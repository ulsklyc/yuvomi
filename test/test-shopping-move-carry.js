/**
 * Test: ein Einkaufsartikel nimmt sein Objekt auf dem CalDAV-Server MIT, wenn
 * er zwischen zwei gespiegelten Listen umzieht (#1700).
 *
 * Gemessen vor der Mitnahme, mit echtem tsdav gegen `test/caldav-fake-server.js`:
 * der Umzug loeschte das Objekt in der alten Liste und legte in der neuen ein
 * frisch gebautes an - neue UID, und Etiketten (CATEGORIES), Alarm (VALARM),
 * Beschreibung und jede Eigenschaft, die Yuvomi nicht kennt, waren fort. Lokal
 * verlor die Zeile ihre Etiketten im selben Zug.
 *
 * Die Regel: das ORIGINAL zieht um. Gelesen am alten Platz, unveraendert am
 * neuen abgelegt (nur was hier bearbeitet wurde, ist angepasst), und erst
 * danach am alten Platz entfernt. Bricht der Weg an irgendeiner Stelle ab,
 * liegt das Objekt an mindestens einem der beiden Plaetze, und ein spaeterer
 * Durchgang fuehrt ihn zu Ende.
 *
 * Jeder Fall laeuft ohne Client-Attrappe: echte Route, echte Dienste, echter
 * Client, echtes HTTP auf 127.0.0.1. Keine Uhr im Spiel ausser der Frist der
 * Upload-Notizen (24 Stunden), die kein Fall erreicht.
 *
 * Ausführen: npm run test:shopping-move-carry
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
delete process.env.LOG_LEVEL;
delete process.env.NODE_ENV;

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const todoOutbound  = await import('../server/services/caldav-todo-outbound.js');
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const { runSerialized } = await import('../server/utils/sync-lock.js');
const { loadItemTags } = await import('../server/utils/task-tags.js');
const { ownUid } = await import('../server/utils/own-uid.js');

const U = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = U;
  req.authRole = 'admin';
  req.session = { userId: U, role: 'admin' };
  next();
});
app.use('/', shoppingRouter);
const http = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => http.on('listening', () => r(`http://127.0.0.1:${http.address().port}`)));

const dav  = await startFakeDavServer();
const dav2 = await startFakeDavServer();
test.after(async () => { http.close(); await dav.close(); await dav2.close(); });

// ── Fixtures ────────────────────────────────────────────────────────────────────

const UID  = 'milk-1@other-app';
const FILE = 'milk-1.ics';

/** Ein VTODO, wie ihn eine andere App schreibt: mit allem, was Yuvomi nicht fuehrt. */
function original({ summary = 'Milch', uid = UID } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other App//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION', 'CATEGORIES:Bio,Kuehlregal', 'DESCRIPTION:fettarm',
    'X-APPLE-SORT-ORDER:740000000',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Erinnerung', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

function neighbour(slug) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other App//EN',
    'BEGIN:VTODO', `UID:neighbour-${slug}@test`, 'DTSTAMP:20260101T090000Z', 'SUMMARY:Nachbar',
    'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

let account1;
let account2;

function reset() {
  for (const table of [
    'caldav_upload_attempts', 'caldav_todo_pending_deletions', 'shopping_item_tags',
    'shopping_items', 'shopping_lists', 'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  dav.reset();
  dav2.reset();
  account1 = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Eins', ?, 'u', 'p')"
  ).run(dav.url).lastInsertRowid);
  account2 = null;
}

function secondAccount() {
  account2 = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zwei', ?, 'u', 'p')"
  ).run(dav2.url).lastInsertRowid);
  return account2;
}

/**
 * Eine gespiegelte Einkaufsliste mit EINEM fremden Artikel darin. Der Nachbar
 * ist nicht Dekoration: eine Liste, die gar nichts liefert, sieht fuer den
 * Leer-Guard wie ein gescheiterter Abruf aus.
 */
function mirroredList(slug, { server = dav, accountId = account1, enabled = true } = {}) {
  const url = server.addCollection(slug, { name: slug, components: ['VTODO'] });
  server.putObject(url, `neighbour-${slug}.ics`, neighbour(slug));
  const listId = Number(db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(slug, U).lastInsertRowid);
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, ?, 'shopping', ?, ?)
  `).run(accountId, url, slug, enabled ? 1 : 0, listId);
  return { url, listId };
}

function plainList(name) {
  return Number(db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, U).lastInsertRowid);
}

const rowsOf = (uid = UID) => db.prepare('SELECT * FROM shopping_items WHERE external_uid = ? ORDER BY id').all(uid);
const row    = (id) => db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);
const named  = (name) => db.prepare('SELECT * FROM shopping_items WHERE name = ? ORDER BY id').all(name);
const notes  = () => db.prepare('SELECT account_id, row_id, collection_url, uid FROM caldav_upload_attempts ORDER BY id').all();
const orders = () => db.prepare('SELECT account_id, uid, object_url FROM caldav_todo_pending_deletions ORDER BY id').all();
const select = (accountId, url, enabled) => db.prepare(
  'UPDATE caldav_reminder_selection SET enabled = ? WHERE account_id = ? AND list_url = ?'
).run(enabled ? 1 : 0, accountId, url);

/** Die Objekte einer Collection, die diese UID tragen. */
function objectsWith(server, collectionUrl, uid = UID) {
  return server.objectNames(collectionUrl)
    .map((name) => ({ name, ...server.getObject(collectionUrl, name) }))
    .filter((obj) => obj.data.includes(`UID:${uid}`));
}

/** Wartet, bis der Sofortversuch der Route durch ist - ohne einen weiteren zu starten. */
const settled = () => runSerialized('caldav-todo', 'settle', async () => null);

async function patch(id, body) {
  const res = await fetch(`${baseUrl}/items/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  await settled();
  return { status: res.status, body: json };
}

