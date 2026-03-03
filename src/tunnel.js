const crypto = require("crypto");
const net = require("net");

class PrivacyShieldTunnelGateway {
  constructor(options = {}) {
    this.node = options.node;
    this.targetHost = options.targetHost || null;
    this.targetPort = options.targetPort || null;
    this.maxChunkBytes = Math.max(256, normalizeInt(options.maxChunkBytes, 1024));
    this.requireSession = options.requireSession !== false;
    this.allowRemoteTarget = options.allowRemoteTarget === true;
    this.started = false;
    this.connections = new Map();
    this._onMessage = (event) => this._handleMessage(event);
  }

  start() {
    if (this.started) {
      return;
    }
    if (!this.node) {
      throw new Error("PrivacyShieldTunnelGateway requires a node");
    }
    this.node.on("message", this._onMessage);
    this.started = true;
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.node.removeListener("message", this._onMessage);
    for (const entry of this.connections.values()) {
      entry.socket.destroy();
    }
    this.connections.clear();
    this.started = false;
  }

  _handleMessage(event) {
    const packet = event && event.packet ? event.packet : null;
    if (!packet || !packet.metadata || packet.metadata.control !== "tunnel") {
      return;
    }
    const fromAlias = event.fromAlias || packet.srcAlias;
    if (!fromAlias) {
      return;
    }
    const message = parseTunnelMessage(event.payload);
    if (!message) {
      return;
    }
    if (message.type === "open") {
      this._handleOpen(fromAlias, message);
      return;
    }
    if (message.type === "data") {
      this._handleData(fromAlias, message);
      return;
    }
    if (message.type === "close") {
      this._handleClose(fromAlias, message);
    }
  }

  _handleOpen(fromAlias, message) {
    if (!isValidConnId(message.connId)) {
      return;
    }
    const key = connectionKey(fromAlias, message.connId);
    if (this.connections.has(key)) {
      return;
    }
    const target = this._resolveTarget(message);
    if (!target) {
      this._send(fromAlias, {
        type: "open_ack",
        connId: message.connId,
        ok: false,
        error: "target_unavailable",
      });
      return;
    }
    const socket = net.createConnection(target.port, target.host);
    this.connections.set(key, { socket, alias: fromAlias, connId: message.connId });

    socket.on("connect", () => {
      this._send(fromAlias, { type: "open_ack", connId: message.connId, ok: true });
    });
    socket.on("data", (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += this.maxChunkBytes) {
        const part = chunk.subarray(offset, offset + this.maxChunkBytes);
        this._send(fromAlias, {
          type: "data",
          connId: message.connId,
          data: part.toString("base64"),
        });
      }
    });
    socket.on("error", (error) => {
      this._send(fromAlias, {
        type: "close",
        connId: message.connId,
        reason: error.code || "socket_error",
      });
      this._dropConnection(key);
    });
    socket.on("close", () => {
      this._send(fromAlias, {
        type: "close",
        connId: message.connId,
        reason: "remote_closed",
      });
      this._dropConnection(key);
    });
  }

  _handleData(fromAlias, message) {
    if (!isValidConnId(message.connId) || typeof message.data !== "string") {
      return;
    }
    const key = connectionKey(fromAlias, message.connId);
    const entry = this.connections.get(key);
    if (!entry) {
      return;
    }
    const payload = Buffer.from(message.data, "base64");
    if (!payload.length) {
      return;
    }
    entry.socket.write(payload);
  }

  _handleClose(fromAlias, message) {
    if (!isValidConnId(message.connId)) {
      return;
    }
    this._dropConnection(connectionKey(fromAlias, message.connId));
  }

  _resolveTarget(message) {
    if (this.targetHost && Number.isInteger(this.targetPort) && this.targetPort > 0) {
      return { host: this.targetHost, port: this.targetPort };
    }
    if (!this.allowRemoteTarget) {
      return null;
    }
    if (
      typeof message.targetHost !== "string" ||
      !Number.isInteger(message.targetPort) ||
      message.targetPort <= 0
    ) {
      return null;
    }
    return { host: message.targetHost, port: message.targetPort };
  }

  _send(alias, message) {
    const payload = Buffer.from(JSON.stringify(message));
    const encrypt = this.requireSession ? this.node.hasSessionKey(alias) : false;
    if (this.requireSession && !encrypt) {
      return false;
    }
    return this.node.sendMessage(alias, payload, {
      encrypt,
      ttl: 3,
      metadata: {
        control: "tunnel",
      },
    });
  }

  _dropConnection(key) {
    const entry = this.connections.get(key);
    if (!entry) {
      return;
    }
    entry.socket.destroy();
    this.connections.delete(key);
  }
}

