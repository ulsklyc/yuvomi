/**
 * Test: Visibility matrix - which rows each role reads on each read path (phase 2, section A)
 * Purpose: a CHARACTERISATION, not a target. For ten roles, nine read paths
 *          and seven row types the suite records which seed rows come back
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
 *          { "n/a": "<reason>" }. Every one of the 630 cells is explicit.
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
    // The seed has two ICS subscriptions with an http:// loopback URL. The
    // first sync tick fires 10 s after boot (server/index.js, runSync); on a
    // slow runner it can land mid-run. With the private-network opt-in off,
    // normalizeUrl() rejects http:// before any connection is made, and
    // syncOne() (services/ics-subscription.js) catches every fetch failure and
    // returns before its first write - the seeded subscription events stay as
    // they are. Pinned to off here so a developer's own .env cannot open it.
    ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: 'false',
  },
});
// The MCP bridge loops back to this server. `internalBaseUrl()` reads the
// variable per call, so setting it now, after the port is known, is enough.
process.env.MCP_INTERNAL_BASE_URL = BASE;

const db = (await import('../server/db.js')).get();
const { todayKey, shiftDateKey } = await import('../server/utils/timezone.js');
const { PERMISSION_MODULES } = await import('../server/authorize/index.ts');
const { MODULE_KEYS } = await import('../server/scopes.js');
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
const { recipientDeniedModules } = await import('../server/services/reminder-origins.js');
const { lacksHealth } = await import('../server/services/cycle-reminders.js');
const { processDueMedications } = await import('../server/services/medication-scheduler.js');
const { SEARCH_LIMIT } = await import('../server/services/search.js');

// --------------------------------------------------------------------------
// HTTP with a client address per bucket
// --------------------------------------------------------------------------

/** @type {string[]} */
const seen429 = [];
/**
 * Answers no measurement expected: a status outside the route's known set, or
 * a 200 without the field the cell is read from. They never fold into a value;
 * a test lists them by role / path / type and fails.
 * @type {string[]}
 */
const unexpected = [];
/**
 * @param {string} where  `role / path / type[ / row]`
 * @param {string} what
 */
function flag(where, what) { unexpected.push(`${where}: ${what}`); }
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
  activities: '/health/activities',
};

/**
 * The list a 200 answer carries in `key`. A 200 without it is no empty list:
 * it is flagged and becomes a status value, so the cell changes too.
 * @param {any} container
 * @param {string} key
 * @param {string} where
 * @returns {{ list: any[] } | { value: { status: number, reason: string } }}
 */
function listField(container, key, where) {
  const list = container && typeof container === 'object' ? container[key] : undefined;
  if (Array.isArray(list)) return { list };
  flag(where, `200 without a list in "${key}"`);
  return { value: { status: 200, reason: `no list in ${key}` } };
}

/**
 * @param {string} type
 * @param {{ status: number, body: any }} res
 * @param {string} where
 */
function listValue(type, res, where) {
  if (res.status !== 200) return statusValue(res);
  const field = listField(res.body, 'data', where);
  return 'list' in field ? rowNames(type, field.list) : field.value;
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
    const where = `${role} / list / ${type}`;
    if (typeof route === 'string') out[type] = listValue(type, await apiGet(role, 'list', route), where);
    else {
      out[type] = {};
      for (const [scope, url] of Object.entries(route)) {
        out[type][scope] = listValue(type, await apiGet(role, 'list', url), `${where} / ${scope}`);
      }
    }
  }
  return out;
}

/**
 * Detail: one request per seed row, and each route has exactly three answers
 * it may give - its success status (visible), its 404 (not visible) and the
 * gate's 403 (refused). Documents go through `/thumbnail`: it runs the same
 * visibility lookup as preview/download and then answers 415 for a non-DMS
 * document without reading any content - a seed row needs no file, and 415
 * IS the success status there. Anything else (a 500, a 401, the thumbnail's
 * 502) is flagged with role / path / type / row / status and fails the suite.
 * @type {Record<string, { route: (id: number) => string, visible: number }>}
 */
