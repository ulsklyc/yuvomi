/**
 * Test: Eine Erinnerung an einem synchronisierten Termin zieht mit, wenn der
 *       Termin beim Anbieter verschoben wird (#1377)
 *
 * Verdacht aus dem Code: der Inbound schreibt `start_datetime` neu, laesst
 * `reminders.remind_at` aber stehen. Die Zustellung arbeitet mit dem absoluten
 * Zeitpunkt (`remind_at <= now`, server/services/notifications.js), also kam
 * "1 Stunde vorher" nach einer Verschiebung in Google zur ALTEN Zeit - oder, bei
 * einem nach vorn gezogenen Termin, erst nach seinem Beginn.
 *
 * Laufweg: der ECHTE Inbound je Anbieter, nicht der Helfer allein -
 *   Google  `__test.upsertGoogleEvents` (die API-Antwort als Objekt, wie in
 *           test-google-calendar.js und test-sync-calendar-move-assignment.js),
 *   CalDAV  `sync({ createClient })`, Apple `sync({ makeClient })`,
 *   ICS-Abo `sync(subId)` gegen einen lokalen HTTP-Server.
 * Die Erinnerung legt die Route an (`PUT /api/v1/reminders`), so wie der
 * Kalenderdialog es tut. Outlook hat keinen Inbound (One-Way-Push) und steht
 * deshalb nicht hier.
 *
 * ZEIT UND ZONE STEHEN FEST. Die Uhr der Suite steht auf NOW (`mock.timers`,
 * nur `Date`): das ICS-Abo liest ein Fenster um "heute", und ob eine Erinnerung
 * schon vorbei ist, entscheidet `Date.now()` in `followInboundStartChange()`.
 * Die Haushaltszone ist gesetzt (UTC, dieselbe Zone wie die Saat, die in
 * `Z`-Zeitpunkten angelegt wird), sonst fiele der Ganztags-Anker (09:00
 * Haushaltszeit) auf die Zone des Rechners. Ein eigener Block verschiebt dann
 * bewusst ueber die Zeitumstellung in Europe/Berlin (25.10.2026).
 *
 * Ausfuehren: npm run test:inbound-reminder-shift
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.APPLE_CALDAV_URL = 'https://caldav.icloud.example/';
process.env.APPLE_USERNAME = 'apple-user';
process.env.APPLE_APP_SPECIFIC_PASSWORD = 'apple-pass';
process.env.ICS_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK = 'true';

import { describe, it, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Nach dem Setzen von DB_PATH: server/db.js verbindet BEIM IMPORT.
const db = (await import('../server/db.js')).get();
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { sync: caldavSync } = await import('../server/services/caldav-sync.js');
const { sync: appleSync } = await import('../server/services/apple-calendar.js');
const { sync: icsSync } = await import('../server/services/ics-subscription.js');
const { __test: google } = await import('../server/services/google-calendar.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const CAL = 'https://dav.example/cal-a/';
const UID = 'moved-in-provider@example.org';

let OWNER; let ANNA;
let actingUser = null;

// --------------------------------------------------------------------------
// Route: dieselbe, die der Kalenderdialog zum Speichern der Vorlaeufe ruft
// --------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actingUser;
  req.authRole = 'member';
  req.session = { userId: actingUser, role: 'member' };
  next();
});
app.use('/', remindersRouter);
const apiServer = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => apiServer.on('listening',
  () => r(`http://127.0.0.1:${apiServer.address().port}`)));

// Der Feed des ICS-Abos: was in `feed` steht, liefert der Server aus.
let feed = '';
const feedServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/calendar' });
  res.end(feed);
});
await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
const feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.ics`;

// Ab hier steht die Uhr: 1. Oktober 2026, 12:00 UTC. Nur `Date` - die Timer
// von fetch und http laufen weiter.
const NOW = Date.parse('2026-10-01T12:00:00Z');
mock.timers.enable({ apis: ['Date'], now: NOW });

after(() => { mock.timers.reset(); apiServer.close(); feedServer.close(); });

async function setReminders(eventId, remindAts) {
  const res = await fetch(`${baseUrl}/?entity_type=event&entity_id=${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remind_ats: remindAts }),
  });
  assert.equal(res.status, 200, 'die Route nimmt die Erinnerung an');
}

// --------------------------------------------------------------------------
// Zeiten: fest, zwei Wochen nach NOW, naiv-UTC wie `remind_at`
// --------------------------------------------------------------------------
const baseMs = Date.parse('2026-10-15T10:00:00Z');
const naive = (ms) => new Date(ms).toISOString().slice(0, 19);
const zulu = (ms) => `${naive(ms)}Z`;
const icsStamp = (ms) => `${naive(ms).replace(/[-:]/g, '')}Z`;
const dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function resetTables() {
  for (const t of ['reminders', 'event_assignments', 'calendar_event_exceptions',
    'calendar_events', 'external_calendars', 'caldav_calendar_selection',
    'caldav_accounts', 'google_calendar_selection', 'calendar_pending_deletions',
    'ics_subscriptions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const add = (name) => Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'x', 'member') RETURNING id
  `).get(name, name).id);
  OWNER = add('owner');
  ANNA = add('anna');
  actingUser = ANNA;
  setHouseholdZone('UTC');
}

// Die Haushaltszone ist eine Einstellung, kein Umgebungszufall: ohne sie faellt
// `householdTimeZone()` auf die Zone des Rechners.
function setHouseholdZone(zone) {
  db.prepare(`INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)`).run(zone);
}

const remindersOf = (eventId) => db.prepare(`
  SELECT remind_at, pushed_at, dismissed FROM reminders
  WHERE entity_type = 'event' AND entity_id = ? ORDER BY remind_at
`).all(eventId).map((row) => ({ ...row }));

const eventBy = (externalId) => db.prepare(
  'SELECT id, start_datetime FROM calendar_events WHERE external_calendar_id = ?'
).get(externalId);

// --------------------------------------------------------------------------
// Anbieter-Attrappen
// --------------------------------------------------------------------------
const vevent = (startMs, uid = UID) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  `UID:${uid}`, 'SUMMARY:Zahnarzt',
  `DTSTART:${icsStamp(startMs)}`, `DTEND:${icsStamp(startMs + HOUR)}`,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const davClient = (startMs) => async () => ({
  fetchCalendars: async () => [{ url: CAL, displayName: 'Kalender A', components: ['VEVENT'] }],
  fetchCalendarObjects: async () => [{ data: vevent(startMs), url: `${CAL}${UID}.ics` }],
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

const gTimed = (id, startMs, extra = {}) => ({
  id,
  status: 'confirmed',
  summary: 'Zahnarzt',
  start: { dateTime: zulu(startMs) },
  end: { dateTime: zulu(startMs + HOUR) },
  ...extra,
});

function seedSubscription() {
  return Number(db.prepare(`
    INSERT INTO ics_subscriptions (name, url, color, shared, created_by)
    VALUES ('Schule', ?, '#4A90E2', 1, ?) RETURNING id
  `).get(feedUrl, OWNER).id);
}

// Verschiebung: zwei Tage und drei Stunden spaeter - Tag UND Uhrzeit wechseln.
const MOVE = 2 * DAY + 3 * HOUR;

// --------------------------------------------------------------------------
// Der gemeldete Fall, je Inbound
// --------------------------------------------------------------------------
describe('#1377 - die Erinnerung wandert mit dem verschobenen Termin', () => {
  beforeEach(resetTables);

  it('Google: der zweite Sync mit verschobenem Start verschiebt remind_at', async () => {
    google.upsertGoogleEvents([gTimed('gev-1', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-1');
    assert.ok(ev, 'importiert');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);

    google.upsertGoogleEvents([gTimed('gev-1', baseMs + MOVE)], null, '#4A90E2', {});
    assert.equal(eventBy('gev-1').start_datetime, zulu(baseMs + MOVE), 'der Termin selbst ist verschoben');
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + MOVE - HOUR)],
      'eine Stunde vor dem NEUEN Beginn, nicht vor dem alten');
  });

  it('CalDAV: der zweite Sync mit verschobenem Start verschiebt remind_at', async () => {
    seedCaldavAccount();
    await caldavSync({ createClient: davClient(baseMs) });
    const ev = eventBy(UID);
    assert.ok(ev, 'importiert');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);

    await caldavSync({ createClient: davClient(baseMs + MOVE) });
    assert.notEqual(eventBy(UID).start_datetime, ev.start_datetime, 'der Termin selbst ist verschoben');
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + MOVE - HOUR)]);
  });

  it('Apple: der zweite Sync mit verschobenem Start verschiebt remind_at', async () => {
    await appleSync({ makeClient: davClient(baseMs) });
    const ev = eventBy(UID);
    assert.ok(ev, 'importiert');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);

    await appleSync({ makeClient: davClient(baseMs + MOVE) });
    assert.notEqual(eventBy(UID).start_datetime, ev.start_datetime, 'der Termin selbst ist verschoben');
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + MOVE - HOUR)]);
  });

  it('ICS-Abo: der zweite Abruf mit verschobenem Start verschiebt remind_at', async () => {
    const subId = seedSubscription();
    feed = vevent(baseMs);
    await icsSync(subId);
    const ev = eventBy(UID);
    assert.ok(ev, 'importiert');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);

    feed = vevent(baseMs + MOVE);
    await icsSync(subId);
    assert.notEqual(eventBy(UID).start_datetime, ev.start_datetime, 'der Termin selbst ist verschoben');
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + MOVE - HOUR)]);
  });
});

// --------------------------------------------------------------------------
// Semantik: dieselbe wie beim Verschieben in Yuvomi
// --------------------------------------------------------------------------
describe('#1377 - was beim Mitwandern gilt', () => {
  beforeEach(resetTables);

  it('ein unveraenderter Sync fasst die Erinnerung nicht an', async () => {
    google.upsertGoogleEvents([gTimed('gev-2', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-2');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare("UPDATE reminders SET remind_at = '2000-01-01T00:00:00' WHERE entity_id = ?").run(ev.id);

    google.upsertGoogleEvents([gTimed('gev-2', baseMs, { summary: 'Zahnarzt (neu)' })], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), ['2000-01-01T00:00:00'],
      'nur eine Startaenderung verschiebt - ein neuer Titel nicht');
  });

  it('mehrere Vorlaeufe und die geerbten Zeilen anderer wandern alle um dieselbe Differenz', async () => {
    google.upsertGoogleEvents([gTimed('gev-3', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-3');
    await setReminders(ev.id, [naive(baseMs - DAY), naive(baseMs - 15 * 60_000)]);
    db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
      VALUES ('event', ?, ?, ?, ?)`).run(ev.id, naive(baseMs - HOUR), OWNER, ANNA);

    google.upsertGoogleEvents([gTimed('gev-3', baseMs - MOVE)], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [
      naive(baseMs - MOVE - DAY), naive(baseMs - MOVE - HOUR), naive(baseMs - MOVE - 15 * 60_000),
    ]);
  });

  it('Google-Ganztag: der Tag wandert, der Vorlauf bleibt', async () => {
    const day = dateKey(baseMs);
    const next = dateKey(baseMs + 3 * DAY);
    const allDay = (start) => ({
      id: 'gev-4', status: 'confirmed', summary: 'Ausflug',
      start: { date: start }, end: { date: dateKey(Date.parse(`${start}T00:00:00Z`) + DAY) },
    });
    google.upsertGoogleEvents([allDay(day)], null, '#4A90E2', {});
    const ev = eventBy('gev-4');
    await setReminders(ev.id, [naive(baseMs - DAY)]);

    google.upsertGoogleEvents([allDay(next)], null, '#4A90E2', {});
    assert.equal(eventBy('gev-4').start_datetime, next);
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + 2 * DAY)],
      'drei Tage spaeter, gleiche Uhrzeit');
  });

  it('Google-Serie: der verschobene Master nimmt die Erinnerung der Serie mit', async () => {
    const series = (startMs) => gTimed('gev-5', startMs, { recurrence: ['RRULE:FREQ=WEEKLY'] });
    google.upsertGoogleEvents([series(baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-5');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);

    google.upsertGoogleEvents([series(baseMs + DAY)], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs + DAY - HOUR)]);
  });

  it('eine schon zugestellte Erinnerung, die in die Zukunft wandert, meldet sich zur neuen Zeit wieder', async () => {
    google.upsertGoogleEvents([gTimed('gev-6', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-6');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare("UPDATE reminders SET pushed_at = '2026-01-01T00:00:00Z', dismissed = 1 WHERE entity_id = ?")
      .run(ev.id);

    google.upsertGoogleEvents([gTimed('gev-6', baseMs + MOVE)], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id), [
      { remind_at: naive(baseMs + MOVE - HOUR), pushed_at: null, dismissed: 0 },
    ], 'die neue Zeit ist neue Auskunft - wie beim Speichern im Dialog, der die Zeile frisch schreibt');
  });

  it('derselbe Zeitpunkt in anderer Schreibweise ist keine Verschiebung: der Zustellstand bleibt', async () => {
    google.upsertGoogleEvents([gTimed('gev-9', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-9');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare("UPDATE reminders SET pushed_at = '2026-01-01T00:00:00Z', dismissed = 1 WHERE entity_id = ?")
      .run(ev.id);

    // 10:00Z als 12:00+02:00: ein anderer String, derselbe Beginn.
    const sameInstant = `${naive(baseMs + 2 * HOUR)}+02:00`;
    google.upsertGoogleEvents([gTimed('gev-9', baseMs, {
      start: { dateTime: sameInstant, timeZone: 'Europe/Berlin' },
    })], null, '#4A90E2', {});
    assert.notEqual(eventBy('gev-9').start_datetime, ev.start_datetime,
      'Vorbedingung: der Inbound hat einen anderen String geschrieben');
    assert.deepEqual(remindersOf(ev.id), [
      { remind_at: naive(baseMs - HOUR), pushed_at: '2026-01-01T00:00:00Z', dismissed: 1 },
    ], 'die Erinnerung hat sich nicht bewegt, also meldet sie sich auch nicht ein zweites Mal');
  });

  it('eine zugestellte Erinnerung, die in die Vergangenheit wandert, meldet sich nicht ein zweites Mal', async () => {
    const pastMs = Date.now() - 10 * DAY;
    google.upsertGoogleEvents([gTimed('gev-7', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-7');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare("UPDATE reminders SET pushed_at = '2026-01-01T00:00:00Z', dismissed = 1 WHERE entity_id = ?")
      .run(ev.id);

    google.upsertGoogleEvents([gTimed('gev-7', pastMs)], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id), [
      { remind_at: naive(pastMs - HOUR), pushed_at: '2026-01-01T00:00:00Z', dismissed: 1 },
    ], 'verschoben wird sie trotzdem, ihr Zustellstand bleibt');
  });

  it('ICS-Abo: ein lokal bearbeiteter Termin (user_modified) behaelt Start UND Erinnerung', async () => {
    const subId = seedSubscription();
    feed = vevent(baseMs);
    await icsSync(subId);
    const ev = eventBy(UID);
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare('UPDATE calendar_events SET user_modified = 1 WHERE id = ?').run(ev.id);

    feed = vevent(baseMs + MOVE);
    await icsSync(subId);
    assert.equal(eventBy(UID).start_datetime, ev.start_datetime, 'das Abo ueberschreibt ihn nicht');
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs - HOUR)],
      'die Erinnerung folgt dem Start, der in der Zeile steht - nicht dem im Feed');
  });

  it('eine wartende lokale Bearbeitung (outbound_dirty) laesst Termin und Erinnerung stehen', async () => {
    google.upsertGoogleEvents([gTimed('gev-8', baseMs)], null, '#4A90E2', {});
    const ev = eventBy('gev-8');
    await setReminders(ev.id, [naive(baseMs - HOUR)]);
    db.prepare('UPDATE calendar_events SET outbound_dirty = 1 WHERE id = ?').run(ev.id);

    google.upsertGoogleEvents([gTimed('gev-8', baseMs + MOVE)], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), [naive(baseMs - HOUR)]);
  });
});

// --------------------------------------------------------------------------
// Ueber die Zeitumstellung: Europe/Berlin, Ende der Sommerzeit am 25.10.2026
// --------------------------------------------------------------------------
describe('#1377 - ueber die Zeitumstellung (Europe/Berlin)', () => {
  beforeEach(() => { resetTables(); setHouseholdZone('Europe/Berlin'); });

  it('Ganztag: 09:00 am Vortag bleibt 09:00 Ortszeit, auch wenn der Tag hinter der Umstellung liegt', async () => {
    const allDay = (start, end) => ({
      id: 'gev-dst-1', status: 'confirmed', summary: 'Ausflug',
      start: { date: start }, end: { date: end },
    });
    google.upsertGoogleEvents([allDay('2026-10-23', '2026-10-24')], null, '#4A90E2', {});
    const ev = eventBy('gev-dst-1');
    // Am Vortag 09:00 Sommerzeit (CEST, UTC+2) - so schreibt es der Dialog.
    await setReminders(ev.id, ['2026-10-22T07:00:00']);

    google.upsertGoogleEvents([allDay('2026-10-27', '2026-10-28')], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), ['2026-10-26T08:00:00'],
      'am neuen Vortag 09:00 Winterzeit (CET, UTC+1) - nicht 10:00, was vier volle Tage ergaeben');
  });

  it('Zeittermin mit Zone: "1 Stunde vorher" bleibt eine Stunde vor 10:00 Ortszeit', async () => {
    const timed = (dateTime) => ({
      id: 'gev-dst-2', status: 'confirmed', summary: 'Zahnarzt',
      start: { dateTime, timeZone: 'Europe/Berlin' },
      end: { dateTime: dateTime.replace('T10:', 'T11:'), timeZone: 'Europe/Berlin' },
    });
    google.upsertGoogleEvents([timed('2026-10-23T10:00:00+02:00')], null, '#4A90E2', {});
    const ev = eventBy('gev-dst-2');
    await setReminders(ev.id, ['2026-10-23T07:00:00']); // 09:00 CEST

    google.upsertGoogleEvents([timed('2026-10-27T10:00:00+01:00')], null, '#4A90E2', {});
    assert.deepEqual(remindersOf(ev.id).map((r) => r.remind_at), ['2026-10-27T08:00:00'],
      '09:00 CET: der Vorlauf bleibt 60 Minuten, die Uhrzeit folgt dem Termin');
  });
});
