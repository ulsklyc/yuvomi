/**
 * Demo Seed Script - Yuvomi
 * Fills the database with realistic English demo content for screenshots/mockups.
 * Usage: node scripts/seed-demo.js [--db /path/to/yuvomi.db]
 *
 * Requires a database already migrated to the current schema (open the app once,
 * or run the server, before seeding). Populates EVERY module:
 *   - Users: alex (admin/dad), sam (mom), emma & leo (children), maria (housekeeper)
 *   - Tasks (categories, priorities, statuses, start/due dates, multi-assignment)
 *   - Calendar events (appointments, activities, recurring, assignments)
 *   - Meals (full week, all slots) linked to recipes
 *   - Recipes with ingredients
 *   - Shopping list (English categories) with items
 *   - Contacts (family, medical, school, services)
 *   - Budget (income + expenses with proper categories/subcategories, a loan)
 *   - Notes (pinned + regular)
 *   - Birthdays (family-linked + relatives)
 *   - Documents (folders + files across categories)
 *   - Housekeeping (worker, work sessions, recurring chores, supplies, log)
 *   - Split expenses (household + trip groups, expenses, ledger, settlement)
 *   - Household preferences (EUR, dd.mm.yyyy, 24h)
 *
 * Login for all demo users: <username> / demo1234
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx !== -1 ? args[dbIdx + 1] : resolve(__dirname, '..', 'yuvomi.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Date helpers (local time, avoid UTC shift) ───────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function daysFromNow(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
function dateTimeFromNow(days, hour, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, min, 0, 0);
  return `${dateKey(d)}T${pad(hour)}:${pad(min)}`;
}
function thisMonthDate(day) {
  const d = new Date();
  d.setDate(day);
  return dateKey(d);
}
function lastMonthDate(day) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  d.setDate(day);
  return dateKey(d);
}
function thisMonthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function isoFromNow(days, hour = 9, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, min, 0, 0);
  return d.toISOString().slice(0, 19) + 'Z';
}

// ── Wipe existing data (keep category/migration tables) ──────────────────────

console.log('Clearing existing data…');
db.pragma('foreign_keys = OFF');
const WIPE = [
  'search_index',
  'shopping_items', 'shopping_lists',
  'budget_loan_payments', 'budget_loans', 'budget_recurrence_skipped', 'budget_entries',
  'contact_phones', 'contact_emails', 'contact_addresses', 'contacts',
  'notes',
  'meal_ingredients', 'meals', 'recipe_ingredients', 'recipes',
  'reminders',
  'event_assignments', 'task_assignments', 'calendar_events', 'tasks',
  'birthdays',
  'expense_activity', 'settlement_entries', 'settlements', 'recurring_expenses',
  'expense_attachments', 'expense_comments', 'expense_ledger_entries', 'expense_splits',
  'expenses', 'expense_group_members', 'split_expense_guest_users', 'expense_groups',
  'housekeeping_work_sessions', 'housekeeping_decay_tasks', 'housekeeping_supply_requests',
  'housekeeping_maintenance_log', 'housekeeping_workers',
  'family_document_access', 'family_documents', 'family_document_folders',
  'users',
];
const wipe = db.transaction(() => {
  for (const t of WIPE) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (e) { /* table may not exist */ }
  }
  db.prepare("DELETE FROM sqlite_sequence").run();
});
wipe();
db.pragma('foreign_keys = ON');

// ── Household preferences ────────────────────────────────────────────────────

console.log('Setting household preferences…');
const cfgSet = db.prepare(`
  INSERT INTO sync_config (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
cfgSet.run('currency', 'EUR');
cfgSet.run('date_format', 'dmy_dot');
cfgSet.run('time_format', '24h');
cfgSet.run('app_name', 'Yuvomi');
cfgSet.run('visible_meal_types', 'breakfast,lunch,dinner,snack');

// English shopping categories (rename the German defaults in place)
console.log('Renaming shopping categories to English…');
const renameCat = db.prepare('UPDATE shopping_categories SET name = ? WHERE id = ?');
[
  [1, 'Fruit & Veg'], [2, 'Bakery'], [3, 'Dairy'], [4, 'Meat & Fish'],
  [5, 'Frozen'], [6, 'Drinks'], [7, 'Household'], [8, 'Health & Beauty'], [9, 'Other'],
].forEach(([id, name]) => renameCat.run(name, id));

// English income category names
console.log('Localising budget income categories…');
const renameBudgetCat = db.prepare('UPDATE budget_categories SET name = ? WHERE key = ?');
[
  ['Erwerbseinkommen', 'Salary & Wages'],
  ['Kapitalerträge', 'Investment Income'],
  ['Geschenke & Transfers', 'Gifts & Transfers'],
  ['Sozialleistungen', 'Benefits'],
  ['Sonstiges Einkommen', 'Other Income'],
].forEach(([key, name]) => renameBudgetCat.run(name, key));

// ── Users ────────────────────────────────────────────────────────────────────

console.log('Creating users…');
const pw = bcrypt.hashSync('demo1234', 12);
const insertUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const alexId  = insertUser.run('alex',  'Alex Johnson',  pw, 'admin',  'dad',   '#2563EB').lastInsertRowid;
const samId   = insertUser.run('sam',   'Sam Johnson',   pw, 'member', 'mom',   '#16A34A').lastInsertRowid;
const emmaId  = insertUser.run('emma',  'Emma Johnson',  pw, 'member', 'child', '#EC4899').lastInsertRowid;
const leoId   = insertUser.run('leo',   'Leo Johnson',   pw, 'member', 'child', '#F97316').lastInsertRowid;
const mariaId = insertUser.run('maria', 'Maria Silva',   pw, 'member', 'other', '#7C3AED').lastInsertRowid;
console.log(`  alex=${alexId} sam=${samId} emma=${emmaId} leo=${leoId} maria=${mariaId}`);

// ── Tasks ────────────────────────────────────────────────────────────────────

console.log('Inserting tasks…');
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, category, priority, status, start_date, due_date, assigned_to, created_by)
  VALUES (@title, @description, @category, @priority, @status, @start_date, @due_date, @assigned_to, @created_by)
`);
const insertTaskAssign = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');

