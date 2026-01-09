# PrivacyShield Node Roadmap

This roadmap captures near-term steps and the longer arc for the Node.js reference implementation. It is aligned with the manifesto and will evolve as the TSNL specification matures.

## Next steps (near term)

- Stabilize the core interfaces (transport, crypto, routing, DHT, shuffle) and document them.
- Add a transport abstraction with a TCP or UDP adapter for real network IO.
- Implement alias resolution flows (publish, lookup, rotation) with basic caching.
- Add session handshakes (X25519 + Ed25519) and AEAD packet protection.
- Expand routing to include multipath and controlled route churn.
- Add coordinate sampling and stabilization hooks for latency-derived space.
- Introduce region quantization helpers and region tables for long hops.
- Add a small test harness for in-process networks and routing behaviors.

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
