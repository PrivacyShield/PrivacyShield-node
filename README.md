# Privacy Shield (Node.js)

Node.js / TypeScript-first implementation of **Privacy Shield**, starting with **TSNL (Time-based Spatial Network Layer[s])** — a privacy-oriented overlay network designed to make **blocking and mass surveillance** materially harder while keeping enough performance for **real‑time media**. :contentReference[oaicite:0]{index=0}

> **Status:** experimental / research-grade. Not audited. Not production-ready.

- 📜 Read the project manifesto: **[`MANIFESTO.md`](./MANIFESTO.md)**
- 📐 Protocol specification drafts (separate repo): see the PrivacyShield organization (e.g. `tsnl-specification`)

---

## What this repository is

This repository hosts the **reference Node.js implementation** of the Privacy Shield stack, with an emphasis on:

- **Accessibility:** easy to run locally, minimal moving parts, sensible defaults.
- **Portability:** runs anywhere Node.js runs (Linux/macOS/Windows/Raspberry Pi).
- **Modularity:** clear interfaces; optional adapters for external stacks (e.g. libp2p) without hard dependencies.
- **Pragmatic reuse:** adopt existing tech where it increases solidity and development speed (QUIC/WebRTC/ICE/DHT building blocks), while keeping the **core independent**.

This repo is the **implementation**. The **spec** lives separately.

---

## What Privacy Shield is (and is not)

Privacy Shield is a non-profit technical initiative to defend:

- freedom of expression and access to information,
- privacy by default,
- network neutrality. :contentReference[oaicite:1]{index=1}

**It is not a content distribution project and does not promote piracy.** It provides protocols and software primitives that can be used for lawful, legitimate communication, including civic broadcasting, education, and emergency information. :contentReference[oaicite:2]{index=2}

See the manifesto for the full ethical and legal positioning.

---

## Core components

### TSNL — Time-based Spatial Network Layer(s)

TSNL is an overlay network where nodes can act as **participants + relays**. It introduces:

- **alias-first addressing** (avoid tying routing identity to IP addresses),
- **latency-derived “coordinate space” routing** (time-based spatial model),
- **multi-path routing and controlled route churn** (reduce observability),
- **per-hop wire-image mutation** (packets change appearance when relayed),
- optional **dimensions/layers** to limit global visibility and avoid predictable topologies. :contentReference[oaicite:3]{index=3}

The long-term goal is to provide **more usable throughput** than classic anonymity networks in scenarios where real-time media matters, without claiming “absolute anonymity”.

### P2V — Peer-to-Viewer (optional / later)

P2V is a decentralized **live streaming distribution** approach (P2P + TV-like experience), intended for lawful use cases. It is **secondary** to TSNL and will be developed only if/when strictly necessary. :contentReference[oaicite:4]{index=4}

---

## Threat model (high-level)

This project is designed to resist, at scale:

- IP blocking / endpoint blacklists
- DNS poisoning / filtering
- SNI / traffic classification & throttling
- mass metadata collection and automated enforcement

Non-goals (at least initially):

- guaranteed protection against a **global passive adversary**
- guaranteed operation behind the most restrictive national firewalls
- “perfect anonymity” under targeted investigation :contentReference[oaicite:5]{index=5}

---

## Architecture (planned)

This repository is structured as **libraries first**, with a reference CLI node on top:

- `packages/tsnl-core` — routing, addressing, packet formats, shuffling policies
- `packages/tsnl-crypto` — keys, handshakes, AEAD, rotation policies
- `packages/tsnl-transport` — transport interface + implementations (QUIC/WebRTC/TCP)
- `packages/tsnl-dht` — alias resolution records, caching, lookup strategies
- `packages/p2v` — live distribution primitives (optional)
- `apps/node` — reference node CLI (bootstrap, config, metrics, demos)

> The exact package split may evolve; stability is guaranteed at the **API level** once public interfaces are declared “stable”.

---

## Technology choices

### Node.js / TypeScript

- Primary target: **Node.js LTS** + **TypeScript**
- Minimal native dependencies (optional adapters can be native)

### Transports

We aim for a multi-transport abstraction so the network can operate across different environments:

- QUIC (where available)
- WebRTC data channels (useful for NAT traversal)
- TCP/TLS fallback for constrained environments

### Reuse without hard dependency (libp2p / IPFS stance)

Some building blocks available in **libp2p/IPFS** ecosystems are valuable (DHTs, transports, pubsub, NAT traversal). We may provide **optional adapters**, but the TSNL core **MUST NOT** require a separate daemon (e.g. `ipfs`) to run. :contentReference[oaicite:6]{index=6}

---

## Getting started (development)

> The toolchain and scripts will stabilize as the repo is scaffolded. These commands reflect the intended workflow.

### Requirements

- Node.js **LTS**
- `pnpm` (recommended) or `npm`

### Install

```bash
pnpm install
```

### Run unit tests

```bash
npm test
```

Watch mode for rapid iteration:

```bash
npm run test:watch
```

### Run performance benchmarks

```bash
npm run bench:routing -- --neighbors 5000 --iterations 20000 --max-paths 3
npm run bench:framing -- --iterations 100000 --payload-bytes 1024
```