const DETAIL_ROUTES = {
  tasks: { route: (id) => `/tasks/${id}`, visible: 200 },
  events: { route: (id) => `/calendar/${id}`, visible: 200 },
  documents: { route: (id) => `/documents/${id}/thumbnail`, visible: 415 },
  medications: { route: (id) => `/health/medications/${id}/schedules`, visible: 200 },
};

/**
 * One detail answer classified: a forced 500 must come back as
 * `unexpected`, never as `visible`.
 * @param {{ status: number }} res
 * @param {number} visibleStatus
 * @returns {'visible' | 'hidden' | 'refused' | 'unexpected'}
 */
function classifyDetail(res, visibleStatus) {
  if (res.status === visibleStatus) return 'visible';
  if (res.status === 404) return 'hidden';
  if (res.status === 403) return 'refused';
  return 'unexpected';
}

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureDetail(role) {
  /** @type {Record<string, any>} */
  const out = {
    notes: NA('notes have no read-by-id route'),
    budget: NA('budget entries have no read-by-id route'),
    activities: NA('health activities have no read-by-id route'),
  };
  for (const [type, { route, visible: visibleStatus }] of Object.entries(DETAIL_ROUTES)) {
    /** @type {string[]} */
    const visible = [];
    /** @type {Record<string, { status: number, reason: string }>} */
    const refused = {};
    /** @type {Record<string, number>} */
    const odd = {};
    for (const row of seed.rows[type]) {
      const res = await apiGet(role, 'detail', route(row.id));
      const kind = classifyDetail(res, visibleStatus);
      if (kind === 'visible') visible.push(row.name);
      else if (kind === 'refused') refused[row.name] = statusValue(res);
      else if (kind === 'unexpected') {
        odd[row.name] = res.status;
        flag(`${role} / detail / ${type} / ${row.name}`, `status ${res.status}`);
      }
    }
    const refusals = new Set(Object.values(refused).map((value) => JSON.stringify(value)));
    const refusedAll = Object.keys(refused).length === seed.rows[type].length && refusals.size === 1;
    if (refusedAll) {
      // The gate refused every row the same way: that refusal is the cell.
      out[type] = Object.values(refused)[0];
    } else if (Object.keys(refused).length || Object.keys(odd).length) {
      // Refusals next to visible rows (or odd answers) stay in the cell by row.
      out[type] = {
        visible: visible.sort(),
        ...(Object.keys(refused).length ? { refused } : {}),
        ...(Object.keys(odd).length ? { unexpected: odd } : {}),
      };
    } else out[type] = visible.sort();
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

/** @param {any[]} wall @returns {number[]} */
const wallIds = (wall) => wall.flatMap((m) => [...(m.open || []), ...(m.done || [])].map((/** @type {any} */ t) => t.id));
/** @param {any[]} list @param {string} source @returns {number[]} */
const countdownIds = (list, source) => list.filter((c) => c.source === source).map((c) => c.id);

/**
 * A dashboard block that must be there. A missing block is flagged, not read
 * as empty.
 * @param {any} body
 * @param {string} key
 * @param {string} where
 * @returns {any[]}
 */
function block(body, key, where) {
  const field = listField(body, key, where);
  return 'list' in field ? field.list : [];
}

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
  const where = `${role} / ${path}`;
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
    if (res.status !== 200) {
      flag(`${where} / tasks`, `category read ${TASK_CATEGORY_OF[owner]} answered ${res.status}, the full read 200`);
      continue;
    }
    const list = block(res.body, 'urgentTasks', `${where} / tasks`);
    // `openTaskCount` counts the same filtered set without the cap of five.
    if ((res.body.openTaskCount ?? 0) > list.length) urgentCapped = Math.max(urgentCapped, list.length);
    urgent.push(...list.map((/** @type {any} */ t) => t.id));
    wall.push(...wallIds(block(res.body, 'wallTasks', `${where} / tasks`)));
  }
  const urgentNames = namesOf('tasks', urgent);
  const countdowns = block(d, 'countdowns', `${where} / countdowns`);
  const countdownTotal = d.countdownTotal ?? 0;
  const upcoming = block(d, 'upcomingEvents', `${where} / events`);
  const pinned = block(d, 'pinnedNotes', `${where} / notes`);
  return {
    tasks: {
      countdowns: capped(countdowns, countdownTotal, namesOf('tasks', countdownIds(countdowns, 'task'))),
      urgentTasks: urgentCapped ? { capped: urgentCapped, ids: urgentNames } : urgentNames,
      wallTasks: namesOf('tasks', wall),
    },
    events: {
      countdowns: capped(countdowns, countdownTotal, namesOf('events', countdownIds(countdowns, 'event'))),
      familyEvents: namesOf('events', block(d, 'familyEvents', `${where} / events`).map((e) => e.id)),
      upcomingEvents: capped(upcoming, upcoming.length >= EVENTS_LIMIT ? Infinity : 0,
        namesOf('events', upcoming.map((e) => e.id))),
      weekEvents: namesOf('events', block(d, 'weekEvents', `${where} / events`).map((e) => e.id)),
    },
    notes: { pinnedNotes: capped(pinned, d.notesTotal ?? 0, namesOf('notes', pinned.map((n) => n.id))) },
    documents: { countdowns: capped(countdowns, countdownTotal, namesOf('documents', countdownIds(countdowns, 'document'))) },
    // Budget and health carry aggregates, not rows.
    budget: { 'budget.entryCount': d.budget?.entryCount ?? null },
    medications: { 'health.hasMeds': d.health?.hasMeds ?? null },
    activities: NA('the overview carries no health activities'),
  };
}

