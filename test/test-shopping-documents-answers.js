/**
 * Test: the answers of the shopping list, documents, Google Drive storage and
 *       the DMS stay byte-equal (#2810, phase 2 section E, group 8, step b)
 * Purpose: server/routes/shopping.js (28 routes), documents.js (17),
 *          document-storage-google-drive.js (4) and dms.js (8) dropped the
 *          hand checks the schema of their operation already covers
 *          (`validateRequest()` runs before every handler since #2867) and
 *          the try/catch blocks that answered an unexpected error with a 500
 *          of their own. This suite holds that refactor: for a table of
 *          requests to all 57 operations - valid, every refusal of the handler
 *          that stays (empty or too long after trimming, a category, shop or
 *          list that does not exist, the last category, the folder cycle and
 *          depth, visibility and the owner, non-members, the storage
 *          configuration, `dms_field_required`/`dms_url_invalid`, the upload
 *          checks, path ids `0`, `-1`, `-0` and with a leading zero), every
 *          input a dropped hand check refused (now the schema's 400), not
 *          found and rights - for an admin, a member, a member without the
 *          meal-plan write right and one without the pantry read right, it
 *          pins status and the WHOLE body (a file: its type, disposition and
 *          bytes; a redirect: its target). The expectations were written
 *          before the refactor (5904145cc) and are literal values in
 *          test/shopping-documents-answers-expected.js (a module of its own
 *          only for the line limit), no fixture file, no update mode. The DMS
 *          is a stub adapter (`_setAdapterFactory`), Google Drive a stub
 *          client (`__setGoogleApiFactoryForTests`, as in
 *          test/test-google-drive-storage.js), the mail a stub service
 *          (`app.locals.emailService`); no network. SQLite stamps rows with
 *          its own clock, which mock.timers does not reach: test triggers pin
 *          `created_at` and `purchased_at`, `updated_at` and `last_check` are
 *          masked. The clock stands still (`mock.timers`, 18.11.2026 12:00
 *          UTC), the household lives in Europe/Berlin.
 *
 *          The second part: an unexpected error in every route that answered
 *          its own 500 reaches the central error handler - 500 with its fixed
 *          sentence and its log line `Unhandled error: <METHOD> <pattern> ->
 *          500` - and the process keeps answering. The five shop and price
 *          routes said `Internal error` before (the visible change of this
 *          PR); async handlers (a rejected promise) included.
 *
 *          The third part: what stays the route's own - the storage 400/409/
 *          502, the DMS 502 of search, thumbnail, link and push, the `UNIQUE`
 *          409s, the deletion lock - keeps its answer and never reaches the
 *          central handler; the clean-up of a staged upload and the release of
 *          a deletion lock still run when the error is passed on.
 *
 *          The fourth part: each handler alone (without `validateRequest()`)
 *          keeps the type checks in front of a loop, a string method or a
 *          number it binds as an id or price (sink, not route).
 * Run: npm run test:shopping-documents-answers
 */

import { tempDir } from './tmp-dir.js';

process.env.SESSION_SECRET = 'shopping-documents-answers-secret';
process.env.DB_PATH = ':memory:';
// Removed at process exit (test/tmp-dir.js).
process.env.MODULES_DIR = tempDir('yuvomi-shopping-documents-answers-');
for (const key of ['DOCUMENT_STORAGE_LOCAL_PATH', 'WEBDAV_URL', 'WEBDAV_USERNAME', 'WEBDAV_PASSWORD', 'WEBDAV_PATH', 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'BASE_URL']) delete process.env[key];
process.env.GOOGLE_CLIENT_ID = 'drive-client';
process.env.GOOGLE_CLIENT_SECRET = 'drive-secret';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://example.test/api/v1/documents/storage/google-drive/callback';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import rateLimit from 'express-rate-limit';
import { createShoppingDocumentsApp } from './shopping-documents-app.js';
import { EXPECTED } from './shopping-documents-answers-expected.js';

const dbmod = await import('../server/db.js');
const { MAX_TITLE, MAX_TEXT, MAX_SHORT } = await import('../server/api/formats.ts');
const driveStorage = await import('../server/services/google-drive-storage.js');
const { _setAdapterFactory } = await import('../server/routes/dms.js');
const { _setDmsAdapterFactory, _setStageUploadForTest } = await import('../server/routes/documents.js');
const { StorageError, stageDocumentUpload } = await import('../server/services/document-storage.js');
const { __test: shoppingInternals } = await import('../server/routes/shopping.js');
const deletionLock = await import('../server/services/document-deletion-lock.js');
const database = () => dbmod.get();

database().prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

// SQLite stamps rows with its own clock, which mock.timers does not reach.
const STAMP = '2026-11-18T12:00:00Z';
for (const { name } of database().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'shopping%' OR name LIKE 'family_document%' OR name = 'dms_accounts' OR name = 'reminders')").all()) {
  const columns = database().prepare(`PRAGMA table_info(${name})`).all().map((/** @type {any} */ c) => c.name);
  for (const column of ['created_at', 'purchased_at']) {
    if (!columns.includes(column)) continue;
    database().exec(`CREATE TRIGGER test_pin_${name}_${column} AFTER INSERT ON ${name} FOR EACH ROW BEGIN UPDATE ${name} SET ${column} = '${STAMP}' WHERE rowid = NEW.rowid; END;`);
  }
}

// The default categories come from a migration, stamped when it ran.
database().prepare('UPDATE shopping_categories SET created_at = ?').run(STAMP);

/** @param {string} username @param {string} role @param {string} [familyRole] */
function user(username, role, familyRole = 'parent') {
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, 'x', ?, ?)")
    .run(username, username, role, familyRole).lastInsertRowid);
}
const ADMIN = user('linda', 'admin');
const MEM = user('tom', 'member');
const NOMEALS = user('ole', 'member');
const NOPANTRY = user('ida', 'member');
const GUEST = user('gast', 'member', 'other');
// A split-expense guest: a users row that is no household member.
const GROUP = Number(database().prepare("INSERT INTO expense_groups (name, created_by) VALUES ('WG', ?)").run(ADMIN).lastInsertRowid);
database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)').run(GUEST, GROUP, ADMIN);
database().prepare("INSERT INTO contacts (name, category, email, family_user_id) VALUES ('Tom', 'misc', 'tom@example.org', ?)").run(MEM);

// Kitchen data the imports read.
const MEAL = Number(database().prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-11-19', 'dinner', 'Pasta', ?)").run(ADMIN).lastInsertRowid);
database().prepare("INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, 'Nudeln', '500 g', 'Sonstiges'), (?, 'Tomaten', '4', 'Obst & Gemüse')").run(MEAL, MEAL);
const PANTRY_ITEM = Number(database().prepare("INSERT INTO pantry_items (name, quantity, unit, category, created_by) VALUES ('Milch', 0, 'l', 'Milchprodukte', ?)").run(ADMIN).lastInsertRowid);
const PANTRY_PRODUCT = Number(database().prepare("INSERT INTO pantry_products (name, unit, category, created_by) VALUES ('Reis', 'kg', 'Sonstiges', ?)").run(ADMIN).lastInsertRowid);

/** @type {Record<string, { id: number, role: string, access?: Record<string, string> }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
  nomeals: { id: NOMEALS, role: 'member', access: { meals: 'read' } },
  nopantry: { id: NOPANTRY, role: 'member', access: { pantry: 'none' } },
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createShoppingDocumentsApp({
  log,
  jsonLimit: '10mb',
  // A generous limiter in front of the routes, as the app has one.
  before: [['/api', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  // requireAuth, reduced to the fields these routes read.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.authScopes = null;
    req.session = { userId: actor.id, role: actor.role, googleDriveOAuthState: 'state-1' };
    req.sessionModuleAccess = actor.access ?? null;
    // An unexpected error: the first answer of the handler throws.
    if (req.get('x-fail') === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end', 'setHeader', 'redirect']) {
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

/** The mail service of the send route: configured or not, it never sends. */
const mail = { configured: true, sent: /** @type {unknown[]} */ ([]) };
app.locals.emailService = {
  isConfigured: () => mail.configured,
  sendMail: async (/** @type {{ to: string, subject: string }} */ message) => { mail.sent.push({ to: message.to, subject: message.subject }); },
};

/** The send route allows 10 requests a minute; the table sends more. */
function resetSendLimiter() {
  for (const key of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    try { shoppingInternals.sendListLimiter.resetKey(key); } catch { /* key unknown */ }
  }
}

const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => server.close());

// ── The DMS stub ─────────────────────────────────────────────────────────────
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** What the stub adapter does: `ok`, or a failure per method. */
const dms = { mode: 'ok' };
const notFound = () => Object.assign(new Error('not found'), { status: 404 });
function dmsAdapter() {
  return {
    async testConnection() {
      if (dms.mode === 'reject') throw new Error('the DMS went away');
      return { ok: true, status: 200 };
    },
    async search(/** @type {string} */ q) {
      if (dms.mode === 'reject') throw new Error('the DMS went away');
      return [{ id: '7', title: `Rechnung ${q}`.trim(), created: STAMP, filename: 'rechnung.pdf', url: 'https://dms.example.org/documents/7/' }];
    },
    async getDocument(/** @type {string} */ id) {
      if (dms.mode === 'reject') throw new Error('the DMS went away');
      if (dms.mode === 'missing') throw notFound();
      return { title: `DMS ${id}`, filename: `dms-${id}.pdf`, url: `https://dms.example.org/documents/${id}/`, correspondent: 'Stadtwerke', tags: ['strom'] };
    },
    async fetchThumbnail() {
      if (dms.mode === 'reject') throw new Error('the DMS went away');
      if (dms.mode === 'missing') throw notFound();
      if (dms.mode === 'svg') return { buffer: Buffer.from('<svg/>'), mime: 'image/svg+xml' };
      return { buffer: PNG, mime: 'image/png' };
    },
    async fetchContent() {
      return { buffer: Buffer.from('%PDF-1.4 dms'), mime: 'application/pdf' };
    },
    async upload() {
      if (dms.mode === 'reject') throw new Error('the DMS went away');
      return { taskId: 'task-1' };
    },
  };
}
const noThumbnails = () => { const adapter = dmsAdapter(); return { ...adapter, fetchThumbnail: undefined }; };
_setAdapterFactory(() => (dms.mode === 'nothumb' ? noThumbnails() : dmsAdapter()));
_setDmsAdapterFactory(() => (dms.mode === 'nothumb' ? noThumbnails() : dmsAdapter()));
test.after(() => { _setAdapterFactory(null); _setDmsAdapterFactory(null); });

// ── The Google Drive stub ────────────────────────────────────────────────────
const drive = { failFiles: false };
class OAuthClient {
  generateAuthUrl() { return 'https://accounts.example.test/auth'; }
  async getToken() { return { tokens: { access_token: 'drive-access', refresh_token: 'drive-refresh', expiry_date: 2_000_000_000_000 } }; }
  setCredentials() {}
  on() {}
}
/** @type {Map<string, Buffer>} */
const driveContent = new Map();
const driveFiles = {
  async list() { return { data: { files: [{ id: 'folder-1', name: 'Yuvomi' }] } }; },
  async create(/** @type {any} */ { media }) {
    if (drive.failFiles) throw Object.assign(new Error('quota'), { code: 403 });
    const chunks = [];
    for await (const chunk of media?.body ?? []) chunks.push(Buffer.from(chunk));
    const id = `file-${driveContent.size + 1}`;
    driveContent.set(id, Buffer.concat(chunks));
    return { data: { id } };
  },
  async get(/** @type {any} */ { fileId, alt }) {
    if (fileId === 'folder-1') return { data: { id: 'folder-1', mimeType: 'application/vnd.google-apps.folder', trashed: false } };
    const content = driveContent.get(fileId) ?? Buffer.alloc(0);
    if (alt === 'media') return { data: Readable.from([content]) };
    return { data: { id: fileId, size: String(content.length), mimeType: 'application/octet-stream' } };
  },
  async delete(/** @type {any} */ { fileId }) { driveContent.delete(fileId); return { data: {} }; },
};
driveStorage.__setGoogleApiFactoryForTests({
  createOAuth2: () => new OAuthClient(),
  createDrive: () => ({ about: { get: async () => ({ data: { user: { permissionId: 'acc-1', emailAddress: 'drive@example.test', displayName: 'Drive' } } }) }, files: driveFiles }),
});
test.after(() => driveStorage.__setGoogleApiFactoryForTests());

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');
/** A body sent as this exact text (a number JSON.stringify cannot write, such as 1e20 as written). */
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
  const res = await fetch(`${baseUrl}/api/v1${route}`, { method, headers, body: payload, redirect: 'manual' });
  const type = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  if (res.status >= 300 && res.status < 400) return { status: res.status, body: { location: res.headers.get('location') } };
  if (type.includes('application/json')) return { status: res.status, body: JSON.parse(bytes.toString('utf8')) };
  if (bytes.length === 0) return { status: res.status, body: null };
  return {
    status: res.status,
    body: {
      type,
      disposition: res.headers.get('content-disposition'),
      cache: res.headers.get('cache-control'),
      bytes: bytes.toString('base64'),
    },
  };
}

