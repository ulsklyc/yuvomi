/**
 * Test: Inventar-Lagerorte-Routen (Stufe 1)
 * Zweck: Zwei-Ebenen-CRUD (Top-Ebene, /subcategories fuer die Kind-Ebene), NOCASE-
 *        Namenskonflikt je Ebene getrennt, Loeschen ist nie blockiert und macht
 *        Gegenstaende/Unterorte eltern-/ortlos statt sie zu verschieben, Umsortieren
 *        je Ebene getrennt.
 * Ausfuehren: node --test test/test-inventory-locations-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createErrorHandler } from '../server/middleware/error-handler.js';
import {
  recordingLog, withTableGone, withWriteRefused, requestLogged, assertFixed500, REFUSED_WRITE_TEXT,
} from './helpers/forced-db-error.js';

const dbmod = await import('../server/db.js');
const { default: locationsRouter } = await import('../server/routes/inventory/locations.js');
const db = dbmod.get();

const app = express();
app.use(express.json());
app.use('/locations', locationsRouter);
// Wie server/index.js: der zentrale Fehlerhandler steht hinter dem Router.
const handlerLog = recordingLog();
app.use(createErrorHandler(handlerLog));
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

// --------------------------------------------------------
// Datenbankfehler (Phase 1b Abschnitt E, Pilot des zentralen Fehlerhandlers).
// Jede Route antwortet auf einen SQLite-Fehler mit 500 und dem festen Satz,
// ohne SQLite-Text im Rumpf, und der Fehler steht genau einmal im Log - gleich,
// ob die Route selbst antwortet oder ihn dem Handler ueberlaesst.
// --------------------------------------------------------
const BROKEN_ROUTES = [
  { method: 'GET', path: '/locations' },
  { method: 'POST', path: '/locations', body: { name: 'Kaputt' } },
  { method: 'PUT', path: '/locations/1', body: { name: 'Kaputt' } },
  { method: 'DELETE', path: '/locations/1' },
  { method: 'PATCH', path: '/locations/reorder', body: { order: [1] } },
  { method: 'POST', path: '/locations/1/subcategories', body: { name: 'Kaputt' } },
  { method: 'PUT', path: '/locations/1/subcategories/2', body: { name: 'Kaputt' } },
  { method: 'DELETE', path: '/locations/1/subcategories/2' },
  { method: 'PATCH', path: '/locations/1/subcategories/reorder', body: { order: [2] } },
];
for (const { method, path, body } of BROKEN_ROUTES) {
  test(`${method} ${path}: Datenbankfehler -> 500 mit festem Satz, kein SQLite-Text im Rumpf`, async () => {
    const answer = await withTableGone(db, 'inventory_locations', () => requestLogged(baseUrl, handlerLog, method, path, body));
    assertFixed500(answer, 'no such table: inventory_locations', `${method} ${path}`);
  });
}

test('POST /locations: scheitert das Einfuegen -> 500 mit festem Satz, nichts angelegt', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_locations').get().c;
  const answer = await withWriteRefused(db, 'inventory_locations', 'INSERT',
    () => requestLogged(baseUrl, handlerLog, 'POST', '/locations', { name: 'Abgelehnt' }));
  assertFixed500(answer, REFUSED_WRITE_TEXT, 'POST /locations');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM inventory_locations').get().c, before);
});

test('PATCH /locations/reorder: scheitert die zweite Zeile, rollt die Transaktion die erste zurueck', async () => {
  const a = await call('POST', '/locations', { name: 'Rollback A' });
  const b = await call('POST', '/locations', { name: 'Rollback B' });
  const ids = [a.body.data.id, b.body.data.id];
  const sortOrders = () => ids.map((id) => db.prepare('SELECT sort_order FROM inventory_locations WHERE id = ?').get(id).sort_order);
  const before = sortOrders();

  // Die erste Zeile (b) ist schon geschrieben, wenn die zweite (a) scheitert.
  const answer = await withWriteRefused(db, 'inventory_locations', 'UPDATE',
    () => requestLogged(baseUrl, handlerLog, 'PATCH', '/locations/reorder', { order: [ids[1], ids[0]] }),
    `NEW.id = ${Number(ids[0])}`);
  assertFixed500(answer, REFUSED_WRITE_TEXT, 'PATCH /locations/reorder');
  assert.deepEqual(sortOrders(), before, 'die Reihenfolge ist unveraendert');
});
