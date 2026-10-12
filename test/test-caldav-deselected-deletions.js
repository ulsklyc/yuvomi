/**
 * Test: ein Löschauftrag für einen abgewählten Kalender (oder eine abgewählte
 * Liste) wartet, statt dort zu löschen oder für immer liegen zu bleiben (#1884).
 *
 * Gemessen vor dem Fix, mit echtem tsdav gegen `test/caldav-fake-server.js`:
 *
 *   - Termin, Kalender abgewählt, Auftrag mit Adresse: der Lauf übersprang ihn
 *     (sechs Läufe, `attempts` 0, kein DELETE), der SOFORTVERSUCH schickte das
 *     DELETE trotzdem - in einen Kalender, in dem Yuvomi nichts löschen soll.
 *     Lehnte der Server ab, zählte jede Absage; nach fünf war der Auftrag
 *     aufgegeben, und der gelöschte Termin kam beim Wieder-Einschalten zurück.
 *   - derselbe Auftrag ohne Adresse, oder in einem Konto ganz ohne Auswahl:
 *     wartete ohne Zähler und ohne Zeile im Log für immer - auch nachdem es
 *     den Kalender auf dem Server längst nicht mehr gab.
 *   - Aufgabe oder Einkaufsposten, Liste abgewählt: das DELETE ging hinaus,
 *     im Lauf wie im Sofortversuch. Der Auftrag kennt seine Liste nicht.
 *
 * Die Regel: Abschalten heisst nicht aufräumen. Solange der Platz abgewählt
 * ist, geht dorthin kein DELETE; der Auftrag bleibt stehen, zählt keinen
 * Versuch und läuft, sobald der Platz wieder eingeschaltet ist. Endgültig
 * fällt er, wenn es den Platz nicht mehr gibt: der Server nennt den Kalender
 * nicht mehr, oder das Konto wird gelöscht.
 *
 * Jeder Fall läuft ohne Client-Attrappe: echte Dienste, echter Client, echtes
 * HTTP auf 127.0.0.1.
 *
 * Ausführen: node --experimental-sqlite --test test/test-caldav-deselected-deletions.js
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
const outbound      = await import('../server/services/calendar-outbound.js');
const todoOutbound  = await import('../server/services/caldav-todo-outbound.js');
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const caldavSync    = await import('../server/services/caldav-sync.js');
const appleCalendar = await import('../server/services/apple-calendar.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

// ── Fixtures ────────────────────────────────────────────────────────────────────

let accountId;

function reset() {
  for (const table of [
    'caldav_upload_attempts', 'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_todo_pending_deletions', 'tasks',
    'shopping_items', 'shopping_lists', 'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  appleCalendar.clearCredentials();
  dav.reset();
  accountId = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Fake', ?, 'u', 'p')
  `).run(dav.url).lastInsertRowid);
}

function ics(component, uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    `BEGIN:${component}`, `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    ...(component === 'VEVENT'
      ? ['DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z']
      : ['STATUS:NEEDS-ACTION']),
    `END:${component}`, 'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Ein Kalender mit EINEM fremden Termin darin. Der Nachbar ist nicht
 * Dekoration: ein Kalender, der gar nichts liefert, sieht für mehrere Guards
 * wie ein gescheiterter Abruf aus.
 */
