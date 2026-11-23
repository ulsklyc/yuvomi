/**
 * Test: the answers of the sign-in, session and own-account routes stay
 *       byte-equal (#2810, phase 2 section E, group 12a, step b)
 * Purpose: server/auth.js validates 34 of its 47 routes against their schema
 *          since #2903 (`validateRequest()`); step (b) drops the try/catch
 *          blocks of these 34 that answered an unexpected error with a 500 of
 *          their own, and keeps every hand check the schema does not cover on
 *          every input or that carries a reason of its own. This suite holds
 *          that refactor:
 *
 *          (1) A table of requests to all 34 operations through the real
 *          router at its real prefix (test/auth-app.js) with the real session
 *          - valid, every refusal the handlers keep, and the inputs the
 *          schema refuses in front of them (its 400 before and after) - for an
 *          admin, a member, a child, a split-expense guest, an API token and
 *          a signed-in device where it makes a difference. It pins status and
 *          the WHOLE body (and the redirect target); probe rows pin what is
 *          stored. The expectations were written before the refactor
 *          (bee6814a0) and are literal values in
 *          test/auth-answers-expected.js, no fixture file, no update mode.
 *          Secrets and random values (CSRF token, device credential, pairing
 *          code and its link and QR, TOTP secret, recovery codes) are masked
 *          by their key; a stamp of SQLite's own clock is masked by its form.
 *
 *          No network: no OIDC issuer (the OIDC variables are set only around
 *          rows that never reach the discovery), no SMTP, Gravatar through an
 *          injected fetch (buildGravatarRoute). The clock stands still
 *          (`mock.timers`, 23.11.2026 12:00 UTC) and moves one minute where a
 *          second TOTP code must not be a replay; the household lives in
 *          Europe/Berlin. Every limiter is generous (RATE_LIMIT_MAX_ATTEMPTS),
 *          and a generous limiter stands in front of the mounts.
 *
 *          (2) An unexpected error (the handler's first `res.json`/`send`/
 *          `end` throws; at `POST /logout` the session store fails) reaches
 *          the central error handler - 500 with its fixed sentence and its
 *          log line `Unhandled error: <METHOD> <pattern> -> 500` - at each of
 *          the 29 dropped catch blocks and at the logout callback, and the
 *          router answers again. A throw in an async handler is a rejected
 *          promise, which Express 5 hands on. What the routes handle keeps
 *          its answer: `POST /forgot-password` its 200.
 *
 *          (3) Each handler alone (without `validateRequest()`) keeps the
 *          type checks in front of a string method, a hash or `.trim()` on
 *          the raw value (sink, not route).
 * Run: npm run test:auth-answers
 */

process.env.SESSION_SECRET = 'auth-answers-secret-at-least-32-chars';
process.env.DB_PATH = ':memory:';
// The limiter of the sign-in counts every refusal; no limiter may stop a row.
process.env.RATE_LIMIT_MAX_ATTEMPTS = '1000000';
const OIDC_ENV = {
  OIDC_ISSUER: 'https://sso.example.test', OIDC_CLIENT_ID: 'yuvomi', OIDC_CLIENT_SECRET: 'not-used', OIDC_REDIRECT_URI: 'https://yuvomi.example.test/api/v1/auth/oidc/callback',
};
for (const key of [...Object.keys(OIDC_ENV), 'GRAVATAR_BASE_URL', 'AUTH_ALLOW_PASSWORD_LOGIN', 'SMTP_HOST', 'BASE_URL', 'NODE_ENV']) delete process.env[key];

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
// @ts-expect-error express 5 ships no type declarations (TS7016)
import express from 'express';
import rateLimit from 'express-rate-limit';
import { AUTH_PREFIX, createAuthApp } from './auth-app.js';
import { EXPECTED, CHANGED } from './auth-answers-expected.js';

mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T12:00:00Z') });
const FROZEN = '2026-11-23T1';

const dbmod = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { hashPassword } = await import('../server/utils/password.js');
const { generateCode } = await import('../server/utils/totp.js');
const twoFactor = await import('../server/services/two-factor.js');
const { passwordResetService } = await import('../server/services/password-reset.js');
const { inviteService } = await import('../server/services/invites.js');
const { GravatarError } = await import('../server/services/gravatar.js');
const database = () => dbmod.get();
/** createInvite() is typed without its defaults (JSDoc `= null`). */
const invites = /** @type {any} */ (inviteService);

database().prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();

const PASSWORD = 'correct-horse-1';
const NEW_PASSWORD = 'battery-staple-2';
const ADMIN_TOKEN = 'yuvomi_auth_answers_admin_token_0001';

/** @param {string} username @param {string} role @param {string} [familyRole] @param {string} [hash] */
async function account(username, role, familyRole = 'other', hash) {
  const passwordHash = hash ?? await hashPassword(PASSWORD, 4);
  return Number(database().prepare("INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color) VALUES (?, ?, ?, ?, ?, '#336699')")
    .run(username, username, passwordHash, role, familyRole).lastInsertRowid);
}

// ── Stand-ins: Gravatar and an invitation lost to a parallel accept ─────────
/** 'off' | 'picture' | 'none' | a GravatarError reason */
let gravatarMode = 'picture';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const gravatarFetch = async (/** @type {string | null} */ email) => {
  // The real fetch refuses an account without an address first.
  if (!email) throw new GravatarError('no_email', 'There is no email address to look up.');
  if (gravatarMode === 'picture') return { dataUrl: PNG, contentType: 'image/png', bytes: 68 };
  if (gravatarMode === 'none') return null;
  if (gravatarMode === 'throw') throw new Error('the fetch broke');
  throw new GravatarError(gravatarMode, `Gravatar failed: ${gravatarMode}.`);
};
const gravatarRouter = express.Router();
auth.buildGravatarRoute(gravatarRouter, { fetch: gravatarFetch, limiter: (/** @type {any} */ _req, /** @type {any} */ _res, /** @type {() => void} */ next) => next() });

let loseAccept = false;
const inviteRouter = express.Router();
auth.buildInviteRoutes(inviteRouter, {
  inviteService: { ...inviteService, markAccepted: (/** @type {string} */ token, /** @type {number} */ userId) => (loseAccept ? 0 : inviteService.markAccepted(token, userId)) },
  emailService: /** @type {any} */ ({ isConfigured: () => false, sendMail: async () => { throw new Error('no mail in this suite'); } }),
  limiter: (/** @type {any} */ _req, /** @type {any} */ _res, /** @type {() => void} */ next) => next(),
});

// ── The app ──────────────────────────────────────────────────────────────────
/** @type {{ warn: string[], error: string[] }} */
const logged = { warn: [], error: [] };
const log = { warn: (/** @type {string} */ line) => { logged.warn.push(line); }, error: (/** @type {string} */ line) => { logged.error.push(line); } };

