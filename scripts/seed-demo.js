/**
 * Demo Seed Script - Yuvomi
 * Fills the database with realistic demo content for screenshots/mockups,
 * in English or German.
 * Usage: node scripts/seed-demo.js [--db /path/to/yuvomi.db] [--locale en|de]
 *
 * Requires a database already migrated to the current schema (open the app once,
 * or run the server, before seeding). Populates EVERY module:
 *   - Users: alex (admin/dad), linda (admin/mom), emma & leo (children), maria (housekeeper)
 *   - Tasks (categories, priorities, statuses, start/due dates, multi-assignment, tags, points)
 *   - Calendar events (appointments, activities, recurring, assignments)
 *   - Meals (full week, all slots) linked to recipes, plus a recurring meal template
 *   - Recipes with ingredients
 *   - Shopping list with items and tags
 *   - Pantry (stock across every location, expiring + low-stock items)
 *   - Contacts (family, medical, school, services)
 *   - Budget (accounts, per-category plans, income + expenses, loans incl. an
 *     annuity mortgage, receipts linked to entries)
 *   - Notes (pinned + regular)
 *   - Birthdays (family-linked + relatives)
 *   - Documents (folders + files across categories)
 *   - Housekeeping (worker, work sessions, recurring chores, supplies, log)
 *   - Split expenses (household + trip groups, expenses, receipts, comments,
 *     a recurring expense, ledger, settlement)
 *   - Health (vitals, activities, medications + schedules/logs, lab reports, cycle,
 *     plus caregiver grants: both parents may record for the two children)
 *   - Rewards (participants, catalog, points ledger, fulfilled + pending redemptions)
 *   - Budget subscriptions (streaming, storage, gym — mixed billing cycles, one ending)
 *   - Household preferences (EUR, dd.mm.yyyy, 24h, weather = Dortmund)
 *
 * Login for all demo users: <username> / demo1234
 */

import Database from 'better-sqlite3-multiple-ciphers';
import bcrypt from 'bcrypt';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLoanSchedule } from '../server/services/loan-amortization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx !== -1 ? args[dbIdx + 1] : resolve(__dirname, '..', 'yuvomi.db');

// ── Locale ───────────────────────────────────────────────────────────────────
// Der Demo-Inhalt existiert in zwei Sprachen: die Screenshots zeigen entweder
// eine englische App mit englischem Inhalt oder eine deutsche mit deutschem.
// `L(en, de)` wählt pro String - die Paarung steht damit an Ort und Stelle und
// kann nicht, wie bei zwei getrennten Datenblöcken, gegeneinander verrutschen.
// Default bleibt `en`: das ist der kanonische Screenshot-Satz.
const localeIdx = args.indexOf('--locale');
const LOCALE = (localeIdx !== -1 ? String(args[localeIdx + 1] || '') : 'en').toLowerCase();
if (!['en', 'de'].includes(LOCALE)) {
  console.error(`Unknown locale "${LOCALE}" — expected "en" or "de".`);
  process.exit(1);
}
const L = (en, de) => (LOCALE === 'de' ? de : en);

console.log(`Locale: ${LOCALE}`);

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

// Tage bis zum Montag DIESER Woche (0 = heute ist Montag, -6 = heute ist Sonntag).
// Der Essensplan zeigt immer Mo-So; ein Plan, der wie alles andere relativ zu
// „heute" liegt, ist an jedem Tag außer Montag angeschnitten - an einem Sonntag
// standen fünf von sieben Spalten leer.
function mondayOffset() {
  const day = new Date().getDay(); // 0 = Sonntag
  return day === 0 ? -6 : 1 - day;
}

/** Datum des i-ten Wochentags dieser Woche. i: 0 = Montag … 6 = Sonntag. */
function weekDayKey(i) {
  return daysFromNow(mondayOffset() + i);
}

// ── Wipe existing data (keep category/migration tables) ──────────────────────

console.log('Clearing existing data…');
db.pragma('foreign_keys = OFF');
const WIPE = [
  'search_index',
  'shopping_item_tags', 'shopping_items', 'shopping_lists',
  'budget_entry_attachments',
  'budget_loan_payments', 'budget_loans', 'budget_recurrence_skipped', 'budget_entries',
  'budget_plans', 'budget_accounts',
  'contact_phones', 'contact_emails', 'contact_addresses', 'contacts',
  'notes',
  'meal_recurrence_ingredients', 'meal_recurrence_exceptions', 'meal_recurrence_templates',
  'meal_ingredients', 'meals', 'recipe_ingredients', 'recipes',
  // Nur der Bestand, NICHT pantry_locations: die Lagerorte sind Referenzdaten
  // aus der Migration (wie shopping_categories, das hier ebenfalls fehlt).
  // Sie zu leeren ließ den Haushalt ohne einen einzigen Lagerort zurück -
  // niemand legt sie danach wieder an.
  'pantry_items',
  // inventory_item_documents haengt per CASCADE an inventory_items, steht aber
  // bewusst zuerst: foreign_keys ist hier aus, CASCADE greift also nicht.
  // inventory_categories fehlt aus demselben Grund wie pantry_locations und
  // shopping_categories - es ist Referenzdatum aus Migration 145, nicht Demo-Inhalt.
  // inventory_locations dagegen legt keine Migration an, die kommen aus diesem Seed.
  'inventory_item_documents', 'inventory_items', 'inventory_locations',
  'reminders',
  'event_assignments', 'task_assignments', 'task_tags', 'task_documents', 'calendar_events', 'tasks',
  'birthdays',
  'expense_activity', 'settlement_entries', 'settlements', 'recurring_expenses',
  'expense_attachments', 'expense_comments', 'expense_ledger_entries', 'expense_splits',
  'expenses', 'expense_group_members', 'split_expense_guest_users', 'expense_groups',
  'housekeeping_work_sessions', 'housekeeping_decay_tasks', 'housekeeping_supply_requests',
  'housekeeping_maintenance_log', 'housekeeping_workers',
  'family_document_access', 'family_documents', 'family_document_folders',
  'health_care_grants',
  'health_vitals', 'health_activities', 'health_lab_results', 'health_lab_reports',
  'medication_logs', 'medication_schedules', 'medications',
  'cycle_day_logs', 'cycle_periods', 'cycle_settings',
  'reward_ledger', 'reward_redemptions', 'reward_participants', 'reward_catalog',
  'budget_subscriptions',
  'users',
];
const wipe = db.transaction(() => {
  for (const t of WIPE) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (e) { /* table may not exist */ }
  }
  // sqlite_sequence existiert erst, wenn je eine AUTOINCREMENT-Tabelle Daten
  // hatte - auf einer frisch migrierten DB fehlt sie und der Seed bräche hier.
  try { db.prepare("DELETE FROM sqlite_sequence").run(); } catch (e) { /* fresh db */ }
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
// Migration 145 schaltet `inventory` ab, weil es sonst in der Navigation JEDES
// Haushalts staende (Diskussion #696). Fuer die Demo gilt das Gegenteil: die
// Landingpage wirbt mit achtzehn Modulen, und ein Modul ohne einen einzigen
// Screenshot ist eines, das der Leser nirgends sehen kann. Der Seed schaltet
// deshalb alles ein - explizit als leere Liste, nicht durch Loeschen des
// Schluessels, damit der Grund am Wert selbst ablesbar bleibt.
cfgSet.run('disabled_modules', '[]');
cfgSet.run('date_format', 'dmy_dot');
cfgSet.run('time_format', '24h');
cfgSet.run('app_name', 'Yuvomi');
cfgSet.run('visible_meal_types', 'breakfast,lunch,dinner,snack');
// Weather widget — Dortmund via Open-Meteo (no API key required)
cfgSet.run('weather_provider', 'open-meteo');
cfgSet.run('weather_lat', '51.5136');
cfgSet.run('weather_lon', '7.4653');
cfgSet.run('weather_city', 'Dortmund');
cfgSet.run('weather_units', 'metric');

// Dashboard-Kacheln: kuratiert statt Vorgabe, aber entlang der Autor-Defaults
// des Seele-Pakets. Das Wetter wohnt seit dem Umbau als Zeile im Masthead -
// die Karte ist Wandtablet-Opt-in und bleibt hier ausgeblendet, sonst zeigte
// jede Demo und jeder Screenshot den Legacy-Pfad OHNE Masthead-Zeile (kein
// Echo: sichtbare Karte schaltet die Zeile stumm). family ist die „Heute
// dran"-Karte und stapelt Mitglieder-Zeilen -> 1x2 wie im Autor-Default.
//
// DIE FUENF KACHELN MUESSEN AUFGEHEN, und sie taten es nicht: budget stand hier
// auf 1x1, waehrend der Autor-Default es (wie jede stapelnde Karte) auf 1x2
// fuehrt. Damit belegten die fuenf zusammen sieben Rasterzellen - bei den vier
// Spalten, die der Desktop-Screenshot (1376px) aufmacht, eine volle Zeile plus
// drei Viertel, und rechts unten blieb genau eine Zelle leer, die `dense` nicht
// mehr schliessen konnte, weil kein Widget mehr uebrig war. Mit budget auf 1x2
// sind es acht Zellen: zwei volle Zeilen, kein Loch. Gemessen am gerenderten
// Raster, nicht am Reissbrett - die Kachelbreiten stehen im CSS, die
// Spaltenzahl aber erst im Fenster.
const dashboardWidgets = [
  { id: 'family',    visible: true,  size: '1x2' },
  { id: 'budget',    visible: true,  size: '1x2' },
  // 1x2 wie der Autor-Default (defaultWidgetSize in public/pages/dashboard.js).
  // Auf 1x1 war die Geburtstagskachel die KURZE Karte einer Rasterzeile - und
  // damit bestimmte SIE die Zeilenhoehe, waehrend Familie und Budget daneben
  // ueber zwei Zeilen spannten und je ~200px leer auslaufen mussten. Gemessen
  // bei 1440px: 535px Kachelhoehe fuer 377px Inhalt. Mit drei gleich hohen
  // 1x2-Karten deckt die Zeile sich mit ihrem Inhalt.
  { id: 'birthdays', visible: true,  size: '1x2' },
  // Das Wetter ist per Autor-Default AUS, weil es als Masthead-Zeile unter dem
  // Gruss schon spricht (Seele-Paket, „kein Echo": ist die Karte da, entfaellt
  // die Zeile). Die Demo zeigt trotzdem die Karte - sie ist der Wandtablet-Fall
  // und traegt Ort und Vorhersage, die die Zeile nicht hat.
  //
  // SIE STEHT VOR DEN BEIDEN FLACHEN KARTEN, und das ist eine Anforderung an den
  // SCREENSHOT, nicht ans Layout: der Bildausschnitt ist 1032 logische Pixel
  // hoch, und als letztes Widget lag die Karte darunter - im Bild also gar
  // nicht. Hier faellt sie in die dritte Rasterzeile und damit ins Bild.
  //
  // 2x1, weil breiter nicht geht: `normalizeDashboardConfig` bildet jede Groesse
  // auf eines der vier kuratierten Presets ab (1x1, 1x2, 2x1, 2x2), ein `3x1`
  // im Seed kaeme als `2x1` an.
  { id: 'weather',   visible: true,  size: '2x1' },
  { id: 'rewards',   visible: true,  size: '1x1' },
  { id: 'notes',     visible: true,  size: '2x1' },
  // Ausgeblendet, aber in der Liste: die Reihenfolge bleibt stabil, wenn ein
  // Haushalt sie im Anpassen-Modus wieder einblendet. tasks/calendar/shopping/
  // meals deckt das „Heute"-Cockpit oben bereits ab - doppelt gezeigt wäre Echo.
  { id: 'tasks',        visible: false, size: '1x2' },
  { id: 'calendar',     visible: false, size: '1x2' },
  { id: 'shopping',     visible: false, size: '2x1' },
  { id: 'meals',        visible: false, size: '2x1' },
  { id: 'housekeeping', visible: false, size: '1x1' },
  { id: 'health',       visible: false, size: '2x1' },
  { id: 'cycle',        visible: false, size: '2x1' },
].map((w, order) => ({ ...w, order }));
cfgSet.run('dashboard_widgets', JSON.stringify(dashboardWidgets));

// Einkaufskategorien sind freie Namen (kein label_key) - im Deutschen stehen die
// Migrationsvorgaben schon richtig, für Englisch werden sie an Ort und Stelle
// umbenannt. CAT ist danach die EINZIGE Quelle für diese Namen: Einkaufszettel,
// Rezeptzutaten, Mahlzeiten-Zutaten und Vorrat schreiben denselben String, sonst
// landen Positionen in einer Kategorie, die es in der Liste nicht gibt.
const CAT = {
  produce:   L('Fruit & Veg',      'Obst & Gemüse'),
  bakery:    L('Bakery',           'Backwaren'),
  dairy:     L('Dairy',            'Milchprodukte'),
  meat:      L('Meat & Fish',      'Fleisch & Fisch'),
  frozen:    L('Frozen',           'Tiefkühl'),
  drinks:    L('Drinks',           'Getränke'),
  household: L('Household',        'Haushalt'),
  beauty:    L('Health & Beauty',  'Drogerie'),
  other:     L('Other',            'Sonstiges'),
};
if (LOCALE === 'en') {
  console.log('Renaming shopping categories to English…');
  const renameCat = db.prepare('UPDATE shopping_categories SET name = ? WHERE id = ?');
  [
    [1, CAT.produce], [2, CAT.bakery], [3, CAT.dairy], [4, CAT.meat],
    [5, CAT.frozen], [6, CAT.drinks], [7, CAT.household], [8, CAT.beauty], [9, CAT.other],
  ].forEach(([id, name]) => renameCat.run(name, id));
}

// Lagerorte des Vorrats — dieselbe Lage wie die Einkaufskategorien: freie Namen
// aus der Migration, deutsch vorbelegt.
const LOC = {
  pantry:  L('Pantry cupboard', 'Vorratsschrank'),
  fridge:  L('Fridge',          'Kühlschrank'),
  freezer: L('Freezer',         'Gefrierschrank'),
  cellar:  L('Cellar',          'Keller'),
  other:   L('Other',           'Sonstiges'),
};
if (LOCALE === 'en') {
  console.log('Renaming pantry locations to English…');
  const renameLoc = db.prepare('UPDATE pantry_locations SET name = ? WHERE id = ?');
  [[1, LOC.pantry], [2, LOC.fridge], [3, LOC.freezer], [4, LOC.cellar], [5, LOC.other]]
    .forEach(([id, name]) => renameLoc.run(name, id));
}

// Einnahmekategorien: `key` ist der deutsche Bestandsschlüssel (Migration),
// `name` der angezeigte Text. Nur der Name wird übersetzt, nie der Key - die
// Buchungen unten referenzieren ihn.
if (LOCALE === 'en') {
  console.log('Localising budget income categories…');
  const renameBudgetCat = db.prepare('UPDATE budget_categories SET name = ? WHERE key = ?');
  [
    ['Erwerbseinkommen', 'Salary & Wages'],
    ['Kapitalerträge', 'Investment Income'],
    ['Geschenke & Transfers', 'Gifts & Transfers'],
    ['Sozialleistungen', 'Benefits'],
    ['Sonstiges Einkommen', 'Other Income'],
  ].forEach(([key, name]) => renameBudgetCat.run(name, key));
}

// ── Users ────────────────────────────────────────────────────────────────────

console.log('Creating users…');
const pw = bcrypt.hashSync('demo1234', 12);
const insertUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role, avatar_color)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const alexId  = insertUser.run('alex',  'Alex Johnson',  pw, 'admin',  'dad',   '#2563EB').lastInsertRowid;
const lindaId   = insertUser.run('linda', 'Linda Johnson', pw, 'admin',  'mom',   '#DB2777').lastInsertRowid;
const emmaId  = insertUser.run('emma',  'Emma Johnson',  pw, 'member', 'child', '#EC4899').lastInsertRowid;
const leoId   = insertUser.run('leo',   'Leo Johnson',   pw, 'member', 'child', '#F97316').lastInsertRowid;
const mariaId = insertUser.run('maria', 'Maria Silva',   pw, 'member', 'other', '#7C3AED').lastInsertRowid;
console.log(`  alex=${alexId} linda=${lindaId} emma=${emmaId} leo=${leoId} maria=${mariaId}`);

