const crypto = require("crypto");
const { EventEmitter } = require("events");
const { createPacket } = require("./packet");
const { generateIdentity, deriveAlias, createAliasRecord } = require("./identity");
const { estimateCoordinates, quantizeAcrossScales } = require("./coordinates");
const {
  NeighborTable,
  SimpleRoutingEngine,
  DynamicConcurrentRoutingEngine,
  RingAwareRoutingEngine,
  deriveOverlayId,
} = require("./routing");
const { MemoryDHTStore } = require("./dht");
const { MemoryTransport } = require("./transport/memory");
const { NoShufflePolicy } = require("./shuffle");
const {
  encryptPayload,
  decryptPayload,
  splitSecretXor,
  combineSecretXor,
  deriveRekeySessionKey,
} = require("./crypto");
const {
  createHandshakeOffer,
  acceptHandshakeOffer,
  finalizeHandshake,
} = require("./handshake");

class PrivacyShieldNode extends EventEmitter {
  constructor(options = {}) {
    super();
    this.identity = options.identity || generateIdentity();
    this.alias = options.alias || deriveAlias(this.identity.publicKey);
    this.coordinates = options.coordinates || { x: 0, y: 0, z: 0 };
    this.transport =
      options.transport || new MemoryTransport({ alias: this.alias });
    this.neighbors = options.neighbors || new NeighborTable();
    const dynamicRoutingOptions = normalizeDynamicRoutingOptions(options);
    this.overlayNamespace = options.overlayNamespace || "ps-ring-v1";
    this.overlayId = deriveOverlayId(this.alias, this.overlayNamespace);
    this.subRegionPrecision = Math.max(
      1,
      normalizePositiveInt(options.subRegionPrecision, 2)
    );
    this.providerId = options.providerId || null;
    this.routing =
      options.routing ||
      createRoutingEngine(dynamicRoutingOptions, {
        overlayNamespace: this.overlayNamespace,
      });
    this.shufflePolicy = options.shufflePolicy || new NoShufflePolicy();
    this.dht = options.dht || new MemoryDHTStore();
    this.maxTtl = options.maxTtl || 6;
    this.routeLaneCount = normalizePositiveInt(options.routeLaneCount, 4);
    this.routeObfuscationDelayMs = normalizePositiveInt(
      options.routeObfuscationDelayMs,
      0
    );
    this._routeSequence = 0;
    this.sessionKeys = new Map();
    this.sessionFallbackKeys = new Map();
    this.sessionEpochs = new Map();
    this.pendingOutboundRekeys = new Map();
    this.pendingInboundRekeys = new Map();
    this.rekeyShareCount = Math.max(
      2,
      normalizePositiveInt(options.rekeyShareCount, 3)
    );
    this.rekeyGraceMs = normalizePositiveInt(options.rekeyGraceMs, 15_000);
    this.rekeyIntervalMs = normalizePositiveInt(options.rekeyIntervalMs, 0);
    this.rekeyIntervalJitterMs = normalizePositiveInt(
      options.rekeyIntervalJitterMs,
      1_000
    );
    this.rekeyShareSpreadMs = normalizePositiveInt(
      options.rekeyShareSpreadMs,
      8
    );
    this.rekeyNoisePackets = normalizePositiveInt(options.rekeyNoisePackets, 1);
    this.rekeyNoiseBytes = Math.max(
      16,
      normalizePositiveInt(options.rekeyNoiseBytes, 48)
    );
    this.rekeyTtlJitter = normalizePositiveInt(options.rekeyTtlJitter, 1);
    this._rekeyTimer = null;
    this._rekeyCursor = 0;
    this.pendingHandshakes = new Map();
    this.aliasCache = new Map();
    this.coordinateSamples = [];
    this.latestAliasRecord = null;
    this.started = false;
  }

  start() {
    if (this.started) {
      return;
    }
    this.transport.start((packet, fromAlias) =>
      this._onPacket(packet, fromAlias)
    );
    this.started = true;
    this.publishAliasRecord();
    this._scheduleRekeyLoop();
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.transport.stop();
    if (this._rekeyTimer) {
      clearTimeout(this._rekeyTimer);
      this._rekeyTimer = null;
    }
    this.started = false;
  }

  publishAliasRecord(options = {}) {
    const record = createAliasRecord(this.identity, {
      alias: this.alias,
      coordinates: options.coordinates || this.coordinates,
      ttlMs: options.ttlMs,
    });
    this.dht.put(record);
    this.latestAliasRecord = record;
    this._cacheAliasRecord(record);
    return record;
  }

  updateCoordinates(samples) {
    this.coordinates = estimateCoordinates(samples);
    this.regionTable = quantizeAcrossScales(this.coordinates);
    return this.coordinates;
  }

