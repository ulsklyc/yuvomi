/**
 * Module: Seed extension for the overview golden master (test/test-overview-golden.js)
 * Purpose: the visibility matrix seed (test/visibility-matrix-seed.js) fills
 *          tasks, events, notes, documents, budget, medications and health
 *          activities. The dashboard answer has more blocks than that: meals,
 *          shopping, birthdays, shared expenses, rewards, doses, fasting,
 *          nutrition, the housekeeper, waste, shifts, pantry and quick links.
 *          This file adds named rows so that
 *            - every block of `GET /dashboard` carries data for at least one role,
 *            - every capped list of the dashboard and every capped hit type of
 *              `GET /search` has MORE visible rows than its cap (cap + 2) for at
 *              least one role, so the cap and the order that decides which
 *              rows fall out are both part of the master,
 *            - the order of every capped list is decided without a tie: names,
 *              dates, amounts and times are pairwise distinct where an
 *              ORDER BY has no unique tiebreak,
 *            - every WHERE term, comparison, ORDER BY term and LEFT JOIN of
 *              the dashboard and search queries decides at least one answer
 *              (seedConditions() at the end; survivors with their reason in
 *              the PR of step D3).
 *
 * Caps covered here (cap + 2 rows for the admin unless named otherwise):
 *   dashboard  pinnedNotes 5, shopping items per list 6, shoppingLists 3,
 *              shoppingTile 3, birthdays 8, budget topExpenses 5, rewards
 *              recent 3 (child), wallTasks open 6 (child) and done 6 (member),
 *              familyEvents per member 6 (child), `?shopping_list=` and
 *              `?notes_category=` 50 values each (see `optionsQuery`)
 *   search     5 per hit type for `goldkiwi`; the infix vocabulary cap of 50
 *              terms for `quokka` (49 filler terms sort before the one term
 *              that finds the second row)
 *
 * It runs AFTER `seedMatrix()` on the same database and never touches a row
 * the matrix seeded, apart from schedules and logs that hang off the matrix
 * medications. The matrix suite has its own database; its data file
 * (`test/visibility-matrix.expected.json`) is not read or written here.
 *
 * Everything that is not a person comes straight into the database, as in
 * the matrix seed: the golden master is about what the readers return, not
 * about how a row was created. The one person (the housekeeper) comes through
 * `POST /auth/users`, like every other account of the matrix.
 */
import assert from 'node:assert/strict';

/** One word in seven rows of every hit type of the search. */
export const GOLDEN_TOKEN = 'goldkiwi';
/** The infix probe: 50 vocabulary terms contain it, the 50th finds its own row. */
export const INFIX_TOKEN = 'quokka';

/** Seven distinct suffixes: cap 5 plus 2. */
const SEVEN = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g']);

/**
 * @typedef {{ prepare: (sql: string) => any }} Database
 * @typedef {{ status: number, body: any, headers: Headers }} HttpResult
 */

/**
 * @param {object} options
 * @param {Database} options.db
 * @param {(method: string, path: string, options?: { headers?: Record<string, string>, body?: unknown }) => Promise<HttpResult>} options.call
 * @param {Record<string, string>} options.adminHeaders
 * @param {Record<string, number>} options.ids        account ids of the matrix seed
 * @param {Record<string, Array<{ name: string, id: number }>>} options.rows  matrix rows by type
 * @param {(key: string, days: number) => string} options.shift  shiftDateKey
 * @param {{ today: string, yesterday: string, monthStart: string, inThreeDays: string, nowIso: string, oneHourAgoIso: string }} options.dates
 * @returns {Promise<{ helperId: number, optionsQuery: string }>}
 */
