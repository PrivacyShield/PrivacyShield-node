const NEUTRAL_CONFIDENCE = 0.5;
const DEFAULT_CONFIDENCE_HALF_LIFE_MS = 30_000;
const ACCEPTANCE_WEIGHT = 0.15;
const DELIVERY_WEIGHT = 0.5;
const LOSS_WEIGHT = 0.5;

// Per (peer, transport) delivery-confidence estimator.
//
// Local send acceptance is only weak evidence: a UDP socket reports success the
// moment the datagram is handed to the kernel, long before (or whether) it is
// ever delivered. Confidence therefore distinguishes three signals:
//   - acceptance: the local transport queued the packet (weak positive)
//   - delivery:   return traffic from the peer confirmed the path (strong)
//   - loss:       a local send was rejected or an expected ACK never arrived
// The estimate is an EWMA in [0, 1] that decays toward neutral so that stale
// paths are re-probed rather than trusted forever.
class PathConfidence {
  constructor(clock, halfLifeMs) {
    this.clock = clock;
    this.halfLifeMs = halfLifeMs;
    this.success = NEUTRAL_CONFIDENCE;
    this.latencyMs = null;
    this.updatedAt = clock();
    this.inFlight = 0;
    this.lastDeliveryAt = 0;
    this.acceptances = 0;
    this.deliveries = 0;
    this.losses = 0;
  }

  _decay(now) {
    const dt = now - this.updatedAt;
    if (dt > 0 && this.halfLifeMs > 0) {
      const factor = Math.pow(0.5, dt / this.halfLifeMs);
      this.success =
        NEUTRAL_CONFIDENCE + (this.success - NEUTRAL_CONFIDENCE) * factor;
    }
    this.updatedAt = now;
  }

  _blend(target, weight) {
    const now = this.clock();
    this._decay(now);
    this.success += (target - this.success) * weight;
    if (this.success > 1) {
      this.success = 1;
    } else if (this.success < 0) {
      this.success = 0;
    }
    return now;
  }

  observeAcceptance() {
    this._blend(1, ACCEPTANCE_WEIGHT);
    this.acceptances += 1;
  }

  observeDelivery(latencyMs) {
    const now = this._blend(1, DELIVERY_WEIGHT);
    this.deliveries += 1;
    this.lastDeliveryAt = now;
    if (typeof latencyMs === "number" && latencyMs >= 0) {
      this.latencyMs =
        this.latencyMs === null
          ? latencyMs
          : this.latencyMs * 0.7 + latencyMs * 0.3;
    }
  }

  observeLoss() {
    this._blend(0, LOSS_WEIGHT);
    this.losses += 1;
  }

  value() {
    this._decay(this.clock());
    return this.success;
  }

  snapshot() {
    return {
      confidence: Number(this.value().toFixed(4)),
      latencyMs: this.latencyMs === null ? null : Math.round(this.latencyMs),
      inFlight: this.inFlight,
      acceptances: this.acceptances,
      deliveries: this.deliveries,
      losses: this.losses,
    };
  }
}

class AdaptiveTransport {
  constructor(options = {}) {
    this.alias = options.alias || null;
    this.transports = normalizeTransports(options.transports || []);
    this.onPacket = null;
    this.started = false;
    this.preferredOrder = Array.isArray(options.preferredOrder)
      ? options.preferredOrder
      : [];
    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
    this.confidenceHalfLifeMs = normalizePositiveInt(
      options.confidenceHalfLifeMs,
      DEFAULT_CONFIDENCE_HALF_LIFE_MS
    );
    // When > 0, an accepted send that is not confirmed by return traffic within
    // the window is scored as a loss, steering subsequent sends to a healthier
    // path (ACK-driven fallback at the path-selection layer).
    this.ackTimeoutMs = normalizePositiveInt(options.ackTimeoutMs, 0);
    this.peerScores = new Map();
    this.pendingAcks = new Map();
    this.stats = {
      sendAttempts: 0,
      sendSuccesses: 0,
      fallbackSuccesses: 0,
      sendFailures: 0,
      deliveriesConfirmed: 0,
      ackTimeouts: 0,
    };
  }

