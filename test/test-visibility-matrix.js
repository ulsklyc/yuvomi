/**
 * Test: Visibility matrix - which rows each role reads on each read path (phase 2, section A)
 * Purpose: a CHARACTERISATION, not a target. For ten roles, nine read paths
 *          and six row types the suite records which seed rows come back
 *          TODAY and compares that against `test/visibility-matrix.expected.json`.
 *          A changed rule anywhere turns exactly the cells red that it moves.
 *
 *          Measured over the REAL server (test/server-ready.js): the gate chain
 *          (split guest, token scopes, module rights) lives inline in
 *          server/index.js, a hand-built middleware stack would not measure it.
 *          The database is in-memory on the production cipher driver.
 *
 *          A non-200 answer is a value of its own ({ status, reason }), an
 *          empty list is `[]`, and a cell that has no such path is
 *          { "n/a": "<reason>" }. Every one of the 540 cells is explicit.
 *
 *          Rate limits: `apiLimiter` (300/min) and `feedLimiter` (30/min) key
 *          on the client address, and `trust proxy` is one hop, so every
 *          role x path sends its own `X-Forwarded-For`. A 429 anywhere fails
 *          the suite.
 *
 *          Update the data file after a deliberate change:
 *            UPDATE_VISIBILITY_MATRIX=1 npm run test:visibility-matrix
 *          Annotations in the file (`divergent`, `note`) survive an update.
 * Run: npm run test:visibility-matrix
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { startTestServer } from './server-ready.js';
import { seedMatrix, ROLES, PATHS, TYPES, OWNERS, TASK_CATEGORY_OF, groupToken } from './visibility-matrix-seed.js';

const DATA_FILE = new URL('./visibility-matrix.expected.json', import.meta.url);
const UPDATE = process.env.UPDATE_VISIBILITY_MATRIX === '1';

const { baseUrl: BASE } = await startTestServer({
  name: 'visibility-matrix',
  env: {
    SESSION_SECRET: 'test-visibility-matrix-secret-32chars',
    // In-memory database on the cipher driver: overrides the file path that
    // startTestServer() set.
    DB_PATH: ':memory:',
  },
});
// The MCP bridge loops back to this server. `internalBaseUrl()` reads the
// variable per call, so setting it now, after the port is known, is enough.
process.env.MCP_INTERNAL_BASE_URL = BASE;

const db = (await import('../server/db.js')).get();
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');
const { PERMISSION_MODULES } = await import('../server/permissions.js');
const { MODULE_KEYS } = await import('../server/scopes.js');
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
const { recipientDeniedModules } = await import('../server/services/reminder-origins.js');
const { lacksHealth } = await import('../server/services/cycle-reminders.js');

// --------------------------------------------------------------------------
// HTTP with a client address per bucket
// --------------------------------------------------------------------------

/** @type {string[]} */
const seen429 = [];
let requestCount = 0;

/**
 * One request with its own `X-Forwarded-For`; a 429 is recorded and fails the suite.
 * @param {string} xff
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: unknown, raw?: boolean }} [options]
 * @returns {Promise<{ status: number, body: any, headers: Headers }>}
 */
async function http(xff, method, path, { headers = {}, body, raw = false } = {}) {
  requestCount += 1;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Forwarded-For': xff, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) seen429.push(`${method} ${path} (${xff})`);
  /** @type {any} */
  let parsed = null;
  const text = await res.text();
  if (raw) parsed = text;
  else { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: res.status, body: parsed, headers: res.headers };
}

// --------------------------------------------------------------------------
// Seed
// --------------------------------------------------------------------------

