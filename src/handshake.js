const crypto = require("crypto");
const { createAliasRecord, verifyAliasRecord, importPublicKey } = require("./identity");

const HANDSHAKE_PROTOCOL = "ps-handshake/v1";

function exportX25519PublicKey(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function importX25519PublicKey(encoded) {
  return crypto.createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
}

function generateEphemeralKeyPair() {
  return crypto.generateKeyPairSync("x25519");
}

function signHandshakePayload(payload, privateKey) {
  return crypto.sign(null, canonicalize(payload), privateKey).toString("base64");
}

function verifyHandshakePayload(payload, signature, publicKeyEncoded) {
  const publicKey = importPublicKey(publicKeyEncoded);
  return crypto.verify(null, canonicalize(payload), publicKey, Buffer.from(signature, "base64"));
}

function deriveSessionKey(sharedSecret, initiatorAlias, responderAlias) {
  const context = Buffer.from(`${HANDSHAKE_PROTOCOL}|${initiatorAlias}|${responderAlias}`);
  const hmac = crypto.createHmac("sha256", context);
  hmac.update(sharedSecret);
  return hmac.digest().subarray(0, 32);
}

function canonicalize(payload) {
  return Buffer.from(JSON.stringify(payload));
}

function createHandshakeOffer(identity, options = {}) {
  const ephemeral = generateEphemeralKeyPair();
  const aliasRecord = options.aliasRecord || createAliasRecord(identity, { coordinates: options.coordinates });
  const payload = {
    version: 1,
    aliasRecord,
    ephemeralPublicKey: exportX25519PublicKey(ephemeral.publicKey),
  };
  const signature = signHandshakePayload(payload, identity.privateKey);
  return {
    offer: { ...payload, signature },
    ephemeral,
  };
}

function acceptHandshakeOffer(offer, identity, options = {}) {
  if (!offer || offer.version !== 1) {
    throw new Error("Unsupported handshake offer");
  }
  if (!verifyAliasRecord(offer.aliasRecord)) {
    throw new Error("Invalid alias record in offer");
  }
  const peerKey = offer.aliasRecord.publicKey;
  if (!verifyHandshakePayload(
    {
      version: offer.version,
      aliasRecord: offer.aliasRecord,
      ephemeralPublicKey: offer.ephemeralPublicKey,
    },
    offer.signature,
    peerKey
  )) {
    throw new Error("Invalid handshake offer signature");
  }

  const responderEphemeral = generateEphemeralKeyPair();
  const sharedSecret = crypto.diffieHellman({
    privateKey: responderEphemeral.privateKey,
    publicKey: importX25519PublicKey(offer.ephemeralPublicKey),
  });

  const aliasRecord = options.aliasRecord || createAliasRecord(identity, { coordinates: options.coordinates });
  const responsePayload = {
    version: 1,
    aliasRecord,
    peerEphemeralPublicKey: offer.ephemeralPublicKey,
    ephemeralPublicKey: exportX25519PublicKey(responderEphemeral.publicKey),
  };
  const signature = signHandshakePayload(responsePayload, identity.privateKey);
  const sessionKey = deriveSessionKey(
    sharedSecret,
    offer.aliasRecord.alias,
    aliasRecord.alias
  );

  return {
    response: { ...responsePayload, signature },
    sessionKey,
  };
}

function finalizeHandshake(offer, response, initiatorEphemeral) {
  if (!response || response.version !== 1) {
    throw new Error("Unsupported handshake response");
  }
  if (!verifyAliasRecord(response.aliasRecord)) {
    throw new Error("Invalid alias record in response");
  }
  const peerKey = response.aliasRecord.publicKey;
  if (!verifyHandshakePayload(
    {
      version: response.version,
      aliasRecord: response.aliasRecord,
      peerEphemeralPublicKey: response.peerEphemeralPublicKey,
      ephemeralPublicKey: response.ephemeralPublicKey,
    },
    response.signature,
    peerKey
  )) {
    throw new Error("Invalid handshake response signature");
  }
  if (!offer || offer.ephemeralPublicKey !== response.peerEphemeralPublicKey) {
    throw new Error("Response does not reference offer");
  }
  const sharedSecret = crypto.diffieHellman({
    privateKey: initiatorEphemeral.privateKey,
    publicKey: importX25519PublicKey(response.ephemeralPublicKey),
  });
  const sessionKey = deriveSessionKey(
    sharedSecret,
    offer.aliasRecord.alias,
    response.aliasRecord.alias
  );
  return { sessionKey };
}

module.exports = {
  HANDSHAKE_PROTOCOL,
  createHandshakeOffer,
  acceptHandshakeOffer,
  finalizeHandshake,
  deriveSessionKey,
  generateEphemeralKeyPair,
  exportX25519PublicKey,
  importX25519PublicKey,
};
