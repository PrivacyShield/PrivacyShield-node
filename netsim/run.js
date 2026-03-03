#!/usr/bin/env node
"use strict";

const path = require("path");
const { buildSimulationConfig } = require("./config");
const { runNetworkSimulation } = require("./simulator");
const { writeSimulationArtifacts } = require("./report");

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const scenario = args.scenario || "advanced-500x30m";
  const overrides = buildOverrides(args);
  const config = buildSimulationConfig(overrides);

  const startedAt = Date.now();
  const report = runNetworkSimulation(config, { scenario });
  const elapsedMs = Date.now() - startedAt;

  let artifacts = null;
  if (!args.noWrite) {
    artifacts = writeSimulationArtifacts(report, {
      outputDir: args.outputDir ? path.resolve(args.outputDir) : undefined,
      scenario,
    });
  }

  printSummary(report, elapsedMs, artifacts);
}

function buildOverrides(args) {
  const overrides = {};

  setIfPresent(overrides, "nodeCount", parseNumber(args.nodes));

  if (args.durationMinutes !== undefined) {
    setIfPresent(
      overrides,
      "durationMs",
      Math.round(parseNumber(args.durationMinutes) * 60_000)
    );
  }
  setIfPresent(overrides, "durationMs", parseNumber(args.durationMs));
  setIfPresent(overrides, "tickMs", parseNumber(args.tickMs));
  if (args.seed !== undefined) {
    overrides.seed = args.seed;
  }

  setIfPresent(
    overrides,
    "traffic.dataSessionsPerSecond",
    parseNumber(args.dataSessionsPerSecond)
  );
  setIfPresent(
    overrides,
    "traffic.noiseSessionsPerSecond",
    parseNumber(args.noiseSessionsPerSecond)
  );
  setIfPresent(overrides, "traffic.payloadBytesMin", parseNumber(args.payloadBytesMin));
  setIfPresent(overrides, "traffic.payloadBytesMax", parseNumber(args.payloadBytesMax));

  setIfPresent(overrides, "routing.routeTtlMs", parseNumber(args.routeTtlMs));
  setIfPresent(
    overrides,
    "routing.mutationProbability",
    parseNumber(args.routeMutationProbability)
  );
  setIfPresent(
    overrides,
    "routing.justInTimeProbability",
    parseNumber(args.justInTimeProbability)
  );

  setIfPresent(overrides, "mitm.baseHopProbability", parseNumber(args.mitmHopProbability));
  setIfPresent(overrides, "mitm.tamperProbability", parseNumber(args.mitmTamperProbability));
  setIfPresent(overrides, "mitm.dropProbability", parseNumber(args.mitmDropProbability));
  setIfPresent(overrides, "mitm.delayProbability", parseNumber(args.mitmDelayProbability));

  setIfPresent(
    overrides,
    "campaigns.spawnProbabilityPerTick",
    parseNumber(args.campaignSpawnProbability)
  );

  setIfPresent(
    overrides,
    "network.preferIpv6Probability",
    parseNumber(args.ipv6Preference)
  );
  setIfPresent(
    overrides,
    "network.translationRelayProbability",
    parseNumber(args.translationRelayProbability)
  );
  setIfPresent(
    overrides,
    "network.natTraversalBaseSuccess",
    parseNumber(args.natBaseSuccess)
  );
  setIfPresent(
    overrides,
    "network.firewallDropBaseProbability",
    parseNumber(args.firewallDropProbability)
  );

  if (args.keyExchange === "false") {
    setNested(overrides, "keyExchange.enabled", false);
  }
  setIfPresent(
    overrides,
    "keyExchange.sessionsPerMinute",
    parseNumber(args.keySessionsPerMinute)
  );
  setIfPresent(overrides, "keyExchange.shareCountMin", parseNumber(args.keyShareMin));
  setIfPresent(overrides, "keyExchange.shareCountMax", parseNumber(args.keyShareMax));

  const ipStackOverrides = buildIpStackOverrides(args);
  if (ipStackOverrides) {
    setNested(overrides, "network.ipStacks", ipStackOverrides);
  }

  return overrides;
}

function buildIpStackOverrides(args) {
  const ipv4 = parseNumber(args.ipv4OnlyShare);
  const dual = parseNumber(args.dualStackShare);
  const ipv6 = parseNumber(args.ipv6OnlyShare);
  const hasAny =
    Number.isFinite(ipv4) || Number.isFinite(dual) || Number.isFinite(ipv6);
  if (!hasAny) {
    return null;
  }

  const values = [ipv4, dual, ipv6];
  let knownSum = 0;
  let missingCount = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      knownSum += Math.max(0, value);
    } else {
      missingCount += 1;
    }
  }

  const remaining = Math.max(0, 1 - knownSum);
  const fill = missingCount > 0 ? remaining / missingCount : 0;
  const finalIpv4 = Number.isFinite(ipv4) ? Math.max(0, ipv4) : fill;
  const finalDual = Number.isFinite(dual) ? Math.max(0, dual) : fill;
  const finalIpv6 = Number.isFinite(ipv6) ? Math.max(0, ipv6) : fill;

  return [
    { id: "ipv4-only", share: finalIpv4 },
    { id: "dual-stack", share: finalDual },
    { id: "ipv6-only", share: finalIpv6 },
  ];
}

