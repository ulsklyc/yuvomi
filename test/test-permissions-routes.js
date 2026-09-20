/**
 * Test: Zugriffsrechte-Routen (Härtung)
 * Zweck: End-to-End über den echten Router - die Admin-Schreib-/Leseschicht der
 *        app-weiten Rechte-Matrix (#467). Der Resolver resolvePermissions ist in
 *        test-permissions.js abgedeckt; hier geht es um die Route-Schicht:
 *        das requireAdmin-Gate (Privilege-Escalation-Schutz), Payload-Validierung,
 *        Round-Trip-Persistenz und die Admin-Ziel-Sonderregel.
 * Ausführen: node --experimental-sqlite --test test/test-permissions-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
const db = dbmod.get();

function mkUser(username, role = 'member', familyRole = 'child') {
  return db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)`,
  ).run(username, username.toUpperCase(), role, familyRole).lastInsertRowid;
}
const ADMIN = mkUser('admin', 'admin', 'parent');
const MEMBER = mkUser('member', 'member', 'child');
const OTHER_ADMIN = mkUser('admin2', 'admin', 'parent');

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', permissionsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, { actor: a, body } = {}) {
  if (a) actor = a;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

const ADM = { id: ADMIN, role: 'admin' };
const MEM = { id: MEMBER, role: 'member' };

// Katalog-abgeleitete gültige Werte (robust gegen künftige Katalog-Änderungen).
let CATALOG, ROLE, MODULE_KEY, MODULE_LEVEL, WIDGET_ID, WIDGET_LEVEL, CAPABILITY_KEY;
test('setup: Katalog liefert Module/Widgets/Rollen/Mitglieder', async () => {
  const r = await call('GET', '/catalog', { actor: ADM });
  assert.equal(r.status, 200);
  CATALOG = r.body.data;
  assert.ok(Array.isArray(CATALOG.modules) && CATALOG.modules.length > 0);
  assert.ok(Array.isArray(CATALOG.roles) && CATALOG.roles.length > 0);
  assert.ok(Array.isArray(CATALOG.members) && CATALOG.members.length >= 3, 'Mitgliederliste enthält die Seed-Nutzer');
  ROLE = CATALOG.roles[0];
  MODULE_KEY = CATALOG.modules[0].key;
  // ein Nicht-Standard-Access-Level, damit es sparse gespeichert wird
  MODULE_LEVEL = CATALOG.moduleAccessLevels.find((l) => l !== CATALOG.defaults.module);
  assert.ok(MODULE_LEVEL, 'nicht-standard Modul-Level vorhanden');
  if (CATALOG.widgets.length > 0) {
    WIDGET_ID = CATALOG.widgets[0].id;
    WIDGET_LEVEL = CATALOG.widgetAccessLevels.find((l) => l !== CATALOG.defaults.widget);
  }
  CAPABILITY_KEY = CATALOG.capabilities[0]?.key;
  assert.equal(CAPABILITY_KEY, 'notes_manage_household_categories');
});

// --------------------------------------------------------------------------
// requireAdmin-Gate: kein Nicht-Admin darf lesen ODER schreiben
// --------------------------------------------------------------------------
test('Gate: Nicht-Admin bekommt 403 auf JEDEM Endpunkt (kein Privilege-Escalation)', async () => {
  const endpoints = [
    ['GET', '/catalog'],
    ['GET', `/role/${ROLE}`],
    ['PUT', `/role/${ROLE}`, { modules: { [MODULE_KEY]: MODULE_LEVEL } }],
    ['GET', `/user/${MEMBER}`],
    ['PUT', `/user/${MEMBER}`, { modules: { [MODULE_KEY]: MODULE_LEVEL } }],
  ];
  for (const [method, path, body] of endpoints) {
    const r = await call(method, path, { actor: MEM, body });
    assert.equal(r.status, 403, `${method} ${path} muss für Nicht-Admin 403 sein`);
  }
  // Und der Schreibversuch darf nichts persistiert haben.
  const after = await call('GET', `/role/${ROLE}`, { actor: ADM });
  assert.deepEqual(after.body.data.modules, {}, 'Nicht-Admin-PUT hat nichts geschrieben');
});

// --------------------------------------------------------------------------
// Rollen-Profil: Validierung + Round-Trip
// --------------------------------------------------------------------------
test('GET /role: ungültige Familienrolle -> 400', async () => {
  const r = await call('GET', '/role/notarole', { actor: ADM });
  assert.equal(r.status, 400);
});

test('PUT /role: gültiges Profil wird gespeichert und per GET zurückgelesen', async () => {
  const put = await call('PUT', `/role/${ROLE}`, { actor: ADM, body: { modules: { [MODULE_KEY]: MODULE_LEVEL } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.modules[MODULE_KEY], MODULE_LEVEL);
  const get = await call('GET', `/role/${ROLE}`, { actor: ADM });
  assert.equal(get.body.data.modules[MODULE_KEY], MODULE_LEVEL, 'Round-Trip');
});

test('PUT /role: Standard-Werte werden sparse verworfen', async () => {
  const put = await call('PUT', `/role/${ROLE}`, { actor: ADM, body: { modules: { [MODULE_KEY]: CATALOG.defaults.module } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.modules[MODULE_KEY], undefined, 'Standardwert nicht gespeichert');
});

test('PUT /role: unbekannter Modul-Schlüssel -> 400', async () => {
  const r = await call('PUT', `/role/${ROLE}`, { actor: ADM, body: { modules: { __no_such_module__: MODULE_LEVEL } } });
  assert.equal(r.status, 400);
});

test('PUT /role: ungültiger Access-Wert -> 400', async () => {
  const r = await call('PUT', `/role/${ROLE}`, { actor: ADM, body: { modules: { [MODULE_KEY]: 'bogus-access' } } });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Mitglied-Overrides: Validierung, Admin-Sonderregel, Erben durch Leeren
// --------------------------------------------------------------------------
test('GET /user: nicht-numerische ID -> 400', async () => {
  const r = await call('GET', '/user/abc', { actor: ADM });
  assert.equal(r.status, 400);
});

test('GET /user: unbekannte ID -> 404', async () => {
  const r = await call('GET', '/user/999999', { actor: ADM });
  assert.equal(r.status, 404);
});

test('PUT /user: Admin-Ziel wird abgelehnt -> 400 (Admins umgehen das System)', async () => {
  const r = await call('PUT', `/user/${OTHER_ADMIN}`, { actor: ADM, body: { modules: { [MODULE_KEY]: MODULE_LEVEL } } });
  assert.equal(r.status, 400);
  // Es darf für den Admin nichts gespeichert worden sein.
  const check = await call('GET', `/user/${OTHER_ADMIN}`, { actor: ADM });
  assert.deepEqual(check.body.data.modules, {});
});

test('PUT /user: leere Maps ersetzen ihre Achse, ausgelassene Capabilities bleiben erhalten', async () => {
  const initialBody = {
    modules: { [MODULE_KEY]: MODULE_LEVEL },
    capabilities: { [CAPABILITY_KEY]: 'allow' },
    ...(WIDGET_ID && WIDGET_LEVEL ? { widgets: { [WIDGET_ID]: WIDGET_LEVEL } } : {}),
  };
  const put = await call('PUT', `/user/${MEMBER}`, { actor: ADM, body: initialBody });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.modules[MODULE_KEY], MODULE_LEVEL);
  assert.equal(put.body.data.capabilities[CAPABILITY_KEY], 'allow');

  // Starší klient posílá jen původní dvě osy: capability musí přežít.
  const cleared = await call('PUT', `/user/${MEMBER}`, { actor: ADM, body: { modules: {}, widgets: {} } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.modules, {});
  assert.deepEqual(cleared.body.data.widgets, {});
  assert.equal(cleared.body.data.capabilities[CAPABILITY_KEY], 'allow');

  // Explicitní prázdná mapa vyčistí i třetí osu a teprve tím odstraní vše.
  const fullyCleared = await call('PUT', `/user/${MEMBER}`, {
    actor: ADM,
    body: { modules: {}, widgets: {}, capabilities: {} },
  });
  assert.deepEqual(fullyCleared.body.data, { modules: {}, widgets: {}, capabilities: {} });
  const get = await call('GET', `/user/${MEMBER}`, { actor: ADM });
  assert.deepEqual(get.body.data, { modules: {}, widgets: {}, capabilities: {} }, 'alle Achsen sind entfernt');
});

test('PUT /user: Widget-Override round-trip (falls Katalog Widgets führt)', async (t) => {
  if (!WIDGET_ID || !WIDGET_LEVEL) return t.skip('kein Widget im Katalog');
  const put = await call('PUT', `/user/${MEMBER}`, { actor: ADM, body: { widgets: { [WIDGET_ID]: WIDGET_LEVEL } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.widgets[WIDGET_ID], WIDGET_LEVEL);
  await call('PUT', `/user/${MEMBER}`, { actor: ADM, body: {} }); // aufräumen
});

test('PUT /user: Capability kann erlaubt und explizit gesperrt werden', async () => {
  const allowed = await call('PUT', `/user/${MEMBER}`, {
    actor: ADM,
    body: { capabilities: { [CAPABILITY_KEY]: 'allow' } },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.data.capabilities[CAPABILITY_KEY], 'allow');

  const blocked = await call('PUT', `/user/${MEMBER}`, {
    actor: ADM,
    body: { capabilities: { [CAPABILITY_KEY]: 'none' } },
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.data.capabilities[CAPABILITY_KEY], 'none');
});

function seedPendingFastingReminder(userId) {
  db.prepare(`INSERT INTO health_fasting_settings
    (user_id, default_goal_minutes, remind_goal, remind_next_start)
    VALUES (?, 960, 1, 1)`).run(userId);
  const fastId = db.prepare(`INSERT INTO health_fasts
    (user_id, start_at, end_at, start_tzid, goal_minutes)
    VALUES (?, '2026-09-18T06:00:00.000Z', NULL, 'UTC', 960)`).run(userId).lastInsertRowid;
  db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('fasting_goal', ?, '2026-09-18T22:00:00.000Z', ?)`).run(fastId, userId);
}

function installFailingReminderDeleteTrigger() {
  db.exec(`CREATE TRIGGER test_fail_fasting_reminder_delete
    BEFORE DELETE ON reminders
    WHEN OLD.entity_type IN ('fasting_goal', 'fasting_next_start')
    BEGIN
      SELECT RAISE(ABORT, 'forced fasting reminder cleanup failure');
    END`);
}

function removeFailingReminderDeleteTrigger() {
  db.exec('DROP TRIGGER IF EXISTS test_fail_fasting_reminder_delete');
}

test('PUT /user rolls permission revocation back when fasting cleanup fails', async () => {
  const userId = mkUser('fasting-user-failure', 'member', 'child');
  db.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'health_use_fasting', 'allow')`).run(String(userId));
  seedPendingFastingReminder(userId);
  installFailingReminderDeleteTrigger();
  try {
    const response = await call('PUT', `/user/${userId}`, {
      actor: ADM,
      body: { capabilities: { health_use_fasting: 'none' } },
    });
    assert.equal(response.status, 500);
    assert.equal(db.prepare(`SELECT access FROM access_permissions
      WHERE subject_type = 'user' AND subject_id = ?
        AND resource_type = 'capability' AND resource_key = 'health_use_fasting'`).get(String(userId)).access, 'allow');
    assert.equal(db.prepare(`SELECT count(*) AS count FROM reminders
      WHERE created_by = ? AND entity_type = 'fasting_goal'`).get(userId).count, 1);
  } finally {
    removeFailingReminderDeleteTrigger();
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
});

test('PUT /role rolls permission revocation back when fasting cleanup fails', async () => {
  const familyRole = 'relative';
  db.prepare(`DELETE FROM access_permissions WHERE subject_type = 'role' AND subject_id = ?`).run(familyRole);
  db.prepare(`INSERT INTO access_permissions
    (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('role', ?, 'capability', 'health_use_fasting', 'allow')`).run(familyRole);
  const userId = mkUser('fasting-role-failure', 'member', familyRole);
  seedPendingFastingReminder(userId);
  installFailingReminderDeleteTrigger();
  try {
    const response = await call('PUT', `/role/${familyRole}`, {
      actor: ADM,
      body: { capabilities: { health_use_fasting: 'none' } },
    });
    assert.equal(response.status, 500);
    assert.equal(db.prepare(`SELECT access FROM access_permissions
      WHERE subject_type = 'role' AND subject_id = ?
        AND resource_type = 'capability' AND resource_key = 'health_use_fasting'`).get(familyRole).access, 'allow');
    assert.equal(db.prepare(`SELECT count(*) AS count FROM reminders
      WHERE created_by = ? AND entity_type = 'fasting_goal'`).get(userId).count, 1);
  } finally {
    removeFailingReminderDeleteTrigger();
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.prepare(`DELETE FROM access_permissions WHERE subject_type = 'role' AND subject_id = ?`).run(familyRole);
  }
});

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
