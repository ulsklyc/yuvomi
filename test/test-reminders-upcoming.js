/**
 * Modul: Kommende Erinnerungen (GET /api/v1/reminders/upcoming, Refs #255)
 * Zweck: Ein nativer Client plant Erinnerungen lokal ein und braucht dafuer, was
 *        NOCH NICHT faellig ist. `/pending` endet bei "jetzt", `GET /reminders`
 *        braucht eine konkrete Entitaet.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Das Fenster: beide Raender zaehlen, hoechstens 14 Tage, und "kommend"
 *      heisst nach jetzt - `/pending` und `/upcoming` teilen die Zeitachse ohne
 *      Luecke und ohne Doppel.
 *   2. `fires_at` ist der Zeitpunkt, auch wenn `remind_at` einen alten Offset
 *      traegt. Fenster, Sortierung und Limit lesen ihn ebenfalls, nicht den Text.
 *   3. Die Riegel von `/pending` gelten unveraendert: Besitz, Sichtbarkeit,
 *      Waisen, Token-Scopes, Mitgliedsrechte, Haushaltsschalter, Haushaltsansicht.
 *   4. `types` engt ein und erweitert nie, ein unbekannter Wert ist 400.
 *   5. Das Limit zaehlt, was der Aufrufer bekommt: eine Zeile eines abgeschalteten
 *      Moduls verdraengt keine sichtbare.
 *   6. Ein Device Credential liest die eigenen Zeilen, als Mitglied.
 *   7. Eine erledigte oder abgelegte Aufgabe fehlt, ihre Zeile bleibt. `/pending`
 *      laesst sie drin: was das Telefon spaeter feuert, fragt nicht mehr nach.
 *
 * WARUM DER ECHTE SERVER und nicht der Router auf einem Testport: das Gate fuer
 * Token-Scopes und das Device Credential stehen in server/index.js und
 * server/auth.js. Eine nachgestellte Middleware bewiese nur sich selbst.
 *
 * Die Uhr steht (nur `Date`), Fixtures rechnen von NOW aus. Laeuft unter
 * TZ=Europe/Berlin und TZ=UTC: ein `from` ohne Zone als Ortszeit gelesen fiele
 * nur unter der ersten auf.
 *
 * Ausfuehren: npm run test:reminders-upcoming
 */
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, cookieHeader } from './server-ready.js';
import { buildOpenApiSpec } from '../server/openapi.js';
import { tokenAccessRequirement } from '../server/scopes.js';

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / SECOND) * SECOND;

mock.timers.enable({ apis: ['Date'], now: NOW });
after(() => mock.timers.reset());

const { baseUrl: BASE } = await startTestServer({
  name: 'reminders-upcoming',
  env: { SESSION_SECRET: 'test-reminders-upcoming-secret-min32chars' },
});
const API = `${BASE}/api/v1`;
const db = (await import('../server/db.js')).get();

// Die volle Kette schaltet Inventar, Schichtplan und Muell ab. Diese Suite misst
// den Schalter gezielt und soll sonst nichts davon erben.
function setDisabledModules(modules) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(modules));
}
setDisabledModules([]);

// --------------------------------------------------------
// Fixtures
// --------------------------------------------------------
const json = { 'Content-Type': 'application/json' };

async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: json, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `Anmeldung ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

// Die Einrichtung geht nur, solange es kein Konto gibt: vor allen Fixtures.
const setup = await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: json,
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});
assert.ok(setup.ok, `Einrichtung: ${setup.status} ${await setup.text()}`);
const adminSession = await login('admin', 'adminpass123');
const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

const naive = (ms) => new Date(ms).toISOString().slice(0, 19);
const zulu = (ms) => `${naive(ms)}Z`;

let seq = 0;
function person(role = 'member') {
  seq += 1;
  return db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, '$2b$12$x', ?)`,
  ).run(`upcoming${seq}`, `Person ${seq}`, role).lastInsertRowid;
}

