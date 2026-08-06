/**
 * Test: Recipe-Provider-Sync-Service (Upsert, Änderungserkennung, Leer-Guard-Löschung)
 * Zweck: sync() gegen einen injizierten Fake-Adapter (kein echtes Netzwerk).
 *        Deckt den sicherheitskritischen Fall ab: ein fehlgeschlagener oder
 *        leerer Abruf darf den lokalen Mirror nie leeren (vgl. calendar-prune.js).
 *        Deckt außerdem ab, dass der Upsert-Schlüssel der Providers stabile Id
 *        ist, nicht der (bei Umbenennung wechselnde) ref/Slug. Der Fake-Adapter-
 *        Hook (_setAdapterFactory) lebt auf recipe-providers/index.js, nicht mehr
 *        als lokaler Export des Sync-Moduls.
 * Ausführen: node --experimental-sqlite --test test/test-recipe-provider-sync.js
 */

process.env.DB_PATH = ':memory:';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../server/db.js');
const sync = await import('../server/services/recipe-provider-sync.js');
const { _setAdapterFactory } = await import('../server/services/recipe-providers/index.js');
const conn = db.get();

const OWNER = conn.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner','Owner','x','member')`).run().lastInsertRowid;

function newAccount(name = 'Zuhause', provider = 'mealie') {
  return conn.prepare(`
    INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by) VALUES (?, ?, 'tok', ?, ?)
  `).run(name, `https://${name.toLowerCase()}.example.com`, provider, OWNER).lastInsertRowid;
}

function mirroredRecipes(accountId) {
  return conn.prepare('SELECT title, provider_recipe_id FROM recipes WHERE provider_account_id = ? ORDER BY id ASC').all(accountId);
}

function ingredientsFor(accountId, providerRecipeId) {
  const recipe = conn.prepare('SELECT id FROM recipes WHERE provider_account_id = ? AND provider_recipe_id = ?').get(accountId, providerRecipeId);
  return conn.prepare('SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC').all(recipe.id);
}

// sync() iteriert über ALLE aktivierten Accounts, nicht nur den des aktuellen
// Tests - ohne diesen Reset würden spätere Tests die Mirror-Rezepte früherer
// Tests mitsynchronisieren (falsche imported/deleted-Zählungen).
beforeEach(() => { conn.prepare('UPDATE recipe_provider_accounts SET enabled = 0').run(); });
afterEach(() => _setAdapterFactory(null));

