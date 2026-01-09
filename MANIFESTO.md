# Privacy Shield — MANIFESTO

**Status:** Draft manifesto for the Privacy Shield organization and its protocol family.  
**Scope:** Values, technical direction, and implementation principles.  
**Primary implementation target:** **Node.js (TypeScript-first)**.

---

## 1. Mission

Privacy Shield is a non-profit technical initiative to **defend online freedom, privacy, and network neutrality** by building open protocols and software that make **mass blocking and mass surveillance** harder to scale, less cost-effective, and less reliable.

Privacy Shield **does not promote piracy** and **does not distribute content**. The project exists to support fundamental rights such as freedom of expression, privacy, and open access to information, and to push censorship/control mechanisms back toward **transparent due process** rather than opaque automation.

---


## 1.1 Motivation and context

Privacy Shield is motivated by the rise of **administrative and automated blocking schemes** that can
be applied broadly and expanded beyond their original scope.

As an illustrative example, the project originated in response to concerns raised by initiatives such as
**Italy’s “Piracy Shield” (AGCOM)** and the broader trend toward network-level controls that can be
repurposed for mass censorship or mass surveillance.

Privacy Shield’s response is **technical** and **rights-focused**: build neutral, open protocols that make
broad network control less scalable, and encourage solutions grounded in transparent, accountable due process.

## 2. Design goals

Privacy Shield aims to build:

- **A privacy-preserving overlay network layer** that remains **fast enough for real-time media**
  (voice/video/live streaming), not just low-bandwidth messaging.
- A system that is **accessible** (simple setup, reasonable defaults), **portable** (runs on commodity hardware),
  and **auditable** (open specifications, test vectors, reproducible builds when possible).
- A stack that is **modular and independent**: it should reuse solid, existing open technologies where helpful,
  but **must not require** a specific external daemon or third-party network to exist.

---

## 3. Non-goals and safety boundaries

Privacy Shield is not:

- A content hosting service.
- A piracy platform or a “pirate streaming” tool.
- A promise of “absolute anonymity” against all adversaries.

Privacy Shield **cannot guarantee** operation inside networks with very high levels of censorship and control.
It is designed primarily for environments where legal and democratic safeguards still exist, even if imperfect.

No technology can guarantee absolute anonymity, especially against targeted investigations.

---

## 4. Core components

Privacy Shield consists of two protocol families.

### 4.1 TSNL — Time-based Spatial Network Layer(s)

**TSNL** is a privacy-focused overlay networking layer where:

- Every participant can act as **node + relay** for others.
- Peers communicate using **alias addresses** rather than directly exchanging stable, authentic IP identity.
- Routing uses a **latency-derived coordinate space** (the “time-based spatial” concept).
- Traffic can be **re-routed, diversified, padded, and reshaped** to reduce traceability while keeping usable throughput.
- The protocol is designed to support **real-time multimedia** use cases.

TSNL is **multi-dimensional** (“layers”): nodes can operate in different **dimensions** to reduce global visibility,
express performance classes, and increase route diversity.

### 4.2 P2V — Peer-to-Viewer live distribution

**P2V** is an optional live streaming distribution protocol that blends:

- **P2P mesh redundancy** (viewers and relays share segments),
- **real-time streaming requirements** (low-latency, low buffering),
- and **censorship resistance through replication and path diversity**.

P2V is **secondary** to TSNL. It is implemented only if/when it is needed for the broader goals of neutrality and
open access.

---


## 4.3 Specifications and repositories

- The TSNL specification is maintained as an open document and will be published and iterated in the
  organization’s specification repository.
- Reference implementations target **Node.js (TypeScript)** first, with additional implementations (e.g., Go)
  as optional interoperability workstreams.

Where available, link the canonical spec and draft documents from this repository’s README.

## 5. Threat model (what we defend against)

Privacy Shield primarily targets:

- **Blocking and filtering** at the network level:
  - IP blocks and endpoint blacklists,
  - DNS manipulation,
  - SNI/HTTP filtering,
  - traffic classification and throttling.
- **Mass monitoring**:
  - metadata collection (who talks to whom, when, and how much),
  - automated enforcement and “suspicion scoring.”
- **Partial active interference**:
  - injected resets,
  - selective drops,
  - targeted throttling.

Privacy Shield does **not** claim to defeat a global passive adversary with full visibility of many backbone links
without heavy and costly defenses (e.g., substantial cover traffic and mixnet-like assumptions).

---

## 6. TSNL technical manifesto

This section describes TSNL in an implementation-oriented form. Details will be refined and published as a formal
specification with test vectors.

### 6.1 Node identity, aliasing, and addressing

**Goal:** communicate and route using **alias addresses**, reducing direct dependence on stable IP identity.

- An **alias address** is a short identifier (e.g., 48–64 bits) that a node uses for overlay routing and addressing.
- A node MUST have a cryptographic identity (public/private keypair) to authenticate control of its alias and to
  enable secure handshakes.