// Stamps of SQLite's own clock the triggers do not pin.
const VOLATILE = new Set(['updated_at', 'last_check']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && typeof v === 'string' && v !== STAMP) return '<volatile>';
    // The document list is ordered by `updated_at`, which SQLite's own clock
    // sets on every write: its order is that clock's, held here by id.
    if (key === 'data' && Array.isArray(v) && v.every((row) => row && typeof row === 'object' && 'mime_type' in row)) {
      return [...v].sort((a, b) => a.id - b.id);
    }
    return v;
  });
}

/** @type {Record<string, any>} */
const ids = {};
/** @type {Record<string, any>} */
const answered = {};
const lastId = (/** @type {string} */ table) => database().prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get().id;
const LONG = (/** @type {number} */ n) => 'x'.repeat(n);
const SPACES = '   ';
const TEXT_FILE = `data:text/plain;base64,${Buffer.from('hallo').toString('base64')}`;
const DOC = (/** @type {Record<string, unknown>} */ over = {}) => ({ name: 'Reisepass', original_name: 'pass.txt', content_data: TEXT_FILE, ...over });
const DMS_ACCOUNT = (/** @type {Record<string, unknown>} */ over = {}) => ({ provider: 'paperless', name: 'Paperless', base_url: 'https://dms.example.org/', api_token: 'tok', ...over });
const L = () => ids.list;
const L2 = () => ids.list2;
const I = () => ids.item;
const S = () => ids.store;
const F = (/** @type {number} */ n) => ids[`f${n}`];
const D = () => ids.doc;
const A = () => ids.account;

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a path or body that is a function is called when its row runs.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | (() => unknown)>}
 */
