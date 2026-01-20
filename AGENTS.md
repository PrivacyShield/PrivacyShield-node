# After a prompt
- Keep `README.md` for human documentation and this AGENTS.md for AI in sync whenever MiniPhi gains a new command, argument, or workflow and essential source code references for AGENTS.md

## Project and source code structure

- `src/node.js`: PrivacyShield node orchestrator (routing, transport, DHT)
- `src/identity.js`: keypairs, alias derivation, alias records
- `src/coordinates.js`: latency-based coordinate estimation + quantization helpers
- `src/routing.js`: neighbor table + basic routing engine
- `src/transport/memory.js`: in-process transport for local demos/tests
- `src/transport/tcp.js`: TCP adapter for real network IO
- `src/transport/base.js`: minimal transport contract
- `src/dht.js`: in-memory DHT store for alias records
- `src/shuffle.js`: shuffle policies (padding and delay)
- `src/crypto.js`: AEAD helpers for payload protection
- `src/handshake.js`: X25519 + Ed25519 session establishment helpers
- `src/demo.js`: in-process helpers for local testing