async function remove(id) {
  const res = await fetch(`${baseUrl}/items/${id}`, { method: 'DELETE' });
  await settled();
  return res.status;
}

/**
 * Zwei gespiegelte Listen desselben Kontos, in `a` das Original. Ein echter
 * Lauf spiegelt es; die Zeile kommt so zurueck, wie die Route sie vorfindet.
 */
async function mirroredItem({ target = {} } = {}) {
  reset();
  const a = mirroredList('alt');
  const b = target.server
    ? mirroredList('neu', { server: target.server, accountId: secondAccount() })
    : mirroredList('neu', target);
  dav.putObject(a.url, FILE, original());
  await remindersSync.sync();
  const [item] = rowsOf();
  assert.ok(item, 'der Lauf hat den Artikel nicht gespiegelt - der Fall misst etwas anderes');
  assert.equal(item.list_id, a.listId);
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);
  return { a, b, item };
}

function assertCarried(server, collectionUrl, { summary = 'Milch' } = {}) {
  const there = objectsWith(server, collectionUrl);
  assert.equal(there.length, 1, 'am neuen Platz liegt genau EIN Objekt dieser UID');
  const data = there[0].data;
  assert.match(data, new RegExp(`SUMMARY:${summary}\\r?\\n`));
  assert.match(data, /CATEGORIES:Bio,Kuehlregal/, 'die Etiketten sind mitgekommen');
  assert.match(data, /BEGIN:VALARM[\s\S]*TRIGGER:-PT15M[\s\S]*END:VALARM/, 'der Alarm ist mitgekommen');
  assert.match(data, /X-APPLE-SORT-ORDER:740000000/, 'die unbekannte Eigenschaft ist mitgekommen');
  assert.match(data, /DESCRIPTION:fettarm/);
  return there[0];
}

// ── Der Umzug selbst ────────────────────────────────────────────────────────────

test('Schema: die Vormerkung des Umzugs steht an der Zeile (Migration 243)', () => {
  const columns = db.prepare('PRAGMA table_info(shopping_items)').all().map((c) => c.name);
  assert.ok(columns.includes('outbound_move'));
  assert.ok(columns.includes('outbound_move_attempts'));
});

test('Mitnahme: das Original liegt danach in der neuen Liste - gleiche UID, Etiketten, Alarm, X-Eigenschaft und die Bearbeitung von hier', async () => {
  const { a, b, item } = await mirroredItem();

  const r = await patch(item.id, { list_id: b.listId, name: 'Hafermilch' });
  assert.equal(r.status, 200);

  const carried = assertCarried(dav, b.url, { summary: 'Hafermilch' });
  assert.equal(carried.name, FILE, 'unter dem Namen, den das Objekt schon trug');
  assert.deepEqual(objectsWith(dav, a.url), [], 'am alten Platz liegt es nicht mehr');
  assert.deepEqual(dav.objectNames(a.url), ['neighbour-alt.ics'], 'der Nachbar blieb unberuehrt');

  const rows = rowsOf();
  assert.equal(rows.length, 1, 'lokal eine Zeile');
  const now = rows[0];
  assert.equal(now.id, item.id, 'dieselbe Zeile');
  assert.deepEqual(
    [now.list_id, now.external_source, now.external_uid, now.external_account_id, now.external_object_url,
      now.outbound_move, now.outbound_dirty],
    [b.listId, 'caldav', UID, account1, `${b.url}${FILE}`, 0, 0],
  );
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal'], 'die Etiketten bleiben auch an der Zeile');
  assert.deepEqual(notes(), [], 'keine Notiz bleibt stehen');
  assert.deepEqual(orders(), [], 'kein Loeschauftrag bleibt stehen');

  // Und der naechste volle Lauf laesst alles, wie es ist.
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.name]), [[item.id, b.listId, 'Hafermilch']]);
  assertCarried(dav, b.url, { summary: 'Hafermilch' });
});

test('Ohne Bearbeitung zieht das Objekt Byte fuer Byte um', async () => {
  const { a, b, item } = await mirroredItem();
  await patch(item.id, { list_id: b.listId });
  assert.equal(objectsWith(dav, b.url)[0]?.data, original());
  assert.deepEqual(objectsWith(dav, a.url), []);
});

test('Eine andere App hat das Objekt seit dem letzten Abruf geaendert: mit geht ihr Stand, nicht der alte von hier', async () => {
  const { a, b, item } = await mirroredItem();
  dav.putObject(a.url, FILE, original({ summary: 'Milch 3,5%' }));

  await patch(item.id, { list_id: b.listId });
  assertCarried(dav, b.url, { summary: 'Milch 3,5%' });

  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.list_id, x.name]), [[b.listId, 'Milch 3,5%']]);
});

