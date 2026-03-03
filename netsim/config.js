"use strict";

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

const DEFAULT_PROVIDERS = [
  {
    id: "provider-atlas",
    share: 0.19,
    baseLatencyMs: 10,
    jitterMs: 4,
    bandwidthMbpsMin: 90,
    bandwidthMbpsMax: 260,
    packetLossRate: 0.003,
    mitmRisk: 0.11,
  },
  {
    id: "provider-boreal",
    share: 0.21,
    baseLatencyMs: 13,
    jitterMs: 6,
    bandwidthMbpsMin: 70,
    bandwidthMbpsMax: 210,
    packetLossRate: 0.006,
    mitmRisk: 0.16,
  },
  {
    id: "provider-cascade",
    share: 0.15,
    baseLatencyMs: 18,
    jitterMs: 8,
    bandwidthMbpsMin: 40,
    bandwidthMbpsMax: 150,
    packetLossRate: 0.011,
    mitmRisk: 0.25,
  },
  {
    id: "provider-delta",
    share: 0.17,
    baseLatencyMs: 16,
    jitterMs: 7,
    bandwidthMbpsMin: 60,
    bandwidthMbpsMax: 180,
    packetLossRate: 0.008,
    mitmRisk: 0.19,
  },
  {
    id: "provider-equinox",
    share: 0.14,
    baseLatencyMs: 12,
    jitterMs: 5,
    bandwidthMbpsMin: 80,
    bandwidthMbpsMax: 220,
    packetLossRate: 0.005,
    mitmRisk: 0.13,
  },
  {
    id: "provider-fjord",
    share: 0.14,
    baseLatencyMs: 21,
    jitterMs: 10,
    bandwidthMbpsMin: 30,
    bandwidthMbpsMax: 120,
    packetLossRate: 0.014,
    mitmRisk: 0.3,
  },
];

const DEFAULT_IP_STACKS = [
  { id: "ipv4-only", share: 0.26 },
  { id: "dual-stack", share: 0.62 },
  { id: "ipv6-only", share: 0.12 },
];

const DEFAULT_ROUTER_PROFILES = [
  {
    id: "open-edge",
    share: 0.12,
    natType: "open_internet",
    latencyOverheadMs: 0.6,
    bandwidthMultiplierMin: 1,
    bandwidthMultiplierMax: 1.2,
    reliabilityBoost: 0.018,
    inspectionRisk: 0.0004,
    natTraversalBias: 0.03,
  },
  {
    id: "home-router",
    share: 0.36,
    natType: "port_restricted_cone",
    latencyOverheadMs: 1.8,
    bandwidthMultiplierMin: 0.86,
    bandwidthMultiplierMax: 1.06,
    reliabilityBoost: 0,
    inspectionRisk: 0.0012,
    natTraversalBias: -0.01,
  },
  {
    id: "enterprise-firewall",
    share: 0.18,
    natType: "restricted_cone",
    latencyOverheadMs: 2.9,
    bandwidthMultiplierMin: 0.75,
    bandwidthMultiplierMax: 1,
    reliabilityBoost: 0.004,
    inspectionRisk: 0.004,
    natTraversalBias: -0.03,
  },
  {
    id: "mobile-cgnat",
    share: 0.22,
    natType: "carrier_grade_nat",
    latencyOverheadMs: 4.6,
    bandwidthMultiplierMin: 0.6,
    bandwidthMultiplierMax: 0.92,
    reliabilityBoost: -0.026,
    inspectionRisk: 0.0028,
    natTraversalBias: -0.05,
  },
  {
    id: "symmetric-gateway",
    share: 0.12,
    natType: "symmetric_nat",
    latencyOverheadMs: 3.8,
    bandwidthMultiplierMin: 0.68,
    bandwidthMultiplierMax: 0.95,
    reliabilityBoost: -0.018,
    inspectionRisk: 0.002,
    natTraversalBias: -0.04,
  },
];

