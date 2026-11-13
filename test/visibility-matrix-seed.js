/**
 * Module: Seed for the visibility matrix (test/test-visibility-matrix.js)
 * Purpose: builds the household the matrix measures - ten roles, seven row
 *          types, every row with a speaking name - against the REAL server.
 *
 * Where production state arises through a route, the seed takes that route:
 * the household setup, every person (`POST /auth/users`, so the child gets its
 * CHILD_START_PERMISSIONS the way a new child does), the wall display (create,
 * pairing code, pair) and the three API tokens (`POST /auth/api-tokens`).
 *
 * The ROWS are written straight into the database. The matrix is about who
 * reads which row, not about how a row was created, and a controlled state
 * per row (visibility, assignment, legacy column, expiry, due reminder) is
 * exactly what a create route would not let the seed choose freely.
 *
 * Names follow `<type>.<owner>.<level>[.<detail>]`. Every title carries a group
 * token unique per type and owner (`mxtaskadmin`), so one search per group
 * stays below the search cap of five hits per bucket.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { cookieHeader } from './server-ready.js';

/**
 * @typedef {{ status: number, body: any, headers: Headers }} HttpResult
 * @typedef {(xff: string, method: string, path: string, options?: { headers?: Record<string, string>, body?: unknown, raw?: boolean }) => Promise<HttpResult>} HttpFn
 * @typedef {{ today: string, inTwoDays: string, inTenDays: string, month: string, dueInstant: string }} SeedDates
 * @typedef {{ name: string, id: number, owner: string }} SeedRow
 * @typedef {{ cookie: string, csrf: string }} SeedSession
 * @typedef {{ prepare: (sql: string) => any }} Database
 * @typedef {{
 *   ids: Record<string, number>,
 *   sessions: Record<string, SeedSession>,
 *   tokens: Record<string, string>,
 *   displayToken: string,
 *   feedTokens: Record<string, string>,
 *   rows: Record<string, SeedRow[]>,
 *   facts: { reminderAccounts: string[], tokenShapes: Record<string, string> },
 * }} Seed
 */

/** The ten matrix roles, in the order of the data file. */
export const ROLES = Object.freeze([
  'admin', 'member', 'child', 'caregiver', 'member_none',
  'split_guest', 'display', 'token_read', 'token_write', 'token_unscoped',
]);

/** The nine read paths. */
export const PATHS = Object.freeze([
  'list', 'detail', 'overview', 'overview_household', 'search',
  'mcp_core', 'mcp_bridge', 'ics_feed', 'due_reminders',
]);

/** The seven row types. */
export const TYPES = Object.freeze(['tasks', 'events', 'notes', 'documents', 'budget', 'medications', 'activities']);

/** Owners of seed rows and the one other account each owner assigns to. */
export const OWNERS = Object.freeze(['admin', 'member', 'child']);
/** @type {Readonly<Record<string, string>>} */
export const OTHER_OF = Object.freeze({ admin: 'member', member: 'child', child: 'caregiver' });

/**
 * One task category per owner: the dashboard is read per category so its cap
 * of five never bites.
 * @type {Readonly<Record<string, string>>}
 */
export const TASK_CATEGORY_OF = Object.freeze({ admin: 'household', member: 'school', child: 'repair' });

/** Accounts that log in with a password (the helper `member_read` is no matrix role). */
const SESSION_ACCOUNTS = ['admin', 'member', 'child', 'caregiver', 'member_none', 'member_read', 'split_guest'];

/** Accounts without seed rows of their own that still own one private medication. */
const MEDICATION_ONLY_OWNERS = ['caregiver', 'member_none', 'split_guest', 'display'];

/** Accounts that get one due reminder per task, event and document row. */
const REMINDER_ACCOUNTS = ['admin', 'member', 'child', 'caregiver', 'member_none', 'split_guest', 'display'];

/** @type {Record<string, string>} */
const TYPE_SHORT = {
  tasks: 'task', events: 'evt', notes: 'note', documents: 'doc', budget: 'budget', medications: 'med', activities: 'act',
};