test('Zwei Konten: das Original geht auf den anderen Server, die Zeile gehoert danach dem anderen Konto', async () => {
  const { a, b, item } = await mirroredItem({ target: { server: dav2 } });

  await patch(item.id, { list_id: b.listId, name: 'Hafermilch' });

  assertCarried(dav2, b.url, { summary: 'Hafermilch' });
  assert.deepEqual(objectsWith(dav, a.url), []);
  const now = row(item.id);
  assert.deepEqual(
    [now.list_id, now.external_account_id, now.external_object_url, now.outbound_move],
    [b.listId, account2, `${b.url}${FILE}`, 0],
  );

  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_account_id]), [[item.id, b.listId, account2]]);
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);
});

// ── Ziel oder Quelle ohne Spiegel ───────────────────────────────────────────────

test('Ziel nicht gespiegelt: am Server ist es ein Loeschen, lokal bleibt der Artikel', async () => {
  const { a, item } = await mirroredItem();
  const plain = plainList('Zettel');

  await patch(item.id, { list_id: plain });

  assert.deepEqual(objectsWith(dav, a.url), []);
  const now = row(item.id);
  assert.deepEqual([now.list_id, now.external_source, now.external_uid, now.outbound_move], [plain, 'local', null, 0]);
});

test('Quelle nicht gespiegelt: in der Zielliste ist es ein Anlegen', async () => {
  reset();
  const b = mirroredList('neu');
  const plain = plainList('Zettel');
  const id = Number(db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Brot')").run(plain).lastInsertRowid);

  await patch(id, { list_id: b.listId });

  const now = row(id);
  assert.equal(now.external_source, 'caldav');
  assert.equal(objectsWith(dav, b.url, now.external_uid).length, 1);
});

test('Zwei Konten, das Zielkonto ist zuerst an der Reihe: eine wartende Bearbeitung ist in das mitgenommene Objekt eingearbeitet', async () => {
  reset();
  secondAccount();
  const a = mirroredList('alt', { server: dav2, accountId: account2 });
  const b = mirroredList('neu');
  dav2.putObject(a.url, FILE, original());
  await remindersSync.sync();
  const [item] = rowsOf();
  assert.equal(item.external_account_id, account2);

  // Der Sofortversuch erreicht keinen der beiden Server.
  dav.refuse({ status: 503 });
  dav2.refuse({ status: 503 });
  await patch(item.id, { list_id: b.listId, name: 'Hafermilch' });
  assert.deepEqual([row(item.id).outbound_move, row(item.id).outbound_dirty], [1, 1]);
  dav.allowAll();
  dav2.allowAll();

  // Der Lauf geht die Konten der Reihe nach durch: das Ziel (Konto 1) vor der
  // Quelle (Konto 2) - die Bearbeitung ist am alten Objekt also noch nicht
  // angekommen, wenn es mitgenommen wird.
  await remindersSync.sync();

  assertCarried(dav, b.url, { summary: 'Hafermilch' });
  assert.deepEqual(objectsWith(dav2, a.url), []);
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.name, x.outbound_dirty, x.external_account_id]),
    [[item.id, b.listId, 'Hafermilch', 0, account1]]);
});

// ── Das Ziel nimmt nicht an ─────────────────────────────────────────────────────

test('Zielliste abgewaehlt: nichts geht hinaus, der Artikel wartet auf der neuen Liste und zieht um, sobald sie wieder an ist', async () => {
  const { a, b, item } = await mirroredItem({ target: { enabled: false } });
  const before = dav.requests.length;

  await patch(item.id, { list_id: b.listId });
  await remindersSync.sync();

  assert.deepEqual(dav.seen('PUT').length + dav.seen('DELETE').length, 0, 'kein Schreibzugriff, solange die Liste aus ist');
  assert.ok(dav.requests.length >= before);
  assert.equal(objectsWith(dav, a.url).length, 1, 'das Original liegt unberuehrt am alten Platz');
  let now = row(item.id);
  assert.deepEqual([now.list_id, now.outbound_move, now.outbound_move_attempts], [b.listId, 1, 0], 'der Lauf holt ihn nicht zurueck, und gezaehlt wird nichts');
  assert.equal(rowsOf().length, 1);

  select(account1, b.url, true);
  await remindersSync.sync();

  assertCarried(dav, b.url);
  assert.deepEqual(objectsWith(dav, a.url), []);
  now = row(item.id);
  assert.deepEqual([now.list_id, now.outbound_move, now.external_object_url], [b.listId, 0, `${b.url}${FILE}`]);
});

test('Die Zuordnung der Zielliste gibt es nicht mehr: der wartende Umzug wird zum Loeschen am Server, der Artikel bleibt', async () => {
  const { a, b, item } = await mirroredItem({ target: { enabled: false } });
  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).outbound_move, 1);
  // Wie beim Entfernen des Zielkontos: die Zuordnung faellt, die Liste bleibt.
  db.prepare('DELETE FROM caldav_reminder_selection WHERE list_url = ?').run(b.url);

  await remindersSync.sync();

  assert.deepEqual(objectsWith(dav, a.url), []);
  const now = row(item.id);
  assert.deepEqual([now.list_id, now.external_source, now.outbound_move], [b.listId, 'local', 0]);
  assert.equal(named('Milch').length, 1);
});

test('Die Zielliste gibt es auf dem Server nicht mehr: der Artikel geht zurueck, sein Eintrag bleibt unberuehrt', async () => {
  const { a, b, item } = await mirroredItem();
  dav.removeCollection(b.url);

  await patch(item.id, { list_id: b.listId });
  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move], [b.listId, 1]);

  await remindersSync.sync();

  const now = row(item.id);
  assert.deepEqual([now.list_id, now.outbound_move, now.external_source, now.external_object_url],
    [a.listId, 0, 'caldav', `${a.url}${FILE}`]);
  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
  assert.deepEqual(orders(), []);
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);
});

