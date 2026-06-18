/**
 * Modul: Dashboard-API-Test
 * Zweck: Validiert die Dashboard-Aggregationsabfragen mit node:sqlite
 * Ausführen: node --experimental-sqlite test-dashboard.js
 */

import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import { hydrateBirthday, syncBirthdayArtifacts } from '../server/services/birthdays.js';
import { getUpcomingEvents } from '../server/services/calendar-events.js';

register('./test-browser-loader.mjs', import.meta.url);

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  pendingTests.push(Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ✗ ${name}: ${err.message}`);
      failed++;
    }));
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion fehlgeschlagen');
}

// --------------------------------------------------------
// DB aufbauen
// --------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);
db.exec(MIGRATIONS_SQL[1]);

// Testdaten einfügen
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('admin', 'Anna Admin', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max Muster', 'x', '#34C759')`).run();

const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const currentMonth = today.slice(0, 7);
const inOneHour = new Date(Date.now() + 3600000).toISOString();
const in30h = new Date(Date.now() + 30 * 3600000).toISOString().slice(0, 10);
const in72h = new Date(Date.now() + 72 * 3600000).toISOString().slice(0, 10);

// Aufgaben
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by, assigned_to)
  VALUES ('Urgent Task', 'urgent', 'open', ?, ?, ?)`).run(today, uid1, uid2);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task morgen', 'high', 'open', ?, ?)`).run(tomorrow, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('High Task in 3 Tagen', 'high', 'open', ?, ?)`).run(in72h, uid1);
db.prepare(`INSERT INTO tasks (title, priority, status, due_date, created_by)
  VALUES ('Done Task', 'urgent', 'done', ?, ?)`).run(today, uid1);

// Kalender-Events
const evMeeting = db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, assigned_to, color)
  VALUES ('Morgen-Meeting', ?, ?, ?, '#007AFF')`).run(inOneHour, uid1, uid2);
db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
  VALUES ('Event in 3 Tagen', ?, ?)`).run(in72h + 'T10:00:00Z', uid1);

// Multi-Assignments für Morgen-Meeting (uid1 + uid2 sind zugewiesen)
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid1);
db.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(evMeeting.lastInsertRowid, uid2);

// Mahlzeiten
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'breakfast', 'Haferbrei', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'dinner', 'Pasta', ?)`).run(today, uid1);
db.prepare(`INSERT INTO meals (date, meal_type, title, created_by)
  VALUES (?, 'lunch', 'Salat morgen', ?)`).run(tomorrow, uid1);

// Notizen
db.prepare(`INSERT INTO notes (content, title, pinned, color, created_by)
  VALUES ('Wichtige Info', 'Pinnwand-Notiz', 1, '#FFEB3B', ?)`).run(uid1);
db.prepare(`INSERT INTO notes (content, pinned, color, created_by)
  VALUES ('Nicht angepinnt', 0, '#E3F2FF', ?)`).run(uid1);

