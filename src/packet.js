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

function encodePacket(packet) {
  const wire = {
    version: packet.version,
    srcAlias: packet.srcAlias,
    dstAlias: packet.dstAlias,
    ttl: packet.ttl,
    hopCount: packet.hopCount,
    payload: packet.payload.toString("base64"),
    metadata: packet.metadata || {},
    encryption: packet.encryption || null,
  };
  return Buffer.from(JSON.stringify(wire));
}

function decodePacket(buffer) {
  const wire = JSON.parse(buffer.toString("utf8"));
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

module.exports = {
  DEFAULT_TTL,
  PROTOCOL_VERSION,
  createPacket,
  encodePacket,
  decodePacket,
};
