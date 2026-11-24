/**
 * Test: request validation in the preferences and push routes (#2810,
 *       phase 2 section E, group 11b)
 * Purpose: server/routes/preferences.js (7 routes) and server/routes/push.js
 *          (5 routes) check every request against the schema of its
 *          operation in the OpenAPI document (`validateRequest()`, 12) before
 *          the handler runs. Held here against the real routers at their real
 *          prefixes (test/preferences-app.js):
 *            - THE OWN CALLERS: the patches of the settings pages
 *              (savePreferences, one field each), of the overview and of the
 *              zone hint; the subscription the browser hands to
 *              public/push.js (`PushSubscription.toJSON()` with
 *              `expirationTime`), its unsubscribe and wall pause, the test
 *              push of the notification settings; the holiday lists and the
 *              holiday sync of the calendar settings - all pass;
 *            - REFUSED: garbage per field is a 400 with `reason:
 *              'validation'` and `fields`; PUT /preferences without a body or
 *              with a list instead of an object;
 *            - 500 NOW 400: `POST /push/unsubscribe` with an object as
 *              endpoint ran into the database as a bind value;
 *            - SILENT READINGS NOW REFUSED: `p256dh: 5` was stored,
 *              `unsubscribe` with `endpoint: 5` answered 204, a test push
 *              with `title: 5` sent the default title;
 *            - THE REGISTER STAYS THE GATE (decision 9): the document checks
 *              the preferences body only as an object, so a member still gets
 *              403 for an admin field with an invalid value, and a field the
 *              registry refuses keeps its own sentence;
 *            - ORDER: `POST /holidays/sync` takes no body, the admin check
 *              answers a member first whatever is sent;
 *            - ONE SOURCE: the path patterns of the holiday routes are the
 *              ones the routes held by hand (COUNTRY_ISO_RE, SUBDIVISION_RE);
 *            - THE DOCUMENT: 12 operations, each with input answering the 400;
 *            - ONLY GUARD (step b): the push shapes the handlers no longer
 *              check are pinned as values (endpoint maxLength 2048, keys,
 *              active, the test push texts).
 *          No network: OpenHolidays is stubbed (holidays.__setFetchImpl), the
 *          push service is a stand-in that sends nothing.
 * Run: npm run test:validate-preferences
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import rateLimit from 'express-rate-limit';
import { createPreferencesApp, PREFERENCES_PREFIX, PUSH_PREFIX } from './preferences-app.js';

const dbmod = await import('../server/db.js');
const { buildOpenApiSpec } = await import('../server/openapi.js');
const holidays = await import('../server/services/holidays.js');
const { buildRouter: buildPushRouter } = await import('../server/routes/push.js');
const { COUNTRY_ISO_RE, SUBDIVISION_RE } = await import('../server/settings/values.ts');
const db = dbmod.get();

const SENTENCE = 'The request does not match the documented schema.';

/** @param {string} username @param {string} role */
function user(username, role) {
  return Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?)")
    .run(username, username, role).lastInsertRowid);
}
const ADMIN = user('admin11b', 'admin');
const MEM = user('mem11b', 'member');

/** @type {Record<string, { id: number, role: string }>} */
const ACTORS = {
  admin: { id: ADMIN, role: 'admin' },
  mem: { id: MEM, role: 'member' },
};

/** What the stand-in push service was asked to send. @type {Array<{ userId: number, payload: any }>} */
const sentPushes = [];
const pushService = {
  getPublicKey: () => 'PUBLIC_KEY',
  ensureVapid: () => ({ publicKey: 'PUBLIC_KEY', privateKey: 'PRIVATE_KEY', subject: 'mailto:test@example.invalid' }),
  sendPushToUser: async (/** @type {number} */ userId, /** @type {any} */ payload) => { sentPushes.push({ userId, payload }); return 0; },
};

