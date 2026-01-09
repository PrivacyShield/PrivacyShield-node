const { EventEmitter } = require("events");
const { createPacket } = require("./packet");
const { generateIdentity, deriveAlias, createAliasRecord } = require("./identity");
const { estimateCoordinates } = require("./coordinates");
const { NeighborTable, SimpleRoutingEngine } = require("./routing");
const { MemoryDHTStore } = require("./dht");
const { MemoryTransport } = require("./transport/memory");
const { NoShufflePolicy } = require("./shuffle");
const { encryptPayload, decryptPayload } = require("./crypto");

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

  publishAliasRecord() {
    const record = createAliasRecord(this.identity, {
      alias: this.alias,
      coordinates: this.coordinates,
    });
    this.dht.put(record);
    return record;
  }

  updateCoordinates(samples) {
    this.coordinates = estimateCoordinates(samples);
    return this.coordinates;
  }

  addNeighbor(entry) {
    return this.neighbors.add(entry);
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

  registerSessionKey(alias, key) {
    if (!Buffer.isBuffer(key)) {
      throw new Error("Session key must be a Buffer");
    }
    this.sessionKeys.set(alias, key);
  }

  getSessionKey(alias) {
    return this.sessionKeys.get(alias) || null;
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
    this.emit("message", { packet, fromAlias, payload });
  }

  _resolveTargetCoordinates(alias) {
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
}

module.exports = {
  PrivacyShieldNode,
};
