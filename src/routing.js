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

  values() {
    return this.entries.values();
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
    if (targetCoordinates) {
      return this._selectNearest(neighborTable.values(), targetCoordinates);
    }

    const neighbors = neighborTable.list();
    if (!neighbors.length) {
      return [];
    }
    if (!this.allowRandomFallback) {
      return neighbors.slice(0, this.maxPaths);
    }
    return this._maybeChurn(neighbors.slice()).slice(0, this.maxPaths);
  }

  _maybeChurn(neighbors) {
    const now = Date.now();
    if (!this._cachedOrder.length || now - this._lastChurnAt > this.churnIntervalMs) {
      this._cachedOrder = shuffle(neighbors);
      this._lastChurnAt = now;
    }
    return this._cachedOrder.slice();
  }

  _selectNearest(neighborIterator, targetCoordinates) {
    const limit = Math.max(1, this.maxPaths);
    const best = [];
    for (const neighbor of neighborIterator) {
      const rank = distance(neighbor.coordinates, targetCoordinates);
      if (best.length === 0) {
        best.push({ neighbor, rank });
        continue;
      }

      let insertAt = best.length;
      while (insertAt > 0 && rank < best[insertAt - 1].rank) {
        insertAt -= 1;
      }

      if (insertAt < limit) {
        best.splice(insertAt, 0, { neighbor, rank });
        if (best.length > limit) {
          best.pop();
        }
      }
    }
    return best.map((entry) => entry.neighbor);
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
