/**
 * Test: Startrechte neuer Kinderkonten und die Betraege der Haushaltshilfe (R20)
 * Zweck: Haelt die Entscheidung vom 2026-10-17 am echten Router fest:
 *          - ein NEUES Konto mit `family_role = child` startet ohne Budget, mit
 *            der Haushaltshilfe nur zum Lesen und ohne Betraege, ohne Fasten;
 *          - bestehende Konten und andere Rollen bleiben, wie sie sind;
 *          - "ohne Betraege" gilt am SERVER: Loehne, Zahlungen und Summen fehlen
 *            in jeder Antwort der Haushaltshilfe und in der Kachel der
 *            Uebersicht, Bezahlen weist ab, und wer schreiben darf, aber keine
 *            Betraege sieht, ueberschreibt sie nicht;
 *          - die Zahlungsaufgabe, deren Titel und Beschreibung den Betrag
 *            nennen, gehoert nur den Erwachsenen, die bezahlen: ein Konto ohne
 *            Betraege findet sie in keiner Flaeche, die Aufgaben ausliefert
 *            (Liste, Detail, Uebersicht, Wand, Suche, MCP), auch nicht, wenn
 *            es selbst eingecheckt hat.
 *        Gemessen ueber HTTP am echten Auth-, Haushaltshilfe- und
 *        Uebersichts-Router mit echten API-Tokens; `requireAuth` loest die
 *        Rechte so auf wie in server/index.js.
 * Ausfuehren: npm run test:child-start-permissions
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'child-start-permissions-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter, requireAuth } = await import('../server/auth.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: searchRouter } = await import('../server/routes/search.js');
const { callTool } = await import('../server/mcp/tools.js');
const {
  resolvePermissions, buildSessionModuleAccess, moduleAccessVerdict,
  applyChildStartPermissions, permissionCatalog, MODULE_ACCESS_READ_ONLY, MODULE_ACCESS_DENIED,
} = await import('../server/permissions.js');
const db = dbmod.get();

function addUser(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

function mintToken(subjectId) {
  const value = `yuvomi_test_${crypto.randomBytes(12).toString('hex')}`;
  db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, subject_user_id, scopes)
    VALUES (?, ?, 'yuvomi_test', ?, ?, NULL)
  `).run(`t-${subjectId}-${value.slice(-4)}`, crypto.createHash('sha256').update(value).digest('hex'), ADMIN, subjectId);
  return value;
}

const ADMIN = addUser('mama', 'admin', 'mom');
// Ein Kind, das es schon VOR dieser Aenderung gab: keine Zeilen, voller Zugriff.
const EXISTING_CHILD = addUser('bestand', 'member', 'child');
const ADULT = addUser('papa', 'member', 'dad');
const adminToken = mintToken(ADMIN);

// Die Modulsperre aus server/index.js, verkuerzt auf diese zwei Module: GET
// braucht `read`, alles andere `write`. Die Karte stammt aus requireAuth.
function moduleGate(moduleKey) {
  return (req, res, next) => {
    const verdict = moduleAccessVerdict(req.sessionModuleAccess, moduleKey, req.method === 'GET' ? 'read' : 'write');
    if (verdict === MODULE_ACCESS_DENIED) return res.status(403).json({ reason: 'module_access_denied' });
    if (verdict === MODULE_ACCESS_READ_ONLY) return res.status(403).json({ reason: 'module_read_only' });
    return next();
  };
}

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/housekeeping', requireAuth, moduleGate('housekeeping'), housekeepingRouter);
app.use('/api/v1/dashboard', requireAuth, dashboardRouter);
app.use('/api/v1/tasks', requireAuth, tasksRouter);
app.use('/api/v1/search', requireAuth, searchRouter);
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

function userRows(userId) {
  return db.prepare(`
    SELECT resource_type, resource_key, access FROM access_permissions
    WHERE subject_type = 'user' AND subject_id = ?
    ORDER BY resource_type, resource_key
  `).all(String(userId)).map((r) => ({ ...r }));
}

async function createMember(body) {
  const res = await call('POST', '/api/v1/auth/users', adminToken, {
    password: 'kinderleicht-123', display_name: body.username, ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.user.id;
}

// --------------------------------------------------------------------------
// Anlegen
// --------------------------------------------------------------------------

test('Admin legt ein Kind an: Budget aus, Haushaltshilfe nur lesen ohne Betraege, Fasten aus', async () => {
  const id = await createMember({ username: 'kim', family_role: 'child' });
  assert.deepEqual(userRows(id), [
    { resource_type: 'capability', resource_key: 'health_use_fasting', access: 'none' },
    { resource_type: 'capability', resource_key: 'housekeeping_view_amounts', access: 'none' },
    { resource_type: 'module', resource_key: 'budget', access: 'none' },
    { resource_type: 'module', resource_key: 'housekeeping', access: 'read' },
  ]);
  const resolved = resolvePermissions(db, { id, role: 'member', family_role: 'child' });
  assert.equal(resolved.modules.budget, 'none');
  assert.equal(resolved.widgets.budget, 'none', 'die Budget-Kachel erbt die Sperre');
  assert.equal(resolved.modules.housekeeping, 'read');
  assert.equal(resolved.modules.tasks, 'write', 'was die Vorgabe nicht nennt, bleibt offen');
  assert.equal(resolved.modules.rewards, 'write');
  assert.equal(resolved.capabilities.health_use_fasting, 'none');
  assert.equal(resolved.capabilities.housekeeping_view_amounts, 'none');
  // Auschecken & Co. sind Schreibrouten - die Modulsperre weist sie ab.
  const map = buildSessionModuleAccess(resolved);
  assert.equal(moduleAccessVerdict(map, 'housekeeping', 'write'), MODULE_ACCESS_READ_ONLY);
  assert.equal(moduleAccessVerdict(map, 'budget', 'read'), MODULE_ACCESS_DENIED);
});

test('andere Rollen und ein Kind mit Admin-Recht bekommen keine Zeile', async () => {
  for (const role of ['parent', 'dad', 'mom', 'grandparent', 'relative', 'other']) {
    const id = await createMember({ username: `erw-${role}`, family_role: role });
    assert.deepEqual(userRows(id), [], `${role}: keine Startzeilen`);
  }
  const adminChild = await createMember({ username: 'admin-kind', family_role: 'child', system_admin: true });
  assert.deepEqual(userRows(adminChild), [], 'ein Admin umgeht die Rechte ohnehin');
});

test('bestehende Kinderkonten bleiben unveraendert (keine Migration, kein Rollenprofil)', () => {
  assert.deepEqual(userRows(EXISTING_CHILD), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_permissions WHERE subject_type = 'role'").get().n, 0);
  const resolved = resolvePermissions(db, { id: EXISTING_CHILD, role: 'member', family_role: 'child' });
  assert.equal(resolved.modules.budget, 'write');
  assert.equal(resolved.capabilities.housekeeping_view_amounts, 'allow');
});

test('ein strengeres Rollenprofil bleibt strenger: kein `read` ueber einem `none`', () => {
  db.prepare(`INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', 'child', 'module', 'housekeeping', 'none')`).run();
  try {
    const id = addUser('lotta', 'member', 'child');
    applyChildStartPermissions(db, { id, role: 'member', family_role: 'child' });
    const keys = userRows(id).map((r) => `${r.resource_type}:${r.resource_key}=${r.access}`);
    assert.ok(!keys.some((k) => k.startsWith('module:housekeeping')), keys.join(', '));
    assert.equal(resolvePermissions(db, { id, role: 'member', family_role: 'child' }).modules.housekeeping, 'none');
  } finally {
    db.prepare("DELETE FROM access_permissions WHERE subject_type = 'role'").run();
  }
});

test('ein spaeterer Rollenwechsel aendert die Rechte nicht', async () => {
  const id = await createMember({ username: 'wechsel', family_role: 'child' });
  const before = userRows(id);
  const res = await call('PATCH', `/api/v1/auth/users/${id}`, adminToken, { family_role: 'parent' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(userRows(id), before);
});

test('der Katalog nennt die Kinder-Startrechte fuer das Formular', () => {
  const { childStart } = permissionCatalog();
  assert.deepEqual(childStart.modules, { budget: 'none', housekeeping: 'read' });
  assert.deepEqual(childStart.capabilities, { health_use_fasting: 'none', housekeeping_view_amounts: 'none' });
});

// --------------------------------------------------------------------------
// Haushaltshilfe ohne Betraege - am Server
// --------------------------------------------------------------------------

const WORKER_USER = addUser('maria', 'member', 'other');
const WORKER = Number(db.prepare(`
  INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, rate_type, hourly_rate)
  VALUES (?, 45, 'monthly', 'daily', 0)
`).run(WORKER_USER).lastInsertRowid);
// Haushaltszone UTC und der Besuch am Ersten des laufenden UTC-Monats: so
// liegt er in jedem Lauf im "laufenden Monat", den auch die Routen lesen,
// egal zu welcher Uhrzeit und in welcher Zone der Runner steht.
db.prepare(`INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
const MONTH = new Date().toISOString().slice(0, 7);
const VISIT = Number(db.prepare(`
  INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by)
  VALUES (?, ?, ?, 45, 12, ?)
`).run(WORKER, `${MONTH}-01T08:00:00.000Z`, `${MONTH}-01T10:00:00.000Z`, ADMIN).lastInsertRowid);

const MONEY_KEYS = new Set([
  'daily_rate', 'extras', 'hourly_rate', 'paid_at', 'payment_task_id', 'payment_task_status',
  'payment_task_title', 'total_amount', 'totals', 'default_daily_rate', 'daily_total', 'extras_total',
  'pending_payments', 'paid_this_month', 'monthly_payments', 'unpaidAmount',
]);

/** Jeder Geld-Schluessel in der Antwort, der nicht `null` ist - mit Pfad. */
function moneyLeaks(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((item, i) => moneyLeaks(item, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    if (MONEY_KEYS.has(key) && inner !== null) return [`${path}.${key}=${JSON.stringify(inner)}`];
    return moneyLeaks(inner, `${path}.${key}`);
  });
}

