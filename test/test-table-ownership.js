/**
 * Module: test infrastructure - table ownership (phase 2, section A, decision E4)
 * Purpose: server/table-owners.ts names the one module that owns each table. This suite
 *          holds it complete against the schema the running server has: every table has
 *          exactly one line, no line names a table that does not exist, every owner is in
 *          OWNERS, OWNERS carries every permission module and no owner without a table.
 * Schema:  built by the production code, never parsed: server/db.js migrates an in-memory
 *          database on import, and importing server/auth.js creates `sessions` the way the
 *          server does at start (BetterSQLiteStore). A CREATE TABLE outside the migrations
 *          that this suite does not execute would leave its table out; the last block finds
 *          every such statement under server/ and demands that its table is in the schema
 *          built here (a temp-schema table such as temp.search_vocab holds no data and is
 *          skipped). Not measured: which file reads a foreign table (SQL lives in template
 *          strings, table names in variables; phase 2 sections B and D route reads through
 *          the owner's read function instead).
 * Run:     npm run test:table-ownership
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'table-ownership-test-secret-32chars';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const db = await import('../server/db.js');
// Creates `sessions` on import, as the server does at start.
await import('../server/auth.js');
const { PERMISSION_MODULES } = await import('../server/permissions.js');
const { OWNERS, TABLE_OWNERS } = await import('../server/table-owners.ts');

/** @returns {string[]} every table and view of the main schema, without sqlite_* */
function schemaTables() {
  return db.get()
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((/** @type {{ name: string }} */ r) => r.name);
}

/**
 * What is wrong with a manifest against a schema, one line per problem, each naming the
 * table and what to do.
 * @param {string[]} tables
 * @param {Record<string, string>} owners
 * @param {readonly string[]} vocabulary
 */
function ownershipProblems(tables, owners, vocabulary) {
  const problems = [];
  const known = new Set(tables);
  const allowed = new Set(vocabulary);
  for (const table of tables) {
    if (!Object.hasOwn(owners, table)) {
      problems.push(`${table}: table without an owner - add a line \`${table}: '<owner>',\` to server/table-owners.ts`);
    }
  }
  for (const [table, owner] of Object.entries(owners)) {
    if (!known.has(table)) {
      problems.push(`${table}: no such table in the migrated schema - remove its line from server/table-owners.ts`);
    } else if (!allowed.has(owner)) {
      problems.push(`${table}: owner '${owner}' is not in OWNERS - use one of ${[...allowed].join(', ')}`);
    }
  }
  return problems;
}

/* ---------- the check itself, on small cases ---------- */

test('the check names a table without a line, a line without a table and a foreign owner', () => {
  const vocabulary = ['tasks', 'core'];
  assert.deepEqual(ownershipProblems(['tasks', 'users'], { tasks: 'tasks', users: 'core' }, vocabulary), []);
  const [missing] = ownershipProblems(['tasks', 'users'], { tasks: 'tasks' }, vocabulary);
  assert.match(missing, /^users: table without an owner - add a line/);
  const [stale] = ownershipProblems(['tasks'], { tasks: 'tasks', gone: 'core' }, vocabulary);
  assert.match(stale, /^gone: no such table in the migrated schema - remove its line/);
  const [foreign] = ownershipProblems(['tasks'], { tasks: 'chores' }, vocabulary);
  assert.match(foreign, /^tasks: owner 'chores' is not in OWNERS - use one of tasks, core$/);
});

/* ---------- the manifest against the real schema ---------- */

test('every table of the schema has exactly one owner from OWNERS', () => {
  const tables = schemaTables();
  assert.ok(tables.length >= 150, `only ${tables.length} tables - the schema was not built`);
  assert.ok(tables.includes('sessions'), 'sessions is missing: the runtime-created tables were not built');
  const problems = ownershipProblems(tables, TABLE_OWNERS, OWNERS);
  assert.deepEqual(problems, [], `server/table-owners.ts does not match the schema (${problems.length}):\n  ${problems.join('\n  ')}`);
});

test('OWNERS carries every permission module, and every owner owns a table', () => {
  /** @type {Set<string>} */
  const owners = new Set(OWNERS);
  assert.equal(owners.size, OWNERS.length, 'OWNERS names an owner twice');
  for (const { key } of PERMISSION_MODULES) assert.ok(owners.has(key), `permission module ${key} is not in OWNERS`);
  /** @type {Set<string>} */
  const used = new Set(Object.values(TABLE_OWNERS));
  const idle = OWNERS.filter((/** @type {string} */ o) => !used.has(o));
  assert.deepEqual(idle, [], `owners without a table - drop them from OWNERS or give them their tables: ${idle.join(', ')}`);
});

test('every table created outside the migrations is in the schema built here', () => {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|ts)$/.test(entry.name)) files.push(relative(REPO, full).split(sep).join('/'));
    }
  };
  walk(join(REPO, 'server'));
  assert.ok(files.length >= 200, `only ${files.length} server files - the walk does not reach them`);
  // db.js holds the migrations (their tables are the migrated schema) and migrate(), which
  // runs on import; db-schema-test.js is the test mirror of the migrations.
  const outside = files.filter((f) => f !== 'server/db.js' && f !== 'server/db-schema-test.js');
  const tables = new Set(schemaTables());
  const created = [];
  const missing = [];
  const STATEMENT = /CREATE\s+(TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?((?:\w+\.)?\w+)/gi;
  for (const file of outside) {
    for (const m of readFileSync(join(REPO, file), 'utf8').matchAll(STATEMENT)) {
      const name = m[2];
      created.push(`${file} ${name}`);
      if (m[1] || /^temp\./i.test(name)) continue;
      if (!tables.has(name)) missing.push(`${name} (${file})`);
    }
  }
  assert.ok(created.includes('server/auth.js sessions'), `the search does not find the sessions table in server/auth.js: ${created.join(', ')}`);
  assert.deepEqual(missing, [], 'created at runtime, but not in the schema this suite builds - import the code that '
    + `creates it at the top of this suite, then give the table its line in server/table-owners.ts:\n  ${missing.join('\n  ')}`);
});
