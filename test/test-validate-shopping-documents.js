/**
 * Test: request validation in shopping, documents, Google Drive storage and
 *       the DMS (#2810, phase 2 section E, group 8)
 * Purpose: server/routes/shopping.js (28 routes), documents.js (17),
 *          document-storage-google-drive.js (4) and dms.js (8) check every
 *          request against the schema of its operation in the OpenAPI
 *          document (`validateRequest()` in every route) before the handler
 *          runs. Held here against the real routers at their real prefixes,
 *          in the order of server/index.js (express.json, defaultEmptyBody,
 *          the routers, the central error handler;
 *          test/shopping-documents-app.js):
 *            - THE OWN CALLERS: the requests public/pages/shopping.js,
 *              components/category-manager.js, utils/kitchen-transfer.js,
 *              pages/pantry.js, pages/documents.js (after its switch to
 *              numeric folder and account ids), components/document-attach.js,
 *              pages/housekeeping.js, settings/pages/documents-storage.js and
 *              documents-dms.js send pass, ids as numbers and as legacy digit
 *              text, an upload as a base64 data URL, a real OAuth callback;
 *            - REFUSED: garbage per field is a 400 with `reason: 'validation'`
 *              and `fields`: a path id that is not plain decimal digits
 *              (`0x1` hit document 1), a non-text in a text field (`name: {}`
 *              was stored as `[object Object]`), an unknown `visibility`
 *              (became `family`), `expiry_reminder_days: true` (read as 1),
 *              an unknown DMS `provider` (became `paperless`), a
 *              `dms_document_id` that is an object (stored as its text),
 *              query garbage and doubled values;
 *            - ORDER: a malformed request is a 400 before the 404, 403 and
 *              409 of the handler; the rights without a row stand in front:
 *              `requireAdmin` on the storage settings, Google Drive and every
 *              DMS route, `cross_module_access` on both kitchen imports;
 *            - THE SINK: the DMS adapter lookup reads only own keys;
 *            - ONE SOURCE: every list of the schemas is the constant the
 *              handler reads, and the DMS providers are the adapters.
 *          The household zone is pinned; no answer asserted here carries a
 *          date of the clock.
 * Run: npm run test:validate-shopping-documents
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-validate-shopping-documents-');
for (const key of ['DOCUMENT_STORAGE_LOCAL_PATH', 'WEBDAV_URL', 'WEBDAV_USERNAME', 'WEBDAV_PASSWORD', 'WEBDAV_PATH']) delete process.env[key];

import test from 'node:test';
import assert from 'node:assert/strict';
import { createShoppingDocumentsApp } from './shopping-documents-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const fields = await import('../server/services/document-fields.js');
const { MODULE_FOLDER_KEYS } = await import('../server/services/document-folders.js');
const dmsService = await import('../server/services/dms/index.js');
const { _setAdapterFactory } = await import('../server/routes/dms.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, 'parent')")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin8', 'admin');
const MEM = user('mem8', 'member');
db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

/** @type {Record<string, { id: number, role: string, scopes?: string[] }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  // A token scoped to the shopping list alone: no meal-plan write, no pantry read.
  shoptoken: { id: ADMIN, role: 'admin', scopes: ['shopping:read', 'shopping:write'] },
};

const app = await createShoppingDocumentsApp({
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = actor.scopes ? 'token' : 'session';
    req.authScopes = actor.scopes ?? null;
    req.session = { userId: actor.id, role: actor.role, googleDriveOAuthState: 'state-1' };
    next();
  },
  jsonLimit: '10mb',
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
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body, text };
}

/**
 * A 400 of the schema check naming `path` (and `rule`, when given) among its fields.
 * @param {{ status: number, body: any }} r
 * @param {string} path
 * @param {string} [rule]
 * @param {string} [label]
 */
function assertRefused(r, path, rule, label = path) {
  assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, SENTENCE, label);
  assert.equal(r.body?.reason, 'validation', label);
  const hit = (r.body?.fields ?? []).find((/** @type {any} */ f) => f.path === path && (rule === undefined || f.rule === rule));
  assert.ok(hit, `${label}: field ${path}${rule ? ` (${rule})` : ''} in ${JSON.stringify(r.body?.fields)}`);
}