/**
 * Group token of a type and owner, e.g. `mxtaskadmin`.
 * @param {string} type
 * @param {string} owner
 * @returns {string}
 */
export function groupToken(type, owner) {
  return `mx${TYPE_SHORT[type]}${owner}`;
}

/**
 * The household, the people, their sessions, the display and the tokens.
 *
 * @param {{ db: Database, call: (method: string, path: string, options?: { headers?: Record<string, string>, body?: unknown }) => Promise<HttpResult>,
 *           permissionModules: string[], scopeModules: string[], displayCookie: string }} options
 */
async function seedAccounts({ db, call, permissionModules, scopeModules, displayCookie }) {
  const setup = await call('POST', '/api/v1/auth/setup', {
    body: { username: 'admin', display_name: 'Admin', password: 'admin-pass-123' },
  });
  assert.equal(setup.status, 201, `household setup: ${JSON.stringify(setup.body)}`);

  /** @type {Record<string, SeedSession>} */
  const sessions = {};
  /** @param {string} account @param {string} password */
  async function login(account, password) {
    const res = await call('POST', '/api/v1/auth/login', { body: { username: account, password } });
    assert.equal(res.status, 200, `login ${account}`);
    sessions[account] = { cookie: cookieHeader(res.headers.get('set-cookie')), csrf: res.body.csrfToken };
  }
  await login('admin', 'admin-pass-123');
  const adminHeaders = { Cookie: sessions.admin.cookie, 'X-CSRF-Token': sessions.admin.csrf };

  /** @type {Record<string, number>} */
  const ids = { admin: db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id };
  /** @type {Record<string, string>} */
  const familyRoleOf = {
    member: 'parent', child: 'child', caregiver: 'parent', member_none: 'other', member_read: 'other', split_guest: 'other',
  };
  for (const account of Object.keys(familyRoleOf)) {
    const res = await call('POST', '/api/v1/auth/users', {
      headers: adminHeaders,
      body: { username: account, display_name: account, password: `${account}-pass-123`, family_role: familyRoleOf[account] },
    });
    assert.equal(res.status, 201, `create ${account}: ${JSON.stringify(res.body)}`);
    ids[account] = res.body.user.id;
  }

  // Module rights of the two restricted members: every permission module.
  const grant = db.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, ?)
  `);
  for (const key of permissionModules) {
    grant.run(String(ids.member_none), key, 'none');
    grant.run(String(ids.member_read), key, 'read');
  }

  // The caregiver looks after the child (health care grant).
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(ids.child, ids.caregiver);

  // The split guest: a users row bound to one expense group.
  const groupId = db.prepare('INSERT INTO expense_groups (name, created_by) VALUES (?, ?)').run('matrix trip', ids.admin).lastInsertRowid;
  db.prepare('INSERT INTO split_expense_guest_users (user_id, group_id, created_by) VALUES (?, ?, ?)')
    .run(ids.split_guest, groupId, ids.admin);

  for (const account of SESSION_ACCOUNTS.filter((a) => a !== 'admin')) await login(account, `${account}-pass-123`);

  // Wall display through the real pairing routes.
  const created = await call('POST', '/api/v1/displays', { headers: adminHeaders, body: { display_name: 'matrix wall' } });
  assert.equal(created.status, 201, `create display: ${JSON.stringify(created.body)}`);
  ids.display = created.body.data.id;
  const code = await call('POST', `/api/v1/displays/${ids.display}/pairing-code`, { headers: adminHeaders, body: {} });
  assert.equal(code.status, 201, `pairing code: ${JSON.stringify(code.body)}`);
  const paired = await call('POST', '/api/v1/displays/pair', { body: { code: code.body.data.code } });
  assert.ok(paired.status < 300, `pair display: ${paired.status}`);
  const cookieMatch = String(paired.headers.get('set-cookie') || '').match(new RegExp(`${displayCookie}=([^;]+)`));
  assert.ok(cookieMatch, 'the pairing answer sets the display cookie');
  const displayToken = decodeURIComponent(cookieMatch[1]);

  // Three API tokens for the member, through the real route.
  /** @type {Record<string, string[] | null>} */
  const tokenShapes = {
    token_read: scopeModules.map((key) => `${key}:read`),
    token_write: scopeModules.map((key) => `${key}:write`),
    token_unscoped: null,
  };
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const [role, scopes] of Object.entries(tokenShapes)) {
    const res = await call('POST', '/api/v1/auth/api-tokens', {
      headers: adminHeaders,
      body: { name: role, subject_user_id: ids.member, ...(scopes ? { scopes } : {}) },
    });
    assert.equal(res.status, 201, `token ${role}: ${JSON.stringify(res.body)}`);
    tokens[role] = res.body.token;
  }

  // Calendar feed token for every account, guest and display included (DB).
  /** @type {Record<string, string>} */
  const feedTokens = {};
  for (const account of [...SESSION_ACCOUNTS, 'display']) {
    feedTokens[account] = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET calendar_feed_token = ? WHERE id = ?').run(feedTokens[account], ids[account]);
  }

  /** @type {Record<string, string>} */
  const tokenFacts = {};
  for (const [role, scopes] of Object.entries(tokenShapes)) {
    tokenFacts[role] = scopes ? `${scopes.length} scopes, every module ${scopes[0].split(':')[1]}` : 'scopes NULL';
  }
  return { ids, sessions, tokens, displayToken, feedTokens, tokenFacts };
}

/**
 * Tasks and events: per owner `all`, `private`, `assignees`, plus the admin's
 * legacy probe and the member's two ICS subscription events.
 *
 * @param {Database} db
 * @param {Record<string, number>} ids
 * @param {SeedDates} dates
 * @param {(type: string, name: string, id: number, owner: string) => void} remember
 */
function seedTasksAndEvents(db, ids, dates, remember) {
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, visibility, created_by, assigned_to, countdown)
    VALUES (@title, @category, 'high', 'open', @due, @visibility, @owner, @assignedTo, @countdown)
    RETURNING id
  `);
  const assignTask = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  const insertEvent = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, subscription_id, countdown)
    VALUES (@title, @start, 1, @visibility, @owner, @source, @subscription, @countdown)
    RETURNING id
  `);
  const assignEvent = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');

  for (const owner of OWNERS) {
    const other = OTHER_OF[owner];
    // `all` carries an assignment too: the wall block (`wallTasks`) only lists
    // assigned tasks, and without one the block could never show a row.
    for (const level of ['all', 'private', 'assignees']) {
      const name = `task.${owner}.${level}`;
      const id = insertTask.get({
        title: `${name} ${groupToken('tasks', owner)}`, category: TASK_CATEGORY_OF[owner], due: dates.today,
        visibility: level, owner: ids[owner], assignedTo: null,
        countdown: owner === 'member' && level === 'assignees' ? 1 : 0,
      }).id;
      if (level !== 'private') assignTask.run(id, ids[other]);
      remember('tasks', name, id, owner);
    }
    for (const level of ['all', 'private', 'assignees']) {
      const name = `event.${owner}.${level}`;
      const id = insertEvent.get({
        title: `${name} ${groupToken('events', owner)}`, start: dates.inTwoDays, visibility: level, owner: ids[owner],
        source: 'local', subscription: null, countdown: owner === 'member' && level === 'assignees' ? 1 : 0,
      }).id;
      if (level !== 'private') assignEvent.run(id, ids[other]);
      remember('events', name, id, owner);
    }
  }

  // Admin probe: only the LEGACY column names the member, no assignment row.
  // `task.admin.assignees.secondary-member` is not seeded: `task.admin.assignees`
  // already is "assignment row only, legacy column NULL" (see _meta).
  const legacy = 'task.admin.private.legacy-assigned-member';
  remember('tasks', legacy, insertTask.get({
    title: `${legacy} ${groupToken('tasks', 'admin')}`, category: TASK_CATEGORY_OF.admin, due: dates.today,
    visibility: 'private', owner: ids.admin, assignedTo: ids.member, countdown: 0,
  }).id, 'admin');

  // Two ICS subscriptions of the member: one unshared, one shared. The URL is a
  // closed loopback port: should the background sync reach it, it fails
  // locally and never leaves the machine.
  for (const shared of [0, 1]) {
    const subscription = db.prepare(`
      INSERT INTO ics_subscriptions (name, url, shared, created_by) VALUES (?, 'http://127.0.0.1:1/matrix.ics', ?, ?)
    `).run(`matrix ${shared ? 'shared' : 'unshared'}`, shared, ids.member).lastInsertRowid;
    const name = `event.member.ics-${shared ? 'shared' : 'unshared'}`;
    remember('events', name, insertEvent.get({
      title: `${name} ${groupToken('events', 'member')}`, start: dates.inTwoDays, visibility: 'all', owner: ids.member,
      source: 'ics', subscription, countdown: 0,
    }).id, 'member');
  }
}

/**
 * Notes, documents, budget entries, medications and health activities per owner.
 *
 * @param {Database} db
 * @param {Record<string, number>} ids
 * @param {SeedDates} dates
 * @param {(type: string, name: string, id: number, owner: string) => void} remember
 */
function seedOtherRows(db, ids, dates, remember) {
  // Budget visibility only applies in personal mode (shared mode: everyone sees everything).
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('budget_mode', 'personal')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  const insertNote = db.prepare(`
    INSERT INTO notes (title, content, pinned, visibility, created_by) VALUES (?, ?, 1, ?, ?) RETURNING id
  `);
  const insertDocument = db.prepare(`
    INSERT INTO family_documents (name, visibility, original_name, mime_type, file_size, content_data, created_by,
                                  expires_at, expiry_reminder_days)
    VALUES (?, ?, 'matrix.txt', 'text/plain', 0, '', ?, ?, ?) RETURNING id
  `);
  const grantDocument = db.prepare('INSERT INTO family_document_access (document_id, user_id) VALUES (?, ?)');
  const insertBudget = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES (?, -10, 'Sonstiges', ?, ?, ?, ?) RETURNING id
  `);
  const insertMedication = db.prepare(`
    INSERT INTO medications (user_id, name, active, visibility) VALUES (?, ?, 1, ?) RETURNING id
  `);
  // The search reads an activity by type and note; the name and the group
  // token stand in the note, the type is the same for every row.
  const insertActivity = db.prepare(`
    INSERT INTO health_activities (user_id, type, performed_at, note, visibility)
    VALUES (?, 'matrix', ?, ?, ?) RETURNING id
  `);
  for (const owner of OWNERS) {
    for (const level of ['all', 'private']) {
      const name = `note.${owner}.${level}`;
      remember('notes', name, insertNote.get(`${name} ${groupToken('notes', owner)}`, name, level, ids[owner]).id, owner);
    }
    for (const level of ['family', 'private', 'restricted']) {
      const name = `document.${owner}.${level}`;
      // An expiry only on the member's three and on the admin's private one:
      // the dashboard countdowns are capped at five, and this keeps every
      // viewer at or below the cap (see _meta).
      const expires = owner === 'member' || (owner === 'admin' && level === 'private');
      const id = insertDocument.get(`${name} ${groupToken('documents', owner)}`, level, ids[owner],
        expires ? dates.inTenDays : null, expires ? 30 : null).id;
      if (level === 'restricted') grantDocument.run(id, ids[OTHER_OF[owner]]);
      remember('documents', name, id, owner);
    }
    for (const level of ['private', 'shared', 'shared_amount']) {
      const name = `budget.${owner}.${level}`;
      remember('budget', name,
        insertBudget.get(`${name} ${groupToken('budget', owner)}`, dates.today, ids[owner], ids[owner], level).id, owner);
    }
    for (const level of ['private', 'family']) {
      const name = `medication.${owner}.${level}`;
      remember('medications', name,
        insertMedication.get(ids[owner], `${name} ${groupToken('medications', owner)}`, level).id, owner);
    }
    for (const level of ['private', 'family']) {
      const name = `activity.${owner}.${level}`;
      remember('activities', name,
        insertActivity.get(ids[owner], `${dates.today}T08:00`, `${name} ${groupToken('activities', owner)}`, level).id, owner);
    }
  }
  // Every other account owns one private medication, so the production dose
  // run can address it as an owner (test-visibility-matrix.js,
  // measureMedicationDelivery).
  for (const owner of MEDICATION_ONLY_OWNERS) {
    const name = `medication.${owner}.private`;
    remember('medications', name,
      insertMedication.get(ids[owner], `${name} ${groupToken('medications', owner)}`, 'private').id, owner);
  }
}