test('Die Zielliste war schon abgeschaltet, als es sie nicht mehr gab: auch dann geht der Artikel zurueck', async () => {
  const { a, b, item } = await mirroredItem({ target: { enabled: false } });
  dav.removeCollection(b.url);

  await patch(item.id, { list_id: b.listId });
  await remindersSync.sync();

  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move], [a.listId, 0]);
  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
});

test('Zwei Konten, die abgeschaltete Zielliste ist die einzige ihres Kontos und fort: der Lauf fragt das Konto trotzdem, der Artikel geht zurueck', async () => {
  const { a, b, item } = await mirroredItem({ target: { server: dav2 } });
  select(account2, b.url, false);
  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).outbound_move, 1);
  dav2.removeCollection(b.url);
  // Der Server des Zielkontos nennt noch eine andere Liste - eine leere
  // Auflistung sagte nichts.
  dav2.addCollection('anderes', { name: 'anderes', components: ['VTODO'] });

  await remindersSync.sync();

  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move], [a.listId, 0]);
  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
});

test('Die Zielliste hat noch eine Server-Liste in einem anderen Konto: der Umzug geht dorthin statt zurueck', async () => {
  const { a, b, item } = await mirroredItem();
  secondAccount();
  const other = dav2.addCollection('auch-neu', { name: 'auch-neu', components: ['VTODO'] });
  dav2.putObject(other, 'neighbour-auch-neu.ics', neighbour('auch-neu'));
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'auch-neu', 'shopping', 1, ?)
  `).run(account2, other, b.listId);
  dav.removeCollection(b.url);
  dav2.refuse({ status: 503 });
  await patch(item.id, { list_id: b.listId });
  dav2.allowAll();

  await remindersSync.sync();

  assertCarried(dav2, other);
  assert.deepEqual([row(item.id).list_id, row(item.id).external_account_id, row(item.id).outbound_move],
    [b.listId, account2, 0]);
  assert.deepEqual(objectsWith(dav, a.url), []);
});

test('Der Umzug wartet, und eine andere App loescht den Artikel in seiner ABGERUFENEN Liste: der Abruf raeumt die Zeile ab', async () => {
  const { a, b, item } = await mirroredItem({ target: { enabled: false } });
  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).outbound_move, 1);
  // Der Nachbar bleibt, die Liste ist also nicht leer.
  dav.reset();
  assert.equal(dav.addCollection('alt', { name: 'alt', components: ['VTODO'] }), a.url);
  dav.putObject(a.url, 'neighbour-alt.ics', neighbour('alt'));
  dav.addCollection('neu', { name: 'neu', components: ['VTODO'] });

  await remindersSync.sync();

  assert.deepEqual(rowsOf(), [], 'der Server fuehrt das Objekt nicht mehr - ein wartender Umzug haelt die Zeile nicht fest');
});

test('Der Server liefert fuer die abgerufene Liste NICHTS, ein Umzug wartet: der Leer-Guard des Prune gilt weiter, kein Artikel des Kontos wird abgeraeumt', async () => {
  const { a, b, item } = await mirroredItem();
  const neighbourRow = rowsOf('neighbour-neu@test')[0];
  assert.ok(neighbourRow, 'der Nachbar der Zielliste ist gespiegelt');
  select(account1, a.url, false);
  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).outbound_move, 1);
  // Die einzige abgerufene Liste kommt leer zurueck - haeufiger ein stiller
  // Fehler des Servers als eine geleerte Liste (#508).
  dav.refuse({
    method: 'REPORT', path: new URL(b.url).pathname, status: 207, contentType: 'application/xml',
    body: '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
  });

  await remindersSync.sync();

  assert.ok(row(neighbourRow.id), 'die UID des wartenden Umzugs macht aus "nichts gesehen" kein "alles andere ist fort"');
  assert.ok(row(item.id));
});

test('Quellliste abgewaehlt: aus ihr wird nichts gelesen und nichts entfernt, der Umzug wartet', async () => {
  const { a, b, item } = await mirroredItem();
  select(account1, a.url, false);
  dav.requests.length = 0;

  await patch(item.id, { list_id: b.listId });

  // Die Auflistung der Collections fragt jede nach ihren Faehigkeiten; gelesen
  // oder geschrieben wird in der abgewaehlten nichts.
  assert.deepEqual(
    dav.requests.filter((req) => req.method !== 'PROPFIND' && req.path.startsWith(new URL(a.url).pathname)), [],
  );
  assert.equal(objectsWith(dav, a.url).length, 1);
  assert.deepEqual(objectsWith(dav, b.url), []);
  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move], [b.listId, 1]);

  // Der volle Lauf liest nur die Zielliste. Das Objekt des Artikels liegt in
  // der abgewaehlten - der Lauf weiss also nicht, ob der Server es noch fuehrt,
  // und raeumt die Zeile nicht als "auf dem Server geloescht" ab.
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.outbound_move]), [[item.id, b.listId, 1]]);
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);

  select(account1, a.url, true);
  await todoOutbound.flushOutbound();
  assertCarried(dav, b.url);
  assert.deepEqual(objectsWith(dav, a.url), []);
});

test('Zielliste lehnt ab (403): das Original bleibt, und nach der fuenften Absage steht der Artikel wieder, wo er war', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'PUT', status: 403 });

  await patch(item.id, { list_id: b.listId });           // Absage 1
  let now = row(item.id);
  assert.deepEqual([now.list_id, now.outbound_move, now.outbound_move_attempts], [b.listId, 1, 1]);
  assert.equal(objectsWith(dav, a.url).length, 1, 'das Original ist unberuehrt');
  assert.equal(dav.seen('DELETE').length, 0, 'ohne Ablage am neuen Platz wird am alten nichts entfernt');

  for (let n = 2; n <= 4; n++) {
    await remindersSync.sync();
    now = row(item.id);
    assert.deepEqual([now.list_id, now.outbound_move, now.outbound_move_attempts], [b.listId, 1, n], `Absage ${n}`);
  }

  await remindersSync.sync();                             // Absage 5
  now = row(item.id);
  assert.deepEqual(
    [now.list_id, now.outbound_move, now.outbound_move_attempts, now.external_source, now.external_object_url],
    [a.listId, 0, 0, 'caldav', `${a.url}${FILE}`],
    'zurueck auf der Liste seines Objekts',
  );
  assert.equal(objectsWith(dav, a.url)[0]?.data, original(), 'das Original ist, wie es war');
  assert.deepEqual(objectsWith(dav, b.url), []);
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);
  assert.equal(dav.seen('DELETE').length, 0);

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id]), [[item.id, a.listId]]);
});

test('Der Name ist in der Zielliste von einem FREMDEN Objekt belegt: es wird nicht ueberschrieben, der Umzug zaehlt als Absage', async () => {
  const { a, b, item } = await mirroredItem();
  const foreign = original({ uid: 'someone-else@test', summary: 'Fremd' });
  dav.putObject(b.url, FILE, foreign);

  await patch(item.id, { list_id: b.listId });

  assert.equal(dav.getObject(b.url, FILE).data, foreign, 'das fremde Objekt ist unberuehrt');
  assert.equal(objectsWith(dav, a.url).length, 1);
  assert.deepEqual([row(item.id).outbound_move, row(item.id).outbound_move_attempts], [1, 1]);
});

// ── Abbruch mitten im Weg ───────────────────────────────────────────────────────

test('Die Antwort des PUT geht verloren: nichts ist doppelt, nichts verloren, der naechste Durchgang fuehrt den Umzug zu Ende', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'PUT', commit: true, drop: true, once: true });

  await patch(item.id, { list_id: b.listId });

  // Zwischenstand: das Objekt liegt an BEIDEN Plaetzen, gebucht ist nichts.
  assert.equal(objectsWith(dav, a.url).length, 1, 'am alten Platz wurde nichts entfernt');
  assert.equal(objectsWith(dav, b.url).length, 1);
  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move, row(item.id).external_object_url],
    [b.listId, 1, `${a.url}${FILE}`]);
  assert.equal(row(item.id).outbound_move_attempts, 0, 'eine abgerissene Verbindung ist keine Absage des Ziels');

  await remindersSync.sync();

  assert.equal(rowsOf().length, 1, 'der Abruf hat keine zweite Zeile angelegt');
  assert.equal(named('Milch').length, 1);
  assertCarried(dav, b.url);
  assert.deepEqual(objectsWith(dav, a.url), []);
  const now = row(item.id);
  assert.deepEqual([now.list_id, now.outbound_move, now.external_object_url], [b.listId, 0, `${b.url}${FILE}`]);
  assert.deepEqual(notes(), []);
});

test('Zwei Konten, die Antwort des PUT geht verloren: der Abruf des Zielkontos importiert das Objekt nicht als zweiten Artikel', async () => {
  const { a, b, item } = await mirroredItem({ target: { server: dav2 } });
  dav2.refuse({ method: 'PUT', commit: true, drop: true, once: true });

  await patch(item.id, { list_id: b.listId });
  assert.equal(objectsWith(dav2, b.url).length, 1);
  // Der Abruf laeuft, bevor der Umzug wieder an der Reihe ist: Konto 2 liest
  // das Objekt, das noch niemandem gebucht ist.
  dav.refuse({ method: 'REPORT', path: new URL(a.url).pathname, status: 503 });
  await remindersSync.sync();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE name = ?').get('Milch').n, 1);

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_account_id]), [[item.id, b.listId, account2]]);
  assert.equal(objectsWith(dav2, b.url).length, 1);
  assert.deepEqual(objectsWith(dav, a.url), []);
});

test('Der Artikel traegt die UID einer hier angelegten AUFGABE (Liste umgestellt), zwei Konten, Antwort des PUT verloren: auch dann kein zweiter Artikel', async () => {
  reset();
  const a = mirroredList('alt');
  const b = mirroredList('neu', { server: dav2, accountId: secondAccount() });
  const uid = ownUid('task', 4711, db);
  dav.putObject(a.url, FILE, original({ uid }));
  await remindersSync.sync();
  const [item] = rowsOf(uid);
  assert.ok(item);
  dav2.refuse({ method: 'PUT', commit: true, drop: true, once: true });

  await patch(item.id, { list_id: b.listId });
  assert.equal(objectsWith(dav2, b.url, uid).length, 1);
  dav.refuse({ method: 'REPORT', path: new URL(a.url).pathname, status: 503 });
  await remindersSync.sync();
  assert.equal(named('Milch').length, 1, 'der Abruf des Zielkontos hat das ungebuchte Objekt nicht importiert');

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(rowsOf(uid).map((x) => [x.id, x.list_id, x.external_account_id]), [[item.id, b.listId, account2]]);
});

test('Das Entfernen am alten Platz scheitert: der Abruf sieht zwei Objekte einer UID in einem Konto und laesst die Zeile, wo sie ist', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });

  await patch(item.id, { list_id: b.listId });

  assert.equal(objectsWith(dav, a.url).length, 1);
  assertCarried(dav, b.url);
  assert.deepEqual([row(item.id).list_id, row(item.id).external_object_url], [b.listId, `${b.url}${FILE}`]);

  // Die Collection der alten Liste wird zuletzt gelesen: ohne den Riegel
  // gewoenne ihr Objekt, und die Zeile stuende wieder in der alten Liste.
  dav.moveToEnd(a.url);
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_object_url]), [[item.id, b.listId, `${b.url}${FILE}`]]);
  assert.equal(objectsWith(dav, a.url).length, 1, 'solange der Server ablehnt, liegt es dort');

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(objectsWith(dav, a.url), [], 'der naechste Durchgang raeumt den alten Platz');
  assertCarried(dav, b.url);
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id]), [[item.id, b.listId]]);
  assert.deepEqual(notes(), []);
});

test('Der Server lehnt das Entfernen am alten Platz laenger ab als die Frist der Notiz: sie bleibt, und die Zeile wechselt nicht die Liste', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 403 });
  await patch(item.id, { list_id: b.listId });
  assert.equal(notes().length, 1);
  // Die Notiz ist aelter als ihre Frist (24 Stunden).
  db.prepare("UPDATE caldav_upload_attempts SET created_at = '2020-01-01T00:00:00Z'").run();
  dav.moveToEnd(a.url);

  await remindersSync.sync();
  await remindersSync.sync();

  assert.deepEqual(notes().map((n) => n.collection_url), [a.url], 'die Notiz verdeckt das Objekt weiter');
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_object_url]), [[item.id, b.listId, `${b.url}${FILE}`]]);

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(objectsWith(dav, a.url), []);
  assert.deepEqual(notes(), []);
});

/** Entfernt ein Objekt, als haette es eine andere App geloescht. */
async function deletedByAnotherApp(server, collectionUrl, name) {
  const res = await fetch(`${collectionUrl}${name}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
}

