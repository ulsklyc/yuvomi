/**
 * API probe against a running Yuvomi server, shared by the restore drill
 * (scripts/restore-drill.mjs) and the rollback probe (this folder).
 *
 * Signs in as a demo user from scripts/seed-demo.js and reads one list or
 * overview endpoint per module. A snapshot records status, size and a body
 * hash per endpoint; diffSnapshots() compares two of them.
 */
import { createHash } from 'node:crypto';

/** The demo admin from scripts/seed-demo.js (every demo user has this password). */
export const DEMO_LOGIN = Object.freeze({ username: 'alex', password: 'demo1234' });

/**
 * One read endpoint per module, plus the account, settings and system reads
 * the app makes at start. Each answers 200 for the demo admin on a seeded
 * database.
 */
export const ENDPOINTS = Object.freeze([
  '/api/v1/auth/me', '/api/v1/tasks', '/api/v1/shopping', '/api/v1/meals', '/api/v1/recipes', '/api/v1/pantry',
  '/api/v1/calendar', '/api/v1/notes', '/api/v1/contacts', '/api/v1/birthdays', '/api/v1/budget',
  '/api/v1/budget/subscriptions', '/api/v1/documents', '/api/v1/split-expenses/groups', '/api/v1/family/members',
  '/api/v1/rewards/overview', '/api/v1/housekeeping/dashboard', '/api/v1/inventory/items', '/api/v1/preferences',
  '/api/v1/dashboard', '/api/v1/backup/status', '/api/v1/modules', '/api/v1/permissions/catalog',
  '/api/v1/quick-links',
]);

/**
 * A cookie jar plus CSRF token against one base URL.
 * @param {string} base e.g. http://127.0.0.1:3871
 */
export function createClient(base) {
  /** @type {Map<string, string>} */
  const jar = new Map();
  let csrf = '';
  /**
   * @param {string} method
   * @param {string} url
   * @param {{ body?: unknown, headers?: Record<string, string>, raw?: boolean }} [options]
   */
  async function call(method, url, { body, headers = {}, raw = false } = {}) {
    /** @type {Record<string, string>} */
    const h = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    if (method !== 'GET') h['x-csrf-token'] = csrf;
    let payload = /** @type {any} */ (body);
    if (body !== undefined && !raw) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [kv] = line.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const token = res.headers.get('x-csrf-token');
    if (token) csrf = token;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: res.status, text, json };
  }
  return { call };
}

/**
 * @param {ReturnType<typeof createClient>} client
 * @param {{ username: string, password: string }} [login]
 */
export async function signIn(client, login = DEMO_LOGIN) {
  const r = await client.call('POST', '/api/v1/auth/login', { body: login });
  if (r.status !== 200) throw new Error(`login as ${login.username}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
  await client.call('GET', '/api/v1/auth/me');
}

/** @param {any} json */
function size(json) {
  const d = json?.data ?? json;
  if (Array.isArray(d)) return d.length;
  return d && typeof d === 'object' ? `obj:${Object.keys(d).length}` : typeof d;
}

/**
 * @typedef {{ s: number, n: number | string, h: string }} EndpointPrint
 * @typedef {{
 *   sw: { status: number, bytes: number, release: string },
 *   index: { status: number, bytes: number, modulepreload: number, assets: number },
 *   api: Record<string, EndpointPrint>
 * }} ApiSnapshot
 */

/**
 * Reads the shell (`/sw.js`, `/`) and every endpoint of ENDPOINTS as the demo admin.
 * @param {string} base
 * @param {{ username: string, password: string }} [login]
 * @returns {Promise<ApiSnapshot>}
 */
export async function snapshot(base, login = DEMO_LOGIN) {
  const client = createClient(base);
  const sw = await client.call('GET', '/sw.js');
  const idx = await client.call('GET', '/');
  await signIn(client, login);
  /** @type {Record<string, EndpointPrint>} */
  const api = {};
  for (const e of ENDPOINTS) {
    const r = await client.call('GET', e);
    api[e] = { s: r.status, n: size(r.json), h: createHash('sha256').update(r.text).digest('hex').slice(0, 10) };
  }
  return {
    sw: { status: sw.status, bytes: sw.text.length, release: (sw.text.match(/\b\d+\.\d+\.\d+\b/) || ['?'])[0] },
    index: {
      status: idx.status,
      bytes: idx.text.length,
      modulepreload: (idx.text.match(/modulepreload/g) || []).length,
      assets: (idx.text.match(/\/assets\//g) || []).length,
    },
    api,
  };
}

/**
 * Endpoints of a snapshot that did not answer 200.
 * @param {ApiSnapshot} snap
 * @returns {string[]}
 */
export function failedEndpoints(snap) {
  return Object.entries(snap.api).filter(([, v]) => v.s !== 200).map(([k, v]) => `${k} ${v.s}`);
}

/**
 * `hard`: status or size changed; `soft`: same status and size, other body.
 * @param {ApiSnapshot} a
 * @param {ApiSnapshot} b
 */
export function diffSnapshots(a, b) {
  const hard = [];
  const soft = [];
  for (const e of Object.keys(a.api)) {
    const x = a.api[e];
    const y = b.api[e];
    if (!y || x.s !== y.s || x.n !== y.n) hard.push(`${e}: ${x.s}/${x.n} -> ${y ? `${y.s}/${y.n}` : 'missing'}`);
    else if (x.h !== y.h) soft.push(e.replace('/api/v1/', ''));
  }
  return { hard, soft };
}
