process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../server/db.js');
const database = dbmod.get();
// By description, not a hardcoded version number: migrations are append-only,
// so this one's number shifts every time another feature merges ahead of it
// on main (161 -> 165 already happened once, during this PR's own rebase).
const migration = dbmod.MIGRATIONS.find((item) => item.description.startsWith('Schedule:'));

function disabledModules(conn) {
  const row = conn.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
  return row ? JSON.parse(row.value) : null;
}

function householdWith(value) {
  const conn = new DatabaseSync(':memory:');
  conn.exec(`
    CREATE TABLE sync_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  if (value !== undefined) conn.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)").run(value);
  return conn;
}

test('a new household has Schedule disabled by default', () => {
  assert.ok(disabledModules(database).includes('schedule'));
});

test('the Schedule opt-in migration preserves existing disabled modules', () => {
  const conn = householdWith(JSON.stringify(['notes', 'rewards']));
  migration.afterUp(conn);
  assert.deepEqual(disabledModules(conn).slice().sort(), ['notes', 'rewards', 'schedule']);
});

test('the Schedule opt-in migration creates a missing setting and is idempotent', () => {
  const conn = householdWith();
  migration.afterUp(conn);
  migration.afterUp(conn);
  assert.deepEqual(disabledModules(conn), ['schedule']);
});

test('invalid or non-array legacy settings are safely replaced', () => {
  for (const value of ['{broken', '"not an array"', '42', 'null']) {
    const conn = householdWith(value);
    migration.afterUp(conn);
    assert.deepEqual(disabledModules(conn), ['schedule']);
  }
});

test('the Schedule slug is accepted by module preferences', async () => {
  // The list lives in the settings registry since phase 2, C3: imported, and
  // the read side asked, instead of cutting the route's text.
  const { TOGGLEABLE_MODULES, parseDisabledModules } = await import('../server/settings/values.ts');
  assert.ok(TOGGLEABLE_MODULES.includes('schedule'));
  assert.deepEqual(parseDisabledModules(JSON.stringify(['schedule'])), ['schedule']);
});
