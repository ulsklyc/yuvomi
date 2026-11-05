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

// Abbildbar heisst: Yuvomi rechnet das naechste Vorkommen so, wie RFC 5545 es
// meint (Review auf #2543). Ein kleiner Nachrechner nach RFC fuer die Teilmenge
// steht gegen `nextDueAfterCompletion`, fuer JEDE Kombination, die der
// Normalisierer annimmt, und jeden Anker ueber drei Jahre, der ein Vorkommen
// ist und zum Faelligkeitstag passt. Unter den Kandidaten stehen auch die, die
// der Rechner falsch rechnet: der Normalisierer muss sie abweisen, sonst wird
// der Vergleich rot.
const { nextDueAfterCompletion } = await import('../server/services/recurrence.js');
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const msOf = (key) => Date.parse(`${key}T00:00:00Z`);
const keyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function ruleParts(rule) {
  const m = new Map(rule.split(';').map((p) => p.split('=')));
  return {
    freq: m.get('FREQ'), interval: Number(m.get('INTERVAL') || 1),
    byday: m.get('BYDAY')?.split(','), lastDay: m.get('BYMONTHDAY') === '-1',
    until: m.get('UNTIL')?.slice(0, 8),
  };
}

/** Ist `day` nach RFC 5545 ein Vorkommen der Serie mit DTSTART `start`? */
function rfcOccurs(start, day, rule) {
  const p = ruleParts(rule);
  const a = new Date(msOf(start));
  const b = new Date(msOf(day));
  if (p.until && day.replace(/-/g, '') > p.until) return false;
  if (p.byday && !p.byday.includes(WEEKDAY_CODES[b.getUTCDay()])) return false;
  if (p.freq === 'DAILY') return ((msOf(day) - msOf(start)) / DAY) % p.interval === 0;
  if (p.freq === 'WEEKLY') {
    const monday = (d) => d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
    if (Math.round((monday(b) - monday(a)) / (7 * DAY)) % p.interval) return false;
    return p.byday ? true : b.getUTCDay() === a.getUTCDay();
  }
  if (p.freq === 'MONTHLY') {
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
    if (months % p.interval) return false;
    if (p.lastDay) return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate() === b.getUTCDate();
    return b.getUTCDate() === a.getUTCDate();
  }
  if (p.freq === 'YEARLY') {
    if ((b.getUTCFullYear() - a.getUTCFullYear()) % p.interval) return false;
    return b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() === a.getUTCDate();
  }
  return false;
}

function rfcNext(start, rule) {
  for (let t = msOf(start) + DAY; t < msOf(start) + 9 * 366 * DAY; t += DAY) {
    if (rfcOccurs(start, keyOf(t), rule)) return keyOf(t);
  }
  return null;
}

function candidateRules() {
  const out = [];
  for (const interval of ['', ';INTERVAL=2', ';INTERVAL=3']) {
    out.push(`FREQ=DAILY${interval}`, `FREQ=YEARLY${interval}`, `FREQ=MONTHLY${interval}`,
      `FREQ=MONTHLY${interval};BYMONTHDAY=-1`, `FREQ=WEEKLY${interval}`);
    for (const days of ['MO', 'MO,WE', 'TU,TH,SA', 'MO,TU,WE,TH,FR', 'SA,SU']) {
      out.push(`FREQ=WEEKLY${interval};BYDAY=${days}`, `FREQ=DAILY${interval};BYDAY=${days}`,
        `FREQ=MONTHLY${interval};BYDAY=${days}`, `FREQ=YEARLY${interval};BYDAY=${days}`);
    }
    out.push(`FREQ=MONTHLY${interval};BYMONTHDAY=-1;BYDAY=FR`);
  }
  out.push('FREQ=DAILY;UNTIL=20270115', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20270301T225959Z',
    'FREQ=MONTHLY;UNTIL=20270615');
  return out;
}

