/**
 * Test: Umzug zwischen zwei Kalendern nimmt die Standard-Zuweisung mit (#1270)
 *
 * Zweck: Wer einen Termin im fremden Kalender von A nach B verschiebt, schickt
 *        ihn mit UNVERAENDERTER Identitaet zurueck - CalDAV/Apple ueber die
 *        iCal-UID, Google ueber die Event-ID. Der Inbound haengt die Zeile per
 *        UPDATE um, `calendar_ref_id` wandert also mit (die Detailansicht zeigt
 *        danach den richtigen Kalender). Die Zuweisung blieb bei der
 *        Standard-Person von A - und mit ihr die Anzeigefarbe, die einem Termin
 *        ohne eigene Farbe von der PRIMAEREN zugewiesenen Person kommt (#891).
 *
 * Laufweg: der ECHTE Inbound je Anbieter, nicht der Helfer allein -
 *          caldav-sync.js `sync({ createClient })`, apple-calendar.js
 *          `sync({ makeClient })`, google-calendar.js `__test.upsertGoogleEvents`.
 *          Geprueft wird der Stand in der Datenbank, also was die Leseabfrage
 *          der Kalenderansicht daraus macht.
 *
 * Volles Schema aus server/db.js: `setEventAssignments()` fasst
 * `event_assignments`, `reminders` und die Dokumentrechte eines Anhangs an - ein
 * schlankes Testschema haette den halben Schreibweg verschwiegen.
 *
 * Ausfuehren: npm run test:sync-calendar-move-assignment
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.APPLE_CALDAV_URL = 'https://caldav.icloud.example/';
process.env.APPLE_USERNAME = 'apple-user';
process.env.APPLE_APP_SPECIFIC_PASSWORD = 'apple-pass';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Nach dem Setzen von DB_PATH: server/db.js verbindet BEIM IMPORT.
const db = (await import('../server/db.js')).get();
const { sync: caldavSync } = await import('../server/services/caldav-sync.js');
const { sync: appleSync } = await import('../server/services/apple-calendar.js');
const { __test: google } = await import('../server/services/google-calendar.js');
const { reassignDefaultOnCalendarMove } = await import('../server/services/sync-assignment.js');

const CAL_A = 'https://dav.example/cal-a/';
const CAL_B = 'https://dav.example/cal-b/';
const GCAL_A = 'a@group.calendar.google.com';
const GCAL_B = 'b@group.calendar.google.com';
const UID = 'move-me@example.org';

let OWNER; let ANNA; let BEN; let CHRIS;

function addUser(username, color) {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, avatar_color)
    VALUES (?, ?, 'x', 'member', ?) RETURNING id
  `).get(username, username, color).id);
}

/** Der Kalender, wie ihn die Admin-Seite anlegt: mit Standard-Person (#459). */
function externalCalendar(source, externalId, name, defaultAssignee) {
  const id = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color, default_assignee_user_id)
    VALUES (?, ?, ?, '#4A90E2', ?) RETURNING id
  `).get(source, externalId, name, defaultAssignee).id);
  return id;
}

function assignmentsOf(eventId) {
  return db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id')
    .all(eventId).map((r) => Number(r.user_id));
}

function eventRow() {
  return db.prepare(
    'SELECT id, assigned_to, calendar_ref_id FROM calendar_events WHERE external_calendar_id = ?'
  ).get(UID);
}

function resetTables() {
  for (const t of ['reminders', 'event_assignments', 'calendar_event_exceptions',
    'calendar_events', 'external_calendars', 'caldav_calendar_selection',
    'caldav_accounts', 'google_calendar_selection', 'calendar_pending_deletions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  OWNER = addUser('owner', '#000000');
  ANNA = addUser('anna', '#FF0000');
  BEN = addUser('ben', '#00FF00');
  CHRIS = addUser('chris', '#0000FF');
}

const VEVENT = (uid) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  `UID:${uid}`, 'SUMMARY:Zahnarzt',
  'DTSTART:20260401T090000Z', 'DTEND:20260401T100000Z',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

/**
 * CalDAV-Client, der GENAU EINEN Kalender mit dem Termin liefert. `null` als
 * Kalender heisst: kein Kalender liefert etwas - so laeuft der Outbound-Push
 * ohne einen Inbound-Fund davor.
 */
const caldavClient = (calendarUrl, uid = UID) => async () => ({
  fetchCalendars: async () => [
    { url: CAL_A, displayName: 'Kalender A', components: ['VEVENT'] },
    { url: CAL_B, displayName: 'Kalender B', components: ['VEVENT'] },
  ],
  fetchCalendarObjects: async ({ calendar }) =>
    (calendar.url === calendarUrl ? [{ data: VEVENT(uid), url: `${calendarUrl}${uid}.ics` }] : []),
  createCalendarObject: async () => ({}),
});

const appleClient = (calendarUrl, uid = UID) => async () => ({
  fetchCalendars: async () => [
    { url: CAL_A, displayName: 'Kalender A', calendarColor: '#FF0000' },
    { url: CAL_B, displayName: 'Kalender B', calendarColor: '#00FF00' },
  ],
  fetchCalendarObjects: async ({ calendar }) =>
    (calendar.url === calendarUrl ? [{ data: VEVENT(uid), url: `${calendarUrl}${uid}.ics` }] : []),
  createCalendarObject: async () => ({}),
});

function seedCaldavAccount() {
  db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('OX', 'https://dav.example/', 'u', 'p')`).run();
  const accountId = Number(db.prepare('SELECT id FROM caldav_accounts').get().id);
  for (const [url, name] of [[CAL_A, 'Kalender A'], [CAL_B, 'Kalender B']]) {
    db.prepare(`INSERT INTO caldav_calendar_selection
      (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, '#4A90E2', 1)`).run(accountId, url, name);
  }
}