const tasks = [
  ['Book dentist appointment',    'Annual check-up for the whole family',   'health',    'high',   'open',        null,            daysFromNow(3),  alexId, alexId, [alexId]],
  ['Pay electricity bill',        'Due end of month — online banking',      'finance',   'urgent', 'open',        null,            daysFromNow(2),  alexId, alexId, [alexId]],
  ['Renew car insurance',         'Compare quotes first',                   'finance',   'high',   'open',        null,            daysFromNow(10), alexId, alexId, [alexId]],
  ['Fix leaking bathroom faucet', 'Replace washer, tools in the basement',  'repair',    'medium', 'open',        null,            daysFromNow(7),  samId,  alexId, [samId]],
  ['Order birthday cake',         "Emma's birthday — chocolate cake",       'household', 'high',   'open',        null,            daysFromNow(5),  samId,  samId,  [samId]],
  ['Clean out the garage',        'Donate old things to charity',           'household', 'low',    'open',        daysFromNow(7),  daysFromNow(14), alexId, alexId, [alexId, samId]],
  ['Sign school permission slip', 'Field trip to the science museum',       'school',    'urgent', 'open',        null,            daysFromNow(1),  samId,  samId,  [samId]],
  ['Renew library cards',         'All three cards expired last month',     'household', 'low',    'open',        null,            daysFromNow(20), alexId, alexId, [alexId]],
  ['Plan summer holiday',         'Italy or Croatia — check flights',       'leisure',   'medium', 'open',        daysFromNow(3),  daysFromNow(30), alexId, alexId, [alexId, samId]],
  ['Tax return 2025',             'Documents ready in the folder',          'finance',   'high',   'in_progress', null,            daysFromNow(18), alexId, alexId, [alexId]],
  ['Tidy bedroom',                'Put away laundry & toys',                'household', 'low',    'open',        null,            daysFromNow(1),  emmaId, samId,  [emmaId]],
  ['Practice piano',              '20 minutes — recital piece',             'school',    'medium', 'open',        null,            daysFromNow(2),  leoId,  samId,  [leoId]],
  ['Grocery run',                 'See the shopping list for details',      'shopping',  'medium', 'done',        null,            daysFromNow(-1), samId,  samId,  [samId]],
  ['Call insurance about claim',  'Reference: CLM-2025-0492',               'finance',   'high',   'done',        null,            daysFromNow(-3), alexId, alexId, [alexId]],
  ['Oil change — VW Golf',        'Every 15,000 km / 12 months',            'repair',    'medium', 'open',        null,            daysFromNow(6),  alexId, alexId, [alexId]],
  ['Buy birthday gift for Mum',   'Book voucher or wishlist item',          'shopping',  'medium', 'open',        null,            daysFromNow(8),  samId,  samId,  [samId]],
  ['Water the plants',            'Indoor plants + balcony herbs',          'household', 'none',   'done',        null,            daysFromNow(-2), leoId,  samId,  [leoId]],
];
for (const [title, description, category, priority, status, start_date, due_date, assigned_to, created_by, assignees] of tasks) {
  const id = insertTask.run({ title, description, category, priority, status, start_date, due_date, assigned_to, created_by }).lastInsertRowid;
  for (const u of assignees) insertTaskAssign.run(id, u);
}

// ── Calendar Events ──────────────────────────────────────────────────────────

console.log('Inserting calendar events…');
const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, location, color, icon, recurrence_rule, assigned_to, created_by)
  VALUES (@title, @description, @start, @end, @all_day, @location, @color, @icon, @rrule, @assigned_to, @created_by)