test('Normalisierer: abbildbar ist nur, was der Rechner wie RFC 5545 rechnet (Review #2543)', () => {
  const { mappableForeignRule: norm, foreignRuleFitsDue: fits } = todoOutbound;
  // Die beiden Faelle aus dem Review, ausdruecklich.
  assert.equal(norm('FREQ=MONTHLY;BYDAY=MO'), null);
  assert.equal(norm('FREQ=DAILY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR'), null);
  assert.equal(fits('FREQ=MONTHLY', '2026-01-31'), false, 'der Rechner klemmt auf den Monatsletzten');
  assert.equal(fits('FREQ=YEARLY', '2028-02-29'), false);

  const wrong = [];
  let compared = 0;
  for (const raw of candidateRules()) {
    const rule = norm(raw);
    if (!rule) continue;
    for (let t = msOf('2026-01-01'); t <= msOf('2028-12-31'); t += DAY) {
      const due = keyOf(t);
      if (!fits(rule, due) || !rfcOccurs(due, due, rule)) continue;
      compared++;
      const got = nextDueAfterCompletion({ anchorDate: due, rule, completedOn: due });
      const want = rfcNext(due, rule);
      if (got !== want && wrong.length < 5) wrong.push(`${rule} ab ${due}: ${got}, RFC ${want}`);
    }
  }
  assert.ok(compared > 20000, `zu wenig verglichen: ${compared}`);
  assert.deepEqual(wrong, [], 'abbildbar, aber falsch gerechnet');
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
  // Review auf #2543: mit dem Master geht sein heutiger Stand zurueck, nicht der
  // vom Abhaken. Sonst schriebe der Push die alte Regel samt Marke wieder hin.
  assert.deepEqual([taskOf(master.id).is_recurring, taskOf(master.id).recurrence_rule], [0, null]);
  const data = dav.getObject(listUrl, FILE).data;
  assert.deepEqual(todoLines(data, 'RRULE'), [], 'die weggenommene Wiederholung ist zurueck');
  assert.deepEqual(todoLines(data, 'X-YUVOMI-RRULE'), []);
});

// ── Unteraufgaben (Review auf #2543) ────────────────────────────────────────
// Eine Unteraufgabe in der anderen App ist ein eigenes VTODO mit RELATED-TO auf
// den Master. Haengt der Master um, zeigt RELATED-TO beim naechsten Abruf auf
// die Folgeinstanz - legte der Spawn daneben noch Kopien an, stuende die
// Checkliste dort doppelt, und die erledigte Zeile verloere ihre.