  addNeighbor(entry) {
    const normalized = this._normalizeNeighborEntry(entry);
    const added = this.neighbors.add(normalized);
    if (
      this.transport.registerPeer &&
      added.address &&
      typeof added.address === "object"
    ) {
      try {
        this.transport.registerPeer(added.alias, added.address);
      } catch (_error) {
        // Ignore address shapes unsupported by the current transport.
      }
    }
    return added;
  }

  removeNeighbor(alias) {
    return this.neighbors.remove(alias);
  }

  linkPeer(peer) {
    if (!peer || !peer.alias) {
      throw new Error("linkPeer requires a peer with alias");
    }
    return this.addNeighbor({
      alias: peer.alias,
      address: peer.address || peer.alias,
      coordinates: peer.coordinates || { x: 0, y: 0, z: 0 },
      metadata: { publicKey: peer.publicKey || null },
    });
  }

  registerPeerAddress(alias, address) {
    return this.addNeighbor({ alias, address });
  }

  registerSessionKey(alias, key) {
    if (!Buffer.isBuffer(key)) {
      throw new Error("Session key must be a Buffer");
    }
    this.sessionKeys.set(alias, key);
    this.sessionFallbackKeys.delete(alias);
  }

  getSessionKey(alias) {
    return this.sessionKeys.get(alias) || null;
  }

  hasSessionKey(alias) {
    this._pruneExpiredFallbackKeys();
    return this.sessionKeys.has(alias) || this.sessionFallbackKeys.has(alias);
  }

  resolveAlias(alias, options = {}) {
    if (alias === this.alias && this.latestAliasRecord) {
      return this.latestAliasRecord;
    }
    const now = Date.now();
    if (options.useCache !== false) {
      const cached = this.aliasCache.get(alias);
      if (cached && cached.expiresAt > now) {
        return cached.record;
      }
    }
    const record = this.dht.get(alias);
    if (record) {
      this._cacheAliasRecord(record);
    }
    return record;
  }

  rotateIdentity(options = {}) {
    const wasStarted = this.started;
    if (wasStarted) {
      this.stop();
    }
    this.identity = generateIdentity();
    this.alias = deriveAlias(this.identity.publicKey);
    this.overlayId = deriveOverlayId(this.alias, this.overlayNamespace);
    if (this.transport.alias !== undefined) {
      this.transport.alias = this.alias;
    }
    this.sessionKeys.clear();
    this.sessionFallbackKeys.clear();
    this.sessionEpochs.clear();
    this.pendingOutboundRekeys.clear();
    this.pendingInboundRekeys.clear();
    this.pendingHandshakes.clear();
    this.publishAliasRecord({ coordinates: options.coordinates || this.coordinates });
    if (wasStarted) {
      this.start();
    }
    return this.alias;
  }

  sendMessage(dstAlias, payload, options = {}) {
    const packet = createPacket({
      srcAlias: this.alias,
      dstAlias,
      payload,
      ttl: options.ttl || this.maxTtl,
      metadata: options.metadata || {},
    });

    if (options.encrypt) {
      const key = this.getSessionKey(dstAlias);
      if (!key) {
        throw new Error(`Missing session key for ${dstAlias}`);
      }
      const encrypted = encryptPayload(
        packet.payload,
        key,
        `${packet.srcAlias}->${packet.dstAlias}`
      );
      packet.payload = encrypted.ciphertext;
      packet.encryption = {
        alg: encrypted.algorithm,
        iv: encrypted.iv.toString("base64"),
        tag: encrypted.tag.toString("base64"),
      };
    }

    return this.forwardPacket(packet);
  }

