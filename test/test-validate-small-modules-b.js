/**
 * Test: request validation in the modules of group 1B (#2810, phase 2 section E)
 * Purpose: family, people (avatar), search, kitchen, screensaver and displays
 *          check every request against the schema of its operation in the
 *          OpenAPI document (`validateRequest()` in every route, after the
 *          gates that answer 403 or 429) before the handler runs. Held here
 *          against the real routers, mounted at their real prefixes in the
 *          order of server/index.js (express.json, defaultEmptyBody, the
 *          pairing router before the sign-in, the routers, error handler):
 *            - REFUSED: each input of the decided list is a 400 with `fields`
 *              naming it, and the route's own `reason` where the schema
 *              carries it (`x-reason`: `invalid_order`, `duplicate_member`,
 *              `immich_url_invalid`, `immich_album_id_invalid`,
 *              `immich_api_key_invalid`), else `validation`;
 *            - GATES FIRST: a member gets 403, never a 400 that names fields;
 *              the pairing limiter stands before the check;
 *            - KEPT: what the routes lived with goes through as before, and
 *              what the schema cannot say still gets the handler's answer;
 *            - THE OWN FRONTEND: every request the app's pages send to these
 *              endpoints passes the middleware of its operation;
 *            - ONE SOURCE: the idle steps of a display, the photo id and the
 *              day key of the document equal the lists and patterns the code
 *              reads.
 *          The one answer that depends on the day (kitchen without `today`)
 *          runs on a frozen clock in a pinned household zone.
 * Run: npm run test:validate-small-modules-b
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// The pairing limiter allows 5 attempts a minute; this suite sends more.
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000';

import test from 'node:test';
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
const { validateRequest } = await import('../server/api/validate-request.ts');
const { todayKey } = await import('../server/utils/timezone.js');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';
const ADMIN = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('admin1b','Admin','x','admin','parent')").run().lastInsertRowid);
const MEMBER = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('member1b','Member','x','member','child')").run().lastInsertRowid);
db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

for (const key of ['IMMICH_URL', 'IMMICH_API_KEY', 'IMMICH_SCREENSAVER_ALBUM_ID']) delete process.env[key];

/** How often a session was destroyed by the pairing route. */
let destroyedSessions = 0;
const quiet = { warn: () => {}, error: () => {} };
const app = express();
app.use(express.json());
app.use(defaultEmptyBody);
// The session middleware: every request has one, as in server/index.js.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  req.session = { destroy: (/** @type {(err?: unknown) => void} */ done) => { destroyedSessions++; done(); } };
  next();
});
// Before the sign-in, as in server/index.js.
app.use('/api/v1/displays', pairingRouter);
// requireAuth, reduced to the fields these routes read.
app.use((/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
  const member = req.get('x-actor') === 'member';
  const id = member ? MEMBER : ADMIN;
  req.authUserId = id;
  req.authRole = member ? 'member' : 'admin';
  req.authMethod = req.get('x-actor') === 'display' ? 'display' : 'session';
  req.session.userId = id;
  req.session.role = req.authRole;
  req.sessionModuleAccess = null;
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
app.use(createErrorHandler(quiet));
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

/**
 * @param {string} method
 * @param {string} route under /api/v1
 * @param {{ json?: unknown, actor?: 'member' | 'display' }} [options] json left out: no body
 */
async function call(method, route, { json, actor } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (actor) headers['x-actor'] = actor;
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
 * @param {string | undefined} reason
 */
function assertHandlerRefused(res, reason) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.notEqual(res.body?.error, SENTENCE, JSON.stringify(res.body));
  assert.equal(res.body?.fields, undefined);
  assert.equal(res.body?.reason, reason);
}

/**
 * @param {{ status: number, body: any }} res
 * @param {number} status
 */
function assertPassed(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
}

/** @param {{ status: number, body: any }} res */
function assertForbidden(res) {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body?.fields, undefined, 'a member learns no field names');
}

const NOT_DIGITS = ['12abc', '5.0', '1e2', '0x10'];

// ── Family ──────────────────────────────────────────────────────────────────

const memberIds = () => db.prepare(`
  SELECT id FROM users WHERE id IN (?, ?) ORDER BY id
`).all(ADMIN, MEMBER).map((/** @type {any} */ row) => row.id);
const positions = () => db.prepare('SELECT id, sort_order FROM users ORDER BY id').all();

test('family: a member gets 403 for any order, never the field names', async () => {
  for (const json of [{ order: 'x' }, [], { order: [1, 1] }, undefined]) {
    const res = await call('PATCH', '/family/members/reorder', { json, actor: 'member' });
    assertForbidden(res);
    assert.equal(res.body.reason, 'admin_required');
  }
});

test('family: the shape of the order keeps invalid_order, a repeat duplicate_member - now with fields', async () => {
  const INVALID = 'invalid_order';
  const before = positions();
  for (const [json, field] of /** @type {Array<[unknown, { path: string, rule: string, reason: string }]>} */ ([
    [{}, { path: 'body/order', rule: 'required', reason: INVALID }],
    [{ order: null }, { path: 'body/order', rule: 'type', reason: INVALID }],
    [{ order: 'x' }, { path: 'body/order', rule: 'type', reason: INVALID }],
    [{ order: { 0: 1 } }, { path: 'body/order', rule: 'type', reason: INVALID }],
    [{ order: [] }, { path: 'body/order', rule: 'minItems', reason: INVALID }],
    [{ order: [ADMIN, String(MEMBER)] }, { path: 'body/order/1', rule: 'type', reason: INVALID }],
    [{ order: [ADMIN, 1.5] }, { path: 'body/order/1', rule: 'type', reason: INVALID }],
    [{ order: [ADMIN, true] }, { path: 'body/order/1', rule: 'type', reason: INVALID }],
    [{ order: [ADMIN, 0] }, { path: 'body/order/1', rule: 'minimum', reason: INVALID }],
    // The shape before the repeat, as memberOrderProblem() reads it.
    [{ order: [ADMIN, ADMIN, 'x'] }, { path: 'body/order/2', rule: 'type', reason: INVALID }],
    [{ order: [ADMIN, MEMBER, ADMIN] }, { path: 'body/order', rule: 'uniqueItems', reason: 'duplicate_member' }],
    [[], { path: 'body', rule: 'type', reason: INVALID }],
  ])) {
    assertRefused(await call('PATCH', '/family/members/reorder', { json }), [field]);
  }
  assertRefused(await call('PATCH', '/family/members/reorder'), [{ path: 'body', rule: 'required', reason: INVALID }]);
  assert.deepEqual(positions(), before, 'nothing written');
});

test('family: kept - who the ids are stays the handler\'s, 1.0 is 1, unknown keys are ignored', async () => {
  assertHandlerRefused(await call('PATCH', '/family/members/reorder', { json: { order: [ADMIN] } }), 'incomplete_order');
  assertHandlerRefused(await call('PATCH', '/family/members/reorder', { json: { order: [...memberIds(), 999999] } }), 'not_a_household_member');
  const [first, second] = memberIds();
  const res = await fetch(`${baseUrl}/api/v1/family/members/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: `{"order":[${second}.0,${first}],"note":"x"}`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.map((/** @type {any} */ m) => m.id), [second, first]);
  assertPassed(await call('GET', '/family/members'), 200);
  assertPassed(await call('GET', '/family/members?anything=1'), 200);
});

// ── People (avatar) ─────────────────────────────────────────────────────────

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64')}`;
db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(JPEG, ADMIN);
const KEY = db.prepare('SELECT avatar_key FROM users WHERE id = ?').get(ADMIN).avatar_key;
const OTHER_KEY = String(KEY).replace(/^./, (/** @type {string} */ c) => (c === '0' ? '1' : '0'));

test('avatar: a missing or malformed key is a 400 that names only the field', async () => {
  assert.match(KEY, /^[0-9a-f]{32}$/, 'the stored key has the shape of the schema');
  assertRefused(await call('GET', `/people/${ADMIN}/avatar`), [{ path: 'query/v', rule: 'required' }]);
  for (const v of ['', 'abc', KEY.toUpperCase(), `${KEY}0`, `${KEY.slice(0, 31)}g`]) {
    assertRefused(await call('GET', `/people/${ADMIN}/avatar?v=${v}`), [{ path: 'query/v', rule: 'pattern' }]);
  }
  assertRefused(await call('GET', `/people/${ADMIN}/avatar?v=${KEY}&v=${KEY}`), [{ path: 'query/v', rule: 'type' }]);
  // The same 400 for a person without a picture: it tells nothing.
  assertRefused(await call('GET', `/people/${MEMBER}/avatar?v=abc`), [{ path: 'query/v', rule: 'pattern' }]);
  for (const id of NOT_DIGITS) {
    assertRefused(await call('GET', `/people/${id}/avatar?v=${KEY}`), [{ path: 'path/id', rule: 'type' }]);
  }
});

test('avatar: kept - a well-formed wrong key, no picture and id 0 stay 404, the right key 200', async () => {
  assert.equal((await call('GET', `/people/${ADMIN}/avatar?v=${OTHER_KEY}`)).status, 404);
  assert.equal((await call('GET', `/people/${MEMBER}/avatar?v=${KEY}`)).status, 404);
  assert.equal((await call('GET', `/people/0/avatar?v=${KEY}`)).status, 404);
  assert.equal((await call('GET', `/people/007/avatar?v=${KEY}`)).status, 404);
  assertHandlerRefused(await call('GET', `/people/-1/avatar?v=${KEY}`), undefined);
  const res = await fetch(`${baseUrl}/api/v1/people/${ADMIN}/avatar?v=${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
});

// ── Search ──────────────────────────────────────────────────────────────────

test('search: q given twice is a 400', async () => {
  assertRefused(await call('GET', '/search?q=milch&q=brot'), [{ path: 'query/q', rule: 'type' }]);
});

test('search: kept - no q, an empty or short q answer the empty lists, any length is read', async () => {
  for (const query of ['', '?q=', '?q=a', '?q=%20%20a%20', `?q=${'x'.repeat(5000)}`, '?q=milch&other=1']) {
    const res = await call('GET', `/search${query}`);
    assertPassed(res, 200);
    assert.ok(Array.isArray(res.body.tasks), query);
  }
});

// ── Kitchen ─────────────────────────────────────────────────────────────────

test('kitchen: today of another shape, or given twice, is a 400', async () => {
  for (const today of ['x', '2026-1-1', '20261118', '2026-11-18T10:00', ' 2026-11-18', '2026-11-18%0A']) {
    assertRefused(await call('GET', `/kitchen/summary?today=${today}`), [{ path: 'query/today', rule: 'pattern' }]);
  }
  assertRefused(await call('GET', '/kitchen/summary?today=2026-11-18&today=2026-11-19'), [{ path: 'query/today', rule: 'type' }]);
});

test('kitchen: kept - an empty or missing today is the household day; a day of the shape is compared as text', async (t) => {
  // Frozen: 11:30 UTC on 15 June is already 16 June in the pinned household zone (UTC+14).
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Pacific/Kiritimati') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO pantry_items (name, quantity, expires_on) VALUES ('Milch', 1, '2030-06-15')").run();
  t.after(() => {
    db.prepare("DELETE FROM pantry_items WHERE name = 'Milch'").run();
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-06-15T11:30:00Z') });
  assert.equal(todayKey(db), '2030-06-16', 'the household day, not the UTC day');
  const expired = async (/** @type {string} */ query) => {
    const res = await call('GET', `/kitchen/summary${query}`);
    assertPassed(res, 200);
    return res.body.data.pantry.expired;
  };
  assert.equal(await expired(''), 1);
  assert.equal(await expired('?today='), 1);
  assert.equal(await expired('?today=2030-06-16'), 1);
  assert.equal(await expired('?today=2030-06-15'), 0);
  // No calendar check: the text is compared as it is, as before.
  assert.equal(await expired('?today=2030-02-31'), 0);
  assert.equal(await expired('?today=2030-13-45'), 1);
});

// ── Screensaver ─────────────────────────────────────────────────────────────

const PHOTO = '0b4f5b2e-6f1a-4c3d-9e8f-1a2b3c4d5e6f';
const ALBUM = '1c5a6b3f-7a2b-4d4e-8f9a-2b3c4d5e6f70';
const stored = (/** @type {string} */ key) => db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value;

test('screensaver: a member gets 403 for an invalid configuration, never the field names', async () => {
  assertForbidden(await call('PUT', '/screensaver/config', { json: { url: 5 }, actor: 'member' }));
  assertForbidden(await call('PUT', '/screensaver/config', { actor: 'member' }));
  assertForbidden(await call('POST', '/screensaver/test', { json: [], actor: 'member' }));
});

test('screensaver: no body, no object, non-text fields and a long key are a 400; the reasons the page reads stay', async () => {
  assertRefused(await call('PUT', '/screensaver/config'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('PUT', '/screensaver/config', { json: [] }), [{ path: 'body', rule: 'type' }]);
  for (const url of [null, 5, true, ['https://photos.example'], {}]) {
    assertRefused(await call('PUT', '/screensaver/config', { json: { url } }), [{ path: 'body/url', rule: 'type', reason: 'immich_url_invalid' }]);
  }
  assertRefused(await call('PUT', '/screensaver/config', { json: { url: `https://${'a'.repeat(2041)}` } }),
    [{ path: 'body/url', rule: 'maxLength', reason: 'immich_url_invalid' }]);
  for (const albumId of [null, 5, [ALBUM]]) {
    assertRefused(await call('PUT', '/screensaver/config', { json: { albumId } }), [{ path: 'body/albumId', rule: 'type', reason: 'immich_album_id_invalid' }]);
  }
  assertRefused(await call('PUT', '/screensaver/config', { json: { apiKey: 'x'.repeat(1001) } }),
    [{ path: 'body/apiKey', rule: 'maxLength', reason: 'immich_api_key_invalid' }]);
  assertRefused(await call('PUT', '/screensaver/config', { json: { apiKey: 5 } }), [{ path: 'body/apiKey', rule: 'type' }]);
  assertRefused(await call('PUT', '/screensaver/config', { json: { clearApiKey: 'true' } }), [{ path: 'body/clearApiKey', rule: 'type' }]);
  // Refused as a whole: a good URL beside a bad album id is not stored first.
  assertRefused(await call('PUT', '/screensaver/config', { json: { url: 'https://kept.example', albumId: 5 } }),
    [{ path: 'body/albumId', rule: 'type', reason: 'immich_album_id_invalid' }]);
  assert.notEqual(stored('immich_url'), 'https://kept.example');
});

test('screensaver: kept - scheme, UUID and the length in UTF-16 units stay the handler\'s; "" clears', async () => {
  assertHandlerRefused(await call('PUT', '/screensaver/config', { json: { url: 'photos.example' } }), 'immich_url_invalid');
  assertHandlerRefused(await call('PUT', '/screensaver/config', { json: { albumId: 'alle-fotos' } }), 'immich_album_id_invalid');
  // 600 emoji: 600 code points for the schema, 1200 UTF-16 units for the route.
  assertHandlerRefused(await call('PUT', '/screensaver/config', { json: { apiKey: '😀'.repeat(600) } }), 'immich_api_key_invalid');
  assertPassed(await call('PUT', '/screensaver/config', { json: { url: '  https://photos.example//  ', albumId: ` ${ALBUM.toUpperCase()} `, apiKey: 'k' } }), 200);
  assert.equal(stored('immich_url'), 'https://photos.example');
  assertPassed(await call('PUT', '/screensaver/config', { json: { url: '', albumId: '', clearApiKey: true, extra: 1 } }), 200);
  assert.equal(stored('immich_url'), '');
  assert.equal(stored('immich_api_key'), '');
  assertPassed(await call('PUT', '/screensaver/config', { json: {} }), 200);
  assertHandlerRefused(await call('POST', '/screensaver/test', { json: {} }), 'immich_not_configured');
  assertHandlerRefused(await call('POST', '/screensaver/test'), 'immich_not_configured');
});

test('screensaver: a photo id that is no UUID is a 400 before the 404 of an unconfigured Immich', async () => {
  for (const id of ['not-a-uuid', '5', `${PHOTO}0`, PHOTO.replace(/-/g, ''), '..%2F..%2Fadmin', PHOTO.replace('4c3d', '9c3d')]) {
    assertRefused(await call('GET', `/screensaver/photos/${id}`), [{ path: 'path/id', rule: 'pattern' }]);
  }
  // Kept: a UUID in either letter case reaches the route, which is not configured.
  assert.equal((await call('GET', `/screensaver/photos/${PHOTO}`)).status, 404);
  assert.equal((await call('GET', `/screensaver/photos/${PHOTO.toUpperCase()}`)).status, 404);
  assertPassed(await call('GET', '/screensaver/photos'), 200);
});

// ── Displays ────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} */
async function newDisplay(name = 'Küche') {
  const res = await call('POST', '/displays', { json: { display_name: name } });
  assertPassed(res, 201);
  return res.body.data.id;
}

test('displays: the admin gate stands before the check - a member gets 403', async () => {
  assertForbidden(await call('POST', '/displays', { json: { display_name: 5 }, actor: 'member' }));
  assertForbidden(await call('PATCH', '/displays/12abc', { json: [], actor: 'member' }));
  assertForbidden(await call('DELETE', '/displays/5.0', { actor: 'member' }));
});

test('displays: a name that is not text, empty or over 128 characters as sent is a 400', async () => {
  for (const name of [5, true, ['Küche'], null]) {
    assertRefused(await call('POST', '/displays', { json: { display_name: name } }), [{ path: 'body/display_name', rule: 'type' }]);
  }
  assertRefused(await call('POST', '/displays', { json: { display_name: '' } }), [{ path: 'body/display_name', rule: 'minLength' }]);
  assertRefused(await call('POST', '/displays', { json: { display_name: `${'x'.repeat(128)}   ` } }), [{ path: 'body/display_name', rule: 'maxLength' }]);
  assertRefused(await call('POST', '/displays', { json: {} }), [{ path: 'body/display_name', rule: 'required' }]);
  assertRefused(await call('POST', '/displays'), [{ path: 'body', rule: 'required' }]);
});

test('displays: kept - spaces only and 128 characters in UTF-16 units stay the handler\'s', async () => {
  assertHandlerRefused(await call('POST', '/displays', { json: { display_name: '   ' } }), undefined);
  assertHandlerRefused(await call('POST', '/displays', { json: { display_name: '😀'.repeat(100) } }), undefined);
  const res = await call('POST', '/displays', { json: { display_name: `  ${'x'.repeat(120)}  `, extra: 1 } });
  assertPassed(res, 201);
  assert.equal(res.body.data.display_name, 'x'.repeat(120));
});

// anyOf names the branch that failed on the boolean, the other branch's
// missing key, then itself.
const NOT_A_BOOLEAN = [
  { path: 'body/show_screensaver', rule: 'type' },
  { path: 'body/device_settings', rule: 'required' },
  { path: 'body', rule: 'anyOf' },
];

test('displays: path ids that are not plain digits are a 400, and the 400 comes before the 404', async () => {
  const id = await newDisplay();
  for (const bad of NOT_DIGITS) {
    assertRefused(await call('PATCH', `/displays/${bad}`, { json: { show_screensaver: true } }), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('DELETE', `/displays/${bad}`), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('POST', `/displays/${bad}/pairing-code`, { json: {} }), [{ path: 'path/id', rule: 'type' }]);
    assertRefused(await call('POST', `/displays/${id}/devices/${bad}/revoke`, { json: {} }), [{ path: 'path/deviceId', rule: 'type' }]);
    assertRefused(await call('POST', `/displays/${bad}/devices/1/remove`, { json: {} }), [{ path: 'path/id', rule: 'type' }]);
  }
  assertRefused(await call('PATCH', '/displays/999999', { json: { show_screensaver: 'true' } }), NOT_A_BOOLEAN);
});

test('displays: PATCH takes a real boolean and complete device settings', async () => {
  const id = await newDisplay();
  assertRefused(await call('PATCH', `/displays/${id}`, { json: { show_screensaver: 'false' } }), NOT_A_BOOLEAN);
  assertRefused(await call('PATCH', `/displays/${id}`, { json: {} }), [
    { path: 'body/show_screensaver', rule: 'required' },
    { path: 'body/device_settings', rule: 'required' },
    { path: 'body', rule: 'anyOf' },
  ]);
  assertRefused(await call('PATCH', `/displays/${id}`), [{ path: 'body', rule: 'required' }]);
  const settings = { night_from: 22, night_until: 6, idle_seconds: 300, show_clock: true, cover_photo: false };
  assertRefused(await call('PATCH', `/displays/${id}`, { json: { device_settings: { ...settings, idle_seconds: 301 } } }),
    [{ path: 'body/device_settings/idle_seconds', rule: 'enum' }]);
  assertRefused(await call('PATCH', `/displays/${id}`, { json: { device_settings: { ...settings, night_from: 24 } } }),
    [{ path: 'body/device_settings/night_from', rule: 'maximum' }]);
  // Kept: equal night hours stay the handler's (a rule across two fields).
  assertHandlerRefused(await call('PATCH', `/displays/${id}`, { json: { device_settings: { ...settings, night_until: 22 } } }), undefined);
  assertPassed(await call('PATCH', `/displays/${id}`, { json: { device_settings: settings, show_screensaver: true } }), 200);
  // Kept: an unknown display is still the handler's 404.
  assert.equal((await call('PATCH', '/displays/999999', { json: { show_screensaver: true } })).status, 404);
  assert.equal((await call('DELETE', '/displays/-3')).status, 404);
});

test('displays: the list for a display stays the handler\'s 403 for a person', async () => {
  const res = await call('GET', '/displays/people');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'display_only');
  assertPassed(await call('GET', '/displays/people', { actor: 'display' }), 200);
});

test('pair: the check stands behind the pairing limiter', () => {
  const route = pairingRouter.stack.find((/** @type {any} */ layer) => layer.route?.path === '/pair')?.route;
  assert.ok(route, 'POST /pair is on the pairing router');
  const names = route.stack.map((/** @type {any} */ layer) => layer.handle.name);
  assert.equal(names.indexOf('validateRequestMiddleware'), 1, names.join(', '));
});

test('pair: no code, a code or label that is not text, a label over 120 characters is a 400 and leaves the session', async () => {
  const before = destroyedSessions;
  assertRefused(await call('POST', '/displays/pair', { json: {} }), [{ path: 'body/code', rule: 'required' }]);
  assertRefused(await call('POST', '/displays/pair'), [{ path: 'body', rule: 'required' }]);
  assertRefused(await call('POST', '/displays/pair', { json: { code: 1234567890 } }), [{ path: 'body/code', rule: 'type' }]);
  assertRefused(await call('POST', '/displays/pair', { json: { code: ['ABCDEFGHJK'] } }), [{ path: 'body/code', rule: 'type' }]);
  assertRefused(await call('POST', '/displays/pair', { json: { code: 'ABCDEFGHJK', label: 5 } }), [{ path: 'body/label', rule: 'type' }]);
  assertRefused(await call('POST', '/displays/pair', { json: { code: 'ABCDEFGHJK', label: 'x'.repeat(121) } }), [{ path: 'body/label', rule: 'maxLength' }]);
  assert.equal(destroyedSessions, before, 'no refused body signed anyone out');
});

test('pair: kept - a label of 120 characters, null or empty, a wrong code is the handler\'s 400', async () => {
  const id = await newDisplay();
  for (const label of ['x'.repeat(120), null, '']) {
    const { code } = issuePairingCode(id, ADMIN);
    const res = await call('POST', '/displays/pair', { json: { code: code.replace(/^(.{5})/, '$1-'), label } });
    assertPassed(res, 201);
  }
  const wrong = await call('POST', '/displays/pair', { json: { code: '' } });
  assertHandlerRefused(wrong, undefined);
  assert.equal(wrong.body.error, 'This pairing code is not valid.');
  const device = db.prepare('SELECT label FROM display_devices WHERE user_id = ? ORDER BY id').all(id);
  assert.deepEqual(device.map((/** @type {any} */ row) => row.label), ['x'.repeat(120), null, null]);
});

// ── THE OWN FRONTEND: every request it sends passes its operation ──────────

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

const DEVICE_SETTINGS = { night_from: 22, night_until: 6, idle_seconds: 300, show_clock: true, cover_photo: false };

/**
 * Each entry: where it is sent from, the operation and the request exactly as
 * that call site builds it. Query and path values are the strings Express hands on.
 * @type {Array<[string, string, string, string, { params?: Record<string, unknown>, query?: Record<string, unknown>, body?: unknown }]>}
 */
const FRONTEND_CALLS = [
  // family-users.js, split-expenses.js, documents.js, health.js, health-fasting.js,
  // meals.js, budget.js, calendar.js: the member list without parameters
  ['family-users.js members', 'GET', '/api/v1/family', '/members', {}],
  // admin-family.js: Number(row.dataset.id), filtered to integers
  ['admin-family.js reorder', 'PATCH', '/api/v1/family', '/members/reorder', { body: { order: [3, 1, 2] } }],
  // the address in a list row (services/person-avatar.js), an <img> and sw.js
  ['list row avatar', 'GET', '/api/v1/people', '/:id/avatar', { params: { id: '12' }, query: { v: '0123456789abcdef0123456789abcdef' } }],
  // router.js: the trimmed text, at least 2 characters
  ['router.js search', 'GET', '/api/v1/search', '/', { query: { q: 'milch brot' } }],
  // kitchen-tabs.js: todayKey(), which is '' when the zone is unreadable
  ['kitchen-tabs.js summary', 'GET', '/api/v1/kitchen', '/summary', { query: { today: '2026-11-18' } }],
  ['kitchen-tabs.js summary without a day', 'GET', '/api/v1/kitchen', '/summary', { query: { today: '' } }],
  // admin-immich.js: collect(), trimmed text, env-locked fields left out, the key only when typed
  ['admin-immich.js load', 'GET', '/api/v1/screensaver', '/config', {}],
  ['admin-immich.js save', 'PUT', '/api/v1/screensaver', '/config', { body: { url: 'https://photos.example', albumId: ALBUM, apiKey: 'secret-key' } }],
  ['admin-immich.js save cleared', 'PUT', '/api/v1/screensaver', '/config', { body: { url: '', albumId: '' } }],
  ['admin-immich.js save all env-locked', 'PUT', '/api/v1/screensaver', '/config', { body: {} }],
  ['admin-immich.js test', 'POST', '/api/v1/screensaver', '/test', { body: {} }],
  // photo-screensaver.js
  ['photo-screensaver.js photos', 'GET', '/api/v1/screensaver', '/photos', {}],
  ['photo-screensaver.js photo', 'GET', '/api/v1/screensaver', '/photos/:id', { params: { id: PHOTO } }],
  // admin-displays.js: ids from dataset (digit text)
  ['admin-displays.js list', 'GET', '/api/v1/displays', '/', {}],
  ['admin-displays.js create', 'POST', '/api/v1/displays', '/', { body: { display_name: 'Küche' } }],
  ['admin-displays.js screensaver', 'PATCH', '/api/v1/displays', '/:id', { params: { id: '7' }, body: { show_screensaver: true } }],
  ['admin-displays.js device settings', 'PATCH', '/api/v1/displays', '/:id', { params: { id: '7' }, body: { device_settings: DEVICE_SETTINGS } }],
  ['admin-displays.js pairing code', 'POST', '/api/v1/displays', '/:id/pairing-code', { params: { id: '7' }, body: {} }],
  ['admin-displays.js revoke', 'POST', '/api/v1/displays', '/:id/devices/:deviceId/revoke', { params: { id: '7', deviceId: '3' }, body: {} }],
  ['admin-displays.js remove', 'POST', '/api/v1/displays', '/:id/devices/:deviceId/remove', { params: { id: '7', deviceId: '3' }, body: {} }],
  ['admin-displays.js delete', 'DELETE', '/api/v1/displays', '/:id', { params: { id: '7' } }],
  // pair-display.js: the trimmed code with grouping, label || null (maxlength 120 on the field)
  ['pair-display.js pair', 'POST', '/api/v1/displays', '/pair', { body: { code: 'ABCDE-FGHJK', label: null } }],
  ['pair-display.js pair with label', 'POST', '/api/v1/displays', '/pair', { body: { code: 'ABCDE FGHJK', label: 'Küche' } }],
  // tasks.js and rewards.js on a display
  ['tasks.js display people', 'GET', '/api/v1/displays', '/people', {}],
];

for (const [site, method, mount, pattern, request] of FRONTEND_CALLS) {
  test(`the own frontend passes the schema: ${site}`, () => {
    assert.equal(passes(method, mount, pattern, request), true);
  });
}

test('the own frontend: an empty member list stays refused with invalid_order, as before', () => {
  const outcome = passes('PATCH', '/api/v1/family', '/members/reorder', { body: { order: [] } });
  assert.equal(outcome, JSON.stringify([{ path: 'body/order', rule: 'minItems', reason: 'invalid_order' }]));
});

// ── The schema's lists and patterns against their one source ────────────────

const { buildOpenApiSpec } = await import('../server/openapi.js');
const { DISPLAY_IDLE_STEPS } = await import('../public/utils/display-device-settings.js');
const { SCREENSAVER_PHOTO_ID } = await import('../server/display-scopes.js');
const { DATE_PATTERN } = await import('../server/utils/datetime-pattern.js');
const SPEC = buildOpenApiSpec();

/** @param {unknown[]} values */
const asSet = (values) => [...new Set(values)].sort((a, b) => Number(a) - Number(b));

test('displays: the idle_seconds enum of the document is exactly DISPLAY_IDLE_STEPS', () => {
  assert.ok(Array.isArray(DISPLAY_IDLE_STEPS) && DISPLAY_IDLE_STEPS.length >= 3, 'DISPLAY_IDLE_STEPS is read');
  const schema = SPEC.paths['/api/v1/displays/{id}'].patch.requestBody.content['application/json'].schema;
  const values = schema.properties.device_settings.properties.idle_seconds.enum;
  assert.ok(Array.isArray(values), 'idle_seconds carries an enum');
  assert.equal(values.length, new Set(values).size, 'no step twice');
  assert.deepEqual(asSet(values), asSet([...DISPLAY_IDLE_STEPS]));
});

test('screensaver: the photo id pattern of the document is the one the route and the display gate read', () => {
  const parameter = SPEC.paths['/api/v1/screensaver/photos/{id}'].get.parameters.find((/** @type {any} */ p) => p.name === 'id');
  assert.equal(parameter.schema.pattern, SCREENSAVER_PHOTO_ID.source);
  assert.equal(SCREENSAVER_PHOTO_ID.flags, '');
});

test('kitchen: the today pattern of the document is the day key of the hand check, or empty', () => {
  const parameter = SPEC.paths['/api/v1/kitchen/summary'].get.parameters.find((/** @type {any} */ p) => p.name === 'today');
  const pattern = new RegExp(parameter.schema.pattern);
  const day = new RegExp(DATE_PATTERN);
  for (const sample of ['', '2026-11-18', '2026-02-31', '9999-99-99', 'x', '2026-11-18 ', '2026-1-18', '2026-11-18T00:00']) {
    assert.equal(pattern.test(sample), sample === '' || day.test(sample), JSON.stringify(sample));
  }
});
