/**
 * Test: ein vom Anbieter abgesagter Termin erinnert nicht und steht nur noch
 * im Kalender (#2499).
 *
 * Ein Anbieter, der einen Termin per STATUS:CANCELLED absagt, ihn aber stehen
 * laesst, lieferte ihn ueber ICS-Abo, CalDAV und iCloud als normalen Termin:
 * der Parser las STATUS, kein Kalender-Importer schrieb ihn. Die Erinnerung
 * feuerte weiter, und Uebersicht, Countdown und Wochenstreifen zeigten den
 * Termin, als faende er statt.
 *
 * WAS DIE FAELLE HALTEN, je Inbound (ICS-Abo, CalDAV, iCloud):
 *   1. CONFIRMED: die Erinnerung meldet sich an allen drei Wegen (Vorlage,
 *      damit der Test nicht an einer kaputten Vorlage gruen wird).
 *   2. Derselbe Termin kommt mit STATUS:CANCELLED: keine Erinnerung in
 *      `GET /reminders/pending`, `GET /reminders/upcoming` und der Zustellung;
 *      die Zeilen stehen weiter mit `pushed_at = NULL` (uebersprungen, nicht
 *      geloescht). Der Kalender-Lesepfad liefert ihn mit
 *      `provider_status = 'CANCELLED'` (die UI streicht ihn durch); die
 *      Flaechen fuer anstehende Termine - Uebersicht mit Kachel, Heute-Blatt,
 *      Familienkarte und Wandmodus (alle aus `getUpcomingEvents`), der
 *      Wochenstreifen (`getEventsOverlappingDays`) und der Countdown - lassen
 *      ihn aus.
 *   3. Wieder CONFIRMED: alles meldet sich wieder.
 * Der eigene Kalender-Feed gibt die Absage als STATUS:CANCELLED weiter.
 * Dazu: eine Absage nur EINES Vorkommens einer Serie (RECURRENCE-ID-Override
 * mit CANCELLED) trifft nur dieses Vorkommen; der einmalige ICS-Import
 * uebernimmt einen abgesagten Termin gar nicht.
 *
 * Netzfrei: In-Memory-SQLite ueber die volle Migrationskette, DAV-Clients als
 * Attrappen, der ICS-Feed auf einem Loopback-Port, Push-Dienst als Attrappe.
 * Die Uhr steht (nur `Date`), Haushaltszone UTC.
 * Ausfuehren: npm run test:provider-cancelled-event
 */
process.env.TZ = process.env.TZ || 'UTC';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.APPLE_CALDAV_URL = 'https://caldav.icloud.example/';
process.env.APPLE_USERNAME = 'apple-user';
process.env.APPLE_APP_SPECIFIC_PASSWORD = 'apple-pass';
process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const db = (await import('../server/db.js')).get();
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const { createNotificationChannelStore } = await import('../server/services/notification-channels.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/authorize/index.ts');
const { sync: caldavSync } = await import('../server/services/caldav-sync.js');
const { sync: appleSync } = await import('../server/services/apple-calendar.js');
const { sync: icsSync, importToLocal } = await import('../server/services/ics-subscription.js');
const {
  getUpcomingEvents, getEventsOverlappingDays, eventProjectionSql, resolveProjectedEventRows,
} = await import('../server/services/calendar-event-reader.js');
const { getCountdowns } = await import('../server/services/countdowns.js');
const { buildFeed } = await import('../server/services/ics-export.js');

const HOUR = 3600_000;
const CAL = 'https://dav.example/cal-a/';

// --------------------------------------------------------------------------
// Router und Feed laufen auf Loopback; danach steht die Uhr (nur `Date`).
// --------------------------------------------------------------------------
let actingUser = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = db.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(actingUser);
  req.authUserId = actingUser;
  req.session = { userId: actingUser, role: user?.role || 'member' };
  req.authScopes = null;
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(db, user));
  next();
});
app.use('/api/v1/reminders', remindersRouter);
const apiServer = http.createServer((req, res) => {
  res.setHeader('Connection', 'close');
  app(req, res);
});
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${apiServer.address().port}/api/v1/reminders`;

let feed = '';
const feedServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/calendar', Connection: 'close' });
  res.end(feed);
});
await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
const feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.ics`;

