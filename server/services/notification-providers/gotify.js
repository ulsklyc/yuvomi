/**
 * Modul: Gotify Notification Provider
 * Zweck: Yuvomi Reminder-Payloads an Gotify senden.
 */

import { guardedFetch } from './guarded-fetch.js';
import { NotificationProviderError } from './provider-error.js';

function httpError(status) {
  if (status === 401 || status === 403) return new NotificationProviderError('Gotify authentication failed.');
  if (status === 404) return new NotificationProviderError('Gotify endpoint was not found.');
  return new NotificationProviderError(`Gotify returned HTTP ${status}`);
}

export const gotifyProvider = {
  id: 'gotify',

  async send({ channel, payload, fetchImpl = guardedFetch, signal } = {}) {
    const baseUrl = String(channel?.config?.baseUrl ?? '').replace(/\/+$/, '');
    const token = String(channel?.secrets?.appToken ?? '');
    const url = new URL(`${baseUrl}/message`);
    url.searchParams.set('token', token);

    const body = new URLSearchParams();
    body.set('title', payload.title);
    body.set('message', payload.body);
    body.set('priority', String(channel?.config?.priority ?? 5));
    if (payload.url) {
      body.set('extras', JSON.stringify({
        'client::notification': {
          click: { url: payload.url },
        },
      }));
    }

    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      body,
      signal,
    });
    if (!response.ok) throw httpError(response.status);

    let providerMessageId = null;
    if (typeof response.json === 'function') {
      const data = await response.json().catch(() => null);
      providerMessageId = data?.id ? String(data.id) : null;
    }
    return { ok: true, status: response.status, providerMessageId };
  },
};

export default gotifyProvider;
