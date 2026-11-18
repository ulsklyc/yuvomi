/**
 * Test: the answers of the six small modules of group 1B stay byte-equal (#2810, phase 2 section E)
 * Purpose: family, people (avatar), search, kitchen, screensaver and displays
 *          dropped the hand checks the schema of their operation already
 *          covers (`validateRequest()` runs before every handler since #2821)
 *          and the try/catch blocks that answered an unexpected error with a
 *          500 of their own. That is a pure refactor, and this suite holds it:
 *          for a table of requests per route - valid, every refusal of the
 *          handler that stays, every refusal of the schema that replaced a
 *          hand check, not found, gated, conflict - it pins status and the
 *          WHOLE answer body. The expectations were written at the state
 *          before the refactor (1fce99e06) and are literal here, no fixture
 *          file, no update mode. Only values that follow a clock this suite
 *          does not hold (SQLite's own `now`) or chance (a pairing code) are
 *          replaced by a marker before the comparison.
 *
 *          The clock stands still (`mock.timers`, 18.11.2026 12:00 UTC) and the
 *          household lives in Europe/Berlin (`household_timezone`): without it
 *          "today" follows the process TZ, and from UTC+12 on noon UTC is
 *          already the next day. Immich is a stub behind `fetch`.
 *
 *          The second part: an unexpected error in each file reaches the
 *          central error handler - 500 with its fixed sentence and its log line
 *          `Unhandled error: <METHOD> <pattern> -> 500` - and the process keeps
 *          answering. What stays the route's own: the 502 answers of the
 *          screensaver, and the 500 of the pairing route when the session
 *          cannot be destroyed (a store callback, which the central handler
 *          does not reach by itself).
 * Run: npm run test:small-modules-b-answers
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// The pairing limiter allows 5 attempts a minute; this suite sends more.
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000';
for (const key of ['IMMICH_URL', 'IMMICH_API_KEY', 'IMMICH_SCREENSAVER_ALBUM_ID']) delete process.env[key];

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: familyRouter } = await import('../server/routes/family.js');
const { default: peopleAvatarRouter } = await import('../server/routes/people.js');
const { default: searchRouter } = await import('../server/routes/search.js');
const { default: kitchenRouter } = await import('../server/routes/kitchen.js');
const { default: screensaverRouter } = await import('../server/routes/screensaver.js');
const { default: displaysRouter, pairingRouter, peopleRouter: displayPeopleRouter } = await import('../server/routes/displays.js');
const { issuePairingCode } = await import('../server/services/display-accounts.js');
const { defaultEmptyBody } = await import('../server/middleware/empty-body.js');
const { createErrorHandler } = await import('../server/middleware/error-handler.js');
const db = dbmod.get();

db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('disabled_modules', '[]')").run();
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T12:00:00Z') });

/**
 * @param {string} username
 * @param {string} role
 * @param {string} familyRole
 */
function user(username, role, familyRole) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', ?, ?)
  `).run(username, username, role, familyRole).lastInsertRowid);
}

const ADMIN = user('linda', 'admin', 'mom');
const MEMBER = user('tom', 'member', 'dad');

// ── Immich behind fetch: the suite's own requests go through the real one ──

const realFetch = globalThis.fetch;
const IMMICH = 'https://photos.example';
const PHOTO = '0b4f5b2e-6f1a-4c3d-9e8f-1a2b3c4d5e6f';
const PHOTO2 = '2d6b7c4a-8b3c-4e5f-a0b1-3c4d5e6f7081';
const ALBUM = '1c5a6b3f-7a2b-4d4e-8f9a-2b3c4d5e6f70';
const immich = { mode: 'ok' };
/**
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 */
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(IMMICH)) return realFetch(input, init);
  if (immich.mode === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  if (immich.mode === 'refused') return new Response('{}', { status: 401 });
  if (immich.mode === 'http') return new Response('{}', { status: 503 });
  if (url.endsWith('/search/random')) {
    return Response.json([
      { id: PHOTO, localDateTime: '2026-06-01T10:00:00', exifInfo: { city: 'Berlin', country: 'Germany' } },
      { id: 'not-a-uuid' },
      { id: PHOTO2, fileCreatedAt: '2025-01-02T03:04:05Z' },
    ]);
  }
  if (immich.mode === 'text') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
};

/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = {
  warn: (/** @type {string} */ line) => { logged.warn.push(line); },
  error: (/** @type {string} */ line) => { logged.error.push(line); },
};

const sessionState = { failDestroy: false };
const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
// The session middleware: every request has one, as in server/index.js. Its
// destroy() calls back the way the app's store does (SqliteStore in
// server/auth.js): synchronously, inside a try whose catch calls back a second
// time with the error - so a throw from the callback never reaches Express.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  req.session = {
    destroy: (/** @type {(err?: unknown) => void} */ done) => {
      try {
        if (sessionState.failDestroy) throw new Error('store is gone');
        done(null);
      } catch (err) {
        done(err);
      }
    },
  };
  next();
});
// Before the sign-in, as in server/index.js.
app.use('/api/v1/displays', pairingRouter);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const actor = req.get('x-actor');
  const id = actor === 'member' ? MEMBER : ADMIN;
  req.authUserId = id;
  req.authRole = actor === 'member' ? 'member' : 'admin';
  req.authMethod = actor === 'display' ? 'display' : 'session';
  req.session.userId = id;
  req.session.role = req.authRole;
  req.sessionModuleAccess = actor === 'member' ? { shopping: 'none', tasks: 'none' } : null;
  next();
});
// The order of server/index.js.
app.use('/api/v1/kitchen', kitchenRouter);
app.use('/api/v1/screensaver', screensaverRouter);
app.use('/api/v1/search', searchRouter);
app.use('/api/v1/family', familyRouter);
app.use('/api/v1/people', peopleAvatarRouter);
app.use('/api/v1/displays', displayPeopleRouter);
app.use('/api/v1/displays', displaysRouter);
app.use(createErrorHandler(log));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const NO_BODY = Symbol('no body');

/**
 * @typedef {{ actor?: 'member' | 'display', raw?: boolean }} CallOptions
 */

/**
 * A JSON answer as it is; anything else as its type and length.
 * @param {string} method
 * @param {string} path
 * @param {unknown} body a JSON value, raw JSON text (`raw`) or NO_BODY
 * @param {CallOptions} [opts]
 */
async function call(method, path, body, { actor, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== NO_BODY) headers['Content-Type'] = 'application/json';
  if (actor) headers['x-actor'] = actor;
  const res = await realFetch(`${baseUrl}/api/v1${path}`, {
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
const VOLATILE = new Set(['created_at', 'updated_at']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (VOLATILE.has(key) && v !== null) return '<clock>';
    // A pairing code is chance; the numeric `code` of an error body stays.
    if (key === 'code' && typeof v === 'string') return '<code>';
    return v;
  });
}

// ── Seed: the database starts empty, so every id below is the same on every run ──

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64')}`;
db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(JPEG, ADMIN);
const KEY = db.prepare('SELECT avatar_key FROM users WHERE id = ?').get(ADMIN).avatar_key;
// The key is random: the rows below use it by name, the answers do not carry it.
const OTHER_KEY = String(KEY).replace(/^./, (/** @type {string} */ c) => (c === '0' ? '1' : '0'));
db.prepare("INSERT INTO contacts (name, category, phone, family_user_id) VALUES ('Linda', 'Familie', '0301234', ?)").run(ADMIN);
const LIST = Number(db.prepare("INSERT INTO shopping_lists (name, created_by) VALUES ('Wocheneinkauf', ?)").run(ADMIN).lastInsertRowid);
db.prepare("INSERT INTO shopping_items (list_id, name) VALUES (?, 'Milch')").run(LIST);
db.prepare("INSERT INTO shopping_items (list_id, name, is_checked) VALUES (?, 'Brot', 1)").run(LIST);
db.prepare("INSERT INTO tasks (title, category, status, created_by) VALUES ('Milch kaufen', 'Sonstiges', 'open', ?)").run(ADMIN);
db.prepare("INSERT INTO notes (title, content, created_by) VALUES ('Einkauf', 'Milchreis', ?)").run(ADMIN);
db.prepare("INSERT INTO pantry_items (name, quantity, expires_on) VALUES ('Joghurt', 1, '2026-11-18')").run();
db.prepare("INSERT INTO pantry_items (name, quantity, expires_on) VALUES ('Quark', 1, '2026-11-17')").run();
db.prepare("INSERT INTO pantry_items (name, quantity, min_quantity) VALUES ('Mehl', 1, 2)").run();

