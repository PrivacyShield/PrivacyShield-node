"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateIdentity,
  createAliasRecord,
  verifyAliasRecord,
} = require("../src/identity");
const { MemoryDHTStore } = require("../src/dht");

test("alias records verify and are bound to the signer public key", () => {
  const identity = generateIdentity();
  const valid = createAliasRecord(identity);
  assert.equal(verifyAliasRecord(valid), true);

  const mismatchedAlias = createAliasRecord(identity, { alias: "deadbeefcafe" });
  assert.equal(verifyAliasRecord(mismatchedAlias), false);
});

test("verifyAliasRecord returns false for malformed records", () => {
  const malformed = {
    alias: "deadbeefcafe",
    publicKey: "not-base64",
    expiresAt: Date.now() + 10_000,
    coordinates: null,
    signature: "not-base64",
  };
  assert.doesNotThrow(() => verifyAliasRecord(malformed));
  assert.equal(verifyAliasRecord(malformed), false);
});

test("memory dht stores valid records and expires them via injected clock", () => {
  let now = 1_700_000_000_000;
  const dht = new MemoryDHTStore({ clock: () => now });
  const identity = generateIdentity();
  const record = createAliasRecord(identity, { expiresAt: now + 25 });
  assert.equal(dht.put(record), true);
  assert.equal(dht.get(record.alias).alias, record.alias);

  now += 50;
  assert.equal(dht.get(record.alias), null);

  const alreadyExpired = createAliasRecord(generateIdentity(), { expiresAt: now - 1 });
  assert.equal(dht.put(alreadyExpired), false);
});

test("memory dht rejects records with invalid signatures", () => {
  const dht = new MemoryDHTStore();
  const record = createAliasRecord(generateIdentity());
  const tampered = { ...record, signature: Buffer.alloc(64, 1).toString("base64") };
  assert.throws(() => dht.put(tampered), /Invalid alias record signature/);
});

