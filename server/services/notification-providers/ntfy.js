/**
 * Modul: ntfy Notification Provider
 * Zweck: Yuvomi Reminder-Payloads an ntfy Topics senden.
 */

import { guardedFetch } from './guarded-fetch.js';
import { NotificationProviderError } from './provider-error.js';

function httpError(status) {
  if (status === 401 || status === 403) return new NotificationProviderError('ntfy authentication failed.');
  if (status === 404) return new NotificationProviderError('ntfy topic or endpoint was not found.');
  return new NotificationProviderError(`ntfy returned HTTP ${status}`);
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export const ntfyProvider = {
  id: 'ntfy',

  async send({ channel, payload, fetchImpl = guardedFetch, signal } = {}) {
    const baseUrl = String(channel?.config?.baseUrl ?? '').replace(/\/+$/, '');
    const topic = encodeURIComponent(String(channel?.config?.topic ?? '').replace(/^\/+/, ''));
    const headers = {
      Title: payload.title,
      Priority: String(channel?.config?.priority ?? 'default'),
    };
    if (payload.url) headers.Click = payload.url;

    const authType = channel?.config?.authType ?? 'none';
    if (authType === 'token' && channel?.secrets?.token) {
      headers.Authorization = `Bearer ${channel.secrets.token}`;
    } else if (authType === 'basic' && channel?.secrets?.username) {
      headers.Authorization = basicAuth(channel.secrets.username, channel.secrets.password ?? '');
    }

    const response = await fetchImpl(`${baseUrl}/${topic}`, {
      method: 'POST',
      headers,
      body: payload.body,
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    return { ok: true, status: response.status };
  },
};

export default ntfyProvider;