// ── Tasks ────────────────────────────────────────────────────────────────────

console.log('Inserting tasks…');
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, category, priority, status, start_date, due_date, assigned_to, created_by)
  VALUES (@title, @description, @category, @priority, @status, @start_date, @due_date, @assigned_to, @created_by)
`);
const insertTaskAssign = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
// Tags sind eine eigene n:m-Achse neben der Kategorie (#586). tag_key ist die
// normalisierte Form, unter der die UI zusammenfasst - dieselbe Regel wie im
// Route-Handler: getrimmt und kleingeschrieben.
const insertTaskTag = db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag, tag_key) VALUES (?, ?, ?)');
const tagKey = (tag) => tag.trim().toLowerCase();

const TAG = {
  urgent:   L('urgent',    'dringend'),
  car:      L('car',       'auto'),
  school:   L('school',    'schule'),
  holiday:  L('holiday',   'urlaub'),
  paperwork:L('paperwork', 'papierkram'),
  kids:     L('kids',      'kinder'),
  garden:   L('garden',    'garten'),
};

const tasks = [
  [L('Book dentist appointment',    'Zahnarzttermin vereinbaren'),       L('Annual check-up for the whole family',  'Jahreskontrolle für die ganze Familie'), 'health',    'high',   'open',        null,            daysFromNow(3),  alexId, alexId, [alexId],          []],
  [L('Pay electricity bill',        'Stromrechnung bezahlen'),           L('Due end of month — online banking',     'Fällig zum Monatsende — Online-Banking'), 'finance',   'urgent', 'open',        null,            daysFromNow(2),  alexId, alexId, [alexId],          [TAG.urgent, TAG.paperwork]],
  [L('Renew car insurance',         'Kfz-Versicherung verlängern'),      L('Compare quotes first',                  'Vorher Angebote vergleichen'),            'finance',   'high',   'open',        null,            daysFromNow(10), alexId, alexId, [alexId],          [TAG.car, TAG.paperwork]],
  [L('Fix leaking bathroom faucet', 'Tropfenden Wasserhahn reparieren'), L('Replace washer, tools in the basement', 'Dichtung tauschen, Werkzeug im Keller'),  'repair',    'medium', 'open',        null,            daysFromNow(7),  lindaId, alexId, [lindaId],         []],
  [L('Order birthday cake',         'Geburtstagstorte bestellen'),       L("Emma's birthday — chocolate cake",      'Emmas Geburtstag — Schokoladentorte'),    'household', 'high',   'open',        null,            daysFromNow(5),  lindaId, lindaId, [lindaId],        [TAG.kids]],
  [L('Clean out the garage',        'Garage ausmisten'),                 L('Donate old things to charity',          'Altes an die Kleiderkammer spenden'),     'household', 'low',    'open',        daysFromNow(7),  daysFromNow(14), alexId, alexId, [alexId, lindaId], []],
  [L('Sign school permission slip', 'Einverständnis für Schulausflug'),  L('Field trip to the science museum',      'Ausflug ins Naturkundemuseum'),           'school',    'urgent', 'open',        null,            daysFromNow(1),  lindaId, lindaId, [lindaId],        [TAG.urgent, TAG.school]],
  [L('Renew library cards',         'Büchereiausweise verlängern'),      L('All three cards expired last month',    'Alle drei sind letzten Monat abgelaufen'),'household', 'low',    'open',        null,            daysFromNow(20), alexId, alexId, [alexId],          []],
  [L('Plan summer holiday',         'Sommerurlaub planen'),              L('Italy or Croatia — check flights',      'Italien oder Kroatien — Flüge prüfen'),   'leisure',   'medium', 'open',        daysFromNow(3),  daysFromNow(30), alexId, alexId, [alexId, lindaId], [TAG.holiday]],
  [L('Tax return 2025',             'Steuererklärung 2025'),             L('Documents ready in the folder',         'Unterlagen liegen im Ordner bereit'),     'finance',   'high',   'in_progress', null,            daysFromNow(18), alexId, alexId, [alexId],          [TAG.paperwork]],
  [L('Tidy bedroom',                'Kinderzimmer aufräumen'),           L('Put away laundry & toys',               'Wäsche und Spielzeug wegräumen'),         'household', 'low',    'open',        null,            daysFromNow(1),  emmaId, lindaId, [emmaId],          [TAG.kids]],
  [L('Practice piano',              'Klavier üben'),                     L('20 minutes — recital piece',            '20 Minuten — Stück fürs Vorspiel'),       'school',    'medium', 'open',        null,            daysFromNow(2),  leoId,  lindaId, [leoId],           [TAG.kids, TAG.school]],
  [L('Grocery run',                 'Wocheneinkauf erledigen'),          L('See the shopping list for details',     'Details stehen auf dem Einkaufszettel'),  'shopping',  'medium', 'done',        null,            daysFromNow(-1), lindaId, lindaId, [lindaId],        []],
  [L('Call insurance about claim',  'Versicherung wegen Schaden anrufen'),L('Reference: CLM-2025-0492',             'Vorgang: CLM-2025-0492'),                 'finance',   'high',   'done',        null,            daysFromNow(-3), alexId, alexId, [alexId],          [TAG.paperwork]],
  [L('Oil change — VW Golf',        'Ölwechsel — VW Golf'),              L('Every 15,000 km / 12 months',           'Alle 15.000 km / 12 Monate'),             'repair',    'medium', 'open',        null,            daysFromNow(6),  alexId, alexId, [alexId],          [TAG.car]],
  [L('Buy birthday gift for Mum',   'Geburtstagsgeschenk für Mama'),     L('Book voucher or wishlist item',         'Buchgutschein oder von der Wunschliste'), 'shopping',  'medium', 'open',        null,            daysFromNow(8),  lindaId, lindaId, [lindaId],        []],
  [L('Water the plants',            'Pflanzen gießen'),                  L('Indoor plants + balcony herbs',         'Zimmerpflanzen + Kräuter auf dem Balkon'),'household', 'none',   'done',        null,            daysFromNow(-2), leoId,  lindaId, [leoId],           [TAG.kids, TAG.garden]],
];
const taskIdByTitle = {};
for (const [title, description, category, priority, status, start_date, due_date, assigned_to, created_by, assignees, tags] of tasks) {
  const id = insertTask.run({ title, description, category, priority, status, start_date, due_date, assigned_to, created_by }).lastInsertRowid;
  taskIdByTitle[title] = id;
  for (const u of assignees) insertTaskAssign.run(id, u);
  for (const tag of tags) insertTaskTag.run(id, tag, tagKey(tag));
}
// Point values on the children's chores (drives the Rewards module)
const setTaskPoints = db.prepare('UPDATE tasks SET points = ? WHERE id = ?');
[
  [L('Tidy bedroom',   'Kinderzimmer aufräumen'), 10],
  [L('Practice piano', 'Klavier üben'),           15],
  [L('Water the plants', 'Pflanzen gießen'),       5],
].forEach(([title, p]) => setTaskPoints.run(p, taskIdByTitle[title]));

// ── Calendar Events ──────────────────────────────────────────────────────────

console.log('Inserting calendar events…');
const insertEvent = db.prepare(`
  INSERT INTO calendar_events (title, description, start_datetime, end_datetime, all_day, location, color, icon, recurrence_rule, assigned_to, created_by)
  VALUES (@title, @description, @start, @end, @all_day, @location, @color, @icon, @rrule, @assigned_to, @created_by)