/** @type {Record<string, string>} */
const SEARCH_BUCKET = {
  tasks: 'tasks', events: 'events', notes: 'notes', documents: 'documents', budget: 'budget', medications: 'meds',
  activities: 'activities',
};

/**
 * The owners that have rows of a type: one search group each.
 * @param {string} type
 * @returns {string[]}
 */
function groupOwners(type) {
  return [...new Set(seed.rows[type].map((row) => row.owner))];
}

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
    for (const owner of groupOwners(type)) {
      const res = await apiGet(role, 'search', `/search?q=${groupToken(type, owner)}`);
      if (res.status !== 200) { refused = statusValue(res); break; }
      const field = listField(res.body, SEARCH_BUCKET[type], `${role} / search / ${type}`);
      if (!('list' in field)) { refused = field.value; break; }
      found.push(...field.list);
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
  try { return { data: JSON.parse(text) }; } catch {
    flag(`${role} / ${path} / ${name}`, 'tool result is no JSON');
    return { error: { status: 'tool_result', reason: 'not JSON' } };
  }
}

/**
 * A tool answer that must be a list (`list_tasks`, `list_upcoming_events`) or
 * carry one in `key` (the bridge's `{ data: [...] }`).
 * @param {string} type
 * @param {{ error?: any, data?: any }} answer
 * @param {string} where
 * @param {string | null} key
 */
function toolList(type, answer, where, key) {
  if (answer.error) return answer.error;
  const field = key ? listField(answer.data, key, where) : listField({ list: answer.data }, 'list', where);
  return 'list' in field ? rowNames(type, field.list) : field.value;
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
    tasks: toolList('tasks', tasks, `${role} / mcp_core / tasks`, null),
    events: toolList('events', events, `${role} / mcp_core / events`, null),
    notes: none, documents: none, budget: none, medications: none, activities: none,
  };
}

/**
 * @param {string} role
 * @param {string} type
 * @param {string} url
 * @param {string} where
 */
