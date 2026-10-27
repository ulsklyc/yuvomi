/**
 * Test: eine Aufgabe oder ein Einkaufsartikel mit derselben UID in zwei
 *       CalDAV-Konten ist EINE Zeile (#1906), und ein gelöschtes Konto gibt
 *       seine Zeilen frei, statt sie lokal zu machen (#1885).
 *
 * Entscheidungen vom 27.10.:
 *   - die ältere Zeile bleibt (wie #1879 für Termine);
 *   - von der jüngeren gehen Kommentare, Dokumente und Zuweisungen über
 *     (Doppeltes übersprungen), ihre Erledigungen fallen, Unteraufgaben werden
 *     vorher umgehängt und über ihre eigene UID-Gruppe zusammengeführt;
 *   - ein AFTER-DELETE-Trigger auf caldav_accounts statt eines
 *     Fremdschlüssels; die Zeile verliert ihr Konto und bleibt Spiegel, das
 *     nächste Konto, das die UID liefert, übernimmt sie.
 *
 * Der Lauf geht gegen echtes HTTP (`test/caldav-fake-server.js`), die
 * Migration gegen eine Bestands-DB aus der echten Kette bis v266.
 *
 * Ausführen: npm run test:caldav-todo-one-row
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { tempDir } from './tmp-dir.js';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { MIGRATIONS } = dbmod;
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const caldavSync = await import('../server/services/caldav-sync.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

function vtodo(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260701T080000Z', `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

function reset() {
  for (const table of [
    'caldav_todo_pending_deletions', 'tasks', 'shopping_items', 'shopping_lists',
    'caldav_reminder_selection', 'caldav_accounts', 'caldav_upload_attempts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  dav.reset();
}

function account(name) {
  return Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES (?, ?, ?, 'p')"
  ).run(name, dav.url, name).lastInsertRowid);
}

function selectTasks(accountId, listUrl) {
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Geteilt', 'tasks', 1)
  `).run(accountId, listUrl);
}

function selectShopping(accountId, listUrl, listId) {
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, 'Einkauf', 'shopping', 1, ?)
  `).run(accountId, listUrl, listId);
}

const shoppingList = (name) => db.prepare(
  'INSERT INTO shopping_lists (name, created_by) VALUES (?, 1) RETURNING id'
).get(name).id;
const tasksWith = (uid) => db.prepare("SELECT * FROM tasks WHERE external_uid = ? ORDER BY id").all(uid);
const itemsWith = (uid) => db.prepare("SELECT * FROM shopping_items WHERE external_uid = ? ORDER BY id").all(uid);

/** Zwei Konten, beide mit einer Liste, in der dieselbe UID liegt - die des
 *  zweiten mit anderem Titel, damit eine Änderung durch das zweite sichtbar ist. */
function twoAccountsOneUid() {
  const a = account('Anna');
  const b = account('Ben');
  const listA = dav.addCollection('todo-a', { name: 'Geteilt A', components: ['VTODO'] });
  const listB = dav.addCollection('todo-b', { name: 'Geteilt B', components: ['VTODO'] });
  for (const list of [listA, listB]) dav.putObject(list, 'neighbour.ics', vtodo(`n-${list.length}@test`, 'Nachbar'));
  dav.putObject(listA, 'shared.ics', vtodo('shared@test', 'Vom ersten Konto'));
  dav.putObject(listB, 'shared.ics', vtodo('shared@test', 'Vom zweiten Konto'));
  selectTasks(a, listA);
  selectTasks(b, listB);
  return { a, b, listA, listB };
}

test('Zwei Konten, dieselbe Aufgabe: eine Zeile, sie gehört dem ersten, das zweite ändert sie nicht (#1906)', async () => {
  reset();
  const { a } = twoAccountsOneUid();

  await remindersSync.sync();
  await remindersSync.sync();
  const rows = tasksWith('shared@test');
  assert.equal(rows.length, 1, 'jedes Konto hat seine eigene Zeile angelegt');
  assert.equal(rows[0].external_account_id, a);
  assert.equal(rows[0].title, 'Vom ersten Konto', 'der Abruf des zweiten Kontos hat die Zeile überschrieben');
});

test('Zwei Konten, derselbe Einkaufsartikel: eine Zeile, auf der Liste des ersten (#1906)', async () => {
  reset();
  const a = account('Anna');
  const b = account('Ben');
  const listA = dav.addCollection('shop-a', { name: 'Einkauf A', components: ['VTODO'] });
  const listB = dav.addCollection('shop-b', { name: 'Einkauf B', components: ['VTODO'] });
  for (const list of [listA, listB]) dav.putObject(list, 'neighbour.ics', vtodo(`sn-${list.length}@test`, 'Nachbar'));
  dav.putObject(listA, 'milk.ics', vtodo('milk@test', 'Milch'));
  dav.putObject(listB, 'milk.ics', vtodo('milk@test', 'Milch'));
  const localA = shoppingList('Wocheneinkauf');
  const localB = shoppingList('Bens Liste');
  selectShopping(a, listA, localA);
  selectShopping(b, listB, localB);

  await remindersSync.sync();
  const rows = itemsWith('milk@test');
  assert.equal(rows.length, 1, 'jedes Konto hat seinen eigenen Artikel angelegt');
  assert.deepEqual([rows[0].external_account_id, rows[0].list_id], [a, localA]);
});

