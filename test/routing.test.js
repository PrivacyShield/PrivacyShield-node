"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NeighborTable, SimpleRoutingEngine } = require("../src/routing");
const { distance } = require("../src/coordinates");

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

test("optimized nearest-path selection matches full-distance ordering", () => {
  const table = new NeighborTable();
  for (let i = 0; i < 120; i += 1) {
    table.add({
      alias: `n-${i}`,
      coordinates: { x: i * 0.7, y: (i % 9) * -0.25, z: i % 5 },
    });
  }

  const target = { x: 13.5, y: -0.8, z: 2.3 };
  const engine = new SimpleRoutingEngine({ maxPaths: 7, allowRandomFallback: false });
  const optimized = engine.selectNextHops({}, table, target).map((hop) => hop.alias);

  const expected = table
    .list()
    .slice()
    .sort(
      (a, b) =>
        distance(a.coordinates, target) - distance(b.coordinates, target)
    )
    .slice(0, 7)
    .map((hop) => hop.alias);

  assert.deepEqual(optimized, expected);
});