const today = todayKey(db);
const dates = {
  today,
  inTwoDays: shiftDateKey(today, 2),
  inTenDays: shiftDateKey(today, 10),
  month: today.slice(0, 7),
  // One day back: due, whatever the time of day and the zone.
  dueInstant: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const seed = await seedMatrix({
  db, http, dates,
  permissionModules: PERMISSION_MODULES.map((m) => m.key),
  scopeModules: MODULE_KEYS,
  displayCookie: DISPLAY_COOKIE,
});

/** id -> name per type. */
/** @type {Record<string, Map<number, string>>} */
const nameOf = Object.fromEntries(TYPES.map((type) => [type, new Map(seed.rows[type].map((r) => [r.id, r.name]))]));

/**
 * The account a role acts for (tokens act for the member).
 * @type {Record<string, string>}
 */
const ACCOUNT_OF = {
  admin: 'admin', member: 'member', child: 'child', caregiver: 'caregiver', member_none: 'member_none',
  split_guest: 'split_guest', display: 'display', token_read: 'member', token_write: 'member', token_unscoped: 'member',
};

/**
 * Auth headers of a role.
 * @param {string} role
 * @returns {Record<string, string>}
 */
function authHeaders(role) {
  if (role.startsWith('token_')) return { Authorization: `Bearer ${seed.tokens[role]}` };
  if (role === 'display') return { Cookie: `${DISPLAY_COOKIE}=${seed.displayToken}` };
  const session = seed.sessions[role];
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
}

// --------------------------------------------------------------------------
// Value helpers
// --------------------------------------------------------------------------

/** @type {Array<[string, string]>} */
const ERROR_CLASSES = [
  ['This account can only access Shared expenses.', 'split_guest_scope'],
  ['Token scope does not permit this operation.', 'token_scope'],
  ['You do not have access to this module.', 'module_access_denied'],
  ['You have read-only access to this module.', 'module_read_only'],
  ['is not permitted for this account.', 'tool_not_permitted'],
  ['Not authenticated.', 'not_authenticated'],
];

/**
 * A short, stable class for an error message.
 * @param {unknown} message
 * @returns {string}
 */
function errorClass(message) {
  const text = String(message ?? '');
  for (const [needle, cls] of ERROR_CLASSES) if (text.includes(needle)) return cls;
  return text.slice(0, 80) || 'no_message';
}

/**
 * A non-200 answer as a cell value.
 * @param {{ status: number, body: any }} res
 * @returns {{ status: number, reason: string }}
 */
function statusValue(res) {
  const body = res.body && typeof res.body === 'object' ? res.body : {};
  return { status: res.status, reason: body.reason || errorClass(body.error) };
}

/**
 * Seed names for a list of ids of one type; unknown ids stay visible as `unknown:<id>`.
 * @param {string} type
 * @param {Array<number | string>} ids
 * @returns {string[]}
 */
function namesOf(type, ids) {
  return [...new Set(ids.map((id) => nameOf[type].get(Number(id)) ?? `unknown:${id}`))].sort();
}

/**
 * Seed names for rows; a masked budget row is named `<name> (masked)`.
 * @param {string} type
 * @param {any[] | undefined} rows
 * @returns {string[]}
 */
function rowNames(type, rows) {
  return [...new Set((rows || [])
    .filter((/** @type {any} */ row) => row && row.id != null)
    .map((/** @type {any} */ row) => {
      const name = nameOf[type].get(Number(row.id)) ?? `unknown:${row.id}`;
      return row.details_hidden ? `${name} (masked)` : name;
    }))].sort();
}

/** @param {string} reason */
const NA = (reason) => ({ 'n/a': reason });

// --------------------------------------------------------------------------
// The nine read paths
// --------------------------------------------------------------------------

/** @type {Record<string, number>} */
const PATH_INDEX = Object.fromEntries(PATHS.map((path, i) => [path, i + 1]));
/** @type {(role: string, path: string) => string} */
const xffOf = (role, path) => `10.9.${ROLES.indexOf(role) + 1}.${PATH_INDEX[path]}`;

/**
 * GET under /api/v1 as a role on a path bucket.
 * @type {(role: string, path: string, url: string) => ReturnType<typeof http>}
 */
const apiGet = (role, path, url) => http(xffOf(role, path), 'GET', `/api/v1${url}`, { headers: authHeaders(role) });

/**
 * The list route of each type.
 * @type {Record<string, string | Record<string, string>>}
 */
const LIST_ROUTES = {
  tasks: '/tasks',
  events: `/calendar?from=${dates.today}&to=${shiftDateKey(dates.today, 7)}`,
  notes: '/notes',
  documents: '/documents',
  budget: { mine: `/budget?month=${dates.month}`, household: `/budget?month=${dates.month}&scope=household` },
  medications: '/health/medications',
};

/**
 * @param {string} type
 * @param {{ status: number, body: any }} res
 */
function listValue(type, res) {
  if (res.status !== 200) return statusValue(res);
  return rowNames(type, res.body?.data);
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureList(role) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const type of TYPES) {
    const route = LIST_ROUTES[type];
    if (typeof route === 'string') out[type] = listValue(type, await apiGet(role, 'list', route));
    else {
      out[type] = {};
      for (const [scope, url] of Object.entries(route)) out[type][scope] = listValue(type, await apiGet(role, 'list', url));
    }
  }
  return out;
}

