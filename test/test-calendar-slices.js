/**
 * Module: calendar, countdown and shift overview slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/calendar-slices.ts,
 *          server/services/countdowns-slices.ts and server/services/schedule-slices.ts,
 *          as test:care-slices does for health and housekeeping:
 *
 *          1. THE CAPS. The event tile counts only what is still coming against its
 *             limit; ended events of today come along outside it, at most
 *             ENDED_TODAY_POOL. The family card asks each member for at most
 *             FAMILY_AHEAD_PER_MEMBER coming events, drops an event it already
 *             has (`id@start`) and sorts the merge by start.
 *          2. THE DAY. The week strip starts the day before `ctx.today` and spans
 *             nine days; the countdowns count from `ctx.today`; the own shift is
 *             the one of `ctx.today`. No slice reads a clock: the event readers of
 *             the tile and the family card get `ctx.now` (getUpcomingEvents), and
 *             every reading of the system clock throws while they run. The suite
 *             still freezes the clock for the reference answers.
 *          3. THE OPTIONS. "Only mine", the wall audience, the hidden modules of
 *             the countdowns and the viewer of the shifts reach their readers.
 *          4. ONE FORM. The empty forms carry the keys in the route's order.
 *          5. ISOLATION. Through the slices, each block fails alone to its old
 *             failure value under its old name (`upcomingEvents`, `weekEvents`,
 *             `familyEvents`, `countdowns`, `myShiftsToday`) and logs
 *             `<name> error:`; without a guard a failure throws.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:calendar-slices
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The clock the event readers read: 10:30 in Berlin.
const FROZEN_NOW = Date.parse('2026-03-11T09:30:00.000Z');
mock.timers.enable({ apis: ['Date'], now: FROZEN_NOW });

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const {
  ENDED_TODAY_POOL, FAMILY_AHEAD_PER_MEMBER, calendarOverviewSlice, emptyCalendarOverview,
  familyEventsOverviewSlice, weekEventFields,
} = await import('../server/services/calendar-slices.ts');
const { countdownsOverviewSlice, emptyCountdownsOverview } = await import('../server/services/countdowns-slices.ts');
const { emptyScheduleOverview, scheduleOverviewSlice } = await import('../server/services/schedule-slices.ts');
const { sliceRunner } = await import('../server/services/slice-runner.ts');

const db = get();
test.after(() => {
  db.close();
  mock.timers.reset();
});

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

/** @param {string} username @param {string} name @param {string} role */
function addUser(username, name, role) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', ?, 'parent')
  `).run(username, name, role).lastInsertRowid);
}
const ANNA = addUser('cal-anna', 'Anna', 'admin');
const BEN = addUser('cal-ben', 'Ben', 'member');
const CARL = addUser('cal-carl', 'Carl', 'member');

// ---- Events -----------------------------------------------------------------
const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, visibility, created_by, external_source, countdown)
  VALUES (?, ?, ?, ?, ?, ?, 'local', ?) RETURNING id
`);
/**
 * @param {string} title @param {string} start @param {string|null} end
 * @param {{ allDay?: boolean, visibility?: string, countdown?: boolean, assignees?: number[] }} [opts]
 * @returns {number}
 */
function addEvent(title, start, end, { allDay = false, visibility = 'all', countdown = false, assignees = [] } = {}) {
  const id = insertEvent.get(title, start, end, allDay ? 1 : 0, visibility, ANNA, countdown ? 1 : 0).id;
  for (const user of assignees) db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, user);
  return id;
}