const READS = [
  '/api/v1/housekeeping/dashboard',
  '/api/v1/housekeeping/worker',
  '/api/v1/housekeeping/workers',
  '/api/v1/housekeeping/summary',
  '/api/v1/housekeeping/work-sessions',
  '/api/v1/housekeeping/visits',
  `/api/v1/housekeeping/visits/${VISIT}`,
];

test('neues Kind: keine Antwort der Haushaltshilfe traegt einen Betrag', async () => {
  const kid = await createMember({ username: 'nele', family_role: 'child' });
  const token = mintToken(kid);
  for (const route of READS) {
    const res = await call('GET', route, token);
    assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(moneyLeaks(res.body), [], route);
  }
  // Was das Kind sehen SOLL, ist noch da: wer kommt und wann.
  const visits = await call('GET', '/api/v1/housekeeping/visits', token);
  assert.equal(visits.body.data.visits.length, 1);
  assert.equal(visits.body.data.visits[0].worker_name, 'maria');
  assert.equal(visits.body.data.visits[0].can_mark_paid, false);
  const dash = await call('GET', '/api/v1/dashboard', token);
  assert.equal(dash.status, 200);
  assert.equal(dash.body.housekeeping.unpaidAmount, null);
  assert.equal(dash.body.housekeeping.visitsThisMonth, 1, 'Besuche sind keine Geldangabe');
});