const app = await createPreferencesApp({
  mount: ['preferences'],
  auth: (/** @type {any} */ req, /** @type {any} */ _res, /** @type {() => void} */ next) => {
    const actor = ACTORS[req.get('x-actor') ?? 'admin'];
    req.authUserId = actor.id;
    req.authRole = actor.role;
    req.authMethod = 'session';
    req.session = { userId: actor.id, role: actor.role };
    req.sessionModuleAccess = null;
    req.authScopes = null;
    next();
  },
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  after: [[PUSH_PREFIX, buildPushRouter({ pushService, database: db })]],
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const origin = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
test.after(() => { server.close(); holidays.__setFetchImpl(null); });

// OpenHolidays never answers here: every list is empty.
/** @type {string[]} */
const holidayUrls = [];
holidays.__setFetchImpl(async (/** @type {unknown} */ url) => {
  holidayUrls.push(String(url));
  return { ok: true, status: 200, json: async () => [] };
});

/**
 * @param {string} method
 * @param {string} route the full path, `/api/v1/...`
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
  const res = await fetch(`${origin}${route}`, { method, headers, body: payload });
  const text = await res.text();
  /** @type {any} */
  let body = null;
  try { body = JSON.parse(text); } catch { /* no JSON body */ }
  return { status: res.status, body };
}

/**
 * The 400 of the schema, naming the field.
 * @param {{ status: number, body: any }} res
 * @param {string} path the expected `fields[].path`
 * @param {string} label
 */
function assertRefused(res, path, label) {
  assert.equal(res.status, 400, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, SENTENCE, label);
  assert.equal(res.body?.reason, 'validation', label);
  assert.ok(res.body.fields.some((/** @type {any} */ f) => f.path === path), `${label}: ${JSON.stringify(res.body.fields)}`);
}

const PREFS = PREFERENCES_PREFIX;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-11b';
/** PushSubscription.toJSON() as public/push.js sends it. */
const SUBSCRIPTION = { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'BPublicKeyOfTheDevice', auth: 'AuthSecret' } };

// ── PUT /preferences ─────────────────────────────────────────────────────────

test('PUT /preferences: the patches of the own UI pass', async () => {
  const patches = [
    // The settings pages, one field per card (savePreferences).
    { week_start: 'sunday' },
    { date_format: 'dmy' },
    { calendar_default_reminders: [15, 60] },
    { tasks_default_visibility: 'assignees' },
    { health_cycle_enabled_user: false },
    { language: null },
    // The overview (public/pages/dashboard.js) and the zone hint.
    { dashboard_widgets: null, dashboard_today_glance: null },
    { timezone_hint_dismissed: true },
    // The weather reset of the household settings.
    { weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '' },
  ];
  for (const json of patches) {
    const res = await call('PUT', PREFS, { json });
    assert.equal(res.status, 200, `${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
  }
});

test('PUT /preferences: without a body or with a list instead of an object is 400', async () => {
  assertRefused(await call('PUT', PREFS), 'body', 'no body');
  assertRefused(await call('PUT', PREFS, { json: [] }), 'body', 'empty list');
  assertRefused(await call('PUT', PREFS, { json: [{ week_start: 'sunday' }] }), 'body', 'list of patches');
  assertRefused(await call('PUT', PREFS, { json: ['sunday'] }), 'body', 'list of text');
});

test('PUT /preferences: the registry stays the validator and the gate (decision 9)', async () => {
  // A member sending an admin field with an invalid value: 403 of the registry, not a schema 400.
  for (const json of [{ currency: 5 }, { currency: 'x' }, { weather_lat: 100 }, { tasks_default_points: 'x' }]) {
    const res = await call('PUT', PREFS, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'admin_required');
  }
  // A field the registry refuses keeps its own sentence, without `fields`.
  const wrong = await call('PUT', PREFS, { json: { week_start: 1 } });
  assert.equal(wrong.status, 400);
  assert.notEqual(wrong.body.error, SENTENCE);
  assert.equal(wrong.body.fields, undefined);
  // Unknown keys stay ignored (additionalProperties open).
  const unknown = await call('PUT', PREFS, { json: { not_a_setting: 1 } });
  assert.equal(unknown.status, 200);
});

// ── Holidays ────────────────────────────────────────────────────────────────

test('holidays: the lists of the calendar settings pass', async () => {
  for (const route of [
    `${PREFS}/holidays/countries`,
    `${PREFS}/holidays/subdivisions/DE?lang=de`,
    `${PREFS}/holidays/subdivisions/DE?lang=pt-BR`,
    `${PREFS}/holidays/groups/BE`,
    `${PREFS}/holidays/groups/CH/CH-BE`,
  ]) {
    const res = await call('GET', route);
    assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.body)}`);
  }
});

