/**
 * Module: calendar - the event blocks of GET /dashboard as overview slices
 *         (phase 2, section D, contract E10)
 * Purpose: the three event lists of the overview answer: the next events of the
 *          event tile (`upcomingEvents`), the slim week of the strip
 *          (`weekEvents`) and the events per member of the family card
 *          (`familyEvents`).
 *
 * THE CONTRACT. calendarOverviewSlice(db, actor, ctx, options, guard) and
 * familyEventsOverviewSlice(db, actor, ctx, options, guard) are synchronous and
 * see no request; they read no clock. The week window starts the day before
 * `ctx.today`.
 *
 * NO CLOCK READ: getUpcomingEvents() gets `ctx.now`, the one reading the route
 * takes for every slice, and reads the household day from it (todayKey(d, now)).
 * Until the follow-up of the cuts it took its own `new Date()`, milliseconds
 * after the route's `now`.
 *
 * TWO SLICES, BECAUSE THE ANSWER HAS TWO PLACES. `upcomingEvents` and
 * `weekEvents` stand before the task keys; `familyEvents` stands after the
 * notes and needs the member list the route reads there (`result.users`). The
 * route calls each slice where its keys always stood (the golden master
 * test:overview-golden holds the key order).
 *
 * WHAT THE REQUEST DECIDES COMES IN AS OPTIONS: the viewer, the "only mine"
 * target, the birthday switch of the tile, the limit, the wall audience, the
 * calendar selection, and `serialize` - serializeEvents() of
 * routes/calendar/helpers.js bound to the request's document viewer and admin
 * flag. It stays in the route: a service importing a route is the layer break
 * the lint baseline counts (`depcruise/lower-layers-not-to-routes`, F3).
 *
 * ONE FAILURE PER BLOCK, AS BEFORE: each block had its own try/catch in the
 * route; `guard` (the route's runSlice()) carries that under the old names
 * `upcomingEvents`, `weekEvents` and `familyEvents`, each failing to an empty
 * list. Without a guard a failure throws.
 *
 * Dependencies: server/authorize/index.ts (types only),
 * services/calendar-event-reader.js, utils/timezone.js. Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { visibleWhere } from '../authorize/index.ts';
import * as eventReader from './calendar-event-reader.js';
import { notBirthdayEventSql } from './household-modules.js';
import type { IndexSearchQuery, SearchActor, SearchRow, TableSearchQuery } from './search-text.ts';
import { SEARCH_LIMIT, firstMatches, pick, withExcerpt } from './search-text.ts';
import {
  EVENT_SEARCH_CANDIDATES, PAST_SINGLE_EVENT_SQL, birthdayFieldsByEvent, eventSearchWindow,
  resolveEventSearchRows, upcomingEventsFirst,
} from './search-events.ts';
import { householdTimeZone, shiftDateKey, storedToInstantMs } from '../utils/timezone.js';

type EventRow = Record<string, unknown>;

// The JS readers infer their option types from their defaults (`userId = null`);
// these are the shapes the overview calls them with. Same functions, same calls.
type EventReader = (db: Database, options: Readonly<Record<string, unknown>>) => EventRow[];
const getUpcomingEvents = eventReader.getUpcomingEvents as unknown as EventReader;
const getEventsOverlappingDays = eventReader.getEventsOverlappingDays as unknown as EventReader;
type AssignedUser = { id: unknown; display_name: unknown; color: unknown };
/** An event as serializeEvents() answers it: a row with the fields of routes/calendar/helpers.js. */
type SerializedEvent = EventRow;

/** serializeEvents() of the route, bound to the request (viewer, actor, admin flag). */
type SerializeEvents = (events: EventRow[]) => SerializedEvent[];

/** The options of the request that act on the event tile and its week strip. */
export type CalendarOverviewOptions = Readonly<{
  /** The viewer (`req.authUserId || req.session.userId`). */
  userId: number | null;
  /** How many coming events the tile lists (clampEventLimit: 5, 8 or 12). */
  limit: number;
  /** "Only mine" (`events_scope=mine`): the viewer's id, otherwise null. */
  assignedTo: number | null;
  /** `events_birthdays` is not `hide`. */
  includeBirthdays: boolean;
  /** `audience=household`: the wall answer. */
  household: boolean;
  /** The resolved calendar selection of the tile (#2062), null for all. */
  calendars: string[] | null;
  serialize: SerializeEvents;
}>;

