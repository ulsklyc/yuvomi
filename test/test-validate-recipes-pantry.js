/**
 * Test: request validation in recipes, recipe providers and pantry (#2810, phase 2 section E, group 2A)
 * Purpose: the three route files check every request against the schema of
 *          its operation in the OpenAPI document (`validateRequest()` in every
 *          route, behind the rights that need no row) before the handler runs.
 *          Held here against the real routers, mounted at their real prefixes
 *          in the order of server/index.js (express.json, defaultEmptyBody,
 *          the routers, the error handler):
 *            - RIGHTS FIRST: a member gets 403 `admin_required` from the seven
 *              admin routes of the providers, a caller without the second
 *              module right gets 403 `cross_module_access` from the three
 *              cross-module routes - for any body, never a 400 naming fields;
 *            - REFUSED: each input of the decided list is a 400 with `fields`,
 *              and with the route's own reason where the schema carries it
 *              (`recipe_providers_url_invalid`,
 *              `recipe_providers_external_url_invalid`), else `validation`;
 *              the 400 comes before the 404 and the 409 of the handler;
 *            - KEPT: what the routes lived with goes through as before, and
 *              what the schema cannot say still gets the handler's answer;
 *            - FIXED: a take-over from the shopping list with a storage
 *              location that does not exist is a 400 before anything is
 *              written (it was a 500 from the foreign key);
 *            - THE OWN FRONTEND: every request the app sends to these
 *              endpoints passes, the legacy digit text included;
 *            - ONE SOURCE: the unit enum is PANTRY_UNITS, the provider enum
 *              SUPPORTED_PROVIDERS, the day pattern DATE_PATTERN, the image
 *              length the route's own limit.
 *          No answer asserted here carries a date; the household zone is
 *          pinned anyway, since the pantry writes reminders.
 * Run: npm run test:validate-recipes-pantry
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipesRouter, MAX_RECIPE_IMAGE_LENGTH } = await import('../server/routes/recipes.js');
const { default: recipeProvidersRouter } = await import('../server/routes/recipe-providers.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { _setAdapterFactory, SUPPORTED_PROVIDERS } = await import('../server/services/recipe-providers/index.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const { validateRequest } = await import('../server/api/validate-request.ts');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const ADMIN = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin2a','Admin','x','admin','parent')").run().lastInsertRowid);
const MEMBER = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('member2a','Member','x','member','child')").run().lastInsertRowid);
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

// No network: the connection test of a new provider account answers ok.
_setAdapterFactory(() => ({
  testConnection: async () => ({ ok: true, status: 200 }),
  listRecipeSummaries: async () => [],
  getRecipe: async () => null,
  recipeUrl: () => null,
  fetchThumbnail: async () => { const err = Object.assign(new Error('none'), { status: 404 }); throw err; },
}));
test.after(() => _setAdapterFactory(null));

const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(defaultEmptyBody);
// requireAuth, reduced to the fields these routes read. `x-access` is the
// member's module access (sessionModuleAccess), e.g. {"shopping":"read"}.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const member = req.get('x-actor') === 'member';
  const id = member ? MEMBER : ADMIN;
  req.authUserId = id;
  req.authRole = member ? 'member' : 'admin';
  req.authMethod = 'session';
  req.session = { userId: id, role: req.authRole };
  req.sessionModuleAccess = req.get('x-access') ? JSON.parse(req.get('x-access')) : null;
  next();
});
// The order of server/index.js.
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/recipe-providers', recipeProvidersRouter);
app.use('/api/v1/pantry', pantryRouter);
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: 'member', access?: Record<string, string> }} [options] json left out: no body
 */
async function call(method, route, { json, actor, access } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor) headers['x-actor'] = actor;
  if (access) headers['x-access'] = JSON.stringify(access);
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/v1${route}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* an image or no body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the middleware: exactly these fields, the reason of the first.
 * @param {{ status: number, body: any }} res
 * @param {Array<{ path: string, rule: string, reason?: string }>} fields
 */
function assertRefused(res, fields) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: SENTENCE, code: 400, reason: fields[0].reason ?? 'validation', fields });
}

/**
 * A 400 of the handler, not of the schema: no `fields`.
 * @param {{ status: number, body: any }} res
 * @param {string | undefined} [reason]
 */
function assertHandlerRefused(res, reason) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.notEqual(res.body?.error, SENTENCE, JSON.stringify(res.body));
  assert.equal(res.body?.fields, undefined);
  assert.equal(res.body?.reason, reason);
}

/** @param {{ status: number, body: any }} res @param {number} status */
function assertPassed(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
}

const NOT_DIGITS = ['12abc', '5.0', '1e2', '0x10'];

// ── Seed ────────────────────────────────────────────────────────────────────

const LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)").run(ADMIN).lastInsertRowid);
const CATEGORY = db.prepare('SELECT name FROM shopping_categories ORDER BY sort_order LIMIT 1').get()?.name ?? 'Sonstiges';
const LOCATION = Number(db.prepare("INSERT INTO pantry_locations (name, icon, sort_order) VALUES ('Probekeller', 'package', 50)").run().lastInsertRowid);
const LOCATION_2 = Number(db.prepare("INSERT INTO pantry_locations (name, icon, sort_order) VALUES ('Proberegal', 'package', 51)").run().lastInsertRowid);

/** A checked item on LIST. @param {string} name */
function checkedItem(name) {
  return Number(db.prepare('INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, ?, ?, 1)')
    .run(LIST, name, CATEGORY).lastInsertRowid);
}

/** @param {string} title */
async function newRecipe(title = 'Pasta') {
  const res = await call('POST', '/recipes', { json: { title, ingredients: [{ name: 'Nudeln', quantity: '500 g', category: CATEGORY }] } });
  assertPassed(res, 201);
  return res.body.data;
}

/** @param {string} name */
async function newPantryItem(name = 'Reis') {
  const res = await call('POST', '/pantry', { json: { name, quantity: 2, unit: 'kg', location_id: LOCATION, category: CATEGORY } });
  assertPassed(res, 201);
  return res.body.data;
}

const ACCOUNT = Number(db.prepare(`
  INSERT INTO recipe_provider_accounts (provider, name, base_url, api_token, created_by) VALUES ('mealie', 'Küche', 'https://mealie.example', 'tok', ?)
`).run(ADMIN).lastInsertRowid);

const pantryCount = () => db.prepare('SELECT COUNT(*) AS n FROM pantry_items').get().n;

// ── RIGHTS FIRST ────────────────────────────────────────────────────────────

const ADMIN_REQUIRED = { error: 'Admin access required.', code: 403, reason: 'admin_required' };

