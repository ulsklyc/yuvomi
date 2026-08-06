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
// Der Einkaufs-Router hängt mit drin, weil die Rücknahme eines Transfers über
// ihn läuft (POST /shopping/items/undo-transfer) - ohne ihn wäre nur die halbe
// Handlung getestet.
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const recipeProviders = await import('../server/services/recipe-providers/index.js');
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
app.use('/shopping', shoppingRouter);
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

  // Rezepte sind Haushaltswissen: wer kocht, darf einkaufen - anders als bei
  // PUT/DELETE, die owner-only bleiben.
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
    // OWNER ist zugleich created_by dieses Mirror-Rezepts (via recipe_provider_accounts.created_by) -
    // der bloße created_by-Vergleich würde das durchlassen; das provider_account_id-Gate muss davor greifen.
    const r = await call('PUT', `/${recipeId}`, { title: 'Gehackt' });
    assert.equal(r.status, 403);
    const row = db.prepare('SELECT title FROM recipes WHERE id = ?').get(recipeId);
    assert.equal(row.title, 'Unveränderlich');
  });

  test(`DELETE /:id: gespiegeltes Rezept (${provider}) → 403`, async () => {
    const { recipeId } = mirroredRecipe('Unlöschbar', `mirror-delete-test-${provider}`, provider);
    const r = await call('DELETE', `/${recipeId}`);
    assert.equal(r.status, 403);
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
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, png1x1.length);
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
