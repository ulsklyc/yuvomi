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
 *          `row_rules` (phase 2, B8a) holds the row checks still written as
 *          JavaScript outside server/authorize: quick links, tasks on every
 *          mayAccessTask call site, series capabilities and occurrence
 *          routes, the Outlook auto-sync target. Their rows are seeded after
 *          every read path was measured (see `_meta.row_rules`).
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

import { startTestServer, cookieHeader } from './server-ready.js';
import {
  seedMatrix, seedRowRules, seedOutlookTarget, ROLES, PATHS, TYPES, OWNERS, TASK_CATEGORY_OF, SERIES_DAYS, OUTLOOK_TARGET_OWNER,
  groupToken,
} from './visibility-matrix-seed.js';

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
    // The row-rule block seeds an Outlook auto-sync target (seedOutlookTarget).
    // runOutlookSync() returns before any request while these three are unset;
    // pinned empty so a developer's own .env cannot open it.
    MS_CLIENT_ID: '',
    MS_CLIENT_SECRET: '',
    MS_REDIRECT_URI: '',
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
const { classifyLocalSeries } = await import('../server/services/calendar-occurrence-overrides.js');

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
// Row rules: the JavaScript row checks outside server/authorize (phase 2, B8a)
// --------------------------------------------------------------------------

/** The blocks under `row_rules` that are keyed by role. */
const RULE_BLOCKS = ['quick_links', 'task_writes', 'series', 'series_outlook_target'];
/** @type {(role: string, block: string) => string} */
const ruleXff = (role, block) => `10.10.${ROLES.indexOf(role) + 1}.${RULE_BLOCKS.indexOf(block) + 1}`;

/**
 * A display writes like the wall does: the display cookie plus the session
 * cookie and CSRF token its first GET was handed (csrfMiddleware keeps the
 * token in req.session). Filled by measureRowRules before the first block.
 * @type {Record<string, string> | null}
 */
let displayWriteHeaders = null;

/** @param {string} role @returns {Record<string, string>} */
function ruleHeaders(role) {
  return role === 'display' && displayWriteHeaders ? displayWriteHeaders : authHeaders(role);
}

/**
 * @param {string} role
 * @param {string} block
 * @param {string} method
 * @param {string} url  below /api/v1
 * @param {unknown} [body]
 */
function ruleCall(role, block, method, url, body) {
  return http(ruleXff(role, block), method, `/api/v1${url}`, { headers: ruleHeaders(role), body });
}

/**
 * One answer of a write path, classified against the route's known set:
 * `ok` (its success status; for a probe that ends at an input check behind
 * the rights check, that check's status and reason), `not_found` (its 404
 * with the route's own reason), `refused` (any 403, kept with its reason).
 * Anything else is flagged and fails the suite.
 * @typedef {{ status: number, reason?: string }} OkShape
 * @param {{ status: number, body: any }} res
 * @param {OkShape} ok
 * @param {string[]} hiddenReasons  the route's own 404 reasons
 * @returns {'ok' | 'not_found' | 'refused' | 'unexpected'}
 */
function classifyWrite(res, ok, hiddenReasons) {
  const reason = res.body && typeof res.body === 'object' ? res.body.reason : undefined;
  if (res.status === ok.status && (ok.reason === undefined || reason === ok.reason)) return 'ok';
  if (res.status === 404 && hiddenReasons.includes(reason)) return 'not_found';
  if (res.status === 403) return 'refused';
  return 'unexpected';
}

/**
 * Collects per-row answers of one write path into a cell: `{ ok, not_found,
 * refused?, unexpected? }`, or the one refusal when the gate refused every row
 * the same way (the same shape as the detail cells). A route with more than
 * one 404 reason keeps the reason per row: `not_found: { row: reason }`.
 */
