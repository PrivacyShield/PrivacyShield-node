const { MemoryDHTStore } = require("./dht");
const { PrivacyShieldNode } = require("./node");

function linkPeers(a, b, options = {}) {
  const latencyMs = options.latencyMs || null;
  a.addNeighbor({
    alias: b.alias,
    coordinates: b.coordinates,
    latencyMs,
  });
  b.addNeighbor({
    alias: a.alias,
    coordinates: a.coordinates,
    latencyMs,
  });
}

function createInMemoryPair(options = {}) {
  const dht = options.dht || new MemoryDHTStore();
  const nodeA = new PrivacyShieldNode({ dht });
  const nodeB = new PrivacyShieldNode({ dht });

  linkPeers(nodeA, nodeB, options);

  return {
    nodeA,
    nodeB,
    start() {
      nodeA.start();
      nodeB.start();
    },
    stop() {
      nodeA.stop();
      nodeB.stop();
    },
  };
}

module.exports = {
  linkPeers,
  createInMemoryPair,
};
