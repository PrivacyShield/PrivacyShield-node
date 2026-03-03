"use strict";

const fs = require("fs");
const path = require("path");

function writeSimulationArtifacts(report, options = {}) {
  const outputRoot = path.resolve(
    options.outputDir || path.join(process.cwd(), "netsim", "output")
  );
  const scenarioName = slugify(options.scenario || report.scenario || "netsim");
  const stamp = formatTimestamp(report.generatedAt || new Date().toISOString());
  const runDirectory = path.join(outputRoot, `${scenarioName}-${stamp}`);

  fs.mkdirSync(runDirectory, { recursive: true });

  const jsonPath = path.join(runDirectory, "report.json");
  const markdownPath = path.join(runDirectory, "report.md");

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, `${renderMarkdownReport(report)}\n`, "utf8");

  return {
    runDirectory,
    jsonPath,
    markdownPath,
  };
}

function renderMarkdownReport(report) {
  const recommendations = (report.recommendations || [])
    .map(
      (item, index) =>
        `${index + 1}. **${item.severity.toUpperCase()} | ${item.area}** - ${item.title}. ${item.detail}`
    )
    .join("\n");

  const conclusions = (report.conclusions || []).map((line) => `- ${line}`).join("\n");

  const providerRows = (report.topology.providers || [])
    .map((provider) => {
      return `| ${provider.providerId} | ${provider.nodeCount} | ${formatPercent(
        safeDivide(provider.nodeCount, report.meta.nodeCount)
      )} | ${formatNumber(provider.averageLatencyMs)} | ${formatNumber(
        provider.averageReputation
      )} | ${formatNumber(provider.averageBandwidthMbps)} | ${provider.mitmExposure} |`;
    })
    .join("\n");

  const timelineRows = (report.timeline || [])
    .slice(-8)
    .map((point) => {
      return `| ${point.minute} | ${point.attemptedPackets} | ${formatPercent(
        point.successRate
      )} | ${formatNumber(point.avgLatencyMs)} | ${point.hopsIpv6} | ${point.hopsTranslationRelay} | ${point.connectivityDrops} | ${point.mitmAttempts} | ${point.mitmDetected} |`;
    })
    .join("\n");

  const ipStackRows = Object.entries(report.network.ipStackCounts || {})
    .map(([id, count]) => {
      return `| ${id} | ${count} | ${formatPercent(safeDivide(count, report.meta.nodeCount))} |`;
    })
    .join("\n");

  const natRows = Object.entries(report.network.natTypeCounts || {})
    .map(([id, count]) => {
      return `| ${id} | ${count} | ${formatPercent(safeDivide(count, report.meta.nodeCount))} |`;
    })
    .join("\n");

  const routerRows = Object.entries(report.network.routerProfileCounts || {})
    .map(([id, count]) => {
      return `| ${id} | ${count} | ${formatPercent(safeDivide(count, report.meta.nodeCount))} |`;
    })
    .join("\n");

  return [
    `# PrivacyShield NetSim Report`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Scenario: ${report.scenario}`,
    `- Nodes: ${report.meta.nodeCount}`,
    `- Virtual duration: ${report.meta.durationMinutes} minutes (${report.meta.durationMs} ms)`,
    `- Tick: ${report.meta.tickMs} ms`,
    `- Seed: ${report.meta.seed}`,
    "",
    "## Key Results",
    "",
    `- Packet success rate: **${formatPercent(report.traffic.successRate)}** (${report.traffic.deliveredPackets}/${report.traffic.totalPackets})`,
    `- Throughput: **${formatNumber(report.traffic.throughputMbps)} Mbps** delivered`,
    `- Latency p50/p95/p99: **${formatNumber(report.performance.p50LatencyMs)} / ${formatNumber(
      report.performance.p95LatencyMs
    )} / ${formatNumber(report.performance.p99LatencyMs)} ms**`,
    `- Average hops: **${formatNumber(report.performance.avgHops)}**`,
    `- Average provider span per route: **${formatNumber(report.performance.avgProviderSpan)}**`,
    `- IPv6 hop share: **${formatPercent(report.network.hops.ipv6ShareOfHops)}** (translation relay share: ${formatPercent(
      report.network.hops.translationRelayShareOfHops
    )})`,
    `- MITM attempts: **${report.security.mitm.attempts}** (detected: ${report.security.mitm.detected}, rate: ${formatPercent(
      report.security.mitm.detectionRate
    )})`,
    `- Key-exchange compromise rate: **${formatPercent(report.security.keyExchange.compromiseRate)}**`,
    "",
    "## Delivery & Routing",
    "",
    `- Data packets: ${report.traffic.dataPackets}`,
    `- Noise packets: ${report.traffic.noisePackets}`,
    `- Key-share packets: ${report.traffic.keySharePackets}`,
    `- Route cache hit rate: ${formatPercent(report.routing.cacheHitRate)}`,
    `- Route mutations: ${report.routing.routeMutations}`,
    `- Just-in-time routes: ${report.routing.justInTimeRoutes}`,
    `- Unique routes observed: ${report.routing.uniqueRoutesObserved}`,
    `- Connectivity drops (stack/NAT/firewall): ${report.network.failures.connectivityDrops} (${formatPercent(
      report.network.failures.connectivityDropRate
    )})`,
    "",
    "## Security & Reputation",
    "",
    `- MITM split: tampered=${report.security.mitm.tampered}, dropped=${report.security.mitm.dropped}, delayed=${report.security.mitm.delayed}, observed=${report.security.mitm.observed}`,
    `- MITM campaigns spawned: ${report.security.mitm.campaignsSpawned}`,
    `- Key sessions attempted/succeeded/failed: ${report.security.keyExchange.sessionsAttempted}/${report.security.keyExchange.sessionsSucceeded}/${report.security.keyExchange.sessionsFailed}`,
    `- Reputation average/min/max: ${formatNumber(report.reputation.averageScore)} / ${formatNumber(
      report.reputation.minScore
    )} / ${formatNumber(report.reputation.maxScore)}`,
    `- Reputation TTL expirations: ${report.reputation.ttlExpirations}`,
    `- Low reputation nodes (< routeFloor): ${report.reputation.lowReputationNodes} (${formatPercent(
      report.reputation.lowReputationRate
    )})`,
    "",
    "## Network Stack & NAT",
    "",
    `- IPv6-capable nodes: ${report.network.ipv6CapableNodes} (${formatPercent(
      report.network.ipv6CapableRate
    )})`,
    `- IPv4-capable nodes: ${report.network.ipv4CapableNodes} (${formatPercent(
      report.network.ipv4CapableRate
    )})`,
    `- NAT traversal checks/success: ${report.network.natTraversal.checks}/${report.network.natTraversal.succeeded} (${formatPercent(
      report.network.natTraversal.successRate
    )})`,
    `- Failure split: stackMismatch=${report.network.failures.stackMismatchDrops}, natTraversal=${report.network.failures.natTraversalDrops}, firewall=${report.network.failures.firewallDrops}`,
    "",
    "| IP Stack | Nodes | Share |",
    "| --- | ---: | ---: |",
    ipStackRows || "| n/a | 0 | 0% |",
    "",
    "| NAT Type | Nodes | Share |",
    "| --- | ---: | ---: |",
    natRows || "| n/a | 0 | 0% |",
    "",
    "| Router Profile | Nodes | Share |",
    "| --- | ---: | ---: |",
    routerRows || "| n/a | 0 | 0% |",
    "",
    "## Provider Breakdown",
    "",
    "| Provider | Nodes | Node Share | Avg Hop Latency (ms) | Avg Reputation | Avg Bandwidth (Mbps) | MITM Exposure |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    providerRows || "| n/a | 0 | 0% | 0 | 0 | 0 | 0 |",
    "",
    "## Timeline (Last 8 Buckets)",
    "",
    "| Minute | Attempted | Success Rate | Avg Latency (ms) | IPv6 Hops | Relay Hops | Conn Drops | MITM Attempts | MITM Detected |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    timelineRows || "| 0 | 0 | 0% | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "## Conclusions",
    "",
    conclusions || "- No conclusions available.",
    "",
    "## Recommendations",
    "",
    recommendations || "1. No recommendations generated.",
    "",
    "## Notes For Next Implementations",
    "",
    "- Focus first on high-severity recommendations before tuning low-impact latency knobs.",
    "- Re-run this scenario after each routing/security change and compare `report.json` key metrics (success rate, p95 latency, MITM detection rate, compromise rate).",
    "- Use provider-specific breakdown to tune diversity penalties and avoid concentration around a single network provider.",
  ].join("\n");
}

function slugify(value) {
  return String(value || "netsim")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatTimestamp(value) {
  const iso = new Date(value).toISOString();
  return iso.replace(/[:]/g, "-").replace(/\..+$/, "");
}

function safeDivide(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return numerator / denominator;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value) {
  return Number((value || 0).toFixed(2));
}

module.exports = {
  renderMarkdownReport,
  writeSimulationArtifacts,
};
