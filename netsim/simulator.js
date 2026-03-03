"use strict";

const { buildSimulationConfig } = require("./config");

function runNetworkSimulation(configOverrides = {}, options = {}) {
  const config = buildSimulationConfig(configOverrides);
  const rng = createSeededRng(config.seed);
  const state = createSimulationState(config, rng, options.scenario);
  const totalTicks = Math.ceil(config.durationMs / config.tickMs);

  for (let tick = 0; tick < totalTicks; tick += 1) {
    state.tick = tick;
    state.nowMs = tick * config.tickMs;

    resetTickCounters(state);
    updateMitmCampaigns(state);
    updateNodeBandwidth(state);
    applyReputationExpiry(state);

    const dataPackets = consumeTrafficQuota(
      state,
      "dataTraffic",
      config.traffic.dataSessionsPerSecond
    );
    for (let i = 0; i < dataPackets; i += 1) {
      simulatePacketTransfer(state, "data");
    }

    const noisePackets = consumeTrafficQuota(
      state,
      "noiseTraffic",
      config.traffic.noiseSessionsPerSecond
    );
    for (let i = 0; i < noisePackets; i += 1) {
      simulatePacketTransfer(state, "noise");
    }

    if (config.keyExchange.enabled) {
      const keySessions = consumeTrafficQuota(
        state,
        "keyExchange",
        config.keyExchange.sessionsPerMinute / 60
      );
      for (let i = 0; i < keySessions; i += 1) {
        simulateKeyExchange(state);
      }
    }

    maybeFlushTimelineBucket(state);
  }

  flushTimelineBucket(state);
  return buildFinalReport(state);
}

function createSimulationState(config, rng, scenarioName) {
  const providers = config.providers.map((provider) => ({ ...provider }));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const nodes = createNodes(config, providers, rng);

  const providerStats = new Map();
  for (const provider of providers) {
    providerStats.set(provider.id, {
      providerId: provider.id,
      nodes: 0,
      txBytes: 0,
      rxBytes: 0,
      attemptedPackets: 0,
      deliveredPackets: 0,
      failedPackets: 0,
      latencyMsTotal: 0,
      latencySamples: 0,
      mitmExposure: 0,
      reputationTotal: 0,
      reputationSamples: 0,
      bandwidthTotalMbps: 0,
      bandwidthSamples: 0,
    });
  }
  for (const node of nodes) {
    providerStats.get(node.providerId).nodes += 1;
  }

  return {
    config,
    rng,
    scenarioName: scenarioName || "advanced-network-adversarial",
    nowMs: 0,
    tick: 0,
    nodes,
    providers,
    providerById,
    providerLatencyMatrix: createProviderLatencyMatrix(providers, rng),
    routeCache: new Map(),
    routeFingerprints: new Set(),
    campaigns: [],
    campaignCounter: 0,
    trafficAccumulators: {
      dataTraffic: 0,
      noiseTraffic: 0,
      keyExchange: 0,
    },
    metrics: {
      packets: {
        attempted: 0,
        delivered: 0,
        failed: 0,
        data: 0,
        noise: 0,
        keyShare: 0,
        bytesAttempted: 0,
        bytesDelivered: 0,
      },
      performance: {
        latencySamples: [],
        hopSamples: [],
        providerSpanSamples: [],
      },
      routing: {
        cacheHits: 0,
        cacheMisses: 0,
        justInTimeRoutes: 0,
        mutations: 0,
        uniqueRoutes: 0,
      },
      mitm: {
        attempts: 0,
        tampered: 0,
        dropped: 0,
        delayed: 0,
        observed: 0,
        detected: 0,
        campaignsSpawned: 0,
      },
      keyExchange: {
        sessionsAttempted: 0,
        sessionsSucceeded: 0,
        sessionsFailed: 0,
        sessionsCompromised: 0,
        sharesAttempted: 0,
        sharesDelivered: 0,
        sharesIntercepted: 0,
      },
      reputation: {
        ttlExpirations: 0,
        rewardsApplied: 0,
        penaltiesApplied: 0,
      },
      network: {
        hopsIpv4: 0,
        hopsIpv6: 0,
        hopsTranslationRelay: 0,
        natTraversalChecks: 0,
        natTraversalSucceeded: 0,
        stackMismatchDrops: 0,
        natTraversalDrops: 0,
        firewallDrops: 0,
      },
      timeline: [],
      timelineBucket: createTimelineBucket(0),
    },
    providerStats,
  };
}

function createNodes(config, providers, rng) {
  const nodes = [];
  for (let index = 0; index < config.nodeCount; index += 1) {
    const provider = pickProvider(providers, rng);
    const ipStackProfile = pickWeighted(config.network.ipStacks, rng);
    const routerProfile = pickWeighted(config.network.routers, rng);
    const routerBandwidthMultiplier = rng.float(
      routerProfile.bandwidthMultiplierMin,
      routerProfile.bandwidthMultiplierMax
    );
    const bandwidthBaseMbps =
      rng.float(provider.bandwidthMbpsMin, provider.bandwidthMbpsMax) *
      routerBandwidthMultiplier;
    const natPenalty =
      config.network.natTraversalPenalty[routerProfile.natType] || 0;
    const natTraversalReliability = clamp(
      config.network.natTraversalBaseSuccess +
        natPenalty +
        routerProfile.natTraversalBias +
        rng.float(-0.03, 0.03),
      0.25,
      0.999
    );
    const reliability = clamp(
      1 - provider.packetLossRate - rng.float(0, 0.025) + routerProfile.reliabilityBoost,
      0.65,
      0.999
    );
    const initialReputation = rng.float(
      config.reputation.initialMin,
      config.reputation.initialMax
    );

    nodes.push({
      id: `node-${String(index + 1).padStart(4, "0")}`,
      providerId: provider.id,
      provider,
      ipStackId: ipStackProfile.id,
      routerProfileId: routerProfile.id,
      natType: routerProfile.natType,
      routerLatencyOverheadMs: routerProfile.latencyOverheadMs,
      natTraversalReliability,
      inspectionDropProbability: clamp(
        config.network.firewallDropBaseProbability +
          routerProfile.inspectionRisk +
          rng.float(0, 0.004),
        0,
        0.4
      ),
      bandwidthBaseMbps,
      bandwidthCurrentMbps: bandwidthBaseMbps,
      reliability,
      reputationScore: initialReputation,
      reputationExpiresAt:
        rng.int(0, config.reputation.ttlMs) +
        rng.int(0, config.reputation.ttlJitterMs),
      txBytes: 0,
      rxBytes: 0,
      forwardedPackets: 0,
      deliveredPackets: 0,
      failedPackets: 0,
      tickTxBytes: 0,
      tickRxBytes: 0,
    });
  }

  return nodes;
}