test('recipe providers: a member gets admin_required for any body on the seven admin routes, never field names', async () => {
  for (const [method, route] of [
    ['GET', '/recipe-providers/accounts'],
    ['POST', '/recipe-providers/accounts'],
    ['PATCH', `/recipe-providers/accounts/${ACCOUNT}`],
    ['PATCH', '/recipe-providers/accounts/12abc'],
    ['DELETE', '/recipe-providers/accounts/0x10'],
    ['POST', `/recipe-providers/accounts/${ACCOUNT}/test`],
    ['POST', `/recipe-providers/accounts/${ACCOUNT}/sync`],
    ['POST', '/recipe-providers/sync'],
  ]) {
    for (const json of method === 'GET' ? [undefined] : [undefined, [], { provider: 'bogus', base_url: 'ftp://x', enabled: 'false', name: 5 }]) {
      const res = await call(method, route, { json, actor: 'member' });
      assert.equal(res.status, 403, `${method} ${route} ${JSON.stringify(json)}`);
      assert.deepEqual(res.body, ADMIN_REQUIRED, `${method} ${route}`);
    }
  }
  assertPassed(await call('GET', '/recipe-providers/status', { actor: 'member' }), 200);
});

test('cross-module rights stand before the schema: 403 cross_module_access with the same body as before, for any body', async () => {
  const recipe = await newRecipe('Rechte');
  const cases = /** @type {Array<[string, string, Record<string, string>, unknown, string]>} */ ([
    ['POST', `/recipes/${recipe.id}/to-shopping-list`, { shopping: 'read' }, { listId: 'x', quantities: 5 }, 'Write access to the shopping list is required.'],
    ['POST', '/recipes/12abc/to-shopping-list', { shopping: 'read' }, [], 'Write access to the shopping list is required.'],
    ['PUT', `/recipes/${recipe.id}/ingredient-match`, { pantry: 'read' }, { name: 5, pantryItemId: 'x' }, 'Write access to the pantry is required.'],
    ['PUT', '/recipes/0x10/ingredient-match', { pantry: 'read' }, undefined, 'Write access to the pantry is required.'],
    ['POST', '/pantry/import-shopping', { shopping: 'none' }, { list_id: 'x', items: 'y' }, 'Read access to the shopping list is required.'],
    ['POST', '/pantry/import-shopping', { shopping: 'none' }, undefined, 'Read access to the shopping list is required.'],
  ]);
  for (const [method, route, access, json, error] of cases) {
    const res = await call(method, route, { json, actor: 'member', access });
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.deepEqual(res.body, { error, code: 403, reason: 'cross_module_access' }, `${method} ${route}`);
  }
});

// ── RECIPES ─────────────────────────────────────────────────────────────────

test('recipes: malformed bodies are a 400 with fields', async () => {
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/title', rule: 'required' }],
    [{ title: 5 }, { path: 'body/title', rule: 'type' }],
    [{ title: ['x'] }, { path: 'body/title', rule: 'type' }],
    [{ title: {} }, { path: 'body/title', rule: 'type' }],
    [{ title: 'x'.repeat(201) }, { path: 'body/title', rule: 'maxLength' }],
    [{ title: 'A', notes: 5 }, { path: 'body/notes', rule: 'type' }],
    [{ title: 'A', notes: 'x'.repeat(5001) }, { path: 'body/notes', rule: 'maxLength' }],
    [{ title: 'A', recipe_url: ['x'] }, { path: 'body/recipe_url', rule: 'type' }],
    [{ title: 'A', servings: '5' }, { path: 'body/servings', rule: 'type' }],
    [{ title: 'A', servings: true }, { path: 'body/servings', rule: 'type' }],
    [{ title: 'A', servings: '' }, { path: 'body/servings', rule: 'type' }],
    [{ title: 'A', servings: 0 }, { path: 'body/servings', rule: 'minimum' }],
    [{ title: 'A', servings: 100 }, { path: 'body/servings', rule: 'maximum' }],
    [{ title: 'A', servings: 5.5 }, { path: 'body/servings', rule: 'type' }],
    [{ title: 'A', ingredients: null }, { path: 'body/ingredients', rule: 'type' }],
    [{ title: 'A', ingredients: 'abc' }, { path: 'body/ingredients', rule: 'type' }],
    [{ title: 'A', ingredients: {} }, { path: 'body/ingredients', rule: 'type' }],
    [{ title: 'A', ingredients: [1] }, { path: 'body/ingredients/0', rule: 'type' }],
    [{ title: 'A', ingredients: [{ name: 5 }] }, { path: 'body/ingredients/0/name', rule: 'type' }],
    [{ title: 'A', ingredients: [{ name: 'x', quantity: 2 }] }, { path: 'body/ingredients/0/quantity', rule: 'type' }],
    [{ title: 'A', image_data: 5 }, { path: 'body/image_data', rule: 'type' }],
    [{ title: 'A', image_data: 'x'.repeat(MAX_RECIPE_IMAGE_LENGTH + 1) }, { path: 'body/image_data', rule: 'maxLength' }],
    [[], { path: 'body', rule: 'type' }],
  ])) {
    assertRefused(await call('POST', '/recipes', { json }), [field]);
  }
  assertRefused(await call('POST', '/recipes'), [{ path: 'body', rule: 'required' }]);
  // meal_types: anything but a list of texts, a text or null.
  const meal = await call('POST', '/recipes', { json: { title: 'A', meal_types: 5 } });
  assert.equal(meal.status, 400);
  assert.equal(meal.body.fields[0].path, 'body/meal_types');
});

test('recipes: the 400 comes before the 404 and the 403 of a mirrored recipe; ids are plain decimal digits', async () => {
  assertRefused(await call('PUT', '/recipes/999999', { json: { title: 5 } }), [{ path: 'body/title', rule: 'type' }]);
  const mirrored = Number(db.prepare("INSERT INTO recipes (title, provider_account_id, provider_recipe_id, created_by) VALUES ('Spiegel', ?, 'r1', ?)").run(ACCOUNT, ADMIN).lastInsertRowid);
  assertRefused(await call('PUT', `/recipes/${mirrored}`, { json: [] }), [{ path: 'body', rule: 'type' }]);
  const recipe = await newRecipe('Ids');
  for (const id of NOT_DIGITS) {
    for (const [method, route] of [['PUT', `/recipes/${id}`], ['DELETE', `/recipes/${id}`], ['GET', `/recipes/${id}/image`], ['GET', `/recipes/${id}/provider-thumbnail`]]) {
      assertRefused(await call(method, route, { json: method === 'PUT' ? { title: 'x' } : undefined }), [{ path: 'path/id', rule: 'type' }]);
    }
  }
  assert.ok(db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipe.id), 'DELETE /recipes/<id>abc deleted nothing');
  assertRefused(await call('GET', `/recipes/${recipe.id}/provider-thumbnail?v=a&v=b`), [{ path: 'query/v', rule: 'type' }]);
});