test('Auf dem Server gelöscht: die Zeile fällt einmal, mit dem Abruf des Kontos, dem sie gehört (#1906)', async () => {
  reset();
  const { b, listA, listB } = twoAccountsOneUid();
  await remindersSync.sync();
  await remindersSync.sync(); // gesehen (#1839)
  // Nur das zweite Konto führt sie nicht mehr: sein Prune fasst die Zeile nicht an.
  dav.removeObject(listB, 'shared.ics');
  await remindersSync.sync();
  assert.equal(tasksWith('shared@test').length, 1, 'der Prune des zweiten Kontos hat die Zeile des ersten entfernt');
  dav.removeObject(listA, 'shared.ics');
  await remindersSync.sync();
  assert.equal(tasksWith('shared@test').length, 0, 'die auf dem Server gelöschte Aufgabe steht noch');
  assert.ok(b);
});

test('Das besitzende Konto wird gelöscht: die Zeile verliert ihr Konto, das zweite übernimmt sie, keine zweite Zeile (#1885)', async () => {
  reset();
  const { a, b } = twoAccountsOneUid();
  await remindersSync.sync();
  const [before] = tasksWith('shared@test');

  caldavSync.deleteAccount(a);
  let rows = tasksWith('shared@test');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].external_source, rows[0].external_account_id], [before.id, 'caldav', null],
    'die Zeile wurde lokal oder verschwand, statt frei zu werden');

  await remindersSync.sync();
  rows = tasksWith('shared@test');
  assert.equal(rows.length, 1, 'das zweite Konto hat neben der freien Zeile eine eigene angelegt');
  assert.deepEqual([rows[0].id, rows[0].external_account_id], [before.id, b]);
});

test('Trigger: ein Konto, das auf anderem Weg verschwindet, gibt Zeilen und Upload-Ziele frei (#1885)', () => {
  reset();
  const a = account('Anna');
  const t = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, external_source, external_uid, external_account_id, outbound_dirty)
    VALUES ('Spiegel', 1, 'caldav', 'x@test', ?, 1)
  `).run(a).lastInsertRowid);
  const target = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, target_caldav_account_id, target_caldav_list_url)
    VALUES ('Lokal mit Ziel', 1, ?, 'https://dav.example/l/')
  `).run(a).lastInsertRowid);
  db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(a);
  const row = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assert.deepEqual([row(t).external_source, row(t).external_account_id, row(t).outbound_dirty], ['caldav', null, 0]);
  assert.deepEqual([row(target).target_caldav_account_id, row(target).target_caldav_list_url], [null, null]);
});

test('Elternteil gehört dem ersten Konto, das Kind nur dem zweiten: das Kind hängt trotzdem am Elternteil (#1906, Review)', async () => {
  reset();
  const a = account('Anna');
  const b = account('Ben');
  const listA = dav.addCollection('todo-a', { name: 'A', components: ['VTODO'] });
  const listB = dav.addCollection('todo-b', { name: 'B', components: ['VTODO'] });
  dav.putObject(listA, 'n.ics', vtodo('na@test', 'Nachbar'));
  dav.putObject(listA, 'parent.ics', vtodo('parent@test', 'Elternteil'));
  dav.putObject(listB, 'parent.ics', vtodo('parent@test', 'Elternteil'));
  dav.putObject(listB, 'child.ics', vtodo('child@test', 'Kind').replace('SUMMARY:Kind', 'SUMMARY:Kind\r\nRELATED-TO;RELTYPE=PARENT:parent@test'));
  selectTasks(a, listA);
  selectTasks(b, listB);

  await remindersSync.sync();
  const [parent] = tasksWith('parent@test');
  const [child] = tasksWith('child@test');
  assert.equal(parent.external_account_id, a);
  assert.equal(child.external_account_id, b);
  assert.equal(child.parent_task_id, parent.id, 'das Kind hängt nicht am Elternteil des anderen Kontos');
  assert.equal(parent.parent_task_id, null);
});

// ── Migration v268 gegen eine Bestands-DB mit Dubletten ─────────────────────────

function applyMigration(d, migration) {
  if (migration.foreignKeysOff) d.pragma('foreign_keys = OFF');
  try {
    d.transaction(() => {
      if (typeof migration.up === 'function') migration.up(d);
      else d.exec(migration.up);
      migration.afterUp?.(d);
    })();
  } finally {
    if (migration.foreignKeysOff) d.pragma('foreign_keys = ON');
  }
}