/** Ein echtes API-Token; `scopes: null` ist ungescopt, `[]` darf nichts. */
function tokenFor(userId, scopes = null) {
  const token = `yuvomi_upcoming_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, scopes)
    VALUES ('Upcoming', ?, 'yuvomi_upcom', ?, ?, ?)
  `).run(
    crypto.createHash('sha256').update(token).digest('hex'),
    userId, userId, scopes === null ? null : JSON.stringify(scopes),
  );
  return token;
}

function makeTask(owner, title = 'Steuer', visibility = 'all') {
  return db.prepare(
    `INSERT INTO tasks (title, category, status, created_by, visibility) VALUES (?, 'Sonstiges', 'open', ?, ?)`,
  ).run(title, owner, visibility).lastInsertRowid;
}
function makeEvent(owner, title = 'Zahnarzt') {
  return db.prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES (?, '2030-05-01T10:00', ?)`,
  ).run(title, owner).lastInsertRowid;
}
function makeSubscription(owner, name = 'Netflix') {
  return db.prepare(
    `INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, next_payment_date, created_by)
     VALUES (?, 9.99, 'EUR', 'monthly', '2030-06-01', ?)`,
  ).run(name, owner).lastInsertRowid;
}
function remind(owner, entityType, entityId, remindAt, dismissed = 0) {
  return db.prepare(
    `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, dismissed) VALUES (?, ?, ?, ?, ?)`,
  ).run(entityType, entityId, remindAt, owner, dismissed).lastInsertRowid;
}
const remindTask = (owner, remindAt, title) => remind(owner, 'task', makeTask(owner, title), remindAt);

function setModuleAccess(userId, moduleKey, access) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(String(userId), moduleKey, access);
}

async function raw(query, credential) {
  const res = await fetch(`${API}/reminders/upcoming${query}`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const windowQuery = (from, to, rest = '') => (
  `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${rest}`
);

/** Das Normalfenster: ab jetzt, die vollen 14 Tage. */
const upcoming = (credential, rest = '') => raw(windowQuery(zulu(NOW), zulu(NOW + 14 * DAY), rest), credential);

async function ids(credential, rest) {
  const res = await upcoming(credential, rest);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.map((row) => row.id);
}

async function pending(credential) {
  const res = await fetch(`${API}/reminders/pending`, { headers: { Authorization: `Bearer ${credential}` } });
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

// --------------------------------------------------------
// 1. Das Fenster
// --------------------------------------------------------
test('beide Fensterraender zaehlen, eine Sekunde daneben nicht', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const from = NOW + DAY;
  const to = NOW + 3 * DAY;

  remindTask(owner, naive(from - SECOND));
  const atFrom = remindTask(owner, naive(from));
  const inside = remindTask(owner, naive(from + HOUR));
  const atTo = remindTask(owner, naive(to));
  remindTask(owner, naive(to + SECOND));

  const res = await raw(windowQuery(zulu(from), zulu(to)), token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((row) => row.id), [atFrom, inside, atTo]);
});

test('kommend heisst nach jetzt, auch wenn das Fenster in der Vergangenheit beginnt', async () => {
  const owner = person();
  const token = tokenFor(owner);
  remindTask(owner, naive(NOW - HOUR));
  const dueNow = remindTask(owner, naive(NOW));
  const next = remindTask(owner, naive(NOW + SECOND));

  const res = await raw(windowQuery(zulu(NOW - 2 * DAY), zulu(NOW + DAY)), token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((row) => row.id), [next]);

  // Die Gegenseite: was hier fehlt, liegt in `/pending` - keine Zeile faellt
  // zwischen die beiden Routen, keine steht in beiden.
  assert.ok((await pending(token)).some((row) => row.id === dueNow));
  assert.ok(!(await pending(token)).some((row) => row.id === next));
});

test('eine verworfene Erinnerung kommt nicht mehr', async () => {
  const owner = person();
  const token = tokenFor(owner);
  remind(owner, 'task', makeTask(owner), naive(NOW + HOUR), 1);
  assert.deepEqual(await ids(token), []);
});

test('eine erledigte oder abgelegte Aufgabe fehlt und kommt beim Wiederoeffnen zurueck', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const taskId = makeTask(owner);
  const reminderId = remind(owner, 'task', taskId, naive(NOW + HOUR));
  const eventReminder = remind(owner, 'event', makeEvent(owner), naive(NOW + 2 * HOUR));
  const setTask = (status, archivedAt) => db.prepare(
    'UPDATE tasks SET status = ?, archived_at = ? WHERE id = ?',
  ).run(status, archivedAt, taskId);

  assert.deepEqual(await ids(token), [reminderId, eventReminder]);

  setTask('done', null);
  assert.deepEqual(await ids(token), [eventReminder], 'erledigt');

  setTask('open', zulu(NOW));
  assert.deepEqual(await ids(token), [eventReminder], 'abgelegt');

  setTask('in_progress', null);
  assert.deepEqual(await ids(token), [reminderId, eventReminder], 'wieder offen');
});

test('from und to ohne Zone sind UTC wie die Spalte, mit Zone ein Zeitpunkt', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const at = NOW + DAY;
  const id = remindTask(owner, naive(at));

  for (const [from, to] of [
    [naive(at), naive(at)],
    [zulu(at), zulu(at)],
    [`${new Date(at).toISOString()}`, `${new Date(at).toISOString()}`],
  ]) {
    const res = await raw(windowQuery(from, to), token);
    assert.equal(res.status, 200, `${from}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.data.map((row) => row.id), [id], `Fenster ${from}`);
  }

  // Derselbe Zeitpunkt in Wandzeit +02:00.
  const shifted = naive(at + 2 * HOUR);
  const res = await raw(windowQuery(`${shifted}+02:00`, `${shifted}+02:00`), token);
  assert.deepEqual(res.body.data.map((row) => row.id), [id]);

  // Ein reines Datum ist Mitternacht UTC.
  const day = naive(at).slice(0, 10);
  const dated = await raw(windowQuery(day, new Date(Date.parse(day) + DAY).toISOString().slice(0, 10)), token);
  assert.deepEqual(dated.body.data.map((row) => row.id), [id]);
});