  start(onPacket) {
    if (this.started) {
      return;
    }
    this.onPacket = onPacket;
    for (const entry of this.transports) {
      entry.transport.start((packet, fromAlias) => {
        this._observeInbound(entry, packet, fromAlias);
        if (this.onPacket) {
          this.onPacket(packet, fromAlias);
        }
      });
    }
    this.started = true;
  }

  stop() {
    if (!this.started) {
      return;
    }
    for (const entry of this.transports) {
      entry.transport.stop();
    }
    this._clearAllPending();
    this.started = false;
  }

  registerPeer(alias, address) {
    let accepted = false;
    for (const entry of this.transports) {
      if (typeof entry.transport.registerPeer !== "function") {
        continue;
      }
      try {
        entry.transport.registerPeer(alias, address);
        accepted = true;
      } catch (_error) {
        // Ignore unsupported peer address shapes for a given transport.
      }
    }
    if (!accepted) {
      throw new Error("No adaptive transport accepted the peer address");
    }
  }

  send(packet, destinationAlias, addressHint = null) {
    if (!this.started || !destinationAlias) {
      return false;
    }
    this.stats.sendAttempts += 1;
    const ordered = this._rankTransports(packet, destinationAlias);
    let attempts = 0;
    for (const entry of ordered) {
      attempts += 1;
      const hint = resolveAddressHint(addressHint, entry.protocol);
      const ok = this._trySend(entry, packet, destinationAlias, hint);
      this._recordSendOutcome(destinationAlias, entry.name, ok);
      if (ok) {
        this.stats.sendSuccesses += 1;
        this._armAckTimeout(destinationAlias, entry.name);
        if (attempts > 1) {
          this.stats.fallbackSuccesses += 1;
        } else if (shouldMirrorControlFallback(packet, entry.protocol)) {
          const mirrored = this._sendMirroredFallback(
            ordered,
            packet,
            destinationAlias,
            addressHint
          );
          if (mirrored) {
            this.stats.fallbackSuccesses += 1;
          }
        }
        return true;
      }
    }
    this.stats.sendFailures += 1;
    return false;
  }

  // Public hook for callers that can correlate an explicit delivery
  // confirmation (e.g. an application-level ACK) to a peer/transport.
  recordDelivery(alias, transportName, options = {}) {
    if (!alias) {
      return;
    }
    const name = transportName || this._anyTransportName(alias);
    if (!name) {
      return;
    }
    const score = this._scoreFor(alias, name);
    const latencyMs =
      typeof options.latencyMs === "number" ? options.latencyMs : null;
    score.observeDelivery(latencyMs);
    this.stats.deliveriesConfirmed += 1;
    this._resolvePending(alias, 1);
  }

  recordLoss(alias, transportName) {
    if (!alias) {
      return;
    }
    const name = transportName || this._anyTransportName(alias);
    if (!name) {
      return;
    }
    this._scoreFor(alias, name).observeLoss();
  }

  getAddress() {
    const addresses = {};
    for (const entry of this.transports) {
      if (typeof entry.transport.getAddress !== "function") {
        addresses[entry.name] = null;
        continue;
      }
      addresses[entry.name] = entry.transport.getAddress();
    }
    return addresses;
  }

  getPeerConfidence(alias) {
    const scores = this.peerScores.get(alias);
    if (!scores) {
      return {};
    }
    const out = {};
    for (const [name, score] of scores.entries()) {
      out[name] = score.snapshot();
    }
    return out;
  }

  getStats() {
    const transports = {};
    for (const entry of this.transports) {
      transports[entry.name] =
        typeof entry.transport.getStats === "function"
          ? entry.transport.getStats()
          : null;
    }
    const confidence = {};
    for (const [alias] of this.peerScores.entries()) {
      confidence[alias] = this.getPeerConfidence(alias);
    }
    return {
      ...this.stats,
      transportCount: this.transports.length,
      transports,
      confidence,
    };
  }

