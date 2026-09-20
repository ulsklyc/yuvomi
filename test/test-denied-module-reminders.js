/**
 * Modul: Erinnerungen eines dem MITGLIED entzogenen Moduls (#1289)
 * Zweck: `access_permissions` mit `none` heisst "dieses Mitglied hat das Modul
 *        nicht". `GET /reminders/pending` hielt sich daran (`mayTouchOrigin()`),
 *        Web Push und die Benachrichtigungskanaele nicht: wer `tasks`, `budget`
 *        oder `documents` verlor, sah den Toast nicht mehr und bekam den
 *        Aufgabentitel, den Abo-Betrag samt Datum und den Dokumentnamen weiter
 *        aufs Telefon - der Tipp darauf oeffnete eine Seite, die der
 *        Routen-Guard abweist. Diese Suite haelt fest:
 *          1. Zustellung (processDueNotifications) UND /pending ueberspringen
 *             die Zeile eines entzogenen Moduls, loeschen sie aber nicht - nach
 *             der Rueckgabe des Rechts geht sie raus. Je Quelle ein Fall, mit
 *             zwei Gegenfaellen: ein anderes Modul desselben Mitglieds und
 *             dasselbe Modul eines anderen Mitglieds.
 *          2. Die Achse ist `none`, nicht `read`: wer lesen darf, hoert weiter
 *             von seinen Erinnerungen.
 *          3. Der Entzug zaehlt aus beiden Quellen der Rechteaufloesung
 *             (Rollenprofil und Mitglied-Override), und ein Admin faellt nie
 *             heraus.
 *          4. Der Guard: jede Herkunft zeigt auf ein Modul der Rechtematrix -
 *             sonst geht eine neue Herkunft an dieser Achse vorbei.
 *
 * Schwestersuite zu test-disabled-module-reminders.js, die dieselbe Frage fuer
 * den HAUSHALTSWEITEN Schalter stellt. Netzfrei: In-Memory-SQLite ueber die
 * volle Migrationskette, Push-Dienst und Kanal-Provider sind Attrappen, der
 * Router laeuft auf einem Loopback-Port.
 * Ausfuehren: node --test test/test-denied-module-reminders.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const remindersModule = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { ORIGIN_MODULE } = await import('../server/services/reminder-origins.js');
const { PERMISSION_MODULES, resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');

// Fest und in der Vergangenheit, gleiche Begruendung wie in der Schwestersuite:
// die Syncs rechnen mit `now`, GET /pending mit der Wanduhr.
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

/**
 * Eine frische Datenbank JE TEST - die Zustellung laeuft ueber alle faelligen
 * Zeilen aller Nutzer. Die Migrationskette schaltet Inventar, Schichtplan und
 * Muell haushaltweit ab (145, 166, 198); hier geht es um die ANDERE Achse, also
 * steht der Haushaltsschalter ueberall auf "an" und misst nicht mit.
 */
function freshDb() {
  const database = buildTestDb();
  _setTestDatabase(database);
  for (const [key, value] of [['household_timezone', 'UTC'], ['disabled_modules', '[]']]) {
    database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
  createNotificationChannelStore({ db: database }).createChannel({
    provider: 'ntfy', name: 'ntfy', enabled: true,
    config: { baseUrl: 'https://ntfy.test', topic: 'family' }, secrets: {},
  });
  return database;
}

let userSeq = 0;
function freshUser(database, { role = 'member', familyRole = 'other' } = {}) {
  userSeq += 1;
  const id = database.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, '$2b$12$x', ?, ?)`,
  ).run(`dn-u${userSeq}`, `User ${userSeq}`, role, familyRole).lastInsertRowid;
  database.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(id, `https://push.test/${id}`, 'p', 'a');
  return id;
}

