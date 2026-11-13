/**
 * Modul: Erinnerung an ein geloeschtes erstes Vorkommen (#2470)
 * Zweck: Eine Erinnerung an einer Serie haengt am Master und rechnet von seinem
 *        Beginn (#2468), sie gehoert also zum ERSTEN Vorkommen. Wird genau
 *        dieses geloescht, steht eine Ausnahme in `calendar_event_exceptions`
 *        - und keiner der drei Lesewege fragte danach: `GET /reminders/pending`,
 *        `GET /reminders/upcoming` und die Zustellung meldeten einen Termin,
 *        den es nicht mehr gibt.
 *
 * WAS DIE FAELLE HALTEN
 *   1. Nach dem Loeschen des ersten Vorkommens fehlt die Erinnerung an allen
 *      drei Wegen; vorher stand sie dort (derselbe Fall, damit der Test nicht
 *      an einer kaputten Vorlage gruen wird).
 *   2. Jede Form der Ausnahme zaehlt: die exakte (lokales Loeschen,
 *      `deleteOccurrence`), die alte Tagesform (Import und Altdaten) und der
 *      UTC-Zeitpunkt einer Serie mit Zone (CalDAV, Google).
 *   3. Das erste Vorkommen ist das erste der REGEL, nicht DTSTART (#960).
 *   4. Gegenrichtung: ein spaeteres geloeschtes Vorkommen, eine Erinnerung an
 *      ein spaeteres Vorkommen, ein VERSCHOBENES erstes Vorkommen (Ausnahme
 *      plus verknuepftes Einzelvorkommen) und das Zuruecknehmen der Ausnahme
 *      lassen die Erinnerung stehen. Uebersprungen, nicht geloescht.
 *
 * Netzfrei: In-Memory-SQLite ueber die volle Migrationskette, Push-Dienst und
 * Kanal-Provider sind Attrappen, der Router laeuft auf einem Loopback-Port. Die
 * Uhr steht (nur `Date`), Haushaltszone UTC.
 * Ausfuehren: npm run test:reminder-deleted-occurrence
 */
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const NOW = Date.parse('2024-06-15T12:00:00Z');
mock.timers.enable({ apis: ['Date'], now: NOW });
after(() => mock.timers.reset());

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const remindersModule = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const { deleteOccurrence } = await import('../server/services/calendar-occurrence-overrides.js');

function freshDb() {
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
  _setTestDatabase(database);
  for (const [key, value] of [['household_timezone', 'UTC'], ['disabled_modules', '[]']]) {
    database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
  return database;
}

let userSeq = 0;
function freshUser(database) {
  userSeq += 1;
  const id = database.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES (?, ?, '$2b$12$x', 'member', 'other')`,
  ).run(`rdo-u${userSeq}`, `User ${userSeq}`).lastInsertRowid;
  database.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(id, `https://push.test/${id}`, 'p', 'a');
  return Number(id);
}

function makeSeries(database, owner, {
  start = '2024-06-20T09:00:00', end = '2024-06-20T10:00:00', rule = 'FREQ=WEEKLY', tzid = null,
} = {}) {
  return Number(database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, recurrence_rule, tzid, created_by)
    VALUES ('Training', ?, ?, ?, ?, ?)
  `).run(start, end, rule, tzid, owner).lastInsertRowid);
}

function insertReminder(database, owner, eventId, remindAt) {
  return Number(database.prepare(
    `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)`,
  ).run(eventId, remindAt, owner).lastInsertRowid);
}

const addException = (database, eventId, key) => database.prepare(
  'INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)',
).run(eventId, key);

async function deliver(database) {
  const push = [];
  await processDueNotifications({
    database,
    channelStore: createNotificationChannelStore({ db: database }),
    pushService: { sendPushToUser: async (userId, payload) => { push.push({ userId, ...payload }); return 1; } },
    providers: {},
    now: new Date(NOW),
  });
  return push;
}

// Der echte Router, mit derselben Rechteaufloesung wie in Produktion.
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
// Jede Antwort schliesst ihre Verbindung (Begruendung in
// test/test-reminder-target-visibility.js am Server).
const server = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  app(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/reminders`;
after(() => server.close());

async function get(database, userId, path) {
  currentDb = database;
  currentUid = userId;
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return (await res.json()).data.map((row) => Number(row.id));
}

const pending = (database, userId) => get(database, userId, '/pending');
const upcoming = (database, userId) =>
  get(database, userId, '/upcoming?from=2024-06-15T12:00:00Z&to=2024-06-29T12:00:00Z');

/** Wo die Zeile steht: Faellige in `/pending` und Push, kommende in `/upcoming`. */
async function seenDue(database, userId, reminderId) {
  return {
    pending: (await pending(database, userId)).includes(reminderId),
    push: (await deliver(database)).some((p) => p.tag === `reminder-${reminderId}`),
  };
}

// Vor dem Serienbeginn am 20.06. und vor jetzt: faellig.
const DUE = '2024-06-15T09:00:00';
// Vor dem Serienbeginn, nach jetzt: kommend.
const COMING = '2024-06-19T09:00:00';

test('Vorlage: ohne Ausnahme meldet sich die Erinnerung an allen drei Wegen', async () => {
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const due = insertReminder(database, me, series, DUE);
  const coming = insertReminder(database, me, series, COMING);
  assert.ok((await upcoming(database, me)).includes(coming));
  assert.deepEqual(await seenDue(database, me, due), { pending: true, push: true });
});

test('erstes Vorkommen lokal geloescht: keine Erinnerung in /pending, /upcoming und Zustellung', async () => {
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const due = insertReminder(database, me, series, DUE);
  const coming = insertReminder(database, me, series, COMING);
  deleteOccurrence(database, { seriesId: series, recurrenceId: '2024-06-20T09:00:00', actorId: me });

  assert.equal((await upcoming(database, me)).includes(coming), false, '/upcoming');
  assert.deepEqual(await seenDue(database, me, due), { pending: false, push: false });
  // Uebersprungen, nicht geloescht: die Zeilen stehen noch, und nichts gilt als zugestellt.
  const rows = database.prepare('SELECT id, pushed_at FROM reminders WHERE entity_id = ? ORDER BY id').all(series);
  assert.deepEqual(rows.map((r) => [Number(r.id), r.pushed_at]), [[due, null], [coming, null]]);
});

test('jede Form der Ausnahme zaehlt: alte Tagesform und UTC-Zeitpunkt einer Serie mit Zone', async () => {
  // Alte Tagesform: so legten Import und Altdaten eine EXDATE vor #2034 ab.
  {
    const database = freshDb();
    const me = freshUser(database);
    const series = makeSeries(database, me);
    const due = insertReminder(database, me, series, DUE);
    addException(database, series, '2024-06-20');
    assert.deepEqual(await seenDue(database, me, due), { pending: false, push: false }, 'Tagesform');
  }
  // Serie mit Zone (CalDAV, Google): der Schluessel ist der Originalstart in UTC.
  {
    const database = freshDb();
    const me = freshUser(database);
    const series = makeSeries(database, me, {
      start: '2024-06-20T09:00:00Z', end: '2024-06-20T10:00:00Z', tzid: 'Europe/Berlin',
    });
    const due = insertReminder(database, me, series, DUE);
    addException(database, series, '2024-06-20T09:00:00Z');
    assert.deepEqual(await seenDue(database, me, due), { pending: false, push: false }, 'mit Zone');
  }
});

test('das erste Vorkommen ist das erste der Regel, nicht DTSTART (#960)', async () => {
  // Beginn am 17.06., "am Monatsletzten": das erste Vorkommen ist der 30.06.
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me, {
    start: '2024-06-17T09:00:00', end: '2024-06-17T10:00:00', rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
  });
  const due = insertReminder(database, me, series, DUE);
  addException(database, series, '2024-06-30T09:00:00');
  assert.deepEqual(await seenDue(database, me, due), { pending: false, push: false });
});

