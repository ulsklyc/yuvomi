/**
 * Test: Notes-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Notes-Router - härtet die bislang nur via
 *        db.prepare simulierte Route-Schicht ab (test-notes-contacts-budget.js baut
 *        die Handler nach, ruft sie nicht auf). Fokus: Validierung (400: Inhalt-
 *        Pflicht, HEX-Farbe), 404, CRUD, Pin-Toggle, Pinned-zuerst-Sortierung,
 *        Titel-Leerung. Notizen sind haushaltsweit → kein Auth-Gate-Teil.
 * Ausführen: node --experimental-sqlite --test test/test-notes-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','Uli','x','member')`).run().lastInsertRowid;
const U2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u2','Berta','x','member')`).run().lastInsertRowid;

let actor = { id: U, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  // cookieSession: eine Sitzung, die neben einem API-Token mitkommt - requireAuth
  // setzt authUserId/authRole dann aus dem Token, req.session bleibt die Sitzung.
  req.session = actor.cookieSession ?? { userId: actor.id, role: actor.role };
  next();
});
app.use('/', notesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

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

// --------------------------------------------------------------------------
// GET /
// --------------------------------------------------------------------------
test('GET /: anfangs leer', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

// --------------------------------------------------------------------------
// Kategorien
// --------------------------------------------------------------------------
test('Kategorien: persönlich ist frei, Haushaltskatalog standardmäßig Admin-only', async () => {
  const personal = await call('POST', '/categories', { name: 'Privat', scope: 'personal' });
  assert.equal(personal.status, 201);
  assert.equal(personal.body.data.scope, 'personal');
  assert.equal('name_key' in personal.body.data, false);
  assert.equal('key' in personal.body.data, false);
  assert.equal('type' in personal.body.data, false);

  const forbidden = await call('POST', '/categories', { name: 'Familie', scope: 'household' });
  assert.equal(forbidden.status, 403);

  actor = { id: U2, role: 'member' };
  const otherView = await call('GET', '/categories');
  assert.equal(otherView.status, 200);
  assert.deepEqual(otherView.body.data, []);
  actor = { id: U, role: 'member' };
});

test('Kategorien: nur scope wählt den Katalog, type ist kein API-Alias', async () => {
  const response = await call('POST', '/categories', { name: 'Kein Type-Alias', type: 'household' });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.scope, 'personal');
});

test('Kategorien: interne Datenbankfehler werden nicht als Eingabefehler offengelegt', async () => {
  db.exec(`
    CREATE TRIGGER test_note_category_storage_failure
    BEFORE INSERT ON note_categories
    BEGIN
      SELECT RAISE(ABORT, 'category storage failure');
    END
  `);
  try {
    const response = await call('POST', '/categories', { name: 'Fehler' });

    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Internal server error.');
    assert.doesNotMatch(response.body.error, /category storage failure/);
  } finally {
    db.exec('DROP TRIGGER test_note_category_storage_failure');
  }
});

test('Kategorien: individuelles Recht erlaubt Haushaltsverwaltung', async () => {
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'capability', 'notes_manage_household_categories', 'allow')
  `).run(String(U));
  const household = await call('POST', '/categories', { name: 'Familie', scope: 'household' });
  assert.equal(household.status, 201);
  assert.equal(household.body.data.scope, 'household');
  assert.equal((await call('GET', '/categories')).body.meta.can_manage_household, true);
});

test('Kategorien: ungültige Scope- und Pfadwerte liefern 400', async () => {
  assert.equal((await call('POST', '/categories', { name: 'Null', scope: null })).status, 400);
  assert.equal((await call('POST', '/categories', { name: 'Leer', scope: '' })).status, 400);
  assert.equal((await call('PUT', '/categories/not-a-number', { name: 'X' })).status, 400);
  assert.equal((await call('DELETE', '/categories/not-a-number')).status, 400);
});

test('Kategorien: Unicode-Dubletten liefern 409 und fremde persönliche Kategorien bleiben verborgen', async () => {
  const first = await call('POST', '/categories', { name: 'Česká', scope: 'personal' });
  assert.equal(first.status, 201);
  assert.equal((await call('POST', '/categories', { name: 'česká', scope: 'personal' })).status, 409);
  assert.equal((await call('POST', '/categories', { name: 'Straße', scope: 'personal' })).status, 201);
  assert.equal((await call('POST', '/categories', { name: 'STRASSE', scope: 'personal' })).status, 409);

  actor = { id: U2, role: 'member' };
  assert.equal((await call('PUT', `/categories/${first.body.data.id}`, { name: 'Cizí' })).status, 404);
  assert.equal((await call('DELETE', `/categories/${first.body.data.id}`)).status, 404);
  actor = { id: U, role: 'member' };
});

test('Kategorien: Umbenennen, Sortieren und Löschen erzwingen Scope-Rechte', async () => {
  const first = (await call('POST', '/categories', { name: 'Sort A', scope: 'personal' })).body.data;
  const second = (await call('POST', '/categories', { name: 'Sort B', scope: 'personal' })).body.data;
  const reordered = await call('PATCH', '/categories/reorder', { order: [second.id, first.id] });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.body.meta.can_manage_household, true);
  const personal = reordered.body.data.filter((category) => [first.id, second.id].includes(category.id));
  assert.deepEqual(personal.map((category) => category.id), [second.id, first.id]);

  const household = reordered.body.data.find((category) => category.scope === 'household');
  const beforeMixedOrder = db.prepare('SELECT id, sort_order FROM note_categories WHERE id IN (?, ?) ORDER BY id').all(first.id, household.id);
  const mixed = await call('PATCH', '/categories/reorder', { order: [first.id, household.id] });
  assert.equal(mixed.status, 400);
  assert.deepEqual(
    db.prepare('SELECT id, sort_order FROM note_categories WHERE id IN (?, ?) ORDER BY id').all(first.id, household.id).map((row) => ({ ...row })),
    beforeMixedOrder.map((row) => ({ ...row })),
  );
  actor = { id: U2, role: 'member' };
  assert.equal((await call('PUT', `/categories/${first.id}`, { name: 'Cizí' })).status, 404);
  assert.equal((await call('PATCH', '/categories/reorder', { order: [household.id] })).status, 403);
  assert.equal((await call('DELETE', `/categories/${household.id}`)).status, 403);

  actor = { id: U, role: 'member' };
  assert.equal((await call('PUT', `/categories/${first.id}`, { name: 'Sort renamed' })).status, 200);
  assert.equal((await call('DELETE', `/categories/${first.id}`)).status, 204);
});

test('Notiz-Zuordnung: jedes Mitglied kann bestehende Haushaltskategorien verwenden', async () => {
  const household = (await call('GET', '/categories')).body.data.find((item) => item.scope === 'household');
  actor = { id: U2, role: 'member' };
  const response = await call('POST', '/', { content: 'Shared assignment', category_ids: [household.id] });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.data.categories.map((category) => category.id), [household.id]);
  const removed = await call('PUT', `/${response.body.data.id}`, { category_ids: [] });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data.categories, []);
  assert.equal((await call('DELETE', `/${response.body.data.id}`)).status, 204);
  actor = { id: U, role: 'member' };
});

test('Notiz-Zuordnung: souběžně zaniklá kategorie vrátí 409 a celou změnu vrátí zpět', async () => {
  const category = (await call('POST', '/categories', { name: 'Race', scope: 'personal' })).body.data;
  const before = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
  db.exec(`
    CREATE TRIGGER test_note_category_disappears
    BEFORE INSERT ON note_category_assignments
    WHEN NEW.category_id = ${Number(category.id)}
    BEGIN
      DELETE FROM note_categories WHERE id = NEW.category_id;
    END
  `);
  try {
    const response = await call('POST', '/', { content: 'Atomic race', category_ids: [category.id] });
    assert.equal(response.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_categories WHERE id = ?').get(category.id).count, 1);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_note_category_disappears');
  }
});

test('Notiz-Response zeigt nur sichtbare Kategorien und schützt fremde persönliche Zuordnung', async () => {
  const categories = (await call('GET', '/categories')).body.data;
  const personal = categories.find((item) => item.scope === 'personal');
  const household = categories.find((item) => item.scope === 'household');
  const created = await call('POST', '/', {
    content: 'Mit Kategorien',
    category_ids: [personal.id, household.id],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.categories.map((item) => item.name), ['Familie', 'Privat']);

  actor = { id: U2, role: 'member' };
  const notes = await call('GET', '/');
  const otherView = notes.body.data.find((item) => item.id === created.body.data.id);
  assert.deepEqual(otherView.categories.map((item) => item.name), ['Familie']);
  const edited = await call('PUT', `/${created.body.data.id}`, { content: 'Jiný text', category_ids: [] });
  assert.equal(edited.status, 200);

  actor = { id: U, role: 'member' };
  const ownerView = (await call('GET', '/')).body.data.find((item) => item.id === created.body.data.id);
  assert.deepEqual(ownerView.categories.map((item) => item.name), ['Privat']);
});

// --------------------------------------------------------------------------
// POST /
// --------------------------------------------------------------------------
test('POST /: fehlender Inhalt → 400', async () => {
  const r = await call('POST', '/', { title: 'X' });
  assert.equal(r.status, 400);
});

test('POST /: ungültige Farbe → 400', async () => {
  const r = await call('POST', '/', { content: 'Hallo', color: 'rot' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /HEX/);
});

test('POST /: legt Notiz an (Default-Farbe, created_by, creator_name-Join)', async () => {
  const r = await call('POST', '/', { content: 'Erste Notiz' });
  assert.equal(r.status, 201);
  const note = r.body.data;
  assert.equal(note.content, 'Erste Notiz');
  assert.equal(note.color, '#FFEB3B');
  assert.equal(note.pinned, 0);
  assert.equal(note.created_by, U);
  assert.equal(note.creator_name, 'Uli');
});

test('POST / mit pinned:true → pinned=1', async () => {
  const r = await call('POST', '/', { content: 'Wichtig', pinned: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.pinned, 1);
});

test('GET /: angepinnte Notizen zuerst', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  assert.equal(r.body.data[0].pinned, 1, 'pinned DESC → angepinnte oben');
});

// --------------------------------------------------------------------------
// PUT /:id
// --------------------------------------------------------------------------
test('PUT /:id: unbekannt → 404', async () => {
  const r = await call('PUT', '/999999', { content: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültige Farbe → 400', async () => {
  const note = (await call('POST', '/', { content: 'Edit' })).body.data;
  const r = await call('PUT', `/${note.id}`, { color: 'blau' });
  assert.equal(r.status, 400);
});

test('PUT /:id: aktualisiert Inhalt/Titel/Farbe/pinned', async () => {
  const note = (await call('POST', '/', { content: 'Alt', title: 'T' })).body.data;
  const r = await call('PUT', `/${note.id}`, { content: 'Neu', title: 'T2', color: '#00FF00', pinned: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.content, 'Neu');
  assert.equal(r.body.data.title, 'T2');
  assert.equal(r.body.data.color, '#00FF00');
  assert.equal(r.body.data.pinned, 1);
});

test('PUT /:id: leerer Titel → null', async () => {
  const note = (await call('POST', '/', { content: 'C', title: 'Hat Titel' })).body.data;
  const r = await call('PUT', `/${note.id}`, { title: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, null);
});

// --------------------------------------------------------------------------
// PATCH /:id/pin
// --------------------------------------------------------------------------
test('PATCH /:id/pin: unbekannt → 404', async () => {
  const r = await call('PATCH', '/999999/pin');
  assert.equal(r.status, 404);
});

test('PATCH /:id/pin: toggelt 0 → 1 → 0', async () => {
  const note = (await call('POST', '/', { content: 'Toggle' })).body.data;
  const r1 = await call('PATCH', `/${note.id}/pin`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.pinned, 1);
  const r2 = await call('PATCH', `/${note.id}/pin`);
  assert.equal(r2.body.data.pinned, 0);
  assert.equal(db.prepare('SELECT pinned FROM notes WHERE id = ?').get(note.id).pinned, 0);
});

// --------------------------------------------------------------------------
// DELETE /:id
// --------------------------------------------------------------------------
test('DELETE /:id: unbekannt → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: löscht Notiz (204)', async () => {
  const note = (await call('POST', '/', { content: 'Weg' })).body.data;
  const r = await call('DELETE', `/${note.id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE id = ?').get(note.id).c, 0);
});

test('Kategorien: ein Mitglieds-Token neben einer Admin-Sitzung legt keine Haushaltskategorie an, die Admin-Sitzung allein schon', async () => {
  // Eigene Nutzer: U hat oben ein individuelles Recht bekommen und taugt nicht als Mitglied ohne Recht.
  const member = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('token-member','Toni','x','member')`).run().lastInsertRowid;
  const admin = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('session-admin','Ada','x','admin')`).run().lastInsertRowid;
  try {
    actor = { id: member, role: 'member', cookieSession: { userId: admin, role: 'admin' } };
    const withToken = await call('POST', '/categories', { name: 'Token-Probe', scope: 'household' });
    assert.equal(withToken.status, 403, 'das Gate urteilt nach der Rolle des Token-Subjekts');
    actor = { id: admin, role: 'admin' };
    const adminOnly = await call('POST', '/categories', { name: 'Token-Probe', scope: 'household' });
    assert.equal(adminOnly.status, 201);
  } finally {
    actor = { id: U, role: 'member' };
    db.prepare("DELETE FROM note_categories WHERE scope = 'household' AND name = 'Token-Probe'").run();
  }
});

test.after(() => server.close());