test('from und to sind Pflicht, Unbrauchbares ist 400 statt 500 oder ein Nachbartag', async () => {
  const token = tokenFor(person());
  const from = zulu(NOW);
  const to = zulu(NOW + DAY);
  for (const [label, query] of [
    ['ohne alles', ''],
    ['ohne to', `?from=${encodeURIComponent(from)}`],
    ['ohne from', `?to=${encodeURIComponent(to)}`],
    ['kein Datum', windowQuery('morgen', to)],
    ['kein Datum in to', windowQuery(from, 'bald')],
    ['31. Februar', windowQuery('2030-02-31T10:00:00', '2030-03-05T10:00:00')],
    ['31. Februar als Datum', windowQuery('2030-02-31', '2030-03-05')],
    ['31. Februar mit Z', windowQuery('2030-02-31T10:00:00Z', '2030-03-05T10:00:00Z')],
    ['Monat 13', windowQuery('2030-13-01T10:00:00', '2030-13-02T10:00:00')],
    ['Stunde 25', windowQuery('2030-01-01T25:00:00', '2030-01-02T10:00:00')],
    ['Ende vor Anfang', windowQuery(to, from)],
    // Ein `+` im Query ist ein Leerzeichen. Das darf nicht als Zeit ohne Zone
    // durchgehen, sonst laege das Fenster um den Offset daneben.
    ['Offset nicht kodiert', `?from=${naive(NOW)}+02:00&to=${encodeURIComponent(to)}`],
  ]) {
    const res = await raw(query, token);
    assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 400, label);
    assert.equal(typeof res.body.error, 'string', label);
  }
});

