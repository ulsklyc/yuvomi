/**
 * Module: the global search as slices (phase 2, section D)
 * Purpose: holds the contract of the search slices (`<module>SearchSlice(db, actor,
 *          query, options?)` in server/services/<module>-slices.ts) and of the
 *          orchestration that calls them (server/services/search.js runSearch,
 *          runTableSearch, searchEverything):
 *
 *          1. EACH SLICE. A hit, no hit, the cap SEARCH_LIMIT, and the row rule:
 *             a private row of someone else stays out (tasks, events, notes,
 *             medications, activities, documents, budget in personal mode); a
 *             household bucket (contacts, items, waste, recipes, pantry,
 *             inventory, birthdays) finds rows anyone created. Archived waste
 *             types stay out.
 *          2. THE EVENT CANDIDATES. More candidates than the cap are resolved
 *             (EVENT_SEARCH_CANDIDATES): six old yearly series stand before a
 *             single event tomorrow in the SQL order, yet tomorrow comes first.
 *          3. THE ORCHESTRATION. The answer keys in their old order; the slices
 *             called in their old order; a hidden module (`hiddenModules`) or a
 *             switched-off nav entry (`disabledNav`) never calls its slice; a
 *             slice that throws ends the whole search (no error isolation).
 *
 *          The whole GET /search answer per role is held byte for byte by
 *          test:overview-golden; this suite holds what that one cannot see.
 *
 * Run: npm run test:search-slices
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// 10:30 in Berlin on 2026-03-11: todayKey() of the event window reads this clock.
const FROZEN_NOW = Date.parse('2026-03-11T09:30:00.000Z');
mock.timers.enable({ apis: ['Date'], now: FROZEN_NOW });

// The production driver, migrated by server/db.js itself, in memory.
process.env.DB_PATH = ':memory:';

const { get } = await import('../server/db.js');
const search = await import('../server/services/search.js');
const { EVENT_SEARCH_CANDIDATES } = await import('../server/services/search-events.ts');
const { tasksSearchSlice } = await import('../server/services/tasks-slices.ts');
const { birthdaysSearchSlice, calendarSearchSlice } = await import('../server/services/calendar-slices.ts');
const { notesSearchSlice } = await import('../server/services/notes-slices.ts');
const { contactsSearchSlice } = await import('../server/services/contacts-slices.ts');
const { shoppingSearchSlice } = await import('../server/services/shopping-slices.ts');
const { healthActivitiesSearchSlice, healthMedsSearchSlice } = await import('../server/services/health-slices.ts');
const { wasteSearchSlice } = await import('../server/services/waste-slices.ts');
const { recipesSearchSlice } = await import('../server/services/recipes-slices.ts');
const { pantrySearchSlice } = await import('../server/services/pantry-slices.ts');
const { inventorySearchSlice } = await import('../server/services/inventory-slices.ts');
const { documentsSearchSlice } = await import('../server/services/documents-slices.ts');
const { budgetSearchSlice } = await import('../server/services/budget-slices.ts');

const { SEARCH_LIMIT, buildMatchQuery, foldSearchText, searchEverything, SEARCH_MODULES } = search;
const db = get();

db.prepare(`
  INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run();

// --------------------------------------------------------------------------
// Seed: two members; every bucket gets its own word.
// --------------------------------------------------------------------------

const addUser = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
                            VALUES (?, ?, 'x', 'member') RETURNING id`);
const ALICE = /** @type {{ id: number }} */ (addUser.get('alice', 'Alice')).id;
const BOB = /** @type {{ id: number }} */ (addUser.get('bob', 'Bob')).id;
const list = /** @type {{ id: number }} */ (db.prepare(`INSERT INTO shopping_lists (name, created_by)
  VALUES ('Groceries', ?) RETURNING id`).get(ALICE)).id;

/** @param {string} sql @param {unknown[]} params @returns {number} */
const insert = (sql, ...params) => /** @type {{ id: number }} */ (db.prepare(`${sql} RETURNING id`).get(...params)).id;

const MANY = SEARCH_LIMIT + 2;
/** @param {number} n */
const range = (n) => Array.from({ length: n }, (_, i) => i);

