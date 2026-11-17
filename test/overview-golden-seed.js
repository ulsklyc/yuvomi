/**
 * Module: Seed extension for the overview golden master (test/test-overview-golden.js)
 * Purpose: the visibility matrix seed (test/visibility-matrix-seed.js) fills
 *          tasks, events, notes, documents, budget, medications and health
 *          activities. The dashboard answer has more blocks than that: meals,
 *          shopping, birthdays, shared expenses, rewards, doses, fasting,
 *          nutrition, the housekeeper, waste, shifts, pantry and quick links.
 *          This file adds one small, named set of rows per block, so every
 *          block of `GET /dashboard` carries data for at least one role, and
 *          every hit type of `GET /search` has a row to find.
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
 *
 * `GOLDEN_TOKEN` stands in the name of one row of every table-searched and
 * index-searched type the matrix does not seed, so one query finds them all.
 */
import assert from 'node:assert/strict';

/** One word in contacts, shopping items, waste types, recipes, pantry, inventory and birthdays. */
export const GOLDEN_TOKEN = 'goldkiwi';

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
 * @param {{ today: string, yesterday: string, monthStart: string, inThreeDays: string, nowIso: string, oneHourAgoIso: string }} options.dates
 */
export async function seedOverviewExtras({ db, call, adminHeaders, ids, rows, dates }) {
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

  // Tasks: one overdue and one done today, both visible to all and assigned,
  // so `overdueTaskCount`, `tasksDoneToday` and the done column of `wallTasks`
  // carry a row.
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, visibility, created_by)
    VALUES (?, 'household', 'urgent', ?, ?, 'all', ?) RETURNING id
  `);
  const overdue = insertTask.get('golden.task.overdue', 'open', dates.yesterday, ids.admin).id;
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(overdue, ids.child);
  const done = insertTask.get('golden.task.done-today', 'done', dates.today, ids.admin).id;
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(done, ids.member);
  db.prepare('INSERT INTO task_completions (task_id, series_id, user_id, completed_at) VALUES (?, ?, ?, ?)')
    .run(done, done, ids.member, dates.oneHourAgoIso);

  // Meals: lunch today, cooked by the member, from a recipe that the search finds.
  const recipe = db.prepare('INSERT INTO recipes (title, notes, created_by) VALUES (?, ?, ?) RETURNING id')
    .get(`${GOLDEN_TOKEN} tart`, 'golden recipe', ids.admin).id;
  db.prepare(`
    INSERT INTO meals (date, meal_type, title, notes, recipe_id, cook_user_id, created_by)
    VALUES (?, 'lunch', 'golden.meal.lunch', 'golden meal note', ?, ?, ?)
  `).run(dates.today, recipe, ids.member, ids.admin);

  // Shopping: one list, two open items and one checked.
  const list = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?) RETURNING id')
    .get('golden.list', ids.admin).id;
  const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, is_checked) VALUES (?, ?, ?, ?)');
  insertItem.run(list, `${GOLDEN_TOKEN} juice`, '2', 0);
  insertItem.run(list, 'golden.item.bread', '1', 0);
  insertItem.run(list, 'golden.item.done', '1', 1);

  // Birthdays: one today (soon count), one later in the year.
  const insertBirthday = db.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)');
  insertBirthday.run(`${GOLDEN_TOKEN} grandma`, `1950-${dates.today.slice(5)}`, ids.admin);
  insertBirthday.run('golden.birthday.later', '1985-12-24', ids.admin);

  // Contacts, waste, pantry and inventory: one searchable row each.
  db.prepare('INSERT INTO contacts (name, notes) VALUES (?, ?)').run(`${GOLDEN_TOKEN} plumber`, 'golden contact');
  const wasteType = db.prepare("INSERT INTO waste_types (name, icon, color, created_by) VALUES (?, 'trash-2', '#6B7280', ?) RETURNING id")
    .get(`${GOLDEN_TOKEN} bin`, ids.admin).id;
  db.prepare('INSERT INTO waste_one_off_pickups (type_id, date, created_by) VALUES (?, ?, ?)').run(wasteType, dates.today, ids.admin);
  const insertPantry = db.prepare(`
    INSERT INTO pantry_items (name, quantity, unit, expires_on, created_by) VALUES (?, 1, 'pcs', ?, ?)
  `);
  insertPantry.run(`${GOLDEN_TOKEN} jam`, dates.today, ids.admin);
  insertPantry.run('golden.pantry.soon', dates.inThreeDays, ids.admin);
  db.prepare("INSERT INTO inventory_items (name, brand, status, created_by) VALUES (?, 'golden brand', 'active', ?)")
    .run(`${GOLDEN_TOKEN} blender`, ids.admin);

  // Budget: an income next to the matrix expenses, and a savings goal.
  db.prepare(`
    INSERT INTO budget_entries (title, amount, category, date, created_by, owner_id, visibility)
    VALUES ('golden.budget.income', 250, 'Sonstiges', ?, ?, ?, 'private')
  `).run(dates.monthStart, ids.admin, ids.admin);
  db.prepare("INSERT INTO budget_plans (category, amount, created_by) VALUES ('__savings__', 200, ?)").run(String(ids.admin));

  // Shared expenses: the admin paid 30.00 for admin, member and child.
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

  // Rewards: member and child collect, one reward in the catalog, the child
  // earned points and asks for the reward.
  const insertParticipant = db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)');
  insertParticipant.run(ids.member);
  insertParticipant.run(ids.child);
  const reward = db.prepare(`
    INSERT INTO reward_catalog (name, cost, icon, description, is_active, sort_order, created_by)
    VALUES ('golden.reward.ice-cream', 30, 'ice-cream', 'golden reward', 1, 0, ?) RETURNING id
  `).get(ids.admin).id;
  db.prepare(`
    INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, created_at) VALUES (?, 40, 'bonus', 'golden.bonus', ?, ?)
  `).run(ids.child, ids.admin, dates.oneHourAgoIso);
  db.prepare(`
    INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, status, requested_by, created_at)
    VALUES (?, ?, 'golden.reward.ice-cream', 'ice-cream', 30, 'pending', ?, ?)
  `).run(ids.child, reward, ids.child, dates.nowIso);

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

  // Housekeeping: the helper is in the house since an hour, and an earlier
  // visit this month is finished and unpaid.
  const worker = db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 40) RETURNING id').get(helperId).id;
  const insertVisit = db.prepare(`
    INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, worker_id, created_by) VALUES (?, ?, 40, ?, ?)
  `);
  insertVisit.run(`${dates.monthStart}T08:00:00.000Z`, `${dates.monthStart}T12:00:00.000Z`, worker, ids.admin);
  insertVisit.run(dates.oneHourAgoIso, null, worker, ids.admin);

  // Shifts: the admin works the early shift today.
  const shift = db.prepare(`
    INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, icon, created_by)
    VALUES ('golden.shift.early', 'E', '06:00', '14:00', '#0EA5E9', 'sunrise', ?) RETURNING id
  `).get(ids.admin).id;
  db.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (?, ?, ?)').run(ids.admin, dates.today, shift);

  // Quick links: one for everyone, one private of the member.
  const insertLink = db.prepare('INSERT INTO quick_links (name, url, visibility, created_by, position) VALUES (?, ?, ?, ?, ?)');
  insertLink.run('golden.link.all', 'https://example.invalid/all', 'all', ids.admin, 0);
  insertLink.run('golden.link.private', 'https://example.invalid/private', 'private', ids.member, 1);

  return { helperId };
}
