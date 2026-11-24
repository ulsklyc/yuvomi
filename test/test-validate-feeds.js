/**
 * Test: group 13 behind validateRequest() - the ICS feeds, the birthday feed
 *       administration and `?download=` at the OpenAPI document (#2810,
 *       phase 2 E, step a)
 * Purpose: the last routes without the request check. The six feeds moved
 *          out of server/index.js into server/routes/ics-feeds.js and are run
 *          here in-process through test/feeds-app.js (the real router at
 *          `/feed`, the app's limiter, the central error handler with a log
 *          this suite reads). The birthday feed administration and the two
 *          addresses of the OpenAPI document are asked over the REAL server
 *          (test/server-ready.js): the document is sent by an inline route of
 *          server/index.js, and the 401/403 come from the real gates. Both
 *          share one database: the server starts first.
 *
 *          (1) FEEDS ANSWER AS BEFORE: per feed a known token 200
 *          `text/calendar` with the same headers, an unknown one 404
 *          `text/plain` `Not found`, a member without the module 200 with an
 *          empty calendar; the readings of the path (`x.ics.ics`, upper case,
 *          trailing slash, `%2F`, `%00`, 5000 characters, `?token=a&token=b`)
 *          are no 400 - the schema of `token` is only `type: string`.
 *          (2) FEED 500: a database error is the JSON 500 of the central
 *          handler (was `text/plain` `Internal error`), and the log names the
 *          route pattern, never the token.
 *          (3) LIMITER: one count of 30 per minute and address across the
 *          feeds; the 31st is 429.
 *          (4) BIRTHDAY FEED ADMINISTRATION: the three routes answer as
 *          before, anonymous 401.
 *          (5) DOWNLOAD: `1` sends the file, no parameter answers inline,
 *          `0`, `true`, empty and the key twice are 400 `reason: validation`
 *          with `fields`; anonymous 401 and a member 403 come first.
 * Run: npm run test:validate-feeds
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer } from './server-ready.js';
import { createFeedsApp } from './feeds-app.js';

const { baseUrl: SERVER } = await startTestServer({
  name: 'validate-feeds',
  env: { SESSION_SECRET: 'test-validate-feeds-secret-32-chars-min', TRUST_PROXY: '1' },
});
const db = (await import('../server/db.js')).get();

/** @type {{ level: string, args: any[] }[]} */
const logged = [];
const log = {
  warn: (/** @type {any[]} */ ...args) => logged.push({ level: 'warn', args }),
  error: (/** @type {any[]} */ ...args) => logged.push({ level: 'error', args }),
};
const app = await createFeedsApp({ log });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const FEEDS_BASE = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
test.after(() => { server.closeAllConnections?.(); server.close(); });

let requests = 0;
/** An address of its own per request: the feed limiter counts per address. */
function address() {
  requests += 1;
  return `10.${Math.floor(requests / 250) % 250}.${requests % 250}.13`;
}

/**
 * @param {string} base
 * @param {string} path
 * @param {{ method?: string, token?: string, from?: string }} [options]
 */
async function call(base, path, { method = 'GET', token, from } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-Forwarded-For': from ?? address(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    cache: res.headers.get('cache-control'),
  };
}

