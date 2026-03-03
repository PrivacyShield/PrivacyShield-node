"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  MemoryDHTStore,
  MemoryTransport,
  BasicShufflePolicy,
  DynamicConcurrentRoutingEngine,
  linkPeers,
  createSymmetricKey,
} = require("../src");
const { waitForEvent } = require("./helpers");

class CaptureTransport {
  constructor(alias) {
    this.alias = alias;
    this.sent = [];
  }

  start() {}

  stop() {}

  send(packet, destinationAlias) {
    this.sent.push({ packet, destinationAlias });
    return true;
  }

  registerPeer() {}
}

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

test("split-route session rekey rotates keys and keeps encrypted delivery stable", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({
    dht,
    dynamicRouting: { minPaths: 1, maxPaths: 3, dynamicPathSpread: true, obfuscationNoise: 0.1 },
    routeLaneCount: 6,
    routeObfuscationDelayMs: 0,
    rekeyShareCount: 4,
    rekeyShareSpreadMs: 2,
    rekeyNoisePackets: 2,
    rekeyNoiseBytes: 48,
  });
  const nodeB = new PrivacyShieldNode({
    dht,
    dynamicRouting: { minPaths: 1, maxPaths: 3, dynamicPathSpread: true, obfuscationNoise: 0.1 },
    routeLaneCount: 6,
    routeObfuscationDelayMs: 0,
    rekeyShareCount: 4,
    rekeyShareSpreadMs: 2,
    rekeyNoisePackets: 1,
    rekeyNoiseBytes: 48,
  });
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

    const keyBefore = Buffer.from(nodeA.getSessionKey(nodeB.alias));
    const rekeyA = waitForEvent(nodeA, "session_rekey", {
      timeoutMs: 3_000,
      predicate: (event) => event.alias === nodeB.alias && event.role === "initiator",
    });
    const rekeyB = waitForEvent(nodeB, "session_rekey", {
      timeoutMs: 3_000,
      predicate: (event) => event.alias === nodeA.alias && event.role === "responder",
    });
    const coverSeen = waitForEvent(nodeB, "cover", { timeoutMs: 3_000 });

    const initiated = nodeA.initiateSessionRekey(nodeB.alias, { shareCount: 4, ttl: 3 });
    assert.equal(!!initiated, true);

    await Promise.all([rekeyA, rekeyB, coverSeen]);

    const keyAfterA = nodeA.getSessionKey(nodeB.alias);
    const keyAfterB = nodeB.getSessionKey(nodeA.alias);
    assert.equal(Buffer.compare(keyAfterA, keyAfterB), 0);
    assert.equal(Buffer.compare(keyBefore, keyAfterA) === 0, false);

    const inboundB = waitForEvent(nodeB, "message", {
      predicate: (event) => event.fromAlias === nodeA.alias,
    });
    nodeA.sendMessage(nodeB.alias, Buffer.from("rekeyed-a2b"), { encrypt: true });
    const fromA = await inboundB;
    assert.equal(fromA.payload.toString("utf8"), "rekeyed-a2b");

    const inboundA = waitForEvent(nodeA, "message", {
      predicate: (event) => event.fromAlias === nodeB.alias,
    });
    nodeB.sendMessage(nodeA.alias, Buffer.from("rekeyed-b2a"), { encrypt: true });
    const fromB = await inboundA;
    assert.equal(fromB.payload.toString("utf8"), "rekeyed-b2a");
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

test("dynamic routing annotates concurrent lane metadata for multiplexed transport", () => {
  const transport = new CaptureTransport("node-a");
  const routing = new DynamicConcurrentRoutingEngine({
    minPaths: 2,
    maxPaths: 3,
    dynamicPathSpread: true,
    obfuscationNoise: 0.05,
  });
  const node = new PrivacyShieldNode({
    transport,
    routing,
    routeLaneCount: 4,
    routeObfuscationDelayMs: 0,
  });

  node.addNeighbor({ alias: "n-1", coordinates: { x: 0, y: 0, z: 0 } });
  node.addNeighbor({ alias: "n-2", coordinates: { x: 1, y: 0, z: 0 } });
  node.addNeighbor({ alias: "n-3", coordinates: { x: 2, y: 0, z: 0 } });

  const forwarded = node.sendMessage("unknown-target", Buffer.from("lane-test"), {
    ttl: 4,
  });
  assert.equal(forwarded, true);
  assert.equal(transport.sent.length >= 2 && transport.sent.length <= 3, true);

  const routeGroups = new Set(
    transport.sent.map((entry) => entry.packet.metadata.routeGroup)
  );
  assert.equal(routeGroups.size, 1);

  for (let i = 0; i < transport.sent.length; i += 1) {
    const metadata = transport.sent[i].packet.metadata;
    assert.equal(Number.isInteger(metadata.routeLane), true);
    assert.equal(metadata.routeLane >= 0 && metadata.routeLane < 4, true);
    assert.equal(metadata.routeWidth, transport.sent.length);
    assert.equal(metadata.routeIndex, i);
  }
});