/** Ids of the rows each bucket must find for Alice, and the one it must not. */
/** @type {Record<string, any>} */
const seed = {
  tasks: range(MANY).map((i) => insert(`INSERT INTO tasks (title, created_by) VALUES (?, ?)`, `taskword ${i}`, ALICE)),
  tasksHidden: insert(`INSERT INTO tasks (title, visibility, created_by) VALUES ('taskword bob', 'private', ?)`, BOB),
  events: range(MANY).map((i) => insert(`INSERT INTO calendar_events (title, start_datetime, created_by)
    VALUES (?, ?, ?)`, `eventword ${i}`, `2026-04-${String(10 + i).padStart(2, '0')}T10:00`, ALICE)),
  eventsHidden: insert(`INSERT INTO calendar_events (title, start_datetime, visibility, created_by)
    VALUES ('eventword bob', '2026-04-01T10:00', 'private', ?)`, BOB),
  notes: range(MANY).map((i) => insert(`INSERT INTO notes (title, content, created_by) VALUES (?, 'x', ?)`, `noteword ${i}`, ALICE)),
  notesHidden: insert(`INSERT INTO notes (title, content, visibility, created_by) VALUES ('noteword bob', 'x', 'private', ?)`, BOB),
  contacts: range(MANY).map((i) => insert(`INSERT INTO contacts (name) VALUES (?)`, `contactword ${i}`)),
  items: range(MANY).map((i) => insert(`INSERT INTO shopping_items (list_id, name) VALUES (?, ?)`, list, `itemword ${i}`)),
  meds: range(MANY).map((i) => insert(`INSERT INTO medications (user_id, name) VALUES (?, ?)`, ALICE, `medword ${i}`)),
  medsFamily: insert(`INSERT INTO medications (user_id, name, visibility) VALUES (?, 'medword family', 'family')`, BOB),
  medsHidden: insert(`INSERT INTO medications (user_id, name) VALUES (?, 'medword bob')`, BOB),
  activities: range(MANY).map((i) => insert(`INSERT INTO health_activities (user_id, type, performed_at)
    VALUES (?, ?, ?)`, ALICE, `activityword ${i}`, `2026-03-0${1 + i}T08:00`)),
  activitiesHidden: insert(`INSERT INTO health_activities (user_id, type, performed_at)
    VALUES (?, 'activityword bob', '2026-03-01T08:00')`, BOB),
  waste: range(MANY).map((i) => insert(`INSERT INTO waste_types (name, color) VALUES (?, '#000000')`, `wasteword ${i}`)),
  wasteArchived: insert(`INSERT INTO waste_types (name, color, archived) VALUES ('wasteword archived', '#000000', 1)`),
  recipes: range(MANY).map((i) => insert(`INSERT INTO recipes (title, created_by) VALUES (?, ?)`, `recipeword ${i}`, BOB)),
  pantry: range(MANY).map((i) => insert(`INSERT INTO pantry_items (name) VALUES (?)`, `pantryword ${i}`)),
  inventory: range(MANY).map((i) => insert(`INSERT INTO inventory_items (name) VALUES (?)`, `inventoryword ${i}`)),
  documents: range(MANY).map((i) => insert(`INSERT INTO family_documents
    (name, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'a.pdf', 'application/pdf', 1, X'00', ?)`, `documentword ${i}`, ALICE)),
  documentsHidden: insert(`INSERT INTO family_documents
    (name, original_name, mime_type, file_size, content_data, visibility, created_by)
    VALUES ('documentword bob', 'b.pdf', 'application/pdf', 1, X'00', 'private', ?)`, BOB),
  birthdays: range(MANY).map((i) => insert(`INSERT INTO birthdays (name, birth_date, created_by)
    VALUES (?, '1990-05-01', ?)`, `birthdayword ${i}`, BOB)),
  budget: range(MANY).map((i) => insert(`INSERT INTO budget_entries (title, amount, date, created_by, owner_id)
    VALUES (?, -1, ?, ?, ?)`, `budgetword ${i}`, `2026-03-0${1 + i}`, ALICE, ALICE)),
  budgetHidden: insert(`INSERT INTO budget_entries (title, amount, date, created_by, owner_id, visibility)
    VALUES ('budgetword bob', -1, '2026-03-01', ?, ?, 'private')`, BOB, BOB),
};

const alice = Object.freeze({ userId: ALICE });
const bob = Object.freeze({ userId: BOB });