// Geburtstage
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Heute Geburtstag', ?, ?)`).run(`2012-${today.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Morgen Geburtstag', ?, ?)`).run(`2010-${tomorrow.slice(5)}`, uid1);
db.prepare(`INSERT INTO birthdays (name, birth_date, created_by)
  VALUES ('Anderer Nutzer', ?, ?)`).run(`2011-${today.slice(5)}`, uid2);

// Budget
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Salary', 3000, 'Erwerbseinkommen', '', ?, ?)`).run(`${currentMonth}-05`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Rent', -1200, 'housing', 'rent_mortgage', ?, ?)`).run(`${currentMonth}-06`, uid1);
db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by)
  VALUES ('Groceries', -450, 'food', 'supermarket', ?, ?)`).run(`${currentMonth}-07`, uid1);

console.log('\n[Dashboard-Test] API-Abfragen\n');

test('Today-Highlights priorisieren dringende Aufgaben und nächsten Termin', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const result = __test.buildTodayHighlights({
    tasks: [
      { id: 1, title: 'Low task', priority: 'low' },
      { id: 2, title: 'Pay bill', priority: 'urgent' },
    ],
    events: [{ id: 3, title: 'Dentist' }],
    shopping: { items: [{ is_checked: false }, { is_checked: true }] },
    meals: { dinner: { title: 'Soup' } },
  });

  assert(result.urgentTask.title === 'Pay bill', 'Urgent Task sollte priorisiert werden');
  assert(result.nextEvent.title === 'Dentist', 'Nächster Termin sollte übernommen werden');
  assert(result.openShoppingCount === 1, 'Offene Einkaufsartikel sollten gezählt werden');
  assert(result.dinner.title === 'Soup', 'Abendessen sollte übernommen werden');
});

test('Today-Highlights filtert Termine auf den heutigen Tag', async () => {
  const { __test } = await import('../public/pages/dashboard.js');
  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const result = __test.buildTodayHighlights({
    events: [
      { id: 1, title: 'Termin Morgen', start_datetime: `${tomorrowStr}T10:00:00` },
      { id: 2, title: 'Termin Heute', start_datetime: `${todayStr}T14:30:00` },
    ],
  });

  assert(result.eventCount === 1, `Erwartet 1 Termin für heute, erhalten ${result.eventCount}`);
  assert(result.nextEvent.title === 'Termin Heute', 'Erwartet "Termin Heute" als nächsten Termin');
});

// --------------------------------------------------------
// Tests: Dringende Aufgaben
// --------------------------------------------------------
const deadline48h = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);

test('Dringende Aufgaben: nur high/urgent mit Fälligkeit ≤ 48h und nicht done', () => {
  const tasks = db.prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.priority IN ('high', 'urgent')
      AND t.status != 'done'
      AND (t.due_date IS NULL OR t.due_date <= ?)
    ORDER BY CASE t.priority WHEN 'urgent' THEN 0 ELSE 1 END, t.due_date ASC
    LIMIT 10
  `).all(deadline48h);

  assert(tasks.length === 2, `Erwartet 2 Aufgaben, erhalten ${tasks.length}`);
  assert(tasks[0].priority === 'urgent', 'Urgent zuerst');
  assert(tasks[0].assigned_name === 'Max Muster', 'assigned_name korrekt');
  assert(tasks[0].assigned_color === '#34C759', 'assigned_color korrekt');
});

test('Dringende Aufgaben: erledigte Aufgaben werden nicht angezeigt', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const doneTask = tasks.find((t) => t.title === 'Done Task');
  assert(!doneTask, 'Erledigte Aufgaben sollten gefiltert sein');
});