let counter = 0;
/** @param {string} role */
function insertUser(role = 'member') {
  counter += 1;
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?) RETURNING id
  `).get(`feedsuser${counter}`, `Feeds user ${counter}`, role).id);
}

/** @param {number} userId @param {string} secret */
function apiToken(userId, secret) {
  db.prepare("INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES ('t', ?, 'yuvomi_vfd', ?)")
    .run(crypto.createHash('sha256').update(secret).digest('hex'), userId);
  return secret;
}

const ADMIN = apiToken(insertUser('admin'), 'yuvomi_validate_feeds_admin_token_0001');
const MEMBER = apiToken(insertUser(), 'yuvomi_validate_feeds_member_token_0002');

db.prepare("INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Feeds birthday', '1990-05-12', ?)").run(insertUser());

/** Per feed: address, token column, module, file name of the answer. */
const FEEDS = [
  { feed: 'calendar', column: 'calendar_feed_token', module: 'calendar', file: 'yuvomi.ics' },
  { feed: 'birthdays', column: 'birthday_feed_token', module: 'calendar', file: 'yuvomi-birthdays.ics' },
  { feed: 'inventory-deadlines', column: 'inventory_deadlines_feed_token', module: 'inventory', file: 'yuvomi-inventory-deadlines.ics' },
  { feed: 'cycle', column: 'cycle_feed_token', module: 'health', file: 'yuvomi-cycle.ics' },
  { feed: 'schedule', column: 'schedule_feed_token', module: 'schedule', file: 'yuvomi-schedule.ics' },
  { feed: 'waste', column: 'waste_feed_token', module: 'waste', file: 'yuvomi-waste.ics' },
];
const owner = insertUser();
const denied = insertUser();
/** @type {Record<string, { valid: string, denied: string }>} */
const TOKENS = {};
for (const { feed, column, module } of FEEDS) {
  // 43 characters, the length of randomBytes(32).toString('base64url').
  TOKENS[feed] = { valid: `${feed.slice(0, 3)}${'A'.repeat(40)}`, denied: `${feed.slice(0, 3)}${'B'.repeat(40)}` };
  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(TOKENS[feed].valid, owner);
  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(TOKENS[feed].denied, denied);
  db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none') ON CONFLICT DO NOTHING
  `).run(String(denied), module);
}

/** @param {Awaited<ReturnType<typeof call>>} res @param {string} file @param {string} what */
function assertCalendar(res, file, what) {
  assert.equal(res.status, 200, `${what}: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.type, 'text/calendar; charset=utf-8', what);
  assert.equal(res.disposition, `inline; filename="${file}"`, what);
  assert.equal(res.cache, 'private, no-store', what);
  assert.ok(res.text.startsWith('BEGIN:VCALENDAR\r\n') && res.text.endsWith('END:VCALENDAR\r\n'), `${what}: not a calendar`);
}

/** @param {Awaited<ReturnType<typeof call>>} res @param {string} what */
function assertNotFound(res, what) {
  assert.equal(res.status, 404, `${what}: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.type, 'text/plain; charset=utf-8', what);
  assert.equal(res.text, 'Not found', what);
}

// --------------------------------------------------------------------------
// 1. FEEDS ANSWER AS BEFORE
// --------------------------------------------------------------------------
for (const { feed, file } of FEEDS) {
  test(`/feed/${feed}: known token 200, unknown 404, module none an empty calendar`, async () => {
    const path = `/feed/${feed}`;
    assertCalendar(await call(FEEDS_BASE, `${path}/${TOKENS[feed].valid}.ics`), file, 'known token');
    assertNotFound(await call(FEEDS_BASE, `${path}/${'Z'.repeat(43)}.ics`), 'unknown token');
    const empty = await call(FEEDS_BASE, `${path}/${TOKENS[feed].denied}.ics`);
    assertCalendar(empty, file, 'module none');
    assert.ok(!empty.text.includes('BEGIN:VEVENT'), 'module none delivers events');
  });

  test(`/feed/${feed}: the readings of the path answer as before, never 400`, async () => {
    const path = `/feed/${feed}`;
    const { valid } = TOKENS[feed];
    // Express matches without regard to case and takes a trailing slash: the token is the same.
    assertCalendar(await call(FEEDS_BASE, `${path}/${valid}.ICS`), file, 'upper-case extension');
    assertCalendar(await call(FEEDS_BASE, `/feed/${feed[0].toUpperCase()}${feed.slice(1)}/${valid}.ics`), file, 'upper-case kind');
    assertCalendar(await call(FEEDS_BASE, `${path}/${valid}.ics/`), file, 'trailing slash');
    assertCalendar(await call(FEEDS_BASE, `${path}/${valid}.ics?token=a&token=b`), file, 'query with a list');
    // Everything else is a token nobody holds: the sink answers 404.
    for (const reading of ['x.ics.ics', 'a%2Fb.ics', '%00.ics', '%E2%82%AC.ics', `${'L'.repeat(5000)}.ics`]) {
      assertNotFound(await call(FEEDS_BASE, `${path}/${reading}`), reading.slice(0, 20));
    }
  });
}