function createProviderLatencyMatrix(providers, rng) {
  const matrix = new Map();
  for (const left of providers) {
    const row = new Map();
    for (const right of providers) {
      const base = (left.baseLatencyMs + right.baseLatencyMs) / 2;
      const interProviderPenalty = left.id === right.id ? 0 : rng.float(4, 24);
      row.set(
        right.id,
        base + interProviderPenalty + rng.float(0, Math.max(left.jitterMs, right.jitterMs))
      );
    }
    matrix.set(left.id, row);
  }
  return matrix;
}

function consumeTrafficQuota(state, accumulatorKey, sessionsPerSecond) {
  const increment = sessionsPerSecond * (state.config.tickMs / 1000);
  state.trafficAccumulators[accumulatorKey] += increment;
  let count = Math.floor(state.trafficAccumulators[accumulatorKey]);
  state.trafficAccumulators[accumulatorKey] -= count;

  if (state.rng.chance(state.trafficAccumulators[accumulatorKey])) {
    count += 1;
    state.trafficAccumulators[accumulatorKey] = Math.max(
      0,
      state.trafficAccumulators[accumulatorKey] - 1
    );
  }

  return count;
}

function resetTickCounters(state) {
  for (const node of state.nodes) {
    node.tickTxBytes = 0;
    node.tickRxBytes = 0;
  }
}

function updateNodeBandwidth(state) {
  const { rng } = state;
  for (const node of state.nodes) {
    const drift = rng.float(-0.06, 0.06);
    const minBound = node.bandwidthBaseMbps * 0.45;
    const maxBound = node.bandwidthBaseMbps * 1.35;
    node.bandwidthCurrentMbps = clamp(
      node.bandwidthCurrentMbps * (1 + drift),
      minBound,
      maxBound
    );
  }
}

function applyReputationExpiry(state) {
  const { reputation } = state.config;
  for (const node of state.nodes) {
    if (state.nowMs < node.reputationExpiresAt) {
      continue;
    }
    node.reputationScore = clamp(
      node.reputationScore - reputation.penaltyTtlExpiry,
      reputation.floor,
      reputation.ceiling
    );
    node.reputationExpiresAt =
      state.nowMs +
      reputation.ttlMs +
      state.rng.int(0, reputation.ttlJitterMs);
    state.metrics.reputation.ttlExpirations += 1;
  }
}

function updateMitmCampaigns(state) {
  state.campaigns = state.campaigns.filter((campaign) => campaign.endsAt > state.nowMs);

  const {
    spawnProbabilityPerTick,
    maxActive,
    minDurationMs,
    maxDurationMs,
    attackBoostMin,
    attackBoostMax,
  } = state.config.campaigns;

  while (
    state.campaigns.length < maxActive &&
    state.rng.chance(spawnProbabilityPerTick)
  ) {
    const typeRoll = state.rng.next();
    let campaign;
    if (typeRoll < 0.34) {
      const provider = state.rng.pick(state.providers);
      campaign = {
        id: `campaign-${++state.campaignCounter}`,
        type: "provider",
        targetProviderId: provider.id,
      };
    } else if (typeRoll < 0.68) {
      const left = state.rng.pick(state.providers);
      const right = state.rng.pick(state.providers);
      campaign = {
        id: `campaign-${++state.campaignCounter}`,
        type: "provider-pair",
        pair: `${left.id}|${right.id}`,
      };
    } else {
      const node = state.rng.pick(state.nodes);
      campaign = {
        id: `campaign-${++state.campaignCounter}`,
        type: "node",
        targetNodeId: node.id,
      };
    }

    const duration = state.rng.int(minDurationMs, maxDurationMs);
    campaign.startsAt = state.nowMs;
    campaign.endsAt = state.nowMs + duration;
    campaign.attackBoost = state.rng.float(attackBoostMin, attackBoostMax);

    state.campaigns.push(campaign);
    state.metrics.mitm.campaignsSpawned += 1;

    if (state.campaigns.length >= maxActive) {
      break;
    }
  }
}

function simulatePacketTransfer(state, kind, options = {}) {
  const src = state.rng.pick(state.nodes);
  let dst = state.rng.pick(state.nodes);
  while (dst.id === src.id) {
    dst = state.rng.pick(state.nodes);
  }

  const payloadBytes =
    kind === "noise"
      ? state.rng.int(
          state.config.traffic.noisePayloadBytesMin,
          state.config.traffic.noisePayloadBytesMax
        )
      : options.payloadBytes ||
        state.rng.int(
          state.config.traffic.payloadBytesMin,
          state.config.traffic.payloadBytesMax
        );

  const route = resolveRoute(state, src, dst, {
    forceFresh: Boolean(options.forceFresh || kind === "noise"),
    routeClass: options.routeClass || kind,
  });

  const packetMetrics = state.metrics.packets;
  packetMetrics.attempted += 1;
  packetMetrics[kind === "noise" ? "noise" : kind === "key-share" ? "keyShare" : "data"] += 1;
  packetMetrics.bytesAttempted += payloadBytes;

  const bucket = state.metrics.timelineBucket;
  bucket.attemptedPackets += 1;

  if (!route || route.length < 2) {
    packetMetrics.failed += 1;
    bucket.failedPackets += 1;
    return {
      delivered: false,
      intercepted: false,
      attacked: false,
      dropped: true,
      tampered: false,
      reason: "route_unavailable",
    };
  }

  state.metrics.performance.hopSamples.push(route.length - 1);
  state.metrics.performance.providerSpanSamples.push(
    countUniqueProviders(route)
  );

  const transfer = transferThroughRoute(state, route, payloadBytes, kind, options);
  if (transfer.delivered) {
    packetMetrics.delivered += 1;
    packetMetrics.bytesDelivered += payloadBytes;
    state.metrics.performance.latencySamples.push(transfer.totalLatencyMs);
    bucket.deliveredPackets += 1;
    bucket.deliveredLatencyMs += transfer.totalLatencyMs;
    applyRouteReputationReward(state, route, true, transfer);
  } else {
    packetMetrics.failed += 1;
    bucket.failedPackets += 1;
    applyRouteReputationReward(state, route, false, transfer);
  }

  bucket.mitmAttempts += transfer.mitmAttempts;
  bucket.mitmDetected += transfer.mitmDetected;

  return transfer;
}