const DEFAULT_NAT_PENALTIES = {
  open_internet: 0.04,
  full_cone: 0.02,
  restricted_cone: -0.01,
  port_restricted_cone: -0.03,
  symmetric_nat: -0.07,
  carrier_grade_nat: -0.1,
};

const DEFAULT_CONFIG = {
  seed: 1337,
  nodeCount: 500,
  durationMs: DEFAULT_DURATION_MS,
  tickMs: 500,
  providers: DEFAULT_PROVIDERS,
  network: {
    ipStacks: DEFAULT_IP_STACKS,
    routers: DEFAULT_ROUTER_PROFILES,
    preferIpv6Probability: 0.72,
    translationRelayProbability: 0.76,
    translationRelayDelayMsMin: 8,
    translationRelayDelayMsMax: 36,
    natTraversalBaseSuccess: 0.93,
    natTraversalPenalty: DEFAULT_NAT_PENALTIES,
    ipv6DirectBonus: 0.04,
    ipv4FallbackPenalty: 0.03,
    firewallDropBaseProbability: 0.0002,
    compatibilityPenalty: 0.36,
    translationRelayPenalty: 0.22,
    dualStackBonus: 0.08,
    routerLatencyJitterMs: 1.8,
  },
  traffic: {
    dataSessionsPerSecond: 72,
    noiseSessionsPerSecond: 26,
    payloadBytesMin: 220,
    payloadBytesMax: 1450,
    noisePayloadBytesMin: 64,
    noisePayloadBytesMax: 340,
  },
  routing: {
    minHops: 2,
    maxHops: 6,
    candidateTrials: 14,
    routeTtlMs: 12_000,
    routeTtlJitterMs: 2_000,
    mutationProbability: 0.14,
    justInTimeProbability: 0.28,
    providerRepeatPenalty: 0.6,
    lowReputationPenalty: 0.45,
    latencyObfuscationMs: 2.5,
  },
  reputation: {
    initialMin: 0.45,
    initialMax: 0.95,
    ttlMs: 90_000,
    ttlJitterMs: 15_000,
    rewardForward: 0.004,
    rewardDelivery: 0.012,
    penaltyDrop: 0.06,
    penaltyTamper: 0.1,
    penaltyTtlExpiry: 0.035,
    floor: 0.05,
    ceiling: 1,
    routeFloor: 0.18,
  },
  mitm: {
    baseHopProbability: 0.012,
    tamperProbability: 0.34,
    dropProbability: 0.2,
    delayProbability: 0.22,
    detectionTamperProbability: 0.985,
    detectionDropProbability: 0.42,
    detectionObserveProbability: 0.07,
    delayMinMs: 25,
    delayMaxMs: 220,
  },
  campaigns: {
    spawnProbabilityPerTick: 0.018,
    maxActive: 6,
    minDurationMs: 8_000,
    maxDurationMs: 45_000,
    attackBoostMin: 0.03,
    attackBoostMax: 0.1,
  },
  keyExchange: {
    enabled: true,
    sessionsPerMinute: 90,
    shareCountMin: 3,
    shareCountMax: 5,
    sharePayloadBytes: 96,
    compromiseRequiresAllShares: true,
  },
  reporting: {
    timelineBucketMs: 60_000,
  },
};

