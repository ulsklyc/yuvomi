/**
 * Generic JSON webhook notification provider.
 *
 * Ohne Vorlage sendet der Kanal einen Yuvomi-geformten Body. Der passt fuer
 * Empfaenger, die beliebiges JSON annehmen (Home Assistant, n8n), aber nicht
 * fuer Dienste mit eigenem Pflichtschema: ein Discord-Webhook verlangt `content`
 * oder `embeds` und antwortet auf alles andere mit 400. Statt pro Dienst einen
 * Adapter zu bauen, formt eine Vorlage den Body - damit bleibt EIN generischer
 * Anbieter fuer Discord, Slack und alles Weitere zustaendig (#692, #660).
 */

import { guardedFetch } from './guarded-fetch.js';
import { NotificationProviderError } from './provider-error.js';
import { renderPayloadTemplate } from './webhook-template.js';

function httpError(status) {
  if (status === 401 || status === 403) return new NotificationProviderError('Webhook authentication failed.');
  if (status === 404) return new NotificationProviderError('Webhook endpoint was not found.');
  return new NotificationProviderError(`Webhook returned HTTP ${status}`);
}

export const webhookProvider = {
  id: 'webhook',

  async send({ channel, payload, fetchImpl = guardedFetch, signal } = {}) {
    const headers = { 'content-type': 'application/json' };
    const token = String(channel?.secrets?.token ?? '');
    if (token) headers.authorization = `Bearer ${token}`;

    const template = String(channel?.config?.payloadTemplate ?? '').trim();
    const body = template
      ? renderPayloadTemplate(template, payload)
      : JSON.stringify({
        event: 'notification',
        notification: payload,
        sentAt: new Date().toISOString(),
      });

    const response = await fetchImpl(channel.config.baseUrl, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    return { ok: true, status: response.status };
  },
};

export default webhookProvider;
