#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  PrivacyShieldNode,
  TcpTransport,
  loadIdentityFromFile,
  loadOrCreateIdentity,
  saveIdentityToFile,
  generateIdentity,
} = require("./index");

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function printUsage() {
  console.log(`
PrivacyShield practical CLI

Commands:
  identity:create --identity <path>
  identity:show --identity <path>
  server --identity <path> [--host 127.0.0.1] [--port 4001] [--echo] [routing/transport/rekey flags]
  client --identity <path> --peer-alias <alias> --peer-host <host> --peer-port <port> --message <text> [--encrypt] [--await-reply] [routing/transport/rekey flags]

Key tuning flags:
  Routing: --dynamic-routing true --min-paths <n> --max-paths <n> --route-obfuscation-delay-ms <ms> --route-obfuscation-noise <float>
  Transport: --lane-count <n> --batch-window-ms <ms> --batch-max-frames <n> --flush-jitter-ms <ms>
  Cover: --cover-traffic true --cover-interval-ms <ms> --cover-rate-bps <n> --max-cover-to-real-ratio <ratio>
  Rekey: --rekey-interval-ms <ms> --rekey-share-count <n> --rekey-noise-packets <n> --rekey-grace-ms <ms>
`);
}

function parsePort(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseTimeout(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`Invalid timeout: ${value}`);
  }
  return timeout;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseFloatValue(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid float value: ${value}`);
  }
  return parsed;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (value === true || value === false) {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function buildTransportOptions(args, alias, host, port) {
  return {
    alias,
    host,
    port,
    laneCount: parsePositiveInt(args["lane-count"], 4),
    batchWindowMs: parsePositiveInt(args["batch-window-ms"], 2),
    batchMaxFrames: parsePositiveInt(args["batch-max-frames"], 24),
    batchMaxBytes: parsePositiveInt(args["batch-max-bytes"], 64 * 1024),
    flushJitterMs: parsePositiveInt(args["flush-jitter-ms"], 1),
    socketIdleTimeoutMs: parsePositiveInt(args["socket-idle-timeout-ms"], 30_000),
    coverTrafficEnabled: parseBool(args["cover-traffic"], false),
    coverIntervalMs: parsePositiveInt(args["cover-interval-ms"], 45),
    coverJitterMs: parsePositiveInt(args["cover-jitter-ms"], 12),
    coverRateBytesPerSec: parsePositiveInt(args["cover-rate-bps"], 8 * 1024),
    coverBurstBytes: parsePositiveInt(args["cover-burst-bytes"], 96 * 12),
    coverPacketBytes: parsePositiveInt(args["cover-packet-bytes"], 96),
    coverPeerFanout: Math.max(1, parsePositiveInt(args["cover-peer-fanout"], 2)),
    coverTtl: Math.max(1, parsePositiveInt(args["cover-ttl"], 2)),
    coverWarmupFrames: parsePositiveInt(args["cover-warmup-frames"], 4),
    maxCoverToRealRatio: parseFloatValue(args["max-cover-to-real-ratio"], 0.5),
  };
}

function buildNodeOptions(args, identity, transport) {
  const laneCount = parsePositiveInt(args["lane-count"], 4);
  const dynamicRouting = parseBool(args["dynamic-routing"], true);
  const minPaths = parsePositiveInt(args["min-paths"], 1);
  const maxPaths = Math.max(minPaths, parsePositiveInt(args["max-paths"], 3));
  const routeObfuscationDelayMs = parsePositiveInt(
    args["route-obfuscation-delay-ms"],
    2
  );
  const obfuscationNoise = parseFloatValue(args["route-obfuscation-noise"], 0.08);

  const options = {
    identity,
    transport,
    routeLaneCount: laneCount,
    routeObfuscationDelayMs,
    rekeyShareCount: Math.max(2, parsePositiveInt(args["rekey-share-count"], 3)),
    rekeyShareSpreadMs: parsePositiveInt(args["rekey-share-spread-ms"], 8),
    rekeyNoisePackets: parsePositiveInt(args["rekey-noise-packets"], 1),
    rekeyNoiseBytes: Math.max(16, parsePositiveInt(args["rekey-noise-bytes"], 48)),
    rekeyIntervalMs: parsePositiveInt(args["rekey-interval-ms"], 0),
    rekeyIntervalJitterMs: parsePositiveInt(args["rekey-interval-jitter-ms"], 1_000),
    rekeyGraceMs: parsePositiveInt(args["rekey-grace-ms"], 15_000),
    rekeyTtlJitter: parsePositiveInt(args["rekey-ttl-jitter"], 1),
  };
  if (dynamicRouting) {
    options.dynamicRouting = {
      minPaths,
      maxPaths,
      dynamicPathSpread: true,
      obfuscationNoise,
    };
  }
  return options;
}

function waitForEvent(emitter, eventName, options = {}) {
  const predicate = options.predicate || (() => true);
  const timeoutMs = options.timeoutMs || 5_000;

  return new Promise((resolve, reject) => {
    const onEvent = (value) => {
      let matches = false;
      try {
        matches = predicate(value);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!matches) {
        return;
      }
      cleanup();
      resolve(value);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out waiting for "${eventName}"`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(eventName, onEvent);
    };

    const timer = setTimeout(onTimeout, timeoutMs);
    emitter.on(eventName, onEvent);
  });
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs || 5_000;
  const intervalMs = options.intervalMs || 20;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityPathFromArgs(args, defaultPath) {
  return path.resolve(args.identity || defaultPath);
}

