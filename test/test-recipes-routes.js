/**
 * Test: Rezepte-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Recipes-Router - härtet die bislang komplett
 *        ungetestete Route-Schicht ab. Fokus: Validierung (400), Nicht-gefunden
 *        (404), Autorisierungs-Gate (403 owner-only, KEIN Admin-Bypass bei
 *        PUT/DELETE), Zutaten-Regeln (leerer Name übersprungen, category-Default
 *        'Sonstiges', quantity leer→null, Längen-Slicing), meal_types-Normalisierung
 *        (Default alle-4, Dedup, Invalides verworfen), Replace-Set der Zutaten bei
 *        PUT und CASCADE-Löschung. Persistenz jeweils per DB-Assertion belegt.
 * Ausführen: node --experimental-sqlite --test test/test-recipes-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const db = dbmod.get();

const OWNER = db.prepare(`INSERT INTO users (username, display_name, avatar_color, password_hash, role) VALUES ('owner','Owner','#112233','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;

// Aktueller Akteur wird zur Request-Zeit gelesen → pro Test umschaltbar.
let actor = { id: OWNER, role: 'member' };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', recipesRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

function ingredientRows(recipeId) {
  return db.prepare('SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(recipeId);
}

// --------------------------------------------------------------------------
// GET / (Liste)
// --------------------------------------------------------------------------
test('GET /: leere Sammlung → leeres Array', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

// --------------------------------------------------------------------------
// POST / (Anlegen + Validierung + Zutaten-Regeln)
// --------------------------------------------------------------------------
test('POST /: fehlender Titel → 400', async () => {
  const r = await call('POST', '/', { title: '  ' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Titel/);
});

test('POST /: legt Rezept an; created_by, 201, meal_types-Default = alle vier', async () => {
  const r = await call('POST', '/', { title: 'Pfannkuchen' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.title, 'Pfannkuchen');
  // meal_types weggelassen → Normalisierung liefert alle vier Keys.
  assert.deepEqual(r.body.data.meal_types, ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.deepEqual(r.body.data.ingredients, []);
  const row = db.prepare('SELECT created_by, meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.created_by, OWNER);
  assert.equal(row.meal_types, 'breakfast,lunch,dinner,snack');
});

test('POST /: meal_types werden dedupliziert und Ungültiges verworfen', async () => {
  const r = await call('POST', '/', { title: 'Nudeln', meal_types: ['lunch', 'lunch', 'pizza', 'dinner'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.meal_types, ['lunch', 'dinner']);
  const row = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.meal_types, 'lunch,dinner');
});

test('POST /: Zutaten-Regeln - leerer Name übersprungen, quantity leer→null, category-Default, Slicing', async () => {
  const longName = 'N'.repeat(250);
  const longQty = 'Q'.repeat(150);
  const r = await call('POST', '/', {
    title: 'Zutatenprobe',
    ingredients: [
      { name: '  Mehl  ', quantity: '  ', category: '' },   // quantity→null, category→'Sonstiges'
      { name: '   ', quantity: '1 EL', category: 'Backen' }, // leerer Name → übersprungen
      { name: longName, quantity: longQty, category: 'Sonstiges' }, // Slicing MAX_TITLE/MAX_SHORT
    ],
  });
  assert.equal(r.status, 201);
  const rows = ingredientRows(r.body.data.id);
  assert.equal(rows.length, 2); // leerer Name wurde nicht eingefügt
  assert.deepEqual(rows[0], { name: 'Mehl', quantity: null, category: 'Sonstiges' });
  assert.equal(rows[1].name.length, 200); // MAX_TITLE
  assert.equal(rows[1].quantity.length, 100); // MAX_SHORT
});

test('POST /: zu lange Notizen → 400 (kein Rezept angelegt)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const r = await call('POST', '/', { title: 'X', notes: 'a'.repeat(5001) });
  assert.equal(r.status, 400);
  const after = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  assert.equal(after, before);
});

// --------------------------------------------------------------------------
// GET / (Aggregation, Join, Sortierung)
// --------------------------------------------------------------------------
test('GET /: Creator-Join, Zutaten aggregiert, NOCASE-Sortierung, meal_types normalisiert', async () => {
  // Frische Sicht: aktuelle Titel u.a. "Nudeln", "Pfannkuchen", "Zutatenprobe".
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  const titles = r.body.data.map((x) => x.title);
  // Zu diesem Zeitpunkt existieren exakt diese drei Rezepte; NOCASE-ASC ist
  // deterministisch (kein JS-Kollations-Orakel, das von SQLite abweichen könnte).
  assert.deepEqual(titles, ['Nudeln', 'Pfannkuchen', 'Zutatenprobe']);
  const probe = r.body.data.find((x) => x.title === 'Zutatenprobe');
  assert.equal(probe.creator_name, 'Owner');
  assert.equal(probe.creator_color, '#112233');
  assert.equal(probe.ingredients.length, 2);
  assert.ok(Array.isArray(probe.meal_types));
});

// --------------------------------------------------------------------------
// PUT /:id (Validierung, Auth-Gate, Replace-Set)
// --------------------------------------------------------------------------
test('PUT /:id: ungültige ID (0) → 400', async () => {
  const r = await call('PUT', '/0', { title: 'egal' });
  assert.equal(r.status, 400);
});

test('PUT /:id: nicht existent → 404', async () => {
  const r = await call('PUT', '/999999', { title: 'egal' });
  assert.equal(r.status, 404);
});

test('PUT /:id: Fremdrezept trotz Admin-Rolle → 403 (kein Admin-Bypass), DB unverändert', async () => {
  const own = await call('POST', '/', { title: 'Owners Rezept', notes: 'geheim' });
  const id = own.body.data.id;
  actor = { id: ADMIN, role: 'admin' };
  const r = await call('PUT', `/${id}`, { title: 'Gekapert', notes: 'weg' });
  actor = { id: OWNER, role: 'member' };
  assert.equal(r.status, 403);
  const row = db.prepare('SELECT title, notes FROM recipes WHERE id = ?').get(id);
  assert.equal(row.title, 'Owners Rezept'); // unverändert
  assert.equal(row.notes, 'geheim');
});

test('PUT /:id: Eigentümer aktualisiert Felder und ersetzt Zutaten (Replace-Set)', async () => {
  const created = await call('POST', '/', {
    title: 'Alt',
    meal_types: ['breakfast'],
    ingredients: [{ name: 'AltZutat', quantity: '1', category: 'Alt' }],
  });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`, {
    title: 'Neu',
    notes: 'frisch',
    meal_types: ['dinner', 'dinner', 'unknown'],
    ingredients: [
      { name: 'NeuA', quantity: '2', category: 'Neu' },
      { name: 'NeuB', quantity: '', category: '' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, 'Neu');
  assert.deepEqual(r.body.data.meal_types, ['dinner']);
  const rows = ingredientRows(id);
  assert.equal(rows.length, 2); // AltZutat ist weg (DELETE + Reinsert)
  assert.deepEqual(rows.map((x) => x.name), ['NeuA', 'NeuB']);
  assert.deepEqual(rows[1], { name: 'NeuB', quantity: null, category: 'Sonstiges' });
});

test('PUT /:id: Validierungsfehler → 400', async () => {
  const created = await call('POST', '/', { title: 'ValidBase' });
  const r = await call('PUT', `/${created.body.data.id}`, { title: '' });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// DELETE /:id (Validierung, Auth-Gate, CASCADE)
// --------------------------------------------------------------------------
test('DELETE /:id: ungültige ID → 400', async () => {
  const r = await call('DELETE', '/0');
  assert.equal(r.status, 400);
});

test('DELETE /:id: nicht existent → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: Fremdrezept trotz Admin-Rolle → 403 (kein Admin-Bypass)', async () => {
  const own = await call('POST', '/', { title: 'Nicht löschbar' });
  const id = own.body.data.id;
  actor = { id: ADMIN, role: 'admin' };
  const r = await call('DELETE', `/${id}`);
  actor = { id: OWNER, role: 'member' };
  assert.equal(r.status, 403);
  assert.ok(db.prepare('SELECT id FROM recipes WHERE id = ?').get(id)); // noch da
});

test('DELETE /:id: Eigentümer löscht → 204, Zutaten kaskadieren mit', async () => {
  const created = await call('POST', '/', {
    title: 'ToDelete',
    ingredients: [{ name: 'Z1' }, { name: 'Z2' }],
  });
  const id = created.body.data.id;
  assert.equal(ingredientRows(id).length, 2);
  const r = await call('DELETE', `/${id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT id FROM recipes WHERE id = ?').get(id), undefined);
  assert.equal(ingredientRows(id).length, 0); // CASCADE
});