// summaries: [{ id, ref, updatedAt }]; details: { [ref]: { id, updatedAt, slug, title,
// notes, hasImage, ingredients } } - details sind bereits die normalisierte Form,
// die ein echter Adapter aus getRecipe() liefert (Zutaten schon geflacht).
// id ist der stabile Provider-Schlüssel (Upsert-Key), ref wird für getRecipe() gebraucht.
function fakeAdapter(summaries, details, { groupSlug = 'home', fail = false } = {}) {
  return () => ({
    testConnection: async () => {
      if (fail) throw new Error('network down');
      return { ok: true, status: 200, linkContext: { groupSlug } };
    },
    listRecipeSummaries: async () => {
      if (fail) throw new Error('network down');
      return summaries;
    },
    getRecipe: async (ref) => details[ref],
    recipeUrl: (linkContext, { slug }) => `https://mealie.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
  });
}

test('sync(): keine aktivierten Accounts → No-Op', async () => {
  const result = await sync.sync();
  assert.deepEqual(result, { success: true, syncedAccounts: 0, imported: 0, updated: 0, deleted: 0 });
});

test('sync(): importiert neue Rezepte inkl. Zutaten, setzt recipe_url, last_sync', async () => {
  const accountId = newAccount('Import');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-pancakes', ref: 'pancakes', updatedAt: '2026-01-01T00:00:00Z' }],
    { pancakes: {
      id: 'uuid-pancakes', updatedAt: '2026-01-01T00:00:00Z', slug: 'pancakes', title: 'Pancakes', notes: 'Fluffy', hasImage: false,
      ingredients: [{ name: 'flour', quantity: '2 cups', category: 'Backwaren' }],
    } },
  ));

  const result = await sync.sync();
  assert.equal(result.imported, 1);

  const [recipe] = mirroredRecipes(accountId);
  assert.equal(recipe.title, 'Pancakes');
  assert.equal(recipe.provider_recipe_id, 'uuid-pancakes');
  const row = conn.prepare('SELECT recipe_url, notes FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(row.recipe_url, 'https://mealie.example.com/g/home/r/pancakes');
  assert.equal(row.notes, 'Fluffy');
  assert.deepEqual(ingredientsFor(accountId, 'uuid-pancakes'), [{ name: 'flour', quantity: '2 cups', category: 'Backwaren' }]);

  const account = conn.prepare('SELECT last_sync, last_error FROM recipe_provider_accounts WHERE id = ?').get(accountId);
  assert.ok(account.last_sync);
  assert.equal(account.last_error, null);
});

test('sync(): unveränderte updatedAt → überspringt Neuimport der Zutaten', async () => {
  newAccount('Unverändert');
  const summaries = [{ id: 'uuid-soup', ref: 'soup', updatedAt: '2026-01-01T00:00:00Z' }];
  const details = { soup: {
    id: 'uuid-soup', updatedAt: '2026-01-01T00:00:00Z', slug: 'soup', title: 'Soup', notes: null, hasImage: false,
    ingredients: [{ name: 'broth', quantity: '1 liter', category: 'Sonstiges' }],
  } };
  _setAdapterFactory(fakeAdapter(summaries, details));
  await sync.sync();

  // Zweiter Lauf: gleiche updatedAt, getRecipe würde bei Aufruf einen Fehler
  // werfen - wird er trotzdem aufgerufen, schlägt der Test fehl.
  _setAdapterFactory(() => ({
    testConnection: async () => ({ ok: true, status: 200, linkContext: { groupSlug: 'home' } }),
    listRecipeSummaries: async () => summaries,
    getRecipe: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    recipeUrl: (linkContext, { slug }) => `https://mealie.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
  }));
  const result = await sync.sync();
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 0);
});

test('sync(): unveränderte updatedAt, aber geänderte external_url → recipe_url wird trotzdem neu gebaut, ohne getRecipe erneut aufzurufen', async () => {
  const accountId = newAccount('LinkWechsel');
  const summaries = [{ id: 'uuid-tarte', ref: 'tarte', updatedAt: '2026-01-01T00:00:00Z' }];
  const details = { tarte: {
    id: 'uuid-tarte', updatedAt: '2026-01-01T00:00:00Z', slug: 'tarte', title: 'Tarte', notes: null, hasImage: false, ingredients: [],
  } };
  _setAdapterFactory(fakeAdapter(summaries, details));
  await sync.sync();
  const before = conn.prepare('SELECT recipe_url FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(before.recipe_url, 'https://mealie.example.com/g/home/r/tarte');

  // Zweiter Lauf simuliert eine nachträglich gesetzte external_url: derselbe
  // Slug, aber ein anderer linkBase. getRecipe darf trotzdem nicht erneut
  // aufgerufen werden - die URL wird nur aus dem gespeicherten Slug neu gebaut.
  _setAdapterFactory(() => ({
    testConnection: async () => ({ ok: true, status: 200, linkContext: { groupSlug: 'home' } }),
    listRecipeSummaries: async () => summaries,
    getRecipe: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    recipeUrl: (linkContext, { slug }) => `https://cook.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
  }));
  await sync.sync();
  const after = conn.prepare('SELECT recipe_url FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(after.recipe_url, 'https://cook.example.com/g/home/r/tarte');
});

test('sync(): unveränderte updatedAt, aber kein groupSlug diesmal → alter recipe_url bleibt unangetastet statt auf null zu fallen', async () => {
  const accountId = newAccount('KeinGroupSlug');
  const summaries = [{ id: 'uuid-brot', ref: 'brot', updatedAt: '2026-01-01T00:00:00Z' }];
  const details = { brot: {
    id: 'uuid-brot', updatedAt: '2026-01-01T00:00:00Z', slug: 'brot', title: 'Brot', notes: null, hasImage: false, ingredients: [],
  } };
  _setAdapterFactory(fakeAdapter(summaries, details));
  await sync.sync();
  const before = conn.prepare('SELECT recipe_url FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(before.recipe_url, 'https://mealie.example.com/g/home/r/brot');

  // testConnection() liefert diesmal ok, aber ohne groupSlug (z. B. Mealie-
  // Versionsunterschied) - recipeUrl(linkContext, {slug}) würde null bauen.
  _setAdapterFactory(() => ({
    testConnection: async () => ({ ok: true, status: 200, linkContext: { groupSlug: null } }),
    listRecipeSummaries: async () => summaries,
    getRecipe: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    recipeUrl: (linkContext, { slug }) => (linkContext?.groupSlug ? `https://mealie.example.com/g/${linkContext.groupSlug}/r/${slug}` : null),
  }));
  await sync.sync();
  const after = conn.prepare('SELECT recipe_url FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(after.recipe_url, 'https://mealie.example.com/g/home/r/brot');
});

test('sync(): geänderte updatedAt → aktualisiert Titel und ersetzt Zutaten', async () => {
  const accountId = newAccount('Ändert');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-stew', ref: 'stew', updatedAt: '2026-01-01T00:00:00Z' }],
    { stew: { id: 'uuid-stew', updatedAt: '2026-01-01T00:00:00Z', slug: 'stew', title: 'Stew v1', notes: null, hasImage: false, ingredients: [{ name: 'carrot', quantity: null, category: 'Obst & Gemüse' }] } },
  ));
  await sync.sync();

  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-stew', ref: 'stew', updatedAt: '2026-02-01T00:00:00Z' }],
    { stew: { id: 'uuid-stew', updatedAt: '2026-02-01T00:00:00Z', slug: 'stew', title: 'Stew v2', notes: null, hasImage: false, ingredients: [{ name: 'potato', quantity: null, category: 'Obst & Gemüse' }] } },
  ));
  const result = await sync.sync();
  assert.equal(result.updated, 1);

  const row = conn.prepare('SELECT title FROM recipes WHERE provider_account_id = ?').get(accountId);
  assert.equal(row.title, 'Stew v2');
  assert.deepEqual(ingredientsFor(accountId, 'uuid-stew').map((i) => i.name), ['potato']);
});

