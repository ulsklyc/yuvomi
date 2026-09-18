/**
 * Modul: Erinnerungen eines haushaltsweit abgeschalteten Moduls (#1279)
 * Zweck: `disabled_modules` heisst "dieses Modul gibt es hier nicht". Bis #1279
 *        hielten sich nur Vorrat, Schichtplan und Muell daran; Aufgaben, Termine,
 *        Abos, Inventar, Dokumente, Zyklus und Geburtstage meldeten sich weiter,
 *        per Push, Kanal und Toast, und der Tipp auf die Meldung oeffnete eine
 *        Seite, die der Routen-Guard abweist. Diese Suite haelt fest:
 *          1. Zustellung (processDueNotifications) und GET /reminders/pending
 *             UEBERSPRINGEN die Zeile eines abgeschalteten Moduls, loeschen sie
 *             aber nicht - nach dem Wiedereinschalten geht sie raus. Je Quelle
 *             ein Fall, jeweils mit einem eingeschalteten Modul als Gegenfall.
 *          2. Zyklus und Geburtstage, die ein Lauf periodisch neu herstellt,
 *             raeumen ihre ausstehenden Zeilen ab und legen sie nach dem
 *             Wiedereinschalten neu an. Geburtstage laufen als `event`, folgen
 *             aber dem Schalter `birthdays`, nicht `calendar`.
 *          3. Der Guard: jede Herkunft, die die Datenbank annimmt, steht in der
 *             Karte ORIGIN_MODULE und zeigt auf ein schaltbares Modul - sonst
 *             faellt eine neue Herkunft still aus /pending.
 *
 * Netzfrei: In-Memory-SQLite ueber die volle Migrationskette, Push-Dienst und
 * Kanal-Provider sind Attrappen, der Router laeuft auf einem Loopback-Port.
 * Ausfuehren: node --test test/test-disabled-module-reminders.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
// Als Namensraum geladen, nicht als benannter Import: so laedt die Suite auch
// gegen einen Stand, der die Exporte noch nicht hat (Gegenprobe gegen main),
// und nur der Guard wird rot statt der ganzen Datei.
const remindersModule = await import('../server/routes/reminders.js');
const preferencesModule = await import('../server/routes/preferences.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { syncAllBirthdayReminders } = await import('../server/services/birthdays.js');
const { syncCycleRemindersForUser, syncAllCycleReminders } = await import('../server/services/cycle-reminders.js');
const { ORIGIN_MODULE } = await import('../server/services/reminder-origins.js');

// Fest und in der Vergangenheit: die Syncs rechnen mit `now`, GET /pending mit
// der Wanduhr. Liegt NOW sicher davor, ist eine hier faellige Zeile auch dort
// faellig, ohne dass ein Test an einem bestimmten Tag haengt.
const NOW = new Date('2024-06-15T12:00:00Z');
const PAST = '2000-01-01T00:00:00';

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(database); else database.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return database;
}

function setDisabled(database, modules) {
  database.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(modules));
}

/**
 * Eine frische Datenbank JE TEST: die Zustellung laeuft ueber alle faelligen
 * Zeilen aller Nutzer, eine geteilte Datenbank liesse Faelle ineinander greifen.
 * `_setTestDatabase`, weil Teile der Kette `db.get()` lesen (Router,
 * healthCycleViews() im Zyklus-Sync).
 */
function freshDb() {
  const database = buildTestDb();
  _setTestDatabase(database);
  database.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', 'UTC')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  // Die Kette schaltet Inventar, Schichtplan und Muell ab (Migrationen 145, 166,
  // 198). Jeder Test setzt den Schalter selbst.
  setDisabled(database, []);
  createNotificationChannelStore({ db: database }).createChannel({
    provider: 'ntfy', name: 'ntfy', enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {},
  });
  return database;
}

let userSeq = 0;
function freshUser(database, displayName = null) {
  userSeq += 1;
  const id = database.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, '$2b$12$x', 'member')`,
  ).run(`dm-u${userSeq}`, displayName ?? `User ${userSeq}`).lastInsertRowid;
  database.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(id, `https://push.test/${id}`, 'p', 'a');
  return id;
}

