/**
 * Modul: Notification-Channel-Store
 * Zweck: CRUD, Validierung und write-only Secret-Handhabung fuer externe Notification-Provider.
 * Abhaengigkeiten: server/db.js
 */
import * as dbModule from '../db.js';

export const NOTIFICATION_PROVIDERS = [
  { id: 'gotify', name: 'Gotify' },
  { id: 'ntfy', name: 'ntfy' },
  { id: 'webhook', name: 'Webhook' },
];

const PROVIDER_IDS = new Set(NOTIFICATION_PROVIDERS.map((p) => p.id));
const NTFY_PRIORITIES = new Set(['min', 'low', 'default', 'high', 'urgent']);
const NTFY_AUTH_TYPES = new Set(['none', 'token', 'basic']);

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('A base URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('A valid base URL is required.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Notification channel URL scheme must be http or https.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  const value = String(provider ?? '').trim().toLowerCase();
  if (!PROVIDER_IDS.has(value)) throw new Error('Unknown notification provider.');
  return value;
}

function normalizeScope(scope) {
  const value = String(scope ?? 'household').trim() || 'household';
  if (!['household', 'user'].includes(value)) throw new Error('Invalid notification channel scope.');
  return value;
}

function normalizeGotifyConfig(input = {}) {
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 5;
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    priority: Math.min(10, Math.max(1, Math.trunc(priority))),
  };
}

function normalizeGotifySecrets(input = {}) {
  return {
    appToken: String(input.appToken ?? '').trim(),
  };
}

function validateGotify({ secrets, requireSecrets }) {
  if (requireSecrets && !secrets.appToken) throw new Error('Gotify app token is required.');
}

function normalizeNtfyConfig(input = {}) {
  const authType = String(input.authType ?? 'none').trim().toLowerCase();
  const priority = String(input.priority ?? 'default').trim().toLowerCase();
  if (!NTFY_AUTH_TYPES.has(authType)) throw new Error('Invalid ntfy auth type.');
  if (!NTFY_PRIORITIES.has(priority)) throw new Error('Invalid ntfy priority.');
  const topic = String(input.topic ?? '').trim();
  if (!topic) throw new Error('ntfy topic is required.');
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    topic,
    priority,
    authType,
  };
}

function normalizeNtfySecrets(input = {}) {
  return {
    token: String(input.token ?? '').trim(),
    username: String(input.username ?? '').trim(),
    password: String(input.password ?? ''),
  };
}

function validateNtfy({ config, secrets, requireSecrets }) {
  if (config.authType === 'token' && requireSecrets && !secrets.token) {
    throw new Error('ntfy token is required for token authentication.');
  }
  if (config.authType === 'basic' && requireSecrets && (!secrets.username || !secrets.password)) {
    throw new Error('ntfy username and password are required for basic authentication.');
  }
}

function normalizeWebhookConfig(input = {}) {
  return { baseUrl: normalizeBaseUrl(input.baseUrl) };
}

function normalizeWebhookSecrets(input = {}) {
  return { token: String(input.token ?? '').trim() };
}

export function normalizeChannelInput(input = {}, existing = null) {
  const provider = existing?.provider || normalizeProvider(input.provider);
  normalizeProvider(provider);
  const mergedConfig = { ...(existing?.config || {}), ...(input.config || {}) };
  const existingSecrets = existing?.secrets || {};
  let mergedSecrets = { ...existingSecrets, ...(input.secrets || {}) };
  for (const key of input.clearSecrets || []) {
    if (Object.hasOwn(mergedSecrets, key)) mergedSecrets[key] = '';
  }

  let config;
  let secrets;
  if (provider === 'gotify') {
    config = normalizeGotifyConfig(mergedConfig);
    secrets = normalizeGotifySecrets(mergedSecrets);
    validateGotify({ secrets, requireSecrets: !existing });
  } else if (provider === 'ntfy') {
    config = normalizeNtfyConfig(mergedConfig);
    secrets = normalizeNtfySecrets(mergedSecrets);
    validateNtfy({ config, secrets, requireSecrets: !existing || input.secrets !== undefined });
  } else {
    config = normalizeWebhookConfig(mergedConfig);
    secrets = normalizeWebhookSecrets(mergedSecrets);
  }

  return {
    provider,
    name: String(input.name ?? existing?.name ?? '').trim(),
    enabled: input.enabled === undefined ? Boolean(existing?.enabled) : Boolean(input.enabled),
    scope: normalizeScope(input.scope ?? existing?.scope ?? 'household'),
    userId: input.userId ?? input.user_id ?? existing?.userId ?? existing?.user_id ?? null,
    config,
    secrets,
  };
}

