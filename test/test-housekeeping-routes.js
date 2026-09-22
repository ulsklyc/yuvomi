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

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { computeHourlyAmount } = await import('../server/services/housekeeping-billing.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
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
  req.sessionModuleAccess = actor.moduleAccess ?? null;
  req.authMethod = actor.authMethod;
  req.authScopes = actor.authScopes ?? null;
  next();
});
// Die Zahlungsaufgabe ist ein zweiter Weg an den bezahlten Besuch, deshalb
// haengt der Aufgaben-Router mit im selben Server (GHSA-4p5w-5346-8598).
app.use('/tasks-api', tasksRouter);
app.use('/', housekeepingRouter);
const server = app.listen(0, '127.0.0.1');
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
// Mitglied mit Housekeeping nur zum Lesen (#1135): GET kommt durch, Schreiben weist
// die Modul-Middleware in server/index.js ab - die ist hier nicht montiert.
const MEM_READ = { id: MEMBER, role: 'member', moduleAccess: { housekeeping: 'read' } };
// API-Token nur mit housekeeping:read, dessen Nutzer (Admin) sonst schreiben duerfte.
const TOKEN_READ = { id: ADMIN, role: 'admin', authMethod: 'api_token', authScopes: ['housekeeping:read'] };

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

test('check-in: zweiter Check-in bei OFFENER Session -> 409', async () => {
  // Der Name hiess bis #1138 "am selben Tag" und beschrieb damit die alte,
  // zu weite Sperre. Gemessen hat er immer diesen Fall hier: die Session aus
  // dem Test davor ist noch offen. Ueberlappende Sessions bleiben gesperrt.
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

test('check-in: nach dem Auschecken ist am selben Tag eine zweite Session erlaubt (#1138)', async () => {
  // Geteilte Schicht, Pause mit Wiederaufnahme, zwei getrennte Besuche: die
  // Sperre las vorher JEDE Session des Tages (`loadTodaySession`) und lehnte
  // deshalb auch nach einem sauberen Auschecken mit 409 ab.
  const r = await call('POST', '/work-sessions/check-in', { as: ADM, body: { worker_id: WORKER_ID, daily_rate: 40, extras: 0 } });
  assert.equal(r.status, 201, 'die zweite Session des Tages wird angelegt');
  const second = r.body.data.id;
  assert.notEqual(second, SESSION_ID, 'es ist eine eigene Session, nicht die alte');

  // Beide Sessions liegen am selben lokalen Tag und tragen ihre eigenen Daten.
  const rows = db.prepare(
    'SELECT id, check_in, check_out, daily_rate FROM housekeeping_work_sessions WHERE worker_id = ? ORDER BY id',
  ).all(WORKER_ID);
  assert.equal(rows.length, 2, 'zwei Sessions am selben Tag');
  assert.equal(rows[0].check_in.slice(0, 10), rows[1].check_in.slice(0, 10), 'derselbe Tag');
  assert.ok(rows[0].check_out, 'die erste ist abgeschlossen');
  assert.equal(rows[1].check_out, null, 'die zweite ist offen');
  assert.equal(rows[0].daily_rate, 50, 'die erste behaelt ihren eigenen Satz');
  assert.equal(rows[1].daily_rate, 40, 'die zweite ihren');
});

test('current_session traegt nur die OFFENE Session, today_session auch die geschlossene (#1133)', async () => {
  // Solange beide Felder dieselbe Zeile lieferten, blieb ein Arbeiter nach dem
  // Auschecken "eingecheckt" - und der Auscheck-Knopf im Frontend, der an
  // current_session haengt, war dauerhaft tot.
  const open = await call('GET', '/workers', { as: ADM });
  const w = open.body.data.find((item) => item.id === WORKER_ID);
  assert.ok(w.current_session, 'die zweite Session ist offen');
  assert.equal(w.current_session.check_out, null);

  const out = await call('POST', '/work-sessions/check-out', { as: ADM, body: { worker_id: WORKER_ID } });
  assert.equal(out.status, 200);

  const after = await call('GET', '/workers', { as: ADM });
  const w2 = after.body.data.find((item) => item.id === WORKER_ID);
  assert.equal(w2.current_session, null, 'ausgecheckt heisst: keine laufende Session');
  assert.ok(w2.today_session, 'der Besuch von heute steht weiterhin');
  assert.ok(w2.today_session.check_out, 'und zwar als abgeschlossener');
});

// --------------------------------------------------------------------------
// Besuch bezahlen / löschen
// --------------------------------------------------------------------------
test('POST /visits/:id/pay: markiert bezahlt', async () => {
  const r = await call('POST', `/visits/${SESSION_ID}/pay`, { as: ADM });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.paid_at, 'paid_at gesetzt');
});

// Ein bezahlter Besuch ist abgerechnet (GHSA-4p5w-5346-8598): Aendern, erneut
// Bezahlen und Loeschen verlangen ab da den Admin - dieselbe Grenze wie beim
// Anlegen des Arbeitsverhaeltnisses. Vorher bleibt der Zettel Mitgliedssache.
test('bezahlter Besuch: Mitglied darf nicht mehr aendern, erneut bezahlen oder loeschen -> 403', async () => {
  const before = db.prepare('SELECT daily_rate, extras, paid_at FROM housekeeping_work_sessions WHERE id = ?').get(SESSION_ID);
  assert.ok(before.paid_at, 'Fixture: der Besuch ist bezahlt');

  const put = await call('PUT', `/visits/${SESSION_ID}`, { as: MEM, body: { date: '2026-05-10', daily_rate: 99999, extras: 50000 } });
  assert.equal(put.status, 403, `erwartet 403, bekommen ${put.status}`);
  const pay = await call('POST', `/visits/${SESSION_ID}/pay`, { as: MEM });
  assert.equal(pay.status, 403);
  const del = await call('DELETE', `/visits/${SESSION_ID}`, { as: MEM });
  assert.equal(del.status, 403);

  const after = db.prepare('SELECT daily_rate, extras, paid_at FROM housekeeping_work_sessions WHERE id = ?').get(SESSION_ID);
  assert.deepEqual(after, before, 'die abgerechnete Zeile ist unveraendert');
});

test('unbezahlter Besuch: Mitglied darf weiter pflegen (kein Rueckschritt fuer den Alltag)', async () => {
  // Direkt eingefuegt: der Check-in kennt nur "heute", und heute ist schon belegt.
  const openId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by, rate_type)
    VALUES (?, '2026-06-01T09:00:00.000Z', '2026-06-01T12:00:00.000Z', 50, 0, ?, 'daily')
  `).run(WORKER_ID, MEMBER).lastInsertRowid;

  const put = await call('PUT', `/visits/${openId}`, { as: MEM, body: { date: '2026-06-01', daily_rate: 55, extras: 5 } });
  assert.equal(put.status, 200, `erwartet 200, bekommen ${put.status} ${JSON.stringify(put.body)}`);
  const del = await call('DELETE', `/visits/${openId}`, { as: MEM });
  assert.equal(del.status, 200);
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

// --------------------------------------------------------------------------
// Zahlung zuruecknehmen (#1136): nur ein Admin, spiegelbildlich zu /pay. Beide
// Rollen im Test - sonst waere ein Total-Admin-Gate ebenso gruen wie ein
// fehlendes. Fixture: PAY_SESSION_ID ist bezahlt (April 2025), die Aufgabe done.
// --------------------------------------------------------------------------
const sessionRow = (id) => db.prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(id);
const taskRow = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

test('can_mark_unpaid: nur fuer den Admin und nur bei bezahltem Besuch (#1136)', async () => {
  const unpaidId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by, rate_type)
    VALUES (?, '2025-04-11T09:00:00.000Z', '2025-04-11T12:00:00.000Z', 30, 0, ?, 'daily')
  `).run(WORKER_ID, ADMIN).lastInsertRowid;
  try {
    const pick = (res, id) => res.body.data.visits.find((v) => v.id === id);

    const adm = await call('GET', '/visits?month=2025-04', { as: ADM });
    assert.equal(pick(adm, PAY_SESSION_ID).can_mark_unpaid, true, 'Admin, bezahlter Besuch');
    assert.equal(pick(adm, unpaidId).can_mark_unpaid, false, 'Admin, unbezahlter Besuch: nichts zurueckzunehmen');

    const mem = await call('GET', '/visits?month=2025-04', { as: MEM });
    assert.equal(pick(mem, PAY_SESSION_ID).can_mark_unpaid, false, 'Mitglied, bezahlter Besuch');
    assert.equal(pick(mem, unpaidId).can_mark_unpaid, false, 'Mitglied, unbezahlter Besuch');

    const oneAdm = await call('GET', `/visits/${PAY_SESSION_ID}`, { as: ADM });
    assert.equal(oneAdm.body.data.can_mark_unpaid, true, 'GET /visits/:id traegt das Feld ebenso');
    const oneMem = await call('GET', `/visits/${PAY_SESSION_ID}`, { as: MEM });
    assert.equal(oneMem.body.data.can_mark_unpaid, false);
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(unpaidId);
  }
});

