/**
 * Test: eine Serie aus iOS Erinnerungen oder Tasks.org hakt Yuvomi so ab, wie
 * die besitzende App es tut (#2506, #2515).
 *
 * Seit #2542 merkt sich der Inbound die fremde Regel (`external_rrule`) und
 * sperrt das Abhaken. Hier kommt der Umbau dazu:
 *   - ein Normalisierer bringt die fremde Regel in die Yuvomi-Teilmenge
 *     (Reihenfolge, INTERVAL=1 und WKST=MO fallen weg); COUNT und alles, was
 *     `RRULE_RE` nicht kennt, ist nicht abbildbar und bleibt gesperrt;
 *   - eine abbildbare Serie kommt als Serie an (`is_recurring = 1`) und ist
 *     abhakbar. Die Folgeinstanz uebernimmt UID, Objekt-URL und Konto des
 *     Masters, der Push rueckt dort DUE vor, setzt NEEDS-ACTION und laesst die
 *     fremde RRULE woertlich stehen (keine X-YUVOMI-RRULE darauf). Die
 *     erledigte Zeile wird lokal, bekommt eine eigene UID und geht als
 *     erledigte Kopie ohne RRULE hoch - die Form, die iOS selbst schreibt;
 *   - Zuruecknehmen kehrt das Umhaengen um (#650), und der naechste Abruf
 *     storniert die erledigte Zeile nicht.
 *
 * Gefahren ueber die echten Wege: Route, `flushOutbound()`, `sync()` mit dem
 * echten tsdav gegen `test/caldav-fake-server.js`.
 *
 * Ausfuehren: npm run test:caldav-foreign-series
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
delete process.env.LOG_LEVEL;

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const remindersSync = await import('../server/services/caldav-reminders-sync.js');
const todoOutbound  = await import('../server/services/caldav-todo-outbound.js');
const { unfoldICS } = await import('../server/utils/ics-patch.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const ADMIN = Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')",
).run().lastInsertRowid);

const dav = await startFakeDavServer();
test.after(() => dav.close());

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = ADMIN;
  req.session = { userId: ADMIN, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => { server.closeAllConnections?.(); server.close(); });

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Prozess- und Haushaltszone sind UTC (oben, ohne gewaehlte Zone): der UTC-Tag
// ist hier der Haushaltstag, mit dem die Route "heute" rechnet.
const DAY = 86400000;
const dayKey = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const icsDay = (key) => key.replace(/-/g, '');

const UID = 'apple-1@phone';
const FILE = 'apple-1.ics';

/** Ein VTODO, wie Apple Erinnerungen es fuer "taeglich" ablegt. */
function appleSeries({ rrule = 'FREQ=DAILY;INTERVAL=1', due = dayKey(0), uid = UID, extra = [] } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261101T080000Z', 'SUMMARY:Muell rausbringen',
    `DTSTART;VALUE=DATE:${icsDay(due)}`, `DUE;VALUE=DATE:${icsDay(due)}`,
    `RRULE:${rrule}`, 'STATUS:NEEDS-ACTION', ...extra,
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

/** Die Zeilen `name` im VTODO eines Objekts (entfaltet). */
function todoLines(data, name) {
  const lines = unfoldICS(String(data)).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'BEGIN:VTODO');
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'END:VTODO');
  return lines.slice(start + 1, end).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

let accountId;
let listUrl;