async function bridgeList(role, type, url, where) {
  const [pathPart, queryPart] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const res = await mcpCall(role, 'mcp_bridge', 'call_api_operation', { method: 'GET', path: `/api/v1${pathPart}`, query });
  return toolList(type, res, where, 'data');
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
    const where = `${role} / mcp_bridge / ${type}`;
    if (typeof route === 'string') out[type] = await bridgeList(role, type, route, where);
    else {
      out[type] = {};
      for (const [scope, url] of Object.entries(route)) out[type][scope] = await bridgeList(role, type, url, `${where} / ${scope}`);
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
  const base = { notes: eventsOnly, documents: eventsOnly, budget: eventsOnly, medications: eventsOnly, activities: eventsOnly };
  if (role.startsWith('token_')) {
    const own = NA('the feed token belongs to the account, see member');
    return { ...base, tasks: own, events: own };
  }
  const res = await http(xffOf(role, 'ics_feed'), 'GET', `/feed/calendar/${seed.feedTokens[ACCOUNT_OF[role]]}.ics`, { raw: true });
  const body = String(res.body);
  /** @type {any} */
  let events;
  if (res.status !== 200) events = { status: res.status, reason: body.slice(0, 40) };
  else if (!body.startsWith('BEGIN:VCALENDAR')) {
    flag(`${role} / ics_feed / events`, '200 without a calendar');
    events = { status: 200, reason: 'no calendar' };
  } else events = namesOf('events', [...body.matchAll(/^UID:event-(\d+)@yuvomi\r?$/gm)].map((m) => m[1]));
  return { ...base, tasks: eventsOnly, events };
}

/** @type {Record<string, string>} */
const REMINDER_ENTITY = { tasks: 'task', events: 'event', documents: 'document_expiry' };

/**
 * @param {string} role
 * @returns {Promise<Record<string, any>>}
 */
async function measureDueReminders(role) {
  /** @type {Record<string, any>} */
  const out = {
    notes: NA('notes have no reminder origin'),
    budget: NA('the budget reminder origin is the subscription, not the entry'),
    activities: NA('health activities have no reminder origin'),
    // Filled after every other measurement by measureMedicationDelivery():
    // the run writes medication_logs, nothing measured afterwards reads them.
    medications: null,
  };
  /** @type {Record<string, { status: number, body: any }>} */
  const answers = {
    default: await apiGet(role, 'due_reminders', '/reminders/pending'),
    household: await apiGet(role, 'due_reminders', '/reminders/pending?audience=household'),
  };
  for (const [type, entity] of Object.entries(REMINDER_ENTITY)) {
    out[type] = {};
    for (const [key, res] of Object.entries(answers)) {
      if (res.status !== 200) { out[type][key] = statusValue(res); continue; }
      const field = listField(res.body, 'data', `${role} / due_reminders / ${type} / ${key}`);
      out[type][key] = 'list' in field
        ? namesOf(type, field.list.filter((r) => r.entity_type === entity).map((r) => r.entity_id))
        : field.value;
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
// Medication delivery: the production scheduler, once, at the very end
// --------------------------------------------------------------------------

/**
 * Who hears about a due dose, measured on the production path: one run of
 * `processDueMedications()` with a push spy, no channels and no providers.
 * Every seeded medication gets one active schedule at 00:00 without a day
 * mask - due today at any time of day and in any zone, so `now` stays the
 * real clock. The schedules are written in the same synchronous turn that
 * starts the run: the server's own scheduler tick (15 s after boot, then every
 * 60 s) cannot create the logs first, because it never runs between the
 * insert and the run's first await.
 *
 * Runs AFTER every other measurement: it writes `medication_logs`, and the
 * dashboard (`dosesTaken`, `nextDose`) and the schedule route would see them.
 *
 * @returns {Promise<Record<string, any>>} cell per account
 */
async function measureMedicationDelivery() {
  const insertSchedule = db.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, active) VALUES (?, '00:00', NULL, 1)
  `);
  for (const row of seed.rows.medications) insertSchedule.run(row.id);
  /** @type {Array<{ userId: number, tag: string }>} */
  const pushes = [];
  const run = processDueMedications({
    database: db,
    pushService: { sendPushToUser: async (/** @type {number} */ userId, /** @type {any} */ payload) => { pushes.push({ userId, tag: payload.tag }); return 0; } },
    channelStore: { listEnabledChannelsForUser: () => [] },
    providers: {},
  });
  const counters = await run;
  assert.ok(counters && 'created' in counters && counters.created === seed.rows.medications.length,
    `every seeded medication had one new due dose (${JSON.stringify(counters)})`);

  /** @type {Map<number, number>} medication id -> owner id */
  const ownerOfMedication = new Map(seed.rows.medications.map((row) => [row.id, seed.ids[row.owner]]));
  const caregivers = new Set(db.prepare('SELECT caregiver_id FROM health_care_grants').all().map((/** @type {any} */ r) => r.caregiver_id));
  /** @type {Record<string, any>} */
  const out = {};
  for (const account of new Set(Object.values(ACCOUNT_OF))) {
    const userId = seed.ids[account];
    const received = pushes.filter((p) => p.userId === userId)
      .map((p) => ownerOfMedication.get(Number(/^medication-(\d+)-/.exec(p.tag)?.[1])));
    out[account] = {
      hearsOwnDose: received.some((ownerId) => ownerId === userId),
      hearsCaredForDose: caregivers.has(userId)
        ? received.some((ownerId) => ownerId !== userId)
        : NA('no health_care_grants row names this account as caregiver'),
      notLacksHealth: !lacksHealth(db, userId),
    };
  }
  return out;
}

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
const MODULE_LEVELS = { none: 'member_none', read: 'member_read', write: 'member' };

/**
 * The write probe for `read`: a DELETE on an id that cannot exist. Refused by
 * the module gate it is `module_read_only`; let through it would be a 404 and
 * change nothing. Its answer is always recorded as `{ status, reason }`.
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
  let n = 0;
  for (const [moduleKey, url] of Object.entries(MODULE_PROBES)) {
    out[moduleKey] = {};
    for (const [level, account] of Object.entries(MODULE_LEVELS)) {
      const session = seed.sessions[account];
      const headers = { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
      n += 1;
      const xff = `10.9.240.${n}`;
      out[moduleKey][level] = shapeOf(await http(xff, 'GET', `/api/v1${url}`, { headers }));
      if (level === 'read') out[moduleKey].read_write_probe = statusValue(await http(xff, 'DELETE', `/api/v1${url}/${WRITE_PROBE_ID}`, { headers }));
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
// Last: the scheduler run writes medication_logs.
const delivery = await measureMedicationDelivery();
for (const role of ROLES) measured[role].due_reminders.medications = delivery[ACCOUNT_OF[role]];
// The scheduler has no path for an account that does not exist (owner and
// caregiver are foreign keys); recorded is what the two exported production
// functions say about such an id.
const unknownAccountId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1000 AS id FROM users').get().id);
const measuredUnknown = {
  health_predicates: {
    recipientDeniedModulesIsNull: recipientDeniedModules(db, unknownAccountId) === null,
    notLacksHealth: !lacksHealth(db, unknownAccountId),
  },
};
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
  detail_documents_route: 'GET /documents/:id/thumbnail - same visibility lookup as preview/download, answers 415 for a non-DMS document without reading content; 415 = visible, 404 = not visible, 403 = refused, anything else fails the suite',
  detail_statuses: 'per route exactly three answers: its success status (200; thumbnail 415) = visible, 404 = not visible, 403 = refused; refusals next to visible rows stay in the cell as { visible, refused: { row: status } }',
  dashboard_reads: 'once with events_limit=12, plus once per owner task category (household/school/repair) for urgentTasks and wallTasks; countdowns and events come from the first read',
  due_reminders: 'one due reminder per task, event and document row for each of these accounts (created_by = caller): ' + seed.facts.reminderAccounts.join(', ') + '; document_expiry rows are seeded directly like the others; token roles read the member\'s rows',
  health_delivery: 'due_reminders / medications is measured on the production path: one processDueMedications() run (medication-scheduler.js) after every other measurement, every seeded medication with one active 00:00 schedule, push spy, no channels; hearsOwnDose = the account received a push for a medication it owns, hearsCaredForDose = for one it does not own (n/a without a care grant); notLacksHealth = !lacksHealth(db, id) (cycle-reminders.js ~71). caregiver, member_none, split_guest and display own one private medication each so they can be addressed',
  health_unknown_account: 'unknown_account: the scheduler has no path for an id without a users row (owner and caregiver are foreign keys); recorded are the two exported production answers for such an id: recipientDeniedModulesIsNull (reminder-origins.js, null = drop the recipient) and notLacksHealth',
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
  // Annotations survive on the module entries and the unknown-account entry too.
  const modules = Object.fromEntries(Object.entries(measuredModules)
    .map(([key, value]) => [key, withAnnotations(expected?.modules?.[key], value)]));
  const unknownAccount = withAnnotations(expected?.unknown_account, measuredUnknown);
  const file = sortKeys({ _meta: meta, cells, modules, unknown_account: unknownAccount });
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
  has(list.activities, [...adminRows('activities'), ...openRows('activities', ['family'])], 'activities');
});

test('no measurement met an answer outside its known set', () => {
  assert.deepEqual(unexpected, []);
});

test('the data file has exactly the measured keys at every level (630 cells, no leftovers)', () => {
  assert.ok(expected, 'test/visibility-matrix.expected.json is missing - run with UPDATE_VISIBILITY_MATRIX=1');
  /** @param {any} value */
  const keys = (value) => Object.keys(value && typeof value === 'object' ? value : {}).sort();
  assert.deepEqual(keys(expected), ['_meta', 'cells', 'modules', 'unknown_account']);
  assert.deepEqual(keys(expected.cells), [...ROLES].sort(), 'roles');
  for (const role of ROLES) {
    assert.deepEqual(keys(expected.cells[role]), [...PATHS].sort(), `${role}: paths`);
    for (const path of PATHS) assert.deepEqual(keys(expected.cells[role][path]), [...TYPES].sort(), `${role} / ${path}: types`);
  }
  assert.deepEqual(keys(expected.modules), keys(measuredModules), 'modules');
  for (const moduleKey of Object.keys(measuredModules)) {
    assert.deepEqual(keys(stripAnnotations(expected.modules[moduleKey])), keys(measuredModules[moduleKey]), `modules / ${moduleKey}: levels`);
  }
  assert.deepEqual(keys(stripAnnotations(expected.unknown_account)), keys(measuredUnknown), 'unknown_account');
});

test('the _meta block of the data file matches this seed', () => {
  assert.deepStrictEqual(sortKeys(expected?._meta), sortKeys(meta));
});

test('every search group stays within the search cap (SEARCH_LIMIT, services/search.js)', () => {
  for (const type of TYPES) {
    for (const owner of groupOwners(type)) {
      const size = seed.rows[type].filter((row) => row.owner === owner).length;
      assert.ok(size <= SEARCH_LIMIT, `${groupToken(type, owner)}: ${size} rows, cap ${SEARCH_LIMIT}`);
    }
  }
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

test('health answers for an account id that does not exist', () => {
  assert.deepStrictEqual(sortKeys(measuredUnknown), sortKeys(stripAnnotations(expected?.unknown_account)));
});

test('the suite stays below the API limit and well under a minute', () => {
  // Every role x path has its own bucket; the busiest is `detail` (one request per row).
  const rowsWithDetail = Object.keys(DETAIL_ROUTES).reduce((n, type) => n + seed.rows[type].length, 0);
  assert.ok(rowsWithDetail < 300, `detail requests per bucket: ${rowsWithDetail}`);
  assert.ok(measureMs < 60_000, `measuring took ${measureMs} ms for ${requestCount} requests`);
});