test('the documented answers of every feed: 200, 404, 429, 500, no 400', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const spec = buildOpenApiSpec(null, '0.0.0');
  for (const { feed } of FEEDS) {
    const operation = spec.paths[`/feed/${feed}/{token}.ics`].get;
    assert.deepEqual(Object.keys(operation.responses).sort(), ['200', '404', '429', '500'], feed);
    const token = operation.parameters.find((/** @type {any} */ p) => p.name === 'token');
    assert.deepEqual(token.schema, { type: 'string' }, `${feed}: token stays a plain string`);
  }
});

// --------------------------------------------------------------------------
// 2. FEED 500
// --------------------------------------------------------------------------
test('a feed whose database read fails answers the JSON 500, and the log carries no token', async () => {
  for (const { column } of FEEDS) db.exec(`ALTER TABLE users RENAME COLUMN ${column} TO ${column}_broken`);
  const from = logged.length;
  try {
    for (const { feed } of FEEDS) {
      const res = await call(FEEDS_BASE, `/feed/${feed}/${TOKENS[feed].valid}.ics`);
      assert.equal(res.status, 500, `${feed}: ${res.status} ${res.text}`);
      assert.equal(res.type, 'application/json; charset=utf-8', feed);
      assert.deepEqual(JSON.parse(res.text), { error: 'Internal server error.', code: 500 }, feed);
    }
  } finally {
    for (const { column } of FEEDS) db.exec(`ALTER TABLE users RENAME COLUMN ${column}_broken TO ${column}`);
  }
  const lines = logged.slice(from);
  assert.equal(lines.length, FEEDS.length, 'one log line per failed feed');
  const text = lines.map((l) => l.args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')).join('\n');
  for (const { feed } of FEEDS) {
    assert.ok(text.includes(`GET /feed/${feed}/:token.ics -> 500`), `the log names the pattern of ${feed}:\n${text}`);
    assert.ok(!text.includes(TOKENS[feed].valid), `the log carries the token of ${feed}`);
  }
});

// --------------------------------------------------------------------------
// 3. LIMITER
// --------------------------------------------------------------------------
test('the feeds share one limiter: the 31st request of an address within the minute is 429', async () => {
  const from = '10.250.13.1';
  for (let i = 0; i < 30; i += 1) {
    const feed = i % 2 ? 'calendar' : 'waste';
    const res = await call(FEEDS_BASE, `/feed/${feed}/${TOKENS[feed].valid}.ics`, { from });
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  assert.equal((await call(FEEDS_BASE, `/feed/birthdays/${TOKENS.birthdays.valid}.ics`, { from })).status, 429,
    'a third feed counts on the same limit');
  assert.equal((await call(FEEDS_BASE, `/feed/birthdays/${TOKENS.birthdays.valid}.ics`)).status, 200, 'another address is not limited');
});

// --------------------------------------------------------------------------
// 4. BIRTHDAY FEED ADMINISTRATION (real server)
// --------------------------------------------------------------------------
test('/api/v1/birthdays/feed: the three routes answer as before, anonymous 401', async () => {
  const none = await call(SERVER, '/api/v1/birthdays/feed', { token: MEMBER });
  assert.equal(none.status, 200);
  assert.equal(none.text, '{"data":null}');

  const regenerated = await call(SERVER, '/api/v1/birthdays/feed/regenerate', { method: 'POST', token: MEMBER });
  assert.equal(regenerated.status, 200, regenerated.text);
  const { data } = JSON.parse(regenerated.text);
  assert.deepEqual(Object.keys(data), ['token', 'url']);
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(data.url, `${SERVER}/feed/birthdays/${data.token}.ics`);

  const read = await call(SERVER, '/api/v1/birthdays/feed?x=1&x=2', { token: MEMBER });
  assert.equal(read.text, JSON.stringify({ data: { token: data.token, url: data.url } }));
  // The token it handed out opens the feed.
  assertCalendar(await call(FEEDS_BASE, `/feed/birthdays/${data.token}.ics`), 'yuvomi-birthdays.ics', 'regenerated token');

  const cleared = await call(SERVER, '/api/v1/birthdays/feed', { method: 'DELETE', token: MEMBER });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.text, '{"data":{"token":null}}');
  assertNotFound(await call(FEEDS_BASE, `/feed/birthdays/${data.token}.ics`), 'cleared token');

  for (const [method, path] of [['GET', '/api/v1/birthdays/feed'], ['POST', '/api/v1/birthdays/feed/regenerate'], ['DELETE', '/api/v1/birthdays/feed']]) {
    const anonymous = await call(SERVER, path, { method });
    assert.equal(anonymous.status, 401, `${method} ${path}`);
    assert.equal(anonymous.text, '{"error":"Not authenticated.","code":401}');
  }
});

// --------------------------------------------------------------------------
// 5. DOWNLOAD (real server)
// --------------------------------------------------------------------------
for (const path of ['/api/v1/openapi.json', '/openapi.json']) {
  test(`${path}: download=1 sends the file, no parameter answers inline`, async () => {
    const file = await call(SERVER, `${path}?download=1`, { token: ADMIN });
    assert.equal(file.status, 200);
    assert.equal(file.disposition, 'attachment; filename="openapi.json"');
    assert.equal(JSON.parse(file.text).openapi, '3.1.0');
    const inline = await call(SERVER, path, { token: ADMIN });
    assert.equal(inline.status, 200);
    assert.equal(inline.disposition, null);
    assert.equal(JSON.parse(inline.text).openapi, '3.1.0');
  });

  test(`${path}: download takes only 1 - 0, true, empty and the key twice are 400`, async () => {
    for (const [query, rule] of [['download=0', 'enum'], ['download=true', 'enum'], ['download=', 'enum'], ['download=1&download=1', 'type'], ['download=1&download=0', 'type']]) {
      const res = await call(SERVER, `${path}?${query}`, { token: ADMIN });
      assert.equal(res.status, 400, `${query}: ${res.status}`);
      assert.equal(res.disposition, null, query);
      assert.deepEqual(JSON.parse(res.text), {
        error: 'The request does not match the documented schema.', code: 400, reason: 'validation',
        fields: [{ path: 'query/download', rule }],
      }, query);
    }
  });

  test(`${path}: rights before shape - anonymous 401, a member 403 whatever download says`, async () => {
    for (const query of ['download=0', 'download=1&download=1', 'download=1']) {
      const anonymous = await call(SERVER, `${path}?${query}`);
      assert.equal(anonymous.status, 401, `anonymous ${query}`);
      const member = await call(SERVER, `${path}?${query}`, { token: MEMBER });
      assert.equal(member.status, 403, `member ${query}`);
      assert.equal(JSON.parse(member.text).reason, 'admin_required', query);
    }
  });
}

test('the document declares download as enum 1 with its 400 at both addresses', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const spec = buildOpenApiSpec(null, '0.0.0');
  for (const path of ['/api/v1/openapi.json', '/openapi.json']) {
    const operation = spec.paths[path].get;
    const download = operation.parameters.find((/** @type {any} */ p) => p.name === 'download');
    assert.equal(download.in, 'query', path);
    assert.equal(download.required, false, path);
    assert.deepEqual(download.schema, { type: 'string', enum: ['1'] }, path);
    assert.ok(operation.responses[400], `${path} documents its 400`);
    assert.ok(operation.responses[401] && operation.responses[403], `${path} documents 401 and 403`);
  }
});
