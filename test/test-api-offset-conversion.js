/**
 * Modul: Test - Offset-Eingabe an der API-Grenze (#1364)
 * Zweck: Ein Datum mit `Z` oder numerischem Offset ist ein eindeutiger
 *        Zeitpunkt. `datetime()` in server/middleware/validate.js las davon bis
 *        v2.68.0 nur die Ziffern, und jede Route speicherte sie als Wanduhrzeit
 *        des Haushalts: `2026-09-21T16:00:00Z` lag in Berlin zwei Stunden zu
 *        frueh, ohne Fehler. Geprueft wird, dass jeder Wert in die Form SEINER
 *        Spalte umgerechnet wird:
 *        - Wanduhrzeit (Kalender start/end, Gesundheits-Zeitstempel): in der
 *          Haushaltszone; ganztaegig zaehlt nur das Datum,
 *        - `reminders.remind_at`: naiv-UTC, wie der Scheduler vergleicht - und
 *          eine schon roh mit Offset gespeicherte Zeile feuert trotzdem
 *          puenktlich, ohne Migration,
 *        - `housekeeping_decay_tasks.last_completed`: UTC-Instant wie `/complete`,
 *        dazu PUT gleich POST, MCP `create_event` auf demselben Weg, eine
 *        Wochenserie ueber die Zeitumstellung und die Herbst-Doppelstunde.
 *
 * DIE ZONE STEHT FEST (Europe/Berlin), sie ist eine Einstellung und kein
 * Zufall der Maschine; die Tests, die sie verschieben, stellen sie zurueck.
 * Die Maschinenzone spielt fuer die Aussagen keine Rolle - gegengeprueft unter
 * `TZ=UTC` und `TZ=America/Chicago`.
 *
 * Ausführen: node --experimental-sqlite --test test/test-api-offset-conversion.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { datetime } = await import('../server/middleware/validate.js');
const { storedToInstantMs, storedToInstantMsPrecise } = await import('../server/utils/timezone.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { default: healthRouter } = await import('../server/routes/health.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { callTool } = await import('../server/mcp/tools.js');
const { processDueNotifications } = await import('../server/services/notifications.js');
const {
  applyDefaultAssigneesToExisting,
  listBackfillCandidates,
  reassignDefaultOnCalendarMove,
} = await import('../server/services/sync-assignment.js');

const HOUSEHOLD = 'Europe/Berlin';

function setZone(zone) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(zone);
}

/** Fuehrt `fn` in einer anderen Haushaltszone aus und stellt die Suite danach zurueck. */
async function inZone(zone, fn) {
  setZone(zone);
  try { return await fn(); } finally { setZone(HOUSEHOLD); }
}

setZone(HOUSEHOLD);

