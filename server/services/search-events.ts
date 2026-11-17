/**
 * Module: the event helpers of the search (phase 2, section D)
 * Purpose: the window a series hit looks for its next occurrence in, the resolution
 *          of event hits through the calendar's occurrence contract, the order
 *          "upcoming first", and the birthday fields of a birthday event. Shared by
 *          the event slice of the global search (calendar-slices.ts) and the
 *          calendar search (routes/calendar/read.js, through services/search.js,
 *          which re-exports these names). Its own file so the slice and
 *          services/search.js import it without a cycle.
 *
 * Dependencies: services/calendar-events.js, services/calendar-event-reader.js,
 *               utils/timezone.js. Erasable TS syntax only.
 */

import type { Database } from '../authorize/index.ts';
import {
  expandRecurringEvents, loadEventExceptions, seriesReadingZone,
} from './calendar-events.js';
import { resolveProjectedEventRows } from './calendar-event-reader.js';
import { householdTimeZone, shiftDateKey, storedToInstantMs, todayKey } from '../utils/timezone.js';

type EventRow = Record<string, unknown>;

// Wie viele Termin-Treffer AUFGELOEST werden, bevor die fuenf fruehesten
// uebrig bleiben (#1607). Eine Serie steht an ihrem naechsten Termin, ihre
// Stammzeile aber am Tag ihres Beginns: wer schon in der Abfrage auf fuenf
// deckelt, waehlt nach einem Datum aus, das er danach gar nicht anzeigt -
// fuenf alte Jahrestage verdraengten den Termin von morgen. Die Schranke haelt
// die Expansion klein; die Kalendersuche loest mit derselben Funktion hundert
// Zeilen auf.
export const EVENT_SEARCH_CANDIDATES = 50;
// Ein Einzeltermin, dessen Tag vor heute liegt (Kandidatenfolge der globalen
// Suche; Serien zaehlen nie dazu - ihr naechster Termin kann kommen).
export const PAST_SINGLE_EVENT_SQL = "(e.recurrence_rule IS NULL AND substr(e.start_datetime, 1, 10) < @from)";

/**
 * Das Fenster, in dem ein Serientreffer seinen naechsten Termin sucht: ab heute
 * (Haushaltszone), zwei Jahre weit.
 *
 * EINE Rechnung fuer beide Suchen (#1607). Die Kalendersuche hatte sie in ihrer
 * Route, die globale Suche hatte gar keine und lieferte den Start der
 * Stammzeile - ein Geburtstag von 1990 stand in der Palette mit dem Datum von
 * 1990 und oeffnete den Kalender in jenem Jahr, waehrend dieselbe Serie in der
 * Kalendersuche an ihrem naechsten Termin stand.
 *
 * Zwei Jahre, damit auch eine Serie mit mehrjaehrigem Abstand ihren naechsten
 * Termin findet. Findet sich keiner, bleibt der Treffer die Stammzeile
 * (`resolveEventSearchRows`).
 *
 * @returns zwei Tagesschluessel
 */
export function eventSearchWindow(database: Database): { from: string; to: string } {
  const from = todayKey(database);
  return { from, to: shiftDateKey(from, 730) };
}

/**
 * Resolves event search hits through the same linked-occurrence contract as
 * calendar reads. When a display window is supplied, recurring master hits are
 * represented by their first occurrence in that window, preserving the
 * calendar-search behavior without expanding one FTS hit into many results.
 */
export function resolveEventSearchRows(
  database: Database,
  rows: EventRow[],
  from: string | null = null,
  to: string | null = null,
  options: Record<string, unknown> = {},
): EventRow[] {
  const recurringIds = rows.filter((row) => row.recurrence_rule).map((row) => row.id);
  // The JS readers declare narrower JSDoc types (a node:sqlite connection, a Set
  // per series) than the values they take at run time; the casts only say so.
  const exceptions = loadEventExceptions(database as unknown as Parameters<typeof loadEventExceptions>[0], recurringIds as number[]);
  // Einmal je Aufruf, nicht je Treffer - und nur, wenn ein Treffer sie braucht
  // (zonenlose Ziffern neben einer `tzid`, #1993).
  const householdZone = rows.reduce((zone: unknown, row) => zone ?? seriesReadingZone(database, row), null);
  // Das Fenster ist ein Haushaltsfenster (`eventSearchWindow`, ab `todayKey()`):
  // eine Serie mit eigener Zone wird an ihrem Haushaltstag gemessen (#1999).
  const windowZone = from && to ? householdTimeZone(database) : null;
  const displayRows = rows.map((row) => {
    if (!row.recurrence_rule || !from || !to) return row;
    return expandRecurringEvents(
      [row],
      from,
      to,
      exceptions as unknown as Parameters<typeof expandRecurringEvents>[3],
      { includeRecurrenceIdentity: true, householdZone, windowZone } as unknown as Parameters<typeof expandRecurringEvents>[4],
    )[0] || row;
  });
  return (resolveProjectedEventRows(database, displayRows, options) as EventRow[])
    .sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
}

