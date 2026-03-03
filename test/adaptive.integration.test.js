"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  TcpTransport,
  UdpTransport,
  AdaptiveTransport,
  generateIdentity,
  deriveAlias,
} = require("../src");
const { waitForEvent, waitForCondition } = require("./helpers");

test("adaptive transport falls back from UDP to TCP when UDP path is unavailable", async () => {
  const identityA = generateIdentity();
  const identityB = generateIdentity();
  const aliasA = deriveAlias(identityA.publicKey);
  const aliasB = deriveAlias(identityB.publicKey);

  const tcpA = new TcpTransport({ alias: aliasA, host: "127.0.0.1", port: 0 });
  tcpA.name = "tcp";
  const udpA = new UdpTransport({
    alias: aliasA,
    host: "127.0.0.1",
    port: 0,
    natKeepaliveMs: 0,
  });
  udpA.name = "udp";
  const transportA = new AdaptiveTransport({
    alias: aliasA,
    transports: [udpA, tcpA],
    preferredOrder: ["udp", "tcp"],
  });

  const transportB = new TcpTransport({ alias: aliasB, host: "127.0.0.1", port: 0 });
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
    const addressB = await waitForCondition(() => transportB.getAddress(), {
      timeoutMs: 2_000,
    });
    nodeA.addNeighbor({
      alias: aliasB,
      address: {
        candidates: [
          {
            protocol: "udp",
            host: "127.0.0.1",
            port: addressB.port + 1000,
          },
          {
            protocol: "tcp",
            host: "127.0.0.1",
            port: addressB.port,
          },
        ],
      },
    });

    const sessionA = waitForEvent(nodeA, "session", {
      timeoutMs: 2_500,
      predicate: (event) => event.alias === aliasB,
    });
    const sessionB = waitForEvent(nodeB, "session", {
      timeoutMs: 2_500,
      predicate: (event) => event.alias === aliasA,
    });
    nodeA.initiateSessionHandshake(aliasB);
    await Promise.all([sessionA, sessionB]);

    const inbound = waitForEvent(nodeB, "message", {
      timeoutMs: 2_000,
      predicate: (event) => event.fromAlias === aliasA,
    });
    nodeA.sendMessage(aliasB, Buffer.from("adaptive-fallback"), {
      encrypt: true,
      metadata: {
        transportPreference: "tcp",
      },
    });
    const received = await inbound;
    assert.equal(received.payload.toString("utf8"), "adaptive-fallback");

    const stats = transportA.getStats();
    assert.equal(stats.sendSuccesses >= 1, true);
    assert.equal(stats.fallbackSuccesses >= 1, true);
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
});
