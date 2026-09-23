/**
 * Modul: Generic CalDAV Sync
 * Zweck: Multi-Account CalDAV synchronization with calendar selection
 * Abhängigkeiten: tsdav, server/db.js, server/services/ics-parser.js
 */

import { createLogger } from '../logger.js';
const log = createLogger('CalDAV');

import * as db from '../db.js';
import { upsertExternalCalendar } from './external-calendars.js';
import { legacyColorSnapshotKey, forgetLegacyColorSnapshot, legacyColorChosenIds } from './legacy-color-snapshot.js';
import { assignDefaultToEvent, reassignDefaultOnCalendarMove } from './sync-assignment.js';
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
import { followInboundStartChange } from './calendar-occurrence-overrides.js';

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

/**
 * UID eines Termins, den Yuvomi selbst hochgeladen hat (`oikos-<id>@oikos.local`,
 * s. den Upload im Sync; ein `::`-Suffix fuer Einzelvorkommen folgt). `_` ist in
 * LIKE ein Platzhalter, im Muster steht keiner.
 */
const UPLOADED_UID_PATTERN = 'oikos-%@oikos.local%';

/**
 * SQL-Bedingung der Farb-Heilung (#1270) fuer selbst hochgeladene Zeilen, mit
 * dem Tabellenpraefix `t` (leer oder `e.`).
 *
 * Eine solche Zeile kann eine eingebrannte Farbe tragen: vor v2.49 angelegt,
 * ohne COLOR hochgeladen (vor #897), und der naechste Inbound schrieb die
 * Farbe des Kalenders hinein, in dem sie lag - ihres Zielkalenders. Wurde sie
 * spaeter bearbeitet, fror Migration 167 diese Farbe ein. Das ist die
 * haeufigste Gruppe von #1270, pauschal ausnehmen darf man sie nicht.
 *
 * Sie ist aber auch der Weg fuer Zeilen, die NIE eingebrannt wurden - etwa ein
 * von `retireLegacyInstances()` (google-calendar.js) abgeloestes
 * Google-Vorkommen mit user_modified = 1, altem created_at und bewusst
 * gewaehlter Farbe. Deshalb gilt fuer sie die engere Frage: ist ihre Farbe
 * genau die ihres EIGENEN Zielkalenders, also die, die damals eingebrannt
 * wurde? Die Farbe eines anderen Kalenders des Kontos spricht fuer eine Wahl.
 * Das Ziel hat der Upload seit jeher stehen lassen; eine Zeile ohne Ziel ist
 * kein Kandidat (der Vergleich mit einem Ziel NULL findet keine Farbe).
 */
function uploadedRowRule(t) {
  return `(${t}external_calendar_id NOT LIKE '${UPLOADED_UID_PATTERN}'
       OR (lower(${t}color) IN (
             SELECT lower(calendar_color) FROM caldav_calendar_selection
              WHERE calendar_url = ${t}target_caldav_calendar_url AND calendar_color IS NOT NULL
             UNION
             SELECT lower(color) FROM external_calendars
              WHERE source = 'caldav' AND external_id = ${t}target_caldav_calendar_url AND color IS NOT NULL)))`;
}

/** Migration, mit der #891 den Import aufhoeren liess, Kalenderfarben einzubrennen. */
const LEGACY_COLOR_FIX_MIGRATION = 166;

/**
 * Wann diese Installation den Fix aus #891 bekam (`applied_at` von Migration
 * 166), oder null ohne `schema_migrations` - das gibt es nur in gekuerzten
 * Test-Fixtures, nie nach `migrate()`. Aeltere Zeilen koennen eine
 * eingebrannte Farbe tragen, juengere nicht (#1270).
 */
function legacyColorCutoff(conn) {
  const hasTable = conn.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!hasTable) return null;
  return conn.prepare('SELECT applied_at FROM schema_migrations WHERE version = ?')
    .get(LEGACY_COLOR_FIX_MIGRATION)?.applied_at ?? null;
}

