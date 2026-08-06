/**
 * Modul: Outlook Calendar Push (Microsoft Graph)
 * Zweck: One-Way-Push Yuvomi → Outlook.com für persönliche Microsoft-Konten
 *        (M365 Family / outlook.com). Multi-Account wie caldav_accounts.
 * Abhängigkeiten: server/db.js, server/services/recurrence.js (kein SDK, plain fetch)
 *
 * Architektur-Entscheidung: Anders als Google/CalDAV gibt es KEINEN Handoff zu
 * external_source='outlook'. Gepushte Events bleiben dauerhaft 'local' — ohne
 * Inbound-Sync würde ein Handoff das Event nach dem ersten Push einfrieren.
 * Der Push-Zustand (Graph-Event-ID + Content-Hash) liegt in outlook_event_links;
 * verwaiste Link-Zeilen sind Tombstones für Remote-Deletes.
 */

import { createLogger } from '../logger.js';
const log = createLogger('Outlook');

import crypto from 'node:crypto';
import * as db from '../db.js';
import { parseRRule } from './recurrence.js';
import { visibilityWhere } from './visibility.js';

// /consumers statt /common: die Entra-App ist für "Personal Microsoft accounts
// only" registriert; so kann sich kein Organisations-Konto versehentlich anmelden.
const AUTH_BASE  = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// User.Read wird für GET /me (Anzeigename + E-Mail der Konto-Zeile) benötigt.
const SCOPES = 'offline_access Calendars.ReadWrite User.Read';

// Zeitzone hartkodiert — Parität mit dem Google-Outbound (google-calendar.js).
const TIMEZONE = 'Europe/Berlin';

/** Refresh-Token ist ungültig/abgelaufen — Konto braucht manuellen Reconnect. */
class ReauthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

function envConfig() {
  return {
    clientId:     process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    redirectUri:  process.env.MS_REDIRECT_URI,
  };
}

function isConfigured() {
  const { clientId, clientSecret, redirectUri } = envConfig();
  return !!(clientId && clientSecret && redirectUri);
}

function requireConfig() {
  if (!isConfigured()) {
    throw new Error('[Outlook] MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REDIRECT_URI must be set.');
  }
  return envConfig();
}

/**
 * Für Route-Handler: wirft bei fehlender Konfiguration denselben lauten Fehler
 * wie der Google-Provider (loadAuthorizedClient) — bewusst KEIN stilles
 * Leerergebnis, damit eine fehlende Konfiguration (z. B. frische Installation)
 * im Server-Log sofort auffällt. Der Intervall-Sync bleibt davon unberührt
 * (sync() kehrt ohne Konten weiterhin leise zurück).
 */
function assertConfigured() {
  requireConfig();
}

// --------------------------------------------------------
// Konten
// --------------------------------------------------------

function getAccountById(accountId) {
  return db.get().prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId);
}

function getAllAccounts() {
  return db.get().prepare('SELECT * FROM outlook_accounts').all();
}

function listAccounts() {
  // Tokens bewusst NICHT zurückgeben (Muster caldav-sync.listAccounts).
  return db.get().prepare(`
    SELECT id, name, email, needs_reauth, created_at, last_sync, last_error,
           auto_sync_calendar_id, owner_user_id
    FROM outlook_accounts
    ORDER BY created_at DESC
  `).all().map((acc) => ({
    id: acc.id,
    name: acc.name,
    email: acc.email,
    needsReauth: acc.needs_reauth === 1,
    createdAt: acc.created_at,
    lastSync: acc.last_sync,
    lastError: acc.last_error,
    autoSyncCalendarId: acc.auto_sync_calendar_id,
    ownerUserId: acc.owner_user_id,
  }));
}

/**
 * Partial-Update eines Kontos. Nur übergebene Felder werden geändert;
 * autoSyncCalendarId/ownerUserId akzeptieren null zum Deaktivieren.
 * Der Auto-Sync-Zielkalender muss beschreibbar sein und wird beim Setzen
 * automatisch als Push-Ziel aktiviert (enabled=1).
 */