function buildPre268Database() {
  const d = new Database(join(tempDir('yuvomi-onerow-'), 'db.sqlite'));
  d.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS.filter((m) => m.version <= 266)) applyMigration(d, migration);
  d.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin'), (2,'kid','Kind','x','member')").run();
  return d;
}

function mirroredTask(d, title, uid, accountId, parentId = null) {
  return Number(d.prepare(`
    INSERT INTO tasks (title, created_by, external_source, external_uid, external_account_id, parent_task_id)
    VALUES (?, 1, 'caldav', ?, ?, ?)
  `).run(title, uid, accountId, parentId).lastInsertRowid);
}

test('Migration v268: Dubletten werden eine Zeile, die ältere bleibt, Anhänge gehen über wie entschieden', () => {
  const v268 = MIGRATIONS.find((m) => m.version === 268);
  assert.ok(v268, 'Migration 268 fehlt');
  const d = buildPre268Database();
  const a = Number(d.prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('A','https://a/','a','p')").run().lastInsertRowid);
  const b = Number(d.prepare("INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('B','https://b/','b','p')").run().lastInsertRowid);

  const older = mirroredTask(d, 'Elternteil', 'parent@test', a);
  const olderChild = mirroredTask(d, 'Kind', 'child@test', a, older);
  const younger = mirroredTask(d, 'Elternteil', 'parent@test', b);
  const youngerChild = mirroredTask(d, 'Kind', 'child@test', b, younger);
  const onlyYoungerChild = mirroredTask(d, 'Nur am Zweiten', 'child2@test', b, younger);
  const single = mirroredTask(d, 'Einzeln', 'single@test', a);

  // Anhänge an der jüngeren: ein Kommentar, ein Dokument, Zuweisungen (eine
  // doppelt), eine Erledigung; an der älteren eine eigene Erledigung.
  d.prepare("INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, 1, 'am Zweiten notiert')").run(younger);
  const doc = Number(d.prepare(`
    INSERT INTO family_documents (name, original_name, mime_type, file_size, content_data, created_by)
    VALUES ('Beleg', 'beleg.pdf', 'application/pdf', 1, 'x', 1)
  `).run().lastInsertRowid);
  d.prepare('INSERT INTO task_documents (task_id, document_id) VALUES (?, ?)').run(younger, doc);
  d.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, 1), (?, 1), (?, 2)').run(older, younger, younger);
  d.prepare("INSERT INTO task_completions (task_id, series_id, completed_at) VALUES (?, ?, '2026-10-01T08:00:00Z')").run(older, older);
  d.prepare("INSERT INTO task_completions (task_id, series_id, completed_at) VALUES (?, ?, '2026-10-01T08:00:01Z')").run(younger, younger);

  const item1 = Number(d.prepare(`
    INSERT INTO shopping_lists (name, created_by) VALUES ('L', 1) RETURNING id
  `).get().id);
  const itemOld = Number(d.prepare(`
    INSERT INTO shopping_items (list_id, name, external_source, external_uid, external_account_id) VALUES (?, 'Milch', 'caldav', 'milk@test', ?)
  `).run(item1, a).lastInsertRowid);
  d.prepare(`
    INSERT INTO shopping_items (list_id, name, external_source, external_uid, external_account_id) VALUES (?, 'Milch', 'caldav', 'milk@test', ?)
  `).run(item1, b);

  applyMigration(d, v268);

  const tasks = d.prepare('SELECT id, external_uid, parent_task_id, external_account_id FROM tasks ORDER BY id').all();
  assert.deepEqual(tasks.map((t) => [t.id, t.external_uid, t.parent_task_id]), [
    [older, 'parent@test', null],
    [olderChild, 'child@test', older],
    [onlyYoungerChild, 'child2@test', older],
    [single, 'single@test', null],
  ], 'eine Zeile je UID, die ältere bleibt, Unteraufgaben hängen am Überlebenden');
  assert.ok(!tasks.some((t) => t.id === youngerChild));
  assert.deepEqual(d.prepare('SELECT task_id, comment FROM task_comments').all(), [{ task_id: older, comment: 'am Zweiten notiert' }]);
  assert.deepEqual(d.prepare('SELECT task_id, document_id FROM task_documents').all(), [{ task_id: older, document_id: doc }]);
  assert.deepEqual(d.prepare('SELECT task_id, user_id FROM task_assignments ORDER BY user_id').all(),
    [{ task_id: older, user_id: 1 }, { task_id: older, user_id: 2 }]);
  assert.deepEqual(d.prepare('SELECT task_id, completed_at FROM task_completions').all(),
    [{ task_id: older, completed_at: '2026-10-01T08:00:00Z' }], 'die Erledigung der jüngeren wurde nicht verworfen');
  assert.deepEqual(d.prepare('SELECT id FROM shopping_items').all().map((r) => r.id), [itemOld]);

  // Der Trigger steht und wirkt.
  d.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(a);
  assert.deepEqual(d.prepare('SELECT external_source, external_account_id FROM tasks WHERE id = ?').get(older),
    { external_source: 'caldav', external_account_id: null });
  d.close();
});