test('recipes: kept - null for "no value", meal_types as text, the handler\'s own refusals', async () => {
  const res = await call('POST', '/recipes', { json: { title: 'Suppe', notes: null, recipe_url: null, servings: null, meal_types: 'lunch,dinner', image_data: '', ingredients: [{ name: 'Wasser', quantity: null, category: null }] } });
  assertPassed(res, 201);
  assert.deepEqual(res.body.data.meal_types, ['lunch', 'dinner']);
  assertPassed(await call('POST', '/recipes', { json: { title: 'Ohne', meal_types: ['bogus'], unknown_key: 1 } }), 201);
  assertPassed(await call('POST', '/recipes', { json: { title: 'Alle', meal_types: null } }), 201);
  // What the schema cannot say: spaces only, a bad image, 0 as id.
  assertHandlerRefused(await call('POST', '/recipes', { json: { title: '   ' } }));
  assertHandlerRefused(await call('POST', '/recipes', { json: { title: 'A', image_data: 'not a data url' } }));
  assertHandlerRefused(await call('PUT', '/recipes/0', { json: { title: 'A' } }));
  // A full replace without ingredients stays allowed (documented).
  const recipe = await newRecipe('Ersetzen');
  const put = await call('PUT', `/recipes/${recipe.id}`, { json: { title: 'Ersetzt' } });
  assertPassed(put, 200);
  assert.equal(put.body.data.ingredients.length, 0);
});

test('to-shopping-list: listId a whole number, quantities texts or null, ingredientIds whole numbers from 1; 400 before 404', async () => {
  const recipe = await newRecipe('Liste');
  const route = `/recipes/${recipe.id}/to-shopping-list`;
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/listId', rule: 'required' }],
    [{ listId: null }, { path: 'body/listId', rule: 'type' }],
    [{ listId: String(LIST) }, { path: 'body/listId', rule: 'type' }],
    [{ listId: true }, { path: 'body/listId', rule: 'type' }],
    [{ listId: [LIST] }, { path: 'body/listId', rule: 'type' }],
    [{ listId: LIST, quantities: null }, { path: 'body/quantities', rule: 'type' }],
    [{ listId: LIST, quantities: [5] }, { path: 'body/quantities/0', rule: 'type' }],
    [{ listId: LIST, quantities: ['x'.repeat(101)] }, { path: 'body/quantities/0', rule: 'maxLength' }],
    [{ listId: LIST, ingredientIds: 'garbage' }, { path: 'body/ingredientIds', rule: 'type' }],
    [{ listId: LIST, ingredientIds: ['1'] }, { path: 'body/ingredientIds/0', rule: 'type' }],
    [{ listId: LIST, ingredientIds: [0] }, { path: 'body/ingredientIds/0', rule: 'minimum' }],
  ])) {
    assertRefused(await call('POST', route, { json }), [field]);
  }
  assertRefused(await call('POST', '/recipes/999999/to-shopping-list', { json: { listId: 'x' } }), [{ path: 'body/listId', rule: 'type' }]);
  // Kept: the handler's 404 for a list, its 400 for quantities without ids, its 409.
  const gone = await call('POST', route, { json: { listId: 999999 } });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.reason, 'shopping_list_not_found');
  assertHandlerRefused(await call('POST', route, { json: { listId: LIST, quantities: ['1 kg'] } }));
  const changed = await call('POST', route, { json: { listId: LIST, quantities: ['1 kg'], ingredientIds: [999999] } });
  assert.equal(changed.status, 409);
  assertPassed(await call('POST', route, { json: { listId: LIST } }), 200);
});

test('ingredient-match: name text, pantryItemId a whole number or null and not required; 400 before 404', async () => {
  const recipe = await newRecipe('Zuordnung');
  const item = await newPantryItem('Nudeln');
  const route = `/recipes/${recipe.id}/ingredient-match`;
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/name', rule: 'required' }],
    [{ name: ['Nudeln'] }, { path: 'body/name', rule: 'type' }],
    [{ name: 'x'.repeat(201) }, { path: 'body/name', rule: 'maxLength' }],
    [{ name: 'Nudeln', pantryItemId: String(item.id) }, { path: 'body/pantryItemId', rule: 'type' }],
    [{ name: 'Nudeln', pantryItemId: '' }, { path: 'body/pantryItemId', rule: 'type' }],
    [{ name: 'Nudeln', pantryItemId: true }, { path: 'body/pantryItemId', rule: 'type' }],
  ])) {
    assertRefused(await call('PUT', route, { json }), [field]);
  }
  assertRefused(await call('PUT', '/recipes/999999/ingredient-match', { json: { name: 5 } }), [{ path: 'body/name', rule: 'type' }]);
  assertPassed(await call('PUT', route, { json: { name: 'Nudeln', pantryItemId: item.id } }), 200);
  const cleared = await call('PUT', route, { json: { name: 'Nudeln' } });
  assertPassed(cleared, 200);
  assert.equal(cleared.body.data.pantry_item_id, null, 'left out clears, as documented');
  assertPassed(await call('PUT', route, { json: { name: ' NUDELN ', pantryItemId: null } }), 200);
});

// ── RECIPE PROVIDERS ────────────────────────────────────────────────────────

const URL_INVALID = 'recipe_providers_url_invalid';
const EXTERNAL_INVALID = 'recipe_providers_external_url_invalid';