test('das Fenster ist auf 14 Tage begrenzt, die vollen 14 sind erlaubt', async () => {
  const token = tokenFor(person());
  assert.equal((await raw(windowQuery(zulu(NOW), zulu(NOW + 14 * DAY)), token)).status, 200);
  const tooWide = await raw(windowQuery(zulu(NOW), zulu(NOW + 14 * DAY + SECOND)), token);
  assert.equal(tooWide.status, 400);
  assert.match(tooWide.body.error, /14 days/);
  // Gemessen wird der Zeitpunkt, nicht der Text: 13 Tage 23 Stunden, in zwei
  // Offsets geschrieben, bleiben im Fenster.
  const from = `${naive(NOW)}+02:00`;
  const to = `${naive(NOW + 14 * DAY)}+03:00`;
  assert.equal((await raw(windowQuery(from, to), token)).status, 200);
});

// --------------------------------------------------------
// 2. fires_at
// --------------------------------------------------------
test('fires_at ist der normalisierte Zeitpunkt mit Z, fuer naive Zeilen und alte Offsets', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const at = NOW + 2 * DAY;
  const wall = (offsetHours) => naive(at + offsetHours * HOUR);

  const cases = [
    ['naiv', naive(at), at],
    ['mit Z', zulu(at), at],
    ['+02:00', `${wall(2)}+02:00`, at],
    ['-04:00', `${wall(-4)}-04:00`, at],
    ['+0200 ohne Doppelpunkt', `${wall(2)}+0200`, at],
    ['reines Datum', naive(at).slice(0, 10), Date.parse(naive(at).slice(0, 10))],
  ];
  const expected = new Map(cases.map(([label, remindAt, instant]) => [remindTask(owner, remindAt), { label, remindAt, instant }]));

  const rows = (await upcoming(token)).body.data;
  assert.equal(rows.length, cases.length);
  for (const row of rows) {
    const { label, remindAt, instant } = expected.get(row.id);
    assert.equal(row.fires_at, zulu(instant), label);
    assert.match(row.fires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, label);
    // `remind_at` bleibt, wie es steht: fuer Fassungen, die es schon lesen.
    assert.equal(row.remind_at, remindAt, label);
  }
});

test('Fenster und Sortierung lesen den Zeitpunkt, nicht den Text der Spalte', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const from = NOW + DAY;
  const to = NOW + 2 * DAY;

  // Als Text im Fenster, als Zeitpunkt zwei Stunden davor.
  remindTask(owner, `${naive(from + HOUR)}+02:00`);
  // Als Text hinter dem Fenster, als Zeitpunkt darin.
  const late = remindTask(owner, `${naive(to + HOUR)}+02:00`);
  const early = remindTask(owner, naive(from + HOUR));
  // Als Text vor `early`, als Zeitpunkt dahinter.
  const westerly = remindTask(owner, `${naive(from)}-04:00`);

  const res = await raw(windowQuery(zulu(from), zulu(to)), token);
  assert.deepEqual(res.body.data.map((row) => row.id), [early, westerly, late]);
});

test('eine Zeile, deren remind_at keinen Zeitpunkt ergibt, faellt heraus', async () => {
  const owner = person();
  const token = tokenFor(owner);
  remindTask(owner, 'irgendwann');
  const id = remindTask(owner, naive(NOW + HOUR));
  assert.deepEqual(await ids(token), [id]);
});

// --------------------------------------------------------
// 3. Die Riegel von /pending
// --------------------------------------------------------
test('fremde, private und verwaiste Zeilen fehlen, die Titel stimmen', async () => {
  const owner = person();
  const stranger = person();
  const token = tokenFor(owner);

  const own = remind(owner, 'task', makeTask(owner, 'Eigene Aufgabe'), naive(NOW + HOUR));
  const event = remind(owner, 'event', makeEvent(owner, 'Eigener Termin'), naive(NOW + 2 * HOUR));
  // Dieselbe Aufgabe, aber die Erinnerung gehoert jemand anderem.
  remind(stranger, 'task', makeTask(owner, 'Fremde Zeile'), naive(NOW + HOUR));
  // Die eigene Erinnerung an eine Aufgabe, die inzwischen privat ist.
  remind(owner, 'task', makeTask(stranger, 'Privat', 'private'), naive(NOW + HOUR));
  // Die Waise: das Ziel gibt es nicht (der Verweis ist ein weicher).
  remind(owner, 'task', 999999, naive(NOW + HOUR));

  const rows = (await upcoming(token)).body.data;
  assert.deepEqual(rows.map((row) => row.id), [own, event]);
  assert.deepEqual(rows.map((row) => row.entity_title), ['Eigene Aufgabe', 'Eigener Termin']);
  assert.deepEqual(await ids(tokenFor(stranger)), [db.prepare(
    "SELECT id FROM reminders WHERE created_by = ? AND entity_type = 'task'",
  ).get(stranger).id]);
});

