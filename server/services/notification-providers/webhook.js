/**
 * Generic JSON webhook notification provider.
 */

function httpError(status) {
  if (status === 401 || status === 403) return new Error('Webhook authentication failed.');
  if (status === 404) return new Error('Webhook endpoint was not found.');
  return new Error(`Webhook returned HTTP ${status}`);
}

export const webhookProvider = {
  id: 'webhook',

  async send({ channel, payload, fetchImpl = fetch, signal } = {}) {
    const headers = { 'content-type': 'application/json' };
    const token = String(channel?.secrets?.token ?? '');
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchImpl(channel.config.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'notification',
        notification: payload,
        sentAt: new Date().toISOString(),
      }),
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    return { ok: true, status: response.status };
  },
};

export default webhookProvider;
