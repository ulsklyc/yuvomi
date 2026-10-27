/**
 * Test: nur beschreibbare Collections sind Upload-Ziel (#1840).
 *
 * Der Fehler: ein nur lesbar geteilter Kalender oder eine solche
 * Erinnerungsliste liess sich als Ziel neuer Eintraege waehlen. Jeder Upload
 * dorthin kam mit 403 zurueck, der Eintrag blieb lokal und wurde bei jedem
 * Lauf erneut versucht - der Grund stand nur im Log. Und die alte
 * iCloud-Verbindung lud jeden lokalen Termin in den ERSTEN Kalender der
 * Auflistung, gleich ob der Termine annimmt.
 *
 * Geprueft wird an der Quelle: die Auflistung liest je Collection
 * `current-user-privilege-set`, die Auswahl merkt es sich, die Zielauswahl
 * der Formulare und die Routen bieten und nehmen nur, was neue Eintraege
 * annimmt, der Upload schickt nichts an eine nur lesbare Collection (das Ziel
 * bleibt stehen, die Zahl der wartenden Eintraege steht in der Auswahl), und
 * iCloud nimmt den ersten beschreibbaren Terminkalender.
 *
 * Echtes tsdav gegen `test/caldav-fake-server.js`, wie test-caldav-http-refusals.js.
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-caldav-writable-targets.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { createCalDAVClient, collectionWritable } = await import('../server/utils/caldav-client.js');
const caldavSync    = await import('../server/services/caldav-sync.js');
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const appleCalendar = await import('../server/services/apple-calendar.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: tasksRouter }    = await import('../server/routes/tasks.js');

const userId = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run().lastInsertRowid);

const dav = await startFakeDavServer();

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = userId; req.authRole = 'admin'; next(); });
app.use('/calendar', calendarRouter);
app.use('/tasks', tasksRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); return dav.close(); });

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let accountId;

function reset() {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'external_calendars', 'caldav_upload_attempts',
    'caldav_calendar_selection', 'caldav_todo_pending_deletions', 'tasks', 'shopping_items',
    'shopping_lists', 'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  appleCalendar.clearCredentials();
  dav.reset();
  accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
}

const RW = ['read', 'write'];
const RO = ['read', 'read-current-user-privilege-set'];

function localEvent(calendarUrl, title = 'Hier angelegt') {
  return Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source,
       target_caldav_account_id, target_caldav_calendar_url)
    VALUES (?, '2035-03-10T09:00', '2035-03-10T10:00', 0, ?, 'local', ?, ?)
  `).run(title, userId, accountId, calendarUrl).lastInsertRowid);
}

const event = (id) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
const selection = (url) => db.prepare('SELECT * FROM caldav_calendar_selection WHERE calendar_url = ?').get(url);
const listSelection = (url) => db.prepare('SELECT * FROM caldav_reminder_selection WHERE list_url = ?').get(url);
const puts = () => dav.seen('PUT');

// ── Die Rechte selbst ───────────────────────────────────────────────────────

test('die Auflistung nennt je Collection, ob sie neue Eintraege annimmt', async () => {
  reset();
  const rw = dav.addCollection('rw', { privileges: RW });
  const ro = dav.addCollection('ro', { privileges: RO });
  const all = dav.addCollection('all', { privileges: ['all'] });
  const silent = dav.addCollection('silent');
  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  const byUrl = new Map((await client.fetchCalendars()).map((cal) => [cal.url, cal.writable]));
  assert.equal(byUrl.get(rw), true);
  assert.equal(byUrl.get(ro), false);
  assert.equal(byUrl.get(all), true);
  assert.equal(byUrl.get(silent), null, 'ohne Angabe des Servers: unbekannt');
});

test('write-content allein erlaubt kein Anlegen, bind schon', () => {
  assert.equal(collectionWritable({ privilege: [{ read: {} }, { writeContent: {} }] }), false);
  assert.equal(collectionWritable({ privilege: { bind: {} } }), true);
  assert.equal(collectionWritable(undefined), null);
  assert.equal(collectionWritable({}), null);
});

// ── Termine ─────────────────────────────────────────────────────────────────

test('Termine: die Auswahl merkt sich die Rechte, die Zielauswahl bietet nur beschreibbare an', async () => {
  reset();
  const rw = dav.addCollection('family', { name: 'Familie', privileges: RW });
  const ro = dav.addCollection('shared', { name: 'Geteilt', privileges: RO });
  const silent = dav.addCollection('old', { name: 'Alt' });
  await caldavSync.getCalendars(accountId, { refresh: true });
  assert.equal(selection(rw).writable, 1);
  assert.equal(selection(ro).writable, 0);
  assert.equal(selection(silent).writable, null);
  db.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();

  // Lesen bleibt: der nur lesbare Kalender ist in der Auswahl und abrufbar.
  const listed = await caldavSync.getCalendars(accountId);
  assert.deepEqual(listed.map((cal) => [cal.calendarName, cal.writable]).sort(),
    [['Alt', null], ['Familie', true], ['Geteilt', false]]);

  const res = await api('GET', '/calendar/sync-targets');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.caldav.map((tgt) => tgt.calendarUrl).sort(), [rw, silent].sort());
});

test('Termine: ein nur lesbarer Kalender wird als neues Ziel abgewiesen, ein gespeichertes bleibt bearbeitbar', async () => {
  reset();
  const rw = dav.addCollection('family', { privileges: RW });
  const ro = dav.addCollection('shared', { privileges: RO });
  await caldavSync.getCalendars(accountId, { refresh: true });
  db.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();

  const refused = await api('POST', '/calendar', {
    title: 'Zahnarzt', start_datetime: '2035-06-10T10:00', end_datetime: '2035-06-10T11:00',
    target_caldav_account_id: accountId, target_caldav_calendar_url: ro,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /does not accept new events/);

  const ok = await api('POST', '/calendar', {
    title: 'Zahnarzt', start_datetime: '2035-06-10T10:00', end_datetime: '2035-06-10T11:00',
    target_caldav_account_id: accountId, target_caldav_calendar_url: rw,
  });
  assert.equal(ok.status, 201);

  // Ein Ziel, das erst NACH der Wahl nur lesbar wurde, verhindert keine
  // Bearbeitung des Termins.
  const waiting = localEvent(ro, 'Schon gewaehlt');
  const edit = await api('PUT', `/calendar/${waiting}`, {
    title: 'Umbenannt', target_caldav_account_id: accountId, target_caldav_calendar_url: ro,
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

test('Termine: der Lauf schickt nichts an einen nur lesbaren Kalender, das Ziel bleibt und wird gezaehlt', async () => {
  reset();
  const ro = dav.addCollection('shared', { name: 'Geteilt', privileges: RO });
  const rw = dav.addCollection('family', { name: 'Familie', privileges: RW });
  await caldavSync.getCalendars(accountId, { refresh: true });
  db.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();
  const stuck = localEvent(ro, 'Wartet');
  const goes = localEvent(rw, 'Geht hinauf');

  await caldavSync.sync();

  assert.equal(puts().filter((r) => r.path.includes('/shared/')).length, 0, 'kein PUT in den nur lesbaren Kalender');
  assert.equal(event(goes).external_source, 'caldav', 'der beschreibbare Kalender nimmt an');
  const row = event(stuck);
  assert.equal(row.external_source, 'local');
  assert.equal(row.target_caldav_calendar_url, ro, 'das Ziel wird nicht still geleert');

  const listed = await caldavSync.getCalendars(accountId);
  const shared = listed.find((cal) => cal.calendarUrl === ro);
  assert.equal(shared.writable, false);
  assert.equal(shared.waitingUploads, 1);
});

test('Termine: jeder Lauf frischt die Rechte auf', async () => {
  reset();
  const cal = dav.addCollection('family', { privileges: RW });
  await caldavSync.getCalendars(accountId, { refresh: true });
  db.prepare('UPDATE caldav_calendar_selection SET enabled = 1').run();
  assert.equal(selection(cal).writable, 1);
  dav.reset();
  dav.addCollection('family', { privileges: RO });
  await caldavSync.sync();
  assert.equal(selection(cal).writable, 0);
});

// ── Erinnerungslisten (Aufgaben, Einkauf) ────────────────────────────────────

test('Aufgaben: nur beschreibbare Listen sind Ziel, der Lauf laesst nur lesbare in Ruhe', async () => {
  reset();
  const rw = dav.addCollection('todo', { name: 'Erinnerungen', components: ['VTODO'], privileges: RW });
  const ro = dav.addCollection('shared-todo', { name: 'Geteilt', components: ['VTODO'], privileges: RO });
  await remindersSync.getReminderLists(accountId, { refresh: true });
  assert.equal(listSelection(rw).writable, 1);
  assert.equal(listSelection(ro).writable, 0);
  db.prepare("UPDATE caldav_reminder_selection SET enabled = 1, target_module = 'tasks'").run();

  const targets = await api('GET', '/tasks/sync-targets');
  assert.equal(targets.status, 200);
  assert.deepEqual(targets.body.data.caldav.map((tgt) => tgt.listUrl), [rw]);

  const refused = await api('POST', '/tasks', { title: 'Neu', sync_target: `caldav:${accountId}|${ro}` });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /does not accept new entries/);

  // Gespeichert, bevor die Liste nur lesbar wurde: bleibt, wartet, wird gezaehlt.
  const taskId = Number(db.prepare(`
    INSERT INTO tasks (title, created_by, target_caldav_account_id, target_caldav_list_url)
    VALUES ('Wartet', ?, ?, ?)
  `).run(userId, accountId, ro).lastInsertRowid);
  const edit = await api('PUT', `/tasks/${taskId}`, { title: 'Wartet noch', sync_target: `caldav:${accountId}|${ro}` });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  await remindersSync.sync();
  assert.equal(puts().filter((r) => r.path.includes('/shared-todo/')).length, 0, 'kein PUT in die nur lesbare Liste');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.external_source, 'local');
  assert.equal(task.target_caldav_list_url, ro, 'das Ziel wird nicht still geleert');

  const lists = await remindersSync.getReminderLists(accountId);
  const shared = lists.find((l) => l.listUrl === ro);
  assert.equal(shared.writable, false);
  assert.equal(shared.waitingUploads, 1);
});

test('Einkauf: eine nur lesbare Liste wird gelesen, neue Artikel warten lokal', async () => {
  reset();
  const ro = dav.addCollection('shop', { name: 'Einkauf', components: ['VTODO'], privileges: RO });
  await remindersSync.getReminderLists(accountId, { refresh: true });
  const listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Einkauf', ?) RETURNING id").get(userId).id;
  db.prepare(`UPDATE caldav_reminder_selection SET enabled = 1, target_module = 'shopping', target_list_id = ?`).run(listId);
  db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Milch')").run(listId);

  await remindersSync.sync();
  assert.equal(puts().length, 0, 'kein PUT in die nur lesbare Liste');
  const lists = await remindersSync.getReminderLists(accountId);
  assert.equal(lists[0].writable, false);
  assert.equal(lists[0].waitingUploads, 1);
});

// ── iCloud (alte Apple-Verbindung) ──────────────────────────────────────────

test('iCloud: lokale Termine gehen in den ersten beschreibbaren Terminkalender', async () => {
  reset();
  dav.addCollection('a-shared', { name: 'Geteilt', privileges: RO });
  dav.addCollection('b-reminders', { name: 'Erinnerungen', components: ['VTODO'], privileges: RW });
  const home = dav.addCollection('c-home', { name: 'Zuhause', privileges: RW });
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
    VALUES ('Lokal', '2035-03-10T09:00', '2035-03-10T10:00', 0, ?, 'local')
  `).run(userId).lastInsertRowid);

  await appleCalendar.sync();

  const sent = puts().map((r) => r.path);
  assert.ok(sent.length > 0, 'ein Upload ging hinaus');
  assert.ok(sent.every((path) => path.startsWith('/cal/c-home/')), `nur in den beschreibbaren Kalender: ${sent}`);
  const row = event(id);
  assert.equal(row.external_source, 'apple');
  assert.ok(row.external_object_url.startsWith(home));
});

test('iCloud: ohne beschreibbaren Terminkalender bleibt der Termin lokal', async () => {
  reset();
  dav.addCollection('a-shared', { name: 'Geteilt', privileges: RO });
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  const id = Number(db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, external_source)
    VALUES ('Lokal', '2035-03-10T09:00', '2035-03-10T10:00', 0, ?, 'local')
  `).run(userId).lastInsertRowid);

  await appleCalendar.sync();

  assert.equal(puts().length, 0);
  assert.equal(event(id).external_source, 'local');
});