test('die Route liegt unter calendar:read wie /pending', async () => {
  for (const path of ['/reminders/upcoming', '/reminders/pending']) {
    assert.deepEqual(tokenAccessRequirement(path, 'GET'), { moduleKey: 'calendar', access: 'read' });
  }
});

test('ein Token ohne calendar-Scope kommt nicht durchs Gate, auch nicht mit tasks:read', async () => {
  const owner = person();
  remindTask(owner, naive(NOW + HOUR));
  for (const scopes of [[], ['tasks:read']]) {
    const res = await upcoming(tokenFor(owner, scopes));
    assert.equal(res.status, 403, JSON.stringify(scopes));
    assert.equal(res.body.code, 403);
  }
  assert.equal((await upcoming(null)).status, 401);
});

test('ein gescoptes Token sieht nur die Herkuenfte seiner Scopes, ein ungescoptes alle', async () => {
  const owner = person();
  const task = remind(owner, 'task', makeTask(owner), naive(NOW + HOUR));
  const event = remind(owner, 'event', makeEvent(owner), naive(NOW + 2 * HOUR));
  const sub = remind(owner, 'subscription', makeSubscription(owner), naive(NOW + 3 * HOUR));

  assert.deepEqual(await ids(tokenFor(owner, ['calendar:read'])), [event]);
  assert.deepEqual(await ids(tokenFor(owner, ['calendar:read', 'tasks:read'])), [task, event]);
  assert.deepEqual(await ids(tokenFor(owner)), [task, event, sub]);
});

test('ein dem Mitglied entzogenes Modul fehlt, read reicht', async () => {
  const owner = person();
  const token = tokenFor(owner);
  remind(owner, 'task', makeTask(owner), naive(NOW + HOUR));
  const event = remind(owner, 'event', makeEvent(owner), naive(NOW + 2 * HOUR));

  setModuleAccess(owner, 'tasks', 'none');
  assert.deepEqual(await ids(token), [event]);
  setModuleAccess(owner, 'tasks', 'read');
  assert.equal((await ids(token)).length, 2);
});

test('ein abgeschaltetes Modul fehlt und kommt zurueck, die Zeile bleibt', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const task = remind(owner, 'task', makeTask(owner), naive(NOW + HOUR));
  const event = remind(owner, 'event', makeEvent(owner), naive(NOW + 2 * HOUR));

  setDisabledModules(['tasks']);
  try {
    assert.deepEqual(await ids(token), [event]);
    assert.ok(db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(task), 'uebersprungen, nicht geloescht');
  } finally {
    setDisabledModules([]);
  }
  assert.deepEqual(await ids(token), [task, event]);
});

test('audience=household bleibt leer, Fehler im Fenster bleiben 400', async () => {
  const owner = person();
  const token = tokenFor(owner);
  remindTask(owner, naive(NOW + HOUR));
  assert.equal((await ids(token)).length, 1);
  assert.deepEqual((await upcoming(token, '&audience=household')).body, { data: [] });
  assert.equal((await raw('?audience=household', token)).status, 400);
});

test('der Geburtstags-Abgleich laeuft vorher wie bei /pending', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const birthday = db.prepare(
    `INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Opa', '1950-03-14', ?)`,
  ).run(owner).lastInsertRowid;
  const linked = () => db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(birthday).calendar_event_id;

  assert.equal(linked(), null);
  assert.equal((await upcoming(token)).status, 200);
  assert.ok(linked(), 'der Geburtstag hat seinen Termin bekommen');
});

