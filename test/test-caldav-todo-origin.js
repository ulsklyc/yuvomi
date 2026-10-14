/**
 * Test: Aufgaben und Einkaufsposten eines CalDAV-Kontos werden nur über die
 * Adresse dieses Kontos geändert, gelöscht und abgerufen - dieselbe Prüfung
 * (`withAccountOrigin`), die für Termine seit #1860 gilt.
 *
 * Die Objekt-Adresse einer gespiegelten Zeile stammt aus der Antwort des
 * Servers (`href` im Multistatus), und tsdav übernimmt eine absolute href so,
 * wie sie dasteht. Jede Anfrage des VTODO-Wegs (Lauf, Sofortversuch, Quelle
 * einer Mitnahme) geht deshalb durch `createTodoClient`.
 *
 * Gemessen mit echtem tsdav gegen `test/caldav-fake-server.js`, vor dem Fix
 * rot: Bearbeiten und Löschen stellten Anfragen an eine Adresse ausserhalb des
 * Kontos, an einen anderen Host ebenso wie an `http://` desselben Hosts bei
 * einem Konto mit `https://`. Der Umzug eines Einkaufspostens war schon vorher
 * dicht (grün gemessen): `carryShoppingItem` wartet, solange der Platz des
 * Originals keine ausgewählte Liste ist (`listIsSelected`). Der Fall steht
 * hier, damit das so bleibt.
 *
 * Ausführen: node --experimental-sqlite --test test/test-caldav-todo-origin.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
delete process.env.LOG_LEVEL;
delete process.env.NODE_ENV;

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const todoOutbound  = await import('../server/services/caldav-todo-outbound.js');
const remindersSync = await import('../server/services/caldav-reminders-sync.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav     = await startFakeDavServer();
const foreign = await startFakeDavServer();
test.after(async () => { await dav.close(); await foreign.close(); });

const UID  = 'victim@other-app';
const FILE = 'victim.ics';

function vtodo(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other App//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION', 'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ein `<d:response>` mit getetag und calendar-data. */
const objectResponse = (href, obj) => `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>`
  + `<d:getetag>${xmlEscape(obj.etag)}</d:getetag><c:calendar-data>${xmlEscape(obj.data)}</c:calendar-data>`
  + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

/** Jedes Objekt der Liste unter seiner richtigen Adresse, wie der Server es nennt. */
const ownResponses = (listUrl) => dav.objectNames(listUrl)
  .map((name) => objectResponse(`${new URL(listUrl).pathname}${name}`, dav.getObject(listUrl, name))).join('');

let accountId;

function reset() {
  for (const table of [
    'caldav_upload_attempts', 'caldav_todo_pending_deletions', 'shopping_item_tags', 'shopping_items',
    'shopping_lists', 'tasks', 'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  dav.reset();
  foreign.reset();
  accountId = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Eins', ?, 'u', 'secret-pass')"
  ).run(dav.url).lastInsertRowid);
}

function list(slug, module) {
  const url = dav.addCollection(slug, { name: slug, components: ['VTODO'] });
  dav.putObject(url, `neighbour-${slug}.ics`, vtodo(`neighbour-${slug}@test`, 'Nachbar'));
  const listId = module === 'shopping'
    ? Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES (?, 1)").run(slug).lastInsertRowid)
    : null;
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(accountId, url, slug, module, listId);
  return { url, listId };
}

/**
 * Der eigene Server beantwortet den Multiget dieser Liste mit dem Objekt und
 * ein zweites Mal mit einer absoluten href auf dem anderen Host - unter
 * demselben Pfad, unter dem das Objekt bei ihm liegt (tsdav ab 2.4.0 verlangt
 * jede angefragte Adresse in der Antwort, weist zusätzliche aber nicht ab).
 * Auf dem anderen Host liegt dort ein fremdes Objekt.
 */
function answerWithForeignHref(listUrl) {
  const path = new URL(listUrl).pathname;
  const foreignList = foreign.addCollection(path.split('/').filter(Boolean).pop(), { components: ['VTODO'] });
  foreign.putObject(foreignList, FILE, vtodo('stranger@elsewhere', 'Fremd'));
  const own = dav.getObject(listUrl, FILE);
  const body = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + ownResponses(listUrl) + objectResponse(`${foreignList}${FILE}`, own)
    + '</d:multistatus>';
  dav.refuse({
    method: 'REPORT', path, status: 207, contentType: 'application/xml; charset=utf-8', body,
    when: (req) => /multiget/.test(req.body) && req.body.includes(FILE),
  });
  return foreignList;
}

