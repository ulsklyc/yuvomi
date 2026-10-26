/**
 * Test: Sichtbarkeit und Sperre einer einzelnen Notiz (#1514, #1602)
 * Zweck: Eine private Notiz fehlt fuer jedes andere Mitglied in Liste,
 *        Aenderungswegen, Suche und Uebersicht - auch fuer Admins. Eine
 *        gesperrte Notiz aendern nur Ersteller:in und Admins, und zwar GANZ:
 *        Bearbeiten, Anpinnen, Loeschen, Kategorien UND Abhaken.
 * Ausführen: node --experimental-sqlite --test test/test-notes-access.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { runSearch } = await import('../server/services/search.js');
const { noteLockedFor, mayChangeNoteLock, mayChangeNoteVisibility } = await import('../public/utils/note-access.js');
const db = dbmod.get();

const addUser = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?)");
const PARENT = Number(addUser.run('parent', 'Parent', 'member').lastInsertRowid);
const CHILD = Number(addUser.run('child', 'Child', 'member').lastInsertRowid);
const ADMIN = Number(addUser.run('admin', 'Admin', 'admin').lastInsertRowid);

let actor = { id: PARENT, role: 'member' };
const as = (id, role = 'member') => { actor = { id, role }; };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/notes', notesRouter);
app.use('/dashboard', dashboardRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

async function create(by, body) {
  as(by);
  const r = await call('POST', '/notes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

const ids = (list) => list.map((n) => n.id);

test('migration: a note without the new fields is visible to all and unlocked', () => {
  const id = Number(db.prepare("INSERT INTO notes (content, created_by) VALUES ('legacy', ?)").run(PARENT).lastInsertRowid);
  const row = db.prepare('SELECT visibility, locked FROM notes WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { visibility: 'all', locked: 0 });
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
});

test('POST: visibility and locked are stored, invalid values are refused in English', async () => {
  const note = await create(PARENT, { content: 'stored', visibility: 'private', locked: true });
  assert.equal(note.visibility, 'private');
  assert.equal(note.locked, 1);
  const bad = await call('POST', '/notes', { content: 'x', visibility: 'assignees' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /visibility/);
  assert.equal((await call('POST', '/notes', { content: 'x', locked: 'yes' })).status, 400);
});

test('private note: absent for every other member in list, write paths, search and overview - admins too', async () => {
  const secret = await create(PARENT, { content: 'zebrasecret - [ ] item', visibility: 'private', pinned: 1 });
  const shared = await create(PARENT, { content: 'zebrashared', pinned: 1 });

  // Die Autorin sieht beide.
  as(PARENT);
  assert.ok(ids((await call('GET', '/notes')).body.data).includes(secret.id));
  assert.ok(ids(runSearch(db, 'zebrasecret', PARENT).notes).includes(secret.id));
  assert.ok(ids((await call('GET', '/dashboard')).body.pinnedNotes).includes(secret.id));

  for (const [id, role] of [[CHILD, 'member'], [ADMIN, 'admin']]) {
    as(id, role);
    const list = ids((await call('GET', '/notes')).body.data);
    assert.ok(!list.includes(secret.id), `list for ${role}`);
    assert.ok(list.includes(shared.id));
    assert.equal((await call('PUT', `/notes/${secret.id}`, { content: 'x' })).status, 404);
    assert.equal((await call('PUT', `/notes/${secret.id}`, { category_ids: [] })).status, 404);
    assert.equal((await call('PATCH', `/notes/${secret.id}/pin`)).status, 404);
    const check = await call('PATCH', `/notes/${secret.id}/check`, { line: 0, checked: true });
    assert.equal(check.status, 404);
    assert.equal(check.body.reason, 'notes_note_not_found');
    assert.equal((await call('DELETE', `/notes/${secret.id}`)).status, 404);
    assert.ok(!ids(runSearch(db, 'zebrasecret', id).notes).includes(secret.id), `search for ${role}`);
    const dash = (await call('GET', '/dashboard')).body;
    assert.ok(!ids(dash.pinnedNotes).includes(secret.id), `overview for ${role}`);
    assert.equal(dash.pinnedNotesCount, 1, `pinned count for ${role}`);
    assert.equal(dash.notesTotal, (await call('GET', '/notes')).body.data.length, `total for ${role}`);
  }
  assert.ok(db.prepare('SELECT 1 FROM notes WHERE id = ?').get(secret.id), 'nothing was deleted');
});

test('visibility: only the author changes it, an unchanged value passes', async () => {
  const note = await create(PARENT, { content: 'vis' });
  as(CHILD);
  const refused = await call('PUT', `/notes/${note.id}`, { visibility: 'private' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'not_owner');
  as(ADMIN, 'admin');
  assert.equal((await call('PUT', `/notes/${note.id}`, { visibility: 'private' })).status, 403);
  // Der ganze Zettel unveraendert zurueck stellt nichts um.
  assert.equal((await call('PUT', `/notes/${note.id}`, { content: 'vis', visibility: 'all' })).status, 200);
  as(PARENT);
  const own = await call('PUT', `/notes/${note.id}`, { visibility: 'private' });
  assert.equal(own.status, 200);
  assert.equal(own.body.data.visibility, 'private');
});

test('lock: holds against everyone else, also for ticking, pinning and categories', async () => {
  const note = await create(PARENT, { content: '- [ ] milk', locked: true });
  as(CHILD);
  for (const [method, path, body] of [
    ['PUT', `/notes/${note.id}`, { content: 'changed' }],
    ['PUT', `/notes/${note.id}`, { category_ids: [] }],
    ['PATCH', `/notes/${note.id}/pin`],
    ['PATCH', `/notes/${note.id}/check`, { line: 0, checked: true }],
    ['DELETE', `/notes/${note.id}`],
  ]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.reason, 'note_locked', `${method} ${path}`);
    assert.match(r.body.error, /^This note is locked/);
  }
  const row = db.prepare('SELECT content, pinned FROM notes WHERE id = ?').get(note.id);
  assert.equal(row.content, '- [ ] milk');
  assert.equal(row.pinned, 0);

  // Ersteller:in und Admin duerfen.
  as(PARENT);
  assert.equal((await call('PATCH', `/notes/${note.id}/check`, { line: 0, checked: true })).status, 200);
  as(ADMIN, 'admin');
  assert.equal((await call('PATCH', `/notes/${note.id}/pin`)).status, 200);
  assert.equal((await call('PUT', `/notes/${note.id}`, { content: '- [x] milk', locked: false })).status, 200);
  as(CHILD);
  assert.equal((await call('PATCH', `/notes/${note.id}/check`, { line: 0, checked: false })).status, 200);
});

test('lock: an unlocked note stays open as before, but only author and admins set the lock', async () => {
  const note = await create(PARENT, { content: '- [ ] bread' });
  as(CHILD);
  assert.equal((await call('PATCH', `/notes/${note.id}/check`, { line: 0, checked: true })).status, 200);
  const r = await call('PUT', `/notes/${note.id}`, { locked: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'not_owner');
  as(ADMIN, 'admin');
  assert.equal((await call('PUT', `/notes/${note.id}`, { locked: true })).body.data.locked, 1);
});

test('note-access: the rule the page and the server share', () => {
  const note = { created_by: 1, locked: 1 };
  assert.equal(noteLockedFor(note, { userId: 2 }), true);
  assert.equal(noteLockedFor(note, { userId: 1 }), false);
  assert.equal(noteLockedFor(note, { userId: 2, isAdmin: true }), false);
  assert.equal(noteLockedFor({ ...note, locked: 0 }, { userId: 2 }), false);
  assert.equal(mayChangeNoteLock(note, { userId: 2, isAdmin: true }), true);
  assert.equal(mayChangeNoteLock(note, { userId: 2 }), false);
  assert.equal(mayChangeNoteVisibility(note, { userId: 2, isAdmin: true }), false);
  assert.equal(mayChangeNoteVisibility(note, { userId: '1' }), true);
});