const makeTask = (database, owner) => database.prepare(
  `INSERT INTO tasks (title, category, status, created_by) VALUES ('Kehrwoche', 'Sonstiges', 'open', ?)`,
).run(owner).lastInsertRowid;
const makeEvent = (database, owner) => database.prepare(
  `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Elternabend', '2024-07-01T19:00', ?)`,
).run(owner).lastInsertRowid;
const makeSubscription = (database, owner) => database.prepare(
  `INSERT INTO budget_subscriptions (name, amount, currency, billing_cycle, next_payment_date, created_by)
   VALUES ('Streaming', 9.99, 'EUR', 'monthly', '2024-07-01', ?)`,
).run(owner).lastInsertRowid;
const makeInventoryItem = (database, owner) => database.prepare(
  `INSERT INTO inventory_items (name, created_by) VALUES ('Waschmaschine', ?)`,
).run(owner).lastInsertRowid;
const makeTrackedDate = (database, owner) => database.prepare(
  `INSERT INTO inventory_item_dates (item_id, label, date) VALUES (?, 'Wartung', '2024-07-01')`,
).run(makeInventoryItem(database, owner)).lastInsertRowid;
const makeDocument = (database, owner) => database.prepare(`
  INSERT INTO family_documents (name, original_name, mime_type, file_size, content_data, expires_at, created_by)
  VALUES ('Reisepass', 'pass.pdf', 'application/pdf', 1, ?, '2024-07-01', ?)
`).run(Buffer.from('x'), owner).lastInsertRowid;

function insertReminder(database, owner, entityType, entityId, remindAt = PAST) {
  return database.prepare(
    'INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)',
  ).run(entityType, entityId, remindAt, owner).lastInsertRowid;
}

function reminderRow(database, id) {
  return database.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
}

/**
 * Ein Zustelllauf ueber den echten Pfad. Zurueck kommen die Tags, die per Push
 * und per Kanal rausgingen - getrennt, damit ein Filter, der nur einen der
 * beiden Wege sperrt, nicht als dicht durchgeht.
 */
async function deliver(database, now = NOW) {
  const push = new Set();
  const channel = new Set();
  const bodies = new Map();
  await processDueNotifications({
    database,
    channelStore: createNotificationChannelStore({ db: database }),
    pushService: { sendPushToUser: async (_userId, payload) => { push.add(payload.tag); return 1; } },
    providers: {
      ntfy: { id: 'ntfy', send: async ({ payload }) => { channel.add(payload.tag); bodies.set(payload.tag, payload.body); return { ok: true, status: 200 }; } },
    },
    now,
  });
  return { push, channel, bodies };
}

function assertDelivered(run, reminderId, message) {
  assert.ok(run.push.has(`reminder-${reminderId}`), `${message} (Push)`);
  assert.ok(run.channel.has(`reminder-${reminderId}`), `${message} (Kanal)`);
}

function assertNotDelivered(run, reminderId, message) {
  assert.ok(!run.push.has(`reminder-${reminderId}`), `${message} (Push)`);
  assert.ok(!run.channel.has(`reminder-${reminderId}`), `${message} (Kanal)`);
}

// --------------------------------------------------------
// GET /reminders/pending ueber den echten Router
// --------------------------------------------------------
let currentUid = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: 'member' };
  req.authScopes = null;
  req.sessionModuleAccess = null;
  next();
});
app.use('/api/v1/reminders', remindersModule.default);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;
test.after(() => server.close());

