"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateCoordinates,
  quantizeCoordinate,
  quantizeAcrossScales,
  distance,
} = require("../src/coordinates");

test("empty coordinate samples produce origin", () => {
  assert.deepEqual(estimateCoordinates([]), { x: 0, y: 0, z: 0 });
});

test("quantization helpers return stable integer region coordinates", () => {
  const coordinate = { x: 1.2, y: -2.4, z: 0.9 };
  assert.deepEqual(quantizeCoordinate(coordinate, 0.5), { x: 2, y: -5, z: 2 });

  const table = quantizeAcrossScales(coordinate, [0.5, 2]);
  assert.deepEqual(table["0.5"], { x: 2, y: -5, z: 2 });
  assert.deepEqual(table["2"], { x: 1, y: -1, z: 0 });
});

test("distance is symmetric and zero for identical points", () => {
  const a = { x: 1, y: 2, z: 3 };
  const b = { x: 4, y: 6, z: 3 };
  assert.equal(distance(a, a), 0);
  assert.equal(distance(a, b), distance(b, a));
});