/**
 * Detail: one request per seed row. Documents go through `/thumbnail`: it runs
 * the same visibility lookup as preview/download and then answers 415 for a
 * non-DMS document without reading any content - a seed row needs no file.
 */
/** @type {Record<string, (id: number) => string>} */
const DETAIL_ROUTES = {
  tasks: (id) => `/tasks/${id}`,
  events: (id) => `/calendar/${id}`,
  documents: (id) => `/documents/${id}/thumbnail`,
  medications: (id) => `/health/medications/${id}/schedules`,
};

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureDetail(role) {
  /** @type {Record<string, any>} */
  const out = {
    notes: NA('notes have no read-by-id route'),
    budget: NA('budget entries have no read-by-id route'),
  };
  for (const [type, route] of Object.entries(DETAIL_ROUTES)) {
    /** @type {string[]} */
    const visible = [];
    /** @type {Map<string, { status: number, reason: string }>} */
    const refused = new Map();
    for (const row of seed.rows[type]) {
      const res = await apiGet(role, 'detail', route(row.id));
      if (res.status === 404) continue;
      if (res.status === 403) {
        const value = statusValue(res);
        refused.set(JSON.stringify(value), value);
        continue;
      }
      visible.push(row.name);
    }
    // A gate refusal is the same for every row: record it as the cell's value.
    if (!visible.length && refused.size === 1) out[type] = [...refused.values()][0];
    else out[type] = visible.sort();
  }
  return out;
}

/**
 * Dashboard caps. A block is recorded as `{ capped, ids }` only when the
 * answer itself says that more rows exist than it carries (the totals next to
 * the lists); `upcomingEvents` has no total, a full list counts as capped.
 *
 * @param {unknown[]} list
 * @param {number} total
 * @param {string[]} ids
 */
function capped(list, total, ids) {
  return total > list.length ? { capped: list.length, ids } : ids;
}
const EVENTS_LIMIT = 12;

/** @param {any[] | undefined} wall @returns {number[]} */
const wallIds = (wall) => (wall || []).flatMap((m) => [...(m.open || []), ...(m.done || [])].map((t) => t.id));
/** @param {any[] | undefined} list @param {string} source @returns {number[]} */
const countdownIds = (list, source) => (list || []).filter((c) => c.source === source).map((c) => c.id);

/**
 * Overview: the full dashboard once, plus once per task category. `urgentTasks`
 * is capped at five for the whole household; one category per owner keeps every
 * read below the cap, and the union is the cell.
 *
 * @param {string} role
 * @param {string} path
 * @returns {Promise<Record<string, any>>}
 */