// #1135: Bearbeiten und Loeschen bietet die Seite nur an, wo der Server es
// zugesteht. Die Felder lesen dieselbe Funktion wie die Schreibsperre; der
// zweite Teil haelt fest, dass Feld und Route sich nicht widersprechen.
test('can_edit/can_delete: Admin immer, Mitglied nur am unbezahlten Besuch - und die Routen sagen dasselbe (#1135)', async () => {
  const unpaidId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by, rate_type)
    VALUES (?, '2025-04-12T09:00:00.000Z', '2025-04-12T12:00:00.000Z', 30, 0, ?, 'daily')
  `).run(WORKER_ID, ADMIN).lastInsertRowid;
  try {
    const pick = (res, id) => res.body.data.visits.find((v) => v.id === id);
    const caps = (v) => ({ can_edit: v.can_edit, can_delete: v.can_delete });
    const pays = (v) => ({ can_mark_paid: v.can_mark_paid, can_mark_unpaid: v.can_mark_unpaid });

    const adm = await call('GET', '/visits?month=2025-04', { as: ADM });
    assert.deepEqual(caps(pick(adm, PAY_SESSION_ID)), { can_edit: true, can_delete: true }, 'Admin, bezahlt');
    assert.deepEqual(caps(pick(adm, unpaidId)), { can_edit: true, can_delete: true }, 'Admin, unbezahlt');

    const mem = await call('GET', '/visits?month=2025-04', { as: MEM });
    assert.deepEqual(caps(pick(mem, PAY_SESSION_ID)), { can_edit: false, can_delete: false }, 'Mitglied, bezahlt');
    assert.deepEqual(caps(pick(mem, unpaidId)), { can_edit: true, can_delete: true }, 'Mitglied, unbezahlt');

    const oneMem = await call('GET', `/visits/${PAY_SESSION_ID}`, { as: MEM });
    assert.deepEqual(caps(oneMem.body.data), { can_edit: false, can_delete: false }, 'GET /visits/:id traegt die Felder ebenso');

    // Nur-Lese-Modulrecht: auch am unbezahlten Besuch nichts, was die Middleware abwiese.
    const readOnly = await call('GET', '/visits?month=2025-04', { as: MEM_READ });
    assert.deepEqual(caps(pick(readOnly, unpaidId)), { can_edit: false, can_delete: false }, 'Mitglied nur lesend, unbezahlt');
    const readOnlyOne = await call('GET', `/visits/${unpaidId}`, { as: MEM_READ });
    assert.deepEqual(caps(readOnlyOne.body.data), { can_edit: false, can_delete: false });
    assert.deepEqual(pays(pick(readOnly, unpaidId)), { can_mark_paid: false, can_mark_unpaid: false }, 'nur lesend: auch kein Bezahlen');

    // Bezahlen: nur am unbezahlten Besuch, fuer jeden mit Schreibrecht.
    assert.deepEqual(pays(pick(mem, unpaidId)), { can_mark_paid: true, can_mark_unpaid: false });
    assert.deepEqual(pays(pick(mem, PAY_SESSION_ID)), { can_mark_paid: false, can_mark_unpaid: false });
    assert.deepEqual(pays(pick(adm, PAY_SESSION_ID)), { can_mark_paid: false, can_mark_unpaid: true });

    // Ein housekeeping:read-Token: auch als Admin keine Schreib-Aktion.
    const token = await call('GET', '/visits?month=2025-04', { as: TOKEN_READ });
    assert.deepEqual({ ...caps(pick(token, PAY_SESSION_ID)), ...pays(pick(token, PAY_SESSION_ID)) },
      { can_edit: false, can_delete: false, can_mark_paid: false, can_mark_unpaid: false }, 'Lese-Token, bezahlt');
    assert.deepEqual({ ...caps(pick(token, unpaidId)), ...pays(pick(token, unpaidId)) },
      { can_edit: false, can_delete: false, can_mark_paid: false, can_mark_unpaid: false }, 'Lese-Token, unbezahlt');
    const oneAdm = await call('GET', `/visits/${PAY_SESSION_ID}`, { as: ADM });
    assert.deepEqual(caps(oneAdm.body.data), { can_edit: true, can_delete: true });

    // Feld false -> Route 403, Feld true -> Route laesst durch.
    const paidBefore = sessionRow(PAY_SESSION_ID);
    const putPaid = await call('PUT', `/visits/${PAY_SESSION_ID}`, { as: MEM, body: { date: '2025-04-10', daily_rate: 1, extras: 0 } });
    assert.equal(putPaid.status, 403);
    assert.equal((await call('DELETE', `/visits/${PAY_SESSION_ID}`, { as: MEM })).status, 403);
    assert.deepEqual(sessionRow(PAY_SESSION_ID), paidBefore, 'der bezahlte Besuch ist unveraendert');
    const putOpen = await call('PUT', `/visits/${unpaidId}`, { as: MEM, body: { date: '2025-04-12', daily_rate: 35, extras: 0 } });
    assert.equal(putOpen.status, 200, JSON.stringify(putOpen.body));
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(unpaidId);
  }
});

test('POST /visits/:id/unpay: Mitglied -> 403, Besuch UND Zahlungsaufgabe unveraendert (#1136)', async () => {
  const before = sessionRow(PAY_SESSION_ID);
  const taskBefore = taskRow(PAYMENT_TASK_ID);
  assert.ok(before.paid_at, 'Fixture: der Besuch ist bezahlt');
  assert.equal(taskBefore.status, 'done', 'Fixture: die Zahlungsaufgabe ist abgehakt');

  const r = await call('POST', `/visits/${PAY_SESSION_ID}/unpay`, { as: MEM });
  assert.equal(r.status, 403, `erwartet 403, bekommen ${r.status}`);

  assert.deepEqual(sessionRow(PAY_SESSION_ID), before, 'die abgerechnete Zeile ist unveraendert');
  assert.deepEqual(taskRow(PAYMENT_TASK_ID), taskBefore, 'die Zahlungsaufgabe bleibt abgehakt');
});

test('POST /visits/:id/unpay: Admin setzt paid_at zurueck und oeffnet die Zahlungsaufgabe wieder (#1136)', async () => {
  const r = await call('POST', `/visits/${PAY_SESSION_ID}/unpay`, { as: ADM });
  assert.equal(r.status, 200, `erwartet 200, bekommen ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.data.paid_at, null, 'Antwort: nicht mehr bezahlt');
  assert.ok(r.body.summary, 'Antwort traegt die Monatssumme wie /pay');

  assert.equal(sessionRow(PAY_SESSION_ID).paid_at, null, 'paid_at in der Zeile zurueckgesetzt');
  assert.equal(taskRow(PAYMENT_TASK_ID).status, 'open', 'die Zahlungsaufgabe ist wieder offen');

  // reconcilePaymentTasks() laeuft in GET /visits und bucht jede Zeile mit einer
  // abgehakten Aufgabe als bezahlt. Bliebe die Aufgabe done, kaeme die Zahlung
  // hier sofort zurueck.
  const list = await call('GET', '/visits?month=2025-04', { as: ADM });
  const visit = list.body.data.visits.find((v) => v.id === PAY_SESSION_ID);
  assert.equal(visit.paid_at, null, 'der naechste Lesezugriff bucht die Zahlung nicht zurueck');
  assert.equal(visit.payment_task_status, 'open');
  assert.equal(visit.can_mark_unpaid, false, 'unbezahlt gibt es nichts mehr zurueckzunehmen');
});