test('Das Entfernen am alten Platz steht aus, und eine andere App loescht die Kopie am NEUEN Platz: das letzte Objekt bleibt, die Zeile auch', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  assert.equal(objectsWith(dav, a.url).length, 1);
  assert.equal(notes().length, 1);
  dav.allowAll();
  await deletedByAnotherApp(dav, b.url, FILE);

  await remindersSync.sync();
  await remindersSync.sync();

  assert.equal(objectsWith(dav, a.url)[0]?.data, original(), 'am alten Platz liegt das einzige verbliebene Objekt - es wurde nicht entfernt');
  const rows = rowsOf();
  assert.equal(rows.length, 1, 'die Zeile ist nicht abgeraeumt');
  assert.deepEqual([rows[0].id, rows[0].list_id, rows[0].external_account_id, rows[0].external_object_url],
    [item.id, a.listId, account1, `${a.url}${FILE}`], 'sie steht wieder, wo der Server den Eintrag fuehrt');
  assert.deepEqual(loadItemTags(db, item.id).sort(), ['Bio', 'Kuehlregal']);
  assert.deepEqual(notes(), []);
});

test('Dasselbe ueber zwei Konten: die Zeile geht an das Konto des alten Platzes zurueck', async () => {
  const { a, b, item } = await mirroredItem({ target: { server: dav2 } });
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).external_account_id, account2);
  dav.allowAll();
  await deletedByAnotherApp(dav2, b.url, FILE);

  await remindersSync.sync();
  await remindersSync.sync();

  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_account_id]), [[item.id, a.listId, account1]]);
});