const DEVICE_SETTINGS = { night_from: 22, night_until: 6, idle_seconds: 300, show_clock: true, cover_photo: false };
const HUGE = '9'.repeat(400);

/** A pairing code for display `id`, in the grouping a person types. */
const codeFor = (/** @type {number} */ id) => issuePairingCode(id, ADMIN).code.replace(/^(.{5})/, '$1-');

/**
 * One request of the table: [name, method, path, body, opts?]. Setup rows are
 * functions; a body that is a function is called when its row runs.
 * @type {Array<[string, string, string, unknown, CallOptions?] | (() => void)>}
 */
const STEPS = [
  // ── family ────────────────────────────────────────────────────────────────
  ['fam members', 'GET', '/family/members', NO_BODY],
  ['fam members extra query', 'GET', '/family/members?x=1', NO_BODY],
  ['fam members member', 'GET', '/family/members', NO_BODY, { actor: 'member' }],
  ['fam reorder', 'PATCH', '/family/members/reorder', { order: [MEMBER, ADMIN] }],
  ['fam reorder back 1.0', 'PATCH', '/family/members/reorder', `{"order":[${ADMIN}.0,${MEMBER}],"note":"x"}`, { raw: true }],
  ['fam reorder member', 'PATCH', '/family/members/reorder', { order: [ADMIN, MEMBER] }, { actor: 'member' }],
  ['fam reorder member junk', 'PATCH', '/family/members/reorder', { order: 'x' }, { actor: 'member' }],
  ['fam reorder no body', 'PATCH', '/family/members/reorder', NO_BODY],
  ['fam reorder empty object', 'PATCH', '/family/members/reorder', {}],
  ['fam reorder null', 'PATCH', '/family/members/reorder', { order: null }],
  ['fam reorder text', 'PATCH', '/family/members/reorder', { order: 'x' }],
  ['fam reorder empty', 'PATCH', '/family/members/reorder', { order: [] }],
  ['fam reorder string id', 'PATCH', '/family/members/reorder', { order: [ADMIN, String(MEMBER)] }],
  ['fam reorder fraction', 'PATCH', '/family/members/reorder', { order: [ADMIN, 1.5] }],
  ['fam reorder zero', 'PATCH', '/family/members/reorder', { order: [ADMIN, 0] }],
  ['fam reorder negative', 'PATCH', '/family/members/reorder', { order: [ADMIN, -2] }],
  ['fam reorder repeat', 'PATCH', '/family/members/reorder', { order: [ADMIN, MEMBER, ADMIN] }],
  ['fam reorder array body', 'PATCH', '/family/members/reorder', []],
  ['fam reorder incomplete', 'PATCH', '/family/members/reorder', { order: [ADMIN] }],
  ['fam reorder stranger', 'PATCH', '/family/members/reorder', { order: [ADMIN, MEMBER, 999] }],

  // ── people (avatar) ───────────────────────────────────────────────────────
  ['avatar ok', 'GET', `/people/${ADMIN}/avatar?v=${KEY}`, NO_BODY],
  ['avatar leading zeros', 'GET', `/people/00${ADMIN}/avatar?v=${KEY}`, NO_BODY],
  ['avatar wrong key', 'GET', `/people/${ADMIN}/avatar?v=${OTHER_KEY}`, NO_BODY],
  ['avatar no picture', 'GET', `/people/${MEMBER}/avatar?v=${KEY}`, NO_BODY],
  ['avatar unknown', 'GET', `/people/999/avatar?v=${KEY}`, NO_BODY],
  ['avatar zero', 'GET', `/people/0/avatar?v=${KEY}`, NO_BODY],
  ['avatar huge', 'GET', `/people/${HUGE}/avatar?v=${KEY}`, NO_BODY],
  ['avatar negative', 'GET', `/people/-1/avatar?v=${KEY}`, NO_BODY],
  ['avatar minus zero', 'GET', `/people/-0/avatar?v=${KEY}`, NO_BODY],
  ['avatar plus', 'GET', `/people/+1/avatar?v=${KEY}`, NO_BODY],
  ['avatar letters', 'GET', `/people/abc/avatar?v=${KEY}`, NO_BODY],
  ['avatar decimal', 'GET', `/people/1.0/avatar?v=${KEY}`, NO_BODY],
  ['avatar exponent', 'GET', `/people/1e2/avatar?v=${KEY}`, NO_BODY],
  ['avatar no key', 'GET', `/people/${ADMIN}/avatar`, NO_BODY],
  ['avatar bad key', 'GET', `/people/${ADMIN}/avatar?v=abc`, NO_BODY],
  ['avatar key twice', 'GET', `/people/${ADMIN}/avatar?v=${KEY}&v=${KEY}`, NO_BODY],

  // ── search ────────────────────────────────────────────────────────────────
  ['search none', 'GET', '/search', NO_BODY],
  ['search empty', 'GET', '/search?q=', NO_BODY],
  ['search short', 'GET', '/search?q=m', NO_BODY],
  ['search spaces', 'GET', '/search?q=%20%20m%20', NO_BODY],
  ['search milch', 'GET', '/search?q=milch', NO_BODY],
  ['search milch member', 'GET', '/search?q=milch', NO_BODY, { actor: 'member' }],
  ['search nothing', 'GET', '/search?q=zebra', NO_BODY],
  ['search twice', 'GET', '/search?q=milch&q=brot', NO_BODY],

  // ── kitchen ───────────────────────────────────────────────────────────────
  ['kitchen none', 'GET', '/kitchen/summary', NO_BODY],
  ['kitchen empty', 'GET', '/kitchen/summary?today=', NO_BODY],
  ['kitchen today', 'GET', '/kitchen/summary?today=2026-11-18', NO_BODY],
  ['kitchen tomorrow', 'GET', '/kitchen/summary?today=2026-11-19', NO_BODY],
  ['kitchen no calendar', 'GET', '/kitchen/summary?today=2026-02-31', NO_BODY],
  ['kitchen member', 'GET', '/kitchen/summary?today=2026-11-19', NO_BODY, { actor: 'member' }],
  ['kitchen bad shape', 'GET', '/kitchen/summary?today=x', NO_BODY],
  ['kitchen with time', 'GET', '/kitchen/summary?today=2026-11-18T10:00', NO_BODY],
  ['kitchen twice', 'GET', '/kitchen/summary?today=2026-11-18&today=2026-11-19', NO_BODY],

  // ── screensaver ───────────────────────────────────────────────────────────
  ['ss config empty', 'GET', '/screensaver/config', NO_BODY],
  ['ss config member', 'GET', '/screensaver/config', NO_BODY, { actor: 'member' }],
  ['ss photos unconfigured', 'GET', '/screensaver/photos', NO_BODY],
  ['ss photo unconfigured', 'GET', `/screensaver/photos/${PHOTO}`, NO_BODY],
  ['ss photo unconfigured bad id', 'GET', '/screensaver/photos/not-a-uuid', NO_BODY],
  ['ss test unconfigured', 'POST', '/screensaver/test', {}],
  ['ss test member', 'POST', '/screensaver/test', {}, { actor: 'member' }],
  ['ss put member', 'PUT', '/screensaver/config', { url: 5 }, { actor: 'member' }],
  ['ss put no body', 'PUT', '/screensaver/config', NO_BODY],
  ['ss put array', 'PUT', '/screensaver/config', []],
  ['ss put url number', 'PUT', '/screensaver/config', { url: 5 }],
  ['ss put url null', 'PUT', '/screensaver/config', { url: null }],
  ['ss put url long', 'PUT', '/screensaver/config', { url: `https://${'a'.repeat(2041)}` }],
  ['ss put url scheme', 'PUT', '/screensaver/config', { url: 'photos.example' }],
  ['ss put album number', 'PUT', '/screensaver/config', { albumId: 5 }],
  ['ss put album word', 'PUT', '/screensaver/config', { albumId: 'alle-fotos' }],
  ['ss put album empty', 'PUT', '/screensaver/config', { albumId: '' }],
  ['ss put key long', 'PUT', '/screensaver/config', { apiKey: 'x'.repeat(1001) }],
  ['ss put key emoji', 'PUT', '/screensaver/config', { apiKey: '😀'.repeat(600) }],
  ['ss put key number', 'PUT', '/screensaver/config', { apiKey: 5 }],
  ['ss put clear text', 'PUT', '/screensaver/config', { clearApiKey: 'true' }],
  ['ss put empty', 'PUT', '/screensaver/config', {}],
  ['ss put all', 'PUT', '/screensaver/config', { url: `  ${IMMICH}//  `, albumId: ` ${ALBUM.toUpperCase()} `, apiKey: 'secret' }],
  ['ss config set', 'GET', '/screensaver/config', NO_BODY],
  ['ss test ok', 'POST', '/screensaver/test', {}],
  ['ss photos', 'GET', '/screensaver/photos', NO_BODY],
  ['ss photos display', 'GET', '/screensaver/photos', NO_BODY, { actor: 'display' }],
  ['ss photo', 'GET', `/screensaver/photos/${PHOTO}`, NO_BODY],
  ['ss photo upper', 'GET', `/screensaver/photos/${PHOTO.toUpperCase()}`, NO_BODY],
  ['ss photo bad id', 'GET', '/screensaver/photos/not-a-uuid', NO_BODY],
  ['ss photo digits', 'GET', '/screensaver/photos/5', NO_BODY],
  ['ss photo long', 'GET', `/screensaver/photos/${PHOTO}0`, NO_BODY],
  ['ss photo no dashes', 'GET', `/screensaver/photos/${PHOTO.replace(/-/g, '')}`, NO_BODY],
  ['ss photo version 9', 'GET', `/screensaver/photos/${PHOTO.replace('4c3d', '9c3d')}`, NO_BODY],
  ['ss photo variant c', 'GET', `/screensaver/photos/${PHOTO.replace('9e8f', 'ce8f')}`, NO_BODY],
  ['ss photo traversal', 'GET', '/screensaver/photos/..%2F..%2Fadmin', NO_BODY],
  ['ss photo newline', 'GET', `/screensaver/photos/${PHOTO}%0A`, NO_BODY],
  () => { immich.mode = 'text'; },
  ['ss photo not an image', 'GET', `/screensaver/photos/${PHOTO}`, NO_BODY],
  () => { immich.mode = 'refused'; },
  ['ss test refused', 'POST', '/screensaver/test', {}],
  () => { immich.mode = 'http'; },
  ['ss test http', 'POST', '/screensaver/test', {}],
  ['ss photos http', 'GET', '/screensaver/photos', NO_BODY],
  ['ss photo http', 'GET', `/screensaver/photos/${PHOTO}`, NO_BODY],
  () => { immich.mode = 'throw'; },
  ['ss test unreachable', 'POST', '/screensaver/test', {}],
  ['ss photos unreachable', 'GET', '/screensaver/photos', NO_BODY],
  ['ss photo unreachable', 'GET', `/screensaver/photos/${PHOTO}`, NO_BODY],
  () => { immich.mode = 'ok'; },
  ['ss put clear', 'PUT', '/screensaver/config', { url: '', albumId: '', clearApiKey: true, extra: 1 }],
  ['ss config cleared', 'GET', '/screensaver/config', NO_BODY],

  // ── displays ──────────────────────────────────────────────────────────────
  ['disp list empty', 'GET', '/displays', NO_BODY],
  ['disp list member', 'GET', '/displays', NO_BODY, { actor: 'member' }],
  ['disp create', 'POST', '/displays', { display_name: '  Küche  ', extra: 1 }],
  ['disp create second', 'POST', '/displays', { display_name: 'Flur' }],
  ['disp create member', 'POST', '/displays', { display_name: 5 }, { actor: 'member' }],
  ['disp create no body', 'POST', '/displays', NO_BODY],
  ['disp create no name', 'POST', '/displays', {}],
  ['disp create number', 'POST', '/displays', { display_name: 5 }],
  ['disp create null', 'POST', '/displays', { display_name: null }],
  ['disp create empty', 'POST', '/displays', { display_name: '' }],
  ['disp create spaces', 'POST', '/displays', { display_name: '   ' }],
  ['disp create long', 'POST', '/displays', { display_name: `${'x'.repeat(128)}   ` }],
  ['disp create emoji', 'POST', '/displays', { display_name: '😀'.repeat(100) }],
  ['disp patch screensaver', 'PATCH', '/displays/3', { show_screensaver: true }],
  ['disp patch settings', 'PATCH', '/displays/3', { device_settings: DEVICE_SETTINGS }],
  ['disp patch both', 'PATCH', '/displays/4', { device_settings: { ...DEVICE_SETTINGS, show_clock: false }, show_screensaver: false }],
  ['disp patch member', 'PATCH', '/displays/12abc', [], { actor: 'member' }],
  ['disp patch no body', 'PATCH', '/displays/3', NO_BODY],
  ['disp patch empty', 'PATCH', '/displays/3', {}],
  ['disp patch other key', 'PATCH', '/displays/3', { other: 1 }],
  ['disp patch text bool', 'PATCH', '/displays/3', { show_screensaver: 'false' }],
  ['disp patch number bool', 'PATCH', '/displays/3', { show_screensaver: 1 }],
  ['disp patch null bool', 'PATCH', '/displays/3', { show_screensaver: null }],
  ['disp patch settings null', 'PATCH', '/displays/3', { device_settings: null }],
  ['disp patch settings and text bool', 'PATCH', '/displays/3', { device_settings: DEVICE_SETTINGS, show_screensaver: 'x' }],
  ['disp patch settings incomplete', 'PATCH', '/displays/3', { device_settings: {} }],
  ['disp patch idle step', 'PATCH', '/displays/3', { device_settings: { ...DEVICE_SETTINGS, idle_seconds: 301 } }],
  ['disp patch hour 24', 'PATCH', '/displays/3', { device_settings: { ...DEVICE_SETTINGS, night_from: 24 } }],
  ['disp patch extra setting', 'PATCH', '/displays/3', { device_settings: { ...DEVICE_SETTINGS, x: 1 } }],
  ['disp patch equal hours', 'PATCH', '/displays/3', { device_settings: { ...DEVICE_SETTINGS, night_until: 22 } }],
  ['disp patch unknown', 'PATCH', '/displays/999', { show_screensaver: true }],
  ['disp patch unknown bad body', 'PATCH', '/displays/999', { show_screensaver: 'true' }],
  ['disp patch zero', 'PATCH', '/displays/0', { show_screensaver: true }],
  ['disp patch negative', 'PATCH', '/displays/-3', { show_screensaver: true }],
  ['disp patch huge', 'PATCH', `/displays/${HUGE}`, { show_screensaver: true }],
  ['disp patch twenty digits', 'PATCH', `/displays/${'9'.repeat(20)}`, { show_screensaver: true }],
  ['disp patch decimal', 'PATCH', '/displays/5.0', { show_screensaver: true }],
  ['disp patch exponent', 'PATCH', '/displays/1e2', { show_screensaver: true }],
  ['disp patch hex', 'PATCH', '/displays/0x10', { show_screensaver: true }],
  ['disp patch letters', 'PATCH', '/displays/12abc', { show_screensaver: true }],
  ['disp list', 'GET', '/displays', NO_BODY],
  ['disp code', 'POST', '/displays/3/pairing-code', {}],
  ['disp code no body', 'POST', '/displays/3/pairing-code', NO_BODY],
  ['disp code unknown', 'POST', '/displays/999/pairing-code', {}],
  ['disp code person', 'POST', `/displays/${ADMIN}/pairing-code`, {}],
  ['disp code huge', 'POST', `/displays/${HUGE}/pairing-code`, {}],
  ['disp code decimal', 'POST', '/displays/3.0/pairing-code', {}],
  ['disp code member', 'POST', '/displays/3/pairing-code', {}, { actor: 'member' }],
  ['pair no body', 'POST', '/displays/pair', NO_BODY],
  ['pair no code', 'POST', '/displays/pair', {}],
  ['pair number', 'POST', '/displays/pair', { code: 1234567890 }],
  ['pair array', 'POST', '/displays/pair', { code: ['ABCDEFGHJK'] }],
  ['pair label number', 'POST', '/displays/pair', { code: 'ABCDEFGHJK', label: 5 }],
  ['pair label long', 'POST', '/displays/pair', { code: 'ABCDEFGHJK', label: 'x'.repeat(121) }],
  ['pair empty', 'POST', '/displays/pair', { code: '' }],
  ['pair wrong', 'POST', '/displays/pair', { code: 'ABCDEFGHJK' }],
  ['pair ok', 'POST', '/displays/pair', () => ({ code: codeFor(3), label: '  Küchentablett ' })],
  ['pair ok null label', 'POST', '/displays/pair', () => ({ code: codeFor(3), label: null })],
  ['pair ok emoji label', 'POST', '/displays/pair', () => ({ code: codeFor(4), label: '😀'.repeat(100) })],
  ['disp list paired', 'GET', '/displays', NO_BODY],
  ['disp revoke', 'POST', '/displays/3/devices/2/revoke', {}],
  ['disp revoke again', 'POST', '/displays/3/devices/2/revoke', {}],
  ['disp revoke other display', 'POST', '/displays/4/devices/2/revoke', {}],
  ['disp revoke unknown', 'POST', '/displays/3/devices/999/revoke', {}],
  ['disp revoke huge', 'POST', `/displays/3/devices/${HUGE}/revoke`, {}],
  ['disp revoke huge display', 'POST', `/displays/${HUGE}/devices/2/revoke`, {}],
  ['disp revoke decimal', 'POST', '/displays/3/devices/2.0/revoke', {}],
  ['disp revoke member', 'POST', '/displays/3/devices/2/revoke', {}, { actor: 'member' }],
  ['disp remove active', 'POST', '/displays/4/devices/3/remove', {}],
  ['disp remove', 'POST', '/displays/3/devices/2/remove', {}],
  ['disp remove again', 'POST', '/displays/3/devices/2/remove', {}],
  ['disp remove huge', 'POST', `/displays/3/devices/${HUGE}/remove`, {}],
  ['disp remove letters', 'POST', '/displays/abc/devices/2/remove', {}],
  ['disp people session', 'GET', '/displays/people', NO_BODY],
  ['disp people display', 'GET', '/displays/people', NO_BODY, { actor: 'display' }],
  ['disp delete', 'DELETE', '/displays/4', NO_BODY],
  ['disp delete again', 'DELETE', '/displays/4', NO_BODY],
  ['disp delete person', 'DELETE', `/displays/${MEMBER}`, NO_BODY],
  ['disp delete negative', 'DELETE', '/displays/-3', NO_BODY],
  ['disp delete huge', 'DELETE', `/displays/${HUGE}`, NO_BODY],
  ['disp delete exponent', 'DELETE', '/displays/1e2', NO_BODY],
  ['disp delete member', 'DELETE', '/displays/3', NO_BODY, { actor: 'member' }],
  ['disp list end', 'GET', '/displays', NO_BODY],
];

