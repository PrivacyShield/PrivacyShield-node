#!/usr/bin/env node
"use strict";

const {
  PrivacyShieldNode,
  TcpTransport,
  generateIdentity,
  deriveAlias,
} = require("../src");

function parseIntArg(args, key, fallback) {
  const idx = args.indexOf(key);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  const parsed = Number.parseInt(args[idx + 1], 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseFloatArg(args, key, fallback) {
  const idx = args.indexOf(key);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  const parsed = Number.parseFloat(args[idx + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs || 4_000;
  const intervalMs = options.intervalMs || 10;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

async function runScenario(options) {
  const identityA = generateIdentity();
  const identityB = generateIdentity();
  const aliasA = deriveAlias(identityA.publicKey);
  const aliasB = deriveAlias(identityB.publicKey);

  const transportA = new TcpTransport({
    alias: aliasA,
    host: "127.0.0.1",
    port: 0,
    laneCount: 4,
    batchWindowMs: options.batchWindowMs,
    batchMaxFrames: 64,
    batchMaxBytes: 128 * 1024,
    flushJitterMs: 0,
    socketIdleTimeoutMs: 10_000,
    coverTrafficEnabled: options.coverEnabled,
    coverIntervalMs: options.coverIntervalMs,
    coverJitterMs: 0,
    coverRateBytesPerSec: options.coverRateBytesPerSec,
    coverBurstBytes: options.coverBurstBytes,
    coverPacketBytes: options.coverPacketBytes,
    coverPeerFanout: options.coverPeerFanout,
    coverTtl: 2,
    coverWarmupFrames: options.coverWarmupFrames,
    maxCoverToRealRatio: options.maxCoverToRealRatio,
  });
  const transportB = new TcpTransport({
    alias: aliasB,
    host: "127.0.0.1",
    port: 0,
    batchWindowMs: 0,
  });

  const nodeA = new PrivacyShieldNode({
    identity: identityA,
    transport: transportA,
    dynamicRouting: { minPaths: 1, maxPaths: 1, dynamicPathSpread: false, obfuscationNoise: 0 },
    routeObfuscationDelayMs: 0,
  });
  const nodeB = new PrivacyShieldNode({
    identity: identityB,
    transport: transportB,
    dynamicRouting: { minPaths: 1, maxPaths: 1, dynamicPathSpread: false, obfuscationNoise: 0 },
    routeObfuscationDelayMs: 0,
  });

  nodeA.start();
  nodeB.start();

  try {
    const addressB = await waitForCondition(() => transportB.getAddress(), {
      timeoutMs: 2_500,
    });
    nodeA.addNeighbor({
      alias: aliasB,
      address: { host: "127.0.0.1", port: addressB.port },
    });

    let received = 0;
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for benchmark messages"));
      }, 8_000);
      nodeB.on("message", ({ fromAlias }) => {
        if (fromAlias !== aliasA) {
          return;
        }
        received += 1;
        if (received >= options.messages) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const payload = Buffer.alloc(options.payloadBytes, 17);
    const startNs = process.hrtime.bigint();
    for (let i = 0; i < options.messages; i += 1) {
      nodeA.sendMessage(aliasB, payload, { ttl: 3 });
    }
    await done;
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;

    await sleep(options.settleMs);
    const stats = transportA.getStats();
    return {
      elapsedMs,
      messagesPerSec: (options.messages / elapsedMs) * 1_000,
      stats,
    };
  } finally {
    nodeA.stop();
    nodeB.stop();
  }
}

async function run() {
  const args = process.argv.slice(2);
  const messages = parseIntArg(args, "--messages", 300);
  const payloadBytes = parseIntArg(args, "--payload-bytes", 256);
  const settleMs = parseIntArg(args, "--settle-ms", 140);
  const batchWindowMs = parseIntArg(args, "--batch-window-ms", 2);
  const coverIntervalMs = parseIntArg(args, "--cover-interval-ms", 12);
  const coverRateBytesPerSec = parseIntArg(args, "--cover-rate-bps", 128 * 1024);
  const coverPacketBytes = parseIntArg(args, "--cover-packet-bytes", 80);
  const coverPeerFanout = parseIntArg(args, "--cover-peer-fanout", 2);
  const maxCoverToRealRatio = parseFloatArg(args, "--max-cover-to-real-ratio", 0.5);
  const coverWarmupFrames = parseIntArg(args, "--cover-warmup-frames", 2);
  const coverBurstBytes = parseIntArg(
    args,
    "--cover-burst-bytes",
    Math.max(coverPacketBytes * 10, 2048)
  );

  const baseline = await runScenario({
    messages,
    payloadBytes,
    settleMs,
    batchWindowMs,
    coverEnabled: false,
    coverIntervalMs,
    coverRateBytesPerSec,
    coverBurstBytes,
    coverPacketBytes,
    coverPeerFanout,
    maxCoverToRealRatio,
    coverWarmupFrames,
  });

  const withCover = await runScenario({
    messages,
    payloadBytes,
    settleMs,
    batchWindowMs,
    coverEnabled: true,
    coverIntervalMs,
    coverRateBytesPerSec,
    coverBurstBytes,
    coverPacketBytes,
    coverPeerFanout,
    maxCoverToRealRatio,
    coverWarmupFrames,
  });

  const coverRatio = withCover.stats.coverFramesSent / Math.max(1, withCover.stats.realFramesSent);
  const throughputRetention = withCover.messagesPerSec / baseline.messagesPerSec;

  console.log(
    JSON.stringify(
      {
        benchmark: "tcp-cover-overhead",
        messages,
        payloadBytes,
        baselineMessagesPerSec: Number(baseline.messagesPerSec.toFixed(1)),
        coverMessagesPerSec: Number(withCover.messagesPerSec.toFixed(1)),
        throughputRetention: Number(throughputRetention.toFixed(3)),
        coverToRealRatio: Number(coverRatio.toFixed(3)),
        coverFramesSent: withCover.stats.coverFramesSent,
        realFramesSent: withCover.stats.realFramesSent,
        coverBytesSent: withCover.stats.coverBytesSent,
        realBytesSent: withCover.stats.realBytesSent,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