test('Dringende Aufgaben: Task mit Fälligkeit in 3 Tagen wird ausgeschlossen', () => {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE priority IN ('high', 'urgent') AND status != 'done' AND due_date <= ?
  `).all(deadline48h);
  const farTask = tasks.find((t) => t.title === 'High Task in 3 Tagen');
  assert(!farTask, 'Aufgabe in 72h sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Anstehende Termine
// --------------------------------------------------------
test('Anstehende Termine: zukünftige Events, sortiert, max 5', () => {
  const now = new Date().toISOString();
  const events = db.prepare(`
    SELECT ce.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
    FROM calendar_events ce
    LEFT JOIN users u ON ce.assigned_to = u.id
    WHERE ce.start_datetime >= ?
    ORDER BY ce.start_datetime ASC
    LIMIT 5
  `).all(now);

  assert(events.length === 2, `Erwartet 2 Events, erhalten ${events.length}`);
  assert(events[0].title === 'Morgen-Meeting', 'Erstes Event ist das nächste');
  assert(events[0].assigned_color === '#34C759', 'assigned_color vom Join');
});

test('Anstehende Termine: Dashboard-Mapping erzeugt assigned_users Array (Issue #284)', () => {
  const raw = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const mapped = raw.map(({ assigned_users_json, ...event }) => {
    event.assigned_users = assigned_users_json ? JSON.parse(assigned_users_json) : [];
    return event;
  });

  const soccer = mapped.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss im Ergebnis sein');
  assert(!('assigned_users_json' in soccer), 'assigned_users_json darf nicht im Ergebnis sein');
  assert(Array.isArray(soccer.assigned_users), 'assigned_users muss ein Array sein');
  assert(soccer.assigned_users.length === 2, `Erwartet 2 Einträge, erhalten ${soccer.assigned_users.length}`);
  assert('avatar_data' in soccer.assigned_users[0], 'avatar_data muss im User-Objekt enthalten sein');

  const fieldTrip = mapped.find((e) => e.title === 'Sofia Field Trip');
  assert(fieldTrip, 'Sofia Field Trip muss erscheinen');
  assert(Array.isArray(fieldTrip.assigned_users) && fieldTrip.assigned_users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users Array');
});

// --------------------------------------------------------
// Tests: Heutige Mahlzeiten
// --------------------------------------------------------
test('Heutige Mahlzeiten: nur heute, in korrekter Reihenfolge', () => {
  const meals = db.prepare(`
    SELECT * FROM meals WHERE date = ?
    ORDER BY CASE meal_type
      WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1
      WHEN 'dinner' THEN 2 WHEN 'snack' THEN 3 END
  `).all(today);

  assert(meals.length === 2, `Erwartet 2 Mahlzeiten, erhalten ${meals.length}`);
  assert(meals[0].meal_type === 'breakfast', 'Frühstück zuerst');
  assert(meals[1].meal_type === 'dinner', 'Abendessen danach');
});

test('Heutige Mahlzeiten: morgige Mahlzeit nicht enthalten', () => {
  const meals = db.prepare(`SELECT * FROM meals WHERE date = ?`).all(today);
  const wrongMeal = meals.find((m) => m.title === 'Salat morgen');
  assert(!wrongMeal, 'Morgige Mahlzeit sollte nicht erscheinen');
});

// --------------------------------------------------------
// Tests: Angepinnte Notizen
// --------------------------------------------------------
test('Angepinnte Notizen: nur pinned=1, max 3', () => {
  const notes = db.prepare(`
    SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
    FROM notes n
    LEFT JOIN users u ON n.created_by = u.id
    WHERE n.pinned = 1
    ORDER BY n.updated_at DESC
    LIMIT 3
  `).all();

  assert(notes.length === 1, `Erwartet 1 Notiz, erhalten ${notes.length}`);
  assert(notes[0].title === 'Pinnwand-Notiz', 'Korrekte Notiz');
  assert(notes[0].author_name === 'Anna Admin', 'author_name vom Join');
});

test('Angepinnte Notizen: nicht angepinnte werden ausgeschlossen', () => {
  const notes = db.prepare(`SELECT * FROM notes WHERE pinned = 1`).all();
  const unpinned = notes.find((n) => n.content === 'Nicht angepinnt');
  assert(!unpinned, 'Nicht angepinnte Notiz sollte gefiltert sein');
});

// --------------------------------------------------------
// Tests: Geburtstage
// --------------------------------------------------------
test('Geburtstage: nur aktueller Nutzer, sortiert nach nächstem Geburtstag', () => {
  const rows = db.prepare('SELECT * FROM birthdays WHERE created_by = ? ORDER BY name COLLATE NOCASE ASC').all(uid1);
  const birthdays = rows
    .map((row) => hydrateBirthday(row, new Date(`${today}T12:00:00Z`)))
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
    .slice(0, 3);

  assert(rows.length === 2, `Erwartet 2 Geburtstage, erhalten ${rows.length}`);
  assert(birthdays[0].name === 'Heute Geburtstag', 'Heutiger Geburtstag zuerst');
  assert(birthdays[0].days_until === 0, 'Heutiger Geburtstag hat 0 Tage Rest');
});

// --------------------------------------------------------
// Tests: Budget
// --------------------------------------------------------
test('Budget: Monatswerte für Einnahmen, Ausgaben, Saldo und Top-Ausgabe', () => {
  const from = `${currentMonth}-01`;
  const to = `${currentMonth}-31`;
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
      SUM(amount) AS balance,
      COUNT(*) AS entry_count
    FROM budget_entries
    WHERE date BETWEEN ? AND ?
  `).get(from, to);

  const topExpense = db.prepare(`
    SELECT category, SUM(amount) AS amount
    FROM budget_entries
    WHERE amount < 0 AND date BETWEEN ? AND ?
    GROUP BY category
    ORDER BY ABS(SUM(amount)) DESC
    LIMIT 1
  `).get(from, to);

  assert(totals.income === 3000, `Einnahmen sollten 3000 sein, erhalten ${totals.income}`);
  assert(Math.abs(totals.expenses) === 1650, `Ausgaben sollten 1650 sein, erhalten ${totals.expenses}`);
  assert(totals.balance === 1350, `Saldo sollte 1350 sein, erhalten ${totals.balance}`);
  assert(totals.entry_count === 3, `Erwartet 3 Einträge, erhalten ${totals.entry_count}`);
  assert(topExpense.category === 'housing', 'Wohnen sollte Top-Ausgabenkategorie sein');
});

