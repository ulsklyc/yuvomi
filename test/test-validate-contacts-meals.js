/**
 * Test: request validation in contacts, CardDAV and the meal plan (#2810,
 *       phase 2 section E, group 7)
 * Purpose: server/routes/contacts.js (12 routes), cardav.js (9) and meals.js
 *          (11) check every request against the schema of its operation in
 *          the OpenAPI document (`validateRequest()` in every route) before
 *          the handler runs. Held here against the real routers at their real
 *          prefixes, in the order of server/index.js (express.json,
 *          defaultEmptyBody, the routers, the central error handler;
 *          test/contacts-meals-app.js):
 *            - THE OWN CALLERS: the requests public/pages/contacts.js (form
 *              and vCard import), components/category-manager.js,
 *              settings/pages/sync-contacts.js, public/pages/meals.js (after
 *              its switch to a numeric `recipe_id`; that the dialog sends it
 *              is held in test:meals-cook, where the dialog runs) and
 *              utils/recipe-to-meal.js send pass, ids as numbers and as
 *              legacy digit text;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              (or the route's own reason where the schema names it) and
 *              `fields`: a path id that is not plain decimal digits (`0x10`
 *              read as 0), a non-text in a text field (`name: {}` was stored
 *              as `[object Object]`, `name: 123` at PUT answered 500), an
 *              unknown `scope` (DELETE removed the meal), `week=abc` (fell
 *              back to the current week), `week=2026-13-45` (500),
 *              `order: {}` (500 with an object entry), `recipe_id: "0x10"`
 *              (read as recipe 16), query garbage and doubled values;
 *            - ORDER: a malformed request is a 400 before the 404, 403 and
 *              409 of the handler; the rights without a row stand in front:
 *              `requireAdmin` on every CardDAV route, the shopping write right
 *              (403 `cross_module_access`) on both transfers;
 *            - THE SINKS: the household week start looks up only own keys
 *              (`constructor` stored as `week_start` answered 500), and the
 *              CardDAV page translates only its own error codes;
 *            - ONE SOURCE: every list of the schemas is the constant the
 *              handler reads.
 *          The household zone is pinned; no answer asserted here carries a
 *          date of the clock.
 * Run: npm run test:validate-contacts-meals
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-validate-contacts-meals-');

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContactsMealsApp } from './contacts-meals-app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const mealsFields = await import('../server/services/meals-fields.js');
const contactsFields = await import('../server/services/contacts-fields.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin7', 'admin');
const MEM = user('mem7', 'member');
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  // A token scoped to the meal plan alone: no write right on the shopping list.
  mealtoken: { id: ADMIN, role: 'admin', scopes: ['meals:read', 'meals:write'] },
};

const app = await createContactsMealsApp({
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.scopes ? 'token' : 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role };
    next();
  },
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: string }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor !== undefined) headers['x-actor'] = actor;
  /** @type {any} */
  let payload;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body, text };
}

/**
 * A refusal of the schema: 400, the fixed sentence, the reason and the field.
 * @param {{ status: number, body: any }} res
 * @param {string} path e.g. `body/title`
 * @param {string} label
 * @param {string} [reason]
 */
