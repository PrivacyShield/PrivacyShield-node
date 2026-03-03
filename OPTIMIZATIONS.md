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

### 3. TCP connection reuse + small write batching

- File: `src/transport/tcp.js`
- Changes:
  - Added pooled outbound connections keyed by `host:port`.
  - Added lane-aware batching scheduler (`batchWindowMs`, `batchMaxFrames`, `batchMaxBytes`).
  - Added idle socket keepalive controls and reconnect-on-queue behavior.
  - Added transport stats (`getStats`) for validation/benchmarking.
- Effect:
  - Fewer socket creations under burst traffic.
  - Better throughput via coalesced writes.
  - Improved multiplexing readiness for dynamic routing lanes.
- Safety coverage:
  - `test/tcp.integration.test.js` validates connection reuse and batching.

### 4. Concurrent dynamic routing + latency obfuscation

- Files: `src/routing.js`, `src/node.js`
- Changes:
  - Added `DynamicConcurrentRoutingEngine` with adaptive path count (`minPaths`/`maxPaths`) and optional distance-noise obfuscation.
  - Node forwarding now tags packets with route group/lane metadata (`routeGroup`, `routeLane`, `routeWidth`, `routeIndex`).
  - Added per-packet route-obfuscation jitter (`routeObfuscationDelayMs`) for timing camouflage.
- Effect:
  - Concurrent multi-path forwarding behavior with logical lane multiplexing over reused TCP connections.
  - Improved uncertainty in traffic timing and route shape without breaking delivery semantics.
- Safety coverage:
  - `test/routing.test.js`
  - `test/node.integration.test.js`

### 5. Transport-level cover traffic scheduling with bounded overhead

- File: `src/transport/tcp.js`
- Changes:
  - Added periodic cover traffic scheduler (`coverTrafficEnabled`, `coverIntervalMs`, `coverRateBytesPerSec`, `coverBurstBytes`).
  - Added bounded overhead controls (`maxCoverToRealRatio`, `coverWarmupFrames`, `coverPeerFanout`).
  - Added lane-tagged randomized noise frame generation and cover-aware transport stats.
- Effect:
  - Sustains traffic-shape noise while keeping absolute and relative overhead bounded.
  - Preserves connection reuse and batching behavior under mixed real/cover traffic.
- Safety coverage:
  - `test/tcp.integration.test.js` validates cover scheduling and ratio bounds.

### 6. Split-share rekey over dynamic lanes with encrypted noise

- Files: `src/node.js`, `src/crypto.js`
- Changes:
  - Added XOR split/combine primitives and deterministic rekey derivation (`deriveRekeySessionKey`).
  - Added session rekey control messages (`rekey_share`, `rekey_ack`) with key fallback grace handling.
  - Added share spread/jitter and encrypted cover-noise bursts during rekey (`rekeyNoisePackets`).
- Effect:
  - Frequent key churn with key material divided across multiple routed shares.
  - Preserves payload confidentiality end-to-end while increasing route/timing uncertainty.
- Safety coverage:
  - `test/handshake-crypto.test.js`
  - `test/node.integration.test.js`

### 7. UDP transport path + adaptive UDP/TCP fallback

- Files: `src/transport/udp.js`, `src/transport/adaptive.js`, `src/transport/tcp.js`
- Changes:
  - Added UDP adapter with datagram framing compatibility and NAT keepalive probes.
  - Added adaptive transport wrapper that ranks transport success per peer and can mirror control-plane traffic to fallback links.
  - Added candidate-aware peer address normalization across TCP/UDP for dual-stack path choices.
- Effect:
  - Enables dynamic alternative transport usage under changing network conditions.
  - Reduces control-plane fragility when one path is unstable or filtered.
- Safety coverage:
  - `test/udp.integration.test.js`
  - `test/adaptive.integration.test.js`

### 8. Ring-aware IDs, provider diversity, and tunnel compatibility path

- Files: `src/routing.js`, `src/node.js`, `src/tunnel.js`, `src/cli.js`
- Changes:
  - Added ring-aware routing engine using stable overlay IDs plus provider/sub-region diversity penalties.
  - Added hashed sub-region IDs to improve routing precision without exposing raw coordinate buckets.
  - Added tunnel binding/gateway bridge so legacy TCP apps can run over PrivacyShield without protocol changes.
- Effect:
  - Improves route diversity against single-provider concentration.
  - Makes practical adoption easier for non-native clients/servers.
- Safety coverage:
  - `test/routing.test.js`
  - `test/node.integration.test.js`
  - `test/tunnel.integration.test.js`

### 9. Advanced adversarial network simulation harness (`netsim/`)

