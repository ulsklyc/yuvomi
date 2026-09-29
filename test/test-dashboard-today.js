/**
 * Modul: Uebersicht - was heute ist (Server)
 * Zweck: Die Stellen, an denen GET /dashboard „heute" und „diesen Monat"
 *        anders zaehlte als der Haushalt sie erlebt, jede gegen den echten
 *        Router und eine migrierte In-Memory-DB, mit festgenagelter Uhr und
 *        Haushaltszone (Berlin wie die Demo-Saat) und je einem Gegenlauf in
 *        einer Zone, die den Tag oder den Monat verschiebt:
 *
 *        1. Haushaltshilfe (#1451): Besuche und offener Betrag des Monats
 *           zaehlten den UTC-Monat von `check_in` (`substr(check_in, 1, 7)`).
 *
 * Ausfuehren: npm run test:dashboard-today
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { register } from 'node:module';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

register('./test-browser-loader.mjs', import.meta.url);

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'dashboard-today-test-secret';

const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

const ADMIN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role, family_role)
  VALUES (?, 'Anna', 'hash', '#7C3AED', 'admin', 'parent')
`).run(`today-admin-${randomUUID()}`).lastInsertRowid;

const app = express();
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(ADMIN);
  req.authUserId = user.id;
  req.authRole = user.role;
  req.session = { userId: user.id, role: user.role };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/housekeeping', housekeepingRouter);
app.use('/', dashboardRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
}

// Die Uhr steht fest; nur `Date` wird gemockt, die Timer des HTTP-Servers
// laufen weiter. Die Zone ist die des HAUSHALTS (sync_config), nicht die des
// Rechners - die Suite laeuft in jeder Maschinenzone gleich.
function withClock(iso, zone, fn) {
  return async () => {
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
    mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

// --------------------------------------------------------------------------
// 1. Haushaltshilfe: der Monat des Haushalts (#1451)
// --------------------------------------------------------------------------

const HELPER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES (?, 'Maria', 'hash', '#34C759', 'member')
`).run(`today-helper-${randomUUID()}`).lastInsertRowid;
const WORKER = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40)').run(HELPER).lastInsertRowid;

// `check_in` in der Form, die der Check-in schreibt: `toISOString()`.
function seedVisit(checkIn, checkOut, { rate = 40, extras = 0, paid = false } = {}) {
  db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, paid_at, worker_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(checkIn, checkOut, rate, extras, paid ? checkOut : null, WORKER, ADMIN);
}
const clearVisits = () => db.prepare('DELETE FROM housekeeping_work_sessions').run();

test('#1451 Berlin: ein Besuch am Ersten um 00:30 zaehlt in diesem Monat, nicht im Vormonat',
  withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
    clearVisits();
    // 01.10. 00:30 bis 03:30 in Berlin - als Instant noch der 30.09.
    seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z', { extras: 10 });
    // Kontrolle: ein Besuch mitten im September zaehlt nicht.
    seedVisit('2026-09-15T07:00:00.000Z', '2026-09-15T11:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'der Besuch vom 01.10. ist ein Oktober-Besuch');
    assert.equal(housekeeping.unpaidAmount, 50, 'daily_rate 40 + extras 10 im Oktober');
  }));

test('#1451 Los Angeles: ein Besuch am Letzten abends zaehlt in diesem Monat, nicht im naechsten',
  withClock('2026-10-01T03:00:00Z', 'America/Los_Angeles', async () => {
    clearVisits();
    // 30.09. 18:00 bis 21:00 in Los Angeles - als Instant schon der 01.10.
    seedVisit('2026-10-01T01:00:00.000Z', '2026-10-01T04:00:00.000Z');
    const { housekeeping } = await getJson('/');
    assert.equal(housekeeping.visitsThisMonth, 1, 'es ist noch September - der Besuch gehoert dazu');
    assert.equal(housekeeping.unpaidAmount, 40);
  }));

test('#1451: zonenlose Wanduhrzeit zaehlt in ihrem eigenen Monat', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  // Beide Formen, die `check_in` tragen kann (householdMonthOf im Modul):
  // zonenlos steht die Ziffernfolge schon in der Haushaltszone.
  seedVisit('2026-10-01T00:30:00', '2026-10-01T03:30:00');
  seedVisit('2026-09-30T23:30:00', '2026-10-01T01:00:00');
  const { housekeeping } = await getJson('/');
  assert.equal(housekeeping.visitsThisMonth, 1, 'nur der Besuch vom 01.10. gehoert in den Oktober');
}));

test('#1451: Uebersicht und Modul zaehlen dieselben abgeschlossenen Besuche', withClock('2026-10-01T08:00:00Z', 'Europe/Berlin', async () => {
  clearVisits();
  seedVisit('2026-09-30T22:30:00.000Z', '2026-10-01T01:30:00.000Z');
  seedVisit('2026-10-01T05:00:00.000Z', '2026-10-01T07:00:00.000Z', { paid: true });
  seedVisit('2026-09-30T20:00:00.000Z', '2026-09-30T21:30:00.000Z'); // 22:00 Berlin, noch September
  const { housekeeping } = await getJson('/');
  const module = (await getJson('/housekeeping/dashboard')).data;
  assert.equal(module.visits_this_month, 2, 'Vorbedingung: das Modul zaehlt zwei Oktober-Besuche');
  assert.equal(housekeeping.visitsThisMonth, module.visits_this_month, 'Uebersicht und Modul sagen dieselbe Zahl');
}));