function calendar(slug, { enabled = true } = {}) {
  const url = dav.addCollection(slug, { name: slug });
  dav.putObject(url, `neighbour-${slug}.ics`, ics('VEVENT', `neighbour-${slug}@test`, 'Nachbar'));
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, ?, '#112233', ?)
  `).run(accountId, url, slug, enabled ? 1 : 0);
  return url;
}

function todoList(slug, { module = 'tasks', enabled = true } = {}) {
  const url = dav.addCollection(slug, { name: slug, components: ['VTODO'] });
  dav.putObject(url, `neighbour-${slug}.ics`, ics('VTODO', `neighbour-${slug}@test`, 'Nachbar'));
  let listId = null;
  if (module === 'shopping') {
    listId = db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES (?, 1) RETURNING id").get(slug).id;
  }
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled, target_list_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, url, slug, module, enabled ? 1 : 0, listId);
  return url;
}

const UID = 'gone@test';

/**
 * Zwei eingeschaltete Kalender, in `a` der Termin, den der Nutzer gleich
 * löscht. Ein echter Lauf spiegelt ihn; die Zeile kommt so zurück, wie die
 * Löschroute sie vorfindet.
 */
async function mirroredEvent({ withAddress = true } = {}) {
  reset();
  const a = calendar('a');
  const b = calendar('b');
  const object = dav.putObject(a, 'gone.ics', ics('VEVENT', UID, 'Weg damit'));
  await caldavSync.sync();
  const row = db.prepare('SELECT * FROM calendar_events WHERE external_calendar_id = ?').get(UID);
  assert.ok(row, 'der Lauf hat den Termin nicht gespiegelt - der Fall misst etwas anderes');
  if (!withAddress) {
    db.prepare('UPDATE calendar_events SET external_object_url = NULL WHERE id = ?').run(row.id);
    row.external_object_url = null;
  }
  return { a, b, object, row };
}

/** Wie die Löschroute: erst vormerken, dann die Zeile entfernen. */
function deleteInYuvomi(row) {
  assert.equal(outbound.queueEventDeletion(row), true, 'die Löschung wurde nicht vorgemerkt');
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(row.id);
}

const select = (url, enabled) => caldavSync.updateCalendarSelection(accountId, url, enabled);
const eventOrders = () => db.prepare(
  'SELECT calendar_external_id, event_external_id, object_url, attempts, etag FROM calendar_pending_deletions ORDER BY id'
).all();
const todoOrders = () => db.prepare(
  'SELECT module, uid, object_url, attempts FROM caldav_todo_pending_deletions ORDER BY id'
).all();
const eventRows = (uid = UID) => db.prepare('SELECT id FROM calendar_events WHERE external_calendar_id = ?').all(uid);
const deletes = () => dav.seen('DELETE').length;

/** Was der Logger auf `level` ausgibt, während `fn` läuft. */
async function capture(level, fn) {
  const lines = [];
  const original = console[level];
  console[level] = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console[level] = original; }
  return lines;
}

// ── Termine ─────────────────────────────────────────────────────────────────────

test('Abgewählter Kalender: weder Lauf noch Sofortversuch löschen dort, der Auftrag altert nicht', async () => {
  const { a, row } = await mirroredEvent();
  select(a, false);
  deleteInYuvomi(row);
  // Lehnte der Server ab, zählte vorher jede Absage des Sofortversuchs.
  dav.refuse({ method: 'DELETE', status: 403 });

  for (let i = 0; i < 6; i++) await caldavSync.sync();
  for (let i = 0; i < 6; i++) await caldavSync.flushOutbound();

  assert.equal(deletes(), 0, 'in einen abgewählten Kalender ging ein DELETE');
  assert.equal(eventOrders().length, 1, 'der Auftrag ist gefallen, obwohl sein Kalender nur abgewählt ist');
  assert.equal(eventOrders()[0].attempts, 0, 'ein wartender Auftrag hat Versuche verbraucht');
  assert.ok(dav.getObject(a, 'gone.ics'), 'das Objekt im abgewählten Kalender ist fort');
});

test('Wieder eingeschaltet: der wartende Auftrag läuft, das Objekt ist fort, der Termin kommt nicht zurück', async () => {
  const { a, row } = await mirroredEvent();
  select(a, false);
  deleteInYuvomi(row);
  dav.refuse({ method: 'DELETE', status: 403 });
  for (let i = 0; i < 6; i++) await caldavSync.flushOutbound();
  for (let i = 0; i < 2; i++) await caldavSync.sync();
  dav.allowAll();

  select(a, true);
  await caldavSync.sync();

  assert.equal(dav.getObject(a, 'gone.ics'), null, 'das Objekt liegt nach dem Wieder-Einschalten noch auf dem Server');
  assert.deepEqual(eventOrders(), [], 'der Auftrag steht nach seinem DELETE noch');
  assert.deepEqual(eventRows(), [], 'der gelöschte Termin ist als Import zurückgekommen');

  await caldavSync.sync();
  assert.deepEqual(eventRows(), [], 'der gelöschte Termin kam im Folgelauf zurück');
});

test('Wieder eingeschaltet, Auftrag ohne gespeicherte Adresse: der Lauf findet das Objekt über seinen Abruf', async () => {
  const { a, row } = await mirroredEvent({ withAddress: false });
  select(a, false);
  deleteInYuvomi(row);
  for (let i = 0; i < 3; i++) await caldavSync.sync();
  await caldavSync.flushOutbound();
  assert.equal(deletes(), 0);
  assert.equal(eventOrders()[0]?.attempts, 0);

  select(a, true);
  await caldavSync.sync();
  assert.equal(dav.getObject(a, 'gone.ics'), null);
  assert.deepEqual(eventOrders(), []);
  assert.deepEqual(eventRows(), []);
});

test('Sofortversuch nach dem Wieder-Einschalten: das DELETE geht hinaus', async () => {
  const { a, row } = await mirroredEvent();
  select(a, false);
  deleteInYuvomi(row);
  const before = dav.requests.length;
  await caldavSync.flushOutbound();
  assert.equal(deletes(), 0);
  assert.equal(dav.requests.length, before, 'der Sofortversuch hat für einen wartenden Auftrag den Server angesprochen');

  select(a, true);
  const res = await caldavSync.flushOutbound();
  assert.equal(res.deleted, 1, 'der Sofortversuch hat den Auftrag eines eingeschalteten Kalenders liegen lassen');
  assert.equal(dav.getObject(a, 'gone.ics'), null);
});

test('Die Auswahl führt den Kalender ohne Schlussstrich: eingeschaltet bleibt eingeschaltet', async () => {
  const { a, row } = await mirroredEvent();
  deleteInYuvomi(row);
  db.prepare('UPDATE caldav_calendar_selection SET calendar_url = ? WHERE calendar_url = ?').run(a.replace(/\/$/, ''), a);
  const res = await caldavSync.flushOutbound();
  assert.equal(res.deleted, 1, 'ein eingeschalteter Kalender galt wegen seiner Schreibweise als abgewählt');
});

test('Während des Durchgangs abgewählt: der Auftrag davor geht hinaus, der für den gerade abgewählten Kalender nicht', async () => {
  reset();
  const a = calendar('a');
  const b = calendar('b');
  dav.putObject(a, 'first.ics', ics('VEVENT', 'first@test', 'Erster'));
  dav.putObject(b, 'second.ics', ics('VEVENT', 'second@test', 'Zweiter'));
  await caldavSync.sync();
  for (const uid of ['first@test', 'second@test']) {
    deleteInYuvomi(db.prepare('SELECT * FROM calendar_events WHERE external_calendar_id = ?').get(uid));
  }
  // Der Nutzer wählt `b` ab, während das DELETE für `a` unterwegs ist.
  let switchedOff = false;
  dav.refuse({
    method: 'DELETE', status: 500,
    when: () => { if (!switchedOff) { switchedOff = true; select(b, false); } return false; },
  });

  await caldavSync.sync();

  assert.equal(switchedOff, true, 'kein DELETE kam an - der Fall misst nichts');
  assert.equal(dav.getObject(a, 'first.ics'), null, 'der Auftrag im eingeschalteten Kalender lief nicht');
  assert.ok(dav.getObject(b, 'second.ics'), 'in den gerade abgewählten Kalender ging noch ein DELETE');
  assert.deepEqual(eventOrders().map((o) => [o.event_external_id, o.attempts]), [['second@test', 0]]);
});

test('Bedingter Auftrag (ETag) im abgewählten Kalender: wartet, und läuft danach mit seiner Bedingung', async () => {
  reset();
  const a = calendar('a');
  calendar('b');
  const rest = dav.putObject(a, 'rest.ics', ics('VEVENT', 'moved@test', 'Rest eines Umzugs'));
  outbound.queueDeletion({
    source: 'caldav', calendarExternalId: a, eventExternalId: 'moved@test',
    objectUrl: rest.url, accountId, etag: rest.etag,
  });
  select(a, false);

  await caldavSync.flushOutbound();
  await caldavSync.sync();
  assert.equal(deletes(), 0, 'ein bedingter Auftrag ging in den abgewählten Kalender');
  assert.equal(eventOrders()[0]?.etag, rest.etag, 'der wartende Auftrag hat seine Bedingung verloren');

  select(a, true);
  await caldavSync.sync();
  const sent = dav.seen('DELETE');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['if-match'], rest.etag, 'das DELETE ging ohne die Bedingung des Auftrags');
  assert.equal(dav.getObject(a, 'rest.ics'), null);
  assert.deepEqual(eventOrders(), []);
});

test('Bedingter Auftrag, das Objekt wurde während der Abwahl geändert: beim Wieder-Einschalten fällt er, das Objekt bleibt', async () => {
  reset();
  const a = calendar('a');
  calendar('b');
  const rest = dav.putObject(a, 'rest.ics', ics('VEVENT', 'moved@test', 'Rest eines Umzugs'));
  outbound.queueDeletion({
    source: 'caldav', calendarExternalId: a, eventExternalId: 'moved@test',
    objectUrl: rest.url, accountId, etag: rest.etag,
  });
  select(a, false);
  await caldavSync.sync();
  dav.putObject(a, 'rest.ics', ics('VEVENT', 'moved@test', 'Auf dem Handy zurückgelegt'));

  select(a, true);
  await caldavSync.sync();
  assert.equal(deletes(), 0);
  assert.ok(dav.getObject(a, 'rest.ics'), 'ein geänderter Termin wurde gelöscht');
  assert.deepEqual(eventOrders(), []);
  assert.equal(eventRows('moved@test').length, 1, 'der zurückgelegte Termin wurde nicht übernommen');
});

test('Abgewählt und auf dem Server gelöscht: der Auftrag fällt ohne Anfrage', async () => {
  const { a, row } = await mirroredEvent({ withAddress: false });
  select(a, false);
  deleteInYuvomi(row);
  await caldavSync.sync();
  assert.equal(eventOrders().length, 1, 'solange es den Kalender gibt, bleibt der Auftrag');

  dav.removeCollection(a);
  await caldavSync.sync();
  assert.deepEqual(eventOrders(), [], 'der Auftrag wartet auf einen Kalender, den es nicht mehr gibt');
  assert.equal(deletes(), 0);
});

test('Konto ganz ohne Auswahl: der Auftrag wartet, und fällt, sobald es den Kalender nicht mehr gibt', async () => {
  const { a, b, row } = await mirroredEvent();
  select(a, false);
  select(b, false);
  deleteInYuvomi(row);

  for (let i = 0; i < 3; i++) await caldavSync.sync();
  await caldavSync.flushOutbound();
  assert.equal(deletes(), 0);
  assert.equal(eventOrders().length, 1);
  assert.equal(eventOrders()[0].attempts, 0);

  dav.removeCollection(a);
  await caldavSync.sync();
  assert.deepEqual(eventOrders(), [], 'in einem Konto ohne Auswahl wartet der Auftrag für immer');
});

test('Konto ohne Auswahl und ohne wartenden Auftrag: der Lauf fragt keine Auflistung ab', async () => {
  reset();
  calendar('a', { enabled: false });
  await caldavSync.sync();
  const home = dav.requests.filter((r) => r.method === 'PROPFIND' && r.path === '/cal/' && r.headers.depth === '1');
  assert.equal(home.length, 0, 'ein Konto ohne Auswahl und ohne Arbeit hat die Kalender aufgelistet');
});

test('Eingeschalteter Kalender verschwindet: er wird abgeschaltet, sein Auftrag fällt mit ihm', async () => {
  const { a, row } = await mirroredEvent({ withAddress: false });
  deleteInYuvomi(row);
  dav.removeCollection(a);

  await caldavSync.sync();
  assert.deepEqual(eventOrders(), [], 'der Auftrag eines verschwundenen Kalenders wartet weiter');
  assert.equal(
    db.prepare('SELECT enabled FROM caldav_calendar_selection WHERE calendar_url = ?').get(a).enabled, 0
  );
});

test('Die Auflistung nennt den Kalender ohne Schlussstrich: der Auftrag gilt nicht als verwaist', async () => {
  const { a, row } = await mirroredEvent({ withAddress: false });
  select(a, false);
  deleteInYuvomi(row);
  assert.equal(outbound.dropDeletionsOfMissingCalendars('caldav', {
    accountId, listedUrls: [a.replace(/\/$/, '')],
  }), 0);
  assert.equal(eventOrders().length, 1);
});

test('Unvollständige Auflistung (nur die Home-Collection): kein wartender Auftrag fällt', async () => {
  const { a, b, row } = await mirroredEvent({ withAddress: false });
  select(a, false);
  deleteInYuvomi(row);
  const listing = () => dav.refuse({
    method: 'PROPFIND', path: '/cal/', status: 207,
    contentType: 'application/xml; charset=utf-8', body: dav.homeOnlyListing(),
  });

  listing();
  await caldavSync.sync();
  assert.equal(eventOrders().length, 1, 'eine leere Auflistung hat den Auftrag abgeräumt');

  // Auch im Konto ganz ohne Auswahl.
  dav.allowAll();
  select(b, false);
  listing();
  await caldavSync.sync();
  assert.equal(eventOrders().length, 1, 'eine leere Auflistung hat den Auftrag eines Kontos ohne Auswahl abgeräumt');
});

test('Der Abruf des eingeschalteten Kalenders scheitert: der Auftrag bleibt und zählt nicht', async () => {
  const { a, row } = await mirroredEvent();
  deleteInYuvomi(row);
  dav.refuse({ method: 'REPORT', path: new URL(a).pathname, status: 500 });
  const errors = await capture('error', async () => {
    for (let i = 0; i < 3; i++) await caldavSync.sync();
  });
  assert.equal(errors.filter((line) => line.includes('Failed to fetch calendar objects')).length, 3);
  assert.equal(eventOrders().length, 1);
  assert.equal(eventOrders()[0].attempts, 0);
  assert.equal(deletes(), 0);
});

test('Konto gelöscht: seine wartenden Aufträge fallen mit ihm', async () => {
  const { a, row } = await mirroredEvent();
  select(a, false);
  deleteInYuvomi(row);
  assert.equal(eventOrders().length, 1);
  caldavSync.deleteAccount(accountId);
  assert.deepEqual(eventOrders(), []);
});

test('Die Auswahl eines ANDEREN Kontos zählt nicht: dessen eingeschalteter Kalender gibt den Auftrag nicht frei', async () => {
  const { a, row } = await mirroredEvent();
  select(a, false);
  deleteInYuvomi(row);
  const other = Number(db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Zweites', ?, 'u2', 'p')
  `).run(dav.url).lastInsertRowid);
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'a', '#112233', 1)
  `).run(other, a);

  await caldavSync.sync();
  await caldavSync.flushOutbound();
  assert.equal(deletes(), 0, 'die Auswahl eines anderen Kontos hat den Auftrag freigegeben');
  assert.equal(eventOrders().length, 1);
});

test('Der Lauf meldet wartende Aufträge einmal, nicht bei jedem Lauf, und wieder, wenn sich die Zahl ändert', async () => {
  reset();
  const a = calendar('a');
  calendar('b');
  dav.putObject(a, 'one.ics', ics('VEVENT', 'one@test', 'Eins'));
  dav.putObject(a, 'two.ics', ics('VEVENT', 'two@test', 'Zwei'));
  await caldavSync.sync();
  select(a, false);
  deleteInYuvomi(db.prepare("SELECT * FROM calendar_events WHERE external_calendar_id = 'one@test'").get());
  const waiting = (lines) => lines.filter((line) => line.includes('wait for a calendar that is not selected'));

  const first = waiting(await capture('info', () => caldavSync.sync()));
  assert.equal(first.length, 1, 'der wartende Auftrag steht in keiner Zeile');
  assert.match(first[0], /1 pending deletion/);
  assert.equal(waiting(await capture('info', () => caldavSync.sync())).length, 0, 'dieselbe Meldung bei jedem Lauf');

  deleteInYuvomi(db.prepare("SELECT * FROM calendar_events WHERE external_calendar_id = 'two@test'").get());
  const changed = waiting(await capture('info', () => caldavSync.sync()));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /2 pending deletion/);
});

// ── iCloud ──────────────────────────────────────────────────────────────────────

test('iCloud: ein Auftrag für einen Kalender, den die Auflistung nicht mehr nennt, fällt', async () => {
  reset();
  const kept = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(kept, 'neighbour.ics', ics('VEVENT', 'apple-neighbour@test', 'Nachbar'));
  const gone = dav.addCollection('old', { name: 'Alt' });
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  try {
    outbound.queueDeletion({ source: 'apple', calendarExternalId: gone, eventExternalId: 'apple-gone@test' });
    // Aufgelistet, aber nicht lesbar: so bleibt ein Auftrag in iCloud liegen.
    dav.refuse({ method: 'REPORT', path: new URL(gone).pathname, status: 500 });
    await capture('warn', () => appleCalendar.sync());
    assert.equal(eventOrders().length, 1, 'solange es den Kalender gibt, bleibt der Auftrag');

    dav.allowAll();
    dav.removeCollection(gone);
    await appleCalendar.sync();
    assert.deepEqual(eventOrders(), [], 'der Auftrag wartet auf einen Kalender, den es in iCloud nicht mehr gibt');
    assert.equal(deletes(), 0);
  } finally {
    appleCalendar.clearCredentials();
  }
});

test('iCloud: der Abruf eines aufgelisteten Kalenders scheitert - sein Auftrag bleibt', async () => {
  reset();
  const kept = dav.addCollection('icloud', { name: 'iCloud' });
  dav.putObject(kept, 'neighbour.ics', ics('VEVENT', 'apple-neighbour@test', 'Nachbar'));
  const shaky = dav.addCollection('shaky', { name: 'Wackelig' });
  appleCalendar.saveCredentials(dav.url, 'u', 'p');
  try {
    outbound.queueDeletion({ source: 'apple', calendarExternalId: shaky, eventExternalId: 'apple-wait@test' });
    dav.refuse({ method: 'REPORT', path: new URL(shaky).pathname, status: 500 });
    await capture('warn', () => appleCalendar.sync());
    assert.equal(eventOrders().length, 1);
    assert.equal(eventOrders()[0].attempts, 0);
  } finally {
    appleCalendar.clearCredentials();
  }
});

// ── Aufgaben und Einkauf (VTODO) ────────────────────────────────────────────────

const TODO_UID = 'todo-gone@test';

/** Zwei eingeschaltete Listen eines Moduls, in `a` der Eintrag, der gleich gelöscht wird. */
async function mirroredTodo(module = 'tasks') {
  reset();
  const a = todoList('ta', { module });
  const b = todoList('tb', { module });
  dav.putObject(a, 'gone.ics', ics('VTODO', TODO_UID, 'Weg damit'));
  await remindersSync.sync();
  const table = module === 'shopping' ? 'shopping_items' : 'tasks';
  const row = db.prepare(`SELECT * FROM ${table} WHERE external_uid = ?`).get(TODO_UID);
  assert.ok(row, 'der Lauf hat den Eintrag nicht gespiegelt - der Fall misst etwas anderes');
  return { a, b, row, table };
}

function deleteTodoInYuvomi(module, table, row) {
  assert.equal(todoOutbound.queueTodoDeletion(module, row), true, 'die Löschung wurde nicht vorgemerkt');
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
}

const selectList = (url, enabled) => remindersSync.updateReminderSelection(accountId, url, { enabled });

for (const module of ['tasks', 'shopping']) {
  test(`${module}: abgewählte Liste - weder Lauf noch Sofortversuch löschen dort, der Auftrag altert nicht`, async () => {
    const { a, row, table } = await mirroredTodo(module);
    selectList(a, false);
    deleteTodoInYuvomi(module, table, row);
    dav.refuse({ method: 'DELETE', status: 403 });

    for (let i = 0; i < 6; i++) await remindersSync.sync();
    for (let i = 0; i < 6; i++) await todoOutbound.flushOutbound();

    assert.equal(deletes(), 0, 'in eine abgewählte Liste ging ein DELETE');
    assert.equal(todoOrders().length, 1, 'der Auftrag ist gefallen, obwohl seine Liste nur abgewählt ist');
    assert.equal(todoOrders()[0].attempts, 0, 'ein wartender Auftrag hat Versuche verbraucht');
    assert.ok(dav.getObject(a, 'gone.ics'), 'das Objekt in der abgewählten Liste ist fort');
  });

  test(`${module}: wieder eingeschaltet - der Auftrag läuft, der Eintrag kommt nicht zurück`, async () => {
    const { a, row, table } = await mirroredTodo(module);
    selectList(a, false);
    deleteTodoInYuvomi(module, table, row);
    await remindersSync.sync();
    await todoOutbound.flushOutbound();
    assert.equal(deletes(), 0);

    selectList(a, true);
    await remindersSync.sync();
    assert.equal(dav.getObject(a, 'gone.ics'), null, 'das Objekt liegt nach dem Wieder-Einschalten noch auf dem Server');
    assert.deepEqual(todoOrders(), []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE external_uid = ?`).get(TODO_UID).c, 0,
      'der gelöschte Eintrag ist als Import zurückgekommen');
    await remindersSync.sync();
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE external_uid = ?`).get(TODO_UID).c, 0);
  });
}

test('tasks: Konto ohne eingeschaltete Liste - der Sofortversuch baut keinen Client auf, der Lauf wartet', async () => {
  const { a, b, row, table } = await mirroredTodo();
  selectList(a, false);
  selectList(b, false);
  deleteTodoInYuvomi('tasks', table, row);
  const before = dav.requests.length;

  await todoOutbound.flushOutbound();
  assert.equal(dav.requests.length, before, 'der Sofortversuch hat für einen wartenden Auftrag den Server angesprochen');

  for (let i = 0; i < 3; i++) await remindersSync.sync();
  assert.equal(deletes(), 0);
  assert.equal(todoOrders().length, 1);

  dav.removeCollection(a);
  await remindersSync.sync();
  assert.deepEqual(todoOrders(), [], 'in einem Konto ohne Auswahl wartet der Auftrag für immer');
  assert.equal(deletes(), 0);
});

test('tasks: während des Durchgangs abgewählt - in die gerade abgewählte Liste geht kein DELETE mehr', async () => {
  reset();
  const a = todoList('ta');
  const b = todoList('tb');
  dav.putObject(a, 'first.ics', ics('VTODO', 'todo-first@test', 'Erster'));
  dav.putObject(b, 'second.ics', ics('VTODO', 'todo-second@test', 'Zweiter'));
  await remindersSync.sync();
  for (const uid of ['todo-first@test', 'todo-second@test']) {
    deleteTodoInYuvomi('tasks', 'tasks', db.prepare('SELECT * FROM tasks WHERE external_uid = ?').get(uid));
  }
  let switchedOff = false;
  dav.refuse({
    method: 'DELETE', status: 500,
    when: () => { if (!switchedOff) { switchedOff = true; selectList(b, false); } return false; },
  });

  await remindersSync.sync();

  assert.equal(switchedOff, true, 'kein DELETE kam an - der Fall misst nichts');
  assert.equal(dav.getObject(a, 'first.ics'), null, 'der Auftrag in der eingeschalteten Liste lief nicht');
  assert.ok(dav.getObject(b, 'second.ics'), 'in die gerade abgewählte Liste ging noch ein DELETE');
  assert.deepEqual(todoOrders().map((o) => [o.uid, o.attempts]), [['todo-second@test', 0]]);
});

test('tasks: Sofortversuch mit anderer Arbeit - die abgewählte Liste wird dabei nicht angesprochen', async () => {
  const { a, b, row, table } = await mirroredTodo();
  dav.putObject(b, 'other.ics', ics('VTODO', 'todo-other@test', 'Anderer'));
  await remindersSync.sync();
  selectList(a, false);
  deleteTodoInYuvomi('tasks', table, row);
  deleteTodoInYuvomi('tasks', table, db.prepare("SELECT * FROM tasks WHERE external_uid = 'todo-other@test'").get());
  const before = dav.requests.length;

  await todoOutbound.flushOutbound();

  assert.equal(dav.getObject(b, 'other.ics'), null, 'der Auftrag der eingeschalteten Liste lief nicht');
  const touched = dav.requests.slice(before).filter((r) => r.path.startsWith(new URL(a).pathname));
  assert.deepEqual(touched.map((r) => `${r.method} ${r.path}`), [], 'der Sofortversuch hat die abgewählte Liste angesprochen');
  assert.equal(todoOrders().length, 1);
});

test('tasks: eine Liste, die die Auswahl nicht kennt, wird nicht als verschwunden beurteilt', async () => {
  const { a, b, row, table } = await mirroredTodo();
  deleteTodoInYuvomi('tasks', table, row);
  db.prepare('DELETE FROM caldav_reminder_selection WHERE list_url = ?').run(a);
  assert.equal(todoOutbound.dropDeletionsOfMissingLists(accountId, [b]), 0);
  assert.equal(todoOrders().length, 1);
  // Mit der Liste in der Auswahl und derselben Auflistung fällt er.
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'ta', 'tasks', 0)
  `).run(accountId, a.replace(/\/$/, ''));
  assert.equal(todoOutbound.dropDeletionsOfMissingLists(accountId, [`${a}`]), 0, 'aufgelistet, also nicht verschwunden');
  assert.equal(todoOutbound.dropDeletionsOfMissingLists(accountId, [b]), 1);
});

