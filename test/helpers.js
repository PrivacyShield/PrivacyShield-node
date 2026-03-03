"use strict";

function waitForEvent(emitter, eventName, options = {}) {
  const predicate = options.predicate || (() => true);
  const timeoutMs = options.timeoutMs || 1_000;

  return new Promise((resolve, reject) => {
    const onEvent = (value) => {
      let matches = false;
      try {
        matches = predicate(value);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!matches) {
        return;
      }
      cleanup();
      resolve(value);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out waiting for "${eventName}"`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(eventName, onEvent);
    };

    const timer = setTimeout(onTimeout, timeoutMs);
    emitter.on(eventName, onEvent);
  });
}

module.exports = {
  waitForEvent,
};