test('Gegenrichtung: ein spaeteres geloeschtes Vorkommen laesst die Erinnerung des ersten stehen', async () => {
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const due = insertReminder(database, me, series, DUE);
  const coming = insertReminder(database, me, series, COMING);
  deleteOccurrence(database, { seriesId: series, recurrenceId: '2024-06-27T09:00:00', actorId: me });
  assert.ok((await upcoming(database, me)).includes(coming));
  assert.deepEqual(await seenDue(database, me, due), { pending: true, push: true });
});

test('Gegenrichtung: eine Erinnerung an ein spaeteres Vorkommen bleibt, wenn das erste geloescht ist', async () => {
  // Einen Tag vor dem zweiten Vorkommen (27.06.), also nach dem Beginn des
  // ersten: sie gehoert nicht zu ihm (#2468, eine fremde Serie rechnet eine
  // neue Zeile vom geoeffneten Vorkommen).
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const later = insertReminder(database, me, series, '2024-06-26T09:00:00');
  deleteOccurrence(database, { seriesId: series, recurrenceId: '2024-06-20T09:00:00', actorId: me });
  assert.ok((await upcoming(database, me)).includes(later));
});

test('Gegenrichtung: ein verschobenes erstes Vorkommen erinnert weiter', async () => {
  // Verschoben heisst: Ausnahme UND verknuepftes Einzelvorkommen. Die
  // Erinnerung erbt es vom Master, es findet ja statt.
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const due = insertReminder(database, me, series, DUE);
  database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by,
      recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES ('Training', '2024-06-21T09:00:00', '2024-06-21T10:00:00', ?, ?, '2024-06-20T09:00:00',
      '["start_datetime","end_datetime"]')
  `).run(me, series);
  addException(database, series, '2024-06-20T09:00:00');
  assert.deepEqual(await seenDue(database, me, due), { pending: true, push: true });
});

test('Gegenrichtung: die Ausnahme zurueckgenommen, die Erinnerung meldet sich wieder', async () => {
  const database = freshDb();
  const me = freshUser(database);
  const series = makeSeries(database, me);
  const due = insertReminder(database, me, series, DUE);
  addException(database, series, '2024-06-20T09:00:00');
  assert.equal((await pending(database, me)).includes(due), false);
  database.prepare('DELETE FROM calendar_event_exceptions WHERE event_id = ?').run(series);
  assert.deepEqual(await seenDue(database, me, due), { pending: true, push: true });
});