const ADMIN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', 'x', 'admin')
`).run().lastInsertRowid;
const ANNA = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('anna', 'Anna', 'x', 'member')
`).run().lastInsertRowid;
const BEN = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('ben', 'Ben', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  req.authUserId = ADMIN;
  req.authRole = 'admin';
  req.session = { userId: ADMIN, role: 'admin' };
  next();
});
app.use('/calendar', calendarRouter);
app.use('/reminders', remindersRouter);
app.use('/health', healthRouter);
app.use('/housekeeping', housekeepingRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((resolve) => server.on('listening',
  () => resolve(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* kein JSON */ }
  return { status: res.status, body: json };
}

const eventRow = (id) => db.prepare(
  'SELECT start_datetime, end_datetime, all_day FROM calendar_events WHERE id = ?',
).get(id);

/**
 * Ein Zeitpunkt in einer bestimmten Offset-Schreibweise, wie ein Fremd-Client
 * ihn schickt: `offsetOf(ms, 120)` -> `...T18:00:00+02:00` fuer 16:00Z.
 */
function offsetOf(ms, offsetMinutes, { colon = true } = {}) {
  const digits = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${digits}${offsetMinutes < 0 ? '-' : '+'}${hh}${colon ? ':' : ''}${mm}`;
}

// ── datetime(): die Rechnung selbst ─────────────────────────────────────────

test('datetime(): ein Offset wird in die Wanduhrzeit der Zone umgerechnet, nicht abgeschnitten', () => {
  const wall = { to: 'wall', zone: HOUSEHOLD };
  assert.equal(datetime('2026-09-21T16:00:00.000Z', 'f', true, wall).value, '2026-09-21T18:00');
  assert.equal(datetime('2026-09-21T18:00:00+02:00', 'f', true, wall).value, '2026-09-21T18:00');
  // Ohne Doppelpunkt und mit Mikrosekunden - die Form aus `isoformat()`.
  assert.equal(datetime('2026-09-16T18:15:32.123456+0000', 'f', true, wall).value, '2026-09-16T20:15');
  assert.equal(datetime('2026-09-21T12:00-04:00', 'f', true, wall).value, '2026-09-21T18:00');
  // Ueber die Datumsgrenze: 23:30Z ist in Berlin schon der naechste Tag.
  assert.equal(datetime('2026-09-21T23:30:00Z', 'f', true, wall).value, '2026-09-22T01:30');
});

test('datetime(): Werte ohne Offset bleiben, was sie waren', () => {
  const wall = { to: 'wall', zone: HOUSEHOLD };
  assert.equal(datetime('2026-09-21T18:00', 'f', true, wall).value, '2026-09-21T18:00');
  assert.equal(datetime('2026-09-21T18:00:59.999', 'f', true, wall).value, '2026-09-21T18:00');
  assert.equal(datetime('2026-09-21', 'f', true, wall).value, '2026-09-21');
  // naiv-UTC: die zonenlose Form IST schon die Zielform und bleibt unberuehrt.
  assert.equal(datetime('2026-09-22T16:00:00', 'f', true, { to: 'utc' }).value, '2026-09-22T16:00:00');
  assert.equal(datetime('2026-09-22', 'f', true, { to: 'utc' }).value, '2026-09-22');
  // Ohne Ziel und ohne Offset: das bisherige Verhalten.
  assert.equal(datetime('2026-09-21T18:00:30', 'f').value, '2026-09-21T18:00');
});

test('datetime(): naiv-UTC und Instant fuer die Spalten, die einen Zeitpunkt meinen', () => {
  assert.equal(datetime('2026-09-22T18:00:00+02:00', 'f', true, { to: 'utc' }).value, '2026-09-22T16:00:00');
  assert.equal(datetime('2026-09-22T12:00:00-0400', 'f', true, { to: 'utc' }).value, '2026-09-22T16:00:00');
  assert.equal(datetime('2026-09-22T16:00:00.250Z', 'f', true, { to: 'utc' }).value, '2026-09-22T16:00:00');
  assert.equal(datetime('2026-09-21T18:00:00+02:00', 'f', true, { to: 'instant' }).value, '2026-09-21T16:00:00.000Z');
  assert.equal(datetime('2026-09-21T16:00:00.123456Z', 'f', true, { to: 'instant' }).value, '2026-09-21T16:00:00.123Z');
});

test('datetime(): ganztaegig zaehlt nur das gesendete Datum', () => {
  const allDay = { to: 'wall', zone: 'America/New_York', allDay: true };
  assert.equal(datetime('2026-09-21T00:00:00Z', 'f', true, allDay).value, '2026-09-21');
  assert.equal(datetime('2026-09-21T23:30:00-04:00', 'f', true, allDay).value, '2026-09-21');
  // Gegenrichtung: ohne `allDay` rutscht derselbe Wert westlich von UTC auf den Vorabend.
  assert.equal(datetime('2026-09-21T00:00:00Z', 'f', true, { to: 'wall', zone: 'America/New_York' }).value,
    '2026-09-20T20:00');
});

test('datetime(): ein Offset ohne genanntes Ziel wirft, statt still abzuschneiden', () => {
  assert.throws(() => datetime('2026-09-21T16:00:00Z', 'f', true), TypeError);
  assert.throws(() => datetime('2026-09-21T16:00:00Z', 'f', true, { to: 'wall' }), TypeError);
  assert.throws(() => datetime('2026-09-21T16:00:00Z', 'f', true, { to: 'wall', zone: 'Mars/Olympus' }), TypeError);
});

test('datetime(): Ziffern, die keinen Zeitpunkt bilden, sind ein 400 statt eines Ueberlaufs', () => {
  const wall = { to: 'wall', zone: HOUSEHOLD };
  for (const bad of ['2026-02-30T10:00Z', '2026-09-21T24:00:00Z', '2026-09-21T10:60Z', '2026-09-21T10:00+24:00']) {
    const r = datetime(bad, 'f', true, wall);
    assert.equal(r.value, null, bad);
    assert.match(r.error, /valid date and time/, bad);
  }
  assert.equal(datetime('2026-02-30T00:00Z', 'f', true, { ...wall, allDay: true }).value, null);
});

test('datetime(): dieselbe Eingabe, drei Haushaltszonen, drei Wanduhrzeiten', () => {
  const at = (zone) => datetime('2026-09-21T16:00:00Z', 'f', true, { to: 'wall', zone }).value;
  const got = {
    'Europe/Berlin': at('Europe/Berlin'),
    'America/New_York': at('America/New_York'),
    'Pacific/Kiritimati': at('Pacific/Kiritimati'),
  };
  assert.deepEqual(got, {
    'Europe/Berlin': '2026-09-21T18:00',
    'America/New_York': '2026-09-21T12:00',
    'Pacific/Kiritimati': '2026-09-22T06:00',
  });
  assert.equal(new Set(Object.values(got)).size, 3, 'die Zone muss die Antwort bestimmen');
});

// ── Kalender ─────────────────────────────────────────────────────────────────

test('POST /calendar: `Z` ergibt die richtige Wanduhrzeit', async () => {
  const res = await call('POST', '/calendar', {
    title: 'Z-Start', start_datetime: '2026-09-21T16:00:00.000Z', end_datetime: '2026-09-21T17:30:00Z',
  });
  assert.equal(res.status, 201);
  assert.deepEqual({ ...eventRow(res.body.data.id) },
    { start_datetime: '2026-09-21T18:00', end_datetime: '2026-09-21T19:30', all_day: 0 });
  assert.equal(res.body.data.start_datetime, '2026-09-21T18:00');
});

test('PUT /calendar/:id speichert denselben Wert wie POST, nicht den rohen', async () => {
  const input = { start_datetime: '2026-09-21T16:00:00.000Z', end_datetime: '2026-09-21T13:30:00-04:00' };
  const posted = await call('POST', '/calendar', { title: 'POST', ...input });
  const created = await call('POST', '/calendar', { title: 'PUT', start_datetime: '2026-09-21T10:00' });
  const put = await call('PUT', `/calendar/${created.body.data.id}`, input);
  assert.equal(put.status, 200);
  assert.deepEqual({ ...eventRow(created.body.data.id) }, { ...eventRow(posted.body.data.id) });
  assert.equal(eventRow(created.body.data.id).start_datetime, '2026-09-21T18:00');
  assert.equal(put.body.data.start_datetime, '2026-09-21T18:00');
});

test('PUT /calendar/:id: ganztaegig mit `T00:00Z` bleibt westlich von UTC am gesendeten Datum', async () => {
  await inZone('America/New_York', async () => {
    const posted = await call('POST', '/calendar', {
      title: 'Ganztag POST', all_day: true,
      start_datetime: '2026-09-21T00:00:00Z', end_datetime: '2026-09-22T00:00:00Z',
    });
    assert.deepEqual({ ...eventRow(posted.body.data.id) },
      { start_datetime: '2026-09-21', end_datetime: '2026-09-22', all_day: 1 });

    // Ueber PUT: der Body nennt `all_day` gar nicht, der Termin ist es schon.
    const created = await call('POST', '/calendar', { title: 'Ganztag PUT', all_day: true, start_datetime: '2026-09-10' });
    const put = await call('PUT', `/calendar/${created.body.data.id}`, { start_datetime: '2026-09-21T00:00:00Z' });
    assert.equal(put.status, 200);
    assert.equal(eventRow(created.body.data.id).start_datetime, '2026-09-21');

    // Gegenrichtung im selben Haushalt: ein Termin mit Uhrzeit wird umgerechnet.
    const timed = await call('POST', '/calendar', { title: 'Mit Uhrzeit', start_datetime: '2026-09-21T00:00:00Z' });
    assert.equal(eventRow(timed.body.data.id).start_datetime, '2026-09-20T20:00');
  });
});

test('PUT /calendar/:seriesId/occurrences/:recurrenceId rechnet einen Offset ebenso um', async () => {
  const series = await call('POST', '/calendar', {
    title: 'Serie mit Ausnahme', start_datetime: '2040-04-10T09:00', recurrence_rule: 'FREQ=DAILY',
  });
  const res = await call('PUT', `/calendar/${series.body.data.id}/occurrences/2040-04-11`, {
    start_datetime: '2040-04-11T08:15:00Z', end_datetime: '2040-04-11T11:45:00+02:00',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    { ...db.prepare('SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?').get(res.body.data.id) },
    { start_datetime: '2040-04-11T10:15', end_datetime: '2040-04-11T11:45' },
  );
});

test('MCP create_event laeuft durch denselben Weg wie POST', async () => {
  const created = await callTool({ db, actor: { id: ADMIN, role: 'admin' } }, 'create_event', {
    title: 'Vom LLM', start_datetime: '2026-09-21T16:00:00Z', end_datetime: '2026-09-21T17:00:00Z',
  });
  assert.equal(created.start_datetime, '2026-09-21T18:00');
  assert.equal(created.end_datetime, '2026-09-21T19:00');
  const allDay = await callTool({ db, actor: { id: ADMIN, role: 'admin' } }, 'create_event', {
    title: 'Ganztag vom LLM', all_day: true, start_datetime: '2026-09-21T23:00:00-05:00',
  });
  assert.equal(allDay.start_datetime, '2026-09-21');
});

/** Die Vorkommen einer Serie im Fenster als Wanduhrzeit der Haushaltszone. */
async function seriesWallTimes(id) {
  const res = await call('GET', '/calendar?from=2026-10-19&to=2026-11-04');
  return (res.body?.data || [])
    .filter((e) => e.id === id || e.series_id === id)
    .map((e) => {
      const ms = storedToInstantMs(e.start_datetime, HOUSEHOLD);
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: HOUSEHOLD, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(new Date(ms)).replace(' ', 'T');
    });
}

test('eine Wochenserie ueber die Zeitumstellung (25.10.2026) bleibt auf ihrer Wanduhrzeit', async () => {
  const expected = ['2026-10-20T18:00', '2026-10-27T18:00', '2026-11-03T18:00'];

  const posted = await call('POST', '/calendar', {
    title: 'Serie per POST', start_datetime: '2026-10-20T16:00:00Z', recurrence_rule: 'FREQ=WEEKLY',
  });
  assert.deepEqual(await seriesWallTimes(posted.body.data.id), expected);

  // Der Weg aus dem Bericht: angelegt mit lokalen Ziffern, der Start per PUT mit `Z`.
  // Roh gespeichert wiederholte die Expansion den UTC-Suffix: 18:00, dann 17:00.
  const created = await call('POST', '/calendar', {
    title: 'Serie per PUT', start_datetime: '2026-10-20T10:00', recurrence_rule: 'FREQ=WEEKLY',
  });
  const put = await call('PUT', `/calendar/${created.body.data.id}`, { start_datetime: '2026-10-20T16:00:00Z' });
  assert.equal(put.status, 200);
  assert.deepEqual(await seriesWallTimes(created.body.data.id), expected);
});

test('Herbst-Doppelstunde: zwei Zeitpunkte, eine Wanduhrzeit - dokumentiertes Verhalten', async () => {
  // Europe/Berlin, 25.10.2026: 02:30 gibt es zweimal, um 00:30Z (CEST) und 01:30Z (CET).
  const first = await call('POST', '/calendar', { title: 'Fold 1', start_datetime: '2026-10-25T00:30:00Z' });
  const second = await call('POST', '/calendar', { title: 'Fold 2', start_datetime: '2026-10-25T01:30:00Z' });
  assert.equal(eventRow(first.body.data.id).start_datetime, '2026-10-25T02:30');
  assert.equal(eventRow(second.body.data.id).start_datetime, '2026-10-25T02:30');
  // Die gespeicherte Wanduhrzeit kann die beiden nicht unterscheiden. Beide
  // Leser nehmen in Berlin die SPAETERE Lage: der erste Zeitpunkt liest sich
  // eine Stunde spaeter zurueck, als er gesendet wurde.
  for (const read of [storedToInstantMs, storedToInstantMsPrecise]) {
    assert.equal(new Date(read('2026-10-25T02:30', 'Europe/Berlin')).toISOString(), '2026-10-25T01:30:00.000Z', read.name);
  }
  // Westlich von UTC faellt die Wahl andersherum: America/New_York, 01.11.2026,
  // 01:30 um 05:30Z (EDT) und 06:30Z (EST) - zurueck kommt die FRUEHERE Lage.
  await inZone('America/New_York', async () => {
    const a = await call('POST', '/calendar', { title: 'Fold NY 1', start_datetime: '2026-11-01T05:30:00Z' });
    const b = await call('POST', '/calendar', { title: 'Fold NY 2', start_datetime: '2026-11-01T06:30:00Z' });
    assert.equal(eventRow(a.body.data.id).start_datetime, '2026-11-01T01:30');
    assert.equal(eventRow(b.body.data.id).start_datetime, '2026-11-01T01:30');
  });
  for (const read of [storedToInstantMs, storedToInstantMsPrecise]) {
    assert.equal(new Date(read('2026-11-01T01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z', read.name);
  }
});

test('POST /calendar folgt der eingestellten Haushaltszone, nicht der Maschine', async () => {
  const stored = {};
  for (const zone of ['Europe/Berlin', 'America/New_York', 'Pacific/Kiritimati']) {
    await inZone(zone, async () => {
      const res = await call('POST', '/calendar', { title: `Zone ${zone}`, start_datetime: '2026-09-21T16:00:00Z' });
      stored[zone] = eventRow(res.body.data.id).start_datetime;
    });
  }
  assert.deepEqual(stored, {
    'Europe/Berlin': '2026-09-21T18:00',
    'America/New_York': '2026-09-21T12:00',
    'Pacific/Kiritimati': '2026-09-22T06:00',
  });
});

// ── Erinnerungen ─────────────────────────────────────────────────────────────

function newEvent(title) {
  return db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, created_by) VALUES (?, '2099-01-01T10:00', ?)
  `).run(title, ADMIN).lastInsertRowid;
}

test('POST und PUT /reminders speichern einen Offset als naiv-UTC', async () => {
  const eventId = newEvent('Erinnerung POST');
  const posted = await call('POST', '/reminders', {
    entity_type: 'event', entity_id: eventId, remind_at: '2099-01-01T09:00:00+02:00',
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.data.remind_at, '2099-01-01T07:00:00');

  const setId = newEvent('Erinnerung PUT');
  const put = await call('PUT', `/reminders?entity_type=event&entity_id=${setId}`, {
    // Derselbe Zeitpunkt in zwei Schreibweisen ist EINE Erinnerung.
    remind_ats: ['2099-01-01T07:00:00', '2099-01-01T09:00:00+02:00', '2099-01-01T05:00-0200'],
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.data.map((r) => r.remind_at), ['2099-01-01T07:00:00']);
});

test('remind_at mit Offset feuert puenktlich - auch eine schon roh so gespeicherte Zeile', async () => {
  const eventId = newEvent('Faellig mit Offset');
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)
  `);
  // Bestand wie vor dem Fix: roh mit Offset in der Zeile.
  const dueEast = insert.run(eventId, offsetOf(now - 30 * 60000, 120), ADMIN).lastInsertRowid;
  const dueNoColon = insert.run(eventId, offsetOf(now - 30 * 60000, 120, { colon: false }), ADMIN).lastInsertRowid;
  const notYetWest = insert.run(eventId, offsetOf(now + 30 * 60000, -240), ADMIN).lastInsertRowid;
  // Und der Weg, den die Route jetzt geht: dieselbe Eingabe, umgerechnet gespeichert.
  const viaRoute = await call('POST', '/reminders', {
    entity_type: 'event', entity_id: newEvent('Faellig ueber die Route'), remind_at: offsetOf(now - 30 * 60000, 120),
  });
  assert.equal(viaRoute.status, 201);

  const pending = await call('GET', '/reminders/pending');
  assert.equal(pending.status, 200);
  const ids = pending.body.data.map((r) => r.id);
  assert.ok(ids.includes(dueEast), `+02:00 vor 30 min ist faellig: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes(dueNoColon), '+0200 ohne Doppelpunkt ebenso');
  assert.ok(ids.includes(viaRoute.body.data.id), 'die umgerechnete Zeile ebenso');
  assert.ok(!ids.includes(notYetWest), '-04:00 in 30 min ist noch nicht faellig');
});

test('der Push-Lauf haelt remind_at als Zeitpunkt, nicht als Text', async () => {
  const eventId = newEvent('Push mit Offset');
  const now = new Date('2026-09-22T16:30:00.000Z');
  const insert = db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)
  `);
  const due = insert.run(eventId, '2026-09-22T18:00:00+02:00', ADMIN).lastInsertRowid;        // 16:00Z
  const early = insert.run(eventId, '2026-09-22T13:00:00-04:00', ADMIN).lastInsertRowid;      // 17:00Z
  await processDueNotifications({
    database: db, now, pushService: { sendPushToUser: async () => 0 }, providers: {},
  });
  const pushed = (id) => db.prepare('SELECT pushed_at FROM reminders WHERE id = ?').get(id).pushed_at;
  assert.ok(pushed(due), 'faellig seit 30 Minuten: zugestellt');
  assert.equal(pushed(early), null, 'erst in 30 Minuten faellig: nicht zu frueh');
});

test('Zuweisung nachtragen: eine vergangene Erinnerung mit Offset gilt als vergangen', async () => {
  const refId = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id)
    VALUES ('caldav', 'https://dav.example/offset-backfill/', 'Offset', ?)
  `).run(ANNA).lastInsertRowid;
  const mk = (title) => db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, created_by, external_source, calendar_ref_id)
    VALUES (?, '2026-09-30T10:00', ?, 'caldav', ?)
  `).run(title, ADMIN, refId).lastInsertRowid;
  const onlyPast = mk('nur vergangen');
  const mixed = mk('gemischt');
  const insert = db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)
  `);
  const now = new Date('2026-09-22T17:00:00.000Z');
  insert.run(onlyPast, '2026-09-22T18:00:00+02:00', ADMIN);   // 16:00Z, vorbei
  insert.run(mixed, '2026-09-22T18:00:00+02:00', ADMIN);      // 16:00Z, vorbei
  insert.run(mixed, '2026-09-29T08:00:00Z', ADMIN);           // kuenftig
  const snapshot = listBackfillCandidates(db).filter((c) => [onlyPast, mixed].includes(c.eventId));
  await applyDefaultAssigneesToExisting(db, snapshot, { now });

  const annas = (id) => db.prepare(`
    SELECT remind_at, dismissed FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? ORDER BY remind_at
  `).all(id, ANNA).map((r) => ({ ...r }));
  assert.deepEqual(annas(onlyPast), [], 'nur Vergangenes: gar keine Verteilung');
  assert.deepEqual(annas(mixed), [
    { remind_at: '2026-09-22T18:00:00+02:00', dismissed: 1 },
    { remind_at: '2026-09-29T08:00:00Z', dismissed: 0 },
  ], 'die vergangene gilt als verworfen, die kuenftige kommt');
});