test('Der neue Platz ist nicht lesbar: am alten wird nichts entfernt, die Notiz bleibt', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  dav.allowAll();
  dav.refuse({ method: 'REPORT', path: new URL(b.url).pathname, status: 503 });

  await remindersSync.sync();

  assert.equal(objectsWith(dav, a.url).length, 1, 'ohne Beleg vom neuen Platz bleibt das alte Objekt');
  assert.equal(notes().length, 1);
  assert.deepEqual([row(item.id).list_id, row(item.id).external_object_url], [b.listId, `${b.url}${FILE}`]);

  dav.allowAll();
  await remindersSync.sync();
  assert.deepEqual(objectsWith(dav, a.url), [], 'liegt die Kopie belegt am neuen Platz, geht der Rest');
  assertCarried(dav, b.url);
});

test('Am alten Platz liegt inzwischen ein FREMDES Objekt: es wird nicht entfernt', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  const foreign = original({ uid: 'someone-else@test', summary: 'Fremd' });
  dav.putObject(a.url, FILE, foreign);
  dav.allowAll();

  await remindersSync.sync();

  assert.equal(dav.getObject(a.url, FILE)?.data, foreign);
  assertCarried(dav, b.url);
  assert.deepEqual(notes(), []);
});

test('Eine andere App aendert das Objekt am alten Platz zwischen Lesen und Entfernen: ihr Stand wird nachgeholt statt geloescht', async () => {
  const { a, b, item } = await mirroredItem();
  let once = true;
  dav.refuse({
    method: 'DELETE',
    when: () => {
      if (once) { once = false; dav.putObject(a.url, FILE, original({ summary: 'Milch laktosefrei' })); }
      return false;
    },
  });

  await patch(item.id, { list_id: b.listId });

  assertCarried(dav, b.url, { summary: 'Milch laktosefrei' });
  assert.deepEqual(objectsWith(dav, a.url), []);
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.name]), [[item.id, b.listId, 'Milch laktosefrei']]);
});

