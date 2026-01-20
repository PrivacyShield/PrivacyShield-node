const net = require("net");
const { encodePacket, decodePacket } = require("../packet");

class TcpTransport {
  constructor(options = {}) {
    this.alias = options.alias;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0;
    this.onPacket = null;
    this.server = null;
    this.started = false;
    this.peers = new Map();
    this.onResolveAddress = options.onResolveAddress || (() => null);
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
  }

  stop() {
    if (!this.started) {
      return;
    }
    if (this.server) {
      this.server.close();
    }
    this.started = false;
  }

  registerPeer(alias, address) {
    if (!address || !address.host || !address.port) {
      throw new Error("registerPeer requires { host, port }");
    }
    this.peers.set(alias, { host: address.host, port: address.port });
  }

  getAddress() {
    if (!this.server || !this.server.address()) {
      return null;
    }
    const info = this.server.address();
    return { host: info.address, port: info.port };
  }

  send(packet, destinationAlias, addressHint = null) {
    if (!this.started) {
      return false;
    }
    const address =
      addressHint ||
      this.peers.get(destinationAlias) ||
      this.onResolveAddress(destinationAlias);
    if (!address) {
      return false;
    }
    const wire = encodePacket(packet).toString("base64") + "\n";
    const socket = net.createConnection(address.port, address.host);
    socket.on("error", () => socket.destroy());
    socket.write(wire, () => socket.end());
    return true;
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
            const packet = decodePacket(Buffer.from(frame, "base64"));
            if (this.onPacket) {
              this.onPacket(packet, packet.srcAlias || null);
            }
          } catch (error) {
            // swallow malformed packets for now
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
  }
}

module.exports = {
  TcpTransport,
};