export async function seedOverviewExtras({ db, call, adminHeaders, ids, rows, shift, dates }) {
  // The housekeeper: an account of its own, through the real route.
  const helper = await call('POST', '/api/v1/auth/users', {
    headers: adminHeaders,
    body: { username: 'helper', display_name: 'helper', password: 'helper-pass-123', family_role: 'other' },
  });
  assert.equal(helper.status, 201, `create helper: ${JSON.stringify(helper.body)}`);
  const helperId = helper.body.user.id;

  // Inventory and waste ship switched off; the golden master wants every hit type.
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', '[]')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();

  // ---- Tasks ---------------------------------------------------------------
  // One overdue task, and seven done today for the member (wall done cap 6).
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, visibility, created_by)
    VALUES (?, 'household', ?, ?, ?, 'all', ?) RETURNING id
  `);
  const assignTask = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  const overdue = insertTask.get('golden.task.overdue', 'urgent', 'open', dates.yesterday, ids.admin).id;
  assignTask.run(overdue, ids.child);
  const completion = db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)');
  SEVEN.forEach((s, i) => {
    const done = insertTask.get(`golden.task.done-today-${s}`, 'urgent', 'done', dates.today, ids.admin).id;
    assignTask.run(done, ids.member);
    completion.run(done, done, ids.member, new Date(Date.parse(dates.oneHourAgoIso) - i * 60_000).toISOString());
  });
  // Seven open `goldkiwi` tasks due today for the child: the search cap and
  // the open column of the wall (cap 6). Order: due date, priority, id.
  for (const s of SEVEN) assignTask.run(insertTask.get(`${GOLDEN_TOKEN} task ${s}`, 'low', 'open', dates.today, ids.admin).id, ids.child);

  // ---- Events --------------------------------------------------------------
  // Seven `goldkiwi` events assigned to the child, a month out, one day apart:
  // the search cap and the family card cap of six per member.
  const insertEvent = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, countdown)
    VALUES (?, ?, 1, 'all', ?, 'local', 0) RETURNING id
  `);
  SEVEN.forEach((s, i) => {
    const event = insertEvent.get(`${GOLDEN_TOKEN} event ${s}`, shift(dates.today, 30 + i), ids.admin).id;
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(event, ids.child);
  });

  // ---- Notes ---------------------------------------------------------------
  // First an unpinned note that carries 49 household categories: only the
  // `notes_category` read of `optionsQuery` shows it (pinned notes sort first,
  // and it is the oldest). Then seven pinned `goldkiwi` notes for everyone.
  const insertNote = db.prepare('INSERT INTO notes (title, content, pinned, visibility, created_by) VALUES (?, ?, ?, \'all\', ?) RETURNING id');
  const tagged = insertNote.get('golden.note.tagged', 'golden note with 49 categories', 0, ids.admin).id;
  const insertCategory = db.prepare(`
    INSERT INTO note_categories (name, name_key, scope, created_by, sort_order) VALUES (?, ?, 'household', ?, ?) RETURNING id
  `);
  /** @type {number[]} */
  const categoryIds = [];
  for (let i = 1; i <= 51; i += 1) {
    const name = `golden.category.${String(i).padStart(2, '0')}`;
    categoryIds.push(insertCategory.get(name, name, ids.admin, i).id);
  }
  const assignCategory = db.prepare('INSERT INTO note_category_assignments (note_id, category_id, assigned_by) VALUES (?, ?, ?)');
  for (const id of categoryIds.slice(0, 49)) assignCategory.run(tagged, id, ids.admin);
  const goldenNotes = SEVEN.map((s) => insertNote.get(`${GOLDEN_TOKEN} note ${s}`, `golden note ${s}`, 1, ids.admin).id);
  // Category 50 hangs on ANOTHER note: every selected category is in use, so
  // only the correlation `nca.note_id = n.id` (and the join on the category
  // id) keeps the notes part of `optionsQuery` empty.
  assignCategory.run(goldenNotes[0], categoryIds[49], ids.admin);

  // ---- Meals and recipes ---------------------------------------------------
  const insertRecipe = db.prepare('INSERT INTO recipes (title, notes, created_by) VALUES (?, ?, ?) RETURNING id');
  const recipe = insertRecipe.get(`${GOLDEN_TOKEN} recipe a`, 'golden recipe', ids.admin).id;
  for (const s of SEVEN.slice(1)) insertRecipe.get(`${GOLDEN_TOKEN} recipe ${s}`, 'golden recipe', ids.admin);
  db.prepare(`
    INSERT INTO meals (date, meal_type, title, notes, recipe_id, cook_user_id, created_by)
    VALUES (?, 'lunch', 'golden.meal.lunch', 'golden meal note', ?, ?, ?)
  `).run(dates.today, recipe, ids.member, ids.admin);

  // ---- Shopping ------------------------------------------------------------
  // 51 lists (the `shopping_list` cap of 50 needs more ids than that); the
  // first five carry open items (shoppingLists and shoppingTile cap 3), the
  // fifth (newest of them, so it is always shown) eight open and one checked
  // (items per list cap 6).
  const insertList = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?) RETURNING id');
  const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, notes, is_checked) VALUES (?, ?, ?, ?, ?)');
  /** @type {number[]} */
  const listIds = [];
  for (let i = 1; i <= 51; i += 1) listIds.push(insertList.get(`golden.list.${String(i).padStart(2, '0')}`, ids.admin).id);
  for (const s of SEVEN) insertItem.run(listIds[4], `${GOLDEN_TOKEN} item ${s}`, '1', null, 0);
  insertItem.run(listIds[4], 'golden.item.bread', '1', null, 0);
  insertItem.run(listIds[4], 'golden.item.done', '1', null, 1);
  for (let i = 0; i < 4; i += 1) insertItem.run(listIds[i], `golden.item.list-${i + 1}`, '1', null, 0);
  // The infix probe: one item whose note holds 49 filler terms that sort
  // before `zquokka99` (same length, earlier letter), and one item named by
  // that 50th term. Both live on the last, otherwise empty list.
  const fillers = Array.from({ length: 49 }, (_, i) => `a${INFIX_TOKEN}${String(i + 1).padStart(2, '0')}`);
  insertItem.run(listIds[50], 'golden.item.infix-fillers', '1', fillers.join(' '), 1);
  insertItem.run(listIds[50], `z${INFIX_TOKEN}99`, '1', null, 1);

  // ---- Birthdays -----------------------------------------------------------
  // Ten birthdays (cap 8), every one on its own day; the first is today.
  const insertBirthday = db.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)');
  SEVEN.forEach((s, i) => insertBirthday.run(`${GOLDEN_TOKEN} birthday ${s}`, `1950${shift(dates.today, i * 9).slice(4)}`, ids.admin));
  insertBirthday.run('golden.birthday.later', '1985-12-24', ids.admin);
  insertBirthday.run('golden.birthday.autumn', '1990-10-03', ids.admin);
  insertBirthday.run('golden.birthday.summer', '1992-07-14', ids.admin);

  // ---- Contacts, waste, pantry, inventory: seven searchable rows each ------
  const insertContact = db.prepare('INSERT INTO contacts (name, notes) VALUES (?, ?)');
  for (const s of SEVEN) insertContact.run(`${GOLDEN_TOKEN} contact ${s}`, 'golden contact');
  const insertWaste = db.prepare("INSERT INTO waste_types (name, icon, color, created_by) VALUES (?, 'trash-2', '#6B7280', ?) RETURNING id");
  const wasteType = insertWaste.get(`${GOLDEN_TOKEN} bin a`, ids.admin).id;
  for (const s of SEVEN.slice(1)) insertWaste.get(`${GOLDEN_TOKEN} bin ${s}`, ids.admin);
  db.prepare('INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, ?, ?)').run(wasteType, dates.today, ids.admin);
  const insertPantry = db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, expires_on, created_by) VALUES (?, 1, 'pcs', ?, ?)
  `);
  insertPantry.run(`${GOLDEN_TOKEN} pantry a`, dates.today, ids.admin);
  for (const s of SEVEN.slice(1)) insertPantry.run(`${GOLDEN_TOKEN} pantry ${s}`, null, ids.admin);
  insertPantry.run('golden.pantry.soon', dates.inThreeDays, ids.admin);
  const insertInventory = db.prepare("INSERT INTO inventory_items (name, brand, status, created_by) VALUES (?, 'golden brand', 'active', ?)");
  for (const s of SEVEN) insertInventory.run(`${GOLDEN_TOKEN} inventory ${s}`, ids.admin);

  // ---- Documents: seven family documents -----------------------------------
  const insertDocument = db.prepare(`
    INSERT INTO family_documents (name, visibility, original_name, mime_type, file_size, content_data, created_by)
    VALUES (?, 'family', 'golden.txt', 'text/plain', 0, '', ?)
  `);
  for (const s of SEVEN) insertDocument.run(`${GOLDEN_TOKEN} document ${s}`, ids.admin);

  seedMoney({ db, ids, shift, dates });

  seedHealth({ db, ids, rows, dates });

  // ---- Housekeeping --------------------------------------------------------
  // The helper is in the house since an hour; an earlier visit this month is
  // finished and unpaid.
  const worker = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40) RETURNING id').get(helperId).id;
  const insertVisit = db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, worker_id, created_by) VALUES (?, ?, 40, ?, ?)
  `);
  insertVisit.run(`${dates.monthStart}T08:00:00.000Z`, `${dates.monthStart}T12:00:00.000Z`, worker, ids.admin);
  insertVisit.run(dates.oneHourAgoIso, null, worker, ids.admin);

  // Shifts: the admin works the early shift today.
  const shiftType = db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, icon, created_by)
    VALUES ('golden.shift.early', 'E', '06:00', '14:00', '#0EA5E9', 'sunrise', ?) RETURNING id
  `).get(ids.admin).id;
  db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)').run(ids.admin, dates.today, shiftType);

  // Quick links: one for everyone, one private of the member.
  const insertLink = db.prepare('INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES (?, ?, ?, ?, ?)');
  insertLink.run('golden.link.all', 'https://example.invalid/all', 'all', ids.admin, 0);
  insertLink.run('golden.link.private', 'https://example.invalid/private', 'private', ids.member, 1);

  // ---- Availability ---------------------------------------------------------
  // The member has an active status (#1591), so the dashboard's
  // familyStatuses block has data to show. The route's own expiry check
  // runs against SQLite's real clock (strftime('now')), which Node's
  // mock.timers never touches - expires_at has to come from that same
  // clock, not from a JS Date tied to the test's frozen FROZEN_NOW.
  // +10 days, not +1 hour: settleSqliteClock() (below) rewrites every
  // stamp within +-2 days of the real 'now' back onto the frozen
  // timeline, which would read as expired again by the time the block
  // is queried; past that window it is left untouched.
  db.prepare(
    "INSERT INTO user_availability (user_id, state, note, expires_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+10 days'))",
  ).run(ids.member, 'busy', 'golden availability note');

  seedConditions({ db, ids, rows, shift, dates });

  // The widget options read: all 51 lists (the cap keeps 50, the tile shows
  // three of the five with open items, `listCount` names the cap) and all 51
  // categories (the cap keeps 1..50; category 50 is on `goldkiwi note a`, not
  // on the tagged note, so the notes part is empty, and one value fewer would
  // show the tagged note).
  const optionsQuery = [
    ...listIds.map((id) => `shopping_list=${id}`),
    ...categoryIds.map((id) => `notes_category=${id}`),
  ].join('&');
  return { helperId, optionsQuery };
}

/**
 * Budget, shared expenses and rewards (see the caps in the file header).
 * @param {{ db: Database, ids: Record<string, number>, shift: (key: string, days: number) => string,
 *           dates: { today: string, monthStart: string, nowIso: string, oneHourAgoIso: string } }} options
 */
function seedMoney({ db, ids, shift, dates }) {
  // ---- Budget --------------------------------------------------------------
  // An income, a savings goal, and seven `goldkiwi` expenses of the admin in
  // seven categories with seven distinct amounts (topExpenses cap 5, ordered
  // by amount only; the matrix rows sum to 30 in `Sonstiges`).
  const insertBudget = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES (?, ?, ?, ?, ?, ?, 'private')
  `);
  insertBudget.run('golden.budget.income', 250, 'Sonstiges', dates.monthStart, ids.admin, ids.admin);
  const categories = ['food', 'housing', 'leisure', 'education', 'transport', 'shopping_clothing', 'personal_health'];
  SEVEN.forEach((s, i) => insertBudget.run(`${GOLDEN_TOKEN} budget ${s}`, -(15 + i * 10), categories[i],
    shift(dates.monthStart, i), ids.admin, ids.admin));
  // A plain category plan BEFORE the savings goal: the savings read picks its
  // row by category, not by being the first row of the table.
  db.prepare("INSERT INTO budget_plans (category, amount, created_by) VALUES ('food', 100, ?)").run(String(ids.admin));
  db.prepare("INSERT INTO budget_plans (category, amount, created_by) VALUES ('__savings__', 200, ?)").run(String(ids.admin));

  // ---- Shared expenses: the admin paid 30.00 for admin, member and child ----
  const group = db.prepare("INSERT INTO expense_groups (name, type, created_by) VALUES ('golden.group', 'household', ?) RETURNING id")
    .get(ids.admin).id;
  const insertMember = db.prepare('INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)');
  insertMember.run(group, ids.admin, 'owner', ids.admin);
  insertMember.run(group, ids.member, 'admin', ids.admin);
  insertMember.run(group, ids.child, 'guest', ids.admin);
  const expense = db.prepare(`
    INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency,
                          payer_id, category, split_method, expense_date, created_by)
    VALUES (?, 'golden.expense.dinner', 3000, 'EUR', 3000, 'EUR', ?, 'general', 'equal', ?, ?) RETURNING id
  `).get(group, ids.admin, dates.today, ids.admin).id;
  const insertSplit = db.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, 1000, \'EUR\')');
  const insertLedger = db.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', ?, ?, ?, ?, 'EUR', 'golden.expense.dinner', ?)
  `);
  insertLedger.run(group, expense, ids.admin, null, 3000, ids.admin);
  for (const account of ['admin', 'member', 'child']) {
    insertSplit.run(expense, ids[account]);
    insertLedger.run(group, expense, ids[account], ids.admin, -1000, ids.admin);
  }

  // ---- Rewards -------------------------------------------------------------
  // Member and child collect; the child earned five bonuses an hour apart
  // (recent cap 3) and asks for the reward.
  const insertParticipant = db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)');
  insertParticipant.run(ids.member);
  insertParticipant.run(ids.child);
  const reward = db.prepare(`
    INSERT INTO reward_catalog (name, cost, icon, description, is_active, sort_order, created_by)
    VALUES ('golden.reward.ice-cream', 30, 'ice-cream', 'golden reward', 1, 0, ?) RETURNING id
  `).get(ids.admin).id;
  const insertBonus = db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, created_at) VALUES (?, ?, 'bonus', ?, ?, ?)
  `);
  for (let i = 0; i < 5; i += 1) {
    insertBonus.run(ids.child, 10 + i, `golden.bonus.${i + 1}`, ids.admin,
      new Date(Date.parse(dates.oneHourAgoIso) - i * 60 * 60 * 1000).toISOString());
  }
  db.prepare(`
    INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, status, requested_by, created_at)
    VALUES (?, ?, 'golden.reward.ice-cream', 'ice-cream', 30, 'pending', ?, ?)
  `).run(ids.child, reward, ids.child, dates.nowIso);
}