Performance strategy, benchmark snapshots, and tuning guidance live in `OPTIMIZATIONS.md`.

### Run performance regression gate

```bash
npm run perf:gate
```

### Practical TCP server/client workflow

Create persistent identities:

```bash
npm run identity:create -- --identity ./.privacyshield/server.identity.json
npm run identity:create -- --identity ./.privacyshield/client.identity.json
```

Show an identity alias (for sharing with peers):

```bash
npm run identity:show -- --identity ./.privacyshield/server.identity.json
```

Start a server node:

```bash
npm run node:server -- --identity ./.privacyshield/server.identity.json --host 127.0.0.1 --port 4001 --echo
```

Send from a client node (replace `<SERVER_ALIAS>` with the server alias):

```bash
npm run node:client -- \
  --identity ./.privacyshield/client.identity.json \
  --peer-alias <SERVER_ALIAS> \
  --peer-host 127.0.0.1 \
  --peer-port 4001 \
  --message "hello practical" \
  --encrypt \
  --await-reply
```

Tune dynamic routing + transport batching/obfuscation (example):

```bash
npm run node:server -- \
  --identity ./.privacyshield/server.identity.json \
  --dynamic-routing true \
  --min-paths 1 \
  --max-paths 3 \
  --route-obfuscation-delay-ms 3 \
  --route-obfuscation-noise 0.08 \
  --batch-window-ms 2 \
  --batch-max-frames 24 \
  --flush-jitter-ms 1 \
  --lane-count 4
```

### Quick in-process demo (memory transport)

```js
const { createInMemoryPair } = require("./src");

const { nodeA, nodeB, start, stop } = createInMemoryPair();

nodeB.on("message", ({ payload }) => {
  console.log("nodeB received:", payload.toString());
  stop();
});

start();
nodeA.sendMessage(nodeB.alias, "hello from nodeA");
```

### Session handshake + encrypted payloads

```js
const { createInMemoryPair } = require("./src");

const { nodeA, nodeB, start, establishSession } = createInMemoryPair();

nodeB.on("session", ({ alias }) => {
  console.log("session established with", alias);
  nodeA.sendMessage(alias, "sealed", { encrypt: true });
});

nodeB.on("message", ({ payload }) => {
  console.log("decrypted:", payload.toString());
});

start();
establishSession(); // sends handshake offers both ways
```

### TCP transport (early)

```js
const { PrivacyShieldNode, TcpTransport } = require("./src");

const transportA = new TcpTransport({ alias: "alice", port: 4001 });
const transportB = new TcpTransport({ alias: "bob", port: 4002 });

const nodeA = new PrivacyShieldNode({ transport: transportA });
const nodeB = new PrivacyShieldNode({ transport: transportB });

nodeA.addNeighbor({ alias: nodeB.alias, address: { host: "127.0.0.1", port: 4002 } });
nodeB.addNeighbor({ alias: nodeA.alias, address: { host: "127.0.0.1", port: 4001 } });

nodeB.on("message", ({ payload }) => console.log(payload.toString()));

nodeA.start();
nodeB.start();

nodeA.sendMessage(nodeB.alias, "hello over TCP");
```

### Prototype layout (current)

- `src/node.js`: PrivacyShield node orchestrator (routing, transport, DHT)
- `src/identity.js`: keypairs, alias derivation, alias records
- `src/coordinates.js`: latency-based coordinate estimation + quantization helpers
- `src/routing.js`: neighbor table + simple/dynamic concurrent routing engines
- `src/transport/memory.js`: in-process transport for local demos/tests
- `src/transport/tcp.js`: TCP adapter for basic real network IO (newline-framed)
- `src/transport/base.js`: minimal transport contract
- `src/dht.js`: in-memory DHT store for alias records
- `src/shuffle.js`: shuffle policies (padding and delay)
- `src/crypto.js`: AEAD helpers for payload protection
- `src/packet.js`: packet creation and wire serialization/parsing helpers
- `src/handshake.js`: X25519 + Ed25519 session establishment utilities
- `src/identity-store.js`: filesystem identity persistence helpers
- `src/demo.js`: in-process helpers for local testing
- `src/cli.js`: practical CLI for identity management and TCP server/client workflows
- `scripts/bench-routing.js`: routing selection benchmark helper
- `scripts/bench-framing.js`: TCP framing benchmark helper
- `scripts/perf-gate.js`: benchmark threshold gate used locally and in CI
- `.github/workflows/performance-gate.yml`: CI workflow for tests + perf regression checks

### Stability test harness (current)

- `test/node.integration.test.js`: in-process network behavior (forwarding, handshake, encrypted messages, rotation, coordinate sample bounds)
- `test/routing.test.js`: neighbor table and routing multipath/churn checks
- `test/identity-dht.test.js`: alias record validation and DHT expiry behavior
- `test/handshake-crypto.test.js`: handshake integrity and AEAD tamper resistance
- `test/packet.test.js`: packet wire serialization/parsing compatibility
- `test/coordinates.test.js`: coordinate estimation, quantization, and distance invariants
- `test/identity-store.test.js`: filesystem identity persistence and integrity checks
- `test/tcp.integration.test.js`: real TCP handshake and encrypted message flow with learned return routes