function buildSimulationConfig(overrides = {}) {
  const raw = mergeObjects(DEFAULT_CONFIG, overrides || {});
  const providers = normalizeProviders(raw.providers);
  const durationMs = normalizeInt(raw.durationMs, DEFAULT_DURATION_MS, 1_000);
  const tickMs = clamp(
    normalizeInt(raw.tickMs, DEFAULT_CONFIG.tickMs, 50),
    50,
    durationMs
  );

  const network = normalizeNetwork(raw.network);
  const traffic = normalizeTraffic(raw.traffic);
  const routing = normalizeRouting(raw.routing);
  const reputation = normalizeReputation(raw.reputation);
  const mitm = normalizeMitm(raw.mitm);
  const campaigns = normalizeCampaigns(raw.campaigns);
  const keyExchange = normalizeKeyExchange(raw.keyExchange);
  const reporting = normalizeReporting(raw.reporting, tickMs);

  return {
    seed: raw.seed === undefined ? DEFAULT_CONFIG.seed : raw.seed,
    nodeCount: normalizeInt(raw.nodeCount, DEFAULT_CONFIG.nodeCount, 4),
    durationMs,
    tickMs,
    providers,
    network,
    traffic,
    routing,
    reputation,
    mitm,
    campaigns,
    keyExchange,
    reporting,
  };
}

function normalizeProviders(rawProviders) {
  const source = Array.isArray(rawProviders) && rawProviders.length
    ? rawProviders
    : DEFAULT_PROVIDERS;
  const providers = source
    .map((provider, index) => ({
      id: String(provider.id || `provider-${index + 1}`),
      share: normalizeFloat(provider.share, 1 / source.length, 0.001),
      baseLatencyMs: normalizeFloat(provider.baseLatencyMs, 15, 1),
      jitterMs: normalizeFloat(provider.jitterMs, 5, 0),
      bandwidthMbpsMin: normalizeFloat(provider.bandwidthMbpsMin, 40, 1),
      bandwidthMbpsMax: normalizeFloat(provider.bandwidthMbpsMax, 140, 2),
      packetLossRate: clamp(
        normalizeFloat(provider.packetLossRate, 0.01, 0),
        0,
        0.2
      ),
      mitmRisk: clamp(normalizeFloat(provider.mitmRisk, 0.1, 0), 0, 1),
    }))
    .map((provider) => {
      if (provider.bandwidthMbpsMax < provider.bandwidthMbpsMin) {
        provider.bandwidthMbpsMax = provider.bandwidthMbpsMin;
      }
      return provider;
    });

  return normalizeShares(providers);
}

function normalizeNetwork(rawNetwork = {}) {
  const ipStacks = normalizeIpStacks(rawNetwork.ipStacks);
  const routers = normalizeRouters(rawNetwork.routers);
  const natTraversalPenalty = normalizeNatPenalties(rawNetwork.natTraversalPenalty);
  const translationRelayDelayMsMin = normalizeFloat(
    rawNetwork.translationRelayDelayMsMin,
    DEFAULT_CONFIG.network.translationRelayDelayMsMin,
    0
  );
  const translationRelayDelayMsMax = Math.max(
    translationRelayDelayMsMin,
    normalizeFloat(
      rawNetwork.translationRelayDelayMsMax,
      DEFAULT_CONFIG.network.translationRelayDelayMsMax,
      translationRelayDelayMsMin
    )
  );

  return {
    ipStacks,
    routers,
    preferIpv6Probability: clamp(
      normalizeFloat(
        rawNetwork.preferIpv6Probability,
        DEFAULT_CONFIG.network.preferIpv6Probability,
        0
      ),
      0,
      1
    ),
    translationRelayProbability: clamp(
      normalizeFloat(
        rawNetwork.translationRelayProbability,
        DEFAULT_CONFIG.network.translationRelayProbability,
        0
      ),
      0,
      1
    ),
    translationRelayDelayMsMin,
    translationRelayDelayMsMax,
    natTraversalBaseSuccess: clamp(
      normalizeFloat(
        rawNetwork.natTraversalBaseSuccess,
        DEFAULT_CONFIG.network.natTraversalBaseSuccess,
        0
      ),
      0,
      1
    ),
    natTraversalPenalty,
    ipv6DirectBonus: clamp(
      normalizeFloat(rawNetwork.ipv6DirectBonus, DEFAULT_CONFIG.network.ipv6DirectBonus, 0),
      0,
      0.3
    ),
    ipv4FallbackPenalty: clamp(
      normalizeFloat(
        rawNetwork.ipv4FallbackPenalty,
        DEFAULT_CONFIG.network.ipv4FallbackPenalty,
        0
      ),
      0,
      0.3
    ),
    firewallDropBaseProbability: clamp(
      normalizeFloat(
        rawNetwork.firewallDropBaseProbability,
        DEFAULT_CONFIG.network.firewallDropBaseProbability,
        0
      ),
      0,
      0.4
    ),
    compatibilityPenalty: normalizeFloat(
      rawNetwork.compatibilityPenalty,
      DEFAULT_CONFIG.network.compatibilityPenalty,
      0
    ),
    translationRelayPenalty: normalizeFloat(
      rawNetwork.translationRelayPenalty,
      DEFAULT_CONFIG.network.translationRelayPenalty,
      0
    ),
    dualStackBonus: normalizeFloat(
      rawNetwork.dualStackBonus,
      DEFAULT_CONFIG.network.dualStackBonus,
      0
    ),
    routerLatencyJitterMs: normalizeFloat(
      rawNetwork.routerLatencyJitterMs,
      DEFAULT_CONFIG.network.routerLatencyJitterMs,
      0
    ),
  };
}

