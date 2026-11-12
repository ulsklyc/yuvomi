// The bottleneck: the one importer of a provider module, the one caller of send().
import { gotifyProvider } from './notification-providers/gotify.js';
/** @type {Record<string, { send: (msg: unknown) => Promise<unknown> }>} */
const providers = { gotify: gotifyProvider };
/** @param {{ channel: { provider: string }, payload: unknown }} msg */
export function sendToChannel({ channel, payload }) { return providers[channel.provider]?.send({ channel, payload }); }