const STEPS = [
  // ══ SHOPPING: LISTS ════════════════════════════════════════════════════════
  ['s versions empty', 'GET', '/shopping/versions', NO_BODY],
  ['s lists empty', 'GET', '/shopping', NO_BODY],
  ['s create', 'POST', '/shopping', { name: ' Wocheneinkauf ' }],
  () => { ids.list = lastId('shopping_lists'); },
  ['s create second', 'POST', '/shopping', { name: 'Baumarkt' }, { actor: 'mem' }],
  () => { ids.list2 = lastId('shopping_lists'); },
  ['s create third', 'POST', '/shopping', { name: 'Leer' }],
  () => { ids.list3 = lastId('shopping_lists'); },
  ['s create name spaces', 'POST', '/shopping', { name: SPACES }],
  ['s create name empty', 'POST', '/shopping', { name: '' }],
  ['s create name long', 'POST', '/shopping', { name: LONG(MAX_TITLE + 1) }],
  ['s create name number', 'POST', '/shopping', { name: 5 }],
  ['s create name object', 'POST', '/shopping', { name: {} }],
  ['s create name missing', 'POST', '/shopping', {}],
  ['s create no body', 'POST', '/shopping', NO_BODY],
  ['s lists', 'GET', '/shopping', NO_BODY],
  ['s rename', 'PUT', () => `/shopping/${L2()}`, { name: ' Baumarkt 2 ' }],
  ['s rename leading zero', 'PUT', () => `/shopping/00${L2()}`, { name: 'Baumarkt' }],
  ['s rename zero', 'PUT', '/shopping/0', { name: 'X' }],
  ['s rename minus', 'PUT', '/shopping/-1', { name: 'X' }],
  ['s rename minus zero', 'PUT', '/shopping/-0', { name: 'X' }],
  ['s rename gone', 'PUT', '/shopping/987654', { name: 'X' }],
  ['s rename letters', 'PUT', '/shopping/abc', { name: 'X' }],
  ['s rename fraction', 'PUT', '/shopping/1.0', { name: 'X' }],
  ['s rename name spaces', 'PUT', () => `/shopping/${L2()}`, { name: SPACES }],
  ['s rename name number', 'PUT', () => `/shopping/${L2()}`, { name: 5 }],
  ['s rename name missing', 'PUT', () => `/shopping/${L2()}`, {}],
  // ══ SHOPPING: CATEGORIES ═══════════════════════════════════════════════════
  ['cat list', 'GET', '/shopping/categories', NO_BODY],
  ['cat create', 'POST', '/shopping/categories', { name: ' Bio ' }],
  () => { ids.cat = lastId('shopping_categories'); },
  ['cat create second', 'POST', '/shopping/categories', { name: 'Garten' }],
  () => { ids.cat2 = lastId('shopping_categories'); },
  ['cat create duplicate', 'POST', '/shopping/categories', { name: 'bio' }],
  ['cat create name spaces', 'POST', '/shopping/categories', { name: SPACES }],
  ['cat create name long', 'POST', '/shopping/categories', { name: LONG(MAX_SHORT + 1) }],
  ['cat create name number', 'POST', '/shopping/categories', { name: 5 }],
  ['cat create name missing', 'POST', '/shopping/categories', {}],
  ['cat rename', 'PUT', () => `/shopping/categories/${ids.cat}`, { name: 'Bioladen' }],
  ['cat rename leading zero', 'PUT', () => `/shopping/categories/0${ids.cat}`, { name: 'Bio' }],
  ['cat rename zero', 'PUT', '/shopping/categories/0', { name: 'X' }],
  ['cat rename minus', 'PUT', '/shopping/categories/-1', { name: 'X' }],
  ['cat rename minus zero', 'PUT', '/shopping/categories/-0', { name: 'X' }],
  ['cat rename gone', 'PUT', '/shopping/categories/987654', { name: 'X' }],
  ['cat rename letters', 'PUT', '/shopping/categories/abc', { name: 'X' }],
  ['cat rename duplicate', 'PUT', () => `/shopping/categories/${ids.cat}`, { name: 'BACKWAREN' }],
  ['cat rename spaces', 'PUT', () => `/shopping/categories/${ids.cat}`, { name: SPACES }],
  ['cat rename number', 'PUT', () => `/shopping/categories/${ids.cat}`, { name: 5 }],
  ['cat reorder', 'PATCH', '/shopping/categories/reorder', () => ({ order: [9, 1, 2, 3, 4, 5, 6, 7, 8, ids.cat, String(ids.cat2)] })],
  ['cat reorder unknown id', 'PATCH', '/shopping/categories/reorder', { order: [987654] }],
  ['cat reorder empty', 'PATCH', '/shopping/categories/reorder', { order: [] }],
  ['cat reorder text', 'PATCH', '/shopping/categories/reorder', { order: 'x' }],
  ['cat reorder object entry', 'PATCH', '/shopping/categories/reorder', { order: [{}] }],
  ['cat reorder fraction entry', 'PATCH', '/shopping/categories/reorder', { order: [1.5] }],
  ['cat reorder zero text entry', 'PATCH', '/shopping/categories/reorder', { order: ['0'] }],
  ['cat reorder missing', 'PATCH', '/shopping/categories/reorder', {}],
  ['cat delete', 'DELETE', () => `/shopping/categories/${ids.cat2}`, NO_BODY],
  ['cat delete zero', 'DELETE', '/shopping/categories/0', NO_BODY],
  ['cat delete minus zero', 'DELETE', '/shopping/categories/-0', NO_BODY],
  ['cat delete gone', 'DELETE', '/shopping/categories/987654', NO_BODY],
  ['cat delete letters', 'DELETE', '/shopping/categories/abc', NO_BODY],
  // ══ SHOPPING: ITEMS ════════════════════════════════════════════════════════
  ['i create', 'POST', () => `/shopping/${L()}/items`, { name: ' Milch ', quantity: '1 l', category: 'Milchprodukte', notes: 'fettarm', url: ' https://example.org/milch ' }],
  () => { ids.item = lastId('shopping_items'); },
  ['i create minimal', 'POST', () => `/shopping/${L()}/items`, { name: 'Brot' }],
  () => { ids.item2 = lastId('shopping_items'); },
  ['i create second dairy', 'POST', () => `/shopping/${L()}/items`, { name: 'Butter', category: 'Milchprodukte' }],
  () => { ids.item3 = lastId('shopping_items'); },
  ['i create nulls', 'POST', () => `/shopping/${L()}/items`, { name: 'Käse', quantity: null, notes: null, url: null, category: null }],
  ['i create category empty', 'POST', () => `/shopping/${L()}/items`, { name: 'Eier', category: '' }],
  ['i create leading zero list', 'POST', () => `/shopping/0${L()}/items`, { name: 'Salz' }],
  ['i create as member', 'POST', () => `/shopping/${L2()}/items`, { name: 'Schrauben', category: 'Haushalt' }, { actor: 'mem' }],
  () => { ids.item4 = lastId('shopping_items'); },
  ['i create category unknown', 'POST', () => `/shopping/${L()}/items`, { name: 'X', category: 'Fantasie' }],
  ['i create category number', 'POST', () => `/shopping/${L()}/items`, { name: 'X', category: 5 }],
  ['i create name spaces', 'POST', () => `/shopping/${L()}/items`, { name: SPACES }],
  ['i create name empty', 'POST', () => `/shopping/${L()}/items`, { name: '' }],
  ['i create name long', 'POST', () => `/shopping/${L()}/items`, { name: LONG(MAX_TITLE + 1) }],
  ['i create name number', 'POST', () => `/shopping/${L()}/items`, { name: 5 }],
  ['i create name object', 'POST', () => `/shopping/${L()}/items`, { name: {} }],
  ['i create name null', 'POST', () => `/shopping/${L()}/items`, { name: null }],
  ['i create name missing', 'POST', () => `/shopping/${L()}/items`, { quantity: '1' }],
  ['i create quantity number', 'POST', () => `/shopping/${L()}/items`, { name: 'X', quantity: 5 }],
  ['i create quantity long', 'POST', () => `/shopping/${L()}/items`, { name: 'X', quantity: LONG(MAX_SHORT + 1) }],
  ['i create notes number', 'POST', () => `/shopping/${L()}/items`, { name: 'X', notes: 5 }],
  ['i create notes list', 'POST', () => `/shopping/${L()}/items`, { name: 'X', notes: [] }],
  ['i create notes long', 'POST', () => `/shopping/${L()}/items`, { name: 'X', notes: LONG(MAX_TEXT + 1) }],
  ['i create url script', 'POST', () => `/shopping/${L()}/items`, { name: 'X', url: 'javascript:alert(1)' }],
  ['i create url broken', 'POST', () => `/shopping/${L()}/items`, { name: 'X', url: 'not a url' }],
  ['i create url number', 'POST', () => `/shopping/${L()}/items`, { name: 'X', url: 5 }],
  ['i create two errors', 'POST', () => `/shopping/${L()}/items`, { name: SPACES, url: 'ftp://x' }],
  ['i create list gone', 'POST', '/shopping/987654/items', { name: 'X' }],
  ['i create list zero', 'POST', '/shopping/0/items', { name: 'X' }],
  ['i create list minus', 'POST', '/shopping/-1/items', { name: 'X' }],
  ['i create list letters', 'POST', '/shopping/abc/items', { name: 'X' }],
  ['i create no body', 'POST', () => `/shopping/${L()}/items`, NO_BODY],
  ['i list', 'GET', () => `/shopping/${L()}/items`, NO_BODY],
  ['i list leading zero', 'GET', () => `/shopping/00${L2()}/items`, NO_BODY],
  ['i list zero', 'GET', '/shopping/0/items', NO_BODY],
  ['i list minus zero', 'GET', '/shopping/-0/items', NO_BODY],
  ['i list gone', 'GET', '/shopping/987654/items', NO_BODY],
  ['i list letters', 'GET', '/shopping/abc/items', NO_BODY],
  // PATCH /items/{itemId}
  ['i tick true', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: true }],
  ['i tick 0', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: 0 }],
  ['i tick 1 price', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: 1, price_cents: 199 }],
  ['i tick false', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: false }],
  ['i tick text', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: 'true' }],
  ['i tick null', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: null }],
  ['i tick 2', 'PATCH', () => `/shopping/items/${I()}`, { is_checked: 2 }],
  ['i patch name', 'PATCH', () => `/shopping/items/${I()}`, { name: ' Vollmilch ' }],
  ['i patch name spaces', 'PATCH', () => `/shopping/items/${I()}`, { name: SPACES }],
  ['i patch name empty', 'PATCH', () => `/shopping/items/${I()}`, { name: '' }],
  ['i patch name long', 'PATCH', () => `/shopping/items/${I()}`, { name: LONG(MAX_TITLE + 1) }],
  ['i patch name number', 'PATCH', () => `/shopping/items/${I()}`, { name: 5 }],
  ['i patch name null', 'PATCH', () => `/shopping/items/${I()}`, { name: null }],
  ['i patch quantity', 'PATCH', () => `/shopping/items/${I()}`, { quantity: '2 l' }],
  ['i patch quantity null', 'PATCH', () => `/shopping/items/${I()}`, { quantity: null }],
  ['i patch quantity number', 'PATCH', () => `/shopping/items/${I()}`, { quantity: 5 }],
  ['i patch quantity long', 'PATCH', () => `/shopping/items/${I()}`, { quantity: LONG(MAX_SHORT + 1) }],
  ['i patch category', 'PATCH', () => `/shopping/items/${I()}`, { category: 'Sonstiges' }],
  ['i patch category unknown', 'PATCH', () => `/shopping/items/${I()}`, { category: 'Fantasie' }],
  ['i patch category number', 'PATCH', () => `/shopping/items/${I()}`, { category: 5 }],
  ['i patch category null', 'PATCH', () => `/shopping/items/${I()}`, { category: null }],
  ['i patch category empty', 'PATCH', () => `/shopping/items/${I()}`, { category: '' }],
  ['i patch notes number', 'PATCH', () => `/shopping/items/${I()}`, { notes: 5 }],
  ['i patch notes long', 'PATCH', () => `/shopping/items/${I()}`, { notes: LONG(MAX_TEXT + 1) }],
  ['i patch notes null', 'PATCH', () => `/shopping/items/${I()}`, { notes: null }],
  ['i patch url script', 'PATCH', () => `/shopping/items/${I()}`, { url: 'javascript:alert(1)' }],
  ['i patch url empty', 'PATCH', () => `/shopping/items/${I()}`, { url: '' }],
  ['i patch price', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: 249 }],
  ['i patch price null', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: null }],
  ['i patch price text', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: '12' }],
  ['i patch price empty', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: '' }],
  ['i patch price negative', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: -1 }],
  ['i patch price fraction', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: 1.5 }],
  ['i patch price above', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: 100_000_001 }],
  ['i patch price top', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: 100_000_000 }],
  ['i patch price bool', 'PATCH', () => `/shopping/items/${I()}`, { price_cents: true }],
  // Shops
  ['st list empty', 'GET', '/shopping/stores', NO_BODY],
  ['st create', 'POST', '/shopping/stores', { name: ' REWE ' }],
  () => { ids.store = lastId('shopping_stores'); },
  ['st create existing', 'POST', '/shopping/stores', { name: 'rewe' }],
  ['st create second', 'POST', '/shopping/stores', { name: 'Aldi' }, { actor: 'mem' }],
  () => { ids.store2 = lastId('shopping_stores'); },
  ['st create spaces', 'POST', '/shopping/stores', { name: SPACES }],
  ['st create long', 'POST', '/shopping/stores', { name: LONG(MAX_SHORT + 1) }],
  ['st create number', 'POST', '/shopping/stores', { name: 5 }],
  ['st create missing', 'POST', '/shopping/stores', {}],
  ['st rename', 'PUT', () => `/shopping/stores/${S()}`, { name: 'REWE City' }],
  ['st rename leading zero', 'PUT', () => `/shopping/stores/0${S()}`, { name: 'REWE' }],
  ['st rename zero', 'PUT', '/shopping/stores/0', { name: 'X' }],
  ['st rename minus zero', 'PUT', '/shopping/stores/-0', { name: 'X' }],
  ['st rename minus', 'PUT', '/shopping/stores/-1', { name: 'X' }],
  ['st rename gone', 'PUT', '/shopping/stores/987654', { name: 'X' }],
  ['st rename letters', 'PUT', '/shopping/stores/abc', { name: 'X' }],
  ['st rename collision', 'PUT', () => `/shopping/stores/${S()}`, { name: 'ALDI' }],
  ['st rename spaces', 'PUT', () => `/shopping/stores/${S()}`, { name: SPACES }],
  ['st rename number', 'PUT', () => `/shopping/stores/${S()}`, { name: 5 }],
  ['st list', 'GET', '/shopping/stores', NO_BODY],
  ['i patch store', 'PATCH', () => `/shopping/items/${I()}`, () => ({ store_id: S(), price_cents: 299, is_checked: true })],
  ['i patch store text', 'PATCH', () => `/shopping/items/${I()}`, () => ({ store_id: String(S()) })],
  ['i patch store leading zero', 'PATCH', () => `/shopping/items/${I()}`, () => ({ store_id: `0${S()}` })],
  ['i patch store unknown', 'PATCH', () => `/shopping/items/${I()}`, { store_id: 987654 }],
  ['i patch store huge', 'PATCH', () => `/shopping/items/${I()}`, new Raw('{"store_id":100000000000000000000}')],
  ['i patch store huge text', 'PATCH', () => `/shopping/items/${I()}`, { store_id: '100000000000000000000' }],
  ['i patch store bool', 'PATCH', () => `/shopping/items/${I()}`, { store_id: true }],
  ['i patch store zero', 'PATCH', () => `/shopping/items/${I()}`, { store_id: 0 }],
  ['i patch store empty', 'PATCH', () => `/shopping/items/${I()}`, { store_id: '' }],
  ['i patch store again', 'PATCH', () => `/shopping/items/${I()}`, () => ({ store_id: S() })],
  ['i patch list unknown', 'PATCH', () => `/shopping/items/${I()}`, { list_id: 987654 }],
  ['i patch list huge', 'PATCH', () => `/shopping/items/${I()}`, new Raw('{"list_id":100000000000000000000}')],
  ['i patch list leading zero', 'PATCH', () => `/shopping/items/${I()}`, () => ({ list_id: `0${L2()}` })],
  ['i patch list same', 'PATCH', () => `/shopping/items/${I()}`, () => ({ list_id: L() })],
  ['i patch list null', 'PATCH', () => `/shopping/items/${I()}`, { list_id: null }],
  ['i patch item zero', 'PATCH', '/shopping/items/0', { is_checked: true }],
  ['i patch item minus', 'PATCH', '/shopping/items/-1', { is_checked: true }],
  ['i patch item minus zero', 'PATCH', '/shopping/items/-0', { is_checked: true }],
  ['i patch item gone', 'PATCH', '/shopping/items/987654', { is_checked: true }],
  ['i patch item letters', 'PATCH', '/shopping/items/abc', { is_checked: true }],
  ['i patch item leading zero', 'PATCH', () => `/shopping/items/00${ids.item2}`, { quantity: '1' }],
  ['i patch empty body', 'PATCH', () => `/shopping/items/${ids.item2}`, {}],
  ['i move', 'PATCH', () => `/shopping/items/${ids.item2}`, () => ({ list_id: String(L2()) })],
  ['i move back', 'PATCH', () => `/shopping/items/${ids.item2}`, () => ({ list_id: L() })],
  // Price history
  ['ph name', 'GET', '/shopping/price-history?name=vollmilch', NO_BODY],
  ['ph exclude', 'GET', () => `/shopping/price-history?name=Vollmilch&exclude_item_id=${I()}`, NO_BODY],
  ['ph exclude other', 'GET', '/shopping/price-history?name=Vollmilch&exclude_item_id=987654', NO_BODY],
  ['ph exclude leading zero', 'GET', () => `/shopping/price-history?name=Vollmilch&exclude_item_id=0${I()}`, NO_BODY],
  ['ph exclude letters', 'GET', '/shopping/price-history?name=Vollmilch&exclude_item_id=abc', NO_BODY],
  ['ph exclude empty', 'GET', '/shopping/price-history?name=Vollmilch&exclude_item_id=', NO_BODY],
  ['ph exclude zero', 'GET', '/shopping/price-history?name=Vollmilch&exclude_item_id=0', NO_BODY],
  ['ph limit', 'GET', '/shopping/price-history?name=Vollmilch&limit=1', NO_BODY],
  ['ph limit top', 'GET', '/shopping/price-history?name=Vollmilch&limit=50', NO_BODY],
  ['ph limit zero', 'GET', '/shopping/price-history?name=Vollmilch&limit=0', NO_BODY],
  ['ph limit above', 'GET', '/shopping/price-history?name=Vollmilch&limit=51', NO_BODY],
  ['ph limit letters', 'GET', '/shopping/price-history?name=Vollmilch&limit=abc', NO_BODY],
  ['ph name spaces', 'GET', '/shopping/price-history?name=%20%20', NO_BODY],
  ['ph name missing', 'GET', '/shopping/price-history', NO_BODY],
  ['ph name twice', 'GET', '/shopping/price-history?name=a&name=b', NO_BODY],
  // Suggestions, recipients, versions
  ['sug prefix', 'GET', '/shopping/suggestions?q=Vo', NO_BODY],
  ['sug spaces', 'GET', '/shopping/suggestions?q=%20', NO_BODY],
  ['sug missing', 'GET', '/shopping/suggestions', NO_BODY],
  ['sug twice', 'GET', '/shopping/suggestions?q=a&q=b', NO_BODY],
  ['recipients', 'GET', '/shopping/send-recipients', NO_BODY],
  ['s versions', 'GET', '/shopping/versions', NO_BODY],
  // Item reorder
  ['ro reorder', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Milchprodukte', order: [ids.item3] })],
  ['ro category missing', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ order: [ids.item3] })],
  ['ro category empty', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: '', order: [ids.item3] })],
  ['ro category unknown', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Fantasie', order: [ids.item3] })],
  ['ro category number', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 5, order: [ids.item3] })],
  ['ro twice', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Milchprodukte', order: [ids.item3, ids.item3] })],
  ['ro foreign', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Milchprodukte', order: [ids.item4] })],
  ['ro subset', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Sonstiges', order: [I()] })],
  ['ro empty', 'PATCH', () => `/shopping/${L()}/items/reorder`, { category: 'Milchprodukte', order: [] }],
  ['ro text', 'PATCH', () => `/shopping/${L()}/items/reorder`, { category: 'Milchprodukte', order: 'x' }],
  ['ro text entry', 'PATCH', () => `/shopping/${L()}/items/reorder`, () => ({ category: 'Milchprodukte', order: [String(ids.item3)] })],
  ['ro fraction entry', 'PATCH', () => `/shopping/${L()}/items/reorder`, { category: 'Milchprodukte', order: [1.5] }],
  ['ro null entry', 'PATCH', () => `/shopping/${L()}/items/reorder`, { category: 'Milchprodukte', order: [null] }],
  ['ro order missing', 'PATCH', () => `/shopping/${L()}/items/reorder`, { category: 'Milchprodukte' }],
  ['ro list gone', 'PATCH', '/shopping/987654/items/reorder', { category: 'Milchprodukte', order: [1] }],
  ['ro list zero', 'PATCH', '/shopping/0/items/reorder', { category: 'Milchprodukte', order: [1] }],
  // Duplicate
  ['dup', 'POST', () => `/shopping/${L()}/duplicate`, { name: 'Kopie' }],
  ['dup flags', 'POST', () => `/shopping/${L()}/duplicate`, { name: 'Kopie 2', resetChecked: false, keepQuantities: false, keepNotes: false }],
  ['dup flag text', 'POST', () => `/shopping/${L()}/duplicate`, { name: 'X', resetChecked: 'false' }],
  ['dup flag number', 'POST', () => `/shopping/${L()}/duplicate`, { name: 'X', keepNotes: 1 }],
  ['dup flag null', 'POST', () => `/shopping/${L()}/duplicate`, { name: 'X', keepQuantities: null }],
  ['dup name spaces', 'POST', () => `/shopping/${L()}/duplicate`, { name: SPACES }],
  ['dup name number', 'POST', () => `/shopping/${L()}/duplicate`, { name: 5 }],
  ['dup no body', 'POST', () => `/shopping/${L()}/duplicate`, NO_BODY],
  ['dup list gone', 'POST', '/shopping/987654/duplicate', { name: 'X' }],
  ['dup list zero', 'POST', '/shopping/0/duplicate', { name: 'X' }],
  // Send
  ['send', 'POST', () => `/shopping/${L()}/send`, { userId: MEM }],
  ['send no address', 'POST', () => `/shopping/${L()}/send`, { userId: ADMIN }],
  ['send guest', 'POST', () => `/shopping/${L()}/send`, { userId: GUEST }],
  ['send unknown', 'POST', () => `/shopping/${L()}/send`, { userId: 987654 }],
  ['send empty list', 'POST', () => `/shopping/${ids.list3}/send`, { userId: MEM }],
  ['send zero', 'POST', () => `/shopping/${L()}/send`, { userId: 0 }],
  ['send text', 'POST', () => `/shopping/${L()}/send`, { userId: String(MEM) }],
  ['send bool', 'POST', () => `/shopping/${L()}/send`, { userId: true }],
  ['send missing', 'POST', () => `/shopping/${L()}/send`, {}],
  ['send list gone', 'POST', '/shopping/987654/send', { userId: MEM }],
  () => { mail.configured = false; resetSendLimiter(); },
  ['send unconfigured', 'POST', () => `/shopping/${L()}/send`, { userId: MEM }],
  () => { mail.configured = true; },
  // Kitchen imports
  ['imp meal preview', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-16', to: '2026-11-22', preview: true }],
  ['imp meal', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-16', to: '2026-11-22' }],
  () => { answered.mealImport = database().prepare('SELECT id FROM meal_ingredients WHERE meal_id = ? ORDER BY id').all(MEAL).map((/** @type {any} */ r) => r.id); },
  ['imp meal again', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-16', to: '2026-11-22' }],
  ['imp meal nothing', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2027-01-01', to: '2027-01-02' }],
  ['imp meal reversed', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-22', to: '2026-11-16' }],
  ['imp meal day gone', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-02-30', to: '2026-03-02' }],
  ['imp meal form', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '16.11.2026', to: '2026-11-22' }],
  ['imp meal number', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: 5, to: '2026-11-22' }],
  ['imp meal to missing', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-16' }],
  ['imp meal preview text', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: '2026-11-16', to: '2026-11-22', preview: 'true' }],
  ['imp meal no meals right', 'POST', () => `/shopping/${L()}/import-meal-plan`, { from: 'x' }, { actor: 'nomeals' }],
  ['imp meal list gone', 'POST', '/shopping/987654/import-meal-plan', { from: '2026-11-16', to: '2026-11-22' }],
  ['imp meal list gone no right', 'POST', '/shopping/987654/import-meal-plan', {}, { actor: 'nomeals' }],
  ['imp pantry', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [{ pantry_item_id: PANTRY_ITEM, quantity: '2 l' }, { pantry_product_id: PANTRY_PRODUCT }, { pantry_item_id: 987654 }] }],
  ['imp pantry again', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [{ pantry_item_id: PANTRY_ITEM }] }],
  ['imp pantry text ids', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [{ pantry_item_id: String(PANTRY_ITEM) }] }],
  ['imp pantry empty', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [] }],
  ['imp pantry text', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: 'abc' }],
  ['imp pantry number entry', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [5] }],
  ['imp pantry empty entry', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [{}] }],
  ['imp pantry quantity number', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: [{ pantry_item_id: PANTRY_ITEM, quantity: 5 }] }],
  ['imp pantry missing', 'POST', () => `/shopping/${L2()}/import-pantry`, {}],
  ['imp pantry no right', 'POST', () => `/shopping/${L2()}/import-pantry`, { items: 'abc' }, { actor: 'nopantry' }],
  ['imp pantry list gone', 'POST', '/shopping/987654/import-pantry', { items: [] }],
  // Undo a transfer
  ['undo empty', 'POST', '/shopping/items/undo-transfer', {}],
  ['undo empty lists', 'POST', '/shopping/items/undo-transfer', { ids: [], ingredient_ids: [] }],
  ['undo text entry', 'POST', '/shopping/items/undo-transfer', { ids: ['x'] }],
  ['undo object entry', 'POST', '/shopping/items/undo-transfer', { ids: [{}] }],
  ['undo zero entry', 'POST', '/shopping/items/undo-transfer', { ids: [0] }],
  ['undo text list', 'POST', '/shopping/items/undo-transfer', { ids: 'x' }],
  ['undo ingredients no right', 'POST', '/shopping/items/undo-transfer', () => ({ ingredient_ids: answered.mealImport }), { actor: 'nomeals' }],
  ['undo meal items no right', 'POST', '/shopping/items/undo-transfer', () => ({ ids: database().prepare('SELECT id FROM shopping_items WHERE added_from_meal IS NOT NULL ORDER BY id').all().map((/** @type {any} */ r) => r.id) }), { actor: 'nomeals' }],
  ['undo meal', 'POST', '/shopping/items/undo-transfer', () => ({ ids: database().prepare('SELECT id FROM shopping_items WHERE added_from_meal IS NOT NULL ORDER BY id').all().map((/** @type {any} */ r) => r.id), ingredient_ids: answered.mealImport })],
  ['undo unknown', 'POST', '/shopping/items/undo-transfer', { ids: [987654] }],
  ['undo pantry no meals right', 'POST', '/shopping/items/undo-transfer', () => ({ ids: [lastId('shopping_items')] }), { actor: 'nomeals' }],
  // Clear ticked
  () => { database().prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(ids.item3); },
  ['chk ids', 'DELETE', () => `/shopping/${L()}/items/checked`, () => ({ ids: [ids.item3, 987654] })],
  ['chk all', 'DELETE', () => `/shopping/${L()}/items/checked`, NO_BODY],
  ['chk empty', 'DELETE', () => `/shopping/${L()}/items/checked`, { ids: [] }],
  ['chk text entry', 'DELETE', () => `/shopping/${L()}/items/checked`, { ids: ['1'] }],
  ['chk zero entry', 'DELETE', () => `/shopping/${L()}/items/checked`, { ids: [0] }],
  ['chk text list', 'DELETE', () => `/shopping/${L()}/items/checked`, { ids: 'x' }],
  ['chk list gone', 'DELETE', '/shopping/987654/items/checked', NO_BODY],
  ['chk list minus zero', 'DELETE', '/shopping/-0/items/checked', NO_BODY],
  ['chk list letters', 'DELETE', '/shopping/abc/items/checked', NO_BODY],
  ['ph after clear', 'GET', '/shopping/price-history?name=Vollmilch', NO_BODY],
  // Delete
  ['i delete', 'DELETE', () => `/shopping/items/${ids.item4}`, NO_BODY],
  ['i delete zero', 'DELETE', '/shopping/items/0', NO_BODY],
  ['i delete minus zero', 'DELETE', '/shopping/items/-0', NO_BODY],
  ['i delete gone', 'DELETE', '/shopping/items/987654', NO_BODY],
  ['i delete letters', 'DELETE', '/shopping/items/abc', NO_BODY],
  ['i delete leading zero', 'DELETE', () => `/shopping/items/0${ids.item2}`, NO_BODY],
  ['st delete', 'DELETE', () => `/shopping/stores/${ids.store2}`, NO_BODY],
  ['st delete zero', 'DELETE', '/shopping/stores/0', NO_BODY],
  ['st delete minus zero', 'DELETE', '/shopping/stores/-0', NO_BODY],
  ['st delete minus', 'DELETE', '/shopping/stores/-1', NO_BODY],
  ['st delete letters', 'DELETE', '/shopping/stores/abc', NO_BODY],
  ['s delete', 'DELETE', () => `/shopping/${ids.list3}`, NO_BODY],
  ['s delete zero', 'DELETE', '/shopping/0', NO_BODY],
  ['s delete minus zero', 'DELETE', '/shopping/-0', NO_BODY],
  ['s delete gone', 'DELETE', '/shopping/987654', NO_BODY],
  ['s delete letters', 'DELETE', '/shopping/abc', NO_BODY],
  ['s lists end', 'GET', '/shopping', NO_BODY],
  // The last category cannot go.
  () => { database().prepare("DELETE FROM shopping_categories WHERE name != 'Sonstiges'").run(); },
  ['cat delete last', 'DELETE', '/shopping/categories/9', NO_BODY],

  // ══ DOCUMENTS: OPTIONS AND STORAGE ═════════════════════════════════════════
  ['d options', 'GET', '/documents/meta/options', NO_BODY],
  ['d options member', 'GET', '/documents/meta/options', NO_BODY, { actor: 'mem' }],
  ['sc get', 'GET', '/documents/storage/config', NO_BODY],
  ['sc get member', 'GET', '/documents/storage/config', NO_BODY, { actor: 'mem' }],
  ['sc put local', 'PUT', '/documents/storage/config', { selected_upload_backend: 'local' }],
  ['sc put username', 'PUT', '/documents/storage/config', { username: ' dav ', enabled: false }],
  ['sc put backend unknown', 'PUT', '/documents/storage/config', { selected_upload_backend: 'ftp' }],
  ['sc put backend number', 'PUT', '/documents/storage/config', { selected_upload_backend: 5 }],
  ['sc put backend null', 'PUT', '/documents/storage/config', { selected_upload_backend: null }],
  ['sc put confirm text', 'PUT', '/documents/storage/config', { confirm_existing_access: 'yes' }],
  ['sc put confirm null', 'PUT', '/documents/storage/config', { confirm_existing_access: null }],
  ['sc put clear number', 'PUT', '/documents/storage/config', { clear_password: 1 }],
  ['sc put clear true', 'PUT', '/documents/storage/config', { clear_password: true }],
  ['sc put enabled text', 'PUT', '/documents/storage/config', { enabled: 'true' }],
  ['sc put password number', 'PUT', '/documents/storage/config', { password: 5 }],
  ['sc put path list', 'PUT', '/documents/storage/config', { path: [] }],
  ['sc put private url', 'PUT', '/documents/storage/config', { url: 'http://10.0.0.1/dav' }],
  ['sc put webdav unconfigured', 'PUT', '/documents/storage/config', { selected_upload_backend: 'webdav' }],
  ['sc put drive unconnected', 'PUT', '/documents/storage/config', { selected_upload_backend: 'google_drive' }],
  ['sc put member', 'PUT', '/documents/storage/config', { selected_upload_backend: 'ftp' }, { actor: 'mem' }],
  ['sc put no body', 'PUT', '/documents/storage/config', NO_BODY],
  ['sc test', 'POST', '/documents/storage/test', {}],
  ['sc test private url', 'POST', '/documents/storage/test', { url: 'http://10.0.0.1/dav', username: 'u', password: 'p' }],
  ['sc test enabled text', 'POST', '/documents/storage/test', { enabled: 'x' }],
  ['sc test member', 'POST', '/documents/storage/test', {}, { actor: 'mem' }],
  // ══ DOCUMENTS: FOLDERS ═════════════════════════════════════════════════════
  ['f list empty', 'GET', '/documents/folders', NO_BODY],
  ['f create', 'POST', '/documents/folders', { name: ' Verträge ' }],
  () => { ids.f1 = lastId('family_document_folders'); },
  ['f create child', 'POST', '/documents/folders', () => ({ name: 'Miete', parent_id: F(1) })],
  () => { ids.f2 = lastId('family_document_folders'); },
  ['f create child text', 'POST', '/documents/folders', () => ({ name: 'Strom', parent_id: String(F(2)) })],
  () => { ids.f3 = lastId('family_document_folders'); },
  ['f create child leading zero', 'POST', '/documents/folders', () => ({ name: 'Gas', parent_id: `00${F(3)}` })],
  () => { ids.f4 = lastId('family_document_folders'); },
  ['f create depth 5', 'POST', '/documents/folders', () => ({ name: 'Tief', parent_id: F(4) })],
  () => { ids.f5 = lastId('family_document_folders'); },
  ['f create too deep', 'POST', '/documents/folders', () => ({ name: 'Zu tief', parent_id: F(5) })],
  ['f create top null', 'POST', '/documents/folders', { name: 'Steuer', parent_id: null }],
  () => { ids.f6 = lastId('family_document_folders'); },
  ['f create parent gone', 'POST', '/documents/folders', { name: 'X', parent_id: 987654 }],
  ['f create parent zero', 'POST', '/documents/folders', { name: 'X', parent_id: 0 }],
  ['f create parent zero text', 'POST', '/documents/folders', { name: 'X', parent_id: '0' }],
  ['f create parent empty', 'POST', '/documents/folders', { name: 'X', parent_id: '' }],
  ['f create parent bool', 'POST', '/documents/folders', { name: 'X', parent_id: true }],
  ['f create parent fraction', 'POST', '/documents/folders', { name: 'X', parent_id: 1.5 }],
  ['f create parent letters', 'POST', '/documents/folders', { name: 'X', parent_id: 'abc' }],
  ['f create parent minus', 'POST', '/documents/folders', { name: 'X', parent_id: -1 }],
  ['f create parent list', 'POST', '/documents/folders', { name: 'X', parent_id: [1] }],
  ['f create duplicate', 'POST', '/documents/folders', { name: 'Verträge' }],
  ['f create duplicate in other parent', 'POST', '/documents/folders', () => ({ name: 'Verträge', parent_id: F(6) })],
  ['f create name spaces', 'POST', '/documents/folders', { name: SPACES }],
  ['f create name long', 'POST', '/documents/folders', { name: LONG(MAX_TITLE + 1) }],
  ['f create name number', 'POST', '/documents/folders', { name: 5 }],
  ['f create name missing', 'POST', '/documents/folders', {}],
  ['f create member', 'POST', '/documents/folders', { name: 'Schule' }, { actor: 'mem' }],
  ['f list', 'GET', '/documents/folders', NO_BODY],
  ['f rename', 'PUT', () => `/documents/folders/${F(6)}`, { name: 'Steuern' }],
  ['f rename leading zero', 'PUT', () => `/documents/folders/0${F(6)}`, { name: 'Steuern 2' }],
  ['f move top', 'PUT', () => `/documents/folders/${F(3)}`, { parent_id: null }],
  ['f move back', 'PUT', () => `/documents/folders/${F(3)}`, () => ({ parent_id: String(F(2)) })],
  ['f move self', 'PUT', () => `/documents/folders/${F(2)}`, () => ({ parent_id: F(2) })],
  ['f move descendant', 'PUT', () => `/documents/folders/${F(2)}`, () => ({ parent_id: F(4) })],
  ['f move gone parent', 'PUT', () => `/documents/folders/${F(2)}`, { parent_id: 987654 }],
  ['f move too deep', 'PUT', () => `/documents/folders/${F(6)}`, () => ({ parent_id: F(5) })],
  ['f move parent empty', 'PUT', () => `/documents/folders/${F(6)}`, { parent_id: '' }],
  ['f move parent bool', 'PUT', () => `/documents/folders/${F(6)}`, { parent_id: true }],
  ['f rename duplicate', 'PUT', () => `/documents/folders/${F(6)}`, { name: 'Verträge' }],
  ['f rename spaces', 'PUT', () => `/documents/folders/${F(6)}`, { name: SPACES }],
  ['f rename number', 'PUT', () => `/documents/folders/${F(6)}`, { name: 5 }],
  ['f put nothing', 'PUT', () => `/documents/folders/${F(6)}`, {}],
  ['f put zero', 'PUT', '/documents/folders/0', { name: 'X' }],
  ['f put minus', 'PUT', '/documents/folders/-1', { name: 'X' }],
  ['f put minus zero', 'PUT', '/documents/folders/-0', { name: 'X' }],
  ['f put gone', 'PUT', '/documents/folders/987654', { name: 'X' }],
  ['f put letters', 'PUT', '/documents/folders/abc', { name: 'X' }],
  // ══ DOCUMENTS ══════════════════════════════════════════════════════════════
  ['doc create', 'POST', '/documents', DOC({ name: ' Reisepass ', description: 'Gültig', category: 'identity', expires_at: '2027-01-10', expiry_reminder_days: 30, subject_user_id: MEM })],
  () => { ids.doc = lastId('family_documents'); },
  ['doc create restricted', 'POST', '/documents', () => DOC({ name: 'Arztbrief', visibility: 'restricted', allowed_member_ids: [MEM], folder_id: F(1) })],
  () => { ids.doc2 = lastId('family_documents'); },
  ['doc create private member', 'POST', '/documents', DOC({ name: 'Tagebuch', visibility: 'private' }), { actor: 'mem' }],
  () => { ids.doc3 = lastId('family_documents'); },
  ['doc create folder text', 'POST', '/documents', () => DOC({ name: 'Mietvertrag', folder_id: `0${F(3)}`, expiry_reminder_days: '', expires_at: '' })],
  ['doc create folder key', 'POST', '/documents', DOC({ name: 'Beleg', folder_key: 'budget', folder_name: 'Budget' })],
  ['doc create folder name', 'POST', '/documents', DOC({ name: 'Beleg 2', folder_name: 'Budget' })],
  ['doc create folder null', 'POST', '/documents', DOC({ name: 'Ohne', folder_id: null, subject_user_id: null, expires_at: null, expiry_reminder_days: null })],
  ['doc create reminder zero', 'POST', '/documents', DOC({ name: 'Heute', expires_at: '2026-11-20', expiry_reminder_days: 0 })],
  ['doc create reminder past', 'POST', '/documents', DOC({ name: 'Vorbei', expires_at: '2026-11-19', expiry_reminder_days: 5 })],
  ['doc create visibility unknown', 'POST', '/documents', DOC({ visibility: 'Private' })],
  ['doc create visibility number', 'POST', '/documents', DOC({ visibility: 5 })],
  ['doc create category unknown', 'POST', '/documents', DOC({ category: 'Medical' })],
  ['doc create status unknown', 'POST', '/documents', DOC({ status: 'gone' })],
  ['doc create folder gone', 'POST', '/documents', DOC({ folder_id: 987654 })],
  ['doc create folder mixed', 'POST', '/documents', DOC({ folder_id: '1abc' })],
  ['doc create folder fraction', 'POST', '/documents', DOC({ folder_id: '1.5' })],
  ['doc create folder zero', 'POST', '/documents', DOC({ folder_id: '0' })],
  ['doc create folder empty', 'POST', '/documents', DOC({ folder_id: '' })],
  ['doc create folder bool', 'POST', '/documents', DOC({ folder_id: true })],
  ['doc create folder key unknown', 'POST', '/documents', DOC({ folder_key: 'nope' })],
  ['doc create folder key proto', 'POST', '/documents', DOC({ folder_key: 'constructor' })],
  ['doc create expiry day gone', 'POST', '/documents', DOC({ expires_at: '2026-02-30' })],
  ['doc create expiry form', 'POST', '/documents', DOC({ expires_at: '30.01.2027' })],
  ['doc create reminder bool', 'POST', '/documents', DOC({ expires_at: '2027-01-10', expiry_reminder_days: true })],
  ['doc create reminder text', 'POST', '/documents', DOC({ expires_at: '2027-01-10', expiry_reminder_days: '5' })],
  ['doc create reminder above', 'POST', '/documents', DOC({ expires_at: '2027-01-10', expiry_reminder_days: 366 })],
  ['doc create reminder negative', 'POST', '/documents', DOC({ expires_at: '2027-01-10', expiry_reminder_days: -1 })],
  ['doc create reminder fraction', 'POST', '/documents', DOC({ expires_at: '2027-01-10', expiry_reminder_days: 1.5 })],
  ['doc create subject guest', 'POST', '/documents', DOC({ subject_user_id: GUEST })],
  ['doc create subject unknown', 'POST', '/documents', DOC({ subject_user_id: 987654 })],
  ['doc create subject text', 'POST', '/documents', DOC({ name: 'Zeugnis', subject_user_id: `0${MEM}` })],
  ['doc create subject fraction', 'POST', '/documents', DOC({ subject_user_id: '1.5' })],
  ['doc create subject bool', 'POST', '/documents', DOC({ subject_user_id: true })],
  ['doc create subject empty', 'POST', '/documents', DOC({ subject_user_id: '' })],
  ['doc create allowed guest', 'POST', '/documents', DOC({ visibility: 'restricted', allowed_member_ids: [GUEST] })],
  ['doc create allowed unknown', 'POST', '/documents', DOC({ visibility: 'restricted', allowed_member_ids: [987654] })],
  ['doc create allowed text', 'POST', '/documents', DOC({ visibility: 'restricted', allowed_member_ids: ['x'] })],
  ['doc create allowed zero', 'POST', '/documents', DOC({ visibility: 'restricted', allowed_member_ids: [0] })],
  ['doc create allowed object', 'POST', '/documents', DOC({ visibility: 'restricted', allowed_member_ids: { 0: 1 } })],
  ['doc create allowed for family', 'POST', '/documents', DOC({ name: 'Familie', allowed_member_ids: [GUEST] })],
  ['doc create name spaces', 'POST', '/documents', DOC({ name: SPACES })],
  ['doc create name long', 'POST', '/documents', DOC({ name: LONG(MAX_TITLE + 1) })],
  ['doc create name number', 'POST', '/documents', DOC({ name: 5 })],
  ['doc create original spaces', 'POST', '/documents', DOC({ original_name: SPACES })],
  ['doc create description long', 'POST', '/documents', DOC({ description: LONG(MAX_TEXT + 1) })],
  ['doc create description number', 'POST', '/documents', DOC({ description: 5 })],
  ['doc create folder name long', 'POST', '/documents', DOC({ folder_name: LONG(MAX_TITLE + 1) })],
  ['doc create two errors', 'POST', '/documents', DOC({ name: SPACES, description: LONG(MAX_TEXT + 1) })],
  ['doc create content broken', 'POST', '/documents', DOC({ content_data: 'hallo' })],
  ['doc create content type', 'POST', '/documents', DOC({ content_data: `data:text/html;base64,${Buffer.from('<p>').toString('base64')}` })],
  ['doc create content empty', 'POST', '/documents', DOC({ content_data: 'data:text/plain;base64,' })],
  ['doc create content mismatch', 'POST', '/documents', DOC({ content_data: `data:application/pdf;base64,${Buffer.from('kein pdf').toString('base64')}` })],
  ['doc create content number', 'POST', '/documents', DOC({ content_data: 5 })],
  ['doc create content missing', 'POST', '/documents', { name: 'X', original_name: 'x.txt' }],
  ['doc create no body', 'POST', '/documents', NO_BODY],
  ['doc list', 'GET', '/documents', NO_BODY],
  ['doc list member', 'GET', '/documents', NO_BODY, { actor: 'mem' }],
  ['doc list archived', 'GET', '/documents?status=archived', NO_BODY],
  ['doc list status unknown', 'GET', '/documents?status=bogus', NO_BODY],
  ['doc list category', 'GET', '/documents?category=identity', NO_BODY],
  ['doc list category unknown', 'GET', '/documents?category=Medical', NO_BODY],
  ['doc list folder', 'GET', () => `/documents?folder_id=${F(1)}`, NO_BODY],
  ['doc list folder leading zero', 'GET', () => `/documents?folder_id=0${F(2)}`, NO_BODY],
  ['doc list folder gone', 'GET', '/documents?folder_id=987654', NO_BODY],
  ['doc list folder letters', 'GET', '/documents?folder_id=abc', NO_BODY],
  ['doc list folder zero', 'GET', '/documents?folder_id=0', NO_BODY],
  ['doc list folder empty', 'GET', '/documents?folder_id=', NO_BODY],
  ['doc list expiring', 'GET', '/documents?expiring=60', NO_BODY],
  ['doc list expiring zero', 'GET', '/documents?expiring=0', NO_BODY],
  ['doc list expiring letters', 'GET', '/documents?expiring=abc', NO_BODY],
  ['doc list expiring negative', 'GET', '/documents?expiring=-1', NO_BODY],
  ['doc list subject', 'GET', `/documents?subject_user_id=${MEM}`, NO_BODY],
  ['doc list subject leading zero', 'GET', `/documents?subject_user_id=0${MEM}`, NO_BODY],
  ['doc list subject zero', 'GET', '/documents?subject_user_id=0', NO_BODY],
  ['doc list subject letters', 'GET', '/documents?subject_user_id=abc', NO_BODY],
  ['doc list subject empty', 'GET', '/documents?subject_user_id=', NO_BODY],
  // PUT /documents/{id}
  ['doc put', 'PUT', () => `/documents/${D()}`, { name: 'Reisepass neu', description: null, category: 'travel', status: 'active', expiry_reminder_days: 14, allowed_member_ids: [] }],
  ['doc put visibility', 'PUT', () => `/documents/${D()}`, { visibility: 'restricted', allowed_member_ids: [MEM, MEM] }],
  // Full representation (group 8 c): left out, the access list of the restricted document was emptied (200, `allowed_member_ids: []`).
  ['doc put without access list', 'PUT', () => `/documents/${D()}`, { name: 'Reisepass neu' }],
  ['doc put leading zero', 'PUT', () => `/documents/0${D()}`, { visibility: 'family', allowed_member_ids: [] }],
  ['doc put folder', 'PUT', () => `/documents/${D()}`, () => ({ folder_id: String(F(6)), allowed_member_ids: [] })],
  ['doc put folder null', 'PUT', () => `/documents/${D()}`, { folder_id: null, allowed_member_ids: [] }],
  ['doc put folder gone', 'PUT', () => `/documents/${D()}`, { folder_id: 987654, allowed_member_ids: [] }],
  ['doc put folder empty', 'PUT', () => `/documents/${D()}`, { folder_id: '', allowed_member_ids: [] }],
  ['doc put folder mixed', 'PUT', () => `/documents/${D()}`, { folder_id: '1abc', allowed_member_ids: [] }],
  ['doc put expiry clear', 'PUT', () => `/documents/${D()}`, { expires_at: null, allowed_member_ids: [] }],
  ['doc put expiry back', 'PUT', () => `/documents/${D()}`, { expires_at: '2027-02-01', expiry_reminder_days: '', allowed_member_ids: [] }],
  ['doc put expiry day gone', 'PUT', () => `/documents/${D()}`, { expires_at: '2027-02-30', allowed_member_ids: [] }],
  ['doc put reminder bool', 'PUT', () => `/documents/${D()}`, { expiry_reminder_days: true, allowed_member_ids: [] }],
  ['doc put reminder above', 'PUT', () => `/documents/${D()}`, { expiry_reminder_days: 400, allowed_member_ids: [] }],
  ['doc put category unknown', 'PUT', () => `/documents/${D()}`, { category: 'Medical', allowed_member_ids: [] }],
  ['doc put category null', 'PUT', () => `/documents/${D()}`, { category: null, allowed_member_ids: [] }],
  ['doc put visibility unknown', 'PUT', () => `/documents/${D()}`, { visibility: 'Private', allowed_member_ids: [] }],
  ['doc put status unknown', 'PUT', () => `/documents/${D()}`, { status: 'deleted', allowed_member_ids: [] }],
  ['doc put subject guest', 'PUT', () => `/documents/${D()}`, { subject_user_id: GUEST, allowed_member_ids: [] }],
  ['doc put subject clear', 'PUT', () => `/documents/${D()}`, { subject_user_id: null, allowed_member_ids: [] }],
  ['doc put subject bool', 'PUT', () => `/documents/${D()}`, { subject_user_id: true, allowed_member_ids: [] }],
  ['doc put allowed guest', 'PUT', () => `/documents/${D()}`, { visibility: 'restricted', allowed_member_ids: [GUEST] }],
  ['doc put allowed unknown', 'PUT', () => `/documents/${D()}`, { visibility: 'restricted', allowed_member_ids: [987654] }],
  ['doc put allowed text', 'PUT', () => `/documents/${D()}`, { allowed_member_ids: ['x'] }],
  ['doc put name spaces', 'PUT', () => `/documents/${D()}`, { name: SPACES, allowed_member_ids: [] }],
  ['doc put name number', 'PUT', () => `/documents/${D()}`, { name: 5, allowed_member_ids: [] }],
  ['doc put description long', 'PUT', () => `/documents/${D()}`, { description: LONG(MAX_TEXT + 1), allowed_member_ids: [] }],
  ['doc put archive', 'PUT', () => `/documents/${D()}`, { status: 'archived', allowed_member_ids: [] }],
  ['doc put member other', 'PUT', () => `/documents/${D()}`, { name: 'X', allowed_member_ids: [] }, { actor: 'mem' }],
  ['doc put member restricted', 'PUT', () => `/documents/${ids.doc2}`, { name: 'X', allowed_member_ids: [] }, { actor: 'mem' }],
  ['doc put admin private', 'PUT', () => `/documents/${ids.doc3}`, { name: 'X', allowed_member_ids: [] }],
  ['doc put zero', 'PUT', '/documents/0', { name: 'X', allowed_member_ids: [] }],
  ['doc put minus', 'PUT', '/documents/-1', { name: 'X', allowed_member_ids: [] }],
  ['doc put minus zero', 'PUT', '/documents/-0', { name: 'X', allowed_member_ids: [] }],
  ['doc put gone', 'PUT', '/documents/987654', { name: 'X', allowed_member_ids: [] }],
  ['doc put letters', 'PUT', '/documents/abc', { name: 'X', allowed_member_ids: [] }],
  ['doc put hex', 'PUT', '/documents/0x1', { name: 'X', allowed_member_ids: [] }],
  // PATCH archive
  ['doc unarchive', 'PATCH', () => `/documents/${D()}/archive`, { archived: false }],
  ['doc archive empty', 'PATCH', () => `/documents/${ids.doc2}/archive`, {}],
  ['doc archive no body', 'PATCH', () => `/documents/${ids.doc2}/archive`, NO_BODY],
  ['doc archive text', 'PATCH', () => `/documents/${D()}/archive`, { archived: 'false' }],
  ['doc archive number', 'PATCH', () => `/documents/${D()}/archive`, { archived: 0 }],
  ['doc archive member', 'PATCH', () => `/documents/${D()}/archive`, { archived: true }, { actor: 'mem' }],
  ['doc archive zero', 'PATCH', '/documents/0/archive', { archived: true }],
  ['doc archive minus zero', 'PATCH', '/documents/-0/archive', { archived: true }],
  ['doc archive gone', 'PATCH', '/documents/987654/archive', { archived: true }],
  ['doc archive leading zero', 'PATCH', () => `/documents/0${ids.doc2}/archive`, { archived: false }],
  // Files
  ['doc preview', 'GET', () => `/documents/${D()}/preview`, NO_BODY],
  ['doc preview leading zero', 'GET', () => `/documents/0${D()}/preview`, NO_BODY],
  ['doc preview member restricted', 'GET', () => `/documents/${ids.doc2}/preview`, NO_BODY, { actor: 'mem' }],
  ['doc preview admin private', 'GET', () => `/documents/${ids.doc3}/preview`, NO_BODY],
  ['doc preview zero', 'GET', '/documents/0/preview', NO_BODY],
  ['doc preview gone', 'GET', '/documents/987654/preview', NO_BODY],
  ['doc preview letters', 'GET', '/documents/abc/preview', NO_BODY],
  ['doc download', 'GET', () => `/documents/${D()}/download`, NO_BODY],
  ['doc download minus zero', 'GET', '/documents/-0/download', NO_BODY],
  ['doc download gone', 'GET', '/documents/987654/download', NO_BODY],
  ['doc thumbnail local', 'GET', () => `/documents/${D()}/thumbnail`, NO_BODY],
  ['doc thumbnail gone', 'GET', '/documents/987654/thumbnail', NO_BODY],
  ['doc thumbnail zero', 'GET', '/documents/0/thumbnail', NO_BODY],
  ['doc thumbnail letters', 'GET', '/documents/abc/thumbnail', NO_BODY],
  // Folder deletion
  ['fd impact', 'GET', () => `/documents/folders/${F(1)}/delete-impact`, NO_BODY],
  ['fd impact member', 'GET', () => `/documents/folders/${F(1)}/delete-impact`, NO_BODY, { actor: 'mem' }],
  ['fd impact leading zero', 'GET', () => `/documents/folders/0${F(6)}/delete-impact`, NO_BODY],
  ['fd impact zero', 'GET', '/documents/folders/0/delete-impact', NO_BODY],
  ['fd impact minus', 'GET', '/documents/folders/-1/delete-impact', NO_BODY],
  ['fd impact minus zero', 'GET', '/documents/folders/-0/delete-impact', NO_BODY],
  ['fd impact gone', 'GET', '/documents/folders/987654/delete-impact', NO_BODY],
  ['fd impact letters', 'GET', '/documents/folders/abc/delete-impact', NO_BODY],
  ['fd action unknown', 'DELETE', () => `/documents/folders/${F(1)}?documents=bogus`, NO_BODY],
  ['fd action empty', 'DELETE', () => `/documents/folders/${F(1)}?documents=`, NO_BODY],
  ['fd expected negative', 'DELETE', () => `/documents/folders/${F(1)}?expected_documents=-1`, NO_BODY],
  ['fd expected letters', 'DELETE', () => `/documents/folders/${F(1)}?expected_folders=abc`, NO_BODY],
  ['fd expected empty', 'DELETE', () => `/documents/folders/${F(1)}?expected_documents=`, NO_BODY],
  ['fd snapshot broken', 'DELETE', () => `/documents/folders/${F(1)}?expected_snapshot=xyz`, NO_BODY],
  ['fd delete without snapshot', 'DELETE', () => `/documents/folders/${F(1)}?documents=delete`, NO_BODY],
  ['fd delete stale snapshot', 'DELETE', () => `/documents/folders/${F(1)}?documents=delete&expected_snapshot=${'a'.repeat(64)}`, NO_BODY],
  ['fd unfile stale count', 'DELETE', () => `/documents/folders/${F(1)}?expected_documents=99`, NO_BODY],
  ['fd delete member', 'DELETE', () => `/documents/folders/${F(1)}?documents=delete&expected_snapshot=${answered.memberSnapshot}`, NO_BODY, { actor: 'mem' }],
  ['fd zero', 'DELETE', '/documents/folders/0', NO_BODY],
  ['fd minus', 'DELETE', '/documents/folders/-1', NO_BODY],
  ['fd minus zero', 'DELETE', '/documents/folders/-0', NO_BODY],
  ['fd gone', 'DELETE', '/documents/folders/987654', NO_BODY],
  ['fd letters', 'DELETE', '/documents/folders/abc', NO_BODY],
  ['fd unfile', 'DELETE', () => `/documents/folders/${F(6)}?expected_documents=0&expected_folders=2`, NO_BODY],
  ['fd delete', 'DELETE', () => `/documents/folders/0${F(3)}?documents=delete&expected_snapshot=${answered.snapshot3}`, NO_BODY],
  ['f list end', 'GET', '/documents/folders', NO_BODY],

  // ══ DMS ════════════════════════════════════════════════════════════════════
  ['dms accounts empty', 'GET', '/documents/dms/accounts', NO_BODY],
  ['dms accounts member', 'GET', '/documents/dms/accounts', NO_BODY, { actor: 'mem' }],
  ['dms create', 'POST', '/documents/dms/accounts', DMS_ACCOUNT()],
  () => { ids.account = lastId('dms_accounts'); },
  ['dms create papra', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'papra', name: ' Papra ', base_url: 'https://papra.example.org///', org_id: ' org-1 ' })],
  () => { ids.account2 = lastId('dms_accounts'); },
  ['dms create default provider', 'POST', '/documents/dms/accounts', { name: 'Dritte', base_url: 'http://dms3.example.org', api_token: 't' }],
  () => { ids.account3 = lastId('dms_accounts'); },
  ['dms create duplicate', 'POST', '/documents/dms/accounts', DMS_ACCOUNT()],
  ['dms create provider unknown', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'zzz', base_url: 'https://z.example.org' })],
  ['dms create provider number', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 5, base_url: 'https://z.example.org' })],
  ['dms create provider proto', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'constructor', base_url: 'https://z.example.org' })],
  ['dms create papra no org', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'papra', base_url: 'https://z.example.org' })],
  ['dms create papra org spaces', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'papra', base_url: 'https://z.example.org', org_id: SPACES })],
  ['dms create papra org number', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 'papra', base_url: 'https://z.example.org', org_id: 5 })],
  ['dms create name spaces', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ name: SPACES, base_url: 'https://z.example.org' })],
  ['dms create name empty', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ name: '', base_url: 'https://z.example.org' })],
  ['dms create name long', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ name: LONG(MAX_TITLE + 1), base_url: 'https://z.example.org' })],
  ['dms create name object', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ name: {}, base_url: 'https://z.example.org' })],
  ['dms create name missing', 'POST', '/documents/dms/accounts', { base_url: 'https://z.example.org', api_token: 't' }],
  ['dms create url scheme', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ base_url: 'ftp://z.example.org' })],
  ['dms create url long', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ base_url: `https://${LONG(500)}` })],
  ['dms create token spaces', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ api_token: SPACES, base_url: 'https://z.example.org' })],
  ['dms create token number', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ api_token: 5, base_url: 'https://z.example.org' })],
  ['dms create member', 'POST', '/documents/dms/accounts', DMS_ACCOUNT({ provider: 5 }), { actor: 'mem' }],
  ['dms create no body', 'POST', '/documents/dms/accounts', NO_BODY],
  ['dms accounts', 'GET', '/documents/dms/accounts', NO_BODY],
  ['dms test', 'POST', () => `/documents/dms/accounts/${A()}/test`, NO_BODY],
  ['dms test leading zero', 'POST', () => `/documents/dms/accounts/0${A()}/test`, NO_BODY],
  ['dms test gone', 'POST', '/documents/dms/accounts/987654/test', NO_BODY],
  ['dms test zero', 'POST', '/documents/dms/accounts/0/test', NO_BODY],
  ['dms test minus zero', 'POST', '/documents/dms/accounts/-0/test', NO_BODY],
  ['dms test letters', 'POST', '/documents/dms/accounts/abc/test', NO_BODY],
  ['dms test member', 'POST', '/documents/dms/accounts/abc/test', NO_BODY, { actor: 'mem' }],
  ['dms search', 'GET', () => `/documents/dms/search?account_id=${A()}&q=%20Strom%20`, NO_BODY],
  ['dms search no q', 'GET', () => `/documents/dms/search?account_id=${A()}`, NO_BODY],
  ['dms search leading zero', 'GET', () => `/documents/dms/search?account_id=0${A()}`, NO_BODY],
  ['dms search gone', 'GET', '/documents/dms/search?account_id=987654', NO_BODY],
  ['dms search letters', 'GET', '/documents/dms/search?account_id=abc', NO_BODY],
  ['dms search missing', 'GET', '/documents/dms/search', NO_BODY],
  ['dms search zero', 'GET', '/documents/dms/search?account_id=0', NO_BODY],
  ['dms thumbnail', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=7`, NO_BODY],
  ['dms thumbnail spaces', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=%20%20`, NO_BODY],
  ['dms thumbnail id missing', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}`, NO_BODY],
  ['dms thumbnail gone', 'GET', '/documents/dms/thumbnail?account_id=987654&dms_document_id=7', NO_BODY],
  ['dms link', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: ' 7 ', category: 'finance', visibility: 'private' })],
  () => { ids.linked = lastId('family_documents'); },
  ['dms link number id', 'POST', '/documents/dms/link', () => ({ account_id: String(A()), dms_document_id: 8 })],
  ['dms link leading zero account', 'POST', '/documents/dms/link', () => ({ account_id: `0${A()}`, dms_document_id: '9' })],
  ['dms link again', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '7' })],
  ['dms link spaces', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: SPACES })],
  ['dms link id empty', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '' })],
  ['dms link id object', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: {} })],
  ['dms link id bool', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: true })],
  ['dms link visibility unknown', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '10', visibility: 'Private' })],
  ['dms link category unknown', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '10', category: 'x' })],
  ['dms link account gone', 'POST', '/documents/dms/link', { account_id: 987654, dms_document_id: '10' }],
  ['dms link account bool', 'POST', '/documents/dms/link', { account_id: true, dms_document_id: '10' }],
  ['dms link account zero', 'POST', '/documents/dms/link', { account_id: 0, dms_document_id: '10' }],
  ['dms link missing', 'POST', '/documents/dms/link', {}],
  ['doc thumbnail dms', 'GET', () => `/documents/${ids.linked}/thumbnail`, NO_BODY],
  ['doc preview dms', 'GET', () => `/documents/${ids.linked}/preview`, NO_BODY],
  ['dms push', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: D() })],
  ['dms push text ids', 'POST', '/documents/dms/push', () => ({ account_id: String(A()), document_id: `0${D()}` })],
  ['dms push linked', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: ids.linked })],
  ['dms push doc gone', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: 987654 })],
  ['dms push doc letters', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: 'abc' })],
  ['dms push doc fraction', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: 1.5 })],
  ['dms push account gone', 'POST', '/documents/dms/push', () => ({ account_id: 987654, document_id: D() })],
  ['dms push private of member', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: ids.doc3 })],
  () => { dms.mode = 'missing'; },
  ['dms link missing in dms', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '11' })],
  ['dms thumbnail missing in dms', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=11`, NO_BODY],
  () => { dms.mode = 'svg'; },
  ['dms thumbnail svg', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=7`, NO_BODY],
  ['doc thumbnail dms svg', 'GET', () => `/documents/${ids.linked}/thumbnail`, NO_BODY],
  () => { dms.mode = 'nothumb'; },
  ['dms thumbnail none', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=7`, NO_BODY],
  ['doc thumbnail dms none', 'GET', () => `/documents/${ids.linked}/thumbnail`, NO_BODY],
  () => { dms.mode = 'reject'; },
  ['dms search unreachable', 'GET', () => `/documents/dms/search?account_id=${A()}`, NO_BODY],
  ['dms thumbnail unreachable', 'GET', () => `/documents/dms/thumbnail?account_id=${A()}&dms_document_id=7`, NO_BODY],
  ['doc thumbnail dms unreachable', 'GET', () => `/documents/${ids.linked}/thumbnail`, NO_BODY],
  ['dms link unreachable', 'POST', '/documents/dms/link', () => ({ account_id: A(), dms_document_id: '12' })],
  ['dms push unreachable', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: D() })],
  () => { dms.mode = 'ok'; },
  // A WebDAV document without a WebDAV configuration: the read is a StorageError.
  () => {
    ids.webdav = Number(database().prepare("INSERT INTO family_documents (name, original_name, mime_type, file_size, content_data, storage_provider, storage_backend, storage_key, created_by) VALUES ('Fern', 'fern.txt', 'text/plain', 5, '', 'external', 'webdav', 'documents/fern.txt', ?)").run(ADMIN).lastInsertRowid);
  },
  ['dms push storage failed', 'POST', '/documents/dms/push', () => ({ account_id: A(), document_id: ids.webdav })],
  ['doc preview storage failed', 'GET', () => `/documents/${ids.webdav}/preview`, NO_BODY],
  ['doc download storage failed', 'GET', () => `/documents/${ids.webdav}/download`, NO_BODY],
  ['doc delete storage failed', 'DELETE', () => `/documents/${ids.webdav}`, NO_BODY],
  () => { database().prepare('DELETE FROM family_documents WHERE id = ?').run(ids.webdav); },
  ['dms delete', 'DELETE', () => `/documents/dms/accounts/${ids.account3}`, NO_BODY],
  ['dms delete leading zero', 'DELETE', () => `/documents/dms/accounts/0${ids.account2}`, NO_BODY],
  ['dms delete zero', 'DELETE', '/documents/dms/accounts/0', NO_BODY],
  ['dms delete minus', 'DELETE', '/documents/dms/accounts/-1', NO_BODY],
  ['dms delete minus zero', 'DELETE', '/documents/dms/accounts/-0', NO_BODY],
  ['dms delete gone', 'DELETE', '/documents/dms/accounts/987654', NO_BODY],
  ['dms delete letters', 'DELETE', '/documents/dms/accounts/abc', NO_BODY],
  ['dms delete member', 'DELETE', () => `/documents/dms/accounts/${A()}`, NO_BODY, { actor: 'mem' }],
  ['dms delete linked account', 'DELETE', () => `/documents/dms/accounts/${A()}`, NO_BODY],
  ['doc preview account gone', 'GET', () => `/documents/${ids.linked}/preview`, NO_BODY],
  ['doc download account gone', 'GET', () => `/documents/${ids.linked}/download`, NO_BODY],
  ['doc thumbnail account gone', 'GET', () => `/documents/${ids.linked}/thumbnail`, NO_BODY],
  ['dms accounts end', 'GET', '/documents/dms/accounts', NO_BODY],

  // ══ GOOGLE DRIVE ═══════════════════════════════════════════════════════════
  ['gd test unconnected', 'POST', '/documents/storage/google-drive/test', NO_BODY],
  ['gd disconnect unconnected', 'DELETE', '/documents/storage/google-drive/disconnect', NO_BODY],
  ['gd auth', 'GET', '/documents/storage/google-drive/auth', NO_BODY],
  ['gd auth member', 'GET', '/documents/storage/google-drive/auth', NO_BODY, { actor: 'mem' }],
  ['gd callback no code', 'GET', '/documents/storage/google-drive/callback?state=state-1', NO_BODY],
  ['gd callback refused', 'GET', '/documents/storage/google-drive/callback?error=access_denied&state=state-1', NO_BODY],
  ['gd callback wrong state', 'GET', '/documents/storage/google-drive/callback?code=c&state=other', NO_BODY],
  ['gd callback code twice', 'GET', '/documents/storage/google-drive/callback?code=a&code=b&state=state-1', NO_BODY],
  ['gd callback member', 'GET', '/documents/storage/google-drive/callback?code=a&code=b', NO_BODY, { actor: 'mem' }],
  ['gd callback', 'GET', '/documents/storage/google-drive/callback?code=c&state=state-1&scope=x&authuser=0&prompt=consent', NO_BODY],
  ['gd test', 'POST', '/documents/storage/google-drive/test', NO_BODY],
  () => { drive.failFiles = true; },
  ['gd test fails', 'POST', '/documents/storage/google-drive/test', NO_BODY],
  () => { drive.failFiles = false; },
  ['sc put drive', 'PUT', '/documents/storage/config', { selected_upload_backend: 'google_drive' }],
  ['gd disconnect selected', 'DELETE', '/documents/storage/google-drive/disconnect', NO_BODY],
  ['sc put local again', 'PUT', '/documents/storage/config', { selected_upload_backend: 'local' }],
  ['gd disconnect', 'DELETE', '/documents/storage/google-drive/disconnect', NO_BODY],
  ['gd disconnect member', 'DELETE', '/documents/storage/google-drive/disconnect', NO_BODY, { actor: 'mem' }],
  ['gd test member', 'POST', '/documents/storage/google-drive/test', NO_BODY, { actor: 'mem' }],

  // ══ DOCUMENTS: DELETE ══════════════════════════════════════════════════════
  ['doc delete member', 'DELETE', () => `/documents/${D()}`, NO_BODY, { actor: 'mem' }],
  ['doc delete zero', 'DELETE', '/documents/0', NO_BODY],
  ['doc delete minus zero', 'DELETE', '/documents/-0', NO_BODY],
  ['doc delete gone', 'DELETE', '/documents/987654', NO_BODY],
  ['doc delete letters', 'DELETE', '/documents/abc', NO_BODY],
  ['doc delete', 'DELETE', () => `/documents/0${D()}`, NO_BODY],
  ['doc delete again', 'DELETE', () => `/documents/${D()}`, NO_BODY],
  ['doc list end', 'GET', '/documents', NO_BODY],
];