/** The options of the request that act on the family card. */
export type FamilyEventsOverviewOptions = Readonly<{
  userId: number | null;
  /** The household members the route read (`result.users`), in their order. */
  members: ReadonlyArray<{ id: number }>;
  includeBirthdays: boolean;
  household: boolean;
  serialize: SerializeEvents;
}>;

type WeekEvent = {
  id: unknown;
  title: unknown;
  start_datetime: unknown;
  end_datetime: unknown;
  all_day: 0 | 1;
  color: unknown;
  cal_color: unknown;
  assigned_to: unknown;
  assigned_users: AssignedUser[];
  birthday_name: unknown;
  birthday_date: unknown;
  birthday_event_kind: unknown;
};

export type CalendarOverview = {
  upcomingEvents: SerializedEvent[];
  weekEvents: WeekEvent[];
};

export type FamilyEventsOverview = { familyEvents: SerializedEvent[] };

/**
 * The empty form of the calendar module: a denied or switched-off calendar
 * (DENIED_PAYLOAD in the route). The key order is the route's old one.
 */
export function emptyCalendarOverview(): CalendarOverview & FamilyEventsOverview {
  return { upcomingEvents: [], familyEvents: [], weekEvents: [] };
}

/** How many ended events of today come along outside the cap (#1449). */
export const ENDED_TODAY_POOL = 20;

/** How many coming events the family card gets per member (#1449):
 * the next own one today, one after it for "next up", and room for shared
 * ones, which the card shows in a row of their own. */
export const FAMILY_AHEAD_PER_MEMBER = 6;

/**
 * The fields of an event the week strip needs: day(s), colour by the rule of
 * public/utils/event-color.js and the title for the day name - the birthday
 * with the fields the browser translates it from (#524).
 */
export function weekEventFields(event: SerializedEvent): WeekEvent {
  return {
    id: event.id,
    title: event.title,
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime ?? null,
    all_day: event.all_day ? 1 : 0,
    color: event.color ?? null,
    cal_color: event.cal_color ?? null,
    assigned_to: event.assigned_to ?? null,
    assigned_users: ((event.assigned_users as AssignedUser[] | undefined) ?? []).map((user) => ({
      id: user.id, display_name: user.display_name, color: user.color,
    })),
    birthday_name: event.birthday_name ?? null,
    birthday_date: event.birthday_date ?? null,
    birthday_event_kind: event.birthday_event_kind ?? null,
  };
}

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The event tile and its week strip.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request (rowReader): a paired display reads
 *                under the wall rule
 * @param ctx     today, zone and now of the request
 * @param options what the request decides (see CalendarOverviewOptions)
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function calendarOverviewSlice(
  db: Database,
  actor: RowReader,
  ctx: OverviewContext,
  options: CalendarOverviewOptions,
  guard: SliceGuard = passThrough,
): CalendarOverview {
  const { userId, limit, assignedTo, includeBirthdays, household, calendars, serialize } = options;

  // The next events (5, 8 or 12, from now on). Shared logic with
  // /calendar/upcoming: expands recurring series, so events whose master start
  // lies in the past show up too.
  //
  // The cap (five, on request 8 or 12, #1680) counts only what is still coming
  // (#1449); ended events of today come along outside it - the tile shows them
  // stepped back, the today sheet leaves them out. Which ones have ended the
  // browser decides at the clock: an event also ends between two fetches.
  const upcomingEvents = guard('upcomingEvents', (): SerializedEvent[] => serialize(getUpcomingEvents(db, {
    userId, limit, fromToday: true, assignedTo, includeBirthdays,
    keepEndedToday: ENDED_TODAY_POOL, household, calendars, reader: actor, now: ctx.now,
  })), []);

  /* THE WEEK FOR THE STRIP of the calendar widget (2x1). A question of its own
   * next to the list above: there "what begins next", here "what takes place on
   * the seven days from today" - including what began the day before yesterday
   * and still runs (getEventsOverlappingDays).
   *
   * ALWAYS DELIVERED, not only on request: the customize mode switches the size
   * as a preview without reloading, and a strip without data would say "empty
   * week" there - a plausible wrong answer. The shape keeps the cost small: only
   * what a dot or a band needs, without description, location and attachments.
   *
   * The same filters as the list (visibility, "only mine", birthdays) and the
   * same module lock via DENIED_PAYLOAD. The window has one day of margin on
   * each side; which day an event is on the browser decides in its display zone
   * and clamps there to the seven. */
  const weekEvents = guard('weekEvents', (): WeekEvent[] => serialize(getEventsOverlappingDays(db, {
    userId, fromKey: shiftDateKey(ctx.today, -1), days: 9,
    assignedTo, includeBirthdays, household, calendars, reader: actor,
  })).map(weekEventFields), []);

  return { upcomingEvents, weekEvents };
}

