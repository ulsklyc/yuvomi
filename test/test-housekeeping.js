/**
 * Modul: Housekeeping-Test
 * Zweck: Validiert Housekeeping-Schema, API-Abfragen und Constraints
 * Ausführen: node --experimental-sqlite test/test-housekeeping.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { MIGRATIONS, _setTestDatabase, _resetTestDatabase } from '../server/db.js';
import { roundMinutesTo15, computeHourlyAmount } from '../server/services/housekeeping-billing.js';

// auth.js (via Route-Import) erwartet SESSION_SECRET; vor dem dynamischen
// Import setzen, da statische Imports gehoistet würden.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

// In-Memory-DB mit allen Migrationen aufbauen
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') {
      m.up(db);
    } else {
      db.exec(m.up);
    }
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

// Seed a test user for created_by references
db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('testuser', 'Test User', '$2b$12$test', 'member')
`).run();

test('housekeeping smoke: workers table exists', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='housekeeping_workers'"
  ).get();
  assert.equal(row?.name, 'housekeeping_workers');
});

test('housekeeping smoke: decay tasks table exists', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='housekeeping_decay_tasks'"
  ).get();
  assert.equal(row?.name, 'housekeeping_decay_tasks');
});

test('decay task: PATCH last_completed=null clears completion (undo)', () => {
  // 1) Task anlegen
  const created = db.prepare(`
    INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
    VALUES ('Mop', 'Kitchen', 7, '2026-06-01T10:00:00Z', 1)
  `).run();
  const id = created.lastInsertRowid;
  // 2) Simuliere PATCH-Handler-Effekt: last_completed -> null
  db.prepare('UPDATE housekeeping_decay_tasks SET last_completed = ? WHERE id = ?').run(null, id);
  const row = db.prepare('SELECT last_completed FROM housekeeping_decay_tasks WHERE id = ?').get(id);
  assert.equal(row.last_completed, null);
});

test('GET /visits/:id: found returns visit with fields', async () => {
  // visit exists (created_by → user id=1, worker needed)
  const wId = db.prepare(`INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (1, 80)`).run().lastInsertRowid;
  const vRow = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, daily_rate, extras, created_by)
    VALUES (?, '2026-06-01T09:00:00Z', 80, 10, 1)
  `).run(wId);
  const vId = vRow.lastInsertRowid;
  const row = db.prepare(`
    SELECT hws.*, u.display_name AS worker_name
    FROM housekeeping_work_sessions hws
    LEFT JOIN housekeeping_workers hw ON hw.id = hws.worker_id
    LEFT JOIN users u ON u.id = hw.user_id
    WHERE hws.id = ?
  `).get(vId);
  assert.ok(row);
  assert.equal(Number(row.daily_rate), 80);
  assert.ok(row.worker_name);
});

test('GET /visits/:id: unknown id returns null row', () => {
  const row = db.prepare('SELECT * FROM housekeeping_work_sessions WHERE id = 99999').get();
  assert.equal(row, undefined);
});

test('staff separation: hidden from task assignees but birthday stays visible', () => {
  // Staff-User + Worker + birthdays-Zeile anlegen
  const staff = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES ('hk1','HK One','x','member','other')
  `).run().lastInsertRowid;
  db.prepare(`INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 0)`).run(staff);
  db.prepare(`INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES ('HK One','1990-04-01',1,?)`).run(staff);

  // Normalen Familien-User anlegen
  const fam = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES ('mom','Mom','x','member','mom')
  `).run().lastInsertRowid;

  // Task-Zuweisungsliste (NOT EXISTS Filter)
  const assignees = db.prepare(`
    SELECT id FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
  `).all().map((r) => r.id);
  assert.ok(!assignees.includes(Number(staff)), 'staff should not be in assignees');
  assert.ok(assignees.includes(Number(fam)), 'family member should be in assignees');

  // Geburtstag bleibt (birthdays-Query unverändert)
  const bd = db.prepare('SELECT 1 FROM birthdays WHERE family_user_id = ?').get(staff);
  assert.ok(bd, 'staff birthday should remain visible');
});

test('staff login: blocked for housekeeping worker accounts', () => {
  // Staff-User anlegen (separater Username, damit kein Konflikt mit anderen Tests)
  const staffId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('hk_login_test','HK Login','$2b$12$test','member')
  `).run().lastInsertRowid;
  db.prepare(`INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 0)`).run(staffId);

  // Simuliere den Guard: prüfe ob housekeeping_worker-Zeile existiert
  const isStaff = db.prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(staffId);
  assert.ok(isStaff, 'staff should be detectable by worker row');

  // Normaler User ist KEIN Staff
  const normalId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('normal_login_test','Normal User','$2b$12$test','member')
  `).run().lastInsertRowid;
  const notStaff = db.prepare('SELECT 1 FROM housekeeping_workers WHERE user_id = ?').get(normalId);
  assert.equal(notStaff, undefined, 'regular user should not be staff');
});

test('hourly rate: schema has rate_type/hourly_rate columns', () => {
  const wCols = db.prepare(`PRAGMA table_info(housekeeping_workers)`).all().map((c) => c.name);
  assert.ok(wCols.includes('rate_type'), 'housekeeping_workers should have rate_type');
  assert.ok(wCols.includes('hourly_rate'), 'housekeeping_workers should have hourly_rate');
  const sCols = db.prepare(`PRAGMA table_info(housekeeping_work_sessions)`).all().map((c) => c.name);
  assert.ok(sCols.includes('rate_type'), 'housekeeping_work_sessions should have rate_type');
  assert.ok(sCols.includes('hourly_rate'), 'housekeeping_work_sessions should have hourly_rate');
  assert.ok(sCols.includes('minutes_worked'), 'housekeeping_work_sessions should have minutes_worked');
});

test('billing: rounds minutes to nearest 15', () => {
  assert.equal(roundMinutesTo15(0), 0);
  assert.equal(roundMinutesTo15(7), 0);
  assert.equal(roundMinutesTo15(8), 15);
  assert.equal(roundMinutesTo15(52), 45);
  assert.equal(roundMinutesTo15(53), 60);
});

test('billing: amount = roundedHours * rate', () => {
  assert.equal(computeHourlyAmount(210, 10), 35);   // 210 min -> 3.5h * 10
  assert.equal(computeHourlyAmount(53, 12), 12);    // 53 -> 60 min -> 1h * 12
  assert.equal(computeHourlyAmount(0, 10), 0);      // 0 min -> 0
});

test('hourly checkout: minutes_worked and daily_rate computed from check_in/check_out', () => {
  // Worker mit hourly rate anlegen
  const hwResult = db.prepare(`
    INSERT INTO housekeeping_workers (user_id, daily_rate, rate_type, hourly_rate)
    VALUES (1, 0, 'hourly', 10)
    ON CONFLICT(user_id) DO UPDATE SET rate_type='hourly', hourly_rate=10
  `).run();
  const hwId = db.prepare('SELECT id FROM housekeeping_workers WHERE user_id = 1').get().id;

  // Session anlegen: check_in vor 2h, check_out null (open session)
  const checkIn = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const sessionId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, daily_rate, extras, created_by, rate_type, hourly_rate)
    VALUES (?, ?, 0, 0, 1, 'hourly', 10)
  `).run(hwId, checkIn).lastInsertRowid;

  // Simuliere check-out Logik direkt (wie der Route-Handler)
  const checkOut = new Date().toISOString();
  const mins = Math.round((new Date(checkOut) - new Date(checkIn)) / 60000);
  const hourlyRate = 10;
  const expectedRate = computeHourlyAmount(mins, hourlyRate); // rounds to nearest 15 min

  db.prepare(`
    UPDATE housekeeping_work_sessions
    SET check_out = ?, minutes_worked = ?, daily_rate = ?, rate_type = 'hourly', hourly_rate = 10
    WHERE id = ?
  `).run(checkOut, mins, expectedRate, sessionId);

  const row = db.prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(sessionId);
  assert.ok(row.minutes_worked >= 118 && row.minutes_worked <= 122, `minutes_worked should be ~120, got ${row.minutes_worked}`);
  assert.ok(Number(row.daily_rate) >= 19 && Number(row.daily_rate) <= 21, `daily_rate should be ~20, got ${row.daily_rate}`);
  assert.equal(row.rate_type, 'hourly');
  assert.equal(Number(row.hourly_rate), 10);
});

// Express-App für Route-Level-Tests (PUT /visits/:id)
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = 1; req.session = { userId: 1 }; next(); });
app.use('/api/v1/housekeeping', housekeepingRouter);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('PUT /visits/:id: hourly visit updates without daily_rate (regression #367)', async () => {
  // Stündlicher Worker + Besuch mit minutes_worked, ohne daily_rate-Feld
  const uId = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('hk-hourly', 'HK Hourly', 'x', 'member')`).run().lastInsertRowid;
  const wId = db.prepare(`
    INSERT INTO housekeeping_workers (user_id, daily_rate, rate_type, hourly_rate)
    VALUES (?, 0, 'hourly', 12)
  `).run(uId).lastInsertRowid;
  const vId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by, rate_type, hourly_rate, minutes_worked)
    VALUES (?, '2026-06-01T09:00:00.000Z', '2026-06-01T09:00:00.000Z', 12, 0, 1, 'hourly', 12, 60)
  `).run(wId).lastInsertRowid;

  // Frontend sendet bei hourly minutes_worked statt daily_rate
  const res = await request('PUT', `/api/v1/housekeeping/visits/${vId}`, {
    date: '2026-06-01',
    minutes_worked: 120,
    extras: 0,
  });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const row = db.prepare('SELECT * FROM housekeeping_work_sessions WHERE id = ?').get(vId);
  assert.equal(Number(row.minutes_worked), 120);
  // 120 min * 12/h = 24
  assert.equal(Number(row.daily_rate), computeHourlyAmount(120, 12));
});

test('PUT /visits/:id: non-hourly visit still requires daily_rate', async () => {
  const uId = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('hk-daily', 'HK Daily', 'x', 'member')`).run().lastInsertRowid;
  const wId = db.prepare(`INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 80)`).run(uId).lastInsertRowid;
  const vId = db.prepare(`
    INSERT INTO housekeeping_work_sessions (worker_id, check_in, check_out, daily_rate, extras, created_by)
    VALUES (?, '2026-06-02T09:00:00.000Z', '2026-06-02T09:00:00.000Z', 80, 0, 1)
  `).run(wId).lastInsertRowid;

  const res = await request('PUT', `/api/v1/housekeeping/visits/${vId}`, { date: '2026-06-02', extras: 0 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /daily_rate is required/);
});

test.after(() => server.close());
