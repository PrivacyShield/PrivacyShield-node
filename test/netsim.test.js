"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DEFAULT_DURATION_MS, buildSimulationConfig } = require("../netsim/config");
const { runNetworkSimulation } = require("../netsim/simulator");
const { renderMarkdownReport, writeSimulationArtifacts } = require("../netsim/report");

test("netsim defaults model 500 nodes over 30 minutes", () => {
  const config = buildSimulationConfig();

  assert.equal(config.nodeCount, 500);
  assert.equal(config.durationMs, DEFAULT_DURATION_MS);
  assert.equal(config.tickMs, 500);
  assert.ok(Array.isArray(config.providers));
  assert.ok(config.providers.length >= 4);
  assert.ok(Array.isArray(config.network.ipStacks));
  assert.ok(config.network.ipStacks.length >= 3);
  assert.ok(Array.isArray(config.network.routers));
  assert.ok(config.network.routers.length >= 3);
  assert.ok(config.network.translationRelayProbability > 0);
  assert.ok(config.reputation.ttlMs > 0);
  assert.ok(config.mitm.baseHopProbability > 0);
});

test("netsim simulation returns report and artifacts", () => {
  const report = runNetworkSimulation(
    {
      seed: 77,
      nodeCount: 32,
      durationMs: 20_000,
      tickMs: 250,
      traffic: {
        dataSessionsPerSecond: 12,
        noiseSessionsPerSecond: 5,
      },
      keyExchange: {
        sessionsPerMinute: 12,
      },
    },
    { scenario: "ci-smoke" }
  );

  assert.equal(report.meta.nodeCount, 32);
  assert.equal(report.scenario, "ci-smoke");
  assert.ok(report.traffic.totalPackets > 0);
  assert.ok(report.traffic.deliveredPackets >= 0);
  assert.ok(report.traffic.successRate >= 0 && report.traffic.successRate <= 1);
  assert.ok(report.performance.p95LatencyMs >= 0);
  assert.ok(report.security.mitm.attempts >= 0);
  assert.ok(report.reputation.ttlExpirations >= 0);
  assert.ok(report.network.ipv6CapableNodes >= 0);
  assert.ok(report.network.hops.ipv4 + report.network.hops.ipv6 >= 0);
  assert.ok(report.network.natTraversal.checks >= 0);
  assert.ok(report.network.failures.connectivityDrops >= 0);
  assert.ok(Array.isArray(report.recommendations));
  assert.ok(Array.isArray(report.timeline));

  const markdown = renderMarkdownReport(report);
  assert.match(markdown, /Recommendations/);
  assert.match(markdown, /Provider Breakdown/);
  assert.match(markdown, /Network Stack & NAT/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "privacyshield-netsim-"));
  const artifacts = writeSimulationArtifacts(report, {
    outputDir: tempDir,
    scenario: "ci",
  });

  assert.ok(fs.existsSync(artifacts.jsonPath));
  assert.ok(fs.existsSync(artifacts.markdownPath));
  assert.ok(fs.existsSync(artifacts.runDirectory));
});

test("netsim under high MITM pressure reports attacks and detections", () => {
  const report = runNetworkSimulation({
    seed: 99,
    nodeCount: 28,
    durationMs: 15_000,
    tickMs: 250,
    traffic: {
      dataSessionsPerSecond: 14,
      noiseSessionsPerSecond: 4,
    },
    mitm: {
      baseHopProbability: 0.42,
      tamperProbability: 0.45,
      dropProbability: 0.25,
      delayProbability: 0.2,
    },
    campaigns: {
      spawnProbabilityPerTick: 0.3,
      maxActive: 4,
    },
    keyExchange: {
      sessionsPerMinute: 10,
      shareCountMin: 3,
      shareCountMax: 4,
    },
  });

  assert.ok(report.security.mitm.attempts > 0);
  assert.ok(report.security.mitm.detected > 0);
  assert.ok(
    report.security.mitm.tampered +
      report.security.mitm.dropped +
      report.security.mitm.delayed +
      report.security.mitm.observed >
      0
  );
  assert.ok(report.security.keyExchange.sessionsAttempted > 0);
});

test("netsim models mixed IPv4/IPv6 stacks with NAT and router effects", () => {
  const report = runNetworkSimulation({
    seed: 1234,
    nodeCount: 40,
    durationMs: 20_000,
    tickMs: 250,
    traffic: {
      dataSessionsPerSecond: 20,
      noiseSessionsPerSecond: 2,
    },
    network: {
      ipStacks: [
        { id: "ipv4-only", share: 0.48 },
        { id: "dual-stack", share: 0.04 },
        { id: "ipv6-only", share: 0.48 },
      ],
      translationRelayProbability: 0.05,
      natTraversalBaseSuccess: 0.78,
      firewallDropBaseProbability: 0.02,
    },
  });

  assert.ok(report.network.ipStackCounts["ipv4-only"] > 0);
  assert.ok(report.network.ipStackCounts["ipv6-only"] > 0);
  assert.ok(Object.keys(report.network.natTypeCounts).length > 0);
  assert.ok(Object.keys(report.network.routerProfileCounts).length > 0);
  assert.ok(
    report.network.failures.stackMismatchDrops +
      report.network.failures.natTraversalDrops +
      report.network.failures.firewallDrops >
      0
  );
});
