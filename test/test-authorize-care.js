/**
 * Test: care grants and health row rules (phase 2, section B4) - server/authorize/care.ts
 *       through server/authorize/index.ts
 *
 * Purpose: the care rule (health_care_grants, #584) has ONE home. Held here against
 *          real SQLite with every migration, for four people: the owner, a caregiver
 *          of the owner, a stranger, and an admin WITHOUT a grant (the admin role
 *          replaces no care grant, DECISIONS 1):
 *            1. hasCareGrant / canWriteFor / caredForIds / caregiversOf answer
 *               "own data", "cared for", "not cared for" and "admin without grant".
 *            2. writableClause / writableChild: own and cared-for rows, nobody else's.
 *            3. careAwareClause in its three forms (no person, the viewer, another
 *               person) and visibilityClause: the SQL text the routes were built on,
 *               and the rows it lets through.
 *            4. readableClause (the "readable by the viewer" fragment of the lab
 *               report and medication lookups) and the fasting filter: same text as
 *               the inline SQL they replace, same rows; readableClause with OPEN_ALL
 *               and the fasting filter also against stored rows.
 *
 * Run: npm run test:authorize-care
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'authorize-care-test-secret-32chars!';
process.env.LOG_LEVEL = 'error';

// server/db.js opens `:memory:` on import and runs every migration on it.
const { get } = await import('../server/db.js');
const authorizeApi = await import('../server/authorize/index.ts');

/**
 * Read as a property, not destructured: before it exists the suite turns red on its
 * tests instead of failing on import.
 * @param {string} name
 * @returns {(...args: any[]) => any}
 */
function api(name) {
  const fn = /** @type {any} */ (authorizeApi)[name];
  assert.equal(typeof fn, 'function', `${name} is exported from server/authorize/index.ts`);
  return fn;
}

const db = get();
test.after(() => db.close());