test('dieselbe Zeile sieht in beiden Routen gleich aus, nur fires_at kommt dazu', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const id = remind(owner, 'event', makeEvent(owner, 'Beide Routen'), naive(NOW + HOUR));

  const { fires_at: firesAt, ...coming } = (await upcoming(token)).body.data.find((row) => row.id === id);
  assert.equal(firesAt, zulu(NOW + HOUR));

  mock.timers.setTime(NOW + 2 * HOUR);
  try {
    const due = (await pending(token)).find((row) => row.id === id);
    assert.deepEqual(due, coming);
    assert.ok(!('fires_at' in due), '/pending bleibt, wie es war');
  } finally {
    mock.timers.setTime(NOW);
  }
});

// --------------------------------------------------------
// 4. types
// --------------------------------------------------------
test('types engt die Herkuenfte ein', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const task = remind(owner, 'task', makeTask(owner), naive(NOW + HOUR));
  const event = remind(owner, 'event', makeEvent(owner), naive(NOW + 2 * HOUR));
  remind(owner, 'subscription', makeSubscription(owner), naive(NOW + 3 * HOUR));

  assert.deepEqual(await ids(token, '&types=task,event'), [task, event]);
  assert.deepEqual(await ids(token, '&types=event'), [event]);
});

test('types erweitert nichts: was der Aufrufer nicht lesen darf, bleibt draussen', async () => {
  const owner = person();
  const event = remind(owner, 'event', makeEvent(owner), naive(NOW + HOUR));
  remind(owner, 'task', makeTask(owner), naive(NOW + 2 * HOUR));
  remind(owner, 'subscription', makeSubscription(owner), naive(NOW + 3 * HOUR));

  const scoped = tokenFor(owner, ['calendar:read']);
  assert.deepEqual(await ids(scoped, '&types=event,task,subscription'), [event]);
  // Nichts bleibt uebrig: eine leere Liste, kein SQL-Fehler an `IN ()`.
  const none = await upcoming(scoped, '&types=task');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data, []);

  setModuleAccess(owner, 'budget', 'none');
  const member = tokenFor(owner);
  assert.deepEqual((await upcoming(member, '&types=subscription')).body.data, []);
});

test('ein unbekannter oder leerer types-Wert ist 400', async () => {
  const token = tokenFor(person());
  for (const [label, rest] of [
    ['unbekannt', '&types=task,banana'],
    ['Gross', '&types=Task'],
    ['leer', '&types='],
    ['Komma am Ende', '&types=task,'],
    ['wiederholter Parameter', '&types=task&types=event'],
  ]) {
    const res = await upcoming(token, rest);
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 400, label);
  }
});

// --------------------------------------------------------
// 5. Das Limit
// --------------------------------------------------------
test('hoechstens 200 Zeilen, die fruehesten', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const task = makeTask(owner);
  const inserted = [];
  for (let i = 1; i <= 205; i += 1) inserted.push(remind(owner, 'task', task, naive(NOW + i * 60 * SECOND)));

  assert.deepEqual(await ids(token), inserted.slice(0, 200));
});

test('das Limit zaehlt nach dem Haushaltsschalter: Abgeschaltetes verdraengt nichts', async () => {
  const owner = person();
  const token = tokenFor(owner);
  const hidden = makeTask(owner);
  for (let i = 1; i <= 205; i += 1) remind(owner, 'task', hidden, naive(NOW + i * 60 * SECOND));
  const visible = remind(owner, 'event', makeEvent(owner), naive(NOW + DAY));

  setDisabledModules(['tasks']);
  try {
    assert.deepEqual(await ids(token), [visible]);
  } finally {
    setDisabledModules([]);
  }
});