`);
const insertEventAssign = db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)');

const events = [
  [L("Emma's Birthday Party",     'Emmas Geburtstagsfeier'),   L('Bouncy castle & cake at home',       'Hüpfburg und Kuchen zu Hause'),         daysFromNow(5) + 'T14:00',  daysFromNow(5) + 'T17:00',  0, L('Home', 'Zu Hause'),                           '#F59E0B', 'cake',     null,                      lindaId, lindaId, [lindaId, emmaId]],
  [L('Dentist — Family',          'Zahnarzt — Familie'),       L('Dr. Müller, bring insurance cards',  'Dr. Müller, Versichertenkarten mitnehmen'), daysFromNow(3) + 'T10:00', daysFromNow(3) + 'T11:30', 0, L('Dental Practice Müller', 'Zahnarztpraxis Müller'), '#EF4444', 'tooth', null,                lindaId, alexId, [alexId, lindaId, emmaId, leoId]],
  [L('Parent–Teacher Evening',    'Elternabend'),              L('Room 12, bring the report card',     'Raum 12, Zeugnis mitbringen'),          daysFromNow(9) + 'T18:30',  daysFromNow(9) + 'T20:00',  0, L('Westpark Primary School', 'Grundschule Westpark'), '#8B5CF6', 'calendar', null,               lindaId, lindaId, [lindaId, alexId]],
  [L('Science Museum Field Trip', 'Ausflug ins Naturkundemuseum'), L('Emma — permission slip signed',  'Emma — Einverständnis unterschrieben'), daysFromNow(1) + 'T08:30',  daysFromNow(1) + 'T15:00',  0, L('Natural History Museum', 'Naturkundemuseum'),  '#06B6D4', 'calendar', null,                      emmaId, lindaId, [emmaId]],
  [L("Family BBQ at Grandma's",   'Grillen bei Oma'),          L('Bring potato salad',                 'Kartoffelsalat mitbringen'),            daysFromNow(12) + 'T13:00', daysFromNow(12) + 'T19:00', 0, L("Grandma's Garden", 'Omas Garten'),            '#F59E0B', 'calendar', null,                      alexId, alexId, [alexId, lindaId, emmaId, leoId]],
  [L('Car Service Appointment',   'Werkstatttermin'),          L('VW Golf — oil change + tyre check',  'VW Golf — Ölwechsel + Reifencheck'),    daysFromNow(6) + 'T09:00',  daysFromNow(6) + 'T10:30',  0, 'AutoHaus König',                                '#6B7280', 'calendar', null,                      alexId, alexId, [alexId]],
  [L('Yoga Class',                'Yoga-Kurs'),                L('Weekly — bring a mat',               'Wöchentlich — Matte mitbringen'),       daysFromNow(2) + 'T19:00',  daysFromNow(2) + 'T20:00',  0, 'FitLife Studio',                                '#10B981', 'calendar', 'FREQ=WEEKLY;BYDAY=TU',    lindaId, lindaId, [lindaId]],
  [L("Mum's Birthday",            'Mamas Geburtstag'),         '',                                                                              daysFromNow(8) + 'T00:00',  daysFromNow(8) + 'T00:00',  1, '',                                              '#EC4899', 'cake',     null,                      alexId, alexId, [alexId, lindaId]],
  [L('Company All-Hands',         'Betriebsversammlung'),      L('Q2 results + roadmap presentation',  'Quartalszahlen + Roadmap-Vorstellung'), daysFromNow(4) + 'T10:00',  daysFromNow(4) + 'T12:00',  0, L('Office — Conference Room B', 'Büro — Besprechungsraum B'), '#2563EB', 'calendar', null,          alexId, alexId, [alexId]],
  [L('Football Training — Leo',   'Fußballtraining — Leo'),    L('Boots & water bottle',               'Schuhe und Trinkflasche'),              daysFromNow(2) + 'T17:00',  daysFromNow(2) + 'T18:30',  0, L('Sports Ground West', 'Sportplatz West'),      '#F97316', 'calendar', 'FREQ=WEEKLY;BYDAY=TU,SA', leoId, lindaId, [leoId]],
  [L('Piano Lesson — Leo',        'Klavierstunde — Leo'),      L('Weekly lesson with Ms. Klein',       'Wöchentlich bei Frau Klein'),           daysFromNow(3) + 'T16:00',  daysFromNow(3) + 'T16:45',  0, L('Music School Dortmund', 'Musikschule Dortmund'), '#8B5CF6', 'calendar', 'FREQ=WEEKLY;BYDAY=TH', leoId, lindaId, [leoId]],
  [L('Holiday Planning Evening',  'Urlaubsplanung'),           L('Italy vs Croatia — laptops out',     'Italien oder Kroatien — Laptops raus'), daysFromNow(3) + 'T21:00',  daysFromNow(3) + 'T22:00',  0, L('Home', 'Zu Hause'),                           '#14B8A6', 'calendar', null,                      alexId, lindaId, [alexId, lindaId]],
  [L('GP Appointment — Alex',     'Hausarzttermin — Alex'),    L('Annual health check',                'Jährlicher Gesundheits-Check'),         daysFromNow(15) + 'T11:00', daysFromNow(15) + 'T11:30', 0, L('Dr. Weber — City Practice', 'Dr. Weber — Praxis am Markt'), '#EF4444', 'stethoscope', null,   alexId, alexId, [alexId]],
  [L('Weekend City Break',        'Städtereise übers Wochenende'), L('Hotel booked — just pack the bags!', 'Hotel gebucht — nur noch packen!'), daysFromNow(20) + 'T00:00', daysFromNow(22) + 'T00:00', 1, 'Amsterdam',                                     '#0EA5E9', 'plane',    null,                      alexId, alexId, [alexId, lindaId]],
  [L('Swimming — Emma',           'Schwimmen — Emma'),         L('Westbad — goggles & towel',          'Westbad — Brille und Handtuch'),        daysFromNow(4) + 'T16:00',  daysFromNow(4) + 'T17:00',  0, L('Westbad Pool', 'Westbad'),                    '#06B6D4', 'calendar', 'FREQ=WEEKLY;BYDAY=FR',    emmaId, lindaId, [emmaId]],
];
const eventIdByTitle = {};
for (const [title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by, assignees] of events) {
  const id = insertEvent.run({ title, description, start, end, all_day, location, color, icon, rrule, assigned_to, created_by }).lastInsertRowid;
  eventIdByTitle[title] = id;
  for (const u of assignees) insertEventAssign.run(id, u);
}

// ── Recipes ──────────────────────────────────────────────────────────────────

console.log('Inserting recipes…');
const insertRecipe = db.prepare('INSERT INTO recipes (title, notes, recipe_url, created_by) VALUES (?, ?, ?, ?)');
const insertRecipeIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, ?, ?, ?)');
const recipes = [
  [L('Spaghetti Bolognese', 'Spaghetti Bolognese'), L('Family favourite — simmer the sauce for at least 45 minutes for the best flavour.', 'Familienklassiker — die Soße mindestens 45 Minuten ziehen lassen.'), 'https://www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe', [
    [L('Spaghetti', 'Spaghetti'), '500 g', CAT.other], [L('Minced beef', 'Rinderhack'), '500 g', CAT.meat], [L('Onion', 'Zwiebel'), '1', CAT.produce],
    [L('Garlic', 'Knoblauch'), L('2 cloves', '2 Zehen'), CAT.produce], [L('Tomato passata', 'Passierte Tomaten'), '700 g', CAT.other], [L('Parmesan', 'Parmesan'), '50 g', CAT.dairy],
  ]],
  [L('Chicken Tikka Masala', 'Chicken Tikka Masala'), L('Marinate the chicken overnight if you can. Serve with basmati rice and naan.', 'Das Hähnchen möglichst über Nacht marinieren. Dazu Basmatireis und Naan.'), 'https://www.bbcgoodfood.com/recipes/chicken-tikka-masala', [
    [L('Chicken breast', 'Hähnchenbrust'), '600 g', CAT.meat], [L('Natural yoghurt', 'Naturjoghurt'), '200 g', CAT.dairy], [L('Tikka paste', 'Tikka-Paste'), L('3 tbsp', '3 EL'), CAT.other],
    [L('Double cream', 'Sahne'), '150 ml', CAT.dairy], [L('Basmati rice', 'Basmatireis'), '300 g', CAT.other], [L('Fresh coriander', 'Frischer Koriander'), L('1 bunch', '1 Bund'), CAT.produce],
  ]],
  [L('Homemade Pizza', 'Pizza selbst gemacht'), L("Emma's favourite night! Let the dough rise for two hours.", 'Emmas Lieblingsabend! Den Teig zwei Stunden gehen lassen.'), null, [
    [L('Pizza flour', 'Pizzamehl'), '500 g', CAT.other], [L('Fresh yeast', 'Frische Hefe'), '7 g', CAT.other], [L('Mozzarella', 'Mozzarella'), '250 g', CAT.dairy],
    [L('Tomato sauce', 'Tomatensoße'), '200 g', CAT.other], [L('Fresh basil', 'Frisches Basilikum'), L('1 bunch', '1 Bund'), CAT.produce],
  ]],
  [L('Grilled Salmon & Roasted Veg', 'Lachs mit Ofengemüse'), L('Lemon butter sauce ties it all together. Ready in 30 minutes.', 'Die Zitronenbutter hält alles zusammen. In 30 Minuten fertig.'), null, [
    [L('Salmon fillets', 'Lachsfilets'), '4', CAT.meat], [L('Courgette', 'Zucchini'), '2', CAT.produce], [L('Bell peppers', 'Paprika'), '2', CAT.produce],
    [L('Lemon', 'Zitrone'), '1', CAT.produce], [L('Butter', 'Butter'), '50 g', CAT.dairy],
  ]],
  [L('Sunday Roast Chicken', 'Hähnchen aus dem Ofen'), L('Rest the chicken for 15 minutes before carving.', 'Das Hähnchen vor dem Tranchieren 15 Minuten ruhen lassen.'), null, [
    [L('Whole chicken', 'Ganzes Hähnchen'), '1,5 kg', CAT.meat], [L('Potatoes', 'Kartoffeln'), '1 kg', CAT.produce], [L('Carrots', 'Möhren'), '500 g', CAT.produce],
    [L('Rosemary', 'Rosmarin'), L('2 sprigs', '2 Zweige'), CAT.produce], [L('Olive oil', 'Olivenöl'), L('4 tbsp', '4 EL'), CAT.other],
  ]],
  [L('Fluffy Pancakes', 'Fluffige Pancakes'), L('Weekend treat with maple syrup and a blueberry compote.', 'Wochenend-Frühstück mit Ahornsirup und Blaubeerkompott.'), null, [
    [L('Plain flour', 'Mehl'), '200 g', CAT.other], [L('Milk', 'Milch'), '300 ml', CAT.dairy], [L('Eggs', 'Eier'), '2', CAT.dairy],
    [L('Blueberries', 'Blaubeeren'), '125 g', CAT.produce], [L('Maple syrup', 'Ahornsirup'), L('1 bottle', '1 Flasche'), CAT.other],
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

// Erstes Feld = Wochentag dieser Woche (0 = Montag … 6 = Sonntag), NICHT Tage ab
// heute: die Ansicht zeigt immer Mo-So, ein relativ geplanter Satz wäre an sechs
// von sieben Wochentagen angeschnitten. Der Freitagabend (Index 4) fehlt hier
// bewusst - den bespielt die Serie weiter unten.
const STIR_FRY = L('Beef stir-fry', 'Rindfleisch-Pfanne');
const mealPlan = [
  [ 0, 'breakfast', L('Scrambled eggs & toast',      'Rührei mit Toast'),            L('With smoked salmon',        'Mit Räucherlachs')],
  [ 0, 'lunch',     L('Tomato soup',                 'Tomatensuppe'),                L('Served with sourdough bread','Dazu Sauerteigbrot')],
  [ 0, 'dinner',    L('Spaghetti Bolognese',         'Spaghetti Bolognese'),         L('Kids loved it',             'Kam bei den Kindern super an')],
  [ 0, 'snack',     L('Apple slices & peanut butter','Apfelspalten mit Erdnussmus'), ''],
  [ 1, 'breakfast', L('Overnight oats',              'Overnight Oats'),              L('Blueberries & honey',       'Blaubeeren und Honig')],
  [ 1, 'lunch',     L('Caesar salad with chicken',   'Caesar Salat mit Hähnchen'),   L('Homemade dressing',         'Dressing selbst gemacht')],
  [ 1, 'dinner',    L('Grilled Salmon & Roasted Veg','Lachs mit Ofengemüse'),        L('Lemon butter sauce',        'Mit Zitronenbutter')],
  [ 1, 'snack',     L('Hummus with carrot sticks',   'Hummus mit Möhrensticks'),     ''],
  [ 2, 'breakfast', L('Avocado toast',               'Avocadobrot'),                 L('Poached eggs on top',       'Mit pochiertem Ei')],
  [ 2, 'lunch',     L('Lentil soup',                 'Linsensuppe'),                 L('With crusty bread',         'Mit knusprigem Brot')],
  [ 2, 'dinner',    L('Chicken Tikka Masala',        'Chicken Tikka Masala'),        L('Basmati rice & naan',       'Basmatireis und Naan')],
  [ 2, 'snack',     L('Yoghurt & granola',           'Joghurt mit Granola'),         ''],
  [ 3, 'breakfast', L('Fluffy Pancakes',             'Fluffige Pancakes'),           L('Blueberry compote',         'Blaubeerkompott')],
  [ 3, 'lunch',     L('Greek salad & pita',          'Griechischer Salat mit Pita'), L('Extra feta',                'Extra Feta')],
  [ 3, 'dinner',    STIR_FRY,                                                        L('Jasmine rice, pak choi',    'Jasminreis, Pak Choi')],
  [ 4, 'breakfast', L('Porridge with banana',        'Porridge mit Banane'),         L('Cinnamon & honey',          'Zimt und Honig')],
  [ 4, 'lunch',     L('Tuna melt sandwich',          'Überbackenes Thunfischbrot'),  L('Toasted ciabatta',          'Getoastetes Ciabatta')],
  [ 4, 'snack',     L('Fruit salad',                 'Obstsalat'),                   ''],
  [ 5, 'breakfast', L('French toast',                'Arme Ritter'),                 L('Powdered sugar & berries',  'Puderzucker und Beeren')],
  [ 5, 'lunch',     L('BLT sandwich',                'BLT-Sandwich'),                L('Wholemeal bread',           'Vollkornbrot')],
  [ 5, 'dinner',    L('Sunday Roast Chicken',        'Hähnchen aus dem Ofen'),       L('For the whole family',      'Für die ganze Familie')],
  [ 5, 'snack',     L('Yoghurt & granola',           'Joghurt mit Granola'),         ''],
  [ 6, 'breakfast', L('Smoothie bowl',               'Smoothie Bowl'),               L('Banana, chia seeds',        'Banane, Chiasamen')],
  [ 6, 'lunch',     L('Caprese salad & focaccia',    'Caprese mit Focaccia'),        L('Fresh basil',               'Frisches Basilikum')],
  [ 6, 'dinner',    L('Lamb chops & couscous',       'Lammkoteletts mit Couscous'),  L('Mint yoghurt dressing',     'Minzjoghurt-Dressing')],
  [ 6, 'snack',     L('Fruit salad',                 'Obstsalat'),                   ''],
];
for (const [weekday, type, title, notes] of mealPlan) {
  const recipeId = recipeIdByTitle[title] ?? null;
  const mid = insertMeal.run(weekDayKey(weekday), type, title, notes, recipeId, alexId).lastInsertRowid;
  // A couple of upcoming dinners get a few ingredients to populate the kitchen view
  if (title === STIR_FRY) {
    [
      [L('Beef strips', 'Rinderstreifen'), '400 g', CAT.meat],
      [L('Pak choi', 'Pak Choi'), '2', CAT.produce],
      [L('Jasmine rice', 'Jasminreis'), '300 g', CAT.other],
      [L('Soy sauce', 'Sojasoße'), L('1 bottle', '1 Flasche'), CAT.other],
    ].forEach(([n, q, c]) => insertMealIng.run(mid, n, q, c, 0));
  }
}

// Wiederkehrende Mahlzeit: der Freitagabend liegt fest. Ohne eine einzige Serie
// zeigte der Essensplan das Feature nie - es ist der Unterschied zwischen einer
// Wochenliste und einem Plan. weekday zählt 0 = Montag (meals.js:18), Freitag = 4.
// Die Mahlzeiten selbst legt der Server beim ersten Laden der Woche an.
console.log('Inserting recurring meal template…');
const pizzaTitle = L('Homemade Pizza', 'Pizza selbst gemacht');
const pizzaTemplateId = db.prepare(`
  INSERT INTO meal_recurrence_templates (start_date, weekday, meal_type, title, notes, recipe_id, created_by)
  VALUES (?, 4, 'dinner', ?, ?, ?, ?)
`).run(
  daysFromNow(-56), pizzaTitle,
  L('Pizza night — every Friday', 'Pizzaabend — jeden Freitag'),
  recipeIdByTitle[pizzaTitle] ?? null, alexId,
).lastInsertRowid;
const insertTemplateIng = db.prepare(`
  INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category) VALUES (?, ?, ?, ?)