test('Zielkonto zuerst, Bearbeitung im Umzug, und eine andere App aendert das alte Objekt vor dem Entfernen: das Nachtragen behaelt die Bearbeitung von hier', async () => {
  reset();
  secondAccount();
  const a = mirroredList('alt', { server: dav2, accountId: account2 });
  const b = mirroredList('neu');
  dav2.putObject(a.url, FILE, original());
  await remindersSync.sync();
  const [item] = rowsOf();

  dav.refuse({ status: 503 });
  dav2.refuse({ status: 503 });
  await patch(item.id, { list_id: b.listId, name: 'Hafermilch' });
  dav.allowAll();
  dav2.allowAll();
  // Zwischen Lesen und Entfernen aendert eine andere App etwas am alten
  // Objekt, das Yuvomi nicht fuehrt - der Name dort ist noch der alte.
  let once = true;
  dav2.refuse({
    method: 'DELETE',
    when: () => {
      if (once) { once = false; dav2.putObject(a.url, FILE, original().replace('DESCRIPTION:fettarm', 'DESCRIPTION:laktosefrei')); }
      return false;
    },
  });

  await remindersSync.sync();

  const carried = objectsWith(dav, b.url);
  assert.equal(carried.length, 1);
  assert.match(carried[0].data, /DESCRIPTION:laktosefrei/, 'die Aenderung der anderen App ist nachgetragen');
  assert.match(carried[0].data, /SUMMARY:Hafermilch\r\n/, 'und die Bearbeitung von hier steht weiter darin');
  assert.deepEqual(objectsWith(dav2, a.url), []);
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.name]), [[item.id, b.listId, 'Hafermilch']]);
});