// --------------------------------------------------------
// 6. Device Credential
// --------------------------------------------------------
async function credentialFor(session) {
  const res = await fetch(`${API}/auth/devices`, {
    method: 'POST',
    headers: { ...json, Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ name: 'Telefon', platform: 'ios', device_id: `device-${crypto.randomUUID()}` }),
  });
  assert.equal(res.status, 201, 'Geraet angemeldet');
  return (await res.json()).credential;
}

test('ein Device Credential liest die eigenen Zeilen und nur die, auch mit Herkunftsfilter', async () => {
  const created = await fetch(`${API}/auth/users`, {
    method: 'POST',
    headers: { ...json, Cookie: adminSession.cookie, 'X-CSRF-Token': adminSession.csrfToken },
    body: JSON.stringify({ username: 'telefon', display_name: 'Telefon', password: 'telefonpass1234' }),
  });
  assert.equal(created.status, 201);
  const memberId = db.prepare("SELECT id FROM users WHERE username = 'telefon'").get().id;
  const credential = await credentialFor(await login('telefon', 'telefonpass1234'));

  const task = remind(memberId, 'task', makeTask(memberId, 'Telefon-Aufgabe'), naive(NOW + HOUR));
  const event = remind(memberId, 'event', makeEvent(memberId), naive(NOW + 2 * HOUR));
  const sub = remind(memberId, 'subscription', makeSubscription(memberId), naive(NOW + 3 * HOUR));
  remind(adminId, 'task', makeTask(adminId), naive(NOW + HOUR));

  // Ein Geraet ist ungescopt: die Grenze ist die Person.
  assert.deepEqual(await ids(credential), [task, event, sub]);
  assert.deepEqual(await ids(credential, '&types=task,event'), [task, event]);
  assert.equal((await upcoming(credential, '&types=task')).body.data[0].fires_at, zulu(NOW + HOUR));

  // Die Mitgliedsrechte gelten am Geraet wie in der Sitzung.
  setModuleAccess(memberId, 'budget', 'none');
  assert.deepEqual(await ids(credential), [task, event]);
});

test('ein Admin ist auf dem Geraet ein Mitglied, das eigene bleibt lesbar', async () => {
  const credential = await credentialFor(await login('admin', 'adminpass123'));
  // Das Mitgliederprofil gilt am Geraet, auch wenn der Admin sonst nichts
  // verliert: ein Entzug trifft ihn dort, in der Sitzung nicht.
  setModuleAccess(adminId, 'tasks', 'none');
  try {
    const event = remind(adminId, 'event', makeEvent(adminId), naive(NOW + 5 * HOUR));
    const task = remind(adminId, 'task', makeTask(adminId), naive(NOW + 6 * HOUR));
    assert.deepEqual(await ids(credential, '&types=task,event'), [event]);
    assert.ok((await ids(tokenFor(adminId), '&types=task,event')).includes(task));
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_id = ? AND resource_key = 'tasks'").run(String(adminId));
  }
});

// --------------------------------------------------------
// OpenAPI
// --------------------------------------------------------
test('die Spec nennt Parameter, typisierte Antwort und Fehlerfaelle', () => {
  const spec = buildOpenApiSpec({});
  const operation = spec.paths['/api/v1/reminders/upcoming'].get;

  assert.equal(operation.operationId, 'listUpcomingReminders');
  const params = Object.fromEntries(operation.parameters.map((param) => [param.name, param]));
  assert.equal(params.from.required, true);
  assert.equal(params.to.required, true);
  assert.equal(params.types.required, false);
  assert.equal(params.audience.required, false);

  const { $ref: ref } = operation.responses[200].content['application/json'].schema;
  const name = ref.split('/').pop();
  const list = spec.components.schemas[name];
  assert.deepEqual(list.required, ['data']);
  assert.equal(list.properties.data.maxItems, 200);
  const row = spec.components.schemas[list.properties.data.items.$ref.split('/').pop()];
  assert.ok(row.required.includes('fires_at'));
  assert.ok(row.properties.fires_at);
  for (const status of [400, 401, 403, 500]) assert.ok(operation.responses[status], `Antwort ${status}`);
});
