/**
 * Test: Housekeeping-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - die zuvor ungetesteten Kern-
 *        Workflows: Worker-Anlage (Admin-Gate), Check-in/Check-out-Lifecycle
 *        inkl. Tages-Doppelbuchungs-Guard und Besuchssumme, Bezahlen/Löschen,
 *        Decay-Tasks-CRUD + Complete, Supply-Requests (koppelt Einkaufsartikel)
 *        und Maintenance-Log. Die Billing-Mathematik liegt in test-housekeeping.js.
 * Ausführen: node --experimental-sqlite --test test/test-housekeeping-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { computeHourlyAmount } = await import('../server/services/housekeeping-billing.js');
const db = dbmod.get();

const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const MEMBER = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('mem','Mem','x','member')`).run().lastInsertRowid;

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', housekeepingRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

const ADM = { id: ADMIN, role: 'admin' };
const MEM = { id: MEMBER, role: 'member' };

// --------------------------------------------------------------------------
// Worker-Anlage: Admin-Gate + Validierung
// --------------------------------------------------------------------------
test('POST /worker: Nicht-Admin -> 403', async () => {
  const r = await call('POST', '/worker', { as: MEM, body: { display_name: 'Putzhilfe', daily_rate: 50 } });
  assert.equal(r.status, 403);
});

test('POST /worker: fehlender daily_rate -> 400', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Putzhilfe' } });
  assert.equal(r.status, 400);
});

test('POST /worker: negativer daily_rate -> 400', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Putzhilfe', daily_rate: -5 } });
  assert.equal(r.status, 400);
});

test('POST /worker: ungültiger Username -> 400', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Putzhilfe', daily_rate: 50, username: 'a b!' } });
  assert.equal(r.status, 400);
});

let WORKER_ID;
test('POST /worker: Admin legt Tages-Worker an -> 201 und erscheint in /workers', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Putzhilfe', daily_rate: 50, rate_type: 'daily' } });
  assert.equal(r.status, 201);
  const list = await call('GET', '/workers', { as: ADM });
  assert.equal(list.body.data.length, 1);
  WORKER_ID = list.body.data[0].id;
  // Der angelegte Staff-Nutzer existiert (separater Login-Block ist in test-housekeeping.js geprüft).
  const staff = db.prepare('SELECT role FROM users WHERE id = (SELECT user_id FROM housekeeping_workers WHERE id = ?)').get(WORKER_ID);
  assert.equal(staff.role, 'member');
});

// --------------------------------------------------------------------------
// Check-in / Check-out-Lifecycle
// --------------------------------------------------------------------------
let SESSION_ID;
test('check-in: öffnet Session -> 201', async () => {
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: WORKER_ID, daily_rate: 50, extras: 10 } });
  assert.equal(r.status, 201);
  SESSION_ID = r.body.data.id;
  assert.ok(SESSION_ID);
});

test('check-in: zweiter Check-in am selben Tag -> 409', async () => {
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: WORKER_ID, daily_rate: 50 } });
  assert.equal(r.status, 409);
});

test('check-in: unbekannter Worker -> 404', async () => {
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: 999999, daily_rate: 50 } });
  assert.equal(r.status, 404);
});

test('check-out: schließt offene Session, Besuch erscheint mit total_amount = rate + extras', async () => {
  const r = await call('POST', '/work-sessions/check-out', { as: ADM, body: { worker_id: WORKER_ID } });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.check_out, 'check_out gesetzt');
  const visits = await call('GET', '/visits', { as: ADM });
  const visit = visits.body.data.visits.find((v) => v.id === SESSION_ID);
  assert.ok(visit, 'Besuch in Liste');
  assert.equal(visit.total_amount, 60, 'daily_rate 50 + extras 10');
});

test('check-out: keine offene Session mehr -> 404', async () => {
  const r = await call('POST', '/work-sessions/check-out', { as: ADM, body: { worker_id: WORKER_ID } });
  assert.equal(r.status, 404);
});

// --------------------------------------------------------------------------
// Besuch bezahlen / löschen
// --------------------------------------------------------------------------
test('POST /visits/:id/pay: markiert bezahlt', async () => {
  const r = await call('POST', `/visits/${SESSION_ID}/pay`, { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.paid_at, 'paid_at gesetzt');
});

test('DELETE /visits/:id: entfernt Besuch (danach 404)', async () => {
  const del = await call('DELETE', `/visits/${SESSION_ID}`, { as: ADM });
  assert.equal(del.status, 200);
  const get = await call('GET', `/visits/${SESSION_ID}`, { as: ADM });
  assert.equal(get.status, 404);
});

// --------------------------------------------------------------------------
// Decay-Tasks CRUD + Complete
// --------------------------------------------------------------------------
let DECAY_ID;
test('POST /decay-tasks: gültig -> 201', async () => {
  const r = await call('POST', '/decay-tasks', { as: ADM, body: { name: 'Kühlschrank', area: 'Küche', frequency_days: 30 } });
  assert.equal(r.status, 201);
  DECAY_ID = r.body.data.id;
});

test('POST /decay-tasks: frequency_days < 1 -> 400', async () => {
  const r = await call('POST', '/decay-tasks', { as: ADM, body: { name: 'X', area: 'Y', frequency_days: 0 } });
  assert.equal(r.status, 400);
});

test('PATCH /decay-tasks/:id: aktualisiert Feld', async () => {
  const r = await call('PATCH', `/decay-tasks/${DECAY_ID}`, { as: ADM, body: { frequency_days: 14 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.frequency_days, 14);
});

test('POST /decay-tasks/:id/complete: setzt last_completed', async () => {
  const r = await call('POST', `/decay-tasks/${DECAY_ID}/complete`, { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.last_completed, 'last_completed gesetzt');
});

test('DELETE /decay-tasks/:id: löscht, danach 404', async () => {
  const del = await call('DELETE', `/decay-tasks/${DECAY_ID}`, { as: ADM });
  assert.equal(del.status, 200);
  const again = await call('DELETE', `/decay-tasks/${DECAY_ID}`, { as: ADM });
  assert.equal(again.status, 404);
});

// --------------------------------------------------------------------------
// Supply-Requests (koppelt Einkaufsartikel) + Maintenance-Log
// --------------------------------------------------------------------------
test('POST /supply-requests: erzeugt Anfrage UND Einkaufsartikel', async () => {
  const r = await call('POST', '/supply-requests', { as: ADM, body: { name: 'Spülmittel', quantity: '2' } });
  assert.equal(r.status, 201);
  const itemId = r.body.shopping_item_id;
  assert.ok(itemId, 'shopping_item_id zurückgegeben');
  const item = db.prepare('SELECT name FROM shopping_items WHERE id = ?').get(itemId);
  assert.equal(item.name, 'Spülmittel', 'Einkaufsartikel angelegt');
});

test('POST /supply-requests: fehlender Name -> 400', async () => {
  const r = await call('POST', '/supply-requests', { as: ADM, body: { quantity: '1' } });
  assert.equal(r.status, 400);
});

test('POST /maintenance-log: gültig -> 201; fehlende description -> 400', async () => {
  const ok = await call('POST', '/maintenance-log', { as: ADM, body: { description: 'Wasserhahn tropft' } });
  assert.equal(ok.status, 201);
  const bad = await call('POST', '/maintenance-log', { as: ADM, body: {} });
  assert.equal(bad.status, 400);
});

// --------------------------------------------------------------------------
// POST /worker: weitere Validierungszweige (kein Zustandswechsel -> 400)
// --------------------------------------------------------------------------
test('POST /worker: negativer hourly_rate -> 400', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Stundenkraft', daily_rate: 0, rate_type: 'hourly', hourly_rate: -1 } });
  assert.equal(r.status, 400);
});

test('POST /worker: ungültiger rate_type -> 400', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'X', daily_rate: 10, rate_type: 'weekly' } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Lese-Handler: Summary / Work-Sessions / Visits (Filter + Monat-Validierung)
// --------------------------------------------------------------------------
test('GET /summary: ungültiger month -> 400', async () => {
  const r = await call('GET', '/summary?month=abc', { as: ADM });
  assert.equal(r.status, 400);
});

test('GET /summary: liefert current_session, default_daily_rate und summary', async () => {
  const r = await call('GET', '/summary', { as: ADM });
  assert.equal(r.status, 200);
  // Nach der Lifecycle-Löschung ist keine Session offen.
  assert.equal(r.body.data.current_session, null);
  // default_daily_rate stammt vom angelegten Worker (daily_rate 50).
  assert.equal(r.body.data.default_daily_rate, 50);
  const s = r.body.data.summary;
  assert.equal(typeof s.session_count, 'number');
  assert.equal(typeof s.total_amount, 'number');
});

test('GET /work-sessions: ungültiger month -> 400', async () => {
  const r = await call('GET', '/work-sessions?month=abc', { as: ADM });
  assert.equal(r.status, 400);
});

test('GET /work-sessions: liefert Sessions-Array', async () => {
  const r = await call('GET', '/work-sessions', { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('GET /visits: ungültige worker_id -> 400', async () => {
  const r = await call('GET', '/visits?worker_id=abc', { as: ADM });
  assert.equal(r.status, 400);
});

test('GET /visits: ungültiger month -> 400', async () => {
  const r = await call('GET', '/visits?month=abc', { as: ADM });
  assert.equal(r.status, 400);
});

test('GET /visits: worker_id-Filter liefert month/visits/totals', async () => {
  const r = await call('GET', `/visits?worker_id=${WORKER_ID}`, { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.visits));
  assert.ok(r.body.data.totals && typeof r.body.data.totals.total === 'number');
  assert.equal(typeof r.body.data.month, 'string');
});

test('GET /dashboard: liefert Kennzahlen-Shape', async () => {
  const r = await call('GET', '/dashboard', { as: ADM });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.ok(Array.isArray(d.workers) && d.workers.length >= 1);
  assert.ok(d.worker, 'erster Worker verfügbar');
  assert.equal(typeof d.visits_this_month, 'number');
  assert.equal(typeof d.pending_payments, 'number');
  assert.equal(typeof d.paid_this_month, 'number');
  assert.ok(Array.isArray(d.monthly_payments));
});

// --------------------------------------------------------------------------
// GET /decay-tasks: Dringlichkeits-Sortierung (overdue vor ok, rang-monoton)
// --------------------------------------------------------------------------
test('GET /decay-tasks: overdue vor ok, Rang monoton', async () => {
  // Ein frisch erledigter Task (freq 30 -> Fälligkeit in Zukunft -> ok)
  // und ein nie erledigter Task (kein last_completed -> overdue).
  const okTask = await call('POST', '/decay-tasks', { as: ADM, body: { name: 'Fenster', area: 'Wohnzimmer', frequency_days: 30 } });
  await call('POST', `/decay-tasks/${okTask.body.data.id}/complete`, { as: ADM });
  await call('POST', '/decay-tasks', { as: ADM, body: { name: 'Ofen', area: 'Küche', frequency_days: 30 } });

  const r = await call('GET', '/decay-tasks', { as: ADM });
  assert.equal(r.status, 200);
  const tasks = r.body.data;
  assert.ok(tasks.length >= 2);
  // Erster Task ist der überfällige.
  assert.equal(tasks[0].urgency_status, 'overdue');
  assert.equal(tasks[0].urgency, null, 'nie erledigt -> keine Dringlichkeitszahl');
  // Rang overdue < today < ok ist über die gesamte Liste monoton.
  const rank = { overdue: 0, today: 1, ok: 2 };
  for (let i = 1; i < tasks.length; i += 1) {
    assert.ok(rank[tasks[i - 1].urgency_status] <= rank[tasks[i].urgency_status], 'Rang-Sortierung monoton');
  }
  const okRow = tasks.find((t) => t.id === okTask.body.data.id);
  assert.equal(okRow.urgency_status, 'ok', 'frisch erledigt (freq 30) -> ok');
});

// --------------------------------------------------------------------------
// Payment-Tasks-Kopplung aktiviert (sync_config housekeeping_payment_tasks = '1')
// Deckt createPaymentTask, updateVisitLinks (Event- + Aufgaben-Zweig) und den
// payment_task-Zweig von POST /visits/:id/pay - Batch 4 lief bewusst ohne Setup.
// --------------------------------------------------------------------------
test('setup: Payment-Tasks aktivieren', () => {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('housekeeping_payment_tasks', '1')
              ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  const row = db.prepare(`SELECT value FROM sync_config WHERE key = 'housekeeping_payment_tasks'`).get();
  assert.equal(row.value, '1');
});

let PAY_SESSION_ID;
let PAYMENT_TASK_ID;
test('check-in: erzeugt verknüpfte Bezahl-Aufgabe', async () => {
  // Der Lifecycle-Besuch von oben wurde gelöscht -> heute wieder buchbar.
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: WORKER_ID, daily_rate: 50, extras: 0 } });
  assert.equal(r.status, 201);
  PAY_SESSION_ID = r.body.data.id;
  const session = db.prepare('SELECT payment_task_id, calendar_event_id FROM housekeeping_work_sessions WHERE id = ?').get(PAY_SESSION_ID);
  assert.ok(session.payment_task_id, 'payment_task_id gesetzt');
  assert.ok(session.calendar_event_id, 'calendar_event_id gesetzt');
  PAYMENT_TASK_ID = session.payment_task_id;
  const task = db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(PAYMENT_TASK_ID);
  assert.ok(task.title.includes('Putzhilfe'), 'Aufgabentitel nennt den Worker');
  assert.equal(task.status, 'open');
});

test('GET /visits/:id: liefert Besuch inkl. payment_task-Felder', async () => {
  const r = await call('GET', `/visits/${PAY_SESSION_ID}`, { as: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.id, PAY_SESSION_ID);
  assert.equal(r.body.data.payment_task_status, 'open');
  assert.ok(r.body.data.payment_task_title);
  assert.equal(r.body.data.total_amount, 50);
});

test('PUT /visits/:id: Datum+Betrag aktualisiert Besuch, Aufgabe und Kalender-Event', async () => {
  const r = await call('PUT', `/visits/${PAY_SESSION_ID}`, { as: ADM, body: { date: '2025-04-10', daily_rate: 80 } });
  assert.equal(r.status, 200);
  const session = db.prepare('SELECT daily_rate, check_in FROM housekeeping_work_sessions WHERE id = ?').get(PAY_SESSION_ID);
  assert.equal(session.daily_rate, 80);
  assert.equal(session.check_in.slice(0, 10), '2025-04-10');
  // Aufgaben-Zweig von updateVisitLinks: due_date und Betrag in der Beschreibung.
  const task = db.prepare('SELECT due_date, description FROM tasks WHERE id = ?').get(PAYMENT_TASK_ID);
  assert.equal(task.due_date, '2025-04-10');
  assert.ok(task.description.includes('80.00'), 'Beschreibung nennt neuen Betrag');
  // Event-Zweig von updateVisitLinks: start_datetime auf das neue Datum.
  const event = db.prepare('SELECT start_datetime FROM calendar_events WHERE id = (SELECT calendar_event_id FROM housekeeping_work_sessions WHERE id = ?)').get(PAY_SESSION_ID);
  assert.equal(event.start_datetime, '2025-04-10');
});

test('POST /visits/:id/pay: markiert verknüpfte Aufgabe als done', async () => {
  const r = await call('POST', `/visits/${PAY_SESSION_ID}/pay`, { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.paid_at);
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(PAYMENT_TASK_ID);
  assert.equal(task.status, 'done', 'Bezahl-Aufgabe abgeschlossen');
});

test('teardown: Payment-Tasks-Einstellung zurücksetzen', () => {
  db.prepare(`UPDATE sync_config SET value = '0' WHERE key = 'housekeeping_payment_tasks'`).run();
});

// --------------------------------------------------------------------------
// Stunden-Abrechnung (rate_type = hourly): Check-out berechnet den Betrag aus
// der Dauer, PUT aus minutes_worked. Deckt die Stunden-Zweige, die der
// Tagessatz-Lifecycle oben nicht berührt.
// --------------------------------------------------------------------------
let HOURLY_WORKER_ID;
let HOURLY_SESSION_ID;
test('POST /worker: Stundenkraft anlegen -> 201', async () => {
  const r = await call('POST', '/worker', { as: ADM, body: { display_name: 'Stundenhilfe', daily_rate: 0, rate_type: 'hourly', hourly_rate: 30 } });
  assert.equal(r.status, 201);
  const list = await call('GET', '/workers', { as: ADM });
  HOURLY_WORKER_ID = list.body.data.find((w) => w.display_name === 'Stundenhilfe').id;
});

test('check-in: Stundenkraft öffnet Session -> 201', async () => {
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: HOURLY_WORKER_ID, daily_rate: 0 } });
  assert.equal(r.status, 201);
  HOURLY_SESSION_ID = r.body.data.id;
});

test('check-out: negative extras -> 400 (Session bleibt offen)', async () => {
  const r = await call('POST', '/work-sessions/check-out', { as: ADM, body: { worker_id: HOURLY_WORKER_ID, extras: -1 } });
  assert.equal(r.status, 400);
});

test('check-out: Stundenkraft übernimmt rate_type und minutes_worked', async () => {
  const r = await call('POST', '/work-sessions/check-out', { as: ADM, body: { worker_id: HOURLY_WORKER_ID } });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT rate_type, hourly_rate, minutes_worked FROM housekeeping_work_sessions WHERE id = ?').get(HOURLY_SESSION_ID);
  assert.equal(row.rate_type, 'hourly');
  assert.equal(row.hourly_rate, 30);
  assert.notEqual(row.minutes_worked, null, 'Dauer wurde erfasst');
});

test('PUT /visits/:id: Stundenkraft berechnet Betrag aus minutes_worked', async () => {
  const r = await call('PUT', `/visits/${HOURLY_SESSION_ID}`, { as: ADM, body: { date: '2025-05-12', minutes_worked: 120 } });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT daily_rate, minutes_worked FROM housekeeping_work_sessions WHERE id = ?').get(HOURLY_SESSION_ID);
  assert.equal(row.minutes_worked, 120);
  // computeHourlyAmount als Orakel: 120 Min bei 30/h.
  assert.equal(row.daily_rate, computeHourlyAmount(120, 30));
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