// The two folder snapshots the deletion rows confirm: read through the route
// just before they run, so a row confirms the preview of its own moment.
const SNAPSHOT_ROWS = {
  'fd delete member': async () => { answered.memberSnapshot = (/** @type {any} */ (await call('GET', `/documents/folders/${F(1)}/delete-impact`, NO_BODY, { actor: 'mem' })).body).data.snapshot; },
  'fd delete': async () => { answered.snapshot3 = (/** @type {any} */ (await call('GET', `/documents/folders/${F(3)}/delete-impact`, NO_BODY)).body).data.snapshot; },
};

async function runTable() {
  /** @type {Record<string, { status: number, body: unknown }>} */
  const answers = {};
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method, route, body, opts] = step;
    assert.ok(!Object.hasOwn(answers, name), `duplicate row name ${name}`);
    const before = /** @type {Record<string, () => Promise<void>>} */ (SNAPSHOT_ROWS)[name];
    if (before) await before();
    const actual = await call(method, typeof route === 'function' ? route() : route, typeof body === 'function' ? body() : body, opts);
    answers[name] = { status: actual.status, body: normalized(actual.body) };
  }
  return answers;
}

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  logged.error.length = 0;
  const answers = await runTable();
  if (process.env.G8_DUMP) fs.writeFileSync(process.env.G8_DUMP, JSON.stringify(answers));
  for (const [name, answer] of Object.entries(answers)) {
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual(answer, EXPECTED[name], name);
  }
  assert.equal(Object.keys(answers).length, Object.keys(EXPECTED).length, 'every expectation has its row');
  assert.deepEqual(logged.error, [], 'no row of the table reached the central handler');
  assert.deepEqual(mail.sent.map((/** @type {any} */ m) => m.to), ['tom@example.org'], 'one mail went out');
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
 * @param {Array<[string, string, unknown, string]>} rows [method, path under /api/v1, body, route pattern]
 */
