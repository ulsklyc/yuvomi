/**
 * Modul: Aufgaben - Handordnung innerhalb einer Kategorie (PATCH /tasks/reorder)
 * Zweck: End-to-End ueber den echten Router gegen eine migrierte Datenbank.
 *        Die Route TEILT DIE RAENGE UM: die Raenge, die die genannten Aufgaben
 *        schon tragen, werden in der Reihenfolge der Anfrage neu ausgeteilt
 *        (jeder nur einmal), Rangloses bekommt neue hinter dem groessten. Sie
 *        weist ab, was nicht umsortiert werden darf: leere oder doppelte
 *        Listen, Unteraufgaben, unsichtbare und unbekannte Aufgaben.
 * Ausfuehren: npm run test:tasks-reorder
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-reorder-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

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
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ALICE = seedUser('alice', 'admin');
const BOB = seedUser('bob', 'member');
const alice = { id: ALICE, role: 'admin' };
const bob = { id: BOB, role: 'member' };

let actor = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeTask(title, extra = {}) {
  const r = await call('POST', '/', { as: alice, body: { title, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

const rankOf = (id) => db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(id).sort_order;

test('Migration 238: tasks.sort_order ist nullbar, neue Aufgaben haben keinen Rang', async () => {
  const col = db.prepare('PRAGMA table_info(tasks)').all().find((c) => c.name === 'sort_order');
  assert.ok(col, 'die Spalte existiert');
  assert.equal(col.notnull, 0, 'NULL = nie von Hand eingeordnet');
  const id = await makeTask('ohne Rang');
  assert.equal(rankOf(id), null);
});

/** Die Aufgaben in der Reihenfolge ihrer Raenge (aufsteigend). */
const byRank = (ids) => [...ids].sort((a, b) => rankOf(a) - rankOf(b));

test('PATCH /reorder: Aufgaben ohne Rang bekommen Raenge in Anfragereihenfolge', async () => {
  const a = await makeTask('A');
  const b = await makeTask('B');
  const c = await makeTask('C');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [c, a, b] } });
  assert.equal(r.status, 200);
  assert.deepEqual(byRank([a, b, c]), [c, a, b]);
  assert.deepEqual(r.body.data.map((x) => x.id), [c, a, b]);
  const ranks = r.body.data.map((x) => x.sort_order);
  assert.equal(new Set(ranks).size, 3, 'drei verschiedene Raenge');
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), 'aufsteigend in Anfragereihenfolge');
});

test('PATCH /reorder: ein zweiter Aufruf verteilt dieselben Raenge neu, statt neue zu vergeben', async () => {
  const a = await makeTask('A2');
  const b = await makeTask('B2');
  await call('PATCH', '/reorder', { as: alice, body: { order: [a, b] } });
  const before = [rankOf(a), rankOf(b)].sort((x, y) => x - y);
  await call('PATCH', '/reorder', { as: alice, body: { order: [b, a] } });
  assert.deepEqual(byRank([a, b]), [b, a]);
  assert.deepEqual([rankOf(a), rankOf(b)].sort((x, y) => x - y), before, 'die Menge der Raenge bleibt');
});

test('PATCH /reorder: GET liefert den Rang mit', async () => {
  const a = await makeTask('GET-A');
  const b = await makeTask('GET-B');
  await call('PATCH', '/reorder', { as: alice, body: { order: [b, a] } });
  const list = await call('GET', '/', { as: alice });
  const rows = new Map(list.body.data.map((t) => [t.id, t]));
  assert.ok(rows.get(b).sort_order < rows.get(a).sort_order);
});

test('PATCH /reorder: eine Teilmenge laesst Ausgelassene stehen und kollidiert mit nichts (Review an #1646)', async () => {
  // Alice ordnet B, C, A (privat), D. Bob sieht A nicht und sendet D, B, C.
  const priv = await makeTask('A-privat', { visibility: 'private' });
  const [b, c, d] = [await makeTask('S-B'), await makeTask('S-C'), await makeTask('S-D')];
  await call('PATCH', '/reorder', { as: alice, body: { order: [b, c, priv, d] } });
  const privRank = rankOf(priv);

  const r = await call('PATCH', '/reorder', { as: bob, body: { order: [d, b, c] } });
  assert.equal(r.status, 200);
  assert.equal(rankOf(priv), privRank, 'die fuer Bob unsichtbare Aufgabe behaelt ihren Rang');
  assert.deepEqual(byRank([d, b, c]), [d, b, c], 'die genannten stehen in Bobs Reihenfolge');
  const all = [b, c, d, priv].map(rankOf);
  assert.equal(new Set(all).size, all.length, 'kein Rang kommt zweimal vor');
  // Bobs Zug belaesst A zwischen den Aufgaben, zwischen denen es stand: B und C
  // standen vor A, D dahinter, und die drei Raenge wurden nur neu ausgeteilt.
  assert.ok(rankOf(d) < rankOf(b) && rankOf(b) < rankOf(c));
});