- Alias records MUST be **time-bounded** (TTL/expiration) and **rotatable** to reduce long-term linkability.

**Recommended direction (robustness):**
- Prefer **self-certifying identity** (address derived from or bound to a public key) to reduce alias hijacking.
- Support “human-friendly labels” as an optional UI layer, not as routing truth.

### 6.2 Time-based spatial coordinates

TSNL associates each alias with **x, y, z** coordinates (floating point internally), representing a **synthetic
space** derived from latency measurements (e.g., RTT/ping) between reference peers.

- Coordinates MUST NOT be treated as geographic truth.
- Coordinates MUST be “good enough” for routing decisions and neighbor selection, not perfect or globally consistent.
- Each node’s coordinate estimation is inherently local; the network map is best understood as a **relativistic**
  aggregate of many partial perspectives.

**Portability note:**
- Internally, `Float32` (12 bytes) is acceptable.
- On-wire encoding SHOULD be compressible (quantization / fixed-point / delta encoding) when needed.

### 6.3 Dimensions (“layers”) and altitude

The `z` axis also represents **dimension/altitude**: a mathematical representation of operating layer(s).

Dimensions exist to:

- reduce any single node’s ability to observe the whole network,
- improve path diversity,
- and allow performance-aware routing without binding to ISP identity.

**Important:** dimensions MUST NOT become rigid “fast lanes” that create predictable, profiler-friendly behavior.

Dimension selection SHOULD include:
- randomization,
- diversity constraints,
- and penalties for overused routes.

### 6.4 Routing requirements

TSNL routing MUST support both:

1) **one-off packet delivery** (quick reachability), and  
2) **stable sessions** (streams) with enough throughput for real-time media.

Routing MUST also provide:

- **path diversification** (multi-path forwarding),
- **route rotation** over time,
- and optional **cross-dimension routing** as part of shuffling strategies.

#### 6.4.1 Region-based quantization

To avoid latency scaling linearly with distance, TSNL introduces region quantization:

- Define a **Reference Region Size (RRS)** based on average peer distance (conceptually).
- For each scale, coordinates are quantized into regions.
- RRS scales up (e.g., doubling) until reaching **Full Scale** (a single region).

Each node maintains:
- a neighbor table for close peers in the same dimension, AND
- a set of **reference nodes** per region and scale (when available), to support long-distance jumps.

### 6.5 Cryptography and wire-image mutation

TSNL uses two cryptographic layers:

- **Point-to-point protection**: confidentiality + authenticity between endpoints (or between session endpoints).
- **Routing (hop-by-hop) protection**: per-relay transformation to mutate the **wire image** of packets as they transit
  the overlay.

The protocol MUST support frequent key rotation and SHOULD support witness/intermediary mechanisms for secure
key agreement in hostile environments.

**Modern implementation recommendation:**
- Prefer **X25519** for key agreement and **Ed25519** for signatures.
- Prefer **AEAD** for packet encryption (e.g., ChaCha20-Poly1305 or AES-GCM).
- Avoid RSA in new designs unless there is a strict compatibility reason.

### 6.6 Shuffling strategies

Cryptography alone is not sufficient for effective traffic obfuscation.
TSNL therefore defines **shuffling strategies** (policy bundles) that MAY include:

- batching and reordering of packets,
- dummy packets / padding,
- probabilistic route changes,
- multi-path sending (with selective redundancy for key frames / control packets).

**Safety principle:**
- Shuffling MUST NOT allow arbitrary remote code execution.
- Strategies SHOULD be expressed as **declarative configurations** or a small, auditable catalog of behaviors.
- If programmability is required, it MUST be sandboxed, deterministic, and signed.

### 6.7 Parallel checksum / integrity signaling (optional)

A draft concept is a “parallel checksum highway” that routes compact integrity hints via alternate paths.

In practice:
- AEAD already provides per-packet integrity.
- An optional parallel channel MAY still be useful for:
  - detecting selective dropping patterns across paths,
  - measuring path quality,
  - or confirming delivery of specific critical chunks.

If implemented, we recommend moving from raw checksums toward:
- chunk commitments (Merkle hashing),
- and/or FEC (forward error correction) for streaming resilience.

### 6.8 Roles, attributes, and reputation

Nodes may have roles/attributes based on:
- latency, bandwidth, stability, uptime,
- hardware capabilities,
- and local reputation.

**Privacy constraint:**
- Reputation SHOULD be primarily **local** to clients, not a global public ranking, to reduce long-term tracking risk.

Bootstrap and reference roles (e.g., “master nodes”) MUST have decentralization and replacement strategies.

### 6.9 Distributed Hash Table (DHT) and alias resolution

Nodes are expected to store a small, redundant portion of distributed tables to enable fast access to essential data,
including alias resolution.

The DHT layer MUST support:
- signed alias records,
- expiration/rotation,
- and caching strategies.