/**
 * Doses, `goldkiwi` medications and activities, fasting and nutrition.
 * @param {{ db: Database, ids: Record<string, number>, rows: Record<string, Array<{ name: string, id: number }>>,
 *           dates: { today: string, yesterday: string, monthStart: string, oneHourAgoIso: string } }} options
 */
function seedHealth({ db, ids, rows, dates }) {
  // ---- Health --------------------------------------------------------------
  // Doses on the matrix medications: the admin took the morning dose, the
  // evening one is next; the member skipped one; the child runs low on stock.
  const medId = (/** @type {string} */ name) => {
    const row = rows.medications.find((r) => r.name === name);
    assert.ok(row, `matrix medication ${name}`);
    return row.id;
  };
  const insertSchedule = db.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, active)
    VALUES (?, ?, 127, 1, ?, 1) RETURNING id
  `);
  const insertLog = db.prepare(`
    INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty) VALUES (?, ?, ?, ?, ?, 1)
  `);
  const adminMed = medId('medication.admin.private');
  const morning = insertSchedule.get(adminMed, '08:00', dates.monthStart).id;
  insertSchedule.get(adminMed, '20:00', dates.monthStart);
  insertLog.run(adminMed, morning, `${dates.today}T08:00`, 'taken', `${dates.today}T08:05`);
  const memberMed = medId('medication.member.private');
  const memberSchedule = insertSchedule.get(memberMed, '07:00', dates.monthStart).id;
  insertLog.run(memberMed, memberSchedule, `${dates.today}T07:00`, 'skipped', null);
  db.prepare('UPDATE medications SET stock_qty = 2, refill_threshold = 5 WHERE id = ?').run(medId('medication.child.private'));
  // Seven `goldkiwi` medications and activities of the admin (search cap 5;
  // medications order by name, activities by time).
  const insertMed = db.prepare("INSERT INTO medications (user_id, name, active, visibility) VALUES (?, ?, 1, 'private')");
  for (const s of SEVEN) insertMed.run(ids.admin, `${GOLDEN_TOKEN} medication ${s}`);
  const insertActivity = db.prepare(`
    INSERT INTO health_activities (user_id, type, performed_at, note, visibility) VALUES (?, 'golden', ?, ?, 'private')
  `);
  SEVEN.forEach((s, i) => insertActivity.run(ids.admin, `${dates.yesterday}T0${i + 1}:00`, `${GOLDEN_TOKEN} activity ${s}`));

  // Fasting: the admin fasts right now, the member finished one yesterday.
  db.prepare(`
    INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
    VALUES (?, ?, NULL, 'Europe/Berlin', 960, 'private', ?, ?)
  `).run(ids.admin, dates.oneHourAgoIso, ids.admin, ids.admin);
  db.prepare(`
    INSERT INTO health_fasts (user_id, start_at, end_at, start_tzid, goal_minutes, visibility, created_by, updated_by)
    VALUES (?, ?, ?, 'Europe/Berlin', 960, 'family', ?, ?)
  `).run(ids.member, `${dates.yesterday}T00:00:00.000Z`, `${dates.yesterday}T16:00:00.000Z`, ids.member, ids.member);

  // Nutrition: the admin has a target and ate breakfast today.
  db.prepare('INSERT INTO health_nutrition_targets (user_id, energy_kcal, protein_g) VALUES (?, 2000, 60)').run(ids.admin);
  db.prepare(`
    INSERT INTO health_nutrition_entries (user_id, consumed_at, meal_type, title, energy_kcal, protein_g, visibility, created_by)
    VALUES (?, ?, 'breakfast', 'golden.nutrition.oats', 350, 12, 'private', ?)
  `).run(ids.admin, `${dates.today}T07:30`, ids.admin);
}

// ===========================================================================
// CONDITIONS. Everything below runs after every row above, so no id above
// moves. Each row is there for ONE condition of a dashboard or search query:
// the condition alone keeps it out (or puts it in, or decides its place), so
// dropping or flipping that condition changes an answer. Mutation sweep in
// the PR (step D3): every `AND`/`OR` term, comparison, ORDER BY term and
// LEFT JOIN of server/routes/dashboard.js, server/services/tasks-slices.ts and
// server/services/search.js mutated one at a time; the survivors that remain
// are listed there with their reason. Names avoid the search words of the
// suite (`private`, the `mx*` group tokens, `quokka`) unless a row is meant
// to be found, and `goldkiwi` rows are meant to be found.
// ===========================================================================

/**
 * @param {{ db: Database, ids: Record<string, number>, rows: Record<string, Array<{ name: string, id: number }>>,
 *           shift: (key: string, days: number) => string,
 *           dates: { today: string, yesterday: string, monthStart: string, nowIso: string, oneHourAgoIso: string } }} options
 */
function seedConditions(options) {
  seedConditionTasks(options);
  seedConditionNotesMealsShopping(options);
  seedConditionMoney(options);
  seedConditionRewards(options);
  seedConditionHealth(options);
  seedConditionSearch(options);
}

/**
 * Tasks (services/tasks-slices.ts and the task hits of the search).
 * @param {{ db: Database, ids: Record<string, number>, shift: (key: string, days: number) => string,
 *           dates: { today: string, yesterday: string, oneHourAgoIso: string } }} options
 */
function seedConditionTasks({ db, ids, shift, dates }) {
  const insert = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, due_time, visibility, created_by,
                       assigned_to, start_date, archived_at, parent_task_id)
    VALUES (@title, 'household', @priority, @status, @due, @time, @visibility, @owner,
            @assignedTo, @start, @archived, @parent) RETURNING id
  `);
  const task = (/** @type {Record<string, unknown>} */ row) => insert.get({
    priority: 'low', status: 'open', due: dates.today, time: null, visibility: 'all', owner: ids.admin,
    assignedTo: null, start: null, archived: null, parent: null, ...row,
  }).id;
  const assign = db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  const complete = db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)');
  const archivedAt = `${dates.yesterday}T08:00:00.000Z`;

  // Three assignees, the legacy column on the child, the rows in the order
  // member, admin, child: `assigned_users` is child (the legacy one first),
  // then member before admin (row order, not user id). Due two days ago and
  // low: first of the urgent list, of the child's wall and of the search,
  // ahead of the urgent task due yesterday only by its date.
  const assigned = task({ title: `${GOLDEN_TOKEN} task assigned three`, due: shift(dates.today, -2), assignedTo: ids.child });
  for (const account of ['member', 'admin', 'child']) assign.run(assigned, ids[account]);
  // A subtask of it, due even earlier: only `parent_task_id IS NULL` hides it.
  assign.run(task({ title: `${GOLDEN_TOKEN} task subtask`, due: shift(dates.today, -4), parent: assigned }), ids.child);
  // Archived, open, overdue: only `archived_at IS NULL` hides it.
  assign.run(task({ title: `${GOLDEN_TOKEN} task archived`, priority: 'urgent', due: shift(dates.today, -3),
    archived: archivedAt }), ids.child);
  // Archived and done today: only `archived_at IS NULL` keeps it out of the done count.
  assign.run(task({ title: 'golden.task.archived-done', status: 'done', archived: archivedAt }), ids.member);
  // Done, due yesterday, ticked today: on the member's wall only through the
  // completion window; out of the overdue count only through `status`.
  const doneYesterday = task({ title: `${GOLDEN_TOKEN} task done yesterday`, priority: 'urgent', status: 'done', due: dates.yesterday });
  assign.run(doneYesterday, ids.member);
  complete.run(doneYesterday, doneYesterday, ids.member, new Date(Date.parse(dates.oneHourAgoIso) - 30 * 60_000).toISOString());
  // Done, due today, never ticked through a completion: on the wall only
  // through `due_date = @today`.
  assign.run(task({ title: 'golden.task.done-unlogged', status: 'done' }), ids.member);
  // Starts tomorrow: only the task scope hides them (one open and overdue, one done today).
  assign.run(task({ title: 'golden.task.starts-later', due: dates.yesterday, start: shift(dates.today, 1) }), ids.child);
  assign.run(task({ title: 'golden.task.starts-later-done', status: 'done', start: shift(dates.today, 1) }), ids.member);
  // The member's own tasks: only the row rule hides them from the admin.
  assign.run(task({ title: 'golden.task.member-own-overdue', priority: 'medium', due: dates.yesterday,
    visibility: 'private', owner: ids.member }), ids.member);
  task({ title: 'golden.task.member-own-done', status: 'done', visibility: 'private', owner: ids.member });
  // Due tomorrow: neither "due today" nor the wall.
  assign.run(task({ title: 'golden.task.tomorrow', due: shift(dates.today, 1) }), ids.child);
  // No due date: last in the urgent list, only through `__due_sort IS NULL`.
  task({ title: 'golden.task.undated', due: null });
  // Two timed tasks today, the later one first: their times decide the order
  // (09:00 is already overdue at 10:30, 11:00 is not).
  assign.run(task({ title: 'golden.task.at-eleven', time: '11:00' }), ids.child);
  assign.run(task({ title: 'golden.task.at-nine', time: '09:00' }), ids.child);
  // Urgent, today, untimed, the newest: its priority alone puts it ahead.
  assign.run(task({ title: 'golden.task.urgent-today', priority: 'urgent' }), ids.child);
}