class PrivacyShieldTunnelBinding {
  constructor(options = {}) {
    this.node = options.node;
    this.remoteAlias = options.remoteAlias;
    this.listenHost = options.listenHost || "127.0.0.1";
    this.listenPort = options.listenPort || 0;
    this.targetHost = options.targetHost || "127.0.0.1";
    this.targetPort = options.targetPort;
    this.maxChunkBytes = Math.max(256, normalizeInt(options.maxChunkBytes, 1024));
    this.requireSession = options.requireSession !== false;
    this.server = null;
    this.started = false;
    this.connections = new Map();
    this._onMessage = (event) => this._handleMessage(event);
  }

  start() {
    if (this.started) {
      return;
    }
    if (!this.node || !this.remoteAlias || !Number.isInteger(this.targetPort)) {
      throw new Error("PrivacyShieldTunnelBinding requires node, remoteAlias and targetPort");
    }
    this.server = net.createServer((socket) => this._onLocalSocket(socket));
    this.server.listen(this.listenPort, this.listenHost);
    this.node.on("message", this._onMessage);
    this.started = true;
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.node.removeListener("message", this._onMessage);
    if (this.server) {
      this.server.close();
    }
    for (const socket of this.connections.values()) {
      socket.destroy();
    }
    this.connections.clear();
    this.started = false;
  }

  getAddress() {
    if (!this.server || !this.server.address()) {
      return null;
    }
    const address = this.server.address();
    return {
      host: address.address,
      port: address.port,
    };
  }

  _onLocalSocket(socket) {
    const connId = crypto.randomBytes(8).toString("hex");
    this.connections.set(connId, socket);
    this._send({
      type: "open",
      connId,
      targetHost: this.targetHost,
      targetPort: this.targetPort,
    });

    socket.on("data", (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += this.maxChunkBytes) {
        const part = chunk.subarray(offset, offset + this.maxChunkBytes);
        this._send({
          type: "data",
          connId,
          data: part.toString("base64"),
        });
      }
    });
    socket.on("close", () => {
      this._send({
        type: "close",
        connId,
        reason: "client_closed",
      });
      this.connections.delete(connId);
    });
    socket.on("error", () => {
      this._send({
        type: "close",
        connId,
        reason: "client_error",
      });
      this.connections.delete(connId);
    });
  }

  _handleMessage(event) {
    const packet = event && event.packet ? event.packet : null;
    if (!packet || !packet.metadata || packet.metadata.control !== "tunnel") {
      return;
    }
    const fromAlias = event.fromAlias || packet.srcAlias;
    if (fromAlias !== this.remoteAlias) {
      return;
    }
    const message = parseTunnelMessage(event.payload);
    if (!message || !isValidConnId(message.connId)) {
      return;
    }

    const socket = this.connections.get(message.connId);
    if (!socket) {
      return;
    }
    if (message.type === "open_ack") {
      if (message.ok !== true) {
        socket.destroy();
        this.connections.delete(message.connId);
      }
      return;
    }
    if (message.type === "data" && typeof message.data === "string") {
      const payload = Buffer.from(message.data, "base64");
      if (payload.length) {
        socket.write(payload);
      }
      return;
    }
    if (message.type === "close") {
      socket.end();
      this.connections.delete(message.connId);
    }
  }

  _send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    const encrypt = this.requireSession ? this.node.hasSessionKey(this.remoteAlias) : false;
    if (this.requireSession && !encrypt) {
      return false;
    }
    return this.node.sendMessage(this.remoteAlias, payload, {
      encrypt,
      ttl: 3,
      metadata: {
        control: "tunnel",
      },
    });
  }
}

function parseTunnelMessage(payload) {
  if (!Buffer.isBuffer(payload)) {
    return null;
  }
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch (_error) {
    return null;
  }
}

function connectionKey(alias, connId) {
  return `${alias}:${connId}`;
}

function isValidConnId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 64;
}

function normalizeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  PrivacyShieldTunnelGateway,
  PrivacyShieldTunnelBinding,
};