function printNodeAddress(node, transport, identityPath, created) {
  const address = transport.getAddress();
  console.log(
    JSON.stringify({
      alias: node.alias,
      host: address ? address.host : null,
      port: address ? address.port : null,
      identityPath,
      createdIdentity: created,
    })
  );
}

async function runIdentityCreate(args) {
  const identityPath = identityPathFromArgs(args, ".privacyshield/identity.json");
  const identity = generateIdentity();
  const saved = saveIdentityToFile(identityPath, identity);
  console.log(
    JSON.stringify({
      alias: saved.alias,
      identityPath: saved.filePath,
      createdIdentity: true,
    })
  );
}

async function runIdentityShow(args) {
  const identityPath = identityPathFromArgs(args, ".privacyshield/identity.json");
  const loaded = loadIdentityFromFile(identityPath);
  console.log(
    JSON.stringify({
      alias: loaded.alias,
      identityPath: loaded.filePath,
      createdAt: loaded.createdAt,
    })
  );
}

async function runServer(args) {
  const identityPath = identityPathFromArgs(args, ".privacyshield/server.identity.json");
  const host = args.host || "127.0.0.1";
  const port = parsePort(args.port, 4001);
  const readyTimeoutMs = parseTimeout(args["ready-timeout-ms"], 5_000);
  const { identity, alias, created } = loadOrCreateIdentity(identityPath);

  const transport = new TcpTransport(
    buildTransportOptions(args, alias, host, port)
  );
  const node = new PrivacyShieldNode(buildNodeOptions(args, identity, transport));

  node.on("session", ({ alias }) => {
    console.log(`[session] established with ${alias}`);
  });
  node.on("message", ({ fromAlias, payload }) => {
    const text = payload.toString("utf8");
    console.log(`[message] from=${fromAlias || "unknown"} text=${text}`);
    if (args.echo && fromAlias) {
      node.sendMessage(fromAlias, payload, { encrypt: node.hasSessionKey(fromAlias) });
    }
  });
  node.on("drop", ({ reason, fromAlias }) => {
    console.error(`[drop] reason=${reason} from=${fromAlias || "unknown"}`);
  });

  node.start();
  await waitForCondition(() => transport.getAddress(), { timeoutMs: readyTimeoutMs });
  printNodeAddress(node, transport, identityPath, created);

  await waitForShutdown(async () => {
    node.stop();
  });
}

async function runClient(args) {
  if (!args["peer-alias"] || !args["peer-host"] || !args["peer-port"]) {
    throw new Error("client requires --peer-alias, --peer-host, and --peer-port");
  }
  if (!args.message) {
    throw new Error("client requires --message");
  }

  const identityPath = identityPathFromArgs(args, ".privacyshield/client.identity.json");
  const host = args.host || "127.0.0.1";
  const port = parsePort(args.port, 0);
  const peerAlias = String(args["peer-alias"]);
  const peerHost = String(args["peer-host"]);
  const peerPort = parsePort(args["peer-port"]);
  const readyTimeoutMs = parseTimeout(args["ready-timeout-ms"], 5_000);
  const handshakeTimeoutMs = parseTimeout(args["handshake-timeout-ms"], 5_000);
  const awaitReplyMs = parseTimeout(args["await-reply-ms"], 2_000);
  const encrypt = args.encrypt === true;

  const { identity, alias, created } = loadOrCreateIdentity(identityPath);
  const transport = new TcpTransport(
    buildTransportOptions(args, alias, host, port)
  );
  const node = new PrivacyShieldNode(buildNodeOptions(args, identity, transport));
  node.on("drop", ({ reason, fromAlias }) => {
    console.error(`[drop] reason=${reason} from=${fromAlias || "unknown"}`);
  });

  node.start();
  await waitForCondition(() => transport.getAddress(), { timeoutMs: readyTimeoutMs });
  node.addNeighbor({
    alias: peerAlias,
    address: { host: peerHost, port: peerPort },
  });

  if (encrypt) {
    const sessionPromise = waitForEvent(node, "session", {
      timeoutMs: handshakeTimeoutMs,
      predicate: (event) => event.alias === peerAlias,
    });
    node.initiateSessionHandshake(peerAlias);
    await sessionPromise;
  }

  node.sendMessage(peerAlias, Buffer.from(String(args.message)), { encrypt });
  printNodeAddress(node, transport, identityPath, created);
  console.log(
    JSON.stringify({
      peerAlias,
      peerHost,
      peerPort,
      encrypt,
      sentBytes: Buffer.byteLength(String(args.message), "utf8"),
    })
  );

  if (args["await-reply"]) {
    const reply = await waitForEvent(node, "message", {
      timeoutMs: awaitReplyMs,
      predicate: (event) => event.fromAlias === peerAlias,
    });
    console.log(`[reply] ${reply.payload.toString("utf8")}`);
  }

  await sleep(25);
  node.stop();
}

async function waitForShutdown(onShutdown) {
  await new Promise((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      try {
        await onShutdown();
      } finally {
        resolve();
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "identity:create") {
    await runIdentityCreate(args);
    return;
  }
  if (command === "identity:show") {
    await runIdentityShow(args);
    return;
  }
  if (command === "server") {
    await runServer(args);
    return;
  }
  if (command === "client") {
    await runClient(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