function updateAccount(accountId, { name, autoSyncCalendarId, ownerUserId } = {}) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('name is required.');
    updates.push('name = ?');
    values.push(trimmed);
  }

  if (autoSyncCalendarId !== undefined) {
    if (autoSyncCalendarId === null || autoSyncCalendarId === '') {
      updates.push('auto_sync_calendar_id = NULL');
    } else {
      if (typeof autoSyncCalendarId !== 'string') {
        throw new Error('autoSyncCalendarId must be a string or null.');
      }
      const cal = db.get().prepare(`
        SELECT can_edit FROM outlook_calendar_selection
        WHERE account_id = ? AND calendar_id = ?
      `).get(accountId, autoSyncCalendarId);
      if (!cal) throw new Error('Calendar not found for this account.');
      if (cal.can_edit !== 1) throw new Error('Calendar is read-only.');
      // Der Auto-Sync-Kalender ist implizit auch als Ziel aktiv.
      db.get().prepare(`
        UPDATE outlook_calendar_selection SET enabled = 1
        WHERE account_id = ? AND calendar_id = ?
      `).run(accountId, autoSyncCalendarId);
      updates.push('auto_sync_calendar_id = ?');
      values.push(autoSyncCalendarId);
    }
  }

  if (ownerUserId !== undefined) {
    if (ownerUserId === null || ownerUserId === '') {
      updates.push('owner_user_id = NULL');
    } else {
      const userId = Number(ownerUserId);
      if (!Number.isInteger(userId) || !db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
        throw new Error('Unknown owner user id.');
      }
      updates.push('owner_user_id = ?');
      values.push(userId);
    }
  }

  if (updates.length === 0) throw new Error('No fields to update.');
  values.push(accountId);
  db.get().prepare(`UPDATE outlook_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return { success: true };
}

function deleteAccount(accountId) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);

  // Bereits gepushte Events bleiben in Outlook stehen (kein Token-Zugriff mehr
  // garantiert); Events mit diesem Ziel werden wieder rein lokal.
  db.get().prepare(`
    UPDATE calendar_events
    SET target_outlook_account_id = NULL, target_outlook_calendar_id = NULL
    WHERE target_outlook_account_id = ?
  `).run(accountId);
  // CASCADE räumt outlook_calendar_selection + outlook_event_links auf.
  db.get().prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);

  log.info(`Deleted Outlook account ${accountId} ("${account.name}").`);
  return { success: true };
}

// --------------------------------------------------------
// OAuth (Authorization Code + Refresh, persönliche Konten)
// --------------------------------------------------------

/**
 * Auth-URL für den Redirect des Admins, mit CSRF-state in der Session.
 * prompt=select_account: mehrere Familienkonten am selben (Admin-)Browser.
 * @param {object} session - Express-Session (state wird dort gespeichert)
 * @returns {string}
 */
function getAuthUrl(session) {
  const { clientId, redirectUri } = requireConfig();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.outlookOAuthState = state;
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    response_mode: 'query',
    scope:         SCOPES,
    state,
    prompt:        'select_account',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(bodyParams, fetchImpl = fetch) {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    ...bodyParams,
  });
  const res = await fetchImpl(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data.error || `HTTP ${res.status}`;
    // invalid_grant: Refresh-Token abgelaufen/widerrufen (MSA rotieren und
    // verfallen nach ~90 Tagen Inaktivität) → Konto braucht Reconnect.
    if (code === 'invalid_grant') {
      throw new ReauthRequiredError(data.error_description || 'invalid_grant');
    }
    throw new Error(`[Outlook] Token request failed: ${code} ${data.error_description || ''}`.trim());
  }
  return data;
}

function expiryFromNow(expiresIn) {
  const seconds = Number(expiresIn) || 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Gültiges Access-Token für ein Konto liefern; refresht bei Ablauf (< 5 min
 * Restlaufzeit). Persistiert IMMER das ggf. rotierte Refresh-Token.
 * Bei invalid_grant: needs_reauth=1 setzen und ReauthRequiredError werfen.
 * @returns {Promise<string>} Access-Token
 */
async function ensureAccessToken(account, fetchImpl = fetch) {
  const expiry = account.token_expiry ? Date.parse(account.token_expiry) : 0;
  if (account.access_token && expiry - Date.now() > 5 * 60_000) {
    return account.access_token;
  }
  let data;
  try {
    data = await tokenRequest(
      { grant_type: 'refresh_token', refresh_token: account.refresh_token },
      fetchImpl
    );
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      db.get().prepare(`
        UPDATE outlook_accounts SET needs_reauth = 1, last_error = ? WHERE id = ?
      `).run(`Reconnect required: ${err.message}`, account.id);
    }
    throw err;
  }
  db.get().prepare(`
    UPDATE outlook_accounts
    SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
        token_expiry = ?, needs_reauth = 0
    WHERE id = ?
  `).run(data.access_token, data.refresh_token || null, expiryFromNow(data.expires_in), account.id);
  return data.access_token;
}

/**
 * OAuth-Callback: Code gegen Tokens tauschen, Konto upserten (Reconnect
 * desselben Microsoft-Kontos ersetzt Tokens statt zu duplizieren) und die
 * Kalenderliste initial laden.
 * @param {string} code
 * @returns {Promise<{accountId: number}>}
 */
async function handleCallback(code, fetchImpl = fetch) {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code }, fetchImpl);
  if (!tokens.refresh_token) {
    throw new Error('[Outlook] No refresh token received - check that offline_access scope is granted.');
  }

  const me = await graphJson('/me?$select=id,displayName,mail,userPrincipalName', tokens.access_token, {}, fetchImpl);
  const email = me.mail || me.userPrincipalName || null;
  const name  = me.displayName || email || 'Outlook';

  const existing = me.id
    ? db.get().prepare('SELECT id FROM outlook_accounts WHERE ms_user_id = ?').get(me.id)
    : null;

  let accountId;
  if (existing) {
    db.get().prepare(`
      UPDATE outlook_accounts
      SET email = ?, access_token = ?, refresh_token = ?, token_expiry = ?,
          needs_reauth = 0, last_error = NULL
      WHERE id = ?
    `).run(email, tokens.access_token, tokens.refresh_token, expiryFromNow(tokens.expires_in), existing.id);
    accountId = existing.id;
    log.info(`Reconnected Outlook account ${accountId} (${email || 'unknown'}).`);
  } else {
    const result = db.get().prepare(`
      INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, me.id || null, email, tokens.access_token, tokens.refresh_token, expiryFromNow(tokens.expires_in));
    accountId = result.lastInsertRowid;
    log.info(`Connected Outlook account ${accountId} (${email || 'unknown'}).`);
  }

  await refreshCalendarSelection(accountId, tokens.access_token, fetchImpl);
  return { accountId };
}