/** The query of an index slice, as runSearch builds it. */
/** @param {string} text */
const indexQuery = (text) => ({ text, match: /** @type {string} */ (buildMatchQuery(text, { database: db })) });

/** The query of a table slice: the same rule as runTableSearch (every word, folded). */
/** @param {string} text */
const tableQuery = (text) => {
  const tokens = text.split(/\s+/).map(foldSearchText);
  return { text, matches: (/** @type {unknown[]} */ ...fields) => {
    const hay = foldSearchText(fields.filter((f) => f != null && f !== '').join(' '));
    return tokens.every((tok) => hay.includes(tok));
  } };
};

/** @param {Array<Record<string, unknown>>} rows */
const ids = (rows) => rows.map((row) => row.id);

/** One row of the slice table: bucket, slice, word, query kind, and the row rule. */
/**
 * @type {Array<{ bucket: string, slice: (db: any, actor: any, query: any) => Array<Record<string, any>>,
 *   word: string, query: (text: string) => any, hidden?: string, household?: boolean }>}
 */
const SLICES = [
  { bucket: 'tasks', slice: tasksSearchSlice, word: 'taskword', query: indexQuery, hidden: 'tasksHidden' },
  { bucket: 'events', slice: calendarSearchSlice, word: 'eventword', query: indexQuery, hidden: 'eventsHidden' },
  { bucket: 'notes', slice: notesSearchSlice, word: 'noteword', query: indexQuery, hidden: 'notesHidden' },
  { bucket: 'contacts', slice: contactsSearchSlice, word: 'contactword', query: indexQuery, household: true },
  { bucket: 'items', slice: shoppingSearchSlice, word: 'itemword', query: indexQuery, household: true },
  { bucket: 'meds', slice: healthMedsSearchSlice, word: 'medword', query: indexQuery, hidden: 'medsHidden' },
  { bucket: 'activities', slice: healthActivitiesSearchSlice, word: 'activityword', query: indexQuery, hidden: 'activitiesHidden' },
  { bucket: 'waste', slice: wasteSearchSlice, word: 'wasteword', query: indexQuery, hidden: 'wasteArchived', household: true },
  { bucket: 'recipes', slice: recipesSearchSlice, word: 'recipeword', query: tableQuery, household: true },
  { bucket: 'pantry', slice: pantrySearchSlice, word: 'pantryword', query: tableQuery, household: true },
  { bucket: 'inventory', slice: inventorySearchSlice, word: 'inventoryword', query: tableQuery, household: true },
  { bucket: 'documents', slice: documentsSearchSlice, word: 'documentword', query: tableQuery, hidden: 'documentsHidden' },
  { bucket: 'birthdays', slice: birthdaysSearchSlice, word: 'birthdayword', query: tableQuery, household: true },
  { bucket: 'budget', slice: budgetSearchSlice, word: 'budgetword', query: tableQuery, hidden: 'budgetHidden' },
];

/** Budget hides a private row of someone else only in personal mode (#659). */
/**
 * @template T
 * @param {string} mode
 * @param {() => T} fn
 * @returns {T}
 */
function withBudgetMode(mode, fn) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('budget_mode', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);
  try { return fn(); } finally { db.prepare("DELETE FROM sync_config WHERE key = 'budget_mode'").run(); }
}

// --------------------------------------------------------------------------
// 1. Each slice
// --------------------------------------------------------------------------

for (const { bucket, slice, word, query, hidden, household } of SLICES) {
  test(`${bucket}: a hit, capped at SEARCH_LIMIT`, () => {
    const rows = withBudgetMode('personal', () => slice(db, alice, query(`${word} 3`)));
    assert.deepEqual(ids(rows), [seed[bucket][3]], 'the one row whose title has both words');
    const all = withBudgetMode('personal', () => slice(db, alice, query(word)));
    assert.equal(all.length, SEARCH_LIMIT, `${MANY} visible rows, at most ${SEARCH_LIMIT} come back`);
    for (const id of ids(all)) assert.ok([...seed[bucket], seed.medsFamily].includes(id), `row ${id} is one of the seeded hits`);
  });

  test(`${bucket}: no hit`, () => {
    assert.deepEqual(slice(db, alice, query(`${word} nothingmatches`)), []);
  });

  if (hidden) {
    test(`${bucket}: a row Alice may not see stays out (${hidden})`, () => {
      const marker = bucket === 'waste' ? 'archived' : 'bob';
      const rows = withBudgetMode('personal', () => slice(db, alice, query(`${word} ${marker}`)));
      assert.deepEqual(rows, [], 'the row matches the words but not the row rule');
      if (bucket !== 'waste') {
        const own = withBudgetMode('personal', () => slice(db, bob, query(`${word} bob`)));
        assert.deepEqual(ids(own), [seed[hidden]], 'its owner finds it');
      }
    });
  }

  if (household) {
    test(`${bucket}: household property, no row rule`, () => {
      // Recipes and birthdays were created by Bob, contacts, items, waste, pantry
      // and inventory by nobody: Alice finds them all the same.
      assert.ok(slice(db, alice, query(word)).length > 0);
      assert.deepEqual(ids(slice(db, alice, query(word))), ids(slice(db, bob, query(word))));
    });
  }
}

