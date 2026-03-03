# PrivacyShield Node Roadmap

This roadmap captures near-term steps and the longer arc for the Node.js reference implementation. It is aligned with the manifesto and will evolve as the TSNL specification matures.

## Next steps (near term)

Completed in the current prototype:

- [x] Stabilize core interfaces (transport, crypto, routing, DHT, shuffle) and document them in `README.md`.
- [x] Add transport abstraction with real network IO support via TCP adapter.
- [x] Implement alias resolution flows (publish, lookup, rotation) with local caching.
- [x] Add session handshakes (X25519 + Ed25519) and AEAD packet protection.
- [x] Expand routing to include multipath selection and controlled route churn.
- [x] Add coordinate sampling hooks for latency-derived coordinate updates.
- [x] Introduce region quantization helpers and region tables for long hops.
- [x] Add a stability-focused unit test harness for in-process networks and routing behaviors.
- [x] Add practical TCP server/client CLI flows with persistent identities for real usage.
- [x] Add a performance optimization track with benchmark scripts and `OPTIMIZATIONS.md`.
- [x] Optimize routing next-hop selection to avoid full neighbor sorting on coordinate-based forwarding.
- [x] Optimize TCP framing path by removing outer base64 framing overhead while keeping legacy compatibility.
- [x] Add TCP connection reuse and small write batching for long-lived traffic.
- [x] Add concurrent dynamic routing controls with lane metadata and route-obfuscation jitter.
- [x] Add CI performance gates with benchmark thresholds (`.github/workflows/performance-gate.yml`).
- [x] Add transport-level cover traffic scheduling with bounded overhead controls and tests.
- [x] Add split-share session rekey flow with route/lane jitter and encrypted noise packets.
- [x] Add cover-traffic benchmark + CI perf gate thresholds (`scripts/bench-cover.js`).
- [x] Add UDP transport adapter with keepalive probes and adaptive UDP/TCP transport fallback.
- [x] Add ring-aware routing IDs with provider/sub-region diversity constraints.
- [x] Add tunnel binding/gateway workflows to proxy non-PrivacyShield TCP clients/servers.
- [x] Add advanced `netsim/` adversarial simulator (500-node/30-minute virtual profile) with provider diversity, IPv4/IPv6 + router/NAT modeling, bandwidth/latency variability, reputation TTL, randomized MITM campaigns, and report artifacts.

Current next implementation focus:

- [ ] Extend transport adapters beyond TCP/UDP (QUIC/WebRTC where practical).
- [ ] Add bootstrap discovery and DHT replication strategies.
- [ ] Add adaptive threshold calibration for perf gates across heterogeneous CI runners.
- [ ] Harden adaptive transport delivery confidence (ACK-driven fallback and path scoring).
- [ ] Harden rekey flow for concurrent bi-directional rotations under packet loss.
- [ ] Add conformance vectors and fuzz-style tests, and extend adversarial simulation scenarios across additional transport adapters.

## General roadmap (phases)

### Phase 0 - Prototype scaffold (done)
- Basic node orchestration, neighbor table, in-memory transport, and DHT stubs.

### Phase 1 - Overlay prototype
- Identity + aliasing with signed alias records.
- Encrypted sessions and basic forwarding.
- Minimal metrics and privacy-safe logging.

### Phase 2 - Diversification
- Multipath routing and route rotation.
- Shuffle policies (padding, batching, basic delay jitter).

### Phase 3 - Coordinate space and regions
- Coordinate stabilization from latency sampling.
- Region quantization tables across multiple scales.
- Dimension and altitude policies to avoid rigid routes.

### Phase 4 - Transport adapters and bootstrap
- QUIC, WebRTC, and TCP/TLS adapters where practical.
- Bootstrap discovery and DHT replication strategies.

### Phase 5 - Optional P2V proof of concept
- Lawful live streaming demo built on TSNL primitives.

### Phase 6 - Hardening and interoperability
- Formalize the spec, add test vectors, fuzzing, and adversarial simulations.
- Stability guarantees for public interfaces.
