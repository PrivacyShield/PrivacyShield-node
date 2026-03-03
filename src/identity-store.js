"use strict";

const fs = require("fs");
const path = require("path");
const {
  generateIdentity,
  deriveAlias,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
} = require("./identity");

function saveIdentityToFile(filePath, identity, options = {}) {
  const absolutePath = path.resolve(filePath);
  const alias = deriveAlias(identity.publicKey);
  const payload = {
    alias,
    publicKey: exportPublicKey(identity.publicKey),
    privateKey: exportPrivateKey(identity.privateKey),
    createdAt: options.createdAt || new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 }
  );

  return {
    alias,
    filePath: absolutePath,
  };
}

function loadIdentityFromFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!raw.publicKey || !raw.privateKey) {
    throw new Error(`Identity file is missing key material: ${absolutePath}`);
  }

  const publicKey = importPublicKey(raw.publicKey);
  const privateKey = importPrivateKey(raw.privateKey);
  const alias = deriveAlias(publicKey);
  if (raw.alias && raw.alias !== alias) {
    throw new Error(`Identity alias mismatch: ${absolutePath}`);
  }

  return {
    identity: { publicKey, privateKey },
    alias,
    filePath: absolutePath,
    createdAt: raw.createdAt || null,
  };
}

function loadOrCreateIdentity(filePath) {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) {
    return {
      ...loadIdentityFromFile(absolutePath),
      created: false,
    };
  }

  const identity = generateIdentity();
  const { alias } = saveIdentityToFile(absolutePath, identity);
  return {
    identity,
    alias,
    filePath: absolutePath,
    createdAt: null,
    created: true,
  };
}

module.exports = {
  saveIdentityToFile,
  loadIdentityFromFile,
  loadOrCreateIdentity,
};