const NOW = Date.parse('2026-10-01T12:00:00Z');
mock.timers.enable({ apis: ['Date'], now: NOW });
after(() => { mock.timers.reset(); apiServer.close(); feedServer.close(); });

const naive = (ms) => new Date(ms).toISOString().slice(0, 19);
const icsStamp = (ms) => `${naive(ms).replace(/[-:]/g, '')}Z`;
const TODAY = naive(NOW).slice(0, 10);

// Der Termin in zwei Stunden; eine Erinnerung ist faellig, eine kommt noch.
const START = NOW + 2 * HOUR;
const DUE = naive(NOW - 60_000);
const COMING = naive(NOW + HOUR);

let OWNER;
beforeEach(() => {
  for (const table of ['reminders', 'event_assignments', 'calendar_event_exceptions',
    'calendar_events', 'external_calendars', 'caldav_calendar_selection', 'caldav_accounts',
    'calendar_pending_deletions', 'ics_subscriptions', 'push_subscriptions', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  OWNER = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES ('owner', 'Owner', 'x', 'admin', 'parent') RETURNING id
  `).get().id);
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
    .run(OWNER, `https://push.test/${OWNER}`, 'p', 'a');
  actingUser = OWNER;
  for (const [key, value] of [['household_timezone', 'UTC'], ['disabled_modules', '[]']]) {
    db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
  }
});

// --------------------------------------------------------------------------
// Anbieter-Attrappen
// --------------------------------------------------------------------------
function vcalendar(...lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function vevent(uid, { status = null, startMs = START, rrule = null, recurrenceIdMs = null, summary = 'Elternabend' } = {}) {
  return [
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${summary}`,
    `DTSTART:${icsStamp(startMs)}`, `DTEND:${icsStamp(startMs + HOUR)}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    ...(recurrenceIdMs ? [`RECURRENCE-ID:${icsStamp(recurrenceIdMs)}`] : []),
    ...(status ? [`STATUS:${status}`] : []),
    'END:VEVENT',
  ];
}

const davClient = (data, uid) => async () => ({
  fetchCalendars: async () => [{ url: CAL, displayName: 'Kalender A', components: ['VEVENT'] }],
  fetchCalendarObjects: async () => [{ data, url: `${CAL}${encodeURIComponent(uid)}.ics` }],
  createCalendarObject: async () => ({}),
});

function seedCaldavAccount() {
  db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('OX', 'https://dav.example/', 'u', 'p')`).run();
  const accountId = Number(db.prepare('SELECT id FROM caldav_accounts').get().id);
  db.prepare(`INSERT INTO caldav_calendar_selection
    (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES (?, ?, 'Kalender A', '#4A90E2', 1)`).run(accountId, CAL);
}

let subId = null;
const WAYS = {
  'ICS-Abo': {
    setup: () => {
      subId = Number(db.prepare(`
        INSERT INTO ics_subscriptions (name, url, color, shared, created_by)
        VALUES ('Schule', ?, '#4A90E2', 1, ?) RETURNING id
      `).get(feedUrl, OWNER).id);
    },
    publish: async (ics) => { feed = ics; await icsSync(subId); },
  },
  CalDAV: {
    setup: seedCaldavAccount,
    publish: (ics, uid) => caldavSync({ createClient: davClient(ics, uid) }),
  },
  iCloud: {
    setup: () => {},
    publish: (ics, uid) => appleSync({ makeClient: davClient(ics, uid) }),
  },
};

// --------------------------------------------------------------------------
// Die Lesewege
// --------------------------------------------------------------------------
async function apiIds(path) {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, path);
  return (await res.json()).data.map((row) => Number(row.id));
}

async function deliver() {
  const push = [];
  await processDueNotifications({
    database: db,
    channelStore: createNotificationChannelStore({ db }),
    pushService: { sendPushToUser: async (userId, payload) => { push.push({ userId, ...payload }); return 1; } },
    providers: {},
    now: new Date(NOW),
  });
  return push;
}

/**
 * Wo sich die beiden Erinnerungen melden. Die Zustellung setzt pushed_at und
 * vermerkt sich in notification_deliveries; beides danach zurueck, damit die
 * naechste Runde dieselbe Frage stellt.
 */
async function reminderPaths(due, coming) {
  const pending = (await apiIds('/pending')).includes(due);
  const upcoming = (await apiIds(`/upcoming?from=${naive(NOW)}Z&to=${naive(NOW + 24 * HOUR)}Z`)).includes(coming);
  const push = (await deliver()).some((p) => p.tag === `reminder-${due}`);
  db.prepare('UPDATE reminders SET pushed_at = NULL').run();
  db.prepare('DELETE FROM notification_deliveries').run();
  return { pending, upcoming, push };
}

/** Was die Sammelflaechen zeigen (Titel), und was der Kalender ueber den Termin sagt. */
function surfaces(eventId) {
  const upcoming = getUpcomingEvents(db, {
    userId: OWNER, limit: 12, fromToday: true, keepEndedToday: 5, household: true,
  }).map((e) => Number(e.id));
  const week = getEventsOverlappingDays(db, { userId: OWNER, fromKey: TODAY, days: 7, household: true })
    .map((e) => Number(e.id));
  db.prepare('UPDATE calendar_events SET countdown = 1 WHERE id = ?').run(eventId);
  const countdown = getCountdowns(db, { userId: OWNER, todayKey: TODAY }).items.map((item) => Number(item.id));
  return {
    upcoming: upcoming.includes(eventId),
    week: week.includes(eventId),
    countdown: countdown.includes(eventId),
  };
}

/** Der Status, wie ihn der Kalender-Lesepfad (Projektion + Aufloesung) ausliefert. */
function calendarStatus(eventId) {
  const rows = db.prepare(`SELECT ${eventProjectionSql(db)} FROM calendar_events e WHERE e.id = ?`).all(eventId);
  return resolveProjectedEventRows(db, rows, { lightweight: true })[0]?.provider_status ?? null;
}

const insertReminder = (eventId, remindAt) => Number(db.prepare(
  `INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)`,
).run(eventId, remindAt, OWNER).lastInsertRowid);

const eventBy = (uid) => db.prepare('SELECT id FROM calendar_events WHERE external_calendar_id = ?').get(uid);

const ALL_ON = { pending: true, upcoming: true, push: true };
const ALL_OFF = { pending: false, upcoming: false, push: false };
const SHOWN = { upcoming: true, week: true, countdown: true };
const HIDDEN = { upcoming: false, week: false, countdown: false };

for (const [way, w] of Object.entries(WAYS)) {
  test(`${way}: abgesagt erinnert nicht und steht nur im Kalender, wieder zugesagt meldet er sich`, async () => {
    const uid = `cancel-${way}@test`;
    w.setup();
    await w.publish(vcalendar(...vevent(uid, { status: 'CONFIRMED' })), uid);
    const ev = eventBy(uid);
    assert.ok(ev, 'importiert');
    const due = insertReminder(ev.id, DUE);
    const coming = insertReminder(ev.id, COMING);
    assert.deepEqual(await reminderPaths(due, coming), ALL_ON, 'Vorlage: zugesagt meldet er sich');
    assert.deepEqual(surfaces(ev.id), SHOWN, 'Vorlage: zugesagt steht er ueberall');

    await w.publish(vcalendar(...vevent(uid, { status: 'CANCELLED' })), uid);
    assert.equal(eventBy(uid)?.id, ev.id, 'derselbe Termin, nicht geloescht');
    assert.deepEqual(await reminderPaths(due, coming), ALL_OFF, 'abgesagt: keine Erinnerung');
    assert.deepEqual(surfaces(ev.id), HIDDEN, 'abgesagt: Uebersicht, Woche und Countdown lassen ihn aus');
    assert.equal(calendarStatus(ev.id), 'CANCELLED', 'der Kalender bekommt die Absage mit');
    assert.match(buildFeed(db, OWNER, new Date(NOW), 'UTC'), /STATUS:CANCELLED/, 'der Feed sagt es weiter');
    const rows = db.prepare('SELECT id, pushed_at FROM reminders WHERE entity_id = ? ORDER BY id').all(ev.id);
    assert.deepEqual(rows.map((r) => [Number(r.id), r.pushed_at]), [[due, null], [coming, null]],
      'uebersprungen, nicht geloescht');

    // Wiederzusage ohne STATUS-Zeile: zaehlt wie CONFIRMED.
    await w.publish(vcalendar(...vevent(uid)), uid);
    assert.deepEqual(await reminderPaths(due, coming), ALL_ON, 'wieder zugesagt: er meldet sich wieder');
    assert.deepEqual(surfaces(ev.id), SHOWN, 'wieder zugesagt: er steht wieder ueberall');
    assert.equal(calendarStatus(ev.id), null);
    assert.doesNotMatch(buildFeed(db, OWNER, new Date(NOW), 'UTC'), /STATUS:CANCELLED/);
  });
}

test('CalDAV: die Absage nur eines Vorkommens trifft nur dieses', async () => {
  // Taeglich ab gestern; das Vorkommen in zwei Stunden ist abgesagt.
  const uid = 'series-cancel@test';
  seedCaldavAccount();
  const ics = vcalendar(
    ...vevent(uid, { startMs: START - 24 * HOUR, rrule: 'FREQ=DAILY;COUNT=5', summary: 'Training' }),
    ...vevent(uid, { startMs: START, recurrenceIdMs: START, status: 'CANCELLED', summary: 'Training' }),
  );
  await caldavSync({ createClient: davClient(ics, uid) });
  const master = eventBy(uid);
  const override = eventBy(`${uid}::${naive(START)}Z`)
    ?? db.prepare("SELECT id FROM calendar_events WHERE external_calendar_id LIKE ?").get(`${uid}::%`);
  assert.ok(master && override, 'Serie und Ausnahme importiert');
  assert.equal(calendarStatus(master.id), null, 'die Serie ist nicht abgesagt');
  assert.equal(calendarStatus(override.id), 'CANCELLED', 'das Vorkommen ist abgesagt');

  const starts = getUpcomingEvents(db, { userId: OWNER, limit: 12, household: true })
    .map((e) => new Date(e.start_datetime).getTime());
  assert.equal(starts.includes(START), false, 'das abgesagte Vorkommen fehlt');
  assert.ok(starts.includes(START + 24 * HOUR), 'das naechste Vorkommen bleibt');

  const onOverride = insertReminder(override.id, DUE);
  const onMaster = insertReminder(master.id, COMING);
  assert.equal((await apiIds('/pending')).includes(onOverride), false, 'keine Erinnerung am abgesagten Vorkommen');
  assert.ok((await apiIds(`/upcoming?from=${naive(NOW)}Z&to=${naive(NOW + 24 * HOUR)}Z`)).includes(onMaster),
    'die Serie erinnert weiter');
});

test('ICS-Import: ein abgesagter Termin wird nicht uebernommen', async () => {
  const result = await importToLocal(OWNER, {
    ics: vcalendar(...vevent('kept@test'), ...vevent('gone@test', { status: 'CANCELLED' })),
  });
  assert.equal(result.imported, 1);
  assert.ok(eventBy('kept@test'));
  assert.equal(eventBy('gone@test'), undefined);
});