test('POST /visits/:id/unpay: unbezahlter Besuch -> 200, nichts geaendert (#1136)', async () => {
  const before = sessionRow(PAY_SESSION_ID);
  const taskBefore = taskRow(PAYMENT_TASK_ID);
  assert.equal(before.paid_at, null, 'Fixture: der Besuch ist unbezahlt');

  const r = await call('POST', `/visits/${PAY_SESSION_ID}/unpay`, { as: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.paid_at, null);
  assert.deepEqual(sessionRow(PAY_SESSION_ID), before, 'Zeile unveraendert');
  assert.deepEqual(taskRow(PAYMENT_TASK_ID), taskBefore, 'Aufgabe unveraendert');
});

test('POST /visits/:id/unpay: unbekannte id -> 404, ungueltige id -> 400 (#1136)', async () => {
  const missing = await call('POST', '/visits/999999/unpay', { as: ADM });
  assert.equal(missing.status, 404);
  const invalid = await call('POST', '/visits/abc/unpay', { as: ADM });
  assert.equal(invalid.status, 400);
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

// ---------------------------------------------------------------------------
// Datensprache und Outbound-Kopplung der Besuchs-Artefakte
//
// Die Oberfläche schickt Titel und Beschreibung übersetzt mit; diese Fallbacks
// greifen für alles, was die API direkt anspricht. Sie standen fest auf
// Englisch, obwohl die Texte in calendar_events/tasks landen und von dort in
// API, ICS-Feed und Sync gehen - dieselbe Ursache wie #631/#632.
// ---------------------------------------------------------------------------

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

async function freshWorker(name) {
  await call('POST', '/worker', {
    as: ADM,
    body: { username: name, display_name: name, password: 'secret123', daily_rate: 40 },
  });
  const list = await call('GET', '/workers', { as: ADM });
  return list.body.data.find((w) => w.display_name === name).id;
}

let LOCALIZED_SESSION;

test('Fallback-Titel folgen der Datensprache des Haushalts', async () => {
  setConfig('language', 'de');
  setConfig('date_format', 'dmy');
  setConfig('currency', 'EUR');
  setConfig('housekeeping_payment_tasks', '1');

  const workerId = await freshWorker('Marta');
  // Bewusst ohne event_title/payment_* - genau der Pfad eines API-Aufrufers.
  const r = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, extras: 5, local_date: '2025-06-02' },
  });
  assert.equal(r.status, 201);
  LOCALIZED_SESSION = r.body.data.id;

  const row = db.prepare(`
    SELECT calendar_event_id, payment_task_id FROM housekeeping_work_sessions WHERE id = ?
  `).get(LOCALIZED_SESSION);

  const event = db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(row.calendar_event_id);
  assert.equal(event.title, 'Haushaltshilfe: Marta');

  const task = db.prepare('SELECT title, description FROM tasks WHERE id = ?').get(row.payment_task_id);
  assert.equal(task.title, 'Marta für Haushaltshilfe bezahlen');
  // Datum nach date_format, Betrag als Währung - wie der Client es schriebe.
  assert.match(task.description, /02\.06\.2025/);
  assert.match(task.description, /45/);
});