test('sync(): Rezept-Umbenennung beim Provider (Ref/Slug ändert sich, Id bleibt) → Update, kein Löschen+Neuanlegen', async () => {
  // Regression: der Upsert-Schlüssel muss die stabile Provider-Id sein. Würde
  // stattdessen der Ref/Slug verwendet, sähe eine Umbenennung wie "altes Rezept
  // gelöscht, neues angelegt" aus und jede Essensplan-Verknüpfung ginge verloren
  // (meals.recipe_id ON DELETE SET NULL).
  const accountId = newAccount('Umbenennung');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-stable', ref: 'alter-name', updatedAt: '2026-01-01T00:00:00Z' }],
    { 'alter-name': { id: 'uuid-stable', updatedAt: '2026-01-01T00:00:00Z', slug: 'alter-name', title: 'Alter Name', notes: null, hasImage: false, ingredients: [] } },
  ));
  await sync.sync();
  const [before] = mirroredRecipes(accountId);
  const recipeId = conn.prepare('SELECT id FROM recipes WHERE provider_account_id = ?').get(accountId).id;

  // Provider liefert jetzt einen neuen Ref/Slug für dieselbe Id (Umbenennung).
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-stable', ref: 'neuer-name', updatedAt: '2026-02-01T00:00:00Z' }],
    { 'neuer-name': { id: 'uuid-stable', updatedAt: '2026-02-01T00:00:00Z', slug: 'neuer-name', title: 'Neuer Name', notes: null, hasImage: false, ingredients: [] } },
  ));
  const result = await sync.sync();

  assert.equal(result.updated, 1);
  assert.equal(result.imported, 0);
  assert.equal(result.deleted, 0);
  const [after] = mirroredRecipes(accountId);
  assert.equal(after.title, 'Neuer Name');
  assert.equal(before.provider_recipe_id, after.provider_recipe_id); // gleiche Id
  // Dieselbe recipes.id - keine Neuanlage, also bleibt jede meals.recipe_id-Referenz intakt.
  assert.equal(conn.prepare('SELECT id FROM recipes WHERE provider_account_id = ?').get(accountId).id, recipeId);
});

