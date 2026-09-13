/**
 * Test: Shopping-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Shopping-Router - härtet die bislang komplett
 *        ungetestete Route-Schicht ab (test-shopping.js prüft nur Frontend-Source
 *        per Regex). Fokus: Validierung (400), Konflikte (409 Kategorie-Dubletten),
 *        Nicht-gefunden (404), Zustandsübergänge (Kategorie-Rename kaskadiert auf
 *        shopping_items, Delete-Fallback-Umzug, Letzte-Kategorie-Sperre, Reorder),
 *        Listen-/Artikel-CRUD inkl. Gang-Sortierung, sowie der Essensplan-Import
 *        (Aggregation, on_shopping_list-Markierung, Datumsbereich).
 *        Shopping ist haushaltsweit (kein owner/visibility) → kein Auth-Gate-Teil.
 * Ausführen: node --experimental-sqlite --test test/test-shopping-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;

let actor = { id: U, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', shoppingRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, body: json };
}

async function newList(name = 'Liste') {
  const r = await call('POST', '/', { name });
  return r.body.data.id;
}

// --------------------------------------------------------------------------
// Suggestions
// --------------------------------------------------------------------------
test('GET /suggestions: leere Query → leere Liste', async () => {
  const r = await call('GET', '/suggestions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

test('GET /suggestions: Präfix liefert distinct Namen', async () => {
  const list = await newList('Sugg');
  await call('POST', `/${list}/items`, { name: 'Bananen' });
  await call('POST', `/${list}/items`, { name: 'Bananen' }); // Duplikat → DISTINCT
  const r = await call('GET', '/suggestions?q=Ban');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, ['Bananen']);
});

// --------------------------------------------------------------------------
// Listen-CRUD
// --------------------------------------------------------------------------
test('POST /: leerer Name → 400', async () => {
  const r = await call('POST', '/', { name: '  ' });
  assert.equal(r.status, 400);
});

test('POST /: legt Liste an, created_by gesetzt', async () => {
  const r = await call('POST', '/', { name: 'REWE' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'REWE');
  const row = db.prepare('SELECT created_by FROM shopping_lists WHERE id = ?').get(r.body.data.id);
  assert.equal(row.created_by, U);
});

test('GET /: liefert Listen mit item_total/item_checked-Zählern', async () => {
  const list = await newList('Zähler');
  await call('POST', `/${list}/items`, { name: 'A' });
  const b = await call('POST', `/${list}/items`, { name: 'B' });
  await call('PATCH', `/items/${b.body.data.id}`, { is_checked: true });
  const r = await call('GET', '/');
  const found = r.body.data.find((l) => l.id === list);
  assert.equal(found.item_total, 2);
  assert.equal(found.item_checked, 1);
});

test('PUT /:listId: leerer Name → 400', async () => {
  const list = await newList();
  const r = await call('PUT', `/${list}`, { name: '' });
  assert.equal(r.status, 400);
});

test('PUT /:listId: unbekannte Liste → 404', async () => {
  const r = await call('PUT', '/999999', { name: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /:listId: benennt um', async () => {
  const list = await newList('Alt');
  const r = await call('PUT', `/${list}`, { name: 'Neu' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Neu');
});

test('DELETE /:listId: unbekannt → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:listId: löscht Liste + Artikel (CASCADE)', async () => {
  const list = await newList('Weg');
  await call('POST', `/${list}/items`, { name: 'X' });
  const r = await call('DELETE', `/${list}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE list_id = ?').get(list).c, 0);
});

// --------------------------------------------------------------------------
// Artikel unter einer Liste
// --------------------------------------------------------------------------
test('POST /:listId/items: unbekannte Liste → 404', async () => {
  const r = await call('POST', '/999999/items', { name: 'X' });
  assert.equal(r.status, 404);
});

test('POST /:listId/items: ungültige Kategorie → 400', async () => {
  const list = await newList();
  const r = await call('POST', `/${list}/items`, { name: 'X', category: 'Quatsch' });
  assert.equal(r.status, 400);
});

test('POST /:listId/items: Nicht-http(s)-URL → 400', async () => {
  const list = await newList();
  const r = await call('POST', `/${list}/items`, { name: 'X', url: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
});

test('POST /:listId/items: legt Artikel an, Default-Kategorie = erste', async () => {
  const list = await newList();
  const r = await call('POST', `/${list}/items`, { name: 'Milch', quantity: '1 l', url: 'https://example.com' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'Milch');
  assert.equal(r.body.data.category, 'Obst & Gemüse'); // sort_order 0
  assert.equal(r.body.data.url, 'https://example.com');
});

test('GET /:listId/items: unbekannte Liste → 404', async () => {
  const r = await call('GET', '/999999/items');
  assert.equal(r.status, 404);
});

test('GET /:listId/items: sortiert nach Kategorie-Gang, abgehakt ans Ende', async () => {
  const list = await newList('Sortiert');
  await call('POST', `/${list}/items`, { name: 'Joghurt', category: 'Milchprodukte' }); // sort 2
  await call('POST', `/${list}/items`, { name: 'Apfel', category: 'Obst & Gemüse' });    // sort 0
  const checked = await call('POST', `/${list}/items`, { name: 'Banane', category: 'Obst & Gemüse' });
  await call('PATCH', `/items/${checked.body.data.id}`, { is_checked: true });
  const r = await call('GET', `/${list}/items`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((i) => i.name), ['Apfel', 'Banane', 'Joghurt']);
  assert.equal(r.body.list.id, list);
  assert.ok(Array.isArray(r.body.categories));
});

test('PATCH /items/:itemId: unbekannt → 404', async () => {
  const r = await call('PATCH', '/items/999999', { name: 'X' });
  assert.equal(r.status, 404);
});

test('PATCH /items/:itemId: leerer Name → 400', async () => {
  const list = await newList();
  const item = (await call('POST', `/${list}/items`, { name: 'X' })).body.data;
  const r = await call('PATCH', `/items/${item.id}`, { name: '' });
  assert.equal(r.status, 400);
});

test('PATCH /items/:itemId: ungültige Kategorie → 400', async () => {
  const list = await newList();
  const item = (await call('POST', `/${list}/items`, { name: 'X' })).body.data;
  const r = await call('PATCH', `/items/${item.id}`, { category: 'Quatsch' });
  assert.equal(r.status, 400);
});

test('PATCH /items/:itemId: aktualisiert Felder + is_checked', async () => {
  const list = await newList();
  const item = (await call('POST', `/${list}/items`, { name: 'X' })).body.data;
  const r = await call('PATCH', `/items/${item.id}`, { name: 'Y', quantity: '2', category: 'Backwaren', is_checked: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.name, 'Y');
  assert.equal(r.body.data.category, 'Backwaren');
  assert.equal(r.body.data.is_checked, 1);
});

test('DELETE /items/:itemId: unbekannt → 404', async () => {
  const r = await call('DELETE', '/items/999999');
  assert.equal(r.status, 404);
});

test('DELETE /items/:itemId: löscht Artikel', async () => {
  const list = await newList();
  const item = (await call('POST', `/${list}/items`, { name: 'X' })).body.data;
  const r = await call('DELETE', `/items/${item.id}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE id = ?').get(item.id).c, 0);
});

// --------------------------------------------------------------------------
// Handsortierung innerhalb einer Kategorie (#678)
// --------------------------------------------------------------------------

/** Legt drei Artikel einer Kategorie an und gibt Liste + IDs zurück. */
async function seedOrderable(cat = 'Obst & Gemüse', names = ['A', 'B', 'C']) {
  const list = await newList('Sortierbar');
  const ids = [];
  for (const name of names) {
    ids.push((await call('POST', `/${list}/items`, { name, category: cat })).body.data.id);
  }
  return { list, ids };
}

