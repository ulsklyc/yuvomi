/**
 * Module: test infrastructure - table ownership (phase 2, section A, decision E4)
 * Purpose: server/table-owners.ts names the one module that owns each table. This suite
 *          holds it complete against the schema the running server has: every table has
 *          exactly one line, no line names a table that does not exist, every owner is in
 *          OWNERS, OWNERS carries every permission module and no owner without a table.
 * Schema:  built by the production code, never parsed: server/db.js migrates an in-memory
 *          database on import, and importing server/auth.js creates `sessions` the way the
 *          server does at start (BetterSQLiteStore). A CREATE TABLE outside the migrations
 *          that this suite does not execute would leave its table out, so one block finds
 *          every `CREATE ... TABLE` under server/ (also with the keywords split by quotes or
 *          `+`), sets off the statements of the MIGRATIONS entries in server/db.js against
 *          the imported array, and demands of each other one a table name in plain text
 *          that is in the schema built here; a name it cannot read (interpolated, quoted,
 *          bracketed, concatenated) is red with file and line. A temp-schema table such as
 *          temp.search_vocab holds no data and is skipped. Blind spot: SQL assembled
 *          without the words CREATE and TABLE in the source (both from variables). Not measured: which file reads a foreign table (SQL lives in template
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
const { PERMISSION_MODULES } = await import('../server/authorize/index.ts');
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

/** Every `CREATE [TEMP] [VIRTUAL] TABLE`, also with the keywords split by quotes or `+`. */
const CREATE_TABLE = /\bCREATE\b(?:[\s"'`+]|TEMP(?:ORARY)?\b|VIRTUAL\b)*\bTABLE\b/gi;
const IF_NOT_EXISTS = /^\s+IF\s+NOT\s+EXISTS(?=\s)/i;
/** A plain name, ended by whitespace or `(`: not `${`, a quote, `[` or a concatenation. */
const PLAIN_NAME = /^\s+((?:temp\.)?[A-Za-z_]\w*)(?=[\s(])/i;

/**
 * Every CREATE TABLE statement in `text`, with the table name it creates or null when the
 * name cannot be read as plain text.
 * @param {string} text
 * @returns {{ index: number, name: string | null, temp: boolean, snippet: string }[]}
 */
function createStatements(text) {
  const out = [];
  for (const m of text.matchAll(CREATE_TABLE)) {
    const index = /** @type {number} */ (m.index);
    let rest = text.slice(index + m[0].length, index + m[0].length + 200);
    const ifNotExists = IF_NOT_EXISTS.exec(rest);
    if (ifNotExists) rest = rest.slice(ifNotExists[0].length);
    const plain = /["'`+]/.test(m[0]) ? null : PLAIN_NAME.exec(rest);
    const name = plain && !/^(IF|NOT|EXISTS|AS)$/i.test(plain[1]) ? plain[1] : null;
    const temp = /\bTEMP/i.test(m[0]) || /^temp\./i.test(name ?? '');
    out.push({ index, name, temp, snippet: text.slice(index, index + 80).split('\n')[0] });
  }
  return out;
}

test('the statement reader names a plain table and refuses every form it cannot read', () => {
  const names = (/** @type {string} */ text) => createStatements(text).map((c) => c.name);
  assert.deepEqual(names('CREATE TABLE a (x); CREATE TABLE IF NOT EXISTS b(x); CREATE VIRTUAL TABLE c USING fts5(x)'), ['a', 'b', 'c']);
  assert.deepEqual(names('CREATE TEMP TABLE t (x); CREATE VIRTUAL TABLE IF NOT EXISTS temp.v USING fts5vocab(a)'), ['t', 'temp.v']);
  for (const unreadable of [
    'CREATE TABLE ${n}_probe (x)',
    'CREATE TABLE IF NOT EXISTS ${n} (x)',
    'CREATE TABLE IF NOT EXISTS "quoted" (x)',
    'CREATE TABLE [probe_bracket] (x)',
    'CREATE TABLE x_${n} (x)',
    '"CREATE TABLE " + "probe_concat (x)"',
    '"CREATE " + "TABLE probe_split (x)"',
  ]) assert.deepEqual(names(unreadable), [null], unreadable);
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
  // server/db-schema-test.js is the test mirror of the migrations: no server code runs it,
  // its tables are the migrated ones under a second spelling.
  const scanned = files.filter((f) => f !== 'server/db-schema-test.js');
  // Inside server/db.js the statements of the MIGRATIONS entries are the migrated schema
  // (a migration may create a table a later one drops). They are taken from the imported
  // array, as text of each `up` string and of each `up`/`afterUp` function, and one
  // statement in db.js is set off against one equal statement there. Everything else in
  // db.js - migrate()'s schema_migrations, any later helper - follows the rule for all files.
  /** @type {Map<string, number>} */
  const migrated = new Map();
  for (const m of db.MIGRATIONS) {
    for (const part of [m.up, m.afterUp]) {
      if (part == null) continue;
      for (const c of createStatements(String(part))) migrated.set(c.snippet, (migrated.get(c.snippet) ?? 0) + 1);
    }
  }
  assert.ok(migrated.size >= 100, `only ${migrated.size} CREATE TABLE statements in the migrations - the reader does not see them`);
  const tables = new Set(schemaTables());
  const problems = [];
  let seen = 0;
  for (const file of scanned) {
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const c of createStatements(text)) {
      seen += 1;
      if (file === 'server/db.js' && (migrated.get(c.snippet) ?? 0) > 0) {
        migrated.set(c.snippet, /** @type {number} */ (migrated.get(c.snippet)) - 1);
        continue;
      }
      const where = `${file}:${text.slice(0, c.index).split('\n').length}`;
      if (c.name === null) {
        problems.push(`${where}: the table name cannot be read (\`${c.snippet}\`) - write it as plain text, `
          + 'or execute this code at the top of this suite and read the schema it builds');
      } else if (!c.temp && !tables.has(c.name)) {
        problems.push(`${where}: ${c.name} is created at runtime but is not in the schema this suite builds - import `
          + 'the code that creates it at the top of this suite, then give the table its line in server/table-owners.ts');
      }
    }
  }
  assert.ok(seen >= 200, `only ${seen} CREATE TABLE statements under server/ - the search does not reach them`);
  assert.deepEqual(problems, [], `CREATE TABLE outside the migrations (${problems.length}):\n  ${problems.join('\n  ')}`);
});

test('the manifest lists its tables sorted by name', () => {
  const keys = Object.keys(TABLE_OWNERS);
  assert.deepEqual(keys, [...keys].sort(), 'server/table-owners.ts: keep the table lines sorted by name');
});
