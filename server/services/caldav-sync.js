/**
 * Modul: Generic CalDAV Sync
 * Zweck: Multi-Account CalDAV synchronization with calendar selection
 * Abhängigkeiten: tsdav, server/db.js, server/services/ics-parser.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CalDAV');

import * as db from '../db.js';
import { upsertExternalCalendar } from './external-calendars.js';
import { assignDefaultToEvent } from './sync-assignment.js';
import { pruneDeletedEvents, countMirroredEvents, deleteMirroredEvents } from './calendar-prune.js';
import * as outbound from './calendar-outbound.js';
import { processPendingDeletions, processPendingUpdates, flushAccount } from './caldav-outbound.js';
import { detachAccountRows } from './caldav-todo-outbound.js';
import { runSerialized } from '../utils/sync-lock.js';
import { toICSDatetime, escapeICSText } from '../utils/ics-format.js';
import { eventDateTimeFields } from '../utils/ics-datetime.js';
import { vtimezoneFor } from '../utils/vtimezone.js';
import { householdTimeZone } from '../utils/timezone.js';
import { createCalDAVClient, supportsComponent } from '../utils/caldav-client.js';
import { rruleLine } from './recurrence.js';
import { nearestIcalColorName } from '../utils/ical-color.js';
import { outboundEvent } from './outbound-dtstart.js';

// Reused functions from apple-calendar.js
import {
  parseICS,
  formatICSDate,
  tzLocalToUTC,
  applyDuration,
  normalizeRecurrenceOverrides
} from './ics-parser.js';

// Historisch hier beheimatet, inzwischen in utils/ics-format.js - der Re-Export
// hält die bestehenden Importpfade (Tests, ics-Export) gültig.
export { toICSDatetime };

function buildCalDAVICS(event, householdZone = null) {
  const uid  = `oikos-${event.id}@oikos.local`;
  const now  = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // Die Zeiten und ihre Zone bestimmt eventDateTimeFields; bis #938 stand hier
  // ein blankes `DTSTART:20260830T100000`, das keinen Zeitpunkt bezeichnet,
  // sondern eine Uhrzeit ohne Uhr.
  // Start/Ende mit der eigenen Wiederholungsregel in Einklang (#986); ein
  // importiertes DTSTART bleibt unberuehrt (#756).
  const when = eventDateTimeFields(outboundEvent(event), householdZone);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Yuvomi//CalDAV Sync//EN',
  ];
  // RFC 5545: ein TZID-Parameter braucht sein VTIMEZONE im selben VCALENDAR,
  // und zwar bevor es benutzt wird.
  if (when.tzid) lines.push(...vtimezoneFor(when.tzid, Number(String(event.start_datetime).slice(0, 4))));
  lines.push(
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeICSText(event.title)}`,
    `DTSTART${when.dtstart.params}:${when.dtstart.value}`,
    `DTEND${when.dtend.params}:${when.dtend.value}`,
  );

  if (event.description)     lines.push(`DESCRIPTION:${escapeICSText(event.description)}`);
  if (event.location)        lines.push(`LOCATION:${escapeICSText(event.location)}`);
  // Eigenfarbe als CSS3-Name (RFC 7986, #897). Ein Termin ohne eigene Farbe
  // bekommt keine Zeile und erbt beim Anbieter die des Kalenders.
  const colorName = nearestIcalColorName(event.color);
  if (colorName) lines.push(`COLOR:${colorName}`);

  if (event.recurrence_rule) {
    lines.push(rruleLine(event.recurrence_rule));
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// --------------------------------------------------------
// Helper Functions
// --------------------------------------------------------

function normalizeCalColor(c) {
  if (!c) return null;
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7); // strip alpha
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return null;
}

// --------------------------------------------------------
// Credentials Helpers
// --------------------------------------------------------

function getAccountById(accountId) {
  return db.get().prepare('SELECT * FROM caldav_accounts WHERE id = ?').get(accountId);
}

function getAllAccounts() {
  return db.get().prepare('SELECT * FROM caldav_accounts').all();
}

// --------------------------------------------------------
// Connection Testing
// --------------------------------------------------------

/**
 * Nur Collections, die Termine aufnehmen. `fetchCalendars()` liefert jede
 * Kalender-Collection des Kontos, also auch reine Aufgabenlisten - die landeten
 * ungefiltert in der Kalenderauswahl und wurden als Speicherziel für Termine
 * angeboten. Sabre/Nextcloud weist ein VEVENT darin mit 403 ab, Radicale nimmt es
 * an und verschmutzt damit die Aufgabenliste anderer Clients (#617).
 */
function eventCalendars(calendars) {
  return (calendars || []).filter(cal => supportsComponent(cal, 'VEVENT'));
}

/**
 * `createClient` wie bei sync(): injizierbare Factory für Tests, Vorgabe ist der
 * echte tsdav-Client. Ohne sie ließe sich der Auffrischungspfad der
 * Kalenderliste nur über die Schreibweise prüfen, nicht über sein Verhalten -
 * und genau dort saß der Fehler, der die Abwahl überschrieb (#732).
 */
