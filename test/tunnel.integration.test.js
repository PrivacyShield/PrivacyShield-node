"use strict";

const net = require("net");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PrivacyShieldNode,
  MemoryDHTStore,
  MemoryTransport,
  linkPeers,
  PrivacyShieldTunnelGateway,
  PrivacyShieldTunnelBinding,
} = require("../src");
const { waitForCondition, waitForEvent } = require("./helpers");

test.beforeEach(() => {
  MemoryTransport.reset();
});

test.afterEach(() => {
  MemoryTransport.reset();
});

test("tcp tunnel bridge proxies legacy stream traffic through PrivacyShield nodes", async () => {
  const dht = new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({ dht });
  const nodeB = new PrivacyShieldNode({ dht });
  linkPeers(nodeA, nodeB);

  const echoServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
    });
  });

  await new Promise((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
  const echoAddress = echoServer.address();

  nodeA.start();
  nodeB.start();

  const gateway = new PrivacyShieldTunnelGateway({
    node: nodeB,
    targetHost: "127.0.0.1",
    targetPort: echoAddress.port,
    requireSession: true,
  });

  const binding = new PrivacyShieldTunnelBinding({
    node: nodeA,
    remoteAlias: nodeB.alias,
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: echoAddress.port,
    requireSession: true,
  });

  try {
    const sessionA = waitForEvent(nodeA, "session", {
      timeoutMs: 2_500,
      predicate: (event) => event.alias === nodeB.alias,
    });
    const sessionB = waitForEvent(nodeB, "session", {
      timeoutMs: 2_500,
      predicate: (event) => event.alias === nodeA.alias,
    });
    nodeA.initiateSessionHandshake(nodeB.alias);
    await Promise.all([sessionA, sessionB]);

    gateway.start();
    binding.start();
    const bindAddress = await waitForCondition(() => binding.getAddress(), {
      timeoutMs: 2_500,
    });

    const response = await new Promise((resolve, reject) => {
      const client = net.createConnection(bindAddress.port, bindAddress.host);
      client.once("error", reject);
      client.once("data", (data) => {
        resolve(data.toString("utf8"));
        client.end();
      });
      client.write("legacy");
    });

    assert.equal(response, "echo:legacy");
  } finally {
    binding.stop();
    gateway.stop();
    nodeA.stop();
    nodeB.stop();
    echoServer.close();
  }
});
