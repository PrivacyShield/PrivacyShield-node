"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AdaptiveTransport } = require("../src");
const { waitForCondition } = require("./helpers");

// Minimal in-memory transport used to drive AdaptiveTransport path scoring
// deterministically without real sockets.
class FakeTransport {
  constructor(name, options = {}) {
    this.name = name;
    this.protocol = name;
    this.accept = options.accept !== false;
    this.onPacket = null;
    this.started = false;
    this.sent = [];
  }

  start(onPacket) {
    this.onPacket = onPacket;
    this.started = true;
  }

  stop() {
    this.started = false;
  }

  registerPeer() {}

  send(packet, destinationAlias) {
    this.sent.push({ packet, destinationAlias });
    return this.accept;
  }

  // Simulate inbound return traffic arriving over this transport.
  deliver(packet, fromAlias) {
    if (this.onPacket) {
      this.onPacket(packet, fromAlias);
    }
  }

  getAddress() {
    return { name: this.name };
  }
}

function basicPacket(overrides = {}) {
  return { dstAlias: "peer", metadata: {}, ...overrides };
}

test("confirmed return traffic steers future sends toward the proven path", () => {
  const now = 1_000;
  const udp = new FakeTransport("udp");
  const tcp = new FakeTransport("tcp");
  const adaptive = new AdaptiveTransport({
    alias: "self",
    transports: [udp, tcp],
    clock: () => now, // frozen clock isolates scoring from time decay
  });
  adaptive.start(() => {});

  // Neutral confidence: index order breaks the tie, so udp is tried first.
  adaptive.send(basicPacket(), "peer");
  assert.equal(udp.sent.length, 1);
  assert.equal(tcp.sent.length, 0);

  // Only tcp confirms the path with return traffic from the peer.
  for (let i = 0; i < 3; i += 1) {
    tcp.deliver(basicPacket({ srcAlias: "peer" }), "peer");
  }

  adaptive.send(basicPacket(), "peer");
  assert.equal(tcp.sent.length, 1, "tcp should now outrank udp");
  assert.equal(udp.sent.length, 1, "udp should not receive the second send");

  const confidence = adaptive.getPeerConfidence("peer");
  assert.equal(confidence.tcp.confidence > confidence.udp.confidence, true);
  assert.equal(confidence.tcp.deliveries >= 3, true);
});

test("local acceptance is weaker evidence than confirmed delivery", () => {
  const now = 5_000;
  const acceptOnly = new AdaptiveTransport({
    alias: "self",
    transports: [new FakeTransport("udp")],
    clock: () => now,
  });
  acceptOnly.start(() => {});
  // One accepted send with no return traffic (UDP-style fire-and-forget).
  acceptOnly.send(basicPacket(), "peer");
  const acceptanceConfidence = acceptOnly.getPeerConfidence("peer").udp.confidence;

  const deliverPath = new AdaptiveTransport({
    alias: "self",
    transports: [new FakeTransport("udp")],
    clock: () => now,
  });
  deliverPath.start(() => {});
  // One confirmed delivery from the same neutral starting point.
  deliverPath.recordDelivery("peer", "udp", { latencyMs: 12 });
  const deliveryConfidence = deliverPath.getPeerConfidence("peer").udp.confidence;

  assert.equal(
    deliveryConfidence > acceptanceConfidence,
    true,
    "a single delivery should outweigh a single acceptance"
  );
  assert.equal(deliverPath.getPeerConfidence("peer").udp.latencyMs, 12);
});

test("ack timeout penalizes a silent path and triggers fallback selection", async () => {
  const udp = new FakeTransport("udp");
  const tcp = new FakeTransport("tcp");
  const adaptive = new AdaptiveTransport({
    alias: "self",
    transports: [udp, tcp],
    preferredOrder: ["udp", "tcp"],
    ackTimeoutMs: 20,
  });
  adaptive.start(() => {});

  // First send prefers udp but never receives confirming return traffic.
  adaptive.send(basicPacket(), "peer");
  assert.equal(udp.sent.length, 1);

  await waitForCondition(() => adaptive.getStats().ackTimeouts >= 1, {
    timeoutMs: 1_000,
  });

  // The unacked udp send was scored as a loss; the next send should fall back
  // to tcp even though udp is still the preferred protocol.
  adaptive.send(basicPacket(), "peer");
  assert.equal(tcp.sent.length, 1, "send should fall back to tcp after timeout");

  const confidence = adaptive.getPeerConfidence("peer");
  assert.equal(confidence.udp.losses >= 1, true);
  assert.equal(confidence.udp.inFlight, 0);
  adaptive.stop();
});

test("inbound traffic resolves an outstanding ack before it times out", async () => {
  const udp = new FakeTransport("udp");
  const adaptive = new AdaptiveTransport({
    alias: "self",
    transports: [udp],
    ackTimeoutMs: 1_000,
  });
  adaptive.start(() => {});

  adaptive.send(basicPacket(), "peer");
  assert.equal(adaptive.getPeerConfidence("peer").udp.inFlight, 1);

  // Return traffic confirms delivery and clears the pending ack timer.
  udp.deliver(basicPacket({ srcAlias: "peer" }), "peer");

  const confidence = adaptive.getPeerConfidence("peer").udp;
  assert.equal(confidence.inFlight, 0);
  assert.equal(confidence.deliveries >= 1, true);
  assert.equal(adaptive.getStats().ackTimeouts, 0);
  adaptive.stop();
});

test("recordLoss lowers confidence for explicit delivery failures", () => {
  const now = 2_000;
  const tcp = new FakeTransport("tcp");
  const adaptive = new AdaptiveTransport({
    alias: "self",
    transports: [tcp],
    clock: () => now,
  });
  adaptive.start(() => {});

  adaptive.recordDelivery("peer", "tcp");
  const healthy = adaptive.getPeerConfidence("peer").tcp.confidence;
  adaptive.recordLoss("peer", "tcp");
  const degraded = adaptive.getPeerConfidence("peer").tcp.confidence;

  assert.equal(degraded < healthy, true);
  assert.equal(adaptive.getPeerConfidence("peer").tcp.losses, 1);
});