/**
 * Das Kalender-Home einer Sammlungs-URL fuer die Zurechnung verwaister
 * Kalender (#1270): Origin plus Pfad ohne letztes Segment, oder null, wenn es
 * keinen Besitzer erkennen laesst - Query-adressiert oder direkt an der Wurzel.
 */
function calendarHome(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  if (parsed.search) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return `${parsed.origin}/${segments.slice(0, -1).join('/')}/`;
}

/**
 * Zeigen zwei Konto-URLs auf dieselbe Adresse? Host klein, Standardport weg
 * (beides erledigt `URL`), Schraegstriche am Ende des Pfads weg. Gespeichert
 * wird die URL unveraendert; verglichen wird normalisiert (#1270).
 */
function sameAccountUrl(a, b) {
  const norm = (raw) => {
    try {
      const u = new URL(String(raw).trim());
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch { return String(raw).trim(); }
  };
  return norm(a) === norm(b);
}

/** So lange laeuft die Farb-Heilung (#1270) je Konto, ab seinem ersten Lauf. */
const LEGACY_HEAL_DAYS = 30;

/**
 * sync_config-Schluessel der Farb-Heilung je Konto (#1270). Wert: der Beginn
 * der Frist als ISO-Zeitstempel, oder `never` fuer ein Konto, das nichts zu
 * heilen hat. Fehlt er, beginnt die Frist mit dem naechsten Lauf.
 */
function legacyColorHealKey(accountId) {
  return `caldav_legacy_color_heal_since_${accountId}`;
}


/**
 * Laeuft die Farb-Heilung fuer dieses Konto, und mit welchen Farben? null,
 * wenn nicht. Beim ersten Lauf nach dem Update startet sie die Frist und legt
 * den Schnappschuss an.
 *
 * DER SCHNAPPSCHUSS haelt fest, welche Farbe eine Altzeile bei Fristbeginn
 * trug. Geheilt wird nur, solange sie genau diese Farbe traegt: waehlt jemand
 * innerhalb der Frist eine Farbe - auch eine Kalenderfarbe, und auch an einer
 * schon geheilten Zeile -, ist das eine Wahl nach Fristbeginn, und die bleibt,
 * selbst wenn der Server die COLOR-Zeile verwirft. Ein Zeitstempel, den nur
 * eine lokale Bearbeitung setzt, gibt es nicht (`updated_at` setzt ein Trigger
 * bei jedem UPDATE, auch beim Sync); die Farbe selbst ist der Vergleich.
 *
 * EINE FRIST STATT EINES FERTIG-MERKERS. Wann ein Konto "fertig" ist, laesst
 * sich nicht sicher sagen: eine leere Antwort, ein abgewaehlter oder kurz
 * fehlender Kalender, ein verworfener VEVENT - jede Regel dafuer liess die
 * Heilung entweder zu frueh enden oder nie. Eine feste Zeit endet sicher und
 * gibt jedem Termin, den ein Lauf in dieser Zeit sieht, seine Heilung.
 */
function legacyHealState(conn, accountId, { serverCalendars = [], cutoff = null, now = new Date() } = {}) {
  const key = legacyColorHealKey(accountId);
  const snapshotKey = legacyColorSnapshotKey(accountId);
  const value = conn.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;
  if (value == null) {
    // Fristbeginn: Frist und Schnappschuss in EINER Anweisung, damit es keinen
    // Stand mit dem einen und ohne das andere gibt.
    const colors = legacyCalendarColors(conn, accountId, serverCalendars);
    // Schon lokal umgefaerbt, bevor dieser Schnappschuss entsteht: keine
    // Altlast. Ist die Vormerkliste unlesbar, nimmt er nichts auf.
    const chosen = legacyColorChosenIds(conn);
    const snapshot = new Map();
    for (const row of chosen === null ? [] : legacyCandidateRows(conn, cutoff)) {
      const color = String(row.color).toLowerCase();
      if (colors.has(color) && !chosen.has(row.id)) snapshot.set(row.id, color);
    }
    conn.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?), (?, ?)').run(
      key, now.toISOString(), snapshotKey, JSON.stringify(Object.fromEntries(snapshot))
    );
    return { colors, snapshot };
  }
  // `never` (und jeder andere Wert, der kein Datum ist) schaltet die Heilung
  // aus. Ein Beginn in der Zukunft - die Uhr ging beim Start vor - verlaengert
  // sie nicht.
  //
  // Bekannte Grenze: die Frist beginnt mit dem ersten Lauf, bei einem Konto,
  // das lange nicht synchronisiert, also spaet. Das ist dasselbe Risiko wie
  // ein frueher Beginn; eine gerade gewaehlte Farbe schuetzt der Schnappschuss
  // (und fuer den laufenden Sync die Neupruefung im UPDATE).
  const since = Date.parse(value);
  const elapsed = now.getTime() - since;
  if (!(Number.isFinite(since) && elapsed >= 0 && elapsed < LEGACY_HEAL_DAYS * 24 * 60 * 60 * 1000)) return null;
  // Fehlt der Schnappschuss oder ist er unlesbar, heilt nichts (fail closed).
  let parsed;
  try { parsed = JSON.parse(conn.prepare('SELECT value FROM sync_config WHERE key = ?').get(snapshotKey)?.value ?? ''); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const snapshot = new Map(Object.entries(parsed).map(([id, color]) => [Number(id), String(color).toLowerCase()]));
  return { colors: legacyCalendarColors(conn, accountId, serverCalendars), snapshot };
}

