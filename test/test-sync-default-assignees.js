/**
 * Test: mehrere Standard-Personen je Sync-Quelle (#1897, #1221, #1940)
 *
 * Zweck: Ein synchronisierter Kalender, ein ICS-Abo und eine CalDAV-
 *        Erinnerungsliste tragen eine MENGE Standard-Personen in einer eigenen
 *        Join-Tabelle (Migration 265) statt der einen Spalte von #459. Ein
 *        Kalender-Import nimmt Personen fuer seinen Lauf mit (#1940).
 *        Geprueft wird jede Stelle, die die Menge liest:
 *          - Migration 265: die bestehende Einzelperson kommt mit, eine
 *            verwaiste nicht;
 *          - neue Termine aus dem Kalender (echter CalDAV-Inbound) bekommen
 *            alle, die erste wird primaer;
 *          - der Umzug zwischen zwei Kalendern (#1270) folgt der Menge, wenn
 *            die Zuweisung genau die Menge des alten Kalenders ist;
 *          - das Nachtragen (#1154) fuellt mit der Menge, die Umzugsliste
 *            (#1307) nennt beide Mengen;
 *          - Erinnerungslisten (#1221): eine neue Aufgabe bekommt die Menge,
 *            eine vorhandene behaelt ihre Zuweisung, eine Einkaufsliste nimmt
 *            keine;
 *          - Import (#1940): neue Termine bekommen die Personen, ein schon
 *            importierter bekommt sie dazu, ohne Personen bleibt alles wie
 *            bisher;
 *          - die Routen nehmen Liste und Altform, lehnen Nicht-Mitglieder ab;
 *          - das Entfernen eines Kontos nimmt es aus jeder Menge.
 *
 *        Volles Schema aus server/db.js, damit setEventAssignments() mit
 *        Erinnerungen und Anhangrechten mitlaeuft.
 *
 * Ausfuehren: npm run test:sync-default-assignees
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { MIGRATIONS } = dbmod;
const { sync: caldavSync } = await import('../server/services/caldav-sync.js');
const sa = await import('../server/services/sync-assignment.js');
// GEGENPROBE: gegen den Stand vor #1897 fehlt das Modul. Statt dass dann die
// ganze Datei am Import scheitert, schreibt und liest der Test dort die alte
// Einzelspalte (die erste Person) - jeder Fall wird an seiner eigenen
// Erwartung rot, nicht an einer fehlenden Datei.
const da = await import('../server/services/default-assignees.js').catch(() => ({
  writeDefaultAssignees(d, kind, id, ids) {
    const table = { calendar: 'external_calendars', subscription: 'ics_subscriptions' }[kind];
    if (!table) throw new Error(`no default assignees for ${kind} before #1897`);
    d.prepare(`UPDATE ${table} SET default_assignee_user_id = ? WHERE id = ?`).run(ids[0] ?? null, id);
  },
  readDefaultAssignees(d, kind, id) {
    const table = { calendar: 'external_calendars', subscription: 'ics_subscriptions' }[kind];
    if (!table) return [];
    const v = d.prepare(`SELECT default_assignee_user_id AS a FROM ${table} WHERE id = ?`).get(id)?.a;
    return v == null ? [] : [v];
  },
}));
const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const ics = await import('../server/services/ics-subscription.js');
const reminders = await import('../server/services/caldav-reminders-sync.js');
const { removeUser } = await import('../server/services/user-removal.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

const CAL_TOGETHER = 'https://dav.example/together/';
const CAL_BEN = 'https://dav.example/ben/';
const UID = 'dentist@example.org';

let OWNER; let ANNA; let BEN; let CHRIS; let STAFF;

function addUser(username, color = '#123456') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, avatar_color)
    VALUES (?, ?, 'x', 'member', ?) RETURNING id
  `).get(username, username[0].toUpperCase() + username.slice(1), color).id);
}

function resetTables() {
  for (const t of ['reminders', 'event_assignments', 'calendar_event_exceptions', 'calendar_events',
    'external_calendar_assignees', 'ics_subscription_assignees', 'caldav_reminder_assignees',
    'external_calendars', 'caldav_calendar_selection', 'caldav_reminder_selection', 'task_assignments',
    'tasks', 'ics_subscriptions', 'caldav_accounts', 'calendar_pending_deletions', 'housekeeping_workers', 'users']) {
    if (tableExists(t)) db.prepare(`DELETE FROM ${t}`).run();
  }
  OWNER = addUser('owner');
  ANNA = addUser('anna', '#FF0000');
  BEN = addUser('ben', '#00FF00');
  CHRIS = addUser('chris', '#0000FF');
  STAFF = addUser('staff');
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(STAFF);
}

function calendar(externalId, name, people, source = 'caldav') {
  const id = Number(db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color) VALUES (?, ?, ?, '#4A90E2') RETURNING id
  `).get(source, externalId, name).id);
  da.writeDefaultAssignees(db, 'calendar', id, people);
  return id;
}

const assignmentsOf = (eventId) => db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id')
  .all(eventId).map((r) => Number(r.user_id));
const primaryOf = (eventId) => db.prepare('SELECT assigned_to FROM calendar_events WHERE id = ?').get(eventId)?.assigned_to ?? null;
const sorted = (ids) => [...ids].sort((a, b) => a - b);

const VEVENT = (uid) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  `UID:${uid}`, 'SUMMARY:Zahnarzt',
  'DTSTART:20260401T090000Z', 'DTEND:20260401T100000Z',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const caldavClient = (calendarUrl) => async () => ({
  fetchCalendars: async () => [
    { url: CAL_TOGETHER, displayName: 'Zusammen', components: ['VEVENT'] },
    { url: CAL_BEN, displayName: 'Ben', components: ['VEVENT'] },
  ],
  fetchCalendarObjects: async ({ calendar: cal }) =>
    (cal.url === calendarUrl ? [{ data: VEVENT(UID), url: `${calendarUrl}${UID}.ics` }] : []),
  createCalendarObject: async () => ({}),
});

function seedCaldavAccount() {
  const accountId = Number(db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('OX', 'https://dav.example/', 'u', 'p') RETURNING id`).get().id);
  for (const [url, name] of [[CAL_TOGETHER, 'Zusammen'], [CAL_BEN, 'Ben']]) {
    db.prepare(`INSERT INTO caldav_calendar_selection
      (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, '#4A90E2', 1)`).run(accountId, url, name);
  }
  return accountId;
}

const eventRow = () => db.prepare('SELECT id, calendar_ref_id FROM calendar_events WHERE external_calendar_id = ?').get(UID);

// ---------------------------------------------------------------------------
describe('Migration 265', () => {
  const V265 = MIGRATIONS.find((m) => m.version === 265);

  it('carries the single default of a calendar and a subscription, and drops an orphan', () => {
    assert.ok(V265, 'migration 265 exists');
    const pre = new Database(':memory:');
    pre.pragma('foreign_keys = ON');
    pre.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
      CREATE TABLE external_calendars (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, external_id TEXT,
        name TEXT, default_assignee_user_id INTEGER);
      CREATE TABLE ics_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, default_assignee_user_id INTEGER);
      CREATE TABLE caldav_reminder_selection (id INTEGER PRIMARY KEY AUTOINCREMENT, list_url TEXT);
      INSERT INTO users (username) VALUES ('anna'), ('ben');
      INSERT INTO external_calendars (source, external_id, name, default_assignee_user_id)
        VALUES ('google', 'a', 'A', 1), ('google', 'b', 'B', NULL), ('caldav', 'c', 'C', 99);
      INSERT INTO ics_subscriptions (name, default_assignee_user_id) VALUES ('S', 2), ('T', NULL);
    `);
    pre.exec(V265.up);
    assert.deepEqual(pre.prepare('SELECT calendar_id, user_id, position FROM external_calendar_assignees').all(),
      [{ calendar_id: 1, user_id: 1, position: 0 }]);
    assert.deepEqual(pre.prepare('SELECT subscription_id, user_id FROM ics_subscription_assignees').all(),
      [{ subscription_id: 1, user_id: 2 }]);
    assert.deepEqual(pre.pragma('foreign_key_check'), []);
    pre.close();
  });
});

// ---------------------------------------------------------------------------
describe('Kalender mit mehreren Standard-Personen (#1897)', () => {
  beforeEach(resetTables);

  it('a new event from a calendar gets every default person, the first one primary', async () => {
    seedCaldavAccount();
    calendar(CAL_TOGETHER, 'Zusammen', [BEN, ANNA]);
    await caldavSync({ createClient: caldavClient(CAL_TOGETHER) });
    const ev = eventRow();
    assert.ok(ev, 'imported');
    assert.deepEqual(assignmentsOf(ev.id), sorted([ANNA, BEN]));
    assert.equal(primaryOf(ev.id), BEN, 'the first chosen person is the primary assignee');
  });

  it('a move from "Together" to a one-person calendar follows the set, and back', async () => {
    seedCaldavAccount();
    const together = calendar(CAL_TOGETHER, 'Zusammen', [ANNA, BEN]);
    const ben = calendar(CAL_BEN, 'Ben', [BEN]);
    await caldavSync({ createClient: caldavClient(CAL_TOGETHER) });
    assert.equal(eventRow().calendar_ref_id, together);
    await caldavSync({ createClient: caldavClient(CAL_BEN) });
    assert.equal(eventRow().calendar_ref_id, ben);
    assert.deepEqual(assignmentsOf(eventRow().id), [BEN]);
    assert.equal(primaryOf(eventRow().id), BEN);
    await caldavSync({ createClient: caldavClient(CAL_TOGETHER) });
    assert.deepEqual(assignmentsOf(eventRow().id), sorted([ANNA, BEN]), 'back in "Together": both again');
  });

  it('a move leaves an assignment alone that is not exactly the old set', () => {
    const together = calendar(CAL_TOGETHER, 'Zusammen', [ANNA, BEN]);
    const ben = calendar(CAL_BEN, 'Ben', [BEN]);
    const id = Number(db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, external_source,
      external_calendar_id, calendar_ref_id) VALUES ('x', '2026-04-01T09:00', ?, 'caldav', 'u1', ?) RETURNING id`).get(OWNER, together).id);
    sa.assignDefaultToEvent(db, id, [ANNA, BEN, CHRIS]);
    assert.equal(sa.reassignDefaultOnCalendarMove(db, id, { fromCalRefId: together, toCalRefId: ben, toDefaultUserIds: [BEN] }), false);
    assert.deepEqual(assignmentsOf(id), sorted([ANNA, BEN, CHRIS]));
  });

  it('the backfill fills an unassigned event with the whole set', async () => {
    const together = calendar(CAL_TOGETHER, 'Zusammen', [ANNA, BEN]);
    const id = Number(db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, external_source,
      external_calendar_id, calendar_ref_id) VALUES ('x', '2026-04-01T09:00', ?, 'caldav', 'u2', ?) RETURNING id`).get(OWNER, together).id);
    const candidates = sa.listBackfillCandidates(db);
    assert.deepEqual(candidates, [{ eventId: id, userIds: [ANNA, BEN] }]);
    assert.equal(await sa.applyDefaultAssigneesToExisting(db, candidates), 1);
    assert.deepEqual(assignmentsOf(id), sorted([ANNA, BEN]));
    assert.equal(primaryOf(id), ANNA);
  });

  it('the list of earlier moves names both sets, and a ticked move applies the new set', async () => {
    seedCaldavAccount();
    calendar(CAL_TOGETHER, 'Zusammen', [ANNA, BEN]);
    const ben = calendar(CAL_BEN, 'Ben', [BEN]);
    // Ein Termin in "Ben", der noch die Menge von "Zusammen" traegt (vor #1306 umgezogen).
    const id = Number(db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, external_source,
      external_calendar_id, calendar_ref_id) VALUES ('x', '2026-04-01T09:00', ?, 'caldav', 'u3', ?) RETURNING id`).get(OWNER, ben).id);
    sa.assignDefaultToEvent(db, id, [ANNA, BEN]);
    const moved = sa.listMovedCandidates(db, { viewerId: OWNER, limit: 10 });
    assert.equal(moved.length, 1);
    assert.deepEqual(sorted(moved[0].fromUserIds), sorted([ANNA, BEN]));
    assert.deepEqual(moved[0].userIds, [BEN]);
    assert.deepEqual(moved[0].toNames, ['Ben']);
    const moves = [{ eventId: id, fromUserIds: [ANNA, BEN], userIds: [BEN] }];
    assert.equal(await sa.movesStillOffered(db, moves, { viewerId: OWNER }), true);
    assert.equal(await sa.applyDefaultAssigneesToExisting(db, moves, { viewerId: OWNER }), 1);
    assert.deepEqual(assignmentsOf(id), [BEN]);
  });
});

// ---------------------------------------------------------------------------
describe('Erinnerungslisten (#1221)', () => {
  beforeEach(resetTables);

  function list(targetModule = 'tasks') {
    const accountId = Number(db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('R', 'https://dav.example/', 'u', 'p') RETURNING id`).get().id);
    const selId = Number(db.prepare(`INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
      VALUES (?, 'https://dav.example/list/', 'Liste', ?, 1) RETURNING id`).get(accountId, targetModule).id);
    return { accountId, selId };
  }
  const taskAssignees = (taskId) => db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(taskId).map((r) => Number(r.user_id));

  it('a new task from a list gets its default people; a known one keeps its assignment', () => {
    const { accountId, selId } = list();
    reminders.updateReminderSelection(accountId, 'https://dav.example/list/', { defaultAssigneeUserIds: [BEN, ANNA] });
    assert.deepEqual(da.readDefaultAssignees(db, 'reminderList', selId), [BEN, ANNA]);
    const todo = { uid: 'todo-1', summary: 'Muell', description: null, tags: [] };
    const taskId = Number(reminders.upsertTask(todo, accountId, OWNER, null, { defaultAssignees: [BEN, ANNA] }));
    assert.deepEqual(taskAssignees(taskId), sorted([ANNA, BEN]));
    assert.equal(db.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(taskId).assigned_to, BEN);
    // Von Hand geleert: der naechste Lauf setzt nichts zurueck.
    db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
    db.prepare('UPDATE tasks SET assigned_to = NULL WHERE id = ?').run(taskId);
    reminders.upsertTask(todo, accountId, OWNER, null, { defaultAssignees: [BEN, ANNA] });
    assert.deepEqual(taskAssignees(taskId), []);
  });

  it('a list mapped to Shopping takes no default people', () => {
    const { accountId } = list('shopping');
    assert.throws(() => reminders.updateReminderSelection(accountId, 'https://dav.example/list/', { defaultAssigneeUserIds: [ANNA] }),
      reminders.ReminderListAssigneeError);
  });

  it('the stored lists name their default people', async () => {
    const { accountId } = list();
    db.prepare("UPDATE caldav_accounts SET reminders_discovered_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(accountId);
    reminders.updateReminderSelection(accountId, 'https://dav.example/list/', { defaultAssigneeUserIds: [ANNA] });
    const lists = await reminders.getReminderLists(accountId);
    assert.deepEqual(lists[0].defaultAssigneeUserIds, [ANNA]);
  });
});

// ---------------------------------------------------------------------------
describe('Import mit Personen (#1940)', () => {
  beforeEach(resetTables);

  const feed = (...uids) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    ...uids.flatMap((uid) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${uid}`,
      'DTSTART:20260501T090000Z', 'DTEND:20260501T100000Z', 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
  const byUid = (uid) => db.prepare('SELECT id FROM calendar_events WHERE external_calendar_id = ? ORDER BY id').all(uid);

  it('every new event of the run gets the chosen people', async () => {
    const r = await ics.importToLocal(OWNER, { ics: feed('a', 'b'), assigneeIds: [ANNA, BEN] });
    assert.deepEqual([r.imported, r.skipped, r.assigned], [2, 0, 0]);
    for (const uid of ['a', 'b']) {
      const [{ id }] = byUid(uid);
      assert.deepEqual(assignmentsOf(id), sorted([ANNA, BEN]));
      assert.equal(primaryOf(id), ANNA);
    }
  });

  it('a shared event of a second run gets the second person added, once', async () => {
    await ics.importToLocal(OWNER, { ics: feed('dentist', 'anna-only'), assigneeIds: [ANNA] });
    const r = await ics.importToLocal(OWNER, { ics: feed('dentist', 'ben-only'), assigneeIds: [BEN] });
    assert.deepEqual([r.imported, r.skipped, r.assigned], [1, 1, 1]);
    assert.equal(byUid('dentist').length, 1, 'the shared event exists once');
    assert.deepEqual(assignmentsOf(byUid('dentist')[0].id), sorted([ANNA, BEN]));
    assert.equal(primaryOf(byUid('dentist')[0].id), ANNA, 'the primary stays');
    assert.deepEqual(assignmentsOf(byUid('ben-only')[0].id), [BEN]);
    // Dieselbe Person noch einmal: nichts kommt dazu, alles uebersprungen.
    const again = await ics.importToLocal(OWNER, { ics: feed('dentist'), assigneeIds: [BEN] });
    assert.deepEqual([again.imported, again.skipped, again.assigned], [0, 1, 0]);
  });

  it('a re-import with a person assigns what an earlier run without one brought in', async () => {
    const first = await ics.importToLocal(OWNER, { ics: feed('a', 'b') });
    assert.deepEqual([first.imported, first.skipped, first.assigned], [2, 0, 0]);
    assert.deepEqual(assignmentsOf(byUid('a')[0].id), []);
    const r = await ics.importToLocal(OWNER, { ics: feed('a', 'b'), assigneeIds: [CHRIS] });
    assert.deepEqual([r.imported, r.skipped, r.assigned], [0, 2, 2]);
    assert.deepEqual(assignmentsOf(byUid('a')[0].id), [CHRIS]);
    assert.equal(primaryOf(byUid('a')[0].id), CHRIS);
  });

  it('with a person, an event already imported into another calendar is found there', async () => {
    const other = Number(db.prepare(`INSERT INTO local_calendars (name, color, sort_order) VALUES ('Zweit', '#111111', 99) RETURNING id`).get().id);
    await ics.importToLocal(OWNER, { ics: feed('x'), assigneeIds: [ANNA] });
    const r = await ics.importToLocal(OWNER, { ics: feed('x'), assigneeIds: [BEN], localCalendarId: other });
    assert.deepEqual([r.imported, r.assigned], [0, 1]);
    assert.equal(byUid('x').length, 1);
  });

  it('a synced event with the same UID is no earlier import and stays untouched (review)', async () => {
    const cal = calendar(CAL_TOGETHER, 'Zusammen', []);
    const mirrored = Number(db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by, external_source,
      external_calendar_id, calendar_ref_id) VALUES ('m', '2026-05-01T09:00', ?, 'caldav', 'shared-uid', ?) RETURNING id`).get(OWNER, cal).id);
    const r = await ics.importToLocal(OWNER, { ics: feed('shared-uid'), assigneeIds: [ANNA] });
    assert.deepEqual([r.imported, r.assigned], [1, 0], 'imported as a local event of its own');
    assert.deepEqual(assignmentsOf(mirrored), [], 'the mirrored event keeps its assignment');
  });

  it('without a person, the run is what it was: the same rows and numbers', async () => {
    await ics.importToLocal(OWNER, { ics: feed('a') });
    const r = await ics.importToLocal(OWNER, { ics: feed('a', 'b') });
    assert.deepEqual([r.imported, r.skipped, r.assigned], [1, 1, 0]);
    assert.deepEqual(assignmentsOf(byUid('b')[0].id), []);
  });

  it("the importer's future reminder on an existing event reaches the added person", async () => {
    await ics.importToLocal(OWNER, { ics: feed('r'), assigneeIds: [ANNA] });
    const id = byUid('r')[0].id;
    db.prepare(`UPDATE calendar_events SET start_datetime = '2099-05-01T09:00:00Z', end_datetime = '2099-05-01T10:00:00Z' WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('event', ?, '2099-05-01T08:00:00Z', ?)`)
      .run(id, OWNER);
    await ics.importToLocal(OWNER, { ics: feed('r'), assigneeIds: [BEN] });
    const forBen = db.prepare(`SELECT 1 FROM reminders WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?`).get(id, BEN);
    assert.ok(forBen, 'Ben inherits the reminder');
  });
});

// ---------------------------------------------------------------------------
describe('Routen', () => {
  let actor;
  let baseUrl;
  let server;

  beforeEach(async () => {
    resetTables();
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OWNER);
    actor = { id: OWNER, role: 'admin' };
    if (!server) {
      const app = express();
      app.use((req, _res, next) => {
        req.authUserId = actor.id; req.authRole = actor.role;
        req.session = { userId: actor.id, role: actor.role };
        next();
      });
      app.use(express.json());
      app.use('/', calendarRouter);
      server = app.listen(0, '127.0.0.1');
      baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
    }
  });

  async function call(method, route, body) {
    const res = await fetch(`${baseUrl}${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leer */ }
    return { status: res.status, body: json };
  }

  it('PATCH /external-calendars takes a list and the single old form', async () => {
    calendar('cal-1', 'Eins', [], 'google');
    const res = await call('PATCH', '/external-calendars', { source: 'google', external_id: 'cal-1', default_assignee_user_ids: [BEN, ANNA] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.default_assignee_user_ids, [BEN, ANNA]);
    assert.equal(res.body.data.default_assignee_user_id, BEN);
    const single = await call('PATCH', '/external-calendars', { source: 'google', external_id: 'cal-1', default_assignee_user_id: CHRIS });
    assert.deepEqual(single.body.data.default_assignee_user_ids, [CHRIS]);
    const cleared = await call('PATCH', '/external-calendars', { source: 'google', external_id: 'cal-1', default_assignee_user_ids: [] });
    assert.deepEqual(cleared.body.data.default_assignee_user_ids, []);
    assert.equal(cleared.body.data.default_assignee_user_id, null);
  });

  it('PATCH /external-calendars refuses a non-member, an unknown id and a non-number with a reason', async () => {
    calendar('cal-1', 'Eins', [], 'google');
    for (const [ids, reason] of [[[ANNA, STAFF], 'calendar_assignee_not_member'], [[987654], 'calendar_assignee_unknown'], [['abc'], 'calendar_assignee_invalid']]) {
      const res = await call('PATCH', '/external-calendars', { source: 'google', external_id: 'cal-1', default_assignee_user_ids: ids });
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, reason);
    }
    assert.deepEqual(da.readDefaultAssignees(db, 'calendar', 1), [], 'nothing written');
  });

  it('POST /import assigns the chosen people and refuses a non-member before writing', async () => {
    const icsText = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:route-1', 'SUMMARY:R',
      'DTSTART:20260601T090000Z', 'DTEND:20260601T100000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    for (const [body, reason] of [[{ assignee_user_ids: [STAFF] }, 'calendar_assignee_not_member'],
      [{ assignee_user_id: 987654 }, 'calendar_assignee_unknown'], [{ assignee_user_ids: ['x'] }, 'calendar_assignee_invalid']]) {
      const refused = await call('POST', '/import', { ics: icsText, ...body });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.reason, reason);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM calendar_events WHERE external_calendar_id = 'route-1'").get().c, 0);
    const ok = await call('POST', '/import', { ics: icsText, assignee_user_ids: [ANNA, BEN] });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.imported, 1);
    assert.equal(ok.body.data.assigned, 0);
    const id = db.prepare("SELECT id FROM calendar_events WHERE external_calendar_id = 'route-1'").get().id;
    assert.deepEqual(assignmentsOf(id), sorted([ANNA, BEN]));
  });

  it('subscriptions: PATCH stores a list and GET returns it', async () => {
    const subId = Number(db.prepare(`INSERT INTO ics_subscriptions (name, url, color, created_by, shared)
      VALUES ('S', 'https://x/s.ics', '#FF0000', ?, 1) RETURNING id`).get(OWNER).id);
    const res = await call('PATCH', `/subscriptions/${subId}`, { default_assignee_user_ids: [ANNA, BEN] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.default_assignee_user_ids, [ANNA, BEN]);
    const list = await call('GET', '/subscriptions');
    const sub = list.body.data.find((s) => s.id === subId);
    assert.deepEqual(sub.default_assignee_user_ids, [ANNA, BEN]);
    assert.equal(sub.default_assignee_user_id, ANNA);
  });

  it('reminder lists: PATCH sets the default people, and a Shopping list says why it cannot', async () => {
    const accountId = Number(db.prepare(`INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('R', 'https://dav.example/', 'u', 'p') RETURNING id`).get().id);
    db.prepare(`INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module, enabled)
      VALUES (?, 'https://dav.example/t/', 'T', 'tasks', 1), (?, 'https://dav.example/s/', 'S', 'shopping', 1)`).run(accountId, accountId);
    const ok = await call('PATCH', `/caldav/accounts/${accountId}/reminder-lists`, { listUrl: 'https://dav.example/t/', defaultAssigneeUserIds: [ANNA] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const shop = await call('PATCH', `/caldav/accounts/${accountId}/reminder-lists`, { listUrl: 'https://dav.example/s/', defaultAssigneeUserIds: [ANNA] });
    assert.equal(shop.status, 400);
    assert.equal(shop.body.reason, 'reminder_list_assignee_not_tasks');
    const stranger = await call('PATCH', `/caldav/accounts/${accountId}/reminder-lists`, { listUrl: 'https://dav.example/t/', defaultAssigneeUserIds: [STAFF] });
    assert.equal(stranger.status, 400);
  });

  it('closes the server', () => { server.close(); });
});

// ---------------------------------------------------------------------------
describe('Konto entfernen', () => {
  beforeEach(resetTables);

  it('a removed account leaves every set', () => {
    const cal = calendar(CAL_TOGETHER, 'Zusammen', [ANNA, BEN]);
    const subId = Number(db.prepare(`INSERT INTO ics_subscriptions (name, url, color, created_by, shared)
      VALUES ('S', 'https://x/s.ics', '#FF0000', ?, 1) RETURNING id`).get(OWNER).id);
    da.writeDefaultAssignees(db, 'subscription', subId, [ANNA]);
    removeUser(db, ANNA);
    assert.deepEqual(da.readDefaultAssignees(db, 'calendar', cal), [BEN]);
    assert.deepEqual(da.readDefaultAssignees(db, 'subscription', subId), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM external_calendar_assignees WHERE user_id = ?').get(ANNA).c, 0);
  });
});
