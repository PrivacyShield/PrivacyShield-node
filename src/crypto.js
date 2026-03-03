const crypto = require("crypto");

const DEFAULT_CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const REKEY_BYTES = 32;

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

function splitSecretXor(secret, shareCount = 3) {
  if (!Buffer.isBuffer(secret) || !secret.length) {
    throw new Error("Secret must be a non-empty Buffer");
  }
  const total = Number.parseInt(shareCount, 10);
  if (!Number.isInteger(total) || total < 2) {
    throw new Error("shareCount must be an integer >= 2");
  }

  const shares = [];
  let accumulator = Buffer.alloc(secret.length, 0);
  for (let i = 0; i < total - 1; i += 1) {
    const randomShare = crypto.randomBytes(secret.length);
    shares.push(randomShare);
    accumulator = xorBuffers(accumulator, randomShare);
  }
  shares.push(xorBuffers(secret, accumulator));
  return shares;
}

function combineSecretXor(shares) {
  if (!Array.isArray(shares) || shares.length < 2) {
    throw new Error("shares must contain at least 2 entries");
  }
  const length = shares[0] && shares[0].length;
  if (!length) {
    throw new Error("shares must be non-empty Buffers");
  }
  let result = Buffer.alloc(length, 0);
  for (const share of shares) {
    if (!Buffer.isBuffer(share) || share.length !== length) {
      throw new Error("all shares must be Buffers with equal length");
    }
    result = xorBuffers(result, share);
  }
  return result;
}

function deriveRekeySessionKey(
  currentKey,
  rekeyMaterial,
  initiatorAlias,
  responderAlias,
  epoch
) {
  if (!Buffer.isBuffer(currentKey) || currentKey.length !== KEY_BYTES) {
    throw new Error("currentKey must be a 32-byte Buffer");
  }
  if (!Buffer.isBuffer(rekeyMaterial) || rekeyMaterial.length < REKEY_BYTES) {
    throw new Error("rekeyMaterial must be at least 32 bytes");
  }
  const normalizedEpoch = Number.isInteger(epoch) ? epoch : 0;
  const context = Buffer.from(
    `ps-rekey/v1|${initiatorAlias}|${responderAlias}|${normalizedEpoch}`
  );
  const hmac = crypto.createHmac("sha256", currentKey);
  hmac.update(context);
  hmac.update(rekeyMaterial);
  return hmac.digest().subarray(0, KEY_BYTES);
}

function xorBuffers(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) {
    throw new Error("xorBuffers requires equal-length Buffers");
  }
  const output = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) {
    output[i] = a[i] ^ b[i];
  }
  return output;
}

module.exports = {
  DEFAULT_CIPHER,
  IV_BYTES,
  KEY_BYTES,
  REKEY_BYTES,
  createSymmetricKey,
  encryptPayload,
  decryptPayload,
  splitSecretXor,
  combineSecretXor,
  deriveRekeySessionKey,
};
