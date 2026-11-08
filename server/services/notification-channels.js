/**
 * Modul: Notification-Channel-Store
 * Zweck: CRUD, Validierung und write-only Secret-Handhabung fuer externe Notification-Provider.
 * Abhaengigkeiten: server/db.js, utils/ssrf.js, notification-providers/guarded-fetch.js
 */
import { isIP } from 'node:net';
import * as dbModule from '../db.js';
import { isBlockedAddress, isBlockedHostname, normalizeHostname } from '../utils/ssrf.js';
import { ENV_ALLOW_PRIVATE_NETWORK, isPrivateNetworkAllowed } from './notification-providers/guarded-fetch.js';
import {
  WEBHOOK_TEMPLATE_PLACEHOLDERS,
  renderPayloadTemplate,
  unknownTemplatePlaceholders,
} from './notification-providers/webhook.js';

export const NOTIFICATION_PROVIDERS = [
  { id: 'gotify', name: 'Gotify' },
  { id: 'ntfy', name: 'ntfy' },
  { id: 'webhook', name: 'Webhook' },
  { id: 'email', name: 'Email' },
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

/**
 * An input check of a channel refused the body (#2622): its sentence is the
 * app's own and the route sends it as a 400 (`code`). Everything else thrown
 * while writing a channel - a TypeError from a malformed body, the database -
 * is not marked and goes out as a fixed 500.
 */
export class ChannelInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelInputError';
    this.code = 'notification_channel_invalid';
  }
}

