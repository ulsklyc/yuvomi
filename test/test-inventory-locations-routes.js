/**
 * Test: Inventar-Lagerorte-Routen (Stufe 1)
 * Zweck: Zwei-Ebenen-CRUD (Top-Ebene, /subcategories fuer die Kind-Ebene), NOCASE-
 *        Namenskonflikt je Ebene getrennt, Loeschen ist nie blockiert und macht
 *        Gegenstaende/Unterorte eltern-/ortlos statt sie zu verschieben, Umsortieren
 *        je Ebene getrennt.
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-locations-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: locationsRouter } = await import('../server/routes/inventory/locations.js');
const db = dbmod.get();

const app = express();
app.use(express.json());
app.use('/locations', locationsRouter);
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

test('GET /locations: leer bei frischer DB', async () => {
  const r = await call('GET', '/locations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

test('POST /locations: legt Top-Ebene-Ort an', async () => {
  const r = await call('POST', '/locations', { name: 'Keller' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.parent_id, null);
  assert.equal(r.body.data.icon, 'package');
});

test('POST /locations: doppelter Top-Ebene-Name (NOCASE) -> 409', async () => {
  const r = await call('POST', '/locations', { name: 'keller' });
  assert.equal(r.status, 409);
});

test('POST /locations/:parentId/subcategories: legt Unterort an', async () => {
  const parent = await call('POST', '/locations', { name: 'Garage' });
  const r = await call('POST', `/locations/${parent.body.data.id}/subcategories`, { name: 'Regal 2' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.parent_id, parent.body.data.id);
});

test('POST subcategory: gleicher Name wie ein Top-Ebene-Ort ist erlaubt (getrennte Ebenen)', async () => {
  const parent = await call('POST', '/locations', { name: 'Dachboden' });
  const r = await call('POST', `/locations/${parent.body.data.id}/subcategories`, { name: 'Dachboden' });
  assert.equal(r.status, 201);
});

test('POST subcategory: doppelter Name INNERHALB desselben Elternteils -> 409', async () => {
  const parent = await call('POST', '/locations', { name: 'Werkstatt' });
  await call('POST', `/locations/${parent.body.data.id}/subcategories`, { name: 'Fach A' });
  const r = await call('POST', `/locations/${parent.body.data.id}/subcategories`, { name: 'fach a' });
  assert.equal(r.status, 409);
});

test('POST subcategory: nicht existenter Elternteil -> 404', async () => {
  const r = await call('POST', '/locations/999999/subcategories', { name: 'X' });
  assert.equal(r.status, 404);
});

test('POST subcategory: unter einem bestehenden Unterort (statt Top-Ebene) -> 404', async () => {
  const parent = await call('POST', '/locations', { name: 'Speicher' });
  const child = await call('POST', `/locations/${parent.body.data.id}/subcategories`, { name: 'Kiste 1' });
  const r = await call('POST', `/locations/${child.body.data.id}/subcategories`, { name: 'Zu tief' });
  assert.equal(r.status, 404);
});

test('DELETE /locations/:id: nie blockiert, Unterorte und Gegenstaende werden elternlos/ortlos', async () => {
  const parent = await call('POST', '/locations', { name: 'Buero' });
  const parentId = parent.body.data.id;
  const child = await call('POST', `/locations/${parentId}/subcategories`, { name: 'Schrank' });
  const childId = child.body.data.id;

  db.prepare(`
    INSERT INTO inventory_items (name, location_id) VALUES ('Laptop', ?)
  `).run(parentId);

  const r = await call('DELETE', `/locations/${parentId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.orphanedItems, 1);
  assert.equal(r.body.orphanedChildren, 1);

  const childRow = db.prepare('SELECT parent_id FROM inventory_locations WHERE id = ?').get(childId);
  assert.equal(childRow.parent_id, null); // Unterort bleibt, wird zur Top-Ebene
  const itemRow = db.prepare('SELECT location_id FROM inventory_items WHERE name = ?').get('Laptop');
  assert.equal(itemRow.location_id, null); // Gegenstand bleibt, wird ortlos
});

test('PATCH /locations/reorder: sortiert nur die Top-Ebene', async () => {
  await call('DELETE', '/locations/999999'); // no-op, keeps prior test data untouched
  const a = await call('POST', '/locations', { name: 'Reorder A' });
  const b = await call('POST', '/locations', { name: 'Reorder B' });
  const r = await call('PATCH', '/locations/reorder', { order: [b.body.data.id, a.body.data.id] });
  assert.equal(r.status, 200);
  const order = r.body.data.map((l) => l.id).filter((id) => id === a.body.data.id || id === b.body.data.id);
  assert.deepEqual(order, [b.body.data.id, a.body.data.id]);
});
