/**
 * Test: Schichtplan - eigene Felder (Registry)
 * Zweck: Der Verwaltungs-Router (/schedule/custom-fields) end-to-end - anlegen
 *        (jedes Mitglied), umbenennen/loeschen (nur Ersteller oder Admin, wie
 *        bei Schichttypen - ownTypeOrAdmin() liest ohnehin nur created_by).
 *        Ausserdem: das Loeschen eines Feldes kaskadiert ueber seine
 *        Schichttyp-Zuordnung UND bereits erfasste Werte (Migration 189,
 *        ON DELETE CASCADE) - direkt per SQL nachgewiesen, nicht nur ueber den
 *        Statuscode der Loeschung selbst.
 * Ausführen: npm run test:schedule-custom-fields
 *            (NICHT nackt `node --test test/test-schedule-custom-fields.js` -
 *            DB_PATH wird unten zwar vor jedem eigenen Top-Level-Code gesetzt,
 *            aber statische Imports werten VOR dem Rest dieser Datei aus, in
 *            Abhaengigkeits-Reihenfolge; server/db.js oeffnet die Datenbank
 *            beim eigenen Modul-Laden anhand von process.env.DB_PATH zu genau
 *            diesem fruehen Zeitpunkt. Ohne den Shell-Prefix des npm-Skripts
 *            (schon gesetzt, bevor der Node-Prozess ueberhaupt startet) laeuft
 *            das gegen die echte yuvomi.db im Repo.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { get } from '../server/db.js';
import scheduleRouter from '../server/routes/schedule.js';

const database = get();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('cf-alice', 'Alice', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('cf-bob', 'Bob', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('cf-admin', 'Admin', 'x', 'admin')").run();

const ALICE = { id: 1, role: 'member' };
const BOB = { id: 2, role: 'member' };
const ADMIN = { id: 3, role: 'admin' };
const typeId = database.prepare("INSERT INTO schedule_shift_types (name, start_time, end_time, color) VALUES ('Period 3', '09:55', '10:40', '#B45309')").run().lastInsertRowid;

let actor = ALICE;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', scheduleRouter);
const server = app.listen(0);
const baseUrl = await new Promise((resolveServer) => server.on('listening', () => resolveServer(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = ALICE, body } = {}) {
  actor = as;
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, body: contentType.includes('application/json') ? await response.json() : null };
}

test('a custom field may be added by anyone but only changed by its creator or an admin', async () => {
  const created = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Room' } });
  assert.equal(created.status, 201, 'every member may add a custom field');
  const fieldId = created.body.data.id;
  assert.equal(created.body.data.created_by, ALICE.id, 'the creator is recorded');

  const foreignRename = await call('PUT', `/custom-fields/${fieldId}`, { as: BOB, body: { name: 'Renamed by Bob' } });
  assert.equal(foreignRename.status, 403, 'a member does not rename someone else\'s field');

  const foreignDelete = await call('DELETE', `/custom-fields/${fieldId}`, { as: BOB });
  assert.equal(foreignDelete.status, 403, 'nor delete it');

  const ownRename = await call('PUT', `/custom-fields/${fieldId}`, { as: ALICE, body: { name: 'Room number' } });
  assert.equal(ownRename.status, 200);
  assert.equal(ownRename.body.data.name, 'Room number');

  const adminDelete = await call('DELETE', `/custom-fields/${fieldId}`, { as: ADMIN });
  assert.equal(adminDelete.status, 204, 'an admin may clean up any custom field');
});

test('name is required, trimmed, and capped at 100 characters', async () => {
  const empty = await call('POST', '/custom-fields', { as: ALICE, body: { name: '' } });
  assert.equal(empty.status, 400);

  const tooLong = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'x'.repeat(101) } });
  assert.equal(tooLong.status, 400);

  const ok = await call('POST', '/custom-fields', { as: ALICE, body: { name: '  Instructor  ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.name, 'Instructor');
  await call('DELETE', `/custom-fields/${ok.body.data.id}`, { as: ALICE });
});

test('PUT leaves the name alone when omitted, and a missing field is 404', async () => {
  const created = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Subject' } });
  const fieldId = created.body.data.id;

  const untouched = await call('PUT', `/custom-fields/${fieldId}`, { as: ALICE, body: {} });
  assert.equal(untouched.status, 200);
  assert.equal(untouched.body.data.name, 'Subject');

  const missing = await call('PUT', '/custom-fields/999999', { as: ADMIN, body: { name: 'Nothing' } });
  assert.equal(missing.status, 404);

  await call('DELETE', `/custom-fields/${fieldId}`, { as: ALICE });
});

test('GET lists fields alphabetically', async () => {
  const zebra = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Zebra' } });
  const apple = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Apple' } });
  const list = await call('GET', '/custom-fields', { as: ALICE });
  assert.equal(list.status, 200);
  const names = list.body.data.map((f) => f.name);
  assert.ok(names.indexOf('Apple') < names.indexOf('Zebra'), 'alphabetical, case-insensitive ordering');
  await call('DELETE', `/custom-fields/${zebra.body.data.id}`, { as: ALICE });
  await call('DELETE', `/custom-fields/${apple.body.data.id}`, { as: ALICE });
});

test('deleting a field cascades to its shift-type attachment and any recorded values', async () => {
  const created = await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Cascade me' } });
  const fieldId = created.body.data.id;

  const stfId = database.prepare('INSERT INTO schedule_shift_type_fields (shift_type_id, custom_field_id, position, show_in_overlay) VALUES (?, ?, 0, 1)').run(typeId, fieldId).lastInsertRowid;
  const valueId = database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('pattern_day', 1, ?, 'Room 204')").run(fieldId).lastInsertRowid;

  assert.equal(database.prepare('SELECT count(*) AS c FROM schedule_shift_type_fields WHERE id = ?').get(stfId).c, 1);
  assert.equal(database.prepare('SELECT count(*) AS c FROM schedule_custom_field_values WHERE id = ?').get(valueId).c, 1);

  const deleted = await call('DELETE', `/custom-fields/${fieldId}`, { as: ALICE });
  assert.equal(deleted.status, 204);

  assert.equal(database.prepare('SELECT count(*) AS c FROM schedule_shift_type_fields WHERE id = ?').get(stfId).c, 0, 'the attachment is gone too');
  assert.equal(database.prepare('SELECT count(*) AS c FROM schedule_custom_field_values WHERE id = ?').get(valueId).c, 0, 'the recorded value is gone too');
});

test('schedule_custom_field_values rejects an empty or overlong value at the schema level', () => {
  const fieldId = database.prepare("INSERT INTO schedule_custom_fields (name) VALUES ('Constraint check')").run().lastInsertRowid;
  assert.throws(() => database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', 1, ?, '')").run(fieldId));
  assert.throws(() => database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', 1, ?, ?)").run(fieldId, 'x'.repeat(501)));
  database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', 1, ?, 'ok')").run(fieldId);
  database.prepare('DELETE FROM schedule_custom_fields WHERE id = ?').run(fieldId);
});

// --------------------------------------------------------
// User deletion cascade (server/auth.js DELETE /users/:id, audit finding):
// schedule_patterns/schedule_overrides/schedule_extra_shifts all cascade away
// with the user (FK CASCADE on user_id), but schedule_custom_field_values is
// polymorphic (entry_type/entry_id, no real FK - same compromise
// reminders.entity_id makes) and does NOT ride that cascade. Exercised against
// the REAL route (not a re-implementation of its cleanup SQL), the same way
// this file already goes through the real schedule router for every other
// cascade above.
// --------------------------------------------------------
const { router: authRouter } = await import('../server/auth.js');
let deleteActor = ADMIN;
const CSRF = 'a'.repeat(64);
const authApp = express();
authApp.use(express.json());
authApp.use((req, _res, next) => {
  req.session = { userId: deleteActor.id, role: deleteActor.role, csrfToken: CSRF };
  next();
});
authApp.use('/auth', authRouter);
const authServer = authApp.listen(0);
const authBaseUrl = await new Promise((r) => authServer.on('listening', () => r(`http://127.0.0.1:${authServer.address().port}`)));
test.after(() => authServer.close());

test('deleting a user cleans up schedule_custom_field_values left behind by their pattern days, overrides, and extra shifts', async () => {
  const doomed = database.prepare(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES ('cf-doomed', 'Doomed', 'x', 'member')"
  ).run().lastInsertRowid;
  const field = database.prepare("INSERT INTO schedule_custom_fields (name) VALUES ('Doomed field')").run().lastInsertRowid;

  const patternId = database.prepare(
    "INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length) VALUES (?, 'Doomed pattern', '2027-01-01', 1)"
  ).run(doomed).lastInsertRowid;
  const dayId = database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)').run(patternId, typeId).lastInsertRowid;
  database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('pattern_day', ?, ?, 'p')").run(dayId, field);

  database.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)').run(doomed, '2027-01-05', typeId);
  const overrideId = database.prepare('SELECT id FROM schedule_overrides WHERE user_id = ? AND date_key = ?').get(doomed, '2027-01-05').id;
  database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('override', ?, ?, 'o')").run(overrideId, field);

  database.prepare('INSERT INTO schedule_extra_shifts (user_id, date_key, shift_type_id) VALUES (?, ?, ?)').run(doomed, '2027-01-06', typeId);
  const extraId = database.prepare('SELECT id FROM schedule_extra_shifts WHERE user_id = ? AND date_key = ?').get(doomed, '2027-01-06').id;
  database.prepare("INSERT INTO schedule_custom_field_values (entry_type, entry_id, custom_field_id, value) VALUES ('extra_shift', ?, ?, 'e')").run(extraId, field);

  assert.equal(database.prepare('SELECT COUNT(*) AS c FROM schedule_custom_field_values WHERE custom_field_id = ?').get(field).c, 3,
    'sanity: all three per-occurrence values exist before deletion');

  deleteActor = ADMIN;
  const res = await fetch(`${authBaseUrl}/auth/users/${doomed}`, { method: 'DELETE', headers: { 'X-CSRF-Token': CSRF } });
  assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => null)));

  assert.equal(database.prepare('SELECT 1 FROM users WHERE id = ?').get(doomed), undefined, 'the user itself is gone');
  assert.equal(database.prepare('SELECT COUNT(*) AS c FROM schedule_custom_field_values WHERE custom_field_id = ?').get(field).c, 0,
    'pattern_day/override/extra_shift custom field values must not survive the deletion of the user whose rows they were attached to - '
    + 'entry_id carries no real foreign key for a schema-level cascade to ride on');

  database.prepare('DELETE FROM schedule_custom_fields WHERE id = ?').run(field);
});
