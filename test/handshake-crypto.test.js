"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createHandshakeOffer,
  acceptHandshakeOffer,
  finalizeHandshake,
} = require("../src/handshake");
const { generateIdentity } = require("../src/identity");
const {
  createSymmetricKey,
  encryptPayload,
  decryptPayload,
} = require("../src/crypto");

test("handshake roundtrip derives the same session key for both peers", () => {
  const initiator = generateIdentity();
  const responder = generateIdentity();

  const { offer, ephemeral } = createHandshakeOffer(initiator);
  const { response, sessionKey: responderKey } = acceptHandshakeOffer(offer, responder);
  const { sessionKey: initiatorKey } = finalizeHandshake(offer, response, ephemeral);

  assert.equal(Buffer.isBuffer(initiatorKey), true);
  assert.equal(initiatorKey.length, 32);
  assert.equal(Buffer.compare(initiatorKey, responderKey), 0);
});

test("tampered handshake payloads are rejected", () => {
  const initiator = generateIdentity();
  const responder = generateIdentity();

  const { offer, ephemeral } = createHandshakeOffer(initiator);
  const tamperedOffer = {
    ...offer,
    ephemeralPublicKey: offer.ephemeralPublicKey.slice(0, -1) + "A",
  };
  assert.throws(() => acceptHandshakeOffer(tamperedOffer, responder));

  const { response } = acceptHandshakeOffer(offer, responder);
  const tamperedResponse = {
    ...response,
    peerEphemeralPublicKey: "invalid-peer-key",
  };
  assert.throws(() => finalizeHandshake(offer, tamperedResponse, ephemeral));
});

test("aead payloads decrypt only with matching key and aad", () => {
  const key = createSymmetricKey();
  const payload = Buffer.from("hello-shield");
  const encrypted = encryptPayload(payload, key, "ctx:a->b");

  const decrypted = decryptPayload(
    encrypted.ciphertext,
    key,
    encrypted.iv,
    encrypted.tag,
    "ctx:a->b"
  );
  assert.equal(decrypted.toString("utf8"), "hello-shield");

  assert.throws(() =>
    decryptPayload(encrypted.ciphertext, key, encrypted.iv, encrypted.tag, "ctx:b->a")
  );
});