test('providers: POST /accounts refuses types, an unknown provider and lengths; the url reasons through x-reason', async () => {
  const good = { name: 'Mealie', base_url: 'https://m.example', api_token: 'tok' };
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string, reason?: string }]>} */ ([
    [{}, { path: 'body/name', rule: 'required' }],
    [{ ...good, provider: 'bogus' }, { path: 'body/provider', rule: 'enum' }],
    [{ ...good, provider: null }, { path: 'body/provider', rule: 'type' }],
    [{ ...good, provider: ['tandoor'] }, { path: 'body/provider', rule: 'type' }],
    [{ ...good, name: 5 }, { path: 'body/name', rule: 'type' }],
    [{ ...good, name: 'x'.repeat(201) }, { path: 'body/name', rule: 'maxLength' }],
    [{ ...good, api_token: 5 }, { path: 'body/api_token', rule: 'type' }],
    [{ ...good, api_token: 'x'.repeat(501) }, { path: 'body/api_token', rule: 'maxLength' }],
    [{ ...good, base_url: 'ftp://m.example' }, { path: 'body/base_url', rule: 'pattern', reason: URL_INVALID }],
    [{ ...good, base_url: ' m.example' }, { path: 'body/base_url', rule: 'pattern', reason: URL_INVALID }],
    [{ ...good, base_url: 5 }, { path: 'body/base_url', rule: 'type' }],
    [{ ...good, base_url: ['https://m.example'] }, { path: 'body/base_url', rule: 'type' }],
    [{ ...good, base_url: `https://${'a'.repeat(1993)}` }, { path: 'body/base_url', rule: 'maxLength' }],
    [{ ...good, external_url: 'ftp://x' }, { path: 'body/external_url', rule: 'pattern', reason: EXTERNAL_INVALID }],
    [{ ...good, external_url: 0 }, { path: 'body/external_url', rule: 'type' }],
    [{ ...good, external_url: ['https://x'] }, { path: 'body/external_url', rule: 'type' }],
  ])) {
    assertRefused(await call('POST', '/recipe-providers/accounts', { json }), [field]);
  }
  // 400 before the 409 of an existing address.
  assertRefused(await call('POST', '/recipe-providers/accounts', { json: { ...good, base_url: 'https://mealie.example', provider: 'x' } }),
    [{ path: 'body/provider', rule: 'enum' }]);
});

test('providers: kept - upper case and padded addresses, "" as no external address, the handler\'s own reasons', async () => {
  const res = await call('POST', '/recipe-providers/accounts', { json: { name: 'A', base_url: '  HTTPS://a.example/', api_token: ' tok ', external_url: '' } });
  assertPassed(res, 201);
  assert.equal(res.body.data.base_url, 'HTTPS://a.example');
  assert.equal(res.body.data.provider, 'mealie', 'left out: mealie');
  assertPassed(await call('POST', '/recipe-providers/accounts', { json: { provider: 'tandoor', name: 'B', base_url: 'http://b.example', api_token: 't', external_url: null } }), 201);
  // Empty or spaces only: the handler's answer without a reason, not the url reason.
  assertHandlerRefused(await call('POST', '/recipe-providers/accounts', { json: { name: 'C', base_url: '', api_token: 't' } }));
  assertHandlerRefused(await call('POST', '/recipe-providers/accounts', { json: { name: 'C', base_url: '   ', api_token: 't' } }));
  assertHandlerRefused(await call('POST', '/recipe-providers/accounts', { json: { name: 'C', base_url: 'https://c.example', api_token: 't', external_url: '  ' } }));
  // State and network rules stay the handler's.
  assertHandlerRefused(await call('POST', '/recipe-providers/accounts', { json: { name: 'C', base_url: 'http://127.0.0.1', api_token: 't' } }), 'recipe_providers_private_network');
  const dup = await call('POST', '/recipe-providers/accounts', { json: { name: 'D', base_url: 'https://mealie.example/', api_token: 't' } });
  assert.equal(dup.status, 409);
});

test('providers: PATCH needs a body, enabled is a real boolean, 400 before 404', async () => {
  const route = `/recipe-providers/accounts/${ACCOUNT}`;
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string, reason?: string }]>} */ ([
    [[], { path: 'body', rule: 'type' }],
    [{ enabled: 'false' }, { path: 'body/enabled', rule: 'type' }],
    [{ enabled: null }, { path: 'body/enabled', rule: 'type' }],
    [{ enabled: 0 }, { path: 'body/enabled', rule: 'type' }],
    [{ name: 5 }, { path: 'body/name', rule: 'type' }],
    [{ external_url: 'ftp://x' }, { path: 'body/external_url', rule: 'pattern', reason: EXTERNAL_INVALID }],
    [{ external_url: true }, { path: 'body/external_url', rule: 'type' }],
  ])) {
    assertRefused(await call('PATCH', route, { json }), [field]);
  }
  assertRefused(await call('PATCH', route), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('PATCH', '/recipe-providers/accounts/999999', { json: { enabled: 'yes' } }), [{ path: 'body/enabled', rule: 'type' }]);
  const enabledBefore = db.prepare('SELECT enabled FROM recipe_provider_accounts WHERE id = ?').get(ACCOUNT).enabled;
  assert.equal(db.prepare('SELECT enabled FROM recipe_provider_accounts WHERE id = ?').get(ACCOUNT).enabled, enabledBefore, 'nothing written');
  // Kept: {} is a no-op, null and "" clear the external address, ids 0 and unknown are 404.
  assertPassed(await call('PATCH', route, { json: {} }), 200);
  assertPassed(await call('PATCH', route, { json: { enabled: false, external_url: '' } }), 200);
  assertPassed(await call('PATCH', route, { json: { external_url: null, name: 'Küche' } }), 200);
  assert.equal((await call('PATCH', '/recipe-providers/accounts/0', { json: {} })).status, 404);
  for (const id of NOT_DIGITS) {
    assertRefused(await call('DELETE', `/recipe-providers/accounts/${id}`), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('POST', `/recipe-providers/accounts/${id}/test`, { json: {} }), [{ path: 'path/id', rule: 'type' }]);
  }
  assert.ok(db.prepare('SELECT id FROM recipe_provider_accounts WHERE id = ?').get(ACCOUNT), 'no id spelling deleted the account');
});

test('providers: test and sync take {} or no body', async () => {
  for (const json of [{}, undefined]) {
    assertPassed(await call('POST', `/recipe-providers/accounts/${ACCOUNT}/test`, { json }), 200);
  }
  assertRefused(await call('POST', `/recipe-providers/accounts/${ACCOUNT}/test`, { json: [] }), [{ path: 'body', rule: 'type' }]);
  assert.equal((await call('POST', '/recipe-providers/accounts/999999/sync', { json: {} })).status, 404);
});

// ── PANTRY ──────────────────────────────────────────────────────────────────