function setIfPresent(target, keyPath, value) {
  if (!Number.isFinite(value)) {
    return;
  }
  setNested(target, keyPath, value);
}

function setNested(target, keyPath, value) {
  const keys = keyPath.split(".");
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const rawKey = token.slice(2);
    if (rawKey === "help") {
      args.help = true;
      continue;
    }
    if (rawKey === "no-write") {
      args.noWrite = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[toCamel(rawKey)] = "true";
      continue;
    }
    args[toCamel(rawKey)] = next;
    i += 1;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, group) => group.toUpperCase());
}

function parseNumber(value) {
  if (value === undefined) {
    return Number.NaN;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function printSummary(report, elapsedMs, artifacts) {
  const summary = [
    `[netsim] scenario=${report.scenario}`,
    `[netsim] nodes=${report.meta.nodeCount} durationMinutes=${report.meta.durationMinutes} tickMs=${report.meta.tickMs}`,
    `[netsim] packets attempted=${report.traffic.totalPackets} delivered=${report.traffic.deliveredPackets} successRate=${percent(report.traffic.successRate)}`,
    `[netsim] throughputMbps=${format(report.traffic.throughputMbps)} p95LatencyMs=${format(report.performance.p95LatencyMs)} ipv6HopShare=${percent(
      report.network.hops.ipv6ShareOfHops
    )} mitmDetection=${percent(
      report.security.mitm.detectionRate
    )}`,
    `[netsim] connectivityDropRate=${percent(report.network.failures.connectivityDropRate)} keyCompromiseRate=${percent(
      report.security.keyExchange.compromiseRate
    )} recommendations=${report.recommendations.length}`,
    `[netsim] runtimeMs=${elapsedMs}`,
  ];

  if (artifacts) {
    summary.push(`[netsim] reportJson=${artifacts.jsonPath}`);
    summary.push(`[netsim] reportMarkdown=${artifacts.markdownPath}`);
  }

  process.stdout.write(`${summary.join("\n")}\n`);
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function format(value) {
  return Number((value || 0).toFixed(2));
}

function printHelp() {
  process.stdout.write(`PrivacyShield NetSim\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  node netsim/run.js [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --scenario <name>                     Scenario label (default: advanced-500x30m)\n`);
  process.stdout.write(`  --nodes <n>                           Number of simulated nodes (default: 500)\n`);
  process.stdout.write(`  --duration-minutes <n>                Virtual simulation duration in minutes (default: 30)\n`);
  process.stdout.write(`  --duration-ms <n>                     Virtual simulation duration in milliseconds\n`);
  process.stdout.write(`  --tick-ms <n>                         Tick interval in ms (default: 500)\n`);
  process.stdout.write(`  --seed <value>                        Deterministic random seed\n`);
  process.stdout.write(`  --data-sessions-per-second <n>        Data traffic rate\n`);
  process.stdout.write(`  --noise-sessions-per-second <n>       Cover/noise traffic rate\n`);
  process.stdout.write(`  --mitm-hop-probability <0-1>          MITM probability per hop\n`);
  process.stdout.write(`  --mitm-tamper-probability <0-1>       MITM tamper action probability\n`);
  process.stdout.write(`  --mitm-drop-probability <0-1>         MITM drop action probability\n`);
  process.stdout.write(`  --mitm-delay-probability <0-1>        MITM delay action probability\n`);
  process.stdout.write(`  --campaign-spawn-probability <0-1>    MITM campaign spawn probability per tick\n`);
  process.stdout.write(`  --ipv6-preference <0-1>               Probability of selecting IPv6 on dual-stack links\n`);
  process.stdout.write(`  --translation-relay-probability <0-1> Relay probability for IPv4/IPv6 stack mismatch hops\n`);
  process.stdout.write(`  --nat-base-success <0-1>              Base NAT traversal success probability\n`);
  process.stdout.write(`  --firewall-drop-probability <0-1>     Base router/firewall drop probability\n`);
  process.stdout.write(`  --ipv4-only-share <0-1>               Override node share for IPv4-only stack profile\n`);
  process.stdout.write(`  --dual-stack-share <0-1>              Override node share for dual-stack profile\n`);
  process.stdout.write(`  --ipv6-only-share <0-1>               Override node share for IPv6-only profile\n`);
  process.stdout.write(`  --key-exchange <true|false>           Enable split-share key exchange simulation\n`);
  process.stdout.write(`  --key-sessions-per-minute <n>         Key exchange sessions per minute\n`);
  process.stdout.write(`  --key-share-min <n>                   Min key shares\n`);
  process.stdout.write(`  --key-share-max <n>                   Max key shares\n`);
  process.stdout.write(`  --route-ttl-ms <n>                    Route cache TTL\n`);
  process.stdout.write(`  --route-mutation-probability <0-1>    Probability of route mutation\n`);
  process.stdout.write(`  --just-in-time-probability <0-1>      Probability of fresh JIT route selection\n`);
  process.stdout.write(`  --output-dir <path>                   Output directory (default: ./netsim/output)\n`);
  process.stdout.write(`  --no-write                            Do not write artifacts\n`);
  process.stdout.write(`  --help                                Show this help\n`);
}

main();
