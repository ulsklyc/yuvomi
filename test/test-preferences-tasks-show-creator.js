/**
 * Test: Ersteller in der Aufgabenliste anzeigen (#2451)
 * Zweck: Deckt die Invarianten der Einstellung ab -
 *        - tasks_show_creator ist admin-only (ein Mitglied bekommt 403)
 *        - der Wert ist ein echter Boolean, keine '1'/'0'-Zeichenkette und
 *          nichts, was dahin gecastet wird ('true', 1, null -> 400)
 *        - GET liefert ohne Einstellung `false`, nicht undefined: die Seite
 *          liest ihn als Schalterstellung
 *        - false ist ein bewusst gesetzter Wert und bleibt false
 *        - ein abgewiesener PUT schreibt nichts
 *        - die Einstellung steht im Display-Scope (server/display-scopes.js),
 *          weil das Wandtablett die Liste genauso rendert
 *        Die Auswirkung auf die Liste selbst (created_by_* an den Endpunkten)
 *        hat ihre eigenen Tests in test/test-tasks-creator.js.
 * Ausführen: npm run test:preferences-tasks-show-creator
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'preferences-tasks-show-creator-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ADMIN  = seedUser('admin', 'admin');
const MEMBER = seedUser('member', 'member');

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/preferences', preferencesRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/api/v1`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const asAdmin  = { id: ADMIN,  role: 'admin' };
const asMember = { id: MEMBER, role: 'member' };

const setShowCreator = (value, as = asAdmin) =>
  call('PUT', '/preferences', { as, body: { tasks_show_creator: value } });

const readShowCreator = async () =>
  (await call('GET', '/preferences', { as: asAdmin })).body.data.tasks_show_creator;

test('GET /preferences: ohne Einstellung ist tasks_show_creator false, nicht undefined', async () => {
  const r = await call('GET', '/preferences', { as: asAdmin });
  assert.equal(r.status, 200);
  // Die Seite liest den Wert als Schalterstellung. `undefined` waere dort
  // "unbestimmt" und der Schalter spraenge beim ersten Speichern.
  assert.equal(r.body.data.tasks_show_creator, false);
});

test('PUT /preferences: der Admin schaltet ein, GET liefert es zurueck', async () => {
  const put = await setShowCreator(true);
  assert.equal(put.status, 200);
  assert.equal(put.body.data.tasks_show_creator, true);
  assert.equal(await readShowCreator(), true);
});

test('PUT /preferences: false ist ein gesetzter Wert und bleibt false', async () => {
  await setShowCreator(true);
  const put = await setShowCreator(false);
  assert.equal(put.status, 200);
  assert.equal(put.body.data.tasks_show_creator, false);
  assert.equal(await readShowCreator(), false, 'false bleibt false, es wird nicht als "nicht gesetzt" gelesen');
});

test('PUT /preferences: ein Mitglied bekommt 403 und schreibt nichts', async () => {
  await setShowCreator(true, asAdmin);
  const r = await setShowCreator(false, asMember);
  assert.equal(r.status, 403);
  assert.equal(await readShowCreator(), true, 'der abgewiesene PUT hat den Wert nicht angefasst');
});

// Kein Cast: die Route nimmt ausschliesslich einen echten Boolean. '1'/'0' sind
// das SPEICHERformat (cfgSet), nicht das der Schnittstelle, und `1`/`'true'`
// sind genau die Werte, die ein Client versehentlich schickt.
for (const invalid of ['1', '0', 'true', 'false', 1, 0, null, [], {}]) {
  test(`PUT /preferences: tasks_show_creator ${JSON.stringify(invalid)} -> 400`, async () => {
    await setShowCreator(true, asAdmin);
    const r = await setShowCreator(invalid, asAdmin);
    assert.equal(r.status, 400, `${JSON.stringify(invalid)} muss abgewiesen werden`);
    assert.match(r.body.error, /boolean/i);
    assert.equal(await readShowCreator(), true, 'der abgewiesene PUT hat den Wert nicht angefasst');
  });
}

test('die Einstellung steht im Display-Scope: das Wandtablett rendert dieselbe Liste', async () => {
  const { DISPLAY_PREFERENCE_KEYS } = await import('../server/display-scopes.js');
  const keys = DISPLAY_PREFERENCE_KEYS ?? [];
  assert.ok(keys.includes('tasks_show_creator'),
    'tasks_show_creator gehoert in server/display-scopes.js - sonst zeigt das Wandtablett '
    + 'die Aufgabenliste ohne Ersteller, obwohl der Haushalt ihn eingeschaltet hat');
});