const app = await createAuthApp({
  log,
  session: auth.sessionMiddleware,
  // An unexpected error on request: the handler's first answer throws, or the
  // session store fails to destroy the session.
  auth: (/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => {
    const fail = req.get('x-fail');
    if (fail === 'answer') {
      let thrown = false;
      for (const name of ['json', 'send', 'end']) {
        const original = res[name];
        res[name] = function (/** @type {unknown[]} */ ...args) {
          if (!thrown) { thrown = true; throw new Error(`${name} broke`); }
          return original.apply(this, args);
        };
      }
    }
    if (fail === 'destroy' && req.session) {
      req.session.destroy = (/** @type {(err: Error) => void} */ cb) => { setImmediate(() => cb(new Error('the session store broke'))); return req.session; };
    }
    next();
  },
  // server/index.js puts the general API limiter in front; a generous one here.
  before: [['/api/v1', rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false })]],
  routers: [gravatarRouter, inviteRouter, auth.router],
  jsonLimit: '2mb',
});
const server = app.listen(0, '127.0.0.1');
/** @type {string} */
const origin = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`)));
const BASE = `${origin}${AUTH_PREFIX}`;
test.after(() => { server.close(); mock.timers.reset(); });

// ── Requests ─────────────────────────────────────────────────────────────────
const NO_BODY = Symbol('no body');

/** Who calls: a session by name, `token:<name>` for a Bearer, or nobody. @type {Record<string, { cookie: string, csrf: string }>} */
const sessions = {};
/** @type {Record<string, string>} */
const bearers = { admintoken: ADMIN_TOKEN };
/** Values a later row needs (tokens, codes, secrets). @type {Record<string, any>} */
const kept = {};

/**
 * @typedef {{ as?: string, fail?: string, raw?: string, form?: Record<string, string>, keep?: (body: any) => void }} CallOptions
 */

/**
 * @param {string} method
 * @param {string} path below /api/v1/auth
 * @param {unknown} body a JSON value, NO_BODY, or a function returning one
 * @param {CallOptions} [opts]
 * @returns {Promise<{ status: number, body: any, location?: string, raw: any, cookie: string }>}
 */
async function call(method, path, body, { as, fail, raw, form } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let payload;
  const value = typeof body === 'function' ? body() : body;
  if (form) payload = new URLSearchParams(form);
  else if (raw !== undefined) { headers['Content-Type'] = 'application/json'; payload = raw; }
  else if (value !== NO_BODY) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(value); }
  if (as && bearers[as]) headers.Authorization = `Bearer ${bearers[as]}`;
  else if (as) {
    const session = sessions[as];
    assert.ok(session, `no session ${as}`);
    headers.Cookie = session.cookie;
    if (session.csrf) headers['X-CSRF-Token'] = session.csrf;
  }
  if (fail) headers['x-fail'] = fail;
  const res = await fetch(`${BASE}${typeof path === 'function' ? /** @type {() => string} */ (path)() : path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  /** @type {any} */
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = '<text>'; }
  }
  const location = res.headers.get('location');
  return { status: res.status, body: parsed, raw: parsed, ...(location ? { location } : {}), cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

/** Signs in through the route and keeps the session under `name`. @param {string} name @param {string} username @param {string} [password] */
async function signIn(name, username, password = PASSWORD) {
  const res = await call('POST', '/login', { username, password });
  assert.equal(res.status, 200, `sign in ${username}: ${JSON.stringify(res.body)}`);
  sessions[name] = { cookie: /** @type {any} */ (res).cookie, csrf: res.body.csrfToken ?? '' };
}

/** A minute on: the next TOTP code is not a replay of the last one. */
function nextMinute() {
  mock.timers.setTime(Date.now() + 60_000);
}

const SECRET_KEYS = new Set(['csrfToken', 'credential', 'secret', 'uri', 'qr', 'link']);

/** @param {unknown} value */
function normalized(value) {
  return JSON.parse(JSON.stringify(value ?? null), function (key, v) {
    if (SECRET_KEYS.has(key) && typeof v === 'string') return '<secret>';
    if (key === 'recovery_codes' && Array.isArray(v)) return `<${v.length} codes>`;
    // The pairing code; an error body's `code` is a number.
    if (key === 'code' && typeof v === 'string' && this && 'expires_at' in this) return '<secret>';
    // A stamp of SQLite's own clock (the frozen one stays).
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !v.startsWith(FROZEN)) return '<stamp>';
    return v;
  });
}

const users = () => database().prepare('SELECT username, display_name, role, family_role, avatar_color, avatar_data IS NOT NULL AS picture, onboarding_version, changelog_seen_latest, deactivated_at IS NOT NULL AS gone FROM users ORDER BY id').all();
const devices = () => database().prepare("SELECT name, platform, device_id, subject_user_id, revoked_at IS NOT NULL AS revoked FROM api_tokens WHERE kind = 'device' ORDER BY id").all();
const contact = (/** @type {string} */ username) => /** @type {any} */ (database().prepare(`
  SELECT c.phone, c.email FROM contacts c JOIN users u ON u.id = c.family_user_id WHERE u.username = ?`).get(username)) ?? null;
const birthday = (/** @type {string} */ username) => /** @type {any} */ (database().prepare(`
  SELECT b.birth_date FROM birthdays b JOIN users u ON u.id = b.family_user_id WHERE u.username = ?`).get(username))?.birth_date ?? null;

const DEVICE = { name: 'Lisa iPhone', platform: 'ios', device_id: 'install-0001' };
const EMOJI_40 = '\u{1F600}'.repeat(40);

/**
 * One row of the table: [name, method, path, body, opts?] for a request,
 * [name, 'PROBE', fn] for what is stored. Setup rows are (async) functions.
 * @type {Array<[string, string, string | (() => string), unknown, CallOptions?] | [string, 'PROBE', () => unknown] | (() => unknown)>}
 */