const gItem = (id) => ({
  id,
  status: 'confirmed',
  summary: 'Zahnarzt',
  start: { dateTime: '2026-04-01T09:00:00Z' },
  end: { dateTime: '2026-04-01T10:00:00Z' },
});

describe('#1270 - der Umzug nimmt die unangetastete Standard-Zuweisung mit', () => {
  beforeEach(resetTables);

  it('CalDAV: A -> B stellt die Zuweisung auf die Standard-Person von B um', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    assert.ok(imported, 'Der Termin wurde aus Kalender A importiert');
    assert.equal(Number(imported.assigned_to), ANNA, 'Import: Standard-Person von A');
    assert.deepEqual(assignmentsOf(imported.id), [ANNA]);

    // Derselbe Termin, gleiche UID, jetzt in Kalender B.
    await caldavSync({ createClient: caldavClient(CAL_B) });
    const moved = eventRow();
    assert.equal(Number(moved.id), Number(imported.id), 'dieselbe Zeile, kein Neuimport');
    const calB = db.prepare('SELECT id FROM external_calendars WHERE external_id = ?').get(CAL_B);
    assert.equal(Number(moved.calendar_ref_id), Number(calB.id), 'der Kalender ist B');
    assert.equal(Number(moved.assigned_to), BEN, 'die primaere Zuweisung ist die Person von B');
    assert.deepEqual(assignmentsOf(moved.id), [BEN], 'und sie ist die einzige');
  });

  it('CalDAV: eine von Hand gesetzte Zuweisung bleibt beim Umzug stehen', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    // Von Hand auf Chris umgestellt - so, wie die Route es schreibt.
    db.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?').run(CHRIS, imported.id);
    db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(imported.id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(imported.id, CHRIS);

    await caldavSync({ createClient: caldavClient(CAL_B) });
    const moved = eventRow();
    assert.equal(Number(moved.assigned_to), CHRIS, 'die Handarbeit bleibt');
    assert.deepEqual(assignmentsOf(moved.id), [CHRIS]);
  });

  it('CalDAV: zwei Zugewiesene sind keine Standard-Zuweisung und bleiben stehen', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(imported.id, CHRIS);

    await caldavSync({ createClient: caldavClient(CAL_B) });
    assert.deepEqual(assignmentsOf(imported.id), [ANNA, CHRIS].sort((a, b) => a - b));
    assert.equal(Number(eventRow().assigned_to), ANNA);
  });

  it('CalDAV: ein Kalender ohne Standard-Person nimmt keine Zuweisung weg', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', null);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    await caldavSync({ createClient: caldavClient(CAL_B) });
    assert.deepEqual(assignmentsOf(imported.id), [ANNA], 'die Zuweisung bleibt');
    assert.equal(Number(eventRow().assigned_to), ANNA);
  });

  it('CalDAV: eine entfernte Zuweisung kehrt beim Umzug nicht zurueck', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(imported.id);
    db.prepare('UPDATE calendar_events SET assigned_to = NULL WHERE id = ?').run(imported.id);

    await caldavSync({ createClient: caldavClient(CAL_B) });
    assert.deepEqual(assignmentsOf(imported.id), [], 'bleibt leer');
    assert.equal(eventRow().assigned_to, null);
  });

  it('Apple: A -> B stellt die Zuweisung um', async () => {
    externalCalendar('apple', CAL_A, 'Kalender A', ANNA);
    externalCalendar('apple', CAL_B, 'Kalender B', BEN);

    await appleSync({ makeClient: appleClient(CAL_A) });
    const imported = eventRow();
    assert.ok(imported, 'Der Termin wurde aus Kalender A importiert');
    assert.equal(Number(imported.assigned_to), ANNA);

    await appleSync({ makeClient: appleClient(CAL_B) });
    assert.equal(Number(eventRow().assigned_to), BEN);
    assert.deepEqual(assignmentsOf(imported.id), [BEN]);
  });

  it('Apple: eine von Hand gesetzte Zuweisung bleibt stehen', async () => {
    externalCalendar('apple', CAL_A, 'Kalender A', ANNA);
    externalCalendar('apple', CAL_B, 'Kalender B', BEN);

    await appleSync({ makeClient: appleClient(CAL_A) });
    const imported = eventRow();
    db.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?').run(CHRIS, imported.id);
    db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(imported.id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(imported.id, CHRIS);

    await appleSync({ makeClient: appleClient(CAL_B) });
    assert.equal(Number(eventRow().assigned_to), CHRIS);
    assert.deepEqual(assignmentsOf(imported.id), [CHRIS]);
  });

  it('Google: A -> B stellt die Zuweisung um (gleiche Event-ID)', () => {
    const refA = externalCalendar('google', GCAL_A, 'Kalender A', ANNA);
    const refB = externalCalendar('google', GCAL_B, 'Kalender B', BEN);

    google.upsertGoogleEvents([gItem('gev-1')], refA, '#4A90E2', {});
    const imported = db.prepare(
      'SELECT id, assigned_to, calendar_ref_id FROM calendar_events WHERE external_calendar_id = ?'
    ).get('gev-1');
    assert.ok(imported, 'Der Termin wurde aus Kalender A importiert');
    assert.equal(Number(imported.assigned_to), ANNA);

    // A meldet den Umzug als 'cancelled', B liefert ihn aktiv - dieselbe ID.
    //
    // UND ZWAR IN DIESER REIHENFOLGE: B zuerst. Googles Abarbeitung geht Kalender
    // fuer Kalender, und nur so bleibt die Zeile ueberhaupt bestehen - danach
    // zeigt ihr calendar_ref_id auf B, und As ID-plus-Kalender-DELETE trifft sie
    // nicht mehr (der Grund, aus dem es auf den meldenden Kalender eingegrenzt
    // ist). Kommt As Absage zuerst, faellt die Zeile und B legt sie neu an; dann
    // greift der INSERT-Zweig und die Zuweisung stimmt auch ohne diesen Fix.
    // Der gemeldete Fall ist der andere.
    google.upsertGoogleEvents([gItem('gev-1')], refB, '#4A90E2', {});
    google.upsertGoogleEvents([{ id: 'gev-1', status: 'cancelled' }], refA, '#4A90E2', {});
    const moved = db.prepare(
      'SELECT id, assigned_to, calendar_ref_id FROM calendar_events WHERE external_calendar_id = ?'
    ).get('gev-1');
    assert.equal(Number(moved.id), Number(imported.id), 'dieselbe Zeile');
    assert.equal(Number(moved.calendar_ref_id), refB);
    assert.equal(Number(moved.assigned_to), BEN);
    assert.deepEqual(assignmentsOf(moved.id), [BEN]);
  });

  it('Google: eine von Hand gesetzte Zuweisung bleibt stehen', () => {
    const refA = externalCalendar('google', GCAL_A, 'Kalender A', ANNA);
    const refB = externalCalendar('google', GCAL_B, 'Kalender B', BEN);

    google.upsertGoogleEvents([gItem('gev-2')], refA, '#4A90E2', {});
    const imported = db.prepare('SELECT id FROM calendar_events WHERE external_calendar_id = ?').get('gev-2');
    db.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?').run(CHRIS, imported.id);
    db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(imported.id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(imported.id, CHRIS);

    google.upsertGoogleEvents([gItem('gev-2')], refB, '#4A90E2', {});
    assert.deepEqual(assignmentsOf(imported.id), [CHRIS]);
  });

  it('die Erinnerung folgt der Zuweisung, eine vergangene aber nicht als Meldung', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();

    await caldavSync({ createClient: caldavClient(CAL_A) });
    const imported = eventRow();
    // Zwei Erinnerungen des Anlegers: eine vergangene, eine kuenftige.
    db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('event', ?, '2020-01-01T08:00:00Z', ?)`).run(imported.id, OWNER);
    db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('event', ?, '2099-01-01T08:00:00Z', ?)`).run(imported.id, OWNER);

    await caldavSync({ createClient: caldavClient(CAL_B) });
    assert.deepEqual(assignmentsOf(imported.id), [BEN]);

    const bens = db.prepare(`SELECT remind_at, dismissed FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
      ORDER BY remind_at`).all(imported.id, BEN);
    assert.equal(bens.length, 2, 'Ben erbt beide Erinnerungen des Anlegers');
    assert.equal(Number(bens[0].dismissed), 1, 'die vergangene gilt als verworfen');
    assert.equal(Number(bens[1].dismissed), 0, 'die kuenftige kommt wie gewohnt');

    const annas = db.prepare(`SELECT COUNT(*) AS n FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?`).get(imported.id, ANNA);
    assert.equal(Number(annas.n), 0, 'Anna hat den Termin nicht mehr und keine Erinnerung daran');
  });
});