async function pending(userId) {
  currentUid = userId;
  const res = await fetch(`${base}/pending`);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

// --------------------------------------------------------------------------
// 1. VON HAND GESETZT ODER BEIM SCHREIBEN ABGELEITET: UEBERSPRINGEN, NICHT LOESCHEN
//
// Aufgaben und Termine setzt jemand von Hand, Abo-, Inventar- und Dokument-
// Erinnerungen entstehen nur beim Speichern ihres Datensatzes. Kein Lauf legt
// sie wieder an, also darf das Abschalten sie nicht loeschen.
// --------------------------------------------------------------------------
const NOT_RECREATED = [
  { type: 'task',                   module: 'tasks',     make: makeTask },
  { type: 'event',                  module: 'calendar',  make: makeEvent },
  { type: 'subscription',           module: 'budget',    make: makeSubscription },
  { type: 'inventory_item',         module: 'inventory', make: makeInventoryItem },
  { type: 'inventory_tracked_date', module: 'inventory', make: makeTrackedDate },
  { type: 'document_expiry',        module: 'documents', make: makeDocument },
];

for (const source of NOT_RECREATED) {
  test(`${source.type}: abgeschaltet weder zugestellt noch in /pending, nach dem Einschalten schon`, async () => {
    const database = freshDb();
    const owner = freshUser(database);
    const id = insertReminder(database, owner, source.type, source.make(database, owner));
    // Gegenfall: ein eingeschaltetes Modul, damit der Filter nicht einfach alles schluckt.
    const [otherType, makeOther] = source.type === 'task' ? ['event', makeEvent] : ['task', makeTask];
    const otherId = insertReminder(database, owner, otherType, makeOther(database, owner));

    setDisabled(database, [source.module]);
    const off = await deliver(database);
    assertNotDelivered(off, id, `${source.type}: ${source.module} ist abgeschaltet und meldet sich trotzdem`);
    assertDelivered(off, otherId, `${otherType}: ein eingeschaltetes Modul wurde mitgesperrt`);
    const offRow = reminderRow(database, id);
    assert.ok(offRow, 'die Zeile wurde geloescht - kein Lauf legt sie wieder an');
    assert.equal(offRow.pushed_at, null, 'die Zeile gilt als zugestellt, obwohl nichts rausging');

    const offPending = (await pending(owner)).map((r) => r.id);
    assert.ok(!offPending.includes(id), `${source.type}: /pending liefert die Zeile eines abgeschalteten Moduls`);
    assert.ok(offPending.includes(otherId), `${otherType}: /pending hat ein eingeschaltetes Modul mitgesperrt`);

    setDisabled(database, []);
    const on = await deliver(database);
    assertDelivered(on, id, `${source.type}: nach dem Wiedereinschalten ging die ausstehende Zeile nicht raus`);
    assert.notEqual(reminderRow(database, id).pushed_at, null);
    assert.ok((await pending(owner)).some((r) => r.id === id), `${source.type}: nach dem Einschalten fehlt die Zeile in /pending`);
    database.close();
  });
}

// --------------------------------------------------------------------------
// 2. ZYKLUS: PERIODISCH HERGESTELLT - ABRAEUMEN UND NEU ANLEGEN
// --------------------------------------------------------------------------
test('Zyklus: Health abgeschaltet raeumt die Erinnerung ab, nach dem Einschalten legt der Lauf sie neu an', async () => {
  const database = freshDb();
  const user = freshUser(database);
  database.prepare('INSERT INTO cycle_settings (user_id, remind_log_daily) VALUES (?, 1)').run(user);
  const taskId = insertReminder(database, user, 'task', makeTask(database, user));

  syncCycleRemindersForUser(database, user, NOW);
  const nudges = () => database.prepare(
    "SELECT * FROM reminders WHERE entity_type = 'cycle_log_nudge' AND created_by = ?",
  ).all(user);
  assert.equal(nudges().length, 1, 'Vorbedingung: der Log-Hinweis fuer heute steht');

  setDisabled(database, ['health']);
  syncAllCycleReminders(database, NOW);
  assert.deepEqual(nudges(), [], 'der Sync raeumt bei abgeschaltetem Health nicht ab');

  const off = await deliver(database);
  assert.deepEqual([...off.push], [`reminder-${taskId}`],
    'bei abgeschaltetem Health ging mehr raus als die Aufgabe - oder die Aufgabe wurde mitgesperrt');
  assert.ok(!(await pending(user)).some((r) => r.entity_type === 'cycle_log_nudge'),
    '/pending liefert eine Zyklus-Erinnerung, obwohl Health abgeschaltet ist');

  setDisabled(database, []);
  const on = await deliver(database);
  const [recreated] = nudges();
  assert.ok(recreated, 'nach dem Wiedereinschalten legt der Lauf die Erinnerung nicht neu an');
  assertDelivered(on, recreated.id, 'die neu angelegte Zyklus-Erinnerung ging nicht raus');
  assert.ok((await pending(user)).some((r) => r.entity_type === 'cycle_log_nudge'));
  database.close();
});

// Die Zustellung liest seit #1279 `r.entity_id` mit (die Geburtstags-Ausnahme
// braucht es). Davon haengt auch der Name in der Partner-Meldung ab: der
// Nachschlag cycleOwnerName() in notifications.js fragte mit `entity_id`, das
// die Sammelabfrage nie lieferte, fand nie jemanden und fiel immer auf den
// neutralen Text zurueck.
test('Zyklus: die Partner-Meldung nennt die Person, deren Periode erwartet wird', async () => {
  const database = freshDb();
  const owner = freshUser(database, 'Anna');
  const partner = freshUser(database, 'Ben');
  for (const [start, end] of [['2024-03-01', '2024-03-05'], ['2024-03-31', '2024-04-04'], ['2024-04-30', '2024-05-04'], ['2024-05-30', '2024-06-03']]) {
    database.prepare("INSERT INTO cycle_periods (user_id, start_date, end_date, visibility) VALUES (?, ?, ?, 'private')")
      .run(owner, start, end);
  }
  // Naechster vorhergesagter Beginn 2024-06-29, vierzehn Tage vorher = NOW.
  database.prepare('INSERT INTO cycle_settings (user_id, notify_partner_user_id, notify_partner_days_before) VALUES (?, ?, 14)')
    .run(owner, partner);

  const run = await deliver(database);
  const row = database.prepare("SELECT id FROM reminders WHERE entity_type = 'cycle_period' AND created_by = ?").get(partner);
  assert.ok(row, 'Vorbedingung: die Partner-Erinnerung steht');
  assertDelivered(run, row.id, 'die Partner-Erinnerung ging nicht raus');
  assert.match(run.bodies.get(`reminder-${row.id}`), /Anna/,
    'die Partner-Meldung faellt auf den neutralen Text zurueck, obwohl der Name bekannt ist');
  database.close();
});

// --------------------------------------------------------------------------
// 3. GEBURTSTAGE: `event`-ZEILEN MIT EIGENEM SCHALTER
// --------------------------------------------------------------------------
// Vorlauf 60 Wochen: der naechste Geburtstag liegt hoechstens 366 Tage voraus,
// die Erinnerung also immer in der Vergangenheit - faellig gegen NOW wie gegen
// die Wanduhr, mit der GET /pending seinen eigenen Geburtstags-Sync faehrt.
function makeBirthday(database, owner, name) {
  return database.prepare(`
    INSERT INTO birthdays (name, birth_date, reminder_offset, reminder_custom_amount, reminder_custom_unit, created_by)
    VALUES (?, '1950-03-10', 'custom', 60, 'weeks', ?)
  `).run(name, owner).lastInsertRowid;
}

function birthdayReminders(database, birthdayId) {
  return database.prepare(`
    SELECT r.* FROM reminders r JOIN birthdays b ON b.calendar_event_id = r.entity_id
    WHERE r.entity_type = 'event' AND b.id = ?
  `).all(birthdayId);
}

const isBirthdayToast = (row) => row.entity_type === 'event' && /Oma Erika/.test(row.entity_title ?? '');

test('Geburtstage: abgeschaltet raeumt der Lauf ab und nichts geht raus, nach dem Einschalten kommt die Erinnerung wieder', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const birthday = makeBirthday(database, owner, 'Oma Erika');
  const taskId = insertReminder(database, owner, 'task', makeTask(database, owner));
  syncAllBirthdayReminders(database, owner, NOW);
  assert.equal(birthdayReminders(database, birthday).length, 1, 'Vorbedingung: die Geburtstags-Erinnerung steht');

  setDisabled(database, ['birthdays']);
  const off = await deliver(database);
  assert.deepEqual(birthdayReminders(database, birthday), [],
    'der Geburtstags-Sync raeumt bei abgeschaltetem Modul die ausstehende Zeile nicht ab');
  assert.equal(off.push.size, 1, 'es ging mehr raus als die Aufgabe');
  assertDelivered(off, taskId, 'Aufgaben sind eingeschaltet und wurden mitgesperrt');
  assert.ok(!(await pending(owner)).some(isBirthdayToast),
    '/pending liefert eine Geburtstags-Erinnerung, obwohl das Modul abgeschaltet ist');

  setDisabled(database, []);
  const on = await deliver(database);
  const [recreated] = birthdayReminders(database, birthday);
  assert.ok(recreated, 'nach dem Wiedereinschalten legt der Lauf die Erinnerung nicht neu an');
  assertDelivered(on, recreated.id, 'die neu angelegte Geburtstags-Erinnerung ging nicht raus');
  assert.ok((await pending(owner)).some(isBirthdayToast));
  database.close();
});