test('pantry items: types, the unit enum, the day shape and lengths are a 400 with fields', async () => {
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/name', rule: 'required' }],
    [{ name: 5 }, { path: 'body/name', rule: 'type' }],
    [{ name: 'x'.repeat(201) }, { path: 'body/name', rule: 'maxLength' }],
    [{ name: 'R', quantity: '3' }, { path: 'body/quantity', rule: 'type' }],
    [{ name: 'R', quantity: true }, { path: 'body/quantity', rule: 'type' }],
    [{ name: 'R', quantity: null }, { path: 'body/quantity', rule: 'type' }],
    [{ name: 'R', quantity: -1 }, { path: 'body/quantity', rule: 'minimum' }],
    [{ name: 'R', unit: 'bogus' }, { path: 'body/unit', rule: 'enum' }],
    [{ name: 'R', unit: 'KG' }, { path: 'body/unit', rule: 'enum' }],
    [{ name: 'R', unit: null }, { path: 'body/unit', rule: 'type' }],
    [{ name: 'R', location_id: 'abc' }, { path: 'body/location_id', rule: 'anyOf' }],
    [{ name: 'R', location_id: '' }, { path: 'body/location_id', rule: 'anyOf' }],
    [{ name: 'R', location_id: 1.5 }, { path: 'body/location_id', rule: 'anyOf' }],
    [{ name: 'R', category: 5 }, { path: 'body/category', rule: 'type' }],
    [{ name: 'R', expires_on: 'x' }, { path: 'body/expires_on', rule: 'pattern' }],
    [{ name: 'R', expires_on: ['2026-12-31'] }, { path: 'body/expires_on', rule: 'type' }],
    [{ name: 'R', expires_on: 0 }, { path: 'body/expires_on', rule: 'type' }],
    [{ name: 'R', min_quantity: '2' }, { path: 'body/min_quantity', rule: 'type' }],
    [{ name: 'R', min_quantity: -1 }, { path: 'body/min_quantity', rule: 'minimum' }],
    [{ name: 'R', notes: 'x'.repeat(5001) }, { path: 'body/notes', rule: 'maxLength' }],
  ])) {
    const res = await call('POST', '/pantry', { json });
    if (field.rule === 'anyOf') {
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === field.path && f.rule === 'anyOf'), JSON.stringify(res.body));
      continue;
    }
    assertRefused(res, [field]);
  }
  assertRefused(await call('POST', '/pantry'), [{ path: 'body', rule: 'required' }]);
});

test('pantry items: 400 before 404; PATCH needs a body; ids are plain decimal digits', async () => {
  assertRefused(await call('PUT', '/pantry/999999', { json: { name: 5 } }), [{ path: 'body/name', rule: 'type' }]);
  assertRefused(await call('PATCH', '/pantry/999999', { json: { quantity: 'x' } }), [{ path: 'body/quantity', rule: 'type' }]);
  const item = await newPantryItem('Mehl');
  assertRefused(await call('PATCH', `/pantry/${item.id}`), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('PATCH', `/pantry/${item.id}`, { json: [] }), [{ path: 'body', rule: 'type' }]);
  // An unknown unit used to overwrite the stored one with pcs.
  assertRefused(await call('PATCH', `/pantry/${item.id}`, { json: { unit: 'bogus' } }), [{ path: 'body/unit', rule: 'enum' }]);
  assert.equal(db.prepare('SELECT unit FROM pantry_items WHERE id = ?').get(item.id).unit, 'kg');
  for (const id of NOT_DIGITS) {
    assertRefused(await call('DELETE', `/pantry/${id}`), [{ path: 'path/itemId', rule: 'type' }]);
    assertRefused(await call('DELETE', `/pantry/products/${id}`), [{ path: 'path/productId', rule: 'type' }]);
    assertRefused(await call('PUT', `/pantry/locations/${id}`, { json: { name: 'x' } }), [{ path: 'path/locId', rule: 'type' }]);
  }
  assert.ok(db.prepare('SELECT id FROM pantry_items WHERE id = ?').get(item.id), 'DELETE /pantry/<id>abc deleted nothing');
});

test('pantry items: kept - digit text as a legacy location, null where it means none or keep, the handler\'s own refusals', async () => {
  const legacy = await call('POST', '/pantry', { json: { name: 'Alt', quantity: 1, unit: 'pcs', location_id: String(LOCATION), category: CATEGORY, expires_on: null, notes: null } });
  assertPassed(legacy, 201);
  assert.equal(legacy.body.data.location_id, LOCATION);
  const item = await newPantryItem('Zucker');
  assertPassed(await call('PATCH', `/pantry/${item.id}`, { json: { quantity: 3 } }), 200);
  assertPassed(await call('PATCH', `/pantry/${item.id}`, { json: {} }), 200);
  const kept = await call('PATCH', `/pantry/${item.id}`, { json: { unit: null, category: null, location_id: null, expires_on: '', notes: null } });
  assertPassed(kept, 200);
  assert.equal(kept.body.data.unit, 'kg', 'null keeps the unit');
  assert.equal(kept.body.data.location_id, null, 'null clears the location');
  assertPassed(await call('PUT', `/pantry/${item.id}`, { json: { name: 'Zucker', unit: null, min_quantity: null } }), 200);
  // What the schema cannot say: a location that does not exist, a day that does not exist, a category outside the table, spaces only.
  assertHandlerRefused(await call('POST', '/pantry', { json: { name: 'R', location_id: 999999 } }));
  assertHandlerRefused(await call('POST', '/pantry', { json: { name: 'R', expires_on: '2026-02-30' } }));
  assertHandlerRefused(await call('POST', '/pantry', { json: { name: 'R', category: 'Gibt es nicht' } }));
  assertHandlerRefused(await call('POST', '/pantry', { json: { name: '   ' } }));
});

test('storage locations: name required and text, order a non-empty list of ids; the two 500s are a 400 now', async () => {
  for (const [method, route, json, field] of /** @type {Array<[string, string, unknown, { path: string, rule: string }]>} */ ([
    ['POST', '/pantry/locations', {}, { path: 'body/name', rule: 'required' }],
    ['POST', '/pantry/locations', { name: 5 }, { path: 'body/name', rule: 'type' }],
    ['POST', '/pantry/locations', { name: 'x'.repeat(101) }, { path: 'body/name', rule: 'maxLength' }],
    ['POST', '/pantry/locations', { name: 'Neu', icon: {} }, { path: 'body/icon', rule: 'type' }],
    ['PUT', `/pantry/locations/${LOCATION}`, { icon: 'box' }, { path: 'body/name', rule: 'required' }],
    ['PUT', '/pantry/locations/999999', {}, { path: 'body/name', rule: 'required' }],
    ['PATCH', '/pantry/locations/reorder', {}, { path: 'body/order', rule: 'required' }],
    ['PATCH', '/pantry/locations/reorder', { order: null }, { path: 'body/order', rule: 'type' }],
    ['PATCH', '/pantry/locations/reorder', { order: 'x' }, { path: 'body/order', rule: 'type' }],
    ['PATCH', '/pantry/locations/reorder', { order: [] }, { path: 'body/order', rule: 'minItems' }],
  ])) {
    assertRefused(await call(method, route, { json }), [field]);
  }
  // 400 before the 409 of an existing name.
  assertRefused(await call('POST', '/pantry/locations', { json: { name: 'Probekeller', icon: 5 } }), [{ path: 'body/icon', rule: 'type' }]);
  // `[{}]` was a RangeError and `[true]` a TypeError, both 500.
  for (const order of [[{}], [true], [null], [[1]], ['x'], [1.5]]) {
    const res = await call('PATCH', '/pantry/locations/reorder', { json: { order } });
    assert.equal(res.status, 400, JSON.stringify(order));
    assert.equal(res.body.reason, 'validation');
    assert.equal(res.body.fields[0].path, 'body/order/0');
  }
  // Kept: numbers and digit text (legacy), a name that exists is the handler's 409, the last location stays.
  assertPassed(await call('PATCH', '/pantry/locations/reorder', { json: { order: [LOCATION_2, LOCATION] } }), 200);
  assertPassed(await call('PATCH', '/pantry/locations/reorder', { json: { order: [String(LOCATION), String(LOCATION_2)] } }), 200);
  assert.equal((await call('POST', '/pantry/locations', { json: { name: 'probekeller' } })).status, 409);
  const deleted = await call('DELETE', `/pantry/locations/${LOCATION_2}`);
  assertPassed(deleted, 200);
  assert.deepEqual(Object.keys(deleted.body).sort(), ['ok', 'orphaned']);
});

