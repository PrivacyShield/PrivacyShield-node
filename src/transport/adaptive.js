class AdaptiveTransport {
  constructor(options = {}) {
    this.alias = options.alias || null;
    this.transports = normalizeTransports(options.transports || []);
    this.onPacket = null;
    this.started = false;
    this.preferredOrder = Array.isArray(options.preferredOrder)
      ? options.preferredOrder
      : [];
    this.peerHealth = new Map();
    this.stats = {
      sendAttempts: 0,
      sendSuccesses: 0,
      fallbackSuccesses: 0,
      sendFailures: 0,
    };
  }

  start(onPacket) {
    if (this.started) {
      return;
    }
    this.onPacket = onPacket;
    for (const entry of this.transports) {
      entry.transport.start((packet, fromAlias) => {
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
      const ok = entry.transport.send(packet, destinationAlias, hint);
      this._recordPeerHealth(destinationAlias, entry.name, ok);
      if (ok) {
        this.stats.sendSuccesses += 1;
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

  getStats() {
    const transports = {};
    for (const entry of this.transports) {
      transports[entry.name] =
        typeof entry.transport.getStats === "function"
          ? entry.transport.getStats()
          : null;
    }
    return {
      ...this.stats,
      transportCount: this.transports.length,
      transports,
    };
  }

  _rankTransports(packet, destinationAlias) {
    const health = this.peerHealth.get(destinationAlias) || {};
    const preference = normalizePreference(
      packet && packet.metadata ? packet.metadata.transportPreference : null
    );
    const preferredOrder = preference.length ? preference : this.preferredOrder;

    const ranked = this.transports
      .map((entry, index) => {
        const peerScore = health[entry.name] || 0;
        const preferredIndex = preferredOrder.indexOf(entry.name);
        const preferredScore =
          preferredIndex === -1 ? 0 : Math.max(0, 100 - preferredIndex * 10);
        return {
          entry,
          score: peerScore + preferredScore - index * 0.01,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.entry);

    return ranked;
  }

  _recordPeerHealth(alias, transportName, success) {
    const peer = this.peerHealth.get(alias) || {};
    const score = peer[transportName] || 0;
    peer[transportName] = success ? score + 1 : score - 2;
    this.peerHealth.set(alias, peer);
  }

  _sendMirroredFallback(ordered, packet, destinationAlias, addressHint) {
    for (let i = 0; i < ordered.length; i += 1) {
      const entry = ordered[i];
      if (entry.protocol === "udp") {
        continue;
      }
      const hint = resolveAddressHint(addressHint, entry.protocol);
      const ok = entry.transport.send(packet, destinationAlias, hint);
      this._recordPeerHealth(destinationAlias, entry.name, ok);
      if (ok) {
        return true;
      }
    }
    return false;
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
};
