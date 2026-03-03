const crypto = require("crypto");
const { distance } = require("./coordinates");
const OVERLAY_RING_SPACE = 2 ** 48;

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

class RingAwareRoutingEngine extends DynamicConcurrentRoutingEngine {
  constructor(options = {}) {
    super(options);
    this.overlayNamespace = options.overlayNamespace || "ps-ring-v1";
    this.coordinateWeight = normalizeFloat(options.coordinateWeight, 1);
    this.ringWeight = normalizeFloat(options.ringWeight, 0.8);
    this.latencyWeight = normalizeFloat(options.latencyWeight, 0.04);
    this.providerDiversityWeight = normalizeFloat(
      options.providerDiversityWeight,
      0.9
    );
    this.subRegionDiversityWeight = normalizeFloat(
      options.subRegionDiversityWeight,
      0.5
    );
    this.enforceProviderDiversity = options.enforceProviderDiversity !== false;
  }

  selectNextHops(packet, neighborTable, targetCoordinates = null) {
    const neighbors = neighborTable.list();
    if (!neighbors.length) {
      return [];
    }

    const upper = Math.min(this.maxPaths, neighbors.length);
    const lower = Math.min(this.minPaths, upper);
    const pathCount = this._computePathCount(packet, lower, upper);
    const targetOverlayId =
      packet && packet.dstAlias
        ? deriveOverlayId(packet.dstAlias, this.overlayNamespace)
        : null;

    return this._selectRingDiversePaths(
      neighbors,
      pathCount,
      targetCoordinates,
      targetOverlayId
    );
  }

  _selectRingDiversePaths(neighbors, pathCount, targetCoordinates, targetOverlayId) {
    const selected = [];
    const pending = neighbors.map((neighbor) => ({
      neighbor,
      baseScore: this._computeRingScore(neighbor, targetCoordinates, targetOverlayId),
      providerId: inferProviderId(neighbor),
      subRegionId: inferSubRegionId(neighbor),
    }));

    const usedProviders = new Set();
    const usedSubRegions = new Set();

    while (selected.length < pathCount && pending.length) {
      let bestIndex = 0;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let i = 0; i < pending.length; i += 1) {
        const candidate = pending[i];
        let score = candidate.baseScore;
        if (this.enforceProviderDiversity && candidate.providerId) {
          if (usedProviders.has(candidate.providerId)) {
            score += this.providerDiversityWeight;
          }
        }
        if (candidate.subRegionId && usedSubRegions.has(candidate.subRegionId)) {
          score += this.subRegionDiversityWeight;
        }
        if (score < bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      const [picked] = pending.splice(bestIndex, 1);
      selected.push(picked.neighbor);
      if (picked.providerId) {
        usedProviders.add(picked.providerId);
      }
      if (picked.subRegionId) {
        usedSubRegions.add(picked.subRegionId);
      }
    }

    return selected;
  }

  _computeRingScore(neighbor, targetCoordinates, targetOverlayId) {
    const coordScore = targetCoordinates
      ? distance(neighbor.coordinates, targetCoordinates) * this.coordinateWeight
      : 0;
    const overlayId = deriveOverlayId(neighbor.alias, this.overlayNamespace);
    const ringScore = targetOverlayId
      ? normalizedRingDistance(overlayId, targetOverlayId) * this.ringWeight
      : 0;
    const latencyScore = neighbor.latencyMs
      ? neighbor.latencyMs * this.latencyWeight
      : 0;
    const raw = coordScore + ringScore + latencyScore;
    return applyNoise(raw, this.obfuscationNoise);
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

function deriveOverlayId(value, namespace = "ps-ring-v1") {
  const normalized = `${namespace}|${value || ""}`;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function normalizedRingDistance(a, b) {
  const aNum = parseHex48(a);
  const bNum = parseHex48(b);
  const direct = Math.abs(aNum - bNum);
  const wrapped = OVERLAY_RING_SPACE - direct;
  return Math.min(direct, wrapped) / OVERLAY_RING_SPACE;
}

function parseHex48(value) {
  const normalized =
    typeof value === "string" && value.length ? value.slice(0, 12) : "0";
  return Number.parseInt(normalized, 16) || 0;
}

function inferProviderId(neighbor) {
  if (!neighbor || !neighbor.metadata) {
    return null;
  }
  return neighbor.metadata.providerId || null;
}

function inferSubRegionId(neighbor) {
  if (!neighbor || !neighbor.metadata) {
    return null;
  }
  return neighbor.metadata.subRegionId || null;
}

function normalizeFloat(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  NeighborTable,
  SimpleRoutingEngine,
  DynamicConcurrentRoutingEngine,
  RingAwareRoutingEngine,
  deriveOverlayId,
};