function appleSubtask(uid, summary, { done = false } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 18.0//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261101T080000Z', `SUMMARY:${summary}`,
    `RELATED-TO;RELTYPE=PARENT:${UID}`, `STATUS:${done ? 'COMPLETED' : 'NEEDS-ACTION'}`,
    ...(done ? ['COMPLETED:20261101T090000Z'] : []),
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

const childrenOf = (id) => db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id').all(id);

test('Unteraufgaben der anderen App gehen mit dem Master, die erledigte Zeile behaelt ihre Liste', async () => {
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  dav.putObject(listUrl, 'sub-1.ics', appleSubtask('sub-1@phone', 'Gelbe Tonne'));
  dav.putObject(listUrl, 'sub-2.ics', appleSubtask('sub-2@phone', 'Papier'));
  await remindersSync.sync();
  const master = rowOf(UID);
  assert.equal(childrenOf(master.id).length, 2, 'Vorbedingung: zwei gespiegelte Unteraufgaben');
  db.prepare(`INSERT INTO tasks (title, created_by, parent_task_id) VALUES ('Nur hier', ?, ?)`).run(ADMIN, master.id);

  assert.equal((await call('PATCH', `/${master.id}/status`, { status: 'done' })).status, 200);
  await settle();
  await remindersSync.sync();

  const next = rowOf(UID);
  const nextKids = childrenOf(next.id);
  assert.deepEqual(nextKids.map((k) => k.title).sort(), ['Gelbe Tonne', 'Nur hier', 'Papier'], 'keine doppelten Unteraufgaben');
  assert.deepEqual(nextKids.filter((k) => k.external_source === 'caldav').map((k) => k.external_uid).sort(),
    ['sub-1@phone', 'sub-2@phone'], 'die gespiegelten gehen mit');
  assert.deepEqual(childrenOf(master.id).map((k) => k.title).sort(), ['Gelbe Tonne', 'Nur hier', 'Papier'],
    'die erledigte Zeile verliert ihre Checkliste');
  assert.ok(childrenOf(master.id).every((k) => k.external_source !== 'caldav'), 'dort nur noch lokale Abbilder');

  // Zuruecknehmen bringt sie zurueck, ohne Abbilder daneben.
  assert.equal((await call('PATCH', `/${master.id}/status`, { status: 'open' })).status, 200);
  await settle();
  await remindersSync.sync();
  const back = childrenOf(master.id);
  assert.deepEqual(back.map((k) => k.title).sort(), ['Gelbe Tonne', 'Nur hier', 'Papier']);
  assert.equal(back.filter((k) => k.external_source === 'caldav').length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 4, 'Master, zwei gespiegelte, eine lokale');
  assert.equal(dav.objectNames(listUrl).length, 3, 'nichts geloescht, keine Kopie liegen geblieben');
});

// ── Zweite Review-Runde auf #2543: unsichere Enden und einzelne Tage ────────

test('Ein Ende mit Uhrzeit oder an einer Serie mit Uhrzeit bleibt gesperrt (Review #2543)', async () => {
  // Taeglich um 00:30 Berlin, UNTIL=20261105T233000Z: der 6. November gehoert
  // in Berlin noch dazu, der Rechner vergleicht aber UTC-Tage. Er laege null
  // vor, und das Abhaken schickte COMPLETED auf den Master.
  const { foreignRuleFitsDue: fits } = todoOutbound;
  assert.equal(fits('FREQ=DAILY;UNTIL=20261105T233000Z', '2026-11-05', '00:30'), false);
  assert.equal(fits('FREQ=DAILY;UNTIL=20261105', '2026-11-05', '00:30'), false, 'auch ein Datum an einer Serie mit Uhrzeit');
  assert.equal(fits('FREQ=DAILY;UNTIL=20261105T225959Z', '2026-11-05', null), false, 'ein UTC-Ende an einem reinen Datum');
  assert.equal(fits('FREQ=DAILY;UNTIL=20261105', '2026-11-05', null), true);
  assert.equal(fits('FREQ=DAILY', '2026-11-05', '00:30'), true, 'ohne Ende zaehlt die Uhrzeit nicht');

  reset();
  const timed = appleSeries({ rrule: `FREQ=DAILY;UNTIL=${icsDay(dayKey(0))}T233000Z` })
    .replace(/DTSTART;VALUE=DATE:\d+/, `DTSTART:${icsDay(dayKey(0))}T003000Z`)
    .replace(/DUE;VALUE=DATE:\d+/, `DUE:${icsDay(dayKey(0))}T003000Z`);
  dav.putObject(listUrl, FILE, timed);
  await remindersSync.sync();
  const row = rowOf(UID);
  assert.equal(row.due_time, '00:30', 'Vorbedingung: eine Serie mit Uhrzeit');
  assert.equal(row.is_recurring, 0);
  const refused = await call('PATCH', `/${row.id}/status`, { status: 'done' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'task_foreign_series');
});

test('EXDATE, RDATE oder ein geaendertes Vorkommen: die Regel allein reicht nicht, gesperrt (Review #2543)', async () => {
  const override = ['BEGIN:VTODO', `UID:${UID}`, 'DTSTAMP:20261101T080000Z',
    `RECURRENCE-ID;VALUE=DATE:${icsDay(dayKey(2))}`, `DUE;VALUE=DATE:${icsDay(dayKey(3))}`,
    'SUMMARY:Muell rausbringen', 'END:VTODO'].join('\r\n');
  const cases = {
    EXDATE: appleSeries({ extra: [`EXDATE;VALUE=DATE:${icsDay(dayKey(1))}`] }),
    RDATE: appleSeries({ extra: [`RDATE;VALUE=DATE:${icsDay(dayKey(10))}`] }),
    'RECURRENCE-ID': appleSeries().replace('END:VCALENDAR', `${override}\r\nEND:VCALENDAR`),
  };
  for (const [what, ics] of Object.entries(cases)) {
    reset();
    dav.putObject(listUrl, FILE, ics);
    await remindersSync.sync();
    const row = rowOf(UID);
    assert.equal(row.is_recurring, 0, `${what}: als Serie eingelesen`);
    assert.equal(row.external_rrule, 'FREQ=DAILY;INTERVAL=1', `${what}: die Sperre fehlt`);
    const res = await call('PATCH', `/${row.id}/status`, { status: 'done' });
    assert.equal(res.status, 409, `${what}: abgehakt`);
  }
});

// ── Dritte Review-Runde auf #2543 ───────────────────────────────────────────

test('Eine Serie mit Uhrzeit in einer anderen Zone als der Haushalt bleibt gesperrt (Review #2543)', async () => {
  // Haushalt UTC, Serie Donnerstag 00:30 Berlin, BYDAY=TH: hier steht sie am
  // Mittwoch 23:30, und der Rechner fuehrte den Wochentag der falschen Zone.
  reset();
  const berlin = appleSeries({ rrule: 'FREQ=WEEKLY;BYDAY=TH' })
    .replace(/DTSTART;VALUE=DATE:\d+\r\n/, '')
    .replace(/DUE;VALUE=DATE:\d+/, 'DUE;TZID=Europe/Berlin:20261105T003000');
  dav.putObject(listUrl, FILE, berlin);
  dav.putObject(listUrl, 'utc.ics', appleSeries({ uid: 'utc@phone', rrule: 'FREQ=WEEKLY;BYDAY=TH' })
    .replace(/DTSTART;VALUE=DATE:\d+\r\n/, '')
    .replace(/DUE;VALUE=DATE:\d+/, 'DUE:20261105T083000Z'));
  dav.putObject(listUrl, 'floating.ics', appleSeries({ uid: 'floating@phone', rrule: 'FREQ=WEEKLY;BYDAY=TH' })
    .replace(/DTSTART;VALUE=DATE:\d+\r\n/, '')
    .replace(/DUE;VALUE=DATE:\d+/, 'DUE:20261105T083000'));
  await remindersSync.sync();

  const row = rowOf(UID);
  assert.deepEqual([row.due_date, row.due_time], ['2026-11-04', '23:30'], 'Vorbedingung: der Tag kippt');
  assert.equal(row.is_recurring, 0, 'eine Serie in fremder Zone wird weitergefuehrt');
  assert.equal((await call('PATCH', `/${row.id}/status`, { status: 'done' })).status, 409);
  assert.equal(rowOf('utc@phone').is_recurring, 1, 'in der Zone des Haushalts geht es');
  assert.equal(rowOf('floating@phone').is_recurring, 1, 'schwebend ebenso');
});

test('DTSTART an einem anderen Tag als DUE: gesperrt (Review #2543)', async () => {
  // Start Montag, faellig Mittwoch, BYDAY=MO: der Rechner kennt nur DUE und
  // rueckte auf Montag statt Mittwoch.
  reset();
  dav.putObject(listUrl, FILE, appleSeries({ rrule: 'FREQ=WEEKLY;BYDAY=MO', due: '2026-11-04' })
    .replace(/DTSTART;VALUE=DATE:\d+/, 'DTSTART;VALUE=DATE:20261102'));
  await remindersSync.sync();
  const row = rowOf(UID);
  assert.equal(row.is_recurring, 0);
  assert.equal((await call('PATCH', `/${row.id}/status`, { status: 'done' })).status, 409);
});

test('Der Push ueberspringt eine Vormerkung, deren Zeile den Master inzwischen abgegeben hat (Review #2543)', async () => {
  // Waehrend der Push auf die Antwort einer anderen Aufgabe wartet, wird die
  // Serie abgehakt: die alte Zeile ist danach die lokale erledigte Kopie. Ihr
  // Schnappschuss nannte noch UID und Adresse des Masters - mit dem frischen
  // Stand gepatcht, ginge COMPLETED ohne RRULE auf den fremden Master.
  reset();
  dav.putObject(listUrl, FILE, appleSeries());
  dav.putObject(listUrl, 'other.ics', appleSeries({ uid: 'aaa@phone', rrule: 'FREQ=WEEKLY' }));
  await remindersSync.sync();
  const other = rowOf('aaa@phone');
  const master = rowOf(UID);
  // Die andere Aufgabe kommt zuerst dran (kleinere id).
  db.prepare('UPDATE tasks SET id = 1 WHERE id = ?').run(other.id);
  const masterId = master.id === 1 ? other.id : master.id;
  db.prepare("UPDATE tasks SET title = 'neu', outbound_dirty = 1 WHERE id IN (1, ?)").run(masterId);

  const index = new Map([
    ['aaa@phone', { url: `${listUrl}other.ics`, etag: '"x"', data: dav.getObject(listUrl, 'other.ics').data }],
    [UID, { url: `${listUrl}${FILE}`, etag: '"y"', data: dav.getObject(listUrl, FILE).data }],
  ]);
  const updated = [];
  let first = true;
  const client = {
    updateCalendarObject: async ({ calendarObject }) => {
      updated.push(calendarObject);
      if (first) {
        first = false;
        db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(masterId);
        const followup = Number(db.prepare(
          "INSERT INTO tasks (title, created_by, status, due_date, is_recurring, recurrence_rule) VALUES ('neu', ?, 'open', ?, 1, 'FREQ=DAILY')",
        ).run(ADMIN, dayKey(1)).lastInsertRowid);
        assert.ok(todoOutbound.handOverForeignSeries(taskOf(masterId), followup), 'Vorbedingung: uebergeben');
      }
      return {};
    },
  };
  await todoOutbound.processPendingUpdates(client, accountId, 'tasks', index);
  const toMaster = updated.filter((obj) => obj.url.endsWith(FILE));
  assert.ok(toMaster.every((obj) => !todoLines(obj.data, 'STATUS').includes('STATUS:COMPLETED')),
    'COMPLETED ging auf den fremden Master');
  assert.equal(toMaster.length, 0, 'die abgegebene Vormerkung wurde trotzdem gesendet');
});

test('DTSTART, das nicht genau DUE ist, sperrt; nach dem Abhaken bleibt Start gleich DUE (Review #2543)', async () => {
  // Start 08:00, faellig 09:00, ein Alarm relativ zum Start: rueckte Yuvomi den
  // Start auf Mitternacht, kaeme der Alarm am Vorabend.
  reset();
  const day = icsDay(dayKey(0));
  const timed = (uid, start) => appleSeries({ uid, rrule: 'FREQ=DAILY' })
    .replace(/DTSTART;VALUE=DATE:\d+/, `DTSTART:${day}T${start}Z`)
    .replace(/DUE;VALUE=DATE:\d+/, `DUE:${day}T090000Z`);
  dav.putObject(listUrl, FILE, timed(UID, '080000'));
  dav.putObject(listUrl, 'same.ics', timed('same@phone', '090000'));
  await remindersSync.sync();
  assert.equal(rowOf(UID).is_recurring, 0, 'Start 08:00, faellig 09:00 wird weitergefuehrt');
  assert.equal((await call('PATCH', `/${rowOf(UID).id}/status`, { status: 'done' })).status, 409);

  // Start gleich DUE: abbildbar, und das Abhaken haelt die Form.
  const same = rowOf('same@phone');
  assert.equal(same.is_recurring, 1);
  assert.equal((await call('PATCH', `/${same.id}/status`, { status: 'done' })).status, 200);
  await settle();
  const data = dav.getObject(listUrl, 'same.ics').data;
  const next = icsDay(dayKey(1));
  assert.deepEqual(todoLines(data, 'DUE').map((l) => l.replace(/^DUE[^:]*:/, '')), [`${next}T090000Z`]);
  assert.deepEqual(todoLines(data, 'DTSTART').map((l) => l.replace(/^DTSTART[^:]*:/, '')), [`${next}T090000Z`],
    'der Start steht nach dem Abhaken nicht mehr auf DUE');
  await remindersSync.sync();
  assert.equal(rowOf('same@phone').is_recurring, 1, 'nach dem eigenen Push gesperrt');
});
