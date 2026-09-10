/**
 * Test: Schichtplan-Extras (zusaetzliche Schichten)
 * Zweck: (1) Extras verschmelzen additiv mit dem, was scheduleData() ohnehin
 *        fuer einen Tag ausgibt - auch an einem Tag ohne primaere Schicht,
 *        auch zwei Extras mit demselben shift_type_id am selben Tag.
 *        (2) Der Verwaltungs-Router (/schedule/extras) end-to-end: erstellen,
 *        Zeitraum fuellen, aendern, loeschen, self-oder-admin.
 * Ausführen: npm run test:schedule-extras
 *            (NICHT nackt `node --test test/test-schedule-extras.js` - DB_PATH
 *            wird unten zwar vor jedem eigenen Top-Level-Code gesetzt, aber
 *            statische Imports werten VOR dem Rest dieser Datei aus, in
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
import scheduleExtrasRouter from '../server/routes/schedule-extras.js';

const database = get();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('extras-alice', 'Alice', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('extras-bob', 'Bob', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('extras-admin', 'Admin', 'x', 'admin')").run();

const ALICE = { id: 1, role: 'member' };
const BOB = { id: 2, role: 'member' };
const ADMIN = { id: 3, role: 'admin' };
const typeId = database.prepare("INSERT INTO schedule_shift_types (name, start_time, end_time, color) VALUES ('Early', '06:00', '14:00', '#6C3AED')").run().lastInsertRowid;

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
app.use('/extras', scheduleExtrasRouter);
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

// Extras are additive to whatever the primary pattern/override slot resolves
// for a day - never a replacement for it, and never routed through the same
// (user_id, date_key) upsert as overrides (there is nothing to conflict on:
// arbitrarily many extras, even sharing a shift_type_id, are allowed on one
// day). This is the core scenario the whole feature exists for: on-call
// stacked on top of a regular shift on the same date.
test('extras merge alongside whatever the primary slot resolves, including an extra-only day with no primary shift', async () => {
  await call('PUT', '/overrides/2027-06-01', { as: ALICE, body: { user_id: ALICE.id, shift_type_id: typeId } });
  const onCall = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-06-01', shift_type_id: typeId, note: 'On-call' } });
  assert.equal(onCall.status, 201);

  const withPrimary = await call('GET', '/entries?from=2027-06-01&to=2027-06-01&user_id=' + ALICE.id, { as: ALICE });
  const aliceEntries = withPrimary.body.data.entries.filter((e) => e.user_id === ALICE.id);
  assert.equal(aliceEntries.length, 2, 'the primary override and the extra both show up as separate entries');
  assert.ok(aliceEntries.some((e) => e.source === 'override' && e.shift_type_id === typeId));
  assert.ok(aliceEntries.some((e) => e.source === 'extra' && e.shift_type_id === typeId && e.note === 'On-call'));

  // ADMIN has no pattern or override anywhere in this fixture, so resolveEntries()
  // pushes nothing for them on any date - a genuinely primary-free day.
  const extraOnly = await call('POST', '/extras', { as: ADMIN, body: { user_id: ADMIN.id, date_key: '2027-06-15', shift_type_id: typeId, note: 'Cover' } });
  assert.equal(extraOnly.status, 201);
  const noPrimary = await call('GET', '/entries?from=2027-06-15&to=2027-06-15&user_id=' + ADMIN.id, { as: ADMIN });
  assert.equal(noPrimary.body.data.entries.length, 1, 'an extra with no primary shift that day still resolves - it needs no special-casing');
  assert.equal(noPrimary.body.data.entries[0].source, 'extra');
});

test('extras CRUD: create, fill, update, and delete are addressed by the extra\'s own id, self or admin-on-behalf', async () => {
  const denied = await call('POST', '/extras', { as: ALICE, body: { user_id: BOB.id, date_key: '2027-07-01', shift_type_id: typeId } });
  assert.equal(denied.status, 403, 'a member cannot add an extra to someone else\'s schedule');

  const badType = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-07-01', shift_type_id: 999999 } });
  assert.equal(badType.status, 400);
  assert.match(badType.body.error, /shift_type_id does not exist/);

  const badOffset = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-07-01', shift_type_id: typeId, reminder_offset_minutes: -5 } });
  assert.equal(badOffset.status, 400);
  assert.match(badOffset.body.error, /reminder_offset_minutes must be/);

  const created = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-07-01', shift_type_id: typeId, note: 'On-call', reminder_offset_minutes: 30 } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.reminder_offset_minutes, 30);
  const extraId = created.body.data.id;

  const updated = await call('PUT', `/extras/${extraId}`, { as: ALICE, body: { note: 'Updated', reminder_offset_minutes: null } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.note, 'Updated');
  assert.equal(updated.body.data.reminder_offset_minutes, null, 'reminder_offset_minutes may be explicitly cleared back to null');
  assert.equal(updated.body.data.shift_type_id, typeId, 'a field left out of the PUT body keeps its previous value');

  const foreignEdit = await call('PUT', `/extras/${extraId}`, { as: BOB, body: { note: 'Hijacked' } });
  assert.equal(foreignEdit.status, 403);

  const foreignDelete = await call('DELETE', `/extras/${extraId}`, { as: BOB });
  assert.equal(foreignDelete.status, 403);

  const deleted = await call('DELETE', `/extras/${extraId}`, { as: ALICE });
  assert.equal(deleted.status, 204);
  assert.equal(database.prepare('SELECT 1 FROM schedule_extra_shifts WHERE id = ?').get(extraId), undefined);

  // C.6 (audit): foreign-user 403 on /fill had never been asserted to leave
  // no rows behind, unlike the single-day POST /extras case above.
  const foreignFill = await call('POST', '/extras/fill', { as: ALICE, body: { user_id: BOB.id, from: '2027-07-20', to: '2027-07-22', shift_type_id: typeId } });
  assert.equal(foreignFill.status, 403, 'a member cannot fill an extra range on someone else\'s schedule');
  assert.equal(database.prepare('SELECT COUNT(*) AS c FROM schedule_extra_shifts WHERE user_id = ? AND date_key BETWEEN ? AND ?').get(BOB.id, '2027-07-20', '2027-07-22').c, 0,
    'a foreign-user 403 must not have written any row');

  const filled = await call('POST', '/extras/fill', { as: ALICE, body: { user_id: ALICE.id, from: '2027-07-10', to: '2027-07-12', shift_type_id: typeId, note: 'On-call week' } });
  assert.equal(filled.status, 200);
  assert.equal(filled.body.data.created, 3, 'three inclusive days, from and to both count');
  const filledRows = database.prepare('SELECT date_key FROM schedule_extra_shifts WHERE user_id = ? AND date_key BETWEEN ? AND ? ORDER BY date_key').all(ALICE.id, '2027-07-10', '2027-07-12').map((r) => r.date_key);
  assert.deepEqual(filledRows, ['2027-07-10', '2027-07-11', '2027-07-12']);

  const overCap = await call('POST', '/extras/fill', { as: ALICE, body: { user_id: ALICE.id, from: '2027-01-01', to: '2027-05-01', shift_type_id: typeId } });
  assert.equal(overCap.status, 400);
  assert.match(overCap.body.error, /100 days/);
});

// Migration 189: an extra shift's field_values are validated against its
// EFFECTIVE shift type (create, or the replacement type on update, not one
// being left behind), /extras/fill shares one set across every created row,
// and deleting an extra cleans up its values - entry_id is polymorphic
// (no real FK, see the schema comment on schedule_custom_field_values).
test('an extra shift\'s field_values round-trip through create/update, fill shares one set, and delete cleans up', async () => {
  const room = (await call('POST', '/custom-fields', { as: ALICE, body: { name: 'Room' } })).body.data.id;
  // typeId was inserted directly via SQL (created_by is NULL), so only an
  // admin - not its non-owner creator ALICE - may attach fields to it.
  const attach = await call('PUT', `/shift-types/${typeId}/fields`, { as: ADMIN, body: { fields: [{ custom_field_id: room, position: 0 }] } });
  assert.equal(attach.status, 200);

  const badField = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-09-01', shift_type_id: typeId, field_values: { 999999: 'nope' } } });
  assert.equal(badField.status, 400);
  assert.match(badField.body.error, /not attached/);

  const created = await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-09-01', shift_type_id: typeId, field_values: { [room]: 'Room 12' } } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.field_values, { [room]: 'Room 12' });
  const extraId = created.body.data.id;
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id=?").get(extraId).c, 1);

  const listed = await call('GET', '/extras?user_id=' + ALICE.id + '&from=2027-09-01&to=2027-09-01', { as: ALICE });
  assert.deepEqual(listed.body.data.find((e) => e.id === extraId).field_values, { [room]: 'Room 12' });

  const updated = await call('PUT', `/extras/${extraId}`, { as: ALICE, body: { field_values: { [room]: 'Room 99' } } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.data.field_values, { [room]: 'Room 99' });

  // Omitting field_values on a PUT leaves existing values untouched - the
  // same "undefined means unchanged" rule every other field on this route uses.
  const untouched = await call('PUT', `/extras/${extraId}`, { as: ALICE, body: { note: 'Just a note change' } });
  assert.equal(untouched.status, 200);
  assert.deepEqual(untouched.body.data.field_values, { [room]: 'Room 99' });

  const deleted = await call('DELETE', `/extras/${extraId}`, { as: ALICE });
  assert.equal(deleted.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS c FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id=?").get(extraId).c, 0);

  const filled = await call('POST', '/extras/fill', { as: ALICE, body: { user_id: ALICE.id, from: '2027-09-10', to: '2027-09-12', shift_type_id: typeId, field_values: { [room]: 'Room 7' } } });
  assert.equal(filled.status, 200);
  const filledRows = database.prepare('SELECT id FROM schedule_extra_shifts WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(ALICE.id, '2027-09-10', '2027-09-12');
  assert.equal(filledRows.length, 3);
  for (const row of filledRows) {
    assert.equal(database.prepare("SELECT value FROM schedule_custom_field_values WHERE entry_type='extra_shift' AND entry_id=? AND custom_field_id=?").get(row.id, room)?.value, 'Room 7');
  }
});

test('two extras on the same day both appear, even sharing the same shift type - there is nothing to conflict on', async () => {
  await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-08-01', shift_type_id: typeId, note: 'First' } });
  await call('POST', '/extras', { as: ALICE, body: { user_id: ALICE.id, date_key: '2027-08-01', shift_type_id: typeId, note: 'Second' } });
  const rows = database.prepare('SELECT note FROM schedule_extra_shifts WHERE user_id = ? AND date_key = ? ORDER BY id').all(ALICE.id, '2027-08-01');
  assert.deepEqual(rows.map((r) => r.note), ['First', 'Second'], 'a second extra of the same type on the same day is a new row, not an upsert over the first');
});