async function assertAllCentral(rows) {
  for (const [method, route, body, pattern] of rows) {
    assertCentral(await call(method, route, body, { fail: true }), method, pattern);
  }
}

/** A new row through the route, its id. @param {string} route @param {unknown} body */
async function created(route, body) {
  const res = await call('POST', route, body);
  assert.ok(res.status === 201 || res.status === 200, `${route}: ${JSON.stringify(res.body)}`);
  return /** @type {any} */ (res.body).data.id;
}

const S_ = '/api/v1/shopping';
const D_ = '/api/v1/documents';
const M_ = '/api/v1/documents/dms';

test('an unexpected error in each shopping route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const list = await created('/shopping', { name: 'Probe' });
  const item = await created(`/shopping/${list}/items`, { name: 'Probe' });
  const category = await created('/shopping/categories', { name: 'Probe' });
  const store = await created('/shopping/stores', { name: 'Probe' });
  database().prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(item);
  await assertAllCentral([
    ['GET', '/shopping/versions', NO_BODY, `${S_}/versions`],
    ['GET', '/shopping/categories', NO_BODY, `${S_}/categories`],
    ['POST', '/shopping/categories', { name: 'Probe 2' }, `${S_}/categories`],
    ['PUT', `/shopping/categories/${category}`, { name: 'Probe 3' }, `${S_}/categories/:catId`],
    ['PATCH', '/shopping/categories/reorder', { order: [category] }, `${S_}/categories/reorder`],
    ['GET', '/shopping/send-recipients', NO_BODY, `${S_}/send-recipients`],
    ['GET', '/shopping/suggestions?q=Pro', NO_BODY, `${S_}/suggestions`],
    // The five shop and price routes said `Internal error` before.
    ['GET', '/shopping/stores', NO_BODY, `${S_}/stores`],
    ['POST', '/shopping/stores', { name: 'Probe 2' }, `${S_}/stores`],
    ['PUT', `/shopping/stores/${store}`, { name: 'Probe 3' }, `${S_}/stores/:id`],
    ['GET', '/shopping/price-history?name=Probe', NO_BODY, `${S_}/price-history`],
    ['PATCH', `/shopping/items/${item}`, { quantity: '2' }, `${S_}/items/:itemId`],
    ['POST', '/shopping/items/undo-transfer', { ids: [987654] }, `${S_}/items/undo-transfer`],
    ['GET', '/shopping', NO_BODY, `${S_}/`],
    ['POST', '/shopping', { name: 'Probe 2' }, `${S_}/`],
    ['PUT', `/shopping/${list}`, { name: 'Probe 3' }, `${S_}/:listId`],
    ['POST', `/shopping/${list}/duplicate`, { name: 'Probe 4' }, `${S_}/:listId/duplicate`],
    ['GET', `/shopping/${list}/items`, NO_BODY, `${S_}/:listId/items`],
    ['PATCH', `/shopping/${list}/items/reorder`, { category: 'Sonstiges', order: [item] }, `${S_}/:listId/items/reorder`],
    ['POST', `/shopping/${list}/items`, { name: 'Probe 2' }, `${S_}/:listId/items`],
    ['POST', `/shopping/${list}/import-meal-plan`, { from: '2026-11-16', to: '2026-11-22', preview: true }, `${S_}/:listId/import-meal-plan`],
    ['POST', `/shopping/${list}/import-pantry`, { items: [] }, `${S_}/:listId/import-pantry`],
    ['DELETE', `/shopping/${list}/items/checked`, NO_BODY, `${S_}/:listId/items/checked`],
    ['DELETE', `/shopping/items/${item}`, NO_BODY, `${S_}/items/:itemId`],
    ['DELETE', `/shopping/stores/${store}`, NO_BODY, `${S_}/stores/:id`],
    ['DELETE', `/shopping/categories/${category}`, NO_BODY, `${S_}/categories/:catId`],
    ['DELETE', `/shopping/${list}`, NO_BODY, `${S_}/:listId`],
  ]);
  assert.equal((await call('GET', '/shopping/stores', NO_BODY)).status, 200, 'the shopping list answers again');
});

