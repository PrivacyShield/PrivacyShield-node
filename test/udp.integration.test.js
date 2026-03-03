"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  UdpTransport,
  generateIdentity,
  deriveAlias,
} = require("../src");
const { waitForEvent, waitForCondition } = require("./helpers");

test("udp nodes establish encrypted sessions and exchange payloads", async () => {
  const identityA = generateIdentity();
  const identityB = generateIdentity();
  const aliasA = deriveAlias(identityA.publicKey);
  const aliasB = deriveAlias(identityB.publicKey);

  const transportA = new UdpTransport({
    alias: aliasA,
    host: "127.0.0.1",
    port: 0,
    natKeepaliveMs: 0,
  });
  const transportB = new UdpTransport({
    alias: aliasB,
    host: "127.0.0.1",
    port: 0,
    natKeepaliveMs: 0,
  });

  const nodeA = new PrivacyShieldNode({
    identity: identityA,
    transport: transportA,
    dynamicRouting: { minPaths: 1, maxPaths: 1, obfuscationNoise: 0 },
  });
  const nodeB = new PrivacyShieldNode({
    identity: identityB,
    transport: transportB,
    dynamicRouting: { minPaths: 1, maxPaths: 1, obfuscationNoise: 0 },
  });

  nodeA.start();
  nodeB.start();

  try {
    const addressA = await waitForCondition(() => transportA.getAddress(), {
      timeoutMs: 2_000,
    });
    const addressB = await waitForCondition(() => transportB.getAddress(), {
      timeoutMs: 2_000,
    });

    nodeA.addNeighbor({
      alias: aliasB,
      address: { protocol: "udp", host: "127.0.0.1", port: addressB.port },
      metadata: { providerId: "isp-a" },
    });
    nodeB.addNeighbor({
      alias: aliasA,
      address: { protocol: "udp", host: "127.0.0.1", port: addressA.port },
      metadata: { providerId: "isp-b" },
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

    const inbound = waitForEvent(nodeB, "message", {
      timeoutMs: 2_000,
      predicate: (event) => event.fromAlias === aliasA,
    });
    nodeA.sendMessage(aliasB, Buffer.from("udp-sealed"), { encrypt: true });
    const received = await inbound;
    assert.equal(received.payload.toString("utf8"), "udp-sealed");

    const stats = transportA.getStats();
    assert.equal(stats.packetsSent >= 1, true);
    assert.equal(stats.sendFailures >= 0, true);
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});