function normalizeIpStacks(rawStacks) {
  const source = Array.isArray(rawStacks) && rawStacks.length
    ? rawStacks
    : DEFAULT_IP_STACKS;
  const stacks = source.map((entry, index) => ({
    id: normalizeIpStackId(entry.id || `stack-${index + 1}`),
    share: normalizeFloat(entry.share, 1 / source.length, 0.001),
  }));
  return normalizeShares(stacks);
}

function normalizeRouters(rawRouters) {
  const source = Array.isArray(rawRouters) && rawRouters.length
    ? rawRouters
    : DEFAULT_ROUTER_PROFILES;
  const routers = source.map((entry, index) => {
    const bandwidthMultiplierMin = normalizeFloat(
      entry.bandwidthMultiplierMin,
      0.8,
      0.1
    );
    const bandwidthMultiplierMax = Math.max(
      bandwidthMultiplierMin,
      normalizeFloat(entry.bandwidthMultiplierMax, 1, bandwidthMultiplierMin)
    );

    return {
      id: String(entry.id || `router-${index + 1}`),
      share: normalizeFloat(entry.share, 1 / source.length, 0.001),
      natType: normalizeNatType(entry.natType),
      latencyOverheadMs: normalizeFloat(entry.latencyOverheadMs, 1.5, 0),
      bandwidthMultiplierMin,
      bandwidthMultiplierMax,
      reliabilityBoost: normalizeFloat(entry.reliabilityBoost, 0, -0.5),
      inspectionRisk: clamp(normalizeFloat(entry.inspectionRisk, 0.01, 0), 0, 0.5),
      natTraversalBias: normalizeFloat(entry.natTraversalBias, 0, -0.5),
    };
  });

  return normalizeShares(routers);
}

function normalizeNatPenalties(rawPenalties = {}) {
  const normalized = {};
  for (const [natType, fallbackPenalty] of Object.entries(DEFAULT_NAT_PENALTIES)) {
    normalized[natType] = normalizeFloat(
      rawPenalties[natType],
      fallbackPenalty,
      -0.9
    );
  }
  return normalized;
}

function normalizeIpStackId(value) {
  const normalized = String(value || "dual-stack").toLowerCase();
  if (normalized === "ipv4" || normalized === "ipv4-only") {
    return "ipv4-only";
  }
  if (normalized === "ipv6" || normalized === "ipv6-only") {
    return "ipv6-only";
  }
  return "dual-stack";
}