test('import from the shopping list: list_id a whole number, items a list of rows, unit from the list; 400 before 404', async () => {
  const route = '/pantry/import-shopping';
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/list_id', rule: 'required' }],
    [{ list_id: String(LIST) }, { path: 'body/list_id', rule: 'type' }],
    [{ list_id: LIST, items: null }, { path: 'body/items', rule: 'type' }],
    [{ list_id: LIST, items: 'x' }, { path: 'body/items', rule: 'type' }],
    [{ list_id: LIST, items: {} }, { path: 'body/items', rule: 'type' }],
    [{ list_id: LIST, items: [null] }, { path: 'body/items/0', rule: 'type' }],
    [{ list_id: LIST, items: [{ shopping_item_id: '1' }] }, { path: 'body/items/0/shopping_item_id', rule: 'type' }],
    [{ list_id: LIST, items: [{ shopping_item_id: 1, quantity: 'x' }] }, { path: 'body/items/0/quantity', rule: 'type' }],
    [{ list_id: LIST, items: [{ shopping_item_id: 1, unit: 'bogus' }] }, { path: 'body/items/0/unit', rule: 'enum' }],
    [{ list_id: LIST, items: [{ shopping_item_id: 1, expires_on: 5 }] }, { path: 'body/items/0/expires_on', rule: 'type' }],
  ])) {
    assertRefused(await call('POST', route, { json }), [field]);
  }
  assertRefused(await call('POST', route, { json: { list_id: 999999, items: 'x' } }), [{ path: 'body/items', rule: 'type' }]);
  // Kept: the handler's 404, a bad day is dropped, the item still arrives.
  assert.equal((await call('POST', route, { json: { list_id: 999999, items: [] } })).status, 404);
  const id = checkedItem('Joghurt');
  const res = await call('POST', route, { json: { list_id: LIST, items: [{ shopping_item_id: id, quantity: 1, unit: 'pcs', location_id: String(LOCATION), expires_on: 'garbage' }] } });
  assertPassed(res, 200);
  assert.equal(res.body.data.added + res.body.data.merged, 1);
});

test('import from the shopping list: a location that does not exist is a 400 before anything is written (was a 500)', async () => {
  const first = checkedItem('Butter');
  const second = checkedItem('Käse');
  const before = pantryCount();
  for (const location_id of [999999, '999999']) {
    const res = await call('POST', '/pantry/import-shopping', {
      json: { list_id: LIST, items: [
        { shopping_item_id: first, quantity: 1, unit: 'pcs', location_id: LOCATION },
        { shopping_item_id: second, quantity: 1, unit: 'pcs', location_id },
      ] },
    });
    assertHandlerRefused(res);
    assert.equal(res.body.error, 'Location not found.');
    assert.equal(pantryCount(), before, 'no row taken over, not even the good one');
  }
  // A row that is not taken over (unchecked or gone) does not need its place.
  const skipped = await call('POST', '/pantry/import-shopping', { json: { list_id: LIST, items: [{ shopping_item_id: 999999, location_id: 999999 }] } });
  assertPassed(skipped, 200);
  assert.equal(skipped.body.data.skipped, 1);
});

test('undo of an import: changes a list of the server\'s own entries', async () => {
  const route = '/pantry/import-shopping/undo';
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string }]>} */ ([
    [{}, { path: 'body/changes', rule: 'required' }],
    [{ changes: null }, { path: 'body/changes', rule: 'type' }],
    [{ changes: 'x' }, { path: 'body/changes', rule: 'type' }],
    [{ changes: [1] }, { path: 'body/changes/0', rule: 'type' }],
    [{ changes: [{ kind: 'added' }] }, { path: 'body/changes/0/pantry_item_id', rule: 'required' }],
    [{ changes: [{ pantry_item_id: '65', kind: 'added' }] }, { path: 'body/changes/0/pantry_item_id', rule: 'type' }],
    [{ changes: [{ pantry_item_id: 1, kind: 'removed' }] }, { path: 'body/changes/0/kind', rule: 'enum' }],
    [{ changes: [{ pantry_item_id: 1, kind: 'merged', quantity_added: '1' }] }, { path: 'body/changes/0/quantity_added', rule: 'type' }],
    [{ changes: [{ pantry_item_id: 1, kind: 'merged', quantity_added: 1, expires_set: 'true' }] }, { path: 'body/changes/0/expires_set', rule: 'type' }],
  ])) {
    assertRefused(await call('POST', route, { json }), [field]);
  }
  assertRefused(await call('POST', route), [{ path: 'body', rule: 'required' }]);
  assertPassed(await call('POST', route, { json: { changes: [] } }), 200);
  // The round trip with the server's own answer.
  const id = checkedItem('Milch');
  const done = await call('POST', '/pantry/import-shopping', { json: { list_id: LIST, items: [{ shopping_item_id: id, quantity: 1, unit: 'l', location_id: null }] } });
  assertPassed(done, 200);
  const undo = await call('POST', route, { json: { changes: done.body.data.changes } });
  assertPassed(undo, 200);
  assert.equal(undo.body.data.removed + undo.body.data.reduced, 1);
});

// ── THE OWN FRONTEND ────────────────────────────────────────────────────────

/**
 * The middleware of the app document for one operation, called as Express
 * would: true when it lets the request through.
 * @param {string} method
 * @param {string} mount
 * @param {string} pattern
 * @param {{ params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }} request
 */