async function testConnection(caldavUrl, username, password, { createClient } = {}) {
  try {
    const makeClient = createClient || createCalDAVClient;
    const client = await makeClient({ caldav_url: caldavUrl, username, password });

    const calendars = await client.fetchCalendars();
    if (!calendars.length) {
      throw new Error('Connected, but no calendars found.');
    }

    return { ok: true, calendars };
  } catch (err) {
    log.error('Connection test failed:', err.message);
    throw new Error(`CalDAV connection failed: ${err.message}`);
  }
}

// --------------------------------------------------------
// Account Management
// --------------------------------------------------------

async function addAccount(name, caldavUrl, username, password, { createClient } = {}) {
  // Validate inputs
  if (!name || !caldavUrl || !username || !password) {
    throw new Error('All fields required: name, caldavUrl, username, password');
  }

  // Test connection first (createClient injizierbar wie bei getCalendars/
  // updateAccount - ohne sie ginge dieser Pfad im Test ans echte Netz).
  const { calendars } = await testConnection(caldavUrl, username, password, { createClient });

  // Check for duplicate
  const existing = db.get().prepare(
    'SELECT id FROM caldav_accounts WHERE caldav_url = ? AND username = ?'
  ).get(caldavUrl, username);

  if (existing) {
    throw new Error('Account with this URL and username already exists.');
  }

  // Warn if DB_ENCRYPTION_KEY not set
  if (!process.env.DB_ENCRYPTION_KEY) {
    log.warn('WARNING: DB_ENCRYPTION_KEY is not set - CalDAV credentials will be stored unencrypted.');
  }

  // Insert account
  const result = db.get().prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES (?, ?, ?, ?)
  `).run(name, caldavUrl, username, password);

  const accountId = result.lastInsertRowid;

  // OPT-IN, NICHT OPT-OUT (#732): Ein neues Konto bringt seine Kalender
  // abgewaehlt mit. Vorher lief nach dem Verbinden sofort jeder gefundene
  // Kalender in den Haushalt - bei einem Konto mit Arbeits-, Geburtstags- und
  // Feiertagskalendern also drei Kalender, die niemand bestellt hat, und deren
  // Termine man einzeln wieder loswerden musste. Wer verbindet, waehlt danach
  // aus; das ist ein Klick mehr und eine Ueberraschung weniger.
  const calendarData = [];
  for (const cal of eventCalendars(calendars)) {
    const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
    const calName = cal.displayName || 'Unnamed Calendar';

    db.get().prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, ?, 0)
    `).run(accountId, cal.url, calName, calColor);

    calendarData.push({ url: cal.url, name: calName, color: calColor, enabled: false });
  }

  log.info(`Added CalDAV account "${name}" with ${calendarData.length} calendars.`);

  return { accountId, calendars: calendarData };
}

function listAccounts() {
  const accounts = db.get().prepare(`
    SELECT id, name, caldav_url, username, created_at, last_sync
    FROM caldav_accounts
    ORDER BY created_at DESC
  `).all();

  // Do NOT return password (security)
  return accounts.map(acc => ({
    id: acc.id,
    name: acc.name,
    caldavUrl: acc.caldav_url,
    username: acc.username,
    createdAt: acc.created_at,
    lastSync: acc.last_sync,
    // Für die Rückfrage vor dem Löschen des Kontos (#732) - dieselbe Zahl, die
    // der Nutzer danach vermissen würde.
    eventCount: countAccountEvents(acc.id),
  }));
}

async function updateAccount(accountId, { name, caldavUrl, username, password, createClient }) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  // If credentials changed, test connection
  const credentialsChanged =
    (caldavUrl && caldavUrl !== account.caldav_url) ||
    (username && username !== account.username) ||
    (password && password !== account.password);

  if (credentialsChanged) {
    const testUrl = caldavUrl || account.caldav_url;
    const testUser = username || account.username;
    const testPwd = password || account.password;

    const { calendars } = await testConnection(testUrl, testUser, testPwd, { createClient });

    // If credentials changed, refresh calendar list
    if (calendars) {
      // Wie in getCalendars({ refresh: true }): neue Zugangsdaten heißen neue
      // Kalenderliste, nicht neue Auswahl. Ein geändertes Passwort darf einen
      // abgewählten Kalender nicht wieder in den Sync holen (#732).
      const previous = new Map(
        db.get().prepare('SELECT calendar_url, enabled FROM caldav_calendar_selection WHERE account_id = ?')
          .all(accountId).map((row) => [row.calendar_url, row.enabled === 1])
      );

      // Delete old selections
      db.get().prepare('DELETE FROM caldav_calendar_selection WHERE account_id = ?').run(accountId);

      // Insert new selections
      for (const cal of eventCalendars(calendars)) {
        const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
        const calName = cal.displayName || 'Unnamed Calendar';

        db.get().prepare(`
          INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
          VALUES (?, ?, ?, ?, ?)
        `).run(accountId, cal.url, calName, calColor, (previous.get(cal.url) ?? false) ? 1 : 0);
      }
    }
  }

  // Update account
  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name); }
  if (caldavUrl) { updates.push('caldav_url = ?'); values.push(caldavUrl); }
  if (username) { updates.push('username = ?'); values.push(username); }
  if (password) { updates.push('password = ?'); values.push(password); }

  if (updates.length === 0) {
    throw new Error('No fields to update.');
  }

  values.push(accountId);

  db.get().prepare(`
    UPDATE caldav_accounts SET ${updates.join(', ')} WHERE id = ?
  `).run(...values);

  log.info(`Updated CalDAV account ${accountId}.`);

  return { success: true };
}

