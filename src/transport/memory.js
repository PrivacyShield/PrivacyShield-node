const registry = new Map();

class MemoryTransport {
  constructor(options = {}) {
    this.alias = options.alias;
    this.onPacket = null;
    this.started = false;
  }

  start(onPacket) {
    if (!this.alias) {
      throw new Error("MemoryTransport requires alias");
    }
    if (registry.has(this.alias)) {
      throw new Error(`MemoryTransport alias already in use: ${this.alias}`);
    }
    this.onPacket = onPacket;
    registry.set(this.alias, this);
    this.started = true;
  }

  stop() {
    if (this.started) {
      registry.delete(this.alias);
      this.started = false;
    }
  }

  send(packet, destinationAlias) {
    const target = registry.get(destinationAlias);
    if (!target || !target.onPacket) {
      return false;
    }
    setImmediate(() => target.onPacket(packet, this.alias));
    return true;
  }

  static isOnline(alias) {
    return registry.has(alias);
  }

  static reset() {
    registry.clear();
  }
}

module.exports = {
  MemoryTransport,
};