test('send (async): a failure while rendering the mail is a 500 of the central handler; the mail service keeps its 502', async () => {
  logged.error.length = 0;
  resetSendLimiter();
  const list = await created('/shopping', { name: 'Versand' });
  await created(`/shopping/${list}/items`, { name: 'Brot' });
  // The mail renderer (services/shopping-mail.js) trims each item name; that
  // trim fails for this one name, so rendering throws.
  const trim = String.prototype.trim;
  String.prototype.trim = function () {
    if (String(this) === 'Brot') throw new Error('rendering broke');
    return trim.call(this);
  };
  try {
    assertCentral(await call('POST', `/shopping/${list}/send`, { userId: MEM }), 'POST', `${S_}/:listId/send`);
  } finally {
    String.prototype.trim = trim;
  }
  const sendMail = app.locals.emailService.sendMail;
  app.locals.emailService.sendMail = async () => { throw new Error('smtp went away'); };
  try {
    assert.deepEqual(await call('POST', `/shopping/${list}/send`, { userId: MEM }), { status: 502, body: { error: 'The email could not be sent.', code: 502 } });
  } finally {
    app.locals.emailService.sendMail = sendMail;
  }
  assert.deepEqual(logged.error, [], 'the 502 stays the route\'s own');
});

test('an unexpected error in each documents route is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const folder = await created('/documents/folders', { name: 'Probe' });
  const folder2 = await created('/documents/folders', { name: 'Probe 2' });
  const doc = await created('/documents', DOC({ name: 'Probe' }));
  await assertAllCentral([
    ['GET', '/documents/storage/config', NO_BODY, `${D_}/storage/config`],
    ['PUT', '/documents/storage/config', { selected_upload_backend: 'local' }, `${D_}/storage/config`],
    ['GET', '/documents/meta/options', NO_BODY, `${D_}/meta/options`],
    ['GET', '/documents/folders', NO_BODY, `${D_}/folders`],
    ['GET', `/documents/folders/${folder}/delete-impact`, NO_BODY, `${D_}/folders/:id/delete-impact`],
    ['POST', '/documents/folders', { name: 'Probe 3' }, `${D_}/folders`],
    ['PUT', `/documents/folders/${folder}`, { name: 'Probe 4' }, `${D_}/folders/:id`],
    ['DELETE', `/documents/folders/${folder2}`, NO_BODY, `${D_}/folders/:id`],
    ['GET', '/documents', NO_BODY, `${D_}/`],
    ['POST', '/documents', DOC({ name: 'Probe 2' }), `${D_}/`],
    ['PUT', `/documents/${doc}`, { name: 'Probe 3', allowed_member_ids: [] }, `${D_}/:id`],
    ['PATCH', `/documents/${doc}/archive`, { archived: false }, `${D_}/:id/archive`],
    // Async handlers: the first header of the file throws after an await.
    ['GET', `/documents/${doc}/preview`, NO_BODY, `${D_}/:id/preview`],
    ['GET', `/documents/${doc}/download`, NO_BODY, `${D_}/:id/download`],
    ['DELETE', `/documents/${doc}`, NO_BODY, `${D_}/:id`],
  ]);
  // The connection test reads the stored configuration first: a table that is
  // gone is the unexpected error there.
  database().exec('ALTER TABLE sync_config RENAME TO test_config_away');
  try {
    assertCentral(await call('POST', '/documents/storage/test', {}), 'POST', `${D_}/storage/test`);
  } finally {
    database().exec('ALTER TABLE test_config_away RENAME TO sync_config');
  }
  assert.equal((await call('GET', '/documents/folders', NO_BODY)).status, 200, 'documents answer again');
});

