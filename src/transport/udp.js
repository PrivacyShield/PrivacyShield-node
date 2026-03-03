const crypto = require("crypto");
const dgram = require("dgram");
const { createPacket, serializePacket, parsePacketString, decodePacket } = require("../packet");

class UdpTransport {
  constructor(options = {}) {
    this.alias = options.alias;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0;
    this.onPacket = null;
    this.socket = null;
    this.started = false;
    this.peers = new Map();
    this.onResolveAddress = options.onResolveAddress || (() => null);
    this.ipv6 = options.ipv6 === true;
    this.family = this.ipv6 ? "udp6" : "udp4";
    this.natKeepaliveMs = normalizeInt(options.natKeepaliveMs, 15_000);
    this.keepaliveFanout = Math.max(1, normalizeInt(options.keepaliveFanout, 3));
    this._keepaliveTimer = null;
    this._peerCursor = 0;
    this._addressHealth = new Map();
    this.stats = {
      packetsSent: 0,
      packetsReceived: 0,
      sendFailures: 0,
      decodeFailures: 0,
      keepaliveSent: 0,
      fallbackAddressUsed: 0,
    };
  }

  start(onPacket) {
    if (this.started) {
      return;
    }
    if (!this.alias) {
      throw new Error("UdpTransport requires alias");
    }
    this.onPacket = onPacket;
    this.socket = dgram.createSocket(this.family);
    this.socket.on("message", (msg, rinfo) => this._onDatagram(msg, rinfo));
    this.socket.on("error", () => {
      this.stats.sendFailures += 1;
    });
    this.socket.bind(this.port, this.host);
    this.started = true;
    this._scheduleKeepalive();
  }

  stop() {
    if (!this.started) {
      return;
    }
    this._clearKeepalive();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.started = false;
  }

  registerPeer(alias, address) {
    const candidates = normalizeCandidateList(address, "udp");
    if (!candidates.length) {
      throw new Error("registerPeer requires UDP-compatible { host, port }");
    }
    this.peers.set(alias, candidates);
    this._scheduleKeepalive();
  }

  getAddress() {
    if (!this.socket) {
      return null;
    }
    let address = null;
    try {
      address = this.socket.address();
    } catch (_error) {
      return null;
    }
    if (!address) {
      return null;
    }
    return {
      protocol: "udp",
      host: address.address,
      port: address.port,
      family: address.family,
    };
  }

  send(packet, destinationAlias, addressHint = null) {
    if (!this.started || !this.socket || !packet || !destinationAlias) {
      return false;
    }
    const address = this._resolvePeerAddress(destinationAlias, addressHint);
    if (!address) {
      return false;
    }
    const metadata = {
      ...(packet.metadata || {}),
    };
    const localAddress = this.getAddress();
    if (!metadata.replyAddress && localAddress) {
      metadata.replyAddress = {
        host: localAddress.host,
        port: localAddress.port,
        protocol: "udp",
        family: localAddress.family,
      };
    }
    const outbound = { ...packet, metadata };
    const payload = Buffer.from(serializePacket(outbound), "utf8");
    this._sendBuffer(payload, address, false);
    return true;
  }

  getStats() {
    return {
      ...this.stats,
      peers: this.peers.size,
      addressHealth: this._addressHealth.size,
    };
  }

  _sendBuffer(payload, address, isKeepalive) {
    const sentAt = Date.now();
    this.socket.send(payload, address.port, address.host, (error) => {
      const key = `${address.host}:${address.port}`;
      const health = this._addressHealth.get(key) || { ok: 0, failed: 0, lastLatencyMs: null };
      if (error) {
        health.failed += 1;
        this.stats.sendFailures += 1;
      } else {
        health.ok += 1;
        health.lastLatencyMs = Date.now() - sentAt;
        this.stats.packetsSent += 1;
        if (isKeepalive) {
          this.stats.keepaliveSent += 1;
        }
      }
      this._addressHealth.set(key, health);
    });
  }

  _onDatagram(message, rinfo) {
    let packet = null;
    try {
      packet = parsePacketString(message.toString("utf8"));
    } catch (_error) {
      try {
        packet = decodePacket(message);
      } catch (_secondError) {
        this.stats.decodeFailures += 1;
        return;
      }
    }
    this.stats.packetsReceived += 1;
    if (this.onPacket) {
      this.onPacket(packet, packet.srcAlias || null);
    }
    this._learnRinfo(packet, rinfo);
  }