/**
 * Die Altzeilen, die die Heilung ueberhaupt fassen darf, ohne die Frage nach
 * der Farbe des Kontos: CalDAV, color_modified = 1, user_modified = 1, mit
 * Farbe, vor dem Fix entstanden, und hochgeladene nur mit ihrer Zielfarbe.
 */
function legacyCandidateRows(conn, cutoff) {
  return conn.prepare(`
    SELECT id, color FROM calendar_events
    WHERE external_source = 'caldav'
      AND color_modified = 1 AND user_modified = 1 AND color IS NOT NULL
      AND ${uploadedRowRule('calendar_events.')}
      AND (? IS NULL OR datetime(created_at) <= datetime(?))
  `).all(cutoff, cutoff);
}

/**
 * Gibt es Altzeilen, die an keinem Kalender eines ANDEREN Kontos haengen und
 * die dieses Konto damit per UID uebernehmen koennte? Nur dann heilt ein neu
 * angelegtes oder umgehaengtes Konto (#1270).
 *
 * Ein wirklich neues Konto hat keine Termine aus der Zeit vor v2.50. Ein WIEDER
 * angelegtes schon: `deleteAccount` laesst die Termine standardmaessig stehen,
 * und der Inbound uebernimmt sie per UID - samt eingebrannter Farbe. Loeschen
 * und neu Anlegen ist genau das, was jemand mit falschen Farben versucht.
 * Abgegrenzt wird ueber die Zeilen selbst, nicht ueber die URLs des Kontos:
 * die Zeile kann noch auf einen Kalender zeigen, der auf dem Server laengst
 * geloescht ist, waehrend ihr Termin in einem anderen liegt.
 */
function hasOrphanedLegacyRows(conn, accountId) {
  const cutoff = legacyColorCutoff(conn);
  return !!conn.prepare(`
    SELECT 1 FROM calendar_events e
    LEFT JOIN external_calendars x ON x.id = e.calendar_ref_id
    WHERE e.external_source = 'caldav'
      AND e.color_modified = 1 AND e.user_modified = 1 AND e.color IS NOT NULL
      AND ${uploadedRowRule('e.')}
      AND (? IS NULL OR datetime(e.created_at) <= datetime(?))
      AND (x.external_id IS NULL
           OR x.external_id NOT IN (SELECT calendar_url FROM caldav_calendar_selection WHERE account_id <> ?))
    LIMIT 1
  `).get(cutoff, cutoff, accountId);
}