class WriteCell {
  /** @param {string} where @param {OkShape} ok @param {string | string[]} hidden */
  constructor(where, ok, hidden) {
    this.where = where; this.okShape = ok;
    this.hiddenReasons = Array.isArray(hidden) ? hidden : [hidden];
    /** @type {string[]} */ this.ok = [];
    /** @type {string[]} */ this.notFound = [];
    /** @type {Record<string, string>} */ this.notFoundReason = {};
    /** @type {Record<string, { status: number, reason: string }>} */ this.refused = {};
    /** @type {Record<string, number>} */ this.odd = {};
    this.total = 0;
  }

  /** @param {string} name @param {{ status: number, body: any }} res @returns {boolean} true when ok */
  add(name, res) {
    this.total += 1;
    const kind = classifyWrite(res, this.okShape, this.hiddenReasons);
    if (kind === 'ok') this.ok.push(name);
    else if (kind === 'not_found') { this.notFound.push(name); this.notFoundReason[name] = res.body.reason; }
    else if (kind === 'refused') this.refused[name] = statusValue(res);
    else {
      this.odd[name] = res.status;
      flag(`${this.where} / ${name}`, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
    }
    return kind === 'ok';
  }

  value() {
    const refusals = new Set(Object.values(this.refused).map((v) => JSON.stringify(v)));
    if (Object.keys(this.refused).length === this.total && refusals.size === 1) return Object.values(this.refused)[0];
    return {
      ok: this.ok.sort(),
      not_found: this.hiddenReasons.length > 1
        ? Object.fromEntries(this.notFound.sort().map((name) => [name, this.notFoundReason[name]]))
        : this.notFound.sort(),
      ...(Object.keys(this.refused).length ? { refused: this.refused } : {}),
      ...(Object.keys(this.odd).length ? { unexpected: this.odd } : {}),
    };
  }
}

/**
 * Puts a deleted row back with the same id and the same values.
 * @param {string} table
 * @param {Record<string, unknown>} row
 */
function reinsert(table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`).run(row);
}

/**
 * A read in the row-rule blocks: 200 is read on, the gate's 403 is the cell
 * value, anything else (a 500, a 401) is flagged and fails the suite - also in
 * update mode, so it never lands in the data file unseen.
 * @param {{ status: number, body: any }} res
 * @param {string} where
 * @returns {{ status: number, reason: string } | null} null for a 200
 */
function readRefusal(res, where) {
  if (res.status === 200) return null;
  if (res.status !== 403) flag(where, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  return statusValue(res);
}

/** @type {ReturnType<typeof seedRowRules> | null} */
let ruleSeed = null;

/**
 * Quick links: list (with `can_edit`), the dashboard row, PUT {} and DELETE
 * per tile (quick-links.js: 404 at ~302/347, mayEdit ~145 -> 403).
 * @param {string} role
 */
async function measureQuickLinks(role) {
  const links = /** @type {NonNullable<typeof ruleSeed>} */ (ruleSeed).quickLinks;
  const nameOfLink = new Map(links.map((l) => [l.id, l.name]));
  /** @param {any[]} list */
  const tiles = (list) => ({
    editable: list.filter((l) => l.can_edit === true).map((l) => nameOfLink.get(l.id) ?? `unknown:${l.id}`).sort(),
    visible: list.map((l) => nameOfLink.get(l.id) ?? `unknown:${l.id}`).sort(),
  });
  const where = `${role} / row_rules / quick_links`;
  const out = /** @type {Record<string, any>} */ ({ detail: NA('quick links have no read-by-id route') });

  const list = await ruleCall(role, 'quick_links', 'GET', '/quick-links');
  const listRefusal = readRefusal(list, `${where} / list`);
  if (listRefusal) out.list = listRefusal;
  else {
    const field = listField(list.body, 'data', `${where} / list`);
    out.list = 'list' in field ? tiles(field.list) : field.value;
  }
  for (const [key, query] of [['overview', ''], ['overview_household', '?audience=household']]) {
    const res = await ruleCall(role, 'quick_links', 'GET', `/dashboard${query}`);
    const refusal = readRefusal(res, `${where} / ${key}`);
    if (refusal) { out[key] = refusal; continue; }
    const field = listField(res.body, 'quicklinks', `${where} / ${key}`);
    out[key] = 'list' in field ? tiles(field.list) : field.value;
  }

  const change = new WriteCell(`${where} / change`, { status: 200 }, 'quick_links_link_not_found');
  const remove = new WriteCell(`${where} / remove`, { status: 204 }, 'quick_links_link_not_found');
  const byId = db.prepare('SELECT * FROM quick_links WHERE id = ?');
  for (const link of links) {
    // `{}`: every field keeps its value (each is read from the row when absent).
    change.add(link.name, await ruleCall(role, 'quick_links', 'PUT', `/quick-links/${link.id}`, {}));
    const before = byId.get(link.id);
    if (remove.add(link.name, await ruleCall(role, 'quick_links', 'DELETE', `/quick-links/${link.id}`))) reinsert('quick_links', before);
  }
  out.change = change.value();
  out.remove = remove.value();
  return out;
}

/**
 * Tasks on the write paths, one cell per call site of mayAccessTask
 * (tasks.js ~420), plus the next due date after ticking a chain off.
 * @param {string} role
 */
async function measureTaskWrites(role) {
  const seedRules = /** @type {NonNullable<typeof ruleSeed>} */ (ruleSeed);
  const where = `${role} / row_rules / task_writes`;
  const notFound = 'tasks_task_not_found';
  const cells = {
    completions: new WriteCell(`${where} / completions`, { status: 200 }, notFound),
    check: new WriteCell(`${where} / check`, { status: 200 }, notFound),
    archive: new WriteCell(`${where} / archive`, { status: 200 }, notFound),
    status: new WriteCell(`${where} / status`, { status: 200 }, notFound),
    subtask: new WriteCell(`${where} / subtask`, { status: 201 }, 'tasks_parent_not_found'),
    remove: new WriteCell(`${where} / remove`, { status: 200 }, notFound),
  };
  const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const assignmentRows = db.prepare('SELECT * FROM task_assignments WHERE task_id = ?');
  for (const task of seedRules.tasks) {
    cells.completions.add(task.name, await ruleCall(role, 'task_writes', 'GET', `/tasks/${task.id}/completions`));
    // Unchanged line: `changed: false`, no write.
    cells.check.add(task.name, await ruleCall(role, 'task_writes', 'PATCH', `/tasks/${task.id}/check`, { line: 0, checked: false }));
    // Not archived, stays not archived.
    cells.archive.add(task.name, await ruleCall(role, 'task_writes', 'PATCH', `/tasks/${task.id}/archive`, { archived: false }));
    // open -> open: no transition, no completion, no followup.
    cells.status.add(task.name, await ruleCall(role, 'task_writes', 'PATCH', `/tasks/${task.id}/status`, { status: 'open' }));
    const sub = await ruleCall(role, 'task_writes', 'POST', '/tasks', { title: 'mx subtask', parent_task_id: task.id });
    if (cells.subtask.add(task.name, sub)) db.prepare('DELETE FROM tasks WHERE id = ?').run(sub.body?.data?.id);
    const before = taskRow.get(task.id);
    const assignments = assignmentRows.all(task.id);
    if (cells.remove.add(task.name, await ruleCall(role, 'task_writes', 'DELETE', `/tasks/${task.id}`))) {
      reinsert('tasks', before);
      for (const row of assignments) reinsert('task_assignments', row);
    }
  }
  /** @type {Record<string, any>} */
  const out = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell.value()]));

  // Next due date (nextDueDateAfter, tasks.js ~1860): tick each shared origin
  // off; the answer names the followup's date or null. A display has to name
  // the person (displayActingPerson); everyone else does not.
  const body = role === 'display' ? { status: 'done', done_by_user_id: seed.ids.admin } : { status: 'done' };
  for (const { cell, origin, followup } of seedRules.chains) {
    const res = await ruleCall(role, 'task_writes', 'PATCH', `/tasks/${origin.id}/status`, body);
    if (res.status === 200) {
      const next = res.body?.data?.next_due_date;
      const followupDue = taskRow.get(followup.id).due_date;
      if (next !== null && next !== followupDue) flag(`${where} / ${cell}`, `unknown date ${next}`);
      out[cell] = { next: next === followupDue ? followup.name : null, status: 200 };
      // Back to open: the transition wrote the status and one completion row.
      db.prepare("UPDATE tasks SET status = 'open' WHERE id = ?").run(origin.id);
      db.prepare('DELETE FROM task_completions WHERE task_id = ?').run(origin.id);
    } else if (res.status === 403 || res.status === 404) out[cell] = statusValue(res);
    else {
      flag(`${where} / ${cell}`, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      out[cell] = statusValue(res);
    }
  }
  return out;
}

/**
 * The series capabilities in the calendar answer (buildRecurrenceCapabilityMap,
 * calendar-occurrence-overrides.js ~643): which seeded series the role sees and
 * for which it may override or detach an occurrence.
 * @param {string} role
 * @param {string} block
 */
async function seriesCapabilities(role, block) {
  const seedRules = /** @type {NonNullable<typeof ruleSeed>} */ (ruleSeed);
  const nameOfSeries = new Map(seedRules.series.map((s) => [s.id, s.name]));
  const to = shiftDateKey(seedRules.seriesStart, SERIES_DAYS);
  const res = await ruleCall(role, block, 'GET', `/calendar?from=${seedRules.seriesStart}&to=${to}`);
  const refusal = readRefusal(res, `${role} / row_rules / ${block} / capabilities`);
  if (refusal) return refusal;
  const field = listField(res.body, 'data', `${role} / row_rules / ${block} / capabilities`);
  if (!('list' in field)) return field.value;
  /** @type {Map<string, Set<string>>} */
  const flags = new Map();
  for (const event of field.list) {
    const name = nameOfSeries.get(Number(event.series_id));
    if (!name) continue;
    if (!flags.has(name)) flags.set(name, new Set());
    flags.get(name)?.add(JSON.stringify([event.can_override_occurrence === true, event.can_detach_occurrence === true]));
  }
  for (const [name, set] of flags) {
    if (set.size > 1) flag(`${role} / row_rules / ${block} / capabilities / ${name}`, `rows disagree: ${[...set].join(' ')}`);
  }
  /** @param {number} index */
  const withFlag = (index) => [...flags].filter(([, set]) => JSON.parse([...set][0])[index]).map(([name]) => name).sort();
  return { can_detach: withFlag(1), can_override: withFlag(0), visible: [...flags.keys()].sort() };
}

/**
 * Series: the capability fields, then every write route that reaches
 * isEligibleLocalSeries (calendar-occurrence-overrides.js ~695). The
 * occurrence routes get a well-formed key one day before the series start:
 * baseOccurrenceFor() refuses it with 400 `invalid_recurrence_id` AFTER the
 * visibility, ownership and series checks, so nothing is written and that 400
 * means "past the checks". PUT and DELETE on the linked occurrence row end in
 * 400 `calendar_occurrence_route_required` behind the same checks.
 * @param {string} role
 */
async function measureSeries(role) {
  const seedRules = /** @type {NonNullable<typeof ruleSeed>} */ (ruleSeed);
  const where = `${role} / row_rules / series`;
  const outside = shiftDateKey(seedRules.seriesStart, -1);
  const past = { status: 400, reason: 'invalid_recurrence_id' };
  const linked = { status: 400, reason: 'calendar_occurrence_route_required' };
  const cells = {
    occurrence_put: new WriteCell(`${where} / occurrence_put`, past, 'calendar_series_not_found'),
    occurrence_put_following: new WriteCell(`${where} / occurrence_put_following`, past, 'calendar_series_not_found'),
    occurrence_delete: new WriteCell(`${where} / occurrence_delete`, past, 'calendar_series_not_found'),
    occurrence_delete_following: new WriteCell(`${where} / occurrence_delete_following`, past, 'calendar_series_not_found'),
    exceptions_post: new WriteCell(`${where} / exceptions_post`, past, 'calendar_event_not_found'),
    // The occurrence row itself hidden (event) or visible with its series
    // hidden (series, rejectLinkedOccurrenceResource): both are kept by row.
    linked_put: new WriteCell(`${where} / linked_put`, linked, ['calendar_event_not_found', 'calendar_series_not_found']),
    linked_delete: new WriteCell(`${where} / linked_delete`, linked, ['calendar_event_not_found', 'calendar_series_not_found']),
  };
  for (const s of seedRules.series) {
    cells.occurrence_put.add(s.name, await ruleCall(role, 'series', 'PUT', `/calendar/${s.id}/occurrences/${outside}`, { title: 'mx' }));
    cells.occurrence_put_following.add(s.name, await ruleCall(role, 'series', 'PUT', `/calendar/${s.id}/occurrences/${outside}/following`, { title: 'mx' }));
    cells.occurrence_delete.add(s.name, await ruleCall(role, 'series', 'DELETE', `/calendar/${s.id}/occurrences/${outside}`));
    cells.occurrence_delete_following.add(s.name, await ruleCall(role, 'series', 'DELETE', `/calendar/${s.id}/occurrences/${outside}/following`));
    cells.exceptions_post.add(s.name, await ruleCall(role, 'series', 'POST', `/calendar/${s.id}/exceptions`, { recurrence_id: outside }));
    if (s.linkedChildId === null) continue;
    cells.linked_put.add(s.name, await ruleCall(role, 'series', 'PUT', `/calendar/${s.linkedChildId}`, {}));
    cells.linked_delete.add(s.name, await ruleCall(role, 'series', 'DELETE', `/calendar/${s.linkedChildId}`));
  }
  return {
    capabilities: await seriesCapabilities(role, 'series'),
    ...Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell.value()])),
  };
}

/**
 * The Outlook block, last: with a writable auto-sync target owned by
 * OUTLOOK_TARGET_OWNER, a series the target's owner would see is no longer
 * eligible (hasConfiguredOutlookAutoSyncTarget, ~508). The calendar answer
 * shows it only through can_override_occurrence; the classification itself
 * comes from the exported production function classifyLocalSeries.
 */
async function measureOutlookTarget() {
  const seedRules = /** @type {NonNullable<typeof ruleSeed>} */ (ruleSeed);
  /** @type {Record<string, any>} */
  const classification = {};
  const before = Object.fromEntries(seedRules.series.map((s) => [s.name,
    classifyLocalSeries(db, db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(s.id))]));
  seedOutlookTarget(db, seed.ids);
  for (const s of seedRules.series) {
    const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(s.id);
    classification[s.name] = { after: classifyLocalSeries(db, row), before: before[s.name] };
  }
  /** @type {Record<string, any>} */
  const roles = {};
  for (const role of ROLES) roles[role] = { capabilities: await seriesCapabilities(role, 'series_outlook_target') };
  return { classification, roles };
}

/**
 * What the write probes must leave as it was: every role measures the same
 * state. Every column except updated_at (PUT {} on a quick link moves it) of
 * the seeded rows, their assignment rows, and how many reminders and ledger
 * rows hang on them.
 * @returns {Record<string, unknown>}
 */
function ruleRowState() {
  /** @param {any[]} rows */
  const withoutUpdatedAt = (rows) => rows.map(({ updated_at: _ignored, ...rest }) => rest);
  const taskIds = 'SELECT id FROM tasks WHERE title LIKE \'wtask.%\' OR title = \'mx subtask\'';
  const eventIds = 'SELECT id FROM calendar_events WHERE title LIKE \'series.%\'';
  return {
    completions: db.prepare(`SELECT COUNT(*) AS n FROM task_completions WHERE task_id IN (${taskIds})`).get(),
    eventAssignments: db.prepare(`SELECT * FROM event_assignments WHERE event_id IN (${eventIds}) ORDER BY event_id, user_id`).all(),
    events: withoutUpdatedAt(db.prepare(`SELECT * FROM calendar_events WHERE id IN (${eventIds}) ORDER BY id`).all()),
    exceptions: db.prepare('SELECT event_id, exception_date FROM calendar_event_exceptions ORDER BY event_id, exception_date').all(),
    ledger: db.prepare(`SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id IN (${taskIds})`).get(),
    quickLinks: withoutUpdatedAt(db.prepare('SELECT * FROM quick_links ORDER BY id').all()),
    reminders: db.prepare(`SELECT COUNT(*) AS n FROM reminders
                           WHERE (entity_type = 'task' AND entity_id IN (${taskIds}))
                              OR (entity_type = 'event' AND entity_id IN (${eventIds}))`).get(),
    taskAssignments: db.prepare(`SELECT * FROM task_assignments WHERE task_id IN (${taskIds}) ORDER BY task_id, user_id`).all(),
    tasks: withoutUpdatedAt(db.prepare(`SELECT * FROM tasks WHERE id IN (${taskIds}) ORDER BY id`).all()),
  };
}

/** @type {{ before: any, after: any } | null} */
let ruleStateKept = null;

/** @returns {Promise<Record<string, any>>} */
async function measureRowRules() {
  ruleSeed = seedRowRules({ db, ids: seed.ids, dates, shiftDateKey });
  // The wall's session: the first GET below /api/v1 (csrfMiddleware; /auth is mounted before it) hands out the session cookie and the CSRF token.
  const first = await http('10.10.250.200', 'GET', '/api/v1/quick-links', { headers: authHeaders('display') });
  const sessionCookie = cookieHeader(first.headers.get('set-cookie'));
  const csrf = first.headers.get('x-csrf-token');
  assert.ok(sessionCookie && csrf, `the display GET hands out a session and a CSRF token (${first.status})`);
  displayWriteHeaders = { Cookie: `${DISPLAY_COOKIE}=${seed.displayToken}; ${sessionCookie}`, 'X-CSRF-Token': String(csrf) };

  /** @type {Record<string, Record<string, any>>} */
  const out = { quick_links: {}, task_writes: {}, series: {} };
  const before = ruleRowState();
  for (const role of ROLES) {
    out.quick_links[role] = await measureQuickLinks(role);
    out.task_writes[role] = await measureTaskWrites(role);
    out.series[role] = await measureSeries(role);
  }
  ruleStateKept = { after: ruleRowState(), before };
  const outlook = await measureOutlookTarget();
  out.series_outlook_target = outlook.roles;
  out.outlook_classification = outlook.classification;
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
// Row rules: their rows exist only from here on (see seedRowRules).
const measuredRowRules = await measureRowRules();
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
  row_rules: 'row_rules holds the JavaScript row checks outside server/authorize (phase 2, B8a). Its rows are seeded AFTER every read path and the module level were measured and BEFORE the medication run (seedRowRules in the seed file); they are not in seed_counts and no read-path cell sees them. Blocks quick_links, task_writes, series and series_outlook_target are keyed by role (all ten), then by cell; outlook_classification is keyed by series. One cell = one leaf under a role (or one series in outlook_classification). Every block sends from its own client address 10.10.<role>.<block>; setup requests from 10.10.250.x',
  row_rules_cells: 'write cells are { ok, not_found, refused?: { row: { status, reason } } } over every seeded row of the block, or the one { status, reason } when the gate refused every row the same way. ok = the route\'s success status (or, where noted, the input check behind the rights check), not_found = its 404 with the route\'s own reason (a route with two 404 reasons keeps them by row: not_found: { row: reason }), refused = any 403; any other answer fails the suite. The reads (list, overview, capabilities) accept 200 and the gate\'s 403; anything else is flagged, also in update mode',
  row_rules_display: 'the display writes like the wall: display cookie plus the session cookie and CSRF token its first GET below /api/v1 (GET /quick-links) handed out (csrfMiddleware keeps the token in req.session)',
  row_rules_quick_links: 'quicklink.<owner>.<all|private> for admin/member/child, seeded directly. list = GET /quick-links as { visible, editable (can_edit) }; overview / overview_household = the quicklinks row of GET /dashboard (personal, audience=household) in the same shape; change = PUT /quick-links/:id with {} (every field keeps its value, only updated_at moves), ok 200; remove = DELETE /quick-links/:id, ok 204, the row goes back with the same id and values after each 204; detail is n/a',
  row_rules_task_writes: 'wtask.<owner>.<all|private|assignees> for admin/member/child (all and assignees assigned to OTHER_OF[owner] via task_assignments, description "- [ ] mx item", no due date), plus wtask.admin.assignees.display assigned to the display account (not a realistic state: without it the display branch of PATCH /:id/status, tasks.js ~2287, answers for no task because mayAccessTask runs first). One cell per mayAccessTask call site: completions = GET /:id/completions (~2604), check = PATCH /:id/check {line 0, checked false} (~2471, unchanged line, no write), archive = PATCH /:id/archive {archived false} (~2418), status = PATCH /:id/status {status open} on an open task (~2244, then the display branch ~2287), subtask = POST /tasks {title, parent_task_id} (~1399, ok 201, the subtask is deleted), remove = DELETE /:id (~2529, the row and its assignments go back with the same id). next_due_date / next_due_date_all / next_due_date_assignees = PATCH /:id/status {status done} on wtask.chain.origin / wtask.chain-all.origin / wtask.chain-assignees.origin (shared, weekly) whose followup already exists: wtask.chain.followup (admin, private), wtask.chain-all.followup (admin, all), wtask.chain-assignees.followup (admin, assignees, assigned to OTHER_OF.admin = member); next names the followup when the answer carries its due date, null otherwise (nextDueDateAfter ~1860: display reads visibility all, people mayAccessTask); the display names done_by_user_id = admin; each origin is reopened and its completion row deleted after each 200',
  row_rules_series: 'series.<owner>.<all|private|assignees> for admin/member/child: local, all-day, FREQ=DAILY;COUNT=' + SERIES_DAYS + ' from today+40 (all and assignees assigned to OTHER_OF[owner] via event_assignments), each with one linked occurrence on its second day, seeded directly in the shape PUT /calendar/:id/occurrences/:day writes (recurrence_parent_id, recurrence_id, overridden_fields, series_authored 1, the series\' assignment rows copied; not through the route, which runs the rule under test); the occurrence of a private or assignees series is overridden to visibility all, so a viewer who may not see the series still gets the occurrence in GET /calendar and the capability map loads the hidden master itself (canOverrideOccurrence then hangs on actorCanSeeSeries alone). Plus series.admin.assignees.unlinked (assigned to member) and series.member.private.unlinked without a linked occurrence: after the Outlook target they are local and not eligible, the only state in which can_detach can be true (a linked child makes it false for everyone). capabilities = GET /calendar over the series days as { visible (series with at least one row in the answer, a shared occurrence included), can_override (can_override_occurrence), can_detach (can_detach_occurrence) } per series. occurrence_put / occurrence_put_following / occurrence_delete / occurrence_delete_following / exceptions_post send the well-formed key of the day before the series start: ok = 400 invalid_recurrence_id, which baseOccurrenceFor() answers only AFTER visibility, ownership (not_owner) and isEligibleLocalSeries, so nothing is written ("past the checks"); exceptions_post computes the eligibility but only uses its reason for a series that is not locally owned. linked_put / linked_delete = PUT {} / DELETE on the linked occurrence row: ok = 400 calendar_occurrence_route_required (rejectLinkedOccurrenceResource, behind the same checks); not_found by row = 404 calendar_event_not_found (the occurrence row hidden) or calendar_series_not_found (the occurrence shared, its series hidden); the unlinked series have no linked_* answer',
  row_rules_coverage: 'what the cells do NOT measure: exceptions_post reaches only loadVisibleEvent and refuseForeignEvent (calendar/crud.js ~1967); isEligibleLocalSeries there only supplies the reason for a series that is not locally owned, so the cell is no evidence for actorCanSeeSeries. canDetachOccurrence (~686-688) is measured only in the stricter direction: a row of a series without a linked child reaches a viewer only when the master itself is visible, which is the same rule as actorCanSeeSeries; a looser actorCanSeeSeries cannot show there. quick_links.overview_household is empty for every role that reads it: the wall allowlist (HOUSEHOLD_AUDIENCE_SHOWS, authorize/rows/household.ts) does not carry quicklinks, so householdAudienceAnswer() keeps the empty form',
  row_rules_outlook: 'series_outlook_target = the capabilities cell again after seedOutlookTarget: one outlook_accounts row (auto_sync_calendar_id, owner_user_id = ' + OUTLOOK_TARGET_OWNER + ') with one outlook_calendar_selection row (enabled 1, can_edit 1); MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REDIRECT_URI are pinned empty, so the sync tick returns before any request. outlook_classification = classifyLocalSeries (exported production function) per series before and after the target: the calendar answer shows eligibility only through can_override_occurrence',
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
  /** @type {Record<string, any>} */
  const rowRules = {};
  for (const block of RULE_BLOCKS) {
    rowRules[block] = {};
    for (const role of ROLES) {
      rowRules[block][role] = Object.fromEntries(Object.entries(measuredRowRules[block][role])
        .map(([cell, value]) => [cell, withAnnotations(expected?.row_rules?.[block]?.[role]?.[cell], value)]));
    }
  }
  rowRules.outlook_classification = Object.fromEntries(Object.entries(measuredRowRules.outlook_classification)
    .map(([name, value]) => [name, withAnnotations(expected?.row_rules?.outlook_classification?.[name], value)]));
  const file = sortKeys({ _meta: meta, cells, modules, unknown_account: unknownAccount, row_rules: rowRules });
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
  assert.deepEqual(keys(expected), ['_meta', 'cells', 'modules', 'row_rules', 'unknown_account']);
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

test('row_rules has exactly the measured keys down to the cell', () => {
  /** @param {any} value */
  const keys = (value) => Object.keys(value && typeof value === 'object' ? value : {}).sort();
  const rules = expected?.row_rules;
  assert.deepEqual(keys(rules), [...RULE_BLOCKS, 'outlook_classification'].sort(), 'blocks');
  for (const block of RULE_BLOCKS) {
    assert.deepEqual(keys(rules[block]), [...ROLES].sort(), `${block}: roles`);
    for (const role of ROLES) {
      assert.deepEqual(keys(rules[block][role]), keys(measuredRowRules[block][role]), `${block} / ${role}: cells`);
    }
  }
  assert.deepEqual(keys(rules.outlook_classification), keys(measuredRowRules.outlook_classification), 'outlook_classification: series');
});

for (const block of RULE_BLOCKS) {
  test(`row_rules / ${block}`, () => {
    const diffs = [];
    for (const role of ROLES) {
      for (const [cell, got] of Object.entries(measuredRowRules[block][role])) {
        const want = stripAnnotations(expected?.row_rules?.[block]?.[role]?.[cell]);
        try { assert.deepStrictEqual(sortKeys(got), sortKeys(want)); } catch {
          diffs.push(`${role} / ${block} / ${cell}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
        }
      }
    }
    assert.equal(diffs.length, 0, `\n${diffs.join('\n')}`);
  });
}

test('row_rules: the write probes leave every seeded row as it was', () => {
  assert.ok(ruleStateKept, 'measured');
  assert.deepStrictEqual(ruleStateKept.after, ruleStateKept.before);
});

test('row_rules / outlook_classification', () => {
  const diffs = [];
  for (const [name, got] of Object.entries(measuredRowRules.outlook_classification)) {
    const want = stripAnnotations(expected?.row_rules?.outlook_classification?.[name]);
    try { assert.deepStrictEqual(sortKeys(got), sortKeys(want)); } catch {
      diffs.push(`outlook_classification / ${name}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }
  assert.equal(diffs.length, 0, `\n${diffs.join('\n')}`);
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