test('meds: a `family` row of someone else is found', () => {
  assert.deepEqual(ids(healthMedsSearchSlice(db, alice, indexQuery('medword family'))), [seed.medsFamily]);
});

test('budget: shared mode shows every title (#659 only narrows personal mode)', () => {
  assert.deepEqual(ids(budgetSearchSlice(db, alice, tableQuery('budgetword bob'))), [seed.budgetHidden]);
});

// --------------------------------------------------------------------------
// 2. The event candidates
// --------------------------------------------------------------------------

test(`events: ${EVENT_SEARCH_CANDIDATES} candidates are resolved, not ${SEARCH_LIMIT}`, () => {
  assert.ok(EVENT_SEARCH_CANDIDATES > SEARCH_LIMIT);
  // Six yearly series from the 1990s: their master rows stand first in the SQL
  // order (start ascending), their next occurrence lies in June.
  const series = range(SEARCH_LIMIT + 1).map((i) => insert(`INSERT INTO calendar_events
    (title, start_datetime, recurrence_rule, created_by)
    VALUES (?, ?, 'FREQ=YEARLY', ?)`, `annivword ${i}`, `199${i}-06-20T10:00`, ALICE));
  const tomorrow = insert(`INSERT INTO calendar_events (title, start_datetime, created_by)
    VALUES ('annivword tomorrow', '2026-03-12T10:00', ?)`, ALICE);
  try {
    const rows = calendarSearchSlice(db, alice, indexQuery('annivword'));
    assert.equal(rows.length, SEARCH_LIMIT);
    assert.equal(rows[0].id, tomorrow, 'tomorrow stands first, though it was the seventh candidate');
    for (const row of rows.slice(1)) {
      assert.ok(series.includes(/** @type {number} */ (row.id)));
      assert.ok(String(row.start_datetime).startsWith('2026-06-20'), 'a series stands at its next occurrence');
    }
  } finally {
    db.prepare("DELETE FROM calendar_events WHERE title LIKE 'annivword%'").run();
  }
});

test('events: with birthdays switched off, a birthday event leaves the event hits (#1660)', () => {
  const event = insert(`INSERT INTO calendar_events (title, start_datetime, created_by)
    VALUES ('Birthday: Partyword', '2026-05-01T00:00', ?)`, ALICE);
  const birthday = insert(`INSERT INTO birthdays (name, birth_date, created_by, calendar_event_id)
    VALUES ('Partyword', '1990-05-01', ?, ?)`, ALICE, event);
  try {
    const on = searchEverything(db, 'partyword', ALICE);
    assert.deepEqual(ids(on.events), [event]);
    assert.equal(on.events[0].birthday_name, 'Partyword', 'the event carries its birthday fields');
    const off = searchEverything(db, 'partyword', ALICE, { disabledNav: new Set(['birthdays']) });
    assert.deepEqual(off.events, []);
    assert.deepEqual(off.birthdays, []);
  } finally {
    db.prepare('DELETE FROM birthdays WHERE id = ?').run(birthday);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(event);
  }
});

// --------------------------------------------------------------------------
// 3. The orchestration
// --------------------------------------------------------------------------

const BUCKET_ORDER = ['tasks', 'events', 'notes', 'contacts', 'items', 'meds', 'activities', 'waste',
  'recipes', 'pantry', 'inventory', 'documents', 'birthdays', 'budget'];

