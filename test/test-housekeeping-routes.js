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

test('teardown: Server schließen', async () => {
  await new Promise((r) => server.close(r));
});