test('holidays: `lang` is text without a list of values, an unknown one answers in English', async () => {
  for (const lang of ['xx', 'de-AT', '']) {
    const res = await call('GET', `${PREFS}/holidays/subdivisions/DE?lang=${encodeURIComponent(lang)}`);
    assert.equal(res.status, 200, `lang=${lang}: ${JSON.stringify(res.body)}`);
  }
  assertRefused(await call('GET', `${PREFS}/holidays/subdivisions/DE?lang=de&lang=fr`), 'query/lang', 'lang twice');
});

test('holidays: a country or region code outside its pattern is 400 before OpenHolidays is asked', async () => {
  const before = holidayUrls.length;
  for (const code of ['de', 'D', 'DEU', '1A']) {
    assertRefused(await call('GET', `${PREFS}/holidays/subdivisions/${code}`), 'path/countryCode', `subdivisions ${code}`);
    assertRefused(await call('GET', `${PREFS}/holidays/groups/${code}`), 'path/countryCode', `groups ${code}`);
    assertRefused(await call('GET', `${PREFS}/holidays/groups/${code}/DE-BY`), 'path/countryCode', `groups ${code}/DE-BY`);
  }
  for (const code of ['x', 'DE', 'de-by', 'DE-', 'DE-ABCDEFGHIJK']) {
    assertRefused(await call('GET', `${PREFS}/holidays/groups/DE/${code}`), 'path/subdivisionCode', `groups DE/${code}`);
  }
  assert.equal(holidayUrls.length, before, 'no refused code reached the holiday service');
});

test('holidays: the document patterns are the ones the routes held by hand', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const params = (/** @type {string} */ path) => spec.paths[path].get.parameters;
  const country = params('/api/v1/preferences/holidays/groups/{countryCode}/{subdivisionCode}').find((/** @type {any} */ p) => p.name === 'countryCode');
  const region = params('/api/v1/preferences/holidays/groups/{countryCode}/{subdivisionCode}').find((/** @type {any} */ p) => p.name === 'subdivisionCode');
  assert.equal(country.schema.pattern, COUNTRY_ISO_RE.source);
  assert.equal(region.schema.pattern, SUBDIVISION_RE.source);
  for (const path of ['/api/v1/preferences/holidays/subdivisions/{countryCode}', '/api/v1/preferences/holidays/groups/{countryCode}']) {
    assert.equal(params(path).find((/** @type {any} */ p) => p.name === 'countryCode').schema.pattern, COUNTRY_ISO_RE.source, path);
  }
});

test('only guard: the document holds the push shapes the handlers no longer check (#2810 group 11b step b)', () => {
  // Since step b the push handlers read `endpoint`, `keys`, `active`, `title`,
  // `body` without a type check of their own: the document is the one guard.
  // Its rules are pinned as values here, so a looser schema turns this red.
  const schemas = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test')).components.schemas;
  const subscribe = schemas.PushSubscribeInput;
  assert.deepEqual(subscribe.required, ['endpoint', 'keys']);
  assert.deepEqual(subscribe.properties.endpoint, { ...subscribe.properties.endpoint, type: 'string', maxLength: 2048 });
  assert.equal(subscribe.properties.keys.type, 'object');
  assert.deepEqual(subscribe.properties.keys.required, ['p256dh', 'auth']);
  for (const key of ['p256dh', 'auth']) {
    assert.equal(subscribe.properties.keys.properties[key].type, 'string', key);
    assert.equal(subscribe.properties.keys.properties[key].minLength, 1, key);
  }
  assert.deepEqual(schemas.PushUnsubscribeInput.required, ['endpoint']);
  assert.equal(schemas.PushUnsubscribeInput.properties.endpoint.type, 'string');
  assert.deepEqual(schemas.PushWallModeInput.required, ['endpoint', 'active']);
  assert.equal(schemas.PushWallModeInput.properties.endpoint.type, 'string');
  assert.equal(schemas.PushWallModeInput.properties.active.type, 'boolean');
  for (const field of ['title', 'body', 'endpoint']) {
    assert.equal(schemas.PushTestInput.properties[field].type, 'string', `test push ${field}`);
  }
});

