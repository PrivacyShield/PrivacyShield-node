const crypto = require("crypto");

class NoShufflePolicy {
  apply(payload) {
    return { payload, delayMs: 0, paddingBytes: 0 };
  }
}

class BasicShufflePolicy {
  constructor(options = {}) {
    this.minPadding = options.minPadding || 0;
    this.maxPadding = options.maxPadding || 32;
    this.maxDelayMs = options.maxDelayMs || 0;
  }

  apply(payload) {
    const paddingBytes = randomInt(this.minPadding, this.maxPadding);
    const delayMs = randomInt(0, this.maxDelayMs);
    const padding = paddingBytes ? crypto.randomBytes(paddingBytes) : Buffer.alloc(0);
    return {
      payload: Buffer.concat([payload, padding]),
      delayMs,
      paddingBytes,
    };
  }
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
  NoShufflePolicy,
  BasicShufflePolicy,
};