function reset() {
  for (const table of [
    'task_completions', 'caldav_todo_pending_deletions', 'caldav_upload_attempts', 'tasks',
    'caldav_reminder_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  dav.reset();
  accountId = Number(db.prepare(
    "INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES ('Telefon', ?, 'u', 'p')",
  ).run(dav.url).lastInsertRowid);
  listUrl = dav.addCollection('erinnerungen', { name: 'Erinnerungen', components: ['VTODO'] });
  db.prepare(`
    INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
    VALUES (?, ?, 'Erinnerungen', 'tasks', 1)
  `).run(accountId, listUrl);
}

const rowOf = (uid) => db.prepare(
  "SELECT * FROM tasks WHERE external_uid = ? AND external_source = 'caldav'",
).get(uid);
const taskOf = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const completionsOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ?').get(id).n;

/** Was nach einem Haken hinausgeht, und der Abruf danach. */
async function settle() {
  await todoOutbound.flushOutbound();
  await remindersSync.sync();
}

/** Die Objekte der Liste ausser dem Master. */
function copies() {
  return dav.objectNames(listUrl).filter((name) => name !== FILE)
    .map((name) => ({ name, data: dav.getObject(listUrl, name).data }));
}

// ── Normalisierer ───────────────────────────────────────────────────────────

test('Normalisierer: die Grundformen von iOS und Tasks.org kommen in Yuvomis Teilmenge (#2515)', () => {
  const { mappableForeignRule: norm } = todoOutbound;
  assert.equal(norm('FREQ=DAILY;INTERVAL=1'), 'FREQ=DAILY');
  assert.equal(norm('RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=MO,WE'), 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(norm('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'), 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(norm('INTERVAL=2;FREQ=WEEKLY'), 'FREQ=WEEKLY;INTERVAL=2', 'Reihenfolge');
  assert.equal(norm('freq=monthly;interval=1'), 'FREQ=MONTHLY');
  assert.equal(norm('FREQ=MONTHLY;BYMONTHDAY=-1'), 'FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.equal(norm('FREQ=YEARLY;UNTIL=20271231T225959Z'), 'FREQ=YEARLY;UNTIL=20271231T225959Z');
  assert.equal(norm('FREQ=WEEKLY;UNTIL=20271231;INTERVAL=3'), 'FREQ=WEEKLY;INTERVAL=3;UNTIL=20271231');
});

test('Normalisierer: COUNT und alles ausserhalb von RRULE_RE ist nicht abbildbar (#2515)', () => {
  const { mappableForeignRule: norm } = todoOutbound;
  for (const rule of [
    'FREQ=DAILY;COUNT=5',             // Yuvomi zaehlt an Aufgaben nicht herunter
    'FREQ=MONTHLY;BYMONTHDAY=15',     // Apple "monatlich am 15."
    'FREQ=MONTHLY;BYMONTHDAY=1,15',
    'FREQ=MONTHLY;BYDAY=2TU',         // Ordinal
    'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    'FREQ=YEARLY;BYMONTH=3',
    'FREQ=WEEKLY;WKST=SU;BYDAY=MO',   // anderer Wochenbeginn verschiebt INTERVAL>1
    'FREQ=HOURLY',
    'FREQ=DAILY;FREQ=WEEKLY',         // doppelt
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=DAILY;UNTIL=20271231T000000', // schwebendes UNTIL
    '', null,
  ]) assert.equal(norm(rule), null, String(rule));
});

// ── Import ──────────────────────────────────────────────────────────────────

test('Import: eine abbildbare Serie kommt als Serie an, eine nicht abbildbare bleibt gesperrt', async () => {
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  dav.putObject(listUrl, 'monthly.ics', appleSeries({ uid: 'monthly@phone', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' }));
  await remindersSync.sync();

  const daily = rowOf(UID);
  assert.equal(daily.is_recurring, 1);
  assert.equal(daily.recurrence_rule, 'FREQ=DAILY');
  assert.equal(daily.external_rrule, 'FREQ=DAILY;INTERVAL=1', 'die fremde Regel bleibt woertlich daneben');

  const monthly = rowOf('monthly@phone');
  assert.equal(monthly.is_recurring, 0);
  assert.equal(monthly.recurrence_rule, null);
  assert.equal(monthly.external_rrule, 'FREQ=MONTHLY;BYMONTHDAY=15');
  const refused = await call('PATCH', `/${monthly.id}/status`, { status: 'done' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'task_foreign_series');

  // Nimmt die andere App die Wiederholung weg, ist es wieder eine einfache Aufgabe.
  dav.putObject(listUrl, FILE, appleSeries().replace(/^RRULE:.*\r\n/m, ''));
  await remindersSync.sync();
  const plain = rowOf(UID);
  assert.deepEqual([plain.is_recurring, plain.recurrence_rule, plain.external_rrule], [0, null, null]);
});

// ── Abhaken ─────────────────────────────────────────────────────────────────

test('Abhaken: der Master bleibt offen und rueckt vor, die RRULE bleibt, dazu eine erledigte Kopie (#2506)', async () => {
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  await remindersSync.sync();
  const master = rowOf(UID);

  const res = await call('PATCH', `/${master.id}/status`, { status: 'done' });
  assert.equal(res.status, 200, `heute ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.next_due_date, dayKey(1));
  await settle();

  const data = dav.getObject(listUrl, FILE).data;
  assert.deepEqual(todoLines(data, 'STATUS'), ['STATUS:NEEDS-ACTION'], 'die Serie laeuft weiter');
  assert.deepEqual(todoLines(data, 'COMPLETED'), []);
  assert.deepEqual(todoLines(data, 'DUE'), [`DUE;VALUE=DATE:${icsDay(dayKey(1))}`], 'DUE rueckt vor');
  assert.deepEqual(todoLines(data, 'DTSTART'), [`DTSTART;VALUE=DATE:${icsDay(dayKey(1))}`], 'DTSTART rueckt mit');
  assert.deepEqual(todoLines(data, 'RRULE'), ['RRULE:FREQ=DAILY;INTERVAL=1'], 'die fremde Regel bleibt Wort fuer Wort');
  assert.deepEqual(todoLines(data, 'X-YUVOMI-RRULE'), [], 'keine Yuvomi-Marke auf der fremden Regel');

  const [copy, ...more] = copies();
  assert.ok(copy, 'die erledigte Kopie fehlt auf dem Server');
  assert.equal(more.length, 0);
  assert.deepEqual(todoLines(copy.data, 'STATUS'), ['STATUS:COMPLETED']);
  assert.deepEqual(todoLines(copy.data, 'RRULE'), [], 'die Kopie traegt keine Regel');
  assert.deepEqual(todoLines(copy.data, 'SUMMARY'), ['SUMMARY:Muell rausbringen']);

  // Die erledigte Zeile ist die alte, mit Verlauf; die Serie lebt in der neuen.
  const done = taskOf(master.id);
  assert.equal(done.status, 'done');
  assert.notEqual(done.external_uid, UID);
  assert.equal(done.external_rrule, null);
  assert.equal(completionsOf(master.id), 1);
  const next = rowOf(UID);
  assert.notEqual(next.id, master.id);
  assert.deepEqual([next.status, next.due_date, next.recurrence_origin_id], ['open', dayKey(1), master.id]);
  assert.equal(next.external_rrule, 'FREQ=DAILY;INTERVAL=1');

  // Der naechste Abruf storniert nichts.
  await remindersSync.sync();
  assert.equal(taskOf(master.id).status, 'done');
  assert.equal(completionsOf(master.id), 1, 'der Abruf hat den Verlauf zurueckgenommen');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2, 'keine dritte Zeile');
});

test('Abhaken ueber PUT und am letzten Vorkommen: das Ende einer Serie geht als COMPLETED hinaus', async () => {
  reset();
  // UNTIL heute: nach diesem Haken gibt es kein naechstes Vorkommen.
  dav.putObject(listUrl, FILE, appleSeries({ rrule: `FREQ=DAILY;UNTIL=${icsDay(dayKey(0))}` }));
  await remindersSync.sync();
  const master = rowOf(UID);
  assert.equal(master.is_recurring, 1);

  const res = await call('PUT', `/${master.id}`, { status: 'done' });
  assert.equal(res.status, 200);
  await settle();
  const data = dav.getObject(listUrl, FILE).data;
  assert.deepEqual(todoLines(data, 'STATUS'), ['STATUS:COMPLETED'], 'die Serie ist zu Ende, wie in der anderen App');
  assert.equal(copies().length, 0);
  await remindersSync.sync();
  assert.equal(taskOf(master.id).status, 'done');
  assert.equal(completionsOf(master.id), 1);
});

// ── Zuruecknehmen ───────────────────────────────────────────────────────────

test('Zuruecknehmen kehrt das Umhaengen um: der Master steht wieder an der alten Zeile (#650)', async () => {
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  await remindersSync.sync();
  const master = rowOf(UID);
  await call('PATCH', `/${master.id}/status`, { status: 'done' });
  await settle();
  assert.equal(copies().length, 1, 'Vorbedingung: die Kopie liegt oben');

  const res = await call('PATCH', `/${master.id}/status`, { status: 'open' });
  assert.equal(res.status, 200);
  await settle();

  const back = taskOf(master.id);
  assert.deepEqual([back.status, back.external_uid, back.external_source], ['open', UID, 'caldav']);
  assert.equal(back.external_rrule, 'FREQ=DAILY;INTERVAL=1');
  assert.equal(completionsOf(master.id), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'die Folgeinstanz ist weg');

  const data = dav.getObject(listUrl, FILE).data;
  assert.ok(data, 'der Master wurde geloescht');
  assert.deepEqual(todoLines(data, 'DUE'), [`DUE;VALUE=DATE:${icsDay(dayKey(0))}`], 'DUE wieder auf heute');
  assert.deepEqual(todoLines(data, 'STATUS'), ['STATUS:NEEDS-ACTION']);
  assert.deepEqual(todoLines(data, 'RRULE'), ['RRULE:FREQ=DAILY;INTERVAL=1']);
  assert.equal(copies().length, 0, 'die erledigte Kopie bleibt nicht liegen');
});

test('Zuruecknehmen, bevor etwas oben ist, laesst nichts zurueck', async () => {
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  await remindersSync.sync();
  const master = rowOf(UID);
  // Ohne Warten auf den Sofortversuch: beide Wechsel stehen, bevor er laeuft.
  dav.refuse({ method: 'PUT', status: 503 });
  await call('PATCH', `/${master.id}/status`, { status: 'done' });
  await call('PATCH', `/${master.id}/status`, { status: 'open' });
  dav.allowAll();
  await settle();

  const back = taskOf(master.id);
  assert.deepEqual([back.status, back.external_uid, back.target_caldav_list_url], ['open', UID, null]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(copies().length, 0);
  assert.deepEqual(todoLines(dav.getObject(listUrl, FILE).data, 'DUE'), [`DUE;VALUE=DATE:${icsDay(dayKey(0))}`]);
});

test('Zuruecknehmen, nachdem die andere App die Wiederholung weggenommen hat: der Master bleibt (#650)', async () => {
  // Die Folgeinstanz haelt dann ein Objekt ohne Regel. Es gehoert trotzdem der
  // anderen App: das Zuruecknehmen gibt es zurueck, statt es zu loeschen.
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  await remindersSync.sync();
  const master = rowOf(UID);
  await call('PATCH', `/${master.id}/status`, { status: 'done' });
  await settle();
  const advanced = dav.getObject(listUrl, FILE).data;
  dav.putObject(listUrl, FILE, advanced.replace(/^RRULE:.*\r?\n/m, ''));
  await remindersSync.sync();
  assert.equal(rowOf(UID).external_rrule, null, 'Vorbedingung: die Regel ist weg');

  assert.equal((await call('PATCH', `/${master.id}/status`, { status: 'open' })).status, 200);
  await settle();
  assert.ok(dav.getObject(listUrl, FILE), 'das Objekt der anderen App wurde geloescht');
  assert.equal(taskOf(master.id).external_uid, UID);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
});