/**
 * The family card.
 *
 * THE FAMILY CARD HAS ITS OWN EVENTS (#1449). It borrowed the list of the event
 * tile: five coming ones for the whole household and its "only mine". On a full
 * day a child's evening event fell out, and with "only mine" everyone else
 * stood there as "free today". Here each member asks for itself: what was today
 * (the ended ones, so "done for today" can be told from "free") and the next
 * coming ones.
 *
 * "ONLY MINE" DOES NOT APPLY HERE - the card shows each member, that is its
 * purpose (recommendation in #1449). Visibility and deselected birthdays apply
 * as everywhere: the viewer sees only what they may see. The calendar selection
 * of the tile does not apply either: the card is a tile of its own.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request
 * @param ctx     today, zone and now of the request (getUpcomingEvents reads `ctx.now`)
 * @param options what the request decides, and the members the route read
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function familyEventsOverviewSlice(
  db: Database,
  actor: RowReader,
  ctx: OverviewContext,
  options: FamilyEventsOverviewOptions,
  guard: SliceGuard = passThrough,
): FamilyEventsOverview {
  const { userId, members, includeBirthdays, household, serialize } = options;
  const familyEvents = guard('familyEvents', (): SerializedEvent[] => {
    const seen = new Set<string>();
    const merged: EventRow[] = [];
    for (const member of members) {
      for (const event of getUpcomingEvents(db, {
        userId, limit: FAMILY_AHEAD_PER_MEMBER, fromToday: true, assignedTo: member.id, includeBirthdays,
        keepEndedToday: ENDED_TODAY_POOL, household, reader: actor, now: ctx.now,
      })) {
        const key = `${event.id}@${event.start_datetime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(event);
      }
    }
    merged.sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
    return serialize(merged);
  }, []);
  return { familyEvents };
}

/** Options of the event hits: the household switches (`householdDisabledModules`). */
export type CalendarSearchOptions = Readonly<{ disabledNav?: ReadonlySet<string> | null }>;

/**
 * The event hits of the global search (services/search.js runSearch, bucket
 * `events`). The SQL is the search's, word for word; the viewer is
 * `actor.userId`, bound as `@userId` as before.
 */
