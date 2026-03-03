const crypto = require("crypto");
const net = require("net");
const {
  createPacket,
  serializePacket,
  parsePacketString,
  decodePacket,
} = require("../packet");

class TcpTransport {
  constructor(options = {}) {
    this.protocol = "tcp";
    this.alias = options.alias;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0;
    this.onPacket = null;
    this.server = null;
    this.started = false;
    this.peers = new Map();
    this.onResolveAddress = options.onResolveAddress || (() => null);
    this.batchWindowMs = normalizeInt(options.batchWindowMs, 2);
    this.batchMaxFrames = normalizeInt(options.batchMaxFrames, 24);
    this.batchMaxBytes = normalizeInt(options.batchMaxBytes, 64 * 1024);
    this.flushJitterMs = normalizeInt(options.flushJitterMs, 0);
    this.socketIdleTimeoutMs = normalizeInt(options.socketIdleTimeoutMs, 30_000);
    this.laneCount = Math.max(1, normalizeInt(options.laneCount, 4));

    this.coverTrafficEnabled = options.coverTrafficEnabled === true;
    this.coverIntervalMs = Math.max(5, normalizeInt(options.coverIntervalMs, 45));
    this.coverJitterMs = normalizeInt(options.coverJitterMs, 12);
    this.coverRateBytesPerSec = normalizeInt(options.coverRateBytesPerSec, 8 * 1024);
    this.coverPacketBytes = Math.max(32, normalizeInt(options.coverPacketBytes, 96));
    this.coverBurstBytes = Math.max(
      this.coverPacketBytes,
      normalizeInt(options.coverBurstBytes, this.coverPacketBytes * 12)
    );
    this.coverPeerFanout = Math.max(1, normalizeInt(options.coverPeerFanout, 2));
    this.coverTtl = Math.max(1, normalizeInt(options.coverTtl, 2));
    this.maxCoverToRealRatio = normalizeRatio(options.maxCoverToRealRatio, 0.5);
    this.coverWarmupFrames = normalizeInt(options.coverWarmupFrames, 4);

    this.connectionPool = new Map();
    this._coverTimer = null;
    this._coverTokens = this.coverBurstBytes;
    this._coverLastRefillAt = Date.now();
    this._coverPeerCursor = 0;
    this.stats = {
      connectionsCreated: 0,
      batchesSent: 0,
      framesSent: 0,
      framesQueued: 0,
      realFramesSent: 0,
      coverFramesSent: 0,
      realBytesSent: 0,
      coverBytesSent: 0,
      realFramesQueued: 0,
      coverFramesQueued: 0,
      coverFramesDropped: 0,
      writesFailed: 0,
      reconnects: 0,
    };
  }

  start(onPacket) {
    if (this.started) {
      return;
    }
    if (!this.alias) {
      throw new Error("TcpTransport requires alias");
    }
    this.onPacket = onPacket;
    this.server = net.createServer((socket) => this._bindSocket(socket));
    this.server.listen(this.port, this.host);
    this.started = true;
    this._scheduleCoverTick();
  }

  stop() {
    if (!this.started) {
      return;
    }
    if (this.server) {
      this.server.close();
    }
    this._clearCoverTimer();
    for (const state of this.connectionPool.values()) {
      this._closeSocket(state);
    }
    this.connectionPool.clear();
    this.started = false;
  }

  registerPeer(alias, address) {
    const normalized = normalizePeerAddress(address, "tcp");
    if (!normalized) {
      throw new Error("registerPeer requires TCP-compatible { host, port }");
    }
    this.peers.set(alias, normalized);
    this._scheduleCoverTick();
  }

  getAddress() {
    if (!this.server || !this.server.address()) {
      return null;
    }
    const info = this.server.address();
    return { host: info.address, port: info.port };
  }

  send(packet, destinationAlias, addressHint = null) {
    return this._queuePacket(packet, destinationAlias, addressHint).ok;
  }

  getStats() {
    let queuedFrames = 0;
    let queuedBytes = 0;
    let openConnections = 0;
    for (const state of this.connectionPool.values()) {
      queuedFrames += state.pendingFrames;
      queuedBytes += state.pendingBytes;
      if (state.connected && state.socket && !state.socket.destroyed) {
        openConnections += 1;
      }
    }
    return {
      ...this.stats,
      poolSize: this.connectionPool.size,
      openConnections,
      queuedFrames,
      queuedBytes,
      coverTokenBytes: Number(this._coverTokens.toFixed(1)),
    };
  }

