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

## Test workflow

- `npm test`: run the stability/unit test suite (`test/**/*.test.js`) using Node's built-in test runner.
- `npm run test:watch`: rerun unit tests in watch mode during active development.

## Test structure

- `test/node.integration.test.js`: in-process network behavior (message forwarding, handshake, encrypted payload flow, rotation, coordinate sample bounds)
- `test/routing.test.js`: neighbor table and routing multipath/churn expectations
- `test/identity-dht.test.js`: alias record validation + DHT acceptance/expiry behavior
- `test/handshake-crypto.test.js`: handshake integrity and AEAD roundtrips/tamper rejection
- `test/coordinates.test.js`: coordinate estimation, quantization, and distance helper invariants
- `test/helpers.js`: async event waiting helper shared by integration tests
