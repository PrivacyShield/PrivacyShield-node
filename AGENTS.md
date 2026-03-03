# After a prompt
- Keep `README.md` for human documentation and this AGENTS.md for AI in sync whenever MiniPhi gains a new command, argument, or workflow and essential source code references for AGENTS.md

## Project and source code structure

- `src/node.js`: PrivacyShield node orchestrator (routing, transport selection, DHT, session rekey)
- `src/identity.js`: keypairs, alias derivation, alias records
- `src/coordinates.js`: latency-based coordinate estimation + quantization helpers
- `src/routing.js`: neighbor table + simple/dynamic/ring-aware routing engines
- `src/transport/memory.js`: in-process transport for local demos/tests
- `src/transport/tcp.js`: TCP adapter for real network IO (pooling, batching, cover scheduler)
- `src/transport/udp.js`: UDP adapter for alternative paths + NAT keepalive probes
- `src/transport/adaptive.js`: dynamic multi-transport wrapper (UDP/TCP fallback strategy)
- `src/transport/base.js`: minimal transport contract
- `src/dht.js`: in-memory DHT store for alias records
- `src/shuffle.js`: shuffle policies (padding and delay)
- `src/crypto.js`: AEAD helpers for payload protection
- `src/packet.js`: packet creation + wire serialization/parsing helpers
- `src/handshake.js`: X25519 + Ed25519 session establishment helpers
- `src/identity-store.js`: filesystem identity persistence helpers for practical node usage
- `src/demo.js`: in-process helpers for local testing
- `src/cli.js`: practical CLI (`identity:create`, `identity:show`, `server`, `client`)
- `src/tunnel.js`: tunnel bridge helpers for non-PrivacyShield TCP clients/servers
- `scripts/bench-routing.js`: routing next-hop benchmark runner
- `scripts/bench-framing.js`: TCP framing benchmark runner
- `scripts/bench-cover.js`: cover-traffic overhead benchmark runner
- `scripts/perf-gate.js`: local benchmark threshold gate runner
- `.github/workflows/performance-gate.yml`: CI job for tests + perf gate
- `OPTIMIZATIONS.md`: performance strategy, benchmark snapshots, and tuning plan

## Test workflow

- `npm test`: run the stability/unit test suite (`test/**/*.test.js`) using Node's built-in test runner.
- `npm run test:watch`: rerun unit tests in watch mode during active development.
- `npm run identity:create -- --identity <path>`: create a persistent identity file for a node.
- `npm run identity:show -- --identity <path>`: print alias metadata for an identity file.
- `npm run node:server -- --identity <path> [--transport tcp|udp|adaptive] [--host <host>] [--port <port>] [--echo]`: run a practical node with selectable transport.
- `npm run node:client -- --identity <path> --peer-alias <alias> --peer-host <host> --peer-port <port> --message <text> [--encrypt] [--await-reply] [--transport tcp|udp|adaptive]`: send a practical client message with dynamic transport.
- `npm run node:tunnel:gateway -- --identity <path> --target-host <host> --target-port <port> [--peer-alias <alias> --peer-host <host> --peer-port <port>]`: accept tunnel control packets and bridge to a local TCP service.
- `npm run node:tunnel:bind -- --identity <path> --peer-alias <alias> --peer-host <host> --peer-port <port> --target-host <host> --target-port <port> [--listen-port <port>]`: expose a local TCP bind for legacy apps over PrivacyShield.
- `npm run bench:routing -- --neighbors <n> --iterations <n> --max-paths <n>`: benchmark routing next-hop selection throughput.
- `npm run bench:framing -- --iterations <n> --payload-bytes <n>`: benchmark TCP framing encode/decode cost and wire size.
- `npm run bench:cover -- --messages <n> --payload-bytes <n> --max-cover-to-real-ratio <ratio>`: benchmark cover-traffic overhead and throughput retention.
- `npm run perf:gate`: enforce benchmark thresholds and fail on regressions.
- `npm run node:server -- --dynamic-routing true --ring-routing true --provider-diversity true --provider-id <id> --min-paths <n> --max-paths <n> --route-obfuscation-delay-ms <ms> --route-obfuscation-noise <float> --batch-window-ms <ms> --batch-max-frames <n> --flush-jitter-ms <ms> --lane-count <n> --cover-traffic true --max-cover-to-real-ratio <ratio> --rekey-interval-ms <ms> --rekey-share-count <n>`: run ring-aware, provider-diverse high-performance routing with cover traffic + key rotation.
- `npm run node:client -- --transport adaptive --peer-udp-port <port> --dynamic-routing true --ring-routing true --provider-diversity true --min-paths <n> --max-paths <n> --route-obfuscation-delay-ms <ms> --route-obfuscation-noise <float> --batch-window-ms <ms> --batch-max-frames <n> --flush-jitter-ms <ms> --lane-count <n> --cover-traffic true --max-cover-to-real-ratio <ratio> --rekey-interval-ms <ms> --rekey-share-count <n>`: client-side equivalent tuning knobs with UDP/TCP fallback.

## Test structure

- `test/node.integration.test.js`: in-process network behavior (message forwarding, handshake, encrypted payload flow, split-route rekey, rotation, coordinate sample bounds)
- `test/routing.test.js`: neighbor table and routing multipath/churn expectations
- `test/identity-dht.test.js`: alias record validation + DHT acceptance/expiry behavior
- `test/handshake-crypto.test.js`: handshake integrity, AEAD roundtrips/tamper rejection, split-key rekey primitives
- `test/packet.test.js`: packet serialization/parsing compatibility and roundtrips
- `test/coordinates.test.js`: coordinate estimation, quantization, and distance helper invariants
- `test/identity-store.test.js`: filesystem identity persistence + integrity guards
- `test/tcp.integration.test.js`: real TCP handshake/message integration with learned return routes, legacy frame compatibility, and bounded cover scheduling
- `test/udp.integration.test.js`: real UDP handshake/message integration and session protection
- `test/adaptive.integration.test.js`: adaptive transport UDP/TCP fallback behavior
- `test/tunnel.integration.test.js`: tunnel binding/gateway interoperability for legacy TCP traffic
- `test/helpers.js`: async event waiting helper shared by integration tests
