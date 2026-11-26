/**
 * Test: sqlInList - a list of values as ONE SQLite parameter (Refs #2810, follow-up 5a)
 * Purpose: server/utils/sql-in-list.ts hands a list to SQLite as one JSON array that
 *          json_each unpacks. Measured on the production driver (better-sqlite3-multiple-ciphers):
 *          the same rows as one placeholder per value for INTEGER and TEXT columns, numeric
 *          text against an INTEGER column, and a number against a TEXT column (no match in
 *          either form), an empty list matches
 *          nothing (and NOT IN everything), duplicates and order do not matter, the list is
 *          not capped at SQLite's 32766 host parameters, the statement text is the same for
 *          every length, a named parameter works, an index on the column is used, and a value
 *          that is no SQL value is refused instead of being bound as something else.
 * Run:     npm run test:sql-in-list
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '../server/utils/sqlite-driver.js';
import { sqlInList } from '../server/utils/sql-in-list.ts';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, list_id INTEGER NOT NULL);
  CREATE INDEX idx_items_list ON items(list_id);
  CREATE INDEX idx_items_name ON items(name);
`);
const insert = db.prepare('INSERT INTO items (id, name, list_id) VALUES (?, ?, ?)');
db.transaction(() => {
  for (let i = 1; i <= 50000; i++) insert.run(i, `n${i}`, i % 100);
})();

/** @param {string} column @param {any[]} values */
const viaJson = (column, values) => {
  const list = sqlInList(values);
  return db.prepare(`SELECT id FROM items WHERE ${column} IN (${list.sql}) ORDER BY id`).all(list.param).map((/** @type {{ id: number }} */ r) => r.id);
};
/** The old way, one placeholder per value, as the reference. @param {string} column @param {any[]} values */
const viaMarks = (column, values) => db
  .prepare(`SELECT id FROM items WHERE ${column} IN (${values.map(() => '?').join(',') || 'NULL'}) ORDER BY id`)
  .all(...values).map((/** @type {{ id: number }} */ r) => r.id);

test('INTEGER column: numbers give the same rows as one placeholder per value', () => {
  const values = [3, 1, 99, 50001];
  assert.deepEqual(viaJson('id', values), [1, 3, 99]);
  assert.deepEqual(viaJson('id', values), viaMarks('id', values));
});

test('INTEGER column: numeric strings match through the column affinity, as with bound text', () => {
  assert.deepEqual(viaJson('id', ['3', '1']), [1, 3]);
  assert.deepEqual(viaJson('id', ['3', '1']), viaMarks('id', ['3', '1']));
});

test('TEXT column: strings match; a number finds its text form in neither form', () => {
  assert.deepEqual(viaJson('name', ['n2', 'n4', 'missing']), [2, 4]);
  assert.deepEqual(viaJson('name', ['n2', 'n4', 'missing']), viaMarks('name', ['n2', 'n4', 'missing']));
  db.prepare("INSERT INTO items (id, name, list_id) VALUES (60000, '42', 0)").run();
  try {
    // Measured, not assumed: the bound 42 in `name IN (?)` did not find the text '42'
    // either, so the change keeps the behaviour; a TEXT column takes strings in both forms.
    assert.deepEqual(viaMarks('name', [42]), []);
    assert.deepEqual(viaJson('name', [42]), []);
    assert.deepEqual(viaJson('name', ['42']), [60000]);
    assert.deepEqual(viaJson('name', ['42']), viaMarks('name', ['42']));
    // Numeric-looking text keeps its form: '0042' is not '42' (external ids are such text).
    db.prepare("UPDATE items SET name = '0042' WHERE id = 60000").run();
    assert.deepEqual(viaJson('name', ['0042']), [60000]);
    assert.deepEqual(viaJson('name', ['42']), []);
    assert.deepEqual(viaMarks('name', ['42']), []);
  } finally {
    db.prepare('DELETE FROM items WHERE id = 60000').run();
  }
});

test('an empty list matches nothing, NOT IN on it matches everything', () => {
  const list = sqlInList([]);
  assert.equal(list.param, '[]');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM items WHERE id IN (${list.sql})`).get(list.param).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM items WHERE id NOT IN (${list.sql})`).get(list.param).c, 50000);
});

test('duplicates and order do not change the result', () => {
  assert.deepEqual(viaJson('id', [5, 5, 2, 5, 2]), [2, 5]);
  assert.deepEqual(viaJson('id', [2, 5]), viaJson('id', [5, 2]));
});

test('null in the list matches nothing, as `IN (NULL)` does', () => {
  assert.deepEqual(viaJson('id', [null, 7]), [7]);
});

test('40 000 values in one statement: no "too many SQL variables", one parameter, the same text', () => {
  const values = Array.from({ length: 40000 }, (_v, i) => i + 1);
  assert.throws(() => viaMarks('id', values), /too many SQL variables/, 'the old form breaks at this length');
  assert.equal(viaJson('id', values).length, 40000);
  assert.equal(sqlInList(values).sql, sqlInList([1]).sql, 'the statement text does not depend on the length');
  const stmt = db.prepare(`SELECT COUNT(*) c FROM items WHERE id IN (${sqlInList([1]).sql})`);
  assert.equal(stmt.get(sqlInList(values).param).c, 40000, 'one prepared statement serves every length');
});

test('a named parameter binds by name next to other named parameters', () => {
  const list = sqlInList([1, 2, 3], 'ids');
  assert.equal(list.sql, 'SELECT value FROM json_each(@ids)');
  const rows = db.prepare(`SELECT id FROM items WHERE id IN (${list.sql}) AND list_id = @list ORDER BY id`).all({ ids: list.param, list: 2 });
  assert.deepEqual(rows.map((/** @type {{ id: number }} */ r) => r.id), [2]);
  assert.throws(() => sqlInList([1], 'a b'), TypeError);
  assert.throws(() => sqlInList([1], '1x'), TypeError);
});

test('the index on the column is used (EXPLAIN QUERY PLAN)', () => {
  const plan = (/** @type {string} */ sql, /** @type {string[]} */ ...params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    .map((/** @type {{ detail: string }} */ r) => r.detail).join(' | ');
  const list = sqlInList([1, 2]);
  const byKey = plan(`SELECT id FROM items WHERE id IN (${list.sql})`, list.param);
  assert.match(byKey, /SEARCH items USING INTEGER PRIMARY KEY \(rowid=\?\)/, byKey);
  const byIndex = plan(`SELECT id FROM items WHERE list_id IN (${list.sql})`, list.param);
  assert.match(byIndex, /SEARCH items USING (COVERING )?INDEX idx_items_list \(list_id=\?\)/, byIndex);
  const byText = plan(`SELECT id FROM items WHERE name IN (${list.sql})`, list.param);
  assert.match(byText, /SEARCH items USING (COVERING )?INDEX idx_items_name \(name=\?\)/, byText);
  assert.doesNotMatch(`${byKey} ${byIndex} ${byText}`, /SCAN items/);
});

test('bigint and strings with quotes survive the trip, anything else is refused', () => {
  assert.deepEqual(viaJson('id', [9n]), [9]);
  db.prepare(`INSERT INTO items (id, name, list_id) VALUES (60001, 'a "b" ''c''', 0)`).run();
  try {
    assert.deepEqual(viaJson('name', ['a "b" \'c\'']), [60001]);
  } finally {
    db.prepare('DELETE FROM items WHERE id = 60001').run();
  }
  for (const bad of [Number.NaN, Infinity, true, undefined, {}, [1]]) {
    assert.throws(() => sqlInList([/** @type {any} */ (bad)]), TypeError, String(bad));
  }
});
