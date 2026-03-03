const DEFAULT_TTL = 6;
const PROTOCOL_VERSION = 1;

function createPacket({
  srcAlias,
  dstAlias,
  payload,
  ttl = DEFAULT_TTL,
  hopCount = 0,
  metadata = {},
  encryption = null,
} = {}) {
  if (!srcAlias || !dstAlias) {
    throw new Error("Packet requires srcAlias and dstAlias");
  }
  const normalizedPayload = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload || "");

  return {
    version: PROTOCOL_VERSION,
    srcAlias,
    dstAlias,
    ttl,
    hopCount,
    payload: normalizedPayload,
    metadata,
    encryption,
  };
}

function packetToWire(packet) {
  return {
    version: packet.version,
    srcAlias: packet.srcAlias,
    dstAlias: packet.dstAlias,
    ttl: packet.ttl,
    hopCount: packet.hopCount,
    payload: packet.payload.toString("base64"),
    metadata: packet.metadata || {},
    encryption: packet.encryption || null,
  };
}

function serializePacket(packet) {
  return JSON.stringify(packetToWire(packet));
}

function encodePacket(packet) {
  return Buffer.from(serializePacket(packet));
}

function parsePacketString(wireString) {
  const wire = JSON.parse(wireString);
  return {
    version: wire.version,
    srcAlias: wire.srcAlias,
    dstAlias: wire.dstAlias,
    ttl: wire.ttl,
    hopCount: wire.hopCount,
    payload: Buffer.from(wire.payload || "", "base64"),
    metadata: wire.metadata || {},
    encryption: wire.encryption || null,
  };
}

function decodePacket(buffer) {
  return parsePacketString(buffer.toString("utf8"));
}

module.exports = {
  DEFAULT_TTL,
  PROTOCOL_VERSION,
  createPacket,
  serializePacket,
  parsePacketString,
  encodePacket,
  decodePacket,
};