test('Zwei Konten fuehren DIESELBE Server-Liste, je auf eine eigene Einkaufsliste: ein Umzug dazwischen fasst das eine Objekt nicht an', async () => {
  reset();
  const a = mirroredList('alt');
  // Ein zweites Konto auf demselben Server (ein anderes Mitglied, dem die
  // Liste freigegeben ist): dieselbe Collection, eigene Einkaufsliste.
  account2 = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zwei', ?, 'v', 'p')"
  ).run(dav.url).lastInsertRowid);
  const other = plainList('alt (Konto zwei)');
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'alt', 'shopping', 1, ?)
  `).run(account2, a.url, other);
  dav.putObject(a.url, FILE, original());
  await remindersSync.sync();
  const mine = rowsOf().find((x) => x.external_account_id === account1);
  assert.equal(rowsOf().length, 2, 'jedes Konto spiegelt das Objekt in seine Liste');

  await patch(mine.id, { list_id: other });
  await remindersSync.sync();

  assert.equal(objectsWith(dav, a.url)[0]?.data, original(), 'das Objekt liegt unveraendert dort - es gab nichts mitzunehmen');
  assert.equal(dav.seen('DELETE').length, 0);
  assert.equal(dav.seen('PUT').length, 0);
  assert.equal(row(mine.id).outbound_move, 0);
  assert.deepEqual(notes(), []);
  assert.equal(rowsOf().length, 2);
});

// ── Der Nutzer handelt, waehrend der Umzug unterwegs ist ────────────────────────

/** Fuehrt `act` aus, waehrend der PUT des Umzugs beim Server liegt. */
function duringCarryPut(act) {
  let once = true;
  dav.refuse({ method: 'PUT', when: () => { if (once) { once = false; act(); } return false; } });
}

test('Geloescht, waehrend der Umzug unterwegs ist: das Objekt bleibt an keinem der beiden Plaetze und kommt nicht zurueck', async () => {
  const { a, b, item } = await mirroredItem();
  duringCarryPut(() => {
    // Wie die Loeschroute: erst vormerken, dann die Zeile entfernen.
    todoOutbound.queueTodoDeletion('shopping', row(item.id));
    db.prepare('DELETE FROM shopping_items WHERE id = ?').run(item.id);
  });

  await patch(item.id, { list_id: b.listId });
  await remindersSync.sync();
  await remindersSync.sync();

  assert.deepEqual(objectsWith(dav, a.url), []);
  assert.deepEqual(objectsWith(dav, b.url), []);
  assert.deepEqual(named('Milch'), [], 'der geloeschte Artikel ist nicht zurueckgekommen');
  assert.deepEqual(notes(), []);
  assert.deepEqual(orders(), []);
});

test('Bearbeitet, waehrend der Umzug unterwegs ist: die Bearbeitung geht dem Objekt am neuen Platz nach', async () => {
  const { a, b, item } = await mirroredItem();
  duringCarryPut(() => {
    const before = row(item.id);
    db.prepare("UPDATE shopping_items SET name = 'Hafermilch' WHERE id = ?").run(item.id);
    todoOutbound.markTodoOutbound('shopping', before, row(item.id));
  });

  await patch(item.id, { list_id: b.listId });
  assert.equal(row(item.id).outbound_dirty, 1, 'die Bearbeitung ist nicht mit dem Umzug abgehakt');
  await remindersSync.sync();

  assertCarried(dav, b.url, { summary: 'Hafermilch' });
  assert.deepEqual(objectsWith(dav, a.url), []);
  assert.deepEqual(rowsOf().map((x) => [x.list_id, x.name, x.outbound_dirty]), [[b.listId, 'Hafermilch', 0]]);
});

test('Zurueckgezogen, waehrend der Umzug unterwegs ist: der Artikel bleibt an seinem Objekt, das eben abgelegte verschwindet', async () => {
  const { a, b, item } = await mirroredItem();
  duringCarryPut(() => {
    db.transaction(() => {
      todoOutbound.moveShoppingMirror(row(item.id), a.listId);
      db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(a.listId, item.id);
    })();
  });

  await patch(item.id, { list_id: b.listId });
  await remindersSync.sync();

  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
  assert.deepEqual(objectsWith(dav, b.url), []);
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.external_object_url, x.outbound_move]),
    [[item.id, a.listId, `${a.url}${FILE}`, 0]]);
  assert.deepEqual(notes(), []);
});

test('Hin und gleich zurueck, das Entfernen am alten Platz steht noch aus: am Ende liegt das Objekt EINMAL, in der Liste des Artikels', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId, name: 'Hafermilch' });
  assert.equal(objectsWith(dav, a.url).length, 1);
  dav.allowAll();

  await patch(item.id, { list_id: a.listId });

  const back = assertCarried(dav, a.url, { summary: 'Hafermilch' });
  assert.equal(back.name, FILE);
  assert.deepEqual(objectsWith(dav, b.url), []);
  await remindersSync.sync();
  assert.deepEqual(rowsOf().map((x) => [x.id, x.list_id, x.name, x.external_object_url]),
    [[item.id, a.listId, 'Hafermilch', `${a.url}${FILE}`]]);
  assert.deepEqual(notes(), []);
});

test('Zurueck, solange der Server am neuen Platz nichts entfernen laesst: das Objekt dort wird mit dem heutigen Stand ueberschrieben, nicht blind uebernommen', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  // Eine andere App aendert den Artikel an seinem neuen Platz; der Abruf holt es herein.
  dav.putObject(b.url, FILE, original({ summary: 'Milch 1,5%' }));
  await remindersSync.sync();
  assert.equal(row(item.id).name, 'Milch 1,5%');
  assert.match(objectsWith(dav, a.url)[0].data, /SUMMARY:Milch\r\n/, 'am alten Platz liegt noch der Stand von vor dem Umzug');

  await patch(item.id, { list_id: a.listId });

  assertCarried(dav, a.url, { summary: 'Milch 1,5%' });
  assert.deepEqual([row(item.id).list_id, row(item.id).external_object_url, row(item.id).outbound_move],
    [a.listId, `${a.url}${FILE}`, 0]);
});

test('Zurueckgezogen, waehrend das Original gelesen wird: am neuen Platz wird nichts abgelegt', async () => {
  const { a, b, item } = await mirroredItem();
  let once = true;
  dav.refuse({
    method: 'REPORT', path: new URL(a.url).pathname,
    when: () => {
      if (once) {
        once = false;
        db.transaction(() => {
          todoOutbound.moveShoppingMirror(row(item.id), a.listId);
          db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(a.listId, item.id);
        })();
      }
      return false;
    },
  });

  await patch(item.id, { list_id: b.listId });

  assert.equal(dav.seen('PUT').length, 0);
  assert.equal(objectsWith(dav, a.url)[0]?.data, original());
  assert.deepEqual([row(item.id).list_id, row(item.id).outbound_move], [a.listId, 0]);
  assert.deepEqual(notes(), []);
});

test('Nach dem Umzug geloescht, das Entfernen am alten Platz steht noch aus: beide Objekte gehen, nichts kommt zurueck', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'DELETE', status: 503 });
  await patch(item.id, { list_id: b.listId });
  dav.allowAll();

  assert.equal(await remove(item.id), 200);
  await remindersSync.sync();
  await remindersSync.sync();

  assert.deepEqual(objectsWith(dav, a.url), []);
  assert.deepEqual(objectsWith(dav, b.url), []);
  assert.deepEqual(named('Milch'), []);
});

test('Das Original ist am Server schon fort: der Umzug faellt, statt etwas zu erfinden', async () => {
  const { a, b, item } = await mirroredItem();
  dav.refuse({ method: 'PUT', status: 500, when: () => false });
  // Eine andere App hat den Artikel geloescht.
  const before = dav.objectNames(a.url).length;
  dav.reset();
  const a2 = dav.addCollection('alt', { name: 'alt', components: ['VTODO'] });
  dav.putObject(a2, 'neighbour-alt.ics', neighbour('alt'));
  const b2 = dav.addCollection('neu', { name: 'neu', components: ['VTODO'] });
  dav.putObject(b2, 'neighbour-neu.ics', neighbour('neu'));
  assert.equal(before, 2);
  assert.equal(a2, a.url);

  await patch(item.id, { list_id: b.listId });

  assert.equal(dav.seen('PUT').length, 0, 'ohne Original wird nichts abgelegt');
  assert.equal(row(item.id).outbound_move, 0);
  await remindersSync.sync();
  assert.deepEqual(rowsOf(), [], 'der Abruf raeumt die Zeile wie jede, deren Objekt der Server nicht mehr fuehrt');
  assert.equal(b2, b.url);
});