test('ohne gesetzte Sprache bleibt es beim englischen Bestandsverhalten', async () => {
  db.prepare(`DELETE FROM sync_config WHERE key IN ('language', 'region')`).run();
  // Sprache am Ende wiederherstellen: die Folgetests pruefen deutsche Texte, und
  // ohne das schriebe updateVisitLinks die Beschreibung stillschweigend auf
  // Englisch zurueck - der Test davor haette dann eine Zusicherung gemacht, die
  // der naechste Aufruf widerlegt.

  const workerId = await freshWorker('Nina');
  const r = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, local_date: '2025-06-03' },
  });
  const row = db.prepare('SELECT calendar_event_id FROM housekeeping_work_sessions WHERE id = ?').get(r.body.data.id);
  const event = db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(row.calendar_event_id);
  assert.equal(event.title, 'Housekeeping: Nina');

  setConfig('language', 'de');
});

test('ein verschobener Besuch wird zum Provider nachgezogen', async () => {
  // Der Termin liegt bereits beim Provider: der Apple-Sync lädt jedes lokale
  // Event ohne Kalenderzuordnung hoch und stellt die Zeile danach auf 'apple'.
  // Ab da erreicht ihn nur noch outbound_dirty (#632).
  setConfig('apple_caldav_url', 'https://caldav.icloud.com/');
  const row = db.prepare('SELECT calendar_event_id FROM housekeeping_work_sessions WHERE id = ?').get(LOCALIZED_SESSION);
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'apple', external_calendar_id = 'hk-test@oikos.local',
        external_object_url = 'https://caldav.icloud.com/home/hk-test.ics', outbound_dirty = 0
    WHERE id = ?
  `).run(row.calendar_event_id);

  const r = await call('PUT', `/visits/${LOCALIZED_SESSION}`, { as: ADM, body: { date: '2025-06-09', daily_rate: 40 } });
  assert.equal(r.status, 200);

  const event = db.prepare('SELECT start_datetime, outbound_dirty FROM calendar_events WHERE id = ?')
    .get(row.calendar_event_id);
  assert.equal(event.start_datetime, '2025-06-09');
  assert.equal(event.outbound_dirty, 1, 'die Verschiebung muss den Provider erreichen');
});

test('im Nur-Lesen-Modus bleibt der verschobene Besuch gegen den Inbound geschützt', async () => {
  // Ein schreibgeschützter Provider nimmt den Push nicht an - der Marker ist aber
  // auch der Schutz davor, dass der Inbound das neue Datum überschreibt.
  setConfig('google_refresh_token', 'token');
  setConfig('google_readonly', '1');

  const workerId = await freshWorker('Rita');
  const created = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, local_date: '2025-07-01' },
  });
  const row = db.prepare('SELECT calendar_event_id AS id FROM housekeeping_work_sessions WHERE id = ?')
    .get(created.body.data.id);
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'google', external_calendar_id = ?, outbound_dirty = 0 WHERE id = ?
  `).run(`hk-ro-${row.id}@google`, row.id);

  await call('PUT', `/visits/${created.body.data.id}`, { as: ADM, body: { date: '2025-07-08', daily_rate: 40 } });

  const event = db.prepare('SELECT start_datetime, outbound_dirty FROM calendar_events WHERE id = ?').get(row.id);
  assert.equal(event.start_datetime, '2025-07-08');
  assert.equal(event.outbound_dirty, 1, 'ohne Marker überschriebe der nächste Inbound das alte Datum zurück');

  db.prepare(`DELETE FROM sync_config WHERE key IN ('google_refresh_token', 'google_readonly')`).run();
});

test('ein gelöschter Besuch räumt die Kopie beim Provider mit ab', async () => {
  const row = db.prepare('SELECT calendar_event_id FROM housekeeping_work_sessions WHERE id = ?').get(LOCALIZED_SESSION);
  const before = db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c;

  const r = await call('DELETE', `/visits/${LOCALIZED_SESSION}`, { as: ADM });
  assert.equal(r.status, 200);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_events WHERE id = ?').get(row.calendar_event_id).c,
    0,
    'lokal gelöscht',
  );
  assert.ok(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c > before,
    'die Löschung beim Provider muss vorgemerkt sein, sonst bleibt der Termin dort stehen',
  );
});

test('ein rein lokaler Besuch merkt nichts beim Provider vor', async () => {
  const workerId = await freshWorker('Tomas');
  const created = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, local_date: '2025-06-04' },
  });
  const before = db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c;

  await call('DELETE', `/visits/${created.body.data.id}`, { as: ADM });

  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c,
    before,
    'ohne Provider-Zuordnung gibt es dort nichts zu löschen',
  );
});

// ---------------------------------------------------------------------------
// Die Zahlungsaufgabe als zweiter Weg (GHSA-4p5w-5346-8598). Verliess die Aufgabe
// eines BEZAHLTEN Besuchs 'done', setzte syncHousekeepingPaymentStatus paid_at
// zurueck, und danach waren Aendern und Loeschen des Besuchs wieder
// Mitgliedssache. Beide Aufgaben-Wege - Formular (PUT) und Status (PATCH, auch
// Checkbox, Swipe, Sammelaktion) - halten jetzt dieselbe Grenze wie die
// Besuchsrouten. Beide Rollen im Test, sonst waere auch ein Total-Gate gruen.
// ---------------------------------------------------------------------------

async function paidVisitWithTask(name, localDate) {
  setConfig('housekeeping_payment_tasks', '1');
  const workerId = await freshWorker(name);
  const created = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, local_date: localDate },
  });
  assert.equal(created.status, 201, `Fixture: Check-in ${created.status} ${JSON.stringify(created.body)}`);
  const visitId = created.body.data.id;
  const paid = await call('POST', `/visits/${visitId}/pay`, { as: ADM });
  assert.equal(paid.status, 200);
  const row = db.prepare('SELECT paid_at, payment_task_id FROM housekeeping_work_sessions WHERE id = ?').get(visitId);
  assert.ok(row.paid_at, 'Fixture: der Besuch ist bezahlt');
  assert.ok(row.payment_task_id, 'Fixture: der Besuch hat eine Zahlungsaufgabe');
  return { visitId, taskId: row.payment_task_id };
}

const visitRow = (id) => db.prepare('SELECT paid_at, daily_rate, extras FROM housekeeping_work_sessions WHERE id = ?').get(id);
const taskStatus = (id) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status;

