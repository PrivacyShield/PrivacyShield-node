const crypto = require("crypto");

const DEFAULT_ALIAS_TTL_MS = 10 * 60 * 1000;
const ALIAS_BYTES = 6;

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

function exportPublicKey(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function exportPrivateKey(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

function importPublicKey(encoded) {
  return crypto.createPublicKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "spki",
  });
}

function importPrivateKey(encoded) {
  return crypto.createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function deriveAlias(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  const hash = crypto.createHash("sha256").update(der).digest();
  return hash.subarray(0, ALIAS_BYTES).toString("hex");
}

function canonicalizeAliasRecord(record) {
  const normalized = {
    alias: record.alias,
    publicKey: record.publicKey,
    expiresAt: record.expiresAt,
    coordinates: record.coordinates || null,
  };
  return Buffer.from(JSON.stringify(normalized));
}

function signAliasRecord(record, privateKey) {
  const payload = canonicalizeAliasRecord(record);
  return crypto.sign(null, payload, privateKey).toString("base64");
}

function verifyAliasRecord(record) {
  if (!record || !record.signature || !record.publicKey) {
    return false;
  }
  const payload = canonicalizeAliasRecord(record);
  const publicKey = importPublicKey(record.publicKey);
  return crypto.verify(
    null,
    payload,
    publicKey,
    Buffer.from(record.signature, "base64")
  );
}

function createAliasRecord(identity, options = {}) {
  const alias = options.alias || deriveAlias(identity.publicKey);
  const ttlMs = options.ttlMs || DEFAULT_ALIAS_TTL_MS;
  const expiresAt = options.expiresAt || Date.now() + ttlMs;
  const publicKey = exportPublicKey(identity.publicKey);
  const record = {
    alias,
    publicKey,
    expiresAt,
    coordinates: options.coordinates || null,
  };
  const signature = signAliasRecord(record, identity.privateKey);
  return { ...record, signature };
}

module.exports = {
  ALIAS_BYTES,
  DEFAULT_ALIAS_TTL_MS,
  generateIdentity,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  deriveAlias,
  createAliasRecord,
  signAliasRecord,
  verifyAliasRecord,
};