/** Was der andere Host zu sehen bekam - erwartet: nichts. */
const reachedForeign = () => foreign.requests.map((r) => `${r.method} ${r.path}`);

async function mirrored(module) {
  reset();
  const home = list('home', module);
  dav.putObject(home.url, FILE, vtodo(UID, 'Milch'));
  const foreignList = answerWithForeignHref(home.url);
  await remindersSync.sync();
  assert.deepEqual(reachedForeign(), [], 'der Abruf selbst fragt nur die Liste des Kontos');
  const table = module === 'shopping' ? 'shopping_items' : 'tasks';
  const row = db.prepare(`SELECT * FROM ${table} WHERE external_uid = ?`).get(UID);
  assert.ok(row, 'der Lauf hat den Eintrag nicht gespiegelt - der Fall misst etwas anderes');
  return { home, foreignList, row, table };
}

function assertForeignUntouched(foreignList) {
  assert.deepEqual(reachedForeign(), [], 'keine Anfrage an einen anderen Host als den des Kontos');
  assert.match(foreign.getObject(foreignList, FILE)?.data ?? '', /UID:stranger@elsewhere/,
    'das fremde Objekt auf dem anderen Host ist unverändert');
}

test('Bearbeitung, Sofortversuch: keine Anfrage an den Host aus der href', async () => {
  const { foreignList, row } = await mirrored('tasks');
  db.prepare("UPDATE tasks SET title = 'Hafermilch', outbound_dirty = 1 WHERE id = ?").run(row.id);
  await todoOutbound.flushOutbound();
  assertForeignUntouched(foreignList);
});

test('Bearbeitung, Lauf: keine Anfrage an den Host aus der href', async () => {
  const { home, foreignList, row } = await mirrored('tasks');
  db.prepare("UPDATE tasks SET title = 'Hafermilch', outbound_dirty = 1 WHERE id = ?").run(row.id);
  answerWithForeignHref(home.url);
  await remindersSync.sync();
  assertForeignUntouched(foreignList);
});

test('Löschung, Sofortversuch und Lauf: kein DELETE an den Host aus der href', async () => {
  const { home, foreignList, row } = await mirrored('tasks');
  assert.equal(todoOutbound.queueTodoDeletion('tasks', row), true);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
  await todoOutbound.flushOutbound();
  assertForeignUntouched(foreignList);
  answerWithForeignHref(home.url);
  await remindersSync.sync();
  assertForeignUntouched(foreignList);
});

test('Einkauf: Umzug in eine andere gespiegelte Liste nimmt nichts vom Host aus der href mit', async () => {
  const { foreignList, row } = await mirrored('shopping');
  const target = list('target', 'shopping');
  db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(target.listId, row.id);
  assert.equal(todoOutbound.moveShoppingMirror(row, target.listId), 'carry');
  await todoOutbound.flushOutbound();
  assertForeignUntouched(foreignList);
});

// ── Eine abgelehnte Adresse ist keine Absage des Servers ───────────────────────

test('Bearbeitung: die Absage der Adresse verbraucht keinen Versuch, die Änderung bleibt vorgemerkt', async () => {
  const { home, row } = await mirrored('tasks');
  db.prepare("UPDATE tasks SET title = 'Hafermilch', outbound_dirty = 1 WHERE id = ?").run(row.id);
  for (let i = 0; i < 6; i++) {
    await todoOutbound.flushOutbound();
    answerWithForeignHref(home.url);
    await remindersSync.sync();
  }
  const now = db.prepare('SELECT title, outbound_dirty, outbound_attempts FROM tasks WHERE id = ?').get(row.id);
  assert.deepEqual(now, { title: 'Hafermilch', outbound_dirty: 1, outbound_attempts: 0 });
});

test('Löschung: der Sofortversuch zählt die Absage nicht, der Lauf räumt den Auftrag ab', async () => {
  const { home, row } = await mirrored('tasks');
  assert.equal(todoOutbound.queueTodoDeletion('tasks', row), true);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
  const orders = () => db.prepare('SELECT attempts FROM caldav_todo_pending_deletions').all();
  for (let i = 0; i < 6; i++) await todoOutbound.flushOutbound();
  assert.deepEqual(orders(), [{ attempts: 0 }], 'der Auftrag wartet ohne gezählten Versuch');
  answerWithForeignHref(home.url);
  await remindersSync.sync();
  assert.deepEqual(orders(), [], 'der volle Lauf räumt den Auftrag ab');
  assert.ok(dav.getObject(home.url, FILE), 'auf dem Server des Kontos wurde nichts gelöscht');
});