  _rankTransports(packet, destinationAlias) {
    const scores = this.peerScores.get(destinationAlias);
    const preference = normalizePreference(
      packet && packet.metadata ? packet.metadata.transportPreference : null
    );
    const preferredOrder = preference.length ? preference : this.preferredOrder;

    const ranked = this.transports
      .map((entry, index) => {
        const score = scores ? scores.get(entry.name) : null;
        const confidence = score ? score.value() : NEUTRAL_CONFIDENCE;
        const confidenceScore = confidence * 100;
        const latency = score ? score.latencyMs : null;
        const latencyPenalty = latency === null ? 0 : Math.min(40, latency / 5);
        const inFlightPenalty = score ? Math.min(20, score.inFlight * 5) : 0;
        const preferredIndex = preferredOrder.indexOf(entry.name);
        const preferredScore =
          preferredIndex === -1 ? 0 : Math.max(0, 30 - preferredIndex * 10);
        return {
          entry,
          score:
            confidenceScore +
            preferredScore -
            latencyPenalty -
            inFlightPenalty -
            index * 0.01,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.entry);

    return ranked;
  }

  _recordSendOutcome(alias, transportName, accepted) {
    const score = this._scoreFor(alias, transportName);
    if (accepted) {
      score.observeAcceptance();
    } else {
      score.observeLoss();
    }
  }

  _observeInbound(entry, packet, fromAlias) {
    const peer = fromAlias || (packet && packet.srcAlias) || null;
    if (!peer) {
      return;
    }
    const latencyMs =
      packet && packet.metadata && typeof packet.metadata.latencyMs === "number"
        ? packet.metadata.latencyMs
        : null;
    // Return traffic over a transport is the strongest available evidence that
    // the path to this peer is alive in both directions.
    this._scoreFor(peer, entry.name).observeDelivery(latencyMs);
    this.stats.deliveriesConfirmed += 1;
    this._resolvePending(peer, 1);
  }

  _scoreFor(alias, transportName) {
    let scores = this.peerScores.get(alias);
    if (!scores) {
      scores = new Map();
      this.peerScores.set(alias, scores);
    }
    let score = scores.get(transportName);
    if (!score) {
      score = new PathConfidence(this.clock, this.confidenceHalfLifeMs);
      scores.set(transportName, score);
    }
    return score;
  }

  _anyTransportName(alias) {
    const scores = this.peerScores.get(alias);
    if (scores && scores.size) {
      return scores.keys().next().value;
    }
    return this.transports.length ? this.transports[0].name : null;
  }

  _armAckTimeout(alias, transportName) {
    const score = this._scoreFor(alias, transportName);
    score.inFlight += 1;
    if (this.ackTimeoutMs <= 0) {
      return;
    }
    const pending = this.pendingAcks.get(alias) || [];
    const entry = { transportName, timer: null };
    entry.timer = setTimeout(() => {
      this._expirePending(alias, entry);
    }, this.ackTimeoutMs);
    if (typeof entry.timer.unref === "function") {
      entry.timer.unref();
    }
    pending.push(entry);
    this.pendingAcks.set(alias, pending);
  }

  _resolvePending(alias, count) {
    const pending = this.pendingAcks.get(alias);
    if (!pending || !pending.length) {
      this._releaseInFlight(alias, count);
      return;
    }
    let resolved = 0;
    while (resolved < count && pending.length) {
      const entry = pending.shift();
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this._releaseInFlightFor(alias, entry.transportName, 1);
      resolved += 1;
    }
    if (!pending.length) {
      this.pendingAcks.delete(alias);
    }
  }

  _expirePending(alias, entry) {
    const pending = this.pendingAcks.get(alias);
    if (pending) {
      const index = pending.indexOf(entry);
      if (index !== -1) {
        pending.splice(index, 1);
      }
      if (!pending.length) {
        this.pendingAcks.delete(alias);
      }
    }
    this._releaseInFlightFor(alias, entry.transportName, 1);
    this._scoreFor(alias, entry.transportName).observeLoss();
    this.stats.ackTimeouts += 1;
  }

  _releaseInFlightFor(alias, transportName, count) {
    const scores = this.peerScores.get(alias);
    if (!scores) {
      return;
    }
    const score = scores.get(transportName);
    if (score) {
      score.inFlight = Math.max(0, score.inFlight - count);
    }
  }

  _releaseInFlight(alias, count) {
    const scores = this.peerScores.get(alias);
    if (!scores) {
      return;
    }
    let remaining = count;
    for (const score of scores.values()) {
      while (remaining > 0 && score.inFlight > 0) {
        score.inFlight -= 1;
        remaining -= 1;
      }
    }
  }

  _clearAllPending() {
    for (const pending of this.pendingAcks.values()) {
      for (const entry of pending) {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
      }
    }
    this.pendingAcks.clear();
  }

  _sendMirroredFallback(ordered, packet, destinationAlias, addressHint) {
    for (let i = 0; i < ordered.length; i += 1) {
      const entry = ordered[i];
      if (entry.protocol === "udp") {
        continue;
      }
      const hint = resolveAddressHint(addressHint, entry.protocol);
      const ok = this._trySend(entry, packet, destinationAlias, hint);
      this._recordSendOutcome(destinationAlias, entry.name, ok);
      if (ok) {
        return true;
      }
    }
    return false;
  }

  // A transport may throw synchronously for an unusable address (e.g. an
  // out-of-range UDP port). Treat that as a failed attempt so the next-best
  // transport is still tried instead of aborting the whole send.
  _trySend(entry, packet, destinationAlias, hint) {
    try {
      return entry.transport.send(packet, destinationAlias, hint) === true;
    } catch (_error) {
      return false;
    }
  }
}

function normalizeTransports(transports) {
  const seen = new Set();
  return transports.map((transport, index) => {
    const protocol = inferProtocol(transport);
    let name = inferName(transport, protocol, index);
    if (seen.has(name)) {
      name = `${name}-${index}`;
    }
    seen.add(name);
    return {
      transport,
      name,
      protocol,
    };
  });
}

function inferProtocol(transport) {
  if (transport && typeof transport.protocol === "string") {
    return transport.protocol;
  }
  const name = transport && transport.constructor && transport.constructor.name
    ? transport.constructor.name.toLowerCase()
    : "";
  if (name.includes("udp")) {
    return "udp";
  }
  if (name.includes("tcp")) {
    return "tcp";
  }
  return "generic";
}

function inferName(transport, protocol, index) {
  if (transport && typeof transport.name === "string" && transport.name) {
    return transport.name;
  }
  const base = protocol || "transport";
  return `${base}-${index + 1}`;
}

function normalizePreference(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveAddressHint(addressHint, protocol) {
  if (!addressHint) {
    return null;
  }
  if (Array.isArray(addressHint)) {
    const selected = addressHint.find((entry) =>
      entry && typeof entry === "object" && (!protocol || entry.protocol === protocol)
    );
    return selected || null;
  }
  if (addressHint && Array.isArray(addressHint.candidates)) {
    return resolveAddressHint(addressHint.candidates, protocol);
  }
  if (
    addressHint &&
    typeof addressHint === "object" &&
    (!addressHint.protocol || !protocol || addressHint.protocol === protocol)
  ) {
    return addressHint;
  }
  return null;
}

function shouldMirrorControlFallback(packet, primaryProtocol) {
  if (!packet || !packet.metadata || !packet.metadata.control) {
    return false;
  }
  return primaryProtocol === "udp";
}

module.exports = {
  AdaptiveTransport,
  PathConfidence,
};
