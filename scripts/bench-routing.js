#!/usr/bin/env node
"use strict";

const { NeighborTable, SimpleRoutingEngine } = require("../src/routing");

function parseIntArg(args, key, fallback) {
  const idx = args.indexOf(key);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  const parsed = Number.parseInt(args[idx + 1], 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function buildTable(neighbors) {
  const table = new NeighborTable();
  for (let i = 0; i < neighbors; i += 1) {
    table.add({
      alias: `bench-${i}`,
      coordinates: {
        x: (i * 13) % 97,
        y: ((i * 31) % 89) * 0.1,
        z: (i * 7) % 11,
      },
    });
  }
  return table;
}

function run() {
  const args = process.argv.slice(2);
  const neighbors = parseIntArg(args, "--neighbors", 5_000);
  const iterations = parseIntArg(args, "--iterations", 20_000);
  const maxPaths = parseIntArg(args, "--max-paths", 3);
  const table = buildTable(neighbors);
  const engine = new SimpleRoutingEngine({
    maxPaths,
    allowRandomFallback: false,
  });
  const target = { x: 42.2, y: 10.5, z: 3.6 };

  // Warmup avoids reporting cold-start JIT cost.
  for (let i = 0; i < 1_000; i += 1) {
    engine.selectNextHops({}, table, target);
  }

  const startNs = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    engine.selectNextHops({}, table, target);
  }
  const elapsedNs = Number(process.hrtime.bigint() - startNs);
  const elapsedMs = elapsedNs / 1e6;
  const opsPerSec = (iterations / elapsedMs) * 1_000;

  console.log(
    JSON.stringify(
      {
        benchmark: "routing-selectNextHops",
        neighbors,
        iterations,
        maxPaths,
        elapsedMs: Number(elapsedMs.toFixed(3)),
        opsPerSec: Number(opsPerSec.toFixed(1)),
      },
      null,
      2
    )
  );
}

run();