**Privacy note:** DHT lookups can leak “who is trying to reach whom.” Mitigations MAY include:
- relay-based lookups,
- batching,
- caching,
- or other privacy-preserving lookup techniques as the protocol evolves.

---

## 7. P2V technical manifesto (optional)

P2V’s primary purpose is **lawful, accessible live distribution** (education, conferences, civic broadcasting,
emergency information) with censorship resilience.

P2V SHOULD be separated into:

- **Control plane**: discovery, membership, stream metadata, peer selection (gossip/pubsub).
- **Data plane**: live segment/chunk distribution (QUIC/WebRTC streams).

P2V MUST prioritize:
- low latency,
- integrity verification of segments,
- and adaptive buffering under churn.

---

## 8. Reuse of existing technologies (solidity + speed + independence)

Privacy Shield explicitly favors pragmatic reuse when it increases:

- correctness,
- development speed,
- portability,
- and resilience.

At the same time, Privacy Shield MUST remain **independent**:
TSNL/P2V cannot require a single third-party daemon or global network to function.

### 8.1 Candidate technologies

- **QUIC**: strong candidate for the transport layer (reliable streams over UDP, better under mobility).
- **ICE / NAT traversal**: useful for peer connectivity in hostile NAT environments.
- **P2P DB / DHT tooling (e.g., GUN)**: useful as reference for decentralized records and bootstrap data.
- **libp2p / IPFS** (partial reuse):
  - **Good for**: discovery, transport abstraction, NAT traversal helpers, multiplexing, pubsub, DHT primitives.
  - **Not sufficient for**: TSNL privacy semantics (aliasing, multi-path routing, hop-by-hop wire mutation, shuffling).

**Policy:**
- We MAY ship adapters that use libp2p/IPFS components.
- The core TSNL implementation MUST define stable internal interfaces so the project remains portable and not locked
  to a specific ecosystem.

---

## 9. Node.js-first implementation principles

### 9.1 Language and runtime

- TypeScript SHOULD be the primary implementation language.
- Node.js LTS MUST be supported.
- Native addons MUST be optional; the base stack SHOULD work without them.

### 9.2 Package architecture (suggested)

- `@privacyshield/tsnl-core` — routing, packet formats, aliasing, shuffle policies
- `@privacyshield/tsnl-crypto` — identities, handshakes, AEAD, key rotation
- `@privacyshield/tsnl-transport` — transport interface + QUIC/WebRTC/TCP-TLS implementations
- `@privacyshield/tsnl-dht` — alias resolution records, caching, replication
- `@privacyshield/p2v` — live distribution (optional)
- `@privacyshield/node` — reference node (CLI + config + metrics)

### 9.3 Minimal core interfaces (stability contract)

To keep the system portable, the following interfaces MUST be stable:

- **Transport**: dial/listen, datagrams/streams, connection metadata
- **CryptoProvider**: handshake, encrypt/decrypt, sign/verify, randomness
- **RoutingEngine**: neighbor management, next-hop selection, multi-path policy
- **DHTStore**: put/get signed records with TTL and replication hints
- **ShufflePolicy**: declarative policy evaluation and per-flow scheduling
- **Metrics/Logging**: privacy-safe telemetry and debug traces

---

## 10. Roadmap (incremental shipping)

1) **Overlay prototype**
   - identity + alias
   - encrypted sessions
   - neighbor tables and basic forwarding

2) **Diversification**
   - multi-path routing
   - route rotation
   - padding/dummy strategies (conservative defaults)

3) **Coordinate space + regions**
   - coordinate stabilization
   - region tables (multi-scale)
   - dimension logic with anti-predictability constraints

4) **P2V proof-of-concept (optional)**
   - lawful live stream demo
   - integrity commitments + adaptive distribution

5) **Interoperability + hardening**
   - formal spec
   - test vectors
   - fuzzing and adversarial simulation harness

---

## 11. Security, privacy, and operational notes

- Minimize logging by default.
- Never log raw IPs, peer identifiers, or destination aliases unless explicitly enabled for debugging.
- Provide “privacy-preserving diagnostics” (aggregate metrics, local-only traces).
- Treat shuffling strategy changes as security-sensitive updates: require signatures and compatibility checks.

Responsible disclosure is encouraged (see repository security policy if present).

---

## 12. Community and contribution

Privacy Shield welcomes contributors across engineering, documentation, UX, and research.

- Prefer small, reviewable changes.
- Keep the Node.js implementation portable and dependency-light.
- Design for real users: setup guides, defaults, and safe failure modes.

If contributors face intimidation or coercion for participation, document it transparently through project channels
(where safe), and seek support from digital rights organizations.

---

## 13. Terminology (short)

- **Alias**: overlay identifier not equal to a real IP.
- **Coordinate space**: synthetic map derived from latency measurements.
- **Dimension**: overlay layer/altitude used for isolation and performance-aware routing.
- **Wire image**: observable on-the-wire packet representation.
- **Shuffling**: routing + traffic shaping behaviors that reduce traceability.

---