const STEPS = [
  // ══ POST /setup: the first account, then closed ═══════════════════════════
  ['setup no body', 'POST', '/setup', NO_BODY],
  ['setup username number', 'POST', '/setup', { username: 5, display_name: 'A', password: 'longenough1' }],
  ['setup empty', 'POST', '/setup', { username: '', display_name: 'A', password: 'longenough1' }],
  ['setup blank display', 'POST', '/setup', { username: 'gadmin', display_name: '   ', password: 'longenough1' }],
  ['setup username format', 'POST', '/setup', { username: 'g admin', display_name: 'A', password: 'longenough1' }],
  ['setup username short', 'POST', '/setup', { username: 'ga', display_name: 'A', password: 'longenough1' }],
  ['setup display long', 'POST', '/setup', { username: 'gadmin', display_name: 'x'.repeat(129), password: 'longenough1' }],
  ['setup display long trimmed', 'POST', '/setup', { username: 'gadmin', display_name: ` ${'x'.repeat(128)} `, password: 'x' }],
  ['setup password short', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'short12' }],
  ['setup password nfd', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'abcdefé' }],
  ['setup password long', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'x'.repeat(1025) }],
  ['setup language unknown', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'longenough1', language: 'xx' }],
  ['setup timezone unknown', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'longenough1', timezone: 'Mars/Olympus' }],
  ['setup timezone number', 'POST', '/setup', { username: 'gadmin', display_name: 'A', password: 'longenough1', timezone: 5 }],
  ['setup nothing created', 'PROBE', () => users()],
  () => { kept.random = Math.random; Math.random = () => 0; },
  ['setup', 'POST', '/setup', NO_BODY, { form: { username: 'gadmin', display_name: ' Linda ', password: PASSWORD, timezone: 'Europe/Berlin', language: 'de', extra: 'x' } }],
  () => { Math.random = kept.random; },
  ['setup created', 'PROBE', () => users()],
  ['setup again', 'POST', '/setup', { username: 'second', display_name: 'S', password: 'longenough1' }],
  ['setup again invalid', 'POST', '/setup', { username: 5 }],
  () => { process.env.NODE_ENV = 'production'; },
  ['setup again production', 'POST', '/setup', { username: 'second', display_name: 'S', password: 'longenough1' }],
  ['setup again production invalid', 'POST', '/setup', {}],
  () => { delete process.env.NODE_ENV; },

  // ══ Accounts ═══════════════════════════════════════════════════════════════
  async () => {
    const admin = /** @type {any} */ (database().prepare("SELECT id FROM users WHERE username = 'gadmin'").get()).id;
    kept.admin = admin;
    kept.mem = await account('gmem', 'member', 'mom');
    kept.kid = await account('gkid', 'member', 'child');
    kept.guest = await account('gguest', 'member');
    database().prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, NULL, ?)').run(kept.guest, admin);
    kept.twofa = await account('g2fa', 'member', 'dad');
    kept.sso = await account('gsso', 'member', 'other', '$oidc$');
    kept.gone = await account('ggone', 'member');
    database().prepare("UPDATE users SET deactivated_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(kept.gone);
    database().prepare("INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES ('t', ?, ?, ?)")
      .run(createHash('sha256').update(ADMIN_TOKEN).digest('hex'), ADMIN_TOKEN.slice(0, 12), admin);
  },

  // ══ POST /login ════════════════════════════════════════════════════════════
  ['login admin', 'POST', '/login', { username: 'gadmin', password: PASSWORD }],
  ['login form', 'POST', '/login', NO_BODY, { form: { username: 'gmem', password: PASSWORD } }],
  ['login wrong password', 'POST', '/login', { username: 'gmem', password: 'wrong-password' }],
  ['login unknown account', 'POST', '/login', { username: 'nobody', password: 'wrong-password' }],
  ['login empty username', 'POST', '/login', { username: '', password: PASSWORD }],
  ['login empty password', 'POST', '/login', { username: 'gmem', password: '' }],
  ['login no body', 'POST', '/login', NO_BODY],
  ['login username list', 'POST', '/login', { username: ['gmem'], password: PASSWORD }],
  ['login username object', 'POST', '/login', { username: { a: 1 }, password: PASSWORD }],
  ['login password number', 'POST', '/login', { username: 'gmem', password: 12345678 }],
  ['login username long', 'POST', '/login', { username: 'g'.repeat(65), password: PASSWORD }],
  ['login password long', 'POST', '/login', { username: 'gmem', password: 'x'.repeat(1025) }],
  ['login password 1024', 'POST', '/login', { username: 'gmem', password: 'x'.repeat(1024) }],
  ['login deactivated', 'POST', '/login', { username: 'ggone', password: PASSWORD }],
  ['login sso only', 'POST', '/login', { username: 'gsso', password: PASSWORD }],
  ['login guest', 'POST', '/login', { username: 'gguest', password: PASSWORD }],
  ['login broken json', 'POST', '/login', NO_BODY, { raw: '{"username":' }],
  // The household switched the password sign-in off: only the guest still signs in.
  () => {
    Object.assign(process.env, OIDC_ENV, { AUTH_ALLOW_PASSWORD_LOGIN: 'false' });
    database().prepare("UPDATE users SET oidc_sub = 'sub-admin', oidc_provider = 'https://sso.example.test' WHERE id = ?").run(kept.admin);
  },
  ['login password off', 'POST', '/login', { username: 'gmem', password: PASSWORD }],
  ['login password off wrong', 'POST', '/login', { username: 'gmem', password: 'wrong-password' }],
  ['login password off guest', 'POST', '/login', { username: 'gguest', password: PASSWORD }],
  ['oidc config password off', 'GET', '/oidc/config', NO_BODY],
  () => {
    for (const key of [...Object.keys(OIDC_ENV), 'AUTH_ALLOW_PASSWORD_LOGIN']) delete process.env[key];
    database().prepare('UPDATE users SET oidc_sub = NULL, oidc_provider = NULL WHERE id = ?').run(kept.admin);
  },
  async () => {
    await signIn('admin', 'gadmin');
    await signIn('mem', 'gmem');
    await signIn('kid', 'gkid');
    await signIn('guest', 'gguest');
  },

  // ══ GET /me, GET /users, GET /oidc/config, GET /oidc/link ═════════════════
  ['me admin', 'GET', '/me', NO_BODY, { as: 'admin' }],
  ['me mem', 'GET', '/me', NO_BODY, { as: 'mem' }],
  ['me guest', 'GET', '/me', NO_BODY, { as: 'guest' }],
  ['me token', 'GET', '/me', NO_BODY, { as: 'admintoken' }],
  ['me anonymous', 'GET', '/me', NO_BODY],
  ['users admin', 'GET', '/users', NO_BODY, { as: 'admin' }],
  ['users mem', 'GET', '/users', NO_BODY, { as: 'mem' }],
  ['users kid', 'GET', '/users', NO_BODY, { as: 'kid' }],
  ['users anonymous', 'GET', '/users', NO_BODY],
  ['oidc config', 'GET', '/oidc/config', NO_BODY],
  ['oidc link', 'GET', '/oidc/link', NO_BODY, { as: 'mem' }],
  ['oidc link anonymous', 'GET', '/oidc/link', NO_BODY],
  ['oidc start off', 'GET', '/oidc/start', NO_BODY],
  ['oidc link start off', 'POST', '/oidc/link/start', NO_BODY, { as: 'mem' }],
  ['oidc unlink not linked', 'DELETE', '/oidc/link', NO_BODY, { as: 'mem' }],
  ['oidc callback off', 'GET', '/oidc/callback?code=x&state=y', NO_BODY],

  // ══ POST /onboarding-seen, POST /changelog-seen ═══════════════════════════
  ['onboarding seen', 'POST', '/onboarding-seen', NO_BODY, { as: 'mem' }],
  ['onboarding seen kid', 'POST', '/onboarding-seen', {}, { as: 'kid' }],
  ['changelog seen', 'POST', '/changelog-seen', { latest: '2.95.0' }, { as: 'mem' }],
  ['changelog seen trimmed', 'POST', '/changelog-seen', { latest: ` ${'9'.repeat(64)} ` }, { as: 'mem' }],
  ['changelog seen too long', 'POST', '/changelog-seen', { latest: '9'.repeat(65) }, { as: 'mem' }],
  ['changelog seen empty', 'POST', '/changelog-seen', {}, { as: 'mem' }],
  ['changelog seen null', 'POST', '/changelog-seen', { latest: null }, { as: 'mem' }],
  ['changelog seen no body', 'POST', '/changelog-seen', NO_BODY, { as: 'kid' }],
  ['changelog seen number', 'POST', '/changelog-seen', { latest: 5 }, { as: 'mem' }],
  ['changelog seen guest', 'POST', '/changelog-seen', { latest: '2.95.0' }, { as: 'guest' }],
  ['seen stored', 'PROBE', () => users()],

  // ══ PATCH /me/profile ═════════════════════════════════════════════════════
  ['profile name', 'PATCH', '/me/profile', { display_name: '  Mia  ' }, { as: 'mem' }],
  ['profile empty', 'PATCH', '/me/profile', {}, { as: 'mem' }],
  ['profile no body', 'PATCH', '/me/profile', NO_BODY, { as: 'mem' }],
  ['profile blank name', 'PATCH', '/me/profile', { display_name: '   ' }, { as: 'mem' }],
  ['profile name long', 'PATCH', '/me/profile', { display_name: 'x'.repeat(129) }, { as: 'mem' }],
  ['profile name number', 'PATCH', '/me/profile', { display_name: 5 }, { as: 'mem' }],
  ['profile color', 'PATCH', '/me/profile', { avatar_color: '#ff9500' }, { as: 'mem' }],
  ['profile color css', 'PATCH', '/me/profile', { avatar_color: 'red; background: url(x)' }, { as: 'mem' }],
  ['profile color empty', 'PATCH', '/me/profile', { avatar_color: '' }, { as: 'mem' }],
  ['profile color null', 'PATCH', '/me/profile', { avatar_color: null }, { as: 'mem' }],
  ['profile picture', 'PATCH', '/me/profile', { avatar_data: PNG }, { as: 'mem' }],
  ['profile picture gif', 'PATCH', '/me/profile', { avatar_data: 'data:image/gif;base64,R0lGOD' }, { as: 'mem' }],
  ['profile picture text', 'PATCH', '/me/profile', { avatar_data: 'not a data url' }, { as: 'mem' }],
  ['profile picture empty', 'PATCH', '/me/profile', { avatar_data: '' }, { as: 'mem' }],
  ['profile picture number', 'PATCH', '/me/profile', { avatar_data: 5 }, { as: 'mem' }],
  ['profile picture removed', 'PATCH', '/me/profile', { avatar_data: null }, { as: 'mem' }],
  ['profile phone long', 'PATCH', '/me/profile', { phone: '1'.repeat(101) }, { as: 'mem' }],
  ['profile mail long', 'PATCH', '/me/profile', { email: `${'m'.repeat(196)}@x.de` }, { as: 'mem' }],
  ['profile mail 200', 'PATCH', '/me/profile', { email: `${'m'.repeat(195)}@x.de` }, { as: 'mem' }],
  ['profile mail invalid', 'PATCH', '/me/profile', { email: 'not-an-address' }, { as: 'mem' }],
  ['profile phone and mail', 'PATCH', '/me/profile', { phone: '+49 30 1234', email: 'mia@example.test' }, { as: 'mem' }],
  ['profile mail taken', 'PATCH', '/me/profile', { email: 'mia@example.test' }, { as: 'kid' }],
  ['profile mail taken case', 'PATCH', '/me/profile', { email: 'MIA@example.test' }, { as: 'kid' }],
  ['profile mail taken admin', 'PATCH', '/me/profile', { email: 'mia@example.test' }, { as: 'admin' }],
  ['profile birthday', 'PATCH', '/me/profile', { birth_date: '1990-05-17' }, { as: 'kid' }],
  ['profile birthday no year', 'PATCH', '/me/profile', { birth_date: '2000-05-17', birth_year_unknown: true }, { as: 'kid' }],
  ['profile birthday invalid', 'PATCH', '/me/profile', { birth_date: '1990-02-30' }, { as: 'kid' }],
  ['profile birthday empty', 'PATCH', '/me/profile', { birth_date: '' }, { as: 'kid' }],
  ['profile role ignored', 'PATCH', '/me/profile', { role: 'admin', family_role: 'dad', username: 'boss' }, { as: 'kid' }],
  ['profile guest', 'PATCH', '/me/profile', { display_name: 'G' }, { as: 'guest' }],
  ['profile token', 'PATCH', '/me/profile', { display_name: 'Linda T' }, { as: 'admintoken' }],
  ['profile anonymous', 'PATCH', '/me/profile', { display_name: 'x' }],
  ['profile stored', 'PROBE', () => ({ users: users(), mem: contact('gmem'), kid: contact('gkid'), admin: contact('gadmin'), kidBirthday: birthday('gkid') })],

  // ══ POST /me/avatar/gravatar ══════════════════════════════════════════════
  ['gravatar off', 'POST', '/me/avatar/gravatar', NO_BODY, { as: 'mem' }],
  ['gravatar off invalid', 'POST', '/me/avatar/gravatar', { email: 5 }, { as: 'mem' }],
  () => { process.env.GRAVATAR_BASE_URL = 'https://gravatar.example.test/avatar/'; },
  ['gravatar no email', 'POST', '/me/avatar/gravatar', NO_BODY, { as: 'kid' }],
  ['gravatar guest', 'POST', '/me/avatar/gravatar', {}, { as: 'guest' }],
  ['gravatar stale page', 'POST', '/me/avatar/gravatar', { email: 'other@example.test' }, { as: 'mem' }],
  ['gravatar email number', 'POST', '/me/avatar/gravatar', { email: 5 }, { as: 'mem' }],
  ['gravatar', 'POST', '/me/avatar/gravatar', { email: 'MIA@example.test' }, { as: 'mem' }],
  () => { gravatarMode = 'none'; },
  ['gravatar not found', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'gravatar_unreachable'; },
  ['gravatar unreachable', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'gravatar_too_large'; },
  ['gravatar too large', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'gravatar_not_image'; },
  ['gravatar not image', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'gravatar_rate_limited'; },
  ['gravatar rate limited', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'gravatar_bad_base_url'; },
  ['gravatar misconfigured', 'POST', '/me/avatar/gravatar', {}, { as: 'mem' }],
  () => { gravatarMode = 'picture'; delete process.env.GRAVATAR_BASE_URL; },
  ['gravatar stored', 'PROBE', () => users()],

  // ══ PATCH /me/password ════════════════════════════════════════════════════
  ['password empty', 'PATCH', '/me/password', { current_password: '', new_password: NEW_PASSWORD }, { as: 'kid' }],
  ['password new empty', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: '' }, { as: 'kid' }],
  ['password new short', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: 'short12' }, { as: 'kid' }],
  ['password new emoji', 'PATCH', '/me/password', { current_password: 'wrong-password', new_password: '\u{1F600}'.repeat(4) }, { as: 'kid' }],
  ['password camel case', 'PATCH', '/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { as: 'kid' }],
  ['password new number', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: 12345678 }, { as: 'kid' }],
  ['password new long', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: 'x'.repeat(1025) }, { as: 'kid' }],
  ['password wrong', 'PATCH', '/me/password', { current_password: 'wrong-password', new_password: NEW_PASSWORD }, { as: 'kid' }],
  ['password', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: NEW_PASSWORD }, { as: 'kid' }],
  ['password old sign-in', 'POST', '/login', { username: 'gkid', password: PASSWORD }],
  async () => { await signIn('kid', 'gkid', NEW_PASSWORD); },
  ['password new sign-in', 'GET', '/me', NO_BODY, { as: 'kid' }],
  ['password anonymous', 'PATCH', '/me/password', { current_password: PASSWORD, new_password: NEW_PASSWORD }],

  // ══ Password reset ════════════════════════════════════════════════════════
  ['forgot known', 'POST', '/forgot-password', { identifier: 'gmem' }],
  ['forgot unknown', 'POST', '/forgot-password', { identifier: 'nobody' }],
  ['forgot by mail', 'POST', '/forgot-password', { identifier: 'mia@example.test' }],
  ['forgot empty', 'POST', '/forgot-password', { identifier: '' }],
  ['forgot list', 'POST', '/forgot-password', { identifier: ['gmem'] }],
  ['forgot missing', 'POST', '/forgot-password', {}],
  () => {
    kept.resetMem = passwordResetService.createToken(kept.mem).token;
    kept.resetGone = passwordResetService.createToken(kept.gone).token;
    kept.resetSso = passwordResetService.createToken(kept.sso).token;
    // An expired one: issued two hours ago.
    mock.timers.setTime(Date.now() - 2 * 60 * 60 * 1000);
    kept.resetOld = passwordResetService.createToken(kept.twofa).token;
    mock.timers.setTime(Date.now() + 2 * 60 * 60 * 1000);
  },
  ['check valid', 'POST', '/reset-password/check', () => ({ token: kept.resetMem })],
  ['check unknown', 'POST', '/reset-password/check', { token: 'not-a-token' }],
  ['check empty', 'POST', '/reset-password/check', { token: '' }],
  ['check expired', 'POST', '/reset-password/check', () => ({ token: kept.resetOld })],
  ['check deactivated', 'POST', '/reset-password/check', () => ({ token: kept.resetGone })],
  ['check sso only', 'POST', '/reset-password/check', () => ({ token: kept.resetSso })],
  ['check number', 'POST', '/reset-password/check', { token: 5 }],
  ['check missing', 'POST', '/reset-password/check', {}],
  ['reset empty token', 'POST', '/reset-password', { token: '', password: 'longenough1' }],
  ['reset empty password', 'POST', '/reset-password', () => ({ token: kept.resetMem, password: '' })],
  ['reset short', 'POST', '/reset-password', () => ({ token: kept.resetMem, password: 'short12' })],
  ['reset nfd short', 'POST', '/reset-password', () => ({ token: kept.resetMem, password: 'abcdefé' })],
  ['reset unknown token', 'POST', '/reset-password', { token: 'not-a-token', password: 'longenough1' }],
  ['reset expired', 'POST', '/reset-password', () => ({ token: kept.resetOld, password: 'longenough1' })],
  ['reset deactivated', 'POST', '/reset-password', () => ({ token: kept.resetGone, password: 'longenough1' })],
  ['reset deactivated again', 'POST', '/reset-password/check', () => ({ token: kept.resetGone })],
  ['reset token number', 'POST', '/reset-password', { token: 5, password: 'longenough1' }],
  ['reset token object', 'POST', '/reset-password', { token: { a: 1 }, password: 'longenough1' }],
  ['reset password long', 'POST', '/reset-password', { token: 'abc', password: 'x'.repeat(1025) }],
  ['reset', 'POST', '/reset-password', () => ({ token: kept.resetMem, password: NEW_PASSWORD })],
  ['reset spent', 'POST', '/reset-password', () => ({ token: kept.resetMem, password: NEW_PASSWORD })],
  ['reset signs in', 'POST', '/login', { username: 'gmem', password: NEW_PASSWORD }],
  ['reset ended the session', 'GET', '/me', NO_BODY, { as: 'mem' }],
  async () => { await signIn('mem', 'gmem', NEW_PASSWORD); },

  // ══ Invitations: preview and accept ═══════════════════════════════════════
  () => {
    kept.inviteFree = invites.createInvite({ displayName: 'Opa', familyRole: 'grandparent', createdBy: kept.admin }).token;
    kept.inviteNamed = invites.createInvite({ username: 'gnamed', displayName: 'Named', createdBy: kept.admin }).token;
    kept.inviteTaken = invites.createInvite({ username: 'gmem', displayName: 'Taken', createdBy: kept.admin }).token;
    kept.inviteLost = invites.createInvite({ displayName: 'Lost', createdBy: kept.admin }).token;
    kept.inviteBare = invites.createInvite({ createdBy: kept.admin }).token;
    mock.timers.setTime(Date.now() - 30 * 24 * 60 * 60 * 1000);
    kept.inviteOld = invites.createInvite({ displayName: 'Old', createdBy: kept.admin }).token;
    mock.timers.setTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
  },
  ['preview', 'GET', () => `/invites/preview?token=${kept.inviteFree}`, NO_BODY],
  ['preview named', 'GET', () => `/invites/preview?token=${kept.inviteNamed}`, NO_BODY],
  ['preview unknown', 'GET', '/invites/preview?token=nope', NO_BODY],
  ['preview empty', 'GET', '/invites/preview?token=', NO_BODY],
  ['preview expired', 'GET', () => `/invites/preview?token=${kept.inviteOld}`, NO_BODY],
  ['preview missing', 'GET', '/invites/preview', NO_BODY],
  ['preview twice', 'GET', '/invites/preview?token=a&token=b', NO_BODY],
  ['accept no token', 'POST', '/invites/accept', { token: '', password: 'longenough1', username: 'gopa' }],
  ['accept token number', 'POST', '/invites/accept', { token: 5, password: 'longenough1' }],
  ['accept missing token', 'POST', '/invites/accept', { password: 'longenough1' }],
  ['accept unknown', 'POST', '/invites/accept', { token: 'nope', password: 'longenough1', username: 'gopa' }],
  ['accept expired', 'POST', '/invites/accept', () => ({ token: kept.inviteOld, password: 'longenough1', username: 'gold' })],
  ['accept no password', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, username: 'gopa' })],
  ['accept short', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, password: 'short12', username: 'gopa' })],
  ['accept nfd short', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, password: 'abcdefé', username: 'gopa' })],
  ['accept password long', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, password: 'x'.repeat(1025), username: 'gopa' })],
  ['accept username format', 'POST', '/invites/accept', () => ({ token: kept.inviteBare, password: 'longenough1', username: 'g o' })],
  ['accept username missing', 'POST', '/invites/accept', () => ({ token: kept.inviteBare, password: 'longenough1' })],
  ['accept display long', 'POST', '/invites/accept', () => ({ token: kept.inviteBare, password: 'longenough1', username: 'gbare', display_name: 'x'.repeat(129) })],
  ['accept display long trimmed', 'POST', '/invites/accept', () => ({ token: kept.inviteBare, password: 'longenough1', username: 'gbare', display_name: ` ${'x'.repeat(128)} ` })],
  ['accept taken', 'POST', '/invites/accept', () => ({ token: kept.inviteTaken, password: 'longenough1' })],
  () => { loseAccept = true; },
  ['accept lost', 'POST', '/invites/accept', () => ({ token: kept.inviteLost, password: 'longenough1', username: 'glost' })],
  () => { loseAccept = false; },
  ['accept', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, password: 'longenough1', username: 'gopa', display_name: 'Opa' })],
  ['accept named', 'POST', '/invites/accept', () => ({ token: kept.inviteNamed, password: 'longenough1', username: 'other', role: 'admin' })],
  ['accept spent', 'POST', '/invites/accept', () => ({ token: kept.inviteFree, password: 'longenough1', username: 'gopa2' })],
  // An accepted invitation draws its colour at random (crypto.randomInt): masked
  // here, then fixed for the lists further down.
  ['accept stored', 'PROBE', () => users().map((/** @type {any} */ row) => (['gopa', 'gnamed', 'gbare'].includes(row.username) ? { ...row, avatar_color: '<random>' } : row))],
  () => { database().prepare("UPDATE users SET avatar_color = '#5856D6' WHERE username IN ('gopa', 'gnamed', 'gbare')").run(); },

  // ══ Second factor ═════════════════════════════════════════════════════════
  async () => { await signIn('twofa', 'g2fa'); },
  ['2fa status', 'GET', '/2fa', NO_BODY, { as: 'twofa' }],
  ['2fa enable no setup', 'POST', '/2fa/enable', { code: '123456' }, { as: 'twofa' }],
  ['2fa disable not enabled', 'POST', '/2fa/disable', { code: '123456' }, { as: 'twofa' }],
  ['2fa disable not enabled invalid', 'POST', '/2fa/disable', { code: 5 }, { as: 'twofa' }],
  ['2fa recovery not enabled', 'POST', '/2fa/recovery-codes', { code: '123456' }, { as: 'twofa' }],
  ['2fa setup', 'POST', '/2fa/setup', NO_BODY, { as: 'twofa', keep: (body) => { kept.secret = body.data.secret; } }],
  ['2fa enable wrong', 'POST', '/2fa/enable', { code: '000000' }, { as: 'twofa' }],
  ['2fa enable emoji', 'POST', '/2fa/enable', { code: EMOJI_40 }, { as: 'twofa' }],
  ['2fa enable long', 'POST', '/2fa/enable', { code: 'x'.repeat(65) }, { as: 'twofa' }],
  ['2fa enable number', 'POST', '/2fa/enable', { code: 123456 }, { as: 'twofa' }],
  ['2fa enable no body', 'POST', '/2fa/enable', NO_BODY, { as: 'twofa' }],
  nextMinute,
  ['2fa enable', 'POST', '/2fa/enable', () => ({ code: generateCode(kept.secret) }), { as: 'twofa' }],
  ['2fa setup again', 'POST', '/2fa/setup', {}, { as: 'twofa' }],
  ['2fa enable again', 'POST', '/2fa/enable', { code: '123456' }, { as: 'twofa' }],
  ['2fa status on', 'GET', '/2fa', NO_BODY, { as: 'twofa' }],
  // The sign-in with the second factor.
  ['2fa verify no pending', 'POST', '/2fa/verify', { code: '123456' }],
  ['2fa verify no pending invalid', 'POST', '/2fa/verify', { code: 5 }],
  ['2fa login', 'POST', '/login', { username: 'g2fa', password: PASSWORD }, { keep: (body) => { kept.pendingBody = body; } }],
  async () => {
    const res = await call('POST', '/login', { username: 'g2fa', password: PASSWORD });
    sessions.pending = { cookie: /** @type {any} */ (res).cookie, csrf: '' };
  },
  ['2fa verify wrong', 'POST', '/2fa/verify', { code: '000000' }, { as: 'pending' }],
  ['2fa verify emoji', 'POST', '/2fa/verify', { code: EMOJI_40 }, { as: 'pending' }],
  ['2fa verify long', 'POST', '/2fa/verify', { code: 'x'.repeat(65) }, { as: 'pending' }],
  ['2fa verify empty', 'POST', '/2fa/verify', { code: '' }, { as: 'pending' }],
  nextMinute,
  ['2fa verify', 'POST', '/2fa/verify', () => ({ code: generateCode(kept.secret) }), { as: 'pending' }],
  ['2fa verify spent', 'POST', '/2fa/verify', { code: '000000' }, { as: 'pending' }],
  // The pending sign-in ends after its window.
  async () => {
    const res = await call('POST', '/login', { username: 'g2fa', password: PASSWORD });
    sessions.late = { cookie: /** @type {any} */ (res).cookie, csrf: '' };
    mock.timers.setTime(Date.now() + 60 * 60 * 1000);
  },
  ['2fa verify too late', 'POST', '/2fa/verify', { code: '000000' }, { as: 'late' }],
  async () => {
    const res = await call('POST', '/login', { username: 'g2fa', password: PASSWORD });
    sessions.blocked = { cookie: /** @type {any} */ (res).cookie, csrf: '' };
    database().prepare("UPDATE users SET deactivated_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(kept.twofa);
  },
  ['2fa verify deactivated', 'POST', '/2fa/verify', { code: '000000' }, { as: 'blocked' }],
  () => { database().prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(kept.twofa); },
  async () => {
    await signIn('twofa', 'g2fa').catch(() => {});
    const first = await call('POST', '/login', { username: 'g2fa', password: PASSWORD });
    nextMinute();
    const second = await fetch(`${BASE}/2fa/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: /** @type {any} */ (first).cookie }, body: JSON.stringify({ code: generateCode(kept.secret) }) });
    const body = await second.json();
    sessions.twofa = { cookie: second.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: body.csrfToken };
  },
  ['2fa recovery wrong', 'POST', '/2fa/recovery-codes', { code: '000000' }, { as: 'twofa' }],
  ['2fa recovery emoji', 'POST', '/2fa/recovery-codes', { code: EMOJI_40 }, { as: 'twofa' }],
  ['2fa recovery number', 'POST', '/2fa/recovery-codes', { code: 5 }, { as: 'twofa' }],
  nextMinute,
  ['2fa recovery', 'POST', '/2fa/recovery-codes', () => ({ code: generateCode(kept.secret) }), { as: 'twofa', keep: (body) => { kept.recovery = body.data.recovery_codes; } }],
  ['2fa disable wrong', 'POST', '/2fa/disable', { code: '000000' }, { as: 'twofa' }],
  ['2fa disable emoji', 'POST', '/2fa/disable', { code: EMOJI_40 }, { as: 'twofa' }],
  () => { twoFactor.setRequiredForHousehold(database(), true); },
  ['2fa disable required', 'POST', '/2fa/disable', () => ({ code: kept.recovery[0] }), { as: 'twofa' }],
  ['2fa disable required invalid', 'POST', '/2fa/disable', { code: 5 }, { as: 'twofa' }],
  () => { twoFactor.setRequiredForHousehold(database(), false); },
  ['2fa disable', 'POST', '/2fa/disable', () => ({ code: kept.recovery[0] }), { as: 'twofa' }],
  ['2fa status off', 'GET', '/2fa', NO_BODY, { as: 'twofa' }],
  ['2fa setup anonymous', 'POST', '/2fa/setup', NO_BODY],
  ['2fa setup token', 'POST', '/2fa/setup', NO_BODY, { as: 'admintoken' }],

  // ══ Signed-in devices and pairing ═════════════════════════════════════════
  ['devices empty', 'GET', '/devices', NO_BODY, { as: 'mem' }],
  ['device token', 'POST', '/devices', DEVICE, { as: 'admintoken' }],
  ['device token invalid', 'POST', '/devices', {}, { as: 'admintoken' }],
  ['device guest', 'POST', '/devices', DEVICE, { as: 'guest' }],
  ['device blank name', 'POST', '/devices', { ...DEVICE, name: '   ' }, { as: 'mem' }],
  ['device name long', 'POST', '/devices', { ...DEVICE, name: 'x'.repeat(101) }, { as: 'mem' }],
  ['device name long trimmed', 'POST', '/devices', { ...DEVICE, name: ` ${'x'.repeat(98)} `, device_id: 'install-trim' }, { as: 'mem', keep: (body) => { kept.trimmedDevice = body.data?.id; } }],
  ['device platform upper', 'POST', '/devices', { ...DEVICE, platform: 'iOS' }, { as: 'mem' }],
  ['device platform list', 'POST', '/devices', { ...DEVICE, platform: ['ios'] }, { as: 'mem' }],
  ['device id short', 'POST', '/devices', { ...DEVICE, device_id: 'short' }, { as: 'mem' }],
  ['device id number', 'POST', '/devices', { ...DEVICE, device_id: 12345678 }, { as: 'mem' }],
  ['device missing', 'POST', '/devices', { name: 'x' }, { as: 'mem' }],
  ['device', 'POST', '/devices', DEVICE, { as: 'mem', keep: (body) => { bearers.device = body.credential; kept.device = body.data.id; } }],
  ['device again', 'POST', '/devices', DEVICE, { as: 'mem', keep: (body) => { bearers.device = body.credential; kept.device = body.data.id; } }],
  ['device kid', 'POST', '/devices', { ...DEVICE, name: 'Kim', device_id: 'install-kid-1' }, { as: 'kid', keep: (body) => { kept.kidDevice = body.data.id; } }],
  ['device by device', 'POST', '/devices', { ...DEVICE, device_id: 'install-0002' }, { as: 'device' }],
  ['devices mem', 'GET', '/devices', NO_BODY, { as: 'mem' }],
  ['devices device', 'GET', '/devices', NO_BODY, { as: 'device' }],
  ['devices token', 'GET', '/devices', NO_BODY, { as: 'admintoken' }],
  ['me device', 'GET', '/me', NO_BODY, { as: 'device' }],
  ['users device', 'GET', '/users', NO_BODY, { as: 'device' }],
  ['changelog device', 'POST', '/changelog-seen', {}, { as: 'device' }],
  ['pair', 'POST', '/devices/pair', { server: 'https://yuvomi.example.test' }, { as: 'mem', keep: (body) => { kept.pair = body.data.code; } }],
  ['pair path', 'POST', '/devices/pair', { server: 'https://yuvomi.example.test/app' }, { as: 'mem' }],
  ['pair scheme', 'POST', '/devices/pair', { server: 'ftp://yuvomi.example.test' }, { as: 'mem' }],
  ['pair number', 'POST', '/devices/pair', { server: 5 }, { as: 'mem' }],
  ['pair missing', 'POST', '/devices/pair', {}, { as: 'mem' }],
  ['pair token', 'POST', '/devices/pair', { server: 5 }, { as: 'admintoken' }],
  ['pair device', 'POST', '/devices/pair', { server: 'https://yuvomi.example.test' }, { as: 'device' }],
  ['pair guest', 'POST', '/devices/pair', { server: 'https://yuvomi.example.test' }, { as: 'guest' }],
  ['redeem wrong code', 'POST', '/devices/pair/redeem', { ...DEVICE, code: 'AAAA-BBBB', device_id: 'install-0003' }],
  ['redeem blank name', 'POST', '/devices/pair/redeem', () => ({ ...DEVICE, name: ' ', code: kept.pair, device_id: 'install-0003' })],
  ['redeem platform', 'POST', '/devices/pair/redeem', () => ({ ...DEVICE, platform: 'I', code: kept.pair, device_id: 'install-0003' })],
  ['redeem code number', 'POST', '/devices/pair/redeem', { ...DEVICE, code: 5, device_id: 'install-0003' }],
  ['redeem', 'POST', '/devices/pair/redeem', () => ({ ...DEVICE, code: String(kept.pair).toLowerCase(), device_id: 'install-0003' })],
  ['redeem spent', 'POST', '/devices/pair/redeem', () => ({ ...DEVICE, code: kept.pair, device_id: 'install-0004' })],
  async () => {
    const res = await call('POST', '/devices/pair', { server: 'https://yuvomi.example.test' }, { as: 'mem' });
    kept.pairLate = res.raw.data.code;
    mock.timers.setTime(Date.now() + 10 * 60 * 1000);
  },
  ['redeem expired', 'POST', '/devices/pair/redeem', () => ({ ...DEVICE, code: kept.pairLate, device_id: 'install-0005' })],
  ['revoke current session', 'DELETE', '/devices/current', NO_BODY, { as: 'mem' }],
  ['revoke current token', 'DELETE', '/devices/current', NO_BODY, { as: 'admintoken' }],
  ['revoke foreign', 'DELETE', () => `/devices/${kept.kidDevice}`, NO_BODY, { as: 'mem' }],
  ['revoke unknown', 'DELETE', '/devices/9999', NO_BODY, { as: 'mem' }],
  ['revoke negative', 'DELETE', '/devices/-1', NO_BODY, { as: 'mem' }],
  ['revoke zero', 'DELETE', '/devices/0', NO_BODY, { as: 'mem' }],
  ['revoke decimal', 'DELETE', '/devices/1.0', NO_BODY, { as: 'mem' }],
  ['revoke exponent', 'DELETE', '/devices/1e1', NO_BODY, { as: 'mem' }],
  ['revoke text', 'DELETE', '/devices/abc', NO_BODY, { as: 'mem' }],
  ['revoke too big', 'DELETE', '/devices/9007199254740992', NO_BODY, { as: 'mem' }],
  ['revoke token', 'DELETE', () => `/devices/${kept.kidDevice}`, NO_BODY, { as: 'admintoken' }],
  ['revoke trimmed', 'DELETE', () => `/devices/0${kept.trimmedDevice}`, NO_BODY, { as: 'mem' }],
  ['revoke own', 'DELETE', () => `/devices/${kept.kidDevice}`, NO_BODY, { as: 'kid' }],
  ['revoke current', 'DELETE', '/devices/current', NO_BODY, { as: 'device' }],
  ['revoked device', 'GET', '/me', NO_BODY, { as: 'device' }],
  ['devices stored', 'PROBE', () => devices()],

  // ══ POST /logout-others, POST /logout ═════════════════════════════════════
  async () => { await signIn('mem2', 'gmem', NEW_PASSWORD); },
  ['logout others token', 'POST', '/logout-others', NO_BODY, { as: 'admintoken' }],
  ['logout others', 'POST', '/logout-others', NO_BODY, { as: 'mem' }],
  ['logout others ended', 'GET', '/me', NO_BODY, { as: 'mem2' }],
  ['logout others kept', 'GET', '/users', NO_BODY, { as: 'mem' }],
  ['logout token', 'POST', '/logout', NO_BODY, { as: 'admintoken' }],
  ['logout anonymous', 'POST', '/logout', NO_BODY],
  ['logout', 'POST', '/logout', NO_BODY, { as: 'kid' }],
  ['logout ended', 'GET', '/me', NO_BODY, { as: 'kid' }],
  // A session store that fails: the sentence changes (CHANGED).
  ['logout store fails', 'POST', '/logout', NO_BODY, { as: 'guest', fail: 'destroy' }],
  ['logout store failed', 'GET', '/me', NO_BODY, { as: 'guest' }],
  // An error in the OIDC start: the sentence changes (CHANGED).
  ['oidc start fails', 'GET', '/oidc/start', NO_BODY, { fail: 'answer' }],
  ['oidc link start fails', 'POST', '/oidc/link/start', NO_BODY, { as: 'admin', fail: 'answer' }],
  ['oidc after', 'GET', '/oidc/start', NO_BODY],
];

/** @param {Record<string, { status?: number, body?: unknown, location?: string, probe?: unknown }>} answers @param {Record<string, string[]>} logs */
async function runTable(answers, logs) {
  for (const step of STEPS) {
    if (typeof step === 'function') { await step(); continue; }
    const [name, method] = step;
    assert.ok(!Object.hasOwn(answers, name), `row name twice: ${name}`);
    if (method === 'PROBE') {
      answers[name] = { probe: normalized(/** @type {() => unknown} */ (step[2])()) };
      continue;
    }
    const [, , path, body, opts] = /** @type {[string, string, string, unknown, CallOptions?]} */ (step);
    logged.error.length = 0;
    const actual = await call(method, path, body, opts);
    if (opts?.keep && actual.status < 300) opts.keep(actual.raw);
    answers[name] = { status: actual.status, body: normalized(actual.body), ...(actual.location ? { location: actual.location } : {}) };
    if (logged.error.length) logs[name] = logged.error.splice(0);
  }
  return answers;
}

// ── (2a) POST /setup: the only state in which its handler runs ───────────────
test('POST /setup: an unexpected error before the first account is a 500 of the central handler, and the setup goes on', async () => {
  logged.error.length = 0;
  // The handler refuses the username; that answer throws.
  const res = await call('POST', '/setup', { username: 'g o', display_name: 'A', password: 'longenough1' }, { fail: 'answer' });
  assert.deepEqual({ status: res.status, body: res.body }, { status: 500, body: { error: 'Internal server error.', code: 500 } });
  assert.deepEqual(logged.error, [`Unhandled error: POST ${AUTH_PREFIX}/setup -> 500`]);
  logged.error.length = 0;
  assert.equal(/** @type {any} */ (database().prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0, 'nothing created');
});

// ── (1) The table ────────────────────────────────────────────────────────────
test('every answer of the table is the one before the refactor (status and whole body)', async () => {
  /** @type {Record<string, { status?: number, body?: unknown, probe?: unknown }>} */
  const answers = {};
  /** @type {Record<string, string[]>} */
  const logs = {};
  try {
    await runTable(answers, logs);
  } finally {
    if (process.env.AUTH_ANSWERS_DUMP) fs.writeFileSync(process.env.AUTH_ANSWERS_DUMP, JSON.stringify({ answers, logs }));
  }
  for (const [name, answer] of Object.entries(answers)) {
    if (Object.hasOwn(CHANGED, name)) {
      assert.deepEqual(answer, CHANGED[name].now, `${name} (changed on purpose)`);
      continue;
    }
    assert.ok(Object.hasOwn(EXPECTED, name), `no expectation for ${name}`);
    assert.deepEqual(answer, EXPECTED[name], name);
  }
  assert.equal(Object.keys(answers).length, Object.keys(EXPECTED).length + Object.keys(CHANGED).length, 'every expectation has its row');
  // Only the rows that changed on purpose reach the central handler; every
  // other row is an answer of the route itself.
  assert.deepEqual(logs, Object.fromEntries(Object.entries(CHANGED).filter(([, row]) => row.log).map(([name, row]) => [name, [row.log]])), 'only these rows reached the central handler');
});

// ── (2) Unexpected errors: the central error handler ─────────────────────────
/**
 * The answer and the log line of the central handler.
 * @param {{ status: number, body: unknown }} res
 * @param {string} method
 * @param {string} route the route below the prefix
 */
function assertCentral(res, method, route) {
  const pattern = `${AUTH_PREFIX}${route}`;
  assert.deepEqual({ status: res.status, body: res.body }, { status: 500, body: { error: 'Internal server error.', code: 500 } }, `${method} ${pattern}`);
  assert.deepEqual(logged.error, [`Unhandled error: ${method} ${pattern} -> 500`], `${method} ${pattern}: the central handler logged it`);
  logged.error.length = 0;
}

test('an unexpected error in each of the 28 other dropped catch blocks is a 500 of the central handler, and the router goes on', async () => {
  await signIn('admin', 'gadmin');
  await signIn('mem', 'gmem', NEW_PASSWORD);
  const device = await call('POST', '/devices', { ...DEVICE, device_id: 'install-fail' }, { as: 'mem' });
  assert.equal(device.status, 201);
  bearers.failing = device.raw.credential;
  logged.error.length = 0;
  /** @type {Array<[string, string, unknown, string | undefined, string]>} [method, path, body, as, route pattern] */
  const rows = [
    // Async handlers: the throw is a rejected promise, which Express 5 hands on.
    ['POST', '/login', { username: 'nobody', password: 'wrong-password' }, undefined, '/login'],
    ['POST', '/login', { username: 'gmem', password: NEW_PASSWORD }, undefined, '/login'],
    ['POST', '/reset-password', { token: 'not-a-token', password: 'longenough1' }, undefined, '/reset-password'],
    ['POST', '/invites/accept', { token: 'not-a-token' }, undefined, '/invites/accept'],
    ['POST', '/2fa/verify', { code: '123456' }, undefined, '/2fa/verify'],
    ['POST', '/me/avatar/gravatar', {}, 'admin', '/me/avatar/gravatar'],
    ['PATCH', '/me/password', { current_password: 'a', new_password: 'short' }, 'admin', '/me/password'],
    // Synchronous handlers.
    ['POST', '/reset-password/check', { token: 'not-a-token' }, undefined, '/reset-password/check'],
    ['GET', '/invites/preview?token=nope', NO_BODY, undefined, '/invites/preview'],
    ['POST', '/logout-others', NO_BODY, 'admin', '/logout-others'],
    ['GET', '/me', NO_BODY, 'admin', '/me'],
    ['POST', '/onboarding-seen', NO_BODY, 'admin', '/onboarding-seen'],
    ['POST', '/changelog-seen', {}, 'admin', '/changelog-seen'],
    ['GET', '/2fa', NO_BODY, 'admin', '/2fa'],
    ['POST', '/2fa/setup', NO_BODY, 'mem', '/2fa/setup'],
    ['POST', '/2fa/enable', { code: EMOJI_40 }, 'mem', '/2fa/enable'],
    ['POST', '/2fa/disable', { code: '123456' }, 'mem', '/2fa/disable'],
    ['POST', '/2fa/recovery-codes', { code: '123456' }, 'mem', '/2fa/recovery-codes'],
    ['POST', '/devices', { ...DEVICE, name: ' ' }, 'mem', '/devices'],
    ['POST', '/devices/pair', { server: 'nope' }, 'mem', '/devices/pair'],
    ['POST', '/devices/pair/redeem', { ...DEVICE, name: ' ', code: 'AAAA-BBBB' }, undefined, '/devices/pair/redeem'],
    ['GET', '/devices', NO_BODY, 'mem', '/devices'],
    ['DELETE', '/devices/current', NO_BODY, 'failing', '/devices/current'],
    ['DELETE', '/devices/9999', NO_BODY, 'mem', '/devices/:id'],
    ['GET', '/users', NO_BODY, 'admin', '/users'],
    ['PATCH', '/me/profile', {}, 'admin', '/me/profile'],
  ];
  for (const [method, path, body, as, route] of rows) {
    assertCentral(await call(method, path, body, { as, fail: 'answer' }), method, route);
  }
  // A failure of the Gravatar fetch that is not a GravatarError.
  process.env.GRAVATAR_BASE_URL = 'https://gravatar.example.test/avatar/';
  gravatarMode = 'throw';
  try {
    assertCentral(await call('POST', '/me/avatar/gravatar', {}, { as: 'mem' }), 'POST', '/me/avatar/gravatar');
  } finally {
    gravatarMode = 'picture';
    delete process.env.GRAVATAR_BASE_URL;
  }
  assert.equal((await call('GET', '/me', NO_BODY, { as: 'admin' })).status, 200, 'the router answers again');
  assert.equal((await call('POST', '/login', { username: 'gmem', password: NEW_PASSWORD })).status, 200, 'the sign-in answers again');
});

test('the three sentences that change: logout and the two OIDC starts answer through the central handler, and the routes go on', async () => {
  await signIn('leaving', 'gmem', NEW_PASSWORD);
  logged.error.length = 0;
  // The session store fails in the destroy callback: next(err), no request left hanging.
  const res = await Promise.race([
    call('POST', '/logout', NO_BODY, { as: 'leaving', fail: 'destroy' }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('POST /logout hangs')), 5000).unref(); }),
  ]);
  assertCentral(/** @type {any} */ (res), 'POST', '/logout');
  assert.equal((await call('GET', '/me', NO_BODY, { as: 'leaving' })).status, 200, 'the session was not destroyed');
  assert.equal((await call('POST', '/logout', NO_BODY, { as: 'leaving' })).status, 200, 'logout answers again');
  assertCentral(await call('GET', '/oidc/start', NO_BODY, { fail: 'answer' }), 'GET', '/oidc/start');
  assertCentral(await call('POST', '/oidc/link/start', NO_BODY, { as: 'admin', fail: 'answer' }), 'POST', '/oidc/link/start');
  assert.equal((await call('GET', '/oidc/start', NO_BODY)).status, 404, 'the OIDC start answers again');
});

test('POST /forgot-password keeps its 200 for an error too (the answer is out before the work)', async () => {
  logged.error.length = 0;
  for (const identifier of ['gmem', 'nobody']) {
    const res = await call('POST', '/forgot-password', { identifier }, { fail: 'answer' });
    assert.deepEqual({ status: res.status, body: res.body }, { status: 200, body: { data: { ok: true } } }, identifier);
  }
  assert.deepEqual(logged.error, [], 'nothing reached the central handler');
});

// ── (3) Sinks ────────────────────────────────────────────────────────────────
/**
 * The handler of a route alone, without validateRequest() and whatever stands
 * in front of it in the route: the last function of its route layer.
 * @param {any} router @param {string} method lower case @param {string} routePath
 */
function bareHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
  }
  throw new Error(`no route ${method} ${routePath}`);
}

/**
 * Runs a bare handler with a raw body as the member; returns its answer. An
 * error the handler throws fails the test (it would be a 500).
 * @param {any} router @param {string} method @param {string} routePath @param {unknown} body
 */
async function callBare(router, method, routePath, body) {
  const handler = bareHandler(router, method, routePath);
  const req = {
    method: method.toUpperCase(), body, query: {}, params: {}, get: () => undefined, ip: '127.0.0.1',
    authUserId: kept.mem, authRole: 'member', authMethod: 'session', sessionID: 'bare', session: { userId: kept.mem, role: 'member' },
  };
  /** @type {{ status: number, body: unknown }} */
  const out = { status: 200, body: undefined };
  const res = {
    status(/** @type {number} */ code) { out.status = code; return res; },
    json(/** @type {unknown} */ value) { out.body = value; return res; },
    send(/** @type {unknown} */ value) { out.body = value; return res; },
    end() { return res; },
  };
  await handler(req, res, (/** @type {unknown} */ err) => { throw err; });
  return out;
}

// The schema refuses each of these in front (the table holds that). Behind it
// a hash or `.trim()` runs over the raw value, or the value is stored, so the
// type check stays there (sink, not route; CodeQL js/loop-bound-injection in
// #2860): called without validateRequest(), each answers instead of throwing
// or storing a value that is not text.
/** @type {unknown[]} */
const NOT_TEXT = [{ length: 1e9 }, 5, ['abc'], { toString: 'x' }];

test('sink: the token check reads a token only as text before it hashes it', async () => {
  for (const token of NOT_TEXT) {
    assert.deepEqual(await callBare(auth.router, 'post', '/reset-password/check', { token }),
      { status: 200, body: { data: { valid: false } } }, JSON.stringify(token));
  }
});

test('sink: readDeviceFields reads name, platform and device id only as text (POST /devices, /devices/pair/redeem)', async () => {
  const before = devices();
  for (const value of NOT_TEXT) {
    for (const [field, error] of [
      ['name', 'name must be between 1 and 100 characters.'],
      ['platform', 'platform must be a short lowercase name.'],
      ['device_id', 'device_id must be between 8 and 128 plain characters.'],
    ]) {
      // A list of one valid text would pass a pattern that reads it as text.
      const raw = Array.isArray(value) ? [/** @type {any} */ (DEVICE)[field]] : value;
      for (const path of ['/devices', '/devices/pair/redeem']) {
        assert.deepEqual(await callBare(auth.router, 'post', path, { ...DEVICE, code: 'AAAA-BBBB', [field]: raw }),
          { status: 400, body: { error, code: 400 } }, `${path} ${field} ${JSON.stringify(raw)}`);
      }
    }
  }
  assert.deepEqual(devices(), before, 'nothing stored');
});