  forwardPacket(packet, fromAlias = null) {
    if (packet.ttl <= 0) {
      this.emit("drop", { packet, reason: "ttl_expired" });
      return false;
    }

    if (packet.dstAlias === this.alias) {
      this._deliver(packet, fromAlias);
      return true;
    }

    const targetCoordinates = this._resolveTargetCoordinates(packet.dstAlias);
    const nextHops = this.routing
      .selectNextHops(packet, this.neighbors, targetCoordinates)
      .filter((hop) => hop.alias !== fromAlias);

    if (!nextHops.length) {
      this.emit("drop", { packet, reason: "no_route" });
      return false;
    }

    const routeGroupId = this._nextRouteGroupId(packet);
    for (let hopIndex = 0; hopIndex < nextHops.length; hopIndex += 1) {
      const hop = nextHops[hopIndex];
      const shuffle = this.shufflePolicy.apply(packet.payload);
      const metadata = { ...packet.metadata };
      const routeLane = this._selectRouteLane(routeGroupId, hop.alias, hopIndex);
      if (!metadata.srcOverlayId) {
        metadata.srcOverlayId = this.overlayId;
      }
      if (!metadata.srcSubRegionId) {
        metadata.srcSubRegionId = this._deriveSubRegionId(this.coordinates);
      }
      if (!metadata.providerId && this.providerId) {
        metadata.providerId = this.providerId;
      }
      const existingPadding = Number.isSafeInteger(metadata.paddingBytes)
        ? metadata.paddingBytes
        : 0;
      if (shuffle.paddingBytes) {
        metadata.paddingBytes = existingPadding + shuffle.paddingBytes;
      } else if (existingPadding) {
        metadata.paddingBytes = existingPadding;
      }
      metadata.routeGroup = routeGroupId;
      metadata.routeLane = routeLane;
      metadata.routeWidth = nextHops.length;
      metadata.routeIndex = hopIndex;

      const outbound = {
        ...packet,
        payload: shuffle.payload,
        metadata,
        hopCount: packet.hopCount + 1,
        ttl: packet.ttl - 1,
      };

      const sendNow = () => this.transport.send(outbound, hop.alias);
      const routeDelayMs = this._computeRouteObfuscationDelay(packet);
      const totalDelayMs = shuffle.delayMs + routeDelayMs;
      if (totalDelayMs > 0) {
        setTimeout(sendNow, totalDelayMs);
      } else {
        sendNow();
      }
    }

    return true;
  }

  _onPacket(packet, fromAlias) {
    if (!packet || !packet.dstAlias) {
      return;
    }

    if (fromAlias) {
      this._learnPeerFromPacket(fromAlias, packet);
      const latencyMs =
        packet.metadata && typeof packet.metadata.latencyMs === "number"
          ? packet.metadata.latencyMs
          : null;
      if (latencyMs !== null) {
        this.neighbors.updateLatency(fromAlias, latencyMs);
        this.recordLatencySample(fromAlias, latencyMs);
      }
    }

    if (packet.dstAlias === this.alias) {
      this._deliver(packet, fromAlias);
      return;
    }

    this.forwardPacket(packet, fromAlias);
  }

  _deliver(packet, fromAlias) {
    if (packet.metadata && packet.metadata.cover === true) {
      this.emit("cover", { packet, fromAlias });
      return;
    }

    let payload = packet.payload;
    const paddingBytes =
      packet.metadata && Number.isSafeInteger(packet.metadata.paddingBytes)
        ? packet.metadata.paddingBytes
        : 0;
    if (paddingBytes > 0) {
      if (payload.length < paddingBytes) {
        this.emit("drop", { packet, reason: "invalid_padding" });
        return;
      }
      payload = payload.subarray(0, payload.length - paddingBytes);
    }
    if (packet.encryption) {
      const keys = this._getDecryptionKeys(packet.srcAlias);
      if (!keys.length) {
        this.emit("drop", { packet, reason: "missing_session_key" });
        return;
      }
      const iv = Buffer.from(packet.encryption.iv, "base64");
      const tag = Buffer.from(packet.encryption.tag, "base64");
      try {
        payload = this._tryDecryptWithSessionKeys(
          payload,
          keys,
          iv,
          tag,
          `${packet.srcAlias}->${packet.dstAlias}`
        );
      } catch (error) {
        this.emit("drop", { packet, reason: "decrypt_failed", error });
        return;
      }
    }
    if (packet.metadata && packet.metadata.control === "handshake") {
      this._handleHandshakeMessage(packet, fromAlias, payload);
      return;
    }
    if (packet.metadata && packet.metadata.control === "session") {
      this._handleSessionControlMessage(packet, fromAlias, payload);
      return;
    }
    this.emit("message", { packet, fromAlias, payload });
  }

  _resolveTargetCoordinates(alias) {
    const cached = this.resolveAlias(alias);
    if (cached && cached.coordinates) {
      return cached.coordinates;
    }
    const neighbor = this.neighbors.get(alias);
    if (neighbor) {
      return neighbor.coordinates;
    }
    const record = this.dht.get(alias);
    if (record && record.coordinates) {
      return record.coordinates;
    }
    return null;
  }

  _cacheAliasRecord(record) {
    this.aliasCache.set(record.alias, {
      record,
      expiresAt: record.expiresAt,
    });
  }

  _getDecryptionKeys(alias) {
    this._pruneExpiredFallbackKeys();
    const keys = [];
    const current = this.sessionKeys.get(alias);
    if (current) {
      keys.push(current);
    }
    const fallback = this.sessionFallbackKeys.get(alias);
    if (fallback && fallback.key) {
      keys.push(fallback.key);
    }
    return keys;
  }

