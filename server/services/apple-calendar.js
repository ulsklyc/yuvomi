/**
 * Modul: Apple Calendar Sync (CalDAV)
 * Zweck: Bidirektionaler Sync mit iCloud Calendar via CalDAV-Protokoll
 * Abhängigkeiten: tsdav (ESM - dynamisch importiert), server/db.js
 *
 * Konfiguration (.env):
 *   APPLE_CALDAV_URL              - z.B. https://caldav.icloud.com
 *   APPLE_USERNAME                - Apple-ID E-Mail
 *   APPLE_APP_SPECIFIC_PASSWORD   - App-spezifisches Passwort aus appleid.apple.com
 *
 * sync_config-Schlüssel:
 *   apple_last_sync - ISO-8601-Timestamp des letzten Syncs
 */

import { createLogger } from '../logger.js';
const log = createLogger('Apple');

import * as db from '../db.js';
import { unfoldLines, parseICS, formatICSDate, tzLocalToUTC, applyDuration } from './ics-parser.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';

const APPLE_COLOR = '#FC3C44';

// --------------------------------------------------------
// Externe Kalender-Metadaten upserten
// --------------------------------------------------------

function normalizeCalColor(c) {
  if (!c) return null;
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7); // strip alpha
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return null;
}

function upsertExternalCalendar(source, externalId, name, color) {
  // Provider-Namen können HTML-entity-encoded sein — zu Klartext normalisieren,
  // sonst escaped die UI doppelt (z. B. literales "&amp;").
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

// --------------------------------------------------------
// Credentials: sync_config hat Vorrang vor .env
// --------------------------------------------------------

function getCredentials() {
  const url      = cfgGet('apple_caldav_url')      || process.env.APPLE_CALDAV_URL;
  const username = cfgGet('apple_username')         || process.env.APPLE_USERNAME;
  const password = cfgGet('apple_app_password')     || process.env.APPLE_APP_SPECIFIC_PASSWORD;
  if (!url || !username || !password) return null;
  return { url, username, password };
}

function saveCredentials(url, username, password) {
  // Warnung wenn DB-Verschluesselung nicht aktiv - Credentials liegen dann im Klartext
  if (!process.env.DB_ENCRYPTION_KEY) {
    log.warn('WARNING: DB_ENCRYPTION_KEY is not set - CalDAV credentials will be stored unencrypted.');
  }
  cfgSet('apple_caldav_url',  url);
  cfgSet('apple_username',    username);
  cfgSet('apple_app_password', password);
}

function clearCredentials() {
  ['apple_caldav_url', 'apple_username', 'apple_app_password', 'apple_last_sync'].forEach(cfgDel);
  log.info('Disconnected.');
}

// --------------------------------------------------------
// Verbindungsstatus
// --------------------------------------------------------

function getStatus() {
  const creds     = getCredentials();
  const configured = !!creds;
  const connected  = !!(cfgGet('apple_caldav_url')); // via UI gespeichert
  const lastSync   = cfgGet('apple_last_sync');
  return { configured, connected, lastSync };
}

/**
 * Verbindungstest: CalDAV-Client erstellen und Kalender abrufen.
 * Wirft einen Fehler wenn die Credentials ungültig sind.
 */
async function testConnection() {
  const creds = getCredentials();
  if (!creds) throw new Error('[Apple] No credentials configured.');

  const { createDAVClient } = await import('tsdav');
  const client = await createDAVClient({
    serverUrl:          creds.url,
    credentials:        { username: creds.username, password: creds.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });

  const calendars = await client.fetchCalendars();
  if (!calendars.length) throw new Error('[Apple] Connected, but no calendars found.');
  return { ok: true, calendarCount: calendars.length };
}

// --------------------------------------------------------
// Minimaler ICS-Builder
// --------------------------------------------------------

/**
 * Erstellt einen minimalen ICS-String für ein lokales Event.
 * @param {{ id, title, description, start_datetime, end_datetime, all_day, location, recurrence_rule }} event
 * @returns {string}
 */
function buildICS(event) {
  const uid   = `oikos-${event.id}@oikos.local`;
  const now   = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Familienplaner//DE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeICS(event.title)}`,
  ];

  if (event.all_day) {
    const startDate = event.start_datetime.slice(0, 10).replace(/-/g, '');
    // RFC 5545: DTEND for VALUE=DATE is exclusive - add one day
    const endSrc = (event.end_datetime || event.start_datetime).slice(0, 10);
    const endD   = new Date(endSrc + 'T00:00:00');
    endD.setDate(endD.getDate() + 1);
    const endDate = `${endD.getFullYear()}${String(endD.getMonth() + 1).padStart(2, '0')}${String(endD.getDate()).padStart(2, '0')}`;
    lines.push(`DTSTART;VALUE=DATE:${startDate}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
  } else {
    const startDt = event.start_datetime.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const endDt   = (event.end_datetime || event.start_datetime).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    lines.push(`DTSTART:${startDt}`);
    lines.push(`DTEND:${endDt}`);
  }

  if (event.description) lines.push(`DESCRIPTION:${escapeICS(event.description)}`);
  if (event.location)    lines.push(`LOCATION:${escapeICS(event.location)}`);
  if (event.recurrence_rule) lines.push(event.recurrence_rule); // z.B. RRULE:FREQ=WEEKLY;BYDAY=MO

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function escapeICS(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeICS(str) {
  if (!str) return str;
  return str
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\,/g,  ',')
    .replace(/\\;/g,  ';')
    .replace(/\\\\/g, '\\');
}

// --------------------------------------------------------
// Sync
// --------------------------------------------------------

/**
 * Bidirektionaler CalDAV-Sync mit iCloud.
 * Inbound:  iCloud → lokale DB (Upsert via external_calendar_id = UID)
 * Outbound: lokale Termine (external_source='local', external_calendar_id IS NULL) → iCloud
 */
async function sync() {
  const creds = getCredentials();
  if (!creds) {
    throw new Error('[Apple] No credentials configured (neither in DB nor in .env).');
  }

  // tsdav ist eine optionale Abhängigkeit - dynamischer Import für graceful degradation
  const { createDAVClient } = await import('tsdav');

  const client = await createDAVClient({
    serverUrl:          creds.url,
    credentials:        { username: creds.username, password: creds.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
  });

  const calendars = await client.fetchCalendars();
  if (!calendars.length) {
    log.warn('No calendars found.');
    return;
  }

  // created_by: ersten existierenden User verwenden (nicht hardcoded ID 1)
  const owner = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  if (!owner) {
    log.warn('No user in database - sync skipped.');
    return;
  }
  const createdBy = owner.id;

  // Alle Kalender synchen (inklusive Geburtstags-Kalender)
  const syncCalendars = calendars;

  let totalObjects = 0;

  for (const cal of syncCalendars) {
    let calObjects;
    try {
      calObjects = await client.fetchCalendarObjects({ calendar: cal });
    } catch (err) {
      log.warn(`Calendar "${cal.displayName || '(unnamed)'}" is not accessible: ${err.message}`);
      continue;
    }

    totalObjects += calObjects.length;

    // Kalender-Metadaten in external_calendars upserten
    const calColor = normalizeCalColor(cal.calendarColor) || APPLE_COLOR;
    const calName  = cal.displayName || 'Apple Calendar';
    const calRefId = upsertExternalCalendar('apple', cal.url, calName, calColor);

    // --------------------------------------------------------
    // Inbound: iCloud → lokal
    // --------------------------------------------------------
    for (const obj of calObjects) {
      const parsed = parseICS(obj.data || '');
      for (const ev of parsed) {
        try {
          const existing = db.get().prepare(
            `SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'apple'`
          ).get(ev.uid);

          if (existing) {
            db.get().prepare(`
              UPDATE calendar_events
              SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
                  all_day = ?, location = ?, recurrence_rule = ?, color = ?, calendar_ref_id = ?
              WHERE id = ?
            `).run(
              ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, ev.rrule, calColor, calRefId, existing.id
            );
          } else {
            db.get().prepare(`
              INSERT INTO calendar_events
                (title, description, start_datetime, end_datetime, all_day,
                 location, color, external_calendar_id, external_source, recurrence_rule, calendar_ref_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apple', ?, ?, ?)
            `).run(
              ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, calColor, ev.uid, ev.rrule, calRefId, createdBy
            );
          }
        } catch (err) {
          log.error(`Upsert error for UID ${ev.uid}:`, err.message);
        }
      }
    }
  }

  // --------------------------------------------------------
  // Outbound: lokal → iCloud (erster verfügbarer Kalender)
  // --------------------------------------------------------
  const defaultCal = syncCalendars[0];
  const localEvents = db.get().prepare(`
    SELECT * FROM calendar_events
    WHERE external_source = 'local' AND external_calendar_id IS NULL
  `).all();

  for (const event of localEvents) {
    try {
      const icsData  = buildICS(event);
      const uid      = `oikos-${event.id}@oikos.local`;
      const filename = `${uid}.ics`;

      await client.createCalendarObject({
        calendar:     defaultCal,
        filename,
        iCalString:   icsData,
      });

      db.get().prepare(`
        UPDATE calendar_events SET external_calendar_id = ?, external_source = 'apple' WHERE id = ?
      `).run(uid, event.id);
    } catch (err) {
      log.error(`Outbound error for event ${event.id}:`, err.message);
    }
  }

  cfgSet('apple_last_sync', new Date().toISOString());
  log.info(`Sync completed - ${totalObjects} objects from ${syncCalendars.length} calendars inbound, ${localEvents.length} local → iCloud.`);
}

export { sync, getStatus, saveCredentials, clearCredentials, testConnection };