test('POST /holidays/sync: the call of the calendar settings passes, a member meets 403 whatever is sent', async () => {
  // No country configured: the sync returns before the network.
  const ok = await call('POST', `${PREFS}/holidays/sync`, { json: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const bare = await call('POST', `${PREFS}/holidays/sync`);
  assert.equal(bare.status, 200, JSON.stringify(bare.body));
  for (const json of [{}, { a: 1 }, [1], undefined]) {
    const res = await call('POST', `${PREFS}/holidays/sync`, { json, actor: 'mem' });
    assert.equal(res.status, 403, `${JSON.stringify(json)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reason, 'admin_required');
  }
});

// ── Push ────────────────────────────────────────────────────────────────────

test('push: the requests of public/push.js and the notification settings pass', async () => {
  const key = await call('GET', `${PUSH_PREFIX}/vapid-public-key`);
  assert.equal(key.status, 200);
  assert.equal(key.body.data.key, 'PUBLIC_KEY');

  const sub = await call('POST', `${PUSH_PREFIX}/subscribe`, { json: SUBSCRIPTION });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.ok(Number.isInteger(sub.body.data.id));

  for (const active of [true, false]) {
    const wall = await call('PUT', `${PUSH_PREFIX}/wall-mode`, { json: { endpoint: ENDPOINT, active } });
    assert.equal(wall.status, 204, `wall-mode ${active}`);
  }

  sentPushes.length = 0;
  const withEndpoint = await call('POST', `${PUSH_PREFIX}/test`, { json: { title: 'Test', body: 'Hallo', endpoint: ENDPOINT } });
  assert.equal(withEndpoint.status, 200, JSON.stringify(withEndpoint.body));
  assert.equal(sentPushes.at(-1)?.payload.title, 'Test');
  const withoutEndpoint = await call('POST', `${PUSH_PREFIX}/test`, { json: { title: 'Test', body: 'Hallo' } });
  assert.equal(withoutEndpoint.status, 200);
  // The body is optional (decision 15).
  const bare = await call('POST', `${PUSH_PREFIX}/test`);
  assert.equal(bare.status, 200, JSON.stringify(bare.body));
  assert.equal(sentPushes.at(-1)?.payload.title, 'Yuvomi');

  const unsub = await call('POST', `${PUSH_PREFIX}/unsubscribe`, { json: { endpoint: ENDPOINT } });
  assert.equal(unsub.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(ENDPOINT).n, 0);
});

test('POST /push/subscribe: garbage per field is 400, and nothing is stored', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
  const before = count();
  const keys = SUBSCRIPTION.keys;
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`), 'body', 'no body');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, endpoint: 5 } }), 'body/endpoint', 'endpoint 5');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, endpoint: `https://fcm.googleapis.com/${'x'.repeat(2030)}` } }), 'body/endpoint', 'endpoint over 2048');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, keys: 'x' } }), 'body/keys', 'keys text');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { endpoint: ENDPOINT } }), 'body/keys', 'keys missing');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, keys: { ...keys, p256dh: 5 } } }), 'body/keys/p256dh', 'p256dh 5');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, keys: { ...keys, auth: '' } } }), 'body/keys/auth', 'auth empty');
  assertRefused(await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, keys: { p256dh: 'P' } } }), 'body/keys/auth', 'auth missing');
  assert.equal(count(), before);
  // The route's own check of the address stays (checkPushEndpoint).
  const local = await call('POST', `${PUSH_PREFIX}/subscribe`, { json: { ...SUBSCRIPTION, endpoint: 'https://127.0.0.1/push' } });
  assert.equal(local.status, 400);
  assert.equal(local.body.error, 'endpoint must be a public https address.');
  assert.equal(count(), before);
});

