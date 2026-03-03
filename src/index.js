const { PrivacyShieldNode } = require("./node");
const { MemoryTransport } = require("./transport/memory");
const { TcpTransport } = require("./transport/tcp");
const { BaseTransport } = require("./transport/base");
const { MemoryDHTStore } = require("./dht");
const { NeighborTable, SimpleRoutingEngine } = require("./routing");
const { NoShufflePolicy, BasicShufflePolicy } = require("./shuffle");
const {
  generateIdentity,
  deriveAlias,
  createAliasRecord,
  verifyAliasRecord,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
} = require("./identity");
const {
  estimateCoordinates,
  quantizeCoordinate,
  quantizeAcrossScales,
  distance,
} = require("./coordinates");
const {
  createPacket,
  serializePacket,
  parsePacketString,
  encodePacket,
  decodePacket,
} = require("./packet");
const {
  createSymmetricKey,
  encryptPayload,
  decryptPayload,
} = require("./crypto");
const {
  createHandshakeOffer,
  acceptHandshakeOffer,
  finalizeHandshake,
  deriveSessionKey,
} = require("./handshake");
const {
  saveIdentityToFile,
  loadIdentityFromFile,
  loadOrCreateIdentity,
} = require("./identity-store");
const { linkPeers, createInMemoryPair } = require("./demo");

module.exports = {
  PrivacyShieldNode,
  MemoryTransport,
  TcpTransport,
  BaseTransport,
  MemoryDHTStore,
  NeighborTable,
  SimpleRoutingEngine,
  NoShufflePolicy,
  BasicShufflePolicy,
  generateIdentity,
  deriveAlias,
  createAliasRecord,
  verifyAliasRecord,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  estimateCoordinates,
  quantizeCoordinate,
  quantizeAcrossScales,
  distance,
  createPacket,
  serializePacket,
  parsePacketString,
  encodePacket,
  decodePacket,
  createSymmetricKey,
  encryptPayload,
  decryptPayload,
  createHandshakeOffer,
  acceptHandshakeOffer,
  finalizeHandshake,
  deriveSessionKey,
  saveIdentityToFile,
  loadIdentityFromFile,
  loadOrCreateIdentity,
  linkPeers,
  createInMemoryPair,
};