/**
 * KOMMENDES ZUERST, VERGANGENES DAHINTER (Critique R21, Palette). Die globale
 * Suche reihte Termine aufsteigend nach Start - wer "Zahnarzt" tippte, sah den
 * Termin vom letzten Jahr vor dem naechste Woche. Jetzt stehen die Termine ab
 * heute (Haushaltstag, `eventSearchWindow`) aufsteigend vorn, die vergangenen
 * danach, der juengste zuerst. Gemessen wird der Zeitpunkt in der
 * Haushaltszone (`storedToInstantMs`), nie der Datumsteil des Texts: ein Wert
 * mit `Z` kurz vor Mitternacht laege sonst am falschen Tag.
 *
 * Both groups are ordered here, not taken from the input: upcoming by start
 * ascending, then id ascending; past by start descending, then id descending.
 * The start compares as text, like the sort in `resolveEventSearchRows`. The
 * candidate query of the event slice cuts in this same order.
 * @param rows    in any order; each row carries its `id`
 * @param fromMs  Beginn des heutigen Haushaltstags
 * @param zone    Haushaltszone
 */
export function upcomingEventsFirst<T extends { start_datetime?: unknown; id?: unknown }>(rows: readonly T[], fromMs: number | null, zone: string): T[] {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const row of rows) {
    const ms = storedToInstantMs(row.start_datetime as string, zone);
    if (ms !== null && fromMs !== null && ms < fromMs) past.push(row);
    else upcoming.push(row);
  }
  const ascending = (a: T, b: T): number =>
    String(a.start_datetime).localeCompare(String(b.start_datetime)) || Number(a.id) - Number(b.id);
  upcoming.sort(ascending);
  past.sort((a, b) => ascending(b, a));
  return [...upcoming, ...past];
}

/**
 * DER GEBURTSTAGSTERMIN TRAEGT SEINEN NAMEN (R24, Critique G0 P1-1). Der Termin
 * steht mit dem sprachneutralen Titel "Birthday: <Name>" in calendar_events
 * (#524); Kalender und Uebersicht uebersetzen ihn ueber `birthday_name`
 * (public/utils/birthday-event.js). Die globale Suche lieferte das Feld nicht,
 * und Palette wie mobile Suche zeigten "Birthday: Emma" auf Deutsch. Dieselben
 * Felder wie `serializeEvent()` (routes/calendar/helpers.js), mit derselben
 * Regel fuer das unbekannte Geburtsjahr. Eine Abfrage fuer die (hoechstens
 * SEARCH_LIMIT) Treffer, nicht ein Join in der FTS-Abfrage.
 * @returns Termin-ID -> Geburtstagsfelder
 */
export function birthdayFieldsByEvent(database: Database, events: readonly EventRow[]): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  if (!events.length) return out;
  const ids = events.map((event) => Number(event.id));
  const marks = ids.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT calendar_event_id, name_day_calendar_event_id, name,
           CASE WHEN year_unknown = 1 THEN NULL ELSE birth_date END AS birth_date
    FROM birthdays
    WHERE calendar_event_id IN (${marks}) OR name_day_calendar_event_id IN (${marks})
  `).all(...ids, ...ids) as EventRow[];
  for (const row of rows) {
    if (row.calendar_event_id != null && ids.includes(Number(row.calendar_event_id))) {
      out.set(Number(row.calendar_event_id), {
        birthday_name: row.name, birthday_date: row.birth_date ?? null, birthday_event_kind: 'birthday',
      });
    }
    if (row.name_day_calendar_event_id != null && ids.includes(Number(row.name_day_calendar_event_id))) {
      out.set(Number(row.name_day_calendar_event_id), {
        birthday_name: row.name, birthday_date: null, birthday_event_kind: 'name_day',
      });
    }
  }
  return out;
}