// `keepPath`: Gotify und ntfy bekommen eine BASIS, an die der Provider seinen
// eigenen Pfad haengt - da ist ein abschliessender Slash Rauschen und wird
// entfernt. Beim Webhook ist der Wert der vollstaendige Endpunkt, auf den
// gepostet wird; ein Empfaenger, der `/hooks/x/` von `/hooks/x` unterscheidet,
// bekaeme sonst still eine andere Adresse als die eingetragene.
function normalizeBaseUrl(value, { keepPath = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ChannelInputError('A base URL is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ChannelInputError('A valid base URL is required.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ChannelInputError('Notification channel URL scheme must be http or https.');
  }
  // Was sich ohne DNS entscheiden laesst, faellt schon beim Speichern: localhost,
  // reservierte Suffixe und ein Literal aus einem privaten Netz. Die Antwort auf
  // ein Formular ist der Ort, an dem ein Admin den Schalter erfaehrt - bei der
  // Zustellung Stunden spaeter liest sie niemand. Die Namensaufloesung prueft
  // guardedFetch beim Senden, je Verbindung (GHSA-f4w5-ggcc-7m5c).
  const host = normalizeHostname(url.hostname);
  if (!isPrivateNetworkAllowed() && (isBlockedHostname(host) || (isIP(host) && isBlockedAddress(host)))) {
    throw new ChannelInputError(`Notification channel URL must not point to a private or local network address (set ${ENV_ALLOW_PRIVATE_NETWORK}=true to allow it).`);
  }
  if (keepPath) return url.toString();
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function normalizeProvider(provider) {
  const value = String(provider ?? '').trim().toLowerCase();
  if (!PROVIDER_IDS.has(value)) throw new ChannelInputError('Unknown notification provider.');
  return value;
}

function normalizeScope(scope) {
  const value = String(scope ?? 'household').trim() || 'household';
  if (!['household', 'user'].includes(value)) throw new ChannelInputError('Invalid notification channel scope.');
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
  if (requireSecrets && !secrets.appToken) throw new ChannelInputError('Gotify app token is required.');
}

function normalizeNtfyConfig(input = {}) {
  const authType = String(input.authType ?? 'none').trim().toLowerCase();
  const priority = String(input.priority ?? 'default').trim().toLowerCase();
  if (!NTFY_AUTH_TYPES.has(authType)) throw new ChannelInputError('Invalid ntfy auth type.');
  if (!NTFY_PRIORITIES.has(priority)) throw new ChannelInputError('Invalid ntfy priority.');
  const topic = String(input.topic ?? '').trim();
  if (!topic) throw new ChannelInputError('ntfy topic is required.');
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
    throw new ChannelInputError('ntfy token is required for token authentication.');
  }
  if (config.authType === 'basic' && requireSecrets && (!secrets.username || !secrets.password)) {
    throw new ChannelInputError('ntfy username and password are required for basic authentication.');
  }
}

const MAX_WEBHOOK_TEMPLATE_LENGTH = 4096;

// Probewerte mit genau den Zeichen, an denen eine naive Ersetzung zerbricht:
// Anfuehrungszeichen, Backslash, Zeilenumbruch. Waeren sie harmlos, ginge die
// Gegenprobe unten durch und der Fehler kaeme erst bei der ersten Zustellung.
const WEBHOOK_TEMPLATE_SAMPLE = Object.freeze({
  title: 'Yuvomi "Test"',
  body: 'Zeile 1\nZeile 2 \\ Ende',
  url: '/tasks',
  tag: 'reminder-1',
});

function normalizeWebhookConfig(input = {}) {
  const payloadTemplate = String(input.payloadTemplate ?? '').trim();
  if (payloadTemplate) {
    if (payloadTemplate.length > MAX_WEBHOOK_TEMPLATE_LENGTH) {
      throw new ChannelInputError(`Webhook payload template must be at most ${MAX_WEBHOOK_TEMPLATE_LENGTH} characters.`);
    }
    const unknown = unknownTemplatePlaceholders(payloadTemplate);
    if (unknown.length) {
      throw new ChannelInputError(
        `Unknown webhook placeholder(s): ${unknown.map((k) => `{{${k}}}`).join(', ')}. `
        + `Available: ${WEBHOOK_TEMPLATE_PLACEHOLDERS.map((k) => `{{${k}}}`).join(', ')}.`,
      );
    }
    // Gegenprobe beim Speichern statt beim Senden: eine Vorlage, die erst in der
    // Nacht am fehlenden Komma scheitert, kostet die Benachrichtigung UND die
    // Diagnose. Der Fehler gehoert an das Formular, in dem sie entstanden ist.
    try {
      JSON.parse(renderPayloadTemplate(payloadTemplate, WEBHOOK_TEMPLATE_SAMPLE));
    } catch {
      throw new ChannelInputError('Webhook payload template must produce valid JSON.');
    }
  }
  return { baseUrl: normalizeBaseUrl(input.baseUrl, { keepPath: true }), payloadTemplate };
}

function normalizeWebhookSecrets(input = {}) {
  return { token: String(input.token ?? '').trim() };
}

/**
 * EINE ADRESSE JE KANAL, keine Liste. Wer zwei Empfaenger will, legt zwei
 * Kanaele an - dann laesst sich jeder einzeln abschalten und einzeln testen.
 * Eine Adressliste in einem Feld nimmt genau das weg: ein Testknopf fuer drei
 * Adressen sagt nicht, welche davon gescheitert ist, und beim Teilversand
 * muesste der Kanal-Status zwei Wahrheiten gleichzeitig tragen.
 *
 * Geprueft wird bewusst nicht gegen RFC 5322 - eine vollstaendige Grammatik
 * lehnt am Ende gueltige Adressen ab. Geprueft wird, was hier schadet: leer,
 * mehrfaches @, Leerraum, fehlende Domain - und Zeilenumbrueche, die aus dem
 * Empfaenger-Header weitere Header machen wuerden.
 *
 * OHNE ZUSAMMENGESETZTE REGEX, und das ist kein Stilentscheid. Die erste
 * Fassung pruefte mit `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, was harmlos aussieht:
 * die beiden Teile hinter dem @ ueberlappen sich aber, denn `[^\s@]` deckt auch
 * den Punkt. Bei einer langen Eingabe OHNE Treffer probiert die Engine jede
 * Aufteilung von "Domain.TLD" durch - quadratischer Aufwand, und Node arbeitet
 * einaedrig: der ganze Server steht so lange. CodeQL hat das als
 * `js/polynomial-redos` gemeldet, zu Recht. Die Pruefungen unten sind linear
 * und sagen dasselbe.
 */
const MAX_EMAIL_LENGTH = 254; // RFC 5321: laenger ist ohnehin keine Adresse.

function normalizeEmailAddress(value) {
  const raw = String(value ?? '').trim();
  const invalid = () => new ChannelInputError('A valid recipient email address is required.');
  if (!raw) throw new ChannelInputError('A recipient email address is required.');
  // Die Laenge zuerst: was hier abprallt, durchlaeuft keine weitere Pruefung.
  if (raw.length > MAX_EMAIL_LENGTH) throw invalid();
  // Deckt Zeilenumbrueche mit ab - ein `\n` im Empfaenger-Header machte aus
  // einer Adresse zwei Header.
  if (/\s/.test(raw)) throw invalid();

  // nodemailer behandelt `to` als LISTE: "a@example.com,postmaster" waeren zwei
  // Empfaenger im Umschlag. Das widerspricht der Zusage oben (eine Adresse je
  // Kanal) und macht die Zustellbuchhaltung falsch - ein Kanal, zwei Ziele, ein
  // Status. Die Trenner gehoeren deshalb abgelehnt, nicht nur die Zaehlung der @.
  if (/[,;]/.test(raw)) throw invalid();

  const at = raw.indexOf('@');
  if (at <= 0) throw invalid();                       // etwas vor dem @, und ueberhaupt eines
  if (raw.indexOf('@', at + 1) !== -1) throw invalid(); // genau eines

  const domain = raw.slice(at + 1);
  const dot = domain.indexOf('.');
  // Ein Punkt, aber weder am Anfang noch am Ende: `a@.de` und `a@de.` sind so
  // wenig eine Domain wie `a@de`.
  if (dot <= 0 || dot === domain.length - 1) throw invalid();
  return raw;
}

function normalizeEmailConfig(input = {}) {
  // Kein baseUrl: der Kanal bringt keinen Endpunkt mit, der SMTP-Zugang steht
  // app-weit in services/email.js. Siehe notification-providers/email.js.
  return { toAddress: normalizeEmailAddress(input.toAddress) };
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
  } else if (provider === 'email') {
    config = normalizeEmailConfig(mergedConfig);
    secrets = {};
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

/**
 * Runs the input checks of a channel (Phase 0 section H). Its own refusals are
 * ChannelInputError (`code: 'notification_channel_invalid'`), which the route
 * sends as a 400; anything else - a TypeError from a malformed body, the
 * database - stays unmarked and goes out as a fixed 500 (#2622).
 */
function checkedInput(input, existing = null) {
  const normalized = normalizeChannelInput(input, existing);
  if (!normalized.name) throw new ChannelInputError('Notification channel name is required.');
  return normalized;
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
    const normalized = checkedInput(input);
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
    const normalized = checkedInput(input, existing);
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