function transferThroughRoute(state, route, payloadBytes, kind, options = {}) {
  const transfer = {
    delivered: true,
    totalLatencyMs: 0,
    intercepted: false,
    attacked: false,
    dropped: false,
    tampered: false,
    reason: null,
    mitmAttempts: 0,
    mitmDetected: 0,
  };

  for (let i = 0; i < route.length - 1; i += 1) {
    const sender = route[i];
    const receiver = route[i + 1];
    const hop = simulateHop(state, sender, receiver, payloadBytes, kind, options);

    transfer.totalLatencyMs += hop.delayMs;
    transfer.mitmAttempts += hop.mitmAttempted ? 1 : 0;
    transfer.mitmDetected += hop.mitmDetected ? 1 : 0;

    if (hop.intercepted) {
      transfer.intercepted = true;
    }
    if (hop.mitmAttempted) {
      transfer.attacked = true;
    }

    if (!hop.delivered) {
      transfer.delivered = false;
      transfer.reason = hop.reason;
      if (
        hop.reason === "mitm_drop" ||
        hop.reason === "transport_drop" ||
        hop.reason === "stack_mismatch_drop" ||
        hop.reason === "nat_traversal_drop" ||
        hop.reason === "firewall_drop"
      ) {
        transfer.dropped = true;
      }
      if (hop.reason === "mitm_tamper") {
        transfer.tampered = true;
      }
      break;
    }
  }

  return transfer;
}

function simulateHop(state, sender, receiver, payloadBytes, kind) {
  const linkMode = resolveLinkMode(state, sender, receiver);
  const linkBaseLatency =
    state.providerLatencyMatrix.get(sender.providerId).get(receiver.providerId) || 0;
  const jitter = state.rng.float(
    0,
    Math.max(sender.provider.jitterMs, receiver.provider.jitterMs)
  );

  const linkMbps = Math.max(
    1,
    Math.min(sender.bandwidthCurrentMbps, receiver.bandwidthCurrentMbps)
  );
  const bytesPerMs = Math.max(1, linkMbps * 125);
  const serializationMs = payloadBytes / bytesPerMs;

  sender.tickTxBytes += payloadBytes;
  receiver.tickRxBytes += payloadBytes;
  sender.txBytes += payloadBytes;
  receiver.rxBytes += payloadBytes;

  const senderTickCapacityBytes =
    sender.bandwidthCurrentMbps * 125 * state.config.tickMs;
  const utilization = sender.tickTxBytes / Math.max(1, senderTickCapacityBytes);
  const queueDelayMs = utilization > 1
    ? (utilization - 1) * state.config.tickMs
    : utilization * 0.08 * state.config.tickMs;

  let delayMs =
    linkBaseLatency +
    jitter +
    serializationMs +
    sender.routerLatencyOverheadMs +
    receiver.routerLatencyOverheadMs +
    linkMode.delayPenaltyMs +
    state.rng.float(0, state.config.network.routerLatencyJitterMs) +
    queueDelayMs +
    state.rng.float(0, state.config.routing.latencyObfuscationMs);

  const congestionDropBonus = utilization > 1 ? Math.min(0.08, (utilization - 1) * 0.05) : 0;
  const dropProbability = clamp(
    (1 - sender.reliability) + (1 - receiver.reliability) + congestionDropBonus,
    0,
    0.45
  );

  const providerSenderStats = state.providerStats.get(sender.providerId);
  const providerReceiverStats = state.providerStats.get(receiver.providerId);

  if (providerSenderStats) {
    providerSenderStats.txBytes += payloadBytes;
    providerSenderStats.attemptedPackets += 1;
  }
  if (providerReceiverStats) {
    providerReceiverStats.rxBytes += payloadBytes;
    providerReceiverStats.attemptedPackets += 1;
  }

  if (!linkMode.reachable) {
    state.metrics.network.stackMismatchDrops += 1;
    state.metrics.timelineBucket.connectivityDrops += 1;
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "stack_mismatch_drop",
      delayMs,
      intercepted: false,
      mitmAttempted: false,
      mitmDetected: false,
    };
  }

  incrementHopModeMetrics(state, linkMode.mode);

  const firewallDropProbability =
    (sender.inspectionDropProbability + receiver.inspectionDropProbability) / 2;
  if (state.rng.chance(firewallDropProbability)) {
    state.metrics.network.firewallDrops += 1;
    state.metrics.timelineBucket.connectivityDrops += 1;
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "firewall_drop",
      delayMs,
      intercepted: false,
      mitmAttempted: false,
      mitmDetected: false,
    };
  }

  state.metrics.network.natTraversalChecks += 1;
  const natTraversalSuccessProbability = computeNatTraversalSuccessProbability(
    state,
    sender,
    receiver,
    linkMode
  );
  if (!state.rng.chance(natTraversalSuccessProbability)) {
    state.metrics.network.natTraversalDrops += 1;
    state.metrics.timelineBucket.connectivityDrops += 1;
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "nat_traversal_drop",
      delayMs,
      intercepted: false,
      mitmAttempted: false,
      mitmDetected: false,
    };
  }
  state.metrics.network.natTraversalSucceeded += 1;

  const attack = evaluateMitm(state, sender, receiver);

  if (attack.attempted) {
    state.metrics.mitm.attempts += 1;
    if (providerSenderStats) {
      providerSenderStats.mitmExposure += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.mitmExposure += 1;
    }
  }

  if (attack.action === "delay") {
    delayMs += attack.extraDelayMs;
    state.metrics.mitm.delayed += 1;
  }
  if (attack.action === "observe") {
    state.metrics.mitm.observed += 1;
  }
  if (attack.action === "drop") {
    state.metrics.mitm.dropped += 1;
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "mitm_drop",
      delayMs,
      intercepted: true,
      mitmAttempted: true,
      mitmDetected: attack.detected,
    };
  }
  if (attack.action === "tamper") {
    state.metrics.mitm.tampered += 1;
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "mitm_tamper",
      delayMs,
      intercepted: true,
      mitmAttempted: true,
      mitmDetected: attack.detected,
    };
  }

  if (state.rng.chance(dropProbability)) {
    if (providerSenderStats) {
      providerSenderStats.failedPackets += 1;
    }
    if (providerReceiverStats) {
      providerReceiverStats.failedPackets += 1;
    }
    return {
      delivered: false,
      reason: "transport_drop",
      delayMs,
      intercepted: attack.attempted,
      mitmAttempted: attack.attempted,
      mitmDetected: attack.detected,
    };
  }

  sender.forwardedPackets += 1;
  receiver.forwardedPackets += 1;

  if (providerSenderStats) {
    providerSenderStats.deliveredPackets += 1;
    providerSenderStats.latencyMsTotal += delayMs;
    providerSenderStats.latencySamples += 1;
  }
  if (providerReceiverStats) {
    providerReceiverStats.deliveredPackets += 1;
    providerReceiverStats.latencyMsTotal += delayMs;
    providerReceiverStats.latencySamples += 1;
  }

  return {
    delivered: true,
    reason: null,
    delayMs,
    intercepted: attack.attempted,
    mitmAttempted: attack.attempted,
    mitmDetected: attack.detected,
  };
}