/**
 * `deleteEvents` nimmt die gespiegelten Termine mit (#732). Ohne die Option war
 * das Loeschen eines Kontos der einzige Weg, bei dem Termine sichtbar liegen
 * blieben, aber ihre Kalenderzuordnung verloren (`calendar_ref_id ON DELETE SET
 * NULL`) - Waisen, denen niemand mehr ansieht, woher sie kamen.
 *
 * Die URLs muessen VOR dem Loeschen des Kontos gelesen werden: die Auswahlzeilen
 * haengen per CASCADE am Konto und sind danach fort.
 */
function deleteAccount(accountId, { deleteEvents = false } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  // CASCADE räumt nur, was dem Konto selbst gehört: Kalender- und
  // Listenauswahl und die offenen VTODO-Löschungen. Die gespiegelten Aufgaben
  // und Einkaufsposten sind Nutzerdaten und bleiben - aber ihre
  // external_account_id trägt keinen Fremdschlüssel und zeigte danach ins Leere
  // (#617). Beim nächsten Löschen so einer Zeile scheiterte der Tombstone am
  // Fremdschlüssel von caldav_todo_pending_deletions: die Aufgabe ließe sich
  // lokal nicht mehr löschen, während die entfernte Kopie ohne Konto ohnehin
  // unerreichbar ist. Also entkoppeln, bevor das Konto verschwindet - beides in
  // einem Zug, damit keine Hälfte allein stehen bleibt.
  const calendarUrls = accountCalendarUrls(accountId);

  const { detached, removed } = db.get().transaction(() => {
    // Ohne deleteEvents bleiben die Termine sichtbar stehen, verlieren aber ihre
    // Kalenderzuordnung - das war bis #732 der einzige Ausgang und ist jetzt der
    // ausdruecklich gewaehlte.
    const cleared = deleteEvents ? deleteMirroredEvents(db.get(), calendarUrls) : 0;
    const rows = detachAccountRows(accountId);
    db.get().prepare('DELETE FROM caldav_accounts WHERE id = ?').run(accountId);
    return { detached: rows, removed: cleared };
  })();

  log.info(
    `Deleted CalDAV account ${accountId} ("${account.name}"), detached ${detached} mirrored row(s).`
    + (removed ? `, ${removed} mirrored event(s) removed` : '')
  );

  return { success: true, removed };
}

// --------------------------------------------------------
// Calendar Selection
// --------------------------------------------------------

async function getCalendars(accountId, { refresh = false, createClient } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  if (!refresh) {
    // Return from DB
    const calendars = db.get().prepare(`
      SELECT calendar_url, calendar_name, calendar_color, enabled
      FROM caldav_calendar_selection
      WHERE account_id = ?
      ORDER BY calendar_name
    `).all(accountId);

    // Standard-Zuweisung je Kalender (#459) aus der geteilten external_calendars-Tabelle.
    const assigneeMap = new Map(
      db.get().prepare(`SELECT external_id, default_assignee_user_id FROM external_calendars WHERE source = 'caldav'`)
        .all().map((r) => [r.external_id, r.default_assignee_user_id])
    );

    return calendars.map(cal => ({
      calendarUrl: cal.calendar_url,
      calendarName: cal.calendar_name,
      calendarColor: cal.calendar_color,
      enabled: cal.enabled === 1,
      default_assignee_user_id: assigneeMap.get(cal.calendar_url) ?? null,
      synced: assigneeMap.has(cal.calendar_url),
      // Die Zahl reist mit der Liste, damit die Rückfrage beim Abwählen sie
      // sofort nennen kann (#732). Ein eigener Endpunkt dafür wäre ein zweiter
      // Roundtrip genau in dem Moment, in dem der Nutzer auf eine Antwort wartet.
      eventCount: countMirroredEvents(db.get(), [cal.calendar_url]),
    }));
  }

  // Refresh from server
  const { calendars } = await testConnection(
    account.caldav_url, account.username, account.password, { createClient }
  );

  // DIE ABWAHL ÜBERLEBT DIE AKTUALISIERUNG: „Kalender aktualisieren" holt die
  // Liste vom Server, es ist keine Zurücksetzung. Vorher lief hier ein DELETE
  // mit anschließendem INSERT auf enabled=1, und jeder bewusst abgewählte
  // Kalender kam ungefragt zurück in den Sync - beim nächsten Lauf mitsamt
  // seinen Terminen (#732). Deshalb den Stand je calendar_url vorher sichern
  // und nur für NEUE Kalender die Vorgabe „an" setzen.
  const previous = new Map(
    db.get().prepare('SELECT calendar_url, enabled FROM caldav_calendar_selection WHERE account_id = ?')
      .all(accountId).map((row) => [row.calendar_url, row.enabled === 1])
  );

  db.get().prepare('DELETE FROM caldav_calendar_selection WHERE account_id = ?').run(accountId);

  const result = [];
  for (const cal of eventCalendars(calendars)) {
    const calColor = normalizeCalColor(cal.calendarColor) || '#4A90E2';
    const calName = cal.displayName || 'Unnamed Calendar';
    // Bekannter Kalender behaelt seinen Stand, ein neu gemeldeter kommt
    // abgewaehlt - dieselbe Opt-in-Regel wie beim Anlegen des Kontos (#732).
    const enabled = previous.get(cal.url) ?? false;

    db.get().prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, cal.url, calName, calColor, enabled ? 1 : 0);

    result.push({
      calendarUrl: cal.url,
      calendarName: calName,
      calendarColor: calColor,
      enabled,
    });
  }

  log.info(`Refreshed calendars for account ${accountId}.`);

  return result;
}