test('neues Kind: Auschecken, Einchecken und Bezahlen weist der Server ab', async () => {
  const kid = await createMember({ username: 'ole', family_role: 'child' });
  const token = mintToken(kid);
  for (const [method, route, body] of [
    ['POST', '/api/v1/housekeeping/work-sessions/check-in', { worker_id: WORKER, daily_rate: 1 }],
    ['POST', '/api/v1/housekeeping/work-sessions/check-out', { worker_id: WORKER }],
    ['POST', `/api/v1/housekeeping/visits/${VISIT}/pay`, {}],
  ]) {
    const res = await call(method, route, token, body);
    assert.equal(res.status, 403, route);
    assert.equal(res.body.reason, 'module_read_only', route);
  }
});

test('Erwachsene und das bestehende Kind sehen die Betraege weiter', async () => {
  for (const id of [ADULT, EXISTING_CHILD]) {
    const token = mintToken(id);
    const visits = await call('GET', '/api/v1/housekeeping/visits', token);
    assert.equal(visits.body.data.visits[0].total_amount, 57);
    assert.equal(visits.body.data.totals.total, 57);
    const dash = await call('GET', '/api/v1/dashboard', token);
    assert.equal(typeof dash.body.housekeeping.unpaidAmount, 'number');
  }
});