test('PATCH /reorder: derselbe Rang zweimal im Pool wird nur einmal ausgeteilt (Review an #1646)', async () => {
  // X=10, R=11 (taeglich), Y=12. R wird erledigt, die Folgeinstanz F erbt Rang 11.
  // Mit angezeigten erledigten Aufgaben sendet der Client X, F, Y, R.
  const x = await makeTask('P-X');
  const rec = await makeTask('P-R', { is_recurring: true, recurrence_rule: 'FREQ=DAILY', due_date: '2031-05-06' });
  const y = await makeTask('P-Y');
  const setRank = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  setRank.run(10, x); setRank.run(11, rec); setRank.run(12, y);
  await call('PATCH', `/${rec}/status`, { as: alice, body: { status: 'done' } });
  const followup = db.prepare('SELECT id, sort_order FROM tasks WHERE recurrence_origin_id = ?').get(rec);
  assert.equal(followup.sort_order, 11, 'Ausgangslage: Original und Folgeinstanz tragen denselben Rang');

  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [x, followup.id, y, rec] } });
  assert.equal(r.status, 200);
  const ranks = [x, followup.id, y, rec].map(rankOf);
  assert.equal(new Set(ranks).size, 4, `kein Rang kommt zweimal vor: ${ranks.join(', ')}`);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'und sie stehen in Anfragereihenfolge');
  assert.deepEqual(r.body.data.map((e) => e.sort_order), ranks, 'die Antwort traegt die echten Raenge');
});

test('PATCH /reorder: gemischt aus Eingeordneten und Neuen: Neue stehen hinter dem hoechsten Rang', async () => {
  const placed = await makeTask('G-eingeordnet');
  await call('PATCH', '/reorder', { as: alice, body: { order: [placed] } });
  const fresh = await makeTask('G-neu');
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get().m;
  await call('PATCH', '/reorder', { as: alice, body: { order: [fresh, placed] } });
  assert.deepEqual(byRank([placed, fresh]), [fresh, placed]);
  assert.ok(rankOf(fresh) <= max + 1, 'die neue Aufgabe nimmt einen freien Rang');
});

test('PATCH /reorder: Folgeinstanz einer Wiederholung erbt den Rang (Review an #1646)', async () => {
  const rec = await makeTask('taeglich', { is_recurring: true, recurrence_rule: 'FREQ=DAILY', due_date: '2031-05-06' });
  const other = await makeTask('daneben');
  await call('PATCH', '/reorder', { as: alice, body: { order: [rec, other] } });
  const rank = rankOf(rec);
  assert.ok(rank !== null);

  const done = await call('PATCH', `/${rec}/status`, { as: alice, body: { status: 'done' } });
  assert.equal(done.status, 200);
  const followup = db.prepare('SELECT id, sort_order FROM tasks WHERE recurrence_origin_id = ?').get(rec);
  assert.ok(followup, 'die Folgeinstanz existiert');
  assert.equal(followup.sort_order, rank, 'sie nimmt den Platz der Vorgaengerin ein');
});

