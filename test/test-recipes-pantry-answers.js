/**
 * Test: the answers of recipes, recipe providers and pantry stay byte-equal (#2810, phase 2 section E, group 2A)
 * Purpose: the three route files dropped the hand checks the schema of their
 *          operation already covers (`validateRequest()` runs before every
 *          handler since #2826) and the try/catch blocks that answered an
 *          unexpected error with a 500 of their own. That is a refactor, and
 *          this suite holds it: for a table of requests to all 29 routes -
 *          valid, every refusal of the handler that stays, every input a
 *          dropped hand check refused (now the schema's 400), not found,
 *          gated, conflict - it pins status and the WHOLE answer body. The
 *          expectations were written at the state before the refactor
 *          (95b65acc5) and are literal here, no fixture file, no update mode.
 *          Two answers changed on purpose and stand apart in CHANGED: the
 *          ingredient label of PUT /recipes/{id}/ingredient-match is English
 *          now ("Ingredient ..." instead of "Zutat ..."). Part 4 of #1448 added
 *          `pantry_product_id` and `pantry_product_name` to every recipe
 *          ingredient and to the answer of ingredient-match (a match names the
 *          household product now), and `match_count` to every product of
 *          GET /pantry; those rows carry the new fields in place,
 *          everything else in them is the answer from before. Only values that
 *          follow a clock this suite does not hold (SQLite's own `now`) are
 *          replaced by a marker before the comparison.
 *
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC) and the
 *          household lives in Europe/Berlin (`household_timezone`): the pantry
 *          writes best-before reminders from "today". The recipe provider is a
 *          stub behind `_setAdapterFactory`.
 *
 *          The second part: an unexpected error in each file reaches the
 *          central error handler - 500 with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps
 *          answering (the seven recipe routes said "Internal error" before).
 *          What stays the route's own: the 409 of a duplicate provider address,
 *          the 502 of a provider that refuses the connection, and the 404/502
 *          of the thumbnail proxy.
 * Run: npm run test:recipes-pantry-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
delete process.env.RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { default: recipeProvidersRouter } = await import('../server/routes/recipe-providers.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');
const { _setAdapterFactory } = await import('../server/services/recipe-providers/index.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

/**
 * @param {string} username
 * @param {string} role
 */
function user(username, role) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, 'parent')
  `).run(username, username, role).lastInsertRowid);
}

const ADMIN = user('linda', 'admin');
const MEMBER = user('tom', 'member');

// ── The recipe provider behind the adapter factory: no network ──

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const provider = { mode: 'ok' };
_setAdapterFactory(() => ({
  testConnection: async () => (provider.mode === 'refuse'
    ? { ok: false, status: 401, error: 'HTTP 401' }
    : provider.mode === 'private'
      ? { ok: false, error: 'URL resolves to a private IP address' }
      : { ok: true, status: 200 }),
  listRecipeSummaries: async () => [],
  getRecipe: async () => null,
  recipeUrl: () => null,
  fetchThumbnail: async () => {
    if (provider.mode === 'none') throw Object.assign(new Error('none'), { status: 404 });
    if (provider.mode === 'throw') throw new Error('socket hang up');
    if (provider.mode === 'svg') return { buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' };
    return { buffer: JPEG_BYTES, mime: 'image/jpeg; charset=binary' };
  },
}));

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};

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
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => {
  server.close();
  _setAdapterFactory(null);
});

const NO_BODY = Symbol('no body');

/**
 * @typedef {{ actor?: 'member', access?: Record<string, string>, raw?: boolean }} CallOptions
 */

/**
 * A JSON answer as it is; anything else as its type and length.
 * @param {string} method
 * @param {string} path
 * @param {unknown} body a JSON value, raw JSON text (`raw`) or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { actor, access, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (actor) headers['x-actor'] = actor;
  if (access) headers['x-access'] = JSON.stringify(access);
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === NO_BODY ? undefined : raw ? /** @type {string} */ (body) : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  if (buf.length === 0) return { status: res.status, body: null };
  if (type.startsWith('application/json')) return { status: res.status, body: JSON.parse(buf.toString('utf8')) };
  return { status: res.status, body: { type, length: buf.length } };
}

// Timestamps SQLite writes from its own clock ('now'), not from Date.
const VOLATILE = new Set(['created_at', 'updated_at', 'confirmed_at']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => (VOLATILE.has(key) && v !== null ? '<clock>' : v));
}

// ── Seed: the database starts empty, so every id below is the same on every run ──

const JPEG = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
const PNG_LABEL_JPEG = `data:image/png;base64,${JPEG_BYTES.toString('base64')}`;
const LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)").run(ADMIN).lastInsertRowid);
const MILK = Number(db.prepare("INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Milch', 'Milchprodukte')").run(LIST).lastInsertRowid);
const BREAD = Number(db.prepare("INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, 'Brot', 'Backwaren', 1)").run(LIST).lastInsertRowid);
const EGGS = Number(db.prepare("INSERT INTO shopping_items (list_id, name, category, is_checked) VALUES (?, 'Eier', 'Gibt es nicht', 1)").run(LIST).lastInsertRowid);
const MIRROR_ACCOUNT = Number(db.prepare(`
  INSERT INTO recipe_provider_accounts (provider, name, base_url, api_token, created_by)
  VALUES ('mealie', 'Mealie', 'https://mealie.example', 'secret', ?)
`).run(ADMIN).lastInsertRowid);
const MIRROR = Number(db.prepare(`
  INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_slug, provider_has_image, provider_updated_at)
  VALUES ('Gespiegelt', ?, ?, 'r1', 'gespiegelt', 1, '2026-11-01T10:00:00Z')