function dbRowToChannel(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const config = parseJson(row.config_json);
  const secrets = parseJson(row.secret_json);
  const channel = {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.enabled),
    scope: row.scope,
    userId: row.user_id,
    config,
    secretSet: Object.values(secrets).some((value) => String(value ?? '') !== ''),
    lastTestAt: row.last_test_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeSecrets) channel.secrets = secrets;
  return channel;
}

export function publicChannel(channel) {
  if (!channel) return null;
  const { secrets, ...safe } = channel;
  void secrets;
  return safe;
}

export function createNotificationChannelStore({ db } = {}) {
  const getDb = () => (db || dbModule.get());

  function getInternalChannel(id) {
    const row = getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
    return dbRowToChannel(row, { includeSecrets: true });
  }

  function listChannels() {
    return getDb().prepare('SELECT * FROM notification_channels ORDER BY provider, name, id')
      .all()
      .map((row) => publicChannel(dbRowToChannel(row)));
  }

  function getChannel(id, options = {}) {
    const row = getDb().prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
    const channel = dbRowToChannel(row, options);
    return options.includeSecrets ? channel : publicChannel(channel);
  }

  function createChannel(input) {
    const normalized = normalizeChannelInput(input);
    if (!normalized.name) throw new Error('Notification channel name is required.');
    const now = new Date().toISOString();
    const result = getDb().prepare(`
      INSERT INTO notification_channels
        (provider, name, enabled, scope, user_id, config_json, secret_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.provider,
      normalized.name,
      normalized.enabled ? 1 : 0,
      normalized.scope,
      normalized.userId,
      toJson(normalized.config),
      toJson(normalized.secrets),
      now,
      now
    );
    return getChannel(result.lastInsertRowid);
  }

  function updateChannel(id, input) {
    const existing = getInternalChannel(id);
    if (!existing) return null;
    const normalized = normalizeChannelInput(input, existing);
    if (!normalized.name) throw new Error('Notification channel name is required.');
    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE notification_channels
      SET name = ?, enabled = ?, scope = ?, user_id = ?, config_json = ?, secret_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalized.name,
      normalized.enabled ? 1 : 0,
      normalized.scope,
      normalized.userId,
      toJson(normalized.config),
      toJson(normalized.secrets),
      now,
      id
    );
    return getChannel(id);
  }

  function deleteChannel(id) {
    const result = getDb().prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  function markChannelTestResult(id, { ok, error = null, at = new Date().toISOString() } = {}) {
    getDb().prepare(`
      UPDATE notification_channels
      SET last_test_at = ?,
          last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(at, ok ? 1 : 0, at, ok ? null : String(error || 'Test failed.'), at, id);
    return getChannel(id);
  }

  function listEnabledChannelsForUser(userId) {
    return getDb().prepare(`
      SELECT * FROM notification_channels
      WHERE enabled = 1
        AND (scope = 'household' OR user_id = ?)
      ORDER BY provider, name, id
    `).all(userId).map((row) => dbRowToChannel(row, { includeSecrets: true }));
  }

  return {
    listChannels,
    getChannel,
    createChannel,
    updateChannel,
    deleteChannel,
    markChannelTestResult,
    listEnabledChannelsForUser,
  };
}
