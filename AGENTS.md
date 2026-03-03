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
- `src/identity-store.js`: filesystem identity persistence helpers for practical node usage
- `src/demo.js`: in-process helpers for local testing
- `src/cli.js`: practical CLI (`identity:create`, `identity:show`, `server`, `client`)

## Test workflow

- `npm test`: run the stability/unit test suite (`test/**/*.test.js`) using Node's built-in test runner.
- `npm run test:watch`: rerun unit tests in watch mode during active development.
- `npm run identity:create -- --identity <path>`: create a persistent identity file for a node.
- `npm run identity:show -- --identity <path>`: print alias metadata for an identity file.
- `npm run node:server -- --identity <path> [--host <host>] [--port <port>] [--echo]`: run a practical TCP server node.
- `npm run node:client -- --identity <path> --peer-alias <alias> --peer-host <host> --peer-port <port> --message <text> [--encrypt] [--await-reply]`: send a practical client message over TCP.

## Test structure

- `test/node.integration.test.js`: in-process network behavior (message forwarding, handshake, encrypted payload flow, rotation, coordinate sample bounds)
- `test/routing.test.js`: neighbor table and routing multipath/churn expectations
- `test/identity-dht.test.js`: alias record validation + DHT acceptance/expiry behavior
- `test/handshake-crypto.test.js`: handshake integrity and AEAD roundtrips/tamper rejection
- `test/coordinates.test.js`: coordinate estimation, quantization, and distance helper invariants
- `test/identity-store.test.js`: filesystem identity persistence + integrity guards
- `test/tcp.integration.test.js`: real TCP handshake/message integration with learned return routes
- `test/helpers.js`: async event waiting helper shared by integration tests
