"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NeighborTable, SimpleRoutingEngine } = require("../src/routing");

test("neighbor table requires alias entries", () => {
  const table = new NeighborTable();
  assert.throws(() => table.add({}), /Neighbor entry requires alias/);
});

test("routing engine prefers nearest neighbors to target coordinates", () => {
  const table = new NeighborTable();
  table.add({ alias: "a", coordinates: { x: 0, y: 0, z: 0 } });
  table.add({ alias: "b", coordinates: { x: 10, y: 0, z: 0 } });
  table.add({ alias: "c", coordinates: { x: 2, y: 0, z: 0 } });

  const engine = new SimpleRoutingEngine({ maxPaths: 2, allowRandomFallback: false });
  const hops = engine.selectNextHops({}, table, { x: 0.2, y: 0, z: 0 });
  assert.deepEqual(
    hops.map((hop) => hop.alias),
    ["a", "c"]
  );
});

test("route churn remains stable inside the churn interval", () => {
  const table = new NeighborTable();
  for (const alias of ["a", "b", "c", "d"]) {
    table.add({ alias });
  }
  const engine = new SimpleRoutingEngine({ maxPaths: 4, churnIntervalMs: 60_000 });
  const first = engine.selectNextHops({}, table).map((hop) => hop.alias);
  const second = engine.selectNextHops({}, table).map((hop) => hop.alias);
  assert.deepEqual(second, first);
});