async function measureOverview(role, path) {
  const audience = path === 'overview_household' ? '&audience=household' : '';
  const full = await apiGet(role, path, `/dashboard?events_limit=${EVENTS_LIMIT}${audience}`);
  if (full.status !== 200) return Object.fromEntries(TYPES.map((type) => [type, statusValue(full)]));
  const d = full.body;
  /** @type {number[]} */
  const urgent = [];
  /** @type {number[]} */
  const wall = [];
  let urgentCapped = 0;
  for (const owner of OWNERS) {
    const res = await apiGet(role, path, `/dashboard?events_limit=${EVENTS_LIMIT}&tasks_category=${TASK_CATEGORY_OF[owner]}${audience}`);
    assert.equal(res.status, 200, `${role} ${path}: category dashboard`);
    const list = res.body.urgentTasks || [];
    // `openTaskCount` counts the same filtered set without the cap of five.
    if ((res.body.openTaskCount ?? 0) > list.length) urgentCapped = Math.max(urgentCapped, list.length);
    urgent.push(...list.map((/** @type {any} */ t) => t.id));
    wall.push(...wallIds(res.body.wallTasks));
  }
  const urgentNames = namesOf('tasks', urgent);
  return {
    tasks: {
      countdowns: capped(d.countdowns || [], d.countdownTotal ?? 0, namesOf('tasks', countdownIds(d.countdowns, 'task'))),
      urgentTasks: urgentCapped ? { capped: urgentCapped, ids: urgentNames } : urgentNames,
      wallTasks: namesOf('tasks', wall),
    },
    events: {
      countdowns: capped(d.countdowns || [], d.countdownTotal ?? 0, namesOf('events', countdownIds(d.countdowns, 'event'))),
      familyEvents: namesOf('events', (d.familyEvents || []).map((/** @type {any} */ e) => e.id)),
      upcomingEvents: capped(d.upcomingEvents || [], (d.upcomingEvents || []).length >= EVENTS_LIMIT ? Infinity : 0,
        namesOf('events', (d.upcomingEvents || []).map((/** @type {any} */ e) => e.id))),
      weekEvents: namesOf('events', (d.weekEvents || []).map((/** @type {any} */ e) => e.id)),
    },
    notes: { pinnedNotes: capped(d.pinnedNotes || [], d.notesTotal ?? 0, namesOf('notes', (d.pinnedNotes || []).map((/** @type {any} */ n) => n.id))) },
    documents: { countdowns: capped(d.countdowns || [], d.countdownTotal ?? 0, namesOf('documents', countdownIds(d.countdowns, 'document'))) },
    // Budget and health carry aggregates, not rows.
    budget: { 'budget.entryCount': d.budget?.entryCount ?? null },
    medications: { 'health.hasMeds': d.health?.hasMeds ?? null },
  };
}

/** @type {Record<string, string>} */
const SEARCH_BUCKET = { tasks: 'tasks', events: 'events', notes: 'notes', documents: 'documents', budget: 'budget', medications: 'meds' };

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureSearch(role) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const type of TYPES) {
    /** @type {any[]} */
    const found = [];
    /** @type {{ status: number, reason: string } | null} */
    let refused = null;
    for (const owner of OWNERS) {
      const res = await apiGet(role, 'search', `/search?q=${groupToken(type, owner)}`);
      if (res.status !== 200) { refused = statusValue(res); break; }
      found.push(...(res.body[SEARCH_BUCKET[type]] || []));
    }
    out[type] = refused ?? rowNames(type, found);
  }
  return out;
}

/**
 * One JSON-RPC `tools/call` over /mcp.
 * @param {string} role
 * @param {string} path
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ error?: { status: number | string, reason: string }, data?: any }>}
 */