test('bezahlter Besuch: Mitglied oeffnet die Zahlungsaufgabe nicht wieder (PATCH status) -> 403', async () => {
  const { visitId, taskId } = await paidVisitWithTask('Pia', '2025-07-01');
  const before = visitRow(visitId);

  const r = await call('PATCH', `/tasks-api/${taskId}/status`, { as: MEM, body: { status: 'open' } });
  assert.equal(r.status, 403, `erwartet 403, bekommen ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(taskStatus(taskId), 'done', 'die Aufgabe bleibt erledigt');
  assert.deepEqual(visitRow(visitId), before, 'der Besuch bleibt bezahlt und unveraendert');

  // Der eigentliche Schaden: ohne die Grenze gingen danach Aendern und Loeschen durch.
  const put = await call('PUT', `/visits/${visitId}`, { as: MEM, body: { date: '2025-07-01', daily_rate: 99999, extras: 0 } });
  assert.equal(put.status, 403);
  const del = await call('DELETE', `/visits/${visitId}`, { as: MEM });
  assert.equal(del.status, 403);
  assert.deepEqual(visitRow(visitId), before);
});

test('bezahlter Besuch: Mitglied oeffnet die Zahlungsaufgabe nicht ueber das Formular (PUT) -> 403', async () => {
  const { visitId, taskId } = await paidVisitWithTask('Rosa', '2025-07-02');
  const before = visitRow(visitId);

  const r = await call('PUT', `/tasks-api/${taskId}`, { as: MEM, body: { status: 'in_progress' } });
  assert.equal(r.status, 403, `erwartet 403, bekommen ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(taskStatus(taskId), 'done');
  assert.deepEqual(visitRow(visitId), before);
});

test('bezahlter Besuch: ein Admin darf die Zahlungsaufgabe wieder oeffnen', async () => {
  const { visitId, taskId } = await paidVisitWithTask('Sara', '2025-07-03');

  const r = await call('PATCH', `/tasks-api/${taskId}/status`, { as: ADM, body: { status: 'open' } });
  assert.equal(r.status, 200, `erwartet 200, bekommen ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(taskStatus(taskId), 'open');
  assert.equal(visitRow(visitId).paid_at, null, 'der Admin nimmt die Zahlung damit zurueck');
});

test('unbezahlter Besuch: Mitglied bewegt die Zahlungsaufgabe weiter frei', async () => {
  setConfig('housekeeping_payment_tasks', '1');
  const workerId = await freshWorker('Tina');
  const created = await call('POST', '/work-sessions/check-in', {
    as: ADM,
    body: { worker_id: workerId, daily_rate: 40, local_date: '2025-07-04' },
  });
  const visitId = created.body.data.id;
  const { payment_task_id: taskId } = db.prepare('SELECT payment_task_id FROM housekeeping_work_sessions WHERE id = ?').get(visitId);
  assert.ok(taskId, 'Fixture: der Besuch hat eine Zahlungsaufgabe');

  const progress = await call('PATCH', `/tasks-api/${taskId}/status`, { as: MEM, body: { status: 'in_progress' } });
  assert.equal(progress.status, 200, `erwartet 200, bekommen ${progress.status} ${JSON.stringify(progress.body)}`);
  const done = await call('PATCH', `/tasks-api/${taskId}/status`, { as: MEM, body: { status: 'done' } });
  assert.equal(done.status, 200, 'abhaken bleibt Mitgliedssache - es ist dasselbe wie Bezahlen');
  assert.ok(visitRow(visitId).paid_at, 'abgehakt heisst bezahlt');
});

// --------------------------------------------------------------------------
// Tage und Monate folgen der Haushaltszone, nicht der Zone des Servers
// und nicht UTC.
//
// Die Uhr steht dafuer fest und die Zone ist ausdruecklich gesetzt: der
// Unterschied existiert nur ein paar Stunden am Tages- bzw. Monatsrand, eine
// Probe zur Tagesmitte waere in jeder Zone gruen. Die Maschinenzone darf das
// Ergebnis nicht bestimmen, deshalb je eine Probe oestlich (Kiritimati, +14)
// und westlich (Niue, -11) - die alte Rechnung in der Serverzone lag in UTC,
// Europa und Amerika bei beiden daneben.
// --------------------------------------------------------------------------
function setHouseholdZone(zone) {
  if (zone === null) {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    return;
  }
  setConfig('household_timezone', zone);
}

async function atClock(isoInstant, fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date(isoInstant) });
  try { return await fn(); } finally { mock.timers.reset(); }
}

async function decayTaskStatus({ zone, lastCompleted, now }) {
  setHouseholdZone(zone);
  const id = db.prepare(`
    INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
    VALUES ('Zonenprobe', 'Flur', 7, ?, ?)
  `).run(lastCompleted, ADMIN).lastInsertRowid;
  try {
    const r = await atClock(now, () => call('GET', '/decay-tasks', { as: ADM }));
    assert.equal(r.status, 200);
    return r.body.data.find((task) => task.id === id);
  } finally {
    db.prepare('DELETE FROM housekeeping_decay_tasks WHERE id = ?').run(id);
    setHouseholdZone(null);
  }
}

test('Dringlichkeit: der Faelligkeitstag ist ein Tag des Haushalts (oestlich von UTC)', async () => {
  // Erledigt am 15.09. um 01:00 Kiritimati-Zeit, Rhythmus 7 Tage: faellig am
  // 22.09. Gefragt am 21.09. um 23:00 Kiritimati-Zeit - noch nicht heute.
  // In UTC (und jeder Zone bis +12) war es am 14.09. erledigt und am 21.09.
  // faellig, also "heute".
  const task = await decayTaskStatus({
    zone: 'Pacific/Kiritimati',
    lastCompleted: '2026-09-14T11:00:00.000Z',
    now: '2026-09-21T09:00:00.000Z',
  });
  assert.equal(task.urgency_status, 'ok', 'faellig ist erst morgen, der 22.09. des Haushalts');
  assert.equal(task.due_date, '2026-09-21T11:00:00.000Z', 'sieben Haushaltstage nach dem Erledigen, zur selben Uhrzeit');
});

test('Dringlichkeit: der Faelligkeitstag ist ein Tag des Haushalts (westlich von UTC)', async () => {
  // Erledigt am 15.09. um 01:30 Niue-Zeit, faellig am 22.09.; gefragt am
  // 21.09. um 23:30 Niue-Zeit. In UTC ist es da schon der 22.09.
  const task = await decayTaskStatus({
    zone: 'Pacific/Niue',
    lastCompleted: '2026-09-15T12:30:00.000Z',
    now: '2026-09-22T10:30:00.000Z',
  });
  assert.equal(task.urgency_status, 'ok');

  const dueToday = await decayTaskStatus({
    zone: 'Pacific/Niue',
    lastCompleted: '2026-09-15T12:30:00.000Z',
    now: '2026-09-22T11:30:00.000Z',
  });
  assert.equal(dueToday.urgency_status, 'today', 'eine Stunde spaeter beginnt der 22.09. in Niue');
});

// Ein Besuch am 01.10. um 00:30 Berliner Zeit ist in UTC noch der 30.09.
const OCTOBER_VISIT_AT = '2026-09-30T22:30:00.000Z';

function insertVisitAt(checkIn) {
  return db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, created_by)
    VALUES (?, ?, 55, 0, ?)
  `).run(checkIn, checkIn, ADMIN).lastInsertRowid;
}

test('Monatsgrenze: ein Besuch gehoert zum Monat des Haushalts, nicht zum UTC-Monat', async () => {
  setHouseholdZone('Europe/Berlin');
  const visitId = insertVisitAt(OCTOBER_VISIT_AT);
  try {
    const october = await call('GET', '/visits?month=2026-10', { as: ADM });
    assert.equal(october.status, 200);
    assert.deepEqual(october.body.data.visits.map((v) => v.id), [visitId], 'der Besuch steht im Oktober');
    assert.equal(october.body.data.totals.total, 55);

    // Andere Tests dieser Suite checken zur echten Uhr ein, der September kann
    // also Besuche haben - gefragt wird nur nach diesem einen.
    const september = await call('GET', '/visits?month=2026-09', { as: ADM });
    assert.equal(september.body.data.visits.some((v) => v.id === visitId), false, 'und nicht im September');

    const sessions = await call('GET', '/work-sessions?month=2026-10', { as: ADM });
    assert.deepEqual(sessions.body.data.map((v) => v.id), [visitId]);

    const summary = await call('GET', '/summary?month=2026-10', { as: ADM });
    assert.equal(summary.body.data.summary.session_count, 1);
    assert.equal(summary.body.data.summary.total_amount, 55);
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(visitId);
    setHouseholdZone(null);
  }
});

test('Monatsgrenze: ohne ?month= gilt der laufende Monat des Haushalts', async () => {
  setHouseholdZone('Europe/Berlin');
  // 01.10. 01:00 in Berlin, in UTC noch September.
  const CLOCK = '2026-09-30T23:00:00.000Z';
  const septemberTotal = (data) => data.monthly_payments.find((row) => row.month === '2026-09')?.total ?? 0;
  const baseline = await atClock(CLOCK, () => call('GET', '/dashboard', { as: ADM }));
  const visitId = insertVisitAt(OCTOBER_VISIT_AT);
  try {
    await atClock(CLOCK, async () => {
      const visits = await call('GET', '/visits', { as: ADM });
      assert.equal(visits.body.data.month, '2026-10');
      assert.deepEqual(visits.body.data.visits.map((v) => v.id), [visitId]);

      const summary = await call('GET', '/summary', { as: ADM });
      assert.equal(summary.body.data.summary.month, '2026-10');
      assert.equal(summary.body.data.summary.session_count, 1);

      const dashboard = await call('GET', '/dashboard', { as: ADM });
      assert.equal(dashboard.body.data.visits_this_month, 1, 'die Kachel zaehlt den Besuch im Oktober');
      const chartRow = dashboard.body.data.monthly_payments.find((row) => row.month === '2026-10');
      assert.equal(chartRow?.total, 55, 'die Monatsgrafik bucht ihn auf den Oktober');
      assert.equal(septemberTotal(dashboard.body.data), septemberTotal(baseline.body.data),
        'und nicht auf den September');
    });
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(visitId);
    setHouseholdZone(null);
  }
});

test('Monatsgrenze: eine am Monatsersten frueh erledigte Aufgabe zaehlt im neuen Monat', async () => {
  setHouseholdZone('Europe/Berlin');
  const id = db.prepare(`
    INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
    VALUES ('Monatsprobe', 'Flur', 30, ?, ?)
  `).run(OCTOBER_VISIT_AT, ADMIN).lastInsertRowid;
  try {
    const before = await atClock('2026-10-15T10:00:00.000Z', () => call('GET', '/dashboard', { as: ADM }));
    assert.equal(before.body.data.finished_tasks_this_month, 1);
  } finally {
    db.prepare('DELETE FROM housekeeping_decay_tasks WHERE id = ?').run(id);
    setHouseholdZone(null);
  }
});

// --------------------------------------------------------------------------
// Beleg eines Besuchs: Name UND Verknuepfung folgen dem Dokumentenrecht (#1358)
// --------------------------------------------------------------------------
// Der Besuch bleibt beim Quellmodul housekeeping, der Beleg ist aber eine Zeile
// des Dokumente-Moduls. Name und ID gehen deshalb nur an, wer das Dokument
// lesen darf - Modulachse (Mitgliedsrecht UND Token-Scope) plus Sichtbarkeit
// des einzelnen Dokuments. Uebrig bleibt das housekeeping-eigene `has_receipt`.
function insertDocument(name, visibility, createdBy) {
  return db.prepare(`
    INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'finance', ?, ?, 'text/plain', 1, 'x', ?)
  `).run(name, visibility, `${name}.txt`, createdBy).lastInsertRowid;
}

function insertVisitWithReceipt(checkIn, documentId, { open = false, workerId = null } = {}) {
  return db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by, receipt_document_id)
    VALUES (?, ?, ?, 40, 0, ?, ?)
  `).run(workerId, checkIn, open ? null : checkIn, ADMIN, documentId).lastInsertRowid;
}

function storedReceipt(visitId) {
  return db.prepare('SELECT receipt_document_id FROM housekeeping_work_sessions WHERE id = ?').get(visitId).receipt_document_id;
}

const receiptOf = (session) => session && {
  id: session.receipt_document_id,
  has: session.has_receipt,
  ...(Object.hasOwn(session, 'receipt_document_name') ? { name: session.receipt_document_name } : {}),
};

test('Beleg: Name und ID nur fuer wer das Dokument lesen darf - Liste und Einzelbericht (#1358)', async () => {
  const familyDoc = insertDocument('Quittung Familie', 'family', ADMIN);
  const privateDoc = insertDocument('Quittung privat', 'private', ADMIN);
  const memberPrivateDoc = insertDocument('Quittung Mitglied', 'private', MEMBER);
  const familyVisit = insertVisitWithReceipt('2026-05-12T10:00:00.000Z', familyDoc);
  const privateVisit = insertVisitWithReceipt('2026-05-13T10:00:00.000Z', privateDoc);
  const memberVisit = insertVisitWithReceipt('2026-05-14T10:00:00.000Z', memberPrivateDoc);
  const visitIds = [familyVisit, privateVisit, memberVisit];
  const receipts = async (as) => {
    const list = await call('GET', '/visits?month=2026-05', { as });
    assert.equal(list.status, 200);
    const byId = new Map(list.body.data.visits.map((v) => [v.id, v]));
    const sessions = await call('GET', '/work-sessions?month=2026-05', { as });
    assert.equal(sessions.status, 200);
    const sessionById = new Map(sessions.body.data.map((s) => [s.id, s]));
    const out = { list: [], detail: [], sessions: [] };
    for (const id of visitIds) {
      const one = await call('GET', `/visits/${id}`, { as });
      assert.equal(one.status, 200);
      out.list.push(receiptOf(byId.get(id)));
      out.detail.push(receiptOf(one.body.data));
      out.sessions.push(receiptOf(sessionById.get(id)));
    }
    return out;
  };
  const expect = (...seen) => {
    const docs = [familyDoc, privateDoc, memberPrivateDoc];
    const names = ['Quittung Familie', 'Quittung privat', 'Quittung Mitglied'];
    const withName = seen.map((ok, i) => ({ id: ok ? docs[i] : null, has: true, name: ok ? names[i] : null }));
    return { list: withName, detail: withName, sessions: withName.map(({ id, has }) => ({ id, has })) };
  };
  try {
    assert.deepEqual(await receipts(ADM), expect(true, true, false),
      'der Admin sieht, was er angelegt hat - ein fremdes privates Dokument nicht, Admin hin oder her');
    assert.deepEqual(await receipts(MEM), expect(true, false, true),
      'ein Mitglied sieht Familie und Eigenes, nicht das private des Admins');
    assert.deepEqual(await receipts({ ...MEM, moduleAccess: { documents: 'read' } }), expect(true, false, true),
      'Leserecht auf die Dokumente reicht');
    assert.deepEqual(await receipts({ ...MEM, moduleAccess: { documents: 'none' } }), expect(false, false, false),
      'documents: none bekommt weder Namen noch ID, auch nicht fuer das eigene Dokument');
    assert.deepEqual(await receipts(TOKEN_READ), expect(false, false, false),
      'ein Token ohne documents-Scope bekommt weder Namen noch ID');
    assert.deepEqual(await receipts({ ...TOKEN_READ, authScopes: ['housekeeping:read', 'documents:read'] }), expect(true, true, false),
      'mit documents:read liefert das Token, was sein Nutzer sieht');
    assert.deepEqual(await receipts({ id: MEMBER, role: 'member', authMethod: 'api_token', authScopes: ['housekeeping:read', 'documents:read'] }),
      expect(true, false, true), 'ein Mitglieds-Token mit documents:read sieht das fremde private Dokument trotzdem nicht');

    db.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)').run(privateDoc, MEMBER);
    assert.deepEqual(await receipts(MEM), expect(true, true, true), 'eine Freigabe an das Mitglied macht den Beleg sichtbar');
  } finally {
    db.prepare(`DELETE FROM housekeeping_work_sessions WHERE id IN (${visitIds.map(() => '?').join(', ')})`).run(...visitIds);
    db.prepare('DELETE FROM family_documents WHERE id IN (?, ?, ?)').run(familyDoc, privateDoc, memberPrivateDoc);
  }
});

test('Beleg: jeder Serialisierer maskiert die ID - Arbeiter, Status, Dashboard, Check-out, Bezahlen, Bearbeiten (#1358)', async () => {
  const privateDoc = insertDocument('Quittung privat', 'private', ADMIN);
  const created = await call('POST', '/worker', { as: ADM, body: { display_name: 'Belegprobe', daily_rate: 40, rate_type: 'daily' } });
  assert.equal(created.status, 201);
  const workerId = created.body.data.id;
  const visitId = insertVisitWithReceipt(new Date().toISOString(), privateDoc, { open: true, workerId });
  const masked = { id: null, has: true };
  try {
    const workers = await call('GET', '/workers', { as: MEM });
    const worker = workers.body.data.find((w) => w.id === workerId);
    assert.equal(worker.current_session.id, visitId);
    assert.deepEqual(receiptOf(worker.current_session), masked, 'current_session am Arbeiter');
    assert.deepEqual(receiptOf(worker.today_session), masked, 'today_session am Arbeiter');

    const summary = await call('GET', '/summary', { as: MEM });
    assert.equal(summary.body.data.current_session.id, visitId);
    assert.deepEqual(receiptOf(summary.body.data.current_session), masked, 'current_session in /summary');

    const dashboard = await call('GET', '/dashboard', { as: MEM });
    assert.equal(dashboard.body.data.last_visit.id, visitId);
    assert.deepEqual(receiptOf(dashboard.body.data.last_visit), masked, 'last_visit im Dashboard');
    const dashWorker = dashboard.body.data.workers.find((w) => w.id === workerId);
    assert.deepEqual(receiptOf(dashWorker.current_session), masked, 'Arbeiter im Dashboard');

    const adminView = await call('GET', '/summary', { as: ADM });
    assert.deepEqual(receiptOf(adminView.body.data.current_session), { id: privateDoc, has: true }, 'die Erstellerin sieht die ID');

    const checkedOut = await call('POST', '/work-sessions/check-out', { as: MEM, body: { worker_id: workerId } });
    assert.equal(checkedOut.status, 200);
    assert.deepEqual(receiptOf(checkedOut.body.data), masked, 'Check-out-Antwort');

    const date = checkedOut.body.data.check_in.slice(0, 10);
    const edited = await call('PUT', `/visits/${visitId}`, { as: MEM, body: { date, daily_rate: 40, extras: 0 } });
    assert.equal(edited.status, 200);
    assert.deepEqual(receiptOf(edited.body.data), masked, 'PUT-Antwort');

    const paid = await call('POST', `/visits/${visitId}/pay`, { as: MEM });
    assert.equal(paid.status, 200);
    assert.deepEqual(receiptOf(paid.body.data), masked, 'Bezahlen-Antwort');
    assert.equal(storedReceipt(visitId), privateDoc, 'gespeichert bleibt der Beleg unberuehrt');
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(visitId);
    db.prepare('DELETE FROM family_documents WHERE id = ?').run(privateDoc);
    db.prepare('DELETE FROM housekeeping_workers WHERE id = ?').run(workerId);
  }
});

test('Beleg: wer den gespeicherten nicht sieht, kann ihn weder loesen noch ersetzen (#1358)', async () => {
  // Regel 2 aus services/document-links.js: Entfernen kann man nur, was man
  // sieht. Der Dialog schickt bei maskierter ID `null` zurueck - das heisst
  // "behalten", nicht "loesen".
  const privateDoc = insertDocument('Quittung privat', 'private', ADMIN);
  const ownDoc = insertDocument('Eigene Quittung', 'private', MEMBER);
  const visitId = insertVisitWithReceipt('2026-05-14T10:00:00.000Z', privateDoc);
  const put = (as, extra) => call('PUT', `/visits/${visitId}`, {
    as,
    body: { date: '2026-05-14', daily_rate: 45, extras: 0, ...extra },
  });
  try {
    assert.equal((await put(MEM, { receipt_document_id: null })).status, 200);
    assert.equal(storedReceipt(visitId), privateDoc, 'null von einem, der den Beleg nicht sieht, behaelt ihn');
    assert.equal((await put(MEM, { receipt_document_id: '' })).status, 200);
    assert.equal(storedReceipt(visitId), privateDoc, 'ein leerer Wert ebenso');
    assert.equal((await put(MEM, {})).status, 200);
    assert.equal(storedReceipt(visitId), privateDoc, 'ein fehlendes Feld ebenso');
    // KEIN ORAKEL: jede Zahl bekommt dieselbe Antwort, auch die richtige.
    // Sonst liesse sich die maskierte ID raten - rowids sind fortlaufend, und
    // 200 gegen 403 verriete den Treffer.
    const replaced = await put(MEM, { receipt_document_id: ownDoc });
    assert.equal(replaced.status, 403);
    assert.equal(replaced.body.code, 403);
    assert.equal(typeof replaced.body.error, 'string');
    assert.equal(storedReceipt(visitId), privateDoc, 'ersetzen darf er ihn auch nicht');
    const guessedRight = await put(MEM, { receipt_document_id: privateDoc });
    assert.deepEqual({ status: guessedRight.status, body: guessedRight.body }, { status: 403, body: replaced.body },
      'die richtig geratene ID antwortet genau wie eine falsche');
    const guessedWrong = await put(MEM, { receipt_document_id: 999999 });
    assert.deepEqual({ status: guessedWrong.status, body: guessedWrong.body }, { status: 403, body: replaced.body });
    // Auch der Loeschzustand des unsichtbaren Belegs darf nicht durchscheinen.
    lockDocumentDeletes([privateDoc]);
    try {
      const locked = await put(MEM, { receipt_document_id: privateDoc });
      assert.deepEqual({ status: locked.status, body: locked.body }, { status: 403, body: replaced.body },
        'im Loeschfenster weiter 403, nicht 409');
      assert.equal((await put(MEM, { receipt_document_id: null })).status, 200, 'behalten fragt die Loeschsperre nicht');
    } finally {
      unlockDocumentDeletes([privateDoc]);
    }
    assert.equal(storedReceipt(visitId), privateDoc);

    // Dieselbe Regel fuer die anderen Wege, auf denen der Beleg verborgen ist:
    // ohne Dokumentenrecht, und ein Token ohne documents-Scope - dessen Nutzer
    // (der Admin) den Beleg selbst angelegt hat und ihn sonst saehe.
    for (const [label, as] of [
      ['documents: none', { ...MEM, moduleAccess: { documents: 'none' } }],
      ['Token nur housekeeping:write', { id: ADMIN, role: 'admin', authMethod: 'api_token', authScopes: ['housekeeping:write'] }],
    ]) {
      const right = await put(as, { receipt_document_id: privateDoc });
      const wrong = await put(as, { receipt_document_id: ownDoc });
      assert.equal(right.status, 403, `${label}: die richtige ID ist 403`);
      assert.deepEqual({ status: right.status, body: right.body }, { status: wrong.status, body: wrong.body },
        `${label}: richtige und falsche ID antworten gleich`);
      assert.deepEqual(right.body, replaced.body, `${label}: und wie beim Mitglied ohne Sicht`);
      assert.equal((await put(as, { receipt_document_id: null })).status, 200);
      assert.equal(storedReceipt(visitId), privateDoc, `${label}: null behaelt den Beleg`);
    }

    // Wer ihn sieht, darf ihn loesen.
    assert.equal((await put(ADM, { receipt_document_id: null })).status, 200);
    assert.equal(storedReceipt(visitId), null, 'die Erstellerin loest ihn');
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(visitId);
    db.prepare('DELETE FROM family_documents WHERE id IN (?, ?)').run(privateDoc, ownDoc);
  }
});

test('Beleg: eine neue Verknuepfung verlangt Dokumentenzugriff und Sichtbarkeit (#1358)', async () => {
  const familyDoc = insertDocument('Quittung Familie', 'family', ADMIN);
  const privateDoc = insertDocument('Quittung privat', 'private', ADMIN);
  const ownDoc = insertDocument('Eigene Quittung', 'private', MEMBER);
  const visitId = insertVisitWithReceipt('2026-05-15T10:00:00.000Z', null);
  const put = (as, extra) => call('PUT', `/visits/${visitId}`, {
    as,
    body: { date: '2026-05-15', daily_rate: 45, extras: 0, ...extra },
  });
  try {
    const noneMember = await put({ ...MEM, moduleAccess: { documents: 'none' } }, { receipt_document_id: familyDoc });
    assert.equal(noneMember.status, 403, 'documents: none setzt keine ID');
    assert.equal(noneMember.body.code, 403);
    assert.equal(storedReceipt(visitId), null);

    const token = await put({ id: ADMIN, role: 'admin', authMethod: 'api_token', authScopes: ['housekeeping:write'] },
      { receipt_document_id: familyDoc });
    assert.equal(token.status, 403, 'ein Token ohne documents-Scope setzt keine ID');
    assert.equal(storedReceipt(visitId), null);

    assert.equal((await put(MEM, { receipt_document_id: privateDoc })).status, 200);
    assert.equal(storedReceipt(visitId), null, 'ein fremdes privates Dokument wird nicht verknuepft');

    assert.equal((await put(MEM, { receipt_document_id: ownDoc })).status, 200);
    assert.equal(storedReceipt(visitId), ownDoc, 'ein eigenes Dokument schon');

    assert.equal((await put(MEM, { receipt_document_id: null })).status, 200);
    assert.equal(storedReceipt(visitId), null, 'und wer es sieht, loest es wieder');
  } finally {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(visitId);
    db.prepare('DELETE FROM family_documents WHERE id IN (?, ?, ?)').run(familyDoc, privateDoc, ownDoc);
  }
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
