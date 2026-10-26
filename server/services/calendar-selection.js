// --------------------------------------------------------
// Welche Kalender die Kalender-Kachel der Uebersicht zeigt (#2062, aus D#2037).
//
// EIN KALENDER HAT HIER DEN SCHLUESSEL DES KALENDERMODULS: `local:<id>` fuer
// einen eigenen Kalender, `cal:<id>` fuer einen synchronisierten (CalDAV,
// Google - eine Zeile in `external_calendars`), `sub:<id>` fuer ein ICS-Abo.
// Dieselbe Rangfolge wie `eventSourceKey` in public/pages/calendar.js: das Abo
// zuerst, dann die aufgeloeste Quelle (`SOURCE_CALENDAR_JOIN`, auch fuer einen
// noch nicht hochgeladenen Termin), dann der eigene Kalender. Ein Termin ohne
// Schluessel (Geburtstage, Besuche der Haushaltshilfe) gehoert keinem Kalender
// und faellt durch keine Auswahl - wie im Filterblatt des Moduls; die
// Geburtstage haben ihren eigenen Schalter an derselben Kachel.
//
// WAS ES GIBT, SAGT EINE STELLE (`calendarSources`): der Katalog des
// Optionen-Dialogs und die Pruefung der Auswahl in der Route lesen dieselbe
// Liste. Ein synchronisierter Kalender zaehlt, solange er einen Termin traegt,
// den die Person sehen darf (auch einen, der erst hochgeladen wird) - `external_calendars` wird beim Trennen eines
// Kontos nie geleert, nur seine Termine verschwinden. So faellt ein entfernter
// Kalender still aus der Auswahl, ob lokal geloescht, Abo entfernt oder Konto
// getrennt.
// --------------------------------------------------------

import { SOURCE_CALENDAR_JOIN } from './calendar-events.js';
import { localCalendarIdSql } from './local-calendars.js';
import { visibilityWhere } from './visibility.js';

const KEY_RE = /^(local|cal|sub):([1-9]\d{0,14})$/;
const MAX_SELECTION = 50;

/**
 * `?events_calendar=` als Liste von Schluesseln: einzeln oder mehrfach
 * angegeben, nur `local:N`, `cal:N` oder `sub:N`, ohne Doppelte, hoechstens 50 -
 * dieselbe Grenze wie die gespeicherten Optionen (preferences.js). Alles andere
 * faellt weg, nie ein Fehler.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeCalendarSelection(raw) {
  if (raw === undefined || raw === null) return [];
  return [...new Set(
    (Array.isArray(raw) ? raw : [raw]).filter((value) => typeof value === 'string' && KEY_RE.test(value)),
  )].slice(0, MAX_SELECTION);
}

/**
 * Die Kalender, die diese Person waehlen kann: eigene, synchronisierte mit
 * einem fuer sie sichtbaren Termin, und die Abos, die sie sieht (geteilt oder
 * eigenes - dieselbe Regel wie `GET /calendar/subscriptions`). Eigene zuerst
 * in der Reihenfolge der Verwaltung, danach die uebrigen nach Namen.
 *
 * @param {object} d better-sqlite3-Connection
 * @param {number|null} viewerId
 * @returns {{ key: string, name: string, color: string|null }[]}
 */
export function calendarSources(d, viewerId) {
  const local = d.prepare(`
    SELECT id, name, color FROM local_calendars
    ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
  `).all().map((row) => ({ key: `local:${row.id}`, name: row.name, color: row.color ?? null }));
  // Ueber dieselbe Aufloesung wie die Leser (`SOURCE_CALENDAR_JOIN`), nicht
  // nur ueber `calendar_ref_id`: ein neuer Termin fuer Google oder CalDAV traegt
  // die Kennung erst nach dem Hochladen (Codex-Review zu PR #2268). Waere er
  // der einzige des Kalenders, fehlte der Kalender sonst im Dialog, und eine
  // gespeicherte Auswahl fiele weg, waehrend die Leser ihn laengst zuordnen.
  const synced = d.prepare(`
    SELECT DISTINCT src.id, src.name, src.color
    FROM calendar_events e
    ${SOURCE_CALENDAR_JOIN}
    WHERE src.id IS NOT NULL AND e.subscription_id IS NULL
      AND ${visibilityWhere('e', 'event_assignments', 'event_id', '@viewer')}
  `).all({ viewer: viewerId }).map((row) => ({ key: `cal:${row.id}`, name: row.name, color: row.color ?? null }));
  const subscriptions = d.prepare(`
    SELECT id, name, color FROM ics_subscriptions WHERE shared = 1 OR created_by = ?
  `).all(viewerId).map((row) => ({ key: `sub:${row.id}`, name: row.name, color: row.color ?? null }));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return [...local, ...[...synced, ...subscriptions].sort(byName)];
}

/**
 * Die Auswahl aus der Anfrage, geprueft gegen den Katalog. Was es nicht (mehr)
 * gibt, faellt weg; bleibt nichts uebrig, ist das `null` - keine Auswahl heisst
 * "alle Kalender", nie eine leere Kachel.
 *
 * @param {object} d
 * @param {unknown} raw `req.query.events_calendar`
 * @param {number|null} viewerId
 * @returns {string[]|null}
 */
export function resolveCalendarSelection(d, raw, viewerId) {
  const wanted = normalizeCalendarSelection(raw);
  if (!wanted.length) return null;
  const available = new Set(calendarSources(d, viewerId).map((source) => source.key));
  const kept = wanted.filter((key) => available.has(key));
  return kept.length ? kept : null;
}

/**
 * Das WHERE-Fragment zur Auswahl fuer die Termin-Leser
 * (services/calendar-event-reader.js). Braucht die Aliase `e` (calendar_events)
 * und `src` (`SOURCE_CALENDAR_JOIN`). Ohne Auswahl leer.
 *
 * @param {string[]|null} keys
 * @returns {{ sql: string, params: string[] }}
 */
export function calendarSelectionSql(keys) {
  if (!Array.isArray(keys) || !keys.length) return { sql: '', params: [] };
  const key = `COALESCE('sub:' || e.subscription_id, 'cal:' || src.id, 'local:' || ${localCalendarIdSql('e')})`;
  return {
    sql: `
    AND (${key} IS NULL OR ${key} IN (${keys.map(() => '?').join(', ')}))`,
    params: [...keys],
  };
}