function evaluateMitm(state, sender, receiver) {
  const config = state.config.mitm;
  const baseRisk = config.baseHopProbability;
  const providerRisk = (sender.provider.mitmRisk + receiver.provider.mitmRisk) / 2;
  let campaignBoost = 0;

  for (const campaign of state.campaigns) {
    if (campaign.type === "provider") {
      if (
        sender.providerId === campaign.targetProviderId ||
        receiver.providerId === campaign.targetProviderId
      ) {
        campaignBoost += campaign.attackBoost;
      }
      continue;
    }

    if (campaign.type === "provider-pair") {
      const pair = `${sender.providerId}|${receiver.providerId}`;
      const reversePair = `${receiver.providerId}|${sender.providerId}`;
      if (pair === campaign.pair || reversePair === campaign.pair) {
        campaignBoost += campaign.attackBoost;
      }
      continue;
    }

    if (campaign.type === "node") {
      if (sender.id === campaign.targetNodeId || receiver.id === campaign.targetNodeId) {
        campaignBoost += campaign.attackBoost;
      }
    }
  }

  const attackProbability = clamp(baseRisk * (1 + providerRisk) + campaignBoost, 0, 0.98);
  if (!state.rng.chance(attackProbability)) {
    return {
      attempted: false,
      action: "none",
      detected: false,
      extraDelayMs: 0,
    };
  }

  const action = weightedActionSelection(state.rng, {
    tamper: config.tamperProbability,
    drop: config.dropProbability,
    delay: config.delayProbability,
    observe: Math.max(
      0,
      1 - config.tamperProbability - config.dropProbability - config.delayProbability
    ),
  });

  let detected = false;
  if (action === "tamper") {
    detected = state.rng.chance(config.detectionTamperProbability);
  } else if (action === "drop") {
    detected = state.rng.chance(config.detectionDropProbability);
  } else if (action === "observe") {
    detected = state.rng.chance(config.detectionObserveProbability);
  }

  if (detected) {
    state.metrics.mitm.detected += 1;
  }

  return {
    attempted: true,
    action,
    detected,
    extraDelayMs:
      action === "delay"
        ? state.rng.float(config.delayMinMs, config.delayMaxMs)
        : 0,
  };
}

function weightedActionSelection(rng, weights) {
  const entries = Object.entries(weights).filter(([, value]) => value > 0);
  if (!entries.length) {
    return "observe";
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const target = rng.float(0, total);
  let cursor = 0;
  for (const [action, value] of entries) {
    cursor += value;
    if (target <= cursor) {
      return action;
    }
  }

  return entries[entries.length - 1][0];
}

function applyRouteReputationReward(state, route, delivered, transfer) {
  const { reputation } = state.config;

  if (delivered) {
    for (let i = 1; i < route.length - 1; i += 1) {
      updateNodeReputation(state, route[i], reputation.rewardForward);
    }
    updateNodeReputation(state, route[0], reputation.rewardDelivery);
    updateNodeReputation(state, route[route.length - 1], reputation.rewardDelivery);
    route[route.length - 1].deliveredPackets += 1;
    return;
  }

  const penalty = transfer.tampered
    ? reputation.penaltyTamper
    : reputation.penaltyDrop;

  for (const node of route) {
    node.failedPackets += 1;
  }

  const candidate = route[Math.max(0, route.length - 2)];
  updateNodeReputation(state, candidate, -penalty);

  if (transfer.tampered && route.length > 2) {
    updateNodeReputation(state, route[1], -(penalty * 0.8));
  }
}

function updateNodeReputation(state, node, delta) {
  const { reputation } = state.config;
  node.reputationScore = clamp(
    node.reputationScore + delta,
    reputation.floor,
    reputation.ceiling
  );
  node.reputationExpiresAt =
    state.nowMs + reputation.ttlMs + state.rng.int(0, reputation.ttlJitterMs);

  if (delta >= 0) {
    state.metrics.reputation.rewardsApplied += 1;
  } else {
    state.metrics.reputation.penaltiesApplied += 1;
  }
}

function resolveRoute(state, src, dst, options = {}) {
  const routing = state.config.routing;
  const routeClass = options.routeClass || "default";
  const key = `${routeClass}:${src.id}->${dst.id}`;
  const cached = state.routeCache.get(key);
  const forceFresh = Boolean(options.forceFresh);
  const useJustInTime = state.rng.chance(routing.justInTimeProbability);

  if (!forceFresh && cached && cached.expiresAt > state.nowMs && !useJustInTime) {
    state.metrics.routing.cacheHits += 1;
    let path = cached.path;
    if (state.rng.chance(routing.mutationProbability)) {
      const mutated = mutateRoute(state, path, src, dst);
      if (mutated.length >= 2) {
        path = mutated;
        cached.path = mutated;
        state.metrics.routing.mutations += 1;
      }
    }
    trackRouteFingerprint(state, path);
    return path;
  }

  if (useJustInTime) {
    state.metrics.routing.justInTimeRoutes += 1;
  }
  state.metrics.routing.cacheMisses += 1;

  const path = buildRoute(state, src, dst, options);
  const expiresAt =
    state.nowMs +
    routing.routeTtlMs +
    state.rng.int(0, Math.max(0, routing.routeTtlJitterMs));

  state.routeCache.set(key, { path, expiresAt });
  trackRouteFingerprint(state, path);

  return path;
}

function buildRoute(state, src, dst, options = {}) {
  const routing = state.config.routing;
  const desiredHopCount = state.rng.int(routing.minHops, routing.maxHops);
  const relayCount = Math.max(0, desiredHopCount - 2);

  const path = [src];
  const usedNodeIds = new Set([src.id, dst.id]);
  const usedProviders = new Set([src.providerId]);

  for (let relayIndex = 0; relayIndex < relayCount; relayIndex += 1) {
    const previousNode = path[path.length - 1];
    const candidate = pickRelayNode(
      state,
      usedNodeIds,
      usedProviders,
      {
        previousNode,
        dstNode: dst,
      },
      options
    );
    if (!candidate) {
      break;
    }
    path.push(candidate);
    usedNodeIds.add(candidate.id);
    usedProviders.add(candidate.providerId);
  }

  path.push(dst);
  return path;
}

function mutateRoute(state, path, src, dst) {
  if (!path || path.length <= 2) {
    return path;
  }

  const clone = path.slice();
  const relayIndex = state.rng.int(1, clone.length - 2);
  const previousNode = clone[relayIndex - 1];
  const nextNode = clone[relayIndex + 1];
  const usedNodeIds = new Set(clone.map((node) => node.id));
  const usedProviders = new Set(clone.map((node) => node.providerId));

  const replacement = pickRelayNode(
    state,
    usedNodeIds,
    usedProviders,
    {
      previousNode,
      nextNode,
      dstNode: dst,
    },
    { forceHigherObfuscation: true }
  );

  if (!replacement) {
    return clone;
  }

  clone[relayIndex] = replacement;
  clone[0] = src;
  clone[clone.length - 1] = dst;
  return clone;
}

function pickRelayNode(state, usedNodeIds, usedProviders, hints = {}, options = {}) {
  const { previousNode = null, nextNode = null, dstNode = null } = hints;
  const { routing, reputation } = state.config;
  const trials = routing.candidateTrials;
  let bestCandidate = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < trials; i += 1) {
    const candidate = state.rng.pick(state.nodes);
    if (usedNodeIds.has(candidate.id)) {
      continue;
    }

    let score = 0;
    score += (1 - candidate.reputationScore) * 1.7;
    score += 1 / Math.max(1, candidate.bandwidthCurrentMbps);

    if (candidate.reputationScore < reputation.routeFloor) {
      score += routing.lowReputationPenalty;
    }

    if (usedProviders.has(candidate.providerId)) {
      score += routing.providerRepeatPenalty;
    } else {
      score -= 0.06;
    }

    if (dstNode && candidate.providerId === dstNode.providerId) {
      score -= 0.04;
    }
    if (previousNode) {
      score += estimateLinkCompatibilityPenalty(
        state,
        previousNode,
        candidate
      );
    }
    if (nextNode) {
      score += estimateLinkCompatibilityPenalty(state, candidate, nextNode);
    } else if (dstNode) {
      score += estimateLinkCompatibilityPenalty(state, candidate, dstNode) * 0.8;
    }
    if (candidate.ipStackId === "dual-stack") {
      score -= state.config.network.dualStackBonus;
    }

    if (options.forceHigherObfuscation) {
      score += state.rng.float(0, 0.4);
    } else {
      score += state.rng.float(0, 0.16);
    }

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate) {
    return bestCandidate;
  }

  for (let retries = 0; retries < 24; retries += 1) {
    const candidate = state.rng.pick(state.nodes);
    if (!usedNodeIds.has(candidate.id)) {
      return candidate;
    }
  }

  return null;
}

