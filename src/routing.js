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
      return this._selectNearest(
        neighborTable.values(),
        targetCoordinates,
        this.maxPaths
      );
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

  _selectNearest(
    neighborIterator,
    targetCoordinates,
    limit = this.maxPaths,
    options = {}
  ) {
    const normalizedLimit = Math.max(1, limit);
    const obfuscationNoise = Number.isFinite(options.obfuscationNoise)
      ? Math.max(0, options.obfuscationNoise)
      : 0;
    const best = [];
    for (const neighbor of neighborIterator) {
      const rawRank = distance(neighbor.coordinates, targetCoordinates);
      const rank = applyNoise(rawRank, obfuscationNoise);
      if (best.length === 0) {
        best.push({ neighbor, rank });
        continue;
      }

      let insertAt = best.length;
      while (insertAt > 0 && rank < best[insertAt - 1].rank) {
        insertAt -= 1;
      }

      if (insertAt < normalizedLimit) {
        best.splice(insertAt, 0, { neighbor, rank });
        if (best.length > normalizedLimit) {
          best.pop();
        }
      }
    }
    return best.map((entry) => entry.neighbor);
  }
}

class DynamicConcurrentRoutingEngine extends SimpleRoutingEngine {
  constructor(options = {}) {
    super(options);
    this.minPaths = Math.max(1, options.minPaths || 1);
    this.dynamicPathSpread = options.dynamicPathSpread !== false;
    this.obfuscationNoise = Math.max(0, options.obfuscationNoise || 0);
  }

  selectNextHops(packet, neighborTable, targetCoordinates = null) {
    const neighbors = neighborTable.list();
    if (!neighbors.length) {
      return [];
    }

    const upper = Math.min(this.maxPaths, neighbors.length);
    const lower = Math.min(this.minPaths, upper);
    const pathCount = this._computePathCount(packet, lower, upper);

    if (targetCoordinates) {
      return this._selectNearest(
        neighbors.values(),
        targetCoordinates,
        pathCount,
        { obfuscationNoise: this.obfuscationNoise }
      );
    }

    if (!this.allowRandomFallback) {
      return neighbors.slice(0, pathCount);
    }
    return this._maybeChurn(neighbors.slice()).slice(0, pathCount);
  }

  _computePathCount(packet, lower, upper) {
    if (!this.dynamicPathSpread || upper <= lower) {
      return upper;
    }
    const ttl = packet && Number.isInteger(packet.ttl) ? packet.ttl : 1;
    const ttlFactor = Math.max(0, Math.min(1, ttl / 6));
    const pivot = lower + Math.round((upper - lower) * ttlFactor);
    const min = Math.max(lower, pivot - 1);
    const max = Math.min(upper, pivot + 1);
    return randomInt(min, max);
  }
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function applyNoise(value, noiseFactor) {
  if (!noiseFactor || value === 0) {
    return value;
  }
  const maxNoise = Math.max(0.0001, value * noiseFactor);
  const offset = randomFloat(-maxNoise, maxNoise);
  return value + offset;
}

function randomFloat(min, max) {
  if (max <= min) {
    return min;
  }
  const precision = 1_000_000;
  const integer = crypto.randomInt(0, precision + 1);
  return min + (max - min) * (integer / precision);
}

function randomInt(min, max) {
  const upper = Math.max(min, max);
  const lower = Math.min(min, max);
  if (upper === lower) {
    return upper;
  }
  return crypto.randomInt(lower, upper + 1);
}

module.exports = {
  NeighborTable,
  SimpleRoutingEngine,
  DynamicConcurrentRoutingEngine,
};