/**
 * Notes, meals and shopping blocks of the dashboard.
 * @param {{ db: Database, ids: Record<string, number> }} options
 */
function seedConditionNotesMealsShopping({ db, ids }) {
  const insertNote = db.prepare(`
    INSERT INTO notes (title, content, pinned, visibility, created_by, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
  `);
  // The newest note is not pinned: only `pinned DESC` keeps it behind the pins.
  insertNote.run(`${GOLDEN_TOKEN} note unpinned`, 'golden note unpinned', 0, 'all', ids.admin, null);
  // The member's own pinned note: only the row rule hides it from the admin.
  insertNote.run('golden.note.member-only', 'golden note of the member', 1, 'private', ids.member, null);
  // Pinned, newest id, oldest change: only `updated_at DESC` puts it last.
  insertNote.run('golden.note.stale', 'golden stale note', 1, 'all', ids.admin, '2026-01-15T10:00:00Z');

  // Breakfast without a recipe, written after the lunch: the LEFT JOIN keeps
  // it, the meal type order puts it first.
  db.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by) VALUES (
      (SELECT date FROM meals WHERE title = 'golden.meal.lunch'), 'breakfast', 'golden.meal.breakfast', ?)
  `).run(ids.admin);

  // A checked item on list 4 (shown in the shopping block): only
  // `is_checked = 0` keeps it out of the item preview.
  db.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, is_checked)
    VALUES ((SELECT id FROM shopping_lists WHERE name = 'golden.list.04'), 'golden.item.list-4-done', '1', 1)
  `).run();
}

