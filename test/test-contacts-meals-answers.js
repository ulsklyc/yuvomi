/**
 * Test: the answers of contacts, CardDAV and the meal plan stay byte-equal
 *       (#2810, phase 2 section E, group 7, step b)
 * Purpose: server/routes/contacts.js (12 routes), cardav.js (9) and meals.js
 *          (11) dropped the hand checks the schema of their operation already
 *          covers (`validateRequest()` runs before every handler since #2864)
 *          and, in contacts and the meal plan, the try/catch blocks that
 *          answered an unexpected error with a 500 of their own. This suite
 *          holds that refactor: for a table of requests to all 32 operations -
 *          valid, every refusal of the handler that stays (empty or too long
 *          after trimming with `reason` and `params.limit`, the calendar day
 *          with `birthday_year_unknown`, the email lock of a household member,
 *          `email_in_use`, a category in use or the last one, a recipe that is
 *          gone, the shopping write right, the CardDAV `errorCode`s, path ids
 *          `0`, `-1`, `-0` and with a leading zero), every input a dropped hand
 *          check refused (now the schema's 400), not found and rights - for an
 *          admin, a member, the member a contact belongs to, a member without
 *          the shopping write right, a meal-plan token and a split-expense
 *          guest, it pins status and the WHOLE body (the vCard: its text). The
 *          expectations were written before the refactor (fd2ff4b8b) and are
 *          literal values in test/contacts-meals-answers-expected.js (a module
 *          of its own only for the line limit), no fixture file, no update
 *          mode. CardDAV talks to no server: the connection test and the sync
 *          are the service's own test stubs (`_mockTestConnection`,
 *          `_mockSyncAccount`, as in test/test-carddav.js). SQLite stamps rows
 *          with its own clock, which mock.timers does not reach: test triggers
 *          pin `created_at`, `updated_at` is masked. The clock stands still
 *          (`mock.timers`, 18.11.2026 12:00 UTC), the household lives in
 *          Europe/Berlin.
 *
 *          The second part: an unexpected error in every contacts and meal-plan
 *          route reaches the central error handler - 500 with its fixed
 *          sentence (the one these routes answered already) and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps
 *          answering. CardDAV keeps its own 500 (`errorCode: internal`): the
 *          settings page shows another sentence at two places for a 500
 *          without it (see the PR, "Not decided"), so its catch blocks stay.
 *
 *          The third part: what stays the route's own - the 409 `email_in_use`
 *          and 403 `contact_email_protected`, the CardDAV 502
 *          `connection_failed`, `account_duplicate`, `password_required` -
 *          keeps its answer and never reaches the central handler.
 *
 *          The fourth part: each handler alone (without `validateRequest()`)
 *          keeps the type checks in front of a loop, a string method or a date
 *          computation over a raw value (sink, not route).
 * Run: npm run test:contacts-meals-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-contacts-meals-answers-');
delete process.env.BASE_URL;

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createContactsMealsApp } from './contacts-meals-app.js';
import { EXPECTED } from './contacts-meals-answers-expected.js';

const dbmod = await import('../server/db.js');
const CardDAVSync = await import('../server/services/cardav-sync.js');
const { MAX_TITLE, MAX_TEXT, MAX_SHORT } = await import('../server/middleware/validate.js');
const { CONTACT_CATEGORY_COLORS } = await import('../server/services/contacts-fields.js');
const database = () => dbmod.get();

database().prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

// SQLite stamps rows with its own clock, which mock.timers does not reach; a
// test trigger pins `created_at` on insert (the CardDAV accounts are listed
// by it).
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'contact%' OR name LIKE 'meal%' OR name LIKE 'carddav%' OR name LIKE 'shopping%' OR name = 'recipes')").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  if (!columns.includes('created_at')) continue;
  database().exec(`CREATE TRIGGER test_pin_${name} AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET created_at = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
}

/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const SELF = user('mia', 'member');
const NOSHOP = user('ole', 'member');
const GUEST = user('gast', 'member', 'other');
// A split-expense guest: a users row that belongs to one expense group only.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);
// Two household members with their contact (the email rules of #2214).
const contactOf = (/** @type {number} */ userId, /** @type {string} */ name, /** @type {string} */ email) => Number(database()
  .prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES (?, 'misc', ?, ?)").run(name, email, userId).lastInsertRowid);
const SELF_CONTACT = contactOf(SELF, 'Mia', 'mia@example.org');
contactOf(MEM, 'Tom', 'tom@example.org');
const LIST = Number(database().prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)").run(ADMIN).lastInsertRowid);
const RECIPE = Number(database().prepare("INSERT INTO recipes (title, created_by) VALUES ('Linsensuppe', ?)").run(ADMIN).lastInsertRowid);
database().prepare("INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, 'Linsen', '200 g')").run(RECIPE);

/** @type {Record<string, { id: number, role: string, scopes?: string[], access?: Record<string, string> }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  self: { id: SELF, role: 'member' },
  noshop: { id: NOSHOP, role: 'member', access: { shopping: 'read' } },
  guest: { id: GUEST, role: 'member' },
  // A token scoped to the meal plan alone: no write right on the shopping list.
  mealtoken: { id: ADMIN, role: 'admin', scopes: ['meals:read', 'meals:write'] },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createContactsMealsApp({
  log,
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.scopes ? 'token' : 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = actor.access ?? null;
    // An unexpected error: the first answer of the handler throws - a JSON
    // answer, an empty one, or the first header of the vCard download.
    if (req.get('x-fail') === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end', 'setHeader']) {
        const original = res[name];
        res[name] = function (/** @type {unknown[]} */ ...args) {
          if (!thrown) { thrown = true; throw new Error(`${name} broke`); }
          return original.apply(this, args);
        };
      }
    }
    next();
  },
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

const NO_BODY = Symbol('no body');
/** A body sent as this exact text (a number JSON.stringify cannot write, such as 1e400). */
class Raw {
  /** @param {string} text */
  constructor(text) { this.text = text; }
}

/** @typedef {{ actor?: string, fail?: boolean }} CallOptions */

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {unknown} body a JSON value, a Raw text or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, route, body, { actor, fail } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let payload;
  if (body !== NO_BODY) {
    headers['Content-Type'] = 'application/json';
    payload = body instanceof Raw ? body.text : JSON.stringify(body);
  }
  if (actor !== undefined) headers['x-actor'] = actor;
  if (fail) headers['x-fail'] = 'answer';
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload });
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (type.includes('text/vcard')) return { status: res.status, body: { vcard: text, file: res.headers.get('content-disposition') } };
  if (!type.includes('application/json')) return { status: res.status, body: text === '' ? null : `<${text.slice(0, 15)}>` };
  return { status: res.status, body: JSON.parse(text) };
}

// Stamps of SQLite's own clock the triggers do not pin.
const VOLATILE = new Set(['updated_at']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && typeof v === 'string' && v !== STAMP) return '<volatile>';
    return v;
  });
}

/** @type {Record<string, number>} */
const ids = {};
const lastId = (/** @type {string} */ table) => database().prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const SPACES = '   ';
const COLOR = CONTACT_CATEGORY_COLORS[0];
const CONTACT = (/** @type {Record<string, unknown>} */ over = {}) => ({
  name: 'Dr. Weber', category: 'doctor', phone: '030 1234', email: 'weber@example.org', address: 'Hauptstr. 1', notes: 'Praxis',
  birthday: null, birthday_year_unknown: false, phones: [{ label: 'work', value: '030 1234', isPrimary: true }],
  emails: [{ label: 'work', value: 'weber@example.org', isPrimary: true }], ...over,
});
const MEAL = (/** @type {Record<string, unknown>} */ over = {}) => ({ date: '2026-11-18', meal_type: 'dinner', title: 'Pasta', ...over });
const ACCOUNT = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Nextcloud', cardavUrl: 'https://dav.example.org/remote.php/dav', username: 'tom', password: ' geheim ', ...over });
const many = (/** @type {number} */ n, /** @type {(i: number) => unknown} */ make) => Array.from({ length: n }, (_, i) => make(i));