/** Passed the schema check: whatever the handler answers, it is not its 400. */
function assertPassed(/** @type {{ status: number, body: any }} */ r, /** @type {string} */ label) {
  assert.ok(r.status !== 400 || r.body?.reason !== 'validation', `${label}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.notEqual(r.status, 500, `${label}: ${JSON.stringify(r.body)}`);
}

const TEXT_FILE = `data:text/plain;base64,${Buffer.from('hallo').toString('base64')}`;
const GONE = 987654;

/** @param {string} name */
function newList(name) {
  return Number(db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run(name, ADMIN).lastInsertRowid);
}
/** @param {number} list @param {string} name */
function newItem(list, name) {
  return Number(db.prepare("INSERT INTO shopping_items (list_id, name, category) VALUES (?, ?, 'Sonstiges')").run(list, name).lastInsertRowid);
}
/** @param {string} name @param {number} [owner] */
function newDocument(name, owner = ADMIN) {
  return Number(db.prepare(`INSERT INTO family_documents (name, category, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'other', 'family', 'a.txt', 'text/plain', 5, ?, ?)`).run(name, Buffer.from('hallo').toString('base64'), owner).lastInsertRowid);
}
function newDmsAccount(provider = 'paperless') {
  return Number(db.prepare(`INSERT INTO dms_accounts (provider, name, base_url, api_token, org_id)
    VALUES (?, ?, ?, 'token', ?)`).run(provider, `DMS ${provider}`, `https://${provider}-${Math.random().toString(36).slice(2)}.test`, provider === 'papra' ? 'org' : '').lastInsertRowid);
}
const FAKE_ADAPTER = {
  async testConnection() { return { ok: true, status: 200 }; },
  async search() { return [{ id: '5', title: 'Rechnung' }]; },
  async getDocument(/** @type {string} */ id) { return { title: `DMS ${id}`, filename: 'a.pdf', url: 'https://dms.test/a' }; },
  async upload() { return { taskId: 't-1' }; },
  async fetchThumbnail() { return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }; },
};

// --------------------------------------------------------------------------
// The own callers
// --------------------------------------------------------------------------

