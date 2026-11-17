/**
 * Module: notes and birthdays overview slices (phase 2, section D, contract E10)
 * Purpose: holds the contract of server/services/notes-slices.ts and
 *          server/services/birthdays-slices.ts, as test:kitchen-slices does for
 *          shopping and meals:
 *
 *          1. NO CLOCK. The system clock is frozen at a deliberately wrong instant
 *             (2031); two calls with two different `ctx` answer what fits `ctx`.
 *             A birthday slice that let hydrateBirthdayOccurrences() read
 *             `new Date()` itself would count the days from 2031.
 *          2. ONE FORM. emptyNotesOverview()/emptyBirthdaysOverview() and the
 *             failure values carry exactly the keys of the slice, the empty forms
 *             in the order the route has always written them.
 *          3. ISOLATION. Through the slice, a failing read answers its failure
 *             value under its old name and logs `<name> error:`; without a guard
 *             a failure throws.
 *
 *          The whole GET /dashboard answer is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:notes-birthdays-slices
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const { personReader } = await import('../server/authorize/index.ts');
const {
  emptyNotesOverview, normalizeNoteCategoryFilter, notesOverviewSlice, NOTES_BLOCK_FAILED,
} = await import('../server/services/notes-slices.ts');
const {
  birthdaysOverviewSlice, emptyBirthdaysOverview, BIRTHDAYS_BLOCK_FAILED,
} = await import('../server/services/birthdays-slices.ts');
const { sliceRunner } = await import('../server/services/slice-runner.ts');

const db = get();
test.after(() => db.close());

/** @param {string} username @param {string} name */
function addUser(username, name) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
    VALUES (?, ?, 'hash', '#7C3AED', 'admin', 'parent')
  `).run(username, name).lastInsertRowid);
}
const ANNA = addUser('slice-anna', 'Anna');
const BEN = addUser('slice-ben', 'Ben');

/**
 * @param {string} title @param {number} by
 * @param {{ pinned?: number, visibility?: string, updatedAt: string }} options
 */
function addNote(title, by, { pinned = 0, visibility = 'all', updatedAt }) {
  return Number(db.prepare(`
    INSERT INTO notes (title, content, pinned, visibility, created_by, updated_at) VALUES (?, '', ?, ?, ?, ?)
  `).run(title, pinned, visibility, by, updatedAt).lastInsertRowid);
}
const OLD_PIN = addNote('old pin', ANNA, { pinned: 1, updatedAt: '2026-01-01T08:00:00Z' });
for (let day = 10; day <= 15; day += 1) addNote(`plain ${day}`, ANNA, { updatedAt: `2026-02-${day}T08:00:00Z` });
addNote('ben private', BEN, { pinned: 1, visibility: 'private', updatedAt: '2026-03-01T08:00:00Z' });

const HOUSEHOLD_CATEGORY = Number(db.prepare(`
  INSERT INTO note_categories (name, name_key, scope) VALUES ('House', 'house', 'household')
`).run().lastInsertRowid);
const BENS_CATEGORY = Number(db.prepare(`
  INSERT INTO note_categories (name, name_key, scope, owner_user_id) VALUES ('Ben only', 'ben only', 'personal', ?)