/** @type {Record<string, { status: number, body: unknown }>} */
const EXPECTED = {
  "fam members": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","family_role":"mom","phone":"0301234","email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"dad","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null}]}},
  "fam members extra query": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","family_role":"mom","phone":"0301234","email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"dad","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null}]}},
  "fam members member": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","family_role":"mom","phone":"0301234","email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"dad","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":null}]}},
  "fam reorder": {"status":200,"body":{"data":[{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"dad","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":1},{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","family_role":"mom","phone":"0301234","email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":2}]}},
  "fam reorder back 1.0": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","family_role":"mom","phone":"0301234","email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":1},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"family_role":"dad","phone":null,"email":null,"birth_date":null,"birth_year_unknown":false,"created_at":"<clock>","sort_order":2}]}},
  "fam reorder member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "fam reorder member junk": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "fam reorder no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body","rule":"required","reason":"invalid_order"}]}},
  "fam reorder empty object": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order","rule":"required","reason":"invalid_order"}]}},
  "fam reorder null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order","rule":"type","reason":"invalid_order"}]}},
  "fam reorder text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order","rule":"type","reason":"invalid_order"}]}},
  "fam reorder empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order","rule":"minItems","reason":"invalid_order"}]}},
  "fam reorder string id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order/1","rule":"type","reason":"invalid_order"}]}},
  "fam reorder fraction": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order/1","rule":"type","reason":"invalid_order"}]}},
  "fam reorder zero": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order/1","rule":"minimum","reason":"invalid_order"}]}},
  "fam reorder negative": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body/order/1","rule":"minimum","reason":"invalid_order"}]}},
  "fam reorder repeat": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"duplicate_member","fields":[{"path":"body/order","rule":"uniqueItems","reason":"duplicate_member"}]}},
  "fam reorder array body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"invalid_order","fields":[{"path":"body","rule":"type","reason":"invalid_order"}]}},
  "fam reorder incomplete": {"status":400,"body":{"error":"The order must list every household member - user 2 is missing.","code":400,"reason":"incomplete_order"}},
  "fam reorder stranger": {"status":400,"body":{"error":"Only household members have a place in the member order - user 999 is not a household member.","code":400,"reason":"not_a_household_member"}},
  "avatar ok": {"status":200,"body":{"type":"image/jpeg","length":9}},
  "avatar leading zeros": {"status":200,"body":{"type":"image/jpeg","length":9}},
  "avatar wrong key": {"status":404,"body":{"error":"No picture for this person.","code":404}},
  "avatar no picture": {"status":404,"body":{"error":"No picture for this person.","code":404}},
  "avatar unknown": {"status":404,"body":{"error":"No picture for this person.","code":404}},
  "avatar zero": {"status":404,"body":{"error":"No picture for this person.","code":404}},
  "avatar huge": {"status":404,"body":{"error":"No picture for this person.","code":404}},
  "avatar negative": {"status":400,"body":{"error":"Invalid person ID.","code":400}},
  "avatar minus zero": {"status":400,"body":{"error":"Invalid person ID.","code":400}},
  "avatar plus": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "avatar letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "avatar decimal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "avatar exponent": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "avatar no key": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/v","rule":"required"}]}},
  "avatar bad key": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/v","rule":"pattern"}]}},
  "avatar key twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/v","rule":"type"}]}},
  "search none": {"status":200,"body":{"tasks":[],"events":[],"notes":[],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search empty": {"status":200,"body":{"tasks":[],"events":[],"notes":[],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search short": {"status":200,"body":{"tasks":[],"events":[],"notes":[],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search spaces": {"status":200,"body":{"tasks":[],"events":[],"notes":[],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search milch": {"status":200,"body":{"tasks":[{"id":1,"title":"Milch kaufen","status":"open","priority":"none","due_date":null,"archived_at":null}],"events":[],"notes":[{"id":1,"title":"Einkauf","content":"Milchreis","excerpt":"Milchreis"}],"contacts":[],"items":[{"id":1,"title":"Milch","list_id":1}],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search milch member": {"status":200,"body":{"tasks":[],"events":[],"notes":[{"id":1,"title":"Einkauf","content":"Milchreis","excerpt":"Milchreis"}],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search nothing": {"status":200,"body":{"tasks":[],"events":[],"notes":[],"contacts":[],"items":[],"meds":[],"activities":[],"waste":[],"recipes":[],"pantry":[],"inventory":[],"documents":[],"birthdays":[],"budget":[]}},
  "search twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/q","rule":"type"}]}},
  "kitchen none": {"status":200,"body":{"data":{"shopping":{"open":1},"pantry":{"attention":2,"expired":1,"low":1,"out":0}}}},
  "kitchen empty": {"status":200,"body":{"data":{"shopping":{"open":1},"pantry":{"attention":2,"expired":1,"low":1,"out":0}}}},
  "kitchen today": {"status":200,"body":{"data":{"shopping":{"open":1},"pantry":{"attention":2,"expired":1,"low":1,"out":0}}}},
  "kitchen tomorrow": {"status":200,"body":{"data":{"shopping":{"open":1},"pantry":{"attention":3,"expired":2,"low":1,"out":0}}}},
  "kitchen no calendar": {"status":200,"body":{"data":{"shopping":{"open":1},"pantry":{"attention":1,"expired":0,"low":1,"out":0}}}},
  "kitchen member": {"status":200,"body":{"data":{"shopping":{"open":0},"pantry":{"attention":3,"expired":2,"low":1,"out":0}}}},
  "kitchen bad shape": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/today","rule":"pattern"}]}},
  "kitchen with time": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/today","rule":"pattern"}]}},
  "kitchen twice": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"query/today","rule":"type"}]}},
  "ss config empty": {"status":200,"body":{"data":{"url":"","albumId":"","apiKeySet":false,"enabled":false,"envControlled":{"url":false,"apiKey":false,"albumId":false}}}},
  "ss config member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "ss photos unconfigured": {"status":200,"body":{"data":{"enabled":false,"photos":[]}}},
  "ss photo unconfigured": {"status":404,"body":null},
  "ss photo unconfigured bad id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss test unconfigured": {"status":400,"body":{"error":"Immich is not configured.","code":400,"reason":"immich_not_configured"}},
  "ss test member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "ss put member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "ss put no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "ss put array": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"type"}]}},
  "ss put url number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"immich_url_invalid","fields":[{"path":"body/url","rule":"type","reason":"immich_url_invalid"}]}},
  "ss put url null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"immich_url_invalid","fields":[{"path":"body/url","rule":"type","reason":"immich_url_invalid"}]}},
  "ss put url long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"immich_url_invalid","fields":[{"path":"body/url","rule":"maxLength","reason":"immich_url_invalid"}]}},
  "ss put url scheme": {"status":400,"body":{"error":"Invalid Immich URL.","code":400,"reason":"immich_url_invalid"}},
  "ss put album number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"immich_album_id_invalid","fields":[{"path":"body/albumId","rule":"type","reason":"immich_album_id_invalid"}]}},
  "ss put album word": {"status":400,"body":{"error":"Invalid album ID.","code":400,"reason":"immich_album_id_invalid"}},
  "ss put album empty": {"status":200,"body":{"data":{"enabled":false,"apiKeySet":false}}},
  "ss put key long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"immich_api_key_invalid","fields":[{"path":"body/apiKey","rule":"maxLength","reason":"immich_api_key_invalid"}]}},
  "ss put key emoji": {"status":400,"body":{"error":"Invalid API key.","code":400,"reason":"immich_api_key_invalid"}},
  "ss put key number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/apiKey","rule":"type"}]}},
  "ss put clear text": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/clearApiKey","rule":"type"}]}},
  "ss put empty": {"status":200,"body":{"data":{"enabled":false,"apiKeySet":false}}},
  "ss put all": {"status":200,"body":{"data":{"enabled":true,"apiKeySet":true}}},
  "ss config set": {"status":200,"body":{"data":{"url":"https://photos.example","albumId":"1C5A6B3F-7A2B-4D4E-8F9A-2B3C4D5E6F70","apiKeySet":true,"enabled":true,"envControlled":{"url":false,"apiKey":false,"albumId":false}}}},
  "ss test ok": {"status":200,"body":{"data":{"ok":true,"photoCount":3}}},
  "ss photos": {"status":200,"body":{"data":{"enabled":true,"photos":[{"id":"0b4f5b2e-6f1a-4c3d-9e8f-1a2b3c4d5e6f","takenAt":"2026-06-01T10:00:00","city":"Berlin","country":"Germany"},{"id":"2d6b7c4a-8b3c-4e5f-a0b1-3c4d5e6f7081","takenAt":"2025-01-02T03:04:05Z","city":null,"country":null}]}}},
  "ss photos display": {"status":200,"body":{"data":{"enabled":true,"photos":[{"id":"0b4f5b2e-6f1a-4c3d-9e8f-1a2b3c4d5e6f","takenAt":"2026-06-01T10:00:00","city":"Berlin","country":"Germany"},{"id":"2d6b7c4a-8b3c-4e5f-a0b1-3c4d5e6f7081","takenAt":"2025-01-02T03:04:05Z","city":null,"country":null}]}}},
  "ss photo": {"status":200,"body":{"type":"image/jpeg","length":4}},
  "ss photo upper": {"status":200,"body":{"type":"image/jpeg","length":4}},
  "ss photo bad id": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo digits": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo no dashes": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo version 9": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo variant c": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo traversal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo newline": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"pattern"}]}},
  "ss photo not an image": {"status":502,"body":null},
  "ss test refused": {"status":502,"body":{"error":"Immich refused the API key.","code":502,"reason":"immich_api_key_rejected"}},
  "ss test http": {"status":502,"body":{"error":"Immich returned 503.","code":502,"reason":"immich_http_status","params":{"status":503}}},
  "ss photos http": {"status":502,"body":{"error":"Immich is unavailable.","code":502}},
  "ss photo http": {"status":502,"body":null},
  "ss test unreachable": {"status":502,"body":{"error":"Could not connect to Immich.","code":502,"reason":"immich_unreachable"}},
  "ss photos unreachable": {"status":502,"body":{"error":"Immich is unavailable.","code":502}},
  "ss photo unreachable": {"status":502,"body":null},
  "ss put clear": {"status":200,"body":{"data":{"enabled":false,"apiKeySet":false}}},
  "ss config cleared": {"status":200,"body":{"data":{"url":"","albumId":"","apiKeySet":false,"enabled":false,"envControlled":{"url":false,"apiKey":false,"albumId":false}}}},
  "disp list empty": {"status":200,"body":{"data":[],"area_modules":["calendar","tasks","rewards","weather"]}},
  "disp list member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "disp create": {"status":201,"body":{"data":{"id":3,"display_name":"Küche","show_screensaver":false,"device_settings":null,"devices":[]}}},
  "disp create second": {"status":201,"body":{"data":{"id":4,"display_name":"Flur","show_screensaver":false,"device_settings":null,"devices":[]}}},
  "disp create member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "disp create no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "disp create no name": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"required"}]}},
  "disp create number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"type"}]}},
  "disp create null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"type"}]}},
  "disp create empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"minLength"}]}},
  "disp create spaces": {"status":400,"body":{"error":"A display name is required.","code":400}},
  "disp create long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/display_name","rule":"maxLength"}]}},
  "disp create emoji": {"status":400,"body":{"error":"A display name is required.","code":400}},
  "disp patch screensaver": {"status":200,"body":{"data":{"id":3,"show_screensaver":true}}},
  "disp patch settings": {"status":200,"body":{"data":{"id":3,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":true,"cover_photo":false}}}},
  "disp patch both": {"status":200,"body":{"data":{"id":4,"show_screensaver":false,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":false,"cover_photo":false}}}},
  "disp patch member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "disp patch no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "disp patch empty": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"required"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch other key": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"required"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch text bool": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"type"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch number bool": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"type"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch null bool": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"type"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch settings null": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"required"},{"path":"body/device_settings","rule":"type"},{"path":"body","rule":"anyOf"}]}},
  "disp patch settings and text bool": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"type"}]}},
  "disp patch settings incomplete": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/device_settings/night_from","rule":"required"}]}},
  "disp patch idle step": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/device_settings/idle_seconds","rule":"enum"}]}},
  "disp patch hour 24": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/device_settings/night_from","rule":"maximum"}]}},
  "disp patch extra setting": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/device_settings","rule":"additionalProperties"}]}},
  "disp patch equal hours": {"status":400,"body":{"error":"Invalid device_settings.","code":400}},
  "disp patch unknown": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp patch unknown bad body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/show_screensaver","rule":"type"},{"path":"body/device_settings","rule":"required"},{"path":"body","rule":"anyOf"}]}},
  "disp patch zero": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp patch negative": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp patch huge": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp patch twenty digits": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp patch decimal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp patch exponent": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp patch hex": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp patch letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp list": {"status":200,"body":{"data":[{"id":4,"display_name":"Flur","avatar_color":"#007AFF","created_at":"<clock>","show_screensaver":false,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":false,"cover_photo":false},"devices":[]},{"id":3,"display_name":"Küche","avatar_color":"#007AFF","created_at":"<clock>","show_screensaver":true,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":true,"cover_photo":false},"devices":[]}],"area_modules":["calendar","tasks","rewards","weather"]}},
  "disp code": {"status":201,"body":{"data":{"code":"<code>","expires_at":"2026-11-18T12:15:00Z"}}},
  "disp code no body": {"status":201,"body":{"data":{"code":"<code>","expires_at":"2026-11-18T12:15:00Z"}}},
  "disp code unknown": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp code person": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp code huge": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp code decimal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp code member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "pair no body": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body","rule":"required"}]}},
  "pair no code": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/code","rule":"required"}]}},
  "pair number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/code","rule":"type"}]}},
  "pair array": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/code","rule":"type"}]}},
  "pair label number": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/label","rule":"type"}]}},
  "pair label long": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"body/label","rule":"maxLength"}]}},
  "pair empty": {"status":400,"body":{"error":"This pairing code is not valid.","code":400}},
  "pair wrong": {"status":400,"body":{"error":"This pairing code is not valid.","code":400}},
  "pair ok": {"status":201,"body":{"data":{"paired":true}}},
  "pair ok null label": {"status":201,"body":{"data":{"paired":true}}},
  "pair ok emoji label": {"status":201,"body":{"data":{"paired":true}}},
  "disp list paired": {"status":200,"body":{"data":[{"id":4,"display_name":"Flur","avatar_color":"#007AFF","created_at":"<clock>","show_screensaver":false,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":false,"cover_photo":false},"devices":[{"id":3,"label":"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀","last_seen_at":null,"revoked_at":null,"created_at":"<clock>"}]},{"id":3,"display_name":"Küche","avatar_color":"#007AFF","created_at":"<clock>","show_screensaver":true,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":true,"cover_photo":false},"devices":[{"id":2,"label":null,"last_seen_at":null,"revoked_at":null,"created_at":"<clock>"},{"id":1,"label":"Küchentablett","last_seen_at":null,"revoked_at":"2026-11-18T12:00:00Z","created_at":"<clock>"}]}],"area_modules":["calendar","tasks","rewards","weather"]}},
  "disp revoke": {"status":200,"body":{"data":{"id":2,"revoked":true}}},
  "disp revoke again": {"status":200,"body":{"data":{"id":2,"revoked":true}}},
  "disp revoke other display": {"status":404,"body":{"error":"Device not found.","code":404,"reason":"displays_device_not_found"}},
  "disp revoke unknown": {"status":404,"body":{"error":"Device not found.","code":404,"reason":"displays_device_not_found"}},
  "disp revoke huge": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp revoke huge display": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp revoke decimal": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/deviceId","rule":"type"}]}},
  "disp revoke member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "disp remove active": {"status":409,"body":{"error":"A paired device cannot be removed. Revoke it first.","code":409,"reason":"display_device_active"}},
  "disp remove": {"status":200,"body":{"data":{"id":2,"removed":true}}},
  "disp remove again": {"status":404,"body":{"error":"Device not found.","code":404,"reason":"displays_device_not_found"}},
  "disp remove huge": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp remove letters": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp people session": {"status":403,"body":{"error":"This route is for paired displays.","code":403,"reason":"display_only"}},
  "disp people display": {"status":200,"body":{"data":[{"id":1,"display_name":"linda","avatar_color":"#007AFF","avatar_data":"data:image/jpeg;base64,/9j/4AECA//Z","can_tick_off":true,"can_redeem":false},{"id":2,"display_name":"tom","avatar_color":"#007AFF","avatar_data":null,"can_tick_off":true,"can_redeem":false}]}},
  "disp delete": {"status":200,"body":{"data":{"id":4,"deleted":true}}},
  "disp delete again": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp delete person": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp delete negative": {"status":404,"body":{"error":"Display not found.","code":404,"reason":"displays_display_not_found"}},
  "disp delete huge": {"status":400,"body":{"error":"Invalid id.","code":400}},
  "disp delete exponent": {"status":400,"body":{"error":"The request does not match the documented schema.","code":400,"reason":"validation","fields":[{"path":"path/id","rule":"type"}]}},
  "disp delete member": {"status":403,"body":{"error":"Admin access required.","code":403,"reason":"admin_required"}},
  "disp list end": {"status":200,"body":{"data":[{"id":3,"display_name":"Küche","avatar_color":"#007AFF","created_at":"<clock>","show_screensaver":true,"device_settings":{"night_from":22,"night_until":6,"idle_seconds":300,"show_clock":true,"cover_photo":false},"devices":[{"id":1,"label":"Küchentablett","last_seen_at":null,"revoked_at":"2026-11-18T12:00:00Z","created_at":"<clock>"}]}],"area_modules":["calendar","tasks","rewards","weather"]}},
};

test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  const seen = new Set();
  for (const step of STEPS) {
    if (typeof step === 'function') { step(); continue; }
    const [name, method, path, body, opts] = step;
    assert.ok(!seen.has(name), `duplicate row name ${name}`);
    seen.add(name);
    const actual = await call(method, path, typeof body === 'function' ? body() : body, opts);
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual({ status: actual.status, body: normalized(actual.body) }, EXPECTED[name], name);
  }
  assert.equal(seen.size, Object.keys(EXPECTED).length, 'every expectation has its row');
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

test('family: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/JOIN contacts/, () => call('GET', '/family/members', NO_BODY)), 'GET', '/api/v1/family/members');
  assertCentral(await withFailingSql(/JOIN contacts/, () => call('PATCH', '/family/members/reorder', { order: [ADMIN, MEMBER] })),
    'PATCH', '/api/v1/family/members/reorder');
  assert.equal((await call('GET', '/family/members', NO_BODY)).status, 200, 'answers again');
});

test('people: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/avatar_key FROM users/, () => call('GET', `/people/${ADMIN}/avatar?v=${KEY}`, NO_BODY)),
    'GET', '/api/v1/people/:id/avatar');
  assert.equal((await call('GET', `/people/${ADMIN}/avatar?v=${KEY}`, NO_BODY)).status, 200, 'answers again');
});

