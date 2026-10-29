import { randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_CALENDAR_NAME = 'Yuvomi';
const DEFAULT_CALENDAR_COLOR = '#007AFF';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function serializeCalendar(req, row, feedUrl, { includeFeedToken = false } = {}) {
  if (!row) return null;
  const token = includeFeedToken ? (row.feed_token ?? null) : null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    is_default: !!row.is_default,
    sort_order: row.sort_order ?? 0,
    feed_token: token,
    feed_url: token ? feedUrl(req, token) : null,
  };
}

function ensureDefaultCalendar(conn) {
  let row = conn.prepare(`
    SELECT * FROM local_calendars
    WHERE is_default = 1
    ORDER BY id
    LIMIT 1
  `).get();
  if (row) return row;

  const id = conn.prepare(`
    INSERT INTO local_calendars (name, color, is_default, sort_order, created_by)
    VALUES (?, ?, 1, 0, ?)
  `).run(DEFAULT_CALENDAR_NAME, DEFAULT_CALENDAR_COLOR, null).lastInsertRowid;
  return conn.prepare('SELECT * FROM local_calendars WHERE id = ?').get(id);
}

function defaultCalendarId(conn) {
  return ensureDefaultCalendar(conn).id;
}

function localCalendarById(conn, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return conn.prepare('SELECT * FROM local_calendars WHERE id = ?').get(numeric) ?? null;
}

// Ein gewaehlter Kalender, den es inzwischen nicht mehr gibt, ist ein Fall, den
// ein Nutzer im Termin-Dialog erreicht (jemand hat ihn in der Verwaltung
// geloescht): er traegt `reason` (#1909). Eine Kennung, die keine Zahl ist,
// schickt nur ein Aufrufer der API.
function validateCalendarId(conn, raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    return { value: required ? null : undefined, error: required ? 'Calendar: choose a valid calendar.' : null };
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    return { value: null, error: 'Calendar: choose a valid calendar.' };
  }
  const row = localCalendarById(conn, id);
  if (!row) {
    return { value: null, error: 'Calendar: this calendar no longer exists.', reason: 'calendar_selected_calendar_not_found' };
  }
  return { value: row.id, error: null };
}

const CALENDAR_NAME_MAX = 80;

// Ein leerer oder zu langer Name ist ein Fall, den ein Nutzer im Dialog
// erreicht: er traegt `reason` und die Grenze (#1909). Ein Name, der kein Text
// ist, kommt nur von einem Aufrufer der API.
function validateCalendarName(value) {
  if (typeof value !== 'string') return { value: null, error: 'Name must be text.' };
  const name = value.trim();
  if (!name || name.length > CALENDAR_NAME_MAX) {
    return {
      value: null,
      error: `Name: enter a name of at most ${CALENDAR_NAME_MAX} characters.`,
      reason: 'calendar_name_invalid',
      params: { limit: CALENDAR_NAME_MAX },
    };
  }
  return { value: name, error: null };
}

function validateCalendarColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value.trim())) {
    return { value: null, error: 'Color: enter a valid hex color.' };
  }
  return { value: value.trim().toUpperCase(), error: null };
}

function findCalendarByFeedToken(conn, token) {
  if (!token) return null;
  const candidate = Buffer.from(token, 'utf8');
  for (const row of conn.prepare(`
    SELECT * FROM local_calendars WHERE feed_token IS NOT NULL
  `).all()) {
    const stored = Buffer.from(row.feed_token, 'utf8');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return row;
  }
  return null;
}

function regenerateCalendarFeedToken(conn, calendarId) {
  const token = randomBytes(32).toString('base64url');
  conn.prepare('UPDATE local_calendars SET feed_token = ? WHERE id = ?').run(token, calendarId);
  return token;
}

function clearCalendarFeedToken(conn, calendarId) {
  conn.prepare('UPDATE local_calendars SET feed_token = NULL WHERE id = ?').run(calendarId);
}

export {
  CALENDAR_NAME_MAX,
  DEFAULT_CALENDAR_NAME,
  DEFAULT_CALENDAR_COLOR,
  ensureDefaultCalendar,
  defaultCalendarId,
  localCalendarById,
  validateCalendarId,
  validateCalendarName,
  validateCalendarColor,
  serializeCalendar,
  findCalendarByFeedToken,
  regenerateCalendarFeedToken,
  clearCalendarFeedToken,
};

/** The single membership resolver: authored events only, default applied on read.
 * SQL form lets feeds, counts and event projections use the exact same rule.
 */
export function localCalendarIdSql(alias = 'e') {
  return `(CASE WHEN ${alias}.external_source = 'local'
    AND ${alias}.target_google_calendar_id IS NULL
    AND ${alias}.target_caldav_account_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM birthdays b
      WHERE b.calendar_event_id = ${alias}.id OR b.name_day_calendar_event_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM housekeeping_work_sessions h WHERE h.calendar_event_id = ${alias}.id)
    THEN COALESCE(${alias}.local_calendar_id,
      (SELECT id FROM local_calendars WHERE is_default = 1)) END)`;
}

/** Preserve the original event colours until a household has multiple local calendars. */
export function localCalendarColorSql(alias = 'lc') {
  return `(CASE WHEN (SELECT COUNT(*) FROM local_calendars) > 1 THEN ${alias}.color END)`;
}

export function resolveLocalCalendarId(conn, eventId) {
  return conn.prepare(`SELECT ${localCalendarIdSql()} AS id FROM calendar_events e WHERE e.id = ?`)
    .get(eventId)?.id ?? null;
}

