/**
 * Test: Laufnummern der Einkaufslisten (Migration v194, GET /shopping/versions)
 * Zweck: Die Zusage "ein offener Zettel sieht, was ein anderer aendert" haengt
 *        an drei Stuecken, und die laufen hier durch den ECHTEN Server
 *        (server/index.js ueber test/server-ready.js): Session-Auth, das
 *        Modul-Gate fuer Mitglieder, die Token-Scopes, CSRF - nichts davon
 *        sieht ein Router auf einer nackten Express-App.
 *        1. Zugang: 401 ohne Sitzung, 403 fuer ein Mitglied ohne Einkaufs-
 *           Zugriff, 403 fuer ein Token ohne shopping:read.
 *        2. Der Zaehler: jede Liste hat von Anfang an eine Zeile (die erste
 *           Aenderung darf nicht als Ausgangsstand verloren gehen), jeder
 *           Schreibweg bewegt sie - auch einer an der Route vorbei -, ein
 *           Artikel, der die Liste wechselt, bewegt BEIDE Listen, Umbenennen
 *           bewegt, Loeschen nimmt die Zeile mit.
 *        3. Die Quittung: die Artikel-Routen antworten mit
 *           `list_change: { list_id, before, after }`.
 *        Dazu der Backfill der Migration gegen eine Vor-v194-Datenbank.
 * Ausfuehren: node --experimental-sqlite --test test/test-shopping-versions.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'shopping-versions',
  env: { SESSION_SECRET: 'test-shopping-versions-secret-minimum-32' },
});
const { default: dbmod } = await import('../server/db.js').then((m) => ({ default: m }));
const { MIGRATIONS } = dbmod;
const db = dbmod.get();

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

const admin = await login('admin', 'adminpass123');

function as(session) {
  const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
  return async (method, path, body) => {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const call = as(admin);

const versionOf = (listId) => db.prepare('SELECT version FROM shopping_list_changes WHERE list_id = ?').get(listId)?.version ?? null;
async function newList(name) {
  const r = await call('POST', '/shopping', { name });
  assert.equal(r.status, 201);
  return r.body.data.id;
}
async function addItem(listId, name = 'Milch') {
  const r = await call('POST', `/shopping/${listId}/items`, { name });
  assert.equal(r.status, 201);
  return r.body;
}

// Ein Mitglied ohne Einkaufs-Zugriff und ein Token ohne shopping:read.
const created = await call('POST', '/auth/users', { username: 'gast', display_name: 'Gast', password: 'gastpass123' });
assert.equal(created.status, 201);
const gastId = created.body.user.id;
const gate = await call('PUT', `/permissions/user/${gastId}`, { modules: { shopping: 'none' } });
assert.equal(gate.status, 200, 'Modul-Zugriff des Mitglieds auf none');
const gast = await login('gast', 'gastpass123');

const NOTES_TOKEN = 'yuvomi_test_notes_only_token';
db.prepare(`
  INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes)
  VALUES ('notes-only', ?, 'yuvomi_test', 1, ?)
`).run(crypto.createHash('sha256').update(NOTES_TOKEN).digest('hex'), JSON.stringify(['notes:read']));

// --------------------------------------------------------------------------
// 1. Zugang
// --------------------------------------------------------------------------
test('GET /shopping/versions: ohne Sitzung 401', async () => {
  const res = await fetch(`${BASE}/api/v1/shopping/versions`);
  assert.equal(res.status, 401);
});

test('GET /shopping/versions: ein Mitglied ohne Einkaufs-Zugriff bekommt 403', async () => {
  const r = await as(gast)('GET', '/shopping/versions');
  assert.equal(r.status, 403);
});

test('GET /shopping/versions: ein Token ohne shopping:read bekommt 403', async () => {
  const res = await fetch(`${BASE}/api/v1/shopping/versions`, { headers: { Authorization: `Bearer ${NOTES_TOKEN}` } });
  assert.equal(res.status, 403);
});

test('GET /shopping/versions: mit Sitzung die Laufnummern aller Listen', async () => {
  const list = await newList('Zugang');
  const r = await call('GET', '/shopping/versions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.deepEqual(r.body.data.find((row) => row.list_id === list), { list_id: list, version: 0 });
});

// --------------------------------------------------------------------------
// 2. Der Zaehler
// --------------------------------------------------------------------------
test('eine neue Liste hat sofort eine Zeile mit 0 - ihre erste Aenderung geht nicht als Ausgangsstand verloren', async () => {
  const list = await newList('Erste');
  assert.equal(versionOf(list), 0, 'die Zeile entsteht mit der Liste');
  await addItem(list);
  assert.ok(versionOf(list) >= 1, 'die ERSTE Aenderung bewegt die Nummer von 0 weg');
});

test('Einfuegen, Aendern und Loeschen eines Artikels bewegen die Laufnummer der Liste', async () => {
  const list = await newList('Trigger');
  const { data: item } = await addItem(list);
  const afterInsert = versionOf(list);
  assert.ok(afterInsert >= 1);

  await call('PATCH', `/shopping/items/${item.id}`, { is_checked: true });
  const afterUpdate = versionOf(list);
  assert.ok(afterUpdate > afterInsert, 'UPDATE (abhaken) bewegt die Nummer');

  await call('DELETE', `/shopping/items/${item.id}`);
  assert.ok(versionOf(list) > afterUpdate, 'DELETE bewegt die Nummer');
});

test('ein Schreibweg an der Route vorbei zaehlt genauso (der Grund fuer den Trigger)', async () => {
  const list = await newList('Direkt');
  const { data: item } = await addItem(list);
  const before = versionOf(list);
  // So schreiben Essensplan-Import, CalDAV-Sync und MCP: direkt in die Tabelle.
  db.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(item.id);
  assert.ok(versionOf(list) > before);
});

test('ein Artikel, der die Liste wechselt, bewegt BEIDE Listen - auch die, die er verlaesst', async () => {
  const from = await newList('Von');
  const to = await newList('Nach');
  const { data: item } = await addItem(from);
  const fromBefore = versionOf(from);
  const toBefore = versionOf(to);
  // So schreibt caldav-reminders-sync.js, wenn die Zielliste einer Auswahl wechselt.
  db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(to, item.id);
  assert.ok(versionOf(from) > fromBefore, 'die verlassene Liste erfaehrt es');
  assert.ok(versionOf(to) > toBefore, 'die neue Liste erfaehrt es');
});

test('Umbenennen einer Liste bewegt ihre Nummer; Loeschen nimmt die Zeile mit', async () => {
  const list = await newList('Alt');
  const before = versionOf(list);
  await call('PUT', `/shopping/${list}`, { name: 'Neu' });
  assert.ok(versionOf(list) > before, 'die anderen Geraete sollen den neuen Namen sehen');

  await addItem(list);
  const r = await call('DELETE', `/shopping/${list}`);
  assert.equal(r.status, 200);
  assert.equal(versionOf(list), null, 'die Kaskade der Artikel darf die Zeile nicht wiederbeleben');
  const versions = await call('GET', '/shopping/versions');
  assert.ok(!versions.body.data.some((row) => row.list_id === list), 'die fehlende Zeile ist die Nachricht, dass die Liste weg ist');
});

test('Artikel zweier Listen zaehlen getrennt', async () => {
  const a = await newList('A');
  const b = await newList('B');
  await addItem(a);
  const va = versionOf(a);
  await addItem(b);
  assert.equal(versionOf(a), va);
});

// --------------------------------------------------------------------------
// 3. Die Quittung
// --------------------------------------------------------------------------
test('die Artikel-Routen antworten mit list_change: { list_id, before, after }', async () => {
  const list = await newList('Quittung');

  const added = await addItem(list, 'Brot');
  assert.deepEqual(added.list_change, { list_id: list, before: 0, after: versionOf(list) });
  assert.ok(added.list_change.after > added.list_change.before);

  const patched = await call('PATCH', `/shopping/items/${added.data.id}`, { is_checked: true });
  assert.equal(patched.body.list_change.list_id, list);
  assert.equal(patched.body.list_change.before, added.list_change.after, 'before ist der Stand vor DIESEM Schreibvorgang');
  assert.equal(patched.body.list_change.after, versionOf(list));

  const reordered = await call('PATCH', `/shopping/${list}/items/reorder`, { category: added.data.category, order: [added.data.id] });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.body.list_change.before, patched.body.list_change.after);

  const cleared = await call('DELETE', `/shopping/${list}/items/checked`);
  assert.equal(cleared.body.deleted, 1);
  assert.equal(cleared.body.list_change.before, reordered.body.list_change.after);
  assert.equal(cleared.body.list_change.after, versionOf(list));

  const again = await addItem(list, 'Eier');
  const removed = await call('DELETE', `/shopping/items/${again.data.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.list_change, { list_id: list, before: again.list_change.after, after: versionOf(list) });
});

test('DELETE /shopping/items/:id: unbekannter Artikel bleibt 404', async () => {
  const r = await call('DELETE', '/shopping/items/999999');
  assert.equal(r.status, 404);
});

// --------------------------------------------------------------------------
// 4. Der Backfill der Migration
// --------------------------------------------------------------------------
test('v194: bestehende Listen bekommen beim Update ihre Zeile mit 0', () => {
  const V = MIGRATIONS.find((m) => m.version === 194);
  assert.ok(V, 'Migration v194 vorhanden');
  const old = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-versions-')), 'db.sqlite'));
  old.exec(`
    CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE shopping_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    INSERT INTO shopping_lists (name) VALUES ('Supermarkt'), ('Baumarkt');
    INSERT INTO shopping_items (list_id, name) VALUES (1, 'Milch');
  `);
  old.exec(V.up);
  const rows = old.prepare('SELECT list_id, version FROM shopping_list_changes ORDER BY list_id').all();
  assert.deepEqual(rows, [{ list_id: 1, version: 0 }, { list_id: 2, version: 0 }],
    'jede Bestandsliste hat eine Zeile - sonst ginge ihre erste Aenderung als Ausgangsstand verloren');
  old.prepare('UPDATE shopping_items SET name = ? WHERE id = 1').run('Hafermilch');
  assert.ok(old.prepare('SELECT version FROM shopping_list_changes WHERE list_id = 1').get().version >= 1);
  old.close();
});