function passes(method, mount, pattern, { params = {}, query = {}, body } = {}) {
  /** @type {unknown} */
  let outcome = 'not called';
  const req = { method, baseUrl: mount, route: { path: pattern }, params, query, body };
  validateRequest()(req, {}, (/** @type {unknown} */ err) => { outcome = err; });
  if (outcome === undefined) return true;
  const fields = /** @type {any} */ (outcome)?.fields ?? /** @type {any} */ (outcome)?.details?.fields;
  return JSON.stringify(fields ?? outcome);
}

const RECIPE_FORM = {
  title: 'Pasta', notes: null, recipe_url: null, meal_types: ['lunch', 'dinner'], servings: 4,
  ingredients: [{ name: 'Nudeln', quantity: '500 g', category: 'Trockenwaren' }, { name: 'Salz', quantity: null, category: 'Sonstiges' }],
};
const PANTRY_FORM = { name: 'Reis', quantity: 1.5, unit: 'kg', location_id: 2, category: 'Trockenwaren', expires_on: '2026-12-31', notes: null };
const R = '/api/v1/recipes';
const P = '/api/v1/pantry';
const RP = '/api/v1/recipe-providers';

/**
 * Each entry: where it is sent from, the operation and the request exactly as
 * that call site builds it (the inventory of #2810, "Frontend callers").
 * @type {Array<[string, string, string, string, { params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }]>}
 */
const FRONTEND_CALLS = [
  ['recipes.js list', 'GET', R, '/', {}],
  ['recipes.js create', 'POST', R, '/', { body: RECIPE_FORM }],
  ['recipes.js create with image', 'POST', R, '/', { body: { ...RECIPE_FORM, image_data: 'data:image/png;base64,iVBORw0KGgo=' } }],
  ['recipes.js create removing the image, no servings, no meals', 'POST', R, '/', { body: { ...RECIPE_FORM, servings: null, meal_types: [], image_data: null } }],
  ['recipes.js duplicate', 'POST', R, '/', { body: { title: 'Pasta (Kopie)', notes: 'n', recipe_url: null, servings: null, ingredients: RECIPE_FORM.ingredients } }],
  ['meals.js save as recipe', 'POST', R, '/', { body: { title: 'Eintopf', notes: null, recipe_url: null, ingredients: [{ name: 'Linsen', quantity: null, category: 'Sonstiges' }] } }],
  ['recipes.js edit', 'PUT', R, '/:id', { params: { id: '7' }, body: RECIPE_FORM }],
  ['recipes.js delete', 'DELETE', R, '/:id', { params: { id: '7' } }],
  ['recipe-thumb.js own image', 'GET', R, '/:id/image', { params: { id: '7' } }],
  ['recipe-thumb.js provider image', 'GET', R, '/:id/provider-thumbnail', { params: { id: '7' }, query: { v: '2026-11-18T10:00:00Z' } }],
  ['kitchen-transfer.js to the list', 'POST', R, '/:id/to-shopping-list', { params: { id: '7' }, body: { listId: 3 } }],
  ['recipes.js scaled to the list', 'POST', R, '/:id/to-shopping-list', { params: { id: '7' }, body: { listId: 3, quantities: ['1 kg', null], ingredientIds: [11, 12] } }],
  ['recipes.js confirm a match', 'PUT', R, '/:id/ingredient-match', { params: { id: '7' }, body: { name: 'Reis', pantryItemId: 4 } }],
  ['recipes.js clear a match', 'PUT', R, '/:id/ingredient-match', { params: { id: '7' }, body: { name: 'Reis', pantryItemId: null } }],
  ['modules-kitchen.js status', 'GET', RP, '/status', {}],
  ['modules-kitchen.js delete', 'DELETE', RP, '/accounts/:id', { params: { id: '2' } }],
  ['modules-kitchen.js sync', 'POST', RP, '/accounts/:id/sync', { params: { id: '2' }, body: {} }],
  ['api.js test', 'POST', RP, '/accounts/:id/test', { params: { id: '2' }, body: {} }],
  ['api.js list', 'GET', RP, '/accounts', {}],
  ['modules-kitchen.js toggle', 'PATCH', RP, '/accounts/:id', { params: { id: '2' }, body: { enabled: false } }],
  ['modules-kitchen.js external url', 'PATCH', RP, '/accounts/:id', { params: { id: '2' }, body: { external_url: 'https://recipes.example' } }],
  ['modules-kitchen.js clear external url', 'PATCH', RP, '/accounts/:id', { params: { id: '2' }, body: { external_url: '' } }],
  ['modules-kitchen.js create', 'POST', RP, '/accounts', { body: { provider: 'tandoor', name: 'Tandoor', base_url: 'http://tandoor:8080', external_url: '', api_token: ' untrimmed ' } }],
  ['pantry.js list', 'GET', P, '/', {}],
  ['pantry.js create', 'POST', P, '/', { body: PANTRY_FORM }],
  ['pantry.js create without place and day, minimum changed', 'POST', P, '/', { body: { ...PANTRY_FORM, location_id: null, expires_on: null, min_quantity: 2 } }],
  ['pantry.js edit, minimum cleared', 'PUT', P, '/:itemId', { params: { itemId: '9' }, body: { ...PANTRY_FORM, min_quantity: null } }],
  ['pantry.js stepper', 'PATCH', P, '/:itemId', { params: { itemId: '9' }, body: { quantity: 2.5 } }],
  ['pantry.js delete', 'DELETE', P, '/:itemId', { params: { itemId: '9' } }],
  ['pantry.js delete product', 'DELETE', P, '/products/:productId', { params: { productId: '9' } }],
  ['category-manager.js locations', 'GET', P, '/locations', {}],
  ['category-manager.js add location', 'POST', P, '/locations', { body: { name: 'Keller' } }],
  ['category-manager.js rename location', 'PUT', P, '/locations/:locId', { params: { locId: '3' }, body: { name: 'Vorratsraum' } }],
  ['category-manager.js reorder (numbers)', 'PATCH', P, '/locations/reorder', { body: { order: [5, 3, 1] } }],
  ['category-manager.js delete location', 'DELETE', P, '/locations/:locId', { params: { locId: '3' } }],
  ['shopping.js take over', 'POST', P, '/import-shopping', { body: { list_id: 3, items: [{ shopping_item_id: 8, quantity: 1, unit: 'pcs', location_id: 2 }, { shopping_item_id: 9, quantity: 2, unit: 'l', location_id: null }] } }],
  ['shopping.js undo', 'POST', P, '/import-shopping/undo', { body: { changes: [{ pantry_item_id: 4, kind: 'added' }, { pantry_item_id: 5, kind: 'merged', quantity_added: 1, expires_set: false }] } }],
  // Service workers of older app versions: digit text, a legacy form.
  ['legacy pantry.js create (digit text)', 'POST', P, '/', { body: { ...PANTRY_FORM, location_id: '2' } }],
  ['legacy shopping.js take over (digit text)', 'POST', P, '/import-shopping', { body: { list_id: 3, items: [{ shopping_item_id: 8, quantity: 1, unit: 'pcs', location_id: '2' }] } }],
  ['legacy category-manager.js reorder (digit text)', 'PATCH', P, '/locations/reorder', { body: { order: ['5', '3', '1'] } }],
];