/** Ein Modul einem Subjekt entziehen bzw. auf `read` setzen (sparse, wie die Admin-UI schreibt). */
function setModuleAccess(database, subjectType, subjectId, moduleKey, access) {
  database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, 'module', ?, ?)
    ON CONFLICT(subject_type, subject_id, resource_type, resource_key) DO UPDATE SET access = excluded.access
  `).run(subjectType, String(subjectId), moduleKey, access);
}

function clearModuleAccess(database, subjectType, subjectId, moduleKey) {
  database.prepare(`
    DELETE FROM access_permissions
    WHERE subject_type = ? AND subject_id = ? AND resource_type = 'module' AND resource_key = ?
  `).run(subjectType, String(subjectId), moduleKey);
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
 * Ein Zustelllauf ueber den echten Pfad. Zurueck kommen die Tags getrennt nach
 * Push und Kanal, damit ein Filter, der nur einen der beiden Wege sperrt, nicht
 * als dicht durchgeht - der Kanal ist haushaltweit, der Push haengt am Konto.
 */
async function deliver(database, now = NOW) {
  const push = new Set();
  const channel = new Set();
  await processDueNotifications({
    database,
    channelStore: createNotificationChannelStore({ db: database }),
    pushService: { sendPushToUser: async (_userId, payload) => { push.add(payload.tag); return 1; } },
    providers: {
      ntfy: { id: 'ntfy', send: async ({ payload }) => { channel.add(payload.tag); return { ok: true, status: 200 }; } },
    },
    now,
  });
  return { push, channel };
}

/**
 * BEIDE WEGE IN EINER ZUSICHERUNG, und das ist der Unterschied zwischen einem
 * Beleg und einem halben: zwei `assert.ok()` hintereinander brechen beim ersten
 * ab, und die rote Zeile der Gegenprobe nennt dann nur den Push - ob der Kanal
 * ueberhaupt gemessen wurde, stuende nirgends. So nennt die Meldung jeden Weg,
 * der ausgeschert ist.
 */
const legs = (run, reminderId) => ({ Push: run.push.has(`reminder-${reminderId}`), Kanal: run.channel.has(`reminder-${reminderId}`) });

function assertDelivered(run, reminderId, message) {
  const missing = Object.entries(legs(run, reminderId)).filter(([, hit]) => !hit).map(([leg]) => leg);
  assert.deepEqual(missing, [], `${message} (fehlt: ${missing.join(' + ') || '-'})`);
}

function assertNotDelivered(run, reminderId, message) {
  const leaked = Object.entries(legs(run, reminderId)).filter(([, hit]) => hit).map(([leg]) => leg);
  assert.deepEqual(leaked, [], `${message} (ging raus per: ${leaked.join(' + ') || '-'})`);
}

// --------------------------------------------------------
// GET /reminders/pending ueber den echten Router
//
// `sessionModuleAccess` kommt aus derselben Aufloesung wie in Produktion
// (server/auth.js#requireAuth) statt aus einer handgeschriebenen Karte - sonst
// pruefte der /pending-Teil dieser Suite eine Karte, die es so nie gibt.
// --------------------------------------------------------
let currentUid = null;
let currentDb = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = currentDb.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(currentUid);
  req.authUserId = currentUid;
  req.session = { userId: currentUid, role: user?.role || 'member' };
  req.authScopes = null;
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(currentDb, user));
  next();
});
app.use('/api/v1/reminders', remindersModule.default);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;
test.after(() => server.close());

async function pending(database, userId) {
  currentDb = database;
  currentUid = userId;
  const res = await fetch(`${base}/pending`);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

// --------------------------------------------------------------------------
// 1. JE QUELLE: ENTZOGEN HEISST STUMM - UND ZURUECKGEGEBEN HEISST WIEDER LAUT
//
// Zwei Gegenfaelle in jedem Fall: ein anderes Modul DESSELBEN Mitglieds (der
// Filter darf nicht alles schlucken) und dasselbe Modul eines ANDEREN Mitglieds
// (er darf nicht haushaltweit wirken - die Rechteachse ist persoenlich).
// --------------------------------------------------------------------------
const SOURCES = [
  { type: 'task',                   module: 'tasks',     make: makeTask },
  { type: 'event',                  module: 'calendar',  make: makeEvent },
  { type: 'subscription',           module: 'budget',    make: makeSubscription },
  { type: 'inventory_item',         module: 'inventory', make: makeInventoryItem },
  { type: 'inventory_tracked_date', module: 'inventory', make: makeTrackedDate },
  { type: 'document_expiry',        module: 'documents', make: makeDocument },
];

for (const source of SOURCES) {
  test(`${source.type}: entzogenes Modul ${source.module} - weder Push noch Kanal noch /pending, nach der Rueckgabe schon`, async () => {
    const database = freshDb();
    const denied = freshUser(database);
    const allowed = freshUser(database);

    const id = insertReminder(database, denied, source.type, source.make(database, denied));
    // Gegenfall 1: ein Modul, das diesem Mitglied bleibt.
    const [otherType, makeOther] = source.type === 'task' ? ['event', makeEvent] : ['task', makeTask];
    const otherId = insertReminder(database, denied, otherType, makeOther(database, denied));
    // Gegenfall 2: dieselbe Herkunft bei jemandem, der das Modul hat.
    const allowedId = insertReminder(database, allowed, source.type, source.make(database, allowed));

    setModuleAccess(database, 'user', denied, source.module, 'none');

    const off = await deliver(database);
    assertNotDelivered(off, id, `${source.type}: ${source.module} ist entzogen und die Meldung ging trotzdem raus`);
    assertDelivered(off, otherId, `${otherType}: ein Modul, das dem Mitglied bleibt, wurde mitgesperrt`);
    assertDelivered(off, allowedId, `${source.type}: der Entzug hat ein anderes Mitglied mitgesperrt`);

    const offRow = reminderRow(database, id);
    assert.ok(offRow, 'die Zeile wurde geloescht - kein Lauf legt sie wieder an');
    assert.equal(offRow.pushed_at, null, 'die Zeile gilt als zugestellt, obwohl nichts rausging');

    const offPending = (await pending(database, denied)).map((r) => r.id);
    assert.ok(!offPending.includes(id), `${source.type}: /pending liefert die Zeile eines entzogenen Moduls`);
    assert.ok(offPending.includes(otherId), `${otherType}: /pending hat ein erlaubtes Modul mitgesperrt`);

    clearModuleAccess(database, 'user', denied, source.module);
    const on = await deliver(database);
    assertDelivered(on, id, `${source.type}: nach der Rueckgabe des Rechts ging die ausstehende Zeile nicht raus`);
    assert.notEqual(reminderRow(database, id).pushed_at, null);
    assert.ok((await pending(database, denied)).some((r) => r.id === id),
      `${source.type}: nach der Rueckgabe fehlt die Zeile in /pending`);
    database.close();
  });
}

// --------------------------------------------------------------------------
// 2. `read` IST KEINE SPERRE
//
// Dieselbe Trennlinie wie in deniedModules(): nur `none` zaehlt. Wer ein Modul
// lesen darf, darf auch von seinen Erinnerungen hoeren - ein Filter, der ihm
// die Meldung naehme, haette aus einer Leseberechtigung eine Sperre gemacht.
// --------------------------------------------------------------------------
test('read ist keine Sperre: nur `none` haelt die Meldung auf', async () => {
  const database = freshDb();
  const reader = freshUser(database);
  const nobody = freshUser(database);
  const readId = insertReminder(database, reader, 'task', makeTask(database, reader));
  const noneId = insertReminder(database, nobody, 'task', makeTask(database, nobody));

  setModuleAccess(database, 'user', reader, 'tasks', 'read');
  setModuleAccess(database, 'user', nobody, 'tasks', 'none');

  const run = await deliver(database);
  assertDelivered(run, readId, 'ein Mitglied mit Leserecht bekommt seine Aufgaben-Erinnerung nicht mehr');
  assertNotDelivered(run, noneId, 'ein Mitglied ohne Aufgaben bekommt die Meldung trotzdem');

  assert.ok((await pending(database, reader)).some((r) => r.id === readId), '/pending sperrt ein Leserecht aus');
  assert.ok(!(await pending(database, nobody)).some((r) => r.id === noneId), '/pending liefert ein entzogenes Modul');
  database.close();
});

// --------------------------------------------------------------------------
// 3. BEIDE QUELLEN DER AUFLOESUNG - UND DER ADMIN, DEN KEINE BETRIFFT
// --------------------------------------------------------------------------
test('der Entzug zaehlt auch aus dem Rollenprofil, nicht nur aus dem Mitglied-Override', async () => {
  const database = freshDb();
  const child = freshUser(database, { familyRole: 'child' });
  const parent = freshUser(database, { familyRole: 'parent' });
  const childId = insertReminder(database, child, 'subscription', makeSubscription(database, child));
  const parentId = insertReminder(database, parent, 'subscription', makeSubscription(database, parent));

  // Kein Mitglied-Override: die Sperre steht am Rollenprofil `child`.
  setModuleAccess(database, 'role', 'child', 'budget', 'none');

  const run = await deliver(database);
  assertNotDelivered(run, childId, 'die Rolle sperrt Budget und die Abo-Meldung ging trotzdem raus');
  assertDelivered(run, parentId, 'eine andere Rolle wurde mitgesperrt');
  database.close();
});

test('ein Admin faellt nie heraus, auch mit einer Sperrzeile auf seiner ID', async () => {
  const database = freshDb();
  const admin = freshUser(database, { role: 'admin' });
  const member = freshUser(database);
  const adminId = insertReminder(database, admin, 'task', makeTask(database, admin));
  const memberId = insertReminder(database, member, 'task', makeTask(database, member));

  setModuleAccess(database, 'user', admin, 'tasks', 'none');
  setModuleAccess(database, 'user', member, 'tasks', 'none');

  const run = await deliver(database);
  assertDelivered(run, adminId, 'ein Admin wurde von einer Rechtezeile ausgesperrt - er umgeht das System vollstaendig');
  assertNotDelivered(run, memberId, 'ein Mitglied ohne Aufgaben bekam die Meldung trotzdem');
  database.close();
});

// --------------------------------------------------------------------------
// 4. DER GUARD GEGEN DIE LUECKE VON MORGEN
//
// Die Schwestersuite haelt jede Herkunft an einen HAUSHALTSSCHALTER; hier ist
// die Frage dieselbe fuer die Rechtematrix. Eine Herkunft, deren Modul dort
// nicht vorkommt, ginge an dieser Achse vorbei - `resolvePermissions()` kennt
// den Schluessel dann gar nicht und kann ihn nie auf `none` stellen.
// --------------------------------------------------------------------------
test('jede Herkunft zeigt auf ein Modul der Rechtematrix', () => {
  const gateable = new Set(PERMISSION_MODULES.map((m) => m.key));
  assert.ok(gateable.size >= 15, `nur ${gateable.size} Rechte-Module gefunden - PERMISSION_MODULES wurde nicht gelesen`);
  const entries = Object.entries(ORIGIN_MODULE);
  assert.ok(entries.length >= 12, `nur ${entries.length} Herkuenfte in ORIGIN_MODULE`);
  const ungated = entries.filter(([, moduleKey]) => !gateable.has(moduleKey));
  assert.deepEqual(ungated, [],
    'Herkunft zeigt auf ein Modul, das die Rechtematrix nicht kennt - sie meldet sich an jedem Entzug vorbei');
});