// ── Schema: dieselbe Adresse, nur http statt https ─────────────────────────────

const { withHttpRefusalsAsErrors, withCalendarObjectUrlFilter } = await import('../server/utils/caldav-client.js');
const { createDAVClient } = await import('tsdav');

/**
 * Anfragen, die der Client mit `http://` gestellt hat. Eine `https://`-Anfrage
 * geht im Test ebenfalls im Klartext an den Fake-Server (er spricht kein TLS),
 * wird aber nicht gezählt: gemessen wird, welches Schema der CLIENT wählt.
 */
const plainRequests = [];
function schemeFetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
  if (url.protocol === 'http:') plainRequests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  else url.protocol = 'http:';
  return fetch(url.href, init);
}

/** Wie `createCalDAVClient`, nur mit `schemeFetch`. */
async function schemeClient(account) {
  const client = await createDAVClient({
    serverUrl:          account.caldav_url,
    credentials:        { username: account.username, password: account.password },
    authMethod:         'Basic',
    defaultAccountType: 'caldav',
    fetch:              schemeFetch,
  });
  return withHttpRefusalsAsErrors(withCalendarObjectUrlFilter(client), { fetch: schemeFetch });
}

const httpsOrigin = dav.origin.replace(/^http:/, 'https:');

/** Konto auf `https://`; der Server nennt das Objekt unter `http://` derselben Adresse. */
async function mirroredOverHttps() {
  reset();
  db.prepare('UPDATE caldav_accounts SET caldav_url = ? WHERE id = ?').run(`${httpsOrigin}/`, accountId);
  const listUrl = dav.addCollection('home', { name: 'home', components: ['VTODO'] });
  const path = new URL(listUrl).pathname;
  dav.putObject(listUrl, 'neighbour-home.ics', vtodo('neighbour-home@test', 'Nachbar'));
  dav.putObject(listUrl, FILE, vtodo(UID, 'Milch'));
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'home', 'tasks', 1)
  `).run(accountId, `${httpsOrigin}${path}`);
  const own = dav.getObject(listUrl, FILE);
  const body = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + ownResponses(listUrl) + objectResponse(`${dav.origin}${path}${FILE}`, own)
    + '</d:multistatus>';
  const rule = {
    method: 'REPORT', path, status: 207, contentType: 'application/xml; charset=utf-8', body,
    when: (req) => /multiget/.test(req.body) && req.body.includes(FILE),
  };
  dav.refuse(rule);
  plainRequests.length = 0;
  await remindersSync.sync({ createClient: schemeClient });
  const row = db.prepare('SELECT * FROM tasks WHERE external_uid = ?').get(UID);
  assert.ok(row, 'der Lauf hat die Aufgabe nicht gespiegelt - der Fall misst etwas anderes');
  assert.ok(dav.requests.length > 0, 'der Client hat den Fake-Server erreicht');
  assert.deepEqual(plainRequests, [], 'der Abruf selbst bleibt bei https');
  return { rule, row };
}

test('https-Konto: Bearbeiten und Löschen stellen keine Anfrage über http', async () => {
  const { rule, row } = await mirroredOverHttps();
  db.prepare("UPDATE tasks SET title = 'Hafermilch', outbound_dirty = 1 WHERE id = ?").run(row.id);
  await todoOutbound.flushOutbound({ createClient: schemeClient });
  dav.refuse(rule);
  await remindersSync.sync({ createClient: schemeClient });
  assert.deepEqual(plainRequests, [], 'Bearbeitung: nichts über http');

  const again = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
  assert.equal(todoOutbound.queueTodoDeletion('tasks', again), true);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
  await todoOutbound.flushOutbound({ createClient: schemeClient });
  dav.refuse(rule);
  await remindersSync.sync({ createClient: schemeClient });
  assert.deepEqual(plainRequests, [], 'Löschung: nichts über http');
  assert.ok(dav.getObject(`${dav.origin}/cal/home/`, FILE), 'das Objekt liegt unverändert auf dem Server');
});