test('search: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/./, () => call('GET', '/search?q=milch', NO_BODY)), 'GET', '/api/v1/search/');
  assert.equal((await call('GET', '/search?q=milch', NO_BODY)).status, 200, 'answers again');
});

test('kitchen: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/shopping_items/, () => call('GET', '/kitchen/summary?today=2026-11-18', NO_BODY)),
    'GET', '/api/v1/kitchen/summary');
  assert.equal((await call('GET', '/kitchen/summary', NO_BODY)).status, 200, 'answers again');
});

test('screensaver: an unexpected error is a 500 of the central handler; Immich failures stay the route\'s 502', async () => {
  logged.error.length = 0;
  assertCentral(await withFailingSql(/sync_config/, () => call('GET', '/screensaver/config', NO_BODY)), 'GET', '/api/v1/screensaver/config');
  assertCentral(await withFailingSql(/sync_config/, () => call('PUT', '/screensaver/config', { url: IMMICH })), 'PUT', '/api/v1/screensaver/config');
  assertCentral(await withFailingSql(/sync_config/, () => call('GET', '/screensaver/photos', NO_BODY)), 'GET', '/api/v1/screensaver/photos');
  assert.equal((await call('PUT', '/screensaver/config', { url: IMMICH, apiKey: 'secret' })).status, 200);
  immich.mode = 'throw';
  try {
    assert.deepEqual(await call('POST', '/screensaver/test', {}),
      { status: 502, body: { error: 'Could not connect to Immich.', code: 502, reason: 'immich_unreachable' } });
    assert.deepEqual(await call('GET', '/screensaver/photos', NO_BODY), { status: 502, body: { error: 'Immich is unavailable.', code: 502 } });
    assert.deepEqual(await call('GET', `/screensaver/photos/${PHOTO}`, NO_BODY), { status: 502, body: null });
  } finally {
    immich.mode = 'ok';
  }
  assert.deepEqual(logged.error, [], 'no Immich failure reached the central handler');
  assert.equal((await call('PUT', '/screensaver/config', { url: '', clearApiKey: true })).status, 200, 'answers again');
});