// --------------------------------------------------------
// Graph-HTTP-Helfer
// --------------------------------------------------------

async function graphRequest(path, accessToken, { method = 'GET', body } = {}, fetchImpl = fetch) {
  const doFetch = () => fetchImpl(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let res = await doFetch();
  // Graph-Throttling: einmal Retry-After honorieren, danach gibt der Aufrufer
  // auf (der Intervall-Sync versucht es in 15 min ohnehin erneut).
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 60);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    res = await doFetch();
  }
  return res;
}

async function graphJson(path, accessToken, options = {}, fetchImpl = fetch) {
  const res = await graphRequest(path, accessToken, options, fetchImpl);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || `HTTP ${res.status}`;
    const err = new Error(`[Outlook] Graph request ${options.method || 'GET'} ${path} failed: ${message}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --------------------------------------------------------
// Kalenderauswahl
// --------------------------------------------------------

async function refreshCalendarSelection(accountId, accessToken, fetchImpl = fetch) {
  const calendars = [];
  let path = '/me/calendars?$select=id,name,hexColor,canEdit,isDefaultCalendar&$top=50';
  while (path) {
    const data = await graphJson(path, accessToken, {}, fetchImpl);
    calendars.push(...(data.value || []));
    // @odata.nextLink ist eine absolute URL — auf den Graph-Pfad reduzieren.
    path = data['@odata.nextLink'] ? data['@odata.nextLink'].replace(GRAPH_BASE, '') : null;
  }

  const conn = db.get();
  conn.transaction(() => {
    // enabled-Zustand bekannter Kalender überlebt den Refresh.
    const enabledMap = new Map(
      conn.prepare('SELECT calendar_id, enabled FROM outlook_calendar_selection WHERE account_id = ?')
        .all(accountId).map((r) => [r.calendar_id, r.enabled])
    );
    conn.prepare('DELETE FROM outlook_calendar_selection WHERE account_id = ?').run(accountId);
    const ins = conn.prepare(`
      INSERT INTO outlook_calendar_selection
        (account_id, calendar_id, calendar_name, calendar_color, can_edit, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const cal of calendars) {
      ins.run(
        accountId,
        cal.id,
        cal.name || 'Calendar',
        /^#[0-9a-fA-F]{6}$/.test(cal.hexColor || '') ? cal.hexColor : null,
        cal.canEdit === false ? 0 : 1,
        // Neue Kalender starten deaktiviert: der Connect-Flow soll erst zur Anlage
        // eines dedizierten Zielkalenders führen, statt alles anzubieten.
        enabledMap.get(cal.id) ?? 0
      );
    }
  })();

  log.info(`Refreshed ${calendars.length} calendars for Outlook account ${accountId}.`);
  return listCalendarSelection(accountId);
}

