const crypto = require("crypto");

const DEFAULT_CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function createSymmetricKey() {
  return crypto.randomBytes(KEY_BYTES);
}

function encryptPayload(plaintext, key, aad = null) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(DEFAULT_CIPHER, key, iv);
  if (aad) {
    cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
  }
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext, algorithm: DEFAULT_CIPHER };
}

function decryptPayload(ciphertext, key, iv, tag, aad = null) {
  const decipher = crypto.createDecipheriv(DEFAULT_CIPHER, key, iv);
  if (aad) {
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  DEFAULT_CIPHER,
  IV_BYTES,
  KEY_BYTES,
  createSymmetricKey,
  encryptPayload,
  decryptPayload,
};
