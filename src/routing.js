const crypto = require("crypto");
const { distance } = require("./coordinates");

class NeighborTable {
  constructor() {
    this.entries = new Map();
  }

  add(entry) {
    if (!entry || !entry.alias) {
      throw new Error("Neighbor entry requires alias");
    }
    const normalized = {
      alias: entry.alias,
      address: entry.address || entry.alias,
      coordinates: entry.coordinates || { x: 0, y: 0, z: 0 },
      latencyMs: entry.latencyMs || null,
      lastSeen: entry.lastSeen || Date.now(),
      metadata: entry.metadata || {},
    };
    this.entries.set(entry.alias, normalized);
    return normalized;
  }

  remove(alias) {
    return this.entries.delete(alias);
  }

  get(alias) {
    return this.entries.get(alias) || null;
  }

  list() {
    return Array.from(this.entries.values());
  }

  updateLatency(alias, latencyMs) {
    const entry = this.entries.get(alias);
    if (!entry) {
      return null;
    }
    entry.latencyMs = latencyMs;
    entry.lastSeen = Date.now();
    return entry;
  }
}

class SimpleRoutingEngine {
  constructor(options = {}) {
    this.maxPaths = options.maxPaths || 2;
    this.allowRandomFallback = options.allowRandomFallback !== false;
    this.churnIntervalMs = options.churnIntervalMs || 10_000;
    this._lastChurnAt = 0;
    this._cachedOrder = [];
  }

  selectNextHops(packet, neighborTable, targetCoordinates = null) {
    const neighbors = neighborTable.list();
    if (!neighbors.length) {
      return [];
    }

    let sorted = neighbors;
    if (targetCoordinates) {
      sorted = neighbors
        .slice()
        .sort(
          (a, b) =>
            distance(a.coordinates, targetCoordinates) -
            distance(b.coordinates, targetCoordinates)
        );
    } else if (this.allowRandomFallback) {
      sorted = this._maybeChurn(neighbors.slice());
    }

    return sorted.slice(0, this.maxPaths);
  }

  _maybeChurn(neighbors) {
    const now = Date.now();
    if (!this._cachedOrder.length || now - this._lastChurnAt > this.churnIntervalMs) {
      this._cachedOrder = shuffle(neighbors);
      this._lastChurnAt = now;
    }
    return this._cachedOrder.slice();
  }
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

module.exports = {
  NeighborTable,
  SimpleRoutingEngine,
};
