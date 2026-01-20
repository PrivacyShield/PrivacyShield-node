const { EventEmitter } = require("events");
const { createPacket } = require("./packet");
const { generateIdentity, deriveAlias, createAliasRecord } = require("./identity");
const { estimateCoordinates, quantizeAcrossScales } = require("./coordinates");
const { NeighborTable, SimpleRoutingEngine } = require("./routing");
const { MemoryDHTStore } = require("./dht");
const { MemoryTransport } = require("./transport/memory");
const { NoShufflePolicy } = require("./shuffle");
const { encryptPayload, decryptPayload } = require("./crypto");
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
    this.routing = options.routing || new SimpleRoutingEngine();
    this.shufflePolicy = options.shufflePolicy || new NoShufflePolicy();
    this.dht = options.dht || new MemoryDHTStore();
    this.maxTtl = options.maxTtl || 6;
    this.sessionKeys = new Map();
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
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.transport.stop();
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
    const added = this.neighbors.add(entry);
    if (
      this.transport.registerPeer &&
      added.address &&
      typeof added.address === "object" &&
      added.address.host &&
      added.address.port
    ) {
      this.transport.registerPeer(added.alias, {
        host: added.address.host,
        port: added.address.port,
      });
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
    if (this.transport.registerPeer) {
      this.transport.registerPeer(alias, address);
    }
    return this.neighbors.add({ alias, address });
  }

  registerSessionKey(alias, key) {
    if (!Buffer.isBuffer(key)) {
      throw new Error("Session key must be a Buffer");
    }
    this.sessionKeys.set(alias, key);
  }

  getSessionKey(alias) {
    return this.sessionKeys.get(alias) || null;
  }

  hasSessionKey(alias) {
    return this.sessionKeys.has(alias);
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
    if (this.transport.alias !== undefined) {
      this.transport.alias = this.alias;
    }
    this.sessionKeys.clear();
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
    const nextHops = this.routing.selectNextHops(
      packet,
      this.neighbors,
      targetCoordinates
    );

    if (!nextHops.length) {
      this.emit("drop", { packet, reason: "no_route" });
      return false;
    }

    for (const hop of nextHops) {
      const shuffle = this.shufflePolicy.apply(packet.payload);
      const metadata = { ...packet.metadata };
      if (shuffle.paddingBytes) {
        metadata.paddingBytes = shuffle.paddingBytes;
      }

      const outbound = {
        ...packet,
        payload: shuffle.payload,
        metadata,
        hopCount: packet.hopCount + 1,
        ttl: packet.ttl - 1,
      };

      const sendNow = () => this.transport.send(outbound, hop.alias);
      if (shuffle.delayMs > 0) {
        setTimeout(sendNow, shuffle.delayMs);
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
    let payload = packet.payload;
    if (packet.encryption) {
      const key = this.getSessionKey(packet.srcAlias);
      if (key) {
        const iv = Buffer.from(packet.encryption.iv, "base64");
        const tag = Buffer.from(packet.encryption.tag, "base64");
        try {
          payload = decryptPayload(
            packet.payload,
            key,
            iv,
            tag,
            `${packet.srcAlias}->${packet.dstAlias}`
          );
        } catch (error) {
          this.emit("drop", { packet, reason: "decrypt_failed", error });
          return;
        }
      }
    }
    if (packet.metadata && packet.metadata.control === "handshake") {
      this._handleHandshakeMessage(packet, fromAlias, payload);
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
}

module.exports = {
  PrivacyShieldNode,
};