// --------------------------------------------------------------------------
// Row rules (phase 2, B8a): rows for the JavaScript row checks outside
// server/authorize. Seeded AFTER every read path has been measured: the ICS
// feed, the due reminders and the dashboard would read every new event and
// task row. They never enter `rows` or `seed_counts`.
// --------------------------------------------------------------------------

/** The two quick link levels (VISIBILITY_VALUES in server/routes/quick-links.js). */
export const QUICK_LINK_LEVELS = Object.freeze(['all', 'private']);
/** Task and event levels. */
export const ROW_LEVELS = Object.freeze(['all', 'private', 'assignees']);
/** Days a seeded series runs (FREQ=DAILY;COUNT=...). */
export const SERIES_DAYS = 3;
/** The account that owns the seeded Outlook auto-sync target. */
export const OUTLOOK_TARGET_OWNER = 'member';

/**
 * @typedef {{ name: string, id: number, owner: string, level: string }} RuleRow
 * @typedef {{
 *   quickLinks: RuleRow[],
 *   tasks: RuleRow[],
 *   chains: Array<{ cell: string, origin: RuleRow, followup: RuleRow }>,
 *   series: Array<RuleRow & { start: string, linkedChildId: number | null }>,
 *   seriesStart: string,
 * }} RuleSeed
 */