  _learnRinfo(packet, rinfo) {
    if (!packet || !packet.srcAlias || !rinfo || !rinfo.address || !rinfo.port) {
      return;
    }
    const existing = this.peers.get(packet.srcAlias) || [];
    const candidate = {
      protocol: "udp",
      host: rinfo.address,
      port: rinfo.port,
      family: rinfo.family || (rinfo.address.includes(":") ? "IPv6" : "IPv4"),
    };
    const key = `${candidate.host}:${candidate.port}`;
    if (!existing.some((entry) => `${entry.host}:${entry.port}` === key)) {
      this.peers.set(packet.srcAlias, [candidate, ...existing].slice(0, 8));
      return;
    }
    this.peers.set(
      packet.srcAlias,
      existing.map((entry) =>
        `${entry.host}:${entry.port}` === key ? { ...entry, ...candidate } : entry
      )
    );
  }

  _resolvePeerAddress(destinationAlias, addressHint) {
    const hinted = normalizeCandidateList(addressHint, "udp");
    if (hinted.length) {
      return hinted[0];
    }
    const known = this.peers.get(destinationAlias);
    if (known && known.length) {
      return this._selectBestAddress(known);
    }
    const resolved = normalizeCandidateList(this.onResolveAddress(destinationAlias), "udp");
    if (resolved.length) {
      return resolved[0];
    }
    return null;
  }

  _selectBestAddress(candidates) {
    if (candidates.length === 1) {
      return candidates[0];
    }
    const ranked = candidates
      .map((entry, idx) => {
        const key = `${entry.host}:${entry.port}`;
        const health = this._addressHealth.get(key) || { ok: 0, failed: 0 };
        const score = health.failed * 3 - health.ok;
        return { entry, score, idx };
      })
      .sort((a, b) => a.score - b.score || a.idx - b.idx);
    if (ranked[0].idx !== 0) {
      this.stats.fallbackAddressUsed += 1;
    }
    return ranked[0].entry;
  }

  _scheduleKeepalive() {
    if (!this.started || this.natKeepaliveMs <= 0 || this._keepaliveTimer) {
      return;
    }
    this._keepaliveTimer = setTimeout(() => {
      this._keepaliveTimer = null;
      this._runKeepaliveTick();
      this._scheduleKeepalive();
    }, this.natKeepaliveMs);
  }

  _runKeepaliveTick() {
    if (!this.started || !this.peers.size) {
      return;
    }
    const aliases = Array.from(this.peers.keys());
    const fanout = Math.min(this.keepaliveFanout, aliases.length);
    for (let i = 0; i < fanout; i += 1) {
      const alias = aliases[(this._peerCursor + i) % aliases.length];
      const address = this._resolvePeerAddress(alias, null);
      if (!address) {
        continue;
      }
      const keepalive = createPacket({
        srcAlias: this.alias,
        dstAlias: alias,
        payload: crypto.randomBytes(16),
        ttl: 1,
        metadata: {
          cover: true,
          control: "nat_probe",
          protocol: "udp",
        },
      });
      const payload = Buffer.from(serializePacket(keepalive), "utf8");
      this._sendBuffer(payload, address, true);
    }
    this._peerCursor = (this._peerCursor + fanout) % aliases.length;
  }

  _clearKeepalive() {
    if (!this._keepaliveTimer) {
      return;
    }
    clearTimeout(this._keepaliveTimer);
    this._keepaliveTimer = null;
  }
}

function normalizeCandidateList(address, protocol) {
  if (!address) {
    return [];
  }
  if (Array.isArray(address)) {
    return address.flatMap((entry) => normalizeCandidateList(entry, protocol));
  }
  if (address.candidates && Array.isArray(address.candidates)) {
    return address.candidates.flatMap((entry) => normalizeCandidateList(entry, protocol));
  }
  if (typeof address !== "object") {
    return [];
  }
  if (protocol && address.protocol && address.protocol !== protocol) {
    return [];
  }
  if (!address.host || !Number.isInteger(address.port) || address.port <= 0) {
    return [];
  }
  return [
    {
      protocol: protocol || address.protocol || null,
      host: address.host,
      port: address.port,
      family: address.family || null,
      providerId: address.providerId || null,
    },
  ];
}

function normalizeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  UdpTransport,
};