- Files: `netsim/config.js`, `netsim/simulator.js`, `netsim/report.js`, `netsim/run.js`
- Changes:
  - Added deterministic discrete-event simulation profile for large virtual scenarios (default: `500` nodes, `30` minutes).
  - Added per-node provider diversity, variable bandwidth/latency models, and route cache + just-in-time mutation behavior.
  - Added per-node IPv4-only/dual-stack/IPv6-only assignment plus router/NAT profile effects (restricted/symmetric/CGNAT).
  - Added randomized MITM campaigns (observe, delay, drop, tamper) with detection metrics.
  - Added reputation TTL decay/refresh model and split-share key exchange stress simulation.
  - Added report artifact generation (`report.json`, `report.md`) with auto-generated conclusions/recommendations.
- Effect:
  - Enables high-scale adversarial performance and security regression testing without long real-time runs.
  - Surfaces routing and detection bottlenecks with provider-level diagnostics.
- Safety coverage:
  - `test/netsim.test.js`

## Benchmark commands

```bash
npm run bench:routing -- --neighbors 5000 --iterations 20000 --max-paths 3
npm run bench:framing -- --iterations 100000 --payload-bytes 1024
npm run bench:cover -- --messages 300 --payload-bytes 256 --max-cover-to-real-ratio 0.5
npm run netsim:run -- --scenario benchmark-500x30m --nodes 500 --duration-minutes 30 --no-write
```

## Benchmark snapshot (2026-03-03)

Environment: local developer machine, Node.js `v24.9.0`.

### Routing selection

```json
{
  "benchmark": "routing-selectNextHops",
  "neighbors": 5000,
  "iterations": 10000,
  "maxPaths": 3,
  "elapsedMs": 338.956,
  "opsPerSec": 29502.3
}
```

### TCP framing encode/decode

```json
{
  "benchmark": "tcp-framing-encode-decode",
  "iterations": 50000,
  "payloadBytes": 1024,
  "utf8FrameOpsPerSec": 408408.7,
  "legacyBase64FrameOpsPerSec": 244663,
  "speedup": 1.669,
  "utf8FrameBytes": 1516,
  "legacyBase64FrameBytes": 2024,
  "wireReductionPercent": 25.1
}
```

### Cover overhead and throughput retention

```json
{
  "benchmark": "tcp-cover-overhead",
  "messages": 300,
  "payloadBytes": 256,
  "baselineMessagesPerSec": 37792.5,
  "coverMessagesPerSec": 35661.7,
  "throughputRetention": 0.944,
  "coverToRealRatio": 0.067,
  "coverFramesSent": 20,
  "realFramesSent": 300,
  "coverBytesSent": 7000,
  "realBytesSent": 183565
}
```

### Adversarial netsim snapshot (500 nodes / 30 minutes virtual)

```json
{
  "benchmark": "netsim-adversarial",
  "nodes": 500,
  "durationMinutes": 30,
  "tickMs": 500,
  "packetsAttempted": 189857,
  "successRate": 0.5966,
  "throughputMbps": 0.3157,
  "p95LatencyMs": 230.86,
  "mitmAttempts": 7850,
  "mitmDetectionRate": 0.4259,
  "ipv6HopShare": 0.5115,
  "connectivityDropRate": 0.2904,
  "keyCompromiseRate": 0.0,
  "runtimeMs": 1180
}
```

### Performance gate snapshot

`npm run perf:gate` currently enforces:

- `routing opsPerSec >= 15000`
- `framing utf8FrameOpsPerSec >= 200000`
- `framing speedup >= 1.1`
- `framing wireReductionPercent >= 20`
- `cover throughputRetention >= 0.6`
- `cover coverToRealRatio <= 0.65`

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
- Adaptive transport:
  - Prefer `--transport adaptive` with explicit `--peer-port` and `--peer-udp-port` to keep both paths available.
  - Keep UDP keepalive (`--udp-nat-keepalive-ms`) enabled when NAT churn is expected.

## Next optimization targets

1. Alias/DHT lookup caching policy tuning (positive + negative cache windows).
2. Coordinated benchmark suite for in-memory vs TCP/UDP/adaptive forwarding throughput.
3. Adaptive transport confidence model (ACK-driven fallback and dynamic path demotion).
4. Rekey hardening under packet loss and concurrent bi-direction rotations.
5. Add CI gates for `netsim` metrics (success rate / p95 latency / MITM detection floors and compromise ceiling).

## Optimization acceptance gate

Before merging a performance change:

1. `npm test`
2. Relevant benchmark command(s) from this file
3. Update this document with new benchmark snapshots and note regressions/tradeoffs