/** Heilung fuer dieses Konto neu entscheiden: Frist verwerfen, ggf. ganz aus. */
function decideLegacyHeal(conn, accountId) {
  const key = legacyColorHealKey(accountId);
  conn.prepare('DELETE FROM sync_config WHERE key IN (?, ?)').run(key, legacyColorSnapshotKey(accountId));
  if (!hasOrphanedLegacyRows(conn, accountId)) {
    conn.prepare("INSERT INTO sync_config (key, value) VALUES (?, 'never')").run(key);
  }
}

/**
 * Die Kalenderfarben, die der alte Import (bis v2.48) in Termine DIESES Kontos
 * eingebrannt haben kann (#1270), kleingeschrieben.
 *
 * Nur Sammlungen, die Termine fuehren: eine reine Aufgabenliste (VTODO) hat
 * nie eine Farbe in einen VEVENT eingebrannt. Konten von vor dem
 * Komponentenfilter tragen solche Listen noch in der Auswahl (#617). Soweit
 * `serverCalendars` die Faehigkeiten einer Sammlung kennt, zaehlt ihre Farbe
 * deshalb nur mit VEVENT; eine Sammlung, die der Server nicht (mehr) meldet,
 * zaehlt wie bisher.
 *
 * Zwei Quellen. Die Auswahl des Kontos traegt jeden Kalender, den der Server
 * noch meldet, auch abgewaehlte. Ein inzwischen auf dem Server GELOESCHTER
 * Kalender faellt beim Aktualisieren aus der Auswahl, seine Farbe steht dann
 * nur noch in `external_calendars` - und genau das ist der Fall, in dem jemand
 * Termine aus einem alten Kalender umzieht und ihn danach aufgibt. Diese
 * Tabelle kennt aber kein Konto. Einem Konto zugerechnet wird ein Eintrag dort
 * deshalb nur, wenn er in keiner fremden Auswahl steht UND im selben
 * Kalender-Home liegt wie ein Kalender dieses Kontos (die URL ohne ihr letztes
 * Segment: `/calendars/<nutzer>/` bei Nextcloud und Radicale, `/<dsid>/calendars/`
 * bei iCloud). Sonst heilte die Farbe eines fremden Kontos eine hier bewusst
 * gewaehlte.
 *
 * Das Home ist eine Schaetzung, und im Zweifel wird NICHT zugerechnet: bei
 * einer Sammlung, die per Query adressiert wird (`urlParts()` in
 * utils/caldav-client.js haelt den Query bewusst als Teil der Identitaet),
 * sagt der Pfad nichts ueber den Besitzer; ein Home direkt an der Wurzel
 * teilen sich alle Konten eines Servers; und ein Home, in dem auch ein anderes
 * Konto Kalender fuehrt, gehoert keinem allein. Die Auswahl des Kontos selbst
 * ist davon nicht betroffen - sie ist gespeicherter Besitz, keine Schaetzung.
 *
 * Bekannte Grenze: manche Server legen alle Konten unter ein gemeinsames erstes
 * Segment ohne Nutzersegment (OX/mailbox.org: `/caldav/<base64-id>/`). Deren
 * Home ist `/caldav/` fuer jeden. `foreignHomes` erkennt das nur, solange das
 * andere Konto lebt und eine Auswahl hat - der Kalender eines GELOESCHTEN
 * OX-Kontos kann dem verbliebenen zugerechnet werden. Ein Schaden entsteht dann
 * nur bei einer exakt gleichen, bewusst gewaehlten Farbe. Von Radicale
 * (`/<nutzer>/<kalender>/`, Home ebenfalls ein Segment tief) ist das am Pfad
 * nicht zu unterscheiden, deshalb bleibt es bei diesem Hinweis.
 */
