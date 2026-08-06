/**
 * Test: Recipe-Provider-Integrationsrouten (Account-CRUD admin-only, Test/Sync-Trigger)
 * Zweck: End-to-End über den echten Router mit injiziertem Fake-Adapter - härtet
 *        Validierung (400/409), Admin-Gate (403), Token-Verstecken in
 *        Listenantworten, dass Account-Löschung ihre gespiegelten Rezepte per
 *        FK-Kaskade mitnimmt, und dass POST /accounts einen fehlenden/ungültigen
 *        provider-Wert auf 'mealie' zurückfallen lässt (SUPPORTED_PROVIDERS-Guard,
 *        analog zu server/routes/dms.js).
 * Ausführen: node --experimental-sqlite --test test/test-recipe-provider-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipeProvidersRouter } = await import('../server/routes/recipe-providers.js');
const { _setAdapterFactory } = await import('../server/services/recipe-providers/index.js');
const db = dbmod.get();

const ADMIN = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')`).run().lastInsertRowid;
const MEMBER = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('member','Member','x','member')`).run().lastInsertRowid;

let actor = { id: ADMIN, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', recipeProvidersRouter);
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

function fakeAdapter({ ok = true, groupSlug = 'home', recipes = [] } = {}) {
  return () => ({
    testConnection: async () => (ok ? { ok: true, status: 200, linkContext: { groupSlug } } : { ok: false, status: 401, error: 'bad token' }),
    listRecipeSummaries: async () => recipes.map((r) => ({ id: r.id ?? r.ref, ref: r.ref, updatedAt: r.updatedAt })),
    getRecipe: async (ref) => recipes.find((r) => r.ref === ref),
    recipeUrl: (linkContext, { slug }) => `https://mealie.example.com/g/${linkContext?.groupSlug}/r/${slug}`,
  });
}

test.after(() => _setAdapterFactory(null)); // Default-Factory wiederherstellen

// --------------------------------------------------------------------------
// GET/POST /accounts (Admin-Gate, Validierung, Token-Versteckung)
// --------------------------------------------------------------------------

test('GET /accounts: Nicht-Admin → 403', async () => {
  actor = { id: MEMBER, role: 'member' };
  const r = await call('GET', '/accounts');
  actor = { id: ADMIN, role: 'admin' };
  assert.equal(r.status, 403);
});

test('POST /accounts: fehlende Felder → 400', async () => {
  const r = await call('POST', '/accounts', { name: 'X' });
  assert.equal(r.status, 400);
});

test('POST /accounts: URL ohne http(s):// → 400', async () => {
  const r = await call('POST', '/accounts', { name: 'X', base_url: 'ftp://x', api_token: 't' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /http/);
});

test('POST /accounts: fehlgeschlagener Verbindungstest → 502, kein Account angelegt', async () => {
  _setAdapterFactory(fakeAdapter({ ok: false }));
  const before = db.prepare('SELECT COUNT(*) AS n FROM recipe_provider_accounts').get().n;
  const r = await call('POST', '/accounts', { name: 'Kaputt', base_url: 'https://bad.example.com', api_token: 't' });
  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipe_provider_accounts').get().n, before);
});

test('POST /accounts: erfolgreiche Anlage → 201, Token nie in der Antwort, has_token=true', async () => {
  _setAdapterFactory(fakeAdapter());
  const r = await call('POST', '/accounts', { name: 'Zuhause', base_url: 'https://mealie.example.com/', api_token: 'super-secret' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'Zuhause');
  assert.equal(r.body.data.base_url, 'https://mealie.example.com'); // trailing slash entfernt
  assert.equal(r.body.data.has_token, true);
  assert.equal('api_token' in r.body.data, false);
  const row = db.prepare('SELECT api_token FROM recipe_provider_accounts WHERE id = ?').get(r.body.data.id);
  assert.equal(row.api_token, 'super-secret'); // in der DB bleibt er, nur nie in der API-Antwort
});

test('POST /accounts: external_url ohne http(s):// → 400', async () => {
  const r = await call('POST', '/accounts', {
    name: 'Blackhole', base_url: 'https://mealie2.example.com', external_url: 'ftp://x', api_token: 't',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /External URL/);
});

test('POST /accounts: external_url wird getrimmt und gespeichert (base_url bleibt für Requests, external_url nur für Links)', async () => {
  _setAdapterFactory(fakeAdapter());
  const r = await call('POST', '/accounts', {
    name: 'MitVanity', base_url: 'https://internal.mealie.local', external_url: 'https://recipes.example.com/', api_token: 't3',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.external_url, 'https://recipes.example.com'); // trailing slash entfernt
  assert.equal(r.body.data.base_url, 'https://internal.mealie.local');
});

test('POST /accounts: doppelte base_url → 409', async () => {
  const r = await call('POST', '/accounts', { name: 'Zweitkonto', base_url: 'https://mealie.example.com', api_token: 't2' });
  assert.equal(r.status, 409);
});

test('POST /accounts: Nicht-Admin → 403', async () => {
  actor = { id: MEMBER, role: 'member' };
  const r = await call('POST', '/accounts', { name: 'X', base_url: 'https://x.example.com', api_token: 't' });
  actor = { id: ADMIN, role: 'admin' };
  assert.equal(r.status, 403);
});

test('POST /accounts: fehlendes oder ungültiges provider-Feld fällt auf \'mealie\' zurück', async () => {
  _setAdapterFactory(fakeAdapter());

  const missing = await call('POST', '/accounts', { name: 'OhneProvider', base_url: 'https://noprovider.example.com', api_token: 't' });
  assert.equal(missing.status, 201);
  assert.equal(missing.body.data.provider, 'mealie');
  assert.equal(db.prepare('SELECT provider FROM recipe_provider_accounts WHERE id = ?').get(missing.body.data.id).provider, 'mealie');

  const invalid = await call('POST', '/accounts', { name: 'UngueltigerProvider', base_url: 'https://invalidprovider.example.com', api_token: 't', provider: 'not-a-real-provider' });
  assert.equal(invalid.status, 201);
  assert.equal(invalid.body.data.provider, 'mealie');
});

test('GET /accounts: listet ohne Token, mit has_token', async () => {
  const r = await call('GET', '/accounts');
  assert.equal(r.status, 200);
  const acc = r.body.data.find((a) => a.name === 'Zuhause');
  assert.ok(acc);
  assert.equal(acc.has_token, true);
  assert.equal('api_token' in acc, false);
});

// --------------------------------------------------------------------------
// PATCH /accounts/:id
// --------------------------------------------------------------------------
test('PATCH /accounts/:id: schaltet enabled um', async () => {
  const list = await call('GET', '/accounts');
  const id = list.body.data.find((a) => a.name === 'Zuhause').id;
  const r = await call('PATCH', `/accounts/${id}`, { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, 0);
});

test('PATCH /accounts/:id: setzt und leert external_url', async () => {
  const list = await call('GET', '/accounts');
  const id = list.body.data.find((a) => a.name === 'Zuhause').id;

  const set = await call('PATCH', `/accounts/${id}`, { external_url: 'https://public.example.com/' });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.external_url, 'https://public.example.com');

  const cleared = await call('PATCH', `/accounts/${id}`, { external_url: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.external_url, null);
});

test('PATCH /accounts/:id: external_url ohne http(s):// → 400', async () => {
  const list = await call('GET', '/accounts');
  const id = list.body.data.find((a) => a.name === 'Zuhause').id;
  const r = await call('PATCH', `/accounts/${id}`, { external_url: 'not-a-url' });
  assert.equal(r.status, 400);
});

test('PATCH /accounts/:id: unbekannter Account → 404', async () => {
  const r = await call('PATCH', '/accounts/999999', { enabled: true });
  assert.equal(r.status, 404);
});

// --------------------------------------------------------------------------
// POST /accounts/:id/sync + POST /sync (mit injiziertem Fake-Adapter)
// --------------------------------------------------------------------------
test('POST /accounts/:id/sync: importiert Rezepte des Fake-Adapters', async () => {
  const list = await call('GET', '/accounts');
  const id = list.body.data.find((a) => a.name === 'Zuhause').id;
  await call('PATCH', `/accounts/${id}`, { enabled: true }); // von oben wieder aktivieren

  _setAdapterFactory(fakeAdapter({
    recipes: [{
      id: 'pfannkuchen', ref: 'pfannkuchen', updatedAt: '2026-01-01T00:00:00Z', slug: 'pfannkuchen',
      title: 'Pfannkuchen', notes: 'Lecker', hasImage: false,
      ingredients: [{ name: 'Mehl', quantity: '2 Tassen', category: 'Backwaren' }],
    }],
  }));

  const r = await call('POST', `/accounts/${id}/sync`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.imported, 1);

  const recipe = db.prepare('SELECT title, recipe_url FROM recipes WHERE provider_account_id = ? AND provider_recipe_id = ?').get(id, 'pfannkuchen');
  assert.equal(recipe.title, 'Pfannkuchen');
  assert.equal(recipe.recipe_url, 'https://mealie.example.com/g/home/r/pfannkuchen');
});

test('POST /sync: Nicht-Admin → 403', async () => {
  actor = { id: MEMBER, role: 'member' };
  const r = await call('POST', '/sync');
  actor = { id: ADMIN, role: 'admin' };
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// GET /status (kein Admin-Gate)
// --------------------------------------------------------------------------
test('GET /status: auch für Nicht-Admin lesbar, enthält nie den Token', async () => {
  actor = { id: MEMBER, role: 'member' };
  const r = await call('GET', '/status');
  actor = { id: ADMIN, role: 'admin' };
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  const acc = r.body.data.find((a) => a.name === 'Zuhause');
  assert.ok(acc);
  assert.equal(acc.recipeCount, 1);
  assert.equal('apiToken' in acc, false);
  assert.equal('api_token' in acc, false);
});

// --------------------------------------------------------------------------
// DELETE /accounts/:id (FK-Kaskade auf gespiegelte Rezepte)
// --------------------------------------------------------------------------
test('DELETE /accounts/:id: löscht per Kaskade auch alle gespiegelten Rezepte', async () => {
  const list = await call('GET', '/accounts');
  const id = list.body.data.find((a) => a.name === 'Zuhause').id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE provider_account_id = ?').get(id).n, 1);

  const r = await call('DELETE', `/accounts/${id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE provider_account_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT id FROM recipe_provider_accounts WHERE id = ?').get(id), undefined);
});

test('DELETE /accounts/:id: unbekannter Account → 404', async () => {
  const r = await call('DELETE', '/accounts/999999');
  assert.equal(r.status, 404);
});