function normalizeNatType(value) {
  const normalized = String(value || "port_restricted_cone").toLowerCase();
  if (normalized === "open" || normalized === "open_internet") {
    return "open_internet";
  }
  if (normalized === "full" || normalized === "full_cone") {
    return "full_cone";
  }
  if (normalized === "restricted" || normalized === "restricted_cone") {
    return "restricted_cone";
  }
  if (
    normalized === "port_restricted" ||
    normalized === "port_restricted_cone"
  ) {
    return "port_restricted_cone";
  }
  if (normalized === "symmetric" || normalized === "symmetric_nat") {
    return "symmetric_nat";
  }
  if (
    normalized === "cgnat" ||
    normalized === "carrier_grade_nat" ||
    normalized === "carrier-grade-nat"
  ) {
    return "carrier_grade_nat";
  }
  return "port_restricted_cone";
}

function normalizeTraffic(rawTraffic = {}) {
  const payloadBytesMin = normalizeInt(
    rawTraffic.payloadBytesMin,
    DEFAULT_CONFIG.traffic.payloadBytesMin,
    24
  );
  const payloadBytesMax = Math.max(
    payloadBytesMin,
    normalizeInt(rawTraffic.payloadBytesMax, DEFAULT_CONFIG.traffic.payloadBytesMax, 32)
  );
  const noisePayloadBytesMin = normalizeInt(
    rawTraffic.noisePayloadBytesMin,
    DEFAULT_CONFIG.traffic.noisePayloadBytesMin,
    16
  );
  const noisePayloadBytesMax = Math.max(
    noisePayloadBytesMin,
    normalizeInt(
      rawTraffic.noisePayloadBytesMax,
      DEFAULT_CONFIG.traffic.noisePayloadBytesMax,
      16
    )
  );

  return {
    dataSessionsPerSecond: normalizeFloat(
      rawTraffic.dataSessionsPerSecond,
      DEFAULT_CONFIG.traffic.dataSessionsPerSecond,
      0.1
    ),
    noiseSessionsPerSecond: normalizeFloat(
      rawTraffic.noiseSessionsPerSecond,
      DEFAULT_CONFIG.traffic.noiseSessionsPerSecond,
      0
    ),
    payloadBytesMin,
    payloadBytesMax,
    noisePayloadBytesMin,
    noisePayloadBytesMax,
  };
}

function normalizeRouting(rawRouting = {}) {
  const minHops = normalizeInt(rawRouting.minHops, DEFAULT_CONFIG.routing.minHops, 2);
  const maxHops = Math.max(
    minHops,
    normalizeInt(rawRouting.maxHops, DEFAULT_CONFIG.routing.maxHops, minHops)
  );

  return {
    minHops,
    maxHops,
    candidateTrials: normalizeInt(
      rawRouting.candidateTrials,
      DEFAULT_CONFIG.routing.candidateTrials,
      4
    ),
    routeTtlMs: normalizeInt(rawRouting.routeTtlMs, DEFAULT_CONFIG.routing.routeTtlMs, 500),
    routeTtlJitterMs: normalizeInt(
      rawRouting.routeTtlJitterMs,
      DEFAULT_CONFIG.routing.routeTtlJitterMs,
      0
    ),
    mutationProbability: clamp(
      normalizeFloat(rawRouting.mutationProbability, DEFAULT_CONFIG.routing.mutationProbability, 0),
      0,
      1
    ),
    justInTimeProbability: clamp(
      normalizeFloat(rawRouting.justInTimeProbability, DEFAULT_CONFIG.routing.justInTimeProbability, 0),
      0,
      1
    ),
    providerRepeatPenalty: normalizeFloat(
      rawRouting.providerRepeatPenalty,
      DEFAULT_CONFIG.routing.providerRepeatPenalty,
      0
    ),
    lowReputationPenalty: normalizeFloat(
      rawRouting.lowReputationPenalty,
      DEFAULT_CONFIG.routing.lowReputationPenalty,
      0
    ),
    latencyObfuscationMs: normalizeFloat(
      rawRouting.latencyObfuscationMs,
      DEFAULT_CONFIG.routing.latencyObfuscationMs,
      0
    ),
  };
}