test('Geburtstage: abgeraeumt wird nur Ausstehendes - eine zugestellte Meldung kommt nach dem Einschalten nicht doppelt', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const birthday = makeBirthday(database, owner, 'Oma Erika');
  syncAllBirthdayReminders(database, owner, NOW);
  const [row] = birthdayReminders(database, birthday);
  assertDelivered(await deliver(database), row.id, 'Vorbedingung: die Erinnerung geht einmal raus');

  setDisabled(database, ['birthdays']);
  syncAllBirthdayReminders(database, owner, NOW);
  const kept = birthdayReminders(database, birthday);
  assert.deepEqual(kept.map((r) => r.id), [row.id], 'der Lauf hat eine bereits zugestellte Zeile geloescht');

  setDisabled(database, []);
  const on = await deliver(database);
  assert.equal(on.push.size, 0, 'dieselbe Geburtstags-Meldung ging nach dem Einschalten ein zweites Mal raus');
  database.close();
});

test('Geburtstage folgen ihrem eigenen Schalter: Kalender aus, Geburtstage an - die Geburtstags-Erinnerung kommt, der Termin nicht', async () => {
  const database = freshDb();
  const owner = freshUser(database);
  const birthday = makeBirthday(database, owner, 'Oma Erika');
  syncAllBirthdayReminders(database, owner, NOW);
  const [birthdayRow] = birthdayReminders(database, birthday);
  const eventId = insertReminder(database, owner, 'event', makeEvent(database, owner));

  setDisabled(database, ['calendar']);
  const run = await deliver(database);
  assertDelivered(run, birthdayRow.id, 'ein abgeschalteter Kalender hat die Geburtstags-Erinnerung mitgenommen');
  assertNotDelivered(run, eventId, 'ein Termin meldet sich, obwohl der Kalender abgeschaltet ist');

  const rows = await pending(owner);
  assert.ok(rows.some(isBirthdayToast), '/pending: der abgeschaltete Kalender nimmt die Geburtstage mit');
  assert.ok(!rows.some((r) => r.id === eventId), '/pending liefert einen Termin des abgeschalteten Kalenders');
  database.close();
});