function refused(res, path, label, reason = 'validation') {
  assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, reason, `${label}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

/**
 * A request the route takes: not a refusal of the schema and not a 500.
 * @param {{ status: number, body: any }} res
 * @param {string} label
 */
function accepted(res, label) {
  assert.ok(res.status < 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
}

/**
 * Not refused by the schema (the route may still answer, e.g. 502 for a
 * CardDAV server that cannot be reached).
 * @param {{ status: number, body: any }} res
 * @param {string} label
 */
function passedSchema(res, label) {
  assert.notEqual(res.body?.error, SENTENCE, `${label}: ${JSON.stringify(res.body)}`);
  assert.notEqual(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const RECIPE = Number(db.prepare("INSERT INTO recipes (title, created_by) VALUES ('Suppe', ?)").run(ADMIN).lastInsertRowid);
const LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('REWE', ?)").run(ADMIN).lastInsertRowid);
const FAMILY = Number(db.prepare("INSERT INTO contacts (name, category, family_user_id) VALUES ('Mitglied', 'misc', ?)").run(MEM).lastInsertRowid);
// A CardDAV server on a port nobody listens on: the routes that connect fail
// fast and locally, never on the network.
const ACCOUNT = Number(db.prepare("INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('Konto', 'http://127.0.0.1:1/dav/', 'u', 'p')").run().lastInsertRowid);
const BOOK = Number(db.prepare("INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled) VALUES (?, 'http://127.0.0.1:1/dav/a/', 'A', 1)").run(ACCOUNT).lastInsertRowid);

/** What the contact form sends (public/pages/contacts.js, the save handler). */
const FORM_CONTACT = (/** @type {Record<string, unknown>} */ over = {}) => ({
  name: 'Ada Lovelace', category: 'misc', phone: '0800 1', email: 'ada@example.org', address: null, notes: null,
  birthday: '1990-07-18', birthday_year_unknown: false,
  phones: [{ label: 'other', value: '0800 1', isPrimary: true }],
  emails: [{ label: 'other', value: 'ada@example.org', isPrimary: true }],
  firstName: 'Ada', lastName: 'Lovelace', ...over,
});
/** What the meal dialog sends on create (public/pages/meals.js, saveModal). */
const FORM_MEAL = (/** @type {Record<string, unknown>} */ over = {}) => ({
  date: '2031-03-03', meal_type: 'dinner', title: 'Eintopf', notes: null, recipe_url: null, recipe_id: null, cook_user_id: null,
  ingredients: [{ name: 'Linsen', quantity: null, category: 'Sonstiges', id: null }], repeat_weekly: false, repeat_until: '', ...over,
});

const contact = (await call('POST', '/contacts', { json: FORM_CONTACT() })).body.data;
const meal = (await call('POST', '/meals', { json: FORM_MEAL() })).body.data;
const series = (await call('POST', '/meals', { json: FORM_MEAL({ date: '2031-04-07', repeat_weekly: true, title: 'Serie' }) })).body.data;
assert.ok(contact?.id && meal?.id && series?.recurrence_template_id, 'Vorbedingung: Kontakt, Mahlzeit und Serie stehen');

// ---------------------------------------------------------------------------
// 1. The own callers pass
// ---------------------------------------------------------------------------

test('contacts: the form, the vCard import and the category manager pass', async () => {
  accepted(await call('GET', '/contacts'), 'GET list');
  accepted(await call('GET', '/contacts?category=misc&q=Ada'), 'GET list with filters');
  accepted(await call('GET', '/contacts/meta'), 'GET meta');
  accepted(await call('GET', '/contacts/categories'), 'GET categories');
  accepted(await call('GET', `/contacts/${contact.id}`), 'GET one');
  const vcard = await call('GET', `/contacts/${contact.id}/vcard`);
  assert.equal(vcard.status, 200);
  assert.match(vcard.text, /^BEGIN:VCARD/);
  accepted(await call('POST', '/contacts', { json: FORM_CONTACT({ birthday: null, phones: [], emails: [] }) }), 'POST form, empty lists');
  accepted(await call('PUT', `/contacts/${contact.id}`, { json: FORM_CONTACT({ birthday: '2000-02-29', birthday_year_unknown: true }) }), 'PUT form');
  // The vCard import: the parser's fields, parts and text fields as null.
  accepted(await call('POST', '/contacts', { json: {
    name: 'Grace Hopper', firstName: 'Grace', lastName: 'Hopper', middleName: null, namePrefix: null, nameSuffix: null,
    phone: null, email: null, address: null, notes: null, birthday: null, category: 'misc', birthday_year_unknown: false,
  } }), 'POST vCard import');
  // `birthday_year_unknown` as the API answers it (0/1) and `null`.
  accepted(await call('PUT', `/contacts/${contact.id}`, { json: { birthday_year_unknown: 0, birthday: '1990-07-18' } }), 'flag 0');
  accepted(await call('PUT', `/contacts/${contact.id}`, { json: { birthday_year_unknown: null, birthday: '' } }), 'flag null, birthday cleared');
  // Addresses: only API clients send them.
  accepted(await call('PUT', `/contacts/${contact.id}`, { json: { addresses: [{ label: 'home', street: 'Weg 1', city: 'Berlin', isPrimary: true }] } }), 'addresses');

  const created = await call('POST', '/contacts/categories', { json: { name: 'Nachbarn' } });
  assert.equal(created.status, 201);
  const key = created.body.data.key;
  accepted(await call('PUT', `/contacts/categories/${encodeURIComponent(key)}`, { json: { color: contactsFields.CONTACT_CATEGORY_COLORS[0] } }), 'colour');
  accepted(await call('PUT', `/contacts/categories/${encodeURIComponent(key)}`, { json: { color: null } }), 'neutral');
  accepted(await call('PUT', `/contacts/categories/${encodeURIComponent(key)}`, { json: { name: 'Nachbarschaft' } }), 'rename');
  const keys = (await call('GET', '/contacts/categories')).body.data.map((/** @type {any} */ c) => c.key);
  accepted(await call('PATCH', '/contacts/categories/reorder', { json: { order: [...keys].reverse() } }), 'reorder');
  assert.equal((await call('DELETE', `/contacts/categories/${encodeURIComponent(key)}`)).status, 204);

  const gone = (await call('POST', '/contacts', { json: { name: 'Weg' } })).body.data;
  assert.equal((await call('DELETE', `/contacts/${gone.id}`)).status, 204);
});

test('CardDAV: the settings page passes', async () => {
  accepted(await call('GET', '/contacts/cardav/accounts'), 'GET accounts');
  accepted(await call('GET', `/contacts/cardav/accounts/${ACCOUNT}/addressbooks`), 'GET addressbooks');
  accepted(await call('PUT', `/contacts/cardav/addressbooks/${BOOK}`, { json: { enabled: false } }), 'toggle');
  // Editing without a new password sends it empty.
  accepted(await call('PUT', `/contacts/cardav/accounts/${ACCOUNT}`, { json: { name: 'Konto', cardavUrl: 'http://127.0.0.1:1/dav/', username: 'u', password: '' } }), 'PUT account');
  // These connect: the server is unreachable, so the route answers 502 or 500 - but not the schema.
  passedSchema(await call('POST', '/contacts/cardav/accounts', { json: { name: 'Neu', cardavUrl: 'http://127.0.0.1:1/x/', username: 'u', password: ' geheim ' } }), 'POST account');
  passedSchema(await call('POST', `/contacts/cardav/accounts/${ACCOUNT}/test`), 'test');
  passedSchema(await call('POST', `/contacts/cardav/accounts/${ACCOUNT}/addressbooks/refresh`), 'refresh');
  passedSchema(await call('POST', `/contacts/cardav/accounts/${ACCOUNT}/sync`), 'sync');
  const extra = Number(db.prepare("INSERT INTO carddav_accounts (name, carddav_url, username, password) VALUES ('Weg', 'http://127.0.0.1:1/w/', 'w', 'p')").run().lastInsertRowid);
  accepted(await call('DELETE', `/contacts/cardav/accounts/${extra}`), 'DELETE account');
});

test('meal plan: the dialog, recipes, the planner and the transfer pass', async () => {
  accepted(await call('GET', '/meals?week=2031-03-03'), 'GET week');
  accepted(await call('GET', '/meals'), 'GET current week');
  accepted(await call('GET', '/meals/suggestions?q=Ein'), 'suggestions');
  accepted(await call('GET', '/meals/suggestions'), 'suggestions without q');
  accepted(await call('POST', '/meals', { json: FORM_MEAL({ recipe_id: RECIPE, cook_user_id: MEM }) }), 'POST dialog');
  accepted(await call('POST', '/meals', { json: FORM_MEAL({ repeat_weekly: true, repeat_until: '2031-06-01' }) }), 'POST series with end');
  // Legacy digit text for the ids (older app versions sent the <select> value).
  accepted(await call('POST', '/meals', { json: FORM_MEAL({ recipe_id: String(RECIPE), cook_user_id: String(MEM) }) }), 'legacy digit text');
  accepted(await call('POST', '/meals', { json: FORM_MEAL({ repeat_until: null }) }), 'repeat_until null');
  // The recipe page and the planner: the shape of mealPayloadFromRecipe() (utils/recipe-to-meal.js).
  const fromRecipe = { date: '2031-03-04', meal_type: 'lunch', title: 'Suppe', notes: null, recipe_url: null, recipe_id: RECIPE, ingredients: [{ name: 'Salz', quantity: null, category: 'Sonstiges' }] };
  accepted(await call('POST', '/meals', { json: fromRecipe }), 'POST from recipe');
  accepted(await call('POST', '/meals/apply-plan', { json: { assignments: [fromRecipe], replace_existing: true } }), 'apply-plan');
  accepted(await call('POST', '/meals/apply-plan', { json: { assignments: [fromRecipe], replace_existing: false } }), 'apply-plan additive');

  accepted(await call('PUT', `/meals/${meal.id}`, { json: { date: '2031-03-03', meal_type: 'lunch', title: 'Eintopf', notes: null, recipe_url: null, recipe_id: RECIPE, cook_user_id: null } }), 'PUT single');
  accepted(await call('PUT', `/meals/${meal.id}`, { json: { date: '2031-03-05', meal_type: 'dinner' } }), 'PUT drag');
  accepted(await call('PUT', `/meals/${series.id}?scope=series`, { json: { meal_type: 'dinner', title: 'Serie', notes: null, recipe_url: null, recipe_id: null, ingredients: [{ name: 'Reis', quantity: '1 kg', category: 'Sonstiges', id: '7' }], repeat_until: '' } }), 'PUT series');
  accepted(await call('PUT', `/meals/${series.id}?scope=single`, { json: { title: 'Einzeln' } }), 'PUT scope=single');

  const ing = await call('POST', `/meals/${meal.id}/ingredients`, { json: { name: 'Zwiebel', quantity: null, category: 'Sonstiges' } });
  assert.equal(ing.status, 201);
  accepted(await call('PATCH', `/meals/ingredients/${ing.body.data.id}`, { json: { name: 'Zwiebeln', quantity: '2', on_shopping_list: false } }), 'PATCH ingredient');
  accepted(await call('POST', `/meals/${meal.id}/to-shopping-list`, { json: { listId: LIST } }), 'transfer');
  accepted(await call('POST', '/meals/week-to-shopping-list', { json: { listId: LIST, week: '2031-03-03' } }), 'week transfer');
  assert.equal((await call('DELETE', `/meals/ingredients/${ing.body.data.id}`)).status, 204);

  for (const scope of mealsFields.MEAL_DELETE_SCOPES) {
    const s = (await call('POST', '/meals', { json: FORM_MEAL({ date: '2032-01-05', repeat_weekly: true }) })).body.data;
    assert.equal((await call('DELETE', `/meals/${s.id}?scope=${scope}`)).status, 204, scope);
  }
  const single = (await call('POST', '/meals', { json: FORM_MEAL({ date: '2032-02-02' }) })).body.data;
  assert.equal((await call('DELETE', `/meals/${single.id}`)).status, 204, 'without scope');
});

// ---------------------------------------------------------------------------
// 2. Refused per field
// ---------------------------------------------------------------------------

const BAD_IDS = ['0x10', '7abc', '1e2', '1.5', ' 5'];

test('a path id that is not plain decimal digits is a 400 on every route with one', async () => {
  /** @type {Array<[string, (id: string) => string, unknown?]>} */
  const routes = [
    ['GET', (id) => `/contacts/${id}`],
    ['PUT', (id) => `/contacts/${id}`, {}],
    ['DELETE', (id) => `/contacts/${id}`],
    ['GET', (id) => `/contacts/${id}/vcard`],
    ['PUT', (id) => `/contacts/cardav/accounts/${id}`, { name: 'a', cardavUrl: 'b', username: 'c' }],
    ['DELETE', (id) => `/contacts/cardav/accounts/${id}`],
    ['POST', (id) => `/contacts/cardav/accounts/${id}/test`],
    ['GET', (id) => `/contacts/cardav/accounts/${id}/addressbooks`],
    ['POST', (id) => `/contacts/cardav/accounts/${id}/addressbooks/refresh`],
    ['PUT', (id) => `/contacts/cardav/addressbooks/${id}`, { enabled: true }],
    ['POST', (id) => `/contacts/cardav/accounts/${id}/sync`],
    ['PUT', (id) => `/meals/${id}`, {}],
    ['DELETE', (id) => `/meals/${id}`],
    ['POST', (id) => `/meals/${id}/ingredients`, { name: 'x' }],
    ['PATCH', (id) => `/meals/ingredients/${id}`, {}],
    ['DELETE', (id) => `/meals/ingredients/${id}`],
    ['POST', (id) => `/meals/${id}/to-shopping-list`, { listId: LIST }],
  ];
  for (const [method, path, json] of routes) {
    for (const id of BAD_IDS) {
      const param = path(encodeURIComponent(id)).includes('/ingredients/') ? 'path/ingId' : 'path/id';
      refused(await call(method, path(encodeURIComponent(id)), { json }), param, `${method} ${path(id)}`);
    }
  }
  // `0x10` read as 0 before and found no row (404); now the schema says it.
  const before = db.prepare('SELECT COUNT(*) AS n FROM meals').get();
  refused(await call('DELETE', '/meals/0x10'), 'path/id', 'DELETE /meals/0x10');
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM meals').get(), before);
});

test('contacts: a text field that is not text, a list that is not a list, a flag that is text', async () => {
  for (const [field, value] of /** @type {Array<[string, unknown]>} */ ([
    ['name', {}], ['name', 5], ['name', []], ['name', true], ['firstName', 5], ['lastName', {}], ['phone', 5], ['email', []],
    ['address', 7], ['notes', []], ['category', 5], ['birthday', 5], ['birthday_year_unknown', 'true'], ['birthday_year_unknown', 2],
  ])) {
    const label = `${field}: ${JSON.stringify(value)}`;
    refused(await call('POST', '/contacts', { json: { name: 'Ada', [field]: value } }), `body/${field}`, `POST ${label}`);
    refused(await call('PUT', `/contacts/${contact.id}`, { json: { [field]: value } }), `body/${field}`, `PUT ${label}`);
  }
  // `name: {}` was stored as "[object Object]"; nothing is written now.
  const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  refused(await call('POST', '/contacts', { json: { name: {} } }), 'body/name', 'name {}');
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM contacts').get(), count);
  // `name: 123` at PUT answered 500 (`.trim` on a number).
  refused(await call('PUT', `/contacts/${contact.id}`, { json: { name: 123 } }), 'body/name', 'PUT name 123');

  // The form of the birthday: the route's own reason.
  refused(await call('POST', '/contacts', { json: { name: 'Ada', birthday: '18.07.1990' } }), 'body/birthday', 'birthday form', 'contacts_birthday_invalid');
  // A day that does not exist stays the route's check, with the same reason.
  const feb30 = await call('POST', '/contacts', { json: { name: 'Ada', birthday: '1990-02-30' } });
  assert.equal(feb30.status, 400);
  assert.equal(feb30.body.reason, 'contacts_birthday_invalid');
  assert.equal(feb30.body.fields, undefined, 'the route, not the schema');

  // A multi-value field that is not a list: the field's own reason.
  refused(await call('POST', '/contacts', { json: { name: 'Ada', phones: 'x' } }), 'body/phones', 'phones', 'contacts_phone_entry_invalid');
  refused(await call('POST', '/contacts', { json: { name: 'Ada', emails: {} } }), 'body/emails', 'emails', 'contacts_email_entry_invalid');
  refused(await call('PUT', `/contacts/${contact.id}`, { json: { addresses: null } }), 'body/addresses', 'addresses', 'contacts_address_entry_invalid');
  // An entry out of shape: `validation`, the field named.
  refused(await call('POST', '/contacts', { json: { name: 'Ada', phones: [null] } }), 'body/phones/0', 'phones [null]');
  refused(await call('POST', '/contacts', { json: { name: 'Ada', emails: [{ label: 'x' }] } }), 'body/emails/0/value', 'email without value');
  refused(await call('POST', '/contacts', { json: { name: 'Ada', addresses: [{ label: 'x', city: 5 }] } }), 'body/addresses/0/city', 'city 5');
  // Lengths stay the route's, with `params.limit`.
  const long = await call('POST', '/contacts', { json: { name: 'Ada', phone: '1'.repeat(101) } });
  assert.equal(long.body.reason, 'contacts_phone_too_long');
  assert.deepEqual(long.body.params, { limit: 100 });

  refused(await call('GET', '/contacts?q=a&q=b'), 'query/q', 'doubled q');
  refused(await call('GET', '/contacts?category=a&category=b'), 'query/category', 'doubled category');
});

test('contact categories: name, colour, order', async () => {
  refused(await call('POST', '/contacts/categories', { json: {} }), 'body/name', 'POST without name');
  refused(await call('POST', '/contacts/categories', { json: { name: 5 } }), 'body/name', 'POST name 5');
  refused(await call('POST', '/contacts/categories', { json: { name: 'Neu', color: 'red' } }), 'body/color', 'POST colour off the list');
  // `order` not a list: 200 and nothing changed before; an object entry 500.
  for (const order of [{}, 'x', [{}], [true], [['misc']]]) {
    const res = await call('PATCH', '/contacts/categories/reorder', { json: { order } });
    assert.equal(res.status, 400, JSON.stringify(order));
    assert.equal(res.body.reason, 'validation');
  }
  refused(await call('PATCH', '/contacts/categories/reorder', { json: {} }), 'body/order', 'reorder without order');
  const neither = await call('PUT', '/contacts/categories/misc', { json: {} });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.error, SENTENCE);
  assert.equal(neither.body.reason, 'validation');
  refused(await call('PUT', '/contacts/categories/misc', { json: { name: 5 } }), 'body/name', 'PUT name 5');
  refused(await call('PUT', '/contacts/categories/misc', { json: { color: 5 } }), 'body/color', 'PUT colour 5');
});

test('CardDAV: missing or non-text fields, a switch that is not a boolean', async () => {
  refused(await call('POST', '/contacts/cardav/accounts', { json: {} }), 'body/name', 'POST empty');
  refused(await call('POST', '/contacts/cardav/accounts', { json: { name: 5, cardavUrl: 'u', username: 'u', password: 'p' } }), 'body/name', 'POST name 5');
  refused(await call('POST', '/contacts/cardav/accounts', { json: { name: 'n', cardavUrl: 'u', username: 'u', password: 1234 } }), 'body/password', 'POST password 1234');
  // A password that is not text counted silently as empty before.
  refused(await call('PUT', `/contacts/cardav/accounts/${ACCOUNT}`, { json: { name: 'n', cardavUrl: 'u', username: 'u', password: 1234 } }), 'body/password', 'PUT password 1234');
  for (const enabled of ['true', 1, null]) {
    refused(await call('PUT', `/contacts/cardav/addressbooks/${BOOK}`, { json: { enabled } }), 'body/enabled', `enabled ${JSON.stringify(enabled)}`);
  }
  refused(await call('PUT', `/contacts/cardav/addressbooks/${BOOK}`, { json: {} }), 'body/enabled', 'enabled missing');
  // An account that does not exist: 404 (was 500 `internal`).
  const gone = await call('DELETE', '/contacts/cardav/accounts/987654');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.errorCode, 'account_not_found');
});

test('meal plan: create and plan - text, ids, the meal type, the series, the ingredients', async () => {
  /** @type {Array<[string, unknown]>} */
  const cases = [
    ['title', 5], ['title', {}], ['notes', 5], ['recipe_url', []], ['meal_type', 'brunch'], ['meal_type', null], ['meal_type', ''],
    ['date', '2026-02-30'], ['date', 20260101], ['recipe_id', '0x10'], ['recipe_id', true], ['recipe_id', []], ['recipe_id', 1.5],
    ['recipe_id', ''], ['recipe_id', '0'], ['cook_user_id', '01'], ['cook_user_id', 0], ['cook_user_id', true], ['cook_user_id', ''],
    ['ingredients', 'abc'], ['ingredients', {}], ['ingredients', null],
  ];
  const count = db.prepare('SELECT COUNT(*) AS n FROM meals').get();
  for (const [field, value] of cases) {
    const label = `${field}: ${JSON.stringify(value)}`;
    refused(await call('POST', '/meals', { json: FORM_MEAL({ [field]: value }) }), `body/${field}`, `POST ${label}`);
    refused(await call('POST', '/meals/apply-plan', { json: { assignments: [FORM_MEAL({ [field]: value })] } }), `body/assignments/0/${field}`, `apply-plan ${label}`);
  }
  refused(await call('POST', '/meals', { json: FORM_MEAL({ ingredients: [null] }) }), 'body/ingredients/0', 'ingredient null');
  refused(await call('POST', '/meals', { json: FORM_MEAL({ ingredients: [{ name: 5 }] }) }), 'body/ingredients/0/name', 'ingredient name 5');
  refused(await call('POST', '/meals', { json: FORM_MEAL({ repeat_weekly: 'true' }) }), 'body/repeat_weekly', 'repeat_weekly text');
  refused(await call('POST', '/meals', { json: FORM_MEAL({ repeat_weekly: true, repeat_until: 'x' }) }), 'body/repeat_until', 'repeat_until x');
  // `recipe_id: "0x10"` was read as recipe 16 by Number().
  refused(await call('POST', '/meals', { json: FORM_MEAL({ recipe_id: '0x10' }) }), 'body/recipe_id', 'recipe_id 0x10');

  for (const assignments of [[null], 'x', {}, []]) {
    const res = await call('POST', '/meals/apply-plan', { json: { assignments } });
    assert.equal(res.status, 400, JSON.stringify(assignments));
    assert.equal(res.body.reason, 'validation');
  }
  refused(await call('POST', '/meals/apply-plan', { json: { assignments: [FORM_MEAL()], skip_occupied: 'true' } }), 'body/skip_occupied', 'skip_occupied text');
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM meals').get(), count, 'nothing written');

  // A recipe that does not exist stays the route's reason.
  const gone = await call('POST', '/meals', { json: FORM_MEAL({ recipe_id: 987654 }) });
  assert.equal(gone.status, 400);
  assert.equal(gone.body.reason, 'meals_selected_recipe_not_found');
  // A digit text above the safe integers passes the schema; cookField() refuses it.
  const unsafe = await call('POST', '/meals', { json: FORM_MEAL({ cook_user_id: '9007199254740993' }) });
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.body.fields, undefined, 'the route, not the schema');
});

test('meal plan: update, delete, ingredients, the week and the transfers', async () => {
  // These answered 500 before (`.trim` on a number, a truth value bound raw).
  refused(await call('PUT', `/meals/${meal.id}`, { json: { title: 5 } }), 'body/title', 'PUT title 5');
  refused(await call('PUT', `/meals/${meal.id}`, { json: { recipe_id: true } }), 'body/recipe_id', 'PUT recipe_id true');
  refused(await call('PUT', `/meals/${meal.id}`, { json: { recipe_id: [] } }), 'body/recipe_id', 'PUT recipe_id []');
  refused(await call('PUT', `/meals/${meal.id}`, { json: { date: '' } }), 'body/date', 'PUT date empty');
  refused(await call('PUT', `/meals/${series.id}?scope=series`, { json: { ingredients: 'abc' } }), 'body/ingredients', 'PUT ingredients abc');
  refused(await call('PUT', `/meals/${meal.id}?scope=bogus`, { json: { title: 'X' } }), 'query/scope', 'PUT scope bogus');
  refused(await call('PUT', `/meals/${meal.id}?scope=future`, { json: { title: 'X' } }), 'query/scope', 'PUT scope future');
  refused(await call('PUT', `/meals/${meal.id}?scope=series&scope=single`, { json: { title: 'X' } }), 'query/scope', 'PUT doubled scope');

  // An unknown scope deleted the meal before.
  const victim = (await call('POST', '/meals', { json: FORM_MEAL({ date: '2033-01-03' }) })).body.data;
  refused(await call('DELETE', `/meals/${victim.id}?scope=bogus`), 'query/scope', 'DELETE scope bogus');
  assert.ok(db.prepare('SELECT 1 FROM meals WHERE id = ?').get(victim.id), 'the meal is still there');

  // The week: another form fell back to the current week, out of range 500, empty the current week.
  for (const week of ['abc', '2026-13-45', '9999-99-99', '2026-02-30', '']) {
    refused(await call('GET', `/meals?week=${week}`), 'query/week', `week=${week}`);
  }
  refused(await call('GET', '/meals?week=2031-03-03&week=2031-03-10'), 'query/week', 'doubled week');
  // A doubled q answered 500 (`.trim` on a list).
  refused(await call('GET', '/meals/suggestions?q=a&q=b'), 'query/q', 'doubled q');

  refused(await call('POST', `/meals/${meal.id}/ingredients`, { json: {} }), 'body/name', 'ingredient without name');
  refused(await call('POST', `/meals/${meal.id}/ingredients`, { json: { name: 5 } }), 'body/name', 'ingredient name 5');
  refused(await call('POST', `/meals/${meal.id}/ingredients`, { json: { name: 'x', quantity: 5 } }), 'body/quantity', 'quantity 5');
  refused(await call('POST', `/meals/${meal.id}/ingredients`, { json: { name: 'x', category: {} } }), 'body/category', 'category {}');
  const ing = (await call('POST', `/meals/${meal.id}/ingredients`, { json: { name: 'Salz' } })).body.data;
  refused(await call('PATCH', `/meals/ingredients/${ing.id}`, { json: { name: 5 } }), 'body/name', 'PATCH name 5');
  refused(await call('PATCH', `/meals/ingredients/${ing.id}`, { json: { quantity: 5 } }), 'body/quantity', 'PATCH quantity 5');
  const flag = await call('PATCH', `/meals/ingredients/${ing.id}`, { json: { on_shopping_list: 'yes' } });
  assert.equal(flag.status, 400);
  assert.equal(flag.body.reason, 'validation');

  for (const listId of [true, {}, '1', 0, -1, 1.5]) {
    refused(await call('POST', `/meals/${meal.id}/to-shopping-list`, { json: { listId } }), 'body/listId', `listId ${JSON.stringify(listId)}`);
    refused(await call('POST', '/meals/week-to-shopping-list', { json: { listId, week: '2031-03-03' } }), 'body/listId', `week listId ${JSON.stringify(listId)}`);
  }
  refused(await call('POST', `/meals/${meal.id}/to-shopping-list`, { json: {} }), 'body/listId', 'listId missing');
  refused(await call('POST', '/meals/week-to-shopping-list', { json: { listId: LIST, week: '2026-13-45' } }), 'body/week', 'week out of range');
  refused(await call('POST', '/meals/week-to-shopping-list', { json: { listId: LIST, week: 20260101 } }), 'body/week', 'week number');
});

// ---------------------------------------------------------------------------
// 3. Order
// ---------------------------------------------------------------------------

test('a malformed request is a 400 before the 404, 403 and 409 of the handler', async () => {
  refused(await call('PUT', '/contacts/987654', { json: { name: {} } }), 'body/name', 'PUT unknown contact');
  // The member may not change the emails of another member's contact (403), but the form comes first.
  refused(await call('PUT', `/contacts/${FAMILY}`, { json: { email: 5 }, actor: 'admin' }), 'body/email', 'PUT family contact');
  refused(await call('PUT', '/contacts/categories/gibt-es-nicht', { json: {} }), 'body', 'PUT unknown category', 'validation');
  refused(await call('PUT', '/meals/987654', { json: { title: 5 } }), 'body/title', 'PUT unknown meal');
  refused(await call('DELETE', '/meals/987654?scope=bogus'), 'query/scope', 'DELETE unknown meal');
  refused(await call('POST', '/meals/987654/ingredients', { json: {} }), 'body/name', 'ingredient of unknown meal');
  refused(await call('PATCH', '/meals/ingredients/987654', { json: { name: 5 } }), 'body/name', 'unknown ingredient');
  refused(await call('POST', '/meals/987654/to-shopping-list', { json: { listId: true } }), 'body/listId', 'transfer of unknown meal');
  refused(await call('PUT', '/contacts/cardav/accounts/987654', { json: { name: 'n', cardavUrl: 'u', username: 'u', password: 5 } }), 'body/password', 'PUT unknown account');
  refused(await call('PUT', '/contacts/cardav/addressbooks/987654', { json: { enabled: 'x' } }), 'body/enabled', 'PUT unknown address book');

  // A well-formed request still gets the handler's answers.
  assert.equal((await call('PUT', '/contacts/987654', { json: { name: 'X' } })).body.reason, 'contacts_contact_not_found');
  assert.equal((await call('DELETE', `/contacts/${FAMILY}`)).body.reason, 'family_member_contact');
  assert.equal((await call('PUT', '/meals/987654', { json: { title: 'X' } })).status, 404);
  assert.equal((await call('POST', `/meals/${meal.id}/to-shopping-list`, { json: { listId: 987654 } })).status, 404);
});

test('rights without a row stand in front: requireAdmin on CardDAV, the shopping right on both transfers', async () => {
  for (const [method, route, json] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/contacts/cardav/accounts', undefined],
    ['POST', '/contacts/cardav/accounts', { name: 5 }],
    ['PUT', '/contacts/cardav/addressbooks/0x10', { enabled: 'x' }],
    ['DELETE', '/contacts/cardav/accounts/abc', undefined],
  ])) {
    const res = await call(method, route, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${method} ${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'admin_required');
  }
  // A member without the shopping write right, a valid request: 403.
  const valid = await call('POST', `/meals/${meal.id}/to-shopping-list`, { json: { listId: LIST }, actor: 'mealtoken' });
  assert.equal(valid.status, 403);
  assert.equal(valid.body.reason, 'cross_module_access');
  const validWeek = await call('POST', '/meals/week-to-shopping-list', { json: { listId: LIST, week: '2031-03-03' }, actor: 'mealtoken' });
  assert.equal(validWeek.status, 403);
  assert.equal(validWeek.body.reason, 'cross_module_access');
  // ... and a broken one: still 403, before the 400.
  const broken = await call('POST', '/meals/0x10/to-shopping-list', { json: { listId: true }, actor: 'mealtoken' });
  assert.equal(broken.status, 403);
  assert.equal(broken.body.reason, 'cross_module_access');
  const brokenWeek = await call('POST', '/meals/week-to-shopping-list', { json: { week: 'x' }, actor: 'mealtoken' });
  assert.equal(brokenWeek.status, 403);
  assert.equal(brokenWeek.body.reason, 'cross_module_access');
});

// ---------------------------------------------------------------------------
// 4. The sinks
// ---------------------------------------------------------------------------

test('the household week start looks up only own keys', async () => {
  const set = db.prepare("INSERT INTO sync_config (key, value) VALUES ('week_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  try {
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      set.run(value);
      const res = await call('GET', '/meals?week=2031-03-05');
      assert.equal(res.status, 200, `${value}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.weekStart, '2031-03-03', `${value}: the default, Monday`);
    }
    set.run('sunday');
    assert.equal((await call('GET', '/meals?week=2031-03-05')).body.weekStart, '2031-03-02', 'a real key still counts');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'week_start'").run();
  }
});

