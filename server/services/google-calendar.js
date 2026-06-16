/**
 * Modul: Google Calendar Sync
 * Zweck: OAuth 2.0 + bidirektionaler Sync mit Google Calendar API v3
 * Abhängigkeiten: googleapis, server/db.js
 *
 * sync_config-Schlüssel:
 *   google_access_token   - OAuth Access Token
 *   google_refresh_token  - OAuth Refresh Token (langlebig)
 *   google_token_expiry   - ISO-8601-Timestamp bis wann Access Token gültig ist
 *   google_sync_token     - Inkrementeller Sync-Token von Google (events.list)
 *   google_last_sync      - ISO-8601-Timestamp des letzten erfolgreichen Syncs
 *   google_calendar_id    - ID des zu synchronisierenden Kalenders (Default: 'primary')
 */

import { createLogger } from '../logger.js';
const log = createLogger('Google');

import { google } from 'googleapis';
import crypto from 'node:crypto';
import * as db from '../db.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';

const GOOGLE_COLOR = '#4285F4';

function upsertExternalCalendar(source, externalId, name, color) {
  // Provider-Namen können HTML-entity-encoded sein (Google liefert das z. B. für
  // Import-Kalender) — zu Klartext normalisieren, sonst escaped die UI doppelt.
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, decodeHtmlEntities(name), color);
  return row.id;
}

// --------------------------------------------------------
// OAuth2-Client (lazy initialisiert)
// --------------------------------------------------------

function createClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('[Google] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// --------------------------------------------------------
// sync_config Helfer
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDel(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

function isReadonly() {
  return cfgGet('google_readonly') === '1';
}

function setReadonly(enabled) {
  if (enabled) {
    cfgSet('google_readonly', '1');
  } else {
    cfgDel('google_readonly');
  }
}

/** Nur owner/writer dürfen via events.insert beschrieben werden. */
function isWritableRole(role) {
  return role === 'owner' || role === 'writer';
}

// --------------------------------------------------------
// Kalenderauswahl (Mehrkalender, Issue #237)
// --------------------------------------------------------

/** Alle bekannten Kalenderauswahl-Zeilen. */
function listSelection() {
  return db.get().prepare(
    'SELECT calendar_id, name, color, enabled, sync_token, last_sync FROM google_calendar_selection'
  ).all();
}

/** IDs der aktuell aktivierten Kalender. */
function enabledCalendarIds() {
  return db.get().prepare(
    'SELECT calendar_id FROM google_calendar_selection WHERE enabled = 1'
  ).all().map((r) => r.calendar_id);
}

/**
 * Aktiviert/deaktiviert einen Kalender. Beim Aktivieren werden name/color
 * (sofern übergeben) als Metadaten gespeichert. Beim Deaktivieren werden die
 * importierten Events dieses Kalenders entfernt und der Sync-Token zurückgesetzt,
 * damit ein erneutes Aktivieren sauber von Grund auf neu liest.
 * @param {string} calendarId
 * @param {boolean} enabled
 * @param {{name?:string,color?:string}} [meta]
 */
function setCalendarEnabled(calendarId, enabled, meta = {}) {
  if (typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    throw new Error('[Google] calendarId fehlt oder ist ungültig.');
  }
  const id = calendarId.trim();
  const flag = enabled ? 1 : 0;

  db.get().prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, color, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(calendar_id) DO UPDATE SET
      enabled = excluded.enabled,
      name    = COALESCE(excluded.name, google_calendar_selection.name),
      color   = COALESCE(excluded.color, google_calendar_selection.color)
  `).run(id, meta.name || id, meta.color || null, flag);

  if (!enabled) {
    db.get().prepare(`
      DELETE FROM calendar_events
      WHERE external_source = 'google' AND calendar_ref_id IN (
        SELECT id FROM external_calendars WHERE source = 'google' AND external_id = ?
      )
    `).run(id);
    db.get().prepare(
      'UPDATE google_calendar_selection SET sync_token = NULL, last_sync = NULL WHERE calendar_id = ?'
    ).run(id);
  }
}

/** Per-Kalender-Sync-Token + last_sync nach erfolgreichem Inbound speichern. */
function recordSyncToken(calendarId, token) {
  db.get().prepare(`
    UPDATE google_calendar_selection
    SET sync_token = ?, last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE calendar_id = ?
  `).run(token, calendarId);
}

function getSyncToken(calendarId) {
  const row = db.get().prepare(
    'SELECT sync_token FROM google_calendar_selection WHERE calendar_id = ?'
  ).get(calendarId);
  return row ? row.sync_token : null;
}

/**
 * Listet die für den verbundenen Account verfügbaren Google-Kalender.
 * @returns {Promise<Array<{id,summary,primary,backgroundColor,enabled,accessRole,writable}>>}
 */
async function listCalendars() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });
  const enabledSet = new Set(enabledCalendarIds());

  const items = [];
  let pageToken;
  do {
    const res = await calendar.calendarList.list({ pageToken, maxResults: 250 });
    for (const cal of res.data.items || []) {
      items.push({
        id:              cal.id,
        summary:         cal.summaryOverride || cal.summary || cal.id,
        primary:         !!cal.primary,
        backgroundColor: cal.backgroundColor || GOOGLE_COLOR,
        enabled:         enabledSet.has(cal.id),
        accessRole:      cal.accessRole ?? null,
        writable:        isWritableRole(cal.accessRole),
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

// --------------------------------------------------------
// Client mit gespeicherten Tokens laden
// --------------------------------------------------------

function loadAuthorizedClient() {
  const accessToken  = cfgGet('google_access_token');
  const refreshToken = cfgGet('google_refresh_token');

  if (!accessToken || !refreshToken) {
    throw new Error('[Google] Not configured - complete OAuth first.');
  }

  const client = createClient();
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   cfgGet('google_token_expiry') ? parseInt(cfgGet('google_token_expiry'), 10) : undefined,
  });

  // Token-Refresh automatisch speichern
  client.on('tokens', (tokens) => {
    if (tokens.access_token) cfgSet('google_access_token', tokens.access_token);
    if (tokens.expiry_date)  cfgSet('google_token_expiry', String(tokens.expiry_date));
  });

  return client;
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * @returns {string} Auth-URL
 */
/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * Enthalt einen CSRF-sicheren state-Parameter.
 * @param {object} session - Express-Session-Objekt (state wird dort gespeichert)
 * @returns {string} Auth-URL
 */
function getAuthUrl(session) {
  const client = createClient();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.googleOAuthState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

/**
 * OAuth-Callback: tauscht Code gegen Tokens, speichert in sync_config.
 * @param {string} code - Code aus dem OAuth-Callback-Query-Parameter
 */
async function handleCallback(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('[Google] No refresh token received. Revoke access in your Google account and connect again.');
  }

  cfgSet('google_access_token',  tokens.access_token);
  cfgSet('google_refresh_token', tokens.refresh_token);
  if (tokens.expiry_date) cfgSet('google_token_expiry', String(tokens.expiry_date));

  log.info('OAuth successful - tokens saved.');
}

/**
 * Verbindungsstatus zurückgeben.
 * @returns {{ configured: boolean, connected: boolean, lastSync: string|null }}
 */
function getStatus() {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
  const connected  = !!(cfgGet('google_access_token') && cfgGet('google_refresh_token'));
  const lastSync   = cfgGet('google_last_sync');
  return {
    configured,
    connected,
    lastSync,
    selectedCount: enabledCalendarIds().length,
    readonly: isReadonly(),
  };
}

/**
 * Tokens und Sync-State löschen (Verbindung trennen).
 */
function disconnect() {
  ['google_access_token', 'google_refresh_token', 'google_token_expiry',
   'google_last_sync', 'google_readonly'].forEach(cfgDel);
  db.get().prepare('DELETE FROM google_calendar_selection').run();
  log.info('Disconnected.');
}

/**
 * Bidirektionaler Sync.
 * Inbound:  Google → lokale DB (Upsert via external_calendar_id)
 * Outbound: lokale Termine (external_source='local', external_calendar_id IS NULL) → Google
 */
async function sync() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  const calendarIds = enabledCalendarIds();
  // accessRole je Kalender, memoisiert über Inbound + Outbound hinweg.
  const roleCache = new Map();

  // --------------------------------------------------------
  // Inbound: jeder aktivierte Kalender mit eigenem syncToken
  // --------------------------------------------------------
  for (const calendarId of calendarIds) {
    let calRefId = null;
    let calColor = GOOGLE_COLOR;
    try {
      const meta = await calendar.calendarList.get({ calendarId });
      calColor   = meta.data.backgroundColor || GOOGLE_COLOR;
      roleCache.set(calendarId, meta.data.accessRole ?? null);
      const calName = meta.data.summaryOverride || meta.data.summary || 'Google Calendar';
      calRefId   = upsertExternalCalendar('google', calendarId, calName, calColor);
    } catch (err) {
      log.warn(`Calendar metadata is not accessible (${calendarId}):`, err.message);
    }

    let syncToken    = getSyncToken(calendarId);
    let pageToken    = undefined;
    let newSyncToken = null;

    do {
      const listParams = { calendarId, singleEvents: true, pageToken };
      if (syncToken) {
        listParams.syncToken = syncToken;
      } else {
        listParams.timeMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        listParams.timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      }

      let response;
      try {
        response = await calendar.events.list(listParams);
      } catch (err) {
        if (err.code === 410) {
          log.warn(`syncToken invalid (${calendarId}) - full resync.`);
          recordSyncToken(calendarId, null);
          syncToken = null;
          continue;
        }
        throw err;
      }

      upsertGoogleEvents(response.data.items || [], calRefId, calColor);
      pageToken    = response.data.nextPageToken;
      newSyncToken = response.data.nextSyncToken || newSyncToken;
    } while (pageToken);

    if (newSyncToken) recordSyncToken(calendarId, newSyncToken);
  }

  // --------------------------------------------------------
  // Outbound: nur lokale Events mit explizitem Google-Ziel
  // --------------------------------------------------------
  if (isReadonly()) {
    log.info('Read-only mode – outbound sync skipped.');
  } else {
    const localEvents = db.get().prepare(`
      SELECT * FROM calendar_events
      WHERE external_source = 'local' AND target_google_calendar_id IS NOT NULL
    `).all();

    const activeIds = new Set(calendarIds);
    for (const event of localEvents) {
      const targetId = event.target_google_calendar_id;
      if (!activeIds.has(targetId)) {
        log.warn(`Target calendar ${targetId} not active, skipping event ${event.id}.`);
        continue;
      }
      let role = roleCache.get(targetId);
      if (role === undefined) {
        // Inbound metadata fetch failed for this calendar; treat as not writable.
        role = null;
      }
      if (!isWritableRole(role)) {
        log.warn(`Target calendar ${targetId} has no writable role (role=${role}), skipping event ${event.id}.`);
        continue;
      }
      try {
        const gEvent  = localEventToGoogle(event);
        const created = await calendar.events.insert({ calendarId: targetId, requestBody: gEvent });
        const calRefId = upsertExternalCalendar('google', targetId, targetId, GOOGLE_COLOR);
        db.get().prepare(`
          UPDATE calendar_events
          SET external_calendar_id = ?, external_source = 'google', calendar_ref_id = ?
          WHERE id = ?
        `).run(created.data.id, calRefId, event.id);
      } catch (err) {
        log.error(`Outbound error for event ${event.id}:`, err.message);
      }
    }
    log.info(`Sync completed - ${localEvents.length} candidate local → Google.`);
  }

  cfgSet('google_last_sync', new Date().toISOString());
}

// Google Calendar uses exclusive end dates for all-day events (RFC 5545).
// A 2-day event Jan 1–2 is stored as end.date = "2026-01-03" (exclusive).
// Subtract 1 day to convert to Yuvomi-style inclusive end date.
function googleAllDayEndToInclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Yuvomi stores inclusive end dates. Add 1 day when sending to Google (exclusive).
function localAllDayEndToExclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------
// Helfer: Google-Event in lokale DB upserten
// --------------------------------------------------------

function upsertGoogleEvents(items, calRefId = null, calColor = GOOGLE_COLOR) {
  const del = db.get().prepare(`
    DELETE FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'google'
  `);

  const insertOrUpdate = db.get().transaction((item) => {
    if (item.status === 'cancelled') {
      del.run(item.id);
      return;
    }

    const allDay      = !!(item.start?.date && !item.start?.dateTime);
    const startDt     = allDay ? item.start.date : (item.start?.dateTime || item.start?.date);
    const endDt       = allDay
      ? googleAllDayEndToInclusive(item.end?.date)
      : (item.end?.dateTime || item.end?.date || null);
    const title       = item.summary || '(kein Titel)';
    const description = item.description || null;
    const location    = item.location    || null;
    const rrule       = item.recurrence  ? item.recurrence[0] : null;

    const existing = db.get().prepare(
      'SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = ?'
    ).get(item.id, 'google');

    if (existing) {
      // color wird bewusst NICHT aktualisiert: benutzerdefinierte Event-Farben
      // sollen über Syncs hinweg erhalten bleiben (Issue #219). Die Kalenderfarbe
      // dient nur als Default beim ersten Import (INSERT).
      db.get().prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, recurrence_rule = ?, calendar_ref_id = ?
        WHERE id = ?
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, rrule, calRefId, existing.id);
    } else {
      db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, external_calendar_id, external_source, recurrence_rule, calendar_ref_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, ?, 1)
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, calColor, item.id, rrule, calRefId);
    }
  });

  for (const item of items) {
    if (!item) continue;
    try {
      insertOrUpdate(item);
    } catch (err) {
      log.error(`Upsert error for event ${item?.id}:`, err.message);
    }
  }
}

// Yuvomi speichert getimte Events als "YYYY-MM-DDTHH:MM" (ohne Sekunden,
// siehe validate.js). Die Google Calendar API verlangt RFC 3339 mit
// Sekunden, sonst "Bad Request" bzw. bei Wiederholungen "Invalid
// recurrence rule" (Issue #217). Sekunden ergänzen, falls sie fehlen.
function toRfc3339(dt) {
  if (!dt) return dt;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt) ? `${dt}:00` : dt;
}

// RFC 5545: Der Werttyp von UNTIL muss dem von DTSTART entsprechen.
// buildRRule liefert UNTIL immer als DATE-TIME (YYYYMMDDTHHMMSSZ).
//   - all-day-Events (start.date):    UNTIL muss DATE sein (YYYYMMDD)
//   - getimte Events (start.dateTime): UNTIL muss UTC DATE-TIME sein
// Andernfalls lehnt Google die Recurrence ab ("Invalid recurrence rule").
function normalizeRecurrenceUntil(rule, allDay) {
  return rule.split(';').map((segment) => {
    const eq = segment.indexOf('=');
    if (eq === -1) return segment;
    if (segment.slice(0, eq).toUpperCase() !== 'UNTIL') return segment;
    const digits   = segment.slice(eq + 1).replace(/\D/g, '');
    const datePart = digits.slice(0, 8);
    if (allDay) return `UNTIL=${datePart}`;
    const timePart = digits.length > 8 ? digits.slice(8, 14).padEnd(6, '0') : '235959';
    return `UNTIL=${datePart}T${timePart}Z`;
  }).join(';');
}

function localEventToGoogle(event) {
  const allDay = !!event.all_day;
  const gEvent = {
    summary:     event.title,
    description: event.description || undefined,
    location:    event.location    || undefined,
  };

  if (allDay) {
    const startDate = event.start_datetime.slice(0, 10);
    const endDate   = event.end_datetime ? event.end_datetime.slice(0, 10) : startDate;
    gEvent.start = { date: startDate };
    gEvent.end   = { date: localAllDayEndToExclusive(endDate) };
  } else {
    const startDt = toRfc3339(event.start_datetime);
    const endDt   = toRfc3339(event.end_datetime) || startDt;
    gEvent.start = { dateTime: startDt, timeZone: 'Europe/Berlin' };
    gEvent.end   = { dateTime: endDt,   timeZone: 'Europe/Berlin' };
  }

  if (event.recurrence_rule) {
    const body = event.recurrence_rule.startsWith('RRULE:')
      ? event.recurrence_rule.slice('RRULE:'.length)
      : event.recurrence_rule;
    gEvent.recurrence = [`RRULE:${normalizeRecurrenceUntil(body, allDay)}`];
  }

  return gEvent;
}

export { getAuthUrl, handleCallback, getStatus, disconnect, sync, listCalendars,
         listSelection, setCalendarEnabled, setReadonly };
export const __test = {
  localEventToGoogle, googleAllDayEndToInclusive, localAllDayEndToExclusive,
  upsertGoogleEvents, upsertExternalCalendar, setReadonly, isReadonly, isWritableRole,
  listSelection, setCalendarEnabled, recordSyncToken, getSyncToken, enabledCalendarIds,
};