const namesOf = (listId) => call('GET', `/${listId}/items`).then((r) => r.body.data.map((i) => i.name));

test('PATCH /:listId/items/reorder: setzt die Reihenfolge innerhalb der Kategorie', async () => {
  const { list, ids } = await seedOrderable();
  const r = await call('PATCH', `/${list}/items/reorder`, {
    category: 'Obst & Gemüse',
    order: [ids[2], ids[0], ids[1]],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((i) => i.name), ['C', 'A', 'B']);
  // Und dauerhaft: das nächste Laden zeigt dasselbe wie die Antwort.
  assert.deepEqual(await namesOf(list), ['C', 'A', 'B']);
});

test('PATCH /:listId/items/reorder: unbekannte Liste → 404', async () => {
  const r = await call('PATCH', '/999999/items/reorder', { category: 'Obst & Gemüse', order: [1] });
  assert.equal(r.status, 404);
});

test('PATCH /:listId/items/reorder: leeres/kein Array → 400', async () => {
  const { list } = await seedOrderable();
  assert.equal((await call('PATCH', `/${list}/items/reorder`, { category: 'Obst & Gemüse', order: [] })).status, 400);
  assert.equal((await call('PATCH', `/${list}/items/reorder`, { category: 'Obst & Gemüse' })).status, 400);
});

test('PATCH /:listId/items/reorder: fehlende oder ungültige Kategorie → 400', async () => {
  const { list, ids } = await seedOrderable();
  assert.equal((await call('PATCH', `/${list}/items/reorder`, { order: ids })).status, 400);
  assert.equal((await call('PATCH', `/${list}/items/reorder`, { category: 'Quatsch', order: ids })).status, 400);
});

test('PATCH /:listId/items/reorder: doppelte ID → 400', async () => {
  const { list, ids } = await seedOrderable();
  const r = await call('PATCH', `/${list}/items/reorder`, {
    category: 'Obst & Gemüse',
    order: [ids[0], ids[0], ids[1]],
  });
  assert.equal(r.status, 400);
});

test('PATCH /:listId/items/reorder: fremder Artikel → 400, ohne fremde Ränge zu berühren', async () => {
  const { list, ids } = await seedOrderable();
  const fremd = await seedOrderable('Backwaren', ['Brot']);
  const vorher = db.prepare('SELECT sort_order FROM shopping_items WHERE id = ?').get(fremd.ids[0]).sort_order;

  const r = await call('PATCH', `/${list}/items/reorder`, {
    category: 'Obst & Gemüse',
    order: [ids[0], ids[1], fremd.ids[0]],
  });
  assert.equal(r.status, 400);
  assert.equal(
    db.prepare('SELECT sort_order FROM shopping_items WHERE id = ?').get(fremd.ids[0]).sort_order,
    vorher,
  );
});

test('PATCH /:listId/items/reorder: Teilmenge der Kategorie → 400', async () => {
  const { list, ids } = await seedOrderable();
  // Zwei von drei: die neu vergebenen Ränge kollidierten sonst mit dem dritten.
  const r = await call('PATCH', `/${list}/items/reorder`, {
    category: 'Obst & Gemüse',
    order: [ids[1], ids[0]],
  });
  assert.equal(r.status, 400);
});

test('Neuer Artikel landet hinter den handsortierten seiner Kategorie', async () => {
  const { list, ids } = await seedOrderable();
  await call('PATCH', `/${list}/items/reorder`, { category: 'Obst & Gemüse', order: [ids[2], ids[0], ids[1]] });
  await call('POST', `/${list}/items`, { name: 'D', category: 'Obst & Gemüse' });
  assert.deepEqual(await namesOf(list), ['C', 'A', 'B', 'D']);
});

test('Auch ein direkter INSERT bekommt einen Rang (Trigger deckt alle Einfügewege ab)', async () => {
  const { list, ids } = await seedOrderable();
  await call('PATCH', `/${list}/items/reorder`, { category: 'Obst & Gemüse', order: [ids[2], ids[0], ids[1]] });

  // So fügen meals.js, recipes.js, housekeeping.js und der CalDAV-Sync ein:
  // an der Route vorbei, ohne sort_order. Ohne den Trigger stünde die Zeile mit
  // Rang 0 vor allem anderen - genau der Fehler, den die Spalte vermeiden soll.
  db.prepare(`INSERT INTO shopping_items (list_id, name, quantity, category)
              VALUES (?, 'Direkt', NULL, 'Obst & Gemüse')`).run(list);
  assert.deepEqual(await namesOf(list), ['C', 'A', 'B', 'Direkt']);
});

test('Kategoriewechsel stellt den Artikel ans Ende der neuen Kategorie', async () => {
  const { list, ids } = await seedOrderable();
  await call('POST', `/${list}/items`, { name: 'Brot', category: 'Backwaren' });
  await call('POST', `/${list}/items`, { name: 'Brezel', category: 'Backwaren' });

  // 'A' wandert zu den Backwaren: sein alter Rang 1 gilt dort nicht, sonst
  // stünde er vor Brot und Brezel.
  const r = await call('PATCH', `/items/${ids[0]}`, { category: 'Backwaren' });
  assert.equal(r.status, 200);
  assert.deepEqual(await namesOf(list), ['B', 'C', 'Brot', 'Brezel', 'A']);
});

test('Kategorie löschen: Umzügler landen hinter der Handsortierung des Ziels', async () => {
  const list = await newList('Umzug');

  // Eigene Wegwerf-Kategorie statt einer geseedeten: die Suite teilt sich eine
  // DB, und ein gelöschtes 'Backwaren' fehlte allen folgenden Tests.
  const weg = (await call('POST', '/categories', { name: 'Umzugskiste' })).body.data;

  // Das Ziel des Fallbacks ist die erste Kategorie nach sort_order.
  const ziel = (await call('GET', '/categories')).body.data[0].name;
  const zielIds = [];
  for (const name of ['Erstes', 'Zweites']) {
    zielIds.push((await call('POST', `/${list}/items`, { name, category: ziel })).body.data.id);
  }
  await call('PATCH', `/${list}/items/reorder`, { category: ziel, order: [zielIds[1], zielIds[0]] });

  const umzug = [];
  for (const name of ['Kiste A', 'Kiste B']) {
    umzug.push((await call('POST', `/${list}/items`, { name, category: 'Umzugskiste' })).body.data.id);
  }
  await call('PATCH', `/${list}/items/reorder`, { category: 'Umzugskiste', order: [umzug[1], umzug[0]] });

  assert.equal((await call('DELETE', `/categories/${weg.id}`)).status, 200);

  // Das Ziel behält seine Handsortierung, die Umzügler hängen sich in ihrer
  // eigenen dahinter - statt sich per Rang 1/2 davor zu drängen.
  assert.deepEqual(await namesOf(list), ['Zweites', 'Erstes', 'Kiste B', 'Kiste A']);
});

test('Abgehaktes bleibt am Ende der Kategorie, auch mit vorderem Rang', async () => {
  const { list, ids } = await seedOrderable();
  await call('PATCH', `/${list}/items/reorder`, { category: 'Obst & Gemüse', order: [ids[0], ids[1], ids[2]] });
  await call('PATCH', `/items/${ids[0]}`, { is_checked: true });
  // Rang 1, aber abgehakt: is_checked sortiert vor sort_order.
  assert.deepEqual(await namesOf(list), ['B', 'C', 'A']);
});

test('DELETE /:listId/items/checked: entfernt nur abgehakte, zählt', async () => {
  const list = await newList('Checked');
  const a = (await call('POST', `/${list}/items`, { name: 'A' })).body.data;
  await call('POST', `/${list}/items`, { name: 'B' });
  await call('PATCH', `/items/${a.id}`, { is_checked: true });
  const r = await call('DELETE', `/${list}/items/checked`);
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE list_id = ?').get(list).c, 1);
});

test('DELETE /:listId/items/checked mit { ids }: nur die genannten, davon nur abgehakte, nur aus dieser Liste', async () => {
  const list  = await newList('Checked-Ids');
  const other = await newList('Andere');
  const a = (await call('POST', `/${list}/items`,  { name: 'A' })).body.data;
  const b = (await call('POST', `/${list}/items`,  { name: 'B' })).body.data;
  const c = (await call('POST', `/${list}/items`,  { name: 'C' })).body.data;
  const x = (await call('POST', `/${other}/items`, { name: 'X' })).body.data;
  for (const item of [a, b, x]) await call('PATCH', `/items/${item.id}`, { is_checked: true });
  // B ist abgehakt, aber nicht genannt (jemand anderes, im Undo-Fenster).
  // C ist genannt, aber nicht abgehakt (zurueckgeholt). X gehoert einer anderen Liste.
  const r = await call('DELETE', `/${list}/items/checked`, { ids: [a.id, c.id, x.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 1, 'nur A: genannt, abgehakt, in dieser Liste');
  const names = (listId) => db.prepare('SELECT name FROM shopping_items WHERE list_id = ? ORDER BY name').all(listId).map((row) => row.name);
  assert.deepEqual(names(list), ['B', 'C']);
  assert.deepEqual(names(other), ['X'], 'eine fremde ID loescht nichts in der anderen Liste');
});

test('DELETE /:listId/items/checked: ein leeres oder unbrauchbares ids ist 400, kein "dann eben alle"', async () => {
  const list = await newList('Checked-400');
  const a = (await call('POST', `/${list}/items`, { name: 'A' })).body.data;
  await call('PATCH', `/items/${a.id}`, { is_checked: true });
  assert.equal((await call('DELETE', `/${list}/items/checked`, { ids: [] })).status, 400);
  assert.equal((await call('DELETE', `/${list}/items/checked`, { ids: ['a'] })).status, 400);
  assert.equal((await call('DELETE', `/${list}/items/checked`, { ids: [0] })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE list_id = ?').get(list).c, 1, 'nichts geloescht');
});

// --------------------------------------------------------------------------
// Essensplan-Import
// --------------------------------------------------------------------------
test('POST /:listId/import-meal-plan: unbekannte Liste → 404', async () => {
  const r = await call('POST', '/999999/import-meal-plan', { from: '2026-06-01', to: '2026-06-07' });
  assert.equal(r.status, 404);
});

test('POST /:listId/import-meal-plan: from > to → 400', async () => {
  const list = await newList();
  const r = await call('POST', `/${list}/import-meal-plan`, { from: '2026-06-07', to: '2026-06-01' });
  assert.equal(r.status, 400);
});

test('POST /:listId/import-meal-plan: leerer Bereich → transferred/added 0', async () => {
  const list = await newList();
  const r = await call('POST', `/${list}/import-meal-plan`, { from: '2030-01-01', to: '2030-01-07' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { transferred: 0, added: 0, meals: 0 });
});

test('POST /:listId/import-meal-plan: aggregiert + markiert on_shopping_list', async () => {
  const list = await newList('Import');
  const meal = db.prepare(`INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-06-10','lunch','M',?)`).run(U).lastInsertRowid;
  const insIng = db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?,?,?,?)`);
  insIng.run(meal, 'Milch', '1 l', 'Milchprodukte');
  insIng.run(meal, 'Milch', '1 l', 'Milchprodukte'); // gleicher Name+Menge → aggregiert
  insIng.run(meal, 'Brot', null, 'Backwaren');
  const r = await call('POST', `/${list}/import-meal-plan`, { from: '2026-06-08', to: '2026-06-14' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 3, 'alle drei Zutaten übertragen');
  assert.equal(r.body.data.added, 2, 'auf zwei Artikel aggregiert');
  assert.equal(r.body.data.meals, 1, 'Mahlzeiten-Zahl für die Vorschau-Copy');
  const milch = db.prepare(`SELECT quantity FROM shopping_items WHERE list_id = ? AND name = 'Milch'`).get(list);
  assert.equal(milch.quantity, '2 l', 'Mengen summiert');
  const open = db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0').get(meal).c;
  assert.equal(open, 0, 'Zutaten als übertragen markiert');
  // zweiter Import überträgt nichts mehr
  const r2 = await call('POST', `/${list}/import-meal-plan`, { from: '2026-06-08', to: '2026-06-14' });
  assert.deepEqual(r2.body.data, { transferred: 0, added: 0, meals: 0 });
});

test('POST /:listId/import-meal-plan: preview rechnet, ohne zu schreiben (Audit A1-22)', async () => {
  const list = await newList('Preview');
  const meal = db.prepare(`INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-07-01','dinner','P',?)`).run(U).lastInsertRowid;
  db.prepare(`INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?,?,?,?)`).run(meal, 'Reis', '500 g', 'Sonstiges');
  const r = await call('POST', `/${list}/import-meal-plan`, { from: '2026-07-01', to: '2026-07-01', preview: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { transferred: 1, added: 1, meals: 1, preview: true });
  const items = db.prepare('SELECT COUNT(*) c FROM shopping_items WHERE list_id = ?').get(list).c;
  assert.equal(items, 0, 'Vorschau legt keine Artikel an');
  const open = db.prepare('SELECT COUNT(*) c FROM meal_ingredients WHERE meal_id = ? AND on_shopping_list = 0').get(meal).c;
  assert.equal(open, 1, 'Zutat bleibt unmarkiert');
});

// --------------------------------------------------------------------------
// Kategorien
// --------------------------------------------------------------------------
test('GET /categories: liefert geseedete Kategorien sortiert', async () => {
  const r = await call('GET', '/categories');
  assert.equal(r.status, 200);
  assert.equal(r.body.data[0].name, 'Obst & Gemüse');
  assert.ok(r.body.data.length >= 9);
});

test('POST /categories: leerer Name → 400', async () => {
  const r = await call('POST', '/categories', { name: '' });
  assert.equal(r.status, 400);
});

test('POST /categories: Dublette (case-insensitive) → 409', async () => {
  const r = await call('POST', '/categories', { name: 'obst & gemüse' });
  assert.equal(r.status, 409);
});

test('POST /categories: legt Kategorie mit sort_order = max+1 an', async () => {
  const before = (await call('GET', '/categories')).body.data;
  const maxOrder = Math.max(...before.map((c) => c.sort_order));
  const r = await call('POST', '/categories', { name: 'Süßwaren' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.icon, 'tag');
  assert.equal(r.body.data.sort_order, maxOrder + 1);
});

test('PUT /categories/:catId: unbekannt → 404', async () => {
  const r = await call('PUT', '/categories/999999', { name: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /categories/:catId: Namenskonflikt → 409', async () => {
  const cat = (await call('POST', '/categories', { name: 'RenameKonflikt' })).body.data;
  const r = await call('PUT', `/categories/${cat.id}`, { name: 'Backwaren' });
  assert.equal(r.status, 409);
});

test('PUT /categories/:catId: Umbenennen kaskadiert auf shopping_items', async () => {
  const cat = (await call('POST', '/categories', { name: 'KaskKat' })).body.data;
  const list = await newList();
  await call('POST', `/${list}/items`, { name: 'Ware', category: 'KaskKat' });
  const r = await call('PUT', `/categories/${cat.id}`, { name: 'KaskKat2' });
  assert.equal(r.status, 200);
  const item = db.prepare(`SELECT category FROM shopping_items WHERE list_id = ? AND name = 'Ware'`).get(list);
  assert.equal(item.category, 'KaskKat2', 'Artikel-Kategorie mitumbenannt');
});

test('DELETE /categories/:catId: unbekannt → 404', async () => {
  const r = await call('DELETE', '/categories/999999');
  assert.equal(r.status, 404);
});

test('DELETE /categories/:catId: verschiebt Artikel auf Fallback + löscht', async () => {
  const cat = (await call('POST', '/categories', { name: 'DelKat' })).body.data;
  const list = await newList();
  await call('POST', `/${list}/items`, { name: 'DelWare', category: 'DelKat' });
  const r = await call('DELETE', `/categories/${cat.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shopping_categories WHERE id = ?').get(cat.id).c, 0);
  const item = db.prepare(`SELECT category FROM shopping_items WHERE list_id = ? AND name = 'DelWare'`).get(list);
  assert.equal(item.category, 'Obst & Gemüse', 'auf erste verbleibende Kategorie (sort_order) verschoben');
});

test('PATCH /categories/reorder: leeres/kein Array → 400', async () => {
  const r = await call('PATCH', '/categories/reorder', { order: [] });
  assert.equal(r.status, 400);
});

test('PATCH /categories/reorder: setzt sort_order gemäß Reihenfolge', async () => {
  const cats = (await call('GET', '/categories')).body.data;
  const reversed = cats.map((c) => c.id).reverse();
  const r = await call('PATCH', '/categories/reorder', { order: reversed });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((c) => c.id), reversed, 'neue Reihenfolge angewandt');
});

// --------------------------------------------------------------------------
// Letzte-Kategorie-Sperre (destruktiv → als Letztes, nichts danach)
// --------------------------------------------------------------------------
test('DELETE /categories/:catId: letzte Kategorie kann nicht gelöscht werden', async () => {
  let cats = (await call('GET', '/categories')).body.data;
  // bis auf eine herunterlöschen
  for (const c of cats.slice(1)) {
    await call('DELETE', `/categories/${c.id}`);
  }
  cats = (await call('GET', '/categories')).body.data;
  assert.equal(cats.length, 1, 'genau eine Kategorie übrig');
  const r = await call('DELETE', `/categories/${cats[0].id}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /last category/i);
});

test.after(() => server.close());

// --------------------------------------------------------
// Preis und Laden am Artikel (#1003, erster Schnitt)
// --------------------------------------------------------

test('POST /stores: derselbe Laden zweimal ist kein Fehler, sondern schon da', async () => {
  const erst = await call('POST', '/stores', { name: 'REWE' });
  assert.equal(erst.status, 201);
  const nochmal = await call('POST', '/stores', { name: 'rewe' });
  assert.equal(nochmal.status, 200, 'gleicher Name in anderer Schreibweise gibt die vorhandene Zeile');
  assert.equal(nochmal.body.data.id, erst.body.data.id);
});

test('PATCH /items: Preis in Cent und Laden werden gespeichert', async () => {
  const store = (await call('POST', '/stores', { name: 'Aldi' })).body.data;
  const list = (await call('POST', '/', { name: 'Preisliste' })).body.data;
  const item = (await call('POST', `/${list.id}/items`, { name: 'Butter' })).body.data;

  const r = await call('PATCH', `/items/${item.id}`, { is_checked: 1, price_cents: 249, store_id: store.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.price_cents, 249);
  assert.equal(r.body.data.store_id, store.id);
});

test('PATCH /items: ohne die Felder bleibt der Preis stehen, null loescht ihn', async () => {
  // Der wichtigere Fall ist der erste: ein Teil-Update, etwa das Umsortieren
  // oder ein neuer Name, darf einen bezahlten Preis nicht abraeumen.
  const list = (await call('POST', '/', { name: 'Preisliste 2' })).body.data;
  const item = (await call('POST', `/${list.id}/items`, { name: 'Milch' })).body.data;
  await call('PATCH', `/items/${item.id}`, { price_cents: 129 });

  const ohne = await call('PATCH', `/items/${item.id}`, { name: 'Milch 1,5%' });
  assert.equal(ohne.body.data.price_cents, 129, 'ohne Feld unveraendert');

  const leer = await call('PATCH', `/items/${item.id}`, { price_cents: null });
  assert.equal(leer.body.data.price_cents, null, 'null loescht');
});

test('PATCH /items: unsinniger Preis und unbekannter Laden werden abgelehnt', async () => {
  const list = (await call('POST', '/', { name: 'Preisliste 3' })).body.data;
  const item = (await call('POST', `/${list.id}/items`, { name: 'Brot' })).body.data;
  assert.equal((await call('PATCH', `/items/${item.id}`, { price_cents: -1 })).status, 400);
  assert.equal((await call('PATCH', `/items/${item.id}`, { price_cents: 1.5 })).status, 400);
  assert.equal((await call('PATCH', `/items/${item.id}`, { store_id: 999999 })).status, 400);
});

test('DELETE /stores/:id laesst den bezahlten Preis stehen', async () => {
  // Was einmal bezahlt wurde, bleibt wahr - auch wenn der Laden aus der
  // verwalteten Liste verschwindet. Der Fremdschluessel steht deshalb auf
  // SET NULL und nicht auf CASCADE.
  const store = (await call('POST', '/stores', { name: 'Tegut' })).body.data;
  const list = (await call('POST', '/', { name: 'Preisliste 4' })).body.data;
  const item = (await call('POST', `/${list.id}/items`, { name: 'Kaese' })).body.data;
  await call('PATCH', `/items/${item.id}`, { price_cents: 399, store_id: store.id });

  assert.equal((await call('DELETE', `/stores/${store.id}`)).status, 204);

  const nachher = (await call('GET', `/${list.id}/items`)).body.data.find((i) => i.id === item.id);
  assert.equal(nachher.price_cents, 399, 'der Preis bleibt');
  assert.equal(nachher.store_id, null, 'nur der Laden ist weg');
});