function trackRouteFingerprint(state, route) {
  if (!route || route.length < 2) {
    return;
  }
  const fingerprint = route.map((node) => node.id).join(">>");
  if (state.routeFingerprints.has(fingerprint)) {
    return;
  }
  state.routeFingerprints.add(fingerprint);
  state.metrics.routing.uniqueRoutes = state.routeFingerprints.size;
}

function simulateKeyExchange(state) {
  const keyMetrics = state.metrics.keyExchange;
  keyMetrics.sessionsAttempted += 1;

  const shareCount = state.rng.int(
    state.config.keyExchange.shareCountMin,
    state.config.keyExchange.shareCountMax
  );

  let deliveredShares = 0;
  let interceptedShares = 0;

  for (let i = 0; i < shareCount; i += 1) {
    keyMetrics.sharesAttempted += 1;
    const transfer = simulatePacketTransfer(state, "key-share", {
      routeClass: `key-share-${i}`,
      forceFresh: true,
      payloadBytes: state.config.keyExchange.sharePayloadBytes,
    });

    if (transfer.delivered) {
      deliveredShares += 1;
      keyMetrics.sharesDelivered += 1;
    }
    if (transfer.intercepted) {
      interceptedShares += 1;
      keyMetrics.sharesIntercepted += 1;
    }
  }

  const success = deliveredShares === shareCount;
  if (success) {
    keyMetrics.sessionsSucceeded += 1;
  } else {
    keyMetrics.sessionsFailed += 1;
  }

  const compromised = state.config.keyExchange.compromiseRequiresAllShares
    ? interceptedShares >= shareCount
    : interceptedShares >= Math.ceil(shareCount * 0.6);

  if (compromised) {
    keyMetrics.sessionsCompromised += 1;
  }
}

function maybeFlushTimelineBucket(state) {
  const bucketMs = state.config.reporting.timelineBucketMs;
  if (state.nowMs - state.metrics.timelineBucket.startMs < bucketMs) {
    return;
  }
  flushTimelineBucket(state);
  state.metrics.timelineBucket = createTimelineBucket(state.nowMs);
}

function flushTimelineBucket(state) {
  const bucket = state.metrics.timelineBucket;
  if (!bucket || bucket.attemptedPackets === 0) {
    return;
  }

  const delivered = bucket.deliveredPackets;
  const attempted = bucket.attemptedPackets;
  const avgLatencyMs = delivered > 0 ? bucket.deliveredLatencyMs / delivered : 0;

  state.metrics.timeline.push({
    minute: Number((bucket.startMs / 60_000).toFixed(2)),
    attemptedPackets: attempted,
    deliveredPackets: delivered,
    failedPackets: bucket.failedPackets,
    successRate: safeDivide(delivered, attempted),
    avgLatencyMs: Number(avgLatencyMs.toFixed(3)),
    mitmAttempts: bucket.mitmAttempts,
    mitmDetected: bucket.mitmDetected,
    hopsIpv4: bucket.hopsIpv4,
    hopsIpv6: bucket.hopsIpv6,
    hopsTranslationRelay: bucket.hopsTranslationRelay,
    connectivityDrops: bucket.connectivityDrops,
  });

  state.metrics.timelineBucket = createTimelineBucket(state.nowMs);
}

function createTimelineBucket(startMs) {
  return {
    startMs,
    attemptedPackets: 0,
    deliveredPackets: 0,
    failedPackets: 0,
    deliveredLatencyMs: 0,
    mitmAttempts: 0,
    mitmDetected: 0,
    hopsIpv4: 0,
    hopsIpv6: 0,
    hopsTranslationRelay: 0,
    connectivityDrops: 0,
  };
}