export function localCalendarProjection(conn, eventId) {
  return conn.prepare(`
    SELECT lc.id AS local_calendar_id, lc.name AS local_calendar_name, ${localCalendarColorSql()} AS local_calendar_color
    FROM calendar_events e LEFT JOIN local_calendars lc ON lc.id = ${localCalendarIdSql()}
    WHERE e.id = ?
  `).get(eventId);
}

/* DIE FARBE EINES IMPORTS IST DIE DES KALENDERS (#2303).
 *
 * Der einmalige ICS-Import schrieb die Farbe aus dem Formular in JEDE Zeile
 * (`calendar_events.color`), und die Eigenfarbe schlaegt die Kalenderfarbe
 * (utils/event-color.js). Solange importierte Termine keinen Kalender hatten,
 * war das die einzige Farbe, die sie bekommen konnten. Seit es lokale Kalender
 * gibt, landen sie in einem - und „Kalender verwalten" faerbte dann den
 * Kalender um, die Termine aber nicht.
 *
 * Gleich der Kalenderfarbe ist die Formularfarbe keine eigene Wahl, sondern
 * eine Kopie: die Zeile bleibt leer und erbt. Nur ab zwei Kalendern, denn erst
 * dann zeigt der Lesepfad die Kalenderfarbe (`localCalendarColorSql`); mit
 * einem einzigen Kalender stuende der Termin sonst grau da. Eine ABWEICHENDE
 * Formularfarbe bleibt, wie sie ist - die hat jemand fuer diesen Import
 * gewaehlt. */
function hasSeveralCalendars(conn) {
  return conn.prepare('SELECT COUNT(*) AS n FROM local_calendars').get().n > 1;
}

const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();

/**
 * Die Eigenfarbe, die ein importierter Termin bekommt, und ob sie GEWAEHLT ist.
 *
 * Die Herkunft steht in `color_modified` (1 = gewaehlt, 0 = Kopie der
 * Kalenderfarbe): nur eine Kopie folgt dem Kalender beim Umfaerben
 * (`releaseCopiedCalendarColor`) und beim Schritt zurueck auf einen Kalender
 * (`restoreInheritedImportColors`). Gewaehlt ist eine Formularfarbe, die von
 * der Kalenderfarbe abweicht; gleicht sie ihr, ist sie eine Kopie - ab zwei
 * Kalendern bleibt die Spalte dann leer und erbt, mit einem einzigen steht die
 * Kopie drin, weil der Lesepfad dort keine Kalenderfarbe zeigt.
 * @param {object} conn
 * @param {?number} calendarId  Zielkalender, `null` heisst Standardkalender
 * @param {?string} color       Farbe aus dem Importformular, leer = Kalenderfarbe
 * @returns {{ color: ?string, chosen: boolean }}
 */
export function importedEventColor(conn, calendarId, color) {
  const calendar = localCalendarById(conn, calendarId ?? defaultCalendarId(conn));
  const value = color || calendar?.color || null;
  if (!value) return { color: null, chosen: false };
  if (!calendar || !sameHex(value, calendar.color)) return { color: value, chosen: true };
  return { color: hasSeveralCalendars(conn) ? null : value, chosen: false };
}

/**
 * Bestandsdaten ohne Migration: wird ein Kalender umgefaerbt, verlieren seine
 * importierten Termine die bis zum Fix kopierte ALTE Kalenderfarbe und erben
 * ab da. Nur Importe (UID, keine Abo-Quelle, lokal), nur unveraendert
 * gefaerbte (`color_modified = 0`) und nur exakt die alte Kalenderfarbe - ein
 * von Hand angelegter Termin oder eine bewusst andere Farbe bleibt stehen.
 * @returns {number} geaenderte Zeilen
 */
export function releaseCopiedCalendarColor(conn, calendarId, oldColor) {
  if (!oldColor || !hasSeveralCalendars(conn)) return 0;
  return conn.prepare(`
    UPDATE calendar_events AS e SET color = NULL
    WHERE ${localCalendarIdSql('e')} = @calendarId
      AND e.external_source = 'local'
      AND e.subscription_id IS NULL
      AND e.external_calendar_id IS NOT NULL
      AND e.color_modified = 0
      AND UPPER(e.color) = UPPER(@oldColor)
  `).run({ calendarId, oldColor }).changes;
}

/**
 * Der Schritt zurueck auf EINEN Kalender (#2303, Review): ab dann zeigt der
 * Lesepfad keine Kalenderfarbe mehr (`localCalendarColorSql`), und ein Import,
 * der bis hierher geerbt hat (Eigenfarbe leer), stuende grau da. Er bekommt die
 * Farbe des verbliebenen Kalenders zurueck - dieselbe, die er zuletzt gezeigt
 * hat oder (aus dem geloeschten Kalender umgezogen) ein Import mit einem
 * Kalender bekommen haette. Nur Importe ohne ausdrueckliche Farbwahl
 * (`color_modified = 0`); ein bewusst geleerter Termin bleibt leer.
 * @returns {number} geaenderte Zeilen
 */
export function restoreInheritedImportColors(conn) {
  if (hasSeveralCalendars(conn)) return 0;
  const calendar = ensureDefaultCalendar(conn);
  return conn.prepare(`
    UPDATE calendar_events AS e SET color = @color
    WHERE ${localCalendarIdSql('e')} = @calendarId
      AND e.external_source = 'local'
      AND e.subscription_id IS NULL
      AND e.external_calendar_id IS NOT NULL
      AND e.color_modified = 0
      AND e.color IS NULL
  `).run({ calendarId: calendar.id, color: calendar.color }).changes;
}
