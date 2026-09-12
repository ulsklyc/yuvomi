process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { dashboardPaths } from '../server/openapi/paths/dashboard.js';

test('OpenAPI documents the repeatable AND note-category filter', () => {
  const parameter = dashboardPaths()['/api/v1/dashboard'].get.parameters.find((item) => item.name === 'notes_category');
  assert.ok(parameter);
  assert.equal(parameter.in, 'query');
  assert.equal(parameter.schema.type, 'array');
  assert.equal(parameter.schema.items.type, 'integer');
  assert.equal(parameter.schema.items.minimum, 1);
  assert.equal(parameter.schema.maxItems, 50);
  assert.match(parameter.description, /AND/);
});

const dbmod = await import('../server/db.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const db = dbmod.get();

const userId = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('notes-dashboard', 'Notes Dashboard', 'x', 'member')
`).run().lastInsertRowid);
const otherId = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('notes-dashboard-other', 'Other', 'x', 'member')
`).run().lastInsertRowid);
const addCategory = db.prepare('INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by) VALUES (?, ?, ?, ?, ?)');
const home = Number(addCategory.run('Home', 'home', 'household', null, userId).lastInsertRowid);
const school = Number(addCategory.run('School', 'school', 'personal', userId, userId).lastInsertRowid);
const hidden = Number(addCategory.run('Hidden', 'hidden', 'personal', otherId, otherId).lastInsertRowid);
const addNote = db.prepare("INSERT INTO notes (content, pinned, created_by, updated_at) VALUES (?, 1, ?, ?)");
for (let index = 0; index < 6; index++) {
  addNote.run(`Newer non-match ${index}`, userId, `2026-08-${String(index + 10).padStart(2, '0')}T12:00:00Z`);
}
const both = Number(addNote.run('Both', userId, '2020-01-01T00:00:00Z').lastInsertRowid);
const onlyHome = Number(addNote.run('Only home', userId, '2020-01-02T00:00:00Z').lastInsertRowid);
const invisible = Number(addNote.run('Invisible personal', userId, '2020-01-03T00:00:00Z').lastInsertRowid);
const assign = db.prepare('INSERT INTO note_category_assignments (note_id, category_id, assigned_by) VALUES (?, ?, ?)');
assign.run(both, home, userId);
assign.run(both, school, userId);
assign.run(onlyHome, home, userId);
assign.run(invisible, hidden, otherId);

const app = express();
app.use((req, _res, next) => {
  req.authUserId = userId;
  req.authRole = 'member';
  req.session = { userId, role: 'member' };
  next();
});
app.use('/', dashboardRouter);
const server = app.listen(0);
const baseUrl = await new Promise((resolve) => server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));

test('dashboard note category filters are AND and run before the row limit', async () => {
  const response = await fetch(`${baseUrl}/?notes_category=${home}&notes_category=${school}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.pinnedNotes.map((note) => note.content), ['Both']);
  assert.deepEqual(body.pinnedNotes[0].categories.map((category) => category.name), ['Home', 'School']);
  assert.equal(body.pinnedNotesCount, 1);
});

test('another user personal category id cannot reveal matching notes', async () => {
  const response = await fetch(`${baseUrl}/?notes_category=${hidden}`);
  const body = await response.json();
  assert.deepEqual(body.pinnedNotes, []);
  assert.equal(body.pinnedNotesCount, 0);
});

test.after(() => server.close());
