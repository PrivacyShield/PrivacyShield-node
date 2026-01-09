const { verifyAliasRecord } = require("./identity");

class MemoryDHTStore {
  constructor(options = {}) {
    this.records = new Map();
    this.clock = options.clock || (() => Date.now());
  }

  put(record) {
    if (!verifyAliasRecord(record)) {
      throw new Error("Invalid alias record signature");
    }
    if (record.expiresAt <= this.clock()) {
      return false;
    }
    this.records.set(record.alias, record);
    return true;
  }

  get(alias) {
    const record = this.records.get(alias);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.clock()) {
      this.records.delete(alias);
      return null;
    }
    return record;
  }

  purgeExpired() {
    const now = this.clock();
    for (const [alias, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(alias);
      }
    }
  }
}

module.exports = {
  MemoryDHTStore,
};