// Twenty-five events that ended this morning: five more than ENDED_TODAY_POOL.
for (let i = 0; i < 25; i += 1) {
  const minute = String(i).padStart(2, '0');
  addEvent(`ended ${minute}`, `2026-03-11T06:${minute}:00Z`, `2026-03-11T06:${minute}:30Z`);
}
// Seven coming events today, unassigned: the tile's limit of five cuts them.
for (let i = 0; i < 7; i += 1) addEvent(`coming ${i}`, `2026-03-11T1${i + 2}:00:00Z`, `2026-03-11T1${i + 2}:30:00Z`);
// Anna's private event: the person sees it, the wall does not.
addEvent('anna private', '2026-03-11T11:00:00Z', '2026-03-11T11:30:00Z', { visibility: 'private' });
// Ben: eight coming events on the days +2 to +9, one per day.
for (let i = 2; i <= 9; i += 1) {
  addEvent(`ben +${i}`, `2026-03-${String(11 + i).padStart(2, '0')}T10:00:00Z`, null, { assignees: [BEN] });
}
// One shared event of Anna and Ben, earlier on +3: the family card shows it once.
addEvent('shared +3', '2026-03-14T08:00:00Z', null, { assignees: [ANNA, BEN] });
// Anna's own event late in the month: first member asked, last in the merge.
addEvent('anna +10', '2026-03-21T10:00:00Z', null, { assignees: [ANNA] });
// Anna's private event on the family card: the person sees it, the wall does not.
addEvent('anna private +11', '2026-03-22T10:00:00Z', null, { visibility: 'private', assignees: [ANNA] });
// Ben's event that ended this morning: the family card carries it outside his cap.
addEvent('ben ended', '2026-03-11T07:00:00Z', '2026-03-11T07:30:00Z', { assignees: [BEN] });
// Carl's daily series, three occurrences: one event id, three starts, three entries.
const CARL_DAILY = addEvent('carl daily', '2026-03-12T05:00:00Z', '2026-03-12T05:30:00Z', { assignees: [CARL] });
db.prepare("UPDATE calendar_events SET recurrence_rule = 'FREQ=DAILY;COUNT=3' WHERE id = ?").run(CARL_DAILY);
// A birthday tomorrow, on Carl: an event of no local calendar, deselectable by `events_birthdays`.
const BIRTHDAY = addEvent('birthday', '2026-03-12', null, { allDay: true, assignees: [CARL] });
db.prepare("INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES ('Dora', '1990-03-12', ?, ?)")
  .run(BIRTHDAY, ANNA);
// The week window: yesterday and +7 inside, the day before yesterday and +8 outside.
addEvent('week -2', '2026-03-09', null, { allDay: true });
addEvent('week -1', '2026-03-10', null, { allDay: true });
addEvent('week +7', '2026-03-18', null, { allDay: true });
addEvent('week +8', '2026-03-19', null, { allDay: true });

// ---- Countdowns ---------------------------------------------------------------
addEvent('countdown event', '2026-03-16', null, { allDay: true, countdown: true });
addEvent('countdown private', '2026-03-17', null, { allDay: true, countdown: true, visibility: 'private' });
db.prepare(`
  INSERT INTO tasks (title, category, priority, status, due_date, visibility, created_by, countdown)
  VALUES ('countdown task', 'household', 'low', 'open', '2026-03-14', 'all', ?, 1)
`).run(ANNA);

// ---- Shifts -----------------------------------------------------------------
const insertShiftType = db.prepare(`
  INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, created_by)
  VALUES (?, ?, ?, ?, '#0EA5E9', ?) RETURNING id
`);
const EARLY = insertShiftType.get('early', 'E', '06:00', '14:00', ANNA).id;
const NIGHT = insertShiftType.get('night', null, null, null, ANNA).id;
const insertOverride = db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)');
insertOverride.run(ANNA, '2026-03-11', EARLY);
insertOverride.run(ANNA, '2026-03-12', null); // a free day is no row
insertOverride.run(BEN, '2026-03-11', NIGHT);

const ZONE = 'Europe/Berlin';
const NOW = new Date(FROZEN_NOW);
const CTX = Object.freeze({ today: '2026-03-11', zone: ZONE, now: NOW });
const anna = personReader(ANNA);
// The reader of a paired display: the wall rule without `audience=household`.
const WALL = Object.freeze({ userId: ANNA, wall: true });
/** @param {Record<string, unknown>[]} events */
const identity = (events) => events;
const TILE = Object.freeze({
  userId: ANNA, limit: 5, assignedTo: null, includeBirthdays: true, household: false, calendars: null, serialize: identity,
});
const FAMILY = Object.freeze({
  userId: ANNA, members: [{ id: ANNA }, { id: BEN }], includeBirthdays: true, household: false, serialize: identity,
});

/** @param {unknown[]} events @returns {string[]} */
const titles = (events) => events.map((event) => /** @type {{ title: string }} */ (event).title);