test('sync(): Rezept verschwindet beim Provider → wird lokal gelöscht (Leer-Guard greift NICHT, da andere Summaries geliefert werden)', async () => {
  const accountId = newAccount('Prune');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-a', ref: 'a', updatedAt: 't1' }, { id: 'uuid-b', ref: 'b', updatedAt: 't1' }],
    {
      a: { id: 'uuid-a', updatedAt: 't1', slug: 'a', title: 'A', notes: null, hasImage: false, ingredients: [] },
      b: { id: 'uuid-b', updatedAt: 't1', slug: 'b', title: 'B', notes: null, hasImage: false, ingredients: [] },
    },
  ));
  await sync.sync();
  assert.equal(mirroredRecipes(accountId).length, 2);

  // Nur noch 'b' wird geliefert - 'a' muss verschwinden.
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-b', ref: 'b', updatedAt: 't1' }],
    { b: { id: 'uuid-b', updatedAt: 't1', slug: 'b', title: 'B', notes: null, hasImage: false, ingredients: [] } },
  ));
  const result = await sync.sync();
  assert.equal(result.deleted, 1);
  assert.deepEqual(mirroredRecipes(accountId).map((r) => r.provider_recipe_id), ['uuid-b']);
});

test('sync(): SICHERHEIT - fehlgeschlagener Abruf löscht den lokalen Mirror nicht und setzt last_error', async () => {
  const accountId = newAccount('Ausfallsicher');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-x', ref: 'x', updatedAt: 't1' }],
    { x: { id: 'uuid-x', updatedAt: 't1', slug: 'x', title: 'X', notes: null, hasImage: false, ingredients: [] } },
  ));
  await sync.sync();
  assert.equal(mirroredRecipes(accountId).length, 1);

  _setAdapterFactory(fakeAdapter([], {}, { fail: true }));
  const result = await sync.sync();
  assert.equal(result.syncedAccounts, 0);
  assert.equal(result.deleted, 0);
  assert.equal(mirroredRecipes(accountId).length, 1); // unverändert, NICHT geleert

  const account = conn.prepare('SELECT last_error FROM recipe_provider_accounts WHERE id = ?').get(accountId);
  assert.match(account.last_error, /network down/);
});

test('sync(): SICHERHEIT - fehlgeschlagener Abruf löscht den lokalen Mirror nicht und setzt last_error (Tandoor-Account)', async () => {
  const accountId = newAccount('AusfallsicherTandoor', 'tandoor');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-tx', ref: 'tx', updatedAt: 't1' }],
    { tx: { id: 'uuid-tx', updatedAt: 't1', slug: 'tx', title: 'TX', notes: null, hasImage: false, ingredients: [] } },
  ));
  await sync.sync();
  assert.equal(mirroredRecipes(accountId).length, 1);

  _setAdapterFactory(fakeAdapter([], {}, { fail: true }));
  const result = await sync.sync();
  assert.equal(result.syncedAccounts, 0);
  assert.equal(result.deleted, 0);
  assert.equal(mirroredRecipes(accountId).length, 1); // unverändert, NICHT geleert

  const account = conn.prepare('SELECT last_error FROM recipe_provider_accounts WHERE id = ?').get(accountId);
  assert.match(account.last_error, /network down/);
});

test('sync(): SICHERHEIT - leere Rezeptliste bei bestehendem Mirror wird als Fehler behandelt, nicht als Leerung', async () => {
  const accountId = newAccount('LeerGuard');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-y', ref: 'y', updatedAt: 't1' }],
    { y: { id: 'uuid-y', updatedAt: 't1', slug: 'y', title: 'Y', notes: null, hasImage: false, ingredients: [] } },
  ));
  await sync.sync();
  assert.equal(mirroredRecipes(accountId).length, 1);

  // Verbindung klappt (testConnection ok), aber die Liste kommt leer zurück -
  // eher ein stiller Server-/Auth-Fehler als eine tatsächlich geleerte Sammlung.
  _setAdapterFactory(fakeAdapter([], {}));
  const result = await sync.sync();
  assert.equal(result.deleted, 0);
  assert.equal(mirroredRecipes(accountId).length, 1);
});