test('schreiben ohne Betraege: der Satz kommt aus dem Profil, Bezahlen bleibt zu', async () => {
  // Ein Elternteil gibt dem Kind das Ein- und Auschecken, die Betraege nicht.
  const kid = await createMember({ username: 'pia', family_role: 'child' });
  db.prepare(`UPDATE access_permissions SET access = 'write'
    WHERE subject_type = 'user' AND subject_id = ? AND resource_key = 'housekeeping'`).run(String(kid));
  const token = mintToken(kid);
  const checkIn = await call('POST', '/api/v1/housekeeping/work-sessions/check-in', token, {
    worker_id: WORKER, daily_rate: 999, extras: 50, payment_description: 'geraten: 0 EUR',
  });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  assert.deepEqual(moneyLeaks(checkIn.body), []);
  const stored = db.prepare('SELECT daily_rate, extras FROM housekeeping_work_sessions WHERE id = ?').get(checkIn.body.data.id);
  assert.deepEqual({ ...stored }, { daily_rate: 45, extras: 0 });

  const checkOut = await call('POST', '/api/v1/housekeeping/work-sessions/check-out', token, { worker_id: WORKER, extras: 70 });
  assert.equal(checkOut.status, 200);
  assert.equal(db.prepare('SELECT extras FROM housekeeping_work_sessions WHERE id = ?').get(checkIn.body.data.id).extras, 0);

  const put = await call('PUT', `/api/v1/housekeeping/visits/${VISIT}`, token, {
    date: `${MONTH}-01`, original_date: `${MONTH}-01`,
    daily_rate: 0, extras: 0,
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(
    { ...db.prepare('SELECT daily_rate, extras FROM housekeeping_work_sessions WHERE id = ?').get(VISIT) },
    { daily_rate: 45, extras: 12 },
    'der Dialog ohne Betraege ueberschreibt sie nicht mit 0',
  );

  const pay = await call('POST', `/api/v1/housekeeping/visits/${VISIT}/pay`, token, {});
  assert.equal(pay.status, 403);
  assert.equal(pay.body.reason, 'amounts_hidden');
  assert.equal(db.prepare('SELECT paid_at FROM housekeeping_work_sessions WHERE id = ?').get(VISIT).paid_at, null);
  db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(checkIn.body.data.id);
});

// --------------------------------------------------------------------------
// Die Zahlungsaufgabe nennt den Betrag - sie gehoert den Erwachsenen (R20 B2)
// --------------------------------------------------------------------------

/** Jede Flaeche, ueber die eine Aufgabe ein Konto erreicht, als eine Antwort. */
async function taskSurfaces(userId, token, taskId) {
  const list = await call('GET', '/api/v1/tasks', token);
  const done = await call('GET', '/api/v1/tasks?status=done', token);
  const detail = await call('GET', `/api/v1/tasks/${taskId}`, token);
  const dash = await call('GET', '/api/v1/dashboard', token);
  const wall = await call('GET', '/api/v1/dashboard?audience=household', token);
  const search = await call('GET', `/api/v1/search?q=${encodeURIComponent('maria')}`, token);
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  const mcp = await callTool({ db, actor: { ...user } }, 'list_tasks', {});
  return {
    list: (list.body.data ?? []).some((t) => t.id === taskId),
    listDone: (done.body.data ?? []).some((t) => t.id === taskId),
    detail: detail.status === 200,
    dashboard: (dash.body.urgentTasks ?? []).some((t) => t.id === taskId),
    wall: JSON.stringify(wall.body.wallTasks ?? []).includes(`"id":${taskId}`),
    search: (search.body.tasks ?? []).some((t) => t.id === taskId),
    mcp: mcp.some((t) => t.id === taskId),
  };
}

const NOWHERE = { list: false, listDone: false, detail: false, dashboard: false, wall: false, search: false, mcp: false };

/** Die aktiven Admins - im Lauf hat auch `admin-kind` von oben Admin-Recht. */
function admins() {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' AND deactivated_at IS NULL ORDER BY id").all().map((r) => r.id);
}

function enablePaymentTasks() {
  db.prepare(`INSERT INTO sync_config (key, value) VALUES ('housekeeping_payment_tasks', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
}

function paymentTaskOf(sessionId) {
  const { payment_task_id: id } = db.prepare('SELECT payment_task_id FROM housekeeping_work_sessions WHERE id = ?').get(sessionId);
  assert.ok(id, 'der Check-in legt eine Zahlungsaufgabe an');
  const task = db.prepare('SELECT id, title, description, created_by, visibility FROM tasks WHERE id = ?').get(id);
  const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
  return { ...task, assignees };
}

async function checkOutAndForget(token, sessionId) {
  await call('POST', '/api/v1/housekeeping/work-sessions/check-out', token, { worker_id: WORKER });
  const { payment_task_id: taskId } = db.prepare('SELECT payment_task_id FROM housekeeping_work_sessions WHERE id = ?').get(sessionId);
  db.prepare('DELETE FROM housekeeping_work_sessions WHERE id = ?').run(sessionId);
  if (taskId) db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

test('Zahlungsaufgabe: eine Erwachsene checkt ein - nur sie und die Admins sehen sie', async () => {
  enablePaymentTasks();
  const kid = await createMember({ username: 'zoe', family_role: 'child' });
  const kidToken = mintToken(kid);
  const adultToken = mintToken(ADULT);
  const checkIn = await call('POST', '/api/v1/housekeeping/work-sessions/check-in', adultToken, {
    worker_id: WORKER, daily_rate: 45, extras: 5,
  });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  try {
    const task = paymentTaskOf(checkIn.body.data.id);
    assert.match(task.description, /50/, 'die Beschreibung nennt den Betrag - genau deshalb ist sie nicht oeffentlich');

    // Zuerst die Flaechen: sie sind das Versprechen, die Spalten darunter der Weg.
    assert.deepEqual(await taskSurfaces(kid, kidToken, task.id), NOWHERE, 'neues Kind');
    assert.deepEqual(await taskSurfaces(EXISTING_CHILD, mintToken(EXISTING_CHILD), task.id), NOWHERE,
      'auch ein Bestandskind ist keine zahlende Person');
    const kidWrite = await call('PATCH', `/api/v1/tasks/${task.id}/status`, kidToken, { status: 'done' });
    assert.equal(kidWrite.status, 404, 'unsichtbar heisst auch unantastbar');

    const adminSees = await taskSurfaces(ADMIN, adminToken, task.id);
    assert.equal(adminSees.list && adminSees.detail && adminSees.mcp, true, JSON.stringify(adminSees));
    assert.equal(adminSees.wall, false, 'an der Wand steht kein Lohn');
    const adultSees = await taskSurfaces(ADULT, adultToken, task.id);
    assert.equal(adultSees.list && adultSees.detail && adultSees.search && adultSees.mcp, true, JSON.stringify(adultSees));

    assert.equal(task.visibility, 'assignees');
    assert.equal(task.created_by, ADULT);
    assert.deepEqual(task.assignees, [...new Set([ADULT, ...admins()])].sort((a, b) => a - b));
  } finally {
    await checkOutAndForget(adultToken, checkIn.body.data.id);
  }
});

test('Zahlungsaufgabe: ein Kind checkt ein - die Aufgabe landet trotzdem nicht bei ihm', async () => {
  enablePaymentTasks();
  const kid = await createMember({ username: 'finn', family_role: 'child' });
  db.prepare(`UPDATE access_permissions SET access = 'write'
    WHERE subject_type = 'user' AND subject_id = ? AND resource_key = 'housekeeping'`).run(String(kid));
  const kidToken = mintToken(kid);
  const checkIn = await call('POST', '/api/v1/housekeeping/work-sessions/check-in', kidToken, { worker_id: WORKER });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
  try {
    const task = paymentTaskOf(checkIn.body.data.id);
    assert.deepEqual(await taskSurfaces(kid, kidToken, task.id), NOWHERE, 'das eincheckende Kind');
    const adminSees = await taskSurfaces(ADMIN, adminToken, task.id);
    assert.equal(adminSees.list && adminSees.detail && adminSees.dashboard && adminSees.search && adminSees.mcp, true,
      JSON.stringify(adminSees));

    assert.equal(task.visibility, 'assignees');
    assert.equal(task.created_by, ADMIN, 'die Erstellerin sieht ihre Aufgabe immer - das Kind darf es nicht sein');
    assert.deepEqual(task.assignees, admins());
    assert.ok(!task.assignees.includes(kid));
    assert.equal(
      db.prepare('SELECT created_by FROM housekeeping_work_sessions WHERE id = ?').get(checkIn.body.data.id).created_by,
      kid, 'der Besuch selbst bleibt dem Kind zugeschrieben',
    );
  } finally {
    await checkOutAndForget(kidToken, checkIn.body.data.id);
  }
});
