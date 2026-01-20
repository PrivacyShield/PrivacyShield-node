const crypto = require("crypto");

function hashToUnitFloat(input) {
  const hash = crypto.createHash("sha256").update(input).digest();
  const value = hash.readUInt32BE(0);
  return value / 0xffffffff;
}

function aliasToUnitVector(alias) {
  const angle = hashToUnitFloat(String(alias)) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function estimateCoordinates(samples = []) {
  if (!samples.length) {
    return { x: 0, y: 0, z: 0 };
  }

  let weightedX = 0;
  let weightedY = 0;
  let weightSum = 0;
  let latencySum = 0;

  for (const sample of samples) {
    const latencyMs = Math.max(1, sample.latencyMs || 1);
    const weight = 1 / latencyMs;
    const unit = aliasToUnitVector(sample.alias);
    weightedX += unit.x * weight;
    weightedY += unit.y * weight;
    weightSum += weight;
    latencySum += latencyMs;
  }

  const averageLatency = latencySum / samples.length;
  const x = weightedX / weightSum;
  const y = weightedY / weightSum;
  const z = Math.log2(averageLatency + 1);

  return { x, y, z };
}

function quantizeCoordinate(coordinate, regionSize) {
  if (!regionSize) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: Math.round(coordinate.x / regionSize),
    y: Math.round(coordinate.y / regionSize),
    z: Math.round(coordinate.z / regionSize),
  };
}

function quantizeAcrossScales(coordinate, regionSizes = [0.25, 1, 5]) {
  const table = {};
  for (const size of regionSizes) {
    table[size] = quantizeCoordinate(coordinate, size);
  }
  return table;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = {
  estimateCoordinates,
  quantizeCoordinate,
  quantizeAcrossScales,
  distance,
};
