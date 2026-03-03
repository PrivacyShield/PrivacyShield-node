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

  console.log(
    JSON.stringify(
      {
        routingResult,
        framingResult,
        thresholds: {
          routingMinOps,
          framingMinOps,
          framingMinSpeedup,
          framingMinWireReduction,
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