// --------------------------------------------------------
// Tests: getUpcomingEvents (geteilte Dashboard/Kalender-Logik)
// Regression für Issue #224: wiederkehrende Termine, deren Master-Start in
// der Vergangenheit liegt, müssen auf der Übersicht erscheinen.
// --------------------------------------------------------

// Eigene DB mit vollständigem Kalender-Schema (subscription_id, calendar_ref_id).
const cdb = new DatabaseSync(':memory:');
cdb.exec('PRAGMA foreign_keys = ON;');
cdb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
    avatar_data TEXT
  );
  CREATE TABLE external_calendars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, color TEXT
  );
  CREATE TABLE ics_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT,
    start_datetime TEXT NOT NULL, end_datetime TEXT,
    all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
    color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    external_source TEXT NOT NULL DEFAULT 'local',
    recurrence_rule TEXT,
    subscription_id INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
    calendar_ref_id INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL
  );
  CREATE TABLE event_assignments (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
  );
`);

const cu1 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('theodore', 'Theodore', 'x', '#34C759')`).run();
const cu2 = cdb.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('sofia', 'Sofia', 'x', '#AF52DE')`).run();
const cuTheo = cu1.lastInsertRowid;
const cuSofia = cu2.lastInsertRowid;

function insertEvent(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map(() => '?').join(', ');
  const r = cdb.prepare(`INSERT INTO calendar_events (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => fields[c]));
  return r.lastInsertRowid;
}

const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19);
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Tagesbeginn heute (UTC). Robust gegen die Tageszeit: ein Event hier ist immer
// "heute" und nie in der Zukunft, anders als now-Nh (rollt nach Mitternacht UTC
// auf gestern und macht den fromToday-Test #230 flaky).
const todayStartIso = () => `${new Date().toISOString().slice(0, 10)}T00:00:00`;

// Wiederkehrender Wochentermin, dessen Master-Start 14 Tage in der Vergangenheit liegt.
// Die nächste Instanz liegt in 7 Tagen relativ zum Master, also innerhalb des Fensters.
const recurStart = isoIn(-14 * DAY + 5 * HOUR);
const recurId = insertEvent({
  title: "Sofia Field Trip",
  start_datetime: recurStart,
  recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
  created_by: cuSofia,
  assigned_to: cuSofia,
});

// Nicht-wiederkehrender Termin in der Vergangenheit -> darf NICHT erscheinen.
insertEvent({ title: 'Past one-off', start_datetime: isoIn(-2 * DAY), created_by: cuTheo });

// Termin von heute Morgen (Vergangenheit, aber noch heute) -> bei fromToday erscheinen.
insertEvent({ title: 'Morning Meeting Today', start_datetime: todayStartIso(), created_by: cuTheo });

// Nicht-wiederkehrender Termin in der Zukunft -> erscheint.
// Beiden Nutzern (Theo + Sofia) zugewiesen – für Issue #284 (assigned_users im Dashboard).
const soccerId = insertEvent({ title: 'Theodore Soccer Game', start_datetime: isoIn(3 * DAY), created_by: cuTheo });
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuTheo);
cdb.prepare(`INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)`).run(soccerId, cuSofia);

test('getUpcomingEvents: wiederkehrender Termin mit Vergangenheits-Start erscheint (Issue #224)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const sofia = events.find((e) => e.title === 'Sofia Field Trip');
  assert(sofia, 'Wiederkehrender "Sofia Field Trip" muss in den anstehenden Terminen erscheinen');
  assert(sofia.start_datetime >= new Date().toISOString(), 'Die expandierte Instanz liegt in der Zukunft');
  assert(sofia.id === recurId, 'Behält die Original-Event-ID der Serie');
});