function buildFinalReport(state) {
  const packets = state.metrics.packets;
  const durationSeconds = state.config.durationMs / 1000;

  const latencySamples = state.metrics.performance.latencySamples;
  const hopSamples = state.metrics.performance.hopSamples;
  const providerSpanSamples = state.metrics.performance.providerSpanSamples;

  const providerDetails = [];
  for (const provider of state.providers) {
    const stats = state.providerStats.get(provider.id);
    const nodes = state.nodes.filter((node) => node.providerId === provider.id);
    let repTotal = 0;
    let bandwidthTotal = 0;
    for (const node of nodes) {
      repTotal += node.reputationScore;
      bandwidthTotal += node.bandwidthCurrentMbps;
    }

    const averageReputation = nodes.length ? repTotal / nodes.length : 0;
    const averageBandwidthMbps = nodes.length ? bandwidthTotal / nodes.length : 0;

    providerDetails.push({
      providerId: provider.id,
      nodeCount: stats.nodes,
      txBytes: stats.txBytes,
      rxBytes: stats.rxBytes,
      attemptedPackets: stats.attemptedPackets,
      deliveredPackets: stats.deliveredPackets,
      failedPackets: stats.failedPackets,
      averageLatencyMs:
        stats.latencySamples > 0 ? stats.latencyMsTotal / stats.latencySamples : 0,
      mitmExposure: stats.mitmExposure,
      averageReputation,
      averageBandwidthMbps,
      packetLossRate: provider.packetLossRate,
      mitmRisk: provider.mitmRisk,
    });
  }

  const reputationScores = state.nodes.map((node) => node.reputationScore);
  const lowReputationNodes = reputationScores.filter(
    (score) => score < state.config.reputation.routeFloor
  ).length;

  const maxProviderNodes = Math.max(
    1,
    ...providerDetails.map((entry) => entry.nodeCount)
  );
  const providerConcentration = safeDivide(maxProviderNodes, state.config.nodeCount);
  const ipStackCounts = countByKey(state.nodes, "ipStackId");
  const natTypeCounts = countByKey(state.nodes, "natType");
  const routerProfileCounts = countByKey(state.nodes, "routerProfileId");
  const ipv6CapableNodes = state.nodes.filter((node) => supportsIpv6(node.ipStackId)).length;
  const ipv4CapableNodes = state.nodes.filter((node) => supportsIpv4(node.ipStackId)).length;
  const totalConnectivityDrops =
    state.metrics.network.stackMismatchDrops +
    state.metrics.network.natTraversalDrops +
    state.metrics.network.firewallDrops;
  const totalConnectivityHops =
    state.metrics.network.hopsIpv4 +
    state.metrics.network.hopsIpv6 +
    state.metrics.network.hopsTranslationRelay;

  const report = {
    generatedAt: new Date().toISOString(),
    scenario: state.scenarioName,
    meta: {
      seed: String(state.config.seed),
      nodeCount: state.config.nodeCount,
      durationMs: state.config.durationMs,
      durationMinutes: Number((state.config.durationMs / 60_000).toFixed(2)),
      tickMs: state.config.tickMs,
      ticks: Math.ceil(state.config.durationMs / state.config.tickMs),
    },
    configSummary: {
      providers: state.config.providers.map((provider) => ({
        id: provider.id,
        share: Number(provider.share.toFixed(4)),
        baseLatencyMs: provider.baseLatencyMs,
        bandwidthMbpsMin: provider.bandwidthMbpsMin,
        bandwidthMbpsMax: provider.bandwidthMbpsMax,
        mitmRisk: provider.mitmRisk,
      })),
      network: {
        ipStacks: state.config.network.ipStacks.map((entry) => ({
          id: entry.id,
          share: Number(entry.share.toFixed(4)),
        })),
        routers: state.config.network.routers.map((entry) => ({
          id: entry.id,
          share: Number(entry.share.toFixed(4)),
          natType: entry.natType,
        })),
        preferIpv6Probability: state.config.network.preferIpv6Probability,
        translationRelayProbability: state.config.network.translationRelayProbability,
        natTraversalBaseSuccess: state.config.network.natTraversalBaseSuccess,
        firewallDropBaseProbability: state.config.network.firewallDropBaseProbability,
      },
      traffic: {
        dataSessionsPerSecond: state.config.traffic.dataSessionsPerSecond,
        noiseSessionsPerSecond: state.config.traffic.noiseSessionsPerSecond,
        payloadBytesMin: state.config.traffic.payloadBytesMin,
        payloadBytesMax: state.config.traffic.payloadBytesMax,
      },
      routing: {
        minHops: state.config.routing.minHops,
        maxHops: state.config.routing.maxHops,
        routeTtlMs: state.config.routing.routeTtlMs,
        mutationProbability: state.config.routing.mutationProbability,
        justInTimeProbability: state.config.routing.justInTimeProbability,
      },
      reputation: {
        ttlMs: state.config.reputation.ttlMs,
        penaltyTtlExpiry: state.config.reputation.penaltyTtlExpiry,
        routeFloor: state.config.reputation.routeFloor,
      },
      mitm: {
        baseHopProbability: state.config.mitm.baseHopProbability,
        tamperProbability: state.config.mitm.tamperProbability,
        dropProbability: state.config.mitm.dropProbability,
        delayProbability: state.config.mitm.delayProbability,
      },
      keyExchange: {
        enabled: state.config.keyExchange.enabled,
        sessionsPerMinute: state.config.keyExchange.sessionsPerMinute,
        shareCountMin: state.config.keyExchange.shareCountMin,
        shareCountMax: state.config.keyExchange.shareCountMax,
      },
    },
    traffic: {
      totalPackets: packets.attempted,
      deliveredPackets: packets.delivered,
      failedPackets: packets.failed,
      dataPackets: packets.data,
      noisePackets: packets.noise,
      keySharePackets: packets.keyShare,
      bytesAttempted: packets.bytesAttempted,
      bytesDelivered: packets.bytesDelivered,
      throughputMbps: safeDivide(packets.bytesDelivered * 8, durationSeconds * 1_000_000),
      successRate: safeDivide(packets.delivered, packets.attempted),
    },
    performance: {
      avgLatencyMs: average(latencySamples),
      p50LatencyMs: percentile(latencySamples, 0.5),
      p95LatencyMs: percentile(latencySamples, 0.95),
      p99LatencyMs: percentile(latencySamples, 0.99),
      avgHops: average(hopSamples),
      p95Hops: percentile(hopSamples, 0.95),
      avgProviderSpan: average(providerSpanSamples),
      p95ProviderSpan: percentile(providerSpanSamples, 0.95),
    },
    routing: {
      cacheHits: state.metrics.routing.cacheHits,
      cacheMisses: state.metrics.routing.cacheMisses,
      cacheHitRate: safeDivide(
        state.metrics.routing.cacheHits,
        state.metrics.routing.cacheHits + state.metrics.routing.cacheMisses
      ),
      justInTimeRoutes: state.metrics.routing.justInTimeRoutes,
      routeMutations: state.metrics.routing.mutations,
      uniqueRoutesObserved: state.metrics.routing.uniqueRoutes,
    },
    security: {
      mitm: {
        attempts: state.metrics.mitm.attempts,
        tampered: state.metrics.mitm.tampered,
        dropped: state.metrics.mitm.dropped,
        delayed: state.metrics.mitm.delayed,
        observed: state.metrics.mitm.observed,
        detected: state.metrics.mitm.detected,
        detectionRate: safeDivide(state.metrics.mitm.detected, state.metrics.mitm.attempts),
        campaignsSpawned: state.metrics.mitm.campaignsSpawned,
      },
      keyExchange: {
        sessionsAttempted: state.metrics.keyExchange.sessionsAttempted,
        sessionsSucceeded: state.metrics.keyExchange.sessionsSucceeded,
        sessionsFailed: state.metrics.keyExchange.sessionsFailed,
        sessionsCompromised: state.metrics.keyExchange.sessionsCompromised,
        successRate: safeDivide(
          state.metrics.keyExchange.sessionsSucceeded,
          state.metrics.keyExchange.sessionsAttempted
        ),
        compromiseRate: safeDivide(
          state.metrics.keyExchange.sessionsCompromised,
          state.metrics.keyExchange.sessionsAttempted
        ),
        sharesAttempted: state.metrics.keyExchange.sharesAttempted,
        sharesDelivered: state.metrics.keyExchange.sharesDelivered,
        sharesIntercepted: state.metrics.keyExchange.sharesIntercepted,
      },
    },
    reputation: {
      averageScore: average(reputationScores),
      minScore: reputationScores.length ? Math.min(...reputationScores) : 0,
      maxScore: reputationScores.length ? Math.max(...reputationScores) : 0,
      ttlExpirations: state.metrics.reputation.ttlExpirations,
      rewardsApplied: state.metrics.reputation.rewardsApplied,
      penaltiesApplied: state.metrics.reputation.penaltiesApplied,
      lowReputationNodes,
      lowReputationRate: safeDivide(lowReputationNodes, state.nodes.length),
    },
    topology: {
      providerConcentration,
      providerCount: state.providers.length,
      providers: providerDetails,
    },
    network: {
      ipv6CapableNodes,
      ipv4CapableNodes,
      ipv6CapableRate: safeDivide(ipv6CapableNodes, state.nodes.length),
      ipv4CapableRate: safeDivide(ipv4CapableNodes, state.nodes.length),
      ipStackCounts,
      natTypeCounts,
      routerProfileCounts,
      hops: {
        ipv4: state.metrics.network.hopsIpv4,
        ipv6: state.metrics.network.hopsIpv6,
        translationRelay: state.metrics.network.hopsTranslationRelay,
        ipv6ShareOfHops: safeDivide(
          state.metrics.network.hopsIpv6,
          totalConnectivityHops
        ),
        translationRelayShareOfHops: safeDivide(
          state.metrics.network.hopsTranslationRelay,
          totalConnectivityHops
        ),
      },
      natTraversal: {
        checks: state.metrics.network.natTraversalChecks,
        succeeded: state.metrics.network.natTraversalSucceeded,
        successRate: safeDivide(
          state.metrics.network.natTraversalSucceeded,
          state.metrics.network.natTraversalChecks
        ),
      },
      failures: {
        stackMismatchDrops: state.metrics.network.stackMismatchDrops,
        natTraversalDrops: state.metrics.network.natTraversalDrops,
        firewallDrops: state.metrics.network.firewallDrops,
        connectivityDrops: totalConnectivityDrops,
        natTraversalDropRate: safeDivide(
          state.metrics.network.natTraversalDrops,
          packets.attempted
        ),
        stackMismatchDropRate: safeDivide(
          state.metrics.network.stackMismatchDrops,
          packets.attempted
        ),
        firewallDropRate: safeDivide(
          state.metrics.network.firewallDrops,
          packets.attempted
        ),
        connectivityDropRate: safeDivide(totalConnectivityDrops, packets.attempted),
      },
    },
    timeline: state.metrics.timeline,
  };

  report.recommendations = buildRecommendations(report);
  report.conclusions = buildConclusions(report);

  return report;
}