test('tasks: abgewählte Liste auf dem Server gelöscht - der Auftrag fällt ohne Anfrage', async () => {
  const { a, row, table } = await mirroredTodo();
  selectList(a, false);
  deleteTodoInYuvomi('tasks', table, row);
  await remindersSync.sync();
  assert.equal(todoOrders().length, 1, 'solange es die Liste gibt, bleibt der Auftrag');

  dav.removeCollection(a);
  await remindersSync.sync();
  assert.deepEqual(todoOrders(), []);
  assert.equal(deletes(), 0, 'für eine verschwundene Liste ging ein DELETE hinaus');
});

test('tasks: unvollständige Auflistung - kein wartender Auftrag fällt', async () => {
  const { a, b, row, table } = await mirroredTodo();
  selectList(a, false);
  selectList(b, false);
  deleteTodoInYuvomi('tasks', table, row);
  dav.refuse({
    method: 'PROPFIND', path: '/cal/', status: 207,
    contentType: 'application/xml; charset=utf-8', body: dav.homeOnlyListing(),
  });
  await remindersSync.sync();
  assert.equal(todoOrders().length, 1);
});

test('tasks: das Objekt liegt inzwischen in einer eingeschalteten Liste - dort wird es gelöscht', async () => {
  const { a, b, row, table } = await mirroredTodo();
  selectList(a, false);
  deleteTodoInYuvomi('tasks', table, row);
  // Auf einem anderen Gerät in die eingeschaltete Liste verschoben.
  const data = dav.getObject(a, 'gone.ics').data;
  dav.removeCollection(a);
  const again = dav.addCollection('ta', { name: 'ta', components: ['VTODO'] });
  assert.equal(again, a);
  dav.putObject(a, 'neighbour-ta.ics', ics('VTODO', 'neighbour-ta@test', 'Nachbar'));
  dav.putObject(b, 'moved.ics', data);

  await remindersSync.sync();
  assert.equal(dav.getObject(b, 'moved.ics'), null, 'das Objekt in der eingeschalteten Liste blieb stehen');
  assert.deepEqual(todoOrders(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE external_uid = ?').get(TODO_UID).c, 0);
});

test('tasks: die Auswahl führt die abgewählte Liste ohne Schlussstrich - sie bleibt abgewählt', async () => {
  const { a, row, table } = await mirroredTodo();
  selectList(a, false);
  db.prepare('UPDATE caldav_reminder_selection SET list_url = ? WHERE list_url = ?').run(a.replace(/\/$/, ''), a);
  deleteTodoInYuvomi('tasks', table, row);
  await todoOutbound.flushOutbound();
  assert.equal(deletes(), 0, 'eine abgewählte Liste galt wegen ihrer Schreibweise als unbekannt');
  assert.equal(todoOrders().length, 1);
});

test('tasks: eine Adresse ausserhalb jeder bekannten Liste wird nicht als abgewählt behandelt', async () => {
  const { a, row, table } = await mirroredTodo();
  deleteTodoInYuvomi('tasks', table, row);
  db.prepare('DELETE FROM caldav_reminder_selection WHERE list_url = ?').run(a);
  await todoOutbound.flushOutbound();
  assert.equal(dav.getObject(a, 'gone.ics'), null);
  assert.deepEqual(todoOrders(), []);
});

test('tasks: Konto gelöscht - seine wartenden Aufträge fallen mit ihm', async () => {
  const { a, row, table } = await mirroredTodo();
  selectList(a, false);
  deleteTodoInYuvomi('tasks', table, row);
  assert.equal(todoOrders().length, 1);
  caldavSync.deleteAccount(accountId);
  assert.deepEqual(todoOrders(), []);
});

test('tasks: der Lauf meldet wartende Aufträge einmal, nicht bei jedem Lauf', async () => {
  const { a, row, table } = await mirroredTodo();
  selectList(a, false);
  deleteTodoInYuvomi('tasks', table, row);
  const waiting = (lines) => lines.filter((line) => line.includes('wait for a reminder list that is not selected'));
  assert.equal(waiting(await capture('info', () => remindersSync.sync())).length, 1);
  assert.equal(waiting(await capture('info', () => remindersSync.sync())).length, 0);
});