test('getUpcomingEvents: vergangene Einzeltermine erscheinen nicht', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(!events.find((e) => e.title === 'Past one-off'), 'Vergangener Einzeltermin darf nicht erscheinen');
  assert(!events.find((e) => e.title === 'Morning Meeting Today'), 'Vergangener Heute-Termin ohne fromToday nicht erscheinen');
});

test('getUpcomingEvents: fromToday=true zeigt heutige vergangene Termine (Issue #230)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  assert(events.find((e) => e.title === 'Morning Meeting Today'),
    'Heute-Morgen-Termin muss mit fromToday=true erscheinen');
  assert(!events.find((e) => e.title === 'Past one-off'),
    'Termin von gestern darf auch mit fromToday nicht erscheinen');
});

test('getUpcomingEvents: zukünftige Termine sortiert und auf limit begrenzt', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  assert(events.find((e) => e.title === 'Theodore Soccer Game'), 'Zukünftiger Einzeltermin erscheint');
  for (let i = 1; i < events.length; i++) {
    assert(events[i - 1].start_datetime <= events[i].start_datetime, 'Aufsteigend nach Startzeit sortiert');
  }
  const limited = getUpcomingEvents(cdb, { userId: cuTheo, limit: 1 });
  assert(limited.length === 1, `limit=1 liefert genau 1 Event, erhalten ${limited.length}`);
});

test('getUpcomingEvents: assigned_users_json enthält avatar_data (Issue #284)', () => {
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10 });
  const soccer = events.find((e) => e.title === 'Theodore Soccer Game');
  assert(soccer, 'Theodore Soccer Game muss erscheinen');
  assert('assigned_users_json' in soccer, 'assigned_users_json muss im rohen Event enthalten sein');
  const users = JSON.parse(soccer.assigned_users_json);
  assert(Array.isArray(users) && users.length === 2,
    `Erwartet 2 zugewiesene User, erhalten ${users.length}`);
  assert(users.every((u) => 'avatar_data' in u),
    'Jeder User im assigned_users_json muss avatar_data enthalten');
  const theo  = users.find((u) => u.display_name === 'Theodore');
  const sofia = users.find((u) => u.display_name === 'Sofia');
  assert(theo,  'Theodore muss in assigned_users sein');
  assert(sofia, 'Sofia muss in assigned_users sein');
});

test('getUpcomingEvents: Event ohne Assignments hat leeres assigned_users_json Array (Issue #284)', () => {
  // Morning Meeting Today wurde ohne event_assignments eingefügt.
  const mornEvents = getUpcomingEvents(cdb, { userId: cuTheo, limit: 10, fromToday: true });
  const mm = mornEvents.find((e) => e.title === 'Morning Meeting Today');
  assert(mm, 'Morning Meeting Today mit fromToday=true vorhanden');
  const users = JSON.parse(mm.assigned_users_json ?? '[]');
  assert(Array.isArray(users) && users.length === 0,
    'Event ohne Zuweisung hat leeres assigned_users_json Array');
});