test('POST /push/unsubscribe: an object as endpoint is 400, no longer 500; a number no longer 204', async () => {
  assertRefused(await call('POST', `${PUSH_PREFIX}/unsubscribe`, { json: { endpoint: {} } }), 'body/endpoint', 'endpoint {}');
  assertRefused(await call('POST', `${PUSH_PREFIX}/unsubscribe`, { json: { endpoint: 5 } }), 'body/endpoint', 'endpoint 5');
  assertRefused(await call('POST', `${PUSH_PREFIX}/unsubscribe`, { json: {} }), 'body/endpoint', 'endpoint missing');
  assertRefused(await call('POST', `${PUSH_PREFIX}/unsubscribe`), 'body', 'no body');
});

test('PUT /push/wall-mode and POST /push/test: garbage per field is 400', async () => {
  assertRefused(await call('PUT', `${PUSH_PREFIX}/wall-mode`, { json: { endpoint: ENDPOINT, active: 'yes' } }), 'body/active', 'active text');
  assertRefused(await call('PUT', `${PUSH_PREFIX}/wall-mode`, { json: { endpoint: 5, active: true } }), 'body/endpoint', 'endpoint 5');
  assertRefused(await call('PUT', `${PUSH_PREFIX}/wall-mode`, { json: { active: true } }), 'body/endpoint', 'endpoint missing');
  assertRefused(await call('PUT', `${PUSH_PREFIX}/wall-mode`), 'body', 'no body');
  sentPushes.length = 0;
  assertRefused(await call('POST', `${PUSH_PREFIX}/test`, { json: { title: 5 } }), 'body/title', 'title 5');
  assertRefused(await call('POST', `${PUSH_PREFIX}/test`, { json: { body: ['x'] } }), 'body/body', 'body list');
  assertRefused(await call('POST', `${PUSH_PREFIX}/test`, { json: { endpoint: 5 } }), 'body/endpoint', 'endpoint 5');
  assert.equal(sentPushes.length, 0, 'a refused test push sends nothing');
});

// ── The document ────────────────────────────────────────────────────────────

test('the document: 12 operations, each one with input answers the 400', () => {
  const spec = /** @type {any} */ (buildOpenApiSpec(null, '0.0.0-test'));
  const operations = Object.entries(spec.paths)
    .filter(([path]) => path.startsWith('/api/v1/preferences') || path.startsWith('/api/v1/push'))
    .flatMap(([path, item]) => Object.entries(/** @type {Record<string, any>} */ (item))
      .filter(([method]) => ['get', 'put', 'post', 'patch', 'delete'].includes(method))
      .map(([method, operation]) => ({ path, method, operation })));
  assert.equal(operations.length, 12);
  for (const { path, method, operation } of operations) {
    const input = operation.requestBody
      || (operation.parameters ?? []).some((/** @type {any} */ p) => p.in === 'path' || p.in === 'query');
    if (input) assert.ok(operation.responses[400], `${method} ${path} answers 400`);
  }
  assert.equal(spec.paths['/api/v1/push/test'].post.requestBody.required, false, 'the test push takes no body as well');
  assert.equal(spec.paths['/api/v1/preferences'].put.requestBody.required, true);
  assert.equal(spec.paths['/api/v1/push/subscribe'].post.responses[201] !== undefined, true);
  assert.equal(spec.paths['/api/v1/push/unsubscribe'].post.responses[204] !== undefined, true);
  assert.equal(spec.paths['/api/v1/push/wall-mode'].put.responses[204] !== undefined, true);
});
