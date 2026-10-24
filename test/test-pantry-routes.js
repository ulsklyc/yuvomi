/**
 * Test: Vorrats-Routen (#596)
 * Zweck: End-to-End über den echten Pantry-Router plus die Gegenrichtung im
 *        Einkaufs-Router. Fokus: Validierung (400), Nicht-gefunden (404),
 *        Mengen-Normalisierung (Rundung, Klemmung, Default 1 statt 0),
 *        Einheiten-Normalisierung statt Ablehnung, Lagerort-Guards (letzter Ort,
 *        Namenskonflikt, ON DELETE SET NULL erhält den Bestand), PATCH als
 *        Teil-Update sowie beide Import-Richtungen inklusive Chargen-Regel
 *        (gleiches MHD addiert, abweichendes MHD legt eine neue Zeile an).
 *        Persistenz jeweils per DB-Assertion belegt.
 * Ausführen: node --experimental-sqlite --test test/test-pantry-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const db = dbmod.get();

const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.authRole = 'member';
  req.session = { userId: USER, role: 'member' };
  next();
});
app.use('/pantry', pantryRouter);
app.use('/shopping', shoppingRouter);
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

const itemRow = (id) => db.prepare('SELECT * FROM pantry_items WHERE id = ?').get(id);

// --------------------------------------------------------------------------
// Lagerorte
// --------------------------------------------------------------------------
test('GET /pantry/locations: fünf Seed-Orte in Sortierreihenfolge', async () => {
  const r = await call('GET', '/pantry/locations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((l) => l.name),
    ['Vorratsschrank', 'Kühlschrank', 'Gefrierschrank', 'Keller', 'Sonstiges']);
  assert.equal(r.body.data[1].icon, 'refrigerator');
});

test('POST /pantry/locations: doppelter Name → 409 (NOCASE)', async () => {
  const r = await call('POST', '/pantry/locations', { name: 'kühlschrank' });
  assert.equal(r.status, 409);
});

test('POST /pantry/locations: legt Ort mit Default-Icon und nächster sort_order an', async () => {
  const r = await call('POST', '/pantry/locations', { name: 'Garage' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.icon, 'package');
  assert.equal(r.body.data.sort_order, 5);
});

test('PUT /pantry/locations/:id: Umbenennen behält das Icon', async () => {
  const created = await call('POST', '/pantry/locations', { name: 'Speis', icon: 'archive' });
  const r = await call('PUT', `/pantry/locations/${created.body.data.id}`, { name: 'Speisekammer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Speisekammer');
  assert.equal(r.body.data.icon, 'archive');
});

test('DELETE /pantry/locations/:id: Artikel behalten Bestand und werden ortlos', async () => {
  const loc = await call('POST', '/pantry/locations', { name: 'Abstellraum' });
  const locId = loc.body.data.id;
  const item = await call('POST', '/pantry', { name: 'Reis', quantity: 3, unit: 'kg', location_id: locId });
  const itemId = item.body.data.id;

  const r = await call('DELETE', `/pantry/locations/${locId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.orphaned, 1);

  const row = itemRow(itemId);
  assert.equal(row.location_id, null);  // ON DELETE SET NULL
  assert.equal(row.quantity, 3);        // Bestand unangetastet
});

test('DELETE /pantry/locations/:id: nicht existent → 404, ungültige ID → 400', async () => {
  assert.equal((await call('DELETE', '/pantry/locations/999999')).status, 404);
  assert.equal((await call('DELETE', '/pantry/locations/0')).status, 400);
});

// --------------------------------------------------------------------------
// Artikel: Anlegen und Normalisierung
// --------------------------------------------------------------------------
test('POST /pantry: fehlender Name → 400, nichts angelegt', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM pantry_items').get().n;
  const r = await call('POST', '/pantry', { name: '   ' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pantry_items').get().n, before);
});

test('POST /pantry: ohne Menge → 1 (nicht 0), Default-Einheit pcs', async () => {
  const r = await call('POST', '/pantry', { name: 'Salz' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.quantity, 1);
  assert.equal(r.body.data.unit, 'pcs');
  assert.equal(r.body.data.expires_on, null);
  assert.equal(r.body.data.created_by, USER);
});

test('POST /pantry: unbekannte Einheit wird normalisiert statt abgelehnt', async () => {
  const r = await call('POST', '/pantry', { name: 'Kaffee', unit: 'faesser' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.unit, 'pcs');
});

test('POST /pantry: Menge wird auf zwei Nachkommastellen gerundet', async () => {
  const r = await call('POST', '/pantry', { name: 'Öl', quantity: 0.30000000000000004, unit: 'l' });
  assert.equal(r.body.data.quantity, 0.3);
});

test('POST /pantry: negative Menge → 400', async () => {
  const r = await call('POST', '/pantry', { name: 'Negativ', quantity: -5 });
  assert.equal(r.status, 400);
});

test('POST /pantry: Menge über der Obergrenze wird geklemmt', async () => {
  const r = await call('POST', '/pantry', { name: 'Viel', quantity: 5_000_000 });
  assert.equal(r.body.data.quantity, 1_000_000);
});

test('POST /pantry: unbekannter Lagerort → 400', async () => {
  const r = await call('POST', '/pantry', { name: 'Nirgends', location_id: 999999 });
  assert.equal(r.status, 400);
});

test('POST /pantry: ungültige Kategorie → 400', async () => {
  const r = await call('POST', '/pantry', { name: 'Falsch', category: 'Gibt-es-nicht' });
  assert.equal(r.status, 400);
});

test('POST /pantry: ungültiges MHD-Format → 400', async () => {
  const r = await call('POST', '/pantry', { name: 'Datum', expires_on: '12.08.2026' });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// GET (Sortierung + Join)
// --------------------------------------------------------------------------
test('GET /pantry: Ortlose ans Ende, Lagerorte in sort_order, Namen NOCASE', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  const fridge = db.prepare(`SELECT id FROM pantry_locations WHERE name = 'Kühlschrank'`).get().id;
  const cupboard = db.prepare(`SELECT id FROM pantry_locations WHERE name = 'Vorratsschrank'`).get().id;

  await call('POST', '/pantry', { name: 'ortlos' });
  await call('POST', '/pantry', { name: 'Milch', location_id: fridge });
  await call('POST', '/pantry', { name: 'zucker', location_id: cupboard });
  await call('POST', '/pantry', { name: 'Mehl', location_id: cupboard });

  const r = await call('GET', '/pantry');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((i) => i.name), ['Mehl', 'zucker', 'Milch', 'ortlos']);
  assert.equal(r.body.data[0].location_name, 'Vorratsschrank');
  assert.equal(r.body.data[3].location_name, null);
  assert.ok(r.body.locations.length >= 5);
  assert.ok(r.body.categories.length >= 1);
});

// --------------------------------------------------------------------------
// PUT / PATCH / DELETE
// --------------------------------------------------------------------------
test('PATCH /pantry/:id: Teil-Update rührt andere Felder nicht an', async () => {
  const created = await call('POST', '/pantry', {
    name: 'Butter', quantity: 2, unit: 'pkg', notes: 'im Fach oben', min_quantity: 1,
  });
  const id = created.body.data.id;

  const r = await call('PATCH', `/pantry/${id}`, { quantity: 1.5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.quantity, 1.5);
  assert.equal(r.body.data.name, 'Butter');
  assert.equal(r.body.data.unit, 'pkg');
  assert.equal(r.body.data.notes, 'im Fach oben');
  assert.equal(r.body.data.min_quantity, 1);
});

test('PATCH /pantry/:id: leerer Body lässt den Artikel unverändert', async () => {
  const created = await call('POST', '/pantry', { name: 'Unberührt', quantity: 4 });
  const r = await call('PATCH', `/pantry/${created.body.data.id}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.quantity, 4);
});

test('PUT /pantry/:id: ersetzt alle Felder; weggelassene werden geleert', async () => {
  const created = await call('POST', '/pantry', {
    name: 'Alt', quantity: 9, unit: 'kg', notes: 'Notiz', min_quantity: 2, expires_on: '2026-12-01',
  });
  const id = created.body.data.id;

  const r = await call('PUT', `/pantry/${id}`, { name: 'Neu', quantity: 1, unit: 'l' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Neu');
  assert.equal(r.body.data.notes, null);
  assert.equal(r.body.data.min_quantity, null);
  assert.equal(r.body.data.expires_on, null);
});

test('PUT/PATCH/DELETE /pantry/:id: nicht existent → 404, ID 0 → 400', async () => {
  assert.equal((await call('PUT', '/pantry/999999', { name: 'X' })).status, 404);
  assert.equal((await call('PATCH', '/pantry/999999', { quantity: 1 })).status, 404);
  assert.equal((await call('DELETE', '/pantry/999999')).status, 404);
  assert.equal((await call('DELETE', '/pantry/0')).status, 400);
});

test('DELETE /pantry/:id: 204 und Zeile ist weg', async () => {
  const created = await call('POST', '/pantry', { name: 'Wegwerf' });
  const id = created.body.data.id;
  const r = await call('DELETE', `/pantry/${id}`);
  assert.equal(r.status, 204);
  assert.equal(itemRow(id), undefined);
});

// --------------------------------------------------------------------------
// Einkauf → Vorrat
// --------------------------------------------------------------------------
test('POST /pantry/import-shopping: nur abgehakte Artikel, gleiche Charge addiert', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  const list = await call('POST', '/shopping', { name: 'Wocheneinkauf' });
  const listId = list.body.data.id;

  const milk = await call('POST', `/shopping/${listId}/items`, { name: 'Milch' });
  const bread = await call('POST', `/shopping/${listId}/items`, { name: 'Brot' });
  const open = await call('POST', `/shopping/${listId}/items`, { name: 'Nicht gekauft' });
  await call('PATCH', `/shopping/items/${milk.body.data.id}`, { is_checked: 1 });
  await call('PATCH', `/shopping/items/${bread.body.data.id}`, { is_checked: 1 });

  const first = await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [
      { shopping_item_id: milk.body.data.id, quantity: 2, unit: 'l' },
      { shopping_item_id: bread.body.data.id, quantity: 1, unit: 'pcs' },
      { shopping_item_id: open.body.data.id, quantity: 1 },  // nicht abgehakt → übersprungen
    ],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { added: 2, merged: 0, skipped: 1 });

  // Zweiter Lauf mit identischer Charge (Name/Einheit/Ort/MHD) addiert auf.
  const second = await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [{ shopping_item_id: milk.body.data.id, quantity: 1, unit: 'l' }],
  });
  assert.deepEqual(second.body.data, { added: 0, merged: 1, skipped: 0 });

  const rows = db.prepare(`SELECT quantity FROM pantry_items WHERE name = 'Milch'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 3);
});

test('POST /pantry/import-shopping: abweichendes MHD ist eine eigene Charge', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  const list = await call('POST', '/shopping', { name: 'Chargen' });
  const listId = list.body.data.id;
  const item = await call('POST', `/shopping/${listId}/items`, { name: 'Joghurt' });
  await call('PATCH', `/shopping/items/${item.body.data.id}`, { is_checked: 1 });

  await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [{ shopping_item_id: item.body.data.id, quantity: 4, unit: 'pcs', expires_on: '2026-08-10' }],
  });
  const second = await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [{ shopping_item_id: item.body.data.id, quantity: 4, unit: 'pcs', expires_on: '2026-08-24' }],
  });
  assert.equal(second.body.data.added, 1);

  const rows = db.prepare(`SELECT expires_on FROM pantry_items WHERE name = 'Joghurt' ORDER BY expires_on`).all();
  assert.deepEqual(rows.map((r) => r.expires_on), ['2026-08-10', '2026-08-24']);
});

test('POST /pantry/import-shopping: räumt die Einkaufsliste bewusst NICHT ab', async () => {
  const list = await call('POST', '/shopping', { name: 'Bleibt stehen' });
  const listId = list.body.data.id;
  const item = await call('POST', `/shopping/${listId}/items`, { name: 'Nudeln' });
  await call('PATCH', `/shopping/items/${item.body.data.id}`, { is_checked: 1 });

  await call('POST', '/pantry/import-shopping', {
    list_id: listId,
    items: [{ shopping_item_id: item.body.data.id, quantity: 1 }],
  });

  // Das Aufräumen ist ein getrennter Aufruf des Clients (Scope-Trennung).
  const still = db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE list_id = ?').get(listId).n;
  assert.equal(still, 1);
});

test('POST /pantry/import-shopping: unbekannte Liste → 404, leere Auswahl → Nullbilanz', async () => {
  assert.equal((await call('POST', '/pantry/import-shopping', { list_id: 999999, items: [] })).status, 404);
  const list = await call('POST', '/shopping', { name: 'Leer' });
  const r = await call('POST', '/pantry/import-shopping', { list_id: list.body.data.id, items: [] });
  assert.deepEqual(r.body.data, { added: 0, merged: 0, skipped: 0 });
});

// --------------------------------------------------------------------------
// Vorrat → Einkauf
// --------------------------------------------------------------------------
test('POST /shopping/:listId/import-pantry: übernimmt Name und Kategorie, Menge als Freitext', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  const list = await call('POST', '/shopping', { name: 'Nachschub' });
  const listId = list.body.data.id;

  const flour = await call('POST', '/pantry', { name: 'Mehl', quantity: 0, unit: 'kg', category: 'Backwaren', min_quantity: 2 });
  const r = await call('POST', `/shopping/${listId}/import-pantry`, {
    items: [{ pantry_item_id: flour.body.data.id, quantity: '2 kg' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.added, 1);
  assert.equal(r.body.data.skipped, 0);

  const row = db.prepare('SELECT id, name, quantity, category FROM shopping_items WHERE list_id = ?').get(listId);
  assert.deepEqual(
    { name: row.name, quantity: row.quantity, category: row.category },
    { name: 'Mehl', quantity: '2 kg', category: 'Backwaren' },
  );
  // added_ids traegt das Undo im Client (Critique 2026-07-30): es muss die
  // tatsaechlich erzeugte Zeile benennen, nicht nur deren Anzahl - sonst loescht
  // das Zuruecknehmen die falschen Artikel.
  assert.deepEqual(r.body.data.added_ids, [row.id]);
});

test('POST /shopping/:listId/import-pantry: gleicher Name unabgehakt → übersprungen statt dupliziert', async () => {
  const list = await call('POST', '/shopping', { name: 'Dublette' });
  const listId = list.body.data.id;
  await call('POST', `/shopping/${listId}/items`, { name: 'Zucker' });

  const sugar = await call('POST', '/pantry', { name: 'zucker', quantity: 0 });
  const r = await call('POST', `/shopping/${listId}/import-pantry`, {
    items: [{ pantry_item_id: sugar.body.data.id }],
  });
  assert.deepEqual(r.body.data, { added: 0, skipped: 1, added_ids: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE list_id = ?').get(listId).n, 1);
});

test('POST /shopping/:listId/import-pantry: unbekannter Vorratsartikel → skipped, unbekannte Liste → 404', async () => {
  const list = await call('POST', '/shopping', { name: 'Unbekannt' });
  const r = await call('POST', `/shopping/${list.body.data.id}/import-pantry`, {
    items: [{ pantry_item_id: 999999 }],
  });
  assert.deepEqual(r.body.data, { added: 0, skipped: 1, added_ids: [] });
  assert.equal((await call('POST', '/shopping/999999/import-pantry', { items: [] })).status, 404);
});

// Das Undo des Warenkorbs nimmt genau den Uebertrag zurueck und nichts sonst.
test('import-pantry: added_ids erlauben ein exaktes Zuruecknehmen', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  const list = await call('POST', '/shopping', { name: 'Undo' });
  const listId = list.body.data.id;
  // Ein Fremdartikel, den das Undo nicht anfassen darf.
  await call('POST', `/shopping/${listId}/items`, { name: 'Bleibt drin' });

  const a = await call('POST', '/pantry', { name: 'Reis', quantity: 0, min_quantity: 1 });
  const bItem = await call('POST', '/pantry', { name: 'Linsen', quantity: 0, min_quantity: 1 });
  const r = await call('POST', `/shopping/${listId}/import-pantry`, {
    items: [{ pantry_item_id: a.body.data.id }, { pantry_item_id: bItem.body.data.id }],
  });
  assert.equal(r.body.data.added, 2);
  assert.equal(r.body.data.added_ids.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE list_id = ?').get(listId).n, 3);

  const undo = await call('POST', '/shopping/items/undo-transfer', { ids: r.body.data.added_ids });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.data.removed, 2);
  const rest = db.prepare('SELECT name FROM shopping_items WHERE list_id = ?').all(listId);
  assert.deepEqual(rest.map((x) => x.name), ['Bleibt drin']);
});

// Ein Undo, das an einem inzwischen von Hand geloeschten Artikel scheitert, waere
// die schlechtere Antwort: `removed` sagt, was tatsaechlich zurueckging.
test('undo-transfer: unbekannte IDs werden uebergangen, leerer Body ist kein Fehler', async () => {
  const empty = await call('POST', '/shopping/items/undo-transfer', {});
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, { removed: 0 });

  const list = await call('POST', '/shopping', { name: 'Teilweise' });
  const added = await call('POST', `/shopping/${list.body.data.id}/items`, { name: 'Butter' });
  const r = await call('POST', '/shopping/items/undo-transfer', { ids: [added.body.data.id, 999999, 'x'] });
  assert.equal(r.body.data.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE list_id = ?').get(list.body.data.id).n, 0);
});

// --------------------------------------------------------------------------
// Products in GET /pantry and the handover of a product without batches (#1448, step 2)
// --------------------------------------------------------------------------
test('GET /pantry: products names every household product with its batch count, also the one without batches', async () => {
  db.prepare('DELETE FROM pantry_items').run();
  db.prepare('DELETE FROM pantry_products').run();
  const cellar = db.prepare("SELECT id FROM pantry_locations WHERE name = 'Keller'").get().id;
  const fridge = db.prepare("SELECT id FROM pantry_locations WHERE name = 'Kühlschrank'").get().id;
  await call('POST', '/pantry', { name: 'Milch', quantity: 2, unit: 'l', location_id: cellar, category: 'Milchprodukte' });
  await call('POST', '/pantry', { name: 'milch ', quantity: 1, unit: 'l', location_id: fridge, category: 'Milchprodukte' });
  const tooth = await call('POST', '/pantry', { name: 'Zahnpasta', quantity: 1, category: 'Drogerie' });
  await call('DELETE', `/pantry/${tooth.body.data.id}`);

  const r = await call('GET', '/pantry');
  assert.equal(r.status, 200);
  // Additive: the batches, places and categories are still there.
  assert.equal(r.body.data.length, 2);
  assert.ok(Array.isArray(r.body.locations) && Array.isArray(r.body.categories));
  assert.deepEqual(
    r.body.products.map(({ name, unit, category, batch_count }) => ({ name, unit, category, batch_count })),
    [
      { name: 'Milch', unit: 'l', category: 'Milchprodukte', batch_count: 2 },
      { name: 'Zahnpasta', unit: 'pcs', category: 'Drogerie', batch_count: 0 },
    ],
  );
  const milk = r.body.products.find((p) => p.name === 'Milch');
  assert.ok(r.body.data.every((i) => i.product_id === milk.id), 'both batches point at the product listed');
});

test('import-pantry: a product without batches goes over by pantry_product_id, with its name and category and no quantity', async () => {
  const list = await call('POST', '/shopping', { name: 'Drogerie' });
  const listId = list.body.data.id;
  const tooth = db.prepare("SELECT id FROM pantry_products WHERE name = 'Zahnpasta'").get();
  const r = await call('POST', `/shopping/${listId}/import-pantry`, {
    // A quantity sent along is not taken: there is no stock to measure it against.
    items: [{ pantry_product_id: tooth.id, quantity: '3' }, { pantry_product_id: 999999 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.added, 1);
  assert.equal(r.body.data.skipped, 1, 'an unknown product is skipped like an unknown batch');
  const row = db.prepare('SELECT id, name, quantity, category FROM shopping_items WHERE list_id = ?').get(listId);
  assert.deepEqual({ name: row.name, quantity: row.quantity, category: row.category },
    { name: 'Zahnpasta', quantity: null, category: 'Drogerie' });
  assert.deepEqual(r.body.data.added_ids, [row.id]);

  // Same name unchecked on the list: skipped, as for a batch.
  const again = await call('POST', `/shopping/${listId}/import-pantry`, { items: [{ pantry_product_id: tooth.id }] });
  assert.deepEqual(again.body.data, { added: 0, skipped: 1, added_ids: [] });

  // pantry_item_id wins when both are sent: a batch entry keeps meaning the batch.
  const milkBatch = db.prepare("SELECT id FROM pantry_items WHERE location_id IS NOT NULL ORDER BY id LIMIT 1").get();
  const both = await call('POST', `/shopping/${listId}/import-pantry`, {
    items: [{ pantry_item_id: milkBatch.id, pantry_product_id: tooth.id, quantity: '1 l' }],
  });
  assert.equal(both.body.data.added, 1);
  assert.equal(db.prepare('SELECT quantity FROM shopping_items WHERE id = ?').get(both.body.data.added_ids[0]).quantity, '1 l');
  assert.equal(db.prepare('SELECT name FROM shopping_items WHERE id = ?').get(both.body.data.added_ids[0]).name, 'Milch');
});

// --------------------------------------------------------------------------
// Deleting a product without batches (#1448, brought forward from step 5;
// review of #2085, point 1)
// --------------------------------------------------------------------------
const productRow = (id) => db.prepare('SELECT id FROM pantry_products WHERE id = ?').get(id);
const batchesOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM pantry_items WHERE product_id = ?').get(id).n;

test('DELETE /pantry/products/:id: a product without batches goes, 204', async () => {
  const made = await call('POST', '/pantry', { name: 'Seife', quantity: 1 });
  const productId = made.body.data.product_id;
  await call('DELETE', `/pantry/${made.body.data.id}`);
  assert.ok(productRow(productId), 'the product outlives its last batch');

  const r = await call('DELETE', `/pantry/products/${productId}`);
  assert.equal(r.status, 204);
  assert.equal(productRow(productId), undefined, 'the product is gone');
  const list = await call('GET', '/pantry');
  assert.equal(list.body.products.some((p) => p.id === productId), false, 'and no longer listed');

  // Gone already: 404; not an id: 400.
  assert.equal((await call('DELETE', `/pantry/products/${productId}`)).status, 404);
  assert.equal((await call('DELETE', '/pantry/products/0')).status, 400);
  assert.equal((await call('DELETE', '/pantry/products/abc')).status, 400);
});

test('DELETE /pantry/products/:id: a product with batches is refused with 409 and a reason, nothing is deleted', async () => {
  const first = await call('POST', '/pantry', { name: 'Linsen', quantity: 2, unit: 'kg' });
  await call('POST', '/pantry', { name: 'linsen', quantity: 1, unit: 'kg', expires_on: '2027-01-01' });
  const productId = first.body.data.product_id;
  assert.equal(batchesOf(productId), 2);

  const r = await call('DELETE', `/pantry/products/${productId}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'pantry_product_has_batches', 'a stable reason for the client');
  assert.equal(r.body.count, 2);
  assert.ok(productRow(productId), 'the product stays');
  assert.equal(batchesOf(productId), 2, 'the ON DELETE CASCADE never takes the stock with it');
});

test('DELETE /pantry/products/:id: behind the pantry write permission, like the delete of a batch', async () => {
  const { sessionModuleAccessRequirement, tokenAccessRequirement } = await import('../server/scopes.js');
  const { moduleAccessVerdict, MODULE_ACCESS_READ_ONLY, MODULE_ACCESS_DENIED } = await import('../server/permissions.js');
  // Both gates in server/index.js ask these two functions, at the path below /api/v1.
  for (const ask of [sessionModuleAccessRequirement, tokenAccessRequirement]) {
    assert.deepEqual(ask('/pantry/products/5', 'DELETE'), ask('/pantry/5', 'DELETE'), 'the same requirement as a batch');
    assert.deepEqual(ask('/pantry/products/5', 'DELETE'), { moduleKey: 'pantry', access: 'write' });
  }

  // The session gate of server/index.js in front of the real router.
  let level = 'read';
  const gated = express();
  gated.use((req, res, next) => {
    req.authUserId = USER;
    req.session = { userId: USER, role: 'member' };
    const { moduleKey, access } = sessionModuleAccessRequirement(req.path, req.method);
    const verdict = moduleAccessVerdict({ pantry: level }, moduleKey, access);
    if (verdict === MODULE_ACCESS_DENIED) return res.status(403).json({ code: 403, reason: 'module_access_denied' });
    if (verdict === MODULE_ACCESS_READ_ONLY) return res.status(403).json({ code: 403, reason: 'module_read_only' });
    return next();
  });
  gated.use('/pantry', pantryRouter);
  const gatedServer = gated.listen(0, '127.0.0.1');
  await new Promise((r) => gatedServer.on('listening', r));
  try {
    const made = await call('POST', '/pantry', { name: 'Kerzen', quantity: 1 });
    const productId = made.body.data.product_id;
    await call('DELETE', `/pantry/${made.body.data.id}`);
    const url = `http://127.0.0.1:${gatedServer.address().port}/pantry/products/${productId}`;

    let r = await fetch(url, { method: 'DELETE' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).reason, 'module_read_only');
    assert.ok(productRow(productId), 'pantry: read deletes nothing');

    level = 'none';
    r = await fetch(url, { method: 'DELETE' });
    assert.equal(r.status, 403);
    assert.ok(productRow(productId));

    level = 'write';
    r = await fetch(url, { method: 'DELETE' });
    assert.equal(r.status, 204, 'with write access it goes');
    assert.equal(productRow(productId), undefined);
  } finally {
    gatedServer.close();
  }
});