// --------------------------------------------------------------------------
// 4. DER GUARD GEGEN DIE LUECKE VON MORGEN
//
// `mayTouchOrigin()` lehnt eine Herkunft ab, die ORIGIN_MODULE nicht kennt, und
// der Haushaltsschalter erreicht nur, was auf ein schaltbares Modul zeigt. Eine
// neue Herkunft, die nur in VALID_ENTITY_TYPES und der CHECK-Liste landet
// (so gebaut in #1179 fuer `fasting_goal`/`fasting_next_start`), verschwaende
// still aus /pending und ginge an jedem Schalter vorbei.
// --------------------------------------------------------------------------
test('jede Herkunft, die die Datenbank annimmt, steht in ORIGIN_MODULE und zeigt auf ein schaltbares Modul', () => {
  const database = freshDb();
  const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  database.close();
  const check = sql.match(/entity_type\s+IN\s*\(([^)]*)\)/i);
  assert.ok(check, 'die CHECK-Liste von reminders.entity_type ist nicht mehr lesbar - das Muster greift nicht');
  const checkTypes = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const validTypes = remindersModule.VALID_ENTITY_TYPES;
  // Reichweiten-Nachweis: beide Listen muessen wirklich gelesen worden sein.
  assert.ok(checkTypes.length >= 12, `nur ${checkTypes.length} Typen in der CHECK-Liste gefunden`);
  assert.ok(Array.isArray(validTypes) && validTypes.length >= 12, 'VALID_ENTITY_TYPES ist nicht exportiert oder leer');

  const unmapped = [...new Set([...checkTypes, ...validTypes])].filter((type) => !Object.hasOwn(ORIGIN_MODULE, type));
  assert.deepEqual(unmapped, [],
    'Herkunft ohne Modul in server/services/reminder-origins.js - sie faellt still aus /pending');

  const toggleable = preferencesModule.TOGGLEABLE_MODULES;
  assert.ok(Array.isArray(toggleable) && toggleable.includes('birthdays'), 'TOGGLEABLE_MODULES ist nicht exportiert');
  const unswitchable = Object.entries(ORIGIN_MODULE).filter(([, moduleKey]) => !toggleable.includes(moduleKey));
  assert.deepEqual(unswitchable, [],
    'Herkunft zeigt auf ein Modul, das der Haushaltsschalter nicht kennt - sie meldet sich immer');
});