test('the CardDAV page translates only its own error codes, and the schema refusal', () => {
  // The page imports browser paths (/api.js, /i18n.js); the loader of the
  // frontend suites maps them, so it runs in a child process.
  const script = `
    globalThis.HTMLElement = class {}; globalThis.customElements = { define() {}, get() {} };
    const { installMiniDom } = await import('./test/mini-dom.js'); installMiniDom();
    const { __test } = await import('./public/settings/pages/sync-contacts.js');
    const say = (data) => __test.errorMessage({ data, message: 'x' }, 'common.errorGeneric');
    console.log(JSON.stringify({
      own: say({ errorCode: 'account_not_found' }),
      schema: say({ reason: 'validation', fields: [] }),
      sinks: ['constructor', '__proto__', 'toString'].map((errorCode) => say({ errorCode })),
    }));`;
  const out = execFileSync(process.execPath, ['--no-warnings', '--loader', './test/test-browser-loader.mjs', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  const said = JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
  assert.equal(said.own, 'settings.cardavErrorAccountNotFound');
  assert.equal(said.schema, 'common.invalidInput', 'the 400 of the schema carries no errorCode');
  assert.deepEqual(said.sinks, ['common.errorGeneric', 'common.errorGeneric', 'common.errorGeneric']);
});

// ---------------------------------------------------------------------------
// 5. One source
// ---------------------------------------------------------------------------

test('every list of the schemas is the constant the handler reads', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const body = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema;
  const query = (/** @type {string} */ path, /** @type {string} */ method, /** @type {string} */ name) => spec.paths[path][method].parameters.find((/** @type {any} */ p) => p.name === name).schema;
  assert.deepEqual(body('/api/v1/meals', 'post').properties.meal_type.enum, [...mealsFields.MEAL_TYPES]);
  assert.deepEqual(body('/api/v1/meals/{id}', 'put').properties.meal_type.enum, [...mealsFields.MEAL_TYPES]);
  assert.deepEqual(body('/api/v1/meals/apply-plan', 'post').properties.assignments.items.properties.meal_type.enum, [...mealsFields.MEAL_TYPES]);
  assert.deepEqual(query('/api/v1/meals/{id}', 'put', 'scope').enum, [...mealsFields.MEAL_UPDATE_SCOPES]);
  assert.deepEqual(query('/api/v1/meals/{id}', 'delete', 'scope').enum, [...mealsFields.MEAL_DELETE_SCOPES]);
  assert.deepEqual(body('/api/v1/contacts/categories', 'post').properties.color.enum, [...contactsFields.CONTACT_CATEGORY_COLORS, '', null]);
  assert.deepEqual(body('/api/v1/contacts/categories/{key}', 'put').properties.color.enum, [...contactsFields.CONTACT_CATEGORY_COLORS, '', null]);
});

test('the colours the page offers are the ones the route takes', async () => {
  const meta = (await call('GET', '/contacts/meta')).body.data;
  assert.deepEqual(meta.categoryColors, [...contactsFields.CONTACT_CATEGORY_COLORS]);
});

// The schema is the only guard since step (b) of group 7 (#2810): the handlers
// dropped `oneOf(meal_type)` and its German "Mahlzeit-Typ ist erforderlich.",
// `num(recipe_id)`, the `skip_occupied` type check, `!listId`, `bool(enabled)`
// and the unknown-colour branch. So the types, lists, bounds and required
// fields behind them are pinned here as literals - a looser type, a lost
// `required`, a `null` let in or a wider bound turns this red. The lists
// themselves are pinned against their constant in the case above.
test('only guard: what the handlers no longer check is the document\'s, as values', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const body = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema;
  const RECIPE_ID = [{ type: 'integer' }, { type: 'string', pattern: '^0*[1-9][0-9]*$' }, { type: 'null' }];
  const MEAL_TYPE = { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] };

  // meal_type: required and one of the list on create and in apply-plan, never null on update.
  const create = body('/api/v1/meals', 'post');
  assert.deepEqual(create.required, ['date', 'meal_type', 'title']);
  assert.deepEqual(create.properties.meal_type, MEAL_TYPE);
  const plan = body('/api/v1/meals/apply-plan', 'post');
  assert.deepEqual(plan.required, ['assignments']);
  assert.equal(plan.properties.assignments.type, 'array');
  assert.equal(plan.properties.assignments.minItems, 1, 'at least one meal');
  assert.equal(plan.properties.assignments.items.type, 'object');
  assert.deepEqual(plan.properties.assignments.items.required, ['date', 'meal_type', 'title']);
  assert.deepEqual(plan.properties.assignments.items.properties.meal_type, MEAL_TYPE);
  const update = body('/api/v1/meals/{id}', 'put');
  assert.equal(update.required, undefined, 'every field optional on update');
  assert.deepEqual(update.properties.meal_type, MEAL_TYPE);
  // recipe_id: a whole number, digit text or null - nothing Number() reads otherwise.
  for (const [name, schema] of [['POST', create], ['PUT', update], ['apply-plan', plan.properties.assignments.items]]) {
    assert.deepEqual(schema.properties.recipe_id.anyOf, RECIPE_ID, `${name} recipe_id`);
  }
  // skip_occupied and replace_existing: JSON booleans.
  assert.equal(plan.properties.skip_occupied.type, 'boolean');
  assert.equal(plan.properties.replace_existing.type, 'boolean');
  // listId: required, a whole number from 1, on both transfers.
  for (const path of ['/api/v1/meals/{id}/to-shopping-list', '/api/v1/meals/week-to-shopping-list']) {
    const transfer = body(path, 'post');
    assert.ok(transfer.required.includes('listId'), `${path} listId required`);
    assert.equal(transfer.properties.listId.type, 'integer', `${path} listId`);
    assert.equal(transfer.properties.listId.minimum, 1, `${path} listId`);
  }
  assert.ok(body('/api/v1/meals/week-to-shopping-list', 'post').required.includes('week'));
  // CardDAV: `enabled` required and a JSON boolean.
  const toggle = body('/api/v1/contacts/cardav/addressbooks/{id}', 'put');
  assert.deepEqual(toggle.required, ['enabled']);
  assert.equal(toggle.properties.enabled.type, 'boolean');
  // The category colour: text or null from the list, never another type.
  for (const [path, method] of [['/api/v1/contacts/categories', 'post'], ['/api/v1/contacts/categories/{key}', 'put']]) {
    assert.deepEqual(body(path, method).properties.color.type, ['string', 'null'], `${path} color`);
  }
});