/**
 * Quick links, tasks for the write paths, task chains for the next due date,
 * local series with one linked occurrence each.
 *
 * @param {object} options
 * @param {Database} options.db
 * @param {Record<string, number>} options.ids
 * @param {SeedDates} options.dates
 * @param {(key: string, days: number) => string} options.shiftDateKey
 * @returns {RuleSeed}
 */
export function seedRowRules({ db, ids, dates, shiftDateKey }) {
  // Quick links: one per owner and level, position in seed order.
  const insertLink = db.prepare(`
    INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES (?, ?, ?, ?, ?) RETURNING id
  `);
  /** @type {RuleRow[]} */
  const quickLinks = [];
  for (const owner of OWNERS) {
    for (const level of QUICK_LINK_LEVELS) {
      const name = `quicklink.${owner}.${level}`;
      const id = insertLink.get(name, `https://example.org/${owner}/${level}`, level, ids[owner], quickLinks.length).id;
      quickLinks.push({ name, id: Number(id), owner, level });
    }
  }

  // Tasks for the write paths: no due date (no reminder, no dashboard block),
  // one checklist line so PATCH /:id/check can answer without writing.
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, category, priority, status, visibility, created_by)
    VALUES (?, '- [ ] mx item', 'household', 'none', 'open', ?, ?) RETURNING id
  `);
  const assignTask = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  /** @type {RuleRow[]} */
  const tasks = [];
  for (const owner of OWNERS) {
    for (const level of ROW_LEVELS) {
      const name = `wtask.${owner}.${level}`;
      const id = Number(insertTask.get(name, level, ids[owner]).id);
      if (level !== 'private') assignTask.run(id, ids[OTHER_OF[owner]]);
      tasks.push({ name, id, owner, level });
    }
  }
  // The display branch of PATCH /:id/status (tasks.js ~2287) sits behind
  // mayAccessTask: a display is never creator or assignee in the household, so
  // without this row the branch answers for no task. Not a realistic state.
  const displayName = 'wtask.admin.assignees.display';
  const displayTaskId = Number(insertTask.get(displayName, 'assignees', ids.admin).id);
  assignTask.run(displayTaskId, ids.display);
  tasks.push({ name: displayName, id: displayTaskId, owner: 'admin', level: 'assignees' });

  // Recurring chains for nextDueDateAfter (tasks.js ~1860): every origin is
  // shared, its already spawned followup exists. Ticking the origin off spawns
  // nothing (one followup per completion) and reports the followup's due date
  // only to whom the read check lets see it: the display arm reads
  // `visibility = 'all'` (~1864), people read mayAccessTask (~1865). Followups:
  // the admin's private row, a shared row, and the admin's `assignees` row
  // assigned to OTHER_OF.admin (the assignment branch of mayAccessTask).
  const insertChain = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, visibility, created_by, is_recurring,
                       recurrence_rule, recurrence_origin_id)
    VALUES (?, 'household', 'none', 'open', ?, ?, ?, 1, 'FREQ=WEEKLY', ?) RETURNING id
  `);
  /** @type {Array<{ cell: string, origin: RuleRow, followup: RuleRow }>} */
  const chains = [];
  for (const [cell, prefix, level] of [
    ['next_due_date', 'wtask.chain', 'private'],
    ['next_due_date_all', 'wtask.chain-all', 'all'],
    ['next_due_date_assignees', 'wtask.chain-assignees', 'assignees'],
  ]) {
    const originId = Number(insertChain.get(`${prefix}.origin`, dates.today, 'all', ids.admin, null).id);
    const followupId = Number(insertChain.get(`${prefix}.followup`, shiftDateKey(dates.today, 7), level, ids.admin, originId).id);
    if (level === 'assignees') assignTask.run(followupId, ids[OTHER_OF.admin]);
    chains.push({
      cell,
      origin: { name: `${prefix}.origin`, id: originId, owner: 'admin', level: 'all' },
      followup: { name: `${prefix}.followup`, id: followupId, owner: 'admin', level },
    });
  }

  // Local series: daily, all-day, far enough ahead to stay out of every
  // seeded window. `assignees` and `all` carry an event_assignments row for
  // OTHER_OF[owner], like the read seed.
  const seriesStart = shiftDateKey(dates.today, 40);
  const insertSeries = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, recurrence_rule)
    VALUES (?, ?, 1, ?, ?, 'local', 'FREQ=DAILY;COUNT=${SERIES_DAYS}') RETURNING id
  `);
  const assignEvent = db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)');
  // One linked occurrence per series (its second day), written in the shape
  // PUT /calendar/:id/occurrences/:day writes for an override of the title
  // (and the visibility): recurrence_parent_id, recurrence_id in format A,
  // overridden_fields, series_authored = 1, the series' assignment rows copied. Seeded directly and not through
  // the route, because that route runs isEligibleLocalSeries - the rule under
  // test - and a mutant of it must turn cells red, not stop the seed.
  // PUT/DELETE /calendar/:childId reach the series rule through
  // rejectLinkedOccurrenceResource (calendar/crud.js ~828).
  // The occurrence of a `private` or `assignees` series is shared (visibility
  // all, overridden): a viewer who may not see the series still gets the
  // occurrence in GET /calendar, the capability map loads the hidden master
  // itself, and canOverrideOccurrence then hangs on actorCanSeeSeries alone -
  // the rule becomes visible in both directions.
  const insertLinked = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source,
                                 recurrence_parent_id, recurrence_id, overridden_fields, series_authored)
    VALUES (?, ?, 1, ?, ?, 'local', ?, ?, ?, 1) RETURNING id
  `);
  /** @type {Array<RuleRow & { start: string, linkedChildId: number | null }>} */
  const series = [];
  const linkedDay = shiftDateKey(seriesStart, 1);
  for (const owner of OWNERS) {
    for (const level of ROW_LEVELS) {
      const name = `series.${owner}.${level}`;
      const id = Number(insertSeries.get(name, seriesStart, level, ids[owner]).id);
      if (level !== 'private') assignEvent.run(id, ids[OTHER_OF[owner]]);
      const fields = level === 'all' ? ['title'] : ['title', 'visibility'];
      const childId = Number(insertLinked.get(`${name} linked`, linkedDay, 'all', ids[owner], id, linkedDay,
        JSON.stringify(fields)).id);
      // The route copies the series' assignment rows onto the occurrence.
      if (level !== 'private') assignEvent.run(childId, ids[OTHER_OF[owner]]);
      series.push({ name, id, owner, level, start: seriesStart, linkedChildId: childId });
    }
  }
  // Two series WITHOUT a linked occurrence: once the Outlook target makes them
  // local but not eligible, canDetachOccurrence (~686) is true for whom
  // actorCanSeeSeries lets through - with a linked child it is false for
  // everyone (linkedParents). Both are seen by the target owner (member):
  // one through the assignment, one as its creator.
  for (const [owner, level] of [['admin', 'assignees'], ['member', 'private']]) {
    const name = `series.${owner}.${level}.unlinked`;
    const id = Number(insertSeries.get(name, seriesStart, level, ids[owner]).id);
    if (level === 'assignees') assignEvent.run(id, ids[OTHER_OF[owner]]);
    series.push({ name, id, owner, level, start: seriesStart, linkedChildId: null });
  }
  return { quickLinks, tasks, chains, series, seriesStart };
}

