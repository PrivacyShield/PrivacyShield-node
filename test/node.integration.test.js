"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  MemoryDHTStore,
  MemoryTransport,
  BasicShufflePolicy,
  linkPeers,
  createSymmetricKey,
} = require("../src");
const { waitForEvent } = require("./helpers");

test.beforeEach(() => {
  MemoryTransport.reset();
});

test.afterEach(() => {
  MemoryTransport.reset();
});

test("in-memory nodes exchange plaintext messages", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({ dht });
  const nodeB = new PrivacyShieldNode({ dht });
  linkPeers(nodeA, nodeB);

  nodeA.start();
  nodeB.start();

  try {
    const messagePromise = waitForEvent(nodeB, "message");
    nodeA.sendMessage(nodeB.alias, Buffer.from("hello"));
    const received = await messagePromise;
    assert.equal(received.payload.toString("utf8"), "hello");
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});

test("handshake and encrypted messages work with padded shuffle payloads", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({
    dht,
    shufflePolicy: new BasicShufflePolicy({ minPadding: 8, maxPadding: 8, maxDelayMs: 0 }),
  });
  const nodeB = new PrivacyShieldNode({ dht });
  linkPeers(nodeA, nodeB);

  nodeA.start();
  nodeB.start();

  try {
    const sessionA = waitForEvent(nodeA, "session", {
      predicate: (event) => event.alias === nodeB.alias,
    });
    const sessionB = waitForEvent(nodeB, "session", {
      predicate: (event) => event.alias === nodeA.alias,
    });
    nodeA.initiateSessionHandshake(nodeB.alias);
    await Promise.all([sessionA, sessionB]);

    assert.equal(nodeA.hasSessionKey(nodeB.alias), true);
    assert.equal(nodeB.hasSessionKey(nodeA.alias), true);

    const messagePromise = waitForEvent(nodeB, "message");
    nodeA.sendMessage(nodeB.alias, Buffer.from("sealed"), { encrypt: true });
    const received = await messagePromise;
    assert.equal(received.payload.toString("utf8"), "sealed");
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});

test("encrypted packets are dropped when the receiver has no session key", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({ dht });
  const nodeB = new PrivacyShieldNode({ dht });
  linkPeers(nodeA, nodeB);

  nodeA.start();
  nodeB.start();

  try {
    nodeA.registerSessionKey(nodeB.alias, createSymmetricKey());
    const dropPromise = waitForEvent(nodeB, "drop", {
      predicate: (event) => event.reason === "missing_session_key",
    });
    nodeA.sendMessage(nodeB.alias, Buffer.from("secret"), { encrypt: true });
    const dropped = await dropPromise;
    assert.equal(dropped.reason, "missing_session_key");
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});

test("forwarding does not bounce packets back to the immediate sender", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({ dht, maxTtl: 3 });
  const nodeB = new PrivacyShieldNode({ dht, maxTtl: 3 });
  linkPeers(nodeA, nodeB);

  nodeA.start();
  nodeB.start();

  try {
    const bDropPromise = waitForEvent(nodeB, "drop", {
      predicate: (event) => event.reason === "no_route",
    });
    const aTtlDropPromise = waitForEvent(nodeA, "drop", {
      predicate: (event) => event.reason === "ttl_expired",
      timeoutMs: 80,
    });

    nodeA.sendMessage("ffffffffffff", Buffer.from("probe"), { ttl: 3 });
    const dropped = await bDropPromise;
    assert.equal(dropped.reason, "no_route");

    await assert.rejects(aTtlDropPromise, /Timed out waiting for "drop"/);
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});

test("rotateIdentity resets transient state and keeps the node running", () => {
  const node = new PrivacyShieldNode();
  const peerAlias = "cafebabefeed";
  node.registerSessionKey(peerAlias, createSymmetricKey());
  node.pendingHandshakes.set(peerAlias, { role: "initiator", offer: {}, ephemeral: {} });
  node.start();

  try {
    const oldAlias = node.alias;
    const newAlias = node.rotateIdentity();
    assert.notEqual(newAlias, oldAlias);
    assert.equal(node.started, true);
    assert.equal(node.sessionKeys.size, 0);
    assert.equal(node.pendingHandshakes.size, 0);
    assert.equal(node.latestAliasRecord.alias, newAlias);
  } finally {
    node.stop();
  }
});

test("latency sample history is bounded and keeps region quantization updated", () => {
  const node = new PrivacyShieldNode();
  for (let i = 0; i < 60; i += 1) {
    node.recordLatencySample(`peer-${i}`, 10 + i);
  }
  assert.equal(node.coordinateSamples.length, 50);
  assert.equal(typeof node.coordinates.x, "number");
  assert.equal(typeof node.coordinates.y, "number");
  assert.equal(typeof node.coordinates.z, "number");
  assert.equal(typeof node.regionTable["1"].x, "number");
});