function normalizeReputation(rawReputation = {}) {
  const initialMin = clamp(
    normalizeFloat(rawReputation.initialMin, DEFAULT_CONFIG.reputation.initialMin, 0),
    0,
    1
  );
  const initialMax = clamp(
    normalizeFloat(rawReputation.initialMax, DEFAULT_CONFIG.reputation.initialMax, initialMin),
    initialMin,
    1
  );

  return {
    initialMin,
    initialMax,
    ttlMs: normalizeInt(rawReputation.ttlMs, DEFAULT_CONFIG.reputation.ttlMs, 1_000),
    ttlJitterMs: normalizeInt(
      rawReputation.ttlJitterMs,
      DEFAULT_CONFIG.reputation.ttlJitterMs,
      0
    ),
    rewardForward: normalizeFloat(
      rawReputation.rewardForward,
      DEFAULT_CONFIG.reputation.rewardForward,
      0
    ),
    rewardDelivery: normalizeFloat(
      rawReputation.rewardDelivery,
      DEFAULT_CONFIG.reputation.rewardDelivery,
      0
    ),
    penaltyDrop: normalizeFloat(
      rawReputation.penaltyDrop,
      DEFAULT_CONFIG.reputation.penaltyDrop,
      0
    ),
    penaltyTamper: normalizeFloat(
      rawReputation.penaltyTamper,
      DEFAULT_CONFIG.reputation.penaltyTamper,
      0
    ),
    penaltyTtlExpiry: normalizeFloat(
      rawReputation.penaltyTtlExpiry,
      DEFAULT_CONFIG.reputation.penaltyTtlExpiry,
      0
    ),
    floor: clamp(normalizeFloat(rawReputation.floor, DEFAULT_CONFIG.reputation.floor, 0), 0, 1),
    ceiling: clamp(
      normalizeFloat(rawReputation.ceiling, DEFAULT_CONFIG.reputation.ceiling, 0.1),
      0,
      1
    ),
    routeFloor: clamp(
      normalizeFloat(rawReputation.routeFloor, DEFAULT_CONFIG.reputation.routeFloor, 0),
      0,
      1
    ),
  };
}

function normalizeMitm(rawMitm = {}) {
  const delayMinMs = normalizeFloat(rawMitm.delayMinMs, DEFAULT_CONFIG.mitm.delayMinMs, 0);
  const delayMaxMs = Math.max(
    delayMinMs,
    normalizeFloat(rawMitm.delayMaxMs, DEFAULT_CONFIG.mitm.delayMaxMs, delayMinMs)
  );

  return {
    baseHopProbability: clamp(
      normalizeFloat(rawMitm.baseHopProbability, DEFAULT_CONFIG.mitm.baseHopProbability, 0),
      0,
      1
    ),
    tamperProbability: clamp(
      normalizeFloat(rawMitm.tamperProbability, DEFAULT_CONFIG.mitm.tamperProbability, 0),
      0,
      1
    ),
    dropProbability: clamp(
      normalizeFloat(rawMitm.dropProbability, DEFAULT_CONFIG.mitm.dropProbability, 0),
      0,
      1
    ),
    delayProbability: clamp(
      normalizeFloat(rawMitm.delayProbability, DEFAULT_CONFIG.mitm.delayProbability, 0),
      0,
      1
    ),
    detectionTamperProbability: clamp(
      normalizeFloat(
        rawMitm.detectionTamperProbability,
        DEFAULT_CONFIG.mitm.detectionTamperProbability,
        0
      ),
      0,
      1
    ),
    detectionDropProbability: clamp(
      normalizeFloat(
        rawMitm.detectionDropProbability,
        DEFAULT_CONFIG.mitm.detectionDropProbability,
        0
      ),
      0,
      1
    ),
    detectionObserveProbability: clamp(
      normalizeFloat(
        rawMitm.detectionObserveProbability,
        DEFAULT_CONFIG.mitm.detectionObserveProbability,
        0
      ),
      0,
      1
    ),
    delayMinMs,
    delayMaxMs,
  };
}