export function calendarSearchSlice(
  db: Database,
  actor: SearchActor,
  query: IndexSearchQuery,
  { disabledNav = null }: CalendarSearchOptions = {},
): SearchRow[] {
  const { text: q, match } = query;
  const userId = actor.userId;
  const limit = SEARCH_LIMIT;

  // Termine sind Familienbesitz (die Kalenderliste zeigt alle Termine, nicht nur
  // eigene) - daher KEIN created_by-Filter, konsistent mit GET /calendar und der
  // Kalender-Suche (#471). Was die beiden aber seit #474 haben und diese Abfrage
  // bis zum Review von #1055 nicht: die Zeilen-Sichtbarkeit (`all` / Ersteller /
  // Zugewiesene) und den Abo-Filter (ICS-Termine nur aus geteilten oder eigenen
  // Abos). Ohne beides fand jedes Mitglied Titel und Datum fremder PRIVATER
  // Termine ueber ein Stichwort. Es sind dieselben zwei Klauseln wie in
  // routes/calendar/read.js, damit globale und Kalender-Suche fuers gleiche
  // Stichwort dieselben Treffer liefern - das war der Sinn von #471. Beide
  // Filter müssen vor ORDER/LIMIT greifen, damit verborgene Treffer sichtbare
  // nicht aus dem Ergebnisfenster verdrängen.
  // Serien stehen an ihrem naechsten Termin, wie in der Kalendersuche (#1607).
  const window = eventSearchWindow(db);
  const eventCandidates = resolveEventSearchRows(db, db.prepare(`
      SELECT ${eventReader.eventProjectionSql(db)}
      FROM search_index s
      JOIN calendar_events e ON e.id = s.entity_id
      WHERE s.entity = 'event' AND s.search_index MATCH @match
        AND ${visibleWhere('ics_subscriptions', 'e', '@userId')}
        AND ${visibleWhere('events', 'e', '@userId')}${
          // Geburtstagstermine stehen in dieser Trefferart, gehoeren aber dem
          // Schalter `birthdays` - wie in der Kalendersuche (#1660).
          disabledNav?.has('birthdays') ? ` AND ${notBirthdayEventSql('e')}` : ''}
      ORDER BY ${PAST_SINGLE_EVENT_SQL} ASC,
               CASE WHEN ${PAST_SINGLE_EVENT_SQL} THEN NULL ELSE e.start_datetime END ASC,
               e.start_datetime DESC,
               -- A unique last key; the stable sort below keeps it, so upcoming ties
               -- show id ascending and past ties, reversed there, the newest id first.
               e.id ASC
      LIMIT @limit
    `).all({ match, userId, from: window.from, limit: EVENT_SEARCH_CANDIDATES }) as SearchRow[], window.from, window.to, { lightweight: true });
  // resolveEventSearchRows sortiert nach dem AUFGELOESTEN Start; vorn steht,
  // was ab heute kommt, danach das Vergangene (upcomingEventsFirst). Die
  // Kandidaten holt die Abfrage schon in dieser Folge, damit fuenfzig alte
  // Einzeltermine den kommenden nicht aus dem Fenster draengen - dort genuegt
  // der Datumsteil, die genaue Grenze zieht upcomingEventsFirst.
  const zone = householdTimeZone(db);
  const eventRows = upcomingEventsFirst(eventCandidates, storedToInstantMs(window.from, zone), zone)
    .slice(0, limit);
  // Preserve the compact global-search payload. The resolver-capable
  // projection supplies linked inheritance without loading attachment bodies
  // or unrelated sync metadata into this result bucket.
  const birthdays = birthdayFieldsByEvent(db, eventRows);
  return eventRows.map((event) => withExcerpt({
    id: event.id,
    title: event.title,
    start_datetime: event.start_datetime,
    all_day: event.all_day,
    ...(birthdays.get(Number(event.id)) || {}),
    ...(event.is_occurrence_override ? {
      series_id: event.series_id,
      recurrence_id: event.recurrence_id,
      is_occurrence_override: true,
      assignment_owner_id: event.assignment_owner_id,
      attachment_owner_id: event.attachment_owner_id,
      reminder_owner_id: event.reminder_owner_id,
      reminder_anchor_start: event.reminder_anchor_start,
    } : {}),
  }, q, [event.description, event.location]));
}

/**
 * The birthday hits of the global search (services/search.js runTableSearch,
 * bucket `birthdays`; rights module and table owner `calendar`, nav entry
 * `birthdays`). Here and not in birthdays-slices.ts: that file reaches server/db.js
 * through services/birthdays.js, and services/search.js must not (it is loaded by
 * suites without DB_PATH, test:db-isolation). No FTS index: the rows come in the
 * SQL order and the first SEARCH_LIMIT that match stay. The SQL is the search's,
 * word for word; the actor is unused.
 */
export function birthdaysSearchSlice(db: Database, _actor: SearchActor, query: TableSearchQuery): SearchRow[] {
  const { text: q, matches } = query;
  const limit = SEARCH_LIMIT;
  // Geburtstage: Haushaltsbesitz, Rechte-Modul `calendar` (siehe BUCKET_MODULE).
  return firstMatches(db.prepare(`
      SELECT b.id, b.name AS title, b.birth_date, b.notes, b.year_unknown
      FROM birthdays b
      ORDER BY b.name COLLATE NOCASE ASC, b.id ASC
    `).all() as SearchRow[], matches, (b) => [b.title, b.notes], limit)
    // `year_unknown` (#2095): birth_date traegt dann das Platzhalterjahr.
    .map((b) => withExcerpt({ ...pick(b, ['id', 'title', 'birth_date']), year_unknown: b.year_unknown === 1 }, q, [b.notes]));
}