/** Which bucket's slice a prepared SQL text belongs to. */
/** @type {Array<[string, RegExp]>} */
const SLICE_SQL = [
  ['tasks', /JOIN tasks t ON t\.id = s\.entity_id/],
  ['events', /JOIN calendar_events e ON e\.id = s\.entity_id/],
  ['notes', /JOIN notes n ON n\.id = s\.entity_id/],
  ['contacts', /JOIN contacts c ON c\.id = s\.entity_id/],
  ['items', /JOIN shopping_items i ON i\.id = s\.entity_id/],
  ['meds', /JOIN medications m ON m\.id = s\.entity_id/],
  ['activities', /JOIN health_activities a ON a\.id = s\.entity_id/],
  ['waste', /JOIN waste_types wt ON wt\.id = s\.entity_id/],
  ['recipes', /FROM recipes r\b/],
  ['pantry', /FROM pantry_items p\b/],
  ['inventory', /FROM inventory_items i\b/],
  ['documents', /FROM family_documents d\b/],
  ['birthdays', /FROM birthdays b\b/],
  ['budget', /FROM budget_entries b\b/],
];

/**
 * A connection that records which slices prepared their query, in order.
 * @param {(bucket: string) => void} [onSlice] runs before the bucket's query is prepared
 */
function recordingDb(onSlice = () => {}) {
  /** @type {string[]} */
  const called = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') {
        return (/** @type {string} */ sql) => {
          const hit = SLICE_SQL.find(([, re]) => re.test(sql));
          if (hit) { called.push(hit[0]); onSlice(hit[0]); }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, called };
}

test('the answer keys stand in their old order, every bucket filled', () => {
  const answer = searchEverything(db, 'word', ALICE);
  assert.deepEqual(Object.keys(answer), BUCKET_ORDER);
  for (const bucket of BUCKET_ORDER) assert.ok(answer[bucket].length > 0, `${bucket} has hits`);
});

test('the slices are called in their old order, each once', () => {
  const { proxy, called } = recordingDb();
  searchEverything(proxy, 'word', ALICE);
  assert.deepEqual(called, BUCKET_ORDER);
});

test('a hidden module never calls its slice, and its bucket stays an empty list', () => {
  /** @type {Record<string, string>} */
  const moduleOf = { events: 'calendar', items: 'shopping', meds: 'health', activities: 'health', recipes: 'meals', birthdays: 'calendar' };
  for (const module of SEARCH_MODULES) {
    const { proxy, called } = recordingDb();
    const answer = searchEverything(proxy, 'word', ALICE, { hiddenModules: new Set([module]) });
    const gone = BUCKET_ORDER.filter((bucket) => (moduleOf[bucket] ?? bucket) === module);
    assert.ok(gone.length > 0, `module ${module} owns a bucket`);
    assert.deepEqual(called, BUCKET_ORDER.filter((bucket) => !gone.includes(bucket)), `hidden ${module}`);
    for (const bucket of gone) assert.deepEqual(answer[bucket], [], `${bucket} is empty`);
    assert.deepEqual(Object.keys(answer), BUCKET_ORDER);
  }
});

test('a switched-off nav entry never calls its slice', () => {
  /** @type {Record<string, string>} */
  const navOf = { events: 'calendar', items: 'shopping', meds: 'health', activities: 'health' };
  const navIds = [...new Set(BUCKET_ORDER.map((bucket) => navOf[bucket] ?? bucket))];
  for (const nav of navIds) {
    const { proxy, called } = recordingDb();
    const answer = searchEverything(proxy, 'word', ALICE, { disabledNav: new Set([nav]) });
    const gone = BUCKET_ORDER.filter((bucket) => (navOf[bucket] ?? bucket) === nav);
    assert.deepEqual(called, BUCKET_ORDER.filter((bucket) => !gone.includes(bucket)), `disabled ${nav}`);
    for (const bucket of gone) assert.deepEqual(answer[bucket], [], `${bucket} is empty`);
  }
});

test('a slice that throws ends the whole search (no error isolation, as before)', () => {
  for (const bucket of ['notes', 'documents']) {
    const { proxy } = recordingDb((hit) => { if (hit === bucket) throw new Error(`boom ${bucket}`); });
    assert.throws(() => searchEverything(proxy, 'word', ALICE), new RegExp(`boom ${bucket}`));
  }
});