test('an unexpected error in each DMS route is a 500 of the central handler, a rejected promise too; Google Drive keeps its 502', async () => {
  logged.error.length = 0;
  const account = await created('/documents/dms/accounts', DMS_ACCOUNT({ name: 'Probe', base_url: 'https://probe.example.org' }));
  const second = await created('/documents/dms/accounts', DMS_ACCOUNT({ name: 'Probe 2', base_url: 'https://probe2.example.org' }));
  const doc = await created('/documents', DOC({ name: 'Probe DMS' }));
  await assertAllCentral([
    ['GET', '/documents/dms/accounts', NO_BODY, `${M_}/accounts`],
    ['POST', '/documents/dms/accounts', DMS_ACCOUNT({ name: 'Probe 3', base_url: 'https://probe3.example.org' }), `${M_}/accounts`],
    ['POST', `/documents/dms/accounts/${account}/test`, NO_BODY, `${M_}/accounts/:id/test`],
    ['POST', '/documents/dms/link', { account_id: account, dms_document_id: '77' }, `${M_}/link`],
    ['POST', '/documents/dms/push', { account_id: account, document_id: doc }, `${M_}/push`],
    ['DELETE', `/documents/dms/accounts/${second}`, NO_BODY, `${M_}/accounts/:id`],
  ]);
  // Decision 31: a connection test the adapter rejects stays a 500, now the
  // central one (an async handler whose promise is rejected).
  dms.mode = 'reject';
  try {
    assertCentral(await call('POST', `/documents/dms/accounts/${account}/test`, NO_BODY), 'POST', `${M_}/accounts/:id/test`);
  } finally {
    dms.mode = 'ok';
  }
  // Google Drive answers every failure through sendStorageError(): 502.
  const drive502 = { status: 502, body: { error: 'Google Drive document storage operation failed.', code: 502, storage_code: 'DOCUMENT_STORAGE_OPERATION_FAILED' } };
  assert.deepEqual(await call('DELETE', '/documents/storage/google-drive/disconnect', NO_BODY, { fail: true }), drive502);
  assert.deepEqual(await call('GET', '/documents/storage/google-drive/auth', NO_BODY, { fail: true }), drive502);
  assert.deepEqual(logged.error, [], 'Google Drive never reaches the central handler');
  assert.equal((await call('GET', '/documents/dms/accounts', NO_BODY)).status, 200, 'the DMS answers again');
});