/**
 * Runs `fn` while every reading of the system clock throws. A Date WITH an argument
 * stays possible: that is a conversion, not a clock.
 * @template T @param {() => T} fn @returns {T}
 */
function withoutClock(fn) {
  const RealDate = globalThis.Date;
  class NoClock extends RealDate {
    /** @param {...any} args */
    constructor(...args) {
      if (args.length === 0) throw new Error('a slice read the clock (new Date())');
      super(.../** @type {[any]} */ (args));
    }
    /** @returns {number} */
    static now() { throw new Error('a slice read the clock (Date.now())'); }
  }
  globalThis.Date = /** @type {DateConstructor} */ (/** @type {unknown} */ (NoClock));
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('the tile: the limit counts what is coming, ended events of today come along up to ENDED_TODAY_POOL', () => {
  assert.equal(ENDED_TODAY_POOL, 20);
  const { upcomingEvents } = calendarOverviewSlice(db, anna, CTX, TILE);
  const list = titles(upcomingEvents);
  const ended = list.filter((title) => title.includes('ended'));
  const coming = list.filter((title) => !title.includes('ended'));
  assert.equal(ended.length, ENDED_TODAY_POOL, 'twenty of the twenty-five ended events, outside the cap');
  assert.deepEqual(coming, ['anna private', 'coming 0', 'coming 1', 'coming 2', 'coming 3'], 'five coming, in order');
  const wider = titles(calendarOverviewSlice(db, anna, CTX, { ...TILE, limit: 8 }).upcomingEvents);
  assert.equal(wider.filter((title) => !title.includes('ended')).length, 8, 'the limit reaches the reader');
});

test('the tile: "only mine" and the wall audience reach both readers', () => {
  const mine = calendarOverviewSlice(db, personReader(BEN), CTX, { ...TILE, userId: BEN, assignedTo: BEN });
  assert.deepEqual(titles(mine.upcomingEvents), ['ben ended', 'ben +2', 'shared +3', 'ben +3', 'ben +4', 'ben +5']);
  assert.deepEqual(titles(mine.weekEvents), ['ben ended', 'ben +2', 'shared +3', 'ben +3', 'ben +4', 'ben +5', 'ben +6', 'ben +7']);

  const person = titles(calendarOverviewSlice(db, anna, CTX, TILE).upcomingEvents);
  const wall = calendarOverviewSlice(db, anna, CTX, { ...TILE, household: true });
  assert.ok(person.includes('anna private'));
  assert.ok(!titles(wall.upcomingEvents).includes('anna private'), 'the wall shows no private event');
  assert.ok(!titles(wall.weekEvents).includes('anna private'), 'nor does its week strip');
  assert.ok(titles(calendarOverviewSlice(db, anna, CTX, TILE).weekEvents).includes('anna private'));
  // A paired display reads the wall rule through its reader, without the parameter.
  const display = calendarOverviewSlice(db, WALL, CTX, TILE);
  assert.ok(!titles(display.upcomingEvents).includes('anna private'), 'the reader reaches the list');
  assert.ok(!titles(display.weekEvents).includes('anna private'), 'and the week strip');
});

test('the tile: the calendar selection and the birthday switch reach both readers', () => {
  // A selection that names no local calendar: only events of no calendar (the birthday) stay.
  const selected = calendarOverviewSlice(db, anna, CTX, { ...TILE, limit: 12, calendars: ['sub:999999'] });
  assert.deepEqual(titles(selected.upcomingEvents), ['birthday']);
  assert.deepEqual(titles(selected.weekEvents), ['birthday']);

  const withBirthdays = calendarOverviewSlice(db, anna, CTX, { ...TILE, limit: 12 });
  assert.ok(titles(withBirthdays.upcomingEvents).includes('birthday'));
  assert.ok(titles(withBirthdays.weekEvents).includes('birthday'));
  const without = calendarOverviewSlice(db, anna, CTX, { ...TILE, limit: 12, includeBirthdays: false });
  assert.ok(!titles(without.upcomingEvents).includes('birthday'), 'events_birthdays=hide reaches the list');
  assert.ok(!titles(without.weekEvents).includes('birthday'), 'and the week strip');
});

test('the week strip: from the day before ctx.today, nine days, in the slim shape', () => {
  const { weekEvents } = calendarOverviewSlice(db, anna, CTX, TILE);
  const week = titles(weekEvents);
  assert.ok(week.includes('week -1'), 'yesterday is the first day of the window');
  assert.ok(week.includes('week +7'), 'the eighth day after today is still inside');
  assert.ok(!week.includes('week -2'), 'the day before yesterday is outside');
  assert.ok(!week.includes('week +8'), 'the ninth day after today is outside');
  assert.ok(week.includes('ended 00'), 'what ended this morning took place this week');
  // Another day in ctx moves the window, whatever the clock says.
  const later = titles(calendarOverviewSlice(db, anna, { ...CTX, today: '2026-03-12' }, TILE).weekEvents);
  assert.ok(!later.includes('week -1') && later.includes('week +8'));

  const shared = weekEvents.find((event) => /** @type {any} */ (event).title === 'shared +3');
  assert.deepEqual(Object.keys(/** @type {object} */ (shared)), [
    'id', 'title', 'start_datetime', 'end_datetime', 'all_day', 'color', 'cal_color', 'assigned_to',
    'assigned_users', 'birthday_name', 'birthday_date', 'birthday_event_kind',
  ]);
  assert.deepEqual(weekEventFields({ id: 1, title: 't', start_datetime: 's', all_day: 'yes', assigned_users: [
    { id: 2, display_name: 'Ben', color: '#fff', avatar_data: 'big' },
  ] }), {
    id: 1, title: 't', start_datetime: 's', end_datetime: null, all_day: 1, color: null, cal_color: null,
    assigned_to: null, assigned_users: [{ id: 2, display_name: 'Ben', color: '#fff' }],
    birthday_name: null, birthday_date: null, birthday_event_kind: null,
  });
});

test('the family card: FAMILY_AHEAD_PER_MEMBER per member, each event once, sorted by start', () => {
  assert.equal(FAMILY_AHEAD_PER_MEMBER, 6);
  const { familyEvents } = familyEventsOverviewSlice(db, anna, CTX, FAMILY);
  assert.deepEqual(titles(familyEvents), [
    // Ben's ended one outside his cap and his six coming: the shared one and +2 to +6;
    // Anna's: the shared one again, +10 and her private +11.
    'ben ended', 'ben +2', 'shared +3', 'ben +3', 'ben +4', 'ben +5', 'ben +6', 'anna +10', 'anna private +11',
  ]);
  // The tile's options do not reach the card: no calendar selection, no "only mine".
  const onlyBen = familyEventsOverviewSlice(db, anna, CTX, { ...FAMILY, members: [{ id: BEN }] });
  assert.equal(onlyBen.familyEvents.length, FAMILY_AHEAD_PER_MEMBER + 1, 'six coming and the ended one');
  assert.deepEqual(familyEventsOverviewSlice(db, anna, CTX, { ...FAMILY, members: [] }).familyEvents, []);
  // The same event at another start (an occurrence) is another entry.
  const carl = familyEventsOverviewSlice(db, anna, CTX, { ...FAMILY, members: [{ id: CARL }] });
  assert.deepEqual(carl.familyEvents.map((event) => `${event.title}@${event.start_datetime}`), [
    'birthday@2026-03-12',
    'carl daily@2026-03-12T05:00:00Z', 'carl daily@2026-03-13T05:00:00Z', 'carl daily@2026-03-14T05:00:00Z',
  ]);
  const carlNoBirthdays = familyEventsOverviewSlice(db, anna, CTX, { ...FAMILY, members: [{ id: CARL }], includeBirthdays: false });
  assert.deepEqual(titles(carlNoBirthdays.familyEvents), ['carl daily', 'carl daily', 'carl daily'],
    'events_birthdays=hide reaches the card');
  // The wall: by parameter and by the reader of a paired display.
  const annaOnly = { ...FAMILY, members: [{ id: ANNA }] };
  assert.ok(titles(familyEventsOverviewSlice(db, anna, CTX, annaOnly).familyEvents).includes('anna private +11'));
  assert.ok(!titles(familyEventsOverviewSlice(db, anna, CTX, { ...annaOnly, household: true }).familyEvents)
    .includes('anna private +11'), 'the wall audience reaches the card');
  assert.ok(!titles(familyEventsOverviewSlice(db, WALL, CTX, annaOnly).familyEvents).includes('anna private +11'),
    'the reader reaches the card');
  const serialized = familyEventsOverviewSlice(db, anna, CTX, {
    ...FAMILY, serialize: (events) => events.map((event) => ({ ...event, serialized: true })),
  });
  assert.ok(serialized.familyEvents.every((event) => /** @type {any} */ (event).serialized), 'serialize sees the merge');
});

test('the tile and the family card read no clock: getUpcomingEvents gets ctx.now', () => {
  const [tile, family] = withoutClock(() => [
    calendarOverviewSlice(db, anna, CTX, TILE),
    familyEventsOverviewSlice(db, anna, CTX, FAMILY),
  ]);
  // The same answers as with the frozen clock: ctx.now is that instant.
  assert.deepEqual(tile, calendarOverviewSlice(db, anna, CTX, TILE));
  assert.deepEqual(family, familyEventsOverviewSlice(db, anna, CTX, FAMILY));
  assert.equal(tile.upcomingEvents.filter((event) => !String(event.title).includes('ended')).length, 5);
  assert.ok(family.familyEvents.length > 0);
});

test('countdowns: from ctx.today without a clock, hidden modules leave out their source', () => {
  const [today, later, noCalendar, display] = withoutClock(() => [
    countdownsOverviewSlice(db, anna, CTX, { userId: ANNA, hiddenModules: new Set() }),
    countdownsOverviewSlice(db, anna, { ...CTX, today: '2026-03-13' }, { userId: ANNA, hiddenModules: new Set() }),
    countdownsOverviewSlice(db, anna, CTX, { userId: ANNA, hiddenModules: new Set(['calendar']) }),
    countdownsOverviewSlice(db, WALL, CTX, { userId: ANNA, hiddenModules: new Set() }),
  ]);
  /** @param {any} out */
  const days = (out) => out.countdowns.map((/** @type {any} */ c) => `${c.title}:${c.days_until}`);
  assert.deepEqual(days(today), ['countdown task:3', 'countdown event:5', 'countdown private:6']);
  assert.equal(today.countdownTotal, 3);
  assert.deepEqual(Object.keys(today), ['countdowns', 'countdownTotal']);
  assert.deepEqual(days(later), ['countdown task:1', 'countdown event:3', 'countdown private:4']);
  assert.deepEqual(days(display), ['countdown task:3', 'countdown event:5'], 'a paired display reads the wall rule');
  assert.deepEqual(days(noCalendar), ['countdown task:3'], 'a hidden calendar drops the event countdown only');
  assert.equal(noCalendar.countdownTotal, 1, 'the total counts behind the same filter');
});

test('shifts: the viewer\'s own shift of ctx.today without a clock, free days are no row', () => {
  const [today, freeDay, ben] = withoutClock(() => [
    scheduleOverviewSlice(db, anna, CTX, { userId: ANNA }),
    scheduleOverviewSlice(db, anna, { ...CTX, today: '2026-03-12' }, { userId: ANNA }),
    scheduleOverviewSlice(db, personReader(BEN), CTX, { userId: BEN }),
  ]);
  assert.deepEqual(today, {
    myShiftsToday: [{
      date_key: '2026-03-11',
      source: 'override',
      crosses_midnight: false,
      shift_type: {
        id: EARLY, name: 'early', short_code: 'E', start_time: '06:00', end_time: '14:00', color: '#0EA5E9', icon: null,
      },
    }],
  });
  assert.deepEqual(freeDay, { myShiftsToday: [] });
  assert.deepEqual(ben.myShiftsToday.map((s) => s.shift_type.name), ['night'], 'only the viewer\'s own shift');
  assert.equal(ben.myShiftsToday[0].shift_type.short_code, null);
});

test('the empty forms carry the keys in the route\'s order', () => {
  assert.deepEqual(emptyCalendarOverview(), { upcomingEvents: [], familyEvents: [], weekEvents: [] });
  assert.deepEqual(Object.keys(emptyCalendarOverview()), ['upcomingEvents', 'familyEvents', 'weekEvents']);
  assert.deepEqual(Object.keys(calendarOverviewSlice(db, anna, CTX, TILE)), ['upcomingEvents', 'weekEvents']);
  assert.notEqual(emptyCalendarOverview().upcomingEvents, emptyCalendarOverview().upcomingEvents, 'fresh lists');
  assert.deepEqual(Object.keys(emptyCountdownsOverview()), ['countdowns', 'countdownTotal']);
  assert.deepEqual(emptyCountdownsOverview(), { countdowns: [], countdownTotal: 0 });
  assert.deepEqual(emptyScheduleOverview(), { myShiftsToday: [] });
});

test('through the slices each block fails alone to its old value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: boom'); }, exec() {} };

  const calLog = capturingLog();
  assert.deepEqual(calendarOverviewSlice(broken, anna, CTX, TILE, sliceRunner(calLog)), { upcomingEvents: [], weekEvents: [] });
  assert.deepEqual(familyEventsOverviewSlice(broken, anna, CTX, FAMILY, sliceRunner(calLog)), { familyEvents: [] });
  const cdLog = capturingLog();
  assert.deepEqual(countdownsOverviewSlice(broken, anna, CTX, { userId: ANNA, hiddenModules: new Set() }, sliceRunner(cdLog)),
    { countdowns: [], countdownTotal: 0 });
  assert.deepEqual(calLog.lines, [
    ['upcomingEvents error:', 'no such table: boom'],
    ['weekEvents error:', 'no such table: boom'],
    ['familyEvents error:', 'no such table: boom'],
  ]);
  assert.deepEqual(cdLog.lines, [['countdowns error:', 'no such table: boom']]);

  // The week alone: the overlap reader fails, the list of the tile stays.
  const weekBroken = {
    /** @param {string} sql */
    prepare(sql) {
      // Only getEventsOverlappingDays() breaks its two date conditions over two lines.
      if (/DATE\(e\.start_datetime\) <= \?\s*\n\s*AND DATE\(COALESCE/.test(sql)) throw new Error('week boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const weekLog = capturingLog();
  const weekOut = calendarOverviewSlice(weekBroken, anna, CTX, TILE, sliceRunner(weekLog));
  assert.equal(weekOut.upcomingEvents.length, 25);
  assert.deepEqual(weekOut.weekEvents, []);
  assert.deepEqual(weekLog.lines, [['weekEvents error:', 'week boom']]);

  // A failing serialize (the document viewer of the request) is the block's failure.
  const serializeLog = capturingLog();
  let calls = 0;
  const failingFirst = calendarOverviewSlice(db, anna, CTX, {
    ...TILE,
    serialize: (events) => {
      calls += 1;
      if (calls === 1) throw new Error('viewer boom');
      return events;
    },
  }, sliceRunner(serializeLog));
  assert.deepEqual(failingFirst.upcomingEvents, []);
  assert.ok(failingFirst.weekEvents.length > 0);
  assert.deepEqual(serializeLog.lines, [['upcomingEvents error:', 'viewer boom']]);

  // The shifts open their own connection (db.get()): take their table away.
  db.exec('ALTER TABLE schedule_overrides RENAME TO schedule_overrides_away');
  try {
    const shiftLog = capturingLog();
    assert.deepEqual(scheduleOverviewSlice(db, anna, CTX, { userId: ANNA }, sliceRunner(shiftLog)), { myShiftsToday: [] });
    assert.equal(shiftLog.lines.length, 1);
    assert.equal(shiftLog.lines[0][0], 'myShiftsToday error:');
    assert.match(String(shiftLog.lines[0][1]), /schedule_overrides/);
    assert.throws(() => scheduleOverviewSlice(db, anna, CTX, { userId: ANNA }), /schedule_overrides/,
      'without a guard a failing read throws');
  } finally {
    db.exec('ALTER TABLE schedule_overrides_away RENAME TO schedule_overrides');
  }

  assert.throws(() => calendarOverviewSlice(broken, anna, CTX, TILE), /no such table/, 'without a guard a failing read throws');
  assert.throws(() => familyEventsOverviewSlice(broken, anna, CTX, FAMILY), /no such table/);
  assert.throws(() => countdownsOverviewSlice(broken, anna, CTX, { userId: ANNA, hiddenModules: new Set() }), /no such table/);
});