function buildRecommendations(report) {
  const recommendations = [];

  if (report.traffic.successRate < 0.975) {
    recommendations.push({
      severity: "high",
      area: "delivery",
      title: "Improve packet delivery resilience",
      detail:
        "Increase multi-path redundancy (higher min/max hops or parallel lanes) and lower per-hop congestion by reducing peak session rate or increasing node bandwidth floors.",
    });
  }

  if (report.performance.p95LatencyMs > 220) {
    recommendations.push({
      severity: "medium",
      area: "latency",
      title: "Reduce high-tail latency",
      detail:
        "Lower route mutation probability or latency obfuscation jitter, and prioritize higher-reputation relays for latency-sensitive flows.",
    });
  }

  if (report.security.mitm.detectionRate < 0.55 && report.security.mitm.attempts > 0) {
    recommendations.push({
      severity: "high",
      area: "security",
      title: "Increase MITM detection fidelity",
      detail:
        "Increase active probing/ack verification and tighten tamper/drop suspicion thresholds to surface stealth observation attacks.",
    });
  }

  if (report.security.keyExchange.compromiseRate > 0.015) {
    recommendations.push({
      severity: "high",
      area: "key-exchange",
      title: "Harden split-share key routing",
      detail:
        "Increase share count and enforce provider-disjoint routes for key shares; shorten share TTL and increase decoy share noise when campaigns spike.",
    });
  }

  if (report.network.failures.natTraversalDrops > 0) {
    recommendations.push({
      severity: report.network.failures.natTraversalDropRate > 0.03 ? "high" : "medium",
      area: "connectivity",
      title: "Mitigate NAT traversal loss",
      detail:
        "Prefer dual-stack relay nodes, increase translation relay probability for mixed-stack paths, and demote symmetric/cgnat pairs for key-share routes.",
    });
  }

  if (report.network.failures.stackMismatchDrops > 0) {
    recommendations.push({
      severity: "medium",
      area: "connectivity",
      title: "Reduce IPv4/IPv6 stack mismatch drops",
      detail:
        "Increase dual-stack node share or enable higher translation relay usage so mixed IPv4-only/IPv6-only segments remain routable.",
    });
  }

  if (
    report.network.ipv6CapableRate > 0.5 &&
    report.network.hops.ipv6ShareOfHops < 0.35
  ) {
    recommendations.push({
      severity: "medium",
      area: "connectivity",
      title: "Increase effective IPv6 route usage",
      detail:
        "Raise IPv6 preference and reduce IPv4 fallback bias to better exploit dual-stack nodes while reducing NAT pressure.",
    });
  }

  if (report.topology.providerConcentration > 0.34) {
    recommendations.push({
      severity: "medium",
      area: "topology",
      title: "Reduce provider concentration",
      detail:
        "Bias peer selection toward underrepresented providers and enforce stronger diversity penalties in ring-aware routing.",
    });
  }

  if (report.reputation.lowReputationRate > 0.2) {
    recommendations.push({
      severity: "medium",
      area: "reputation",
      title: "Tune reputation TTL and penalties",
      detail:
        "Increase TTL for stable nodes or reduce TTL decay penalties to avoid over-penalizing transient congestion.",
    });
  }

  if (!recommendations.length) {
    recommendations.push({
      severity: "low",
      area: "baseline",
      title: "Current scenario is stable",
      detail:
        "Keep current routing and MITM controls, and re-run with higher attack/campaign pressure to discover the next bottleneck.",
    });
  }

  return recommendations;
}

