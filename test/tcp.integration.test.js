"use strict";

const net = require("net");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  TcpTransport,
  generateIdentity,
  deriveAlias,
  createPacket,
} = require("../src");
const { waitForEvent, waitForCondition } = require("./helpers");

test("tcp nodes establish encrypted sessions and learn return routes", async () => {
  const identityA = generateIdentity();
  const identityB = generateIdentity();
  const aliasA = deriveAlias(identityA.publicKey);
  const aliasB = deriveAlias(identityB.publicKey);

  const transportA = new TcpTransport({ alias: aliasA, host: "127.0.0.1", port: 0 });
  const transportB = new TcpTransport({ alias: aliasB, host: "127.0.0.1", port: 0 });

  const nodeA = new PrivacyShieldNode({ identity: identityA, transport: transportA });
  const nodeB = new PrivacyShieldNode({ identity: identityB, transport: transportB });

  nodeA.start();
  nodeB.start();

  try {
    const addressA = await waitForCondition(() => transportA.getAddress(), { timeoutMs: 2_000 });
    const addressB = await waitForCondition(() => transportB.getAddress(), { timeoutMs: 2_000 });
    assert.equal(typeof addressA.port, "number");
    assert.equal(typeof addressB.port, "number");

    nodeA.addNeighbor({
      alias: aliasB,
      address: { host: "127.0.0.1", port: addressB.port },
    });

    const sessionA = waitForEvent(nodeA, "session", {
      timeoutMs: 2_000,
      predicate: (event) => event.alias === aliasB,
    });
    const sessionB = waitForEvent(nodeB, "session", {
      timeoutMs: 2_000,
      predicate: (event) => event.alias === aliasA,
    });
    nodeA.initiateSessionHandshake(aliasB);
    await Promise.all([sessionA, sessionB]);

    const learned = nodeB.neighbors.get(aliasA);
    assert.equal(!!learned, true);
    assert.equal(typeof learned.address, "object");
    assert.equal(learned.address.host, "127.0.0.1");
    assert.equal(learned.address.port, addressA.port);

    const bInbound = waitForEvent(nodeB, "message", {
      timeoutMs: 2_000,
      predicate: (event) => event.fromAlias === aliasA,
    });
    nodeA.sendMessage(aliasB, Buffer.from("tcp-sealed-1"), { encrypt: true });
    const fromA = await bInbound;
    assert.equal(fromA.payload.toString("utf8"), "tcp-sealed-1");

    const aInbound = waitForEvent(nodeA, "message", {
      timeoutMs: 2_000,
      predicate: (event) => event.fromAlias === aliasB,
    });
    nodeB.sendMessage(aliasA, Buffer.from("tcp-sealed-2"), { encrypt: true });
    const fromB = await aInbound;
    assert.equal(fromB.payload.toString("utf8"), "tcp-sealed-2");
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});

test("tcp transport accepts backward-compatible base64-framed packets", async () => {
  const identity = generateIdentity();
  const alias = deriveAlias(identity.publicKey);
  const transport = new TcpTransport({ alias, host: "127.0.0.1", port: 0 });
  const node = new PrivacyShieldNode({ identity, transport });
  node.start();

  try {
    const address = await waitForCondition(() => transport.getAddress(), { timeoutMs: 2_000 });
    const inbound = waitForEvent(node, "message", {
      timeoutMs: 2_000,
      predicate: (event) => event.fromAlias === "legacy-client",
    });
    const packet = createPacket({
      srcAlias: "legacy-client",
      dstAlias: alias,
      payload: Buffer.from("legacy-frame"),
    });
    const frame = `${Buffer.from(JSON.stringify({
      version: packet.version,
      srcAlias: packet.srcAlias,
      dstAlias: packet.dstAlias,
      ttl: packet.ttl,
      hopCount: packet.hopCount,
      payload: packet.payload.toString("base64"),
      metadata: packet.metadata || {},
      encryption: packet.encryption || null,
    })).toString("base64")}\n`;

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(address.port, address.host);
      socket.once("error", reject);
      socket.write(frame, () => {
        socket.end();
        resolve();
      });
    });

    const received = await inbound;
    assert.equal(received.payload.toString("utf8"), "legacy-frame");
  } finally {
    node.stop();
  }
});