/** The CardDAV stubs: a server with one address book; a failing one answers like testConnection(). */
const connectionOk = async () => ({ ok: true, addressbooks: [{ url: 'https://dav.example.org/ab/1/', displayName: 'Kontakte' }] });
const connectionFails = async () => {
  const failed = new Error('CardDAV connection failed: 401', { cause: Object.assign(new Error('Unauthorized'), { status: 401 }) });
  /** @type {any} */ (failed).code = 'carddav_connection_failed';
  throw failed;
};
CardDAVSync._mockTestConnection(connectionOk);
const syncOk = async (/** @type {number} */ id) => ({ synced: true, account: id, contactsAdded: 0, contactsUpdated: 0 });
CardDAVSync._mockSyncAccount(syncOk);

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ CONTACT CATEGORIES ═════════════════════════════════════════════════════
  ['cat list', 'GET', '/contacts/categories', NO_BODY],
  ['cat create', 'POST', '/contacts/categories', { name: ' Nachbarn ', color: COLOR }],
  ['cat create no colour', 'POST', '/contacts/categories', { name: 'Verein' }],
  ['cat create colour empty', 'POST', '/contacts/categories', { name: 'Schule 2', color: '' }],
  ['cat create colour null', 'POST', '/contacts/categories', { name: 'Sport', color: null }],
  ['cat create duplicate', 'POST', '/contacts/categories', { name: 'nachbarn' }],
  ['cat create duplicate bad colour', 'POST', '/contacts/categories', { name: 'nachbarn', color: 'red' }],
  ['cat create colour unknown', 'POST', '/contacts/categories', { name: 'Garten', color: 'red' }],
  ['cat create colour number', 'POST', '/contacts/categories', { name: 'Garten', color: 5 }],
  ['cat create colour proto', 'POST', '/contacts/categories', { name: 'Garten', color: 'constructor' }],
  ['cat create name spaces', 'POST', '/contacts/categories', { name: SPACES }],
  ['cat create name empty', 'POST', '/contacts/categories', { name: '' }],
  ['cat create name long', 'POST', '/contacts/categories', { name: LONG(MAX_SHORT + 1) }],
  ['cat create name number', 'POST', '/contacts/categories', { name: 5 }],
  ['cat create name missing', 'POST', '/contacts/categories', {}],
  ['cat create no body', 'POST', '/contacts/categories', NO_BODY],
  ['cat create guest', 'POST', '/contacts/categories', { name: 'Gastkategorie' }, { actor: 'guest' }],
  ['cat reorder', 'PATCH', '/contacts/categories/reorder', { order: ['verein', 'nachbarn', 'unknown'] }],
  ['cat reorder empty', 'PATCH', '/contacts/categories/reorder', { order: [] }],
  ['cat reorder text', 'PATCH', '/contacts/categories/reorder', { order: 'x' }],
  ['cat reorder object entry', 'PATCH', '/contacts/categories/reorder', { order: [{}] }],
  ['cat reorder bool entry', 'PATCH', '/contacts/categories/reorder', { order: [true] }],
  ['cat reorder missing', 'PATCH', '/contacts/categories/reorder', {}],
  ['cat put unknown', 'PUT', '/contacts/categories/unknown', { name: 'X' }],
  ['cat put colour only', 'PUT', '/contacts/categories/doctor', { color: COLOR }],
  ['cat put colour clear', 'PUT', '/contacts/categories/doctor', { color: null }],
  ['cat put colour empty', 'PUT', '/contacts/categories/doctor', { color: '' }],
  ['cat put colour unknown', 'PUT', '/contacts/categories/doctor', { color: 'red' }],
  ['cat put colour unknown missing key', 'PUT', '/contacts/categories/unknown', { color: 'red' }],
  ['cat put name', 'PUT', '/contacts/categories/verein', { name: ' Sportverein ' }],
  ['cat put name and colour', 'PUT', '/contacts/categories/verein', { name: 'Sportverein', color: CONTACT_CATEGORY_COLORS[2] }],
  ['cat put neither', 'PUT', '/contacts/categories/verein', {}],
  ['cat put name spaces', 'PUT', '/contacts/categories/verein', { name: SPACES }],
  ['cat put name long', 'PUT', '/contacts/categories/verein', { name: LONG(MAX_SHORT + 1) }],
  ['cat put name number', 'PUT', '/contacts/categories/verein', { name: 5 }],
  ['cat put duplicate', 'PUT', '/contacts/categories/verein', { name: 'NACHBARN' }],
  ['cat put same name', 'PUT', '/contacts/categories/verein', { name: 'sportverein' }],
  ['cat delete unknown', 'DELETE', '/contacts/categories/unknown', NO_BODY],
  ['cat delete unused', 'DELETE', '/contacts/categories/sport', NO_BODY],
  ['cat delete in use', 'DELETE', '/contacts/categories/misc', NO_BODY],
  // ══ CONTACTS ═══════════════════════════════════════════════════════════════
  ['c list', 'GET', '/contacts', NO_BODY],
  ['c create', 'POST', '/contacts', CONTACT()],
  () => { ids.c1 = lastId('contacts'); },
  ['c create parts', 'POST', '/contacts', { firstName: ' Ada ', lastName: 'Lovelace', middleName: 'King', namePrefix: 'Dr.', nameSuffix: 'Jr.', name: 'ignored', category: 'nachbarn' }],
  () => { ids.c2 = lastId('contacts'); },
  ['c create minimal', 'POST', '/contacts', { name: 'Schlüsseldienst' }],
  () => { ids.c3 = lastId('contacts'); },
  ['c create birthday', 'POST', '/contacts', { name: 'Oma', birthday: '1940-03-05' }],
  ['c create birthday no year', 'POST', '/contacts', { name: 'Opa', birthday: '1941-02-29', birthday_year_unknown: true }],
  () => { ids.c5 = lastId('contacts'); },
  ['c create birthday no year 1', 'POST', '/contacts', { name: 'Uroma', birthday: '1920-07-01', birthday_year_unknown: 1 }],
  ['c create birthday day gone', 'POST', '/contacts', { name: 'X', birthday: '2026-02-30' }],
  ['c create birthday leap no year off', 'POST', '/contacts', { name: 'X', birthday: '1941-02-29', birthday_year_unknown: false }],
  ['c create birthday form', 'POST', '/contacts', { name: 'X', birthday: '18.07.1990' }],
  ['c create birthday number', 'POST', '/contacts', { name: 'X', birthday: 5 }],
  ['c create birthday empty', 'POST', '/contacts', { name: 'Leer', birthday: '', phone: '', email: null, notes: '   ' }],
  ['c create year unknown text', 'POST', '/contacts', { name: 'X', birthday_year_unknown: 'true' }],
  ['c create year unknown 2', 'POST', '/contacts', { name: 'X', birthday_year_unknown: 2 }],
  ['c create name missing', 'POST', '/contacts', { phone: '123' }],
  ['c create name spaces', 'POST', '/contacts', { name: SPACES }],
  ['c create name long', 'POST', '/contacts', { name: LONG(MAX_TITLE + 1) }],
  ['c create name object', 'POST', '/contacts', { name: {} }],
  ['c create name number', 'POST', '/contacts', { name: 5 }],
  ['c create part long', 'POST', '/contacts', { firstName: 'A', namePrefix: LONG(MAX_SHORT + 1) }],
  ['c create part number', 'POST', '/contacts', { firstName: 5 }],
  ['c create phone long', 'POST', '/contacts', { name: 'X', phone: LONG(101) }],
  ['c create email long', 'POST', '/contacts', { name: 'X', email: LONG(MAX_TITLE + 1) }],
  ['c create address long', 'POST', '/contacts', { name: 'X', address: LONG(MAX_TEXT + 1) }],
  ['c create notes long', 'POST', '/contacts', { name: 'X', notes: LONG(MAX_TEXT + 1) }],
  ['c create two long', 'POST', '/contacts', { name: LONG(MAX_TITLE + 1), notes: LONG(MAX_TEXT + 1) }],
  ['c create notes list', 'POST', '/contacts', { name: 'X', notes: [] }],
  ['c create category gone', 'POST', '/contacts', { name: 'X', category: 'gone' }],
  ['c create category gone and name', 'POST', '/contacts', { name: SPACES, category: 'gone' }],
  ['c create category empty', 'POST', '/contacts', { name: 'Kategorielos', category: '' }],
  ['c create category number', 'POST', '/contacts', { name: 'X', category: 5 }],
  ['c create phones text', 'POST', '/contacts', { name: 'X', phones: 'x' }],
  ['c create phones null', 'POST', '/contacts', { name: 'X', phones: null }],
  ['c create phones many', 'POST', '/contacts', { name: 'X', phones: many(21, (i) => ({ label: 'm', value: String(i) })) }],
  ['c create phone label long', 'POST', '/contacts', { name: 'X', phones: [{ label: LONG(51), value: '1' }] }],
  ['c create phone label spaces', 'POST', '/contacts', { name: 'X', phones: [{ label: SPACES, value: '1' }] }],
  ['c create phone value long', 'POST', '/contacts', { name: 'X', phones: [{ label: 'm', value: LONG(101) }] }],
  ['c create phone value spaces', 'POST', '/contacts', { name: 'X', phones: [{ label: 'm', value: SPACES }] }],
  ['c create phone entry null', 'POST', '/contacts', { name: 'X', phones: [null] }],
  ['c create phone primary text', 'POST', '/contacts', { name: 'X', phones: [{ label: 'm', value: '1', isPrimary: 'ja' }] }],
  ['c create emails many', 'POST', '/contacts', { name: 'X', emails: many(21, (i) => ({ label: 'm', value: `${i}@x.de` })) }],
  ['c create email no at', 'POST', '/contacts', { name: 'X', emails: [{ label: 'm', value: 'keine-adresse' }] }],
  ['c create email value long', 'POST', '/contacts', { name: 'X', emails: [{ label: 'm', value: `${LONG(250)}@x.de` }] }],
  ['c create email label long', 'POST', '/contacts', { name: 'X', emails: [{ label: LONG(51), value: 'a@x.de' }] }],
  ['c create email value number', 'POST', '/contacts', { name: 'X', emails: [{ label: 'm', value: 5 }] }],
  ['c create addresses', 'POST', '/contacts', { name: 'Adressen', addresses: [{ label: 'home', street: 'Weg 1', city: 'Berlin', postalCode: '10115', country: 'DE', isPrimary: true }, { label: 'work' }] }],
  ['c create addresses many', 'POST', '/contacts', { name: 'X', addresses: many(21, () => ({ label: 'h' })) }],
  ['c create address part long', 'POST', '/contacts', { name: 'X', addresses: [{ label: 'h', city: LONG(256) }] }],
  ['c create address label long', 'POST', '/contacts', { name: 'X', addresses: [{ label: LONG(51) }] }],
  ['c create address label missing', 'POST', '/contacts', { name: 'X', addresses: [{ city: 'Berlin' }] }],
  ['c create address postal number', 'POST', '/contacts', { name: 'X', addresses: [{ label: 'h', postalCode: 12345 }] }],
  ['c create addresses object', 'POST', '/contacts', { name: 'X', addresses: {} }],
  ['c create no body', 'POST', '/contacts', NO_BODY],
  ['c create guest', 'POST', '/contacts', { name: 'Gastkontakt' }, { actor: 'guest' }],
  ['c list again', 'GET', '/contacts', NO_BODY],
  ['c list category', 'GET', '/contacts?category=doctor', NO_BODY],
  ['c list category unknown', 'GET', '/contacts?category=gone', NO_BODY],
  ['c list q', 'GET', '/contacts?q=weber', NO_BODY],
  ['c list q phone', 'GET', '/contacts?q=1234', NO_BODY],
  ['c list q doubled', 'GET', '/contacts?q=a&q=b', NO_BODY],
  ['c list category doubled', 'GET', '/contacts?category=a&category=b', NO_BODY],
  ['c meta', 'GET', '/contacts/meta', NO_BODY],
  ['c get', 'GET', () => `/contacts/${ids.c1}`, NO_BODY],
  ['c get parts', 'GET', () => `/contacts/${ids.c2}`, NO_BODY],
  ['c get member', 'GET', () => `/contacts/${ids.c1}`, NO_BODY, { actor: 'mem' }],
  ['c get leading zero', 'GET', () => `/contacts/00${ids.c1}`, NO_BODY],
  ['c get zero', 'GET', '/contacts/0', NO_BODY],
  ['c get negative', 'GET', '/contacts/-1', NO_BODY],
  ['c get minus zero', 'GET', '/contacts/-0', NO_BODY],
  ['c get letters', 'GET', '/contacts/abc', NO_BODY],
  ['c get hex', 'GET', '/contacts/0x10', NO_BODY],
  ['c get missing', 'GET', '/contacts/987654', NO_BODY],
  ['c vcard', 'GET', () => `/contacts/${ids.c1}/vcard`, NO_BODY],
  ['c vcard parts', 'GET', () => `/contacts/${ids.c2}/vcard`, NO_BODY],
  ['c vcard no year', 'GET', () => `/contacts/${ids.c5}/vcard`, NO_BODY],
  ['c vcard zero', 'GET', '/contacts/0/vcard', NO_BODY],
  ['c vcard minus zero', 'GET', '/contacts/-0/vcard', NO_BODY],
  ['c vcard leading zero', 'GET', () => `/contacts/0${ids.c3}/vcard`, NO_BODY],
  ['c put', 'PUT', () => `/contacts/${ids.c1}`, { name: ' Dr. Weber-Schmidt ', notes: '', phones: [{ label: 'mobile', value: '0170 1' }] }],
  ['c put empty', 'PUT', () => `/contacts/${ids.c1}`, {}],
  ['c put name empty', 'PUT', () => `/contacts/${ids.c3}`, { name: '' }],
  ['c put name back', 'PUT', () => `/contacts/${ids.c3}`, { name: 'Schlüsseldienst' }],
  ['c put name spaces', 'PUT', () => `/contacts/${ids.c3}`, { name: SPACES }],
  ['c put name long', 'PUT', () => `/contacts/${ids.c3}`, { name: LONG(MAX_TITLE + 1) }],
  ['c put name number', 'PUT', () => `/contacts/${ids.c3}`, { name: 123 }],
  ['c put phone number', 'PUT', () => `/contacts/${ids.c3}`, { phone: 5 }],
  ['c put notes list', 'PUT', () => `/contacts/${ids.c3}`, { notes: [] }],
  ['c put category gone', 'PUT', () => `/contacts/${ids.c3}`, { category: 'gone' }],
  ['c put category null', 'PUT', () => `/contacts/${ids.c3}`, { category: null }],
  ['c put first name', 'PUT', () => `/contacts/${ids.c2}`, { firstName: 'Augusta' }],
  ['c put year unknown on', 'PUT', () => `/contacts/${ids.c1}`, { birthday: '1970-05-06' }],
  ['c put year unknown only', 'PUT', () => `/contacts/${ids.c1}`, { birthday_year_unknown: true }],
  ['c put year unknown off without day', 'PUT', () => `/contacts/${ids.c5}`, { birthday_year_unknown: false }],
  ['c put year unknown off with day', 'PUT', () => `/contacts/${ids.c5}`, { birthday_year_unknown: false, birthday: '1941-03-01' }],
  ['c put birthday day gone', 'PUT', () => `/contacts/${ids.c5}`, { birthday: '1941-02-30' }],
  ['c put birthday clear', 'PUT', () => `/contacts/${ids.c5}`, { birthday: '' }],
  ['c put phones too many', 'PUT', () => `/contacts/${ids.c1}`, { phones: many(21, (i) => ({ label: 'm', value: String(i) })) }],
  ['c put emails no at', 'PUT', () => `/contacts/${ids.c1}`, { emails: [{ label: 'm', value: 'x' }] }],
  ['c put addresses', 'PUT', () => `/contacts/${ids.c1}`, { addresses: [{ label: 'home', city: 'Köln' }] }],
  ['c put addresses country number', 'PUT', () => `/contacts/${ids.c1}`, { addresses: [{ label: 'home', country: 12345 }] }],
  ['c put zero', 'PUT', '/contacts/0', { name: 'X' }],
  ['c put negative', 'PUT', '/contacts/-1', { name: 'X' }],
  ['c put minus zero', 'PUT', '/contacts/-0', { name: 'X' }],
  ['c put leading zero', 'PUT', () => `/contacts/0${ids.c3}`, { notes: 'führende Null' }],
  ['c put missing', 'PUT', '/contacts/987654', { name: 'X' }],
  ['c put missing bad body', 'PUT', '/contacts/987654', { name: 5 }],
  ['c put no body', 'PUT', () => `/contacts/${ids.c3}`, NO_BODY],
  // The email rules of a household member's contact (#2214, GHSA-6pmj-w42g-g6qv).
  ['c put member other email', 'PUT', `/contacts/${SELF_CONTACT}`, { email: 'neu@example.org' }, { actor: 'mem' }],
  ['c put member other emails', 'PUT', `/contacts/${SELF_CONTACT}`, { emails: [{ label: 'm', value: 'neu@example.org' }] }, { actor: 'mem' }],
  ['c put member other same email', 'PUT', `/contacts/${SELF_CONTACT}`, { email: 'MIA@example.org', notes: 'gleich' }, { actor: 'mem' }],
  ['c put member other phone', 'PUT', `/contacts/${SELF_CONTACT}`, { phone: '0171' }, { actor: 'mem' }],
  ['c put self taken', 'PUT', `/contacts/${SELF_CONTACT}`, { email: 'tom@example.org' }, { actor: 'self' }],
  ['c put self taken emails', 'PUT', `/contacts/${SELF_CONTACT}`, { emails: [{ label: 'm', value: 'Tom@example.org' }] }, { actor: 'self' }],
  ['c put self new', 'PUT', `/contacts/${SELF_CONTACT}`, { email: 'mia.neu@example.org' }, { actor: 'self' }],
  ['c put admin taken', 'PUT', `/contacts/${SELF_CONTACT}`, { emails: [{ label: 'm', value: 'tom@example.org' }] }],
  ['c put token other email', 'PUT', `/contacts/${SELF_CONTACT}`, { email: 'x@example.org' }, { actor: 'mealtoken' }],
  ['c delete family', 'DELETE', `/contacts/${SELF_CONTACT}`, NO_BODY],
  ['c delete', 'DELETE', () => `/contacts/${ids.c3}`, NO_BODY],
  ['c delete again', 'DELETE', () => `/contacts/${ids.c3}`, NO_BODY],
  ['c delete zero', 'DELETE', '/contacts/0', NO_BODY],
  ['c delete negative', 'DELETE', '/contacts/-1', NO_BODY],
  ['c delete minus zero', 'DELETE', '/contacts/-0', NO_BODY],
  ['c delete letters', 'DELETE', '/contacts/abc', NO_BODY],
  ['c list end', 'GET', '/contacts', NO_BODY],
  // The last category: every other one gone (no contact left in them).
  () => {
    database().prepare("UPDATE contacts SET category = 'misc'").run();
    database().prepare("DELETE FROM contact_categories WHERE key NOT IN ('misc', 'school')").run();
  },
  ['cat delete before last', 'DELETE', '/contacts/categories/school', NO_BODY],
  ['cat delete last', 'DELETE', '/contacts/categories/misc', NO_BODY],
  () => { database().prepare("UPDATE contacts SET category = 'doctor'").run(); },
  ['cat delete last unused', 'DELETE', '/contacts/categories/misc', NO_BODY],
  // ══ CARDDAV ════════════════════════════════════════════════════════════════
  ['d list empty', 'GET', '/contacts/cardav/accounts', NO_BODY],
  ['d list member', 'GET', '/contacts/cardav/accounts', NO_BODY, { actor: 'mem' }],
  ['d create', 'POST', '/contacts/cardav/accounts', ACCOUNT()],
  () => { ids.a1 = lastId('carddav_accounts'); ids.ab1 = lastId('carddav_addressbook_selection'); },
  ['d create second', 'POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'mia' })],
  () => { ids.a2 = lastId('carddav_accounts'); },
  ['d create duplicate', 'POST', '/contacts/cardav/accounts', ACCOUNT()],
  ['d create member', 'POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'x' }), { actor: 'mem' }],
  ['d create member bad', 'POST', '/contacts/cardav/accounts', { name: 5 }, { actor: 'mem' }],
  ['d create name spaces', 'POST', '/contacts/cardav/accounts', ACCOUNT({ name: SPACES })],
  ['d create name long', 'POST', '/contacts/cardav/accounts', ACCOUNT({ name: LONG(MAX_TITLE + 1) })],
  ['d create url long', 'POST', '/contacts/cardav/accounts', ACCOUNT({ cardavUrl: `https://x.de/${LONG(500)}` })],
  ['d create password spaces', 'POST', '/contacts/cardav/accounts', ACCOUNT({ password: SPACES })],
  ['d create password empty', 'POST', '/contacts/cardav/accounts', ACCOUNT({ password: '' })],
  ['d create password long', 'POST', '/contacts/cardav/accounts', ACCOUNT({ password: LONG(4097) })],
  ['d create password number', 'POST', '/contacts/cardav/accounts', ACCOUNT({ password: 1234 })],
  ['d create missing', 'POST', '/contacts/cardav/accounts', { name: 'X' }],
  ['d create no body', 'POST', '/contacts/cardav/accounts', NO_BODY],
  () => { CardDAVSync._mockTestConnection(connectionFails); },
  ['d create refused', 'POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'refused' })],
  ['d test refused', 'POST', () => `/contacts/cardav/accounts/${ids.a1}/test`, NO_BODY],
  () => { CardDAVSync._mockTestConnection(connectionOk); },
  ['d list', 'GET', '/contacts/cardav/accounts', NO_BODY],
  ['d put', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: ' Wolke ', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: '' }],
  ['d put password null', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: null }],
  ['d put password new', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: 'neu' }],
  ['d put password spaces', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: SPACES }],
  ['d put password long', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: LONG(4097) }],
  ['d put password number', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: 1234 }],
  ['d put other host no password', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'Wolke', cardavUrl: 'https://evil.example.net/dav', username: 'tom' }],
  ['d put conflict', 'PUT', () => `/contacts/cardav/accounts/${ids.a2}`, { name: 'Wolke', cardavUrl: 'https://dav.example.org/other/path', username: 'tom', password: 'x' }],
  ['d put name spaces', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: SPACES, cardavUrl: 'https://dav.example.org/x', username: 'tom' }],
  ['d put missing field', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'X', cardavUrl: 'https://dav.example.org/x' }],
  ['d put unknown', 'PUT', '/contacts/cardav/accounts/987654', { name: 'X', cardavUrl: 'https://dav.example.org/x', username: 'tom', password: 'x' }],
  ['d put zero', 'PUT', '/contacts/cardav/accounts/0', { name: 'X', cardavUrl: 'https://dav.example.org/x', username: 'tom' }],
  ['d put negative', 'PUT', '/contacts/cardav/accounts/-1', { name: 'X', cardavUrl: 'https://dav.example.org/x', username: 'tom' }],
  ['d put minus zero', 'PUT', '/contacts/cardav/accounts/-0', { name: 'X', cardavUrl: 'https://dav.example.org/x', username: 'tom' }],
  ['d put zero bad body', 'PUT', '/contacts/cardav/accounts/0', { name: 5 }],
  ['d put letters', 'PUT', '/contacts/cardav/accounts/abc', { name: 'X', cardavUrl: 'https://dav.example.org/x', username: 'tom' }],
  ['d put leading zero', 'PUT', () => `/contacts/cardav/accounts/00${ids.a1}`, { name: 'Wolke 0', cardavUrl: 'https://dav.example.org/other/path', username: 'tom' }],
  ['d put member', 'PUT', () => `/contacts/cardav/accounts/${ids.a1}`, { name: 'X', cardavUrl: 'https://evil.example.net/', username: 'tom' }, { actor: 'mem' }],
  ['d books', 'GET', () => `/contacts/cardav/accounts/${ids.a1}/addressbooks`, NO_BODY],
  ['d books unknown', 'GET', '/contacts/cardav/accounts/987654/addressbooks', NO_BODY],
  ['d books zero', 'GET', '/contacts/cardav/accounts/0/addressbooks', NO_BODY],
  ['d books minus zero', 'GET', '/contacts/cardav/accounts/-0/addressbooks', NO_BODY],
  ['d books leading zero', 'GET', () => `/contacts/cardav/accounts/0${ids.a1}/addressbooks`, NO_BODY],
  ['d book toggle', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, { enabled: false }],
  ['d book toggle on', 'PUT', () => `/contacts/cardav/addressbooks/0${ids.ab1}`, { enabled: true }],
  ['d book toggle text', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, { enabled: 'true' }],
  ['d book toggle one', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, { enabled: 1 }],
  ['d book toggle null', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, { enabled: null }],
  ['d book toggle missing', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, {}],
  ['d book toggle unknown', 'PUT', '/contacts/cardav/addressbooks/987654', { enabled: true }],
  ['d book toggle zero', 'PUT', '/contacts/cardav/addressbooks/0', { enabled: true }],
  ['d book toggle zero bad', 'PUT', '/contacts/cardav/addressbooks/0', { enabled: 'x' }],
  ['d book toggle negative', 'PUT', '/contacts/cardav/addressbooks/-1', { enabled: true }],
  ['d book toggle member', 'PUT', () => `/contacts/cardav/addressbooks/${ids.ab1}`, { enabled: 'x' }, { actor: 'mem' }],
  ['d test', 'POST', () => `/contacts/cardav/accounts/${ids.a1}/test`, NO_BODY],
  ['d test unknown', 'POST', '/contacts/cardav/accounts/987654/test', NO_BODY],
  ['d test zero', 'POST', '/contacts/cardav/accounts/0/test', NO_BODY],
  ['d test negative', 'POST', '/contacts/cardav/accounts/-1/test', NO_BODY],
  ['d refresh unknown', 'POST', '/contacts/cardav/accounts/987654/addressbooks/refresh', NO_BODY],
  ['d refresh zero', 'POST', '/contacts/cardav/accounts/0/addressbooks/refresh', NO_BODY],
  ['d refresh minus zero', 'POST', '/contacts/cardav/accounts/-0/addressbooks/refresh', NO_BODY],
  ['d sync', 'POST', () => `/contacts/cardav/accounts/${ids.a1}/sync`, NO_BODY],
  ['d sync leading zero', 'POST', () => `/contacts/cardav/accounts/0${ids.a1}/sync`, NO_BODY],
  ['d sync unknown', 'POST', '/contacts/cardav/accounts/987654/sync', NO_BODY],
  ['d sync zero', 'POST', '/contacts/cardav/accounts/0/sync', NO_BODY],
  ['d sync member', 'POST', () => `/contacts/cardav/accounts/${ids.a1}/sync`, NO_BODY, { actor: 'mem' }],
  ['d delete unknown', 'DELETE', '/contacts/cardav/accounts/987654', NO_BODY],
  ['d delete zero', 'DELETE', '/contacts/cardav/accounts/0', NO_BODY],
  ['d delete minus zero', 'DELETE', '/contacts/cardav/accounts/-0', NO_BODY],
  ['d delete letters', 'DELETE', '/contacts/cardav/accounts/abc', NO_BODY],
  ['d delete member', 'DELETE', () => `/contacts/cardav/accounts/${ids.a2}`, NO_BODY, { actor: 'mem' }],
  ['d delete', 'DELETE', () => `/contacts/cardav/accounts/${ids.a2}`, NO_BODY],
  ['d list end', 'GET', '/contacts/cardav/accounts', NO_BODY],
  // ══ MEALS ══════════════════════════════════════════════════════════════════
  ['m list empty', 'GET', '/meals?week=2026-11-18', NO_BODY],
  ['m create', 'POST', '/meals', MEAL({ notes: ' scharf ', recipe_url: 'https://example.org/r', cook_user_id: MEM, ingredients: [{ name: ' Nudeln ', quantity: '500 g', category: 'Trockenwaren' }, { name: '  ' }, { name: 'Salz', quantity: null, category: null, id: 3 }] })],
  () => { ids.m1 = lastId('meals'); ids.i1 = lastId('meal_ingredients'); },
  ['m create recipe', 'POST', '/meals', MEAL({ date: '2026-11-19', meal_type: 'lunch', title: 'Linsensuppe', recipe_id: RECIPE })],
  () => { ids.m2 = lastId('meals'); },
  ['m create recipe text', 'POST', '/meals', MEAL({ date: '2026-11-19', meal_type: 'snack', title: 'Suppe', recipe_id: `00${RECIPE}` })],
  ['m create recipe gone', 'POST', '/meals', MEAL({ recipe_id: 987654 })],
  ['m create recipe zero', 'POST', '/meals', MEAL({ recipe_id: 0 })],
  ['m create recipe negative', 'POST', '/meals', MEAL({ recipe_id: -1 })],
  ['m create recipe huge', 'POST', '/meals', new Raw('{"date":"2026-11-18","meal_type":"dinner","title":"X","recipe_id":1e400}')],
  ['m create recipe hex', 'POST', '/meals', MEAL({ recipe_id: '0x10' })],
  ['m create recipe true', 'POST', '/meals', MEAL({ recipe_id: true })],
  ['m create recipe null', 'POST', '/meals', MEAL({ title: 'Ohne Rezept', recipe_id: null, notes: '', recipe_url: null })],
  ['m create series', 'POST', '/meals', MEAL({ date: '2026-11-16', meal_type: 'breakfast', title: 'Müsli', repeat_weekly: true, repeat_until: '2026-12-31', cook_user_id: String(SELF), ingredients: [{ name: 'Haferflocken' }] })],
  () => { ids.m3 = lastId('meals'); },
  ['m create series open', 'POST', '/meals', MEAL({ date: '2026-11-17', meal_type: 'snack', title: 'Obst', repeat_weekly: true, repeat_until: '' })],
  ['m create series before', 'POST', '/meals', MEAL({ repeat_weekly: true, repeat_until: '2026-11-01' })],
  ['m create series day gone', 'POST', '/meals', MEAL({ repeat_weekly: true, repeat_until: '2026-02-30' })],
  ['m create repeat until no series', 'POST', '/meals', MEAL({ title: 'Einmal', repeat_until: '' })],
  ['m create repeat text', 'POST', '/meals', MEAL({ repeat_weekly: 'true' })],
  ['m create type missing', 'POST', '/meals', { date: '2026-11-18', title: 'X' }],
  ['m create type empty', 'POST', '/meals', MEAL({ meal_type: '' })],
  ['m create type null', 'POST', '/meals', MEAL({ meal_type: null })],
  ['m create type unknown', 'POST', '/meals', MEAL({ meal_type: 'brunch' })],
  ['m create type proto', 'POST', '/meals', MEAL({ meal_type: 'constructor' })],
  ['m create type and title', 'POST', '/meals', MEAL({ meal_type: 'brunch', title: SPACES })],
  ['m create title spaces', 'POST', '/meals', MEAL({ title: SPACES })],
  ['m create title long', 'POST', '/meals', MEAL({ title: LONG(MAX_TITLE + 1) })],
  ['m create title number', 'POST', '/meals', MEAL({ title: 5 })],
  ['m create notes long', 'POST', '/meals', MEAL({ notes: LONG(MAX_TEXT + 1) })],
  ['m create date missing', 'POST', '/meals', { meal_type: 'dinner', title: 'X' }],
  ['m create date gone', 'POST', '/meals', MEAL({ date: '2026-02-30' })],
  ['m create date form', 'POST', '/meals', MEAL({ date: '18.11.2026' })],
  ['m create cook guest', 'POST', '/meals', MEAL({ cook_user_id: GUEST })],
  ['m create cook missing', 'POST', '/meals', MEAL({ cook_user_id: 987654 })],
  ['m create cook zero', 'POST', '/meals', MEAL({ cook_user_id: 0 })],
  ['m create cook leading zero', 'POST', '/meals', MEAL({ cook_user_id: '01' })],
  ['m create cook huge text', 'POST', '/meals', MEAL({ cook_user_id: '9007199254740993' })],
  ['m create ingredients text', 'POST', '/meals', MEAL({ ingredients: 'abc' })],
  ['m create ingredients null entry', 'POST', '/meals', MEAL({ ingredients: [null] })],
  ['m create no body', 'POST', '/meals', NO_BODY],
  ['m create guest', 'POST', '/meals', MEAL({ title: 'Gast' }), { actor: 'guest' }],
  ['m list', 'GET', '/meals?week=2026-11-18', NO_BODY],
  ['m list default', 'GET', '/meals', NO_BODY],
  ['m list next week', 'GET', '/meals?week=2026-11-25', NO_BODY],
  ['m list week text', 'GET', '/meals?week=abc', NO_BODY],
  ['m list week empty', 'GET', '/meals?week=', NO_BODY],
  ['m list week gone', 'GET', '/meals?week=2026-02-30', NO_BODY],
  ['m list week out of range', 'GET', '/meals?week=2026-13-45', NO_BODY],
  ['m suggestions', 'GET', '/meals/suggestions?q=pa', NO_BODY],
  ['m suggestions empty', 'GET', '/meals/suggestions?q=', NO_BODY],
  ['m suggestions spaces', 'GET', '/meals/suggestions?q=%20%20', NO_BODY],
  ['m suggestions none', 'GET', '/meals/suggestions', NO_BODY],
  ['m suggestions doubled', 'GET', '/meals/suggestions?q=a&q=b', NO_BODY],
  ['m plan', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-11-20', title: 'Plan 1', recipe_id: RECIPE, ingredients: [{ name: 'Brot' }] }), MEAL({ date: '2026-11-20', meal_type: 'lunch', title: 'Plan 2', cook_user_id: SELF })] }],
  ['m plan skip', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-11-20', title: 'Belegt' }), MEAL({ date: '2026-11-21', title: 'Frei' }), MEAL({ date: '2026-11-23', meal_type: 'breakfast', title: 'Serie belegt' })], skip_occupied: true }],
  ['m plan replace', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-11-20', meal_type: 'lunch', title: 'Ersetzt' })], replace_existing: true }],
  ['m plan replace series', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-11-30', meal_type: 'breakfast', title: 'Statt Müsli' })], replace_existing: true }],
  ['m plan both', 'POST', '/meals/apply-plan', { assignments: [MEAL()], replace_existing: true, skip_occupied: true }],
  ['m plan skip text', 'POST', '/meals/apply-plan', { assignments: [MEAL()], skip_occupied: 'true' }],
  ['m plan skip number', 'POST', '/meals/apply-plan', { assignments: [MEAL()], skip_occupied: 1 }],
  ['m plan skip null', 'POST', '/meals/apply-plan', { assignments: [MEAL()], skip_occupied: null }],
  ['m plan replace text', 'POST', '/meals/apply-plan', { assignments: [MEAL()], replace_existing: 'true' }],
  ['m plan empty', 'POST', '/meals/apply-plan', { assignments: [] }],
  ['m plan text', 'POST', '/meals/apply-plan', { assignments: 'x' }],
  ['m plan null entry', 'POST', '/meals/apply-plan', { assignments: [null] }],
  ['m plan missing', 'POST', '/meals/apply-plan', {}],
  ['m plan type missing', 'POST', '/meals/apply-plan', { assignments: [{ date: '2026-11-20', title: 'X' }] }],
  ['m plan type unknown', 'POST', '/meals/apply-plan', { assignments: [MEAL({ meal_type: 'brunch' })] }],
  ['m plan title spaces', 'POST', '/meals/apply-plan', { assignments: [MEAL(), MEAL({ title: SPACES })] }],
  ['m plan date gone', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-02-30' })] }],
  ['m plan recipe gone', 'POST', '/meals/apply-plan', { assignments: [MEAL({ recipe_id: 987654 })] }],
  ['m plan recipe zero', 'POST', '/meals/apply-plan', { assignments: [MEAL({ recipe_id: 0 })] }],
  ['m plan recipe text', 'POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-11-22', title: 'Text', recipe_id: String(RECIPE) })] }],
  ['m plan recipe hex', 'POST', '/meals/apply-plan', { assignments: [MEAL({ recipe_id: '0x10' })] }],
  ['m plan recipe huge', 'POST', '/meals/apply-plan', new Raw('{"assignments":[{"date":"2026-11-18","meal_type":"dinner","title":"X","recipe_id":1e400}]}')],
  ['m plan cook guest', 'POST', '/meals/apply-plan', { assignments: [MEAL({ cook_user_id: GUEST })] }],
  ['m plan ingredients text', 'POST', '/meals/apply-plan', { assignments: [MEAL({ ingredients: 'abc' })] }],
  ['m put', 'PUT', () => `/meals/${ids.m1}`, { title: ' Pasta al forno ', notes: null, meal_type: 'lunch', recipe_id: RECIPE }],
  ['m put empty', 'PUT', () => `/meals/${ids.m1}`, {}],
  ['m put title empty', 'PUT', () => `/meals/${ids.m2}`, { title: '' }],
  ['m put title spaces', 'PUT', () => `/meals/${ids.m2}`, { title: SPACES }],
  ['m put title back', 'PUT', () => `/meals/${ids.m2}`, { title: 'Linsensuppe' }],
  ['m put title long', 'PUT', () => `/meals/${ids.m2}`, { title: LONG(MAX_TITLE + 1) }],
  ['m put title number', 'PUT', () => `/meals/${ids.m2}`, { title: 5 }],
  ['m put type unknown', 'PUT', () => `/meals/${ids.m2}`, { meal_type: 'brunch' }],
  ['m put type null', 'PUT', () => `/meals/${ids.m2}`, { meal_type: null }],
  ['m put type empty', 'PUT', () => `/meals/${ids.m2}`, { meal_type: '' }],
  ['m put date gone', 'PUT', () => `/meals/${ids.m2}`, { date: '2026-02-30' }],
  ['m put date empty', 'PUT', () => `/meals/${ids.m2}`, { date: '' }],
  ['m put recipe gone', 'PUT', () => `/meals/${ids.m2}`, { recipe_id: 987654 }],
  ['m put recipe zero', 'PUT', () => `/meals/${ids.m2}`, { recipe_id: 0 }],
  ['m put recipe text', 'PUT', () => `/meals/${ids.m2}`, { recipe_id: `0${RECIPE}` }],
  ['m put recipe huge', 'PUT', () => `/meals/${ids.m2}`, new Raw('{"recipe_id":1e400}')],
  ['m put recipe true', 'PUT', () => `/meals/${ids.m2}`, { recipe_id: true }],
  ['m put recipe null', 'PUT', () => `/meals/${ids.m2}`, { recipe_id: null }],
  ['m put cook', 'PUT', () => `/meals/${ids.m2}`, { cook_user_id: SELF }],
  ['m put cook guest', 'PUT', () => `/meals/${ids.m2}`, { cook_user_id: GUEST }],
  ['m put cook null', 'PUT', () => `/meals/${ids.m2}`, { cook_user_id: null }],
  ['m put move series meal', 'PUT', () => `/meals/${ids.m3}`, { date: '2026-11-17' }],
  ['m list after move', 'GET', '/meals?week=2026-11-18', NO_BODY],
  ['m put series', 'PUT', () => `/meals/${ids.m3}?scope=series`, { title: 'Porridge', meal_type: 'breakfast', ingredients: [{ name: 'Hafer', quantity: '80 g' }], repeat_until: '2026-12-14' }],
  ['m put series end empty', 'PUT', () => `/meals/${ids.m3}?scope=series`, { repeat_until: '' }],
  ['m put series end before', 'PUT', () => `/meals/${ids.m3}?scope=series`, { repeat_until: '2026-01-01' }],
  ['m put series end gone', 'PUT', () => `/meals/${ids.m3}?scope=series`, { repeat_until: '2026-02-30' }],
  ['m put series cook guest', 'PUT', () => `/meals/${ids.m3}?scope=series`, { cook_user_id: GUEST }],
  ['m put series title empty', 'PUT', () => `/meals/${ids.m3}?scope=series`, { title: '' }],
  ['m put series ingredients text', 'PUT', () => `/meals/${ids.m3}?scope=series`, { ingredients: 'abc' }],
  ['m put series on single', 'PUT', () => `/meals/${ids.m2}?scope=series`, { title: 'Linsen' }],
  ['m put scope single', 'PUT', () => `/meals/${ids.m2}?scope=single`, { notes: 'einzeln' }],
  ['m put scope unknown', 'PUT', () => `/meals/${ids.m2}?scope=bogus`, { notes: 'x' }],
  ['m put scope future', 'PUT', () => `/meals/${ids.m2}?scope=future`, { notes: 'x' }],
  ['m put zero', 'PUT', '/meals/0', { title: 'X' }],
  ['m put negative', 'PUT', '/meals/-1', { title: 'X' }],
  ['m put minus zero', 'PUT', '/meals/-0', { title: 'X' }],
  ['m put leading zero', 'PUT', () => `/meals/00${ids.m2}`, { notes: 'null' }],
  ['m put letters', 'PUT', '/meals/abc', { title: 'X' }],
  ['m put missing', 'PUT', '/meals/987654', { title: 'X' }],
  ['m put no body', 'PUT', () => `/meals/${ids.m2}`, NO_BODY],
  ['m list series', 'GET', '/meals?week=2026-11-25', NO_BODY],
  ['m ing add', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: ' Möhren ', quantity: ' 2 ', category: ' Gemüse ' }],
  () => { ids.i2 = lastId('meal_ingredients'); },
  ['m ing add minimal', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: 'Lorbeer' }],
  ['m ing add nulls', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: 'Pfeffer', quantity: null, category: null }],
  ['m ing add name spaces', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: SPACES }],
  ['m ing add name missing', 'POST', () => `/meals/${ids.m2}/ingredients`, { quantity: '1' }],
  ['m ing add name number', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: 5 }],
  ['m ing add quantity number', 'POST', () => `/meals/${ids.m2}/ingredients`, { name: 'X', quantity: 5 }],
  ['m ing add meal zero', 'POST', '/meals/0/ingredients', { name: 'X' }],
  ['m ing add meal minus zero', 'POST', '/meals/-0/ingredients', { name: 'X' }],
  ['m ing add meal missing', 'POST', '/meals/987654/ingredients', { name: 'X' }],
  ['m ing patch', 'PATCH', () => `/meals/ingredients/${ids.i2}`, { name: ' Karotten ', quantity: '', on_shopping_list: 1 }],
  ['m ing patch empty', 'PATCH', () => `/meals/ingredients/${ids.i2}`, {}],
  ['m ing patch nulls', 'PATCH', () => `/meals/ingredients/${ids.i2}`, { name: null, quantity: null, category: null, on_shopping_list: false }],
  ['m ing patch name empty', 'PATCH', () => `/meals/ingredients/${ids.i2}`, { name: '' }],
  ['m ing patch flag text', 'PATCH', () => `/meals/ingredients/${ids.i2}`, { on_shopping_list: 'yes' }],
  ['m ing patch zero', 'PATCH', '/meals/ingredients/0', { name: 'X' }],
  ['m ing patch leading zero', 'PATCH', () => `/meals/ingredients/0${ids.i2}`, { name: 'Möhren' }],
  ['m ing patch missing', 'PATCH', '/meals/ingredients/987654', { name: 'X' }],
  ['m transfer', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: LIST }],
  ['m transfer again', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: LIST }],
  ['m transfer recipe', 'POST', () => `/meals/${ids.m2}/to-shopping-list`, { listId: LIST }],
  ['m transfer noshop', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: LIST }, { actor: 'noshop' }],
  ['m transfer noshop bad', 'POST', '/meals/0x10/to-shopping-list', { listId: true }, { actor: 'noshop' }],
  ['m transfer token', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: LIST }, { actor: 'mealtoken' }],
  ['m transfer list missing', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, {}],
  ['m transfer list zero', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: 0 }],
  ['m transfer list text', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: String(LIST) }],
  ['m transfer list true', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: true }],
  ['m transfer list unknown', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, { listId: 987654 }],
  ['m transfer list huge', 'POST', () => `/meals/${ids.m1}/to-shopping-list`, new Raw('{"listId":1e400}')],
  ['m transfer meal zero', 'POST', '/meals/0/to-shopping-list', { listId: LIST }],
  ['m transfer meal negative', 'POST', '/meals/-1/to-shopping-list', { listId: LIST }],
  ['m transfer meal missing', 'POST', '/meals/987654/to-shopping-list', { listId: LIST }],
  ['m transfer meal missing list missing', 'POST', '/meals/987654/to-shopping-list', { listId: 987654 }],
  ['m week transfer', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-11-18' }],
  ['m week transfer empty week', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2030-01-01' }],
  ['m week transfer noshop', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-11-18' }, { actor: 'noshop' }],
  ['m week transfer token bad', 'POST', '/meals/week-to-shopping-list', {}, { actor: 'mealtoken' }],
  ['m week transfer list missing', 'POST', '/meals/week-to-shopping-list', { week: '2026-11-18' }],
  ['m week transfer list zero', 'POST', '/meals/week-to-shopping-list', { listId: 0, week: '2026-11-18' }],
  ['m week transfer list unknown', 'POST', '/meals/week-to-shopping-list', { listId: 987654, week: '2026-11-18' }],
  ['m week transfer week missing', 'POST', '/meals/week-to-shopping-list', { listId: LIST }],
  ['m week transfer week gone', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-02-30' }],
  ['m week transfer week out of range', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-13-45' }],
  ['m week transfer week number', 'POST', '/meals/week-to-shopping-list', { listId: LIST, week: 20261118 }],
  ['m ing delete', 'DELETE', () => `/meals/ingredients/${ids.i1}`, NO_BODY],
  ['m ing delete again', 'DELETE', () => `/meals/ingredients/${ids.i1}`, NO_BODY],
  ['m ing delete zero', 'DELETE', '/meals/ingredients/0', NO_BODY],
  ['m ing delete minus zero', 'DELETE', '/meals/ingredients/-0', NO_BODY],
  ['m ing delete letters', 'DELETE', '/meals/ingredients/abc', NO_BODY],
  ['m delete scope unknown', 'DELETE', () => `/meals/${ids.m1}?scope=bogus`, NO_BODY],
  ['m delete', 'DELETE', () => `/meals/${ids.m1}?scope=single`, NO_BODY],
  ['m delete again', 'DELETE', () => `/meals/${ids.m1}`, NO_BODY],
  ['m delete zero', 'DELETE', '/meals/0', NO_BODY],
  ['m delete negative', 'DELETE', '/meals/-1', NO_BODY],
  ['m delete minus zero', 'DELETE', '/meals/-0', NO_BODY],
  ['m delete hex', 'DELETE', '/meals/0x10', NO_BODY],
  ['m delete series future', 'DELETE', () => `/meals/${ids.m3}?scope=future`, NO_BODY],
  ['m list after future', 'GET', '/meals?week=2026-11-25', NO_BODY],
  () => { ids.m4 = database().prepare("SELECT id FROM meals WHERE title = 'Obst' ORDER BY id LIMIT 1").get().id; },
  ['m delete series', 'DELETE', () => `/meals/0${ids.m4}?scope=series`, NO_BODY],
  ['m delete single on single', 'DELETE', () => `/meals/${ids.m2}?scope=series`, NO_BODY],
  ['m list end', 'GET', '/meals?week=2026-11-18', NO_BODY],
];

// Written against fd2ff4b8b, before the refactor: test/contacts-meals-answers-expected.js.

/** Runs the table and returns each row's answer, normalized. */
async function runTable() {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answers[name] = { status: actual.status, body: normalized(actual.body) };
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  const answers = await runTable();
  for (const [name, answer] of Object.entries(answers)) {
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual(answer, EXPECTED[name], name);
  }
  assert.equal(Object.keys(answers).length, Object.keys(EXPECTED).length, 'every expectation has its row');
  assert.deepEqual(logged.error, [], 'no row of the table reached the central handler');
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
 * Each request in turn with a handler whose first answer throws.
 * @param {Array<[string, string, unknown, string, string?]>} rows [method, path under /api/v1, body, route pattern, actor]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern, actor] of rows) {
    assertCentral(await call(method, route, body, { fail: true, actor: actor ?? 'admin' }), method, pattern);
  }
}

/** A new row through the route, its id. @param {string} route @param {unknown} body */
async function created(route, body) {
  const res = await call('POST', route, body);
  assert.ok(res.status === 201 || res.status === 200, `${route}: ${JSON.stringify(res.body)}`);
  return /** @type {any} */ (res.body).data.id;
}

test('an unexpected error in each contacts and meal-plan route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  await call('POST', '/contacts/categories', { name: 'Probe' });
  const contact = await created('/contacts', { name: 'Probe' });
  await assertAllCentral([
    ['GET', '/contacts/categories', NO_BODY, '/api/v1/contacts/categories'],
    ['POST', '/contacts/categories', { name: 'Probe 2' }, '/api/v1/contacts/categories'],
    ['PATCH', '/contacts/categories/reorder', { order: ['probe'] }, '/api/v1/contacts/categories/reorder'],
    ['PUT', '/contacts/categories/probe', { name: 'Probe 3' }, '/api/v1/contacts/categories/:key'],
    ['DELETE', '/contacts/categories/probe', NO_BODY, '/api/v1/contacts/categories/:key'],
    ['GET', '/contacts', NO_BODY, '/api/v1/contacts/'],
    ['POST', '/contacts', { name: 'Probe 4' }, '/api/v1/contacts/'],
    ['PUT', `/contacts/${contact}`, { notes: 'x' }, '/api/v1/contacts/:id'],
    ['GET', '/contacts/meta', NO_BODY, '/api/v1/contacts/meta'],
    ['GET', `/contacts/${contact}`, NO_BODY, '/api/v1/contacts/:id'],
    ['GET', `/contacts/${contact}/vcard`, NO_BODY, '/api/v1/contacts/:id/vcard'],
    ['DELETE', `/contacts/${contact}`, NO_BODY, '/api/v1/contacts/:id'],
  ]);
  const meal = await created('/meals', MEAL({ date: '2026-12-02', title: 'Probe', ingredients: [{ name: 'Probe' }] }));
  const ingredient = database().prepare('SELECT id FROM meal_ingredients WHERE meal_id = ?').get(meal).id;
  await assertAllCentral([
    ['GET', '/meals/suggestions?q=pro', NO_BODY, '/api/v1/meals/suggestions'],
    ['GET', '/meals?week=2026-12-02', NO_BODY, '/api/v1/meals/'],
    ['POST', '/meals', MEAL({ date: '2026-12-03' }), '/api/v1/meals/'],
    ['POST', '/meals/apply-plan', { assignments: [MEAL({ date: '2026-12-04' })] }, '/api/v1/meals/apply-plan'],
    ['PUT', `/meals/${meal}`, { notes: 'x' }, '/api/v1/meals/:id'],
    ['POST', `/meals/${meal}/ingredients`, { name: 'Probe 2' }, '/api/v1/meals/:id/ingredients'],
    ['PATCH', `/meals/ingredients/${ingredient}`, { name: 'Probe 3' }, '/api/v1/meals/ingredients/:ingId'],
    ['POST', `/meals/${meal}/to-shopping-list`, { listId: LIST }, '/api/v1/meals/:id/to-shopping-list'],
    ['POST', '/meals/week-to-shopping-list', { listId: LIST, week: '2026-12-02' }, '/api/v1/meals/week-to-shopping-list'],
    ['DELETE', `/meals/ingredients/${ingredient}`, NO_BODY, '/api/v1/meals/ingredients/:ingId'],
    ['DELETE', `/meals/${meal}`, NO_BODY, '/api/v1/meals/:id'],
  ]);
  assert.equal((await call('GET', '/contacts/meta', NO_BODY)).status, 200, 'contacts answer again');
  assert.equal((await call('GET', '/meals/suggestions?q=a', NO_BODY)).status, 200, 'the meal plan answers again');
});

test('CardDAV keeps its own 500 with errorCode internal, sync and async alike (not decided, see the PR)', async () => {
  logged.error.length = 0;
  const account = await call('POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'probe' }));
  const id = /** @type {any} */ (account.body).data.account.id;
  const book = lastId('carddav_addressbook_selection');
  const own = { status: 500, body: { error: 'Internal error', errorCode: 'internal', code: 500 } };
  // A rejected promise of the service (the sync failed for another reason
  // than the connection) is the same answer.
  CardDAVSync._mockSyncAccount(async () => { throw new Error('the server went away'); });
  try {
    assert.deepEqual(await call('POST', `/contacts/cardav/accounts/${id}/sync`, NO_BODY), own, 'a rejected promise');
  } finally {
    CardDAVSync._mockSyncAccount(syncOk);
  }
  for (const [method, route, body] of /** @type {Array<[string, string, unknown]>} */ ([
    ['GET', '/contacts/cardav/accounts', NO_BODY],
    ['POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'probe 2' })],
    ['PUT', `/contacts/cardav/accounts/${id}`, { name: 'P', cardavUrl: 'https://dav.example.org/remote.php/dav', username: 'probe' }],
    ['GET', `/contacts/cardav/accounts/${id}/addressbooks`, NO_BODY],
    ['PUT', `/contacts/cardav/addressbooks/${book}`, { enabled: false }],
    ['POST', `/contacts/cardav/accounts/${id}/test`, NO_BODY],
    ['POST', `/contacts/cardav/accounts/${id}/sync`, NO_BODY],
    ['DELETE', `/contacts/cardav/accounts/${id}`, NO_BODY],
  ])) {
    assert.deepEqual(await call(method, route, body, { fail: true }), own, `${method} ${route}`);
  }
  assert.deepEqual(logged.error, [], 'none reached the central handler');
  assert.equal((await call('GET', '/contacts/cardav/accounts', NO_BODY)).status, 200, 'answers again');
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // Mia's contact as it was before the table gave it Tom's address.
  database().prepare('UPDATE contacts SET email = ? WHERE id = ?').run('mia@example.org', SELF_CONTACT);
  database().prepare('DELETE FROM contact_emails WHERE contact_id = ?').run(SELF_CONTACT);
  assert.deepEqual(await call('PUT', `/contacts/${SELF_CONTACT}`, { email: 'tom@example.org' }, { actor: 'self' }), EXPECTED['c put self taken']);
  assert.deepEqual(await call('PUT', `/contacts/${SELF_CONTACT}`, { email: 'neu@example.org' }, { actor: 'mem' }), EXPECTED['c put member other email']);
  assert.deepEqual(await call('DELETE', `/contacts/${SELF_CONTACT}`, NO_BODY), EXPECTED['c delete family']);
  CardDAVSync._mockTestConnection(connectionFails);
  try {
    assert.deepEqual(await call('POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'refused' })), EXPECTED['d create refused']);
  } finally {
    CardDAVSync._mockTestConnection(connectionOk);
  }
  const first = await call('POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'eins' }));
  const second = await call('POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'zwei' }));
  const secondId = /** @type {any} */ (second.body).data.account.id;
  assert.equal(first.status, 201);
  assert.deepEqual(await call('PUT', `/contacts/cardav/accounts/${secondId}`, { name: 'Z', cardavUrl: ACCOUNT().cardavUrl, username: 'eins', password: 'x' }),
    { status: 409, body: { error: 'Account with this URL and username already exists', errorCode: 'account_duplicate', code: 409 } });
  assert.deepEqual(await call('PUT', `/contacts/cardav/accounts/${secondId}`, { name: 'Z', cardavUrl: 'https://evil.example.net/dav', username: 'zwei' }),
    { status: 400, body: { error: 'A new server or username needs the password again', errorCode: 'password_required', code: 400 } });
  assert.deepEqual(await call('GET', '/contacts/cardav/accounts/0/addressbooks', NO_BODY), EXPECTED['d books zero']);
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});

/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} file the router module under server/routes/
 * @param {string} method lower case
 * @param {string} path the Express pattern of the router
 */
async function bareHandler(file, method, path) {
  const { default: router } = await import(`../server/routes/${file}`);
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${path} in ${file}`);
}

/**
 * Runs a bare handler with a raw body, query and params; returns its answer.
 * @param {string} file
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, query?: Record<string, unknown>, params?: Record<string, string> }} input
 */
async function callBare(file, method, path, { body = {}, query = {}, params = {} }) {
  const handler = await bareHandler(file, method, path);
  const req = { method: method.toUpperCase(), body, query, params, authUserId: ADMIN, authRole: 'admin', authScopes: null, session: { userId: ADMIN, role: 'admin' } };
  /** @type {{ status: number, body: unknown }} */
  const out = { status: 200, body: undefined };
  const res = {
    status(/** @type {number} */ code) { out.status = code; return res; },
    json(/** @type {unknown} */ value) { out.body = value; return res; },
    send(/** @type {unknown} */ value) { out.body = value; return res; },
    end() { return res; },
    setHeader() {},
  };
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a loop, a string method or a date computation runs over the raw value, so
// the handler keeps its own type check there (sink, not route; CodeQL
// js/loop-bound-injection in #2860): called without validateRequest(), each
// answers as it did instead of throwing or looping.
test('the sinks check their own input: each handler alone takes a raw value of the wrong type', async () => {
  const sentence = (/** @type {string} */ error) => ({ error, code: 400 });
  // PATCH /contacts/categories/reorder: `order` that is no list is an empty one.
  for (const order of ['x', { length: 1e9 }, 5]) {
    const answer = await callBare('contacts.js', 'patch', '/categories/reorder', { body: { order } });
    assert.equal(answer.status, 200, `order ${JSON.stringify(order)}`);
  }
  // POST and PUT /contacts: the multi-value fields keep their own checks (exported, test-carddav.js).
  assert.deepEqual((await callBare('contacts.js', 'post', '/', { body: { name: 'Senke', phones: { length: 1e9 } } })).body,
    { ...sentence('Phones must be an array'), reason: 'contacts_phone_entry_invalid' });
  assert.deepEqual((await callBare('contacts.js', 'post', '/', { body: { name: 'Senke', emails: 'a@x.de' } })).body,
    { ...sentence('Emails must be an array'), reason: 'contacts_email_entry_invalid' });
  assert.deepEqual((await callBare('contacts.js', 'post', '/', { body: { name: 'Senke', addresses: [{ label: 'h', city: { length: 3 } }] } })).body,
    { ...sentence('Address city invalid or too long'), reason: 'contacts_address_entry_invalid' });
  // POST /meals/apply-plan: `assignments` that is no list is an empty one.
  for (const assignments of ['x', { length: 1e9 }, 5]) {
    assert.deepEqual((await callBare('meals.js', 'post', '/apply-plan', { body: { assignments } })).body, sentence('At least one meal is required.'), `assignments ${JSON.stringify(assignments)}`);
  }
  // GET /meals and POST /meals/week-to-shopping-list: `week` goes into a date computation.
  const week = await callBare('meals.js', 'get', '/', { query: { week: { length: 10 } } });
  assert.equal(week.status, 200, 'a week that is no day is the current one');
  assert.equal(/** @type {any} */ (week.body).weekStart, '2026-11-16');
  assert.deepEqual((await callBare('meals.js', 'post', '/week-to-shopping-list', { body: { listId: LIST, week: { length: 10 } } })).body, sentence('A valid date (YYYY-MM-DD) is required.'));
  // PUT /meals/{id}?scope=series: `ingredients` that is no list leaves them.
  const series = await created('/meals', MEAL({ date: '2027-01-04', title: 'Senke', repeat_weekly: true, ingredients: [{ name: 'Bleibt' }] }));
  const kept = await callBare('meals.js', 'put', '/:id', { body: { ingredients: { length: 1e9 } }, query: { scope: 'series' }, params: { id: String(series) } });
  assert.equal(kept.status, 200);
  assert.deepEqual(/** @type {any} */ (kept.body).data.ingredients.map((/** @type {any} */ i) => i.name), ['Bleibt']);
  // PUT /contacts/cardav/accounts/{id}: a password that is no text keeps the stored one.
  const account = await call('POST', '/contacts/cardav/accounts', ACCOUNT({ username: 'senke' }));
  const id = /** @type {any} */ (account.body).data.account.id;
  for (const password of [5, { trim: 1 }, ['x']]) {
    const answer = await callBare('cardav.js', 'put', '/accounts/:id', { body: { name: 'S', cardavUrl: ACCOUNT().cardavUrl, username: 'senke', password }, params: { id: String(id) } });
    assert.equal(answer.status, 200, `password ${JSON.stringify(password)}`);
  }
  assert.equal(database().prepare('SELECT password FROM carddav_accounts WHERE id = ?').get(id).password, ' geheim ', 'the stored password stays');
});