test('sync(): SICHERHEIT - leere Rezeptliste bei bestehendem Mirror wird als Fehler behandelt, nicht als Leerung (Tandoor-Account)', async () => {
  const accountId = newAccount('LeerGuardTandoor', 'tandoor');
  _setAdapterFactory(fakeAdapter(
    [{ id: 'uuid-ty', ref: 'ty', updatedAt: 't1' }],
    { ty: { id: 'uuid-ty', updatedAt: 't1', slug: 'ty', title: 'TY', notes: null, hasImage: false, ingredients: [] } },
  ));
  await sync.sync();
  assert.equal(mirroredRecipes(accountId).length, 1);

  // Verbindung klappt (testConnection ok), aber die Liste kommt leer zurück -
  // eher ein stiller Server-/Auth-Fehler als eine tatsächlich geleerte Sammlung.
  _setAdapterFactory(fakeAdapter([], {}));
  const result = await sync.sync();
  assert.equal(result.deleted, 0);
  assert.equal(mirroredRecipes(accountId).length, 1);
});

test('sync(): deaktivierter Account wird übersprungen', async () => {
  const accountId = newAccount('Deaktiviert');
  conn.prepare('UPDATE recipe_provider_accounts SET enabled = 0 WHERE id = ?').run(accountId);
  _setAdapterFactory(() => ({
    testConnection: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    listRecipeSummaries: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    getRecipe: async () => { throw new Error('sollte nicht aufgerufen werden'); },
    recipeUrl: () => null,
  }));
  const result = await sync.sync();
  assert.equal(result.syncedAccounts, 0);
});

test('sync(): ein fehlschlagender Account blockiert einen zweiten, gesunden Account nicht', async () => {
  const brokenId = newAccount('Kaputt');
  const healthyId = newAccount('Gesund');

  let callCount = 0;
  _setAdapterFactory((account) => {
    callCount += 1;
    if (account.id === brokenId) {
      return {
        testConnection: async () => { throw new Error('kaputt'); },
        listRecipeSummaries: async () => { throw new Error('kaputt'); },
        getRecipe: async () => { throw new Error('unused'); },
        recipeUrl: () => null,
      };
    }
    return {
      testConnection: async () => ({ ok: true, status: 200, linkContext: { groupSlug: 'home' } }),
      listRecipeSummaries: async () => [{ id: 'uuid-z', ref: 'z', updatedAt: 't1' }],
      getRecipe: async () => ({ id: 'uuid-z', updatedAt: 't1', slug: 'z', title: 'Z', notes: null, hasImage: false, ingredients: [] }),
      recipeUrl: (linkContext, { slug }) => `https://mealie.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
    };
  });

  const result = await sync.sync();
  assert.equal(callCount, 2);
  assert.equal(result.syncedAccounts, 1);
  assert.equal(mirroredRecipes(healthyId).length, 1);
  assert.equal(mirroredRecipes(brokenId).length, 0);

  const broken = conn.prepare('SELECT last_error FROM recipe_provider_accounts WHERE id = ?').get(brokenId);
  assert.match(broken.last_error, /kaputt/);
});

test('syncOne(): synchronisiert nur den angegebenen Account', async () => {
  const idA = newAccount('Einzeln A');
  const idB = newAccount('Einzeln B');
  _setAdapterFactory((account) => ({
    testConnection: async () => ({ ok: true, status: 200, linkContext: { groupSlug: 'home' } }),
    listRecipeSummaries: async () => [{ id: `uuid-${account.id}`, ref: `r-${account.id}`, updatedAt: 't1' }],
    getRecipe: async (ref) => ({ id: `uuid-${account.id}`, updatedAt: 't1', slug: ref, title: ref, notes: null, hasImage: false, ingredients: [] }),
    recipeUrl: (linkContext, { slug }) => `https://mealie.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
  }));

  await sync.syncOne(idA);
  assert.equal(mirroredRecipes(idA).length, 1);
  assert.equal(mirroredRecipes(idB).length, 0);
});

test('syncOne(): unbekannter Account wirft', async () => {
  await assert.rejects(() => sync.syncOne(999999), /not found/i);
});