`).run(BEN).lastInsertRowid);
db.prepare('INSERT INTO note_category_assignments (note_id, category_id) VALUES (?, ?)').run(OLD_PIN, HOUSEHOLD_CATEGORY);
db.prepare('INSERT INTO note_category_assignments (note_id, category_id) VALUES (?, ?)').run(OLD_PIN, BENS_CATEGORY);

/** @param {string} name @param {string} birthDate @param {string | null} [nameDay] */
function addBirthday(name, birthDate, nameDay = null) {
  db.prepare(`
    INSERT INTO birthdays (name, birth_date, name_day, created_by) VALUES (?, ?, ?, ?)
  `).run(name, birthDate, nameDay, ANNA);
}
addBirthday('Zoe', '1990-03-12');
addBirthday('Adam', '1985-03-12', '03-13');
addBirthday('Mia', '2000-03-20');
for (let i = 0; i < 6; i += 1) addBirthday(`Later ${i}`, `1970-0${4 + (i % 5)}-01`);

const ZONE = 'Europe/Berlin';
// The household zone the birthday days are counted in (the route's ctx.zone).
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(ZONE);
const WEDNESDAY = Object.freeze({ today: '2026-03-11', zone: ZONE, now: new Date('2026-03-11T09:30:00.000Z') });
const THURSDAY = Object.freeze({ today: '2026-03-12', zone: ZONE, now: new Date('2026-03-12T09:30:00.000Z') });

const anna = personReader(ANNA);

test('the slices read no clock: two ctx, a wrong system clock, two answers that fit ctx', () => {
  // A system clock years away: any reading of it counts the days from 2031.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-07-01T03:00:00.000Z') });
  try {
    const wednesday = birthdaysOverviewSlice(db, anna, WEDNESDAY);
    const thursday = birthdaysOverviewSlice(db, anna, THURSDAY);
    assert.deepEqual(wednesday.birthdays.slice(0, 2).map((b) => [b.name, b.kind, b.days_until]),
      [['Adam', 'birthday', 1], ['Zoe', 'birthday', 1]]);
    assert.deepEqual(thursday.birthdays.slice(0, 3).map((b) => [b.name, b.kind, b.days_until]),
      [['Adam', 'birthday', 0], ['Zoe', 'birthday', 0], ['Adam', 'name_day', 1]]);
    assert.equal(wednesday.birthdaySoonCount, 3);
    assert.equal(notesOverviewSlice(db, anna, WEDNESDAY).notesTotal, 7);
  } finally {
    mock.timers.reset();
  }
});

test('birthdays: sorted by days, name and kind, capped at eight, counts uncapped', () => {
  const answer = birthdaysOverviewSlice(db, anna, WEDNESDAY);
  assert.deepEqual(answer.birthdays.slice(0, 4).map((b) => `${b.name}/${b.kind}`),
    ['Adam/birthday', 'Zoe/birthday', 'Adam/name_day', 'Mia/birthday']);
  assert.equal(answer.birthdays.length, 8, 'the stock of the largest tile');
  assert.equal(answer.birthdayCount, 9, 'people');
  assert.equal(answer.birthdayTotal, 10, 'occasions: a name day is a row of its own');
  // The success order the route has always written.
  assert.deepEqual(Object.keys(answer), ['birthdaySoonCount', 'birthdays', 'birthdayCount', 'birthdayTotal']);
});

test('notes: pinned first, then newest, five at most; real pin count and total', () => {
  const answer = notesOverviewSlice(db, anna, WEDNESDAY);
  assert.deepEqual(answer.pinnedNotes.map((note) => note.title),
    ['old pin', 'plain 15', 'plain 14', 'plain 13', 'plain 12']);
  assert.equal(answer.pinnedNotesCount, 1, "Ben's private pin is not Anna's");
  assert.equal(answer.notesTotal, 7);
  const categories = /** @type {{ name: string }[]} */ (answer.pinnedNotes[0].categories);
  assert.deepEqual(categories.map((c) => c.name), ['House'],
    "Ben's personal category does not travel with Anna's note");
  assert.equal(answer.pinnedNotes[0].author_name, 'Anna');
});

test('notes: the category selection filters list and counts, a foreign personal category finds nothing', () => {
  const house = notesOverviewSlice(db, anna, WEDNESDAY, { categories: [HOUSEHOLD_CATEGORY] });
  assert.deepEqual(house.pinnedNotes.map((note) => note.title), ['old pin']);
  assert.equal(house.pinnedNotesCount, 1);
  assert.equal(house.notesTotal, 1);
  const guessed = notesOverviewSlice(db, anna, WEDNESDAY, { categories: [BENS_CATEGORY] });
  assert.deepEqual(guessed, { pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 });
});

test('the note category filter keeps positive integers, once each, at most 50', () => {
  assert.deepEqual(normalizeNoteCategoryFilter(undefined), []);
  assert.deepEqual(normalizeNoteCategoryFilter(['3', '3', 'abc', '-1', '0', '2.5', '7']), [3, 7]);
  assert.deepEqual(normalizeNoteCategoryFilter('9'), [9]);
  assert.equal(normalizeNoteCategoryFilter(Array.from({ length: 60 }, (_v, i) => String(i + 1))).length, 50);
});

test('the empty forms and the failure values carry exactly the keys of the slices', () => {
  const noteKeys = Object.keys(notesOverviewSlice(db, anna, WEDNESDAY));
  assert.deepEqual(Object.keys(emptyNotesOverview()), noteKeys);
  assert.deepEqual(Object.keys(NOTES_BLOCK_FAILED), noteKeys);
  assert.deepEqual(emptyNotesOverview(), { pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 });
  assert.notEqual(emptyNotesOverview(), emptyNotesOverview(), 'a fresh object per call');

  const birthdayKeys = Object.keys(birthdaysOverviewSlice(db, anna, WEDNESDAY)).sort();
  assert.deepEqual(Object.keys(emptyBirthdaysOverview()).sort(), birthdayKeys);
  assert.deepEqual(Object.keys(BIRTHDAYS_BLOCK_FAILED).sort(), birthdayKeys);
  // The empty form keeps the key order of the route's old emptyBirthdays().
  assert.deepEqual(Object.keys(emptyBirthdaysOverview()), ['birthdays', 'birthdayCount', 'birthdayTotal', 'birthdaySoonCount']);
  assert.notEqual(emptyBirthdaysOverview(), emptyBirthdaysOverview(), 'a fresh object per call');
});

/** A logger that keeps what runSlice() writes. */
function capturingLog() {
  /** @type {unknown[][]} */
  const lines = [];
  return { lines, error: (/** @type {unknown[]} */ ...args) => { lines.push(args); } };
}

test('through the slices a failing read answers its failure value under its old name', () => {
  const broken = { prepare() { throw new Error('no such table: notes'); }, exec() {} };

  const notesLog = capturingLog();
  const notes = notesOverviewSlice(broken, anna, WEDNESDAY, {}, sliceRunner(notesLog));
  assert.deepEqual(notes, { pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 });
  assert.deepEqual(notes, { ...NOTES_BLOCK_FAILED });
  assert.deepEqual(notesLog.lines, [['pinnedNotes error:', 'no such table: notes']]);
  assert.throws(() => notesOverviewSlice(broken, anna, WEDNESDAY), /no such table/,
    'without a guard a failing read throws');

  const birthdaysLog = capturingLog();
  const birthdays = birthdaysOverviewSlice(broken, anna, WEDNESDAY, {}, sliceRunner(birthdaysLog));
  assert.deepEqual(birthdays, { ...BIRTHDAYS_BLOCK_FAILED });
  assert.deepEqual(Object.keys(birthdays), ['birthdays', 'birthdayCount', 'birthdayTotal', 'birthdaySoonCount'],
    'the failure keeps the old key order');
  assert.deepEqual(birthdaysLog.lines, [['birthdays error:', 'no such table: notes']]);
  assert.throws(() => birthdaysOverviewSlice(broken, anna, WEDNESDAY), /no such table/,
    'without a guard a failing read throws');
});

test('a count that fails after the list empties the whole note block, as the one try/catch did', () => {
  const countBroken = {
    /** @param {string} sql */
    prepare(sql) {
      if (sql.includes('n.pinned = 1')) throw new Error('count boom');
      return db.prepare(sql);
    },
    exec() {},
  };
  const log = capturingLog();
  assert.deepEqual(notesOverviewSlice(countBroken, anna, WEDNESDAY, {}, sliceRunner(log)),
    { pinnedNotes: [], pinnedNotesCount: 0, notesTotal: 0 });
  assert.deepEqual(log.lines, [['pinnedNotes error:', 'count boom']]);
});

test('notes: pins with the same update time stand newest id first, with and without a category', () => {
  // Inserted as 9002, 9003, 9001: only the id as last key decides their order.
  // Without it the plain list and the category list sorted the ties differently.
  const insertNote = db.prepare(`
    INSERT INTO notes (id, title, content, pinned, visibility, created_by, updated_at)
    VALUES (?, ?, '', 1, 'all', ?, '2026-03-20T08:00:00Z')
  `);
  const assign = db.prepare('INSERT INTO note_category_assignments (note_id, category_id) VALUES (?, ?)');
  for (const id of [9002, 9003, 9001]) {
    insertNote.run(id, `tie ${id}`, ANNA);
    assign.run(id, HOUSEHOLD_CATEGORY);
  }
  try {
    /** @param {{ pinnedNotes: { id?: unknown }[] }} answer */
    const firstThree = (answer) => answer.pinnedNotes.slice(0, 3).map((note) => note.id);
    assert.deepEqual(firstThree(notesOverviewSlice(db, anna, WEDNESDAY)), [9003, 9002, 9001]);
    assert.deepEqual(firstThree(notesOverviewSlice(db, anna, WEDNESDAY, { categories: [HOUSEHOLD_CATEGORY] })),
      [9003, 9002, 9001]);
  } finally {
    db.prepare('DELETE FROM notes WHERE id IN (9001, 9002, 9003)').run();
  }
});