  _tryDecryptWithSessionKeys(payload, keys, iv, tag, aad) {
    let lastError = null;
    for (const key of keys) {
      try {
        return decryptPayload(payload, key, iv, tag, aad);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Unable to decrypt with available session keys");
  }

  _promoteSessionKey(alias, nextKey, options = {}) {
    const current = this.sessionKeys.get(alias);
    if (current) {
      const graceMs = normalizePositiveInt(options.graceMs, this.rekeyGraceMs);
      this.sessionFallbackKeys.set(alias, {
        key: current,
        expiresAt: Date.now() + graceMs,
      });
    }
    this.sessionKeys.set(alias, nextKey);
  }

  _pruneExpiredFallbackKeys() {
    const now = Date.now();
    for (const [alias, fallback] of this.sessionFallbackKeys.entries()) {
      if (!fallback || fallback.expiresAt <= now) {
        this.sessionFallbackKeys.delete(alias);
      }
    }
  }

  initiateSessionRekey(dstAlias, options = {}) {
    const currentKey = this.sessionKeys.get(dstAlias);
    if (!currentKey) {
      return null;
    }

    this._pruneStaleRekeys();
    const pendingByAlias =
      this.pendingOutboundRekeys.get(dstAlias) || new Map();
    if (pendingByAlias.size >= 1) {
      return null;
    }

    const shareCount = Math.max(
      2,
      normalizePositiveInt(options.shareCount, this.rekeyShareCount)
    );
    const material = crypto.randomBytes(32);
    const shares = splitSecretXor(material, shareCount);
    const epoch = this._nextSessionEpoch(dstAlias);
    const rekeyId = crypto.randomBytes(8).toString("hex");
    pendingByAlias.set(rekeyId, {
      rekeyId,
      epoch,
      material,
      baseKey: currentKey,
      createdAt: Date.now(),
      totalShares: shareCount,
    });
    this.pendingOutboundRekeys.set(dstAlias, pendingByAlias);

    const baseTtl = Math.max(1, normalizePositiveInt(options.ttl, 3));
    for (let i = 0; i < shares.length; i += 1) {
      const message = {
        type: "rekey_share",
        version: 1,
        rekeyId,
        epoch,
        totalShares: shareCount,
        index: i,
        share: shares[i].toString("base64"),
      };
      this._dispatchRekeyShare(dstAlias, message, {
        baseTtl,
        shareCount,
      });
    }
    this._emitRekeyNoise(dstAlias, { baseTtl });
    return {
      rekeyId,
      epoch,
      totalShares: shareCount,
      noisePackets: this.rekeyNoisePackets,
    };
  }

  _dispatchRekeyShare(dstAlias, message, options = {}) {
    const ttl = this._withRekeyTtlJitter(options.baseTtl || 3);
    const spreadWindowMs = Math.max(
      0,
      normalizePositiveInt(this.rekeyShareSpreadMs, 0)
    );
    const delayMs =
      spreadWindowMs > 0
        ? crypto.randomInt(0, spreadWindowMs * Math.max(1, options.shareCount || 1) + 1)
        : 0;
    const payload = Buffer.from(JSON.stringify(message));
    const metadata = {
      control: "session",
      rekey: true,
      routeLane: this._selectRekeyRouteLane(message.index),
      rekeyId: message.rekeyId,
      rekeyShareIndex: message.index,
      routeEntropy: crypto.randomBytes(2).toString("hex"),
    };

    const dispatch = () => {
      try {
        this.sendMessage(dstAlias, payload, {
          encrypt: true,
          ttl,
          metadata,
        });
      } catch (_error) {
        // best-effort share dispatch
      }
    };

    if (delayMs > 0) {
      setTimeout(dispatch, delayMs);
      return;
    }
    dispatch();
  }

  _emitRekeyNoise(dstAlias, options = {}) {
    if (this.rekeyNoisePackets <= 0) {
      return;
    }
    const baseTtl = Math.max(1, normalizePositiveInt(options.baseTtl, 2));
    const burstWindowMs = Math.max(0, this.rekeyShareSpreadMs);
    for (let i = 0; i < this.rekeyNoisePackets; i += 1) {
      const payload = crypto.randomBytes(this.rekeyNoiseBytes);
      const ttl = this._withRekeyTtlJitter(baseTtl);
      const metadata = {
        cover: true,
        control: "session",
        rekeyNoise: true,
        routeLane: this._selectRekeyRouteLane(i),
        routeEntropy: crypto.randomBytes(2).toString("hex"),
      };
      const sendNoise = () => {
        try {
          this.sendMessage(dstAlias, payload, {
            encrypt: true,
            ttl,
            metadata,
          });
        } catch (_error) {
          // best-effort noise injection
        }
      };
      if (burstWindowMs > 0) {
        setTimeout(sendNoise, crypto.randomInt(0, burstWindowMs + 1));
      } else {
        sendNoise();
      }
    }
  }

  _selectRekeyRouteLane(seed = 0) {
    if (this.routeLaneCount <= 1) {
      return 0;
    }
    return (seed + crypto.randomInt(0, this.routeLaneCount)) % this.routeLaneCount;
  }

  _withRekeyTtlJitter(baseTtl) {
    const normalizedBase = Math.max(1, normalizePositiveInt(baseTtl, 3));
    if (this.rekeyTtlJitter <= 0) {
      return Math.min(this.maxTtl, normalizedBase);
    }
    return Math.min(
      this.maxTtl,
      normalizedBase + crypto.randomInt(0, this.rekeyTtlJitter + 1)
    );
  }

  _nextRouteGroupId(packet) {
    this._routeSequence = (this._routeSequence + 1) % 0x7fffffff;
    const dstAlias = packet && packet.dstAlias ? packet.dstAlias : "unknown";
    return `${this.alias}:${dstAlias}:${this._routeSequence.toString(36)}`;
  }

  _selectRouteLane(routeGroupId, hopAlias, hopIndex) {
    if (this.routeLaneCount <= 1) {
      return 0;
    }
    const seed = `${routeGroupId}|${hopAlias}|${hopIndex}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % this.routeLaneCount;
  }

  _computeRouteObfuscationDelay(packet) {
    if (this.routeObfuscationDelayMs <= 0) {
      return 0;
    }
    if (packet.metadata && packet.metadata.control) {
      return 0;
    }
    return crypto.randomInt(0, this.routeObfuscationDelayMs + 1);
  }

  _learnPeerFromPacket(fromAlias, packet) {
    const replyAddress =
      packet.metadata && this._isValidPeerAddress(packet.metadata.replyAddress)
        ? packet.metadata.replyAddress
        : null;
    const replyCandidates =
      packet.metadata &&
      Array.isArray(packet.metadata.replyCandidates) &&
      packet.metadata.replyCandidates.length
        ? packet.metadata.replyCandidates
        : null;
    const learnedAddress = replyCandidates
      ? { candidates: replyCandidates }
      : replyAddress;
    const metadata = {
      overlayId:
        (packet.metadata && packet.metadata.srcOverlayId) ||
        deriveOverlayId(fromAlias, this.overlayNamespace),
      subRegionId:
        (packet.metadata && packet.metadata.srcSubRegionId) ||
        null,
      providerId:
        (packet.metadata && packet.metadata.providerId) ||
        null,
    };

    const existing = this.neighbors.get(fromAlias);
    if (!existing) {
      this.addNeighbor({
        alias: fromAlias,
        address: learnedAddress || fromAlias,
        metadata,
      });
      return;
    }

    if (
      learnedAddress &&
      (!existing.address ||
        typeof existing.address !== "object" ||
        !isSamePeerAddress(existing.address, learnedAddress))
    ) {
      this.addNeighbor({
        ...existing,
        address: learnedAddress,
        metadata: {
          ...(existing.metadata || {}),
          ...metadata,
        },
      });
      return;
    }
    this.addNeighbor({
      ...existing,
      metadata: {
        ...(existing.metadata || {}),
        ...metadata,
      },
    });
  }

  _isValidPeerAddress(address) {
    return (
      !!address &&
      typeof address === "object" &&
      typeof address.host === "string" &&
      Number.isInteger(address.port) &&
      address.port > 0 &&
      address.port < 65536
    );
  }

  _normalizeNeighborEntry(entry) {
    const normalized = { ...entry };
    const metadata = { ...(entry.metadata || {}) };
    metadata.overlayId =
      metadata.overlayId || deriveOverlayId(entry.alias, this.overlayNamespace);
    metadata.subRegionId =
      metadata.subRegionId || this._deriveSubRegionId(entry.coordinates);
    metadata.providerId =
      metadata.providerId || inferProviderIdFromAddress(entry.address);
    normalized.metadata = metadata;
    return normalized;
  }

  _deriveSubRegionId(coordinates) {
    const source = coordinates || { x: 0, y: 0, z: 0 };
    const quantized = quantizeAcrossScales(source);
    const keys = Object.keys(quantized)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value))
      .sort((a, b) => a - b);
    if (!keys.length) {
      return deriveOverlayId("region:origin", `${this.overlayNamespace}|sub`);
    }
    const precisionIndex = Math.min(this.subRegionPrecision - 1, keys.length - 1);
    const scale = keys[precisionIndex];
    const region = quantized[String(scale)] || quantized[scale];
    const raw = `${scale}:${region.x}:${region.y}:${region.z}`;
    return deriveOverlayId(raw, `${this.overlayNamespace}|sub`);
  }

  getOverlayProfile() {
    return {
      alias: this.alias,
      overlayId: this.overlayId,
      providerId: this.providerId || null,
      subRegionId: this._deriveSubRegionId(this.coordinates),
      namespace: this.overlayNamespace,
    };
  }

  recordLatencySample(alias, latencyMs) {
    this.coordinateSamples.push({ alias, latencyMs });
    if (this.coordinateSamples.length > 50) {
      this.coordinateSamples.shift();
    }
    this.updateCoordinates(this.coordinateSamples);
  }

  initiateSessionHandshake(dstAlias, options = {}) {
    if (this.hasSessionKey(dstAlias)) {
      return null;
    }
    if (this.pendingHandshakes.has(dstAlias)) {
      return this.pendingHandshakes.get(dstAlias).offer;
    }
    if (!this.latestAliasRecord) {
      this.publishAliasRecord();
    }
    const { offer, ephemeral } = createHandshakeOffer(this.identity, {
      aliasRecord: this.latestAliasRecord,
      coordinates: this.coordinates,
    });
    this.pendingHandshakes.set(dstAlias, { role: "initiator", offer, ephemeral });
    const payload = Buffer.from(JSON.stringify({ type: "offer", offer }));
    this.sendMessage(dstAlias, payload, {
      ttl: options.ttl || 2,
      metadata: { control: "handshake" },
    });
    return offer;
  }

  _handleHandshakeMessage(_packet, fromAlias, payload) {
    try {
      const message = JSON.parse(payload.toString("utf8"));
      if (message.type === "offer" && message.offer) {
        if (
          !fromAlias ||
          !message.offer.aliasRecord ||
          message.offer.aliasRecord.alias !== fromAlias
        ) {
          this.emit("drop", { reason: "handshake_alias_mismatch", fromAlias });
          return;
        }
        if (this.hasSessionKey(fromAlias)) {
          return;
        }
        const pending = this.pendingHandshakes.get(fromAlias);
        if (pending && pending.role === "initiator" && this.alias < fromAlias) {
          // Prefer the existing outbound handshake to avoid double derivations.
          return;
        }
        if (pending && pending.role === "initiator") {
          this.pendingHandshakes.delete(fromAlias);
        }
        const { response, sessionKey } = acceptHandshakeOffer(message.offer, this.identity, {
          aliasRecord: this.latestAliasRecord,
          coordinates: this.coordinates,
        });
        this.registerSessionKey(fromAlias, sessionKey);
        const outbound = Buffer.from(JSON.stringify({ type: "response", response }));
        this.sendMessage(fromAlias, outbound, { ttl: 2, metadata: { control: "handshake" } });
        this.emit("session", { alias: fromAlias, role: "responder", key: sessionKey });
      } else if (message.type === "response" && message.response) {
        if (
          !fromAlias ||
          !message.response.aliasRecord ||
          message.response.aliasRecord.alias !== fromAlias
        ) {
          this.emit("drop", { reason: "handshake_alias_mismatch", fromAlias });
          return;
        }
        const pending = this.pendingHandshakes.get(fromAlias);
        if (!pending || pending.role !== "initiator") {
          return;
        }
        const { sessionKey } = finalizeHandshake(
          pending.offer,
          message.response,
          pending.ephemeral
        );
        this.registerSessionKey(fromAlias, sessionKey);
        this.pendingHandshakes.delete(fromAlias);
        this.emit("session", { alias: fromAlias, role: "initiator", key: sessionKey });
      }
    } catch (error) {
      this.emit("drop", { reason: "handshake_error", fromAlias, error });
    }
  }

  _handleSessionControlMessage(_packet, fromAlias, payload) {
    try {
      const message = JSON.parse(payload.toString("utf8"));
      if (!fromAlias || !message || !message.type) {
        return;
      }
      if (message.type === "rekey_share") {
        this._handleRekeyShare(fromAlias, message);
        return;
      }
      if (message.type === "rekey_ack") {
        this._handleRekeyAck(fromAlias, message);
      }
    } catch (error) {
      this.emit("drop", { reason: "session_control_error", fromAlias, error });
    }
  }

  _handleRekeyShare(fromAlias, message) {
    const {
      rekeyId,
      epoch,
      totalShares,
      index,
      share,
    } = message;
    if (
      typeof rekeyId !== "string" ||
      !Number.isInteger(epoch) ||
      !Number.isInteger(totalShares) ||
      !Number.isInteger(index) ||
      totalShares < 2 ||
      totalShares > 16 ||
      index < 0 ||
      index >= totalShares ||
      typeof share !== "string"
    ) {
      return;
    }

    const currentEpoch = this.sessionEpochs.get(fromAlias) || 0;
    if (epoch <= currentEpoch) {
      return;
    }
    const baseKey =
      this.sessionKeys.get(fromAlias) ||
      (this.sessionFallbackKeys.get(fromAlias) || {}).key;
    if (!baseKey) {
      return;
    }
    const shareBuffer = Buffer.from(share, "base64");
    if (!shareBuffer.length || shareBuffer.length > 1024) {
      return;
    }
    const inboundByAlias =
      this.pendingInboundRekeys.get(fromAlias) || new Map();
    let pending = inboundByAlias.get(rekeyId);
    if (!pending) {
      pending = {
        rekeyId,
        epoch,
        totalShares,
        baseKey,
        shareBytes: shareBuffer.length,
        shares: new Map(),
        createdAt: Date.now(),
      };
      inboundByAlias.set(rekeyId, pending);
      this.pendingInboundRekeys.set(fromAlias, inboundByAlias);
    }
    if (pending.epoch !== epoch || pending.totalShares !== totalShares) {
      return;
    }
    if (pending.shareBytes !== shareBuffer.length) {
      return;
    }
    if (!pending.shares.has(index)) {
      pending.shares.set(index, shareBuffer);
    }
    if (pending.shares.size < totalShares) {
      return;
    }

    const orderedShares = [];
    for (let i = 0; i < totalShares; i += 1) {
      const part = pending.shares.get(i);
      if (!part) {
        return;
      }
      orderedShares.push(part);
    }
    let nextKey = null;
    try {
      const material = combineSecretXor(orderedShares);
      nextKey = deriveRekeySessionKey(
        pending.baseKey,
        material,
        fromAlias,
        this.alias,
        epoch
      );
    } catch (_error) {
      inboundByAlias.delete(rekeyId);
      return;
    }
    this._ackSessionRekey(fromAlias, rekeyId, epoch, pending.baseKey);
    this._promoteSessionKey(fromAlias, nextKey, { graceMs: this.rekeyGraceMs });
    this.sessionEpochs.set(fromAlias, epoch);
    inboundByAlias.delete(rekeyId);
    if (!inboundByAlias.size) {
      this.pendingInboundRekeys.delete(fromAlias);
    }
    this.emit("session_rekey", { alias: fromAlias, role: "responder", epoch });
  }

  _handleRekeyAck(fromAlias, message) {
    const { rekeyId, epoch } = message;
    if (
      typeof rekeyId !== "string" ||
      !Number.isInteger(epoch)
    ) {
      return;
    }
    const currentEpoch = this.sessionEpochs.get(fromAlias) || 0;
    if (epoch <= currentEpoch) {
      return;
    }
    const pendingByAlias = this.pendingOutboundRekeys.get(fromAlias);
    if (!pendingByAlias) {
      return;
    }
    const pending = pendingByAlias.get(rekeyId);
    if (!pending || pending.epoch !== epoch) {
      return;
    }

    const nextKey = deriveRekeySessionKey(
      pending.baseKey,
      pending.material,
      this.alias,
      fromAlias,
      pending.epoch
    );
    this._promoteSessionKey(fromAlias, nextKey, { graceMs: this.rekeyGraceMs });
    this.sessionEpochs.set(fromAlias, pending.epoch);
    pendingByAlias.delete(rekeyId);
    if (!pendingByAlias.size) {
      this.pendingOutboundRekeys.delete(fromAlias);
    }
    this.emit("session_rekey", {
      alias: fromAlias,
      role: "initiator",
      epoch: pending.epoch,
    });
  }

  _ackSessionRekey(alias, rekeyId, epoch, keyOverride = null) {
    const message = {
      type: "rekey_ack",
      version: 1,
      rekeyId,
      epoch,
    };
    const payload = Buffer.from(JSON.stringify(message));
    const metadata = {
      control: "session",
      rekey: true,
    };
    if (!keyOverride) {
      this.sendMessage(alias, payload, {
        encrypt: true,
        ttl: 2,
        metadata,
      });
      return;
    }
    this._sendEncryptedControlPacket(alias, payload, keyOverride, metadata, 2);
  }

  _sendEncryptedControlPacket(dstAlias, payload, key, metadata, ttl) {
    const packet = createPacket({
      srcAlias: this.alias,
      dstAlias,
      payload,
      ttl,
      metadata,
    });
    const encrypted = encryptPayload(
      packet.payload,
      key,
      `${packet.srcAlias}->${packet.dstAlias}`
    );
    packet.payload = encrypted.ciphertext;
    packet.encryption = {
      alg: encrypted.algorithm,
      iv: encrypted.iv.toString("base64"),
      tag: encrypted.tag.toString("base64"),
    };
    return this.forwardPacket(packet);
  }

  _nextSessionEpoch(alias) {
    return (this.sessionEpochs.get(alias) || 0) + 1;
  }

  _scheduleRekeyLoop() {
    if (!this.started || this.rekeyIntervalMs <= 0) {
      return;
    }
    if (this._rekeyTimer) {
      clearTimeout(this._rekeyTimer);
      this._rekeyTimer = null;
    }
    const jitter = this.rekeyIntervalJitterMs
      ? crypto.randomInt(0, this.rekeyIntervalJitterMs + 1)
      : 0;
    this._rekeyTimer = setTimeout(() => {
      this._rekeyTimer = null;
      this._runRekeyTick();
      this._scheduleRekeyLoop();
    }, this.rekeyIntervalMs + jitter);
  }

  _runRekeyTick() {
    this._pruneStaleRekeys();
    const aliases = Array.from(this.sessionKeys.keys());
    if (!aliases.length) {
      return;
    }
    this._rekeyCursor = this._rekeyCursor % aliases.length;
    const alias = aliases[this._rekeyCursor];
    this._rekeyCursor = (this._rekeyCursor + 1) % aliases.length;
    try {
      this.initiateSessionRekey(alias, { shareCount: this.rekeyShareCount });
    } catch (_error) {
      // best-effort background key rotation
    }
  }

  _pruneStaleRekeys() {
    const maxAgeMs = Math.max(this.rekeyGraceMs * 4, 30_000);
    const now = Date.now();
    for (const [alias, pendingByAlias] of this.pendingOutboundRekeys.entries()) {
      for (const [rekeyId, pending] of pendingByAlias.entries()) {
        if (!pending || now - pending.createdAt > maxAgeMs) {
          pendingByAlias.delete(rekeyId);
        }
      }
      if (!pendingByAlias.size) {
        this.pendingOutboundRekeys.delete(alias);
      }
    }
    for (const [alias, pendingByAlias] of this.pendingInboundRekeys.entries()) {
      for (const [rekeyId, pending] of pendingByAlias.entries()) {
        if (!pending || now - pending.createdAt > maxAgeMs) {
          pendingByAlias.delete(rekeyId);
        }
      }
      if (!pendingByAlias.size) {
        this.pendingInboundRekeys.delete(alias);
      }
    }
    this._pruneExpiredFallbackKeys();
  }
}

module.exports = {
  PrivacyShieldNode,
};

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeDynamicRoutingOptions(options) {
  if (options.dynamicRouting === true) {
    return options.dynamicRoutingOptions || {};
  }
  if (options.dynamicRouting && typeof options.dynamicRouting === "object") {
    return options.dynamicRouting;
  }
  return null;
}

function createRoutingEngine(dynamicRoutingOptions, options = {}) {
  if (!dynamicRoutingOptions) {
    return new SimpleRoutingEngine();
  }
  const mode = String(dynamicRoutingOptions.mode || "").toLowerCase();
  if (mode === "ring" || dynamicRoutingOptions.ringAware === true) {
    return new RingAwareRoutingEngine({
      ...dynamicRoutingOptions,
      overlayNamespace:
        dynamicRoutingOptions.overlayNamespace || options.overlayNamespace,
    });
  }
  return new DynamicConcurrentRoutingEngine(dynamicRoutingOptions);
}

function inferProviderIdFromAddress(address) {
  if (!address || typeof address !== "object") {
    return null;
  }
  if (typeof address.providerId === "string" && address.providerId) {
    return address.providerId;
  }
  const candidates = Array.isArray(address.candidates) ? address.candidates : null;
  if (candidates) {
    const provider = candidates.find(
      (entry) => entry && typeof entry.providerId === "string" && entry.providerId
    );
    if (provider) {
      return provider.providerId;
    }
  }
  if (typeof address.host === "string" && address.host) {
    const parts = address.host.split(".");
    if (parts.length >= 2) {
      return `${parts[0]}-${parts[1]}`;
    }
  }
  return null;
}

function isSamePeerAddress(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (a.host && b.host && a.port && b.port) {
    return a.host === b.host && a.port === b.port;
  }
  const aCandidates = Array.isArray(a.candidates) ? a.candidates : [];
  const bCandidates = Array.isArray(b.candidates) ? b.candidates : [];
  if (!aCandidates.length || !bCandidates.length) {
    return false;
  }
  const aSet = new Set(aCandidates.map((entry) => `${entry.host}:${entry.port}`));
  const bSet = new Set(bCandidates.map((entry) => `${entry.host}:${entry.port}`));
  if (aSet.size !== bSet.size) {
    return false;
  }
  for (const key of aSet.values()) {
    if (!bSet.has(key)) {
      return false;
    }
  }
  return true;
}
