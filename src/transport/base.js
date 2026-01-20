class BaseTransport {
  // Expected to be extended; provides interface documentation only.
  start(_onPacket) {
    throw new Error("start() must be implemented by a transport adapter");
  }

  stop() {
    throw new Error("stop() must be implemented by a transport adapter");
  }

  // eslint-disable-next-line no-unused-vars
  send(_packet, _destinationAlias, _addressHint) {
    throw new Error("send() must be implemented by a transport adapter");
  }
}

module.exports = {
  BaseTransport,
};