for (const [site, method, mount, pattern, request] of FRONTEND_CALLS) {
  test(`the own frontend passes the schema: ${site}`, () => {
    assert.equal(passes(method, mount, pattern, request), true);
  });
}

// That the app sends these numbers is held where its code runs: the save click
// of the pantry form (test:pantry-ux), the confirm click of the take-over
// (test:shopping-readonly-ui) and the location manager's order with the
// pantry page as its only `numericKeys` caller (test:category-manager).

// ── ONE SOURCE ──────────────────────────────────────────────────────────────

const { buildOpenApiSpec } = await import('../server/openapi.js');
const { PANTRY_UNITS } = await import('../public/utils/pantry-units.js');
const { DATE_PATTERN } = await import('../server/utils/datetime-pattern.js');
const SPEC = buildOpenApiSpec();

/** @param {string} path @param {string} method */
const bodySchema = (path, method) => SPEC.paths[path][method].requestBody.content['application/json'].schema;
/** @param {unknown[]} values */
const asSet = (values) => [...new Set(values.filter((v) => v !== null))].sort();

test('pantry: every unit enum of the document is exactly PANTRY_UNITS', () => {
  assert.ok(PANTRY_UNITS.length >= 5, 'PANTRY_UNITS is read');
  const enums = [
    bodySchema('/api/v1/pantry', 'post').properties.unit.enum,
    bodySchema('/api/v1/pantry/{itemId}', 'put').properties.unit.enum,
    bodySchema('/api/v1/pantry/{itemId}', 'patch').properties.unit.enum,
    bodySchema('/api/v1/pantry/import-shopping', 'post').properties.items.items.properties.unit.enum,
  ];
  for (const values of enums) {
    assert.equal(values.filter((/** @type {unknown} */ v) => v !== null).length, new Set(values).size - (values.includes(null) ? 1 : 0), 'no unit twice');
    assert.deepEqual(asSet(values), asSet([...PANTRY_UNITS]));
  }
});

test('providers: the provider enum of the document is exactly SUPPORTED_PROVIDERS', () => {
  assert.deepEqual(asSet(bodySchema('/api/v1/recipe-providers/accounts', 'post').properties.provider.enum), asSet([...SUPPORTED_PROVIDERS]));
});

test('pantry: the expires_on pattern is the day key of the hand check, or empty', () => {
  const day = new RegExp(DATE_PATTERN);
  for (const [path, method] of [['/api/v1/pantry', 'post'], ['/api/v1/pantry/{itemId}', 'put'], ['/api/v1/pantry/{itemId}', 'patch']]) {
    const pattern = new RegExp(bodySchema(path, method).properties.expires_on.pattern);
    for (const sample of ['', '2026-11-18', '2026-02-31', '9999-99-99', 'x', '2026-11-18 ', '2026-1-18', '2026-11-18T00:00']) {
      assert.equal(pattern.test(sample), sample === '' || day.test(sample), `${method} ${path} ${JSON.stringify(sample)}`);
    }
  }
  assert.equal(bodySchema('/api/v1/pantry/import-shopping', 'post').properties.items.items.properties.expires_on.pattern, undefined,
    'the import drops a bad day and keeps the row: no pattern there');
});

test('recipes: the image length of the document is the route\'s own limit', () => {
  for (const [path, method] of [['/api/v1/recipes', 'post'], ['/api/v1/recipes/{id}', 'put']]) {
    assert.equal(bodySchema(path, method).properties.image_data.maxLength, MAX_RECIPE_IMAGE_LENGTH);
  }
});

// Since step (b) of group 2A the handler no longer checks these itself: the
// schema is their only guard, so it is held to the one source here.

test('recipes: the servings bounds of the document are the CHECK of the column (1 to 99)', () => {
  // The insert never stays: the transaction throws after it and rolls back.
  const UNDONE = new Error('undone');
  const probe = db.transaction((/** @type {number} */ value) => {
    db.prepare("INSERT INTO recipes (title, servings, created_by) VALUES ('Probe', ?, ?)").run(value, ADMIN);
    throw UNDONE;
  });
  for (const [path, method] of [['/api/v1/recipes', 'post'], ['/api/v1/recipes/{id}', 'put']]) {
    const { minimum, maximum } = bodySchema(path, method).properties.servings;
    assert.ok(Number.isInteger(minimum) && Number.isInteger(maximum), `${method} ${path}: bounds are set`);
    for (const value of [minimum - 1, minimum, maximum, maximum + 1]) {
      let stored = false;
      try {
        probe(value);
      } catch (err) {
        if (err === UNDONE) stored = true;
        else assert.match(String(/** @type {Error} */ (err).message), /CHECK constraint/);
      }
      assert.equal(stored, value >= minimum && value <= maximum, `${method} ${path}: servings ${value}`);
    }
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recipes WHERE title = 'Probe'").get().n, 0, 'nothing stayed');
});

test('pantry: the kind enum of the undo is exactly the kinds a take-over answers', async () => {
  const list = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Kinds', ?)").run(ADMIN).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, 'Kindprobe', 1)").run(list).lastInsertRowid);
  const kinds = new Set();
  for (let i = 0; i < 2; i++) {
    const res = await call('POST', '/pantry/import-shopping', { json: { list_id: list, items: [{ shopping_item_id: item }] } });
    assertPassed(res, 200);
    for (const change of res.body.data.changes) kinds.add(change.kind);
  }
  const schema = bodySchema('/api/v1/pantry/import-shopping/undo', 'post').properties.changes.items;
  assert.deepEqual(asSet(schema.properties.kind.enum), asSet([...kinds]), 'added on the first take-over, merged on the second');
  assert.deepEqual(asSet(schema.required), ['kind', 'pantry_item_id']);
});

test('pantry: quantity and min_quantity are refused below 0 by the document', () => {
  for (const [path, method] of [['/api/v1/pantry', 'post'], ['/api/v1/pantry/{itemId}', 'put'], ['/api/v1/pantry/{itemId}', 'patch']]) {
    const { properties } = bodySchema(path, method);
    assert.equal(properties.quantity.minimum, 0, `${method} ${path} quantity`);
    assert.equal(properties.min_quantity.minimum, 0, `${method} ${path} min_quantity`);
  }
});
