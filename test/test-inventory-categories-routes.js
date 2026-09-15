/**
 * Test: Inventar-Kategorien-Routen (Stufe 1, plus label_key aus Migration 142)
 * Zweck: CRUD, NOCASE-Namenskonflikt, 'other' nicht loeschbar, Loeschen einer
 *        Kategorie haengt betroffene Gegenstaende auf 'other' um, Umsortieren,
 *        Lokalisierung der fuenf Seed-Kategorien (label_key, name = NULL,
 *        gleiches Muster wie task_categories/server/routes/tasks.js).
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-categories-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: categoriesRouter } = await import('../server/routes/inventory/categories.js');
const db = dbmod.get();

const app = express();
app.use(express.json());
app.use('/categories', categoriesRouter);
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
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

test('GET /categories: fuenf Seed-Kategorien in Sortierreihenfolge', async () => {
  const r = await call('GET', '/categories');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((c) => c.key), ['electronics', 'vehicles', 'household', 'sports', 'other']);
});

test('GET /categories: Seed-Kategorien tragen label_key statt name (Migration 142)', async () => {
  const r = await call('GET', '/categories');
  const electronics = r.body.data.find((c) => c.key === 'electronics');
  assert.equal(electronics.label_key, 'inventory.categoryElectronics');
  assert.equal(electronics.name, null);
});

test('POST /categories: legt Kategorie mit generiertem Key an', async () => {
  const r = await call('POST', '/categories', { name: 'Werkzeug' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.key, 'werkzeug');
  assert.equal(r.body.data.sort_order, 5);
  assert.equal(r.body.data.label_key, null); // custom Kategorien sind nie lokalisiert
});

test('POST /categories: doppelter Name (NOCASE) gegen eine Custom-Kategorie -> 409', async () => {
  const r = await call('POST', '/categories', { name: 'werkzeug' });
  assert.equal(r.status, 409);
});

// Bekannte, dokumentierte Grenze (gleiches Muster wie server/routes/tasks.js):
// der NOCASE-Konflikt vergleicht bei einer lokalisierten Seed-Kategorie gegen
// ihren stabilen KEY, nicht gegen die uebersetzte Anzeige - eine Server-Route
// kennt die Sprache des Aufrufers nicht. "Elektronik" (die deutsche
// Uebersetzung) kollidiert deshalb NICHT mehr mit dem Key 'electronics'.
test('POST /categories: die uebersetzte Anzeige einer Seed-Kategorie loest KEINEN Konflikt aus', async () => {
  const r = await call('POST', '/categories', { name: 'Elektronik' });
  assert.equal(r.status, 201);
});

test('POST /categories: Namenskollision haengt _2 an den Key', async () => {
  await call('POST', '/categories', { name: 'Garten Deko' });
  // "Garten Deko" und "Garten-Deko" slugifizieren beide zu "garten_deko" (slugify
  // ersetzt jede Folge von Nicht-Alphanumerischen durch "_") - echte Key-Kollision,
  // die Namen selbst sind aber verschieden, kein NOCASE-409.
  const r = await call('POST', '/categories', { name: 'Garten-Deko' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.key, 'garten_deko_2');
});

test('PUT /categories/:key: benennt um, aendert Icon und macht eine Seed-Kategorie custom', async () => {
  const r = await call('PUT', '/categories/sports', { name: 'Sport & Fitness', icon: 'trophy' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.key, 'sports');
  assert.equal(r.body.data.name, 'Sport & Fitness');
  assert.equal(r.body.data.icon, 'trophy');
  // 'sports' war eine Seed-Kategorie (label_key) - das Umbenennen macht sie
  // custom, sonst ueberschriebe der naechste Sprachwechsel den getippten
  // Namen wieder (gleiches Muster wie server/routes/tasks.js).
  assert.equal(r.body.data.label_key, null);
});

test('PUT /categories/:key: nicht existent -> 404', async () => {
  const r = await call('PUT', '/categories/does-not-exist', { name: 'Egal' });
  assert.equal(r.status, 404);
});

test('PUT /categories/:key: NOCASE-Namenskonflikt gegen eine Custom-Kategorie beim Umbenennen -> 409', async () => {
  const r = await call('PUT', '/categories/household', { name: 'garten deko' });
  assert.equal(r.status, 409);

  const check = await call('GET', '/categories');
  const household = check.body.data.find((c) => c.key === 'household');
  assert.equal(household.label_key, 'inventory.categoryHousehold'); // unveraendert, weiterhin Seed-Kategorie
});

// Gleiche Grenze wie beim POST-Konflikt oben: 'vehicles' ist noch eine
// Seed-Kategorie, der Vergleich laeuft also gegen ihren Key statt gegen die
// uebersetzte Anzeige "Fahrzeuge".
test('PUT /categories/:key: die uebersetzte Anzeige einer Seed-Kategorie loest beim Umbenennen KEINEN Konflikt aus', async () => {
  const r = await call('PUT', '/categories/household', { name: 'FAHRZEUGE' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'FAHRZEUGE');
  assert.equal(r.body.data.label_key, null);
});

test("DELETE /categories/other: geschuetzt, immer 400", async () => {
  const r = await call('DELETE', '/categories/other');
  assert.equal(r.status, 400);
});

test('DELETE /categories/:key: haengt betroffene Gegenstaende auf other um', async () => {
  const cat = await call('POST', '/categories', { name: 'Temporaer' });
  db.prepare("INSERT INTO inventory_items (name, category) VALUES ('X', ?)").run(cat.body.data.key);
  db.prepare("INSERT INTO inventory_items (name, category) VALUES ('Y', ?)").run(cat.body.data.key);

  const r = await call('DELETE', `/categories/${cat.body.data.key}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.reassigned, 2);

  const rows = db.prepare('SELECT category FROM inventory_items WHERE name IN (?, ?)').all('X', 'Y');
  assert.ok(rows.every((row) => row.category === 'other'));
});

test('DELETE /categories/:key: nicht existent -> 404', async () => {
  const r = await call('DELETE', '/categories/does-not-exist');
  assert.equal(r.status, 404);
});

test('PATCH /categories/reorder: setzt neue Reihenfolge', async () => {
  const r = await call('PATCH', '/categories/reorder', { order: ['other', 'sports', 'household', 'vehicles', 'electronics'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((c) => c.key), ['other', 'sports', 'household', 'vehicles', 'electronics']);
});

test('PATCH /categories/reorder: unbekannter Key -> 400, Reihenfolge unveraendert', async () => {
  const before = await call('GET', '/categories');
  const beforeOrder = before.body.data.map((c) => c.key);

  const r = await call('PATCH', '/categories/reorder', {
    order: ['other', 'sports', 'household', 'vehicles', 'does-not-exist'],
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 400);
  assert.ok(r.body.error.includes('does-not-exist'));

  const after = await call('GET', '/categories');
  assert.deepEqual(after.body.data.map((c) => c.key), beforeOrder);
});