`).run(ADMIN, MIRROR_ACCOUNT).lastInsertRowid);
const BROKEN_IMAGE = Number(db.prepare("INSERT INTO recipes (title, image_data, created_by) VALUES ('Kaputt', 'nicht lesbar', ?)").run(ADMIN).lastInsertRowid);

const EMOJI_150 = '😀'.repeat(150); // 150 code points, 300 UTF-16 units
const EMOJI_51 = '😀'.repeat(51); // 51 code points, 102 UTF-16 units
const HUGE = '9'.repeat(400);

/** The ids of the ingredient rows of a recipe, in the order the route reads them. */
const ingredientIds = (/** @type {number} */ recipe) => db.prepare('SELECT id FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(recipe).map((/** @type {any} */ r) => r.id);
/** The id of a storage location by name. */
const location = (/** @type {string} */ name) => db.prepare('SELECT id FROM pantry_locations WHERE name = ?').get(name).id;
/** The newest pantry batch of a name. */
const batch = (/** @type {string} */ name) => db.prepare('SELECT id FROM pantry_items WHERE name = ? ORDER BY id DESC').get(name).id;

const PROVIDER = { provider: 'tandoor', name: 'Tandoor', base_url: ' https://tandoor.example/ ', api_token: ' tok ', external_url: 'https://open.example/' };
const ACCOUNT = { name: 'Zweites', base_url: 'https://second.example', api_token: 'tok' };
const ITEM = { name: 'Reis', quantity: 2, unit: 'kg', category: 'Sonstiges', expires_on: '2027-01-31', min_quantity: 1, notes: 'Basmati' };

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a body that is a function is called when its row runs.
 * @type {Array<[string, string, string, unknown, CallOptions?] | (() => void)>}
 */
const STEPS = [
  // ── recipes: create ───────────────────────────────────────────────────────
  ['rec list empty-ish', 'GET', '/recipes', NO_BODY],
  ['rec create', 'POST', '/recipes', {
    title: ' Pfannkuchen ', notes: 'Lecker', recipe_url: 'https://example.org/p', meal_types: ['breakfast', 'nope'], servings: 4, image_data: JPEG,
    ingredients: [{ name: 'Mehl', quantity: '200 g', category: 'Backwaren' }, { name: ' Milch ', quantity: null }, { name: '  ' }, { quantity: '1' }, {}],
  }],
  ['rec create plain', 'POST', '/recipes', { title: 'Brot' }],
  ['rec create no body', 'POST', '/recipes', NO_BODY],
  ['rec create array body', 'POST', '/recipes', []],
  ['rec create text body', 'POST', '/recipes', '"Brot"', { raw: true }],
  ['rec create empty object', 'POST', '/recipes', {}],
  ['rec create title empty', 'POST', '/recipes', { title: '' }],
  ['rec create title spaces', 'POST', '/recipes', { title: '   ' }],
  ['rec create title number', 'POST', '/recipes', { title: 5 }],
  ['rec create title 201', 'POST', '/recipes', { title: 'a'.repeat(201) }],
  ['rec create title padded 200', 'POST', '/recipes', { title: ` ${'a'.repeat(200)} ` }],
  ['rec create title emoji', 'POST', '/recipes', { title: EMOJI_150 }],
  ['rec create notes 5001', 'POST', '/recipes', { title: 'x', notes: 'a'.repeat(5001) }],
  ['rec create notes number', 'POST', '/recipes', { title: 'x', notes: 5 }],
  ['rec create url list', 'POST', '/recipes', { title: 'x', recipe_url: ['a'] }],
  ['rec create meal text', 'POST', '/recipes', { title: 'Abendbrot', meal_types: 'dinner,snack' }],
  ['rec create meal number', 'POST', '/recipes', { title: 'x', meal_types: 5 }],
  ['rec create ingredients null', 'POST', '/recipes', { title: 'x', ingredients: null }],
  ['rec create ingredients text', 'POST', '/recipes', { title: 'x', ingredients: 'Mehl' }],
  ['rec create ingredients object', 'POST', '/recipes', { title: 'x', ingredients: { name: 'Mehl' } }],
  ['rec create ingredients number entry', 'POST', '/recipes', { title: 'x', ingredients: [1] }],
  ['rec create ingredients null entry', 'POST', '/recipes', { title: 'x', ingredients: [null, { name: 'Mehl' }] }],
  ['rec create ingredients list entry', 'POST', '/recipes', { title: 'x', ingredients: [[{ name: 'Mehl' }]] }],
  ['rec create ingredient name number', 'POST', '/recipes', { title: 'x', ingredients: [{ name: 5 }] }],
  ['rec create ingredient quantity number', 'POST', '/recipes', { title: 'x', ingredients: [{ name: 'Mehl', quantity: 5 }] }],
  ['rec create servings text', 'POST', '/recipes', { title: 'x', servings: '4' }],
  ['rec create servings empty', 'POST', '/recipes', { title: 'x', servings: '' }],
  ['rec create servings true', 'POST', '/recipes', { title: 'x', servings: true }],
  ['rec create servings list', 'POST', '/recipes', { title: 'x', servings: [4] }],
  ['rec create servings zero', 'POST', '/recipes', { title: 'x', servings: 0 }],
  ['rec create servings 100', 'POST', '/recipes', { title: 'x', servings: 100 }],
  ['rec create servings negative', 'POST', '/recipes', { title: 'x', servings: -1 }],
  ['rec create servings fraction', 'POST', '/recipes', { title: 'x', servings: 2.5 }],
  ['rec create servings infinite', 'POST', '/recipes', '{"title":"x","servings":1e400}', { raw: true }],
  ['rec create servings 1', 'POST', '/recipes', { title: 'Eins', servings: 1 }],
  ['rec create servings 99.0', 'POST', '/recipes', '{"title":"Viele","servings":99.0}', { raw: true }],
  ['rec create servings null', 'POST', '/recipes', { title: 'Ohne', servings: null, image_data: '' }],
  ['rec create image number', 'POST', '/recipes', { title: 'x', image_data: 5 }],
  ['rec create image text', 'POST', '/recipes', { title: 'x', image_data: 'data:text/plain;base64,AAAA' }],
  ['rec create image mismatch', 'POST', '/recipes', { title: 'x', image_data: PNG_LABEL_JPEG }],

  // ── recipes: read, replace, image, delete ─────────────────────────────────
  ['rec list', 'GET', '/recipes', NO_BODY],
  ['rec list no pantry', 'GET', '/recipes', NO_BODY, { actor: 'member', access: { pantry: 'none' } }],
  ['rec put', 'PUT', '/recipes/3', { title: 'Pfannkuchen fein', ingredients: [{ name: 'Mehl', quantity: '250 g' }, { name: 'Ei', quantity: '2' }] }],
  ['rec put servings cleared', 'PUT', '/recipes/3', { title: 'Pfannkuchen fein', servings: null, image_data: null, meal_types: 'lunch', ingredients: [{ name: 'Mehl', quantity: '250 g' }, { name: 'Ei', quantity: '2' }] }],
  ['rec put servings back', 'PUT', '/recipes/3', { title: 'Pfannkuchen fein', servings: 6, image_data: JPEG, ingredients: [{ name: 'Mehl', quantity: '250 g' }, { name: 'Ei', quantity: '2' }] }],
  ['rec put no body', 'PUT', '/recipes/3', NO_BODY],
  ['rec put array body', 'PUT', '/recipes/3', [{ title: 'x' }]],
  ['rec put ingredients text', 'PUT', '/recipes/3', { title: 'x', ingredients: 'Mehl' }],
  ['rec put ingredients null', 'PUT', '/recipes/3', { title: 'x', ingredients: null }],
  ['rec put servings empty', 'PUT', '/recipes/3', { title: 'x', servings: '' }],
  ['rec put servings 100', 'PUT', '/recipes/3', { title: 'x', servings: 100 }],
  ['rec put servings text', 'PUT', '/recipes/3', { title: 'x', servings: 'vier' }],
  ['rec put title spaces', 'PUT', '/recipes/3', { title: '  ' }],
  ['rec put zero', 'PUT', '/recipes/0', { title: 'x' }],
  ['rec put unknown', 'PUT', '/recipes/999', { title: 'x' }],
  ['rec put letters', 'PUT', '/recipes/abc', { title: 'x' }],
  ['rec put huge', 'PUT', `/recipes/${HUGE}`, { title: 'x' }],
  ['rec put mirrored', 'PUT', `/recipes/${MIRROR}`, { title: 'x' }],
  ['rec put mirrored bad body', 'PUT', `/recipes/${MIRROR}`, { title: 5 }],
  ['rec image', 'GET', '/recipes/3/image', NO_BODY],
  ['rec image none', 'GET', `/recipes/${MIRROR}/image`, NO_BODY],
  ['rec image unreadable', 'GET', `/recipes/${BROKEN_IMAGE}/image`, NO_BODY],
  ['rec image zero', 'GET', '/recipes/0/image', NO_BODY],
  ['rec image unknown', 'GET', '/recipes/999/image', NO_BODY],
  ['rec image letters', 'GET', '/recipes/abc/image', NO_BODY],
  ['rec delete zero', 'DELETE', '/recipes/0', NO_BODY],
  ['rec delete letters', 'DELETE', '/recipes/1e2', NO_BODY],
  ['rec delete unknown', 'DELETE', '/recipes/999', NO_BODY],
  ['rec delete mirrored', 'DELETE', `/recipes/${MIRROR}`, NO_BODY],
  ['rec delete', 'DELETE', '/recipes/4', NO_BODY],
  ['rec delete again', 'DELETE', '/recipes/4', NO_BODY],

  // ── recipes: provider thumbnail ───────────────────────────────────────────
  ['thumb ok', 'GET', `/recipes/${MIRROR}/provider-thumbnail?v=1`, NO_BODY],
  ['thumb native', 'GET', '/recipes/3/provider-thumbnail', NO_BODY],
  ['thumb zero', 'GET', '/recipes/0/provider-thumbnail', NO_BODY],
  ['thumb unknown', 'GET', '/recipes/999/provider-thumbnail', NO_BODY],
  ['thumb letters', 'GET', '/recipes/abc/provider-thumbnail', NO_BODY],
  ['thumb v twice', 'GET', `/recipes/${MIRROR}/provider-thumbnail?v=1&v=2`, NO_BODY],
  () => { provider.mode = 'none'; },
  ['thumb provider 404', 'GET', `/recipes/${MIRROR}/provider-thumbnail`, NO_BODY],
  () => { provider.mode = 'throw'; },
  ['thumb provider fails', 'GET', `/recipes/${MIRROR}/provider-thumbnail`, NO_BODY],
  () => { provider.mode = 'svg'; },
  ['thumb provider svg', 'GET', `/recipes/${MIRROR}/provider-thumbnail`, NO_BODY],
  () => { provider.mode = 'ok'; },

  // ── recipes: to the shopping list ─────────────────────────────────────────
  ['shop transfer', 'POST', '/recipes/3/to-shopping-list', { listId: LIST }],
  ['shop transfer again', 'POST', '/recipes/3/to-shopping-list', { listId: LIST }],
  ['shop transfer scaled', 'POST', '/recipes/3/to-shopping-list', () => ({ listId: LIST, quantities: [' 500 g ', null], ingredientIds: ingredientIds(3) })],
  ['shop transfer empty recipe', 'POST', '/recipes/5/to-shopping-list', { listId: LIST }],
  ['shop ids stale', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['1', '2'], ingredientIds: [1, 2] }],
  ['shop ids short', 'POST', '/recipes/3/to-shopping-list', () => ({ listId: LIST, quantities: ['1', '2'], ingredientIds: ingredientIds(3).slice(0, 1) })],
  ['shop ids missing', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['1', '2'] }],
  ['shop ids unsafe', 'POST', '/recipes/3/to-shopping-list', `{"listId":${LIST},"quantities":["1"],"ingredientIds":[1e20]}`, { raw: true }],
  ['shop ids zero', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['1'], ingredientIds: [0] }],
  ['shop ids fraction', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['1'], ingredientIds: [1.5] }],
  ['shop ids text', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['1'], ingredientIds: ['1'] }],
  ['shop ids text without quantities', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, ingredientIds: ['x'] }],
  ['shop quantities null', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: null }],
  ['shop quantities text', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: '1' }],
  ['shop quantities number entry', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: [5], ingredientIds: [1] }],
  ['shop quantities long', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: ['a'.repeat(101)], ingredientIds: [1] }],
  ['shop quantities emoji', 'POST', '/recipes/3/to-shopping-list', { listId: LIST, quantities: [EMOJI_51], ingredientIds: [1] }],
  ['shop list missing', 'POST', '/recipes/3/to-shopping-list', {}],
  ['shop list text', 'POST', '/recipes/3/to-shopping-list', { listId: String(LIST) }],
  ['shop list null', 'POST', '/recipes/3/to-shopping-list', { listId: null }],
  ['shop list true', 'POST', '/recipes/3/to-shopping-list', { listId: true }],
  ['shop list infinite', 'POST', '/recipes/3/to-shopping-list', '{"listId":1e400}', { raw: true }],
  ['shop list huge', 'POST', '/recipes/3/to-shopping-list', '{"listId":1e20}', { raw: true }],
  ['shop list unknown', 'POST', '/recipes/3/to-shopping-list', { listId: 999 }],
  ['shop no body', 'POST', '/recipes/3/to-shopping-list', NO_BODY],
  ['shop array body', 'POST', '/recipes/3/to-shopping-list', [LIST]],
  ['shop recipe zero', 'POST', '/recipes/0/to-shopping-list', { listId: LIST }],
  ['shop recipe unknown', 'POST', '/recipes/999/to-shopping-list', { listId: LIST }],
  ['shop member read only', 'POST', '/recipes/3/to-shopping-list', { listId: 'x' }, { actor: 'member', access: { shopping: 'read' } }],

  // ── pantry: locations ─────────────────────────────────────────────────────
  ['loc list', 'GET', '/pantry/locations', NO_BODY],
  ['loc create', 'POST', '/pantry/locations', { name: ' Garage ', icon: 'box' }],
  ['loc create default icon', 'POST', '/pantry/locations', { name: 'Speisekammer', icon: null }],
  ['loc create duplicate', 'POST', '/pantry/locations', { name: 'garage' }],
  ['loc create empty', 'POST', '/pantry/locations', { name: '' }],
  ['loc create spaces', 'POST', '/pantry/locations', { name: '   ' }],
  ['loc create 101', 'POST', '/pantry/locations', { name: 'a'.repeat(101) }],
  ['loc create emoji', 'POST', '/pantry/locations', { name: '😀'.repeat(60) }],
  ['loc create number', 'POST', '/pantry/locations', { name: 5 }],
  ['loc create no body', 'POST', '/pantry/locations', NO_BODY],
  ['loc reorder', 'PATCH', '/pantry/locations/reorder', () => ({ order: [location('Speisekammer'), location('Garage')] })],
  ['loc reorder legacy text', 'PATCH', '/pantry/locations/reorder', () => ({ order: [String(location('Garage')), location('Speisekammer'), 999] })],
  ['loc reorder empty', 'PATCH', '/pantry/locations/reorder', { order: [] }],
  ['loc reorder missing', 'PATCH', '/pantry/locations/reorder', {}],
  ['loc reorder null', 'PATCH', '/pantry/locations/reorder', { order: null }],
  ['loc reorder text', 'PATCH', '/pantry/locations/reorder', { order: '1,2' }],
  ['loc reorder object entry', 'PATCH', '/pantry/locations/reorder', { order: [{}] }],
  ['loc reorder no body', 'PATCH', '/pantry/locations/reorder', NO_BODY],
  ['loc put', 'PUT', '/pantry/locations/__KELLER__', { name: 'Vorratskeller', icon: '' }],
  ['loc put duplicate', 'PUT', '/pantry/locations/__KELLER__', { name: 'speisekammer' }],
  ['loc put empty', 'PUT', '/pantry/locations/__KELLER__', { name: '' }],
  ['loc put zero', 'PUT', '/pantry/locations/0', { name: 'x' }],
  ['loc put unknown', 'PUT', '/pantry/locations/999', { name: 'x' }],
  ['loc put letters', 'PUT', '/pantry/locations/abc', { name: 'x' }],
  ['loc put unknown bad body', 'PUT', '/pantry/locations/999', { name: 5 }],

  // ── pantry: items ─────────────────────────────────────────────────────────
  ['item create', 'POST', '/pantry', () => ({ ...ITEM, location_id: location('Vorratskeller') })],
  ['item create minimal', 'POST', '/pantry', { name: 'Salz' }],
  ['item create legacy location', 'POST', '/pantry', () => ({ name: 'Zucker', location_id: String(location('Speisekammer')), quantity: 2000000, min_quantity: 0.555 })],
  ['item create no body', 'POST', '/pantry', NO_BODY],
  ['item create name empty', 'POST', '/pantry', { name: '' }],
  ['item create name emoji', 'POST', '/pantry', { name: EMOJI_150 }],
  ['item create quantity text', 'POST', '/pantry', { name: 'x', quantity: '3' }],
  ['item create quantity null', 'POST', '/pantry', { name: 'x', quantity: null }],
  ['item create quantity true', 'POST', '/pantry', { name: 'x', quantity: true }],
  ['item create quantity negative', 'POST', '/pantry', { name: 'x', quantity: -1 }],
  ['item create quantity infinite', 'POST', '/pantry', '{"name":"x","quantity":1e400}', { raw: true }],
  ['item create min negative', 'POST', '/pantry', { name: 'x', min_quantity: -0.5 }],
  ['item create min empty', 'POST', '/pantry', { name: 'x', min_quantity: '' }],
  ['item create min text', 'POST', '/pantry', { name: 'x', min_quantity: '2' }],
  ['item create min infinite', 'POST', '/pantry', '{"name":"x","min_quantity":-1e400}', { raw: true }],
  ['item create unit unknown', 'POST', '/pantry', { name: 'x', unit: 'faesser' }],
  ['item create unit null', 'POST', '/pantry', { name: 'x', unit: null }],
  ['item create location empty', 'POST', '/pantry', { name: 'x', location_id: '' }],
  ['item create location zero', 'POST', '/pantry', { name: 'x', location_id: 0 }],
  ['item create location unknown', 'POST', '/pantry', { name: 'x', location_id: 999 }],
  ['item create category unknown', 'POST', '/pantry', { name: 'x', category: 'Nope' }],
  ['item create expiry no day', 'POST', '/pantry', { name: 'x', expires_on: '2026-02-30' }],
  ['item create expiry shape', 'POST', '/pantry', { name: 'x', expires_on: '30.02.2026' }],
  ['item put', 'PUT', '/pantry/__REIS__', { name: 'Reis', quantity: 3, unit: null, category: null, expires_on: '2026-11-20' }],
  ['item put zero', 'PUT', '/pantry/0', { name: 'x' }],
  ['item put unknown', 'PUT', '/pantry/999', { name: 'x' }],
  ['item put quantity negative', 'PUT', '/pantry/__REIS__', { name: 'x', quantity: -2 }],
  ['item put min empty', 'PUT', '/pantry/__REIS__', { name: 'x', min_quantity: '' }],
  ['item patch quantity', 'PATCH', '/pantry/__REIS__', { quantity: 0 }],
  ['item patch min', 'PATCH', '/pantry/__REIS__', { min_quantity: 4 }],
  ['item patch min cleared', 'PATCH', '/pantry/__REIS__', { min_quantity: null }],
  ['item patch unit keep', 'PATCH', '/pantry/__REIS__', { unit: null, notes: null }],
  ['item patch nothing', 'PATCH', '/pantry/__REIS__', {}],
  ['item patch no body', 'PATCH', '/pantry/__REIS__', NO_BODY],
  ['item patch quantity text', 'PATCH', '/pantry/__REIS__', { quantity: 'x' }],
  ['item patch quantity negative', 'PATCH', '/pantry/__REIS__', { quantity: -1 }],
  ['item patch min negative', 'PATCH', '/pantry/__REIS__', { min_quantity: -2 }],
  ['item patch min empty', 'PATCH', '/pantry/__REIS__', { min_quantity: '' }],
  ['item patch zero', 'PATCH', '/pantry/0', { quantity: 1 }],
  ['item patch unknown', 'PATCH', '/pantry/999', { quantity: 1 }],
  ['item list', 'GET', '/pantry', NO_BODY],

  // ── recipes: ingredient to pantry row ─────────────────────────────────────
  ['match set', 'PUT', '/recipes/3/ingredient-match', () => ({ name: ' mehl ', pantryItemId: batch('Reis') })],
  ['match set huge item', 'PUT', '/recipes/3/ingredient-match', '{"name":"Mehl","pantryItemId":1e20}', { raw: true }],
  ['match item unknown', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl', pantryItemId: 999 }],
  ['match item text', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl', pantryItemId: '2' }],
  ['match item empty', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl', pantryItemId: '' }],
  ['match item true', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl', pantryItemId: true }],
  ['match item fraction', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl', pantryItemId: 1.5 }],
  ['match item infinite', 'PUT', '/recipes/3/ingredient-match', '{"name":"Mehl","pantryItemId":1e400}', { raw: true }],
  ['match name empty', 'PUT', '/recipes/3/ingredient-match', { name: '', pantryItemId: null }],
  ['match name spaces', 'PUT', '/recipes/3/ingredient-match', { name: '   ', pantryItemId: null }],
  ['match name emoji', 'PUT', '/recipes/3/ingredient-match', { name: EMOJI_150, pantryItemId: null }],
  ['match list shows it', 'GET', '/recipes', NO_BODY],
  ['match clear left out', 'PUT', '/recipes/3/ingredient-match', { name: 'Mehl' }],
  ['match clear null', 'PUT', '/recipes/3/ingredient-match', { name: 'Ei', pantryItemId: null }],
  ['match ingredient unknown', 'PUT', '/recipes/3/ingredient-match', { name: 'Zucker', pantryItemId: null }],
  ['match name only marks', 'PUT', '/recipes/3/ingredient-match', { name: '!!!', pantryItemId: null }],
  ['match name number', 'PUT', '/recipes/3/ingredient-match', { name: 5 }],
  ['match name 201', 'PUT', '/recipes/3/ingredient-match', { name: 'a'.repeat(201) }],
  ['match name missing', 'PUT', '/recipes/3/ingredient-match', { pantryItemId: null }],
  ['match no body', 'PUT', '/recipes/3/ingredient-match', NO_BODY],
  ['match recipe zero', 'PUT', '/recipes/0/ingredient-match', { name: 'Mehl' }],
  ['match recipe unknown', 'PUT', '/recipes/999/ingredient-match', { name: 'Mehl' }],
  ['match member read only', 'PUT', '/recipes/3/ingredient-match', { name: 5 }, { actor: 'member', access: { pantry: 'read' } }],

  // ── pantry: from the shopping list and back ───────────────────────────────
  ['import', 'POST', '/pantry/import-shopping', () => ({
    list_id: LIST,
    items: [
      { shopping_item_id: BREAD, quantity: 2, unit: 'pcs', location_id: location('Speisekammer'), expires_on: '2026-11-25' },
      { shopping_item_id: EGGS, expires_on: '2026-02-30' },
      { shopping_item_id: MILK },
      { shopping_item_id: 999 },
      { quantity: 1 },
    ],
  })],
  ['import merge', 'POST', '/pantry/import-shopping', () => ({
    list_id: LIST,
    items: [{ shopping_item_id: BREAD, quantity: -3, location_id: location('Speisekammer') }, { shopping_item_id: EGGS, quantity: 6, expires_on: '2026-12-01' }],
  })],
  ['import no items', 'POST', '/pantry/import-shopping', { list_id: LIST }],
  ['import empty items', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [] }],
  ['import items null', 'POST', '/pantry/import-shopping', { list_id: LIST, items: null }],
  ['import items text', 'POST', '/pantry/import-shopping', { list_id: LIST, items: 'Brot' }],
  ['import items object', 'POST', '/pantry/import-shopping', { list_id: LIST, items: { shopping_item_id: BREAD } }],
  ['import row number', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [BREAD] }],
  ['import row id text', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [{ shopping_item_id: String(BREAD) }] }],
  ['import row unit unknown', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [{ shopping_item_id: BREAD, unit: 'faesser' }] }],
  ['import row location unknown', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [{ shopping_item_id: BREAD, location_id: 999 }] }],
  ['import row location unknown skipped', 'POST', '/pantry/import-shopping', { list_id: LIST, items: [{ shopping_item_id: MILK, location_id: 999 }] }],
  ['import list zero', 'POST', '/pantry/import-shopping', { list_id: 0, items: [] }],
  ['import list text', 'POST', '/pantry/import-shopping', { list_id: String(LIST) }],
  ['import list unknown', 'POST', '/pantry/import-shopping', { list_id: 999 }],
  ['import no body', 'POST', '/pantry/import-shopping', NO_BODY],
  ['import member no shopping', 'POST', '/pantry/import-shopping', { list_id: 'x' }, { actor: 'member', access: { shopping: 'none' } }],
  ['undo merged', 'POST', '/pantry/import-shopping/undo', () => ({ changes: [
    { pantry_item_id: batch('Brot'), kind: 'merged', quantity_added: 0, expires_set: false },
    { pantry_item_id: batch('Eier'), kind: 'merged', quantity_added: 6, expires_set: true },
  ] })],
  ['undo added', 'POST', '/pantry/import-shopping/undo', () => ({ changes: [{ pantry_item_id: batch('Eier'), kind: 'added' }, { pantry_item_id: 999, kind: 'added' }] })],
  ['undo merged without amount', 'POST', '/pantry/import-shopping/undo', () => ({ changes: [{ pantry_item_id: batch('Brot'), kind: 'merged' }] })],
  ['undo id zero', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 0, kind: 'added' }, { pantry_item_id: -4, kind: 'added' }] }],
  ['undo empty', 'POST', '/pantry/import-shopping/undo', { changes: [] }],
  ['undo missing', 'POST', '/pantry/import-shopping/undo', {}],
  ['undo null', 'POST', '/pantry/import-shopping/undo', { changes: null }],
  ['undo text', 'POST', '/pantry/import-shopping/undo', { changes: 'x' }],
  ['undo number entry', 'POST', '/pantry/import-shopping/undo', { changes: [1] }],
  ['undo id text', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: '1', kind: 'added' }] }],
  ['undo id fraction', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 1.5, kind: 'added' }] }],
  ['undo id missing', 'POST', '/pantry/import-shopping/undo', { changes: [{ kind: 'added' }] }],
  ['undo kind unknown', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 1, kind: 'removed' }] }],
  ['undo kind missing', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 1 }] }],
  ['undo amount text', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 1, kind: 'merged', quantity_added: '2' }] }],
  ['undo expires text', 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: 1, kind: 'merged', quantity_added: 2, expires_set: 'yes' }] }],
  ['undo no body', 'POST', '/pantry/import-shopping/undo', NO_BODY],

  // ── pantry: products, deletes ─────────────────────────────────────────────
  ['product with batches', 'DELETE', '/pantry/products/__REIS_PRODUCT__', NO_BODY],
  ['item delete', 'DELETE', '/pantry/__REIS__', NO_BODY],
  ['item delete again', 'DELETE', '/pantry/__REIS__', NO_BODY],
  ['item delete zero', 'DELETE', '/pantry/0', NO_BODY],
  ['item delete letters', 'DELETE', '/pantry/5.0', NO_BODY],
  ['product without batches', 'DELETE', '/pantry/products/__REIS_PRODUCT__', NO_BODY],
  ['product unknown', 'DELETE', '/pantry/products/999', NO_BODY],
  ['product zero', 'DELETE', '/pantry/products/0', NO_BODY],
  ['product letters', 'DELETE', '/pantry/products/abc', NO_BODY],
  ['loc delete', 'DELETE', '/pantry/locations/__KELLER__', NO_BODY],
  ['loc delete again', 'DELETE', '/pantry/locations/__KELLER__', NO_BODY],
  ['loc delete zero', 'DELETE', '/pantry/locations/0', NO_BODY],
  ['loc delete letters', 'DELETE', '/pantry/locations/0x10', NO_BODY],
  ['pantry end', 'GET', '/pantry', NO_BODY],

  // ── recipe providers ──────────────────────────────────────────────────────
  ['prov list', 'GET', '/recipe-providers/accounts', NO_BODY],
  ['prov list member', 'GET', '/recipe-providers/accounts', NO_BODY, { actor: 'member' }],
  ['prov create', 'POST', '/recipe-providers/accounts', PROVIDER],
  ['prov create duplicate', 'POST', '/recipe-providers/accounts', { ...PROVIDER, base_url: 'https://tandoor.example' }],
  ['prov create default provider', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, external_url: '' }],
  ['prov create provider unknown', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, provider: 'chefkoch' }],
  ['prov create provider null', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, provider: null }],
  ['prov create no body', 'POST', '/recipe-providers/accounts', NO_BODY],
  ['prov create name empty', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, name: '' }],
  ['prov create name spaces', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, name: '  ' }],
  ['prov create name number', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, name: 5 }],
  ['prov create token missing', 'POST', '/recipe-providers/accounts', { name: 'x', base_url: 'https://x.example' }],
  ['prov create token 501', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, api_token: 'a'.repeat(501) }],
  ['prov create url ftp', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 'ftp://x.example' }],
  ['prov create url bare', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 'x.example' }],
  ['prov create url padded ftp', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: '  ftp://x.example' }],
  ['prov create url upper', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, name: 'Gross', base_url: ' HTTPS://Upper.example//' }],
  ['prov create url empty', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: '' }],
  ['prov create url spaces', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: ' \t　' }],
  ['prov create url number', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 5 }],
  ['prov create url list', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: ['https://x.example'] }],
  ['prov create url padded long', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: `https://${'a'.repeat(1990)}${' '.repeat(10)}` }],
  ['prov create url long', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: `https://${'a'.repeat(1993)}` }],
  ['prov create url private', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 'http://localhost:9000' }],
  ['prov create external ftp', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, external_url: 'ftp://x' }],
  ['prov create external spaces', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, external_url: '   ' }],
  ['prov create external tab', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, external_url: '\t' }],
  ['prov create external number', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, external_url: 0 }],
  ['prov create member', 'POST', '/recipe-providers/accounts', { name: 5 }, { actor: 'member' }],
  () => { provider.mode = 'refuse'; },
  ['prov create refused', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 'https://refuse.example' }],
  () => { provider.mode = 'private'; },
  ['prov create resolves private', 'POST', '/recipe-providers/accounts', { ...ACCOUNT, base_url: 'https://intranet.example' }],
  () => { provider.mode = 'ok'; },
  ['prov patch', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: false, name: ' Tandoor neu ', external_url: ' HTTP://open.example/x/ ' }],
  ['prov patch enabled', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: true, external_url: null }],
  ['prov patch nothing', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', {}],
  ['prov patch external empty', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { external_url: '' }],
  ['prov patch external spaces', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { external_url: '  ' }],
  ['prov patch external ftp', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { external_url: 'ftp://x' }],
  ['prov patch enabled text', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: 'false' }],
  ['prov patch enabled null', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: null }],
  ['prov patch enabled zero', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: 0 }],
  ['prov patch name empty', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { name: '' }],
  ['prov patch name spaces', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { name: '  ' }],
  ['prov patch no body', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', NO_BODY],
  ['prov patch unknown', 'PATCH', '/recipe-providers/accounts/999', {}],
  ['prov patch zero', 'PATCH', '/recipe-providers/accounts/0', {}],
  ['prov patch letters', 'PATCH', '/recipe-providers/accounts/0x1e', {}],
  ['prov patch member', 'PATCH', '/recipe-providers/accounts/__TANDOOR__', { enabled: 'x' }, { actor: 'member' }],
  ['prov test', 'POST', '/recipe-providers/accounts/__TANDOOR__/test', {}],
  ['prov test no body', 'POST', '/recipe-providers/accounts/__TANDOOR__/test', NO_BODY],
  () => { provider.mode = 'refuse'; },
  ['prov test refused', 'POST', '/recipe-providers/accounts/__TANDOOR__/test', {}],
  () => { provider.mode = 'ok'; },
  ['prov test list body', 'POST', '/recipe-providers/accounts/__TANDOOR__/test', []],
  ['prov test unknown', 'POST', '/recipe-providers/accounts/999/test', {}],
  ['prov test member', 'POST', '/recipe-providers/accounts/__TANDOOR__/test', {}, { actor: 'member' }],
  ['prov sync one', 'POST', '/recipe-providers/accounts/__TANDOOR__/sync', {}],
  ['prov sync one unknown', 'POST', '/recipe-providers/accounts/999/sync', NO_BODY],
  ['prov sync one letters', 'POST', '/recipe-providers/accounts/31.0/sync', {}],
  ['prov sync all', 'POST', '/recipe-providers/sync', NO_BODY],
  ['prov sync all member', 'POST', '/recipe-providers/sync', NO_BODY, { actor: 'member' }],
  ['prov status', 'GET', '/recipe-providers/status', NO_BODY],
  ['prov status member', 'GET', '/recipe-providers/status', NO_BODY, { actor: 'member' }],
  ['prov delete', 'DELETE', `/recipe-providers/accounts/${MIRROR_ACCOUNT}`, NO_BODY],
  ['prov delete again', 'DELETE', `/recipe-providers/accounts/${MIRROR_ACCOUNT}`, NO_BODY],
  ['prov delete letters', 'DELETE', '/recipe-providers/accounts/abc', NO_BODY],
  ['prov delete member', 'DELETE', '/recipe-providers/accounts/__TANDOOR__', NO_BODY, { actor: 'member' }],
  ['prov list end', 'GET', '/recipe-providers/accounts', NO_BODY],
  ['rec list end', 'GET', '/recipes', NO_BODY],
];