test('shopping: the page, the category manager, the kitchen transfers and the pantry pass', async () => {
  const created = await call('POST', '/shopping', { json: { name: 'Wocheneinkauf' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const list = created.body.data.id;
  const item = await call('POST', `/shopping/${list}/items`, { json: { name: 'Milch', quantity: '1 L', category: undefined } });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  const itemId = item.body.data.id;
  const store = await call('POST', '/shopping/stores', { json: { name: 'Markt' } });
  assert.equal(store.status, 201);
  const other = newList('Zweite');

  for (const [method, route, json, label] of /** @type {Array<[string, string, any, string]>} */ ([
    ['PATCH', `/shopping/items/${itemId}`, { is_checked: 1 }, 'tick (0/1)'],
    ['PATCH', `/shopping/items/${itemId}`, { is_checked: 0, price_cents: 199, store_id: store.body.data.id }, 'untick with price and shop'],
    ['PATCH', `/shopping/items/${itemId}`, { name: 'Milch', quantity: null, category: 'Sonstiges', notes: null, url: null, price_cents: null, store_id: null }, 'edit dialog'],
    ['PATCH', `/shopping/items/${itemId}`, { url: '', notes: 'Bio', quantity: '2 L' }, 'edit dialog, link cleared'],
    ['PATCH', `/shopping/items/${itemId}`, { store_id: String(store.body.data.id), list_id: String(list) }, 'legacy digit text'],
    ['PATCH', `/shopping/items/${itemId}`, { store_id: '' }, 'shop cleared with an empty string'],
    ['PATCH', `/shopping/items/${itemId}`, { list_id: other }, 'move'],
    ['PATCH', `/shopping/items/${itemId}`, { list_id: list }, 'move back'],
    ['PUT', `/shopping/${list}`, { name: 'Umbenannt' }, 'rename list'],
    ['POST', `/shopping/${list}/duplicate`, { name: 'Kopie', resetChecked: true, keepQuantities: false, keepNotes: true }, 'duplicate'],
    ['PATCH', `/shopping/${list}/items/reorder`, { category: 'Sonstiges', order: [itemId] }, 'reorder items'],
    ['POST', '/shopping/categories', { name: 'Tiefkühl' }, 'category manager: add'],
    ['POST', `/shopping/${list}/import-meal-plan`, { from: '2026-01-05', to: '2026-01-11', preview: true }, 'meal-plan import preview'],
    ['POST', `/shopping/${list}/import-meal-plan`, { from: '2026-01-05', to: '2026-01-11' }, 'meal-plan import'],
    ['POST', `/shopping/${list}/import-pantry`, { items: [{ pantry_item_id: 999, quantity: '2' }, { pantry_product_id: 998, quantity: null }] }, 'pantry'],
    ['POST', '/shopping/items/undo-transfer', { ids: [GONE] }, 'kitchen undo'],
    ['POST', '/shopping/items/undo-transfer', { ids: [GONE], ingredient_ids: [GONE] }, 'kitchen undo with ingredients'],
    ['DELETE', `/shopping/${list}/items/checked`, { ids: [itemId] }, 'clear ticked, named'],
    ['POST', `/shopping/${list}/send`, { userId: MEM }, 'send'],
  ])) {
    assertPassed(await call(method, route, { json }), label);
  }
  assertPassed(await call('DELETE', `/shopping/${list}/items/checked`), 'clear ticked without a body');
  assertPassed(await call('GET', `/shopping/suggestions?q=${encodeURIComponent('Mi')}`), 'suggestions');
  assertPassed(await call('GET', `/shopping/price-history?name=${encodeURIComponent('Milch')}&exclude_item_id=${itemId}&limit=1`), 'price history');

  // The category manager: rename and the order, as numbers (`numericKeys`,
  // the page since #2810) and as the digit text it sent before.
  const categories = (await call('GET', '/shopping/categories')).body.data;
  const ids = categories.map((/** @type {any} */ c) => c.id);
  assertPassed(await call('PUT', `/shopping/categories/${ids.at(-1)}`, { json: { name: 'Tiefkühlware' } }), 'category rename');
  assertPassed(await call('PATCH', '/shopping/categories/reorder', { json: { order: ids } }), 'category order, numbers');
  assertPassed(await call('PATCH', '/shopping/categories/reorder', { json: { order: ids.map(String) } }), 'category order, legacy text');
  assertPassed(await call('PUT', `/shopping/stores/${store.body.data.id}`, { json: { name: 'Markt Süd' } }), 'shop rename');
  assertPassed(await call('DELETE', `/shopping/stores/${store.body.data.id}`), 'shop removed');
});

test('documents: the upload dialog, the attachment component, the folder tree and the edit dialog pass', async () => {
  const folder = await call('POST', '/documents/folders', { json: { name: 'Wohnung', parent_id: null } });
  assert.equal(folder.status, 201, JSON.stringify(folder.body));
  const folderId = folder.body.data.id;
  const sub = await call('POST', '/documents/folders', { json: { name: 'Miete', parent_id: folderId } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));

  // pages/documents.js saveDocument() (folder as a number since #2810).
  const payload = {
    name: 'Mietvertrag', description: null, category: 'home', folder_id: folderId, visibility: 'restricted', status: 'active',
    expires_at: '2027-01-31', expiry_reminder_days: 30, subject_user_id: MEM, allowed_member_ids: [MEM],
  };
  const created = await call('POST', '/documents', { json: { ...payload, original_name: 'vertrag.txt', content_data: TEXT_FILE } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const doc = created.body.data.id;
  // components/document-attach.js and pages/housekeeping.js.
  assertPassed(await call('POST', '/documents', { json: {
    name: 'Beleg', description: '', category: 'finance', visibility: 'family', status: 'active', allowed_member_ids: [],
    original_name: 'beleg.txt', content_data: TEXT_FILE, folder_key: 'budget', folder_name: 'Budget',
  } }), 'attachment');
  assertPassed(await call('PUT', `/documents/${doc}`, { json: payload }), 'edit dialog');
  assertPassed(await call('PUT', `/documents/${doc}`, { json: { ...payload, folder_id: String(folderId), expires_at: null, expiry_reminder_days: null, subject_user_id: null } }), 'legacy digit text, cleared fields');
  // The bulk move (pages/documents.js, no expiry fields).
  assertPassed(await call('PUT', `/documents/${doc}`, { json: {
    name: 'Mietvertrag', description: null, category: 'home', folder_id: null, visibility: 'family', status: 'active', allowed_member_ids: [],
  } }), 'bulk move');
  assertPassed(await call('PATCH', `/documents/${doc}/archive`, { json: { archived: true } }), 'archive');
  assertPassed(await call('PATCH', `/documents/${doc}/archive`, { json: { archived: false } }), 'restore');
  assertPassed(await call('PATCH', `/documents/${doc}/archive`), 'archive without a body');
  assertPassed(await call('GET', '/documents?status=archived'), 'list');
  assertPassed(await call('GET', `/documents?folder_id=${folderId}&category=home&expiring=30&subject_user_id=${MEM}`), 'filters');
  assertPassed(await call('PUT', `/documents/folders/${sub.body.data.id}`, { json: { parent_id: null } }), 'folder move');
  assertPassed(await call('PUT', `/documents/folders/${sub.body.data.id}`, { json: { name: 'Nebenkosten' } }), 'folder rename');
  const impact = await call('GET', `/documents/folders/${folderId}/delete-impact`);
  assert.equal(impact.status, 200);
  const { documents, removed_folders: folders, snapshot } = impact.body.data;
  assertPassed(await call('DELETE', `/documents/folders/${folderId}?documents=delete&expected_documents=${documents}&expected_folders=${folders}&expected_snapshot=${snapshot}`), 'folder delete');
  assertPassed(await call('GET', `/documents/${doc}/download`), 'download');
  assertPassed(await call('GET', `/documents/${doc}/preview`), 'preview');
  assertPassed(await call('DELETE', `/documents/${doc}`), 'delete');
});

test('storage settings, Google Drive and the DMS: the settings pages and the link dialog pass', async () => {
  // settings/pages/documents-storage.js: empty text clears, the selector alone.
  assertPassed(await call('PUT', '/documents/storage/config', { json: { enabled: false, url: '', username: '', path: '', confirm_existing_access: true } }), 'WebDAV form');
  assertPassed(await call('PUT', '/documents/storage/config', { json: { selected_upload_backend: 'local' } }), 'selector');
  assertPassed(await call('POST', '/documents/storage/test', { json: { enabled: true, url: 'https://dav.invalid/', username: 'u', password: 'p', path: 'docs' } }), 'WebDAV test');
  // A real OAuth callback: Google adds `scope` (and more) to code and state.
  const callback = await call('GET', '/documents/storage/google-drive/callback?state=state-1&code=4%2F0Ab&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&authuser=0&prompt=consent');
  assert.equal(callback.status, 302, callback.text);
  const denied = await call('GET', '/documents/storage/google-drive/callback?error=access_denied&state=state-1');
  assert.equal(denied.status, 302, denied.text);
  assertPassed(await call('POST', '/documents/storage/google-drive/test', { json: {} }), 'Drive test');

  _setAdapterFactory(() => FAKE_ADAPTER);
  try {
    // settings/pages/documents-dms.js.
    const papra = await call('POST', '/documents/dms/accounts', { json: { provider: 'papra', name: 'Papra', base_url: 'https://papra.test', api_token: 't', org_id: 'org' } });
    assert.equal(papra.status, 201, JSON.stringify(papra.body));
    assertPassed(await call('POST', '/documents/dms/accounts', { json: { name: 'Ohne Anbieter', base_url: 'https://pl.test', api_token: 't' } }), 'without provider');
    const account = papra.body.data.id;
    assertPassed(await call('POST', `/documents/dms/accounts/${account}/test`), 'account test');
    assertPassed(await call('GET', `/documents/dms/search?account_id=${account}&q=${encodeURIComponent('Rech')}`), 'search');
    assertPassed(await call('GET', `/documents/dms/search?account_id=${account}&q=`), 'search, all');
    assertPassed(await call('GET', `/documents/dms/thumbnail?account_id=${account}&dms_document_id=5`), 'thumbnail');
    // pages/documents.js linkDmsDocument(): the id of the DMS as text, the account as a number (since #2810).
    assertPassed(await call('POST', '/documents/dms/link', { json: { account_id: account, dms_document_id: '5', category: 'other', visibility: 'family' } }), 'link');
    assertPassed(await call('POST', '/documents/dms/link', { json: { account_id: String(account), dms_document_id: 6 } }), 'link, legacy forms');
    assertPassed(await call('POST', '/documents/dms/push', { json: { account_id: account, document_id: newDocument('Zum DMS') } }), 'push');
    assertPassed(await call('DELETE', `/documents/dms/accounts/${account}`), 'account removed');
  } finally {
    _setAdapterFactory(null);
  }
});

// --------------------------------------------------------------------------
// Refused
// --------------------------------------------------------------------------

test('a path id that is not plain decimal digits is a 400 on every kind of route', async () => {
  const doc = newDocument('Pfad');
  const list = newList('Pfad');
  // `0x1` read as Number() hit document 1, the shopping routes bound it raw.
  for (const route of [`/documents/0x${doc.toString(16)}`, `/documents/${doc}.0`, '/documents/1e0']) {
    assertRefused(await call('PUT', route, { json: { name: 'Neu' } }), 'path/id', 'type', route);
  }
  assertRefused(await call('GET', '/documents/1e0/preview'), 'path/id', 'type', 'preview');
  assertRefused(await call('GET', `/shopping/${list}.0/items`), 'path/listId', 'type', 'list items');
  assertRefused(await call('DELETE', '/shopping/items/abc'), 'path/itemId', 'type', 'item');
  assertRefused(await call('DELETE', '/documents/dms/accounts/0x1'), 'path/id', 'type', 'DMS account');
  assert.equal(db.prepare('SELECT name FROM family_documents WHERE id = ?').get(doc).name, 'Pfad', 'the row is untouched');
});

test('shopping: non-text names, broken ids and flags, query garbage', async () => {
  const list = newList('Muell');
  const item = newItem(list, 'Brot');
  for (const [method, route, json, path] of /** @type {Array<[string, string, any, string]>} */ ([
    ['POST', '/shopping', { name: {} }, 'body/name'],
    ['POST', '/shopping', { name: 5 }, 'body/name'],
    ['PUT', `/shopping/${list}`, { name: ['x'] }, 'body/name'],
    ['POST', '/shopping/stores', { name: {} }, 'body/name'],
    ['POST', '/shopping/categories', { name: 5 }, 'body/name'],
    ['POST', `/shopping/${list}/duplicate`, { name: true }, 'body/name'],
    ['PATCH', `/shopping/items/${item}`, { is_checked: 'true' }, 'body/is_checked'],
    ['PATCH', `/shopping/items/${item}`, { price_cents: true }, 'body/price_cents'],
    ['PATCH', `/shopping/items/${item}`, { price_cents: '0x10' }, 'body/price_cents'],
    ['PATCH', `/shopping/items/${item}`, { store_id: '01' }, 'body/store_id'],
    ['PATCH', `/shopping/items/${item}`, { list_id: true }, 'body/list_id'],
    ['PATCH', '/shopping/categories/reorder', { order: [{}] }, 'body/order/0'],
    ['PATCH', '/shopping/categories/reorder', { order: [1.5] }, 'body/order/0'],
    ['PATCH', `/shopping/${list}/items/reorder`, { category: 'Sonstiges', order: ['1'] }, 'body/order/0'],
    ['POST', `/shopping/${list}/import-meal-plan`, { from: '2026-01-05', to: '2026-01-11', preview: 'true' }, 'body/preview'],
    ['POST', `/shopping/${list}/import-meal-plan`, { from: 5, to: '2026-01-11' }, 'body/from'],
    ['POST', `/shopping/${list}/import-pantry`, { items: 'abc' }, 'body/items'],
    ['POST', `/shopping/${list}/import-pantry`, {}, 'body/items'],
    ['POST', `/shopping/${list}/import-pantry`, { items: [5] }, 'body/items/0'],
    ['POST', '/shopping/items/undo-transfer', { ids: [{}] }, 'body/ids/0'],
    ['POST', `/shopping/${list}/send`, { userId: true }, 'body/userId'],
    ['DELETE', `/shopping/${list}/items/checked`, { ids: ['1'] }, 'body/ids/0'],
  ])) {
    assertRefused(await call(method, route, { json }), path, undefined, `${method} ${route} ${JSON.stringify(json)}`);
  }
  for (const [route, path] of [
    ['/shopping/suggestions?q=a&q=b', 'query/q'],
    ['/shopping/price-history?limit=5', 'query/name'],
    ['/shopping/price-history?name=Brot&limit=0', 'query/limit'],
    ['/shopping/price-history?name=Brot&exclude_item_id=abc', 'query/exclude_item_id'],
  ]) {
    assertRefused(await call('GET', route), path, undefined, route);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shopping_lists WHERE name = '[object Object]'").get().n, 0);
});

test('documents: unknown values, non-text, broken ids, query garbage', async () => {
  const doc = newDocument('Ziel');
  const base = { name: 'Neu', original_name: 'a.txt', content_data: TEXT_FILE };
  for (const [json, path] of /** @type {Array<[any, string]>} */ ([
    [{ ...base, visibility: 'Private' }, 'body/visibility'],
    [{ ...base, category: 'Medical' }, 'body/category'],
    [{ ...base, name: {} }, 'body/name'],
    [{ ...base, expiry_reminder_days: true }, 'body/expiry_reminder_days'],
    [{ ...base, expiry_reminder_days: '5' }, 'body/expiry_reminder_days'],
    [{ ...base, folder_id: '1abc' }, 'body/folder_id'],
    [{ ...base, folder_id: '0' }, 'body/folder_id'],
    [{ ...base, folder_key: 'nope' }, 'body/folder_key'],
    [{ ...base, subject_user_id: true }, 'body/subject_user_id'],
    [{ ...base, allowed_member_ids: ['x'] }, 'body/allowed_member_ids/0'],
    [{ ...base, expires_at: '31.01.2027' }, 'body/expires_at'],
    [{ name: 'Ohne Datei', original_name: 'a.txt' }, 'body/content_data'],
  ])) {
    assertRefused(await call('POST', '/documents', { json }), path, undefined, `POST ${JSON.stringify(json).slice(0, 80)}`);
  }
  for (const [json, path] of /** @type {Array<[any, string]>} */ ([
    [{ status: 'gone' }, 'body/status'],
    [{ visibility: 5 }, 'body/visibility'],
    [{ description: 5 }, 'body/description'],
  ])) {
    assertRefused(await call('PUT', `/documents/${doc}`, { json }), path, undefined, `PUT ${JSON.stringify(json)}`);
  }
  assertRefused(await call('PATCH', `/documents/${doc}/archive`, { json: { archived: 'false' } }), 'body/archived', 'type');
  assertRefused(await call('POST', '/documents/folders', { json: { name: 5 } }), 'body/name', 'type');
  assertRefused(await call('POST', '/documents/folders', { json: { name: 'X', parent_id: '0x1' } }), 'body/parent_id');
  assertRefused(await call('PUT', '/documents/storage/config', { json: { selected_upload_backend: 'ftp' } }), 'body/selected_upload_backend', 'enum');
  assertRefused(await call('PUT', '/documents/storage/config', { json: { enabled: 'yes' } }), 'body/enabled', 'type');
  for (const [route, path] of [
    ['/documents?status=deleted', 'query/status'],
    ['/documents?category=Medical', 'query/category'],
    ['/documents?folder_id=abc', 'query/folder_id'],
    ['/documents?expiring=abc', 'query/expiring'],
    ['/documents?status=active&status=archived', 'query/status'],
  ]) {
    assertRefused(await call('GET', route), path, undefined, route);
  }
  assertRefused(await call('DELETE', `/documents/folders/${GONE}?documents=`), 'query/documents', undefined, 'empty action');
  assertRefused(await call('GET', '/documents/storage/google-drive/callback?code=a&code=b&state=state-1'), 'query/code', 'type', 'doubled code');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM family_documents WHERE name = 'Neu'").get().n, 0, 'nothing was stored');
});

test('DMS: unknown provider, a link id that is not text or a number, account ids', async () => {
  const account = newDmsAccount();
  _setAdapterFactory(() => FAKE_ADAPTER);
  try {
    for (const [route, json, path] of /** @type {Array<[string, any, string]>} */ ([
      ['/documents/dms/accounts', { provider: 'zzz', name: 'X', base_url: 'https://x.test', api_token: 't' }, 'body/provider'],
      ['/documents/dms/accounts', { provider: 5, name: 'X', base_url: 'https://x.test', api_token: 't' }, 'body/provider'],
      ['/documents/dms/accounts', { name: {}, base_url: 'https://x.test', api_token: 't' }, 'body/name'],
      ['/documents/dms/link', { account_id: account, dms_document_id: {} }, 'body/dms_document_id'],
      ['/documents/dms/link', { account_id: account, dms_document_id: true }, 'body/dms_document_id'],
      ['/documents/dms/link', { account_id: account, dms_document_id: '7', visibility: 'Private' }, 'body/visibility'],
      ['/documents/dms/link', { account_id: true, dms_document_id: '7' }, 'body/account_id'],
      ['/documents/dms/link', { account_id: '1.0', dms_document_id: '7' }, 'body/account_id'],
      ['/documents/dms/push', { account_id: account, document_id: 'abc' }, 'body/document_id'],
    ])) {
      assertRefused(await call('POST', route, { json }), path, undefined, `${route} ${JSON.stringify(json)}`);
    }
    assertRefused(await call('GET', '/documents/dms/search?account_id=0x1'), 'query/account_id', 'type');
    assertRefused(await call('GET', '/documents/dms/search'), 'query/account_id', 'required');
    assertRefused(await call('GET', `/documents/dms/thumbnail?account_id=${account}`), 'query/dms_document_id', 'required');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM family_documents WHERE storage_key IN ('[object Object]', 'true')").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dms_accounts WHERE base_url = 'https://x.test'").get().n, 0);
  } finally {
    _setAdapterFactory(null);
  }
});

test('an access list with an id that has no account is the 400 of a non-member, not a 500', async () => {
  const doc = newDocument('Freigabe');
  const body = { name: 'Freigabe', original_name: 'a.txt', content_data: TEXT_FILE, visibility: 'restricted', allowed_member_ids: [GONE] };
  for (const r of [
    await call('POST', '/documents', { json: body }),
    await call('PUT', `/documents/${doc}`, { json: { visibility: 'restricted', allowed_member_ids: [GONE] } }),
  ]) {
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(String(r.body?.error), /household member/i);
    assert.match(String(r.body?.error), new RegExp(String(GONE)));
  }
});

// --------------------------------------------------------------------------
// Order
// --------------------------------------------------------------------------

test('a malformed request is a 400 before the 404, 403 and 409 of the handler', async () => {
  // 404: an unknown list, item, category, shop, document, folder, DMS account.
  for (const [method, route, json, path] of /** @type {Array<[string, string, any, string]>} */ ([
    ['POST', `/shopping/${GONE}/items`, { name: 5 }, 'body/name'],
    ['POST', `/shopping/${GONE}/duplicate`, { name: {} }, 'body/name'],
    ['PATCH', `/shopping/${GONE}/items/reorder`, { order: 'x' }, 'body/order'],
    ['DELETE', `/shopping/${GONE}/items/checked`, { ids: [] }, 'body/ids'],
    ['POST', `/shopping/${GONE}/send`, {}, 'body/userId'],
    ['PATCH', `/shopping/items/${GONE}`, { is_checked: 2 }, 'body/is_checked'],
    ['PUT', `/shopping/categories/${GONE}`, { name: 5 }, 'body/name'],
    ['PUT', `/shopping/stores/${GONE}`, { name: 5 }, 'body/name'],
    ['PUT', `/documents/${GONE}`, { visibility: 'Private' }, 'body/visibility'],
    ['PATCH', `/documents/${GONE}/archive`, { archived: 0 }, 'body/archived'],
    ['PUT', `/documents/folders/${GONE}`, { name: 5 }, 'body/name'],
    ['POST', '/documents/dms/link', { account_id: GONE }, 'body/dms_document_id'],
    ['POST', '/documents/dms/push', { account_id: GONE, document_id: 'x' }, 'body/document_id'],
  ])) {
    assertRefused(await call(method, route, { json }), path, undefined, `${method} ${route}`);
  }
  // 403 at the row: a member may not change the document of another.
  const foreign = newDocument('Fremd', ADMIN);
  assertRefused(await call('PUT', `/documents/${foreign}`, { json: { category: 'nope' }, actor: 'mem' }), 'body/category', 'enum', 'mayManage');
  const valid = await call('PUT', `/documents/${foreign}`, { json: { category: 'home' }, actor: 'mem' });
  assert.equal(valid.status, 403, 'a valid request meets the old answer');
  // 409: a category name that is taken.
  const existing = (await call('GET', '/shopping/categories')).body.data[0].name;
  const taken = await call('POST', '/shopping/categories', { json: { name: existing } });
  assert.equal(taken.status, 409);
  assertRefused(await call('POST', '/shopping/categories', { json: { name: [existing] } }), 'body/name', 'type', '409');
});

test('rights without a row stand in front: admin gates and the kitchen imports', async () => {
  const list = newList('Rechte');
  const ADMIN_REQUIRED = { error: 'Admin access required.', code: 403, reason: 'admin_required' };
  for (const [method, route, json] of /** @type {Array<[string, string, any]>} */ ([
    ['GET', '/documents/storage/config', undefined],
    ['PUT', '/documents/storage/config', { selected_upload_backend: 'x', enabled: 'yes' }],
    ['POST', '/documents/storage/test', { url: 5 }],
    ['GET', '/documents/storage/google-drive/callback?code=a&code=b', undefined],
    ['POST', '/documents/storage/google-drive/test', {}],
    ['GET', '/documents/dms/accounts', undefined],
    ['POST', '/documents/dms/accounts', { provider: 'zzz' }],
    ['DELETE', '/documents/dms/accounts/0x1', undefined],
    ['GET', '/documents/dms/search?account_id=abc', undefined],
    ['GET', '/documents/dms/thumbnail', undefined],
    ['POST', '/documents/dms/link', { dms_document_id: {} }],
    ['POST', '/documents/dms/push', {}],
  ])) {
    const r = await call(method, route, { json, actor: 'mem' });
    assert.deepEqual([r.status, r.body], [403, ADMIN_REQUIRED], `${method} ${route}`);
  }
  // A credential without the meal plan (write) or the pantry (read): 403
  // cross_module_access before the 404 of the list and before the 400.
  for (const [route, json, error] of [
    [`/shopping/${GONE}/import-meal-plan`, { from: 5 }, 'Write access to the meal plan is required.'],
    [`/shopping/${list}/import-meal-plan`, { from: '2026-01-05', to: '2026-01-11', preview: true }, 'Write access to the meal plan is required.'],
    [`/shopping/${GONE}/import-pantry`, { items: 'abc' }, 'Read access to the pantry is required.'],
    [`/shopping/${list}/import-pantry`, { items: [] }, 'Read access to the pantry is required.'],
  ]) {
    const r = await call('POST', /** @type {string} */ (route), { json, actor: 'shoptoken' });
    assert.deepEqual([r.status, r.body], [403, { error, code: 403, reason: 'cross_module_access' }], String(route));
  }
});

// --------------------------------------------------------------------------
// The sink and the one source
// --------------------------------------------------------------------------

test('the DMS adapter lookup reads only own keys', () => {
  for (const provider of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.throws(() => dmsService.getAdapter({ provider }), /Unknown DMS provider/, provider);
  }
  assert.equal(typeof dmsService.getAdapter({ provider: 'paperless', base_url: 'https://pl.test', api_token: 't' }).search, 'function');
});

test('every list of the schemas is the constant the handler reads', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const bodyOf = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method].requestBody.content['application/json'].schema.properties;
  const queryOf = (/** @type {string} */ path, /** @type {string} */ name) => spec.paths[path].get.parameters.find((/** @type {any} */ p) => p.name === name).schema;
  // The DMS providers are the adapters of server/services/dms/index.js.
  assert.deepEqual([...fields.DMS_PROVIDERS], dmsService.SUPPORTED_PROVIDERS);
  for (const [schema, constant, label] of /** @type {Array<[any, readonly string[], string]>} */ ([
    [bodyOf('/api/v1/documents', 'post').category, fields.DOCUMENT_CATEGORIES, 'POST category'],
    [bodyOf('/api/v1/documents', 'post').visibility, fields.DOCUMENT_VISIBILITIES, 'POST visibility'],
    [bodyOf('/api/v1/documents', 'post').folder_key, MODULE_FOLDER_KEYS, 'POST folder_key'],
    [bodyOf('/api/v1/documents/{id}', 'put').status, fields.DOCUMENT_STATUSES, 'PUT status'],
    [queryOf('/api/v1/documents', 'status'), fields.DOCUMENT_STATUSES, 'query status'],
    [queryOf('/api/v1/documents', 'category'), fields.DOCUMENT_CATEGORIES, 'query category'],
    [schemas.DocumentStorageConfigRequest.properties.selected_upload_backend, fields.DOCUMENT_UPLOAD_BACKENDS, 'upload backend'],
    [schemas.DmsAccountCreateRequest.properties.provider, fields.DMS_PROVIDERS, 'provider'],
    [schemas.DmsAccount.properties.provider, fields.DMS_PROVIDERS, 'provider of the answer'],
    [schemas.DmsLinkRequest.properties.category, fields.DOCUMENT_CATEGORIES, 'link category'],
    [schemas.DmsLinkRequest.properties.visibility, fields.DOCUMENT_VISIBILITIES, 'link visibility'],
  ])) {
    assert.deepEqual(schema.enum, [...constant], label);
  }
});

// Since group 8 step (b) the schema is the only guard for these: the handlers
// dropped their own check (#2810). So the types, lists and bounds are pinned
// here as literal values - a looser type, a value added to a list (also to
// the constant the list is read from), a lost `required` or a wider bound in
// the document turns this red.
test('only guard: the types, lists and bounds the handlers no longer check are the document\'s, as values', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const schemas = spec.components.schemas;
  const op = (/** @type {string} */ path, /** @type {string} */ method) => spec.paths[path][method];
  const bodyOf = (/** @type {string} */ path, /** @type {string} */ method) => op(path, method).requestBody.content['application/json'].schema;
  const queryOf = (/** @type {string} */ path, /** @type {string} */ method, /** @type {string} */ name) => op(path, method).parameters.find((/** @type {any} */ p) => p.name === name && p.in === 'query').schema;
  const ROW_ID = { type: 'integer', minimum: 1 };
  const ROW_ID_OR_NULL = [{ $ref: '#/components/schemas/BodyRowId' }, { type: 'null' }];
  const CATEGORIES = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
  const VISIBILITIES = ['family', 'restricted', 'private'];
  const STATUSES = ['active', 'archived'];

  // Shopping: PATCH /items/{itemId} (is_checked, the text fields).
  const update = schemas.ShoppingItemUpdateInput.properties;
  assert.deepEqual(update.is_checked.anyOf, [{ type: 'boolean' }, { type: 'integer', enum: [0, 1] }]);
  assert.equal(update.name.type, 'string');
  assert.equal(update.category.type, 'string', 'category cannot be null');
  assert.deepEqual(update.quantity.type, ['string', 'null']);
  assert.deepEqual(update.notes.type, ['string', 'null']);
  // POST /{listId}/items: the text fields.
  const create = schemas.ShoppingItemCreateInput;
  assert.equal(create.properties.name.type, 'string');
  assert.deepEqual(create.required, ['name']);
  assert.deepEqual(create.properties.quantity.type, ['string', 'null']);
  assert.deepEqual(create.properties.notes.type, ['string', 'null']);
  // POST /{listId}/duplicate: the three flags.
  const duplicate = bodyOf('/api/v1/shopping/{listId}/duplicate', 'post').properties;
  for (const flag of ['resetChecked', 'keepQuantities', 'keepNotes']) assert.deepEqual(duplicate[flag], { type: 'boolean' }, flag);
  // PATCH /{listId}/items/reorder: item ids as integers from 1.
  const reorder = bodyOf('/api/v1/shopping/{listId}/items/reorder', 'patch');
  assert.deepEqual([reorder.properties.order.type, reorder.properties.order.minItems, reorder.properties.order.items], ['array', 1, ROW_ID]);
  assert.deepEqual(reorder.required, ['order']);

  // Documents: the storage settings.
  const config = schemas.DocumentStorageConfigRequest.properties;
  assert.deepEqual([config.selected_upload_backend.type, config.selected_upload_backend.enum], ['string', ['local', 'webdav', 'google_drive']]);
  assert.equal(config.confirm_existing_access.type, 'boolean');
  assert.equal(config.clear_password.type, 'boolean');
  // Folders: the parent, the deletion's query.
  assert.deepEqual(schemas.BodyRowId.anyOf, [ROW_ID, { type: 'string', pattern: '^0*[1-9][0-9]*$' }]);
  for (const [path, method] of [['/api/v1/documents/folders', 'post'], ['/api/v1/documents/folders/{id}', 'put']]) {
    assert.deepEqual(bodyOf(path, method).properties.parent_id.anyOf, ROW_ID_OR_NULL, `${method} ${path} parent_id`);
  }
  const folderDelete = '/api/v1/documents/folders/{id}';
  assert.deepEqual(queryOf(folderDelete, 'delete', 'documents').enum, ['unfile', 'delete']);
  for (const name of ['expected_documents', 'expected_folders']) {
    assert.deepEqual(queryOf(folderDelete, 'delete', name), { type: 'integer', minimum: 0 }, name);
  }
  assert.deepEqual(queryOf(folderDelete, 'delete', 'expected_snapshot'), { type: 'string', pattern: '^[a-f0-9]{64}$' });
  // GET /documents: the filters.
  assert.deepEqual(queryOf('/api/v1/documents', 'get', 'status').enum, STATUSES);
  assert.deepEqual(queryOf('/api/v1/documents', 'get', 'category').enum, CATEGORIES);
  assert.deepEqual(queryOf('/api/v1/documents', 'get', 'folder_id'), ROW_ID);
  assert.deepEqual(queryOf('/api/v1/documents', 'get', 'expiring'), { type: 'integer', minimum: 0 });
  assert.deepEqual(queryOf('/api/v1/documents', 'get', 'subject_user_id'), ROW_ID);
  // POST and PUT /documents: the lists and the ids.
  for (const [path, method] of [['/api/v1/documents', 'post'], ['/api/v1/documents/{id}', 'put']]) {
    const props = bodyOf(path, method).properties;
    assert.deepEqual([props.category.type, props.category.enum], ['string', CATEGORIES], `${method} category`);
    assert.deepEqual([props.visibility.type, props.visibility.enum], ['string', VISIBILITIES], `${method} visibility`);
    assert.deepEqual(props.folder_id.anyOf, ROW_ID_OR_NULL, `${method} folder_id`);
    assert.deepEqual(props.subject_user_id.anyOf, ROW_ID_OR_NULL, `${method} subject_user_id`);
  }
  assert.deepEqual(bodyOf('/api/v1/documents/{id}', 'put').properties.status.enum, STATUSES);

  // DMS: the provider and the lists of a link.
  assert.deepEqual([schemas.DmsAccountCreateRequest.properties.provider.type, schemas.DmsAccountCreateRequest.properties.provider.enum], ['string', ['paperless', 'papra']]);
  assert.deepEqual(schemas.DmsLinkRequest.properties.category.enum, CATEGORIES);
  assert.deepEqual(schemas.DmsLinkRequest.properties.visibility.enum, VISIBILITIES);
});

test('the categories a document may carry are the ones the options offer', async () => {
  const r = await call('GET', '/documents/meta/options');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.categories, [...fields.DOCUMENT_CATEGORIES]);
  assert.deepEqual(r.body.data.visibilities, [...fields.DOCUMENT_VISIBILITIES]);
  assert.deepEqual(r.body.data.statuses, [...fields.DOCUMENT_STATUSES]);
});