`);
[
  [L('Pizza flour', 'Pizzamehl'), '500 g', CAT.other],
  [L('Mozzarella', 'Mozzarella'), '250 g', CAT.dairy],
  [L('Tomato sauce', 'Tomatensoße'), '200 g', CAT.other],
].forEach(([n, q, c]) => insertTemplateIng.run(pizzaTemplateId, n, q, c));

// ── Shopping List ─────────────────────────────────────────────────────────────

console.log('Inserting shopping list…');
const listId = db.prepare('INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)')
  .run(L('Weekly Shop', 'Wocheneinkauf'), alexId).lastInsertRowid;
const insertItem = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, category, is_checked) VALUES (?, ?, ?, ?, ?)');
const insertItemTag = db.prepare('INSERT OR IGNORE INTO shopping_item_tags (item_id, tag, tag_key) VALUES (?, ?, ?)');
const TAG_ORGANIC = L('organic', 'bio');
const TAG_OFFER   = L('offer',   'angebot');
[
  [L('Whole milk',          'Vollmilch'),        '2 l',                    CAT.dairy,     0, [TAG_ORGANIC]],
  [L('Greek yoghurt',       'Griechischer Joghurt'), '500 g',              CAT.dairy,     0, []],
  [L('Cheddar cheese',      'Cheddar'),          '300 g',                  CAT.dairy,     0, []],
  [L('Free-range eggs',     'Freilandeier'),     '12',                     CAT.dairy,     0, [TAG_ORGANIC]],
  [L('Sourdough bread',     'Sauerteigbrot'),    L('1 loaf', '1 Laib'),    CAT.bakery,    0, []],
  [L('Wholemeal bread',     'Vollkornbrot'),     L('1 loaf', '1 Laib'),    CAT.bakery,    0, []],
  [L('Croissants',          'Croissants'),       '4',                      CAT.bakery,    0, []],
  [L('Chicken breast',      'Hähnchenbrust'),    '800 g',                  CAT.meat,      0, []],
  [L('Minced beef',         'Rinderhack'),       '500 g',                  CAT.meat,      0, [TAG_OFFER]],
  [L('Salmon fillets',      'Lachsfilets'),      '2',                      CAT.meat,      0, []],
  [L('Smoked salmon',       'Räucherlachs'),     '100 g',                  CAT.meat,      1, []],
  [L('Frozen peas',         'Tiefkühlerbsen'),   '1 kg',                   CAT.frozen,    0, []],
  [L('Fish fingers',        'Fischstäbchen'),    L('1 box', '1 Packung'),  CAT.frozen,    0, []],
  [L('Broccoli',            'Brokkoli'),         L('1 head', '1 Kopf'),    CAT.produce,   0, []],
  [L('Cherry tomatoes',     'Kirschtomaten'),    '250 g',                  CAT.produce,   0, []],
  [L('Avocados',            'Avocados'),         '3',                      CAT.produce,   0, []],
  [L('Baby spinach',        'Babyspinat'),       '150 g',                  CAT.produce,   1, []],
  [L('Bananas',             'Bananen'),          '6',                      CAT.produce,   0, [TAG_ORGANIC]],
  [L('Blueberries',         'Blaubeeren'),       '125 g',                  CAT.produce,   0, []],
  [L('Lemons',              'Zitronen'),         '4',                      CAT.produce,   0, []],
  [L('Orange juice',        'Orangensaft'),      '1 l',                    CAT.drinks,    0, []],
  [L('Sparkling water',     'Sprudelwasser'),    '6 × 1 l',                CAT.drinks,    1, [TAG_OFFER]],
  [L('Washing-up liquid',   'Spülmittel'),       '1',                      CAT.household, 0, []],
  [L('Kitchen roll',        'Küchenrolle'),      L('4 pack', '4er-Pack'),  CAT.household, 0, []],
  [L("Children's vitamins", 'Kindervitamine'),   L('1 pack', '1 Packung'), CAT.beauty,    0, []],
  [L('Toothpaste',          'Zahnpasta'),        '2',                      CAT.beauty,    0, []],
].forEach(([name, qty, cat, checked, tags]) => {
  const itemId = insertItem.run(listId, name, qty, cat, checked).lastInsertRowid;
  for (const tag of tags) insertItemTag.run(itemId, tag, tagKey(tag));
});

// ── Pantry ────────────────────────────────────────────────────────────────────
// Der Vorrat schließt den Küchen-Kreislauf (planen → kochen → einkaufen →
// lagern). Er braucht drei Zustände, sonst zeigen die Filter ins Leere:
// haltbar, bald ablaufend und unter Mindestbestand.

console.log('Inserting pantry stock…');
const locId = Object.fromEntries(
  db.prepare('SELECT id, name FROM pantry_locations').all().map((r) => [r.name, r.id])
);
const insertPantry = db.prepare(`
  INSERT INTO pantry_items (name, quantity, unit, location_id, category, expires_on, min_quantity, notes, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// unit MUSS aus PANTRY_UNITS stammen (public/utils/pantry-units.js) - alles
// andere fällt beim Speichern still auf 'pcs' zurück.
[
  // name, qty, unit, location, category, expires in days (null = unbegrenzt), min, note
  [L('Spaghetti',        'Spaghetti'),            3,   'pkg',    LOC.pantry,  CAT.other,     240,  2,    null],
  [L('Passata',          'Passierte Tomaten'),    4,   'can',    LOC.pantry,  CAT.other,     300,  2,    null],
  [L('Basmati rice',     'Basmatireis'),          1.5, 'kg',     LOC.pantry,  CAT.other,     400,  1,    null],
  [L('Olive oil',        'Olivenöl'),             1,   'bottle', LOC.pantry,  CAT.other,     500,  1,    null],
  [L('Plain flour',      'Mehl'),                 0.5, 'kg',     LOC.pantry,  CAT.other,     180,  1,    L('Running low — pizza night', 'Wird knapp — Pizzaabend')],
  [L('Coffee beans',     'Kaffeebohnen'),         2,   'pkg',    LOC.pantry,  CAT.drinks,    120,  1,    null],
  [L('Tinned chickpeas', 'Kichererbsen'),         6,   'can',    LOC.pantry,  CAT.other,     540,  3,    null],
  [L('Whole milk',       'Vollmilch'),            1,   'l',      LOC.fridge,  CAT.dairy,     3,    2,    null],
  [L('Butter',           'Butter'),               1,   'pcs',    LOC.fridge,  CAT.dairy,     14,   1,    null],
  [L('Greek yoghurt',    'Griechischer Joghurt'), 2,   'jar',    LOC.fridge,  CAT.dairy,     6,    2,    null],
  [L('Parmesan',         'Parmesan'),             1,   'pcs',    LOC.fridge,  CAT.dairy,     21,   1,    null],
  [L('Eggs',             'Eier'),                 8,   'pcs',    LOC.fridge,  CAT.dairy,     11,   6,    null],
  [L('Baby spinach',     'Babyspinat'),           1,   'bag',    LOC.fridge,  CAT.produce,   2,    null, L('Use for the curry', 'Für das Curry verwenden')],
  [L('Frozen peas',      'Tiefkühlerbsen'),       2,   'pkg',    LOC.freezer, CAT.frozen,    365,  1,    null],
  [L('Fish fingers',     'Fischstäbchen'),        1,   'pkg',    LOC.freezer, CAT.frozen,    200,  1,    null],
  [L('Berry mix',        'Beerenmischung'),       3,   'pkg',    LOC.freezer, CAT.frozen,    280,  2,    null],
  [L('Sparkling water',  'Sprudelwasser'),        4,   'bottle', LOC.cellar,  CAT.drinks,    null, 6,    L('Crate in the cellar', 'Kasten steht im Keller')],
  [L('Apple juice',      'Apfelsaft'),            6,   'bottle', LOC.cellar,  CAT.drinks,    150,  4,    null],
  [L('Potatoes',         'Kartoffeln'),           4,   'kg',     LOC.cellar,  CAT.produce,   40,   2,    null],
  [L('Kitchen roll',     'Küchenrolle'),          2,   'pkg',    LOC.other,   CAT.household, null, 2,    null],
  [L('Washing powder',   'Waschmittel'),          1,   'pkg',    LOC.other,   CAT.household, null, 1,    null],
].forEach(([name, qty, unit, loc, cat, expiresInDays, min, note]) =>
  insertPantry.run(name, qty, unit, locId[loc] ?? null, cat,
    expiresInDays === null ? null : daysFromNow(expiresInDays), min, note, alexId));

// ── Contacts ─────────────────────────────────────────────────────────────────

// Die Demo nutzt zwei Kategorien, die der Standardsatz nicht kennt. Sie werden
// hier angelegt, wie ein Haushalt sie anlegen würde - sonst tragen die Kontakte
// Keys ohne Eintrag in contact_categories, und der Bearbeiten-Dialog hätte für
// sie keine Option (das Select fiele stumm auf die erste Kategorie zurück).
console.log('Adding custom contact categories…');
const insertContactCat = db.prepare(`
  INSERT OR IGNORE INTO contact_categories (key, name, label_key, icon, sort_order)
  VALUES (?, ?, NULL, ?, ?)
`);
[
  ['family',   L('Family',   'Familie'),           'heart',     10],
  ['services', L('Services', 'Dienstleistungen'),  'briefcase', 11],
].forEach(row => insertContactCat.run(...row));

console.log('Inserting contacts…');
const insertContact = db.prepare(`
  INSERT INTO contacts (name, category, phone, email, address, notes, organization, job_title)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  ['Dr. Anna Weber',                                          'doctor',   '+49 231 445 2210', 'praxis@dr-weber.de',            'Bürgerstraße 12, Dortmund',    L('GP — appointments Mon–Thu',                 'Hausärztin — Termine Mo–Do'),               L('City Practice', 'Praxis am Markt'),                   L('General Practitioner', 'Allgemeinmedizin')],
  ['Dr. Thomas Müller',                                       'doctor',   '+49 231 887 0034', 'info@zahnarzt-mueller.de',      'Hansastraße 55, Dortmund',     L('Family dentist',                            'Zahnarzt der Familie'),                    L('Dental Practice Müller', 'Zahnarztpraxis Müller'),    L('Dentist', 'Zahnarzt')],
  [L('Grandma & Grandpa Johnson', 'Oma & Opa Johnson'),       'family',   '+49 2304 78 221',  'oma.johnson@gmail.com',         'Ahornweg 4, Castrop-Rauxel',   L("Emma & Leo's grandparents",                 'Emmas und Leos Großeltern'),               null,                                                    null],
  [L('Westpark Primary School', 'Grundschule Westpark'),      'school',   '+49 231 556 8810', 'office@westpark-grundschule.de','Westparkstraße 20, Dortmund',  L("Emma's school — Mrs Bauer is class teacher",'Emmas Schule — Klassenlehrerin Frau Bauer'),L('Westpark Primary School', 'Grundschule Westpark'), null],
  ['AutoHaus König',                                          'services', '+49 231 997 1100', 'service@autohaus-koenig.de',    'Industriestraße 88, Dortmund', L('VW service partner — Ref: Golf TDI 2021',   'VW-Servicepartner — Kunde: Golf TDI 2021'),'AutoHaus König',                                        L('Service Centre', 'Werkstatt')],
  ['FitLife Studio',                                          'services', '+49 231 340 5060', 'hello@fitlife-dortmund.de',     'Rheinlanddamm 14, Dortmund',   L("Linda's yoga — Tuesdays 19:00",             'Lindas Yoga — dienstags 19:00'),           'FitLife Studio',                                        null],
  [L('Uncle Mike Johnson', 'Onkel Mike Johnson'),             'family',   '+49 172 3340 551', 'mike.j@outlook.com',            'Hamburg',                      L("Alex's brother — lives in Hamburg",         'Alex’ Bruder — wohnt in Hamburg'),         null,                                                    null],
  [L('Aunt Claire Becker', 'Tante Claire Becker'),            'family',   '+49 151 2234 8876','claire.becker@web.de',          'Fichtenweg 7, Bochum',         L("Linda's sister",                            'Lindas Schwester'),                        null,                                                    null],
  [L("Leo's Football Coach", 'Leos Fußballtrainer'),          'school',   '+49 176 5512 4490','trainer@svwest-dortmund.de',    'Sportplatz West, Dortmund',    L('Training Tue & Sat 17:00',                  'Training Di und Sa 17:00'),                'SV West Dortmund',                                      L('Coach', 'Trainer')],
  [L('City Library', 'Stadtbibliothek'),                      'services', '+49 231 502 6600', 'stadtbibliothek@dortmund.de',   'Königswall 18, Dortmund',      L('Family cards — renew every 2 years',        'Familienausweise — alle 2 Jahre verlängern'), L('Dortmund City Library', 'Stadtbibliothek Dortmund'), null],
  [L('Landlord — Mr Groß', 'Vermieter — Herr Groß'),          'services', '+49 231 112 7743', 'vermieter.gross@gmail.com',     null,                           L('Emergency maintenance: same number',        'Notfall-Hausmeisterdienst: gleiche Nummer'), null,                                                  L('Landlord', 'Vermieter')],
  [L("Emma's friend — Lena", 'Emmas Freundin — Lena'),        'family',   '+49 231 774 3309', null,                            null,                           L('Lena Braun — mum Katrin +49 231 774 3308',  'Lena Braun — Mutter Katrin +49 231 774 3308'), null,                                                null],
].forEach(row => insertContact.run(...row));

// ── Budget ───────────────────────────────────────────────────────────────────

// Konten tragen die Buchungen — ohne sie ist der Konten-Tab leer und jede
// Buchung kontolos. Die Salden entstehen aus starting_balance plus Buchungen.
console.log('Inserting budget accounts…');
const insertAccount = db.prepare(`
  INSERT INTO budget_accounts (name, type, starting_balance, color, sort_order, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// Sechs Konten decken vier der sechs Kontoarten ab. Vier waren zu wenig: die
// Liste endete auf halber Höhe, und `investment` kam in keinem Datensatz vor.
const accountId = {};
[
  ['current',  L('Joint Current Account', 'Gemeinsames Girokonto'), 'checking',   2480.00, '#2563EB', 0, alexId],
  ['savings',  L('Savings — Holiday',     'Sparkonto — Urlaub'),    'savings',    5200.00, '#10B981', 1, lindaId],
  ['kids',     L('Savings — Emma & Leo',  'Sparen für Emma & Leo'), 'savings',    1850.00, '#EC4899', 2, lindaId],
  ['cash',     L('Housekeeping cash',     'Haushaltskasse'),        'cash',        180.00, '#F59E0B', 3, lindaId],
  ['credit',   L('Visa Credit Card',      'Visa Kreditkarte'),      'credit',     -340.00, '#8B5CF6', 4, alexId],
  ['depot',    L('Investment Account',    'Wertpapierdepot'),       'investment', 9420.00, '#0EA5E9', 5, alexId],
].forEach(([slug, name, type, balance, color, sort, by]) => {
  accountId[slug] = insertAccount.run(name, type, balance, color, sort, by).lastInsertRowid;
});

console.log('Inserting budget entries…');
const insertBudget = db.prepare(`
  INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, account_id, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const budget = [
  // Income (category = income key, no subcategory)
  [L('Alex — Monthly Salary',    'Alex — Gehalt'),               3850.00, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, 'current', alexId],
  [L('Linda — Part-time Work',   'Linda — Teilzeit'),            1200.00, 'Erwerbseinkommen', '',                       thisMonthDate(1),  1, 'current', lindaId],
  [L('Child Benefit',            'Kindergeld'),                   500.00, 'Sozialleistungen', '',                       thisMonthDate(5),  1, 'current', alexId],
  // Fixed expenses
  [L('Rent',                     'Miete'),                      -1450.00, 'housing',           'rent_mortgage',          thisMonthDate(1),  1, 'current', alexId],
  [L('Car Insurance — VW Golf',  'Kfz-Versicherung — VW Golf'),   -89.50, 'transport',         'maintenance_insurance',  thisMonthDate(1),  1, 'current', alexId],
  [L('Health Insurance',         'Krankenversicherung'),         -310.00, 'personal_health',   'health_insurance',       thisMonthDate(1),  1, 'current', alexId],
  [L('Internet & Phone Bundle',  'Internet & Telefon'),           -49.99, 'housing',           'internet_tv_phone',      thisMonthDate(5),  1, 'current', alexId],
  [L('Electricity',              'Strom'),                        -78.00, 'housing',           'utilities',              thisMonthDate(15), 1, 'current', alexId],
  [L('Netflix',                  'Netflix'),                      -17.99, 'leisure',           'streaming',              thisMonthDate(10), 1, 'credit',  alexId],
  [L('Spotify Family',           'Spotify Family'),               -16.99, 'leisure',           'streaming',              thisMonthDate(10), 1, 'credit',  alexId],
  [L('Gym — FitLife',            'Fitnessstudio — FitLife'),      -39.00, 'personal_health',   'gym_sports',             thisMonthDate(1),  1, 'current', lindaId],
  // Variable, this month
  [L('Weekly Groceries — Wk 1',  'Wocheneinkauf — KW 1'),        -142.30, 'food',              'groceries',              thisMonthDate(4),  0, 'current', lindaId],
  [L('Weekly Groceries — Wk 2',  'Wocheneinkauf — KW 2'),        -118.75, 'food',              'groceries',              thisMonthDate(11), 0, 'current', lindaId],
  [L('Weekly Groceries — Wk 3',  'Wocheneinkauf — KW 3'),        -134.20, 'food',              'groceries',              thisMonthDate(18), 0, 'cash',    lindaId],
  [L('School Trip Payment',      'Zahlung Schulausflug'),         -25.00, 'education',         'school_supplies',        thisMonthDate(3),  0, 'cash',    lindaId],
  [L('Birthday Gift — Mum',      'Geburtstagsgeschenk — Mama'),   -60.00, 'shopping_clothing', 'gifts',                  thisMonthDate(7),  0, 'credit',  alexId],
  [L('Restaurant — Date Night',  'Restaurant — Paarabend'),       -87.50, 'food',              'restaurants_bars',       thisMonthDate(9),  0, 'credit',  alexId],
  [L('Fuel — VW Golf',           'Tanken — VW Golf'),             -68.00, 'transport',         'fuel',                   thisMonthDate(6),  0, 'current', alexId],
  [L('Pharmacy',                 'Apotheke'),                     -22.40, 'personal_health',   'pharmacy',               thisMonthDate(8),  0, 'cash',    lindaId],
  [L("Leo's Football Boots",     'Fußballschuhe für Leo'),        -54.99, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(12), 0, 'current', lindaId],
  [L('Tools — Home Improvement', 'Werkzeug — Heimwerken'),        -43.00, 'housing',           'renovation_maintenance', thisMonthDate(14), 0, 'current', alexId],
  [L('Clothes — Emma',           'Kleidung — Emma'),              -38.50, 'shopping_clothing', 'clothes_shoes',          thisMonthDate(16), 0, 'credit',  lindaId],
  [L('Weekend Trip Deposit',     'Anzahlung Kurzurlaub'),        -200.00, 'leisure',           'travel',                 thisMonthDate(19), 0, 'savings', alexId],
  // Last month (trend comparison)
  [L('Alex — Monthly Salary',    'Alex — Gehalt'),               3850.00, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, 'current', alexId],
  [L('Linda — Part-time Work',   'Linda — Teilzeit'),            1200.00, 'Erwerbseinkommen', '',                        lastMonthDate(1),  0, 'current', lindaId],
  [L('Rent',                     'Miete'),                      -1450.00, 'housing',           'rent_mortgage',          lastMonthDate(1),  0, 'current', alexId],
  [L('Weekly Groceries',         'Wocheneinkauf'),               -489.00, 'food',              'groceries',              lastMonthDate(10), 0, 'current', lindaId],
  [L('Electricity',              'Strom'),                        -82.00, 'housing',           'utilities',              lastMonthDate(15), 0, 'current', alexId],
  [L('Fuel — VW Golf',           'Tanken — VW Golf'),             -71.00, 'transport',         'fuel',                   lastMonthDate(8),  0, 'current', alexId],
];
const budgetEntryIdByTitle = {};
budget.forEach(([title, amount, category, subcategory, date, recurring, acct, by]) => {
  const id = insertBudget.run(title, amount, category, subcategory, date, recurring, accountId[acct], by).lastInsertRowid;
  // Für die Belege unten reicht der erste Treffer je Titel (Miete steht zweimal).
  if (!(title in budgetEntryIdByTitle)) budgetEntryIdByTitle[title] = id;
});

// Kategoriebudgets: ohne sie zeigt der Plan-Tab nur Leerzustand, und die
// Fortschrittsbalken auf der Budget-Übersicht haben keinen Bezugswert.
console.log('Inserting budget plans…');
const insertPlan = db.prepare('INSERT INTO budget_plans (category, amount, created_by) VALUES (?, ?, ?)');
[
  ['housing',           1700],
  ['food',               650],
  ['transport',          220],
  ['personal_health',    400],
  ['leisure',            300],
  ['shopping_clothing',  180],
  ['education',           80],
].forEach(([cat, amount]) => insertPlan.run(cat, amount, String(alexId)));

// Darlehen: eines ohne Zinsen (privat geliehenes Geld) und eines als
// Annuität mit Zinsbindung (#569). total_amount/installment_count sind bei
// verzinsten Darlehen abgeleitete Größen - sie kommen aus derselben Rechnung,
// die auch der Route-Handler nutzt, statt aus einer Schätzung hier.
console.log('Inserting budget loans…');
const insertLoan = db.prepare(`
  INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, notes, status, created_by,
                            interest_mode, principal, fixed_rate, initial_repayment_rate, fixed_period_months, followup_rate)
  VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
`);
const loanId = insertLoan.run(
  L('Loan to Uncle Mike', 'Darlehen an Onkel Mike'), L('Uncle Mike Johnson', 'Onkel Mike Johnson'),
  1200.00, 6, thisMonthKey(-2),
  L('Helping with his car repair — €200/month', 'Hilfe bei der Autoreparatur — 200 € im Monat'),
  alexId, 'none', null, null, null, null, null,
).lastInsertRowid;

const mortgage = computeLoanSchedule({
  principal: 180000, fixedRate: 3.65, initialRepaymentRate: 2.5,
  interestMode: 'fixed_then_variable', fixedPeriodMonths: 120, followupRate: 4.5,
});
if (!mortgage.ok) throw new Error(`Mortgage schedule failed: ${mortgage.reason}`);
const mortgageId = insertLoan.run(
  L('Mortgage — Bürgerstraße', 'Baufinanzierung — Bürgerstraße'), L('Sparkasse Dortmund', 'Sparkasse Dortmund'),
  mortgage.totalRepayment, mortgage.totalMonths, thisMonthKey(-14),
  L('10-year fixed rate, 2.5% initial repayment', '10 Jahre Zinsbindung, 2,5 % Anfangstilgung'),
  alexId, 'fixed_then_variable', 180000, 3.65, 2.5, 120, 4.5,
).lastInsertRowid;

const insertLoanPayment = db.prepare(`
  INSERT INTO budget_loan_payments (loan_id, installment_number, amount, paid_date, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
insertLoanPayment.run(loanId, 1, 200.00, lastMonthDate(2), alexId);
insertLoanPayment.run(loanId, 2, 200.00, thisMonthDate(2), alexId);
// 14 Monatsraten der Baufinanzierung sind bezahlt — genug für einen sichtbaren
// Tilgungsfortschritt, weit vor dem Ende der Zinsbindung. Rate i gehört zum
// Monat, in dem sie fällig war (Start: 14 Monate zurück).
for (let i = 1; i <= 14; i++) {
  insertLoanPayment.run(mortgageId, i, mortgage.monthlyPayment, `${thisMonthKey(-14 + i - 1)}-01`, alexId);
}

// ── Notes ────────────────────────────────────────────────────────────────────

console.log('Inserting notes…');
const insertNote = db.prepare('INSERT INTO notes (title, content, color, pinned, created_by) VALUES (?, ?, ?, ?, ?)');
[
  [L('Holiday Checklist 🌍', 'Urlaubs-Checkliste 🌍'),
   L('Passports (exp. 2028)\nTravel insurance — check!\nEuro cash — €300\nBook airport parking\nAsk Mike to water the plants\nPack sunscreen SPF 50',
     'Reisepässe (gültig bis 2028)\nAuslandskrankenschein — prüfen!\nBargeld — 300 €\nParkplatz am Flughafen buchen\nMike wegen Blumengießen fragen\nSonnencreme LSF 50 einpacken'), '#0EA5E9', 1, alexId],
  [L('WiFi & Smart Home', 'WLAN & Smart Home'),
   L('WiFi: Yuvomi_Home_5G (password in the router app)\nPhilips Hue: bridge 192.168.1.42\nThermostat: eco mode 18°C\nRouter admin: fritz.box',
     'WLAN: Yuvomi_Home_5G (Passwort in der Router-App)\nPhilips Hue: Bridge 192.168.1.42\nThermostat: Eco-Modus 18 °C\nRouter-Verwaltung: fritz.box'), '#F59E0B', 1, alexId],
  [L("Emma's School Info", 'Emmas Schulinfos'),
   L('Class: 3b — Mrs Bauer\nSchool starts: 08:10\nCollection: 13:30 (Tue/Thu 15:00)\nAllergy: mild lactose intolerance\nBest friends: Lena, Sophie, Tim',
     'Klasse: 3b — Frau Bauer\nSchulbeginn: 08:10\nAbholung: 13:30 (Di/Do 15:00)\nUnverträglichkeit: leichte Laktoseintoleranz\nBeste Freunde: Lena, Sophie, Tim'), '#EC4899', 1, lindaId],
  [L("Leo's Activities", 'Leos Termine'),
   L('Football: Tue & Sat 17:00 — SV West\nSwimming: Fri 16:00 — Westbad\nNeeds: boots size 35, goggles\nCoach: Herr Krüger',
     'Fußball: Di und Sa 17:00 — SV West\nSchwimmen: Fr 16:00 — Westbad\nBraucht: Schuhe Größe 35, Schwimmbrille\nTrainer: Herr Krüger'), '#F97316', 1, lindaId],
  [L('Emergency Numbers', 'Notrufnummern'),
   L('Police: 110\nFire / Ambulance: 112\nPoison Control: 0800 192 11 10\nGP out-of-hours: 116 117\nNearest A&E: Klinikum Dortmund',
     'Polizei: 110\nFeuerwehr / Rettungsdienst: 112\nGiftnotruf: 0800 192 11 10\nÄrztlicher Bereitschaftsdienst: 116 117\nNächste Notaufnahme: Klinikum Dortmund'), '#EF4444', 1, alexId],
  [L('Car — Important Dates', 'Auto — wichtige Termine'),
   L('Next service: this June (60,000 km)\nMOT due: September\nWinter tyres: stored at AutoHaus König\nInsurance renewal: October',
     'Nächste Inspektion: im Juni (60.000 km)\nTÜV fällig: September\nWinterreifen: eingelagert beim AutoHaus König\nVersicherungswechsel: Oktober'), '#6B7280', 0, alexId],
  [L('Book Recommendations', 'Buchempfehlungen'),
   L('Reading: "Atomic Habits" — James Clear\nWishlist:\n• The Thursday Murder Club\n• Lessons in Chemistry\n• Tomorrow, and Tomorrow, and Tomorrow',
     'Gerade dabei: „Die 1%-Methode" — James Clear\nWunschliste:\n• Der Donnerstagsmordclub\n• Eine Frage der Chemie\n• Morgen, morgen und wieder morgen'), '#8B5CF6', 0, lindaId],
  [L('Garden To-Do', 'Garten-Aufgaben'),
   L('□ Re-pot herbs (basil, rosemary)\n□ Fix fence panel (3rd from gate)\n□ Order mulch for the flower beds\n□ Plant tulip bulbs before November',
     '□ Kräuter umtopfen (Basilikum, Rosmarin)\n□ Zaunfeld reparieren (3. vom Tor)\n□ Rindenmulch für die Beete bestellen\n□ Tulpenzwiebeln vor November setzen'), '#10B981', 0, alexId],
].forEach(row => insertNote.run(...row));

// ── Birthdays ────────────────────────────────────────────────────────────────

console.log('Inserting birthdays…');
const insertBirthday = db.prepare(`
  INSERT INTO birthdays (name, birth_date, notes, family_user_id, reminder_offset, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// reminder_offset ist ein Minutenwert als Text, wie ihn das Formular schreibt
// (REMINDER_OFFSETS in public/pages/birthdays.js - nur deren Werte, sonst zeigt das Formular
// eine Auswahl, die es nicht kennt; der Server liest ihn per
// parseInt). Hier stand '1d'/'3d'/'1w' - daraus wurden 1, 3 und wieder 1 Minute (parseInt liest nur die Ziffer), und
// jeder Demo-Geburtstag erinnerte kurz vor Mittag AM Tag selbst statt Tage vorher.
const DAY_BEFORE  = '1440';
const TWO_DAYS    = '2880';
const WEEK_BEFORE = '10080';
[
  ['Emma Johnson',                                    '2018-06-14', L('Turning 8 — chocolate cake & bouncy castle', 'Wird 8 — Schokotorte und Hüpfburg'), emmaId, WEEK_BEFORE, lindaId],
  ['Leo Johnson',                                     '2016-03-22', L('Loves football & LEGO',                      'Liebt Fußball und LEGO'),            leoId,  WEEK_BEFORE, lindaId],
  ['Margaret Johnson',                                '1958-06-19', L("Alex's mum — 'Grandma'",                     'Alex’ Mutter — „Oma"'),              null,   TWO_DAYS,    alexId],
  [L('Uncle Mike Johnson', 'Onkel Mike Johnson'),     '1985-11-02', L("Alex's brother in Hamburg",                  'Alex’ Bruder in Hamburg'),           null,   DAY_BEFORE,  alexId],
  [L('Aunt Claire Becker', 'Tante Claire Becker'),    '1989-08-30', L("Linda's sister",                             'Lindas Schwester'),                  null,   DAY_BEFORE,  lindaId],
  ['Lena Braun',                                      '2018-09-12', L("Emma's best friend",                         'Emmas beste Freundin'),              null,   DAY_BEFORE,  lindaId],
  ['Alex Johnson',                                    '1986-02-08', '',                                                                                   alexId, TWO_DAYS,    lindaId],
  ['Linda Johnson',                                   '1988-04-25', '',                                                                                   lindaId,TWO_DAYS,    alexId],
].forEach(row => insertBirthday.run(...row));

// ── Documents ────────────────────────────────────────────────────────────────

console.log('Inserting documents…');
const insertFolder = db.prepare('INSERT INTO family_document_folders (name, created_by) VALUES (?, ?)');
const folderId = {};
for (const [slug, name] of [
  ['medical',   L('Medical',   'Gesundheit')],
  ['school',    L('School',    'Schule')],
  ['insurance', L('Insurance', 'Versicherungen')],
  ['home',      L('Home',      'Wohnung')],
  ['travel',    L('Travel',    'Reisen')],
  ['vehicle',   L('Vehicle',   'Fahrzeug')],
  ['receipts',  L('Receipts',  'Belege')],
]) {
  folderId[slug] = insertFolder.run(name, alexId).lastInsertRowid;
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
  [L('Vaccination Record — Emma',  'Impfpass — Emma'),           L('Up to date as of last check-up',       'Beim letzten Check-up aktualisiert'),  'medical',   'family',     'medical',   'emma_vaccinations.pdf',   'application/pdf', 124000, alexId],
  [L('Health Insurance Card',      'Versichertenkarte'),         L('Scan of the family insurance card',    'Scan der Familien-Versichertenkarte'), 'medical',   'restricted', 'medical',   'insurance_card.jpg',      'image/jpeg',      86000,  alexId],
  [L('School Report — Emma',       'Zeugnis — Emma'),            L('Spring term report',                   'Halbjahreszeugnis'),                   'school',    'family',     'school',    'emma_report_spring.pdf',  'application/pdf', 210000, lindaId],
  [L('Field Trip Permission Slip', 'Einverständnis Schulausflug'), L('Signed — science museum',            'Unterschrieben — Naturkundemuseum'),   'school',    'family',     'school',    'permission_slip.pdf',     'application/pdf', 48000,  lindaId],
  [L('Tenancy Agreement',          'Mietvertrag'),               L('Signed lease — flat on Bürgerstraße',  'Unterschrieben — Wohnung Bürgerstraße'), 'home',    'restricted', 'home',      'tenancy_agreement.pdf',   'application/pdf', 320000, alexId],
  [L('Home Insurance Policy',      'Hausratversicherung'),       L('Policy documents 2025',                'Versicherungsunterlagen 2025'),        'insurance', 'family',     'insurance', 'home_insurance_2025.pdf', 'application/pdf', 180000, alexId],
  [L('Car Insurance — VW Golf',    'Kfz-Versicherung — VW Golf'),L('Comprehensive cover',                  'Vollkasko'),                           'insurance', 'family',     'vehicle',   'car_insurance.pdf',       'application/pdf', 156000, alexId],
  [L('Vehicle Registration',       'Fahrzeugschein'),            L('VW Golf TDI — registration papers',    'VW Golf TDI — Zulassungspapiere'),     'vehicle',   'restricted', 'vehicle',   'vw_golf_registration.pdf','application/pdf', 96000,  alexId],
  [L('Passports (scans)',          'Reisepässe (Scans)'),        L('All four family passports',            'Alle vier Reisepässe der Familie'),    'travel',    'private',    'travel',    'passports.pdf',           'application/pdf', 410000, alexId],
  [L('Flight Confirmation',        'Flugbestätigung'),           L('Amsterdam city break',                 'Städtereise Amsterdam'),               'travel',    'family',     'travel',    'flights_amsterdam.pdf',   'application/pdf', 64000,  alexId],
  // Belege: hängen unten an Buchungen bzw. an einer geteilten Ausgabe (#583).
  [L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf'), L('REWE — week 1',                        'REWE — KW 1'),                         'finance',     'family',     'receipts',  'receipt_rewe.jpg',        'image/jpeg',      92000,  lindaId],
  [L('Invoice — Electricity',      'Rechnung — Strom'),          L('Monthly instalment',                   'Monatlicher Abschlag'),                'finance',     'family',     'receipts',  'invoice_electricity.pdf', 'application/pdf', 71000,  alexId],
  [L('Receipt — Football Boots',   'Kassenbon — Fußballschuhe'), L('Sports shop — size 35',                'Sportgeschäft — Größe 35'),            'finance',     'family',     'receipts',  'receipt_boots.jpg',       'image/jpeg',      68000,  lindaId],
];
const documentIdByName = {};
for (const [name, description, category, visibility, folder, original, mime, size, created_by] of documents) {
  const p = payload(Math.min(size, 4096)); // store a small placeholder, report a realistic size
  documentIdByName[name] = insertDoc.run({
    name, description, category, visibility, folder: folderId[folder],
    original, mime, size, content: p.base64, created_by,
  }).lastInsertRowid;
}

// Belege an Buchungen (#583). Erst hier möglich: die Dokumente entstehen oben,
// die Buchungen weiter vorn - die Verknüpfung braucht beide Seiten.
console.log('Linking receipts to budget entries…');
const insertEntryAttachment = db.prepare(`
  INSERT OR IGNORE INTO budget_entry_attachments (entry_id, document_id, created_by) VALUES (?, ?, ?)
`);
[
  [L('Weekly Groceries — Wk 1', 'Wocheneinkauf — KW 1'), L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf'), lindaId],
  [L('Electricity',             'Strom'),                L('Invoice — Electricity',      'Rechnung — Strom'),          alexId],
  [L("Leo's Football Boots",    'Fußballschuhe für Leo'),L('Receipt — Football Boots',   'Kassenbon — Fußballschuhe'), lindaId],
].forEach(([entryTitle, docName, by]) => {
  const entryId = budgetEntryIdByTitle[entryTitle];
  const docId = documentIdByName[docName];
  if (entryId && docId) insertEntryAttachment.run(entryId, docId, by);
});

// Dokument an einer Aufgabe: der unterschriebene Zettel hängt an der Aufgabe,
// die ihn verlangt.
const insertTaskDoc = db.prepare(`
  INSERT OR IGNORE INTO task_documents (task_id, document_id, created_by) VALUES (?, ?, ?)
`);
{
  const taskId = taskIdByTitle[L('Sign school permission slip', 'Einverständnis für Schulausflug')];
  const docId = documentIdByName[L('Field Trip Permission Slip', 'Einverständnis Schulausflug')];
  if (taskId && docId) insertTaskDoc.run(taskId, docId, lindaId);
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

console.log('Inserting housekeeping data…');
const workerId = db.prepare(`
  INSERT INTO housekeeping_workers (user_id, daily_rate, payment_schedule, notes, calendar_color)
  VALUES (?, ?, ?, ?, ?)
`).run(mariaId, 45.00, 'twice_monthly',
  L('Comes Mon, Wed & Fri mornings', 'Kommt Mo, Mi und Fr vormittags'), '#7C3AED').lastInsertRowid;

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
  [L('Clean bathrooms',    'Bäder putzen'),          L('Bathrooms',   'Bäder'),         7,  isoFromNow(-3)],
  [L('Mop kitchen floor',  'Küchenboden wischen'),   L('Kitchen',     'Küche'),         7,  isoFromNow(-6)],
  [L('Dust living room',   'Wohnzimmer abstauben'),  L('Living room', 'Wohnzimmer'),    14, isoFromNow(-10)],
  [L('Change bed linens',  'Bettwäsche wechseln'),   L('Bedrooms',    'Schlafzimmer'),  14, isoFromNow(-16)],   // overdue
  [L('Clean refrigerator', 'Kühlschrank reinigen'),  L('Kitchen',     'Küche'),         30, isoFromNow(-20)],
  [L('Clean windows',      'Fenster putzen'),        L('Whole house', 'Ganze Wohnung'), 30, isoFromNow(-35)],   // overdue
  [L('Deep clean oven',    'Backofen gründlich reinigen'), L('Kitchen','Küche'),        60, isoFromNow(-40)],
  [L('Wash balcony/patio', 'Balkon kehren'),         L('Outdoor',     'Außenbereich'),  30, isoFromNow(-12)],
].forEach(row => insertDecay.run(...row, alexId));

const insertSupply = db.prepare('INSERT INTO housekeeping_supply_requests (name, quantity, created_by) VALUES (?, ?, ?)');
[
  [L('Dish soap',       'Spülmittel'),       L('2 bottles', '2 Flaschen'), mariaId],
  [L('Paper towels',    'Küchenrolle'),      L('6 rolls',   '6 Rollen'),   mariaId],
  [L('Glass cleaner',   'Glasreiniger'),     '1',                          mariaId],
  [L('Bin bags (60 l)', 'Müllbeutel (60 l)'),L('1 pack',    '1 Packung'),  mariaId],
].forEach(row => insertSupply.run(...row));

const insertMaint = db.prepare('INSERT INTO housekeeping_maintenance_log (description, created_by) VALUES (?, ?)');
[
  [L('Reported a dripping tap in the main bathroom',      'Tropfenden Wasserhahn im Bad gemeldet'),             mariaId],
  [L('Replaced the kitchen sponge and refilled hand soap','Küchenschwamm getauscht und Seife nachgefüllt'),     mariaId],
  [L('Living-room blind is sticking — needs a look',      'Rollo im Wohnzimmer klemmt — sollte jemand ansehen'), mariaId],
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
  // Typ muss exakt einer der Typen sein, die server/routes/split-expenses.js
  // schreibt — der Feed übersetzt über splitExpenses.activityType.<type>, ein
  // erfundener Typ rendert als roher Key.
  insertActivity.run(groupId, payerId, 'expense_created', 'expense', expId, JSON.stringify({ title, amount_minor: amount }));
  return expId;
}

// Group 1: Household (alex + linda)
const houseGroupName = L('Household', 'Haushalt');
const houseGroup = insertGroup.run(houseGroupName,
  L('Shared bills, groceries and family costs', 'Gemeinsame Rechnungen, Einkäufe und Familienkosten'),
  'household', '#0F766E', alexId).lastInsertRowid;
insertMember.run(houseGroup, alexId, 'owner', alexId);
insertMember.run(houseGroup, lindaId, 'admin', alexId);
insertActivity.run(houseGroup, alexId, 'group_created', 'group', houseGroup, JSON.stringify({ name: houseGroupName }));
const groceriesExpenseId =
  addExpense(houseGroup, alexId,  [alexId, lindaId], L('Weekly groceries',  'Wocheneinkauf'),        L('Big shop at REWE',      'Großeinkauf bei REWE'),      142.30, 'groceries',     thisMonthDate(4));
addExpense(houseGroup, lindaId, [alexId, lindaId], L('Electricity bill',  'Stromrechnung'),        L('Monthly direct debit',  'Monatlicher Abschlag'),       78.00, 'utilities',     thisMonthDate(15));
const dinnerExpenseId =
  addExpense(houseGroup, alexId,  [alexId, lindaId], L('Date-night dinner', 'Abendessen zu zweit'),  L('Italian on the corner', 'Italiener um die Ecke'),      87.50, 'general',       thisMonthDate(9));
addExpense(houseGroup, lindaId, [alexId, lindaId], L("Emma's new shoes",  'Neue Schuhe für Emma'), L('Back-to-school',        'Für den Schulstart'),         38.50, 'shopping',      thisMonthDate(16));
addExpense(houseGroup, alexId,  [alexId, lindaId], L('Streaming bundle',  'Streaming-Paket'),      L('Netflix + Spotify',     'Netflix und Spotify'),        34.98, 'subscriptions', thisMonthDate(10));

// Group 2: Italy Trip 2026 (alex + linda)
const tripGroupName = L('Italy Trip 2026', 'Italienurlaub 2026');
const tripGroup = insertGroup.run(tripGroupName,
  L('Summer holiday planning & costs', 'Planung und Kosten des Sommerurlaubs'),
  'travel', '#0EA5E9', alexId).lastInsertRowid;
insertMember.run(tripGroup, alexId, 'owner', alexId);
insertMember.run(tripGroup, lindaId, 'admin', alexId);
insertActivity.run(tripGroup, alexId, 'group_created', 'group', tripGroup, JSON.stringify({ name: tripGroupName }));
addExpense(tripGroup, alexId,  [alexId, lindaId], L('Flights (×4)',      'Flüge (×4)'),          L('Dortmund → Naples',   'Dortmund → Neapel'),        648.00, 'travel',  thisMonthDate(2));
addExpense(tripGroup, lindaId, [alexId, lindaId], L('Apartment deposit', 'Anzahlung Ferienwohnung'), L('Sorrento — 7 nights', 'Sorrent — 7 Nächte'),   400.00, 'travel',  thisMonthDate(6));
addExpense(tripGroup, alexId,  [alexId, lindaId], L('Travel insurance',  'Reiseversicherung'),   L('Family annual policy','Jahrespolice für die Familie'), 96.00, 'general', thisMonthDate(8));

// Beleg + Kommentar an einer geteilten Ausgabe: beides gab es im Seed nie, und
// beide Ansichten (Beleg-Chip, Kommentarfaden) blieben dadurch unsichtbar.
const receiptDocId = documentIdByName[L('Receipt — Weekly Groceries', 'Kassenbon — Wocheneinkauf')];
if (receiptDocId) {
  db.prepare(`
    INSERT INTO expense_attachments (expense_id, document_id, kind, created_by) VALUES (?, ?, 'receipt', ?)
  `).run(groceriesExpenseId, receiptDocId, alexId);
}
const insertExpenseComment = db.prepare(`
  INSERT INTO expense_comments (expense_id, user_id, comment) VALUES (?, ?, ?)
`);
insertExpenseComment.run(dinnerExpenseId, lindaId, L('Worth every cent — let us go again.', 'Jeden Cent wert — da gehen wir wieder hin.'));
insertExpenseComment.run(dinnerExpenseId, alexId,  L('Agreed. Next time we book a table.',  'Finde ich auch. Nächstes Mal reservieren wir.'));

// Wiederkehrende geteilte Ausgabe: der Mietanteil läuft monatlich weiter.
db.prepare(`
  INSERT INTO recurring_expenses (group_id, title, description, amount_minor, currency, payer_id, category,
                                  split_method, split_snapshot, frequency, next_run_date, created_by)
  VALUES (?, ?, ?, ?, 'EUR', ?, 'housing', 'equal', ?, 'monthly', ?, ?)
`).run(
  houseGroup, L('Rent share', 'Mietanteil'), L('Split 50/50 each month', 'Jeden Monat hälftig geteilt'),
  145000, alexId,
  JSON.stringify([{ user_id: alexId, amount_minor: 72500 }, { user_id: lindaId, amount_minor: 72500 }]),
  thisMonthDate(1) > daysFromNow(0) ? thisMonthDate(1) : `${thisMonthKey(1)}-01`,
  alexId,
);

// A settlement in the household group: Linda pays Alex back a round amount
const settlementId = db.prepare(`
  INSERT INTO settlements (group_id, payer_id, payee_id, amount_minor, currency, notes, created_by)
  VALUES (?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, lindaId, alexId, 5000,
  L('Partial settle-up via bank transfer', 'Teilausgleich per Überweisung'), lindaId).lastInsertRowid;
db.prepare(`
  INSERT INTO settlement_entries (settlement_id, from_user_id, to_user_id, amount_minor, currency)
  VALUES (?, ?, ?, ?, 'EUR')
`).run(settlementId, lindaId, alexId, 5000);
// Ledger for settlement: payer (linda) +amount toward payee, payee (alex) -amount
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, settlementId, lindaId, alexId, 5000, L('Settle-up', 'Ausgleich'), lindaId);
db.prepare(`
  INSERT INTO expense_ledger_entries (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
  VALUES (?, 'settlement', ?, ?, ?, ?, 'EUR', ?, ?)
`).run(houseGroup, settlementId, alexId, lindaId, -5000, L('Settle-up', 'Ausgleich'), lindaId);
insertActivity.run(houseGroup, lindaId, 'payment_registered', 'settlement', settlementId, JSON.stringify({ amount_minor: 5000 }));

// ── Health: Vitals ───────────────────────────────────────────────────────────
// All health data belongs to Linda (the demo login) so it renders on her own
// Health page. visibility stays at the DEFAULT 'private' (own data always shows).

console.log('Inserting health vitals…');
const insertVital = db.prepare(`
  INSERT INTO health_vitals (user_id, type, value_num, value_num2, value_num3, unit, measured_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Weight trend (kg) — a gentle downward trend over ~8 weeks
[[-56, 66.9], [-49, 66.6], [-42, 66.4], [-35, 66.1], [-28, 65.9], [-21, 65.6], [-14, 65.4], [-7, 65.2], [-1, 65.0]]
  .forEach(([d, kg]) => insertVital.run(lindaId, 'weight', kg, null, null, 'kg', dateTimeFromNow(d, 7, 30), null));
// Blood pressure (systolic / diastolic / pulse)
[[-42, 122, 79, 68], [-28, 118, 76, 64], [-14, 120, 78, 66], [-3, 116, 74, 61]]
  .forEach(([d, sys, dia, pul]) => insertVital.run(lindaId, 'bp', sys, dia, pul, 'mmHg', dateTimeFromNow(d, 8, 0), null));
// Fasting glucose (mg/dL)
[[-30, 92], [-14, 88], [-2, 90]].forEach(([d, v]) =>
  insertVital.run(lindaId, 'glucose', v, null, null, 'mg/dL', dateTimeFromNow(d, 7, 0), L('Fasting', 'Nüchtern')));
// SpO₂ (%) and temperature (°C)
[[-10, 98], [-2, 99]].forEach(([d, v]) => insertVital.run(lindaId, 'spo2', v, null, null, '%', dateTimeFromNow(d, 8, 30), null));
insertVital.run(lindaId, 'temp', 36.7, null, null, '°C', dateTimeFromNow(-5, 20, 0), null);
// Sleep (decimal hours, measured_at = the morning the night ended)
[[-13, 7.5], [-12, 6.75], [-11, 7.25], [-10, 8.0], [-9, 6.5], [-8, 7.0], [-7, 7.75],
 [-6, 7.25], [-5, 6.25], [-4, 7.5], [-3, 8.25], [-2, 7.0], [-1, 7.5]]
  .forEach(([d, hours]) => insertVital.run(lindaId, 'sleep', hours, null, null, 'h', dateTimeFromNow(d, 7, 0), null));
// Mood on the 1-5 scale — no unit, the number is a step
[[-13, 4], [-11, 3], [-9, 2], [-7, 4], [-5, 3], [-3, 5], [-1, 4]]
  .forEach(([d, step]) => insertVital.run(lindaId, 'mood', step, null, null, null, dateTimeFromNow(d, 20, 30), null));

// ── Health: Caregiver grants (#584) ──────────────────────────────────────────
// Both parents may record for both children. Without a grant the feature is
// invisible, and a demo that never shows it is a demo of the old behaviour.

console.log('Granting health caregiver rights…');
const insertCareGrant = db.prepare(`
  INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)
`);
for (const childId of [emmaId, leoId]) {
  for (const parentId of [alexId, lindaId]) insertCareGrant.run(childId, parentId);
}

// ── Health: Activities ───────────────────────────────────────────────────────

console.log('Inserting health activities…');
const insertActivity2 = db.prepare(`
  INSERT INTO health_activities (user_id, type, duration_min, distance_km, intensity, calories, performed_at, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  ['running',  32, 5.2, 'high',     410, -1,  L('Morning run in the park',   'Morgenlauf im Park')],
  ['yoga',     40, null, 'low',     150, -2,  L('Evening flow',              'Abend-Flow')],
  ['cycling',  48, 15.4, 'moderate', 395, -3, L('River loop',                'Runde an der Ruhr')],
  ['walking',  55, 4.3, 'low',      190, -4,  L('Walk with the kids',        'Spaziergang mit den Kindern')],
  ['strength', 35, null, 'high',    230, -6,  L('Full-body session',         'Ganzkörper-Einheit')],
  ['running',  28, 4.6, 'moderate', 360, -8,  ''],
  ['swimming', 30, 1.2, 'moderate', 300, -10, L('Lane swimming at Westbad',  'Bahnen im Westbad')],
  ['cycling',  60, 19.0, 'high',    520, -12, L('Weekend ride',              'Wochenendtour')],
].forEach(([type, dur, dist, inten, cal, d, note]) =>
  insertActivity2.run(lindaId, type, dur, dist, inten, cal, dateTimeFromNow(d, 7, 0), note || null));

// ── Health: Medications ──────────────────────────────────────────────────────

console.log('Inserting medications…');
const insertMed = db.prepare(`
  INSERT INTO medications (user_id, name, dosage_text, form, active, prn, stock_qty, stock_unit, refill_threshold, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertMedSched = db.prepare(`
  INSERT INTO medication_schedules (medication_id, time_of_day, days_mask, dose_qty, start_date, active)
  VALUES (?, ?, ?, ?, ?, 1)
`);
const insertMedLog = db.prepare(`
  INSERT INTO medication_logs (medication_id, schedule_id, scheduled_at, status, taken_at, dose_qty)
  VALUES (?, ?, ?, ?, ?, ?)
`);
// Daily supplements with a schedule + a week of adherence logs (today still pending)
const vitDId = insertMed.run(lindaId, L('Vitamin D3', 'Vitamin D3'), L('1000 IU', '1000 IE'), 'tablet', 1, 0, 42,
  L('tablets', 'Tabletten'), 10, L('With breakfast', 'Zum Frühstück')).lastInsertRowid;
const vitDSched = insertMedSched.run(vitDId, '08:00', 127, 1, daysFromNow(-40)).lastInsertRowid;
const ironId = insertMed.run(lindaId, L('Iron (Ferrous bisglycinate)', 'Eisen (Eisenbisglycinat)'), '25 mg', 'capsule', 1, 0, 18,
  L('capsules', 'Kapseln'), 14, L('Low ferritin — evening, away from dairy', 'Niedriges Ferritin — abends, nicht mit Milchprodukten')).lastInsertRowid;
const ironSched = insertMedSched.run(ironId, '20:00', 127, 1, daysFromNow(-25)).lastInsertRowid;
// As-needed medication (no schedule)
insertMed.run(lindaId, 'Ibuprofen', '400 mg', 'tablet', 1, 1, 20,
  L('tablets', 'Tabletten'), 5, L('For headaches — max 3/day', 'Bei Kopfschmerzen — höchstens 3 pro Tag'));
// Adherence logs: last 6 days taken, today pending
for (let d = -6; d <= 0; d++) {
  const status = d === 0 ? 'pending' : 'taken';
  const takenAt = d === 0 ? null : dateTimeFromNow(d, 8, 12);
  insertMedLog.run(vitDId, vitDSched, dateTimeFromNow(d, 8, 0), status, takenAt, 1);
}
for (let d = -6; d <= 0; d++) {
  const taken = d < 0 && d !== -3;                 // one missed dose for realism
  insertMedLog.run(ironId, ironSched, dateTimeFromNow(d, 20, 0), taken ? 'taken' : (d === 0 ? 'pending' : 'skipped'), taken ? dateTimeFromNow(d, 20, 18) : null, 1);
}

// ── Health: Lab Reports ──────────────────────────────────────────────────────

console.log('Inserting lab reports…');
const insertLabReport = db.prepare(`
  INSERT INTO health_lab_reports (user_id, report_date, lab_name, note) VALUES (?, ?, ?, ?)
`);
const insertLabResult = db.prepare(`
  INSERT INTO health_lab_results (report_id, analyte, value_num, unit, ref_low, ref_high, flag) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const LAB_NAME = L('City Practice Laboratory', 'Labor der Praxis am Markt');
const ANALYTE = {
  haemoglobin: L('Haemoglobin',       'Hämoglobin'),
  ferritin:    L('Ferritin',          'Ferritin'),
  vitaminD:    L('Vitamin D',         'Vitamin D'),
  tsh:         L('TSH',               'TSH'),
  cholesterol: L('Total Cholesterol', 'Gesamtcholesterin'),
  hdl:         L('HDL',               'HDL'),
  ldl:         L('LDL',               'LDL'),
  glucose:     L('Fasting Glucose',   'Nüchternblutzucker'),
};
const labReportNow = insertLabReport.run(lindaId, daysFromNow(-18), LAB_NAME,
  L('Annual blood panel', 'Jährliches Blutbild')).lastInsertRowid;
[
  [ANALYTE.haemoglobin, 13.2, 'g/dL',  12.0, 16.0, null],
  [ANALYTE.ferritin,    24,   'ng/mL', 15,   150,  null],
  [ANALYTE.vitaminD,    22,   'ng/mL', 30,   100,  'low'],
  [ANALYTE.tsh,         2.1,  'mIU/L', 0.4,  4.0,  null],
  [ANALYTE.cholesterol, 195,  'mg/dL', 0,    200,  null],
  [ANALYTE.hdl,         62,   'mg/dL', 40,   100,  null],
  [ANALYTE.ldl,         118,  'mg/dL', 0,    130,  null],
  [ANALYTE.glucose,     91,   'mg/dL', 70,   100,  null],
].forEach(([a, v, u, lo, hi, flag]) => insertLabResult.run(labReportNow, a, v, u, lo, hi, flag));
// An older panel for trend comparison
const labReportOld = insertLabReport.run(lindaId, daysFromNow(-200), LAB_NAME,
  L('Routine check', 'Routinekontrolle')).lastInsertRowid;
[
  [ANALYTE.haemoglobin, 12.8, 'g/dL',  12.0, 16.0, null],
  [ANALYTE.ferritin,    18,   'ng/mL', 15,   150,  null],
  [ANALYTE.vitaminD,    18,   'ng/mL', 30,   100,  'low'],
].forEach(([a, v, u, lo, hi, flag]) => insertLabResult.run(labReportOld, a, v, u, lo, hi, flag));

// ── Health: Cycle ────────────────────────────────────────────────────────────

console.log('Inserting cycle data…');
// Demo-Zyklus familienweit sichtbar seeden: sonst sind die Perioden aus jeder
// anderen Account-Perspektive unsichtbar und die Vorhersage rechnet auf Lücken
// (Discussion #550). default_visibility bleibt 'private' - nur die Beispieldaten
// selbst sind bewusst geteilt.
db.prepare(`
  INSERT INTO cycle_settings (user_id, cycle_length_avg, period_length_avg, luteal_length, track_fertility)
  VALUES (?, 28, 5, 14, 1)
`).run(lindaId);
const insertPeriod = db.prepare('INSERT INTO cycle_periods (user_id, start_date, end_date, note, visibility) VALUES (?, ?, ?, ?, ?)');
[[-6, -2, L('Current cycle', 'Aktueller Zyklus')], [-34, -30, null], [-62, -58, null], [-90, -86, null]]
  .forEach(([s, e, note]) => insertPeriod.run(lindaId, daysFromNow(s), daysFromNow(e), note, 'family'));
const insertCycleLog = db.prepare('INSERT INTO cycle_day_logs (user_id, log_date, flow, symptoms, mood, note, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)');
[
  [-6, 'heavy',    'cramps,fatigue',       'sensitive', null],
  [-5, 'heavy',    'cramps,backache',      'irritable', L('Tough day', 'Anstrengender Tag')],
  [-4, 'medium',   'headache',             'neutral',   null],
  [-3, 'light',    'fatigue',              'good',      null],
  [-2, 'spotting', '',                     'good',      null],
].forEach(([d, flow, symptoms, mood, note]) => insertCycleLog.run(lindaId, daysFromNow(d), flow, symptoms, mood, note, 'family'));

// ── Rewards ──────────────────────────────────────────────────────────────────

console.log('Inserting rewards…');
const insertRewardParticipant = db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)');
insertRewardParticipant.run(emmaId);
insertRewardParticipant.run(leoId);

const insertRewardItem = db.prepare(`
  INSERT INTO reward_catalog (name, cost, icon, description, is_active, sort_order, created_by)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`);
const REWARD_ICE_CREAM = L('Ice cream trip',  'Eis essen gehen');
const REWARD_GAMING    = L('Video game hour', 'Eine Stunde zocken');
[
  [L('Extra 30 min screen time', '30 Minuten extra Bildschirmzeit'), 20, '📺', L('One extra half-hour of tablet or TV',   'Eine halbe Stunde mehr Tablet oder Fernsehen')],
  [REWARD_ICE_CREAM,                                                 25, '🍦', L('A visit to the ice cream parlour',      'Ein Besuch in der Eisdiele')],
  [L('Choose movie night film',  'Filmabend aussuchen'),             30, '🎬', L('Pick what the family watches on Friday','Aussuchen, was die Familie freitags schaut')],
  [REWARD_GAMING,                                                    40, '🎮', L('A full hour of gaming',                 'Eine ganze Stunde Videospiele')],
  [L('€5 pocket money',          '5 € Taschengeld'),                 50, '💶', L('Five euros added to your savings',      'Fünf Euro fürs Sparschwein')],
  [L('Friend sleepover',         'Übernachtungsbesuch'),             60, '🛌', L('Invite a friend to stay over',          'Eine Freundin oder einen Freund einladen')],
].forEach((r, i) => insertRewardItem.run(r[0], r[1], r[2], r[3], i, alexId));

const insertRewardLedger = db.prepare(`
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Emma earns points, then redeems an ice cream trip
[
  [10, 'earn',  L('Tidied her bedroom',      'Zimmer aufgeräumt'),          -9],
  [15, 'earn',  L('Helped with the dishes',  'Beim Abwasch geholfen'),      -7],
  [20, 'bonus', L('Great school week 🎉',    'Tolle Schulwoche 🎉'),        -5],
  [10, 'earn',  L('Fed the cat all week',    'Die ganze Woche Katze gefüttert'), -2],
].forEach(([delta, type, reason, d]) => insertRewardLedger.run(emmaId, delta, type, reason, null, null, alexId, isoFromNow(d, 18, 0)));
// Leo earns points (has a pending redemption, not yet deducted)
[
  [15, 'earn',  L('Practised piano',          'Klavier geübt'),             -8],
  [10, 'earn',  L('Watered the plants',       'Pflanzen gegossen'),         -6],
  [20, 'bonus', L('Kept his room tidy all week','Zimmer die ganze Woche ordentlich'), -4],
  [15, 'earn',  L('Homework done on time',    'Hausaufgaben pünktlich erledigt'), -1],
].forEach(([delta, type, reason, d]) => insertRewardLedger.run(leoId, delta, type, reason, null, null, alexId, isoFromNow(d, 18, 0)));

const insertRedemption = db.prepare(`
  INSERT INTO reward_redemptions (user_id, catalog_id, reward_name, reward_icon, cost, status, note, requested_by, decided_by, decided_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Emma: fulfilled ice cream trip (catalog id 2) — creates a matching spend in the ledger
const emmaRedemptionId = insertRedemption.run(
  emmaId, 2, REWARD_ICE_CREAM, '🍦', 25, 'fulfilled', null, emmaId, alexId, isoFromNow(-3, 19, 0), isoFromNow(-3, 16, 0)
).lastInsertRowid;
insertRewardLedger.run(emmaId, -25, 'redeem', REWARD_ICE_CREAM, null, emmaRedemptionId, alexId, isoFromNow(-3, 19, 0));
// Leo: pending request awaiting a parent's approval (no ledger entry yet)
insertRedemption.run(leoId, 4, REWARD_GAMING, '🎮', 40, 'pending',
  L('Please? Finished all my homework!', 'Bitte? Ich habe alle Hausaufgaben fertig!'),
  leoId, null, null, isoFromNow(-1, 17, 30));

// ── Budget: Subscriptions ────────────────────────────────────────────────────

console.log('Inserting subscriptions…');
db.prepare('UPDATE subscription_settings SET monthly_budget = 90, base_currency = ? WHERE id = 1').run('EUR');
const insertSub = db.prepare(`
  INSERT INTO budget_subscriptions
    (name, description, amount, currency, billing_cycle, cycle_interval, next_payment_date,
     category_id, payment_method_id, reminder_days, enabled, website_url, brand_color, notes,
     end_type, end_date, created_by)
  VALUES (@name, @desc, @amount, 'EUR', @cycle, 1, @next, @cat, @pm, 3, 1, @url, @color, @notes,
          @endType, @endDate, @by)
`);
// category ids: 1 Entertainment · 2 Productivity · 3 Utilities · 4 Health · 5 Education · 6 Other
// payment methods: 1 Credit Card · 3 PayPal · 4 Apple Pay · 6 Bank Transfer
// end_type: 'never' | 'on_date' | 'after_count' (#594)
[
  ['Netflix',             L('Standard plan',           'Standard-Abo'),           17.99, 'monthly', 8,   1, 1, 'https://netflix.com',    '#E50914', L('Shared family profile', 'Gemeinsames Familienprofil'), 'never',   null],
  ['Spotify Family',      L('Up to 6 accounts',        'Bis zu 6 Konten'),        16.99, 'monthly', 3,   1, 3, 'https://spotify.com',    '#1DB954', null,                                                     'never',   null],
  ['Disney+',             L('Standard with ads',       'Standard mit Werbung'),    8.99, 'monthly', 21,  1, 1, 'https://disneyplus.com', '#113CCF', L("Kids' favourites", 'Lieblingsfilme der Kinder'),       'never',   null],
  ['iCloud+ 2 TB',        L('Family photo & backup',   'Familienfotos & Backup'),  9.99, 'monthly', 12,  3, 4, 'https://icloud.com',     '#3693F3', null,                                                     'never',   null],
  [L('FitLife Gym', 'FitLife Fitnessstudio'), L("Linda's membership", 'Lindas Mitgliedschaft'), 39.00, 'monthly', 1, 4, 6, null,         '#10B981', L('Yoga + classes', 'Yoga und Kurse'),                    'never',   null],
  ['Microsoft 365 Family',L('Office + 1 TB each',      'Office + je 1 TB'),       99.00, 'yearly',  60,  2, 6, 'https://microsoft.com',  '#D83B01', L('Renews annually', 'Verlängert sich jährlich'),         'never',   null],
  ['Amazon Prime',        L('Delivery + Prime Video',  'Versand + Prime Video'),  89.90, 'yearly',  140, 6, 1, 'https://amazon.de',      '#FF9900', null,                                                     'never',   null],
  // Ein Abo mit Ende (#594): läuft in gut vier Monaten aus und zeigt damit die
  // Ende-Bedingung, die sonst in keinem Datensatz vorkam.
  [L('Kids magazine', 'Kindermagazin'), L('12-month subscription', '12-Monats-Abo'), 4.90, 'monthly', 16, 5, 6, null, '#F97316', L('Ends after the school year', 'Endet nach dem Schuljahr'), 'on_date', daysFromNow(128)],
].forEach(([name, desc, amount, cycle, nextDays, cat, pm, url, color, notes, endType, endDate]) =>
  insertSub.run({ name, desc, amount, cycle, next: daysFromNow(nextDays), cat, pm, url, color, notes, endType, endDate, by: alexId }));

// ── Inventory ────────────────────────────────────────────────────────────────

console.log('Inserting inventory…');
// Lagerorte legt keine Migration an (anders als die Kategorien), sie kommen
// also von hier. Flach gehalten: `parent_id` kann verschachteln, aber ein
// Screenshot, der zwei Ebenen zeigt, erklaert weniger als einer, der acht
// Gegenstaende zeigt.
const insertInvLocation = db.prepare(`
  INSERT INTO inventory_locations (name, icon, sort_order) VALUES (?, ?, ?)
`);
const invLocationId = {};
[
  ['livingroom', L('Living room', 'Wohnzimmer'), 'sofa',   0],
  ['office',     L('Office',      'Büro'),        'laptop', 1],
  ['basement',   L('Basement',    'Keller'),      'archive',2],
  ['garage',     L('Garage',      'Garage'),      'car',    3],
].forEach(([key, name, icon, sort]) => {
  invLocationId[key] = insertInvLocation.run(name, icon, sort).lastInsertRowid;
});

const insertInvItem = db.prepare(`
  INSERT INTO inventory_items
    (name, brand, model, serial_number, category, location_id, purchase_date,
     purchase_price, currency, vendor, warranty_months, condition, status, notes, created_by)
  VALUES (@name, @brand, @model, @serial, @cat, @loc, @date, @price, 'EUR', @vendor,
          @warranty, @cond, 'active', @notes, @by)
`);
// Die Mischung ist absichtlich: ein Posten mit laufender Garantie, einer mit
// abgelaufener, ein teures Fahrzeug und ein billiges Werkzeug. Genau daran
// haengt der Nutzen des Moduls - Kaufpreis, Garantie und Ort an einem Ort -
// und genau das muss ein Screenshot in einem Blick zeigen.
[
  [L('Television', 'Fernseher'), 'LG', 'OLED55C4', 'LG4C55-882174', 'electronics', 'livingroom',
   -420, 1299.00, L('Local electronics store', 'Elektromarkt vor Ort'), 24, 'good',
   L('Wall mount included', 'Wandhalterung dabei')],
  [L('Laptop', 'Notebook'), 'Apple', 'MacBook Air M3', 'C02XJ1QWLVDL', 'electronics', 'office',
   -180, 1499.00, 'Apple', 12, 'new', null],
  [L('Washing machine', 'Waschmaschine'), 'Miele', 'WWD660', '31-4471902', 'household', 'basement',
   -910, 949.00, 'Miele', 120, 'good',
   L('Ten-year warranty, receipt in Documents', 'Zehn Jahre Garantie, Beleg in Dokumenten')],
  [L('Family car', 'Familienauto'), 'Škoda', 'Octavia Combi', 'TMBJJ7NE0J0123456', 'vehicles', 'garage',
   -1250, 18900.00, L('Dealership', 'Autohaus'), 24, 'good',
   L('Next inspection in spring', 'Nächste HU im Frühjahr')],
  [L("Emma's bike", 'Emmas Fahrrad'), 'Cube', 'Acid 240', 'CU240-77120', 'sports', 'garage',
   -300, 449.00, L('Bike shop', 'Fahrradladen'), 24, 'good', null],
  [L('Cordless drill', 'Akkuschrauber'), 'Bosch', 'GSR 18V-55', '3601JJ2000', 'household', 'basement',
   -640, 159.00, 'Bosch', 36, 'fair', null],
  [L('Espresso machine', 'Espressomaschine'), 'Sage', 'Barista Express', 'SES875-441209', 'household', 'livingroom',
   -1100, 699.00, L('Coffee specialist', 'Kaffeehändler'), 24, 'good',
   L('Warranty expired', 'Garantie abgelaufen')],
  [L('Monitor', 'Monitor'), 'Dell', 'U2723QE', 'CN-0M4H2X', 'electronics', 'office',
   -95, 549.00, 'Dell', 36, 'new', null],
].forEach(([name, brand, model, serial, cat, loc, dayOffset, price, vendor, warranty, cond, notes]) =>
  insertInvItem.run({
    name, brand, model, serial, cat, loc: invLocationId[loc],
    date: daysFromNow(dayOffset), price, vendor, warranty, cond, notes, by: alexId,
  }));

// ── Reminders ────────────────────────────────────────────────────────────────

console.log('Inserting reminders…');
const insertReminder = db.prepare(`
  INSERT INTO reminders (entity_type, entity_id, remind_at, dismissed, created_by)
  VALUES (?, ?, ?, 0, ?)
`);
// Erinnerung an die dringende Stromrechnung und an den Schulausflug. Bewusst
// über die Titel-Maps statt über feste IDs: die Reihenfolge der Einfügungen
// oben darf sich ändern, ohne dass die Erinnerung still am falschen Eintrag hängt.
const reminderTaskId = taskIdByTitle[L('Pay electricity bill', 'Stromrechnung bezahlen')];
const reminderEventId = eventIdByTitle[L('Science Museum Field Trip', 'Ausflug ins Naturkundemuseum')];
if (reminderTaskId) insertReminder.run('task', reminderTaskId, isoFromNow(2, 8, 0), alexId);
if (reminderEventId) insertReminder.run('event', reminderEventId, isoFromNow(1, 7, 30), lindaId);

// ── Done ─────────────────────────────────────────────────────────────────────

db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\n✓ Demo data inserted successfully!');
console.log('  Admin login:  alex  / demo1234   (dad)');
console.log('  Admin login:  linda / demo1234   (mom — screenshot persona, has health/cycle data)');
console.log('  Member login: emma, leo, maria   / demo1234');