let seq = 0;
/** @param {string} role @returns {number} */
function seedUser(role = 'member') {
  seq += 1;
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'x', '#007AFF', ?)
  `).run(`care-${seq}`, `Care ${seq}`, role).lastInsertRowid);
}

const owner = seedUser();
const caregiver = seedUser();
const stranger = seedUser();
const admin = seedUser('admin');
db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(owner, caregiver);

/** @param {number} userId @param {string} visibility @returns {number} */
function seedMedication(userId, visibility) {
  return Number(db.prepare('INSERT INTO medications (user_id, name, visibility) VALUES (?, ?, ?)')
    .run(userId, `med-${userId}-${visibility}`, visibility).lastInsertRowid);
}
const ownerPrivate = seedMedication(owner, 'private');
const ownerFamily = seedMedication(owner, 'family');
const strangerPrivate = seedMedication(stranger, 'private');
const strangerFamily = seedMedication(stranger, 'family');
const ownerSchedule = Number(db.prepare(
  "INSERT INTO medication_schedules (medication_id, time_of_day) VALUES (?, '08:00')",
).run(ownerPrivate).lastInsertRowid);

/**
 * The medication ids a fragment lets through, sorted.
 * @param {{ sql: string, params: unknown[] }} clause
 * @returns {number[]}
 */
function medIds(clause) {
  return db.prepare(`SELECT id FROM medications m WHERE ${clause.sql} ORDER BY id`)
    .all(...clause.params).map((/** @type {any} */ r) => r.id);
}

const SUBQUERY = 'SELECT subject_id FROM health_care_grants WHERE caregiver_id = ?';

// ── 1. The single questions ────────────────────────────────────────────────────

test('hasCareGrant: only the granted caregiver, in one direction', () => {
  const hasCareGrant = api('hasCareGrant');
  assert.equal(hasCareGrant(db, caregiver, owner), true);
  assert.equal(hasCareGrant(db, owner, caregiver), false, 'the grant has a direction');
  assert.equal(hasCareGrant(db, stranger, owner), false);
  assert.equal(hasCareGrant(db, admin, owner), false, 'an admin holds no grant');
  assert.equal(hasCareGrant(db, owner, owner), false, 'owning is not a grant');
});

test('canWriteFor: own data and cared-for people; not strangers, not an admin', () => {
  const canWriteFor = api('canWriteFor');
  assert.equal(canWriteFor(db, owner, owner), true, 'own data');
  assert.equal(canWriteFor(db, caregiver, owner), true, 'cared for');
  assert.equal(canWriteFor(db, stranger, owner), false, 'not cared for');
  assert.equal(canWriteFor(db, admin, owner), false, 'admin without grant');
  assert.equal(canWriteFor(db, owner, caregiver), false, 'the grant has a direction');
  assert.equal(canWriteFor(db, null, owner), false, 'no viewer');
  assert.equal(canWriteFor(db, owner, 0), false, 'no owner');
});

test('caredForIds: the people a viewer cares for, [] without a grant or a viewer', () => {
  const caredForIds = api('caredForIds');
  assert.deepEqual(caredForIds(db, caregiver), [owner]);
  assert.deepEqual(caredForIds(db, owner), [], 'own data is no care grant');
  assert.deepEqual(caredForIds(db, stranger), []);
  assert.deepEqual(caredForIds(db, admin), [], 'admin without grant');
  assert.deepEqual(caredForIds(db, null), []);
});

test('caregiversOf: the caregivers of a person', () => {
  const caregiversOf = api('caregiversOf');
  assert.deepEqual(caregiversOf(db, owner), [caregiver]);
  assert.deepEqual(caregiversOf(db, stranger), []);
});

// ── 2. Writable rows ───────────────────────────────────────────────────────────

test('writableClause: own rows plus those of cared-for people, the text the routes bind', () => {
  const writableClause = api('writableClause');
  assert.deepEqual(writableClause('', 7), {
    sql: `(user_id = ? OR user_id IN (${SUBQUERY}))`,
    params: [7, 7],
  });
  assert.deepEqual(writableClause('m', 7).sql, `(m.user_id = ? OR m.user_id IN (${SUBQUERY}))`);
  assert.deepEqual(medIds(writableClause('m', owner)), [ownerPrivate, ownerFamily], 'own data');
  assert.deepEqual(medIds(writableClause('m', caregiver)), [ownerPrivate, ownerFamily], 'cared for, private too');
  assert.deepEqual(medIds(writableClause('m', stranger)), [strangerPrivate, strangerFamily], 'only their own');
  assert.deepEqual(medIds(writableClause('m', admin)), [], 'admin without grant');
});

test('writableChild: a child row through a writable parent, else null', () => {
  const writableChild = api('writableChild');
  const sql = 'SELECT s.* FROM medication_schedules s JOIN medications m ON m.id = s.medication_id WHERE s.id = ?';
  assert.equal(writableChild(db, sql, 'm', ownerSchedule, owner)?.id, ownerSchedule, 'own data');
  assert.equal(writableChild(db, sql, 'm', ownerSchedule, caregiver)?.id, ownerSchedule, 'cared for');
  assert.equal(writableChild(db, sql, 'm', ownerSchedule, stranger), null, 'not cared for');
  assert.equal(writableChild(db, sql, 'm', ownerSchedule, admin), null, 'admin without grant');
  assert.equal(writableChild(db, sql, 'm', 999999, owner), null, 'unknown id');
});

// ── 3. Readable rows ───────────────────────────────────────────────────────────

test('careAwareClause without a person: own, family-visible and cared-for rows', () => {
  const careAwareClause = api('careAwareClause');
  assert.deepEqual(careAwareClause('m', 7, null), {
    sql: `(m.user_id = ? OR m.visibility = ? OR m.user_id IN (${SUBQUERY}))`,
    params: [7, 'family', 7],
  });
  assert.deepEqual(careAwareClause('e', 7, null, 'all').params, [7, 'all', 7], 'the open value is a bind');
  assert.deepEqual(medIds(careAwareClause('m', owner, null)), [ownerPrivate, ownerFamily, strangerFamily]);
  assert.deepEqual(medIds(careAwareClause('m', caregiver, null)), [ownerPrivate, ownerFamily, strangerFamily]);
  assert.deepEqual(medIds(careAwareClause('m', stranger, null)), [ownerFamily, strangerPrivate, strangerFamily]);
  assert.deepEqual(medIds(careAwareClause('m', admin, null)), [ownerFamily, strangerFamily], 'admin without grant');
});

test('careAwareClause for the viewer themself: their rows only', () => {
  const careAwareClause = api('careAwareClause');
  assert.deepEqual(careAwareClause('m', 7, 7), { sql: 'm.user_id = ?', params: [7] });
  assert.deepEqual(medIds(careAwareClause('m', owner, owner)), [ownerPrivate, ownerFamily]);
});

test('careAwareClause for another person: everything when cared for, else family only', () => {
  const careAwareClause = api('careAwareClause');
  assert.deepEqual(careAwareClause('m', 7, 9), {
    sql: `m.user_id = ? AND (m.visibility = ? OR ? IN (${SUBQUERY}))`,
    params: [9, 'family', 9, 7],
  });
  assert.deepEqual(medIds(careAwareClause('m', caregiver, owner)), [ownerPrivate, ownerFamily], 'cared for');
  assert.deepEqual(medIds(careAwareClause('m', stranger, owner)), [ownerFamily], 'not cared for');
  assert.deepEqual(medIds(careAwareClause('m', admin, owner)), [ownerFamily], 'admin without grant');
});

test('visibilityClause: owner or family, care plays no part', () => {
  const visibilityClause = api('visibilityClause');
  assert.deepEqual(visibilityClause('p', 7, null), { sql: '(p.user_id = ? OR p.visibility = ?)', params: [7, 'family'] });
  assert.deepEqual(visibilityClause('p', 7, 7), { sql: 'p.user_id = ?', params: [7] });
  assert.deepEqual(visibilityClause('p', 7, 9), { sql: 'p.user_id = ? AND p.visibility = ?', params: [9, 'family'] });
  assert.deepEqual(medIds(visibilityClause('m', caregiver, owner)), [ownerFamily], 'a grant does not open cycle data');
});

test('readableClause: the literal family value or a writable row, as the inline SQL was', () => {
  const readableClause = api('readableClause');
  const w = api('writableClause')('', 7);
  assert.deepEqual(readableClause('', 7), { sql: `(visibility = 'family' OR ${w.sql})`, params: w.params });
  assert.throws(() => readableClause('', 7, "x' OR 1=1 --"), TypeError, 'only a known open value becomes SQL text');
  const ids = (/** @type {number} */ viewer) => db.prepare(
    `SELECT id FROM medications WHERE ${readableClause('', viewer).sql} ORDER BY id`,
  ).all(...readableClause('', viewer).params).map((/** @type {any} */ r) => r.id);
  assert.deepEqual(ids(owner), [ownerPrivate, ownerFamily, strangerFamily], 'own data');
  assert.deepEqual(ids(caregiver), [ownerPrivate, ownerFamily, strangerFamily], 'cared for');
  assert.deepEqual(ids(stranger), [ownerFamily, strangerPrivate, strangerFamily], 'not cared for');
  assert.deepEqual(ids(admin), [ownerFamily, strangerFamily], 'admin without grant');
});

test('readableClause with OPEN_ALL: \'all\' is the open value, \'family\' is not', () => {
  const readableClause = api('readableClause');
  const OPEN_ALL = /** @type {any} */ (authorizeApi).OPEN_ALL;
  const w = api('writableClause')('n', 7);
  assert.deepEqual(readableClause('n', 7, OPEN_ALL), { sql: `(n.visibility = 'all' OR ${w.sql})`, params: w.params });
  // health_nutrition_entries carries the canonical set (CHECK private | all).
  const nutrition = (/** @type {number} */ userId, /** @type {string} */ visibility) => Number(db.prepare(
    "INSERT INTO health_nutrition_entries (user_id, consumed_at, title, visibility, created_by) VALUES (?, '2026-01-01T08:00', 'n', ?, ?)",
  ).run(userId, visibility, userId).lastInsertRowid);
  const nOwnerPrivate = nutrition(owner, 'private');
  const nOwnerAll = nutrition(owner, 'all');
  const nStrangerPrivate = nutrition(stranger, 'private');
  const nStrangerAll = nutrition(stranger, 'all');
  try {
    const ids = (/** @type {string} */ table, /** @type {number} */ viewer) => {
      const clause = readableClause('n', viewer, OPEN_ALL);
      return db.prepare(`SELECT n.id FROM ${table} n WHERE ${clause.sql} ORDER BY n.id`)
        .all(...clause.params).map((/** @type {any} */ r) => r.id);
    };
    const n = 'health_nutrition_entries';
    assert.deepEqual(ids(n, owner), [nOwnerPrivate, nOwnerAll, nStrangerAll], 'own data');
    assert.deepEqual(ids(n, caregiver), [nOwnerPrivate, nOwnerAll, nStrangerAll], 'cared for');
    assert.deepEqual(ids(n, stranger), [nOwnerAll, nStrangerPrivate, nStrangerAll], 'not cared for');
    assert.deepEqual(ids(n, admin), [nOwnerAll, nStrangerAll], 'admin without grant');
    // Over a table that writes 'family', OPEN_ALL opens nothing: only the writable rows.
    assert.deepEqual(ids('medications', stranger), [strangerPrivate, strangerFamily], 'family is not open under OPEN_ALL');
    assert.deepEqual(ids('medications', admin), [], 'admin without grant, nothing open');
  } finally {
    db.prepare(`DELETE FROM health_nutrition_entries WHERE id IN (${[nOwnerPrivate, nOwnerAll, nStrangerPrivate, nStrangerAll].join(',')})`).run();
  }
});

test('fastingVisibleFilter against health_fasts: a stranger gets the family rows, never private ones', () => {
  const fastingVisibleFilter = api('fastingVisibleFilter');
  const ownerFast = (/** @type {string} */ visibility) => Number(db.prepare(`
    INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, visibility)
    VALUES (?, '2025-06-01T08:00:00Z', '2025-06-01T20:00:00Z', 'UTC', ?)
  `).run(owner, visibility).lastInsertRowid);
  const fPrivate = ownerFast('private');
  const fFamily = ownerFast('family');
  try {
    const ids = (/** @type {number} */ viewer) => db.prepare(
      `SELECT id FROM health_fasts WHERE ${fastingVisibleFilter(db, viewer, owner)} AND id IN (?, ?) ORDER BY id`,
    ).all(owner, fPrivate, fFamily).map((/** @type {any} */ r) => r.id);
    assert.deepEqual(ids(owner), [fPrivate, fFamily], 'own data');
    assert.deepEqual(ids(caregiver), [fPrivate, fFamily], 'cared for');
    assert.deepEqual(ids(stranger), [fFamily], 'not cared for: the family row');
    assert.deepEqual(ids(admin), [fFamily], 'admin without grant: the family row');
  } finally {
    db.prepare('DELETE FROM health_fasts WHERE id IN (?, ?)').run(fPrivate, fFamily);
  }
});

test('fastingVisibleFilter: full view for the owner and a caregiver, family rows for others', () => {
  const fastingVisibleFilter = api('fastingVisibleFilter');
  assert.equal(fastingVisibleFilter(db, owner, owner), 'user_id = ?', 'own data');
  assert.equal(fastingVisibleFilter(db, caregiver, owner), 'user_id = ?', 'cared for');
  assert.equal(fastingVisibleFilter(db, stranger, owner), "user_id = ? AND visibility = 'family'", 'not cared for');
  assert.equal(fastingVisibleFilter(db, admin, owner), "user_id = ? AND visibility = 'family'", 'admin without grant');
});

test('the open values', () => {
  assert.equal(/** @type {any} */ (authorizeApi).OPEN_FAMILY, 'family');
  assert.equal(/** @type {any} */ (authorizeApi).OPEN_ALL, 'all');
});

// ── 5. The row form of readableClause (B8b) ────────────────────────────────────
//
// healthRowReadable() answers for one loaded row (fasting.js loadWritable),
// readableRows() filters the derived list of one owner (prevention due). Held
// against readableClause over health_fasts (CHECK private | family) for every viewer.

/** @param {number} userId @param {string} visibility @param {number} day @returns {number} */
function seedFast(userId, visibility, day) {
  return Number(db.prepare(`
    INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, visibility)
    VALUES (?, ?, ?, 'UTC', ?)
  `).run(userId, `2026-01-${String(day).padStart(2, '0')}T08:00:00Z`, `2026-01-${String(day).padStart(2, '0')}T20:00:00Z`, visibility).lastInsertRowid);
}
let fastDay = 1;
for (const person of [owner, caregiver, stranger, admin]) {
  for (const visibility of ['private', 'family']) seedFast(person, visibility, fastDay++);
}
const FAST_VIEWERS = [owner, caregiver, stranger, admin];
/** @returns {any[]} */
const fastRows = () => db.prepare('SELECT * FROM health_fasts ORDER BY id').all();

/** A connection that counts its prepare() calls. */
function countingDb() {
  let calls = 0;
  return {
    database: { prepare: (/** @type {string} */ sql) => { calls += 1; return db.prepare(sql); } },
    get calls() { return calls; },
  };
}

test('healthRowReadable: the same rows as readableClause for every viewer', () => {
  const healthRowReadable = api('healthRowReadable');
  const readableClause = api('readableClause');
  for (const viewer of FAST_VIEWERS) {
    const clause = readableClause('', viewer);
    const sql = db.prepare(`SELECT id FROM health_fasts WHERE ${clause.sql} ORDER BY id`)
      .all(...clause.params).map((/** @type {any} */ r) => r.id);
    const js = fastRows().filter((row) => healthRowReadable(db, row, viewer)).map((row) => row.id);
    assert.deepEqual(js, sql, `viewer ${viewer}`);
  }
  assert.equal(healthRowReadable(db, null, owner), false, 'no row');
  assert.throws(() => healthRowReadable(db, fastRows()[0], owner, 'shared'), TypeError, 'only a known open value');
});

test('healthRowReadable: reads the grant only for a foreign row that is not open', () => {
  const healthRowReadable = api('healthRowReadable');
  for (const row of fastRows()) {
    for (const viewer of FAST_VIEWERS) {
      const c = countingDb();
      healthRowReadable(c.database, row, viewer);
      const expected = row.visibility !== 'family' && row.user_id !== viewer ? 1 : 0;
      assert.equal(c.calls, expected, `row ${row.id} viewer ${viewer}`);
    }
  }
});

test('readableRows: one owner\'s list as readableClause cuts it, whole for the owner and a caregiver', () => {
  const readableRows = api('readableRows');
  const readableClause = api('readableClause');
  for (const ownerId of FAST_VIEWERS) {
    const rows = fastRows().filter((row) => row.user_id === ownerId);
    for (const viewer of FAST_VIEWERS) {
      const clause = readableClause('', viewer);
      const sql = db.prepare(`SELECT id FROM health_fasts WHERE user_id = ? AND ${clause.sql} ORDER BY id`)
        .all(ownerId, ...clause.params).map((/** @type {any} */ r) => r.id);
      const c = countingDb();
      const js = readableRows(c.database, rows, viewer, ownerId).map((/** @type {any} */ row) => row.id);
      assert.deepEqual(js, sql, `owner ${ownerId} viewer ${viewer}`);
      assert.equal(c.calls, viewer === ownerId ? 0 : 1, 'one grant read for the whole list');
    }
  }
  // Derived items carry no user_id; the owner is the parameter.
  const items = [{ visibility: 'private' }, { visibility: 'family' }, { visibility: null }];
  assert.equal(readableRows(db, items, caregiver, owner), items, 'cared for: the list itself');
  assert.deepEqual(readableRows(db, items, stranger, owner), [{ visibility: 'family' }]);
  assert.deepEqual(readableRows(db, items, stranger, Number.NaN), [{ visibility: 'family' }], 'no owner');
});

// ── 5. The grant table itself (B9): list, caregivers of one person, replace ──────
// PRAGMA reverse_unordered_selects reverses every result without ORDER BY: the
// primary key's covering index would otherwise hand back the sorted order by luck.

test('allCareGrants and caregiversOf: sorted by promise, not by the planner', () => {
  const allCareGrants = api('allCareGrants');
  const caregiversOf = api('caregiversOf');
  const [a, b, c] = [seedUser(), seedUser(), seedUser()];
  const grant = db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)');
  grant.run(b, c); grant.run(b, a); grant.run(a, c);
  db.pragma('reverse_unordered_selects = ON');
  try {
    const rows = allCareGrants(db).filter((/** @type {any} */ r) => [a, b].includes(r.subject_id));
    assert.deepEqual(rows, [
      { subject_id: a, caregiver_id: c },
      { subject_id: b, caregiver_id: a },
      { subject_id: b, caregiver_id: c },
    ]);
    assert.deepEqual(allCareGrants(db)[0], { subject_id: owner, caregiver_id: caregiver }, 'the whole table, from the first subject');
    assert.deepEqual(caregiversOf(db, b), [a, c]);
  } finally {
    db.pragma('reverse_unordered_selects = OFF');
    db.prepare('DELETE FROM health_care_grants WHERE subject_id IN (?, ?)').run(a, b);
  }
});

test('replaceCaregivers: the stored list goes, the new one is written in order, in one transaction', () => {
  const replaceCaregivers = api('replaceCaregivers');
  const [subject, x, y, z] = [seedUser(), seedUser(), seedUser(), seedUser()];
  const rows = () => db.prepare('SELECT subject_id, caregiver_id FROM health_care_grants WHERE subject_id IN (?, ?) ORDER BY rowid')
    .all(subject, owner).map((/** @type {any} */ r) => [r.subject_id, r.caregiver_id]);
  try {
    replaceCaregivers(db, subject, [z, x]);
    assert.deepEqual(rows(), [[owner, caregiver], [subject, z], [subject, x]], 'other subjects stay');
    replaceCaregivers(db, subject, [y]);
    assert.deepEqual(rows(), [[owner, caregiver], [subject, y]]);
    // A failing insert (the person herself, CHECK) rolls the delete back too.
    assert.throws(() => replaceCaregivers(db, subject, [x, subject]), /CHECK/);
    assert.deepEqual(rows(), [[owner, caregiver], [subject, y]], 'nothing changed');
    replaceCaregivers(db, subject, []);
    assert.deepEqual(rows(), [[owner, caregiver]]);
  } finally {
    db.prepare('DELETE FROM health_care_grants WHERE subject_id = ?').run(subject);
  }
});