/**
 * A writable Outlook auto-sync target owned by OUTLOOK_TARGET_OWNER. No token
 * is real: the sync tick returns before any request while MS_CLIENT_ID,
 * MS_CLIENT_SECRET and MS_REDIRECT_URI are unset (outlook-calendar.js,
 * runOutlookSync), and the suite pins them empty.
 *
 * @param {Database} db
 * @param {Record<string, number>} ids
 */
export function seedOutlookTarget(db, ids) {
  const accountId = db.prepare(`
    INSERT INTO outlook_accounts (name, access_token, refresh_token, auto_sync_calendar_id, owner_user_id)
    VALUES ('matrix outlook', 'not-a-token', 'not-a-token', 'mx-outlook-calendar', ?) RETURNING id
  `).get(ids[OUTLOOK_TARGET_OWNER]).id;
  db.prepare(`
    INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'mx-outlook-calendar', 'matrix', 1, 1)
  `).run(accountId);
}

/**
 * Builds the household.
 *
 * @param {object} options
 * @param {Database} options.db               the server's own connection
 * @param {HttpFn} options.http               one request with its own client address
 * @param {SeedDates} options.dates
 * @param {string[]} options.permissionModules the 15 permission module keys
 * @param {string[]} options.scopeModules      every token scope module key
 * @param {string} options.displayCookie       name of the display cookie
 * @returns {Promise<Seed>}
 */
