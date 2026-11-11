/**
 * Module: channel delivery
 * Purpose: The one place that hands a message to an outside notification channel
 *          (Gotify, ntfy, webhook, e-mail). It holds the provider table and the
 *          timeout and is the only caller of a provider's `send()` in the tree.
 *          Whoever imports it decides who hears what: the importers are named, each
 *          with the recipient check that lets it send, in the dependency-cruiser rule
 *          `channel-delivery-importers` (.dependency-cruiser.mjs). The providers
 *          themselves are imported only here (`providers-only-in-channel-delivery`),
 *          and the lint selector CHANNEL-SEND (.oxlintrc.json) keeps a provider that
 *          reaches another file as a parameter from being called there.
 * WHY: the medication scheduler (#2602, #2598) sent on its own, with providers it got
 *      as a parameter, past the recipient filters of the regular path. A provider
 *      handed around as a value is invisible to an import rule; one send function
 *      behind an import rule is not.
 * Not here (yet): the recipient check itself stays with each caller until phase 2
 * moves it behind authorize().
 * Dependencies: notification-providers/*.
 */
import { gotifyProvider } from './notification-providers/gotify.js';
import { ntfyProvider } from './notification-providers/ntfy.js';
import { webhookProvider } from './notification-providers/webhook.js';
import { emailProvider } from './notification-providers/email.js';
import { guardedFetch } from './notification-providers/guarded-fetch.js';
import { NotificationProviderError } from './notification-providers/provider-error.js';

// Exported so that the mail transport's own timeouts (services/email.js) are checked
// against it instead of against a copied number: the staggering is the promise.
export const PROVIDER_TIMEOUT_MS = 8_000;

export const defaultProviders = {
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
  webhook: webhookProvider,
  email: emailProvider,
};

/**
 * @template T
 * @param {(signal: AbortSignal) => Promise<T> | T} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function withTimeout(fn, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one message to one channel through its provider, aborted after
 * PROVIDER_TIMEOUT_MS. An unknown provider is an error, never a silent skip.
 *
 * @param {Object} opts
 * @param {{ provider: string }} opts.channel
 * @param {Object} opts.payload
 * @param {Function} [opts.fetchImpl] - tests inject one. The SSRF-guarded fetch is the one
 *   default for every sender and is set here; a caller passes its own on, never a default
 * @param {Record<string, { send: Function }>} [opts.providers] - { [provider]: { send } }; tests inject fakes
 * @returns {Promise<unknown>} what the provider's send() returns
 */
export function sendToChannel({ channel, payload, fetchImpl = guardedFetch, providers = defaultProviders } = /** @type {any} */ ({})) {
  const provider = providers[channel?.provider];
  if (!provider) return Promise.reject(new NotificationProviderError('Unknown notification provider.'));
  return withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
}