`);
const insertEventAssign = db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');

const events = [
  ["Emma's Birthday Party",     'Bouncy castle & cake at home',        daysFromNow(5) + 'T14:00', daysFromNow(5) + 'T17:00', 0, 'Home',                        '#F59E0B', 'cake',     null,               samId,  samId,  [samId, emmaId]],
  ['Dentist — Family',          'Dr. Müller, bring insurance cards',   daysFromNow(3) + 'T10:00', daysFromNow(3) + 'T11:30', 0, 'Dental Practice Müller',      '#EF4444', 'tooth',    null,               alexId, alexId, [alexId, samId, emmaId, leoId]],
  ['Parent–Teacher Evening',    'Room 12, bring the report card',      daysFromNow(9) + 'T18:30', daysFromNow(9) + 'T20:00', 0, 'Westpark Primary School',     '#8B5CF6', 'calendar', null,               samId,  samId,  [samId, alexId]],
  ['Science Museum Field Trip', 'Emma — permission slip signed',       daysFromNow(1) + 'T08:30', daysFromNow(1) + 'T15:00', 0, 'Natural History Museum',      '#06B6D4', 'calendar', null,               emmaId, samId,  [emmaId]],
  ['Family BBQ at Grandma\'s',  'Bring potato salad',                  daysFromNow(12) + 'T13:00', daysFromNow(12) + 'T19:00', 0, "Grandma's Garden",           '#F59E0B', 'calendar', null,               alexId, alexId, [alexId, samId, emmaId, leoId]],
  ['Car Service Appointment',   'VW Golf — oil change + tyre check',   daysFromNow(6) + 'T09:00', daysFromNow(6) + 'T10:30', 0, 'AutoHaus König',              '#6B7280', 'calendar', null,               alexId, alexId, [alexId]],
  ['Yoga Class',                'Weekly — bring a mat',                daysFromNow(2) + 'T19:00', daysFromNow(2) + 'T20:00', 0, 'FitLife Studio',              '#10B981', 'calendar', 'FREQ=WEEKLY;BYDAY=TU', samId, samId, [samId]],
  ["Mum's Birthday",            '',                                    daysFromNow(8) + 'T00:00', daysFromNow(8) + 'T00:00', 1, '',                            '#EC4899', 'cake',     null,               alexId, alexId, [alexId, samId]],
  ['Company All-Hands',         'Q2 results + roadmap presentation',   daysFromNow(4) + 'T10:00', daysFromNow(4) + 'T12:00', 0, 'Office — Conference Room B',  '#2563EB', 'calendar', null,               alexId, alexId, [alexId]],
  ['Football Training — Leo',   'Boots & water bottle',                daysFromNow(2) + 'T17:00', daysFromNow(2) + 'T18:30', 0, 'Sports Ground West',          '#F97316', 'calendar', 'FREQ=WEEKLY;BYDAY=TU,SA', leoId, samId, [leoId]],
  ['Piano Lesson — Leo',        'Weekly lesson with Ms. Klein',        daysFromNow(3) + 'T16:00', daysFromNow(3) + 'T16:45', 0, 'Music School Dortmund',       '#8B5CF6', 'calendar', 'FREQ=WEEKLY;BYDAY=TH', leoId, samId, [leoId]],
  ['Holiday Planning Evening',  'Italy vs Croatia — laptops out',      daysFromNow(3) + 'T21:00', daysFromNow(3) + 'T22:00', 0, 'Home',                        '#14B8A6', 'calendar', null,               alexId, samId,  [alexId, samId]],
  ['GP Appointment — Alex',     'Annual health check',                 daysFromNow(15) + 'T11:00', daysFromNow(15) + 'T11:30', 0, 'Dr. Weber — City Practice',  '#EF4444', 'stethoscope', null,            alexId, alexId, [alexId]],
  ['Weekend City Break',        'Hotel booked — just pack the bags!',  daysFromNow(20) + 'T00:00', daysFromNow(22) + 'T00:00', 1, 'Amsterdam',                  '#0EA5E9', 'plane',    null,               alexId, alexId, [alexId, samId]],
  ['Swimming — Emma',           'Westbad — goggles & towel',           daysFromNow(4) + 'T16:00', daysFromNow(4) + 'T17:00', 0, 'Westbad Pool',               '#06B6D4', 'calendar', 'FREQ=WEEKLY;BYDAY=FR', emmaId, samId, [emmaId]],
];
for (const [title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by, assignees] of events) {
  const id = insertEvent.run({ title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by }).lastInsertRowid;
  for (const u of assignees) insertEventAssign.run(id, u);
}

// ── Recipes ──────────────────────────────────────────────────────────────────

console.log('Inserting recipes…');
const insertRecipe = db.prepare('INSERT INTO recipes (title, notes, recipe_url, created_by) VALUES (?, ?, ?, ?)');
const insertRecipeIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)');
const recipes = [
  ['Spaghetti Bolognese', 'Family favourite — simmer the sauce for at least 45 minutes for the best flavour.', 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe', [
    ['Spaghetti', '500 g', 'Other'], ['Minced beef', '500 g', 'Meat & Fish'], ['Onion', '1', 'Fruit & Veg'],
    ['Garlic', '2 cloves', 'Fruit & Veg'], ['Tomato passata', '700 g', 'Other'], ['Parmesan', '50 g', 'Dairy'],
  ]],
  ['Chicken Tikka Masala', 'Marinate the chicken overnight if you can. Serve with basmati rice and naan.', 'https://www.bbcgoodfood.com/recipes/chicken-tikka-masala', [
    ['Chicken breast', '600 g', 'Meat & Fish'], ['Natural yoghurt', '200 g', 'Dairy'], ['Tikka paste', '3 tbsp', 'Other'],
    ['Double cream', '150 ml', 'Dairy'], ['Basmati rice', '300 g', 'Other'], ['Fresh coriander', '1 bunch', 'Fruit & Veg'],
  ]],
  ['Homemade Pizza', "Emma's favourite night! Let the dough rise for two hours.", null, [
    ['Pizza flour', '500 g', 'Other'], ['Fresh yeast', '7 g', 'Other'], ['Mozzarella', '250 g', 'Dairy'],
    ['Tomato sauce', '200 g', 'Other'], ['Fresh basil', '1 bunch', 'Fruit & Veg'],
  ]],
  ['Grilled Salmon & Roasted Veg', 'Lemon butter sauce ties it all together. Ready in 30 minutes.', null, [
    ['Salmon fillets', '4', 'Meat & Fish'], ['Courgette', '2', 'Fruit & Veg'], ['Bell peppers', '2', 'Fruit & Veg'],
    ['Lemon', '1', 'Fruit & Veg'], ['Butter', '50 g', 'Dairy'],
  ]],
  ['Sunday Roast Chicken', 'Rest the chicken for 15 minutes before carving.', null, [
    ['Whole chicken', '1.5 kg', 'Meat & Fish'], ['Potatoes', '1 kg', 'Fruit & Veg'], ['Carrots', '500 g', 'Fruit & Veg'],
    ['Rosemary', '2 sprigs', 'Fruit & Veg'], ['Olive oil', '4 tbsp', 'Other'],
  ]],
  ['Fluffy Pancakes', 'Weekend treat with maple syrup and a blueberry compote.', null, [
    ['Plain flour', '200 g', 'Other'], ['Milk', '300 ml', 'Dairy'], ['Eggs', '2', 'Dairy'],
    ['Blueberries', '125 g', 'Fruit & Veg'], ['Maple syrup', '1 bottle', 'Other'],
  ]],
];
const recipeIdByTitle = {};
for (const [title, notes, url, ings] of recipes) {
  const rid = insertRecipe.run(title, notes, url, alexId).lastInsertRowid;
  recipeIdByTitle[title] = rid;
  for (const [name, qty, cat] of ings) insertRecipeIng.run(rid, name, qty, cat);
}

// ── Meals (linked to recipes where titles match) ─────────────────────────────

console.log('Inserting meals…');
const insertMeal = db.prepare(`
  INSERT INTO meals (date, meal_type, title, notes, recipe_id, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertMealIng = db.prepare('INSERT INTO meal_ingredients (meal_id, name, quantity, category, on_shopping_list) VALUES (?, ?, ?, ?, ?)');

const mealPlan = [
  [-1, 'breakfast', 'Scrambled eggs & toast',        'With smoked salmon'],
  [-1, 'lunch',     'Tomato soup',                    'Served with sourdough bread'],
  [-1, 'dinner',    'Spaghetti Bolognese',            'Kids loved it'],
  [-1, 'snack',     'Apple slices & peanut butter',   ''],
  [ 0, 'breakfast', 'Overnight oats',                 'Blueberries & honey'],
  [ 0, 'lunch',     'Caesar salad with chicken',      'Homemade dressing'],
  [ 0, 'dinner',    'Grilled Salmon & Roasted Veg',   'Lemon butter sauce'],
  [ 0, 'snack',     'Hummus with carrot sticks',      ''],
  [ 1, 'breakfast', 'Avocado toast',                  'Poached eggs on top'],
  [ 1, 'lunch',     'Lentil soup',                    'With crusty bread'],
  [ 1, 'dinner',    'Chicken Tikka Masala',           'Basmati rice & naan'],
  [ 2, 'breakfast', 'Fluffy Pancakes',                'Blueberry compote'],
  [ 2, 'lunch',     'Greek salad & pita',             'Extra feta'],
  [ 2, 'dinner',    'Beef stir-fry',                  'Jasmine rice, pak choi'],
  [ 2, 'snack',     'Yoghurt & granola',             ''],
  [ 3, 'breakfast', 'Porridge with banana',           'Cinnamon & honey'],
  [ 3, 'lunch',     'Tuna melt sandwich',             'Toasted ciabatta'],
  [ 3, 'dinner',    'Homemade Pizza',                 "Emma's favourite night!"],
  [ 4, 'breakfast', 'Granola & mixed berries',        'Greek yoghurt'],
  [ 4, 'lunch',     'Minestrone soup',                'Topped with Parmesan'],
  [ 4, 'dinner',    'Sunday Roast Chicken',           'Sunday roast vibes'],
  [ 4, 'snack',     'Fruit salad',                    ''],
  [ 5, 'breakfast', 'French toast',                   'Powdered sugar & berries'],
  [ 5, 'lunch',     'BLT sandwich',                   'Wholemeal bread'],
  [ 5, 'dinner',    'Fish & chips',                   'Mushy peas, tartare sauce'],
  [ 6, 'breakfast', 'Smoothie bowl',                  'Banana, chia seeds'],
  [ 6, 'lunch',     'Caprese salad & focaccia',       'Fresh basil'],
  [ 6, 'dinner',    'Lamb chops & couscous',          'Mint yoghurt dressing'],
];
for (const [days, type, title, notes] of mealPlan) {
  const recipeId = recipeIdByTitle[title] ?? null;
  const mid = insertMeal.run(daysFromNow(days), type, title, notes, recipeId, alexId).lastInsertRowid;
  // A couple of upcoming dinners get a few ingredients to populate the kitchen view
  if (title === 'Beef stir-fry') {
    [['Beef strips', '400 g', 'Meat & Fish'], ['Pak choi', '2', 'Fruit & Veg'], ['Jasmine rice', '300 g', 'Other'], ['Soy sauce', '1 bottle', 'Other']]
      .forEach(([n, q, c]) => insertMealIng.run(mid, n, q, c, 0));
  }
}

// ── Shopping List ─────────────────────────────────────────────────────────────

console.log('Inserting shopping list…');
const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)').run('Weekly Shop', alexId).lastInsertRowid;
const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, category, is_checked) VALUES (?, ?, ?, ?, ?)');
[
  ['Whole milk',           '2 l',       'Dairy',           0],
  ['Greek yoghurt',        '500 g',     'Dairy',           0],
  ['Cheddar cheese',       '300 g',     'Dairy',           0],
  ['Free-range eggs',      '12',        'Dairy',           0],
  ['Sourdough bread',      '1 loaf',    'Bakery',          0],
  ['Wholemeal bread',      '1 loaf',    'Bakery',          0],
  ['Croissants',           '4',         'Bakery',          0],
  ['Chicken breast',       '800 g',     'Meat & Fish',     0],
  ['Minced beef',          '500 g',     'Meat & Fish',     0],
  ['Salmon fillets',       '2',         'Meat & Fish',     0],
  ['Smoked salmon',        '100 g',     'Meat & Fish',     1],
  ['Frozen peas',          '1 kg',      'Frozen',          0],
  ['Fish fingers',         '1 box',     'Frozen',          0],
  ['Broccoli',             '1 head',    'Fruit & Veg',     0],
  ['Cherry tomatoes',      '250 g',     'Fruit & Veg',     0],
  ['Avocados',             '3',         'Fruit & Veg',     0],
  ['Baby spinach',         '150 g',     'Fruit & Veg',     1],
  ['Bananas',              '6',         'Fruit & Veg',     0],
  ['Blueberries',          '125 g',     'Fruit & Veg',     0],
  ['Lemons',               '4',         'Fruit & Veg',     0],
  ['Orange juice',         '1 l',       'Drinks',          0],
  ['Sparkling water',      '6 × 1 l',   'Drinks',          1],
  ['Washing-up liquid',    '1',         'Household',       0],
  ['Kitchen roll',         '4 pack',    'Household',       0],
  ["Children's vitamins",  '1 pack',    'Health & Beauty', 0],
  ['Toothpaste',           '2',         'Health & Beauty', 0],
].forEach(([name, qty, cat, checked]) => insertItem.run(listId, name, qty, cat, checked));