/**
 * `deleteEvents` räumt beim ABWÄHLEN zusätzlich die bereits gespiegelten Termine
 * weg (#732). Nur beim Abwählen: beim Einschalten gibt es nichts aufzuräumen,
 * und ein Flag, das in beide Richtungen etwas täte, wäre eine Falle für jeden
 * künftigen Aufrufer.
 */
function updateCalendarSelection(accountId, calendarUrl, enabled, { deleteEvents = false } = {}) {
  const account = getAccountById(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  const enabledValue = enabled ? 1 : 0;

  const result = db.get().prepare(`
    UPDATE caldav_calendar_selection
    SET enabled = ?
    WHERE account_id = ? AND calendar_url = ?
  `).run(enabledValue, accountId, calendarUrl);

  if (result.changes === 0) {
    throw new Error(`Calendar not found for account ${accountId}.`);
  }

  const removed = (!enabled && deleteEvents)
    ? deleteMirroredEvents(db.get(), [calendarUrl])
    : 0;

  log.info(`Calendar selection updated: account ${accountId}, calendar ${calendarUrl}, enabled=${enabled}`
    + (removed ? `, ${removed} mirrored event(s) removed` : ''));

  return { success: true, removed };
}

/** Die Kalender-URLs eines Kontos - Grundlage für Zählen und Aufräumen (#732). */
function accountCalendarUrls(accountId) {
  return db.get().prepare(
    'SELECT calendar_url FROM caldav_calendar_selection WHERE account_id = ?'
  ).all(accountId).map((r) => r.calendar_url);
}

/** Wie viele gespiegelte Termine hängen an diesem Konto? Für die Rückfrage. */
function countAccountEvents(accountId) {
  return countMirroredEvents(db.get(), accountCalendarUrls(accountId));
}

// --------------------------------------------------------
// Sync
// --------------------------------------------------------

// Beim Inbound-Sync werden Kalenderobjekte synchron geparst und in die (synchrone)
// node:sqlite-DB geschrieben. Damit ein großer Kalender den Event-Loop nicht für die
// gesamte Dauer blockiert (App friert beim Navigieren ein, #519), wird nach je
// YIELD_EVERY verarbeiteten Objekten kurz an den Event-Loop zurückgegeben.
const YIELD_EVERY = 50;

/** Echter tsdav-Client für einen Account; in Tests durch eine Factory ersetzbar. */
const defaultClientFactory = createCalDAVClient;

/**
 * Ein Sync-Lauf, serialisiert gegen den Sofortversuch und gegen sich selbst
 * (#593): beide führen dieselbe ausgehende Buchhaltung, und ein Tick, der in
 * einen laufenden Durchgang hineinliefe, läse deren Zwischenstand.
 */
async function sync(opts = {}) {
  return runSerialized('caldav', 'sync', () => runSync(opts));
}

async function runSync({ createClient } = {}) {
  const accounts = getAllAccounts();

  if (accounts.length === 0) {
    log.debug('No CalDAV accounts configured.');
    return { success: true, syncedAccounts: 0, syncedEvents: 0 };
  }

  // Client-Factory injizierbar (Tests), Default = echter tsdav-Client.
  const makeClient = createClient || defaultClientFactory;

  let totalSyncedEvents = 0;
  // Getrennt von totalSyncedEvents: gesehen ist nicht geändert. Ein Kalender mit
  // 47 Terminen liefert bei jedem Lauf 47 gesehene Events, aber im Regelfall
  // null geänderte - und nur letzteres ist eine Meldung im Standard-Log wert.
  let totalChangedEvents = 0;
  let successfulAccounts = 0;

  // Hot-Path-Statements einmal vorbereiten statt pro Event neu (#519): das spart bei
  // großen Kalendern spürbar Zeit und verkürzt damit das synchrone Verarbeitungsfenster.
  const conn = db.get();
  const selExistingEvent = conn.prepare(
    `SELECT id, outbound_dirty FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'caldav'`
  );
  // Offene Löschungen einmal je Lauf, nicht je eingehendem Termin.
  const pendingDeletionUids = outbound.pendingDeletionUids('caldav');
  // Der Vergleich in der WHERE-Klausel hält das Statement von Schreibvorgängen
  // ab, die nichts ändern: ohne ihn meldet SQLite auch bei identischen Werten
  // changes = 1, sodass sich ein Tick über einen unveränderten Kalender nicht
  // von einem mit echten Änderungen unterscheiden lässt. Nebeneffekt: der
  // Normalfall (nichts hat sich geändert) erzeugt keine WAL-Writes mehr.
  // `IS NOT` statt `<>`, weil der Vergleich NULL-sicher sein muss, und die
  // beiden abgeleiteten Spalten wiederholen ihren SET-Ausdruck, damit eine
  // lokale Umfärbung (color_modified) bzw. ein fehlendes obj.url nicht als
  // Unterschied zählt. Die Bindings der SET-Liste kommen dafür ein zweites Mal.
  //
  // Die Farbe gattert auf `color_modified`, NICHT auf `user_modified` (#899):
  // letzteres wird bei jeder Bearbeitung gesetzt, eine Titeländerung hätte die
  // Farbspalte also für immer eingefroren und eine Umfärbung auf dem Server
  // wäre nie mehr angekommen.
  const updEvent = conn.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, recurrence_rule = ?, tzid = ?,
        color = CASE WHEN color_modified = 0 THEN ? ELSE color END,
        calendar_ref_id = ?,
        external_object_url = COALESCE(?, external_object_url)
    WHERE id = ?
      AND (   title               IS NOT ?
           OR description         IS NOT ?
           OR start_datetime      IS NOT ?
           OR end_datetime        IS NOT ?
           OR all_day             IS NOT ?
           OR location            IS NOT ?
           OR recurrence_rule     IS NOT ?
           OR tzid                IS NOT ?
           OR color               IS NOT CASE WHEN color_modified = 0 THEN ? ELSE color END
           OR calendar_ref_id     IS NOT ?
           OR external_object_url IS NOT COALESCE(?, external_object_url)
          )
  `);
  const insEvent = conn.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, all_day,
       location, color, external_calendar_id, external_source, recurrence_rule, tzid, calendar_ref_id, created_by,
       external_object_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'caldav', ?, ?, ?, ?, ?)
  `);
  // EXDATE-Ausnahmen der Serie (#489/#549). Additiv (INSERT OR IGNORE): entfernt
  // keine lokal vom Nutzer ausgenommenen Einzeltermine.
  const insException = conn.prepare(
    'INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)'
  );
  // Besitzer (created_by-Fallback) einmal auflösen — konstant über den ganzen Sync.
  const ownerRow = conn.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const createdBy = ownerRow ? ownerRow.id : 1;

  for (const account of accounts) {
    try {
      log.debug(`Syncing CalDAV account ${account.id} ("${account.name}")...`);

      // Create tsdav client (oder injizierte Test-Factory)
      const client = await makeClient(account);

      // Get enabled calendars for this account
      const enabledCalendars = db.get().prepare(`
        SELECT calendar_url, calendar_name, calendar_color
        FROM caldav_calendar_selection
        WHERE account_id = ? AND enabled = 1
      `).all(account.id);

      if (enabledCalendars.length === 0) {
        log.debug(`Account ${account.id}: no enabled calendars, skipping.`);
        continue;
      }

      // Fetch all calendars from server
      const serverCalendars = await client.fetchCalendars();

      // Inbound sync: CalDAV → Yuvomi
      let accountEventCount = 0;
      let accountChangedCount = 0;
      let processedObjects = 0; // Zähler für den Event-Loop-Yield (#519)

      // Für die Löschphase: pro erfolgreich abgerufenem Kalender die gesehenen UIDs.
      // Kalender, deren Fetch fehlschlägt, landen hier nicht und werden nie geprunt.
      const fetchedCalendars = [];
      const accountUids = new Set();
      // UID → das Kalenderobjekt, in dem sie steht (#593). Ausgehende Löschungen
      // brauchen dessen URL, Änderungen zusätzlich seinen Originalinhalt.
      const objectIndex   = new Map();
      const calendarsByUrl = new Map();
      const ownCalendarUrls = new Set();

      for (const selCal of enabledCalendars) {
        // Find matching calendar from server
        const serverCal = serverCalendars.find(sc => sc.url === selCal.calendar_url);

        if (!serverCal) {
          log.warn(`Calendar ${selCal.calendar_url} not found on server, disabling.`);
          db.get().prepare(`
            UPDATE caldav_calendar_selection SET enabled = 0
            WHERE account_id = ? AND calendar_url = ?
          `).run(account.id, selCal.calendar_url);
          continue;
        }

        // Konten, die vor dem Komponentenfilter angelegt wurden, tragen die
        // Aufgabenlisten weiter als aktivierte Kalender: das Filtern beim Anlegen
        // erreicht sie nicht mehr, und bis jemand von Hand aktualisiert bleibt eine
        // Aufgabenliste ein Ziel für Termine (#617). Der Lauf hat die Komponenten
        // ohnehin schon geladen, also wird die Auswahl hier nachgezogen. Vor dem
        // Vermerken in `fetchedCalendars`, damit der Prune die bereits gespiegelten
        // Termine dieses Kalenders in Ruhe lässt.
        if (!supportsComponent(serverCal, 'VEVENT')) {
          log.warn(`Calendar ${selCal.calendar_name} does not accept events, disabling.`);
          db.get().prepare(`
            UPDATE caldav_calendar_selection SET enabled = 0
            WHERE account_id = ? AND calendar_url = ?
          `).run(account.id, selCal.calendar_url);
          continue;
        }

        // Fetch calendar objects
        let calObjects;
        try {
          calObjects = await client.fetchCalendarObjects({ calendar: serverCal });
        } catch (err) {
          log.error(`Failed to fetch calendar objects from ${selCal.calendar_name}:`, err.message);
          continue;
        }
        calendarsByUrl.set(selCal.calendar_url, serverCal);
        ownCalendarUrls.add(selCal.calendar_url);

        // Upsert external calendar metadata
        const calRefId = upsertExternalCalendar('caldav', selCal.calendar_url, selCal.calendar_name, selCal.calendar_color);
        // Standard-Zuweisung dieses Kalenders (#459) einmal auflösen, nicht pro Event.
        const calDefaultAssignee = db.get()
          .prepare('SELECT default_assignee_user_id FROM external_calendars WHERE id = ?')
          .get(calRefId)?.default_assignee_user_id ?? null;

        // Parse and upsert events
        const calendarUids = new Set();
        fetchedCalendars.push({ calRefId, calendarName: selCal.calendar_name, calendarUids });

        for (const obj of calObjects) {
          // RECURRENCE-ID-Overrides zusammenführen, sonst überschreibt ein
          // geändertes Einzel-Vorkommen die Serie derselben UID (#549).
          // Was der Parser verwirft, wird benannt: ein still fehlender Termin
          // sah bisher aus wie einer, den der Server nie geliefert hat (#883).
          const parsed = normalizeRecurrenceOverrides(parseICS(obj.data || '', {
            onSkip: ({ uid, reason }) =>
              log.warn(`Skipped VEVENT (${reason}) uid=${uid ?? '(none)'} at ${obj.url ?? '(unknown URL)'}`),
          }));
          if (!parsed.length && !String(obj.data || '').includes('BEGIN:VEVENT')) {
            log.warn(`Calendar object without any VEVENT at ${obj.url ?? '(unknown URL)'}`);
          }

          for (const ev of parsed) {
            try {
              calendarUids.add(ev.uid);
              accountUids.add(ev.uid);
              // Objekt merken: ausgehende Löschungen brauchen die URL, Änderungen
              // zusätzlich den Originalinhalt zum Patchen (#593).
              if (obj.url) {
                objectIndex.set(ev.uid, {
                  url: obj.url, etag: obj.etag, data: obj.data, calendarUrl: selCal.calendar_url,
                });
              }
              // NUR die Eigenfarbe des Termins (RFC 7986 COLOR). Die Kalenderfarbe
              // gehoert NICHT hierher: sie ist geerbt, gilt fuer jeden Termin des
              // Kalenders und sagt ueber diesen einen nichts aus. Sie hier
              // einzusetzen hat sie ununterscheidbar von einer ausdruecklichen
              // Angabe gemacht und damit die Farbe der zugewiesenen Person
              // dauerhaft verdraengt (#891). Die Anzeige holt sie weiterhin - als
              // cal_color ueber calendar_ref_id, wo sie als geerbt erkennbar ist.
              const evColor = ev.color ?? null;

              // Vom Nutzer gelöscht und noch nicht auf dem Server: nicht wieder
              // anlegen, sonst kehrt der Termin bei jedem Sync zurück (#593).
              if (pendingDeletionUids.has(ev.uid)) continue;

              const existing = selExistingEvent.get(ev.uid);

              // Eine lokale Bearbeitung, die noch auf ihren Push wartet, darf der
              // Inbound nicht mit dem alten Serverstand überschreiben (#593).
              if (existing?.outbound_dirty) {
                accountEventCount++;
                continue;
              }

              let eventId;
              // Ob dieser Termin den lokalen Stand wirklich verändert hat. Nur
              // das zählt als Änderung, nicht das bloße Wiedersehen.
              let changed = false;
              if (existing) {
                // Update: color nur überschreiben, solange der Nutzer nicht lokal
                // umgefärbt hat (color_modified = 0); Titel/Zeit bleiben remote-geführt.
                // Dieselben Werte binden die SET-Liste und den Vergleich in der
                // WHERE-Klausel, weshalb sie zweimal übergeben werden.
                const values = [
                  ev.summary, ev.description, ev.dtstart, ev.dtend,
                  ev.allDay ? 1 : 0, ev.location, ev.rrule, ev.tzid ?? null, evColor, calRefId,
                  obj.url ?? null,
                ];
                changed = updEvent.run(...values, existing.id, ...values).changes > 0;
                eventId = existing.id;
              } else {
                // Insert
                const inserted = insEvent.run(
                  ev.summary, ev.description, ev.dtstart, ev.dtend,
                  ev.allDay ? 1 : 0, ev.location, evColor, ev.uid, ev.rrule, ev.tzid ?? null, calRefId, createdBy,
                  obj.url ?? null
                );
                eventId = Number(inserted.lastInsertRowid);
                changed = true;
                // Standard-Zuweisung dieses Kalenders (#459) auf den neuen Termin.
                assignDefaultToEvent(db.get(), eventId, calDefaultAssignee);
              }

              // EXDATE + ersetzte Override-Termine als Instanz-Ausnahmen ablegen,
              // damit die Expansion diese Vorkommen überspringt (#489/#549).
              // INSERT OR IGNORE meldet changes = 0, wenn die Ausnahme schon
              // steht, sodass auch hier nur echter Zuwachs als Änderung zählt.
              if (ev.rrule && Array.isArray(ev.exdates)) {
                for (const exDate of ev.exdates) {
                  if (insException.run(eventId, exDate).changes > 0) changed = true;
                }
              }

              accountEventCount++;
              if (changed) accountChangedCount++;
            } catch (err) {
              log.error(`Failed to upsert event UID ${ev.uid}:`, err.message);
            }
          }

          // Nach je YIELD_EVERY Objekten dem Event-Loop Luft geben, damit ein großer
          // Kalender die App während des Syncs nicht einfriert (#519).
          if (++processedObjects % YIELD_EVERY === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }

      // Löschphase: erst nach allen Kalendern, damit `accountUids` vollständig ist
      // und ein zwischen Kalendern verschobener Termin nicht fälschlich verschwindet.
      let deletedCount = 0;
      for (const { calRefId, calendarName, calendarUids } of fetchedCalendars) {
        try {
          const removed = pruneDeletedEvents(db.get(), {
            calRefId, calendarUids, accountUids, source: 'caldav', calendarName,
          });
          if (removed > 0) {
            log.info(`Calendar "${calendarName}": removed ${removed} event(s) deleted on the server.`);
            deletedCount += removed;
          }
        } catch (err) {
          log.error(`Failed to prune deleted events for calendar "${calendarName}":`, err.message);
        }
      }

      // Ausgehende Löschungen und Änderungen (#593). Nach dem Inbound, weil der
      // Weg zum Objekt für Bestandstermine erst aus dessen Abruf bekannt wird;
      // der Inbound überspringt dafür alles, was hier noch aussteht.
      try {
        const removed = await processPendingDeletions(client, 'caldav', objectIndex, ownCalendarUrls);
        if (removed) log.info(`${removed} pending deletion(s) applied on the server.`);
        const pushed = await processPendingUpdates(client, 'caldav', objectIndex, calendarsByUrl);
        if (pushed) log.info(`${pushed} local change(s) pushed to the server.`);
      } catch (err) {
        log.error(`Outbound changes failed for account ${account.id}:`, err.message);
      }

      // Outbound sync: Yuvomi → CalDAV (events with target_caldav_account_id)
      const localEvents = db.get().prepare(`
        SELECT * FROM calendar_events
        WHERE external_source = 'local' AND target_caldav_account_id = ?
      `).all(account.id);

      // Einmal je Lauf: die Zone, an der naive Zeiten haengen (#938).
      const householdZone = householdTimeZone(db.get());

      for (const event of localEvents) {
        try {
          // Find target calendar
          const targetCal = serverCalendars.find(sc => sc.url === event.target_caldav_calendar_url);

          if (!targetCal) {
            log.warn(`Target calendar ${event.target_caldav_calendar_url} not found, skipping event ${event.id}.`);
            continue;
          }

          const uid     = `oikos-${event.id}@oikos.local`;
          const icsData = buildCalDAVICS(event, householdZone);

          // Upload to CalDAV
          await client.createCalendarObject({
            calendar: targetCal,
            filename: `${uid}.ics`,
            iCalString: icsData,
          });

          // Objekt-URL und Kalenderzuordnung festhalten: ohne sie wäre der frisch
          // hochgeladene Termin für spätere Änderungen und Löschungen unerreichbar,
          // bis ihn der nächste Inbound-Lauf wiederfindet (#593).
          const objectUrl = `${String(targetCal.url).replace(/\/?$/, '/')}${uid}.ics`;
          const calRefId  = upsertExternalCalendar(
            'caldav', event.target_caldav_calendar_url,
            targetCal.displayName || event.target_caldav_calendar_url, null
          );
          // `color_modified` mit hoch: die Farbe, die gerade als CSS3-Name
          // hinausging, ist unsere. Der Name ist eine verlustbehaftete Abbildung
          // des Hex-Werts, und ohne das Flag holte der nächste Inbound-Lauf
          // genau ihn zurück und überschriebe den exakten Wert mit dem
          // gerundeten (#899). Ein Termin, der gar keine eigene Farbe trägt,
          // behält seinen Zustand - dann ist nichts hinausgegangen, was wir
          // verteidigen müssten.
          db.get().prepare(`
            UPDATE calendar_events
            SET external_source = 'caldav', external_calendar_id = ?,
                external_object_url = ?, calendar_ref_id = ?,
                color_modified = CASE WHEN color IS NOT NULL THEN 1 ELSE color_modified END
            WHERE id = ?
          `).run(uid, objectUrl, calRefId, event.id);

          accountEventCount++;
          accountChangedCount++;
        } catch (err) {
          log.error(`Failed to upload event ${event.id} to CalDAV:`, err.message);
        }
      }

      // Update last_sync for account
      db.get().prepare(`
        UPDATE caldav_accounts SET last_sync = ? WHERE id = ?
      `).run(new Date().toISOString(), account.id);

      // Serverseitige Löschungen sind ebenfalls echte Änderungen am lokalen Stand.
      accountChangedCount += deletedCount;

      totalSyncedEvents  += accountEventCount;
      totalChangedEvents += accountChangedCount;
      successfulAccounts++;

      log.debug(
        `Account ${account.id} sync complete: ${accountEventCount} events seen, ` +
        `${accountChangedCount} changed` +
        `${deletedCount > 0 ? ` (${deletedCount} deleted)` : ''}.`
      );

    } catch (err) {
      log.error(`Sync failed for account ${account.id}:`, err.message);
      // Continue with next account (don't abort entire sync)
    }
  }

  // Die Zusammenfassung gehört nur ins Standard-Log, wenn der Lauf den lokalen
  // Stand tatsächlich verändert hat. Ein Tick, der einen unveränderten Kalender
  // bloß erneut abruft, bleibt damit ebenso still wie einer ohne aktivierte
  // Kalender; Fehler melden sich ohnehin einzeln über log.error.
  const summary = `CalDAV sync complete: ${successfulAccounts}/${accounts.length} accounts, `
    + `${totalSyncedEvents} events seen, ${totalChangedEvents} changed.`;
  if (totalChangedEvents > 0) log.info(summary);
  else log.debug(summary);

  return { success: true, syncedAccounts: successfulAccounts, syncedEvents: totalSyncedEvents };
}

/**
 * Sofortversuch direkt nach einer lokalen Änderung oder Löschung (#593), damit ein
 * Termin nicht erst beim nächsten Sync-Intervall auf dem Server nachzieht.
 *
 * Anders als der Sync-Lauf holt er keine Kalender ab, sondern nur die betroffenen
 * Objekte: eine Löschung ist ein DELETE auf die gespeicherte URL, eine Änderung
 * ein gezielter GET plus PUT. Termine ohne bekannte Objekt-URL (synchronisiert vor
 * Migration v106) bleiben vorgemerkt und laufen im nächsten Sync mit.
 * @returns {Promise<{deleted:number,updated:number}>}
 */
async function flushOutbound(opts = {}) {
  return runSerialized('caldav', 'flush', () => runFlushOutbound(opts));
}

async function runFlushOutbound({ createClient } = {}) {
  const idle = { deleted: 0, updated: 0 };
  const deletions = outbound.pendingDeletions('caldav');
  const updates   = outbound.pendingUpdates('caldav');
  if (!deletions.length && !updates.length) return idle;

  const conn = db.get();
  const accountForCalendar = conn.prepare(
    'SELECT account_id FROM caldav_calendar_selection WHERE calendar_url = ? LIMIT 1'
  );
  const calendarForRef = conn.prepare(
    `SELECT external_id FROM external_calendars WHERE id = ? AND source = 'caldav'`
  );

  // Beides nach Account bündeln: ein Client je Konto, nicht je Termin.
  const buckets = new Map();
  const bucket = (accountId) => {
    if (!buckets.has(accountId)) buckets.set(accountId, { deletions: [], updates: [], needsCalendars: false });
    return buckets.get(accountId);
  };

  for (const row of deletions) {
    if (!row.object_url) continue; // ohne URL hilft nur der volle Abruf des Syncs
    const accountId = accountForCalendar.get(row.calendar_external_id)?.account_id;
    if (accountId) bucket(accountId).deletions.push(row);
  }

  for (const event of updates) {
    const calendarUrl = (event.calendar_ref_id ? calendarForRef.get(event.calendar_ref_id)?.external_id : null)
      || event.target_caldav_calendar_url || null;
    if (!calendarUrl || !event.external_object_url) continue;
    const accountId = accountForCalendar.get(calendarUrl)?.account_id;
    if (!accountId) continue;
    const b = bucket(accountId);
    b.updates.push({ ...event, __calendarUrl: calendarUrl });
    if (event.outbound_move_to) b.needsCalendars = true;
  }

  if (buckets.size === 0) return idle;

  const makeClient = createClient || defaultClientFactory;
  const total = { deleted: 0, updated: 0 };
  for (const [accountId, work] of buckets) {
    const account = getAccountById(accountId);
    if (!account) continue;
    try {
      const client = await makeClient(account);
      const res = await flushAccount(client, 'caldav', work);
      total.deleted += res.deleted;
      total.updated += res.updated;
    } catch (err) {
      // Unkritisch: alles bleibt vorgemerkt, der nächste Sync-Lauf zieht nach.
      log.warn(`Immediate outbound attempt failed for account ${accountId}: ${err.message}`);
    }
  }
  return total;
}

function getStatus() {
  const accounts = getAllAccounts();

  const accountStatus = accounts.map(acc => {
    const calendarCount = db.get().prepare(
      'SELECT COUNT(*) as count FROM caldav_calendar_selection WHERE account_id = ? AND enabled = 1'
    ).get(acc.id).count;

    return {
      id: acc.id,
      name: acc.name,
      caldavUrl: acc.caldav_url,
      username: acc.username,
      lastSync: acc.last_sync,
      enabledCalendars: calendarCount,
    };
  });

  const totalCalendars = db.get().prepare(
    'SELECT COUNT(*) as count FROM caldav_calendar_selection WHERE enabled = 1'
  ).get().count;

  return {
    accounts: accountStatus,
    totalAccounts: accounts.length,
    totalEnabledCalendars: totalCalendars,
  };
}

// --------------------------------------------------------
// Exports
// --------------------------------------------------------

export {
  addAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  getCalendars,
  updateCalendarSelection,
  countAccountEvents,
  sync,
  flushOutbound,
  getStatus
};

// Nur fuer Tests: der ICS-Builder ist der einzige Weg, auf dem ein rein lokaler
// Termin zum Anbieter kommt, und der Sync-Pfad drumherum ist zu gross, um ihn
// dafuer nachzustellen.
export const __test = { buildCalDAVICS };
