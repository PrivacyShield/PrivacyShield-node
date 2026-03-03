#!/usr/bin/env node
"use strict";

const {
  createPacket,
  serializePacket,
  parsePacketString,
  encodePacket,
  decodePacket,
} = require("../src/packet");

function parseIntArg(args, key, fallback) {
  const idx = args.indexOf(key);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  const parsed = Number.parseInt(args[idx + 1], 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function measure(iterations, run) {
  const startNs = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    run();
  }
  const elapsedNs = Number(process.hrtime.bigint() - startNs);
  const elapsedMs = elapsedNs / 1e6;
  return {
    elapsedMs,
    opsPerSec: (iterations / elapsedMs) * 1_000,
  };
}

function run() {
  const args = process.argv.slice(2);
  const iterations = parseIntArg(args, "--iterations", 100_000);
  const payloadBytes = parseIntArg(args, "--payload-bytes", 1024);
  const payload = Buffer.alloc(payloadBytes, 7);
  const packet = createPacket({
    srcAlias: "aaaaaaaaaaaa",
    dstAlias: "bbbbbbbbbbbb",
    payload,
    ttl: 4,
    metadata: { control: "bench" },
  });

  const utf8Path = measure(iterations, () => {
    const frame = serializePacket(packet);
    parsePacketString(frame);
  });

  const base64Path = measure(iterations, () => {
    const frame = encodePacket(packet).toString("base64");
    decodePacket(Buffer.from(frame, "base64"));
  });

  const utf8FrameBytes = Buffer.byteLength(serializePacket(packet), "utf8");
  const base64FrameBytes = Buffer.byteLength(encodePacket(packet).toString("base64"), "utf8");
  const wireReduction = (1 - utf8FrameBytes / base64FrameBytes) * 100;

  console.log(
    JSON.stringify(
      {
        benchmark: "tcp-framing-encode-decode",
        iterations,
        payloadBytes,
        utf8FrameOpsPerSec: Number(utf8Path.opsPerSec.toFixed(1)),
        legacyBase64FrameOpsPerSec: Number(base64Path.opsPerSec.toFixed(1)),
        speedup: Number((utf8Path.opsPerSec / base64Path.opsPerSec).toFixed(3)),
        utf8FrameBytes,
        legacyBase64FrameBytes: base64FrameBytes,
        wireReductionPercent: Number(wireReduction.toFixed(2)),
      },
      null,
      2
    )
  );
}

run();