  _queuePacket(packet, destinationAlias, addressHint = null) {
    if (!this.started || !packet || !destinationAlias) {
      return { ok: false, queuedBytes: 0 };
    }

    const address =
      normalizePeerAddress(addressHint, "tcp") ||
      this.peers.get(destinationAlias) ||
      normalizePeerAddress(this.onResolveAddress(destinationAlias), "tcp");
    if (!address) {
      return { ok: false, queuedBytes: 0 };
    }

    const localAddress = this.getAddress();
    const metadata = { ...(packet.metadata || {}) };
    if (
      !metadata.replyAddress &&
      localAddress &&
      localAddress.host &&
      localAddress.port
    ) {
      metadata.replyAddress = localAddress;
    }

    const outbound = { ...packet, metadata };
    const lane = resolveLaneId(outbound.metadata, this.laneCount);
    const wire = `${serializePacket(outbound)}\n`;
    const frameBytes = Buffer.byteLength(wire, "utf8");
    const isCover = metadata.cover === true;

    const state = this._getOrCreateConnectionState(address);
    this._enqueueFrame(state, { wire, bytes: frameBytes, isCover }, lane);
    return { ok: true, queuedBytes: frameBytes };
  }

  _bindSocket(socket) {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (frame) {
          try {
            const packet = decodeFrame(frame);
            if (this.onPacket) {
              this.onPacket(packet, packet.srcAlias || null);
            }
          } catch (_error) {
            // swallow malformed packets for now
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
  }

  _getOrCreateConnectionState(address) {
    const key = `${address.host}:${address.port}`;
    let state = this.connectionPool.get(key);
    if (state) {
      return state;
    }
    state = {
      key,
      address: { host: address.host, port: address.port },
      socket: null,
      connecting: false,
      connected: false,
      waitingDrain: false,
      closeRequested: false,
      pendingFrames: 0,
      pendingBytes: 0,
      flushTimer: null,
      idleTimer: null,
      laneCursor: 0,
      lanes: Array.from({ length: this.laneCount }, () => []),
    };
    this.connectionPool.set(key, state);
    this._ensureConnection(state);
    return state;
  }

  _ensureConnection(state) {
    if (!this.started || state.connected || state.connecting) {
      return;
    }
    state.connecting = true;
    state.closeRequested = false;
    const socket = net.createConnection(state.address.port, state.address.host);
    state.socket = socket;
    socket.setNoDelay(true);
    this._bindSocket(socket);
    this.stats.connectionsCreated += 1;

    socket.on("connect", () => {
      state.connecting = false;
      state.connected = true;
      state.waitingDrain = false;
      this._clearIdleTimer(state);
      this._scheduleFlush(state, true);
    });

    socket.on("drain", () => {
      state.waitingDrain = false;
      this._scheduleFlush(state, true);
    });

    socket.on("error", () => {
      this.stats.writesFailed += 1;
    });

    socket.on("close", () => {
      const shouldReconnect =
        this.started && !state.closeRequested && state.pendingFrames > 0;
      state.connecting = false;
      state.connected = false;
      state.waitingDrain = false;
      state.socket = null;
      if (shouldReconnect) {
        this.stats.reconnects += 1;
        setTimeout(() => this._ensureConnection(state), 15);
      }
    });
  }

  _enqueueFrame(state, frameEntry, laneId) {
    this._clearIdleTimer(state);
    const lane = state.lanes[laneId % state.lanes.length];
    lane.push(frameEntry);
    state.pendingFrames += 1;
    state.pendingBytes += frameEntry.bytes;
    this.stats.framesQueued += 1;
    if (frameEntry.isCover) {
      this.stats.coverFramesQueued += 1;
    } else {
      this.stats.realFramesQueued += 1;
    }
    this._ensureConnection(state);
    this._scheduleFlush(state);
  }

  _scheduleFlush(state, immediate = false) {
    if (state.flushTimer) {
      return;
    }
    const scheduleNow = immediate || this.batchWindowMs === 0;
    if (scheduleNow) {
      const handle = setImmediate(() => {
        state.flushTimer = null;
        this._flushConnection(state);
      });
      state.flushTimer = { kind: "immediate", handle };
      return;
    }
    const jitter =
      this.flushJitterMs > 0 ? crypto.randomInt(0, this.flushJitterMs + 1) : 0;
    const handle = setTimeout(() => {
      state.flushTimer = null;
      this._flushConnection(state);
    }, this.batchWindowMs + jitter);
    state.flushTimer = { kind: "timeout", handle };
  }

  _flushConnection(state) {
    if (!this.started) {
      return;
    }
    if (!state.pendingFrames) {
      this._scheduleIdleClose(state);
      return;
    }
    if (!state.connected || !state.socket || state.socket.destroyed) {
      this._ensureConnection(state);
      this._scheduleFlush(state);
      return;
    }
    if (state.waitingDrain) {
      return;
    }

    const batch = this._collectBatch(state);
    if (!batch) {
      this._scheduleIdleClose(state);
      return;
    }

    try {
      const writable = state.socket.write(batch.payload);
      this.stats.framesSent += batch.frames;
      this.stats.realFramesSent += batch.realFrames;
      this.stats.coverFramesSent += batch.coverFrames;
      this.stats.realBytesSent += batch.realBytes;
      this.stats.coverBytesSent += batch.coverBytes;
      this.stats.batchesSent += 1;
      if (!writable) {
        state.waitingDrain = true;
      }
    } catch (_error) {
      this.stats.writesFailed += 1;
    }

    if (state.pendingFrames > 0) {
      this._scheduleFlush(state, true);
    } else {
      this._scheduleIdleClose(state);
    }
  }

  _collectBatch(state) {
    const frames = [];
    let frameCount = 0;
    let bytes = 0;
    let realFrames = 0;
    let coverFrames = 0;
    let realBytes = 0;
    let coverBytes = 0;

    while (
      state.pendingFrames > 0 &&
      frameCount < this.batchMaxFrames &&
      bytes < this.batchMaxBytes
    ) {
      let pulled = false;
      for (let i = 0; i < state.lanes.length; i += 1) {
        const laneIndex = (state.laneCursor + i) % state.lanes.length;
        const lane = state.lanes[laneIndex];
        if (!lane.length) {
          continue;
        }

        const frameEntry = lane[0];
        const frameBytes = frameEntry.bytes;
        if (frameCount > 0 && bytes + frameBytes > this.batchMaxBytes) {
          break;
        }

        lane.shift();
        state.pendingFrames -= 1;
        state.pendingBytes -= frameBytes;
        frames.push(frameEntry.wire);
        bytes += frameBytes;
        frameCount += 1;
        if (frameEntry.isCover) {
          coverFrames += 1;
          coverBytes += frameBytes;
          this.stats.coverFramesQueued = Math.max(0, this.stats.coverFramesQueued - 1);
        } else {
          realFrames += 1;
          realBytes += frameBytes;
          this.stats.realFramesQueued = Math.max(0, this.stats.realFramesQueued - 1);
        }
        state.laneCursor = (laneIndex + 1) % state.lanes.length;
        pulled = true;
        if (frameCount >= this.batchMaxFrames || bytes >= this.batchMaxBytes) {
          break;
        }
      }
      if (!pulled) {
        break;
      }
    }

    if (!frameCount) {
      return null;
    }

    return {
      payload: frames.join(""),
      frames: frameCount,
      realFrames,
      coverFrames,
      realBytes,
      coverBytes,
    };
  }

  _scheduleCoverTick() {
    if (!this.started || !this.coverTrafficEnabled || this._coverTimer) {
      return;
    }
    const jitter =
      this.coverJitterMs > 0 ? crypto.randomInt(0, this.coverJitterMs + 1) : 0;
    this._coverTimer = setTimeout(() => {
      this._coverTimer = null;
      this._runCoverTick();
      this._scheduleCoverTick();
    }, this.coverIntervalMs + jitter);
  }

  _runCoverTick() {
    if (!this.started || !this.coverTrafficEnabled) {
      return;
    }

    this._refillCoverTokens();
    const peerAliases = Array.from(this.peers.keys());
    if (!peerAliases.length) {
      return;
    }

    const bytesBudget = Math.floor(this._coverTokens);
    if (bytesBudget < this.coverPacketBytes) {
      return;
    }

    const rateFrameBudget = Math.floor(bytesBudget / this.coverPacketBytes);
    const ratioFrameBudget = this._calculateCoverFrameBudget();
    const frameBudget = Math.min(
      this.coverPeerFanout,
      rateFrameBudget,
      ratioFrameBudget
    );
    if (frameBudget <= 0) {
      return;
    }

    for (let i = 0; i < frameBudget; i += 1) {
      const alias =
        peerAliases[(this._coverPeerCursor + i) % peerAliases.length];
      const packet = this._buildCoverPacket(alias);
      const queued = this._queuePacket(packet, alias);
      if (!queued.ok) {
        this.stats.coverFramesDropped += 1;
        continue;
      }
      this._coverTokens = Math.max(0, this._coverTokens - queued.queuedBytes);
    }

    this._coverPeerCursor =
      (this._coverPeerCursor + frameBudget) % peerAliases.length;
  }

  _calculateCoverFrameBudget() {
    const budget =
      Math.floor(this.stats.realFramesSent * this.maxCoverToRealRatio) +
      this.coverWarmupFrames;
    const used = this.stats.coverFramesSent + this.stats.coverFramesQueued;
    return Math.max(0, budget - used);
  }

  _refillCoverTokens() {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this._coverLastRefillAt);
    this._coverLastRefillAt = now;

    if (this.coverRateBytesPerSec <= 0) {
      return;
    }

    const refill = (elapsedMs / 1000) * this.coverRateBytesPerSec;
    this._coverTokens = Math.min(this.coverBurstBytes, this._coverTokens + refill);
  }

  _buildCoverPacket(destinationAlias) {
    return createPacket({
      srcAlias: this.alias,
      dstAlias: destinationAlias,
      payload: crypto.randomBytes(this.coverPacketBytes),
      ttl: this.coverTtl,
      metadata: {
        cover: true,
        noise: true,
        routeLane: crypto.randomInt(0, this.laneCount),
        routeEntropy: crypto.randomBytes(2).toString("hex"),
      },
    });
  }

  _scheduleIdleClose(state) {
    if (this.socketIdleTimeoutMs <= 0 || !state.socket) {
      return;
    }
    this._clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.pendingFrames > 0 || !state.socket || !state.connected) {
        return;
      }
      state.closeRequested = true;
      state.socket.end();
    }, this.socketIdleTimeoutMs);
  }

  _clearIdleTimer(state) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  _closeSocket(state) {
    this._clearFlushTimer(state);
    this._clearIdleTimer(state);
    state.closeRequested = true;
    if (state.socket) {
      state.socket.destroy();
      state.socket = null;
    }
    state.connecting = false;
    state.connected = false;
    state.waitingDrain = false;
  }

  _clearFlushTimer(state) {
    if (!state.flushTimer) {
      return;
    }
    if (state.flushTimer.kind === "immediate") {
      clearImmediate(state.flushTimer.handle);
    } else {
      clearTimeout(state.flushTimer.handle);
    }
    state.flushTimer = null;
  }

  _clearCoverTimer() {
    if (!this._coverTimer) {
      return;
    }
    clearTimeout(this._coverTimer);
    this._coverTimer = null;
  }
}

function decodeFrame(frame) {
  try {
    return parsePacketString(frame);
  } catch (_error) {
    // Backward-compatible fallback for older base64-framed senders.
    return decodePacket(Buffer.from(frame, "base64"));
  }
}

function normalizeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeRatio(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveLaneId(metadata, laneCount) {
  if (metadata && Number.isInteger(metadata.routeLane)) {
    return Math.abs(metadata.routeLane) % laneCount;
  }
  return crypto.randomInt(0, laneCount);
}

function normalizePeerAddress(address, protocol) {
  if (!address) {
    return null;
  }
  if (Array.isArray(address)) {
    for (const entry of address) {
      const normalized = normalizePeerAddress(entry, protocol);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }
  if (address && Array.isArray(address.candidates)) {
    return normalizePeerAddress(address.candidates, protocol);
  }
  if (typeof address !== "object") {
    return null;
  }
  if (protocol && address.protocol && address.protocol !== protocol) {
    return null;
  }
  if (!address.host || !Number.isInteger(address.port) || address.port <= 0) {
    return null;
  }
  return { host: address.host, port: address.port };
}

module.exports = {
  TcpTransport,
};