export async function seedMatrix({ db, http, dates, permissionModules, scopeModules, displayCookie }) {
  let setupIp = 0;
  // Each setup request from its own address: the setup is no measured cell
  // and must never eat into the budget of one.
  /** @type {(method: string, path: string, options?: { headers?: Record<string, string>, body?: unknown }) => Promise<HttpResult>} */
  const call = (method, path, options) => http(`10.9.250.${(setupIp++ % 250) + 1}`, method, path, options);

  const accounts = await seedAccounts({ db, call, permissionModules, scopeModules, displayCookie });
  const { ids } = accounts;

  /** @type {Record<string, SeedRow[]>} */
  const rows = Object.fromEntries(TYPES.map((type) => [type, []]));
  /** @type {(type: string, name: string, id: number, owner: string) => void} */
  const remember = (type, name, id, owner) => { rows[type].push({ name, id: Number(id), owner }); };
  seedTasksAndEvents(db, ids, dates, remember);
  seedOtherRows(db, ids, dates, remember);

  // Due reminders. `reminders.created_by` is the caller of /reminders/pending.
  // Every account that can call it gets one due reminder per task, event and
  // document row, visible or not, so the cell shows which TARGETS pass the
  // target filter.
  const insertReminder = db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)
  `);
  for (const account of REMINDER_ACCOUNTS) {
    for (const [type, entityType] of [['tasks', 'task'], ['events', 'event'], ['documents', 'document_expiry']]) {
      for (const row of rows[type]) insertReminder.run(entityType, row.id, dates.dueInstant, ids[account]);
    }
  }

  return {
    ids, rows,
    sessions: accounts.sessions,
    tokens: accounts.tokens,
    displayToken: accounts.displayToken,
    feedTokens: accounts.feedTokens,
    facts: { reminderAccounts: REMINDER_ACCOUNTS, tokenShapes: accounts.tokenFacts },
  };
}