function legacyCalendarColors(conn, accountId, serverCalendars = []) {
  const byUrl = new Map(serverCalendars.map((sc) => [sc.url, sc]));
  // Meldet der Server die Sammlung, entscheiden ihre Faehigkeiten. Meldet er
  // sie nicht mehr, weiss niemand, was sie war: die Auswahl speichert weder
  // Komponenten noch den Grund einer Abschaltung. Eine ABGESCHALTETE Auswahl,
  // die der Server nicht mehr listet, zaehlt deshalb nicht mit - sie kann eine
  // frueher automatisch abgeschaltete Aufgabenliste sein. Ein auf dem Server
  // geloeschter Kalender, der Termine fuehrte, zaehlt weiter ueber
  // `external_calendars`: dort landen nur Sammlungen, die als Terminkalender
  // gelesen wurden.
  const holdsEvents = (url, enabled = true) => (byUrl.has(url)
    ? supportsComponent(byUrl.get(url), 'VEVENT')
    : enabled);
  const colors = new Set();
  const homes = new Set();
  const own = conn.prepare(
    'SELECT calendar_url, calendar_color, enabled FROM caldav_calendar_selection WHERE account_id = ?'
  ).all(accountId);
  for (const row of own) {
    const h = calendarHome(row.calendar_url);
    if (h) homes.add(h);
    if (row.calendar_color && holdsEvents(row.calendar_url, row.enabled === 1)) {
      colors.add(String(row.calendar_color).toLowerCase());
    }
  }
  const foreignRows = conn.prepare(
    'SELECT calendar_url FROM caldav_calendar_selection WHERE account_id <> ?'
  ).all(accountId);
  const foreign = new Set(foreignRows.map((row) => row.calendar_url));
  // Ein Home, in dem auch ein anderes Konto Kalender fuehrt, ist nicht
  // eindeutig: ein verwaister Kalender darin koennte jedem der beiden gehoeren.
  const foreignHomes = new Set(foreignRows.map((row) => calendarHome(row.calendar_url)).filter(Boolean));
  const known = conn.prepare(
    "SELECT external_id, color FROM external_calendars WHERE source = 'caldav' AND color IS NOT NULL"
  ).all();
  for (const row of known) {
    if (foreign.has(row.external_id)) continue;
    const h = calendarHome(row.external_id);
    if (!h || !homes.has(h) || foreignHomes.has(h) || !holdsEvents(row.external_id)) continue;
    colors.add(String(row.color).toLowerCase());
  }
  return colors;
}

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

  // Konto, Kalenderauswahl und die Entscheidung ueber die Farb-Heilung
  // (#1270) in EINEM Zug: ein Konto ohne diese Entscheidung heilte, obwohl es
  // nichts zu heilen gibt, und eine Entscheidung ohne Konto zeigte ins Leere.
  const insertAccount = db.get().transaction(() => {
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

    // Hat das neue Konto nichts zu heilen, laeuft die Heilung dort nie (#1270).
    // NACH der neuen Auswahl entschieden: eine hochgeladene Altzeile zaehlt nur
    // mit der Farbe ihres Zielkalenders, und die kann allein in dieser Auswahl
    // stehen. Die Auswahl des neuen Kontos selbst macht keine Zeile zu einer
    // mit lebendem Konto - die Abfrage sieht nur die ANDERER Konten.
    decideLegacyHeal(db.get(), accountId);
    return { accountId, calendarData };
  });
  const { accountId, calendarData } = insertAccount();

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

  // Neue Adresse oder neuer Benutzer heisst: ein anderes Konto unter derselben
  // ID, das womoeglich Termine eines geloeschten uebernimmt. Die Frist der
  // Farb-Heilung (#1270) gilt dem alten und wird neu entschieden. Nur bei
  // einer ECHTEN Aenderung: ein Schraegstrich am Ende, ein grossgeschriebener
  // Host oder der Standardport sind dieselbe Adresse. Ein neues Passwort
  // laesst die Frist stehen.
  if ((caldavUrl && !sameAccountUrl(caldavUrl, account.caldav_url))
      || (username && username !== account.username)) {
    decideLegacyHeal(db.get(), accountId);
  }

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
    // Die Frist der Farb-Heilung (#1270) haengt an keinem Fremdschluessel.
    db.get().prepare('DELETE FROM sync_config WHERE key IN (?, ?)')
      .run(legacyColorHealKey(accountId), legacyColorSnapshotKey(accountId));
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
    `SELECT id, outbound_dirty, calendar_ref_id, start_datetime, color, color_modified FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'caldav'`
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
  // Eingebrannte Kalenderfarbe aus der Zeit vor #891 loesen (#1270). Bis
  // v2.48 schrieb der Import die Farbe des Kalenders in die Eigenfarb-Spalte,
  // und Migration 167 hat jede damals schon bearbeitete Zeile als "lokal
  // umgefaerbt" uebernommen (color_modified = user_modified). Seitdem gewinnt
  // diese geerbte Farbe dauerhaft gegen die der zugewiesenen Person - und nach
  // einem Umzug in einen anderen Kalender ist es sogar die Farbe des ALTEN.
  //
  // DAS KEHRT DIE ABWAEGUNG VON MIGRATION 167 UM, und zwar nur hier. Die
  // Migration hat alle bearbeiteten Zeilen geschuetzt, weil sie eine
  // eingebrannte Farbe von einer bewusst gewaehlten nicht trennen konnte: sie
  // sah nur die Zeile. Der Sync sieht mehr. Seit #897/#899 schreibt der
  // Ausgang eine in Yuvomi gewaehlte Farbe als COLOR-Zeile auf den Server, und
  // der Inbound liest sie als Eigenfarbe - eine Farbe, die dem Termin wirklich
  // gehoert, steht also am VEVENT. Fehlt dort die COLOR-Zeile und ist der
  // gespeicherte Wert genau die Farbe eines Kalenders DIESES Kontos, bleibt als
  // Herkunft praktisch nur der alte Import. Der Farbwaehler bietet nur die
  // feste Palette an; eine bewusste Wahl trifft einen Kalenderwert also nur
  // zufaellig.
  //
  // EINE FEST BEGRENZTE ZEIT JE KONTO (LEGACY_HEAL_DAYS ab seinem ersten Lauf
  // nach dem Update), nicht fuer immer: es ist eine Reparatur von Altlasten,
  // und jeder weitere Lauf truege nur das Fehlalarm-Risiko weiter. Geheilt
  // wird erst, wenn alle Kalender des Laufs gelesen sind: ein Termin, der beim
  // Umzug kurz in zwei Kalendern steht, gehoert sich selbst, sobald IRGENDEINE
  // Kopie eine COLOR-Zeile traegt - die Reihenfolge der Kalender darf das
  // Ergebnis nicht bestimmen.
  //
  // `user_modified = 1`: nur diese Zeilen hat Migration 167 als "umgefaerbt"
  // uebernommen. Ein alter lokaler Termin, der jetzt hochgeladen wird, bleibt
  // bei 0 und ist kein Kandidat. Bearbeitet ihn danach jemand, setzt die Route
  // user_modified = 1 (routes/calendar/crud.js) - dann kann er geheilt werden,
  // sofern er vor dem Fix entstand und der Server ihn ohne COLOR-Zeile
  // zurueckgibt. Das ist hingenommen: die Bearbeitung schickt seine Farbe als
  // COLOR-Zeile hinaus, und behaelt der Server sie, gehoert sie dem Termin.
  // Geheilt wird zum Zustand "nie eine gelernt" (color_modified = 0), damit
  // der Ausgang auf dem Server nichts loescht.
  //
  // NUR ZEILEN, DIE AELTER SIND ALS DER FIX. Eingebrannt hat allein der Import
  // vor #891, und #891 kam mit Migration 166. Eine Zeile, die nach deren
  // `applied_at` angelegt wurde, hat nie eine geerbte Farbe bekommen - auch
  // nicht auf einem Konto, das zwischen v2.49 und diesem Update angelegt
  // wurde, und auch nicht nach einem Loeschen und Neuanlegen des Kontos. Ohne
  // `schema_migrations` (nur in gekuerzten Test-Fixtures, nie nach
  // `migrate()`) gilt keine Altersgrenze.
  //
  // `<=`, nicht `<`: beide Zeitstempel haben nur Sekunden. Eine Zeile aus der
  // Sekunde der Migration kann noch vom alten Import stammen. Eine Zeile NACH
  // dem Fix in derselben Sekunde muesste importiert UND von Hand bearbeitet
  // (user_modified = 1) UND auf eine Kalenderfarbe umgefaerbt sein - in einer
  // Sekunde, in der der Server gerade erst migriert hat.
  const legacyCutoff = legacyColorCutoff(conn);
  const healBurntInColor = conn.prepare(`
    UPDATE calendar_events SET color = NULL, color_modified = 0
    WHERE id = ? AND color_modified = 1 AND user_modified = 1
      AND outbound_dirty = 0 AND outbound_move_to IS NULL AND lower(color) = lower(?)
      AND ${uploadedRowRule('calendar_events.')}
      AND (? IS NULL OR datetime(created_at) <= datetime(?))
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

      // Heilung eingebrannter Kalenderfarben (#1270), siehe oben. Nach dem
      // Abruf der Kalender, weil deren Faehigkeiten die Farbmenge begrenzen.
      const heal = legacyHealState(conn, account.id, { serverCalendars, cutoff: legacyCutoff });
      // Kandidaten erst sammeln, geheilt wird nach allen Kalendern: UIDs, die
      // in IRGENDEINER Kopie dieses Laufs eine COLOR-Zeile tragen, bleiben.
      const healCandidates = new Map();
      const coloredUids = new Set();
      const changedIds = new Set();

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
                // `hasColor`, nicht `evColor`: auch eine COLOR-Zeile mit einem
                // unlesbaren Wert (etwa #RRGGBBAA) sagt, dass der Server ueber
                // DIESEN Termin spricht.
                if (ev.hasColor) coloredUids.add(ev.uid);
                else if (heal !== null
                  && existing.color_modified === 1 && existing.color != null
                  && heal.colors.has(String(existing.color).toLowerCase())
                  && heal.snapshot.get(existing.id) === String(existing.color).toLowerCase()) {
                  healCandidates.set(existing.id, { uid: ev.uid, color: existing.color });
                }
                changed = updEvent.run(...values, existing.id, ...values).changes > 0;
                eventId = existing.id;
                // Auf dem Server verschoben (#1377): die Erinnerungen ziehen mit.
                if (changed) followInboundStartChange(conn, eventId, existing.start_datetime, ev.dtstart);
                // Von einem Kalender in einen anderen verschoben (#1270): die
                // unangetastete Standard-Zuweisung zieht mit um.
                reassignDefaultOnCalendarMove(db.get(), eventId, {
                  fromCalRefId: existing.calendar_ref_id,
                  toCalRefId: calRefId,
                  toDefaultUserId: calDefaultAssignee,
                });
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
              if (changed) { accountChangedCount++; changedIds.add(eventId); }
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

      // Farb-Heilung (#1270): erst jetzt, nachdem jede Kopie jeder UID gesehen
      // wurde. Eine reine Heilung zaehlt als Aenderung, aber nur einmal je Termin.
      // Zwischen dem Sammeln und hier liegen die awaits der uebrigen Kalender:
      // waehlt in der Zeit jemand eine Farbe, steht der Termin auf
      // outbound_dirty und traegt eine andere Farbe. Das UPDATE prueft beides
      // neu, sonst naehme es die gerade gewaehlte Farbe mit. Ein anstehender
      // Umzug (outbound_move_to) schuetzt ebenso: ein reiner Umzug setzt kein
      // outbound_dirty, und danach zeigt target_caldav_calendar_url schon auf
      // den neuen Kalender.
      const healedIds = [];
      for (const [eventId, { uid, color }] of healCandidates) {
        if (coloredUids.has(uid)) continue;
        if (healBurntInColor.run(eventId, color, legacyCutoff, legacyCutoff).changes > 0) {
          healedIds.push(eventId);
          if (!changedIds.has(eventId)) accountChangedCount++;
        }
      }
      // Geheilt faellt die Zeile aus dem Schnappschuss: eine spaetere Wahl
      // derselben Farbe ist dann eine Wahl, keine Altlast. Gelesen wird der
      // gespeicherte Stand, nicht der dieses Laufs - eine Umfaerbung ueber die
      // Route waehrend des Laufs hat ihn womoeglich schon verkleinert.
      forgetLegacyColorSnapshot(conn, healedIds);

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