function listCalendarSelection(accountId) {
  return db.get().prepare(`
    SELECT calendar_id, calendar_name, calendar_color, can_edit, enabled
    FROM outlook_calendar_selection
    WHERE account_id = ?
    ORDER BY calendar_name
  `).all(accountId).map((cal) => ({
    calendarId: cal.calendar_id,
    calendarName: cal.calendar_name,
    calendarColor: cal.calendar_color,
    canEdit: cal.can_edit === 1,
    enabled: cal.enabled === 1,
  }));
}

async function listCalendars(accountId, { refresh = false } = {}, fetchImpl = fetch) {
  const account = getAccountById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found.`);
  if (!refresh) return listCalendarSelection(accountId);
  const accessToken = await ensureAccessToken(account, fetchImpl);
  return refreshCalendarSelection(accountId, accessToken, fetchImpl);
}

function setCalendarEnabled(accountId, calendarId, enabled) {
  const result = db.get().prepare(`
    UPDATE outlook_calendar_selection SET enabled = ?
    WHERE account_id = ? AND calendar_id = ?
  `).run(enabled ? 1 : 0, accountId, calendarId);
  if (result.changes === 0) {
    throw new Error(`Calendar not found for account ${accountId}.`);
  }
  return { success: true };
}

// --------------------------------------------------------
// Mapping: lokales Event → Graph-Payload
// --------------------------------------------------------

// JS-Wochentagsnummern (parseRRule/DAY_MAP: 0=SU..6=SA) → Graph-daysOfWeek.
const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Yuvomi-RRULE-Subset → Graph-recurrence ({pattern, range}).
 * MONTHLY mit BYDAY degradiert bewusst zum absoluten Monatstag (PoC-Grenze).
 * @param {string} rrule - RRULE-Body (mit oder ohne "RRULE:"-Prefix)
 * @param {string} startDate - 'YYYY-MM-DD' (DTSTART-Datum)
 * @returns {{pattern: object, range: object}|null}
 */
function rruleToGraphRecurrence(rrule, startDate) {
  const parsed = parseRRule(rrule);
  if (!parsed || !startDate) return null;

  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start.getTime())) return null;

  let pattern;
  if (parsed.freq === 'DAILY') {
    pattern = { type: 'daily', interval: parsed.interval };
  } else if (parsed.freq === 'WEEKLY') {
    const days = parsed.byday.length
      ? parsed.byday.map((d) => GRAPH_DAYS[d])
      : [GRAPH_DAYS[start.getUTCDay()]];
    pattern = { type: 'weekly', interval: parsed.interval, daysOfWeek: days, firstDayOfWeek: 'monday' };
  } else if (parsed.freq === 'MONTHLY') {
    pattern = { type: 'absoluteMonthly', interval: parsed.interval, dayOfMonth: start.getUTCDate() };
  } else if (parsed.freq === 'YEARLY') {
    pattern = {
      type: 'absoluteYearly',
      interval: parsed.interval,
      dayOfMonth: start.getUTCDate(),
      month: start.getUTCMonth() + 1,
    };
  } else {
    return null;
  }

  let range;
  if (parsed.until) {
    range = { type: 'endDate', startDate, endDate: parsed.until.toISOString().slice(0, 10) };
  } else if (parsed.count) {
    range = { type: 'numbered', startDate, numberOfOccurrences: parsed.count };
  } else {
    range = { type: 'noEnd', startDate };
  }
  range.recurrenceTimeZone = TIMEZONE;

  return { pattern, range };
}

// Yuvomi speichert inklusive Ganztags-Enden; Graph verlangt exklusiv
// (Mitternacht-zu-Mitternacht) — +1 Tag (Muster google-calendar.js).
function allDayEndToExclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * DB-Datetime → Graph {dateTime, timeZone}. Lokal angelegte Events sind naive
 * "YYYY-MM-DDTHH:MM" (validate.js) → Sekunden ergänzen, TZ Europe/Berlin.
 * Importierte Events können Z/Offset tragen → nach UTC normalisieren.
 */
function toGraphDateTime(dt) {
  if (!dt) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) {
    return { dateTime: `${dt}:00`, timeZone: TIMEZONE };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dt)) {
    return { dateTime: dt, timeZone: TIMEZONE };
  }
  const parsed = new Date(dt);
  if (isNaN(parsed.getTime())) return { dateTime: dt, timeZone: TIMEZONE };
  return { dateTime: parsed.toISOString().slice(0, 19), timeZone: 'UTC' };
}

/**
 * Lokales calendar_events-Row → Microsoft-Graph-Event-Payload.
 * Zugewiesene Personen erscheinen als Titel-Suffix "Titel (A, B)" — gleiche
 * Konvention wie der ICS-Export-Feed (#482). Da die Namen Teil des Payloads
 * sind, löst eine Zuweisungs-Änderung über den Content-Hash ein PATCH aus.
 * Kein Teilnehmer-/Reminder-/Farb-Mapping (PoC-Umfang).
 */
function localEventToGraph(event, assigneeNames = []) {
  const allDay = !!event.all_day;
  const subject = assigneeNames.length
    ? `${event.title} (${assigneeNames.join(', ')})`
    : event.title;
  const payload = {
    subject,
    body: { contentType: 'text', content: event.description || '' },
  };
  if (event.location) payload.location = { displayName: event.location };

  if (allDay) {
    const startDate = event.start_datetime.slice(0, 10);
    const endDate   = (event.end_datetime || event.start_datetime).slice(0, 10);
    payload.isAllDay = true;
    payload.start = { dateTime: `${startDate}T00:00:00`, timeZone: TIMEZONE };
    payload.end   = { dateTime: `${allDayEndToExclusive(endDate)}T00:00:00`, timeZone: TIMEZONE };
  } else {
    payload.start = toGraphDateTime(event.start_datetime);
    payload.end   = toGraphDateTime(event.end_datetime || event.start_datetime);
  }

  if (event.recurrence_rule) {
    const recurrence = rruleToGraphRecurrence(event.recurrence_rule, event.start_datetime.slice(0, 10));
    if (recurrence) payload.recurrence = recurrence;
  }

  return payload;
}

// Der Payload wird deterministisch aufgebaut — der Hash erkennt inhaltliche
// Änderungen und macht unveränderte Events zu No-Ops (0 Graph-Requests).
function contentHash(payload, calendarId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload) + '|' + calendarId)
    .digest('hex');
}

// --------------------------------------------------------
// Sync (One-Way-Push)
// --------------------------------------------------------

// Zugewiesene Personen alphabetisch als JSON-Array je Event (Muster
// ics-export.js #482) — wird zum Titel-Suffix "Titel (A, B)".
const ASSIGNEE_NAMES_SQL = `(
  SELECT json_group_array(name) FROM (
    SELECT u.display_name AS name
    FROM event_assignments ea JOIN users u ON u.id = ea.user_id
    WHERE ea.event_id = e.id
    ORDER BY u.display_name
  )
) AS assignee_names_json`;

/**
 * Kandidaten eines Kontos: eventId → { event, calendarId }.
 * a) Auto-Sync (falls Zielkalender + Owner gesetzt): alle lokalen, für den
 *    Owner sichtbaren Events → Auto-Kalender. Extern synchronisierte Events
 *    (google/caldav/ics/apple) sind bewusst ausgeschlossen — die hängen
 *    typischerweise schon nativ in Outlook und würden Duplikate erzeugen.
 * b) Explizites Ziel-pro-Termin — gewinnt bei Kollision mit a).
 */
function collectCandidates(conn, account) {
  const candidates = new Map();

  if (account.auto_sync_calendar_id && account.owner_user_id) {
    const rows = conn.prepare(`
      SELECT e.*, ${ASSIGNEE_NAMES_SQL}
      FROM calendar_events e
      WHERE e.external_source = 'local'
        AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
    `).all(account.owner_user_id, account.owner_user_id);
    for (const event of rows) {
      candidates.set(event.id, { event, calendarId: account.auto_sync_calendar_id });
    }
  }

  const explicit = conn.prepare(`
    SELECT e.*, ${ASSIGNEE_NAMES_SQL}
    FROM calendar_events e
    WHERE e.external_source = 'local' AND e.target_outlook_account_id = ?
  `).all(account.id);
  for (const event of explicit) {
    candidates.set(event.id, { event, calendarId: event.target_outlook_calendar_id });
  }

  return candidates;
}

/**
 * id → changeKey aller Events eines Kalenders (Serien zählen als ein Master) —
 * die Basis der Drift-Erkennung, eine (paginierte) Anfrage je Kalender und Lauf.
 * @returns {Promise<Map<string, string|null>|null>} null, wenn das Listing
 *          scheitert; der Push läuft dann ohne Drift-Erkennung weiter.
 */
async function fetchRemoteEventStates(calendarId, accessToken, fetchImpl = fetch) {
  try {
    const states = new Map();
    let path = `/me/calendars/${encodeURIComponent(calendarId)}/events?$select=id,changeKey&$top=500`;
    while (path) {
      const data = await graphJson(path, accessToken, {}, fetchImpl);
      for (const ev of data.value || []) states.set(ev.id, ev.changeKey ?? null);
      path = data['@odata.nextLink'] ? data['@odata.nextLink'].replace(GRAPH_BASE, '') : null;
    }
    return states;
  } catch (err) {
    log.warn(`Drift check failed for calendar ${calendarId}:`, err.message);
    return null;
  }
}

/**
 * Pusht je Konto die Kandidatenmenge (Auto-Sync + explizite Ziele) in die
 * Zielkalender, löscht Remote-Events, deren lokales Event aus der Menge
 * gefallen ist (gelöscht, Sichtbarkeit verloren, Auto-Sync deaktiviert), und
 * setzt in Outlook veränderte oder gelöschte Termine auf den Yuvomi-Stand
 * zurück (changeKey-Reconciliation - Yuvomi ist Source of Truth).
 * Kein Inbound. Konto-Fehler brechen nur das jeweilige Konto ab.
 * @param {{fetchImpl?: typeof fetch}} [options] - fetch injizierbar (Tests)
 */
async function sync({ fetchImpl = fetch } = {}) {
  const accounts = getAllAccounts();
  if (accounts.length === 0) {
    log.debug('No Outlook accounts configured.');
    return { success: true, syncedAccounts: 0, pushed: 0, updated: 0, deleted: 0 };
  }
  if (!isConfigured()) {
    log.warn('Accounts exist but MS_CLIENT_ID/MS_CLIENT_SECRET/MS_REDIRECT_URI are not set - skipping.');
    return { success: false, syncedAccounts: 0, pushed: 0, updated: 0, deleted: 0 };
  }

  const conn = db.get();
  const selLink = conn.prepare('SELECT * FROM outlook_event_links WHERE event_id = ? AND account_id = ?');
  const insLink = conn.prepare(`
    INSERT INTO outlook_event_links
      (event_id, account_id, outlook_calendar_id, outlook_event_id, content_hash, outlook_change_key, last_pushed_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL)
    ON CONFLICT(event_id, account_id) DO UPDATE SET
      outlook_calendar_id = excluded.outlook_calendar_id,
      outlook_event_id = excluded.outlook_event_id,
      content_hash = excluded.content_hash,
      outlook_change_key = excluded.outlook_change_key,
      last_pushed_at = excluded.last_pushed_at,
      last_error = NULL
  `);
  const delLink = conn.prepare('DELETE FROM outlook_event_links WHERE event_id = ? AND account_id = ?');
  const setLinkError = conn.prepare('UPDATE outlook_event_links SET last_error = ? WHERE event_id = ? AND account_id = ?');

  let syncedAccounts = 0;
  let pushed = 0;
  let updated = 0;
  let deleted = 0;

  for (const account of accounts) {
    if (account.needs_reauth) {
      // Der Zustand steht in der UI ("Neu verbinden"); alle 15 min ins Log
      // gehört er nicht (No-Op-Log-Konvention, vgl. #601).
      log.debug(`Account ${account.id} needs reconnect, skipping.`);
      continue;
    }
    try {
      const accessToken = await ensureAccessToken(account, fetchImpl);
      const candidates = collectCandidates(conn, account);
      const linkRows = conn.prepare(
        'SELECT * FROM outlook_event_links WHERE account_id = ?'
      ).all(account.id);

      // ------------------------------------------------
      // Drift-Erkennung: je verlinktem Kalender EINMAL id+changeKey listen
      // (eine kleine Anfrage pro Kalender und Lauf). Fehlt ein Event remote,
      // wurde es in Outlook gelöscht; weicht der changeKey ab, wurde es dort
      // verändert - beides setzt der Push unten auf den Yuvomi-Stand zurück.
      // ------------------------------------------------
      const remoteStates = new Map();
      for (const calId of new Set(linkRows.map((l) => l.outlook_calendar_id))) {
        remoteStates.set(calId, await fetchRemoteEventStates(calId, accessToken, fetchImpl));
      }

      // ------------------------------------------------
      // 1) Deletions: Links dieses Kontos, deren Event nicht (mehr) in der
      //    Kandidatenmenge ist. Zuerst, damit Ziel-Wechsel sauber konvergieren.
      // ------------------------------------------------
      const orphans = linkRows.filter((link) => !candidates.has(link.event_id));

      for (const link of orphans) {
        try {
          // Remote nachweislich schon weg → Tombstone ohne Request abräumen.
          const remote = remoteStates.get(link.outlook_calendar_id);
          if (!remote || remote.has(link.outlook_event_id)) {
            const res = await graphRequest(
              `/me/events/${encodeURIComponent(link.outlook_event_id)}`,
              accessToken, { method: 'DELETE' }, fetchImpl
            );
            if (!res.ok && res.status !== 404) {
              throw new Error(`HTTP ${res.status}`);
            }
          }
          delLink.run(link.event_id, link.account_id);
          deleted++;
        } catch (err) {
          log.error(`Failed to delete Outlook event for local event ${link.event_id}:`, err.message);
          setLinkError.run(err.message, link.event_id, link.account_id);
        }
      }

      // ------------------------------------------------
      // 2) Create/Update: Kandidatenmenge dieses Kontos.
      // ------------------------------------------------
      const enabledCalendars = new Map(
        conn.prepare(`
          SELECT calendar_id, can_edit FROM outlook_calendar_selection
          WHERE account_id = ? AND enabled = 1
        `).all(account.id).map((r) => [r.calendar_id, r.can_edit === 1])
      );

      for (const { event, calendarId } of candidates.values()) {
        if (!enabledCalendars.has(calendarId)) {
          log.warn(`Target calendar not enabled for account ${account.id}, skipping event ${event.id}.`);
          continue;
        }
        if (!enabledCalendars.get(calendarId)) {
          log.warn(`Target calendar is read-only, skipping event ${event.id}.`);
          continue;
        }

        const link = selLink.get(event.id, account.id);
        const assigneeNames = event.assignee_names_json ? JSON.parse(event.assignee_names_json) : [];
        const payload = localEventToGraph(event, assigneeNames);
        const hash = contentHash(payload, calendarId);

        // Drift gegen den zuletzt selbst geschriebenen changeKey. Ein Link ohne
        // gespeicherten Key (Alt-Bestand) wird einmalig zurückgesetzt und trägt
        // den Key danach.
        const remote = link ? remoteStates.get(link.outlook_calendar_id) : null;
        const remoteMissing = !!(link && remote && !remote.has(link.outlook_event_id));
        const remoteDrifted = !!(link && remote && !remoteMissing
          && (!link.outlook_change_key || remote.get(link.outlook_event_id) !== link.outlook_change_key));

        try {
          if (!link) {
            const created = await graphJson(
              `/me/calendars/${encodeURIComponent(calendarId)}/events`,
              accessToken, { method: 'POST', body: payload }, fetchImpl
            );
            insLink.run(event.id, account.id, calendarId, created.id, hash, created.changeKey ?? null);
            pushed++;
          } else if (link.outlook_calendar_id !== calendarId) {
            // Zielkalender gewechselt → Delete + Create (Graph-"move" wäre ein
            // eigener Endpoint mit eigenen Fehlerpfaden — Delete+Create genügt).
            const res = await graphRequest(
              `/me/events/${encodeURIComponent(link.outlook_event_id)}`,
              accessToken, { method: 'DELETE' }, fetchImpl
            );
            if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status} on delete`);
            const created = await graphJson(
              `/me/calendars/${encodeURIComponent(calendarId)}/events`,
              accessToken, { method: 'POST', body: payload }, fetchImpl
            );
            insLink.run(event.id, account.id, calendarId, created.id, hash, created.changeKey ?? null);
            updated++;
          } else if (remoteMissing) {
            // In Outlook von Hand gelöscht → Yuvomi ist Source of Truth: neu anlegen.
            const created = await graphJson(
              `/me/calendars/${encodeURIComponent(calendarId)}/events`,
              accessToken, { method: 'POST', body: payload }, fetchImpl
            );
            insLink.run(event.id, account.id, calendarId, created.id, hash, created.changeKey ?? null);
            updated++;
          } else if (link.content_hash !== hash || remoteDrifted) {
            try {
              const patched = await graphJson(
                `/me/events/${encodeURIComponent(link.outlook_event_id)}`,
                accessToken, { method: 'PATCH', body: payload }, fetchImpl
              );
              insLink.run(event.id, account.id, calendarId, link.outlook_event_id, hash, patched.changeKey ?? null);
            } catch (err) {
              // Fallback ohne Drift-Erkennung (Listing fehlgeschlagen): Remote
              // von Hand gelöscht → neu anlegen.
              if (err.status !== 404) throw err;
              const created = await graphJson(
                `/me/calendars/${encodeURIComponent(calendarId)}/events`,
                accessToken, { method: 'POST', body: payload }, fetchImpl
              );
              insLink.run(event.id, account.id, calendarId, created.id, hash, created.changeKey ?? null);
            }
            updated++;
          }
          // Hash unverändert + kein Drift → No-Op (keine weitere Anfrage).
        } catch (err) {
          log.error(`Push failed for event ${event.id} (account ${account.id}):`, err.message);
          if (link) setLinkError.run(err.message, event.id, account.id);
        }
      }

      conn.prepare(`
        UPDATE outlook_accounts SET last_sync = ?, last_error = NULL WHERE id = ?
      `).run(new Date().toISOString(), account.id);
      syncedAccounts++;
    } catch (err) {
      log.error(`Sync failed for account ${account.id}:`, err.message);
      if (!(err instanceof ReauthRequiredError)) {
        conn.prepare('UPDATE outlook_accounts SET last_error = ? WHERE id = ?')
          .run(err.message, account.id);
      }
      // Nächstes Konto weiterversuchen (Muster caldav-sync).
    }
  }

  // Leere Läufe bleiben unter dem Default-Log-Level (No-Op-Konvention, #601).
  const summaryLevel = pushed + updated + deleted > 0 ? 'info' : 'debug';
  log[summaryLevel](`Outlook push complete: ${syncedAccounts}/${accounts.length} accounts, ${pushed} created, ${updated} updated, ${deleted} deleted.`);
  return { success: true, syncedAccounts, pushed, updated, deleted };
}

function getStatus() {
  const accounts = listAccounts().map((acc) => ({
    ...acc,
    enabledCalendars: db.get().prepare(
      'SELECT COUNT(*) AS count FROM outlook_calendar_selection WHERE account_id = ? AND enabled = 1'
    ).get(acc.id).count,
  }));
  return {
    configured: isConfigured(),
    accounts,
    totalAccounts: accounts.length,
  };
}

export {
  getAuthUrl,
  handleCallback,
  sync,
  getStatus,
  listAccounts,
  updateAccount,
  deleteAccount,
  listCalendars,
  listCalendarSelection,
  setCalendarEnabled,
  assertConfigured,
};

export const __test = {
  rruleToGraphRecurrence,
  allDayEndToExclusive,
  toGraphDateTime,
  localEventToGraph,
  contentHash,
  collectCandidates,
  fetchRemoteEventStates,
  ensureAccessToken,
  refreshCalendarSelection,
  ReauthRequiredError,
};