test('Kalenderumzug: eine vergangene geerbte Erinnerung mit Offset gilt als verworfen', () => {
  const refA = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id)
    VALUES ('caldav', 'https://dav.example/offset-move-a/', 'A', ?)
  `).run(ANNA).lastInsertRowid;
  const refB = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id)
    VALUES ('caldav', 'https://dav.example/offset-move-b/', 'B', ?)
  `).run(BEN).lastInsertRowid;
  const id = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, external_calendar_id, external_source, calendar_ref_id, created_by, assigned_to)
    VALUES ('Umzug', '2026-09-30T10:00', 'offset-move-uid', 'caldav', ?, ?, ?)
  `).run(refA, ADMIN, ANNA).lastInsertRowid;
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, ANNA);
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, ?, ?)
  `).run(id, offsetOf(Date.now() - 30 * 60000, 120), ADMIN);

  assert.equal(reassignDefaultOnCalendarMove(db, id, {
    fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: BEN,
  }), true);
  const bens = db.prepare(`
    SELECT dismissed FROM reminders WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).all(id, BEN);
  assert.equal(bens.length, 1, 'Ben erbt die Erinnerung');
  assert.equal(Number(bens[0].dismissed), 1, 'sie liegt 30 Minuten zurueck und kommt nicht als Meldung');
});

// ── Gesundheit ───────────────────────────────────────────────────────────────

test('Gesundheit: ein Zeitstempel mit `Z` oder Offset wird Wanduhrzeit des Haushalts', async () => {
  // Dieselbe Minute, einmal aus `utcnow()`, einmal aus `now()` mit Ortsoffset.
  for (const measuredAt of ['2026-09-16T18:15:32.123456+00:00', '2026-09-16T20:15:32.123456+02:00']) {
    const res = await call('POST', '/health/vitals', { type: 'weight', value_num: 80, unit: 'kg', measured_at: measuredAt });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.measured_at, '2026-09-16T20:15', measuredAt);
  }
  const vital = await call('POST', '/health/vitals', { type: 'weight', value_num: 81, unit: 'kg', measured_at: '2026-09-16T08:00' });
  const patched = await call('PATCH', `/health/vitals/${vital.body.data.id}`, { measured_at: '2026-09-16T06:00:00Z' });
  assert.equal(patched.body.data.measured_at, '2026-09-16T08:00');

  const activity = await call('POST', '/health/activities', { type: 'run', duration_min: 30, performed_at: '2026-09-16T12:00:00-04:00' });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  assert.equal(activity.body.data.performed_at, '2026-09-16T18:00');

  const meal = await call('POST', '/health/nutrition/entries', { title: 'Abendessen', consumed_at: '2026-09-16T17:30:00Z' });
  assert.equal(meal.status, 201, JSON.stringify(meal.body));
  assert.equal(meal.body.data.consumed_at, '2026-09-16T19:30');

  const med = await call('POST', '/health/medications', { name: 'Ibuprofen' });
  assert.equal(med.status, 201, JSON.stringify(med.body));
  const doseLog = await call('POST', `/health/medications/${med.body.data.id}/logs`, {
    scheduled_at: '2026-09-16T06:00:00Z', status: 'taken', taken_at: '2026-09-16T06:10:00Z',
  });
  assert.equal(doseLog.status, 201, JSON.stringify(doseLog.body));
  assert.equal(doseLog.body.data.scheduled_at, '2026-09-16T08:00');
  assert.equal(doseLog.body.data.taken_at, '2026-09-16T08:10');
  const taken = await call('POST', `/health/logs/${doseLog.body.data.id}/take`, { taken_at: '2026-09-16T06:20:00Z' });
  assert.equal(taken.body.data.taken_at, '2026-09-16T08:20');
});

// ── Haushaltshilfe ───────────────────────────────────────────────────────────

test('last_completed mit Offset wird der UTC-Instant, den /complete schreibt', async () => {
  const res = await call('POST', '/housekeeping/decay-tasks', {
    name: 'Bad', area: 'Bad', frequency_days: 7, last_completed: '2026-09-01T18:00:00+02:00',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.last_completed, '2026-09-01T16:00:00.000Z');
  assert.equal(res.body.data.due_date, '2026-09-08T16:00:00.000Z');

  const patched = await call('PATCH', `/housekeeping/decay-tasks/${res.body.data.id}`, {
    last_completed: '2026-09-02T09:00:00-04:00',
  });
  assert.equal(patched.body.data.last_completed, '2026-09-02T13:00:00.000Z');
});

test('last_completed ohne Offset ist Wanduhrzeit des Haushalts, nicht des Servers', async () => {
  // Kiritimati (UTC+14) liegt weit genug von jeder Maschinenzone weg, dass die
  // alte Lesart in der Serverzone einen anderen Zeitpunkt ergaebe.
  await inZone('Pacific/Kiritimati', async () => {
    const res = await call('POST', '/housekeeping/decay-tasks', {
      name: 'Kueche', area: 'Kueche', frequency_days: 7, last_completed: '2026-09-01T18:00',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.last_completed, '2026-09-01T18:00', 'gespeichert wie gesendet');
    assert.equal(res.body.data.due_date, '2026-09-08T04:00:00.000Z', '18:00 in Kiritimati ist 04:00Z');
  });
});