function normalizeCampaigns(rawCampaigns = {}) {
  const minDurationMs = normalizeInt(
    rawCampaigns.minDurationMs,
    DEFAULT_CONFIG.campaigns.minDurationMs,
    1_000
  );
  const maxDurationMs = Math.max(
    minDurationMs,
    normalizeInt(rawCampaigns.maxDurationMs, DEFAULT_CONFIG.campaigns.maxDurationMs, minDurationMs)
  );

  return {
    spawnProbabilityPerTick: clamp(
      normalizeFloat(
        rawCampaigns.spawnProbabilityPerTick,
        DEFAULT_CONFIG.campaigns.spawnProbabilityPerTick,
        0
      ),
      0,
      1
    ),
    maxActive: normalizeInt(rawCampaigns.maxActive, DEFAULT_CONFIG.campaigns.maxActive, 0),
    minDurationMs,
    maxDurationMs,
    attackBoostMin: clamp(
      normalizeFloat(rawCampaigns.attackBoostMin, DEFAULT_CONFIG.campaigns.attackBoostMin, 0),
      0,
      1
    ),
    attackBoostMax: clamp(
      normalizeFloat(rawCampaigns.attackBoostMax, DEFAULT_CONFIG.campaigns.attackBoostMax, 0),
      0,
      1
    ),
  };
}

function normalizeKeyExchange(rawKeyExchange = {}) {
  const shareCountMin = normalizeInt(
    rawKeyExchange.shareCountMin,
    DEFAULT_CONFIG.keyExchange.shareCountMin,
    2
  );
  const shareCountMax = Math.max(
    shareCountMin,
    normalizeInt(rawKeyExchange.shareCountMax, DEFAULT_CONFIG.keyExchange.shareCountMax, shareCountMin)
  );

  return {
    enabled:
      rawKeyExchange.enabled === undefined
        ? DEFAULT_CONFIG.keyExchange.enabled
        : Boolean(rawKeyExchange.enabled),
    sessionsPerMinute: normalizeFloat(
      rawKeyExchange.sessionsPerMinute,
      DEFAULT_CONFIG.keyExchange.sessionsPerMinute,
      0
    ),
    shareCountMin,
    shareCountMax,
    sharePayloadBytes: normalizeInt(
      rawKeyExchange.sharePayloadBytes,
      DEFAULT_CONFIG.keyExchange.sharePayloadBytes,
      32
    ),
    compromiseRequiresAllShares:
      rawKeyExchange.compromiseRequiresAllShares === undefined
        ? DEFAULT_CONFIG.keyExchange.compromiseRequiresAllShares
        : Boolean(rawKeyExchange.compromiseRequiresAllShares),
  };
}

function normalizeReporting(rawReporting = {}, tickMs) {
  return {
    timelineBucketMs: Math.max(
      tickMs,
      normalizeInt(
        rawReporting.timelineBucketMs,
        DEFAULT_CONFIG.reporting.timelineBucketMs,
        tickMs
      )
    ),
  };
}

function normalizeShares(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.share, 0);
  if (total <= 0) {
    const equalShare = 1 / Math.max(1, entries.length);
    for (const entry of entries) {
      entry.share = equalShare;
    }
    return entries;
  }
  for (const entry of entries) {
    entry.share = entry.share / total;
  }
  return entries;
}

function mergeObjects(base, override) {
  const result = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    const baseValue = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = mergeObjects(baseValue, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function normalizeInt(value, fallback, minValue) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (minValue === undefined) {
    return parsed;
  }
  return Math.max(minValue, parsed);
}

function normalizeFloat(value, fallback, minValue) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (minValue === undefined) {
    return parsed;
  }
  return Math.max(minValue, parsed);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_DURATION_MS,
  buildSimulationConfig,
};