test('the handled cases keep their own answer and never reach the central handler', async () => {
  logged.error.length = 0;
  // The deletion lock of a document (409).
  const doc = await created('/documents', DOC({ name: 'Gesperrt' }));
  deletionLock.lockDocumentDeletes([doc]);
  try {
    for (const [method, route, body] of /** @type {Array<[string, string, unknown]>} */ ([
      ['PUT', `/documents/${doc}`, { name: 'X', allowed_member_ids: [] }],
      ['PATCH', `/documents/${doc}/archive`, { archived: true }],
      ['DELETE', `/documents/${doc}`, NO_BODY],
    ])) {
      const res = await call(method, route, body);
      assert.equal(res.status, 409, `${method} ${route}`);
      assert.equal(/** @type {any} */ (res.body).reason, 'DOCUMENT_DELETE_IN_PROGRESS', `${method} ${route}`);
    }
  } finally {
    deletionLock.unlockDocumentDeletes([doc]);
  }
  // The store refuses the upload (StorageError): its 502, not a 500.
  _setStageUploadForTest(async () => { throw new StorageError('DOCUMENT_STORAGE_UPLOAD_FAILED', 'down'); });
  try {
    assert.deepEqual(await call('POST', '/documents', DOC({ name: 'Kein Speicher' })), {
      status: 502, body: { error: 'Document storage upload failed.', code: 502, storage_code: 'DOCUMENT_STORAGE_UPLOAD_FAILED', reason: 'documents_storage_failed' },
    });
  } finally {
    _setStageUploadForTest(null);
  }
  // The chosen folder goes while the file is staged: the folder's 400.
  const folder = await created('/documents/folders', { name: 'Verschwindet' });
  _setStageUploadForTest(async (/** @type {any} */ upload) => {
    database().prepare('DELETE FROM family_document_folders WHERE id = ?').run(folder);
    return stageDocumentUpload(upload);
  });
  try {
    assert.deepEqual(await call('POST', '/documents', DOC({ name: 'Ohne Ordner', folder_id: folder })), EXPECTED['doc create folder gone']);
  } finally {
    _setStageUploadForTest(null);
  }
  assert.deepEqual(logged.error, [], 'none reached the central handler');
});

test('the clean-up runs when the error goes on: a staged upload is removed, the deletion locks are released', async () => {
  logged.error.length = 0;
  // A staged file on disk (local folder storage), then the answer fails.
  const dir = tempDir('yuvomi-shopping-documents-staged-');
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  try {
    const kept = await created('/documents', DOC({ name: 'Bleibt' }));
    const keptKey = database().prepare('SELECT storage_key FROM family_documents WHERE id = ?').get(kept).storage_key;
    assert.ok(fs.existsSync(path.join(dir, keptKey)), 'a stored upload is on disk');
    assertCentral(await call('POST', '/documents', DOC({ name: 'Weg' }), { fail: true }), 'POST', `${D_}/`);
    const staged = database().prepare("SELECT storage_key FROM family_documents WHERE name = 'Weg'").get().storage_key;
    assert.equal(fs.existsSync(path.join(dir, staged)), false, 'the staged file was cleaned up');
  } finally {
    delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  }
  // DELETE /documents/{id}: the lock goes with the error.
  const doc = await created('/documents', DOC({ name: 'Loeschen' }));
  assertCentral(await call('DELETE', `/documents/${doc}`, NO_BODY, { fail: true }), 'DELETE', `${D_}/:id`);
  assert.equal(deletionLock.documentDeleteIsActive(doc), false, 'the document lock is released');
  // DELETE /documents/folders/{id}?documents=delete: folder and document locks go with it.
  const folder = await created('/documents/folders', { name: 'Zweig' });
  const inside = await created('/documents', DOC({ name: 'Im Zweig', folder_id: folder }));
  const snapshot = /** @type {any} */ ((await call('GET', `/documents/folders/${folder}/delete-impact`, NO_BODY)).body).data.snapshot;
  assertCentral(await call('DELETE', `/documents/folders/${folder}?documents=delete&expected_snapshot=${snapshot}`, NO_BODY, { fail: true }), 'DELETE', `${D_}/folders/:id`);
  assert.equal(deletionLock.documentDeleteIsActive(inside), false, 'the document lock is released');
  assert.deepEqual(await call('POST', '/documents/folders', { name: 'Kind', parent_id: folder }), EXPECTED['f create parent gone'], 'the folder lock is released (no 409)');
});

/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {string} file the router module under server/routes/
 * @param {string} method lower case
 * @param {string} routePath the Express pattern of the router
 */
async function bareHandler(file, method, routePath) {
  const { default: router } = await import(`../server/routes/${file}`);
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath} in ${file}`);
}

/**
 * Runs a bare handler with a raw body and params as the admin; returns its answer.
 * @param {string} file
 * @param {string} method
 * @param {string} routePath
 * @param {{ body?: unknown, params?: Record<string, string> }} input
 */
async function callBare(file, method, routePath, { body = {}, params = {} }) {
  const handler = await bareHandler(file, method, routePath);
  const req = { method: method.toUpperCase(), body, query: {}, params, authUserId: ADMIN, authRole: 'admin', authScopes: null, session: { userId: ADMIN, role: 'admin' } };
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
// a loop, `.length`, a string method, a date computation or a binding runs
// over the raw value, so the handler keeps its own type check there (sink,
// not route; CodeQL js/loop-bound-injection in #2860): called without
// validateRequest(), each answers as it did instead of throwing or looping.
const sentence = (/** @type {string} */ error) => ({ error, code: 400 });
/** @type {{ list: string, item: string } | null} */
let sinkRows = null;
/** A list with one item of its own, made on first use, so each sink case also runs alone. */
function sink() {
  if (!sinkRows) {
    const list = Number(database().prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Senke', ?)").run(ADMIN).lastInsertRowid);
    const item = database().prepare("INSERT INTO shopping_items (list_id, name, category) VALUES (?, 'Senke', 'Sonstiges')").run(list).lastInsertRowid;
    sinkRows = { list: String(list), item: String(item) };
  }
  return sinkRows;
}

test('sink: the category and item reorder keep their list check', async () => {
  for (const order of ['x', { length: 1e9 }, 5]) {
    assert.deepEqual(await callBare('shopping.js', 'patch', '/categories/reorder', { body: { order } }),
      { status: 400, body: sentence('order must be a non-empty array of ids.') }, `categories ${JSON.stringify(order)}`);
    assert.deepEqual(await callBare('shopping.js', 'patch', '/:listId/items/reorder', { body: { category: 'Sonstiges', order }, params: { listId: sink().list } }),
      { status: 400, body: sentence('order must be a non-empty array of ids.') }, `items ${JSON.stringify(order)}`);
  }
});

test('sink: undo-transfer, the ticked clean-up and the pantry import keep their list checks', async () => {
  for (const raw of ['x', { length: 1e9 }]) {
    assert.deepEqual((await callBare('shopping.js', 'post', '/items/undo-transfer', { body: { ids: raw, ingredient_ids: raw } })).body, { data: { removed: 0 } }, `undo ${JSON.stringify(raw)}`);
    assert.deepEqual((await callBare('shopping.js', 'delete', '/:listId/items/checked', { body: { ids: raw }, params: { listId: sink().list } })).body,
      sentence('ids must be a non-empty array of item ids.'), `checked ${JSON.stringify(raw)}`);
    assert.deepEqual((await callBare('shopping.js', 'post', '/:listId/import-pantry', { body: { items: raw }, params: { listId: sink().list } })).body,
      { data: { added: 0, skipped: 0, added_ids: [] } }, `pantry ${JSON.stringify(raw)}`);
  }
  assert.deepEqual((await callBare('shopping.js', 'delete', '/:listId/items/checked', { body: { ids: [{}] }, params: { listId: sink().list } })).body,
    sentence('ids may only contain item ids.'));
});

test('sink: an item keeps the checks in front of name.trim() and of the price, shop and list it binds', async () => {
  const item = sink().item;
  const patch = (/** @type {unknown} */ body) => callBare('shopping.js', 'patch', '/items/:itemId', { body, params: { itemId: item } });
  assert.deepEqual((await patch({ name: 5 })).body, sentence('name must be text.'));
  assert.deepEqual((await patch({ price_cents: 'x' })).body, sentence('price_cents must be a whole number of cents from 0 to 100000000.'));
  assert.deepEqual((await patch({ store_id: true })).body, sentence('store_id must be a store id.'));
  assert.deepEqual((await patch({ list_id: {} })).body, sentence('list_id must be a list id.'));
});

test('sink: send keeps its recipient check', async () => {
  for (const userId of ['x', { length: 1 }, -1]) {
    assert.deepEqual((await callBare('shopping.js', 'post', '/:listId/send', { body: { userId }, params: { listId: sink().list } })).body,
      sentence('A recipient userId is required.'), `userId ${JSON.stringify(userId)}`);
  }
});

test('sink: a document keeps its access list check and the reminder days in front of the date computation', async () => {
  const doc = await created('/documents', DOC({ name: 'Senke', expires_at: '2027-03-01' }));
  const put = (/** @type {unknown} */ body) => callBare('documents.js', 'put', '/:id', { body, params: { id: String(doc) } });
  const access = await put({ visibility: 'restricted', allowed_member_ids: { length: 1e9 } });
  assert.equal(access.status, 200);
  assert.deepEqual(/** @type {any} */ (access.body).data.allowed_member_ids, []);
  assert.deepEqual((await put({ expiry_reminder_days: { length: 1 } })).body, sentence('Reminder lead time must be a valid number.'));
  assert.deepEqual((await put({ expiry_reminder_days: 1e9 })).body, sentence('Reminder lead time must be an integer between 0 and 365.'));
});
