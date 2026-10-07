/**
 * Deletes the personal Hermes profile before Yuvomi removes or deactivates a
 * user. This is intentionally outside the SQLite transaction: the Hermes
 * profile owns its own durable state. A configured cleanup failure rejects the
 * Yuvomi removal before any local account data is changed.
 */
function settings(env = process.env) {
  const endpoint = env.HERMES_USER_DELETION_URL?.trim();
  const token = env.HERMES_LIFECYCLE_TOKEN?.trim();
  const required = env.HERMES_USER_DELETION_REQUIRED === 'true';
  if (!endpoint || !token) {
    if (required) throw new Error('Hermes user-deletion cleanup is required but not configured');
    return null;
  }
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Hermes user-deletion URL must use HTTP(S)');
  return { base, token };
}

export async function cleanupHermesProfile(userId, { env = process.env, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid Yuvomi user id for Hermes cleanup');
  const configured = settings(env);
  if (!configured) return { configured: false };
  const url = new URL(`internal/users/${userId}/deleted`, configured.base.href.endsWith('/') ? configured.base.href : `${configured.base.href}/`);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configured.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Hermes user-deletion cleanup returned HTTP ${response.status}`);
  return { configured: true };
}