test('displays: an unexpected error is a 500 of the central handler, and the process goes on', async () => {
  logged.error.length = 0;
  const created = await call('POST', '/displays', { display_name: 'Probe' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const paired = await call('POST', '/displays/pair', { code: codeFor(id), label: null });
  assert.equal(paired.status, 201);
  const device = db.prepare('SELECT id FROM display_devices WHERE user_id = ?').get(id).id;
  for (const [sql, method, path, body, pattern] of /** @type {Array<[RegExp, string, string, unknown, string]>} */ ([
    [/display_accounts/, 'GET', '/displays', NO_BODY, '/api/v1/displays/'],
    [/INSERT INTO users/, 'POST', '/displays', { display_name: 'Flur' }, '/api/v1/displays/'],
    [/UPDATE display_accounts/, 'PATCH', `/displays/${id}`, { show_screensaver: true }, '/api/v1/displays/:id'],
    [/display_accounts/, 'DELETE', `/displays/${id}`, NO_BODY, '/api/v1/displays/:id'],
    [/display_accounts/, 'POST', `/displays/${id}/pairing-code`, {}, '/api/v1/displays/:id/pairing-code'],
    [/FROM display_devices/, 'POST', `/displays/${id}/devices/${device}/revoke`, {}, '/api/v1/displays/:id/devices/:deviceId/revoke'],
    [/FROM display_devices/, 'POST', `/displays/${id}/devices/${device}/remove`, {}, '/api/v1/displays/:id/devices/:deviceId/remove'],
    [/FROM users u/, 'GET', '/displays/people', NO_BODY, '/api/v1/displays/people'],
    [/display_pairing_codes/, 'POST', '/displays/pair', { code: 'ABCDEFGHJK' }, '/api/v1/displays/pair'],
  ])) {
    const opts = pattern === '/api/v1/displays/people' ? { actor: /** @type {const} */ ('display') } : {};
    assertCentral(await withFailingSql(sql, () => call(method, path, body, opts)), method, pattern);
  }
  assert.equal((await call('GET', '/displays', NO_BODY)).status, 200, 'answers again');
  assert.equal((await call('DELETE', `/displays/${id}`, NO_BODY)).status, 200);
});

test('pair: a session that cannot be destroyed keeps the route\'s own 500, and the code stays unused', async () => {
  logged.error.length = 0;
  const created = await call('POST', '/displays', { display_name: 'Store' });
  const id = created.body.data.id;
  const code = codeFor(id);
  sessionState.failDestroy = true;
  try {
    assert.deepEqual(await call('POST', '/displays/pair', { code }), { status: 500, body: { error: 'Internal server error.', code: 500 } });
  } finally {
    sessionState.failDestroy = false;
  }
  assert.deepEqual(logged.error, [], 'the store callback answers itself, not through the central handler');
  assert.equal((await call('POST', '/displays/pair', { code })).status, 201, 'the code still pairs');
  assert.equal((await call('DELETE', `/displays/${id}`, NO_BODY)).status, 200);
});
