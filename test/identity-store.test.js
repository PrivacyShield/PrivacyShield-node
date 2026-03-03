"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  saveIdentityToFile,
  loadIdentityFromFile,
  loadOrCreateIdentity,
  generateIdentity,
} = require("../src");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "privacyshield-node-"));
}

test("identity store saves and reloads key material with stable alias", () => {
  const dir = createTempDir();
  const identityPath = path.join(dir, "identity.json");
  try {
    const identity = generateIdentity();
    const saved = saveIdentityToFile(identityPath, identity);
    const loaded = loadIdentityFromFile(identityPath);

    assert.equal(loaded.alias, saved.alias);
    assert.equal(typeof loaded.identity.publicKey.export, "function");
    assert.equal(typeof loaded.identity.privateKey.export, "function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateIdentity creates once and then reloads without regenerating", () => {
  const dir = createTempDir();
  const identityPath = path.join(dir, "identity.json");
  try {
    const first = loadOrCreateIdentity(identityPath);
    const second = loadOrCreateIdentity(identityPath);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.alias, first.alias);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity store rejects files whose declared alias mismatches key material", () => {
  const dir = createTempDir();
  const identityPath = path.join(dir, "identity.json");
  try {
    const identity = generateIdentity();
    saveIdentityToFile(identityPath, identity);

    const tampered = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    tampered.alias = "deadbeefcafe";
    fs.writeFileSync(identityPath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => loadIdentityFromFile(identityPath),
      /Identity alias mismatch/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