/** Ids that exist only once their row ran, by placeholder. */
const PLACEHOLDERS = {
  __KELLER__: () => db.prepare("SELECT id FROM pantry_locations WHERE icon = 'box'").get().id,
  __REIS__: () => batch('Reis'),
  __REIS_PRODUCT__: () => db.prepare("SELECT id FROM pantry_products WHERE name = 'Reis'").get().id,
  __TANDOOR__: () => db.prepare("SELECT id FROM recipe_provider_accounts WHERE provider = 'tandoor'").get().id,
};

/** @type {Map<string, number>} */
const resolvedIds = new Map();

/** A path with its placeholders as ids, each read once and kept: a row after its delete names the same id. @param {string} path */
function resolved(path) {
  return path.replace(/__[A-Z_]+__/g, (key) => {
    if (!resolvedIds.has(key)) resolvedIds.set(key, /** @type {Record<string, () => number>} */ (PLACEHOLDERS)[key]());
    return String(resolvedIds.get(key));
  });
}

// Written at 95b65acc5 (before the refactor), literal.
/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "rec list empty-ish": {"status":200,"body":{"data":[{"id":1,"title":"Gespiegelt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":1,"provider_recipe_id":"r1","provider_updated_at":"2026-11-01T10:00:00Z","provider_slug":"gespiegelt","provider_has_image":1,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":"Mealie","provider_type":"mealie","ingredients":[],"has_own_image":false,"source":"mealie"},{"id":2,"title":"Kaputt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":true,"source":"native"}]}},
  "rec create": {"status":201,"body":{"data":{"id":3,"title":"Pfannkuchen","notes":"Lecker","recipe_url":"https://example.org/p","created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":4,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":1,"recipe_id":3,"name":"Mehl","quantity":"200 g","category":"Backwaren","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":2,"recipe_id":3,"name":"Milch","quantity":null,"category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"}}},
  "rec create plain": {"status":201,"body":{"data":{"id":4,"title":"Brot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}}},
  "rec create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rec create array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "rec create text body": {"status":400,"body":{"error":"The request was refused (Bad Request).","code":400}},
  "rec create empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"required"}]}},
  "rec create title empty": {"status":400,"body":{"error":"title is required.","code":400}},
  "rec create title spaces": {"status":400,"body":{"error":"title must not be empty.","code":400}},
  "rec create title number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"type"}]}},
  "rec create title 201": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"maxLength"}]}},
  "rec create title padded 200": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"maxLength"}]}},
  "rec create title emoji": {"status":400,"body":{"error":"title may be at most 200 characters long.","code":400}},
  "rec create notes 5001": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/notes","rule":"maxLength"}]}},
  "rec create notes number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/notes","rule":"type"}]}},
  "rec create url list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/recipe_url","rule":"type"}]}},
  "rec create meal text": {"status":201,"body":{"data":{"id":5,"title":"Abendbrot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}}},
  "rec create meal number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/meal_types","rule":"type"},{"path":"body/meal_types","rule":"anyOf"}]}},
  "rec create ingredients null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients","rule":"type"}]}},
  "rec create ingredients text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients","rule":"type"}]}},
  "rec create ingredients object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients","rule":"type"}]}},
  "rec create ingredients number entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients/0","rule":"type"}]}},
  "rec create ingredients null entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients/0","rule":"type"}]}},
  "rec create ingredients list entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients/0","rule":"type"}]}},
  "rec create ingredient name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients/0/name","rule":"type"}]}},
  "rec create ingredient quantity number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients/0/quantity","rule":"type"}]}},
  "rec create servings text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"minimum"}]}},
  "rec create servings 100": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"maximum"}]}},
  "rec create servings negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"minimum"}]}},
  "rec create servings fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec create servings 1": {"status":201,"body":{"data":{"id":6,"title":"Eins","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":1,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}}},
  "rec create servings 99.0": {"status":201,"body":{"data":{"id":7,"title":"Viele","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":99,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}}},
  "rec create servings null": {"status":201,"body":{"data":{"id":8,"title":"Ohne","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}}},
  "rec create image number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/image_data","rule":"type"}]}},
  "rec create image text": {"status":400,"body":{"error":"Image must be a valid image data URL.","code":400}},
  "rec create image mismatch": {"status":400,"body":{"error":"Image content does not match its image type.","code":400}},
  "rec list": {"status":200,"body":{"data":[{"id":5,"title":"Abendbrot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":4,"title":"Brot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":6,"title":"Eins","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":1,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":1,"title":"Gespiegelt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":1,"provider_recipe_id":"r1","provider_updated_at":"2026-11-01T10:00:00Z","provider_slug":"gespiegelt","provider_has_image":1,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":"Mealie","provider_type":"mealie","ingredients":[],"has_own_image":false,"source":"mealie"},{"id":2,"title":"Kaputt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":true,"source":"native"},{"id":8,"title":"Ohne","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":3,"title":"Pfannkuchen","notes":"Lecker","recipe_url":"https://example.org/p","created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":4,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":1,"recipe_id":3,"name":"Mehl","quantity":"200 g","category":"Backwaren","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":2,"recipe_id":3,"name":"Milch","quantity":null,"category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"},{"id":7,"title":"Viele","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":99,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}]}},
  "rec list no pantry": {"status":200,"body":{"data":[{"id":5,"title":"Abendbrot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":4,"title":"Brot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":6,"title":"Eins","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":1,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":1,"title":"Gespiegelt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":1,"provider_recipe_id":"r1","provider_updated_at":"2026-11-01T10:00:00Z","provider_slug":"gespiegelt","provider_has_image":1,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":"Mealie","provider_type":"mealie","ingredients":[],"has_own_image":false,"source":"mealie"},{"id":2,"title":"Kaputt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":true,"source":"native"},{"id":8,"title":"Ohne","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":3,"title":"Pfannkuchen","notes":"Lecker","recipe_url":"https://example.org/p","created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":4,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":1,"recipe_id":3,"name":"Mehl","quantity":"200 g","category":"Backwaren","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":2,"recipe_id":3,"name":"Milch","quantity":null,"category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"},{"id":7,"title":"Viele","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":99,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}]}},
  "rec put": {"status":200,"body":{"data":{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":4,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":3,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":4,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"}}},
  "rec put servings cleared": {"status":200,"body":{"data":{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["lunch"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":5,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":6,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":false,"source":"native"}}},
  "rec put servings back": {"status":200,"body":{"data":{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["lunch"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":6,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":7,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":8,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"}}},
  "rec put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "rec put array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "rec put ingredients text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients","rule":"type"}]}},
  "rec put ingredients null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredients","rule":"type"}]}},
  "rec put servings empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec put servings 100": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"maximum"}]}},
  "rec put servings text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/servings","rule":"type"}]}},
  "rec put title spaces": {"status":400,"body":{"error":"title must not be empty.","code":400}},
  "rec put zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "rec put unknown": {"status":404,"body":{"error":"Recipe not found.","code":404,"reason":"recipes_recipe_not_found"}},
  "rec put letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rec put huge": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rec put mirrored": {"status":403,"body":{"error":"Mirrored recipes are managed by their source provider and cannot be edited here.","code":403,"reason":"recipe_mirrored"}},
  "rec put mirrored bad body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/title","rule":"type"}]}},
  "rec image": {"status":200,"body":{"type":"image/jpeg","length":9}},
  "rec image none": {"status":404,"body":{"error":"No image available.","code":404}},
  "rec image unreadable": {"status":415,"body":{"error":"Stored image is not readable.","code":415}},
  "rec image zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "rec image unknown": {"status":404,"body":{"error":"No image available.","code":404}},
  "rec image letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rec delete zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "rec delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "rec delete unknown": {"status":404,"body":{"error":"Recipe not found.","code":404,"reason":"recipes_recipe_not_found"}},
  "rec delete mirrored": {"status":403,"body":{"error":"Mirrored recipes are managed by their source provider and cannot be deleted here.","code":403,"reason":"recipe_mirrored"}},
  "rec delete": {"status":204,"body":null},
  "rec delete again": {"status":404,"body":{"error":"Recipe not found.","code":404,"reason":"recipes_recipe_not_found"}},
  "thumb ok": {"status":200,"body":{"type":"image/jpeg","length":9}},
  "thumb native": {"status":404,"body":{"error":"No thumbnail available.","code":404}},
  "thumb zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "thumb unknown": {"status":404,"body":{"error":"No thumbnail available.","code":404}},
  "thumb letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "thumb v twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/v","rule":"type"}]}},
  "thumb provider 404": {"status":404,"body":{"error":"No thumbnail available.","code":404}},
  "thumb provider fails": {"status":502,"body":{"error":"Recipe provider thumbnail proxy failed.","code":502}},
  "thumb provider svg": {"status":415,"body":{"error":"Thumbnail not available.","code":415}},
  "shop transfer": {"status":200,"body":{"data":{"transferred":2,"skipped":0,"added_ids":[4,5]}}},
  "shop transfer again": {"status":200,"body":{"data":{"transferred":0,"skipped":2,"added_ids":[]}}},
  "shop transfer scaled": {"status":200,"body":{"data":{"transferred":0,"skipped":2,"added_ids":[]}}},
  "shop transfer empty recipe": {"status":200,"body":{"data":{"transferred":0,"skipped":0,"added_ids":[]}}},
  "shop ids stale": {"status":409,"body":{"error":"The recipe ingredients changed since they were loaded.","code":409,"reason":"recipes_ingredients_changed","recipe":{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["lunch"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":6,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":7,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":8,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"}}},
  "shop ids short": {"status":400,"body":{"error":"Quantities need the ingredientIds they belong to, one per quantity.","code":400}},
  "shop ids missing": {"status":400,"body":{"error":"Quantities need the ingredientIds they belong to, one per quantity.","code":400}},
  "shop ids unsafe": {"status":400,"body":{"error":"Quantities need the ingredientIds they belong to, one per quantity.","code":400}},
  "shop ids zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredientIds/0","rule":"minimum"}]}},
  "shop ids fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredientIds/0","rule":"type"}]}},
  "shop ids text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredientIds/0","rule":"type"}]}},
  "shop ids text without quantities": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/ingredientIds/0","rule":"type"}]}},
  "shop quantities null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantities","rule":"type"}]}},
  "shop quantities text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantities","rule":"type"}]}},
  "shop quantities number entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantities/0","rule":"type"}]}},
  "shop quantities long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantities/0","rule":"maxLength"}]}},
  "shop quantities emoji": {"status":400,"body":{"error":"Quantities must be one text per ingredient.","code":400}},
  "shop list missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/listId","rule":"required"}]}},
  "shop list text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/listId","rule":"type"}]}},
  "shop list null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/listId","rule":"type"}]}},
  "shop list true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/listId","rule":"type"}]}},
  "shop list infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/listId","rule":"type"}]}},
  "shop list huge": {"status":404,"body":{"error":"Shopping list not found.","code":404,"reason":"shopping_list_not_found"}},
  "shop list unknown": {"status":404,"body":{"error":"Shopping list not found.","code":404,"reason":"shopping_list_not_found"}},
  "shop no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "shop array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "shop recipe zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "shop recipe unknown": {"status":404,"body":{"error":"Recipe not found.","code":404,"reason":"recipes_recipe_not_found"}},
  "shop member read only": {"status":403,"body":{"error":"Write access to the shopping list is required.","code":403,"reason":"cross_module_access"}},
  "loc list": {"status":200,"body":{"data":[{"id":1,"name":"Vorratsschrank","icon":"archive","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Kühlschrank","icon":"refrigerator","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Gefrierschrank","icon":"snowflake","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Keller","icon":"warehouse","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Sonstiges","icon":"package","sort_order":4,"created_at":"<clock>"}]}},
  "loc create": {"status":201,"body":{"data":{"id":6,"name":"Garage","icon":"box","sort_order":5,"created_at":"<clock>"}}},
  "loc create default icon": {"status":201,"body":{"data":{"id":7,"name":"Speisekammer","icon":"package","sort_order":6,"created_at":"<clock>"}}},
  "loc create duplicate": {"status":409,"body":{"error":"Storage location already exists.","code":409,"reason":"pantry_location_exists"}},
  "loc create empty": {"status":400,"body":{"error":"name is required.","code":400}},
  "loc create spaces": {"status":400,"body":{"error":"name must not be empty.","code":400}},
  "loc create 101": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  "loc create emoji": {"status":400,"body":{"error":"name may be at most 100 characters long.","code":400}},
  "loc create number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "loc create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "loc reorder": {"status":200,"body":{"data":[{"id":1,"name":"Vorratsschrank","icon":"archive","sort_order":0,"created_at":"<clock>"},{"id":7,"name":"Speisekammer","icon":"package","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Kühlschrank","icon":"refrigerator","sort_order":1,"created_at":"<clock>"},{"id":6,"name":"Garage","icon":"box","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Gefrierschrank","icon":"snowflake","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Keller","icon":"warehouse","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Sonstiges","icon":"package","sort_order":4,"created_at":"<clock>"}]}},
  "loc reorder legacy text": {"status":200,"body":{"data":[{"id":1,"name":"Vorratsschrank","icon":"archive","sort_order":0,"created_at":"<clock>"},{"id":6,"name":"Garage","icon":"box","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Kühlschrank","icon":"refrigerator","sort_order":1,"created_at":"<clock>"},{"id":7,"name":"Speisekammer","icon":"package","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Gefrierschrank","icon":"snowflake","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Keller","icon":"warehouse","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Sonstiges","icon":"package","sort_order":4,"created_at":"<clock>"}]}},
  "loc reorder empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"minItems"}]}},
  "loc reorder missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"required"}]}},
  "loc reorder null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc reorder text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order","rule":"type"}]}},
  "loc reorder object entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/order/0","rule":"type"},{"path":"body/order/0","rule":"anyOf"}]}},
  "loc reorder no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "loc put": {"status":200,"body":{"data":{"id":6,"name":"Vorratskeller","icon":"box","sort_order":0,"created_at":"<clock>"}}},
  "loc put duplicate": {"status":409,"body":{"error":"Storage location already exists.","code":409,"reason":"pantry_location_exists"}},
  "loc put empty": {"status":400,"body":{"error":"name is required.","code":400}},
  "loc put zero": {"status":400,"body":{"error":"locId must be a positive number.","code":400}},
  "loc put unknown": {"status":404,"body":{"error":"Storage location not found.","code":404,"reason":"pantry_location_not_found"}},
  "loc put letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/locId","rule":"type"}]}},
  "loc put unknown bad body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "item create": {"status":201,"body":{"data":{"id":1,"name":"Reis","quantity":2,"unit":"kg","location_id":6,"category":"Sonstiges","expires_on":"2027-01-31","min_quantity":1,"notes":"Basmati","created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item create minimal": {"status":201,"body":{"data":{"id":2,"name":"Salz","quantity":1,"unit":"pcs","location_id":null,"category":"Sonstiges","expires_on":null,"min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":2}}},
  "item create legacy location": {"status":201,"body":{"data":{"id":3,"name":"Zucker","quantity":1000000,"unit":"pcs","location_id":7,"category":"Sonstiges","expires_on":null,"min_quantity":0.56,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":3}}},
  "item create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "item create name empty": {"status":400,"body":{"error":"name is required.","code":400}},
  "item create name emoji": {"status":400,"body":{"error":"name may be at most 200 characters long.","code":400}},
  "item create quantity text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "item create quantity null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "item create quantity true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "item create quantity negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"minimum"}]}},
  "item create quantity infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "item create min negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"minimum"}]}},
  "item create min empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"type"}]}},
  "item create min text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"type"}]}},
  "item create min infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"type"}]}},
  "item create unit unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/unit","rule":"enum"}]}},
  "item create unit null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/unit","rule":"type"}]}},
  "item create location empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/location_id","rule":"type"},{"path":"body/location_id","rule":"pattern"},{"path":"body/location_id","rule":"anyOf"}]}},
  "item create location zero": {"status":400,"body":{"error":"location_id must be a positive number.","code":400}},
  "item create location unknown": {"status":400,"body":{"error":"Location not found.","code":400}},
  "item create category unknown": {"status":400,"body":{"error":"category must be one of: Obst & Gemüse, Backwaren, Milchprodukte, Fleisch & Fisch, Tiefkühl, Getränke, Haushalt, Drogerie, Sonstiges.","code":400}},
  "item create expiry no day": {"status":400,"body":{"error":"expires_on must be a valid calendar date.","code":400}},
  "item create expiry shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/expires_on","rule":"pattern"}]}},
  "item put": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":3,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":1,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item put zero": {"status":400,"body":{"error":"itemId must be a positive number.","code":400}},
  "item put unknown": {"status":404,"body":{"error":"Item not found.","code":404}},
  "item put quantity negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"minimum"}]}},
  "item put min empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"type"}]}},
  "item patch quantity": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":1,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item patch min": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":4,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item patch min cleared": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item patch unit keep": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item patch nothing": {"status":200,"body":{"data":{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1}}},
  "item patch no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "item patch quantity text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"type"}]}},
  "item patch quantity negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/quantity","rule":"minimum"}]}},
  "item patch min negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"minimum"}]}},
  "item patch min empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/min_quantity","rule":"type"}]}},
  "item patch zero": {"status":400,"body":{"error":"itemId must be a positive number.","code":400}},
  "item patch unknown": {"status":404,"body":{"error":"Item not found.","code":404}},
  "item list": {"status":200,"body":{"data":[{"id":3,"name":"Zucker","quantity":1000000,"unit":"pcs","location_id":7,"category":"Sonstiges","expires_on":null,"min_quantity":0.56,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":3,"location_name":"Speisekammer","location_icon":"package"},{"id":1,"name":"Reis","quantity":0,"unit":"kg","location_id":null,"category":"Sonstiges","expires_on":"2026-11-20","min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":1,"location_name":null,"location_icon":null},{"id":2,"name":"Salz","quantity":1,"unit":"pcs","location_id":null,"category":"Sonstiges","expires_on":null,"min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":2,"location_name":null,"location_icon":null}],"products":[{"id":1,"name":"Reis","unit":"kg","category":"Sonstiges","min_quantity":null,"batch_count":1,"total_quantity":0,"match_count":0},{"id":2,"name":"Salz","unit":"pcs","category":"Sonstiges","min_quantity":null,"batch_count":1,"total_quantity":1,"match_count":0},{"id":3,"name":"Zucker","unit":"pcs","category":"Sonstiges","min_quantity":0.56,"batch_count":1,"total_quantity":1000000,"match_count":0}],"locations":[{"id":1,"name":"Vorratsschrank","icon":"archive","sort_order":0,"created_at":"<clock>"},{"id":6,"name":"Vorratskeller","icon":"box","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Kühlschrank","icon":"refrigerator","sort_order":1,"created_at":"<clock>"},{"id":7,"name":"Speisekammer","icon":"package","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Gefrierschrank","icon":"snowflake","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Keller","icon":"warehouse","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Sonstiges","icon":"package","sort_order":4,"created_at":"<clock>"}],"categories":[{"id":1,"name":"Obst & Gemüse","icon":"apple","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Backwaren","icon":"wheat","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Milchprodukte","icon":"milk","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Fleisch & Fisch","icon":"beef","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Tiefkühl","icon":"snowflake","sort_order":4,"created_at":"<clock>"},{"id":6,"name":"Getränke","icon":"cup-soda","sort_order":5,"created_at":"<clock>"},{"id":7,"name":"Haushalt","icon":"spray-can","sort_order":6,"created_at":"<clock>"},{"id":8,"name":"Drogerie","icon":"pill","sort_order":7,"created_at":"<clock>"},{"id":9,"name":"Sonstiges","icon":"shopping-basket","sort_order":8,"created_at":"<clock>"}]}},
  "match set": {"status":200,"body":{"data":{"name":"Mehl","ingredient_key":"mehl","pantry_item_id":1,"pantry_item_name":"Reis","pantry_product_id":1,"pantry_product_name":"Reis"}}},
  "match set huge item": {"status":404,"body":{"error":"Pantry item not found.","code":404,"reason":"recipes_selected_pantry_item_not_found"}},
  "match item unknown": {"status":404,"body":{"error":"Pantry item not found.","code":404,"reason":"recipes_selected_pantry_item_not_found"}},
  "match item text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/pantryItemId","rule":"type"}]}},
  "match item empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/pantryItemId","rule":"type"}]}},
  "match item true": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/pantryItemId","rule":"type"}]}},
  "match item fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/pantryItemId","rule":"type"}]}},
  "match item infinite": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/pantryItemId","rule":"type"}]}},
  "match name empty": {"status":400,"body":{"error":"Zutat is required.","code":400}},
  "match name spaces": {"status":400,"body":{"error":"Zutat must not be empty.","code":400}},
  "match name emoji": {"status":400,"body":{"error":"Zutat may be at most 200 characters long.","code":400}},
  "match list shows it": {"status":200,"body":{"data":[{"id":5,"title":"Abendbrot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":6,"title":"Eins","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":1,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":1,"title":"Gespiegelt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":1,"provider_recipe_id":"r1","provider_updated_at":"2026-11-01T10:00:00Z","provider_slug":"gespiegelt","provider_has_image":1,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":"Mealie","provider_type":"mealie","ingredients":[],"has_own_image":false,"source":"mealie"},{"id":2,"title":"Kaputt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":true,"source":"native"},{"id":8,"title":"Ohne","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["lunch"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":6,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":7,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":1,"pantry_item_name":"Reis","pantry_product_id":1,"pantry_product_name":"Reis"},{"id":8,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"},{"id":7,"title":"Viele","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":99,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}]}},
  "match clear left out": {"status":200,"body":{"data":{"name":"Mehl","ingredient_key":"mehl","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}}},
  "match clear null": {"status":200,"body":{"data":{"name":"Ei","ingredient_key":"ei","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}}},
  "match ingredient unknown": {"status":404,"body":{"error":"Ingredient not found in this recipe.","code":404,"reason":"recipes_ingredient_not_found"}},
  "match name only marks": {"status":404,"body":{"error":"Ingredient not found in this recipe.","code":404,"reason":"recipes_ingredient_not_found"}},
  "match name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "match name 201": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"maxLength"}]}},
  "match name missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"required"}]}},
  "match no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "match recipe zero": {"status":400,"body":{"error":"Invalid recipe ID.","code":400}},
  "match recipe unknown": {"status":404,"body":{"error":"Recipe not found.","code":404,"reason":"recipes_recipe_not_found"}},
  "match member read only": {"status":403,"body":{"error":"Write access to the pantry is required.","code":403,"reason":"cross_module_access"}},
  "import": {"status":200,"body":{"data":{"added":2,"merged":0,"skipped":3,"changes":[{"pantry_item_id":4,"kind":"added"},{"pantry_item_id":5,"kind":"added"}]}}},
  "import merge": {"status":200,"body":{"data":{"added":0,"merged":2,"skipped":0,"changes":[{"pantry_item_id":4,"kind":"merged","quantity_added":0,"expires_set":false},{"pantry_item_id":5,"kind":"merged","quantity_added":6,"expires_set":true}]}}},
  "import no items": {"status":200,"body":{"data":{"added":0,"merged":0,"skipped":0,"changes":[]}}},
  "import empty items": {"status":200,"body":{"data":{"added":0,"merged":0,"skipped":0,"changes":[]}}},
  "import items null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items","rule":"type"}]}},
  "import items text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items","rule":"type"}]}},
  "import items object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items","rule":"type"}]}},
  "import row number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items/0","rule":"type"}]}},
  "import row id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items/0/shopping_item_id","rule":"type"}]}},
  "import row unit unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/items/0/unit","rule":"enum"}]}},
  "import row location unknown": {"status":400,"body":{"error":"Location not found.","code":400}},
  "import row location unknown skipped": {"status":200,"body":{"data":{"added":0,"merged":0,"skipped":1,"changes":[]}}},
  "import list zero": {"status":400,"body":{"error":"list_id must be a positive number.","code":400}},
  "import list text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/list_id","rule":"type"}]}},
  "import list unknown": {"status":404,"body":{"error":"List not found.","code":404}},
  "import no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "import member no shopping": {"status":403,"body":{"error":"Read access to the shopping list is required.","code":403,"reason":"cross_module_access"}},
  "undo merged": {"status":200,"body":{"data":{"removed":0,"reduced":2}}},
  "undo added": {"status":200,"body":{"data":{"removed":1,"reduced":0}}},
  "undo merged without amount": {"status":200,"body":{"data":{"removed":0,"reduced":0}}},
  "undo id zero": {"status":200,"body":{"data":{"removed":0,"reduced":0}}},
  "undo empty": {"status":200,"body":{"data":{"removed":0,"reduced":0}}},
  "undo missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes","rule":"required"}]}},
  "undo null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes","rule":"type"}]}},
  "undo text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes","rule":"type"}]}},
  "undo number entry": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0","rule":"type"}]}},
  "undo id text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/pantry_item_id","rule":"type"}]}},
  "undo id fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/pantry_item_id","rule":"type"}]}},
  "undo id missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/pantry_item_id","rule":"required"}]}},
  "undo kind unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/kind","rule":"enum"}]}},
  "undo kind missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/kind","rule":"required"}]}},
  "undo amount text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/quantity_added","rule":"type"}]}},
  "undo expires text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/changes/0/expires_set","rule":"type"}]}},
  "undo no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "product with batches": {"status":409,"body":{"error":"The product still has batches; delete them first.","code":409,"reason":"pantry_product_has_batches","count":1}},
  "item delete": {"status":204,"body":null},
  "item delete again": {"status":404,"body":{"error":"Item not found.","code":404}},
  "item delete zero": {"status":400,"body":{"error":"itemId must be a positive number.","code":400}},
  "item delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/itemId","rule":"type"}]}},
  "product without batches": {"status":204,"body":null},
  "product unknown": {"status":404,"body":{"error":"Product not found.","code":404}},
  "product zero": {"status":400,"body":{"error":"productId must be a positive number.","code":400}},
  "product letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/productId","rule":"type"}]}},
  "loc delete": {"status":200,"body":{"ok":true,"orphaned":0}},
  "loc delete again": {"status":404,"body":{"error":"Storage location not found.","code":404,"reason":"pantry_location_not_found"}},
  "loc delete zero": {"status":400,"body":{"error":"locId must be a positive number.","code":400}},
  "loc delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/locId","rule":"type"}]}},
  "pantry end": {"status":200,"body":{"data":[{"id":4,"name":"Brot","quantity":2,"unit":"pcs","location_id":7,"category":"Backwaren","expires_on":"2026-11-25","min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":4,"location_name":"Speisekammer","location_icon":"package"},{"id":3,"name":"Zucker","quantity":1000000,"unit":"pcs","location_id":7,"category":"Sonstiges","expires_on":null,"min_quantity":0.56,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":3,"location_name":"Speisekammer","location_icon":"package"},{"id":2,"name":"Salz","quantity":1,"unit":"pcs","location_id":null,"category":"Sonstiges","expires_on":null,"min_quantity":null,"notes":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","product_id":2,"location_name":null,"location_icon":null}],"products":[{"id":4,"name":"Brot","unit":"pcs","category":"Backwaren","min_quantity":null,"batch_count":1,"total_quantity":2,"match_count":0},{"id":5,"name":"Eier","unit":"pcs","category":"Sonstiges","min_quantity":null,"batch_count":0,"total_quantity":0,"match_count":0},{"id":2,"name":"Salz","unit":"pcs","category":"Sonstiges","min_quantity":null,"batch_count":1,"total_quantity":1,"match_count":0},{"id":3,"name":"Zucker","unit":"pcs","category":"Sonstiges","min_quantity":0.56,"batch_count":1,"total_quantity":1000000,"match_count":0}],"locations":[{"id":1,"name":"Vorratsschrank","icon":"archive","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Kühlschrank","icon":"refrigerator","sort_order":1,"created_at":"<clock>"},{"id":7,"name":"Speisekammer","icon":"package","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Gefrierschrank","icon":"snowflake","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Keller","icon":"warehouse","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Sonstiges","icon":"package","sort_order":4,"created_at":"<clock>"}],"categories":[{"id":1,"name":"Obst & Gemüse","icon":"apple","sort_order":0,"created_at":"<clock>"},{"id":2,"name":"Backwaren","icon":"wheat","sort_order":1,"created_at":"<clock>"},{"id":3,"name":"Milchprodukte","icon":"milk","sort_order":2,"created_at":"<clock>"},{"id":4,"name":"Fleisch & Fisch","icon":"beef","sort_order":3,"created_at":"<clock>"},{"id":5,"name":"Tiefkühl","icon":"snowflake","sort_order":4,"created_at":"<clock>"},{"id":6,"name":"Getränke","icon":"cup-soda","sort_order":5,"created_at":"<clock>"},{"id":7,"name":"Haushalt","icon":"spray-can","sort_order":6,"created_at":"<clock>"},{"id":8,"name":"Drogerie","icon":"pill","sort_order":7,"created_at":"<clock>"},{"id":9,"name":"Sonstiges","icon":"shopping-basket","sort_order":8,"created_at":"<clock>"}]}},
  "prov list": {"status":200,"body":{"data":[{"id":1,"name":"Mealie","base_url":"https://mealie.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"mealie","last_error_reason":null,"last_error_params":null,"has_token":true}]}},
  "prov list member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov create": {"status":201,"body":{"data":{"id":2,"name":"Tandoor","base_url":"https://tandoor.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":"https://open.example","provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov create duplicate": {"status":409,"body":{"error":"A recipe provider account with this URL already exists.","code":409,"reason":"recipe_providers_account_exists"}},
  "prov create default provider": {"status":201,"body":{"data":{"id":3,"name":"Zweites","base_url":"https://second.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"mealie","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov create provider unknown": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/provider","rule":"enum"}]}},
  "prov create provider null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/provider","rule":"type"}]}},
  "prov create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "prov create name empty": {"status":400,"body":{"error":"Name is required.","code":400}},
  "prov create name spaces": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "prov create name number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/name","rule":"type"}]}},
  "prov create token missing": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/api_token","rule":"required"}]}},
  "prov create token 501": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/api_token","rule":"maxLength"}]}},
  "prov create url ftp": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"recipe_providers_url_invalid","fields":[{"path":"body/base_url","rule":"pattern","reason":"recipe_providers_url_invalid"}]}},
  "prov create url bare": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"recipe_providers_url_invalid","fields":[{"path":"body/base_url","rule":"pattern","reason":"recipe_providers_url_invalid"}]}},
  "prov create url padded ftp": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"recipe_providers_url_invalid","fields":[{"path":"body/base_url","rule":"pattern","reason":"recipe_providers_url_invalid"}]}},
  "prov create url upper": {"status":201,"body":{"data":{"id":4,"name":"Gross","base_url":"HTTPS://Upper.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"mealie","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov create url empty": {"status":400,"body":{"error":"Base URL is required.","code":400}},
  "prov create url spaces": {"status":400,"body":{"error":"Base URL must not be empty.","code":400}},
  "prov create url number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/base_url","rule":"type"}]}},
  "prov create url list": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/base_url","rule":"type"}]}},
  "prov create url padded long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/base_url","rule":"maxLength"}]}},
  "prov create url long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/base_url","rule":"maxLength"}]}},
  "prov create url private": {"status":400,"body":{"error":"Recipe provider URL must not point to a private or local network address (set RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK=true to allow it).","code":400,"reason":"recipe_providers_private_network"}},
  "prov create external ftp": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"recipe_providers_external_url_invalid","fields":[{"path":"body/external_url","rule":"pattern","reason":"recipe_providers_external_url_invalid"}]}},
  "prov create external spaces": {"status":400,"body":{"error":"External URL must not be empty.","code":400}},
  "prov create external tab": {"status":400,"body":{"error":"External URL must not be empty.","code":400}},
  "prov create external number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/external_url","rule":"type"}]}},
  "prov create member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov create refused": {"status":502,"body":{"error":"Could not connect to the recipe provider with these credentials.","code":502,"reason":"recipe_providers_connection_failed"}},
  "prov create resolves private": {"status":400,"body":{"error":"URL resolves to a private IP address - Recipe provider URL must not point to a private or local network address (set RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK=true to allow it).","code":400,"reason":"recipe_providers_private_network"}},
  "prov patch": {"status":200,"body":{"data":{"id":2,"name":"Tandoor neu","base_url":"https://tandoor.example","enabled":0,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":"HTTP://open.example/x","provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov patch enabled": {"status":200,"body":{"data":{"id":2,"name":"Tandoor neu","base_url":"https://tandoor.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov patch nothing": {"status":200,"body":{"data":{"id":2,"name":"Tandoor neu","base_url":"https://tandoor.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov patch external empty": {"status":200,"body":{"data":{"id":2,"name":"Tandoor neu","base_url":"https://tandoor.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":null,"last_error":null,"external_url":null,"provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true}}},
  "prov patch external spaces": {"status":400,"body":{"error":"External URL must not be empty.","code":400}},
  "prov patch external ftp": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"recipe_providers_external_url_invalid","fields":[{"path":"body/external_url","rule":"pattern","reason":"recipe_providers_external_url_invalid"}]}},
  "prov patch enabled text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "prov patch enabled null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "prov patch enabled zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/enabled","rule":"type"}]}},
  "prov patch name empty": {"status":400,"body":{"error":"Name is required.","code":400}},
  "prov patch name spaces": {"status":400,"body":{"error":"Name must not be empty.","code":400}},
  "prov patch no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "prov patch unknown": {"status":404,"body":{"error":"Recipe provider account not found.","code":404,"reason":"recipe_providers_account_not_found"}},
  "prov patch zero": {"status":404,"body":{"error":"Recipe provider account not found.","code":404,"reason":"recipe_providers_account_not_found"}},
  "prov patch letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "prov patch member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov test": {"status":200,"body":{"data":{"ok":true,"status":200}}},
  "prov test no body": {"status":200,"body":{"data":{"ok":true,"status":200}}},
  "prov test refused": {"status":200,"body":{"data":{"ok":false,"status":401,"error":"HTTP 401","reason":"recipe_providers_sync_auth_failed"}}},
  "prov test list body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "prov test unknown": {"status":404,"body":{"error":"Recipe provider account not found.","code":404,"reason":"recipe_providers_account_not_found"}},
  "prov test member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov sync one": {"status":200,"body":{"data":{"imported":0,"updated":0,"deleted":0,"failed":false}}},
  "prov sync one unknown": {"status":404,"body":{"error":"Recipe provider account not found.","code":404,"reason":"recipe_providers_account_not_found"}},
  "prov sync one letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "prov sync all": {"status":200,"body":{"data":{"success":true,"syncedAccounts":4,"imported":0,"updated":0,"deleted":0}}},
  "prov sync all member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov status": {"status":200,"body":{"data":[{"id":4,"provider":"mealie","name":"Gross","baseUrl":"HTTPS://Upper.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0},{"id":1,"provider":"mealie","name":"Mealie","baseUrl":"https://mealie.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":1},{"id":2,"provider":"tandoor","name":"Tandoor neu","baseUrl":"https://tandoor.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0},{"id":3,"provider":"mealie","name":"Zweites","baseUrl":"https://second.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0}]}},
  "prov status member": {"status":200,"body":{"data":[{"id":4,"provider":"mealie","name":"Gross","baseUrl":"HTTPS://Upper.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0},{"id":1,"provider":"mealie","name":"Mealie","baseUrl":"https://mealie.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":1},{"id":2,"provider":"tandoor","name":"Tandoor neu","baseUrl":"https://tandoor.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0},{"id":3,"provider":"mealie","name":"Zweites","baseUrl":"https://second.example","externalUrl":null,"enabled":true,"lastSync":"2026-11-18T12:00:00.000Z","lastError":null,"lastErrorReason":null,"lastErrorParams":null,"recipeCount":0}]}},
  "prov delete": {"status":204,"body":null},
  "prov delete again": {"status":404,"body":{"error":"Recipe provider account not found.","code":404,"reason":"recipe_providers_account_not_found"}},
  "prov delete letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "prov delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "prov list end": {"status":200,"body":{"data":[{"id":4,"name":"Gross","base_url":"HTTPS://Upper.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":"2026-11-18T12:00:00.000Z","last_error":null,"external_url":null,"provider":"mealie","last_error_reason":null,"last_error_params":null,"has_token":true},{"id":2,"name":"Tandoor neu","base_url":"https://tandoor.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":"2026-11-18T12:00:00.000Z","last_error":null,"external_url":null,"provider":"tandoor","last_error_reason":null,"last_error_params":null,"has_token":true},{"id":3,"name":"Zweites","base_url":"https://second.example","enabled":1,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","last_sync":"2026-11-18T12:00:00.000Z","last_error":null,"external_url":null,"provider":"mealie","last_error_reason":null,"last_error_params":null,"has_token":true}]}},
  "rec list end": {"status":200,"body":{"data":[{"id":5,"title":"Abendbrot","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":6,"title":"Eins","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":1,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":2,"title":"Kaputt","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":true,"source":"native"},{"id":8,"title":"Ohne","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":null,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"},{"id":3,"title":"Pfannkuchen fein","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["lunch"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":6,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[{"id":7,"recipe_id":3,"name":"Mehl","quantity":"250 g","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null},{"id":8,"recipe_id":3,"name":"Ei","quantity":"2","category":"Sonstiges","created_at":"<clock>","updated_at":"<clock>","pantry_item_id":null,"pantry_item_name":null,"pantry_product_id":null,"pantry_product_name":null}],"has_own_image":true,"source":"native"},{"id":7,"title":"Viele","notes":null,"recipe_url":null,"created_by":1,"created_at":"<clock>","updated_at":"<clock>","meal_types":["breakfast","lunch","dinner","snack"],"provider_account_id":null,"provider_recipe_id":null,"provider_updated_at":null,"provider_slug":null,"provider_has_image":0,"servings":99,"creator_name":"linda","creator_color":"#007AFF","provider_account_name":null,"provider_type":null,"ingredients":[],"has_own_image":false,"source":"native"}]}},
};

/**
 * The answers that changed on purpose, with their old body for the record:
 * the ingredient label of PUT /recipes/{id}/ingredient-match is English now.
 * @type {Record<string, { status: number, body: unknown }>}
 */
const CHANGED = {
  'match name empty': { status: 400, body: { error: 'Ingredient is required.', code: 400 } },
  'match name spaces': { status: 400, body: { error: 'Ingredient must not be empty.', code: 400 } },
  'match name emoji': { status: 400, body: { error: 'Ingredient may be at most 200 characters long.', code: 400 } },
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, resolved(path), typeof body === 'function' ? body() : body, opts);
    const expected = Object.hasOwn(CHANGED, name) ? CHANGED[name] : EXPECTED[name];
    assert.ok(expected, `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, expected, name);
  }
  assert.equal(seen.size, Object.keys(EXPECTED).length, 'every expectation has its row');
  for (const name of Object.keys(CHANGED)) assert.ok(seen.has(name), `changed row ${name} is in the table`);
});

/**
 * The answer and the log line of the central handler.
 * @param {{ status: number, body: unknown }} res
 * @param {string} method
 * @param {string} pattern
 */
function assertCentral(res, method, pattern) {
  assert.deepEqual(res, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${pattern}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${pattern}: the central handler logged it`);
  logged.error.length = 0;
}

/**
 * Runs `request` while every statement whose SQL matches `sql` fails to prepare,
 * as a broken or locked database would.
 * @template T
 * @param {RegExp} sql
 * @param {() => Promise<T>} request
 */
async function withFailingSql(sql, request) {
  const prepare = db.prepare;
  db.prepare = function (/** @type {string} */ text) {
    if (sql.test(text)) throw new Error('SQLITE_IOERR: disk I/O error');
    return prepare.call(this, text);
  };
  try {
    return await request();
  } finally {
    delete db.prepare;
  }
}

test('recipes: an unexpected error is a 500 of the central handler (was "Internal error"), and the process goes on', async () => {
  logged.error.length = 0;
  const created = await call('POST', '/recipes', { title: 'Probe', ingredients: [{ name: 'Mehl' }] });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  for (const [sql, method, path, body, pattern] of /** @type {Array<[RegExp, string, string, unknown, string]>} */ ([
    [/FROM recipes r/, 'GET', '/recipes', NO_BODY, '/api/v1/recipes/'],
    [/INSERT INTO recipes/, 'POST', '/recipes', { title: 'x' }, '/api/v1/recipes/'],
    [/UPDATE recipes/, 'PUT', `/recipes/${id}`, { title: 'x' }, '/api/v1/recipes/:id'],
    [/SELECT image_data FROM recipes/, 'GET', `/recipes/${id}/image`, NO_BODY, '/api/v1/recipes/:id/image'],
    [/DELETE FROM recipes/, 'DELETE', `/recipes/${id}`, NO_BODY, '/api/v1/recipes/:id'],
    [/FROM shopping_lists/, 'POST', `/recipes/${id}/to-shopping-list`, { listId: LIST }, '/api/v1/recipes/:id/to-shopping-list'],
    [/pantry_product_matches/, 'PUT', `/recipes/${id}/ingredient-match`, { name: 'Mehl', pantryItemId: null }, '/api/v1/recipes/:id/ingredient-match'],
  ])) {
    assertCentral(await withFailingSql(sql, () => call(method, path, body)), method, pattern);
  }
  assert.equal((await call('GET', '/recipes', NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('DELETE', `/recipes/${id}`, NO_BODY)).status, 204);
});

test('recipes: the thumbnail proxy keeps its own 404 and 502, also for a failure of its own database read', async () => {
  logged.error.length = 0;
  const account = Number(db.prepare(`
    INSERT INTO recipe_provider_accounts (provider, name, base_url, api_token, created_by)
    VALUES ('mealie', 'Thumbs', 'https://thumbs.example', 'secret', ?)
  `).run(ADMIN).lastInsertRowid);
  const recipe = Number(db.prepare(`
    INSERT INTO recipes (title, created_by, provider_account_id, provider_recipe_id, provider_slug, provider_has_image, provider_updated_at)
    VALUES ('Bild', ?, ?, 'r9', 'bild', 1, '2026-11-02T10:00:00Z')
  `).run(ADMIN, account).lastInsertRowid);
  const path = `/recipes/${recipe}/provider-thumbnail`;
  try {
    assert.deepEqual(await call('GET', path, NO_BODY), { status: 200, body: { type: 'image/jpeg', length: JPEG_BYTES.length } });
    provider.mode = 'throw';
    assert.deepEqual(await call('GET', path, NO_BODY), { status: 502, body: { error: 'Recipe provider thumbnail proxy failed.', code: 502 } });
    provider.mode = 'none';
    assert.deepEqual(await call('GET', path, NO_BODY), { status: 404, body: { error: 'No thumbnail available.', code: 404 } });
    provider.mode = 'ok';
    assert.deepEqual(await withFailingSql(/FROM recipe_provider_accounts/, () => call('GET', path, NO_BODY)),
      { status: 502, body: { error: 'Recipe provider thumbnail proxy failed.', code: 502 } });
  } finally {
    provider.mode = 'ok';
    db.prepare('DELETE FROM recipe_provider_accounts WHERE id = ?').run(account);
  }
  assert.deepEqual(logged.error, [], 'no thumbnail failure reached the central handler');
});

test('recipe providers: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const created = await call('POST', '/recipe-providers/accounts', { name: 'Probe', base_url: 'https://probe.example', api_token: 'tok' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  for (const [sql, method, path, body, pattern] of /** @type {Array<[RegExp, string, string, unknown, string]>} */ ([
    [/FROM recipe_provider_accounts ORDER BY/, 'GET', '/recipe-providers/accounts', NO_BODY, '/api/v1/recipe-providers/accounts'],
    [/INSERT INTO recipe_provider_accounts/, 'POST', '/recipe-providers/accounts', { name: 'x', base_url: 'https://x.example', api_token: 't' }, '/api/v1/recipe-providers/accounts'],
    [/FROM recipe_provider_accounts WHERE id/, 'PATCH', `/recipe-providers/accounts/${id}`, {}, '/api/v1/recipe-providers/accounts/:id'],
    [/DELETE FROM recipe_provider_accounts/, 'DELETE', `/recipe-providers/accounts/${id}`, NO_BODY, '/api/v1/recipe-providers/accounts/:id'],
    [/FROM recipe_provider_accounts WHERE id/, 'POST', `/recipe-providers/accounts/${id}/test`, {}, '/api/v1/recipe-providers/accounts/:id/test'],
    [/FROM recipe_provider_accounts WHERE id/, 'POST', `/recipe-providers/accounts/${id}/sync`, {}, '/api/v1/recipe-providers/accounts/:id/sync'],
    [/FROM recipe_provider_accounts/, 'POST', '/recipe-providers/sync', NO_BODY, '/api/v1/recipe-providers/sync'],
    [/FROM recipe_provider_accounts/, 'GET', '/recipe-providers/status', NO_BODY, '/api/v1/recipe-providers/status'],
  ])) {
    assertCentral(await withFailingSql(sql, () => call(method, path, body)), method, pattern);
  }
  assert.equal((await call('GET', '/recipe-providers/accounts', NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('DELETE', `/recipe-providers/accounts/${id}`, NO_BODY)).status, 204);
});

test('recipe providers: a duplicate address stays the route\'s 409 and a refused connection its 502', async () => {
  logged.error.length = 0;
  const body = { name: 'Doppelt', base_url: 'https://double.example', api_token: 'tok' };
  const created = await call('POST', '/recipe-providers/accounts', body);
  assert.equal(created.status, 201);
  assert.deepEqual(await call('POST', '/recipe-providers/accounts', { ...body, base_url: 'https://double.example/' }), {
    status: 409, body: { error: 'A recipe provider account with this URL already exists.', code: 409, reason: 'recipe_providers_account_exists' },
  });
  provider.mode = 'refuse';
  try {
    assert.deepEqual(await call('POST', '/recipe-providers/accounts', { ...body, base_url: 'https://other.example' }), {
      status: 502, body: { error: 'Could not connect to the recipe provider with these credentials.', code: 502, reason: 'recipe_providers_connection_failed' },
    });
  } finally {
    provider.mode = 'ok';
  }
  assert.deepEqual(logged.error, [], 'neither reached the central handler');
  assert.equal((await call('DELETE', `/recipe-providers/accounts/${created.body.data.id}`, NO_BODY)).status, 204);
});

test('pantry: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const item = (await call('POST', '/pantry', { name: 'Probe' })).body.data;
  const loc = (await call('POST', '/pantry/locations', { name: 'Probeort' })).body.data;
  for (const [sql, method, path, body, pattern] of /** @type {Array<[RegExp, string, string, unknown, string]>} */ ([
    [/FROM pantry_locations ORDER BY/, 'GET', '/pantry/locations', NO_BODY, '/api/v1/pantry/locations'],
    [/FROM pantry_locations WHERE name/, 'POST', '/pantry/locations', { name: 'x' }, '/api/v1/pantry/locations'],
    [/UPDATE pantry_locations SET sort_order/, 'PATCH', '/pantry/locations/reorder', { order: [loc.id] }, '/api/v1/pantry/locations/reorder'],
    [/FROM pantry_locations WHERE id/, 'PUT', `/pantry/locations/${loc.id}`, { name: 'x' }, '/api/v1/pantry/locations/:locId'],
    [/FROM pantry_locations WHERE id/, 'DELETE', `/pantry/locations/${loc.id}`, NO_BODY, '/api/v1/pantry/locations/:locId'],
    [/FROM shopping_lists/, 'POST', '/pantry/import-shopping', { list_id: LIST }, '/api/v1/pantry/import-shopping'],
    [/DELETE FROM pantry_items/, 'POST', '/pantry/import-shopping/undo', { changes: [{ pantry_item_id: item.id, kind: 'added' }] }, '/api/v1/pantry/import-shopping/undo'],
    [/FROM pantry_items pi/, 'GET', '/pantry', NO_BODY, '/api/v1/pantry/'],
    [/FROM pantry_products WHERE id/, 'DELETE', '/pantry/products/1', NO_BODY, '/api/v1/pantry/products/:productId'],
    [/INSERT INTO pantry_items/, 'POST', '/pantry', { name: 'x' }, '/api/v1/pantry/'],
    [/FROM pantry_items pi/, 'PUT', `/pantry/${item.id}`, { name: 'x' }, '/api/v1/pantry/:itemId'],
    [/FROM pantry_items pi/, 'PATCH', `/pantry/${item.id}`, { quantity: 2 }, '/api/v1/pantry/:itemId'],
    [/DELETE FROM pantry_items/, 'DELETE', `/pantry/${item.id}`, NO_BODY, '/api/v1/pantry/:itemId'],
  ])) {
    assertCentral(await withFailingSql(sql, () => call(method, path, body)), method, pattern);
  }
  assert.equal((await call('GET', '/pantry', NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('DELETE', `/pantry/${item.id}`, NO_BODY)).status, 204);
  assert.equal((await call('DELETE', `/pantry/locations/${loc.id}`, NO_BODY)).status, 200);
});