test('PUT /:id: ein Kategoriewechsel setzt den Rang zurueck, ein anderer Wechsel nicht (Review an #1646)', async () => {
  const cats = (await call('GET', '/categories', { as: alice })).body.data.map((c) => c.key);
  assert.ok(cats.length >= 2);
  const id = await makeTask('wandert', { category: cats[0] });
  await call('PATCH', '/reorder', { as: alice, body: { order: [id] } });
  assert.ok(rankOf(id) !== null);

  const sameCat = await call('PUT', `/${id}`, { as: alice, body: { title: 'wandert 2', category: cats[0] } });
  assert.equal(sameCat.status, 200, JSON.stringify(sameCat.body));
  assert.ok(rankOf(id) !== null, 'ohne Kategoriewechsel bleibt der Rang');

  const moved = await call('PUT', `/${id}`, { as: alice, body: { title: 'wandert 2', category: cats[1] } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(rankOf(id), null, 'in der neuen Kategorie ist die Aufgabe nicht eingeordnet');
});

test('PATCH /reorder: leere, fehlende und nicht-ganzzahlige Listen -> 400', async () => {
  const a = await makeTask('typ-A');
  // `Number(true)` ist 1, `Number("12")` ist 12, `[[12]]` wird zu 12: alles das
  // hatte stumm eine fremde Aufgabe umgestellt.
  for (const order of [undefined, [], 'x', [1, 'abc'], [1.5], [true], [[a]], [String(a)], [null]]) {
    const r = await call('PATCH', '/reorder', { as: alice, body: { order } });
    assert.equal(r.status, 400, `order=${JSON.stringify(order)}`);
  }
  assert.equal(rankOf(a), null, 'nichts davon hat eine Aufgabe angefasst');
});

test('PATCH /reorder: ohne JSON-Body -> 400 statt 500', async () => {
  actor = alice;
  const res = await fetch(`${base}/reorder`, { method: 'PATCH' });
  assert.equal(res.status, 400);
});

test('PATCH /reorder: mehr als 500 IDs -> 400', async () => {
  const order = Array.from({ length: 501 }, (_, i) => i + 1);
  const r = await call('PATCH', '/reorder', { as: alice, body: { order } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /500/);
});

test('PATCH /reorder: doppelte ID -> 400, nichts geaendert', async () => {
  const a = await makeTask('D-A');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [a, a] } });
  assert.equal(r.status, 400);
  assert.equal(rankOf(a), null);
});

test('PATCH /reorder: unbekannte ID -> 404, nichts geaendert', async () => {
  const a = await makeTask('U-A');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [a, 999999] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(a), null, 'die Anfrage ist atomar: auch die gueltige ID bleibt unberuehrt');
});

test('PATCH /reorder: Unteraufgaben lassen sich nicht einordnen -> 404', async () => {
  const parent = await makeTask('Eltern');
  const sub = (await call('POST', '/', { as: alice, body: { title: 'Kind', parent_task_id: parent } })).body.data.id;
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [parent, sub] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(sub), null);
});

test('PATCH /reorder: eine fuer die Person unsichtbare Aufgabe -> 404', async () => {
  const privat = await makeTask('nur Alice', { visibility: 'private' });
  const offen = await makeTask('fuer alle', { visibility: 'all' });
  const r = await call('PATCH', '/reorder', { as: bob, body: { order: [offen, privat] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(privat), null, 'die private Aufgabe wurde nicht umnummeriert');
  assert.equal(rankOf(offen), null);
  const ok = await call('PATCH', '/reorder', { as: bob, body: { order: [offen] } });
  assert.equal(ok.status, 200);
});

test('PATCH /reorder: wird nicht als /:id gelesen (Routenreihenfolge)', async () => {
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [] } });
  assert.equal(r.status, 400, 'die Reorder-Route antwortet, nicht /:id/status oder ein 404');
  assert.match(r.body.error, /task IDs/);
});

// --------------------------------------------------------
// POST /reorder/reset - zurueck zur automatischen Reihenfolge
// --------------------------------------------------------
test('POST /reorder/reset: loescht die Raenge der genannten Aufgaben, nur dieser', async () => {
  const a = await makeTask('R-A');
  const b = await makeTask('R-B');
  const c = await makeTask('R-C');
  await call('PATCH', '/reorder', { as: alice, body: { order: [a, b, c] } });
  const cRank = rankOf(c);

  const r = await call('POST', '/reorder/reset', { as: alice, body: { ids: [a, b] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [{ id: a, sort_order: null }, { id: b, sort_order: null }]);
  assert.equal(rankOf(a), null);
  assert.equal(rankOf(b), null);
  assert.equal(rankOf(c), cRank, 'nicht genannte Aufgaben behalten ihren Rang');
});

test('POST /reorder/reset: gleiche Abweisungen wie PATCH /reorder', async () => {
  const priv = await makeTask('R-privat', { visibility: 'private' });
  await call('PATCH', '/reorder', { as: alice, body: { order: [priv] } });
  const rank = rankOf(priv);
  for (const [body, status] of [
    [{}, 400], [{ ids: [] }, 400], [{ ids: ['1'] }, 400], [{ ids: [1, 1] }, 400],
    [{ ids: Array.from({ length: 501 }, (_, i) => i + 1) }, 400],
    [{ ids: [priv] }, 404],
    [{ ids: [999999] }, 404],
  ]) {
    const r = await call('POST', '/reorder/reset', { as: bob, body });
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(rankOf(priv), rank, 'die fuer Bob unsichtbare Aufgabe wurde nicht angefasst');
});