describe('#1270 - der Helfer selbst', () => {
  beforeEach(resetTables);

  /** Ein importierter Termin in `refId`, zugewiesen an `userIds`. */
  function seedEvent(refId, userIds, primary = userIds[0] ?? null) {
    const id = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, external_calendar_id, external_source,
         calendar_ref_id, created_by, assigned_to)
      VALUES ('X', '2026-04-01T09:00', '2026-04-01T10:00', ?, 'caldav', ?, ?, ?)
      RETURNING id
    `).get(UID, refId, OWNER, primary).id);
    for (const uid of userIds) {
      db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, uid);
    }
    return id;
  }

  it('eine Altzeile ohne calendar_ref_id bleibt unangetastet', () => {
    const refB = externalCalendar('caldav', CAL_B, 'B', BEN);
    const id = seedEvent(null, [ANNA]);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: null, toCalRefId: refB, toDefaultUserId: BEN,
      }),
      false,
    );
    assert.deepEqual(assignmentsOf(id), [ANNA]);
  });

  it('derselbe Kalender ist kein Umzug', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', ANNA);
    const id = seedEvent(refA, [ANNA]);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refA, toDefaultUserId: ANNA,
      }),
      false,
    );
  });

  it('ein alter Kalender ohne Standard-Person laesst die Zuweisung stehen', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', null);
    const refB = externalCalendar('caldav', CAL_B, 'B', BEN);
    const id = seedEvent(refA, [ANNA]);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: BEN,
      }),
      false,
    );
    assert.deepEqual(assignmentsOf(id), [ANNA]);
  });

  it('eine verwaiste Standard-Person des neuen Kalenders wird still uebergangen', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', ANNA);
    const refB = externalCalendar('caldav', CAL_B, 'B', null);
    const id = seedEvent(refA, [ANNA]);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: 9999,
      }),
      false,
    );
    assert.deepEqual(assignmentsOf(id), [ANNA]);
  });

  it('beide Kalender mit derselben Standard-Person: nichts zu tun', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', ANNA);
    const refB = externalCalendar('caldav', CAL_B, 'B', ANNA);
    const id = seedEvent(refA, [ANNA]);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: ANNA,
      }),
      false,
    );
    assert.deepEqual(assignmentsOf(id), [ANNA]);
  });

  it('eine abweichende primaere Zuweisung schuetzt die Zeile', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', ANNA);
    const refB = externalCalendar('caldav', CAL_B, 'B', BEN);
    // event_assignments = {Anna}, aber assigned_to nennt Chris - kein
    // unangetasteter Import.
    const id = seedEvent(refA, [ANNA], CHRIS);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: BEN,
      }),
      false,
    );
    assert.deepEqual(assignmentsOf(id), [ANNA]);
  });

  it('eine leere primaere Spalte hindert den Umzug nicht', () => {
    const refA = externalCalendar('caldav', CAL_A, 'A', ANNA);
    const refB = externalCalendar('caldav', CAL_B, 'B', BEN);
    const id = seedEvent(refA, [ANNA], null);
    assert.equal(
      reassignDefaultOnCalendarMove(db, id, {
        fromCalRefId: refA, toCalRefId: refB, toDefaultUserId: BEN,
      }),
      true,
    );
    assert.deepEqual(assignmentsOf(id), [BEN]);
    assert.equal(Number(db.prepare('SELECT assigned_to FROM calendar_events WHERE id = ?').get(id).assigned_to), BEN);
  });
});

// --------------------------------------------------------
// Der hinausgepushte Termin (Folgebefund zu #1270).
//
// Ein eigener Termin, den jemand von Hand der Person zuweist, die AUCH der
// Zielkalender vergibt, sieht nach dem Push wie ein unangetasteter Import aus:
// `calendar_ref_id` zeigt auf A, die Zuweisung nennt As Standard-Person. Die
// Schwester-Abfrage des Nachtragens (#1154) kennt diesen Fall und nimmt einen
// hinausgepushten Termin ausdruecklich aus; der Umzug tat es nicht und stellte
// die Handarbeit auf die Person von B um.
//
// Gefahren wird der ECHTE Weg: der Outbound-Push uebergibt die Zeile an den
// Sync (oikos-UID, `calendar_ref_id`), der Inbound haengt sie danach um.
// --------------------------------------------------------

describe('#1270 - ein hinausgepushter Termin behaelt seine Zuweisung', () => {
  beforeEach(resetTables);

  const rowOf = (id) => db.prepare(
    `SELECT assigned_to, calendar_ref_id, external_source, external_calendar_id
     FROM calendar_events WHERE id = ?`
  ).get(id);
  const refOf = (externalId) => Number(
    db.prepare('SELECT id FROM external_calendars WHERE external_id = ?').get(externalId).id
  );

  it('CalDAV: der eigene Termin, von Hand zugewiesen und hinausgepusht, behaelt sie', async () => {
    externalCalendar('caldav', CAL_A, 'Kalender A', ANNA);
    externalCalendar('caldav', CAL_B, 'Kalender B', BEN);
    seedCaldavAccount();
    const accountId = Number(db.prepare('SELECT id FROM caldav_accounts').get().id);

    // Eigener Termin, von Hand an Anna - die Person, die auch Kalender A vergibt.
    const id = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, created_by, assigned_to,
         target_caldav_account_id, target_caldav_calendar_url)
      VALUES ('Zahnarzt', '2026-04-01T09:00', '2026-04-01T10:00', ?, ?, ?, ?)
      RETURNING id
    `).get(OWNER, ANNA, accountId, CAL_A).id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, ANNA);

    // ECHTER Outbound: kein Kalender liefert etwas, der Push laeuft.
    await caldavSync({ createClient: caldavClient(null) });
    const uid = `oikos-${id}@oikos.local`;
    const pushed = rowOf(id);
    assert.equal(pushed.external_source, 'caldav', 'der Push hat die Zeile uebergeben');
    assert.equal(pushed.external_calendar_id, uid, 'und ihr die oikos-UID gegeben');
    assert.equal(Number(pushed.calendar_ref_id), refOf(CAL_A), 'sie liegt in Kalender A');

    // ECHTER Inbound: derselbe Termin liegt jetzt in Kalender B.
    await caldavSync({ createClient: caldavClient(CAL_B, uid) });
    const moved = rowOf(id);
    assert.equal(Number(moved.calendar_ref_id), refOf(CAL_B), 'der Umzug kam an');
    assert.equal(Number(moved.assigned_to), ANNA, 'die Handarbeit bleibt');
    assert.deepEqual(assignmentsOf(id), [ANNA], 'und sie ist die einzige');
  });

  it('Apple: die oikos-UID allein haelt die Zuweisung, ohne jedes Ziel', async () => {
    externalCalendar('apple', CAL_A, 'Kalender A', ANNA);
    externalCalendar('apple', CAL_B, 'Kalender B', BEN);

    // Der Apple-Legacy-Outbound laedt JEDEN lokalen Termin in den ersten
    // Kalender - ohne Zielspalte. Die UID ist die einzige Spur des Pushs.
    const id = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, created_by, assigned_to)
      VALUES ('Zahnarzt', '2026-04-01T09:00', '2026-04-01T10:00', ?, ?)
      RETURNING id
    `).get(OWNER, ANNA).id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, ANNA);

    // ECHTER Outbound: kein Kalender liefert etwas, der Push laeuft.
    await appleSync({ makeClient: appleClient(null) });
    const uid = `oikos-${id}@oikos.local`;
    const pushed = rowOf(id);
    assert.equal(pushed.external_source, 'apple', 'der Push hat die Zeile uebergeben');
    assert.equal(pushed.external_calendar_id, uid, 'und ihr die oikos-UID gegeben');
    assert.equal(Number(pushed.calendar_ref_id), refOf(CAL_A), 'sie liegt in Kalender A');
    const targets = db.prepare(`SELECT target_caldav_calendar_url AS c,
      target_google_calendar_id AS g FROM calendar_events WHERE id = ?`).get(id);
    assert.equal(targets.c, null, 'Apple setzt keine CalDAV-Zielspalte');
    assert.equal(targets.g, null, 'und keine Google-Zielspalte');

    // ECHTER Inbound: derselbe Termin liegt jetzt in Kalender B.
    await appleSync({ makeClient: appleClient(CAL_B, uid) });
    const moved = rowOf(id);
    assert.equal(Number(moved.calendar_ref_id), refOf(CAL_B), 'der Umzug kam an');
    assert.equal(Number(moved.assigned_to), ANNA, 'die Handarbeit bleibt');
    assert.deepEqual(assignmentsOf(id), [ANNA], 'und sie ist die einzige');
  });

  it('Google: der gewaehlte Zielkalender haelt die Zuweisung', () => {
    const refA = externalCalendar('google', GCAL_A, 'Kalender A', ANNA);
    const refB = externalCalendar('google', GCAL_B, 'Kalender B', BEN);

    // Der Stand, den der Google-Outbound nach dem Push schreibt
    // (google-calendar.js: external_source='google' + calendar_ref_id, das
    // gewaehlte Ziel bleibt stehen). Von Hand an Anna, die auch A vergibt.
    const id = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, created_by, assigned_to,
         external_source, external_calendar_id, calendar_ref_id,
         target_google_calendar_id)
      VALUES ('Zahnarzt', '2026-04-01T09:00', '2026-04-01T10:00', ?, ?,
              'google', 'gev-push', ?, ?)
      RETURNING id
    `).get(OWNER, ANNA, refA, GCAL_A).id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, ANNA);

    // ECHTER Inbound: dieselbe Event-ID, jetzt aus Kalender B.
    google.upsertGoogleEvents([gItem('gev-push')], refB, '#4A90E2', {});
    const moved = rowOf(id);
    assert.equal(Number(moved.calendar_ref_id), refB, 'der Umzug kam an');
    assert.equal(Number(moved.assigned_to), ANNA, 'die Handarbeit bleibt');
    assert.deepEqual(assignmentsOf(id), [ANNA], 'und sie ist die einzige');
  });

  it('Google: ein Termin von vor Migration 47 bleibt aussen vor', () => {
    const refA = externalCalendar('google', GCAL_A, 'Kalender A', ANNA);
    const refB = externalCalendar('google', GCAL_B, 'Kalender B', BEN);

    // Vor Migration 47 lud der Google-Outbound JEDEN lokalen Termin in den einen
    // Google-Kalender, ohne Ziel, und die Migration hat target_google_calendar_id
    // nicht nachgetragen: ein solcher Push ist von einem Import nicht zu
    // unterscheiden. Dass hier nur Handarbeit stehen kann, sagt das Datum - die
    // Standard-Person je Kalender kam erst mit Migration 79, der Import konnte
    // die Zuweisung damals also nicht gesetzt haben.
    const id = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, created_by, assigned_to,
         external_source, external_calendar_id, calendar_ref_id)
      VALUES ('Zahnarzt', '2026-04-01T09:00', '2026-04-01T10:00', ?, ?,
              'google', 'gev-legacy', ?)
      RETURNING id
    `).get(OWNER, ANNA, refA).id);
    db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, ANNA);
    db.prepare(`UPDATE calendar_events SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(id);
    const applied = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 47').get();
    assert.ok(applied, 'Migration 47 steht in schema_migrations');

    google.upsertGoogleEvents([gItem('gev-legacy')], refB, '#4A90E2', {});
    const moved = rowOf(id);
    assert.equal(Number(moved.calendar_ref_id), refB, 'der Umzug kam an');
    assert.equal(Number(moved.assigned_to), ANNA, 'die Handarbeit bleibt');
    assert.deepEqual(assignmentsOf(id), [ANNA], 'und sie ist die einzige');
  });
});
