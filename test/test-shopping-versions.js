/**
 * Test: Laufnummern der Einkaufslisten (Migration v196, GET /shopping/versions)
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
 *           Artikel, der die Liste wechselt, bewegt BEIDE Listen, ein Tag
 *           bewegt die Liste seines Artikels (ohne die Kaskade doppelt zu
 *           zaehlen), Umbenennen bewegt, Loeschen nimmt die Zeile mit.
 *        3. Die Quittung: die Artikel-Routen antworten mit
 *           `list_change: { list_id, before, after }`.
 *        Dazu der Backfill der Migration gegen eine Vor-v196-Datenbank.
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

test('Buchhaltung bewegt die Nummer nicht: outbound_dirty, updated_at, ein unveraenderter Sync-Schreibvorgang', async () => {
  const list = await newList('Buchhaltung');
  const { data: item } = await addItem(list);
  const before = versionOf(list);
  // So merkt markTodoOutbound() den Artikel fuer den CalDAV-Push vor, und so
  // raeumt der Push den Merker nach dem Versand - zwei UPDATEs, die kein
  // Zettel sieht und keine Quittung deckt.
  db.prepare('UPDATE shopping_items SET outbound_dirty = 1, outbound_attempts = 0 WHERE id = ?').run(item.id);
  db.prepare('UPDATE shopping_items SET outbound_dirty = 0, outbound_attempts = 0 WHERE id = ?').run(item.id);
  assert.equal(versionOf(list), before, 'der Push-Merker ist keine Aenderung, die ein Zettel sieht');
  // So schreibt upsertShoppingItem() (caldav-reminders-sync.js) jede
  // gespiegelte Zeile bei jedem Lauf - meist unveraendert.
  db.prepare('UPDATE shopping_items SET name = name, is_checked = is_checked, list_id = list_id WHERE id = ?').run(item.id);
  assert.equal(versionOf(list), before, 'ein Schreibvorgang ohne Aenderung bewegt nichts');
  db.prepare('UPDATE shopping_items SET name = ? WHERE id = ?').run('Hafermilch', item.id);
  assert.equal(versionOf(list), before + 1,
    'genau ein Schritt: das zweite UPDATE von trg_shopping_items_updated_at zaehlt nicht mit');
});

test('der eigene Haken auf einer gespiegelten Liste kostet kein Nachladen: nichts, was der Push schreibt, liegt hinter der Quittung', async () => {
  // Ein Konto, das es gibt (isMirrored prueft das), auf einer Adresse, die
  // sofort ablehnt: der Sofortversuch des Push laeuft nach der Antwort und
  // scheitert hier, wie er soll.
  const account = db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Radicale', 'http://127.0.0.1:9/', 'u', 'p')
  `).run().lastInsertRowid;
  const list = await newList('Spiegel');
  const { data: item } = await addItem(list, 'Milch');
  db.prepare(`
    UPDATE shopping_items
    SET external_uid = 'uid-spiegel', external_source = 'caldav', external_account_id = ?,
        external_object_url = 'http://127.0.0.1:9/spiegel.ics'
    WHERE id = ?
  `).run(account, item.id);

  const patched = await call('PATCH', `/shopping/items/${item.id}`, { is_checked: true });
  assert.equal(patched.status, 200);
  assert.equal(db.prepare('SELECT outbound_dirty FROM shopping_items WHERE id = ?').get(item.id).outbound_dirty, 1,
    'der Push ist vorgemerkt - die Route hat markTodoOutbound() wirklich durchlaufen');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(versionOf(list), patched.body.list_change.after,
    'Vormerken und Versuch des Push bewegen die Nummer nicht - die Quittung deckt den Haken ganz');
});

test('GET /shopping/:listId/items traegt die Laufnummer, zu der die Artikel gehoeren', async () => {
  const list = await newList('Stand');
  await addItem(list);
  const r = await call('GET', `/shopping/${list}/items`);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, versionOf(list), 'derselbe Stand wie die Artikel - synchron gelesen');
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

test('ein Tag, der kommt oder geht, bewegt die Liste seines Artikels', async () => {
  const list = await newList('Tags');
  const { data: item } = await addItem(list);
  const before = versionOf(list);
  // So schreibt setItemTags() (utils/task-tags.js) fuer den CalDAV-To-do-Sync:
  // erst DELETE, dann INSERT je Tag - beides ohne Umweg ueber eine Route.
  db.prepare('INSERT INTO shopping_item_tags (item_id, tag, tag_key) VALUES (?, ?, ?)').run(item.id, 'Bio', 'bio');
  const afterInsert = versionOf(list);
  assert.ok(afterInsert > before, 'ein neuer Tag bewegt die Nummer');
  db.prepare('DELETE FROM shopping_item_tags WHERE item_id = ?').run(item.id);
  assert.ok(versionOf(list) > afterInsert, 'ein entfernter Tag bewegt die Nummer');
});

test('die Tag-Kaskade eines geloeschten Artikels zaehlt nicht doppelt', async () => {
  const list = await newList('Kaskade');
  const { data: item } = await addItem(list);
  db.prepare('INSERT INTO shopping_item_tags (item_id, tag, tag_key) VALUES (?, ?, ?)').run(item.id, 'Bio', 'bio');
  const before = versionOf(list);
  // Die Kaskade raeumt den Tag, aber der Artikel ist da schon weg: das SELECT
  // im Tag-Trigger findet keine list_id mehr, gezaehlt wird nur der Artikel.
  const r = await call('DELETE', `/shopping/items/${item.id}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shopping_item_tags WHERE item_id = ?').get(item.id).n, 0, 'der Tag ist mit dem Artikel gegangen');
  assert.equal(versionOf(list), before + 1, 'genau ein Schritt fuer das Loeschen');
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
test('DELETE /shopping/:listId/items/checked mit { ids } loescht nur die genannten - der Zettel nennt, was er entfernt hat', async () => {
  const list = await newList('Genannt');
  const a = (await addItem(list, 'A')).data;
  const b = (await addItem(list, 'B')).data;
  for (const item of [a, b]) await call('PATCH', `/shopping/items/${item.id}`, { is_checked: true });
  // B hat jemand anderes im Undo-Fenster abgehakt; der Zettel hat nur A entfernt.
  const r = await call('DELETE', `/shopping/${list}/items/checked`, { ids: [a.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 1);
  assert.deepEqual(db.prepare('SELECT name FROM shopping_items WHERE list_id = ?').all(list).map((row) => row.name), ['B'],
    'der fremde Haken bleibt - und kommt beim Zuruecknehmen nicht als Fremdkoerper zurueck');
  assert.equal(r.body.list_change.after, versionOf(list));
});

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
test('v196: bestehende Listen bekommen beim Update ihre Zeile mit 0', () => {
  const V = MIGRATIONS.find((m) => m.version === 196);
  assert.ok(V, 'Migration v196 vorhanden');
  const old = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-versions-')), 'db.sqlite'));
  old.exec(`
    CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE shopping_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      -- Die Spalten, die der Update-Trigger vergleicht; ohne sie schluege
      -- schon CREATE TRIGGER fehl.
      quantity TEXT, category TEXT NOT NULL DEFAULT 'Sonstiges', is_checked INTEGER NOT NULL DEFAULT 0,
      notes TEXT, url TEXT, sort_order INTEGER NOT NULL DEFAULT 0, price_cents INTEGER, store_id INTEGER
    );
    CREATE TABLE shopping_item_tags (
      item_id INTEGER NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
      tag TEXT NOT NULL, tag_key TEXT NOT NULL, PRIMARY KEY (item_id, tag_key)
    );
    INSERT INTO shopping_lists (name) VALUES ('Supermarkt'), ('Baumarkt');
    INSERT INTO shopping_items (list_id, name) VALUES (1, 'Milch');
  `);
  old.exec(V.up);
  const rows = old.prepare('SELECT list_id, version FROM shopping_list_changes ORDER BY list_id').all();
  assert.deepEqual(rows, [{ list_id: 1, version: 0 }, { list_id: 2, version: 0 }],
    'jede Bestandsliste hat eine Zeile - sonst ginge ihre erste Aenderung als Ausgangsstand verloren');
  old.prepare('UPDATE shopping_items SET name = ? WHERE id = 1').run('Hafermilch');
  assert.equal(old.prepare('SELECT version FROM shopping_list_changes WHERE list_id = 1').get().version, 1);
  old.close();
});
