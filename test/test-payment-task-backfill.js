/**
 * Test: Alte Zahlungsaufgaben der Haushaltshilfe gehoeren den Erwachsenen (R20)
 * Zweck: Seit R20 entsteht eine Zahlungsaufgabe auf `assignees` (eincheckende
 *        Person mit `housekeeping_view_amounts` + aktive Admins). Aeltere
 *        standen auf `all` und nannten den Lohn jedem Konto. Haelt fest:
 *          - Migration 250 zieht OFFENE verknuepfte Zahlungsaufgaben nach,
 *            erledigte und archivierte nicht, fremde Aufgaben auf `all` nicht;
 *          - Ersteller ohne Betragsrecht wird durch die erste Admin-Person
 *            ersetzt, ein zugewiesenes Kind faellt heraus;
 *          - ohne aktiven Admin bleibt eine Aufgabe ohne moegliche
 *            Eigentuemerin unveraendert;
 *          - zweimal ausgefuehrt aendert sie nichts mehr;
 *          - Bearbeiten, Auschecken, Bezahlen eines Besuchs zieht seine
 *            Aufgabe ebenso nach, auch eine erledigte.
 * Ausfuehren: npm run test:payment-task-backfill
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'payment-task-backfill-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

const dbmod = await import('../server/db.js');
const { requireAuth } = await import('../server/auth.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const db = dbmod.get();
const migration250 = dbmod.MIGRATIONS.find((m) => m.version === 250);

function addUser(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

function withoutAmounts(userId) {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'housekeeping_view_amounts', 'none')
  `).run(String(userId));
}

const ADULT = addUser('papa', 'member', 'dad');
const KID = addUser('kind', 'member', 'child');
withoutAmounts(KID);
const WORKER_USER = addUser('maria', 'member', 'other');
const WORKER = Number(db.prepare(`
  INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, rate_type, hourly_rate)
  VALUES (?, 45, 'monthly', 'daily', 0)
`).run(WORKER_USER).lastInsertRowid);
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

/** Eine Zahlungsaufgabe, wie sie vor R20 entstand: `all`, ohne Zuweisung. */
function legacyPaymentTask(createdBy, { status = 'open', archived = false, open = false, assign = [] } = {}) {
  const taskId = Number(db.prepare(`
    INSERT INTO tasks (title, description, due_date, priority, category, status, created_by, archived_at)
    VALUES ('Maria bezahlen', 'Besuch: 57 EUR', '2026-10-01', 'medium', 'household', ?, ?, ?)
  `).run(status, createdBy, archived ? '2026-10-02T00:00:00Z' : null).lastInsertRowid);
  for (const id of assign) db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, id);
  const sessionId = Number(db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, payment_task_id, created_by)
    VALUES (?, '2026-10-01T08:00:00.000Z', ?, 45, 12, ?, ?)
  `).run(WORKER, open ? null : '2026-10-01T10:00:00.000Z', taskId, createdBy ?? ADULT).lastInsertRowid);
  return { taskId, sessionId };
}

function taskState(taskId) {
  const row = db.prepare('SELECT visibility, created_by, assigned_to FROM tasks WHERE id = ?').get(taskId);
  const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(taskId).map((r) => r.user_id);
  return { ...row, assignees };
}

const UNTOUCHED = (createdBy, assignees = []) => ({ visibility: 'all', created_by: createdBy, assigned_to: null, assignees });

test('ohne aktiven Admin: eine Aufgabe ohne moegliche Eigentuemerin bleibt, die einer Erwachsenen wird ihre', () => {
  const kids = legacyPaymentTask(KID);
  const adults = legacyPaymentTask(ADULT);

  migration250.up(db);

  assert.deepEqual(taskState(kids.taskId), UNTOUCHED(KID), 'niemand sonst koennte sie danach sehen');
  assert.deepEqual(taskState(adults.taskId), { visibility: 'assignees', created_by: ADULT, assigned_to: ADULT, assignees: [ADULT] });
  for (const t of [kids, adults]) {
    db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(t.sessionId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.taskId);
  }
});

// Die Admins entstehen erst NACH dem Fall ohne Admin: node:test faehrt die
// Tests erst, wenn der Modulkoerper durch ist.
let ADMIN, ADMIN2, GONE_ADMIN, adminToken, adultToken;

test('Migration 250 zieht nur OFFENE verknuepfte Zahlungsaufgaben nach, und zweimal ist wie einmal', () => {
  ADMIN = addUser('mama', 'admin', 'mom');
  ADMIN2 = addUser('oma', 'admin', 'grandparent');
  GONE_ADMIN = addUser('alt', 'admin', 'dad');
  db.prepare("UPDATE users SET deactivated_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(GONE_ADMIN);
  adminToken = mintToken(ADMIN);
  adultToken = mintToken(ADULT);

  const byAdult = legacyPaymentTask(ADULT);
  const byKid = legacyPaymentTask(KID, { assign: [KID] });
  const inProgress = legacyPaymentTask(ADULT, { status: 'in_progress' });
  const done = legacyPaymentTask(ADULT, { status: 'done' });
  const archived = legacyPaymentTask(ADULT, { archived: true });
  const byGone = legacyPaymentTask(GONE_ADMIN);
  const notPayment = Number(db.prepare(`
    INSERT INTO tasks (title, status, created_by) VALUES ('Fenster putzen', 'open', ?)
  `).run(KID).lastInsertRowid);

  migration250.up(db);
  const first = Object.fromEntries(Object.entries({ byAdult, byKid, inProgress, done, archived, byGone })
    .map(([k, t]) => [k, taskState(t.taskId)]));

  assert.deepEqual(first.byAdult, { visibility: 'assignees', created_by: ADULT, assigned_to: ADULT, assignees: [ADULT, ADMIN, ADMIN2] });
  assert.deepEqual(first.byKid, { visibility: 'assignees', created_by: ADMIN, assigned_to: ADMIN, assignees: [ADMIN, ADMIN2] },
    'das Kind ist weder Erstellerin noch zugewiesen');
  assert.deepEqual(first.inProgress, first.byAdult, 'in Arbeit ist offen');
  assert.deepEqual(first.done, UNTOUCHED(ADULT), 'erledigte fasst die Migration nicht an');
  assert.deepEqual(first.archived, UNTOUCHED(ADULT), 'archivierte auch nicht');
  assert.deepEqual(first.byGone, { visibility: 'assignees', created_by: ADMIN, assigned_to: ADMIN, assignees: [ADMIN, ADMIN2] },
    'ein deaktiviertes Konto ist keine zahlende Person');
  assert.deepEqual(taskState(notPayment), UNTOUCHED(KID), 'eine Aufgabe ohne Besuch ist keine Zahlungsaufgabe');

  migration250.up(db);
  for (const [k, t] of Object.entries({ byAdult, byKid, inProgress, done, archived, byGone })) {
    assert.deepEqual(taskState(t.taskId), first[k], `zweiter Lauf: ${k}`);
  }
});

// --------------------------------------------------------------------------
// Bearbeiten eines Besuchs
// --------------------------------------------------------------------------

function mintToken(subjectId) {
  const value = `yuvomi_test_${crypto.randomBytes(12).toString('hex')}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, scopes)
    VALUES (?, ?, 'yuvomi_test', ?, ?, NULL)
  `).run(`t-${subjectId}-${value.slice(-4)}`, crypto.createHash('sha256').update(value).digest('hex'), subjectId, subjectId);
  return value;
}

const app = express();
app.use(express.json());
app.use('/api/v1/housekeeping', requireAuth, housekeepingRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, token, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

test('einen Besuch bearbeiten zieht seine alte Zahlungsaufgabe nach, auch eine erledigte', async () => {
  const t = legacyPaymentTask(KID, { status: 'done', assign: [KID] });
  const put = await call('PUT', `/api/v1/housekeeping/visits/${t.sessionId}`, adminToken, {
    date: '2026-10-01', original_date: '2026-10-01', daily_rate: 45, extras: 12,
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(taskState(t.taskId), { visibility: 'assignees', created_by: ADMIN, assigned_to: ADMIN, assignees: [ADMIN, ADMIN2] });
});

test('Auschecken zieht die Zahlungsaufgabe des offenen Besuchs nach', async () => {
  const t = legacyPaymentTask(ADULT, { open: true });
  const out = await call('POST', '/api/v1/housekeeping/work-sessions/check-out', adultToken, { worker_id: WORKER });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(taskState(t.taskId), { visibility: 'assignees', created_by: ADULT, assigned_to: ADULT, assignees: [ADULT, ADMIN, ADMIN2] });
});

test('Bezahlen zieht die Zahlungsaufgabe nach', async () => {
  const t = legacyPaymentTask(ADULT);
  const pay = await call('POST', `/api/v1/housekeeping/visits/${t.sessionId}/pay`, adultToken);
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(taskState(t.taskId).visibility, 'assignees');
});

test('eine schon gewaehlte Sichtbarkeit bleibt beim Bearbeiten stehen', async () => {
  const t = legacyPaymentTask(ADULT);
  db.prepare("UPDATE tasks SET visibility = 'private' WHERE id = ?").run(t.taskId);
  const put = await call('PUT', `/api/v1/housekeeping/visits/${t.sessionId}`, adminToken, {
    date: '2026-10-01', original_date: '2026-10-01', daily_rate: 45, extras: 12,
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(taskState(t.taskId), { visibility: 'private', created_by: ADULT, assigned_to: null, assignees: [] });
});
