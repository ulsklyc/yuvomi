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
 *   apple_last_error    - Fehlermeldung des letzten Laufs, fehlt nach einem sauberen (#820)
 *   apple_last_error_at - ISO-8601-Timestamp dieses Fehlers
 */

import { createLogger } from '../logger.js';
const log = createLogger('Apple');

import * as db from '../db.js';
import { assignDefaultToEvent } from './sync-assignment.js';
import { pruneDeletedEvents, countSourceEvents, deleteSourceEvents } from './calendar-prune.js';
import { readSyncOutcome, withSyncOutcome } from './sync-outcome.js';
import { runSerialized } from '../utils/sync-lock.js';
import { unfoldLines, parseICS, formatICSDate, tzLocalToUTC, applyDuration, normalizeRecurrenceOverrides } from './ics-parser.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';
import * as outbound from './calendar-outbound.js';
import { processPendingDeletions, processPendingUpdates, flushAccount } from './caldav-outbound.js';
import { rruleLine } from './recurrence.js';
import { eventDateTimeFields } from '../utils/ics-datetime.js';
import { vtimezoneFor } from '../utils/vtimezone.js';
import { householdTimeZone } from '../utils/timezone.js';
import { createCalDAVClient } from '../utils/caldav-client.js';
import { nearestIcalColorName } from '../utils/ical-color.js';
import { outboundEvent } from './outbound-dtstart.js';

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

/**
 * @param {object} [opts]
 * @param {boolean} [opts.deleteEvents] Gespiegelte Termine mitnehmen (#820).
 * @returns {{ removed: number }}
 */
function clearCredentials({ deleteEvents = false } = {}) {
  // In einer Transaktion, damit nicht die Termine fallen und die Verbindung
  // stehen bleibt (oder umgekehrt).
  return db.get().transaction(() => {
    const removed = deleteEvents ? clearMirroredEvents() : 0;
    ['apple_caldav_url', 'apple_username', 'apple_app_password', 'apple_last_sync',
     // Der Fehlerstand gehoert zur Verbindung (#820).
     'apple_last_error', 'apple_last_error_at'].forEach(cfgDel);
    log.info('Disconnected.' + (removed ? ` ${removed} mirrored event(s) removed.` : ''));
    return { removed };
  })();
}

/**
 * Entfernt die lokal gespiegelten Apple-Termine (#820). Ohne Wirkung nach außen:
 * der iCloud-Kalender bleibt unberührt, geräumt wird nur die Kopie.
 * @returns {number} Anzahl gelöschter Termine
 */
function clearMirroredEvents() {
  return deleteSourceEvents(db.get(), 'apple');
}

// --------------------------------------------------------
// Verbindungsstatus
// --------------------------------------------------------

function getStatus() {
  const creds     = getCredentials();
  const configured = !!creds;
  const connected  = !!(cfgGet('apple_caldav_url')); // via UI gespeichert
  const lastSync   = cfgGet('apple_last_sync');
  // Reist mit dem Status, damit die Rückfrage vor dem Löschen die Zahl sofort
  // nennen kann - und damit die Einstellungen den Rückstand auch dann noch
  // zeigen, wenn längst getrennt wurde (#820).
  const mirroredEvents = countSourceEvents(db.get(), 'apple');
  // Ein still gescheiterter Lauf sah bisher aus wie ein Kalender, der einfach
  // aufhoert zu aktualisieren - der Fehler stand nur im Serverlog (#820).
  return { configured, connected, lastSync, mirroredEvents, ...readSyncOutcome(db.get(), 'apple') };
}

/**
 * Verbindungstest: CalDAV-Client erstellen und Kalender abrufen.
 * Wirft einen Fehler wenn die Credentials ungültig sind.
 */
async function testConnection() {
  const creds = getCredentials();
  if (!creds) throw new Error('[Apple] No credentials configured.');

  const client = await createClient(creds);

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
function buildICS(event, householdZone = null) {
  // UID-Format bewusst auf `oikos-…@oikos.local` belassen (kein Rebrand):
  // bereits synchronisierte Events tragen diese UID auf dem entfernten CalDAV-Server
  // und in external_calendar_id. Eine Änderung würde beim nächsten Sync Duplikate
  // bzw. verwaiste Remote-Objekte erzeugen.
  const uid   = `oikos-${event.id}@oikos.local`;
  const now   = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Zeiten samt Zone zentral (#938). Vorher schnitt dieser Pfad die Trennzeichen
  // aus dem gespeicherten Wert und schickte die Ziffern ohne Zonenangabe los -
  // 10 Uhr auf wessen Uhr auch immer.
  // Start/Ende mit der eigenen Wiederholungsregel in Einklang (#986); ein
  // importiertes DTSTART bleibt unberuehrt (#756).
  const when = eventDateTimeFields(outboundEvent(event), householdZone);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//Familienplaner//DE',
  ];
  // Ein TZID ohne sein VTIMEZONE ist laut RFC 5545 ungueltig.
  if (when.tzid) lines.push(...vtimezoneFor(when.tzid, Number(String(event.start_datetime).slice(0, 4))));
  lines.push(
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeICS(event.title)}`,
    `DTSTART${when.dtstart.params}:${when.dtstart.value}`,
    `DTEND${when.dtend.params}:${when.dtend.value}`,
  );

  if (event.description) lines.push(`DESCRIPTION:${escapeICS(event.description)}`);
  if (event.location)    lines.push(`LOCATION:${escapeICS(event.location)}`);
  // Eigenfarbe als CSS3-Name (RFC 7986, #897). Ein Termin ohne eigene Farbe
  // bekommt keine Zeile und erbt beim Anbieter die des Kalenders.
  const colorName = nearestIcalColorName(event.color);
  if (colorName) lines.push(`COLOR:${colorName}`);

  // Beide Schreibweisen kommen vor: eingelesene Serien tragen die volle
  // ICS-Zeile, lokal angelegte nur den Regelkörper (#756). Roh übernommen ergab
  // letzteres eine Zeile ohne Property-Namen - ein VEVENT, das kein Server als
  // Serie liest. patchICSEvent normalisiert an seiner Stelle genauso.
  if (event.recurrence_rule) {
    lines.push(rruleLine(event.recurrence_rule));
  }

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
/**
 * tsdav ist eine optionale Abhängigkeit - `createCalDAVClient` importiert sie
 * dynamisch (graceful degradation) und legt zugleich den `urlFilter` für
 * Kalenderobjekte an, ohne den tsdav Objekte ohne `.ics`-Namen still
 * verschluckt (#883).
 */
async function createClient(creds) {
  return createCalDAVClient({ caldav_url: creds.url, username: creds.username, password: creds.password });
}

/**
 * Sofortversuch direkt nach einer lokalen Änderung oder Löschung (#593), damit ein
 * Termin nicht erst beim nächsten Sync-Intervall in iCloud nachzieht. Holt nur die
 * betroffenen Objekte statt ganzer Kalender; was ohne vollen Abruf nicht geht,
 * bleibt vorgemerkt und läuft im nächsten Sync mit.
 * @returns {Promise<{deleted:number,updated:number}>}
 */
async function flushOutbound(opts = {}) {
  return runSerialized('apple', 'flush', () => runFlushOutbound(opts));
}

async function runFlushOutbound({ makeClient } = {}) {
  const idle = { deleted: 0, updated: 0 };
  const deletions = outbound.pendingDeletions('apple').filter((r) => r.object_url);
  const updates   = outbound.pendingUpdates('apple').filter((e) => e.external_object_url);
  if (!deletions.length && !updates.length) return idle;

  const creds = getCredentials();
  if (!creds) return idle;

  const calendarForRef = db.get().prepare(
    `SELECT external_id FROM external_calendars WHERE id = ? AND source = 'apple'`
  );
  const withCalendar = updates
    .map((e) => ({ ...e, __calendarUrl: e.calendar_ref_id ? calendarForRef.get(e.calendar_ref_id)?.external_id : null }))
    .filter((e) => e.__calendarUrl);

  try {
    const client = await (makeClient || createClient)(creds);
    // Apple kennt keinen wählbaren Zielkalender, also nie einen Umzug.
    return await flushAccount(client, 'apple', {
      deletions, updates: withCalendar, needsCalendars: false,
    });
  } catch (err) {
    log.warn(`Immediate outbound attempt failed: ${err.message}`);
    return idle;
  }
}

/**
 * Ein Lauf, dessen Ausgang den Lauf überlebt (#820). Um runSync() statt in ihm,
 * damit auch der frühe Ausstieg bei fehlenden Zugangsdaten erfasst wird.
 */
async function sync() {
  return runSerialized('apple', 'sync', () => withSyncOutcome(db.get(), 'apple', runSync));
}

async function runSync() {
  const creds = getCredentials();
  if (!creds) {
    throw new Error('[Apple] No credentials configured (neither in DB nor in .env).');
  }

  const client = await createClient(creds);

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

  // Für die Löschphase (#508): pro erfolgreich abgerufenem Kalender die gesehenen
  // UIDs. Kalender, deren Fetch fehlschlägt, landen hier nicht und werden nie geprunt.
  const fetchedCalendars = [];
  const accountUids = new Set();
  // UID → das Kalenderobjekt, in dem sie steht (#593). Ausgehende Löschungen
  // brauchen dessen URL, Änderungen zusätzlich seinen Originalinhalt.
  const objectIndex     = new Map();
  const calendarsByUrl  = new Map();
  const ownCalendarUrls = new Set();
  // Offene Löschungen einmal je Lauf, nicht je eingehendem Termin.
  const pendingDeletionUids = outbound.pendingDeletionUids('apple');

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
    // Standard-Zuweisung dieses Kalenders (#459) einmal auflösen, nicht pro Event.
    const calDefaultAssignee = db.get()
      .prepare('SELECT default_assignee_user_id FROM external_calendars WHERE id = ?')
      .get(calRefId)?.default_assignee_user_id ?? null;

    // --------------------------------------------------------
    // Inbound: iCloud → lokal
    // --------------------------------------------------------
    const calendarUids = new Set();
    fetchedCalendars.push({ calRefId, calendarName: calName, calendarUids });

    calendarsByUrl.set(cal.url, cal);
    ownCalendarUrls.add(cal.url);

    for (const obj of calObjects) {
      // RECURRENCE-ID-Overrides zusammenführen, sonst überschreibt ein geändertes
      // Einzel-Vorkommen die Serie derselben UID (#549). Was der Parser verwirft,
      // wird benannt statt still übergangen (#883).
      const parsed = normalizeRecurrenceOverrides(parseICS(obj.data || '', {
        onSkip: ({ uid, reason }) =>
          log.warn(`Skipped VEVENT (${reason}) uid=${uid ?? '(none)'} at ${obj.url ?? '(unknown URL)'}`),
      }));
      for (const ev of parsed) {
        try {
          calendarUids.add(ev.uid);
          accountUids.add(ev.uid);
          // Objekt merken: ausgehende Löschungen brauchen die URL, Änderungen
          // zusätzlich den Originalinhalt zum Patchen (#593).
          if (obj.url) {
            objectIndex.set(ev.uid, {
              url: obj.url, etag: obj.etag, data: obj.data, calendarUrl: cal.url,
            });
          }
          // NUR die Eigenfarbe des Termins (RFC 7986 COLOR); die Kalenderfarbe
          // ist geerbt und gehoert nicht in die Eigenfarb-Spalte (#891), sonst
          // verdraengt sie dauerhaft die Farbe der zugewiesenen Person. Der
          // Lesepfad holt sie als cal_color ueber calendar_ref_id.
          const evColor = ev.color ?? null;

          // Vom Nutzer gelöscht und noch nicht auf dem Server: nicht wieder
          // anlegen, sonst kehrt der Termin bei jedem Sync zurück (#593).
          if (pendingDeletionUids.has(ev.uid)) continue;

          const existing = db.get().prepare(
            `SELECT id, outbound_dirty FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'apple'`
          ).get(ev.uid);

          // Eine lokale Bearbeitung, die noch auf ihren Push wartet, darf der
          // Inbound nicht mit dem alten Serverstand überschreiben (#593).
          if (existing?.outbound_dirty) continue;

          let eventId;
          if (existing) {
            // color nur überschreiben, solange der Nutzer nicht lokal umgefärbt
            // hat (color_modified = 0); Titel/Zeit bleiben remote-geführt.
            //
            // Nicht `user_modified` (#899): das wird bei jeder Bearbeitung
            // gesetzt, eine Titeländerung hätte die Farbspalte also dauerhaft
            // eingefroren und eine Umfärbung auf dem Server nie mehr erreicht.
            db.get().prepare(`
              UPDATE calendar_events
              SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
                  all_day = ?, location = ?, recurrence_rule = ?, tzid = ?,
                  color = CASE WHEN color_modified = 0 THEN ? ELSE color END,
                  calendar_ref_id = ?,
                  external_object_url = COALESCE(?, external_object_url)
              WHERE id = ?
            `).run(
              ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, ev.rrule, ev.tzid ?? null, evColor, calRefId,
              obj.url ?? null, existing.id
            );
            eventId = existing.id;
          } else {
            const inserted = db.get().prepare(`
              INSERT INTO calendar_events
                (title, description, start_datetime, end_datetime, all_day,
                 location, color, external_calendar_id, external_source, recurrence_rule, tzid, calendar_ref_id, created_by,
                 external_object_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apple', ?, ?, ?, ?, ?)
            `).run(
              ev.summary, ev.description, ev.dtstart, ev.dtend,
              ev.allDay ? 1 : 0, ev.location, evColor, ev.uid, ev.rrule, ev.tzid ?? null, calRefId, createdBy,
              obj.url ?? null
            );
            eventId = Number(inserted.lastInsertRowid);
            // Standard-Zuweisung dieses Kalenders (#459) auf den neuen Termin.
            assignDefaultToEvent(db.get(), eventId, calDefaultAssignee);
          }

          // EXDATE + ersetzte Override-Termine als Instanz-Ausnahmen ablegen,
          // damit die Expansion diese Vorkommen überspringt (#489/#549). Additiv.
          if (ev.rrule && Array.isArray(ev.exdates) && ev.exdates.length) {
            const insEx = db.get().prepare(
              'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
            );
            for (const exDate of ev.exdates) insEx.run(eventId, exDate);
          }
        } catch (err) {
          log.error(`Upsert error for UID ${ev.uid}:`, err.message);
        }
      }
    }
  }

  // --------------------------------------------------------
  // Löschphase (#508): in iCloud gelöschte Termine lokal entfernen. Erst nach allen
  // Kalendern, damit `accountUids` vollständig ist und ein zwischen Kalendern
  // verschobener Termin nicht fälschlich verschwindet.
  // --------------------------------------------------------
  let deletedCount = 0;
  for (const { calRefId, calendarName, calendarUids } of fetchedCalendars) {
    try {
      const removed = pruneDeletedEvents(db.get(), {
        calRefId, calendarUids, accountUids, source: 'apple', calendarName,
      });
      if (removed > 0) {
        log.info(`Calendar "${calendarName}": removed ${removed} event(s) deleted on the server.`);
        deletedCount += removed;
      }
    } catch (err) {
      log.error(`Failed to prune deleted events for calendar "${calendarName}":`, err.message);
    }
  }

  // --------------------------------------------------------
  // Ausgehende Löschungen und Änderungen (#593). Nach dem Inbound, weil der Weg
  // zum Objekt für Bestandstermine erst aus dessen Abruf bekannt wird; der
  // Inbound überspringt dafür alles, was hier noch aussteht.
  // --------------------------------------------------------
  try {
    const removed = await processPendingDeletions(client, 'apple', objectIndex, ownCalendarUrls);
    if (removed) log.info(`${removed} pending deletion(s) applied in iCloud.`);
    const pushed = await processPendingUpdates(client, 'apple', objectIndex, calendarsByUrl);
    if (pushed) log.info(`${pushed} local change(s) pushed to iCloud.`);
  } catch (err) {
    log.error('Outbound changes failed:', err.message);
  }

  // --------------------------------------------------------
  // Outbound: lokal → iCloud (erster verfügbarer Kalender)
  // --------------------------------------------------------
  const defaultCal = syncCalendars[0];
  const localEvents = db.get().prepare(`
    SELECT * FROM calendar_events
    WHERE external_source = 'local' AND external_calendar_id IS NULL
  `).all();

  // Einmal je Lauf: die Zone, an der naive Zeiten haengen (#938).
  const householdZone = householdTimeZone(db.get());

  for (const event of localEvents) {
    try {
      const icsData  = buildICS(event, householdZone);
      const uid      = `oikos-${event.id}@oikos.local`;
      const filename = `${uid}.ics`;

      await client.createCalendarObject({
        calendar:     defaultCal,
        filename,
        iCalString:   icsData,
      });

      // Objekt-URL und Kalenderzuordnung festhalten: ohne sie wäre der frisch
      // hochgeladene Termin für spätere Änderungen und Löschungen unerreichbar,
      // bis ihn der nächste Inbound-Lauf wiederfindet (#593).
      const objectUrl = `${String(defaultCal.url).replace(/\/?$/, '/')}${filename}`;
      const calRefId  = upsertExternalCalendar(
        'apple', defaultCal.url, defaultCal.displayName || 'Apple Calendar',
        normalizeCalColor(defaultCal.calendarColor) || APPLE_COLOR
      );
      // `color_modified` mit hoch: die gerade hinausgegangene Farbe ist unsere.
      // Der CSS3-Name ist eine verlustbehaftete Abbildung des Hex-Werts - ohne
      // das Flag holte der nächste Inbound-Lauf ihn zurück und ersetzte den
      // exakten Wert durch den gerundeten (#899).
      db.get().prepare(`
        UPDATE calendar_events
        SET external_calendar_id = ?, external_source = 'apple',
            external_object_url = ?, calendar_ref_id = ?,
            color_modified = CASE WHEN color IS NOT NULL THEN 1 ELSE color_modified END
        WHERE id = ?
      `).run(uid, objectUrl, calRefId, event.id);
    } catch (err) {
      log.error(`Outbound error for event ${event.id}:`, err.message);
    }
  }

  cfgSet('apple_last_sync', new Date().toISOString());
  log.info(
    `Sync completed - ${totalObjects} objects from ${syncCalendars.length} calendars inbound` +
    `${deletedCount > 0 ? `, ${deletedCount} deleted` : ''}, ${localEvents.length} local → iCloud.`
  );
}

export { sync, flushOutbound, getStatus, saveCredentials, clearCredentials,
         clearMirroredEvents, testConnection };

// Nur fuer Tests: der ICS-Builder ist der einzige Weg, auf dem ein rein lokaler
// Termin zum Anbieter kommt, und der Sync-Pfad drumherum ist zu gross, um ihn
// dafuer nachzustellen.
export const __test = { buildICS };
