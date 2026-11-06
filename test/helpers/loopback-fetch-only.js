/** Preload into test child servers: integrations must never leave loopback. */
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return Promise.reject(new Error('External fetch disabled for isolated browser test.'));
  }
  return originalFetch(input, options);
};