test('getUpcomingEvents: private ICS-Termine fremder User werden ausgeblendet', () => {
  const sub = cdb.prepare(`INSERT INTO ics_subscriptions (name, shared, created_by) VALUES ('Privat', 0, ?)`)
    .run(cuSofia).lastInsertRowid;
  insertEvent({
    title: 'Sofias privater ICS-Termin',
    start_datetime: isoIn(2 * DAY),
    external_source: 'ics',
    subscription_id: sub,
    created_by: cuSofia,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20 });
  assert(!events.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Privates ICS-Abo eines anderen Users darf nicht erscheinen');
  const ownerEvents = getUpcomingEvents(cdb, { userId: cuSofia, limit: 20 });
  assert(ownerEvents.find((e) => e.title === 'Sofias privater ICS-Termin'),
    'Eigentümer sieht seinen privaten ICS-Termin');
});

// --------------------------------------------------------
// Bug #360: Geburtstag mit reminder_offset='' darf nicht als Kalender-Event existieren
// --------------------------------------------------------
{
  const bdb = new DatabaseSync(':memory:');
  bdb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar_color TEXT NOT NULL DEFAULT '#007AFF',
      avatar_data TEXT
    );
    CREATE TABLE calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT,
      start_datetime TEXT NOT NULL, end_datetime TEXT,
      all_day INTEGER NOT NULL DEFAULT 0, location TEXT,
      color TEXT NOT NULL DEFAULT '#007AFF', icon TEXT NOT NULL DEFAULT 'calendar',
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL DEFAULT 'local',
      recurrence_rule TEXT,
      subscription_id INTEGER,
      calendar_ref_id INTEGER
    );
    CREATE TABLE birthdays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, birth_date TEXT NOT NULL, notes TEXT,
      photo_data TEXT, created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      reminder_offset TEXT, reminder_custom_amount TEXT, reminder_custom_unit TEXT,
      updated_at TEXT
    );
    CREATE TABLE event_assignments (
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE ics_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  const bUserId = bdb.prepare(
    `INSERT INTO users (username, display_name, password_hash, avatar_color) VALUES ('bert', 'Bert', 'x', '#ff0')`
  ).run().lastInsertRowid;

  test('syncBirthdayArtifacts: reminder_offset="" → kein calendar_event_id (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Max', '1990-05-10', ?, '')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'Geburtstag ohne Benachrichtigung darf kein Kalender-Event haben');
    const evCount = bdb.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n;
    assert(evCount === 0, 'Keine Kalender-Events in der DB erwartet');
  });

  test('syncBirthdayArtifacts: vorhandenes Event wird bei reminder_offset="" gelöscht (Issue #360)', () => {
    const evId = bdb.prepare(
      `INSERT INTO calendar_events (title, start_datetime, all_day, created_by) VALUES ('Geburtstag Hans', '1985-03-15', 1, ?)`
    ).run(bUserId).lastInsertRowid;
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, calendar_event_id, reminder_offset) VALUES ('Hans', '1985-03-15', ?, ?, '')`
    ).run(bUserId, evId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(evId);
    assert(!ev, 'Vorhandenes Kalender-Event muss gelöscht worden sein');
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id === null, 'calendar_event_id in birthdays muss NULL sein');
  });

  test('syncBirthdayArtifacts: reminder_offset gesetzt → Kalender-Event wird angelegt (Issue #360)', () => {
    const bdId = bdb.prepare(
      `INSERT INTO birthdays (name, birth_date, created_by, reminder_offset) VALUES ('Lisa', '1992-07-20', ?, '1440')`
    ).run(bUserId).lastInsertRowid;
    const bd = bdb.prepare('SELECT * FROM birthdays WHERE id = ?').get(bdId);
    syncBirthdayArtifacts(bdb, bd);
    const updated = bdb.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bdId);
    assert(updated.calendar_event_id !== null, 'Geburtstag mit Erinnerung muss ein Kalender-Event haben');
    const ev = bdb.prepare('SELECT * FROM calendar_events WHERE id = ?').get(updated.calendar_event_id);
    assert(ev, 'Kalender-Event muss existieren');
    assert(ev.all_day === 1, 'Geburtstags-Event muss ganztägig sein');
  });
}

// --------------------------------------------------------
// Bug-Fixes: ganztägige Termine + Geburtstags-Filterung
// --------------------------------------------------------
test('getUpcomingEvents: ganztägiger Termin heute erscheint mit fromToday=true (Issue #360)', () => {
  const todayDate = new Date().toISOString().slice(0, 10);
  insertEvent({
    title: 'Ganztägiger Termin heute',
    start_datetime: todayDate, // kein T-Teil – genau das war das Problem
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Termin heute'),
    'Heutiger ganztägiger Termin muss im Dashboard erscheinen (start_datetime ohne Zeit-Teil)');
});

test('getUpcomingEvents: ganztägiger Termin in der Zukunft erscheint (Issue #360)', () => {
  const futureDate = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  insertEvent({
    title: 'Ganztägiger Zukunfts-Termin',
    start_datetime: futureDate,
    all_day: 1,
    created_by: cuTheo,
  });
  const events = getUpcomingEvents(cdb, { userId: cuTheo, limit: 20, fromToday: true });
  assert(events.find((e) => e.title === 'Ganztägiger Zukunfts-Termin'),
    'Zukünftiger ganztägiger Termin muss im Dashboard erscheinen');
});

// --------------------------------------------------------
// Ergebnis
// --------------------------------------------------------
await Promise.all(pendingTests);

console.log(`\n[Dashboard-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
