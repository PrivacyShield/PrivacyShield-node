#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function runJson(scriptPath, args) {
  const stdout = cp.execFileSync("node", [scriptPath, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(stdout);
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}=${value}`);
  }
  return parsed;
}

function main() {
  const routingMinOps = envNumber("ROUTING_MIN_OPS", 15_000);
  const framingMinOps = envNumber("FRAMING_MIN_UTF8_OPS", 200_000);
  const framingMinSpeedup = envNumber("FRAMING_MIN_SPEEDUP", 1.1);
  const framingMinWireReduction = envNumber("FRAMING_MIN_WIRE_REDUCTION", 20);
  const coverMinThroughputRetention = envNumber(
    "COVER_MIN_THROUGHPUT_RETENTION",
    0.6
  );
  const coverMaxToRealRatio = envNumber("COVER_MAX_TO_REAL_RATIO", 0.65);

  const routingResult = runJson(path.join("scripts", "bench-routing.js"), [
    "--neighbors",
    String(envNumber("ROUTING_NEIGHBORS", 5_000)),
    "--iterations",
    String(envNumber("ROUTING_ITERATIONS", 10_000)),
    "--max-paths",
    String(envNumber("ROUTING_MAX_PATHS", 3)),
  ]);

  const framingResult = runJson(path.join("scripts", "bench-framing.js"), [
    "--iterations",
    String(envNumber("FRAMING_ITERATIONS", 50_000)),
    "--payload-bytes",
    String(envNumber("FRAMING_PAYLOAD_BYTES", 1024)),
  ]);
  const coverResult = runJson(path.join("scripts", "bench-cover.js"), [
    "--messages",
    String(envNumber("COVER_MESSAGES", 300)),
    "--payload-bytes",
    String(envNumber("COVER_PAYLOAD_BYTES", 256)),
    "--batch-window-ms",
    String(envNumber("COVER_BATCH_WINDOW_MS", 2)),
    "--cover-interval-ms",
    String(envNumber("COVER_INTERVAL_MS", 12)),
    "--cover-rate-bps",
    String(envNumber("COVER_RATE_BPS", 128 * 1024)),
    "--cover-packet-bytes",
    String(envNumber("COVER_PACKET_BYTES", 80)),
    "--cover-peer-fanout",
    String(envNumber("COVER_PEER_FANOUT", 2)),
    "--max-cover-to-real-ratio",
    String(envNumber("COVER_MAX_RATIO_CONFIG", 0.5)),
    "--cover-warmup-frames",
    String(envNumber("COVER_WARMUP_FRAMES", 2)),
  ]);

  const failures = [];
  if (routingResult.opsPerSec < routingMinOps) {
    failures.push(
      `routing opsPerSec ${routingResult.opsPerSec} is below threshold ${routingMinOps}`
    );
  }
  if (framingResult.utf8FrameOpsPerSec < framingMinOps) {
    failures.push(
      `framing utf8FrameOpsPerSec ${framingResult.utf8FrameOpsPerSec} is below threshold ${framingMinOps}`
    );
  }
  if (framingResult.speedup < framingMinSpeedup) {
    failures.push(
      `framing speedup ${framingResult.speedup} is below threshold ${framingMinSpeedup}`
    );
  }
  if (framingResult.wireReductionPercent < framingMinWireReduction) {
    failures.push(
      `framing wireReductionPercent ${framingResult.wireReductionPercent} is below threshold ${framingMinWireReduction}`
    );
  }
  if (coverResult.throughputRetention < coverMinThroughputRetention) {
    failures.push(
      `cover throughputRetention ${coverResult.throughputRetention} is below threshold ${coverMinThroughputRetention}`
    );
  }
  if (coverResult.coverToRealRatio > coverMaxToRealRatio) {
    failures.push(
      `cover coverToRealRatio ${coverResult.coverToRealRatio} exceeds threshold ${coverMaxToRealRatio}`
    );
  }

  console.log(
    JSON.stringify(
      {
        routingResult,
        framingResult,
        coverResult,
        thresholds: {
          routingMinOps,
          framingMinOps,
          framingMinSpeedup,
          framingMinWireReduction,
          coverMinThroughputRetention,
          coverMaxToRealRatio,
        },
        pass: failures.length === 0,
        failures,
      },
      null,
      2
    )
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main();
