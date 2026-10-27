/**
 * Test: Rezepte-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Recipes-Router - härtet die bislang komplett
 *        ungetestete Route-Schicht ab. Fokus: Validierung (400), Nicht-gefunden
 *        (404), kein Besitzer-Riegel bei PUT/DELETE (#1577: das Modulrecht
 *        genuegt, `meals: read` weist der Modul-Riegel ab - gemessen in
 *        test-recipe-transfer-gate.js), Zutaten-Regeln (leerer Name übersprungen, category-Default
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
// Der Einkaufs-Router hängt mit drin, weil die Rücknahme eines Transfers über
// ihn läuft (POST /shopping/items/undo-transfer) - ohne ihn wäre nur die halbe
// Handlung getestet.
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
// Der Planer traegt die Bildversion des Rezepts mit (#2048) - gemessen am echten
// Meals-Router, nicht an seinem SQL-Text.
const { default: mealsRouter } = await import('../server/routes/meals.js');
const recipeProviders = await import('../server/services/recipe-providers/index.js');
const db = dbmod.get();

const OWNER = db.prepare(`INSERT INTO users (username, display_name, avatar_color, password_hash, role) VALUES ('owner','Owner','#112233','x','member')`).run().lastInsertRowid;
const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const MEMBER2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member2','Member Zwei','x','member')`).run().lastInsertRowid;

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
app.use('/shopping', shoppingRouter);
app.use('/meals', mealsRouter);
// Derselbe Router noch einmal unter seinem echten Pfad: die MCP-Bruecke ruft
// `/api/v1/recipes` per Loopback auf (#2197), und genau diesen Weg nimmt der
// Test am Ende dieser Datei.
app.use('/api/v1/recipes', recipesRouter);
app.use('/', recipesRouter);
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
  assert.match(r.body.error, /^title /);
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

// #1577 (Entscheidung 30.09.2026): Rezepte gehoeren dem Haushalt. Wer das
// Modul schreiben darf, bearbeitet jedes Rezept - kein Besitzer-Riegel, und
// ausdruecklich auch fuer ein Mitglied ohne Admin-Rolle, denn die Regel ist
// das Modulrecht, nicht die Rolle. `meals: read` weist der Modul-Riegel in
// server/index.js ab (test-recipe-transfer-gate.js, echte Gates).
for (const who of [{ id: MEMBER2, role: 'member', label: 'anderes Mitglied' }, { id: ADMIN, role: 'admin', label: 'Admin' }]) {
  test(`PUT /:id: ${who.label} bearbeitet ein fremdes Rezept samt Zutaten (#1577)`, async () => {
    const own = await call('POST', '/', { title: 'Owners Rezept', notes: 'alt', ingredients: [{ name: 'Mehl' }] });
    const id = own.body.data.id;
    actor = { id: who.id, role: who.role };
    const r = await call('PUT', `/${id}`, { title: 'Verbessert', notes: 'neu', ingredients: [{ name: 'Dinkelmehl' }] });
    actor = { id: OWNER, role: 'member' };
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = db.prepare('SELECT title, notes, created_by FROM recipes WHERE id = ?').get(id);
    assert.equal(row.title, 'Verbessert');
    assert.equal(row.notes, 'neu');
    assert.equal(row.created_by, OWNER, 'wer es angelegt hat, bleibt stehen');
    assert.deepEqual(ingredientRows(id).map((x) => x.name), ['Dinkelmehl']);
  });
}

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

for (const who of [{ id: MEMBER2, role: 'member', label: 'anderes Mitglied' }, { id: ADMIN, role: 'admin', label: 'Admin' }]) {
  test(`DELETE /:id: ${who.label} löscht ein fremdes Rezept → 204 (#1577)`, async () => {
    const own = await call('POST', '/', { title: 'Fremd gelöscht', ingredients: [{ name: 'Z' }] });
    const id = own.body.data.id;
    actor = { id: who.id, role: who.role };
    const r = await call('DELETE', `/${id}`);
    actor = { id: OWNER, role: 'member' };
    assert.equal(r.status, 204);
    assert.equal(db.prepare('SELECT id FROM recipes WHERE id = ?').get(id), undefined);
    assert.equal(ingredientRows(id).length, 0);
  });
}

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

// --------------------------------------------------------------------------
// POST /:id/to-shopping-list (Zutaten → Einkaufsliste)
// --------------------------------------------------------------------------

function shoppingItems(listId) {
  return db.prepare('SELECT name, quantity, category, is_checked FROM shopping_items WHERE list_id = ? ORDER BY id ASC').all(listId);
}

function newList(name) {
  return db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, OWNER).lastInsertRowid;
}

test('POST /:id/to-shopping-list: überträgt Zutaten mit Menge und Kategorie', async () => {
  const listId = newList('Transfer A');
  const created = await call('POST', '/', {
    title: 'Transfer-Rezept',
    ingredients: [
      { name: 'Mehl', quantity: '500 g', category: 'Backen' },
      { name: 'Milch', quantity: '1 l' },
    ],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });

  assert.equal(r.status, 200);
  assert.deepEqual({ transferred: r.body.data.transferred, skipped: r.body.data.skipped }, { transferred: 2, skipped: 0 });
  assert.deepEqual(r.body.data.added_ids.length, 2);
  const items = shoppingItems(listId);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Mehl');
  assert.equal(items[0].quantity, '500 g');
  assert.equal(items[0].category, 'Backen');
  assert.equal(items[1].category, 'Sonstiges'); // Default greift
});

test('POST /:id/to-shopping-list: überspringt, was unabgehakt schon auf der Liste liegt', async () => {
  const listId = newList('Transfer B');
  const created = await call('POST', '/', {
    title: 'Doppelt',
    ingredients: [{ name: 'Butter' }, { name: 'Eier' }],
  });
  const id = created.body.data.id;

  const first = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.equal(first.body.data.transferred, 2);

  // Zweiter Lauf darf die Liste nicht verdoppeln - ein Rezept ist eine Vorlage,
  // die mehrfach gekocht wird, und trägt kein „schon übertragen"-Flag.
  const second = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.deepEqual(second.body.data, { transferred: 0, skipped: 2, added_ids: [] });
  assert.equal(shoppingItems(listId).length, 2);
});

test('POST /:id/to-shopping-list: abgehakte Artikel blockieren die Übernahme nicht', async () => {
  const listId = newList('Transfer C');
  const created = await call('POST', '/', { title: 'Nachkauf', ingredients: [{ name: 'Salz' }] });
  const id = created.body.data.id;

  await call('POST', `/${id}/to-shopping-list`, { listId });
  db.prepare('UPDATE shopping_items SET is_checked = 1 WHERE list_id = ?').run(listId);

  // Bereits gekauft und abgehakt → beim nächsten Kochen wieder aufnehmen.
  const again = await call('POST', `/${id}/to-shopping-list`, { listId });
  assert.equal(again.body.data.transferred, 1);
  assert.equal(shoppingItems(listId).length, 2);
});

// R23 (D2): die Regel der ganzen Kueche normalisiert wie ingredientMatchKey -
// Raender, Leerraum und Gross-/Kleinschreibung auch jenseits von ASCII.
test('POST /:id/to-shopping-list: "ÖL" auf der Liste deckt " öl " im Rezept (D2)', async () => {
  const listId = newList('Transfer Unicode');
  db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'ÖL');
  const created = await call('POST', '/', {
    title: 'Unicode', ingredients: [{ name: ' öl ' }, { name: 'Brot  dunkel' }, { name: 'brot dunkel', quantity: '1' }],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.body.data.transferred, 1, 'zweimal Brot im Rezept ist EINE Zeile');
  assert.equal(r.body.data.skipped, 1, 'nur das Öl stand schon da');
  assert.deepEqual(shoppingItems(listId).map((i) => i.name), ['ÖL', 'Brot  dunkel']);
});

test('POST /:id/to-shopping-list: Rezept ohne Zutaten → 0/0 statt Fehler', async () => {
  const listId = newList('Transfer D');
  const created = await call('POST', '/', { title: 'Leer', ingredients: [] });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { transferred: 0, skipped: 0, added_ids: [] });
});

test('POST /:id/to-shopping-list: fehlende oder unbekannte Liste → 400/404', async () => {
  const created = await call('POST', '/', { title: 'Ziel', ingredients: [{ name: 'X' }] });
  const id = created.body.data.id;

  const noList = await call('POST', `/${id}/to-shopping-list`, {});
  assert.equal(noList.status, 400);

  const badList = await call('POST', `/${id}/to-shopping-list`, { listId: 999999 });
  assert.equal(badList.status, 404);
});

test('POST /:id/to-shopping-list: unbekanntes Rezept → 404', async () => {
  const listId = newList('Transfer E');
  const r = await call('POST', '/999999/to-shopping-list', { listId });
  assert.equal(r.status, 404);
});

test('POST /:id/to-shopping-list: Nicht-Eigentümer darf übernehmen (kein owner-Gate)', async () => {
  const listId = newList('Transfer F');
  const created = await call('POST', '/', { title: 'Geteilt', ingredients: [{ name: 'Reis' }] });
  const id = created.body.data.id;

  // Rezepte sind Haushaltswissen: wer kocht, darf einkaufen - wie bei
  // PUT/DELETE gibt es keinen Besitzer-Riegel (#1577).
  actor = { id: ADMIN, role: 'admin' };
  const r = await call('POST', `/${id}/to-shopping-list`, { listId });
  actor = { id: OWNER, role: 'member' };
  assert.equal(r.status, 200);
  assert.equal(r.body.data.transferred, 1);
});

// Der Rezept-Transfer ist der Pfad, der am meisten auf einmal ueberträgt - eine
// ganze Zutatenliste, in eine Liste, die der Nutzer gerade nicht ansieht. Ohne
// added_ids gaebe es nichts zurueckzunehmen (Audit 2026-07-30, P1-B).
test('POST /:id/to-shopping-list: added_ids erlauben ein exaktes Zuruecknehmen', async () => {
  const listId = newList('Transfer Undo');
  db.prepare('INSERT INTO shopping_items (list_id, name) VALUES (?, ?)').run(listId, 'Bleibt drin');

  const created = await call('POST', '/', {
    title: 'Ruecknahme',
    ingredients: [{ name: 'Zwiebel' }, { name: 'Knoblauch' }],
  });
  const r = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(r.body.data.transferred, 2);
  assert.equal(r.body.data.added_ids.length, 2);

  const undo = await call('POST', '/shopping/items/undo-transfer', { ids: r.body.data.added_ids });
  assert.equal(undo.body.data.removed, 2);
  assert.deepEqual(shoppingItems(listId).map((i) => i.name), ['Bleibt drin']);

  // Ein Rezept ist eine Vorlage: nach der Ruecknahme laesst es sich erneut
  // uebertragen, weil am Rezept nichts markiert wird.
  const again = await call('POST', `/${created.body.data.id}/to-shopping-list`, { listId });
  assert.equal(again.body.data.transferred, 2);
});

// --------------------------------------------------------------------------
// Recipe-Provider-Mirror: source-Feld, PUT/DELETE-Gate für gespiegelte Rezepte,
// GET /:id/provider-thumbnail. Läuft einmal je unterstütztem Provider (mealie,
// tandoor), um zu belegen, dass der generalisierte Code-Pfad nicht heimlich
// noch Mealie-spezifisch ist.
// --------------------------------------------------------------------------

// Ein Account je Provider reicht für alle Tests (base_url ist UNIQUE); jedes
// Rezept braucht nur eine eigene provider_recipe_id, um den Partial-Unique-Index
// (provider_account_id, provider_recipe_id) nicht zu verletzen.
const PROVIDER_ACCOUNTS = {
  mealie: {
    name: 'Testkonto',
    id: db.prepare(`
      INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES ('Testkonto', 'https://mealie.example.com', 'tok', 'mealie', ?)
    `).run(OWNER).lastInsertRowid,
  },
  tandoor: {
    name: 'Tandoor-Testkonto',
    id: db.prepare(`
      INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES ('Tandoor-Testkonto', 'https://tandoor.example.com', 'tok', 'tandoor', ?)
    `).run(OWNER).lastInsertRowid,
  },
};

function mirroredRecipe(title, providerRecipeId, provider = 'mealie') {
  const accountId = PROVIDER_ACCOUNTS[provider].id;
  const recipeId = db.prepare(`
    INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id) VALUES (?, ?, ?, ?)
  `).run(title, OWNER, accountId, providerRecipeId).lastInsertRowid;
  return { accountId, recipeId, provider };
}

test.after(() => recipeProviders._setAdapterFactory(null));

test('GET /:id/provider-thumbnail: natives Rezept → 404', async () => {
  const native = await call('POST', '/', { title: 'Kein Provider' });
  const r = await call('GET', `/${native.body.data.id}/provider-thumbnail`);
  assert.equal(r.status, 404);
});

function registerMirrorTests(provider) {
  const { name: accountName, id: accountId } = PROVIDER_ACCOUNTS[provider];

  test(`GET /: native Rezept trägt source "native", gespiegeltes trägt "${provider}" + Account-Name`, async () => {
    const native = await call('POST', '/', { title: 'Eigenes Rezept' });
    const { recipeId } = mirroredRecipe(`${provider}-Rezept`, `mirror-source-test-${provider}`, provider);

    const r = await call('GET', '/');
    const nativeRow = r.body.data.find((x) => x.id === native.body.data.id);
    const mirroredRow = r.body.data.find((x) => x.id === recipeId);

    assert.equal(nativeRow.source, 'native');
    assert.equal(mirroredRow.source, provider);
    assert.equal(mirroredRow.provider_account_name, accountName);
  });

  test(`PUT /:id: gespiegeltes Rezept (${provider}) → 403, auch für den Nutzer, der den Account angelegt hat`, async () => {
    const { recipeId } = mirroredRecipe('Unveränderlich', `mirror-put-test-${provider}`, provider);
    // OWNER ist zugleich created_by dieses Mirror-Rezepts (via recipe_provider_accounts.created_by),
    // MEMBER2 ist es nicht - seit #1577 gibt es keinen Besitzer-Riegel mehr, also
    // muss das provider_account_id-Gate fuer beide allein greifen.
    const r = await call('PUT', `/${recipeId}`, { title: 'Gehackt' });
    assert.equal(r.status, 403);
    actor = { id: MEMBER2, role: 'member' };
    const r2 = await call('PUT', `/${recipeId}`, { title: 'Gehackt' });
    actor = { id: OWNER, role: 'member' };
    assert.equal(r2.status, 403);
    assert.match(r2.body.error, /Mirrored/);
    const row = db.prepare('SELECT title FROM recipes WHERE id = ?').get(recipeId);
    assert.equal(row.title, 'Unveränderlich');
  });

  test(`DELETE /:id: gespiegeltes Rezept (${provider}) → 403`, async () => {
    const { recipeId } = mirroredRecipe('Unlöschbar', `mirror-delete-test-${provider}`, provider);
    const r = await call('DELETE', `/${recipeId}`);
    assert.equal(r.status, 403);
    actor = { id: MEMBER2, role: 'member' };
    const r2 = await call('DELETE', `/${recipeId}`);
    actor = { id: OWNER, role: 'member' };
    assert.equal(r2.status, 403);
    assert.match(r2.body.error, /Mirrored/);
    assert.ok(db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId));
  });

  test(`POST /:id/to-shopping-list: funktioniert unverändert für gespiegelte Rezepte (${provider})`, async () => {
    const listId = newList(`Transfer ${provider}`);
    const { recipeId } = mirroredRecipe(`${provider}-Transfer`, `mirror-shopping-test-${provider}`, provider);
    db.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, 'Reis', '1 kg', 'Sonstiges')`).run(recipeId);

    const r = await call('POST', `/${recipeId}/to-shopping-list`, { listId });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.transferred, 1);
    assert.equal(r.body.data.added_ids.length, 1);
  });

  test(`GET /:id/provider-thumbnail: gespiegelt (${provider}), aber provider_has_image=0 → 404, Adapter wird nicht aufgerufen`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 0)
    `).run('Ohne Bild', OWNER, accountId, `thumb-none-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 404);
  });

  test(`GET /:id/provider-thumbnail: proxied Bytes und Content-Type vom Fake-Adapter (${provider})`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_slug, provider_has_image) VALUES (?, ?, ?, ?, ?, 1)
    `).run('Mit Bild', OWNER, accountId, `thumb-yes-${provider}`, `slug-yes-${provider}`).lastInsertRowid;

    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async ({ id, slug }) => {
        assert.equal(id, `thumb-yes-${provider}`);
        assert.equal(slug, `slug-yes-${provider}`);
        return { buffer: png1x1, mime: 'image/png' };
      },
    }));

    const res = await fetch(`${baseUrl}/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    // Ohne provider_updated_at keine Version, also kein Cache - wie vor #2048.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, png1x1.length);
  });

  // #2048: 500 gespiegelte Rezepte waren bei jedem Oeffnen der Liste 500
  // Live-Abrufe beim Provider, alle `no-store`. Mit der Version aus der Zeile
  // darf der Browser das Bild behalten, und eine Nachfrage kostet den Provider
  // nichts.
  test(`GET /:id/provider-thumbnail: revalidierbar mit ?v=<provider_updated_at>, nie max-age, 304 ohne Provider-Abruf (${provider}, #2048)`, async () => {
    const updatedAt = '2026-10-01T08:15:30.123456';
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_slug, provider_has_image, provider_updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run('Versioniert', OWNER, accountId, `thumb-v-${provider}`, `slug-v-${provider}`, updatedAt).lastInsertRowid;
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    let upstream = 0;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { upstream += 1; return { buffer: png1x1, mime: 'image/png' }; },
    }));
    try {
      // Die Liste nennt genau diesen Wert - die Oberflaeche baut daraus ?v=.
      const list = await call('GET', '/');
      assert.equal(list.body.data.find((x) => x.id === recipeId).provider_updated_at, updatedAt);

      const url = `${baseUrl}/${recipeId}/provider-thumbnail?v=${encodeURIComponent(updatedAt)}`;
      const first = await fetch(url);
      assert.equal(first.status, 200);
      // NIE max-age (Codex-Review zu #2067): ein Bild aus dem HTTP-Cache kaeme
      // nach dem Abmelden oder einem Kontowechsel ohne Auth- und Modul-Gate.
      // Jede Nutzung fragt nach, die Nachfrage ist das 304 unten.
      assert.equal(first.headers.get('cache-control'), 'private, no-cache');
      const etag = first.headers.get('etag');
      assert.match(etag ?? '', /^"[0-9a-f]{32}"$/);
      assert.equal(upstream, 1);

      const again = await fetch(url, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304);
      assert.equal(again.headers.get('cache-control'), 'private, no-cache');
      assert.equal(upstream, 1, 'die Nachfrage beantwortet die Route, ohne den Provider zu fragen');

      // Ohne oder mit alter Version: dieselbe Antwort.
      for (const stale of ['', '?v=2020-01-01']) {
        const r = await fetch(`${baseUrl}/${recipeId}/provider-thumbnail${stale}`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'private, no-cache');
        assert.equal(r.headers.get('etag'), etag);
      }

      // Neuer Sync, neue Version: das alte ETag passt nicht mehr.
      db.prepare('UPDATE recipes SET provider_updated_at = ? WHERE id = ?').run('2026-10-02T09:00:00', recipeId);
      const changed = await fetch(url, { headers: { 'If-None-Match': etag } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.get('etag'), etag);
    } finally {
      recipeProviders._setAdapterFactory(null);
    }
  });

  test(`GET /:id/provider-thumbnail: Fehler bleiben no-store, auch mit passender Version (${provider}, #2048)`, async () => {
    const updatedAt = '2026-10-03T10:00:00';
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image, provider_updated_at) VALUES (?, ?, ?, ?, 1, ?)
    `).run('Kaputt', OWNER, accountId, `thumb-err-${provider}`, updatedAt).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { throw new Error('upstream down'); },
    }));
    try {
      const r = await fetch(`${baseUrl}/${recipeId}/provider-thumbnail?v=${encodeURIComponent(updatedAt)}`);
      assert.equal(r.status, 502);
      assert.doesNotMatch(r.headers.get('cache-control') ?? '', /max-age|immutable/);
      // Express haengt an jede JSON-Antwort ein schwaches ETag; das Versions-
      // ETag der Route darf ein Fehler nie tragen.
      assert.doesNotMatch(r.headers.get('etag') ?? '', /^"[0-9a-f]{32}"$/);
    } finally {
      recipeProviders._setAdapterFactory(null);
    }
  });

  test(`GET /:id/provider-thumbnail: Bild seit letztem Sync beim Provider gelöscht (404 vom Adapter, ${provider}) → 404 statt 500`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 1)
    `).run('Geloescht', OWNER, accountId, `thumb-gone-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => { const err = new Error('Thumbnail request failed (404)'); err.status = 404; throw err; },
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 404);
  });

  test(`GET /:id/provider-thumbnail: nicht in der MIME-Allowlist (z. B. SVG, ${provider}) → 415`, async () => {
    const recipeId = db.prepare(`
      INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image) VALUES (?, ?, ?, ?, 1)
    `).run('SVG', OWNER, accountId, `thumb-svg-${provider}`).lastInsertRowid;
    recipeProviders._setAdapterFactory(() => ({
      fetchThumbnail: async () => ({ buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' }),
    }));
    const r = await call('GET', `/${recipeId}/provider-thumbnail`);
    recipeProviders._setAdapterFactory(null);
    assert.equal(r.status, 415);
  });
}

registerMirrorTests('mealie');
registerMirrorTests('tandoor');

test('GET /meals: eine Mahlzeit aus einem gespiegelten Rezept traegt recipe_image_version (#2048)', async () => {
  const updatedAt = '2026-10-04T12:00:00';
  const recipeId = db.prepare(`
    INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_has_image, provider_updated_at) VALUES (?, ?, ?, ?, 1, ?)
  `).run('Im Planer', OWNER, PROVIDER_ACCOUNTS.mealie.id, 'planner-version', updatedAt).lastInsertRowid;
  const mealId = db.prepare(`
    INSERT INTO meals (date, meal_type, title, recipe_id, created_by) VALUES ('2026-10-05', 'dinner', 'Im Planer', ?, ?)
  `).run(recipeId, OWNER).lastInsertRowid;
  const r = await call('GET', '/meals?week=2026-10-05');
  assert.equal(r.status, 200);
  const meal = r.body.data.find((m) => m.id === mealId);
  assert.ok(meal, 'die Mahlzeit steht in der Woche');
  assert.equal(meal.recipe_has_image, 1);
  assert.equal(meal.recipe_image_version, updatedAt);
});

// --------------------------------------------------------------------------
// #750: Eine leere Auswahl ist eine Antwort, keine Lücke. Vorher machte die
// Normalisierung daraus stillschweigend alle vier Mahlzeiten - sichtbar erst,
// wenn der Nutzer das Rezept wieder zum Bearbeiten öffnete.
// --------------------------------------------------------------------------

test('POST /: eine leere meal_types-Liste bleibt leer (#750)', async () => {
  const r = await call('POST', '/', { title: 'Grundbrühe', meal_types: [] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.meal_types, [], 'die Abwahl darf nicht in alle vier umschlagen');
  const row = db.prepare('SELECT meal_types FROM recipes WHERE id = ?').get(r.body.data.id);
  assert.equal(row.meal_types, '', 'in der Spalte steht der leere Wert, nicht die volle Liste');
});

test('PUT /:id: die leere Auswahl übersteht das erneute Öffnen (#750)', async () => {
  // Der gemeldete Ablauf: anlegen, alle Haken entfernen, speichern, wieder
  // öffnen. Genau hier standen vorher wieder alle vier Haken.
  const created = await call('POST', '/', { title: 'Fond', meal_types: ['dinner'] });
  const id = created.body.data.id;

  const cleared = await call('PUT', `/${id}`, { title: 'Fond', meal_types: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.meal_types, []);

  // Das Formular befüllt sich aus der Liste (ein GET /:id gibt es nicht), also
  // muss der leere Stand genau dort ankommen - das war die Stelle, an der
  // vorher wieder alle vier Haken standen.
  const list = await call('GET', '/');
  const reopened = list.body.data.find((x) => x.id === id);
  assert.deepEqual(reopened.meal_types, []);
});

test('PUT /:id: ein Teil-Update ohne meal_types lässt die Auswahl stehen (#750)', async () => {
  // Sonst nähme jeder Aufruf, der das Feld nicht mitschickt, die bewusst leere
  // Auswahl wieder mit - die Nachbar-Falle des eigentlichen Fehlers.
  const created = await call('POST', '/', { title: 'Sud', meal_types: [] });
  const id = created.body.data.id;

  const renamed = await call('PUT', `/${id}`, { title: 'Sud, verfeinert' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.data.meal_types, []);

  const kept = db.prepare('SELECT title, meal_types FROM recipes WHERE id = ?').get(id);
  assert.equal(kept.title, 'Sud, verfeinert');
  assert.equal(kept.meal_types, '');
});

// --------------------------------------------------------
// Eigenes Rezeptbild (#1059, Schritt 2)
// --------------------------------------------------------

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('POST /recipes: ein eigenes Bild wird gespeichert, aber nie mitgeliefert', async () => {
  const r = await call('POST', '/', { title: 'Mit Bild', image_data: PNG_1X1 });
  assert.equal(r.status, 201);
  // DIE DATEN SELBST GEHEN NIE MIT: eine Data-URL von bis zu 5 MB in jeder
  // Listenzeile waere ein Vielfaches der Antwort, fuer eine 32px-Vorschau.
  assert.equal(r.body.data.image_data, undefined, 'image_data darf nicht in der Antwort stehen');
  assert.equal(r.body.data.has_own_image, true, 'das Flag sagt, dass es eins gibt');
});

test('GET /recipes: die Liste traegt das Flag, nicht das Bild', async () => {
  const r = await call('GET', '/');
  const mitBild = r.body.data.find((x) => x.title === 'Mit Bild');
  assert.ok(mitBild, 'das Rezept muss in der Liste stehen');
  assert.equal(mitBild.image_data, undefined);
  assert.equal(mitBild.has_own_image, true);
});

test('GET /recipes/:id/image liefert das Bild als Datei', async () => {
  const created = await call('POST', '/', { title: 'Bildabruf', image_data: PNG_1X1 });
  const res = await fetch(`${baseUrl}/${created.body.data.id}/image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // Das Bild steht im Browser-Cache sonst bis zu einer Stunde - auch nach dem Abmelden.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, 'die Datei darf nicht leer sein');
});

test('GET /recipes/:id/image: ohne Bild 404', async () => {
  const ohne = await call('POST', '/', { title: 'Ohne Bild' });
  assert.equal(ohne.body.data.has_own_image, false);
  const res = await fetch(`${baseUrl}/${ohne.body.data.id}/image`);
  assert.equal(res.status, 404);
});

test('PUT /recipes: ohne das Feld bleibt das Bild stehen, null loescht es', async () => {
  // Der wichtigere Fall ist der erste: ein Speichern, das nur den Titel aendert,
  // darf das Bild nicht stillschweigend abraeumen - und es auch nicht erneut
  // hochladen muessen.
  const created = await call('POST', '/', { title: 'Bleibt', image_data: PNG_1X1 });
  const id = created.body.data.id;

  const ohneFeld = await call('PUT', `/${id}`, { title: 'Bleibt, neuer Titel' });
  assert.equal(ohneFeld.body.data.has_own_image, true, 'ohne Feld unveraendert');

  const geloescht = await call('PUT', `/${id}`, { title: 'Bleibt', image_data: null });
  assert.equal(geloescht.body.data.has_own_image, false, 'null loescht');
  assert.equal((await fetch(`${baseUrl}/${id}/image`)).status, 404);
});

test('POST /recipes: ein Bild, dessen Inhalt nicht zum Typ passt -> 400', async () => {
  // Der Praefix kommt aus dem Browser des Absenders (#937); geprueft wird der
  // Inhalt. Hier steht ein PNG-Rumpf unter einer JPEG-Deklaration.
  const gelogen = PNG_1X1.replace('image/png', 'image/jpeg');
  const r = await call('POST', '/', { title: 'Gelogen', image_data: gelogen });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Ohne Body (#2197): Express 5 laesst `req.body` undefined, wenn eine Anfrage
// keinen JSON-Body traegt. Jede Schreibroute las daraus unbesehen und
// antwortete mit 500 "Internal error" statt mit ihrer eigenen Validierung.
// --------------------------------------------------------------------------
test('POST /: ohne Body → 400 mit der Titel-Meldung, nicht 500 (#2197)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const r = await call('POST', '/');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /title is required/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, before);
});

test('PUT /:id: ohne Body → 400, das Rezept bleibt unveraendert (#2197)', async () => {
  const created = await call('POST', '/', { title: 'OhneBody', ingredients: [{ name: 'Bleibt' }] });
  const id = created.body.data.id;
  const r = await call('PUT', `/${id}`);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /title is required/);
  assert.deepEqual(ingredientRows(id).map((x) => x.name), ['Bleibt']);
});

test('POST /:id/to-shopping-list und PUT /:id/ingredient-match: ohne Body → 400 (#2197)', async () => {
  const created = await call('POST', '/', { title: 'OhneBodyZiel', ingredients: [{ name: 'Mehl' }] });
  const id = created.body.data.id;
  const transfer = await call('POST', `/${id}/to-shopping-list`);
  assert.equal(transfer.status, 400, JSON.stringify(transfer.body));
  const match = await call('PUT', `/${id}/ingredient-match`);
  assert.equal(match.status, 400, JSON.stringify(match.body));
});

test('POST / und PUT /:id: Zutaten, die keine Liste sind → 400, nichts geschrieben (#2197)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const post = await call('POST', '/', { title: 'Zutatenobjekt', ingredients: { name: 'Mehl' } });
  assert.equal(post.status, 400, JSON.stringify(post.body));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, before);

  const created = await call('POST', '/', { title: 'ZutatenBleiben', ingredients: [{ name: 'Salz' }] });
  const id = created.body.data.id;
  const put = await call('PUT', `/${id}`, { title: 'ZutatenBleiben', ingredients: { name: 'Mehl' } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  assert.deepEqual(ingredientRows(id).map((x) => x.name), ['Salz']);

  const nullItem = await call('POST', '/', { title: 'NullZutat', ingredients: [null, { name: 'Zucker' }] });
  assert.equal(nullItem.status, 201, JSON.stringify(nullItem.body));
  assert.deepEqual(ingredientRows(nullItem.body.data.id).map((x) => x.name), ['Zucker']);
});

// --------------------------------------------------------------------------
// Ueber die MCP-Bruecke (#2197): `call_api_operation` geht per Loopback an
// genau diesen Router. Ein Assistent, der die Rezeptfelder neben
// `operation_key` statt in `payload` legt, schickte einen POST ohne Body und
// bekam "Internal error". Termine, Einkauf und Aufgaben haben eigene
// MCP-Werkzeuge mit flachen Argumenten, Rezepte nur die Bruecke - deshalb traf
// es nur sie.
// --------------------------------------------------------------------------
test('MCP call_api_operation post_recipes: Felder neben payload → klare Meldung, kein Request (#2197)', async () => {
  const { callTool } = await import('../server/mcp/tools.js');
  const previous = process.env.MCP_INTERNAL_BASE_URL;
  process.env.MCP_INTERNAL_BASE_URL = baseUrl;
  actor = { id: ADMIN, role: 'admin' };
  const ctx = { actor: { id: ADMIN, role: 'admin' }, requestHeaders: {} };
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
    await assert.rejects(
      callTool(ctx, 'call_api_operation', { operation_key: 'post_recipes', title: 'error-probe' }),
      (err) => {
        assert.doesNotMatch(err.message, /Internal error/);
        assert.match(err.message, /payload/);
        assert.match(err.message, /title/);
        return true;
      },
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, before, 'kein Rezept ohne payload');

    // Ganz ohne payload: die Route antwortet mit ihrer eigenen Validierung.
    await assert.rejects(
      callTool(ctx, 'call_api_operation', { operation_key: 'post_recipes' }),
      (err) => {
        assert.doesNotMatch(err.message, /Internal error/);
        assert.match(err.message, /title is required/);
        return true;
      },
    );

    const created = await callTool(ctx, 'call_api_operation', {
      operation_key: 'post_recipes',
      payload: { title: 'error-probe', ingredients: [{ name: 'Mehl' }] },
    });
    assert.equal(created.data.title, 'error-probe');
    assert.deepEqual(ingredientRows(created.data.id).map((x) => x.name), ['Mehl']);
  } finally {
    actor = { id: OWNER, role: 'member' };
    if (previous === undefined) delete process.env.MCP_INTERNAL_BASE_URL;
    else process.env.MCP_INTERNAL_BASE_URL = previous;
  }
});