// ── Contacts ─────────────────────────────────────────────────────────────────

console.log('Inserting contacts…');
const insertContact = db.prepare(`
  INSERT INTO contacts (name, category, phone, email, address, notes, organization, job_title)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  ['Dr. Anna Weber',            'medical',  '+49 231 445 2210', 'praxis@dr-weber.de',            'Bürgerstraße 12, Dortmund',      'GP — appointments Mon–Thu',                  'City Practice',          'General Practitioner'],
  ['Dr. Thomas Müller',         'medical',  '+49 231 887 0034', 'info@zahnarzt-mueller.de',      'Hansastraße 55, Dortmund',       'Family dentist',                             'Dental Practice Müller', 'Dentist'],
  ['Grandma & Grandpa Johnson', 'family',   '+49 2304 78 221',  'oma.johnson@gmail.com',         'Ahornweg 4, Castrop-Rauxel',     "Emma & Leo's grandparents",                  null,                     null],
  ['Westpark Primary School',   'school',   '+49 231 556 8810', 'office@westpark-grundschule.de','Westparkstraße 20, Dortmund',    "Emma's school — Mrs Bauer is class teacher", 'Westpark Primary School', null],
  ['AutoHaus König',            'services', '+49 231 997 1100', 'service@autohaus-koenig.de',    'Industriestraße 88, Dortmund',   'VW service partner — Ref: Golf TDI 2021',    'AutoHaus König',         'Service Centre'],
  ['FitLife Studio',            'services', '+49 231 340 5060', 'hello@fitlife-dortmund.de',     'Rheinlanddamm 14, Dortmund',     "Sam's yoga — Tuesdays 19:00",                'FitLife Studio',         null],
  ['Uncle Mike Johnson',        'family',   '+49 172 3340 551', 'mike.j@outlook.com',            'Hamburg',                        "Alex's brother — lives in Hamburg",          null,                     null],
  ['Aunt Claire Becker',        'family',   '+49 151 2234 8876','claire.becker@web.de',          'Fichtenweg 7, Bochum',           "Sam's sister",                               null,                     null],
  ["Leo's Football Coach",      'school',   '+49 176 5512 4490','trainer@svwest-dortmund.de',    'Sportplatz West, Dortmund',      'Training Tue & Sat 17:00',                   'SV West Dortmund',       'Coach'],
  ['City Library',              'services', '+49 231 502 6600', 'stadtbibliothek@dortmund.de',   'Königswall 18, Dortmund',        'Family cards — renew every 2 years',         'Dortmund City Library',  null],
  ['Landlord — Mr Groß',        'services', '+49 231 112 7743', 'vermieter.gross@gmail.com',     null,                             'Emergency maintenance: same number',         null,                     'Landlord'],
  ["Emma's friend — Lena",      'family',   '+49 231 774 3309', null,                            null,                             "Lena Braun — mum Katrin +49 231 774 3308",   null,                     null],
].forEach(row => insertContact.run(...row));

// ── Budget ───────────────────────────────────────────────────────────────────

console.log('Inserting budget entries…');
const insertBudget = db.prepare(`
  INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const budget = [
  // Income (category = income key, no subcategory)
  ['Alex — Monthly Salary',      3850.00, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, alexId],
  ['Sam — Part-time Work',       1200.00, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, samId ],
  ['Child Benefit',               500.00, 'Sozialleistungen', '',                       thisMonthDate(5),  1, alexId],
  // Fixed expenses
  ['Rent',                      -1450.00, 'housing',           'rent_mortgage',          thisMonthDate(1),  1, alexId],
  ['Car Insurance — VW Golf',     -89.50, 'transport',         'maintenance_insurance',  thisMonthDate(1),  1, alexId],
  ['Health Insurance',           -310.00, 'personal_health',   'health_insurance',       thisMonthDate(1),  1, alexId],
  ['Internet & Phone Bundle',     -49.99, 'housing',           'internet_tv_phone',      thisMonthDate(5),  1, alexId],
  ['Electricity',                 -78.00, 'housing',           'utilities',              thisMonthDate(15), 1, alexId],
  ['Netflix',                     -17.99, 'leisure',           'streaming',              thisMonthDate(10), 1, alexId],
  ['Spotify Family',              -16.99, 'leisure',           'streaming',              thisMonthDate(10), 1, alexId],
  ['Gym — FitLife',               -39.00, 'personal_health',   'gym_sports',             thisMonthDate(1),  1, samId ],
  // Variable, this month
  ['Weekly Groceries — Wk 1',    -142.30, 'food',              'groceries',              thisMonthDate(4),  0, samId ],
  ['Weekly Groceries — Wk 2',    -118.75, 'food',              'groceries',              thisMonthDate(11), 0, samId ],
  ['Weekly Groceries — Wk 3',    -134.20, 'food',              'groceries',              thisMonthDate(18), 0, samId ],
  ['School Trip Payment',         -25.00, 'education',         'school_supplies',        thisMonthDate(3),  0, samId ],
  ['Birthday Gift — Mum',         -60.00, 'shopping_clothing', 'gifts',                  thisMonthDate(7),  0, alexId],
  ['Restaurant — Date Night',     -87.50, 'food',              'restaurants_bars',       thisMonthDate(9),  0, alexId],
  ['Fuel — VW Golf',              -68.00, 'transport',         'fuel',                   thisMonthDate(6),  0, alexId],
  ['Pharmacy',                    -22.40, 'personal_health',   'pharmacy',               thisMonthDate(8),  0, samId ],
  ["Leo's Football Boots",        -54.99, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(12), 0, samId ],
  ['Tools — Home Improvement',    -43.00, 'housing',           'renovation_maintenance', thisMonthDate(14), 0, alexId],
  ['Clothes — Emma',              -38.50, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(16), 0, samId ],
  ['Weekend Trip Deposit',       -200.00, 'leisure',           'travel',                 thisMonthDate(19), 0, alexId],
  // Last month (trend comparison)
  ['Alex — Monthly Salary',      3850.00, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, alexId],
  ['Sam — Part-time Work',       1200.00, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, samId ],
  ['Rent',                      -1450.00, 'housing',           'rent_mortgage',          lastMonthDate(1),  0, alexId],
  ['Weekly Groceries',           -489.00, 'food',              'groceries',              lastMonthDate(10), 0, samId ],
  ['Electricity',                 -82.00, 'housing',           'utilities',              lastMonthDate(15), 0, alexId],
  ['Fuel — VW Golf',              -71.00, 'transport',         'fuel',                   lastMonthDate(8),  0, alexId],
];
budget.forEach(row => insertBudget.run(...row));

// Budget loan (money lent, repaid in installments)
console.log('Inserting budget loan…');
const loanId = db.prepare(`
  INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, notes, status, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run('Loan to Uncle Mike', 'Uncle Mike Johnson', 1200.00, 6, thisMonthKey(-2), 'Helping with his car repair — €200/month', 'active', alexId).lastInsertRowid;
const insertLoanPayment = db.prepare(`
  INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
insertLoanPayment.run(loanId, 1, 200.00, lastMonthDate(2), alexId);
insertLoanPayment.run(loanId, 2, 200.00, thisMonthDate(2), alexId);

// ── Notes ────────────────────────────────────────────────────────────────────

console.log('Inserting notes…');
const insertNote = db.prepare('INSERT INTO notes (title, content, color, pinned, created_by) VALUES (?, ?, ?, ?, ?)');
[
  ['Holiday Checklist 🌍', 'Passports (exp. 2028)\nTravel insurance — check!\nEuro cash — €300\nBook airport parking\nAsk Mike to water the plants\nPack sunscreen SPF 50', '#0EA5E9', 1, alexId],
  ['WiFi & Smart Home',    'WiFi: Yuvomi_Home_5G\nPassword: sunshine2024!\nPhilips Hue: bridge 192.168.1.42\nThermostat: eco mode 18°C', '#F59E0B', 1, alexId],
  ["Emma's School Info",   "Class: 3b — Mrs Bauer\nSchool starts: 08:10\nCollection: 13:30 (Tue/Thu 15:00)\nAllergy: mild lactose intolerance\nBest friends: Lena, Sophie, Tim", '#EC4899', 1, samId],
  ["Leo's Activities",     'Football: Tue & Sat 17:00 — SV West\nSwimming: Fri 16:00 — Westbad\nNeeds: boots size 35, goggles\nCoach: Herr Krüger', '#F97316', 1, samId],
  ['Emergency Numbers',    'Police: 110\nFire / Ambulance: 112\nPoison Control: 0800 192 11 10\nGP out-of-hours: 116 117\nNearest A&E: Klinikum Dortmund', '#EF4444', 1, alexId],
  ['Car — Important Dates','Next service: this June (60,000 km)\nMOT due: September\nWinter tyres: stored at AutoHaus König\nInsurance renewal: October', '#6B7280', 0, alexId],
  ['Book Recommendations', 'Reading: "Atomic Habits" — James Clear\nWishlist:\n• The Thursday Murder Club\n• Lessons in Chemistry\n• Tomorrow, and Tomorrow, and Tomorrow', '#8B5CF6', 0, samId],
  ['Garden To-Do',         '□ Re-pot herbs (basil, rosemary)\n□ Fix fence panel (3rd from gate)\n□ Order mulch for the flower beds\n□ Plant tulip bulbs before November', '#10B981', 0, alexId],
].forEach(row => insertNote.run(...row));

// ── Birthdays ────────────────────────────────────────────────────────────────

console.log('Inserting birthdays…');
const insertBirthday = db.prepare(`
  INSERT INTO birthdays (name, birth_date, notes, family_user_id, reminder_offset, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
[
  ['Emma Johnson',        '2018-06-14', 'Turning 8 — chocolate cake & bouncy castle', emmaId, '1w',  samId],
  ['Leo Johnson',         '2016-03-22', 'Loves football & LEGO',                       leoId,  '1w',  samId],
  ['Margaret Johnson',    '1958-06-19', "Alex's mum — 'Grandma'",                      null,   '3d',  alexId],
  ['Uncle Mike Johnson',  '1985-11-02', "Alex's brother in Hamburg",                   null,   '1d',  alexId],
  ['Aunt Claire Becker',  '1989-08-30', "Sam's sister",                                null,   '1d',  samId],
  ['Lena Braun',          '2018-09-12', "Emma's best friend",                          null,   '1d',  samId],
  ['Alex Johnson',        '1986-02-08', '',                                            alexId, '3d',  samId],
  ['Sam Johnson',         '1988-04-25', '',                                            samId,  '3d',  alexId],
].forEach(row => insertBirthday.run(...row));

// ── Documents ────────────────────────────────────────────────────────────────

console.log('Inserting documents…');
const insertFolder = db.prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)');
const folderId = {};
for (const name of ['Medical', 'School', 'Insurance', 'Home', 'Travel', 'Vehicle']) {
  folderId[name] = insertFolder.run(name, alexId).lastInsertRowid;
}
// Build a base64 payload of a given byte size so file sizes look realistic.
function payload(bytes) {
  const text = 'OIKOS DEMO DOCUMENT — placeholder content. '.repeat(Math.ceil(bytes / 44)).slice(0, bytes);
  const buf = Buffer.from(text, 'utf8');
  return { base64: buf.toString('base64'), size: buf.length };
}
const insertDoc = db.prepare(`
  INSERT INTO family_documents (name, description, category, status, visibility, folder_id, original_name, mime_type, file_size, content_data, created_by)
  VALUES (@name, @description, @category, 'active', @visibility, @folder, @original, @mime, @size, @content, @created_by)
`);
const documents = [
  ['Vaccination Record — Emma',  'Up to date as of last check-up',     'medical',   'family',     'Medical',   'emma_vaccinations.pdf',   'application/pdf', 124000, alexId],
  ['Health Insurance Card',      'Scan of the family insurance card',  'medical',   'restricted', 'Medical',   'insurance_card.jpg',      'image/jpeg',      86000,  alexId],
  ['School Report — Emma',       'Spring term report',                 'school',    'family',     'School',    'emma_report_spring.pdf',  'application/pdf', 210000, samId ],
  ['Field Trip Permission Slip', 'Signed — science museum',            'school',    'family',     'School',    'permission_slip.pdf',     'application/pdf', 48000,  samId ],
  ['Tenancy Agreement',          'Signed lease — flat on Bürgerstraße','home',      'restricted', 'Home',      'tenancy_agreement.pdf',   'application/pdf', 320000, alexId],
  ['Home Insurance Policy',      'Policy documents 2025',              'insurance', 'family',     'Insurance', 'home_insurance_2025.pdf', 'application/pdf', 180000, alexId],
  ['Car Insurance — VW Golf',    'Comprehensive cover',                'insurance', 'family',     'Vehicle',   'car_insurance.pdf',       'application/pdf', 156000, alexId],
  ['Vehicle Registration',       'VW Golf TDI — registration papers',  'vehicle',   'restricted', 'Vehicle',   'vw_golf_registration.pdf','application/pdf', 96000,  alexId],
  ['Passports (scans)',          'All four family passports',          'travel',    'private',    'Travel',    'passports.pdf',           'application/pdf', 410000, alexId],
  ['Flight Confirmation',        'Amsterdam city break',               'travel',    'family',     'Travel',    'flights_amsterdam.pdf',   'application/pdf', 64000,  alexId],
];
for (const [name, description, category, visibility, folder, original, mime, size, created_by] of documents) {
  const p = payload(Math.min(size, 4096)); // store a small placeholder, report a realistic size
  insertDoc.run({
    name, description, category, visibility, folder: folderId[folder],
    original, mime, size, content: p.base64, created_by,
  });
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

console.log('Inserting housekeeping data…');
const workerId = db.prepare(`
  INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, notes, calendar_color)
  VALUES (?, ?, ?, ?, ?)
`).run(mariaId, 45.00, 'twice_monthly', 'Comes Mon, Wed & Fri mornings', '#7C3AED').lastInsertRowid;

const insertSession = db.prepare(`
  INSERT INTO housekeeping_work_sessions (check_in, check_out, daily_rate, extras, worker_id, paid_at, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
// Past few weeks of sessions; earlier ones paid, recent ones unpaid.
const sessionDays = [-23, -21, -18, -16, -14, -11, -9, -7, -4, -2, 0];
sessionDays.forEach((d, i) => {
  const checkIn = isoFromNow(d, 8, 30);
  const checkOut = d === 0 ? null : isoFromNow(d, 12, 0); // today still open
  const extras = i % 4 === 0 ? 10.00 : 0;
  const paidAt = d <= -14 ? isoFromNow(-13, 18, 0) : null;
  insertSession.run(checkIn, checkOut, 45.00, extras, workerId, paidAt, alexId);
});

const insertDecay = db.prepare(`
  INSERT INTO housekeeping_decay_tasks (name, area, frequency_days, last_completed, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
[
  ['Clean bathrooms',     'Bathrooms',   7,  isoFromNow(-3)],
  ['Mop kitchen floor',   'Kitchen',     7,  isoFromNow(-6)],
  ['Dust living room',    'Living room', 14, isoFromNow(-10)],
  ['Change bed linens',   'Bedrooms',    14, isoFromNow(-16)],   // overdue
  ['Clean refrigerator',  'Kitchen',     30, isoFromNow(-20)],
  ['Clean windows',       'Whole house', 30, isoFromNow(-35)],   // overdue
  ['Deep clean oven',     'Kitchen',     60, isoFromNow(-40)],
  ['Wash balcony/patio',  'Outdoor',     30, isoFromNow(-12)],
].forEach(row => insertDecay.run(...row, alexId));

const insertSupply = db.prepare('INSERT INTO housekeeping_supply_requests (name, quantity, created_by) VALUES (?, ?, ?)');
[
  ['Dish soap', '2 bottles', mariaId],
  ['Paper towels', '6 rolls', mariaId],
  ['Glass cleaner', '1', mariaId],
  ['Bin bags (60 l)', '1 pack', mariaId],
].forEach(row => insertSupply.run(...row));

const insertMaint = db.prepare('INSERT INTO housekeeping_maintenance_log (description, created_by) VALUES (?, ?)');
[
  ['Reported a dripping tap in the main bathroom', mariaId],
  ['Replaced the kitchen sponge and refilled hand soap', mariaId],
  ['Living-room blind is sticking — needs a look', mariaId],
].forEach(row => insertMaint.run(...row));

// ── Split Expenses ───────────────────────────────────────────────────────────

console.log('Inserting split expenses…');
const insertGroup = db.prepare(`
  INSERT INTO expense_groups (name, description, type, avatar_color, default_currency, created_by)
  VALUES (?, ?, ?, ?, 'EUR', ?)
`);
const insertMember = db.prepare(`
  INSERT INTO expense_group_members (group_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)
`);
const insertExpenseRow = db.prepare(`
  INSERT INTO expenses (group_id, title, description, amount_minor, currency, converted_amount_minor, converted_currency, payer_id, category, split_method, expense_date, created_by)
  VALUES (@group, @title, @description, @amount, 'EUR', @amount, 'EUR', @payer, @category, 'equal', @date, @created_by)
`);
const insertSplit = db.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)');
const insertLedger = db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'expense', ?, ?, ?, ?, 'EUR', ?, ?)
`);
const insertActivity = db.prepare(`
  INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function addExpense(groupId, payerId, memberIds, title, description, euros, category, date) {
  const amount = Math.round(euros * 100);
  const n = memberIds.length;
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;
  const shares = memberIds.map((uid) => {
    let s = base;
    if (remainder > 0) { s += 1; remainder -= 1; }
    return { uid, amount_minor: s };
  });
  const expId = insertExpenseRow.run({
    group: groupId, title, description, amount, payer: payerId, category, date, created_by: payerId,
  }).lastInsertRowid;
  for (const s of shares) insertSplit.run(expId, s.uid, s.amount_minor, 'EUR');
  // Ledger: payer +full, each member -their share
  insertLedger.run(groupId, expId, payerId, null, amount, title, payerId);
  for (const s of shares) insertLedger.run(groupId, expId, s.uid, payerId, -s.amount_minor, title, payerId);
  insertActivity.run(groupId, payerId, 'expense_added', 'expense', expId, JSON.stringify({ title, amount_minor: amount }));
  return expId;
}

// Group 1: Household (alex + sam)
const houseGroup = insertGroup.run('Household', 'Shared bills, groceries and family costs', 'household', '#0F766E', alexId).lastInsertRowid;
insertMember.run(houseGroup, alexId, 'owner', alexId);
insertMember.run(houseGroup, samId, 'admin', alexId);
insertActivity.run(houseGroup, alexId, 'group_created', 'group', houseGroup, JSON.stringify({ name: 'Household' }));
addExpense(houseGroup, alexId, [alexId, samId], 'Weekly groceries',     'Big shop at REWE',        142.30, 'groceries',     thisMonthDate(4));
addExpense(houseGroup, samId,  [alexId, samId], 'Electricity bill',     'Monthly direct debit',     78.00, 'utilities',     thisMonthDate(15));
addExpense(houseGroup, alexId, [alexId, samId], 'Date-night dinner',    'Italian on the corner',    87.50, 'general',       thisMonthDate(9));
addExpense(houseGroup, samId,  [alexId, samId], "Emma's new shoes",     'Back-to-school',           38.50, 'shopping',      thisMonthDate(16));
addExpense(houseGroup, alexId, [alexId, samId], 'Streaming bundle',     'Netflix + Spotify',        34.98, 'subscriptions', thisMonthDate(10));

// Group 2: Italy Trip 2026 (alex + sam)
const tripGroup = insertGroup.run('Italy Trip 2026', 'Summer holiday planning & costs', 'travel', '#0EA5E9', alexId).lastInsertRowid;
insertMember.run(tripGroup, alexId, 'owner', alexId);
insertMember.run(tripGroup, samId, 'admin', alexId);
insertActivity.run(tripGroup, alexId, 'group_created', 'group', tripGroup, JSON.stringify({ name: 'Italy Trip 2026' }));
addExpense(tripGroup, alexId, [alexId, samId], 'Flights (×4)',     'Dortmund → Naples',     648.00, 'travel',  thisMonthDate(2));
addExpense(tripGroup, samId,  [alexId, samId], 'Apartment deposit','Sorrento — 7 nights',   400.00, 'travel',  thisMonthDate(6));
addExpense(tripGroup, alexId, [alexId, samId], 'Travel insurance', 'Family annual policy',   96.00, 'general', thisMonthDate(8));

// A settlement in the household group: Sam pays Alex back a round amount
const settlementId = db.prepare(`
  INSERT INTO settlements (group_id, payer_id, payee_id, amount_minor, currency, notes, created_by)
  VALUES (?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, samId, alexId, 5000, 'Partial settle-up via bank transfer', samId).lastInsertRowid;
db.prepare(`
  INSERT INTO settlement_entries (settlement_id, from_user_id, to_user_id, amount_minor, currency)
  VALUES (?, ?, ?, ?, 'EUR')
`).run(settlementId, samId, alexId, 5000);
// Ledger for settlement: payer (sam) +amount toward payee, payee (alex) -amount
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, settlementId, samId, alexId, 5000, 'Settle-up', samId);
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, settlementId, alexId, samId, -5000, 'Settle-up', samId);
insertActivity.run(houseGroup, samId, 'settlement_added', 'settlement', settlementId, JSON.stringify({ amount_minor: 5000 }));

// ── Reminders ────────────────────────────────────────────────────────────────

console.log('Inserting reminders…');
const insertReminder = db.prepare(`
  INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by)
  VALUES (?, ?, ?, 0, ?)
`);
// Remind for the urgent electricity-bill task (task id 2) and the field-trip event (event id 4)
insertReminder.run('task', 2, isoFromNow(2, 8, 0), alexId);
insertReminder.run('event', 4, isoFromNow(1, 7, 30), samId);

// ── Done ─────────────────────────────────────────────────────────────────────

db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ Demo data inserted successfully!');
console.log('  Admin login:  alex  / demo1234');
console.log('  Member login: sam   / demo1234   (also: emma, leo, maria)');