/**
 * Budget totals, top expenses, plans and the currency of the split balance.
 * @param {{ db: Database, ids: Record<string, number>, shift: (key: string, days: number) => string,
 *           dates: { today: string, monthStart: string } }} options
 */
function seedConditionMoney({ db, ids, shift, dates }) {
  const insert = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility, is_pending)
    VALUES (?, ?, ?, ?, ?, ?, 'private', ?) RETURNING id
  `);
  const member = (/** @type {string} */ title, /** @type {number} */ amount, /** @type {string} */ category, pending = 0) =>
    insert.get(title, amount, category, shift(dates.monthStart, 1), ids.member, ids.member, pending).id;
  // The member's month: one zero expense (only `amount < 0` keeps `food` out
  // of the top list), one pending, one transfer pair.
  member('golden.budget.zero', 0, 'food');
  member('golden.budget.pending', -7, 'transport', 1);
  const out = member('golden.budget.transfer-out', -20, 'leisure');
  const back = member('golden.budget.transfer-in', 20, 'leisure');
  const link = db.prepare('UPDATE budget_entries SET transfer_entry_id = ? WHERE id = ?');
  link.run(back, out);
  link.run(out, back);

  // A second debt in CHF: the household currency (EUR, no `currency` row)
  // sorts first, against the alphabet - read only through `key = 'currency'`.
  const group = db.prepare("SELECT id FROM expense_groups WHERE name = 'golden.group'").get().id;
  const expense = db.prepare(`
    INSERT INTO expenses (group_id, title, amount_minor, currency, converted_amount_minor, converted_currency,
                          payer_id, category, split_method, expense_date, created_by)
    VALUES (?, 'golden.expense.ticket', 2000, 'CHF', 2000, 'CHF', ?, 'general', 'equal', ?, ?) RETURNING id
  `).get(group, ids.admin, dates.today, ids.admin).id;
  const ledger = db.prepare(`
    INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
    VALUES (?, 'expense', ?, ?, ?, ?, 'CHF', 'golden.expense.ticket', ?)
  `);
  ledger.run(group, expense, ids.admin, null, 2000, ids.admin);
  for (const account of ['admin', 'member']) {
    db.prepare("INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, 1000, 'CHF')").run(expense, ids[account]);
    ledger.run(group, expense, ids[account], ids.admin, -1000, ids.admin);
  }
}

/**
 * Rewards: participants, redemptions and the child's recent credits.
 * @param {{ db: Database, ids: Record<string, number>, dates: { nowIso: string } }} options
 */
function seedConditionRewards({ db, ids, dates }) {
  // The admin collects no more (`enabled = 0`); the split guest collects but
  // is no household member.
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 0)').run(ids.admin);
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(ids.split_guest);
  const redemption = db.prepare(`
    INSERT INTO reward_redemptions (user_id, reward_name, reward_icon, cost, status, kind, currency, requested_by)
    VALUES (?, ?, 'gift', ?, ?, ?, ?, ?)
  `);
  // Decided, not pending: one reward, one deposit. Pending money: a withdrawal
  // and a deposit - two, so the money count never equals the one pending reward.
  redemption.run(ids.child, 'golden.reward.fulfilled', 10, 'fulfilled', 'reward', null, ids.child);
  redemption.run(ids.child, 'golden.money.deposit', 500, 'fulfilled', 'deposit', 'EUR', ids.child);
  redemption.run(ids.child, 'golden.money.withdrawal', 300, 'pending', 'withdrawal', 'EUR', ids.child);
  redemption.run(ids.child, 'golden.money.deposit-open', 200, 'pending', 'deposit', 'EUR', ids.child);

  // The child's ledger, newer than every bonus of seedMoney. The two newest
  // valid credits share one instant (only `id DESC` orders them); the five in
  // between are no "earned" credit, each for one reason.
  const at = (/** @type {number} */ minutes) => new Date(Date.parse(dates.nowIso) - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const credit = db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, created_at, unit, currency, reverses_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const row = (/** @type {number} */ delta, /** @type {string} */ type, /** @type {string} */ reason,
    /** @type {number} */ minutes, unit = 'points', reverses = null) => credit.get(ids.child, delta, type, reason, ids.admin,
    at(minutes), unit, unit === 'money' ? 'EUR' : null, reverses).id;
  row(0, 'bonus', 'golden.credit.zero', 5);
  row(5, 'adjust', 'golden.credit.adjust', 6);
  row(300, 'earn', 'golden.credit.money', 7, 'money');
  const reversed = row(4, 'earn', 'golden.credit.reversed', 8);
  row(-4, 'reversal', 'golden.credit.reversal', 8, 'points', reversed);
  row(6, 'bonus', 'golden.credit.tie-first', 2);
  row(7, 'bonus', 'golden.credit.tie-second', 2);
}

/**
 * Health: an inactive medication and schedule, two logs on one dose.
 * @param {{ db: Database, ids: Record<string, number>, rows: Record<string, Array<{ name: string, id: number }>>,
 *           dates: { today: string, monthStart: string } }} options
 */
function seedConditionHealth({ db, ids, rows, dates }) {
  // Inactive, out of stock, named before every `goldkiwi` medication: only
  // `active = 1` keeps it out of the dose card, only `m.active DESC` behind
  // the active ones of the search.
  const inactive = db.prepare(`
    INSERT INTO medications (user_id, name, active, visibility, stock_qty, refill_threshold) VALUES (?, ?, 0, 'private', 0, 1) RETURNING id
  `).get(ids.admin, `${GOLDEN_TOKEN} medication 0`).id;
  const schedule = db.prepare(`
    INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, active)
    VALUES (?, ?, 127, 1, ?, ?) RETURNING id
  `);
  schedule.get(inactive, '09:00', dates.monthStart, 1);
  const adminMed = rows.medications.find((r) => r.name === 'medication.admin.private')?.id;
  assert.ok(adminMed, 'matrix medication medication.admin.private');
  // An inactive schedule on the admin's medication.
  schedule.get(adminMed, '13:00', dates.monthStart, 0);
  // A noon dose logged twice: skipped first, then taken. The newest log counts.
  const noon = schedule.get(adminMed, '12:00', dates.monthStart, 1).id;
  const log = db.prepare(`
    INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty) VALUES (?, ?, ?, ?, ?, 1)
  `);
  log.run(adminMed, noon, `${dates.today}T12:00`, 'skipped', null);
  log.run(adminMed, noon, `${dates.today}T12:00`, 'taken', `${dates.today}T12:02`);
}

/**
 * Search hits: one row per ORDER BY term and filter of each hit type.
 * @param {{ db: Database, ids: Record<string, number>, shift: (key: string, days: number) => string,
 *           dates: { today: string, monthStart: string } }} options
 */
function seedConditionSearch({ db, ids, shift, dates }) {
  // Names that sort before `goldkiwi ... a` and come last by id: only the
  // name order lifts them into the first five.
  db.prepare("INSERT INTO contacts (name, notes) VALUES (?, 'golden contact')").run(`${GOLDEN_TOKEN} contact 0`);
  const lastList = db.prepare("SELECT id FROM shopping_lists WHERE name = 'golden.list.51'").get().id;
  const item = db.prepare("INSERT INTO shopping_items (list_id, name, quantity, is_checked) VALUES (?, ?, '1', 1)");
  item.run(lastList, `${GOLDEN_TOKEN} item 0`);
  // Infix vocabulary: a longer term that sorts first by letter, a term of the
  // same length that sorts after `zquokka99` - both outside the cap of 50.
  item.run(lastList, `aa${INFIX_TOKEN}000`);
  item.run(lastList, `zz${INFIX_TOKEN}9`);
  // Pantry and birthdays: the same name twice, so `id ASC` orders the pair.
  const pantry = db.prepare("INSERT INTO pantry_items (name, quantity, unit, created_by) VALUES (?, 1, 'pcs', ?)");
  pantry.run(`${GOLDEN_TOKEN} pantry 0`, ids.admin);
  pantry.run(`${GOLDEN_TOKEN} pantry 0`, ids.admin);
  const birthday = db.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)');
  birthday.run(`${GOLDEN_TOKEN} birthday 0`, '1980-02-01', ids.admin);
  birthday.run(`${GOLDEN_TOKEN} birthday 0`, '1980-02-01', ids.admin);
  // Two birthdays tomorrow whose names are canonically equal (NFC and NFD):
  // the dashboard's own sort (days, localeCompare, kind) ties them, so the
  // SQL order by name (bytes: NFD first) decides, not the insert order.
  const tomorrow = shift(dates.today, 1);
  birthday.run('golden.birthday.rené', `1970${tomorrow.slice(4)}`, ids.admin);
  birthday.run('golden.birthday.rené', `1970${tomorrow.slice(4)}`, ids.admin);
  const recipe = db.prepare("INSERT INTO recipes (title, notes, created_by) VALUES (?, 'golden recipe', ?)");
  recipe.run(`${GOLDEN_TOKEN} recipe 0`, ids.admin);
  recipe.run(`${GOLDEN_TOKEN} recipe 0`, ids.admin);

  // Waste types: archived (first by order, hidden), first by `sort_order`
  // against the alphabet, and first by name among `sort_order` 0 but newest.
  const waste = db.prepare("INSERT INTO waste_types (name, icon, color, archived, sort_order, created_by) VALUES (?, 'trash-2', '#6B7280', ?, ?, ?)");
  waste.run(`${GOLDEN_TOKEN} bin 0`, 1, -2, ids.admin);
  waste.run(`${GOLDEN_TOKEN} bin z`, 0, -1, ids.admin);
  waste.run(`${GOLDEN_TOKEN} bin 1`, 0, 0, ids.admin);

  // Inventory: sold (first by name, behind every active one), active and newest.
  const inventory = db.prepare("INSERT INTO inventory_items (name, brand, status, created_by) VALUES (?, 'golden brand', ?, ?)");
  inventory.run(`${GOLDEN_TOKEN} inventory 0`, 'sold', ids.admin);
  inventory.run(`${GOLDEN_TOKEN} inventory 1`, 'active', ids.admin);

  // Documents: archived; newest id with the oldest change; two with one change time.
  const document = db.prepare(`
    INSERT INTO family_documents (name, visibility, status, original_name, mime_type, file_size, content_data, created_by, updated_at)
    VALUES (?, 'family', ?, 'golden.txt', 'text/plain', 0, '', ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
  `);
  document.run(`${GOLDEN_TOKEN} document archived`, 'archived', ids.admin, null);
  document.run(`${GOLDEN_TOKEN} document stale`, 'active', ids.admin, '2026-01-15T10:00:00Z');
  document.run(`${GOLDEN_TOKEN} document tie x`, 'active', ids.admin, '2026-03-10T12:00:00Z');
  document.run(`${GOLDEN_TOKEN} document tie y`, 'active', ids.admin, '2026-03-10T12:00:00Z');

  // Budget hits of the admin: the newest id with an old date, then two on one
  // later date (only `id DESC` orders them). Outside the month of the tile.
  const budget = db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility) VALUES (?, ?, 'food', ?, ?, ?, 'private')
  `);
  budget.run(`${GOLDEN_TOKEN} budget old`, -5, shift(dates.monthStart, -45), ids.admin, ids.admin);
  budget.run(`${GOLDEN_TOKEN} budget later x`, -6, shift(dates.monthStart, 32), ids.admin, ids.admin);
  budget.run(`${GOLDEN_TOKEN} budget later y`, -8, shift(dates.monthStart, 32), ids.admin, ids.admin);

  // An event of the member's UNSHARED subscription, soon: only the
  // subscription rule hides it from everyone else.
  const unshared = db.prepare("SELECT id FROM ics_subscriptions WHERE name = 'matrix unshared'").get().id;
  db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, subscription_id, countdown)
    VALUES (?, ?, 1, 'all', ?, 'ics', ?, 0)
  `).run(`${GOLDEN_TOKEN} event subscribed`, shift(dates.today, 5), ids.member, unshared);
  // 51 single events last year, one day apart: more past hits than the 50
  // candidates the event query reads, so only "upcoming first" in its ORDER BY
  // keeps the upcoming `goldkiwi` events in the answer.
  const pastEvent = db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, visibility, created_by, external_source, countdown)
    VALUES (?, ?, 1, 'all', ?, 'local', 0)
  `);
  for (let i = 1; i <= 51; i += 1) {
    pastEvent.run(`${GOLDEN_TOKEN} event past ${String(i).padStart(2, '0')}`, shift(dates.today, -300 - i), ids.admin);
  }
}