async function mcpCall(role, path, name, args) {
  const res = await http(xffOf(role, path), 'POST', '/mcp', {
    headers: authHeaders(role),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  if (res.status !== 200) return { error: statusValue(res) };
  const result = res.body?.result;
  if (!result) return { error: { status: 'rpc_error', reason: errorClass(res.body?.error?.message) } };
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) return { error: { status: 'tool_error', reason: errorClass(text) } };
  return { data: JSON.parse(text) };
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureMcpCore(role) {
  const tasks = await mcpCall(role, 'mcp_core', 'list_tasks', { include_future: true });
  const events = await mcpCall(role, 'mcp_core', 'list_upcoming_events', { limit: 100 });
  const none = NA('no core MCP tool reads this type');
  return {
    tasks: tasks.error ?? rowNames('tasks', tasks.data),
    events: events.error ?? rowNames('events', events.data),
    notes: none, documents: none, budget: none, medications: none,
  };
}

/**
 * @param {string} role
 * @param {string} type
 * @param {string} url
 */
async function bridgeList(role, type, url) {
  const [pathPart, queryPart] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const res = await mcpCall(role, 'mcp_bridge', 'call_api_operation', { method: 'GET', path: `/api/v1${pathPart}`, query });
  return res.error ?? rowNames(type, res.data?.data);
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureMcpBridge(role) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const type of TYPES) {
    const route = LIST_ROUTES[type];
    if (typeof route === 'string') out[type] = await bridgeList(role, type, route);
    else {
      out[type] = {};
      for (const [scope, url] of Object.entries(route)) out[type][scope] = await bridgeList(role, type, url);
    }
  }
  return out;
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureIcsFeed(role) {
  const eventsOnly = NA('the calendar feed carries events only');
  const base = { notes: eventsOnly, documents: eventsOnly, budget: eventsOnly, medications: eventsOnly };
  if (role.startsWith('token_')) {
    const own = NA('the feed token belongs to the account, see member');
    return { ...base, tasks: own, events: own };
  }
  const res = await http(xffOf(role, 'ics_feed'), 'GET', `/feed/calendar/${seed.feedTokens[ACCOUNT_OF[role]]}.ics`, { raw: true });
  const events = res.status !== 200
    ? { status: res.status, reason: String(res.body).slice(0, 40) }
    : namesOf('events', [...String(res.body).matchAll(/^UID:event-(\d+)@yuvomi\r?$/gm)].map((m) => m[1]));
  return { ...base, tasks: eventsOnly, events };
}

/** @type {Record<string, string>} */
const REMINDER_ENTITY = { tasks: 'task', events: 'event', documents: 'document_expiry' };

/**
 * `mayHearAboutHealth` is module-private in services/medication-scheduler.js
 * (~82). Its body is exactly `denied !== null && !denied.has('health')` over
 * the exported `recipientDeniedModules`; that expression is read here.
 *
 * @param {number} userId
 */
function healthPredicates(userId) {
  const denied = recipientDeniedModules(db, userId);
  return { mayHearAboutHealth: denied !== null && !denied.has('health'), notLacksHealth: !lacksHealth(db, userId) };
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureDueReminders(role) {
  /** @type {Record<string, any>} */
  const out = {
    notes: NA('notes have no reminder origin'),
    budget: NA('the budget reminder origin is the subscription, not the entry'),
    medications: healthPredicates(seed.ids[ACCOUNT_OF[role]]),
  };
  /** @type {Record<string, { status: number, body: any }>} */
  const answers = {
    default: await apiGet(role, 'due_reminders', '/reminders/pending'),
    household: await apiGet(role, 'due_reminders', '/reminders/pending?audience=household'),
  };
  for (const [type, entity] of Object.entries(REMINDER_ENTITY)) {
    out[type] = {};
    for (const [key, res] of Object.entries(answers)) {
      out[type][key] = res.status !== 200
        ? statusValue(res)
        : namesOf(type, (res.body?.data || []).filter((/** @type {any} */ r) => r.entity_type === entity).map((/** @type {any} */ r) => r.entity_id));
    }
  }
  return out;
}

/** @type {Record<string, (role: string) => Promise<Record<string, any>>>} */
const MEASURE = {
  list: measureList,
  detail: measureDetail,
  overview: (role) => measureOverview(role, 'overview'),
  overview_household: (role) => measureOverview(role, 'overview_household'),
  search: measureSearch,
  mcp_core: measureMcpCore,
  mcp_bridge: measureMcpBridge,
  ics_feed: measureIcsFeed,
  due_reminders: measureDueReminders,
};

// --------------------------------------------------------------------------
// Module level: the nine other permission modules under none / read / write
// --------------------------------------------------------------------------

/** @type {Record<string, string>} */
const MODULE_PROBES = {
  contacts: '/contacts',
  meals: '/meals',
  shopping: '/shopping',
  pantry: '/pantry/locations',
  inventory: '/inventory/locations',
  housekeeping: '/housekeeping/task-templates',
  waste: '/waste/types',
  rewards: '/rewards/catalog',
  schedule: '/schedule/shift-types',
};

/**
 * The write probe for `read`: a DELETE on an id that cannot exist. Refused by
 * the module gate it is `module_read_only`; let through it would be a 404 and
 * change nothing.
 */
const WRITE_PROBE_ID = 999999999;

/** @param {{ status: number, body: any }} res */
function shapeOf(res) {
  if (res.status !== 200) return statusValue(res);
  const body = res.body && typeof res.body === 'object' ? res.body : {};
  return { status: 200, keys: Object.keys(body).sort() };
}

/** @returns {Promise<Record<string, any>>} */
async function measureModules() {
  /** @type {Record<string, any>} */
  const out = {};
  const levels = { none: 'member_none', read: 'member_read', write: 'member' };
  let n = 0;
  for (const [moduleKey, url] of Object.entries(MODULE_PROBES)) {
    out[moduleKey] = {};
    for (const [level, account] of Object.entries(levels)) {
      const session = seed.sessions[account];
      const headers = { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
      n += 1;
      const xff = `10.9.240.${n}`;
      out[moduleKey][level] = shapeOf(await http(xff, 'GET', `/api/v1${url}`, { headers }));
      if (level === 'read') {
        const write = await http(xff, 'DELETE', `/api/v1${url}/${WRITE_PROBE_ID}`, { headers });
        out[moduleKey].read_write_probe = write.status === 403 ? statusValue(write) : NA(`write probe was not refused by the gate (status ${write.status})`);
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Measure everything once
// --------------------------------------------------------------------------

const started = Date.now();
/** @type {Record<string, Record<string, Record<string, any>>>} */
const measured = {};
for (const role of ROLES) {
  measured[role] = {};
  for (const path of PATHS) measured[role][path] = await MEASURE[path](role);
}
const measuredModules = await measureModules();
const unknownAccountId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1000 AS id FROM users').get().id);
const measuredUnknown = { health_predicates: healthPredicates(unknownAccountId) };
const measureMs = Date.now() - started;

// --------------------------------------------------------------------------
// Data file: compare, or rewrite in update mode
// --------------------------------------------------------------------------

const ANNOTATIONS = ['divergent', 'note'];

/**
 * The comparable value of a cell: annotations dropped, `{ ids }` unwrapped.
 * @param {any} value
 * @returns {any}
 */
function stripAnnotations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !ANNOTATIONS.includes(key)));
  const keys = Object.keys(rest);
  if (keys.length === 1 && keys[0] === 'ids' && Object.keys(value).some((key) => ANNOTATIONS.includes(key))) return rest.ids;
  return rest;
}

/**
 * The measured value with the annotations of the previous cell kept.
 * @param {any} previous
 * @param {any} value
 * @returns {any}
 */
function withAnnotations(previous, value) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return value;
  const notes = Object.fromEntries(ANNOTATIONS.filter((key) => key in previous).map((key) => [key, previous[key]]));
  if (!Object.keys(notes).length) return value;
  if (Array.isArray(value)) return { ids: value, ...notes };
  return { ...value, ...notes };
}

/**
 * Object keys sorted at every level, so the file has one stable form.
 * @param {any} value
 * @returns {any}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

/** @type {any} */
let expected = null;
try { expected = JSON.parse(readFileSync(DATA_FILE, 'utf8')); } catch { expected = null; }

const meta = {
  budget_mode: 'personal (sync_config.budget_mode; in shared mode the budget visibility rule is off)',
  database: ':memory: on better-sqlite3-multiple-ciphers (DB_PATH override after freshTestDbPath)',
  detail_documents_route: 'GET /documents/:id/thumbnail - same visibility lookup as preview/download, answers 415 for a non-DMS document without reading content; 404 = not visible',
  dashboard_reads: 'once with events_limit=12, plus once per owner task category (household/school/repair) for urgentTasks and wallTasks; countdowns and events come from the first read',
  due_reminders: 'one due reminder per task, event and document row for each of these accounts (created_by = caller): ' + seed.facts.reminderAccounts.join(', ') + '; document_expiry rows are seeded directly like the others; token roles read the member\'s rows',
  health_predicates: 'mayHearAboutHealth = recipientDeniedModules(db, id) !== null && !has(health) (module-private in medication-scheduler.js ~82, expression read here); notLacksHealth = !lacksHealth(db, id) (cycle-reminders.js ~71)',
  mcp: 'list_tasks with include_future=true, list_upcoming_events with limit=100; the bridge calls call_api_operation with method GET and the /api/v1 path of each list route; a refused call is { status: tool_error, reason }',
  role_accounts: 'token_read / token_write / token_unscoped act for the member account',
  seed_counts: Object.fromEntries(TYPES.map((type) => [type, seed.rows[type].length])),
  seed_shape: 'tasks and events per owner all/private/assignees (all and assignees assigned to one other account via the assignment table, legacy assigned_to NULL); task.admin.private.legacy-assigned-member sets only tasks.assigned_to = member; task.admin.assignees.secondary-member is not seeded because task.admin.assignees already is "assignment row only"; event.member.ics-unshared / ics-shared come from two subscriptions of the member; countdown flag on task.member.assignees and event.member.assignees; document expiry (today+10, lead 30 days) on the member\'s three documents and on document.admin.private; tasks due today, events all-day in two days, budget entries today',
  tokens: 'minted via POST /auth/api-tokens with subject_user_id = member: ' + JSON.stringify(seed.facts.tokenShapes),
};

if (UPDATE) {
  /** @type {Record<string, Record<string, Record<string, any>>>} */
  const cells = {};
  for (const role of ROLES) {
    cells[role] = {};
    for (const path of PATHS) {
      cells[role][path] = {};
      for (const type of TYPES) {
        cells[role][path][type] = withAnnotations(expected?.cells?.[role]?.[path]?.[type], measured[role][path][type]);
      }
    }
  }
  const file = sortKeys({ _meta: meta, cells, modules: measuredModules, unknown_account: measuredUnknown });
  writeFileSync(DATA_FILE, `${JSON.stringify(file, null, 2)}\n`);
  expected = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('no request met a rate limit (429 fails the suite)', () => {
  assert.deepEqual(seen429, []);
});

test('the client address keys the API limiter (X-Forwarded-For, one trusted hop)', async () => {
  const headers = authHeaders('admin');
  const first = await http('10.9.230.1', 'GET', '/api/v1/auth/me', { headers });
  const second = await http('10.9.230.1', 'GET', '/api/v1/auth/me', { headers });
  const other = await http('10.9.230.2', 'GET', '/api/v1/auth/me', { headers });
  /** @param {{ headers: Headers }} res */
  const remaining = (res) => Number(/remaining=(\d+)/.exec(res.headers.get('ratelimit') || '')?.[1]
    ?? res.headers.get('ratelimit-remaining'));
  assert.ok(Number.isFinite(remaining(first)), 'the limiter reports its remaining budget');
  assert.equal(remaining(second), remaining(first) - 1, 'same address, same bucket');
  assert.equal(remaining(other), remaining(first), 'another address starts its own bucket');
});

test('precondition: the unrestricted view is not empty for any type', () => {
  const list = measured.admin.list;
  /** @param {string} type */
  const adminRows = (type) => seed.rows[type].filter((r) => r.owner === 'admin').map((r) => r.name);
  /** @param {string} type @param {string[]} levels */
  const openRows = (type, levels) => seed.rows[type]
    .filter((r) => r.owner !== 'admin' && levels.some((level) => r.name.split('.')[2] === level))
    .map((r) => r.name);
  /** @param {string[]} cell @param {string[]} names @param {string} label */
  const has = (cell, names, label) => {
    for (const name of names) assert.ok(cell.includes(name), `${label}: ${name} missing from ${JSON.stringify(cell)}`);
  };
  has(list.tasks, [...adminRows('tasks'), ...openRows('tasks', ['all'])], 'tasks');
  has(list.events, [...adminRows('events'), ...openRows('events', ['all'])], 'events');
  has(list.notes, [...adminRows('notes'), ...openRows('notes', ['all'])], 'notes');
  has(list.documents, [...adminRows('documents'), ...openRows('documents', ['family'])], 'documents');
  has([...list.budget.mine, ...list.budget.household], [...adminRows('budget'), ...openRows('budget', ['shared'])], 'budget');
  has(list.medications, [...adminRows('medications'), ...openRows('medications', ['family'])], 'medications');
});

test('the data file names every role x path x type cell (540)', () => {
  assert.ok(expected, 'test/visibility-matrix.expected.json is missing - run with UPDATE_VISIBILITY_MATRIX=1');
  const missing = [];
  for (const role of ROLES) {
    for (const path of PATHS) {
      for (const type of TYPES) if (!(expected.cells?.[role]?.[path] && type in expected.cells[role][path])) missing.push(`${role} / ${path} / ${type}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.equal(Object.keys(expected.cells).length, ROLES.length);
});

for (const role of ROLES) {
  for (const path of PATHS) {
    test(`${role} / ${path}`, () => {
      const diffs = [];
      for (const type of TYPES) {
        const want = stripAnnotations(expected?.cells?.[role]?.[path]?.[type]);
        const got = measured[role][path][type];
        try { assert.deepStrictEqual(sortKeys(got), sortKeys(want)); } catch {
          diffs.push(`${role} / ${path} / ${type}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
        }
      }
      assert.equal(diffs.length, 0, `\n${diffs.join('\n')}`);
    });
  }
}

test('module level: nine permission modules under none / read / write', () => {
  const diffs = [];
  for (const [moduleKey, value] of Object.entries(measuredModules)) {
    const want = stripAnnotations(expected?.modules?.[moduleKey]);
    try { assert.deepStrictEqual(sortKeys(value), sortKeys(want)); } catch {
      diffs.push(`modules / ${moduleKey}: expected ${JSON.stringify(want)} got ${JSON.stringify(value)}`);
    }
  }
  assert.equal(diffs.length, 0, `\n${diffs.join('\n')}`);
});

test('module level: a read-only member is refused every write by the gate', () => {
  for (const [moduleKey, value] of Object.entries(measuredModules)) {
    assert.deepEqual(value.read_write_probe, { status: 403, reason: 'module_read_only' }, moduleKey);
  }
});

test('health predicates for an account id that does not exist', () => {
  assert.deepStrictEqual(sortKeys(measuredUnknown), sortKeys(stripAnnotations(expected?.unknown_account)));
});

test('the suite stays below the API limit and well under a minute', () => {
  // Every role x path has its own bucket; the busiest is `detail` (one request per row).
  const rowsWithDetail = Object.keys(DETAIL_ROUTES).reduce((n, type) => n + seed.rows[type].length, 0);
  assert.ok(rowsWithDetail < 300, `detail requests per bucket: ${rowsWithDetail}`);
  assert.ok(measureMs < 60_000, `measuring took ${measureMs} ms for ${requestCount} requests`);
});