function buildConclusions(report) {
  const traffic = report.traffic;
  const perf = report.performance;
  const security = report.security;
  const network = report.network;

  const deliveryState =
    traffic.successRate >= 0.985
      ? "delivery remained highly stable"
      : traffic.successRate >= 0.96
      ? "delivery was acceptable but showed stress"
      : "delivery degraded under load";

  const latencyState =
    perf.p95LatencyMs <= 150
      ? "tail latency stayed controlled"
      : perf.p95LatencyMs <= 260
      ? "tail latency was moderately elevated"
      : "tail latency was high and needs tuning";

  const mitmState =
    security.mitm.detectionRate >= 0.7
      ? "MITM attempts were frequently detected"
      : security.mitm.detectionRate >= 0.45
      ? "MITM detection was partial"
      : "MITM detection was weak for this scenario";

  const keyState =
    security.keyExchange.compromiseRate === 0
      ? "split-share exchange prevented full-key interception"
      : "key-share interception occasionally reached compromise thresholds";
  const connectivityState =
    network.failures.connectivityDropRate <= 0.02
      ? "IPv6/NAT connectivity remained stable"
      : "IPv6/NAT connectivity produced measurable drop pressure";

  return [
    `Across ${report.meta.nodeCount} simulated nodes over ${report.meta.durationMinutes} minutes, ${deliveryState}.`,
    `${latencyState} (p95=${formatNumber(perf.p95LatencyMs)} ms, p99=${formatNumber(perf.p99LatencyMs)} ms).`,
    `${mitmState} with ${security.mitm.attempts} attack attempts and detection rate ${formatPercent(security.mitm.detectionRate)}.`,
    `${keyState} (compromise rate ${formatPercent(security.keyExchange.compromiseRate)}).`,
    `${connectivityState} (IPv6 hop share ${formatPercent(network.hops.ipv6ShareOfHops)}, connectivity drop rate ${formatPercent(network.failures.connectivityDropRate)}).`,
  ];
}

function resolveLinkMode(state, sender, receiver) {
  const network = state.config.network;
  const senderIpv4 = supportsIpv4(sender.ipStackId);
  const senderIpv6 = supportsIpv6(sender.ipStackId);
  const receiverIpv4 = supportsIpv4(receiver.ipStackId);
  const receiverIpv6 = supportsIpv6(receiver.ipStackId);

  const bothIpv6 = senderIpv6 && receiverIpv6;
  const bothIpv4 = senderIpv4 && receiverIpv4;

  if (bothIpv6 && bothIpv4) {
    if (state.rng.chance(network.preferIpv6Probability)) {
      return { reachable: true, mode: "ipv6", delayPenaltyMs: state.rng.float(0, 0.8) };
    }
    return { reachable: true, mode: "ipv4", delayPenaltyMs: state.rng.float(0.2, 1.6) };
  }

  if (bothIpv6) {
    return { reachable: true, mode: "ipv6", delayPenaltyMs: state.rng.float(0, 1) };
  }
  if (bothIpv4) {
    return { reachable: true, mode: "ipv4", delayPenaltyMs: state.rng.float(0.4, 2.4) };
  }

  if (state.rng.chance(network.translationRelayProbability)) {
    return {
      reachable: true,
      mode: "translation-relay",
      delayPenaltyMs: state.rng.float(
        network.translationRelayDelayMsMin,
        network.translationRelayDelayMsMax
      ),
    };
  }

  return {
    reachable: false,
    mode: "none",
    delayPenaltyMs: 0,
  };
}

function computeNatTraversalSuccessProbability(state, sender, receiver, linkMode) {
  const network = state.config.network;
  let probability =
    (sender.natTraversalReliability + receiver.natTraversalReliability) / 2;

  if (linkMode.mode === "ipv6") {
    probability += network.ipv6DirectBonus;
  } else if (linkMode.mode === "ipv4") {
    probability -= network.ipv4FallbackPenalty;
  } else if (linkMode.mode === "translation-relay") {
    probability *= 0.9;
  }

  if (
    (sender.natType === "carrier_grade_nat" || sender.natType === "symmetric_nat") &&
    (receiver.natType === "carrier_grade_nat" || receiver.natType === "symmetric_nat")
  ) {
    probability -= 0.03;
  }

  return clamp(probability, 0.1, 0.999);
}

function incrementHopModeMetrics(state, mode) {
  const bucket = state.metrics.timelineBucket;
  if (mode === "ipv6") {
    state.metrics.network.hopsIpv6 += 1;
    bucket.hopsIpv6 += 1;
    return;
  }
  if (mode === "ipv4") {
    state.metrics.network.hopsIpv4 += 1;
    bucket.hopsIpv4 += 1;
    return;
  }
  if (mode === "translation-relay") {
    state.metrics.network.hopsTranslationRelay += 1;
    bucket.hopsTranslationRelay += 1;
  }
}

function estimateLinkCompatibilityPenalty(state, leftNode, rightNode) {
  if (!leftNode || !rightNode) {
    return 0;
  }
  const leftIpv4 = supportsIpv4(leftNode.ipStackId);
  const leftIpv6 = supportsIpv6(leftNode.ipStackId);
  const rightIpv4 = supportsIpv4(rightNode.ipStackId);
  const rightIpv6 = supportsIpv6(rightNode.ipStackId);

  if ((leftIpv4 && rightIpv4) || (leftIpv6 && rightIpv6)) {
    if (leftNode.natType === "open_internet" || rightNode.natType === "open_internet") {
      return -0.03;
    }
    return 0;
  }

  if (state.config.network.translationRelayProbability > 0) {
    return state.config.network.translationRelayPenalty;
  }
  return state.config.network.compatibilityPenalty;
}

function supportsIpv4(ipStackId) {
  return ipStackId === "ipv4-only" || ipStackId === "dual-stack";
}

function supportsIpv6(ipStackId) {
  return ipStackId === "ipv6-only" || ipStackId === "dual-stack";
}

function countUniqueProviders(route) {
  const providers = new Set();
  for (const node of route) {
    providers.add(node.providerId);
  }
  return providers.size;
}

function countByKey(items, key) {
  const counts = {};
  for (const item of items) {
    const value = String(item[key]);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function pickProvider(providers, rng) {
  return pickWeighted(providers, rng);
}

function pickWeighted(items, rng) {
  const target = rng.next();
  let cursor = 0;
  for (const item of items) {
    cursor += item.share;
    if (target <= cursor) {
      return item;
    }
  }
  return items[items.length - 1];
}

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
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
  return Number(value.toFixed(2));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createSeededRng(seedValue) {
  let state = hashSeed(seedValue);
  if (state === 0) {
    state = 0x6d2b79f5;
  }

  return {
    next() {
      state += 0x6d2b79f5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      const lower = Math.min(min, max);
      const upper = Math.max(min, max);
      if (lower === upper) {
        return lower;
      }
      return lower + Math.floor(this.next() * (upper - lower + 1));
    },
    float(min, max) {
      if (max <= min) {
        return min;
      }
      return min + this.next() * (max - min);
    },
    chance(probability) {
      if (probability <= 0) {
        return false;
      }
      if (probability >= 1) {
        return true;
      }
      return this.next() < probability;
    },
    pick(items) {
      if (!Array.isArray(items) || !items.length) {
        throw new Error("Cannot pick from an empty collection");
      }
      const index = this.int(0, items.length - 1);
      return items[index];
    },
  };
}

function hashSeed(seedValue) {
  const input = String(seedValue);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

module.exports = {
  runNetworkSimulation,
};
