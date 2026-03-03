"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPacket,
  serializePacket,
  parsePacketString,
  encodePacket,
  decodePacket,
} = require("../src");

test("packet serialize/parse roundtrip preserves fields", () => {
  const original = createPacket({
    srcAlias: "aaaaaaaaaaaa",
    dstAlias: "bbbbbbbbbbbb",
    payload: Buffer.from("payload-value"),
    ttl: 3,
    hopCount: 1,
    metadata: { control: "demo", paddingBytes: 2 },
  });

  const wire = serializePacket(original);
  const parsed = parsePacketString(wire);
  assert.equal(parsed.srcAlias, original.srcAlias);
  assert.equal(parsed.dstAlias, original.dstAlias);
  assert.equal(parsed.ttl, original.ttl);
  assert.equal(parsed.hopCount, original.hopCount);
  assert.deepEqual(parsed.metadata, original.metadata);
  assert.equal(parsed.payload.toString("utf8"), "payload-value");
});

test("packet encode/decode remains compatible with existing Buffer API", () => {
  const original = createPacket({
    srcAlias: "111111111111",
    dstAlias: "222222222222",
    payload: Buffer.from("legacy-buffer-api"),
    metadata: { control: "compat" },
  });
  const encoded = encodePacket(original);
  const decoded = decodePacket(encoded);
  assert.equal(decoded.payload.toString("utf8"), "legacy-buffer-api");
  assert.equal(decoded.metadata.control, "compat");
});

