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
 *            Aufgabe ebenso nach, auch eine erledigte;
 *          - wer das Betragsrecht verliert (Mitglied-Zeile, Rollenprofil,
 *            Familienrolle), faellt aus den Zahlungsaufgaben, die ihm schon
 *            gehoerten.
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
const { router: authRouter } = await import('../server/auth.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
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

test('ohne aktiven Admin: eine Aufgabe ohne moegliche Eigentuemerin wird privat, die einer Erwachsenen wird ihre', async () => {
  const { normalizePaymentTaskAudience } = await import('../server/services/payment-task-audience.js');
  const kids = legacyPaymentTask(KID, { assign: [KID, ADULT] });
  const adults = legacyPaymentTask(ADULT);
  const viaRuntime = legacyPaymentTask(KID, { assign: [KID, ADULT] });

  migration250.up(db);
  normalizePaymentTaskAudience(db, viaRuntime.taskId);

  // Fail-closed (Ulas 2026-10-18): nie auf `all` - privat fuer die
  // Erstellerin, ohne Zuweisungen und ohne die Beschreibung mit dem Lohn.
  const closed = { visibility: 'private', created_by: KID, assigned_to: null, assignees: [] };
  const description = (id) => db.prepare('SELECT description FROM tasks WHERE id = ?').get(id).description;
  assert.deepEqual(taskState(kids.taskId), closed, 'Migration: geschlossen statt offen');
  assert.equal(description(kids.taskId), null, 'Migration: die Beschreibung mit dem Lohn faellt weg');
  assert.deepEqual(taskState(viaRuntime.taskId), taskState(kids.taskId), 'Migration und Laufzeit schliessen gleich');
  assert.equal(description(viaRuntime.taskId), null);
  assert.deepEqual(taskState(adults.taskId), { visibility: 'assignees', created_by: ADULT, assigned_to: ADULT, assignees: [ADULT] });
  for (const t of [kids, adults, viaRuntime]) {
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
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/permissions', requireAuth, permissionsRouter);
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

// --------------------------------------------------------------------------
// Migration und Laufzeitregel (Aequivalenz)
// --------------------------------------------------------------------------

// Migration 250 traegt eine EINGEFRORENE Kopie der Regel aus
// services/payment-task-audience.js (eine Migration importiert nie Laufzeit-
// Code). Heute muessen beide auf denselben Daten dasselbe ergeben. Weicht die
// Laufzeitregel spaeter BEWUSST ab, wird dieser Test mit Begruendung angepasst
// - nie die Migration.
test('Migration 250 und die Laufzeitregel liefern auf denselben Daten dasselbe', async () => {
  const { normalizePaymentTaskAudience } = await import('../server/services/payment-task-audience.js');
  // Rollenprofil ohne Betraege fuer 'relative', eine Mitglied-Zeile oeffnet es
  // fuer eine Person wieder: beide Ebenen muss die Kopie lesen wie die Regel.
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'relative', 'capability', 'housekeeping_view_amounts', 'none')
  `).run();
  // Ein Admin-Konto, das Hauspersonal ist, ist kein Haushaltsmitglied (#1207)
  // und bezahlt niemanden - weder Migration noch Laufzeitregel weisen es zu.
  const STAFF_ADMIN = addUser('hilfe-admin', 'admin', 'other');
  db.prepare(`
    INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, rate_type, hourly_rate)
    VALUES (?, 40, 'monthly', 'daily', 0)
  `).run(STAFF_ADMIN);
  const AUNT = addUser('tante', 'member', 'relative');
  const UNCLE = addUser('onkel', 'member', 'relative');
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'housekeeping_view_amounts', 'allow')
  `).run(String(UNCLE));
  const fixtures = [
    legacyPaymentTask(ADULT),
    legacyPaymentTask(KID, { assign: [KID, ADULT] }),
    legacyPaymentTask(ADMIN2, { assign: [ADULT] }),
    legacyPaymentTask(GONE_ADMIN),
    legacyPaymentTask(AUNT),
    legacyPaymentTask(UNCLE, { status: 'in_progress' }),
    legacyPaymentTask(ADULT, { status: 'done' }),
    legacyPaymentTask(ADULT, { archived: true }),
  ];
  const before = fixtures.map((t) => taskState(t.taskId));
  const restore = () => fixtures.forEach((t, i) => {
    db.prepare("UPDATE tasks SET visibility = 'all', created_by = ?, assigned_to = NULL WHERE id = ?")
      .run(before[i].created_by, t.taskId);
    db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(t.taskId);
    for (const id of before[i].assignees) {
      db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(t.taskId, id);
    }
  });

  migration250.up(db);
  const viaMigration = fixtures.map((t) => taskState(t.taskId));
  restore();
  assert.deepEqual(fixtures.map((t) => taskState(t.taskId)), before, 'Ausgangslage wiederhergestellt');
  for (const t of fixtures) {
    const row = db.prepare('SELECT status, archived_at FROM tasks WHERE id = ?').get(t.taskId);
    if (row.status !== 'done' && row.archived_at == null) normalizePaymentTaskAudience(db, t.taskId);
  }
  const viaRuntime = fixtures.map((t) => taskState(t.taskId));

  assert.deepEqual(viaMigration, viaRuntime);
  // Nicht trivial gleich: die Faelle decken beide Ausgaenge ab.
  assert.equal(viaMigration[4].created_by, ADMIN, 'Rollenprofil ohne Betraege: Admin uebernimmt');
  assert.equal(viaMigration[5].created_by, UNCLE, 'Mitglied-Zeile oeffnet das Rollenprofil wieder');
  assert.equal(viaMigration[6].visibility, 'all', 'erledigte bleibt');
  for (const [label, states] of [['Migration', viaMigration], ['Laufzeit', viaRuntime]]) {
    assert.ok(states.every((st) => !st.assignees.includes(STAFF_ADMIN) && st.created_by !== STAFF_ADMIN || st.visibility === 'all'),
      `${label}: das Admin-Konto der Haushaltshilfe steht in keiner Zahlungsaufgabe`);
  }
});

// --------------------------------------------------------------------------
// Fail-closed (security-guidance zu R20): ohne Admin-Mitglied bleibt keine
// Zahlungsaufgabe auf `all`. Die App laesst diesen Haushalt nicht zu
// (assertAdminWouldRemain); die Regel schliesst trotzdem, falls er entsteht.
// --------------------------------------------------------------------------

test('ohne Admin-Mitglied springt ein aktives Admin-Konto ein, ohne jeden Admin wird sie privat', async () => {
  const { normalizePaymentTaskAudience } = await import('../server/services/payment-task-audience.js');
  const staffAdmin = db.prepare("SELECT id FROM users WHERE username = 'hilfe-admin'").get()?.id;
  assert.ok(staffAdmin, 'Reichweite: das Admin-Konto der Haushaltshilfe aus dem Aequivalenztest steht');
  const members = db.prepare("SELECT id FROM users WHERE role = 'admin' AND id <> ?").all(staffAdmin).map((r) => r.id);
  const demote = db.prepare("UPDATE users SET role = 'member' WHERE id = ?");
  const promote = db.prepare("UPDATE users SET role = 'admin' WHERE id = ?");
  members.forEach((id) => demote.run(id));
  try {
    const fallback = legacyPaymentTask(KID);
    assert.equal(normalizePaymentTaskAudience(db, fallback.taskId), true);
    assert.deepEqual(taskState(fallback.taskId),
      { visibility: 'assignees', created_by: staffAdmin, assigned_to: staffAdmin, assignees: [staffAdmin] },
      'kein Admin-Mitglied: das aktive Admin-Konto uebernimmt');

    demote.run(staffAdmin);
    const none = legacyPaymentTask(KID, { assign: [KID, ADULT] });
    assert.equal(normalizePaymentTaskAudience(db, none.taskId), true);
    assert.deepEqual(taskState(none.taskId), { visibility: 'private', created_by: KID, assigned_to: null, assignees: [] },
      'gar kein Admin: privat, ohne Zuweisungen - nie auf all');
    const desc = db.prepare('SELECT description FROM tasks WHERE id = ?').get(none.taskId).description;
    assert.equal(desc, null, 'die Beschreibung mit dem Lohn faellt weg');
  } finally {
    promote.run(staffAdmin);
    members.forEach((id) => promote.run(id));
  }
});

// --------------------------------------------------------------------------
// Rechte entziehen (Codex zu R20): eine Aufgabe auf `assignees` haelt die
// Erstellerin und die Zugewiesenen durch, ohne nach dem Betragsrecht zu
// fragen. Wer es verliert, muss aus den Aufgaben fallen, die ihm gehoerten.
// --------------------------------------------------------------------------

async function checkInAndOut(token) {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('housekeeping_payment_tasks', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  const inRes = await call('POST', '/api/v1/housekeeping/work-sessions/check-in', token, { worker_id: WORKER, daily_rate: 45 });
  assert.equal(inRes.status, 201, JSON.stringify(inRes.body));
  const outRes = await call('POST', '/api/v1/housekeeping/work-sessions/check-out', token, { worker_id: WORKER });
  assert.equal(outRes.status, 200, JSON.stringify(outRes.body));
  return db.prepare('SELECT payment_task_id FROM housekeeping_work_sessions WHERE id = ?').get(inRes.body.data.id).payment_task_id;
}

test('wer das Betragsrecht verliert, faellt aus seinen Zahlungsaufgaben - auf jedem Weg, der Rechte schreibt', async () => {
  const admins = [ADMIN, ADMIN2];
  const paidBy = (id) => ({ visibility: 'assignees', created_by: id, assigned_to: id, assignees: [id, ...admins].sort((a, b) => a - b) });
  const toAdmins = { visibility: 'assignees', created_by: ADMIN, assigned_to: ADMIN, assignees: admins };

  // 1. Mitglied-Zeile: PUT /permissions/user/:id
  const viaUser = addUser('zahlerin', 'member', 'mom');
  const userTask = await checkInAndOut(mintToken(viaUser));
  const done = await checkInAndOut(mintToken(viaUser));
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(done);
  assert.deepEqual(taskState(userTask), paidBy(viaUser), 'Ausgangslage');
  const put = await call('PUT', `/api/v1/permissions/user/${viaUser}`, adminToken, {
    modules: {}, widgets: {}, capabilities: { housekeeping_view_amounts: 'none' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(taskState(userTask), toAdmins, 'Mitglied-Zeile: die Erstellerin faellt heraus');
  assert.deepEqual(taskState(done), toAdmins, 'auch die erledigte - sie nennt den Lohn genauso');

  // 2. Rollenprofil: PUT /permissions/role/:familyRole
  const viaRole = addUser('opa', 'member', 'grandparent');
  const roleTask = await checkInAndOut(mintToken(viaRole));
  // Ein Erwachsener mit dem Recht steht zusaetzlich drin und bleibt Erstellerin.
  const shared = await checkInAndOut(adultToken);
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(shared, viaRole);
  const putRole = await call('PUT', '/api/v1/permissions/role/grandparent', adminToken, {
    modules: {}, widgets: {}, capabilities: { housekeeping_view_amounts: 'none' },
  });
  assert.equal(putRole.status, 200, JSON.stringify(putRole.body));
  assert.deepEqual(taskState(roleTask), toAdmins, 'Rollenprofil: der Opa faellt heraus');
  assert.deepEqual(taskState(shared), paidBy(ADULT),
    'als Zugewiesener faellt er auch heraus, die Erstellerin mit dem Recht bleibt');

  // 3. Familienrolle: PATCH /auth/users/:id auf ein Profil ohne Betraege
  // ('relative' sperrt sie seit dem Aequivalenztest oben).
  const viaFamilyRole = addUser('cousine', 'member', 'parent');
  const familyTask = await checkInAndOut(mintToken(viaFamilyRole));
  const patch = await call('PATCH', `/api/v1/auth/users/${viaFamilyRole}`, adminToken, { family_role: 'relative' });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(taskState(familyTask), toAdmins, 'Familienrolle: die Cousine faellt heraus');

  // Wer das Recht behaelt, bleibt: dieselbe Route fuer ein anderes Konto
  // aendert seine Aufgabe nicht.
  const keeps = addUser('nachbar', 'member', 'dad');
  const keptTask = await checkInAndOut(mintToken(keeps));
  const before = taskState(keptTask);
  const putKeep = await call('PUT', `/api/v1/permissions/user/${keeps}`, adminToken, { modules: {}, widgets: {} });
  assert.equal(putKeep.status, 200, JSON.stringify(putKeep.body));
  assert.deepEqual(taskState(keptTask), before, 'mit dem Recht bleibt alles stehen');
});
