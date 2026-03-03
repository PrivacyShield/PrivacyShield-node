# PrivacyShield Node Optimizations

This document tracks performance-focused implementation work, measurable baselines, and next optimization targets aligned with `ROADMAP.md`.

## Current optimization goals

- Keep packet forwarding and handshake behavior stable while reducing CPU and wire overhead.
- Improve practical TCP node efficiency for server/client deployments.
- Provide repeatable benchmarks that can be run in CI and on developer machines.

## Implemented optimizations

### 1. Routing hot path: partial nearest selection

- File: `src/routing.js`
- Change: `SimpleRoutingEngine` now selects nearest next hops using a bounded top-k insertion strategy instead of sorting all neighbors for coordinate-based routing.
- Effect: avoids full `O(n log n)` sort when only `maxPaths` candidates are needed.
- Safety coverage:
  - `test/routing.test.js` verifies nearest-path correctness vs full-distance ordering.

### 2. TCP framing path: single serialization and parse

- Files: `src/packet.js`, `src/transport/tcp.js`
- Changes:
  - Added `serializePacket()` and `parsePacketString()` to avoid extra Buffer conversions.
  - Removed double-encoding of wire frames (JSON payload remains base64, outer frame is now newline-delimited JSON).
  - Kept backward compatibility by accepting legacy base64-framed outer packets.
- Effect:
  - Higher framing throughput on benchmarked workloads.
  - Lower wire size per packet (no outer base64 expansion).
- Safety coverage:
  - `test/packet.test.js`
  - `test/tcp.integration.test.js` (includes legacy frame compatibility test).

## Benchmark commands

```bash
npm run bench:routing -- --neighbors 5000 --iterations 20000 --max-paths 3
npm run bench:framing -- --iterations 100000 --payload-bytes 1024
```

## Benchmark snapshot (2026-03-03)

Environment: local developer machine, Node.js `v24.9.0`.

### Routing selection

```json
{
  "benchmark": "routing-selectNextHops",
  "neighbors": 5000,
  "iterations": 20000,
  "maxPaths": 3,
  "elapsedMs": 744.926,
  "opsPerSec": 26848.3
}
```

### TCP framing encode/decode

```json
{
  "benchmark": "tcp-framing-encode-decode",
  "iterations": 100000,
  "payloadBytes": 1024,
  "utf8FrameOpsPerSec": 321036.8,
  "legacyBase64FrameOpsPerSec": 237797.8,
  "speedup": 1.35,
  "utf8FrameBytes": 1516,
  "legacyBase64FrameBytes": 2024,
  "wireReductionPercent": 25.1
}
```

## Practical tuning guidelines

- `maxPaths`:
  - Keep at `2-3` for constrained CPU/edge nodes.
  - Increase only when diversity gains are required and tested.
- `shuffle`:
  - Keep padding/delay minimal for latency-sensitive real-time paths.
  - Use higher padding only for threat-model-driven scenarios.
- TCP deployment:
  - Prefer stable peer lists and long-running processes to avoid repeated handshake churn.
  - Keep `--echo` disabled in production-like tests unless explicitly needed.

## Next optimization targets

1. Connection reuse and small write batching for TCP transport.
2. Alias/DHT lookup caching policy tuning (positive + negative cache windows).
3. Coordinated benchmark suite for in-memory vs TCP forwarding throughput.
4. Adversarial/perf simulations (packet loss, high-latency links, route churn pressure).

## Optimization acceptance gate

Before merging a performance change:

1. `npm test`
2. Relevant benchmark command(s) from this file
3. Update this document with new benchmark snapshots and note regressions/tradeoffs

