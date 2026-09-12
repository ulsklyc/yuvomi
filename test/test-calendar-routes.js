/**
 * Test: Kalender-Routen-Schicht (Härtung)
 * Zweck: End-to-End über den echten Router (server/routes/calendar.js) - zuvor nur
 *        ~50% Zeilen / 37% fn abgedeckt, weil die bestehenden calendar-Tests
 *        (test-calendar.js u. a.) die Handler NICHT über HTTP aufrufen, sondern
 *        public-Helfer + SQL direkt prüfen. Diese Suite mountet den Router in einer
 *        echten express-App und ruft ihn per fetch mit injiziertem actor auf.
 *
 *        Substanz (alles netz-frei - Sync-Provider werden NUR über ihre
 *        requireAdmin-Gates + configured:false-Status berührt, nie über echtes Netz):
 *          - GET /            Datumsbereich, assigned_to/source-Filter, Sichtbarkeit
 *                             (#474, KEIN Admin-Bypass), Serien-Expansion, 400
 *          - GET /upcoming    Sortierung + serialisierte Form
 *          - GET /search      FTS-Treffer (Trigger-befüllt), leere Query, Sichtbarkeit,
 *                             wiederkehrender Treffer -> nächste Instanz
 *          - Status-Routen    google/apple/caldav/reminders getStatus ohne Config
 *          - requireAdmin     403 für Nicht-Admin auf allen Sync-Routen
 *          - Admin-Handler     netz-frei: external-calendars-Zuweisung (#459),
 *                             google/readonly, google/disconnect, apple/disconnect,
 *                             caldav/accounts-Liste + Validierungs-400s
 *          - subscriptions    Liste, POST-Validierung, PATCH/DELETE (404/403/Happy)
 *          - POST /import     ICS-String -> echte lokale Termine (401/400/201)
 *          - feed             getFeedToken/regenerate/setShowAssignees/clear
 *          - holidays         400-Validierung + leerer Bereich
 *          - GET /:id         404, Sichtbarkeit (privat -> auch Admin 404)
 *          - POST /           Validierung, Anhang->Dokument, Zuweisungen, Serie,
 *                             Sichtbarkeit, CalDAV/Google-Ziel
 *          - PUT /:id         partielle Updates, Anhang ersetzen/entfernen, COALESCE
 *                             der Sync-Ziele, user_modified bei externem Event
 *          - reset/exceptions ICS-Reset-Gate, EXDATE-Einzellöschung (#489) inkl.
 *                             Extern-Sperre + identischer Sichtbarkeit wie Serien
 *          - DELETE /:id      404 + 204
 *
 *        Systemuhr: GET / immer mit explizitem Fenster (2035); /upcoming per
 *        Zukunftsdaten (2098/2099) + relativer Ordnung; keine Kopplung an "heute".
 *        Geteilte :memory:-DB (pro Testdatei ein Prozess): Aggregat-Routen nutzen
 *        eindeutige Titel-/Suchmarker + Enthaltensein statt Gesamtzahl.
 * Ausführen: node --experimental-sqlite --test test/test-calendar-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const {
  calendarOccurrenceDeleteTarget,
  calendarOccurrenceMutationTarget,
} = await import('../public/utils/recurrence-scope.js');
const db = dbmod.get();

// ── Nutzer anlegen (IDs deterministisch ab 1: eigener Prozess je Testdatei) ──────
const ADMIN = { id: 1, role: 'admin' };
const MARIA = { id: 2, role: 'member' };
const TOM   = { id: 3, role: 'member' };
const ANON  = { id: null, role: 'member' };
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role, avatar_color) VALUES ('maria','Maria','x','member','#34C759')").run();
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('tom','Tom','x','member')").run();

// ── App mit injizierter Auth (actor zur Request-Zeit gelesen) ────────────────────
let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/', calendarRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

test.after(() => server.close());

async function call(method, route, { actor: a = ADMIN, body } = {}) {
  actor = a;
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* leer */ } }
  return { status: res.status, body: json };
}

let seq = 0;
function insertEvent(fields = {}) {
  const f = {
    title: `EV-${++seq}`, description: null,
    start_datetime: '2035-03-10T09:00', end_datetime: null,
    created_by: 1, color: '#007AFF', icon: 'calendar', visibility: 'all',
    external_source: 'local', all_day: 0, recurrence_rule: null,
    subscription_id: null, calendar_ref_id: null, user_modified: 0,
    assigned_to: null, countdown: 0,
    attachment_name: null, attachment_mime: null, attachment_size: null,
    attachment_data: null, recurrence_parent_id: null, recurrence_id: null,
    overridden_fields: null,
    ...fields,
  };
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, description, start_datetime, end_datetime, created_by, color, icon, visibility,
       external_source, all_day, recurrence_rule, subscription_id, calendar_ref_id, user_modified,
       assigned_to, countdown, attachment_name, attachment_mime, attachment_size,
       attachment_data, recurrence_parent_id, recurrence_id, overridden_fields)
    VALUES (@title,@description,@start_datetime,@end_datetime,@created_by,@color,@icon,@visibility,
       @external_source,@all_day,@recurrence_rule,@subscription_id,@calendar_ref_id,@user_modified,
       @assigned_to,@countdown,@attachment_name,@attachment_mime,@attachment_size,
       @attachment_data,@recurrence_parent_id,@recurrence_id,@overridden_fields)
  `).run(f);
  return r.lastInsertRowid;
}
function assignEvent(eventId, userId) {
  db.prepare('INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(eventId, userId);
}
const titles = (rows) => rows.map((e) => e.title);

// ════════════════════════════════════════════════════════════════════════════════
// GET / — Datumsbereich, Filter, Sichtbarkeit, Serien
// ════════════════════════════════════════════════════════════════════════════════

test('GET / — 400 bei ungültigem from/to', async () => {
  const res = await call('GET', '/?from=2035-3-1&to=xxxx');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /YYYY-MM-DD/);
});

test('GET / — liefert Termine im Fenster (all-sichtbar)', async () => {
  insertEvent({ title: 'LIST-A', start_datetime: '2035-03-10T09:00' });
  insertEvent({ title: 'LIST-B', start_datetime: '2035-03-15T09:00' });
  const res = await call('GET', '/?from=2035-03-01&to=2035-03-31', { actor: MARIA });
  assert.equal(res.status, 200);
  assert.equal(res.body.from, '2035-03-01');
  const t = titles(res.body.data);
  assert.ok(t.includes('LIST-A') && t.includes('LIST-B'), 'beide all-Termine sichtbar');
});

test('GET / — private Termine anderer sind unsichtbar (#474, kein Admin-Bypass)', async () => {
  insertEvent({ title: 'PRIV-TOM', start_datetime: '2035-03-12T09:00', created_by: TOM.id, visibility: 'private' });
  const asMaria = await call('GET', '/?from=2035-03-01&to=2035-03-31', { actor: MARIA });
  assert.ok(!titles(asMaria.body.data).includes('PRIV-TOM'), 'Maria sieht Toms privaten Termin nicht');
  const asAdmin = await call('GET', '/?from=2035-03-01&to=2035-03-31', { actor: ADMIN });
  assert.ok(!titles(asAdmin.body.data).includes('PRIV-TOM'), 'Admin hat KEINEN Bypass');
  const asTom = await call('GET', '/?from=2035-03-01&to=2035-03-31', { actor: TOM });
  assert.ok(titles(asTom.body.data).includes('PRIV-TOM'), 'Tom sieht seinen eigenen privaten Termin');
});

test('GET / — assigned_to-Filter', async () => {
  const id = insertEvent({ title: 'ASSIGN-MARIA', start_datetime: '2035-03-18T09:00' });
  assignEvent(id, MARIA.id);
  const forMaria = await call('GET', '/?from=2035-03-01&to=2035-03-31&assigned_to=2', { actor: ADMIN });
  assert.ok(titles(forMaria.body.data).includes('ASSIGN-MARIA'));
  const forTom = await call('GET', '/?from=2035-03-01&to=2035-03-31&assigned_to=3', { actor: ADMIN });
  assert.ok(!titles(forTom.body.data).includes('ASSIGN-MARIA'), 'nicht in Toms Zuweisungen');
});

test('GET / — source-Filter grenzt auf external_source ein', async () => {
  insertEvent({ title: 'SRC-LOCAL', start_datetime: '2035-03-20T09:00', external_source: 'local' });
  const local = await call('GET', '/?from=2035-03-01&to=2035-03-31&source=local', { actor: ADMIN });
  assert.ok(titles(local.body.data).includes('SRC-LOCAL'));
  const google = await call('GET', '/?from=2035-03-01&to=2035-03-31&source=google', { actor: ADMIN });
  assert.ok(!titles(google.body.data).includes('SRC-LOCAL'), 'source=google blendet lokale aus');
});

test('GET / — wiederkehrende Serie wird in Instanzen expandiert', async () => {
  insertEvent({ title: 'SERIE-DAILY', start_datetime: '2035-03-05T09:00', recurrence_rule: 'FREQ=DAILY;COUNT=3' });
  const res = await call('GET', '/?from=2035-03-01&to=2035-03-31', { actor: ADMIN });
  const count = res.body.data.filter((e) => e.title === 'SERIE-DAILY').length;
  assert.equal(count, 3, 'COUNT=3 erzeugt genau 3 Instanzen im Fenster');
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /upcoming
// ════════════════════════════════════════════════════════════════════════════════

test('GET /upcoming — chronologisch sortiert, limit-geklemmt, serialisiert', async () => {
  insertEvent({ title: 'UPC-A', start_datetime: '2044-01-01T09:00' });
  insertEvent({ title: 'UPC-B', start_datetime: '2044-02-01T09:00' });
  // limit funktional: exakt 3 angefordert -> höchstens 3 (Akkumulation der DB
  // macht Enthaltensein-Assertions auf die 2098er unzuverlässig; stattdessen die
  // Handler-Invarianten prüfen: Klemmung, aufsteigende Sortierung, Serialisierung).
  const res = await call('GET', '/upcoming?limit=3', { actor: ADMIN });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data), 'Array');
  assert.ok(res.body.data.length <= 3, 'limit=3 klemmt');
  const starts = res.body.data.map((e) => e.start_datetime);
  const sorted = [...starts].sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(starts, sorted, 'aufsteigend nach start_datetime');
  if (res.body.data.length) {
    assert.ok(Array.isArray(res.body.data[0].assigned_users), 'serialisiert (assigned_users-Array)');
  }
  // Klemmung auf Maximum 20 auch bei überhöhtem limit.
  const capped = await call('GET', '/upcoming?limit=999', { actor: ADMIN });
  assert.ok(capped.body.data.length <= 20, 'limit-Clamp <= 20');
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /search
// ════════════════════════════════════════════════════════════════════════════════

test('GET /search — leere Query liefert leeres Resultat', async () => {
  const res = await call('GET', '/search?q=', { actor: ADMIN });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { data: [], total: 0 });
});

test('GET /search — findet Termin über FTS-Index (Trigger-befüllt)', async () => {
  insertEvent({ title: 'Zahnkontrolle Xyzzykosh', start_datetime: '2035-05-01T09:00' });
  const res = await call('GET', '/search?q=Xyzzykosh', { actor: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.data[0].title, 'Zahnkontrolle Xyzzykosh');
});

test('GET /search — respektiert Sichtbarkeit (privat fremd nicht auffindbar)', async () => {
  insertEvent({ title: 'Geheimtermin Qwobbler', start_datetime: '2035-05-02T09:00', created_by: TOM.id, visibility: 'private' });
  const asMaria = await call('GET', '/search?q=Qwobbler', { actor: MARIA });
  assert.equal(asMaria.body.total, 0, 'Maria findet Toms privaten Termin nicht');
  const asTom = await call('GET', '/search?q=Qwobbler', { actor: TOM });
  assert.equal(asTom.body.total, 1, 'Tom findet seinen eigenen');
});

test('GET /search — wiederkehrender Treffer wird auf kommende Instanz aufgelöst', async () => {
  // Serienstart in der Vergangenheit, damit die "nächste Instanz ab heute" echt vom
  // Serienstart abweicht (sonst fiele expandRecurringEvents auf den Master zurück).
  // YEARLY hält das MM-DD-Raster (15.04.) uhr-robust; nur das Jahr rückt vor.
  insertEvent({ title: 'Steuertermin Plimb', start_datetime: '2015-04-15T18:00', recurrence_rule: 'FREQ=YEARLY' });
  const res = await call('GET', '/search?q=Plimb', { actor: ADMIN });
  assert.equal(res.body.total, 1);
  const resolved = res.body.data[0].start_datetime;
  assert.match(resolved, /-04-15T18:00/, 'bleibt im jährlichen 15.-April-Raster');
  assert.notEqual(resolved.slice(0, 4), '2015', 'nicht mehr der Serienstart, sondern eine kommende Instanz');
  assert.ok(parseInt(resolved.slice(0, 4), 10) > 2015, 'aufgelöstes Jahr liegt nach dem Serienstart');
});

test('range, upcoming, calendar search and detail share linked occurrence resolution', async () => {
  const dateKey = (days) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const originalDate = dateKey(5);
  const movedDate = dateKey(8);
  const masterId = Number(insertEvent({
    title: 'Reader master title',
    description: 'Old inherited description',
    start_datetime: `${originalDate}T09:00:00`,
    end_datetime: `${originalDate}T10:00:00`,
    recurrence_rule: 'FREQ=DAILY;COUNT=4',
    assigned_to: MARIA.id,
  }));
  assignEvent(masterId, MARIA.id);
  const childId = Number(insertEvent({
    title: 'Reader override Qzxreader',
    description: 'Stale child description',
    start_datetime: `${movedDate}T11:00:00`,
    end_datetime: `${movedDate}T12:00:00`,
    assigned_to: TOM.id,
    visibility: 'assignees',
    countdown: 1,
    attachment_name: 'occurrence.txt',
    attachment_mime: 'text/plain',
    attachment_size: 4,
    attachment_data: Buffer.from('move').toString('base64'),
    recurrence_parent_id: masterId,
    recurrence_id: originalDate,
    overridden_fields: '["title","start_datetime","end_datetime","assignments","visibility","countdown","attachment","reminders"]',
  }));
  assignEvent(childId, TOM.id);
  db.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, ?)
  `).run(masterId, originalDate);
  db.prepare('UPDATE calendar_events SET description = ? WHERE id = ?')
    .run('Current inherited description', masterId);

  const assertResolved = (event, source) => {
    assert.ok(event, `${source}: moved child missing`);
    assert.equal(event.id, childId, `${source}: concrete child identity`);
    assert.equal(event.title, 'Reader override Qzxreader', `${source}: overridden title`);
    assert.equal(event.description, 'Current inherited description', `${source}: inherited description`);
    assert.equal(event.start_datetime, `${movedDate}T11:00:00`, `${source}: moved start`);
    assert.equal(event.series_id, masterId, `${source}: series identity`);
    assert.equal(event.recurrence_id, originalDate, `${source}: original slot identity`);
    assert.equal(event.is_occurrence_override, true, `${source}: override marker`);
    assert.equal(event.assignment_owner_id, childId, `${source}: assignment owner`);
    assert.equal(event.attachment_owner_id, childId, `${source}: attachment owner`);
    assert.equal(event.reminder_owner_id, childId, `${source}: reminder owner`);
    assert.equal(event.reminder_anchor_start, `${movedDate}T11:00:00`, `${source}: reminder anchor`);
    assert.deepEqual(event.assigned_users.map((user) => Number(user.id)), [TOM.id], `${source}: assignment projection`);
    assert.equal(event.attachment_data, 'data:text/plain;base64,bW92ZQ==', `${source}: attachment projection`);
  };

  const range = await call('GET', `/?from=${originalDate}&to=${movedDate}`, { actor: TOM });
  assert.equal(range.status, 200);
  const rangeChild = range.body.data.find((event) => event.id === childId);
  assertResolved(rangeChild, 'range');
  assert.equal(rangeChild.creator_name, 'Admin', 'range: creator projection');
  assert.equal(range.body.data.some((event) => event.id === masterId
    && event.recurrence_id === originalDate), false, 'range: original EXDATE slot stays suppressed');

  const upcoming = await call('GET', '/upcoming?limit=20', { actor: TOM });
  assert.equal(upcoming.status, 200);
  assertResolved(upcoming.body.data.find((event) => event.id === childId), 'upcoming');

  const search = await call('GET', '/search?q=Qzxreader', { actor: TOM });
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 1);
  assertResolved(search.body.data[0], 'calendar search');
  assert.equal(search.body.data[0].creator_name, 'Admin', 'calendar search: creator projection');

  const detail = await call('GET', `/${childId}`, { actor: TOM });
  assert.equal(detail.status, 200);
  assertResolved(detail.body.data, 'detail');
  assert.equal(detail.body.data.creator_name, 'Admin', 'detail: creator projection');
});

// ════════════════════════════════════════════════════════════════════════════════
// Status-Routen (netz-frei, ohne Config)
// ════════════════════════════════════════════════════════════════════════════════

test('GET /google/status — configured:false ohne Config', async () => {
  const res = await call('GET', '/google/status', { actor: MARIA });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
  assert.equal(res.body.connected, false);
});

test('GET /apple/status — configured:false ohne Config', async () => {
  const res = await call('GET', '/apple/status', { actor: MARIA });
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
});

test('GET /caldav/status + /caldav/reminders/status — leere Konten', async () => {
  const s = await call('GET', '/caldav/status', { actor: MARIA });
  assert.equal(s.status, 200);
  assert.equal(s.body.data.totalAccounts, 0);
  const r = await call('GET', '/caldav/reminders/status', { actor: MARIA });
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
});

// ════════════════════════════════════════════════════════════════════════════════
// requireAdmin-Gates — Nicht-Admin 403 auf allen Sync-Routen
// ════════════════════════════════════════════════════════════════════════════════

test('Sync-Routen: Nicht-Admin erhält 403 (requireAdmin-Gate)', async () => {
  const guarded = [
    ['POST', '/google/sync'], ['GET', '/google/calendars'], ['PATCH', '/google/calendars'],
    ['PUT', '/google/readonly'], ['PATCH', '/external-calendars'], ['DELETE', '/google/disconnect'],
    ['POST', '/apple/sync'], ['POST', '/apple/connect'], ['DELETE', '/apple/disconnect'],
    ['POST', '/caldav/accounts'], ['GET', '/caldav/accounts'], ['PUT', '/caldav/accounts/1'],
    ['DELETE', '/caldav/accounts/1'], ['GET', '/caldav/accounts/1/calendars'],
    ['PATCH', '/caldav/accounts/1/calendars'], ['POST', '/caldav/sync'],
    ['GET', '/caldav/accounts/1/reminder-lists'], ['PATCH', '/caldav/accounts/1/reminder-lists'],
    ['POST', '/caldav/reminders/sync'],
  ];
  for (const [method, route] of guarded) {
    // Kein Body: requireAdmin greift vor dem Body-Parsing, und fetch verbietet
    // einen Body bei GET.
    const res = await call(method, route, { actor: MARIA });
    assert.equal(res.status, 403, `${method} ${route} -> 403 für Nicht-Admin`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// Admin-Handler, netz-frei
// ════════════════════════════════════════════════════════════════════════════════

test('PATCH /external-calendars — Validierung + 404 (nicht synchronisiert)', async () => {
  assert.equal((await call('PATCH', '/external-calendars', { body: { source: 'x', external_id: 'a' } })).status, 400);
  assert.equal((await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: '' } })).status, 400);
  assert.equal((await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: 'c1', default_assignee_user_id: 'abc' } })).status, 400);
  assert.equal((await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: 'c1', default_assignee_user_id: 999 } })).status, 400);
  const notSynced = await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: 'never-synced', default_assignee_user_id: 2 } });
  assert.equal(notSynced.status, 404);
});

test('PATCH /external-calendars — setzt Standard-Zuweisung (#459)', async () => {
  db.prepare("INSERT INTO external_calendars (source, external_id, name) VALUES ('google','cal-xyz','My Cal')").run();
  const res = await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: 'cal-xyz', default_assignee_user_id: 2 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.default_assignee_user_id, 2);
  const row = db.prepare("SELECT default_assignee_user_id AS a FROM external_calendars WHERE source='google' AND external_id='cal-xyz'").get();
  assert.equal(row.a, 2);
  // null wieder entfernen
  const cleared = await call('PATCH', '/external-calendars', { body: { source: 'google', external_id: 'cal-xyz', default_assignee_user_id: null } });
  assert.equal(cleared.body.data.default_assignee_user_id, null);
});

// ────────────────────────────────────────────────────────────────────────────
// #730: Die Zuweisung war genau so lange nicht setzbar, wie sie etwas bewirkt
// hätte. Der Picker erschien erst, wenn die external_calendars-Zeile existierte
// - und die entstand beim ersten Sync, also nachdem der erste Schwung Termine
// bereits ohne Zuweisung hereingekommen war.
// ────────────────────────────────────────────────────────────────────────────

test('PATCH /external-calendars — legt die Zeile für einen bekannten, noch nicht synchronisierten Kalender an (#730)', async () => {
  // So weit ist der Nutzer, wenn er den Haken setzt: Der Kalender steht in der
  // Auswahlliste seines Kontos, synchronisiert wurde er noch nicht.
  db.prepare(`
    INSERT INTO caldav_accounts (name, caldav_url, username, password)
    VALUES ('Mailbox', 'https://dav.example/', 'u', 'p')
  `).run();
  db.prepare(`
    INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
    VALUES ((SELECT id FROM caldav_accounts WHERE name = 'Mailbox'), 'https://dav.example/privat/', 'Privat', '#4A90E2', 1)
  `).run();

  try {
    const res = await call('PATCH', '/external-calendars', {
      body: { source: 'caldav', external_id: 'https://dav.example/privat/', default_assignee_user_id: 2 },
    });
    assert.equal(res.status, 200, 'vorher antwortete der Server hier mit 404');

    const row = db.prepare(
      "SELECT name, default_assignee_user_id AS a FROM external_calendars WHERE source='caldav' AND external_id='https://dav.example/privat/'"
    ).get();
    assert.equal(row.a, 2);
    assert.equal(row.name, 'Privat', 'der Name kommt aus der Auswahlliste, nicht aus dem Request');
  } finally {
    // Die Datenbank wird über die ganze Datei geteilt, und ein Nachbartest
    // erwartet die Kontenliste leer. Aufräumen statt Reihenfolge annehmen.
    db.prepare("DELETE FROM external_calendars WHERE external_id = 'https://dav.example/privat/'").run();
    db.prepare("DELETE FROM caldav_calendar_selection WHERE calendar_url = 'https://dav.example/privat/'").run();
    db.prepare("DELETE FROM caldav_accounts WHERE name = 'Mailbox'").run();
  }
});

test('PATCH /external-calendars — ein unbekannter Kalender bleibt 404 (#730)', async () => {
  // Die Schranke zum Test darüber: Die Zeile entsteht nur für einen Kalender,
  // den ein verbundenes Konto tatsächlich anbietet. Sonst legte jeder Aufruf
  // beliebige Zeilen an.
  const res = await call('PATCH', '/external-calendars', {
    body: { source: 'caldav', external_id: 'https://dav.example/fremd/', default_assignee_user_id: 2 },
  });
  assert.equal(res.status, 404);
});

test('PUT /google/readonly — 400 non-boolean + Happy', async () => {
  assert.equal((await call('PUT', '/google/readonly', { body: { readonly: 'yes' } })).status, 400);
  const ok = await call('PUT', '/google/readonly', { body: { readonly: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.readonly, true);
});

test('DELETE /google/disconnect + DELETE /apple/disconnect', async () => {
  assert.equal((await call('DELETE', '/google/disconnect')).status, 200);
  assert.equal((await call('DELETE', '/apple/disconnect')).status, 204);
});

test('GET /caldav/accounts — leere Liste', async () => {
  const res = await call('GET', '/caldav/accounts');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

test('POST /apple/connect — Validierungs-400s (vor Netz)', async () => {
  assert.equal((await call('POST', '/apple/connect', { body: { url: 'ftp://x', username: 'u', password: 'p' } })).status, 400);
  assert.equal((await call('POST', '/apple/connect', { body: { url: 'https://x', username: '', password: 'p' } })).status, 400);
  assert.equal((await call('POST', '/apple/connect', { body: { url: 'https://x', username: 'u', password: '' } })).status, 400);
});

test('PATCH /google/calendars — Validierungs-400s (vor Netz)', async () => {
  assert.equal((await call('PATCH', '/google/calendars', { body: { enabled: true } })).status, 400);
  assert.equal((await call('PATCH', '/google/calendars', { body: { calendarId: 'c', enabled: 'yes' } })).status, 400);
});

test('POST /caldav/accounts + PATCH-Routen — 400 bei fehlenden Feldern', async () => {
  assert.equal((await call('POST', '/caldav/accounts', { body: { name: 'x' } })).status, 400);
  assert.equal((await call('PATCH', '/caldav/accounts/1/calendars', { body: { calendarUrl: 'u' } })).status, 400);
  assert.equal((await call('PATCH', '/caldav/accounts/1/reminder-lists', { body: { listUrl: 'u' } })).status, 400);
});

// ════════════════════════════════════════════════════════════════════════════════
// ICS-Subscriptions
// ════════════════════════════════════════════════════════════════════════════════

test('GET /subscriptions — Liste (leer, dann mit Eintrag)', async () => {
  const empty = await call('GET', '/subscriptions', { actor: ADMIN });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  db.prepare("INSERT INTO ics_subscriptions (name, url, color, created_by, shared) VALUES ('Feed','https://x.test/f.ics','#FF0000',1,1)").run();
  const withOne = await call('GET', '/subscriptions', { actor: ADMIN });
  assert.equal(withOne.body.data.length, 1);
  assert.equal(withOne.body.data[0].name, 'Feed');
});

test('POST /subscriptions — Validierungs-400s (name/url/protokoll/color)', async () => {
  assert.equal((await call('POST', '/subscriptions', { body: { name: '', url: 'https://x/f.ics', color: '#FF0000' } })).status, 400);
  assert.equal((await call('POST', '/subscriptions', { body: { name: 'F', color: '#FF0000' } })).status, 400);
  const badProto = await call('POST', '/subscriptions', { body: { name: 'F', url: 'http://x/f.ics', color: '#FF0000' } });
  assert.equal(badProto.status, 400, 'http:// ohne Private-Network-Opt-in abgelehnt');
  assert.equal((await call('POST', '/subscriptions', { body: { name: 'F', url: 'https://x/f.ics', color: 'red' } })).status, 400);
});

test('POST /subscriptions — prüft die Standard-Zuweisung schon beim Anlegen (#730)', async () => {
  // Das Anlegen synchronisiert unmittelbar; wer die Zuweisung erst danach im
  // Bearbeiten-Dialog setzen kann, verpasst die erste - oft größte - Ladung.
  // Netzfrei prüfbar ist die Annahme des Feldes: Beide Fälle scheitern an der
  // Validierung, bevor irgendein Abruf beginnt.
  const badType = await call('POST', '/subscriptions', {
    body: { name: 'F', url: 'https://x/f.ics', color: '#FF0000', default_assignee_user_id: 'abc' },
  });
  assert.equal(badType.status, 400);
  const unknownUser = await call('POST', '/subscriptions', {
    body: { name: 'F', url: 'https://x/f.ics', color: '#FF0000', default_assignee_user_id: 999999 },
  });
  assert.equal(unknownUser.status, 400, 'eine unbekannte Nutzer-ID darf nicht bis zum Anlegen durchrutschen');
});

test('PATCH /subscriptions/:id — 400/404/403/Happy', async () => {
  const subId = db.prepare("INSERT INTO ics_subscriptions (name, url, color, created_by, shared) VALUES ('Owned','https://x/o.ics','#00FF00',2,0)").run().lastInsertRowid;
  assert.equal((await call('PATCH', '/subscriptions/abc')).status, 400);
  assert.equal((await call('PATCH', `/subscriptions/999999`, { body: { name: 'X' } })).status, 404);
  assert.equal((await call('PATCH', `/subscriptions/${subId}`, { body: { name: '' } })).status, 400);
  assert.equal((await call('PATCH', `/subscriptions/${subId}`, { body: { color: 'nope' } })).status, 400);
  // Maria (Owner, non-admin) darf eigenen Sub ändern
  const ok = await call('PATCH', `/subscriptions/${subId}`, { actor: MARIA, body: { name: 'Renamed', shared: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.name, 'Renamed');
  // Tom (non-admin, fremd) -> 403
  const forbidden = await call('PATCH', `/subscriptions/${subId}`, { actor: TOM, body: { name: 'Hijack' } });
  assert.equal(forbidden.status, 403);
});

test('DELETE /subscriptions/:id — 400/404/403/204', async () => {
  const subId = db.prepare("INSERT INTO ics_subscriptions (name, url, color, created_by, shared) VALUES ('ToDelete','https://x/d.ics','#0000FF',2,0)").run().lastInsertRowid;
  assert.equal((await call('DELETE', '/subscriptions/abc')).status, 400);
  assert.equal((await call('DELETE', '/subscriptions/999999')).status, 404);
  assert.equal((await call('DELETE', `/subscriptions/${subId}`, { actor: TOM })).status, 403);
  assert.equal((await call('DELETE', `/subscriptions/${subId}`, { actor: MARIA })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ics_subscriptions WHERE id=?').get(subId).n, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /import (ICS-String, netz-frei)
// ════════════════════════════════════════════════════════════════════════════════

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:import-1@test',
  'SUMMARY:Importierter Termin', 'DTSTART:20350701T090000Z', 'DTEND:20350701T100000Z',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

test('POST /import — 401 ohne authentifizierten Nutzer', async () => {
  const res = await call('POST', '/import', { actor: ANON, body: { ics: SAMPLE_ICS } });
  assert.equal(res.status, 401);
});

test('POST /import — 400 ohne ics und url', async () => {
  assert.equal((await call('POST', '/import', { actor: ADMIN, body: {} })).status, 400);
});

test('POST /import — 400 bei ungültiger Farbe', async () => {
  const res = await call('POST', '/import', { actor: ADMIN, body: { ics: SAMPLE_ICS, color: 'notacolor' } });
  assert.equal(res.status, 400);
});

test('POST /import — importiert ICS-String als echte lokale Termine', async () => {
  const res = await call('POST', '/import', { actor: ADMIN, body: { ics: SAMPLE_ICS, color: '#123456' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 1);
  const row = db.prepare("SELECT external_source, color FROM calendar_events WHERE title='Importierter Termin'").get();
  assert.equal(row.external_source, 'local', 'Import erzeugt bearbeitbare lokale Termine');
  assert.equal(row.color, '#123456');
});

// ════════════════════════════════════════════════════════════════════════════════
// Feed (ICS-Export)
// ════════════════════════════════════════════════════════════════════════════════

test('feed — Lebenszyklus getFeed/regenerate/setShowAssignees/clear', async () => {
  const none = await call('GET', '/feed', { actor: MARIA });
  assert.equal(none.status, 200);
  assert.equal(none.body.data, null, 'ohne Token null');

  const gen = await call('POST', '/feed/regenerate', { actor: MARIA });
  assert.equal(gen.status, 200);
  assert.ok(gen.body.data.token && gen.body.data.url.includes(`${gen.body.data.token}.ics`));

  const withToken = await call('GET', '/feed', { actor: MARIA });
  assert.equal(withToken.body.data.token, gen.body.data.token);

  assert.equal((await call('PUT', '/feed', { actor: MARIA, body: { showAssignees: 'nope' } })).status, 400);
  const put = await call('PUT', '/feed', { actor: MARIA, body: { showAssignees: true } });
  assert.equal(put.body.data.showAssignees, true);

  const del = await call('DELETE', '/feed', { actor: MARIA });
  assert.equal(del.body.data.token, null);
  assert.equal((await call('GET', '/feed', { actor: MARIA })).body.data, null);
});

// ════════════════════════════════════════════════════════════════════════════════
// Holidays
// ════════════════════════════════════════════════════════════════════════════════

test('GET /holidays — 400 bei fehlenden/ungültigen Params, [] im Bereich', async () => {
  assert.equal((await call('GET', '/holidays', { actor: MARIA })).status, 400);
  assert.equal((await call('GET', '/holidays?from=2030-01-01&to=badformat', { actor: MARIA })).status, 400);
  const ok = await call('GET', '/holidays?from=2030-01-01&to=2030-01-31', { actor: MARIA });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.data));
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /:id
// ════════════════════════════════════════════════════════════════════════════════

test('GET /:id — 404 für unbekannten Termin', async () => {
  assert.equal((await call('GET', '/9999999', { actor: ADMIN })).status, 404);
});

test('GET /:id — liefert Termin + serialisiert', async () => {
  const id = insertEvent({ title: 'SINGLE-GET', start_datetime: '2036-01-01T09:00' });
  const res = await call('GET', `/${id}`, { actor: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.title, 'SINGLE-GET');
  assert.ok(Array.isArray(res.body.data.assigned_users));
});

test('GET /:id — privat: fremd 404, auch Admin (kein Bypass)', async () => {
  const id = insertEvent({ title: 'PRIV-SINGLE', start_datetime: '2036-01-02T09:00', created_by: TOM.id, visibility: 'private' });
  assert.equal((await call('GET', `/${id}`, { actor: MARIA })).status, 404);
  assert.equal((await call('GET', `/${id}`, { actor: ADMIN })).status, 404);
  assert.equal((await call('GET', `/${id}`, { actor: TOM })).status, 200);
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /
// ════════════════════════════════════════════════════════════════════════════════

test('POST / — 401 ohne authentifizierten Nutzer', async () => {
  const res = await call('POST', '/', { actor: ANON, body: { title: 'X', start_datetime: '2040-01-01T09:00' } });
  assert.equal(res.status, 401);
});

test('POST / — Validierungs-400s', async () => {
  const base = { start_datetime: '2040-01-01T09:00' };
  assert.equal((await call('POST', '/', { body: { ...base, title: '' } })).status, 400);
  assert.equal((await call('POST', '/', { body: { title: 'T', start_datetime: 'not-a-date' } })).status, 400);
  assert.equal((await call('POST', '/', { body: { ...base, title: 'T', icon: 'no-such-icon' } })).status, 400);
  assert.equal((await call('POST', '/', { body: { ...base, title: 'T', color: 'red' } })).status, 400);
  // CalDAV-Ziel: account_id gesetzt, aber Kalender-URL fehlt
  assert.equal((await call('POST', '/', { body: { ...base, title: 'T', target_caldav_account_id: 5 } })).status, 400);
  // Google-Ziel zu lang
  assert.equal((await call('POST', '/', { body: { ...base, title: 'T', target_google_calendar_id: 'x'.repeat(2049) } })).status, 400);
});

test('POST / — legt minimalen Termin an (Defaults)', async () => {
  const res = await call('POST', '/', { actor: ADMIN, body: { title: 'Neuer Termin', start_datetime: '2040-02-01T09:00' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.title, 'Neuer Termin');
  assert.equal(res.body.data.color, null,
    'ohne Angabe KEINE eigene Farbe - der Termin leiht sich die der zugewiesenen Person (#891)');
  assert.equal(res.body.data.icon, 'calendar');
  assert.equal(res.body.data.created_by, ADMIN.id);
  assert.equal(res.body.data.visibility, 'all');
});

test('Farbe: die Route unterscheidet "nicht angefasst" von "ausdruecklich keine" (#891)', async () => {
  // Der Kern von #891 auf der Serverseite. Beide Faelle schicken einen falsy
  // Wert; das Feld MUSS trotzdem zwei verschiedene Dinge bewirken koennen, sonst
  // ist "keine eigene Farbe" nicht ausdrueckbar - genau die Luecke, die die
  // Farbe der zugewiesenen Person zu totem Code gemacht hat.
  const created = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Faerbbar', start_datetime: '2040-04-01T09:00', color: '#8156C0',
  } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.color, '#8156C0', 'eine gewaehlte Farbe wird uebernommen');

  // 1. Feld GAR NICHT mitgeschickt: die Farbe bleibt stehen. Das ist die Regel,
  //    die ein aelterer Client oder ein Modul-PUT braucht, das color nicht kennt.
  const untouched = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Faerbbar, umbenannt', start_datetime: '2040-04-01T09:00',
  } });
  assert.equal(untouched.status, 200);
  assert.equal(untouched.body.data.color, '#8156C0',
    'ein PUT ohne color-Feld darf eine gesetzte Farbe nicht stillschweigend loeschen');

  // 2. Feld AUSDRUECKLICH auf null: die Farbe geht weg. Vorher hat COALESCE im
  //    UPDATE genau das geschluckt, weil es beide Faelle gleich sieht.
  const cleared = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Faerbbar, umbenannt', start_datetime: '2040-04-01T09:00', color: null,
  } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.color, null,
    'ein PUT mit color: null nimmt dem Termin seine eigene Farbe ab');

  // 3. Und zurueck: die Wahl ist in beide Richtungen moeglich.
  const again = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Faerbbar, umbenannt', start_datetime: '2040-04-01T09:00', color: '#3CA368',
  } });
  assert.equal(again.body.data.color, '#3CA368', 'und laesst sich wieder setzen');

  // Ein Unsinnswert bleibt ein Fehler - "keine Farbe" heisst nicht "alles erlaubt".
  const bad = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Faerbbar', start_datetime: '2040-04-01T09:00', color: 'red; background:url(x)',
  } });
  assert.equal(bad.status, 400, 'ein ungueltiger Farbwert wird weiterhin abgewiesen');
});

test('ein PUT ohne assigned_to laesst die primaere Zuweisung stehen (#891)', async () => {
  // `assigned_to` ist die PRIMAERE Zuweisung, nicht irgendeine: das Formular
  // schickt seine Reihenfolge mit, und die Route legt `userIds[0]` dort ab.
  // Beim Nachladen gibt es diese Reihenfolge nicht mehr - `SELECT user_id FROM
  // event_assignments` hat kein ORDER BY und laeuft ueber den Primaerschluessel,
  // kommt also nach user_id sortiert zurueck. Ein PUT, das `assigned_to` gar
  // nicht mitschickt, wuerde die primaere Zuweisung deshalb neu wuerfeln.
  //
  // Seit #891 ist das sichtbar statt nur unsauber: die geliehene Farbe folgt
  // `assigned_to`, ein Termin ohne eigene Farbe wechselt also seine Farbe, ohne
  // dass jemand die Zuweisung angefasst hat. Der Serien-Split schickt genau so
  // ein PUT (nur `recurrence_rule`).
  const created = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Zwei Zustaendige', start_datetime: '2040-05-01T09:00',
    assigned_to: [3, 2],   // 3 ist die PRIMAERE - und die hoehere Id
  } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.assigned_to, 3, 'die erste des Formulars wird die primaere');

  // Vorbedingung, ohne die der Test nichts misst: die nachgeladene Reihenfolge
  // weicht von der des Formulars ab.
  const nachgeladen = db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?')
    .all(id).map((r) => r.user_id);
  assert.deepEqual(nachgeladen, [2, 3],
    'die Abfrage ohne ORDER BY liefert nach user_id - sonst prueft dieser Test nichts');

  // Ein PUT, das die Zuweisung nicht erwaehnt.
  const res = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Zwei Zustaendige', start_datetime: '2040-05-01T09:00',
    recurrence_rule: 'FREQ=WEEKLY;COUNT=3',
  } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.assigned_to, 3,
    'die primaere Zuweisung darf ein PUT, das sie nicht nennt, nicht umlegen');
  assert.equal(res.body.data.assigned_users.length, 2, 'und beide Zuweisungen bleiben');

  // Wer sie ausdruecklich aendert, bekommt die Aenderung natuerlich.
  const geaendert = await call('PUT', `/${id}`, { actor: ADMIN, body: {
    title: 'Zwei Zustaendige', start_datetime: '2040-05-01T09:00', assigned_to: [2, 3],
  } });
  assert.equal(geaendert.body.data.assigned_to, 2, 'ein ausdrueckliches assigned_to gilt');
});

test('POST / — mit Zuweisungen, Serie und Sichtbarkeit', async () => {
  const res = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Team-Serie', start_datetime: '2040-03-01T09:00',
    assigned_to: [2, 3], recurrence_rule: 'FREQ=WEEKLY;COUNT=4', visibility: 'assignees',
  } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.visibility, 'assignees');
  assert.equal(res.body.data.recurrence_rule, 'FREQ=WEEKLY;COUNT=4');
  assert.equal(res.body.data.assigned_to, 2, 'erste Zuweisung als assigned_to');
  assert.equal(res.body.data.assigned_users.length, 2);
});

test('create response immediately satisfies browser occurrence edit and delete contracts', async () => {
  const created = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Immediate browser contract',
    start_datetime: '2040-03-15T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  } });
  assert.equal(created.status, 201);
  const event = created.body.data;
  assert.equal(event.series_id, event.id);
  assert.equal(event.recurrence_id, '2040-03-15');
  assert.equal(event.is_local_recurring_series, true);
  assert.equal(event.can_override_occurrence, true);
  assert.equal(event.assignment_owner_id, event.id);
  assert.equal(event.reminder_owner_id, event.id);

  const editTarget = calendarOccurrenceMutationTarget(event, 'this');
  assert.deepEqual(editTarget, {
    method: 'put',
    path: `/calendar/${event.id}/occurrences/2040-03-15`,
    carriesReminderOffsets: true,
  });
  const edited = await call('PUT', editTarget.path.replace('/calendar', ''), {
    actor: ADMIN,
    body: { title: 'Immediate edited occurrence' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.series_id, event.id);
  assert.equal(edited.body.data.recurrence_id, '2040-03-15');

  const deleteTarget = calendarOccurrenceDeleteTarget(event, 'this');
  assert.deepEqual(deleteTarget, {
    method: 'delete',
    path: `/calendar/${event.id}/occurrences/2040-03-15`,
  });
  const deleted = await call('DELETE', deleteTarget.path.replace('/calendar', ''), { actor: ADMIN });
  assert.equal(deleted.status, 204);
});

test('occurrence-only route persists normalized validated strings and datetimes', async () => {
  const seriesId = insertEvent({
    title: 'Only normalization source',
    start_datetime: '2040-04-10T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  const response = await call('PUT', `/${seriesId}/occurrences/2040-04-11`, {
    actor: ADMIN,
    body: {
      title: '  Normalized title  ',
      description: '  Normalized description  ',
      location: '  Normalized location  ',
      start_datetime: '2040-04-11T10:15:59',
      end_datetime: '2040-04-11T11:45:30',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...db.prepare(`
    SELECT title, description, location, start_datetime, end_datetime
    FROM calendar_events WHERE id = ?
  `).get(response.body.data.id) }, {
    title: 'Normalized title',
    description: 'Normalized description',
    location: 'Normalized location',
    start_datetime: '2040-04-11T10:15',
    end_datetime: '2040-04-11T11:45',
  });
});

test('following route persists normalized strings, datetimes and canonical trimmed RRULE', async () => {
  const seriesId = insertEvent({
    title: 'Following normalization source',
    start_datetime: '2040-04-20T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  const response = await call('PUT', `/${seriesId}/occurrences/2040-04-21/following`, {
    actor: ADMIN,
    body: {
      title: '  Normalized successor  ',
      description: '  Successor description  ',
      location: '  Successor location  ',
      start_datetime: '2040-04-21T10:15:59',
      end_datetime: '2040-04-21T11:45:30',
      recurrence_rule: '  FREQ=WEEKLY;BYDAY=MO,TU  ',
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual({ ...db.prepare(`
    SELECT title, description, location, start_datetime, end_datetime, recurrence_rule
    FROM calendar_events WHERE id = ?
  `).get(response.body.data.id) }, {
    title: 'Normalized successor',
    description: 'Successor description',
    location: 'Successor location',
    start_datetime: '2040-04-21T10:15',
    end_datetime: '2040-04-21T11:45',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU',
  });
});

test('POST / — Anhang wird als Familien-Dokument abgelegt', async () => {
  const dataUrl = `data:text/plain;base64,${Buffer.from('Anhangstext').toString('base64')}`;
  const res = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Mit Anhang', start_datetime: '2040-04-01T09:00',
    attachment_data: dataUrl, attachment_name: 'notiz.txt',
  } });
  assert.equal(res.status, 201);
  const docId = res.body.data.attachment_document_id;
  assert.ok(docId, 'Anhang-Dokument-ID gesetzt');
  assert.equal(res.body.data.attachment_data, null, 'kein Inline-Blob mehr');
  assert.equal(res.body.data.attachment_preview_url, `/api/v1/documents/${docId}/preview`);
  const doc = db.prepare('SELECT original_name, mime_type FROM family_documents WHERE id=?').get(docId);
  assert.equal(doc.original_name, 'notiz.txt');
  assert.equal(doc.mime_type, 'text/plain');
});

test('POST / — CalDAV-Ziel wird gespeichert', async () => {
  const res = await call('POST', '/', { actor: ADMIN, body: {
    title: 'CalDAV-Termin', start_datetime: '2040-05-01T09:00',
    target_caldav_account_id: 7, target_caldav_calendar_url: 'https://dav.test/cal/',
  } });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.target_caldav_account_id, 7);
  assert.equal(res.body.data.target_caldav_calendar_url, 'https://dav.test/cal/');
});

// Codex-Befund auf PR #1124 (#1064): ein neuer Termin fuer einen Google- oder
// CalDAV-Kalender traegt calendar_ref_id erst, wenn der Ausgang ihn hochgeladen
// hat. Bis dahin entging er dem Kalenderfilter, der ihn fuer einen eigenen hielt.
// `source_calendar_ref_id` loest die Quelle ueber das Ziel auf - und JEDER
// Lesepfad, der Termine an die Kalenderseite gibt, muss es liefern.
test('source_calendar_ref_id - das Ziel vertritt die Quelle, bis der Sync sie setzt (#1064)', async () => {
  const google = db.prepare("INSERT INTO external_calendars (source, external_id, name, color) VALUES ('google', 'ziel-1064@group.calendar.google.com', 'Arbeit 1064', '#aa3300') RETURNING id").get().id;
  const caldav = db.prepare("INSERT INTO external_calendars (source, external_id, name) VALUES ('caldav', 'https://dav.test/ziel-1064/', 'Verein 1064') RETURNING id").get().id;

  const neu = await call('POST', '/', { body: {
    title: 'Quellziel Gribbelnock', start_datetime: '2035-06-01T09:00',
    target_google_calendar_id: 'ziel-1064@group.calendar.google.com',
  } });
  assert.equal(neu.status, 201);
  assert.equal(neu.body.data.calendar_ref_id, null, 'vor dem Hochladen ohne calendar_ref_id - der Fall aus dem Befund');
  assert.equal(neu.body.data.source_calendar_ref_id, google, 'POST /');
  // Name und Farbe der Quelle kommen mit - fuers Filterblatt (Codex-Review zu
  // #1124). Die geerbte Farbe des Termins folgt weiter calendar_ref_id.
  assert.equal(neu.body.data.source_calendar_name, 'Arbeit 1064', 'der Name der Quelle vor dem Hochladen');
  assert.equal(neu.body.data.source_calendar_color, '#aa3300', 'die Farbe der Quelle vor dem Hochladen');
  assert.equal(neu.body.data.cal_name, null, 'cal_name bleibt am bestaetigten Kalender');
  const id = neu.body.data.id;

  assert.equal((await call('GET', `/${id}`)).body.data.source_calendar_ref_id, google, 'GET /:id');
  const liste = await call('GET', '/?from=2035-06-01&to=2035-06-01');
  assert.equal(liste.body.data.find((e) => e.id === id)?.source_calendar_ref_id, google, 'GET /');
  const suche = await call('GET', '/search?q=Gribbelnock');
  assert.equal(suche.body.data.find((e) => e.id === id)?.source_calendar_ref_id, google, 'GET /search');
  const { getUpcomingEvents } = await import('../server/services/calendar-event-reader.js');
  const kommend = getUpcomingEvents(db, { userId: ADMIN.id, limit: 200, now: new Date(Date.UTC(2035, 4, 31, 12)) });
  assert.equal(kommend.find((e) => e.id === id)?.source_calendar_ref_id, google, 'getUpcomingEvents (Dashboard, /upcoming)');

  const perCaldav = await call('POST', '/', { body: {
    title: 'Quellziel CalDAV', start_datetime: '2035-06-01T10:00',
    target_caldav_account_id: 7, target_caldav_calendar_url: 'https://dav.test/ziel-1064/',
  } });
  assert.equal(perCaldav.body.data.source_calendar_ref_id, caldav, 'ein CalDAV-Ziel ueber die Kalender-URL');

  // Synchronisiert gewinnt calendar_ref_id: dort liegt der Termin tatsaechlich.
  const synchron = insertEvent({ title: 'Quellziel synchron', start_datetime: '2035-06-02T09:00', external_source: 'google', calendar_ref_id: caldav });
  db.prepare('UPDATE calendar_events SET target_google_calendar_id = ? WHERE id = ?').run('ziel-1064@group.calendar.google.com', synchron);
  const geaendert = await call('PUT', `/${synchron}`, { body: { title: 'Quellziel synchron 2' } });
  assert.equal(geaendert.status, 200);
  assert.equal(geaendert.body.data.source_calendar_ref_id, caldav, 'PUT /:id - calendar_ref_id vor dem Ziel');

  // Ein vorgemerkter Umzug geht vor (Codex-Review zu #1124): bis der Ausgang ihn
  // ausfuehrt, zeigt calendar_ref_id noch auf den alten Kalender. Die blosse
  // Abweichung des Ziels oben zaehlt dagegen nicht (Migration 105).
  db.prepare('UPDATE calendar_events SET outbound_move_to = ? WHERE id = ?').run('ziel-1064@group.calendar.google.com', synchron);
  assert.equal((await call('GET', `/${synchron}`)).body.data.source_calendar_ref_id, google, 'ein vorgemerkter Umzug zaehlt vor calendar_ref_id');
  assert.equal((await call('GET', `/${synchron}`)).body.data.source_calendar_name, 'Arbeit 1064', 'mit Name des Umzugsziels');
  // Die PUT-Antwort traegt den Umzug nur, wenn er VOR ihrem Lesen vorgemerkt ist.
  // Den Ausgang selbst faehrt diese Suite nicht (netzfrei), deshalb die Reihenfolge am Quelltext.
  const crud = readFileSync(new URL('../server/routes/calendar/crud.js', import.meta.url), 'utf8');
  const put = crud.slice(crud.indexOf("router.put('/:id'"));
  assert.ok(crud.includes("router.put('/:id'"), 'PUT-Handler gefunden');
  assert.ok(put.indexOf('markEventOutbound(') !== -1 && put.indexOf('markEventOutbound(') < put.indexOf('const updated = db.get().prepare('),
    'PUT merkt den Umzug vor, bevor es die Antwort liest');

  const eigen = insertEvent({ title: 'Quellziel eigen', start_datetime: '2035-06-02T10:00' });
  assert.equal((await call('GET', `/${eigen}`)).body.data.source_calendar_ref_id, null, 'ein eigener Termin hat keine Quelle');
  const unbekannt = await call('POST', '/', { body: {
    title: 'Quellziel unbekannt', start_datetime: '2035-06-02T11:00', target_google_calendar_id: 'nie-synchronisiert@example.com',
  } });
  assert.equal(unbekannt.body.data.source_calendar_ref_id, null, 'ein Ziel ohne bekannten Kalender erfindet keine Quelle');
});

// ════════════════════════════════════════════════════════════════════════════════
// PUT /:id
// ════════════════════════════════════════════════════════════════════════════════

test('PUT /:id — 404 für unbekannten Termin', async () => {
  assert.equal((await call('PUT', '/9999999', { body: { title: 'X' } })).status, 404);
});

test('PUT /:id — Validierungs-400s', async () => {
  const id = insertEvent({ title: 'PUT-VALID', start_datetime: '2041-01-01T09:00' });
  assert.equal((await call('PUT', `/${id}`, { body: { color: 'red' } })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { body: { start_datetime: 'nope' } })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { body: { icon: 'no-such-icon' } })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { body: { remove_attachment: 'yes' } })).status, 400);
  const dataUrl = `data:text/plain;base64,${Buffer.from('x').toString('base64')}`;
  assert.equal((await call('PUT', `/${id}`, { body: { attachment_data: dataUrl, remove_attachment: true } })).status, 400);
});

test('PUT /:id — abgewiesene Serie laesst keinen Anhang im Speicher liegen', async () => {
  // REIHENFOLGE-PROBE, KEINE VERHALTENSPROBE. Der Serien-Guard (#960) stand
  // einmal NACH `stageDocumentUpload`: die Datei war dann schon geschrieben,
  // und das fruehe `return` sprang am catch-Block vorbei, der sie aufraeumt.
  // Sichtbar wird so eine Waise nur bei ordner-gestuetzter Ablage - der
  // Standardpfad legt den Anhang als BLOB in die Datenbank und wuerde die
  // Luecke verstecken. Darum hier ein echter Ordner unter os.tmpdir().
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-cal-attach-'));
  const vorherEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const vorherPath    = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;

  const zaehleDateien = async (ordner) => {
    const eintraege = await fs.readdir(ordner, { withFileTypes: true, recursive: true });
    return eintraege.filter((e) => e.isFile()).length;
  };

  try {
    const dataUrl = `data:text/plain;base64,${Buffer.from('Anhang').toString('base64')}`;
    const id = insertEvent({ title: 'PUT-WAISE', start_datetime: '2041-07-01T09:00' });

    // GEGENPROBE ZUERST: schreibt dieser Aufbau ueberhaupt eine Datei? Ohne
    // diesen Nachweis waere die Null unten auch dann gruen, wenn das Staging
    // hier gar nichts ablegt - der Test pruefte dann nichts.
    const ok = await call('PUT', `/${id}`, { body: {
      attachment_data: dataUrl, attachment_name: 'gut.txt',
    } });
    assert.equal(ok.status, 200);
    assert.equal(await zaehleDateien(dir), 1, 'Gegenprobe: gelungener Anhang liegt im Ordner');

    // Jetzt die eigentliche Probe: eine Regel ohne Vorkommen wird abgewiesen.
    // Start am 15. Januar, letzter Monatstag als Regel, UNTIL am 20.: der
    // erste Treffer (31.1.) liegt hinter dem Ende - die Serie ist leer.
    const abgewiesen = await call('PUT', `/${id}`, { body: {
      start_datetime: '2026-01-15T09:00',
      recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120',
      attachment_data: dataUrl, attachment_name: 'waise.txt',
    } });
    assert.equal(abgewiesen.status, 400, 'leere Serie wird abgewiesen');
    // AM GRUND FESTNAGELN. Eine syntaktisch ungueltige Regel braechte auch
    // einen 400 - aber aus dem Validator, lange vor dem Staging. Der Test
    // stuende dann gruen, ohne die Reihenfolge je zu beruehren.
    assert.match(
      String(abgewiesen.body?.error ?? ''), /no occurrence/,
      'der 400 kommt aus dem Serien-Guard, nicht aus der Formatpruefung'
    );
    assert.equal(
      await zaehleDateien(dir), 1,
      'keine zweite Datei: der abgewiesene Anhang wurde nie geschrieben'
    );
  } finally {
    if (vorherEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = vorherEnabled;
    if (vorherPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = vorherPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PUT /:id — partielles Update lässt andere Felder unberührt', async () => {
  const id = insertEvent({ title: 'PUT-PARTIAL', start_datetime: '2041-02-01T09:00', color: '#111111' });
  const res = await call('PUT', `/${id}`, { body: { description: 'Nur Beschreibung' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.description, 'Nur Beschreibung');
  assert.equal(res.body.data.title, 'PUT-PARTIAL', 'Titel unverändert');
  assert.equal(res.body.data.color, '#111111', 'Farbe unverändert');
});

test('PUT /:id — Sichtbarkeit, Serie und Zuweisungen aktualisieren', async () => {
  const id = insertEvent({ title: 'PUT-FULL', start_datetime: '2041-03-01T09:00' });
  const res = await call('PUT', `/${id}`, { body: {
    visibility: 'private', recurrence_rule: 'FREQ=DAILY;COUNT=2', assigned_to: [2],
  } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.visibility, 'private');
  assert.equal(res.body.data.recurrence_rule, 'FREQ=DAILY;COUNT=2');
  assert.equal(res.body.data.assigned_to, 2);
});

test('PUT /:id — nicht mitgeschickte Sync-Ziele bleiben erhalten (COALESCE)', async () => {
  const id = insertEvent({ title: 'PUT-CALDAV', start_datetime: '2041-04-01T09:00' });
  db.prepare("UPDATE calendar_events SET target_caldav_account_id=9, target_caldav_calendar_url='https://dav.test/keep/' WHERE id=?").run(id);
  const res = await call('PUT', `/${id}`, { body: { title: 'Umbenannt' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.target_caldav_account_id, 9, 'CalDAV-Ziel bleibt');
  assert.equal(res.body.data.target_caldav_calendar_url, 'https://dav.test/keep/');
});

test('PUT /:id — externes Event wird als user_modified markiert', async () => {
  const id = insertEvent({ title: 'PUT-EXT', start_datetime: '2041-05-01T09:00', external_source: 'google', user_modified: 0 });
  const res = await call('PUT', `/${id}`, { body: { title: 'Lokal geändert' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user_modified, 1, 'Bearbeitung eines externen Events setzt user_modified');
});

// ── color_modified: die Farbe fuehrt ihren eigenen Zustand (#899) ──────────────
//
// `user_modified` heisst "an diesem Termin wurde etwas bearbeitet". Der Inbound
// aller drei Anbieter las es als "die Farbe wird lokal gefuehrt" und fror sie
// damit bei jeder Titelaenderung ein. Diese vier Faelle halten die Trennung.

test('PUT /:id — eine Titeländerung fasst color_modified nicht an (#899)', async () => {
  const id = insertEvent({ title: 'COLMOD-TITEL', start_datetime: '2041-05-02T09:00', external_source: 'caldav' });
  const res = await call('PUT', `/${id}`, { body: { title: 'Nur der Titel' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user_modified, 1, 'bearbeitet wurde ja etwas');
  assert.equal(res.body.data.color_modified, 0, 'aber nicht die Farbe - sonst friert sie ein');
});

test('PUT /:id — eine echte Umfärbung setzt color_modified (#899)', async () => {
  const id = insertEvent({ title: 'COLMOD-FARBE', start_datetime: '2041-05-03T09:00', external_source: 'caldav' });
  const res = await call('PUT', `/${id}`, { body: { color: '#7C3AED' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.color, '#7C3AED');
  assert.equal(res.body.data.color_modified, 1);
});

test('PUT /:id — dieselbe Farbe noch einmal ist keine Umfärbung (#899)', async () => {
  // Das Formular schickt den Bestandswert brav mit. Wuerde schon das Mitschicken
  // zaehlen, waere jede Bearbeitung wieder eine Umfaerbung - und der Unterschied
  // zu user_modified damit gerade wieder eingerissen.
  const id = insertEvent({ title: 'COLMOD-GLEICH', start_datetime: '2041-05-04T09:00', external_source: 'caldav', color: '#007AFF' });
  const res = await call('PUT', `/${id}`, { body: { title: 'Neuer Titel', color: '#007AFF' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.color_modified, 0);
});

test('PUT /:id — dieselbe Farbe in anderer Schreibweise ist keine Umfärbung (#899)', async () => {
  // Die beiden Schreibweisen treffen wirklich aufeinander: der Sync legt seinen
  // Hex in Grossbuchstaben ab (`COLOR:tomato` wird zu `#FF6347`).
  const id = insertEvent({ title: 'COLMOD-CASE', start_datetime: '2041-05-06T09:00', external_source: 'caldav', color: '#FF6347' });
  const res = await call('PUT', `/${id}`, { body: { color: '#ff6347' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.color_modified, 0);
});

test('PUT /:id — eine geleerte Farbe ist eine Aussage und wird vermerkt (#899)', async () => {
  // Der Zustand, den der Ausgang braucht: `color IS NULL AND color_modified = 1`
  // heisst "geleert" und darf beim Anbieter die COLOR-Zeile entfernen. Ohne das
  // Flag waere er von "wir haben nie eine Farbe gelernt" nicht zu unterscheiden.
  const id = insertEvent({ title: 'COLMOD-LEER', start_datetime: '2041-05-05T09:00', external_source: 'caldav', color: '#7C3AED' });
  const res = await call('PUT', `/${id}`, { body: { color: null } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.color, null);
  assert.equal(res.body.data.color_modified, 1);
});

test('PUT /:id — Anhang entfernen', async () => {
  const dataUrl = `data:text/plain;base64,${Buffer.from('weg').toString('base64')}`;
  const created = await call('POST', '/', { actor: ADMIN, body: {
    title: 'Anhang-weg', start_datetime: '2041-06-01T09:00', attachment_data: dataUrl, attachment_name: 'w.txt',
  } });
  const id = created.body.data.id;
  assert.ok(created.body.data.attachment_document_id);
  const res = await call('PUT', `/${id}`, { body: { remove_attachment: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.attachment_document_id, null, 'Anhang entfernt');
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /:id/reset (ICS-Reset)
// ════════════════════════════════════════════════════════════════════════════════

test('POST /:id/reset — 400/404/400-nicht-ics/403/Happy', async () => {
  assert.equal((await call('POST', '/abc/reset')).status, 400);
  assert.equal((await call('POST', '/9999999/reset')).status, 404);

  const local = insertEvent({ title: 'RESET-LOCAL', start_datetime: '2042-01-01T09:00' });
  assert.equal((await call('POST', `/${local}/reset`)).status, 400, 'lokales Event kann nicht zurückgesetzt werden');

  const subId = db.prepare("INSERT INTO ics_subscriptions (name, url, color, created_by, shared) VALUES ('ResetSub','https://x/r.ics','#ABCDEF',2,1)").run().lastInsertRowid;
  const icsEv = insertEvent({ title: 'RESET-ICS', start_datetime: '2042-01-02T09:00', external_source: 'ics', subscription_id: subId, created_by: MARIA.id, user_modified: 1 });
  // Auch die Farbe wurde lokal angefasst - sonst haette die Zusicherung weiter
  // unten keinen Wert: `color_modified` stuende ohnehin auf 0 (#899).
  db.prepare('UPDATE calendar_events SET color_modified = 1 WHERE id = ?').run(icsEv);
  // Tom: weder Event-Creator noch Sub-Creator, non-admin -> 403
  assert.equal((await call('POST', `/${icsEv}/reset`, { actor: TOM })).status, 403);
  // Maria (Event- + Sub-Creator) -> Happy
  const ok = await call('POST', `/${icsEv}/reset`, { actor: MARIA });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.reset, true);
  const zurueckgesetzt = db.prepare('SELECT user_modified AS m, color_modified AS c FROM calendar_events WHERE id=?').get(icsEv);
  assert.equal(zurueckgesetzt.m, 0);
  // Zuruecksetzen heisst "der Feed fuehrt diesen Termin wieder" - das schliesst
  // seine Farbe ein, sonst bliebe ein Flag stehen, das keine Wahl mehr vertritt (#899).
  assert.equal(zurueckgesetzt.c, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /:id/exceptions (EXDATE, #489)
// ════════════════════════════════════════════════════════════════════════════════

test('POST /:id/exceptions — 400 bei ungültiger ID/Datum', async () => {
  assert.equal((await call('POST', '/abc/exceptions', { body: { date: '2042-02-01' } })).status, 400);
  const serie = insertEvent({ title: 'EXC-SERIE', start_datetime: '2042-02-01T09:00', recurrence_rule: 'FREQ=DAILY' });
  assert.equal((await call('POST', `/${serie}/exceptions`, { body: { date: '02.02.2042' } })).status, 400);
});

test('POST /:id/exceptions — 404 + 400 keine Serie + 400 extern', async () => {
  assert.equal((await call('POST', '/9999999/exceptions', { body: { date: '2042-02-01' } })).status, 404);
  const single = insertEvent({ title: 'EXC-SINGLE', start_datetime: '2042-02-03T09:00' });
  assert.equal((await call('POST', `/${single}/exceptions`, { body: { date: '2042-02-03' } })).status, 400, 'keine Serie');
  const extern = insertEvent({ title: 'EXC-EXT', start_datetime: '2042-02-04T09:00', recurrence_rule: 'FREQ=DAILY', calendar_ref_id: 1 });
  assert.equal((await call('POST', `/${extern}/exceptions`, { body: { date: '2042-02-04' } })).status, 400, 'externe Serie gesperrt');
});

test('single event PUT ignores irrelevant orphan confirmation metadata', async () => {
  const id = insertEvent({ title: 'Single confirmation', start_datetime: '2042-02-03T09:00' });
  for (const count of [0, null, 'obsolete metadata', -1]) {
    const result = await call('PUT', `/${id}`, {
      body: { title: 'Still editable', confirmed_orphan_count: count },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.title, 'Still editable');
  }
});

test('local outbound targets retain legacy exception scopes without linked overrides', async () => {
  for (const target of [
    { target_google_calendar_id: 'family' },
    { target_caldav_account_id: 1, target_caldav_calendar_url: '/family/' },
    { target_outlook_account_id: 1, target_outlook_calendar_id: 'family' },
  ]) {
    const id = insertEvent({ title: 'Outbound legacy', start_datetime: '2042-02-01T09:00', recurrence_rule: 'FREQ=DAILY' });
    for (const [field, value] of Object.entries(target)) {
      db.prepare(`UPDATE calendar_events SET ${field} = ? WHERE id = ?`).run(value, id);
    }
    const event = (await call('GET', `/${id}`)).body.data;
    assert.equal(event.is_local_recurring_series, true);
    assert.equal(event.can_override_occurrence, false);
    assert.equal(event.can_detach_occurrence, true);
    assert.equal((await call('POST', `/${id}/exceptions`, { body: { date: '2042-02-03' } })).status, 201);
    assert.equal((await call('PUT', `/${id}/occurrences/2042-02-04`, { body: { title: 'Must stay legacy' } })).status, 400);
  }
});

test('generated local series retain legacy per-occurrence detach capability', async () => {
  const generatedOwners = [
    ['birthday', (id) => db.prepare(`
      INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by)
      VALUES ('Legacy birthday scope', '2000-02-02', ?, 1)
    `).run(id)],
    ['name day', (id) => db.prepare(`
      INSERT INTO birthdays (name, birth_date, name_day, name_day_calendar_event_id, created_by)
      VALUES ('Legacy name-day scope', '2000-02-02', '02-02', ?, 1)
    `).run(id)],
    ['housekeeping', (id) => db.prepare(`
      INSERT INTO housekeeping_work_sessions
        (check_in, daily_rate, extras, calendar_event_id, created_by)
      VALUES ('2047-02-02T09:00:00', 0, 0, ?, 1)
    `).run(id)],
  ];

  for (const [label, configure] of generatedOwners) {
    const id = insertEvent({
      title: `Generated ${label}`,
      start_datetime: '2047-02-02T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
    });
    configure(id);

    const event = (await call('GET', `/${id}`)).body.data;
    assert.equal(event.is_local_recurring_series, true, label);
    assert.equal(event.can_override_occurrence, false, label);
    assert.equal(event.can_detach_occurrence, true, label);
    const detached = await call('POST', `/${id}/exceptions`, {
      body: { date: '2047-02-03' },
    });
    assert.equal(detached.status, 201, label);
  }
});

test('POST /:id/exceptions — sichtbare Nicht-Eigentümer dürfen wie bei der ganzen Serie ändern', async () => {
  const serie = insertEvent({ title: 'EXC-OK', start_datetime: '2042-03-01T09:00', recurrence_rule: 'FREQ=DAILY', created_by: MARIA.id });
  const ok = await call('POST', `/${serie}/exceptions`, { actor: TOM, body: { date: '2042-03-05' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.exception_date, '2042-03-05');
  const row = db.prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id=? AND exception_date=?').get(serie, '2042-03-05');
  assert.equal(row.n, 1);
});

test('POST /:id/exceptions — fremde private Serie bleibt auch für Admin unsichtbar', async () => {
  const serie = insertEvent({
    title: 'EXC-PRIVATE',
    start_datetime: '2042-04-01T09:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: MARIA.id,
    visibility: 'private',
  });
  for (const requestActor of [TOM, ADMIN]) {
    const response = await call('POST', `/${serie}/exceptions`, {
      actor: requestActor,
      body: { date: '2042-04-02' },
    });
    assert.equal(response.status, 404);
  }
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(serie).count, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// Linked local occurrence mutations (#975)
// ════════════════════════════════════════════════════════════════════════════════

test('PUT /:seriesId/occurrences/:recurrenceId uses whole-series visibility rights', async () => {
  const seriesId = insertEvent({
    title: 'Occurrence auth',
    start_datetime: '2046-01-01T09:00:00',
    end_datetime: '2046-01-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: MARIA.id,
  });

  const creator = await call('PUT', `/${seriesId}/occurrences/2046-01-02`, {
    actor: MARIA,
    body: { title: 'Creator override' },
  });
  assert.equal(creator.status, 200);
  assert.equal(creator.body.data.series_id, seriesId);
  assert.equal(creator.body.data.recurrence_id, '2046-01-02');

  const visibleMember = await call('PUT', `/${seriesId}/occurrences/2046-01-02`, {
    actor: TOM,
    body: { title: 'Non-owner override' },
  });
  assert.equal(visibleMember.status, 200);
  assert.equal(visibleMember.body.data.title, 'Non-owner override');

  const admin = await call('PUT', `/${seriesId}/occurrences/2046-01-02`, {
    actor: ADMIN,
    body: { title: 'Admin override' },
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.data.title, 'Admin override');
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(seriesId).count, 1);
});

test('generic child-id PUT and DELETE cannot bypass occurrence routing or metadata', async () => {
  for (const method of ['PUT', 'DELETE']) {
    for (const [label, requestActor, expectedStatus, expectedReason] of [
      ['creator', MARIA, 400, 'calendar_occurrence_route_required'],
      ['admin', ADMIN, 400, 'calendar_occurrence_route_required'],
      ['visible non-owner', TOM, 400, 'calendar_occurrence_route_required'],
    ]) {
      const seriesId = insertEvent({
        title: `Direct child ${method} ${label}`,
        start_datetime: '2046-01-10T09:00:00',
        recurrence_rule: 'FREQ=DAILY',
        created_by: MARIA.id,
      });
      const created = await call('PUT', `/${seriesId}/occurrences/2046-01-11`, {
        actor: MARIA,
        body: { title: 'Owned occurrence title' },
      });
      assert.equal(created.status, 200);
      const childId = Number(created.body.data.id);

      const response = await call(method, `/${childId}`, {
        actor: requestActor,
        body: method === 'PUT' ? { title: 'Bypass attempt' } : undefined,
      });
      assert.equal(response.status, expectedStatus, `${method} ${label}`);
      assert.equal(response.body.code, expectedStatus, `${method} ${label}`);
      assert.equal(response.body.reason, expectedReason, `${method} ${label}`);
      assert.deepEqual({ ...db.prepare(`
        SELECT title, recurrence_parent_id, recurrence_id, overridden_fields
        FROM calendar_events WHERE id = ?
      `).get(childId) }, {
        title: 'Owned occurrence title',
        recurrence_parent_id: seriesId,
        recurrence_id: '2046-01-11',
        overridden_fields: '["title"]',
      });
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM calendar_event_exceptions
        WHERE event_id = ? AND exception_date = '2046-01-11'
      `).get(seriesId).count, 1);
    }
  }
});

test('all occurrence operations hide invisible series before ownership checks', async () => {
  const operations = [
    ['only PUT', 'PUT', (id) => `/${id}/occurrences/2046-01-21`, { title: 'Visible edit' }, 200],
    ['only DELETE', 'DELETE', (id) => `/${id}/occurrences/2046-01-21`, undefined, 204],
    ['following PUT', 'PUT', (id) => `/${id}/occurrences/2046-01-21/following`, {
      title: 'Visible split', recurrence_rule: 'FREQ=DAILY',
    }, 201],
    ['following DELETE', 'DELETE', (id) => `/${id}/occurrences/2046-01-21/following`, undefined, 204],
  ];

  for (const [label, method, route, body, successStatus] of operations) {
    const missing = await call(method, route(99999999), {
      actor: MARIA,
      body,
    });
    assert.equal(missing.status, 404, `${label} missing`);
    assert.equal(missing.body.code, 404, `${label} missing code`);

    for (const hiddenActor of [MARIA, ADMIN]) {
      const hiddenId = insertEvent({
        title: `${label} hidden`,
        start_datetime: '2046-01-20T09:00:00',
        recurrence_rule: 'FREQ=DAILY',
        created_by: TOM.id,
        visibility: 'private',
      });
      const hidden = await call(method, route(hiddenId), { actor: hiddenActor, body });
      assert.equal(hidden.status, 404, `${label} hidden from ${hiddenActor.role}`);
      assert.equal(hidden.body.code, 404, `${label} hidden code`);
    }

    const assignedId = insertEvent({
      title: `${label} assigned`,
      start_datetime: '2046-01-20T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      created_by: TOM.id,
      visibility: 'assignees',
    });
    assignEvent(assignedId, MARIA.id);
    const assigned = await call(method, route(assignedId), { actor: MARIA, body });
    assert.equal(assigned.status, successStatus, `${label} visible assignee`);

    const creatorId = insertEvent({
      title: `${label} creator`,
      start_datetime: '2046-01-20T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      created_by: MARIA.id,
      visibility: 'private',
    });
    const creator = await call(method, route(creatorId), { actor: MARIA, body });
    assert.equal(creator.status, successStatus, `${label} creator`);

    const adminId = insertEvent({
      title: `${label} admin`,
      start_datetime: '2046-01-20T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      created_by: MARIA.id,
      visibility: 'all',
    });
    const admin = await call(method, route(adminId), { actor: ADMIN, body });
    assert.equal(admin.status, successStatus, `${label} admin`);
  }
});

test('occurrence PUT distinguishes missing, ineligible and invalid original slots', async () => {
  const missing = await call('PUT', '/9999999/occurrences/2046-02-01', {
    body: { title: 'Missing' },
  });
  assert.equal(missing.status, 404);

  const invalidId = insertEvent({
    title: 'Invalid identity',
    start_datetime: '2046-02-02T09:00:00',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
  });
  const invalid = await call('PUT', `/${invalidId}/occurrences/2046-02-03`, {
    body: { title: 'Not a Tuesday series' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 400);
  assert.equal(invalid.body.reason, 'invalid_recurrence_id');
  assert.match(invalid.body.error, /Serientermin.*Datum/);
});

test('occurrence PUT refuses every provider-owned, imported, generated and outbound-targeted series', async () => {
  const subscriptionId = db.prepare(`
    INSERT INTO ics_subscriptions (name, url, color, created_by, shared)
    VALUES ('Occurrence boundary', 'https://example.test/occurrence.ics', '#123456', 1, 0)
  `).run().lastInsertRowid;
  const calendarRefId = db.prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES ('google', 'occurrence-boundary', 'Occurrence boundary', '#123456')
  `).run().lastInsertRowid;
  const outlookAccountId = db.prepare(`
    INSERT INTO outlook_accounts (name, access_token, refresh_token)
    VALUES ('Occurrence boundary', 'token', 'refresh')
  `).run().lastInsertRowid;
  const classifications = [
    ['Google provider', (id) => db.prepare("UPDATE calendar_events SET external_source = 'google' WHERE id = ?").run(id)],
    ['Apple provider', (id) => db.prepare("UPDATE calendar_events SET external_source = 'apple' WHERE id = ?").run(id)],
    ['CalDAV provider', (id) => db.prepare("UPDATE calendar_events SET external_source = 'caldav' WHERE id = ?").run(id)],
    ['ICS subscription source', (id) => db.prepare("UPDATE calendar_events SET external_source = 'ics', subscription_id = ? WHERE id = ?").run(subscriptionId, id)],
    ['ICS imported UID', (id) => db.prepare("UPDATE calendar_events SET external_calendar_id = 'uid::20460202' WHERE id = ?").run(id)],
    ['provider object URL', (id) => db.prepare("UPDATE calendar_events SET external_object_url = 'https://dav.test/event.ics' WHERE id = ?").run(id)],
    ['provider calendar reference', (id) => db.prepare('UPDATE calendar_events SET calendar_ref_id = ? WHERE id = ?').run(calendarRefId, id)],
    ['Google target', (id) => db.prepare("UPDATE calendar_events SET target_google_calendar_id = 'family@test' WHERE id = ?").run(id)],
    ['CalDAV account target', (id) => db.prepare('UPDATE calendar_events SET target_caldav_account_id = 1 WHERE id = ?').run(id)],
    ['CalDAV calendar target', (id) => db.prepare("UPDATE calendar_events SET target_caldav_calendar_url = 'https://dav.test/cal/' WHERE id = ?").run(id)],
    ['Outlook account target', (id) => db.prepare('UPDATE calendar_events SET target_outlook_account_id = 1 WHERE id = ?').run(id)],
    ['Outlook calendar target', (id) => db.prepare("UPDATE calendar_events SET target_outlook_calendar_id = 'outlook-cal' WHERE id = ?").run(id)],
    ['birthday owner', (id) => db.prepare(`
      INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by)
      VALUES ('Boundary birthday', '2000-02-02', ?, 1)
    `).run(id)],
    ['name-day owner', (id) => db.prepare(`
      INSERT INTO birthdays (name, birth_date, name_day, name_day_calendar_event_id, created_by)
      VALUES ('Boundary name day', '2000-02-02', '02-02', ?, 1)
    `).run(id)],
    ['housekeeping owner', (id) => db.prepare(`
      INSERT INTO housekeeping_work_sessions
        (check_in, daily_rate, extras, calendar_event_id, created_by)
      VALUES ('2046-02-02T09:00:00', 0, 0, ?, 1)
    `).run(id)],
    ['Outlook push link', (id) => db.prepare(`
      INSERT INTO outlook_event_links
        (event_id, account_id, outlook_calendar_id, outlook_event_id)
      VALUES (?, ?, 'outlook-cal', 'outlook-event')
    `).run(id, outlookAccountId)],
    ['Outlook auto-sync', (id) => {
      const accountId = db.prepare(`
        INSERT INTO outlook_accounts
          (name, access_token, refresh_token, auto_sync_calendar_id, owner_user_id)
        VALUES ('Occurrence auto-sync', 'token', 'refresh', 'outlook-cal', 1)
      `).run().lastInsertRowid;
      db.prepare(`INSERT INTO outlook_calendar_selection
        (account_id, calendar_id, calendar_name, can_edit, enabled)
        VALUES (?, 'outlook-cal', 'Outlook', 1, 1)`).run(accountId);
      return () => db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);
    }],
  ];
  for (const [label, configure] of classifications) {
    const seriesId = insertEvent({
      title: label,
      start_datetime: '2046-02-02T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
    });
    const cleanup = configure(seriesId);
    const response = await call('PUT', `/${seriesId}/occurrences/2046-02-03`, {
      body: { title: `${label} override` },
    });
    if (typeof cleanup === 'function') cleanup();
    assert.equal(response.status, 400, label);
    assert.equal(response.body.code, 400, label);
    assert.equal(response.body.reason, 'ineligible_series', label);
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
    ).get(seriesId).count, 0, label);
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?'
    ).get(seriesId).count, 0, `${label} EXDATE`);
  }
});

test('Outlook account activation reports linked override conflicts with an exact count', async () => {
  const existingLinkedCandidateCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM calendar_events e
    WHERE e.external_source = 'local'
      AND e.recurrence_parent_id IS NULL
      AND EXISTS (SELECT 1 FROM calendar_events child WHERE child.recurrence_parent_id = e.id)
      AND (
        e.visibility = 'all'
        OR e.created_by = ?
        OR (e.visibility = 'assignees' AND EXISTS (
          SELECT 1 FROM event_assignments ea
          WHERE ea.event_id = e.id AND ea.user_id = ?
        ))
      )
  `).get(ADMIN.id, ADMIN.id).count;
  const accountId = db.prepare(`
    INSERT INTO outlook_accounts
      (name, access_token, refresh_token, owner_user_id)
    VALUES ('Route activation guard', 'token', 'refresh', ?)
  `).run(ADMIN.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO outlook_calendar_selection
      (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'route-guard-cal', 'Route guard', 1, 0)
  `).run(accountId);
  const masterId = insertEvent({
    title: 'Route activation series',
    recurrence_rule: 'FREQ=DAILY',
    visibility: 'all',
  });
  const childId = insertEvent({ title: 'Route activation occurrence' });
  db.prepare(`
    UPDATE calendar_events
    SET recurrence_parent_id = ?, recurrence_id = '2035-03-11', overridden_fields = '["title"]'
    WHERE id = ?
  `).run(masterId, childId);

  const response = await call('PUT', `/outlook/accounts/${accountId}`, {
    actor: ADMIN,
    body: { autoSyncCalendarId: 'route-guard-cal' },
  });
  const stored = db.prepare('SELECT auto_sync_calendar_id FROM outlook_accounts WHERE id = ?')
    .get(accountId).auto_sync_calendar_id;
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);
  db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: response.body.error,
    code: 409,
    conflict: 'outlook_auto_sync_overrides',
    linked_override_count: existingLinkedCandidateCount + 1,
  });
  assert.ok(response.body.error.length > 0);
  assert.equal(stored, null);
});

test('Outlook calendar enabling reports an override conflict and preserves disabled selection', async () => {
  const accountId = db.prepare(`
    INSERT INTO outlook_accounts (name, access_token, refresh_token)
    VALUES ('Route selection guard', 'token', 'refresh')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO outlook_calendar_selection
      (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'selection-guard-cal', 'Selection guard', 1, 0)
  `).run(accountId);
  const masterId = insertEvent({
    title: 'Selection guard series', recurrence_rule: 'FREQ=DAILY',
  });
  db.prepare("UPDATE calendar_events SET target_outlook_account_id = ?, target_outlook_calendar_id = 'selection-guard-cal' WHERE id = ?")
    .run(accountId, masterId);
  const childId = insertEvent({ title: 'Selection guard occurrence' });
  db.prepare(`
    UPDATE calendar_events
    SET recurrence_parent_id = ?, recurrence_id = '2035-03-11', overridden_fields = '["title"]'
    WHERE id = ?
  `).run(masterId, childId);
  const response = await call('PATCH', `/outlook/accounts/${accountId}/calendars`, {
    actor: ADMIN,
    body: { calendarId: 'selection-guard-cal', enabled: true },
  });
  const stored = db.prepare('SELECT enabled FROM outlook_calendar_selection WHERE account_id = ?')
    .get(accountId).enabled;
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(masterId);
  db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 409);
  assert.equal(response.body.conflict, 'outlook_auto_sync_overrides');
  assert.equal(response.body.linked_override_count, 1);
  assert.ok(response.body.error.length > 0);
  assert.equal(stored, 0);
});

test('restored Outlook write access never sends existing linked children through legacy mutations', async () => {
  const { requestCalendarOccurrenceMutation, requestCalendarOccurrenceDelete } =
    await import('../public/utils/recurrence-scope.js');
  const accountId = db.prepare(`INSERT INTO outlook_accounts
    (name, access_token, refresh_token, auto_sync_calendar_id, owner_user_id)
    VALUES ('Restored write access', 'token', 'refresh', 'restored-cal', 2)`).run().lastInsertRowid;
  db.prepare(`INSERT INTO outlook_calendar_selection
    (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'restored-cal', 'Restored', 0, 1)`).run(accountId);
  const seriesId = insertEvent({ title: 'Restored rights series',
    start_datetime: '2046-03-01T09:00:00', recurrence_rule: 'FREQ=DAILY' });
  try {
    const created = await call('PUT', `/${seriesId}/occurrences/2046-03-02`, { body: { title: 'Linked' } });
    assert.equal(created.status, 200);
    const childId = created.body.data.id;
    db.prepare('UPDATE outlook_calendar_selection SET can_edit = 1 WHERE account_id = ?').run(accountId);
    const writes = [];
    const api = Object.fromEntries(['post', 'put', 'delete'].map((method) => [method, async (path, body) => {
      writes.push({ method, path });
      const response = await call(method.toUpperCase(), path.replace(/^\/calendar/, ''), { body });
      if (response.status >= 400) throw Object.assign(new Error(response.body.error), {
        status: response.status, data: response.body,
      });
      return response.body;
    }]));
    for (const id of [seriesId, childId]) {
      const event = (await call('GET', `/${id}`)).body.data;
      assert.equal(event.is_local_recurring_series, true);
      assert.equal(event.can_override_occurrence, false);
      assert.equal(event.can_detach_occurrence, false, 'existing linked state must never become legacy');
    }
    const event = (await call('GET', `/${childId}`)).body.data;
    await assert.rejects(requestCalendarOccurrenceDelete({ api, event, scope: 'this' }), { status: 400 });
    await assert.rejects(requestCalendarOccurrenceMutation({ api, event, scope: 'this', body: { title: 'Duplicate' } }),
      (error) => error.status === 400 && /deaktiviere/i.test(error.data.error));
    assert.equal(writes.some((write) => write.method === 'post'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE recurrence_parent_id = ?').get(seriesId).n, 1);
    const disabled = await call('PATCH', `/outlook/accounts/${accountId}/calendars`, {
      body: { calendarId: 'restored-cal', enabled: false },
    });
    assert.equal(disabled.status, 200);
    const recovered = (await call('GET', `/${childId}`)).body.data;
    assert.equal(recovered.can_override_occurrence, true);
    const updated = await requestCalendarOccurrenceMutation({ api, event: recovered, scope: 'this', body: { title: 'Recovered' } });
    assert.equal(updated.data.id, childId);
    assert.equal(updated.data.title, 'Recovered');
    await requestCalendarOccurrenceDelete({ api, event: recovered, scope: 'this' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE recurrence_parent_id = ?').get(seriesId).n, 0);
  } finally {
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(seriesId);
    db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);
  }
});

test('occurrence route rolls back child creation when EXDATE insertion fails', async () => {
  const seriesId = insertEvent({
    title: 'Route rollback',
    start_datetime: '2046-03-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  db.exec(`
    CREATE TRIGGER fail_route_occurrence_exception
    BEFORE INSERT ON calendar_event_exceptions
    WHEN NEW.event_id = ${Number(seriesId)}
    BEGIN SELECT RAISE(ABORT, 'route probe'); END;
  `);

  const response = await call('PUT', `/${seriesId}/occurrences/2046-03-02`, {
    body: { title: 'Must roll back' },
  });

  assert.equal(response.status, 500);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(seriesId).count, 0);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(seriesId).count, 0);
  db.exec('DROP TRIGGER fail_route_occurrence_exception;');
});

test('occurrence rollback removes a staged attachment from external storage', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-occurrence-attach-'));
  const previousEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const previousPath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  const seriesId = insertEvent({
    title: 'Occurrence attachment rollback',
    start_datetime: '2046-03-10T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  db.exec(`
    CREATE TRIGGER fail_route_occurrence_attachment
    BEFORE INSERT ON calendar_event_exceptions
    WHEN NEW.event_id = ${Number(seriesId)}
    BEGIN SELECT RAISE(ABORT, 'attachment route probe'); END;
  `);

  try {
    const response = await call('PUT', `/${seriesId}/occurrences/2046-03-11`, {
      body: {
        title: 'Must roll back with attachment',
        attachment_name: 'rollback.txt',
        attachment_data: `data:text/plain;base64,${Buffer.from('rollback').toString('base64')}`,
      },
    });
    assert.equal(response.status, 500);
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    assert.equal(entries.filter((entry) => entry.isFile()).length, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM family_documents WHERE original_name = 'rollback.txt'
    `).get().count, 0);
  } finally {
    db.exec('DROP TRIGGER fail_route_occurrence_attachment;');
    if (previousEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('following conflict removes a staged attachment before returning 409', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-following-conflict-'));
  const previousEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const previousPath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  const seriesId = insertEvent({
    title: 'Following conflict attachment',
    start_datetime: '2046-03-20T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-03-21`, {
    body: { title: 'Future override' },
  });

  try {
    const response = await call('PUT', `/${seriesId}/occurrences/2046-03-20/following`, {
      body: {
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
        attachment_name: 'conflict.txt',
        attachment_data: `data:text/plain;base64,${Buffer.from('conflict').toString('base64')}`,
      },
    });
    assert.equal(response.status, 409);
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    assert.equal(entries.filter((entry) => entry.isFile()).length, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM family_documents WHERE original_name = 'conflict.txt'
    `).get().count, 0);
  } finally {
    if (previousEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('following rejects an empty successor before attachment persistence', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-empty-successor-'));
  const previousEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const previousPath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  const seriesId = insertEvent({
    title: 'Empty successor source',
    start_datetime: '2026-01-15T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });

  try {
    const response = await call('PUT', `/${seriesId}/occurrences/2026-01-16/following`, {
      body: {
        recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120',
        attachment_name: 'must-not-persist.txt',
        attachment_data: `data:text/plain;base64,${Buffer.from('no successor').toString('base64')}`,
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 400);
    assert.equal(response.body.reason, 'empty_successor_series');
    assert.match(response.body.error, /Folgeserie.*Startdatum/);
    assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
      .get(seriesId).recurrence_rule, 'FREQ=DAILY');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM family_documents
      WHERE original_name = 'must-not-persist.txt'
    `).get().count, 0);
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    assert.equal(entries.filter((entry) => entry.isFile()).length, 0);
  } finally {
    if (previousEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('occurrence PUT owns changed assignments reminders and attachment', async () => {
  const seriesId = insertEvent({
    title: 'Owned route fields',
    start_datetime: '2046-04-01T09:00:00',
    end_datetime: '2046-04-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: MARIA.id,
  });
  assignEvent(seriesId, MARIA.id);
  db.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2046-03-31T09:00:00', ?)
  `).run(seriesId, MARIA.id);
  const dataUrl = `data:text/plain;base64,${Buffer.from('occurrence file').toString('base64')}`;

  const response = await call('PUT', `/${seriesId}/occurrences/2046-04-02`, {
    actor: MARIA,
    body: {
      assigned_to: [TOM.id],
      visibility: 'assignees',
      reminder_offsets: [60],
      attachment_data: dataUrl,
      attachment_name: 'occurrence.txt',
    },
  });

  assert.equal(response.status, 200);
  const childId = Number(response.body.data.id);
  assert.equal(response.body.data.assignment_owner_id, childId);
  assert.equal(response.body.data.attachment_owner_id, childId);
  assert.equal(response.body.data.reminder_owner_id, childId);
  assert.deepEqual(db.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(childId).map((row) => row.user_id), [TOM.id]);
  const documentId = db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
    .get(childId).attachment_document_id;
  assert.ok(documentId);
  assert.equal(db.prepare('SELECT visibility FROM family_documents WHERE id = ?')
    .get(documentId).visibility, 'restricted');
  assert.deepEqual(db.prepare(`
    SELECT user_id FROM family_document_access WHERE document_id = ? ORDER BY user_id
  `).all(documentId).map((row) => row.user_id), [TOM.id]);
  assert.deepEqual(db.prepare(`
    SELECT remind_at, created_by FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? ORDER BY created_by
  `).all(childId), [
    { remind_at: '2046-04-02T08:00:00', created_by: MARIA.id },
    { remind_at: '2046-04-02T08:00:00', created_by: TOM.id },
  ]);
});

test('following route copies inherited attachment bytes into an independently owned document', async () => {
  const originalBytes = Buffer.from('independent split attachment');
  const created = await call('POST', '/', {
    actor: MARIA,
    body: {
      title: 'Storage-safe split source',
      start_datetime: '2046-04-20T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      visibility: 'all',
      assigned_to: [MARIA.id],
      attachment_name: 'split-source.txt',
      attachment_data: `data:text/plain;base64,${originalBytes.toString('base64')}`,
    },
  });
  assert.equal(created.status, 201);
  const seriesId = Number(created.body.data.id);
  const originalDocumentId = Number(created.body.data.attachment_document_id);

  const split = await call('PUT', `/${seriesId}/occurrences/2046-04-21/following`, {
    actor: MARIA,
    body: {
      recurrence_rule: 'FREQ=DAILY',
      visibility: 'assignees',
      assigned_to: [TOM.id],
    },
  });

  assert.equal(split.status, 201);
  const successorId = Number(split.body.data.id);
  const clonedDocumentId = Number(split.body.data.attachment_document_id);
  assert.notEqual(clonedDocumentId, originalDocumentId);
  assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
    .get(seriesId).attachment_document_id, originalDocumentId);
  assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
    .get(successorId).attachment_document_id, clonedDocumentId);
  const original = db.prepare(`
    SELECT visibility, content_data, storage_backend, storage_key
    FROM family_documents WHERE id = ?
  `).get(originalDocumentId);
  const cloned = db.prepare(`
    SELECT visibility, content_data, storage_backend, storage_key
    FROM family_documents WHERE id = ?
  `).get(clonedDocumentId);
  assert.equal(original.visibility, 'family');
  assert.equal(cloned.visibility, 'restricted');
  assert.deepEqual(Buffer.from(original.content_data), originalBytes);
  assert.deepEqual(Buffer.from(cloned.content_data), originalBytes);
  assert.equal(original.storage_backend, 'local');
  assert.equal(cloned.storage_backend, 'local');
  assert.deepEqual(db.prepare(`
    SELECT user_id FROM family_document_access WHERE document_id = ? ORDER BY user_id
  `).all(originalDocumentId).map((row) => Number(row.user_id)), []);
  assert.deepEqual(db.prepare(`
    SELECT user_id FROM family_document_access WHERE document_id = ? ORDER BY user_id
  `).all(clonedDocumentId).map((row) => Number(row.user_id)), [TOM.id]);

  db.prepare('DELETE FROM family_documents WHERE id = ?').run(clonedDocumentId);
  assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
    .get(successorId).attachment_document_id, null);
  assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
    .get(seriesId).attachment_document_id, originalDocumentId);
  assert.deepEqual(Buffer.from(db.prepare('SELECT content_data FROM family_documents WHERE id = ?')
    .get(originalDocumentId).content_data), originalBytes);
});

test('first-slot target detachment clones inherited attachments for every standalone orphan', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { deleteDocumentContent, readDocumentContent } = await import(
    '../server/services/document-storage.js'
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-orphan-clones-'));
  const previousEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const previousPath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;
  const originalBytes = Buffer.from('independent orphan attachment');

  try {
    const created = await call('POST', '/', {
      actor: MARIA,
      body: {
        title: 'Outbound orphan source',
        start_datetime: '2054-08-01T09:00:00',
        recurrence_rule: 'FREQ=DAILY',
        visibility: 'private',
        assigned_to: [MARIA.id],
        attachment_name: 'orphan-source.txt',
        attachment_data: `data:text/plain;base64,${originalBytes.toString('base64')}`,
      },
    });
    assert.equal(created.status, 201);
    const seriesId = Number(created.body.data.id);
    const originalDocumentId = Number(created.body.data.attachment_document_id);
    db.prepare("UPDATE family_documents SET visibility = 'private' WHERE id = ?")
      .run(originalDocumentId);

    const familyChild = await call('PUT', `/${seriesId}/occurrences/2054-08-02`, {
      actor: MARIA,
      body: {
        title: 'Family detached child',
        visibility: 'all',
        assigned_to: [MARIA.id],
      },
    });
    const restrictedChild = await call('PUT', `/${seriesId}/occurrences/2054-08-03`, {
      actor: MARIA,
      body: {
        title: 'Restricted detached child',
        visibility: 'assignees',
        assigned_to: [TOM.id],
      },
    });
    assert.equal(familyChild.status, 200);
    assert.equal(restrictedChild.status, 200);

    const conflict = await call('PUT', `/${seriesId}/occurrences/2054-08-01/following`, {
      actor: MARIA,
      body: { target_google_calendar_id: 'family@example.test' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.orphaned_override_count, 2);

    const detached = await call('PUT', `/${seriesId}/occurrences/2054-08-01/following`, {
      actor: MARIA,
      body: {
        target_google_calendar_id: 'family@example.test',
        confirmed_orphan_count: 2,
      },
    });
    assert.equal(detached.status, 200);

    const familyEvent = db.prepare('SELECT * FROM calendar_events WHERE id = ?')
      .get(familyChild.body.data.id);
    const restrictedEvent = db.prepare('SELECT * FROM calendar_events WHERE id = ?')
      .get(restrictedChild.body.data.id);
    const documentIds = [
      originalDocumentId,
      Number(familyEvent.attachment_document_id),
      Number(restrictedEvent.attachment_document_id),
    ];
    assert.equal(new Set(documentIds).size, 3);
    assert.deepEqual(db.prepare(`
      SELECT id, visibility FROM family_documents
      WHERE id IN (?, ?, ?) ORDER BY id
    `).all(...documentIds).map((row) => ({ ...row })), [
      { id: originalDocumentId, visibility: 'private' },
      { id: Number(familyEvent.attachment_document_id), visibility: 'family' },
      { id: Number(restrictedEvent.attachment_document_id), visibility: 'restricted' },
    ]);
    assert.deepEqual(db.prepare(`
      SELECT user_id FROM family_document_access
      WHERE document_id = ? ORDER BY user_id
    `).all(restrictedEvent.attachment_document_id).map((row) => Number(row.user_id)), [TOM.id]);

    const storedDocuments = documentIds.map((id) => db.prepare(
      'SELECT * FROM family_documents WHERE id = ?'
    ).get(id));
    assert.equal(new Set(storedDocuments.map((document) => document.storage_key)).size, 3);
    for (const document of storedDocuments) {
      const content = await readDocumentContent(document);
      assert.deepEqual(content.buffer, originalBytes);
    }

    await deleteDocumentContent(storedDocuments[1]);
    db.prepare('DELETE FROM family_documents WHERE id = ?').run(storedDocuments[1].id);
    assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
      .get(familyEvent.id).attachment_document_id, null);
    assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
      .get(seriesId).attachment_document_id, originalDocumentId);
    assert.equal(db.prepare('SELECT attachment_document_id FROM calendar_events WHERE id = ?')
      .get(restrictedEvent.id).attachment_document_id, restrictedEvent.attachment_document_id);
    for (const document of [storedDocuments[0], storedDocuments[2]]) {
      const content = await readDocumentContent(document);
      assert.deepEqual(content.buffer, originalBytes);
    }
  } finally {
    if (previousEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('whole-series target detachment also clones an inherited orphan attachment', async () => {
  const originalBytes = Buffer.from('whole-series orphan attachment');
  const created = await call('POST', '/', {
    actor: MARIA,
    body: {
      title: 'Whole-series orphan source',
      start_datetime: '2055-08-10T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      assigned_to: [MARIA.id],
      attachment_name: 'whole-series-source.txt',
      attachment_data: `data:text/plain;base64,${originalBytes.toString('base64')}`,
    },
  });
  assert.equal(created.status, 201);
  const seriesId = Number(created.body.data.id);
  const originalDocumentId = Number(created.body.data.attachment_document_id);
  const child = await call('PUT', `/${seriesId}/occurrences/2055-08-11`, {
    actor: MARIA,
    body: { title: 'Whole-series detached child' },
  });
  assert.equal(child.status, 200);

  const response = await call('PUT', `/${seriesId}`, {
    actor: MARIA,
    body: {
      target_google_calendar_id: 'whole-series@example.test',
      confirmed_orphan_count: 1,
    },
  });
  assert.equal(response.status, 200);
  const orphan = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(child.body.data.id);
  assert.equal(orphan.recurrence_parent_id, null);
  assert.notEqual(Number(orphan.attachment_document_id), originalDocumentId);
  assert.deepEqual(Buffer.from(db.prepare(`
    SELECT content_data FROM family_documents WHERE id = ?
  `).get(orphan.attachment_document_id).content_data), originalBytes);
});

test('following orphan-clone rollback removes every staged storage copy', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuvomi-orphan-rollback-'));
  const previousEnabled = process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
  const previousPath = process.env.DOCUMENT_STORAGE_LOCAL_PATH;
  process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'true';
  process.env.DOCUMENT_STORAGE_LOCAL_PATH = dir;

  try {
    const created = await call('POST', '/', {
      actor: MARIA,
      body: {
        title: 'Orphan rollback source',
        start_datetime: '2057-09-01T09:00:00',
        recurrence_rule: 'FREQ=DAILY',
        assigned_to: [MARIA.id],
        attachment_name: 'rollback-source.txt',
        attachment_data: `data:text/plain;base64,${Buffer.from('rollback clones').toString('base64')}`,
      },
    });
    assert.equal(created.status, 201);
    const seriesId = Number(created.body.data.id);
    const child = await call('PUT', `/${seriesId}/occurrences/2057-09-03`, {
      actor: MARIA,
      body: { title: 'Inherited rollback child' },
    });
    assert.equal(child.status, 200);
    db.exec(`
      CREATE TRIGGER fail_second_orphan_document_clone
      BEFORE INSERT ON family_documents
      WHEN NEW.original_name = 'rollback-source.txt'
        AND (SELECT COUNT(*) FROM family_documents
             WHERE original_name = 'rollback-source.txt') >= 2
      BEGIN SELECT RAISE(ABORT, 'orphan document rollback probe'); END;
    `);

    const response = await call('PUT', `/${seriesId}/occurrences/2057-09-02/following`, {
      actor: MARIA,
      body: {
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=SU',
        confirmed_orphan_count: 1,
      },
    });
    assert.equal(response.status, 500);
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    assert.equal(entries.filter((entry) => entry.isFile()).length, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM family_documents
      WHERE original_name = 'rollback-source.txt'
    `).get().count, 1);
    assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
      .get(child.body.data.id).recurrence_parent_id, seriesId);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_second_orphan_document_clone;');
    if (previousEnabled === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_ENABLED;
    else process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;
    else process.env.DOCUMENT_STORAGE_LOCAL_PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('second clone upload failure keeps the storage response after cleaning the first clone', async () => {
  const driveStorage = await import('../server/services/google-drive-storage.js');
  const configKeys = [
    'document_storage_selected_backend',
    'document_storage_google_drive_refresh_token',
    'document_storage_google_drive_folder_id',
  ];
  const previousConfig = new Map(configKeys.map((key) => [
    key,
    db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key)?.value,
  ]));
  const previousEnv = {
    localEnabled: process.env.DOCUMENT_STORAGE_LOCAL_ENABLED,
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
  };
  const uploads = [];
  const deleted = [];

  try {
    process.env.DOCUMENT_STORAGE_LOCAL_ENABLED = 'false';
    db.prepare(`
      INSERT OR REPLACE INTO sync_config (key, value)
      VALUES ('document_storage_selected_backend', 'local')
    `).run();
    const created = await call('POST', '/', {
      actor: MARIA,
      body: {
        title: 'Second clone storage failure',
        start_datetime: '2058-09-01T09:00:00',
        recurrence_rule: 'FREQ=DAILY',
        assigned_to: [MARIA.id],
        attachment_name: 'second-clone.txt',
        attachment_data: `data:text/plain;base64,${Buffer.from('clone contract').toString('base64')}`,
      },
    });
    assert.equal(created.status, 201);
    const seriesId = Number(created.body.data.id);
    const child = await call('PUT', `/${seriesId}/occurrences/2058-09-03`, {
      actor: MARIA,
      body: { title: 'Inherited orphan for failed upload' },
    });
    assert.equal(child.status, 200);

    process.env.GOOGLE_DRIVE_CLIENT_ID = 'route-drive-client';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'route-drive-secret';
    process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://example.test/drive-callback';
    db.exec(`
      INSERT OR REPLACE INTO sync_config (key, value)
      VALUES
        ('document_storage_selected_backend', 'google_drive'),
        ('document_storage_google_drive_refresh_token', 'route-refresh'),
        ('document_storage_google_drive_folder_id', 'documents-folder');
    `);
    driveStorage.__setGoogleApiFactoryForTests({
      createOAuth2: () => ({
        setCredentials() {},
        on() {},
      }),
      createDrive: () => ({
        files: {
          get: async ({ fileId }) => ({
            data: {
              id: fileId,
              name: 'Documents',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
            },
          }),
          create: async () => {
            uploads.push(`attempt-${uploads.length + 1}`);
            if (uploads.length === 2) throw new Error('second clone upload probe');
            return { data: { id: 'first-staged-clone' } };
          },
          delete: async ({ fileId }) => {
            deleted.push(fileId);
            return { data: {} };
          },
        },
      }),
    });

    const response = await call('PUT', `/${seriesId}/occurrences/2058-09-02/following`, {
      actor: MARIA,
      body: {
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
        confirmed_orphan_count: 1,
      },
    });

    assert.equal(uploads.length, 2);
    assert.deepEqual(deleted, ['first-staged-clone']);
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      error: 'Calendar attachment storage upload failed.',
      code: 502,
      storage_code: 'DOCUMENT_STORAGE_UPLOAD_FAILED',
    });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM family_documents
      WHERE original_name = 'second-clone.txt'
    `).get().count, 1);
    assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
      .get(child.body.data.id).recurrence_parent_id, seriesId);
  } finally {
    driveStorage.__setGoogleApiFactoryForTests();
    db.prepare(`
      DELETE FROM sync_config
      WHERE key IN (
        'document_storage_selected_backend',
        'document_storage_google_drive_refresh_token',
        'document_storage_google_drive_folder_id'
      )
    `).run();
    for (const [key, value] of previousConfig) {
      if (value !== undefined) {
        db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
      }
    }
    for (const [name, value] of [
      ['DOCUMENT_STORAGE_LOCAL_ENABLED', previousEnv.localEnabled],
      ['GOOGLE_DRIVE_CLIENT_ID', previousEnv.clientId],
      ['GOOGLE_DRIVE_CLIENT_SECRET', previousEnv.clientSecret],
      ['GOOGLE_DRIVE_REDIRECT_URI', previousEnv.redirectUri],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('occurrence and split responses preserve assignment primary order and projections', async () => {
  db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('#FF9500', TOM.id);
  const cases = [
    ['occurrence', (seriesId) => `/${seriesId}/occurrences/2046-04-11`, 200],
    ['split', (seriesId) => `/${seriesId}/occurrences/2046-04-11/following`, 201],
  ];
  for (const [label, route, status] of cases) {
    const seriesId = insertEvent({
      title: `${label} assignment response`,
      start_datetime: '2046-04-10T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
      created_by: MARIA.id,
      assigned_to: MARIA.id,
    });
    assignEvent(seriesId, MARIA.id);
    const response = await call('PUT', route(seriesId), {
      actor: MARIA,
      body: {
        title: `${label} assigned`,
        assigned_to: [TOM.id, MARIA.id],
        ...(label === 'split' ? { recurrence_rule: 'FREQ=DAILY' } : {}),
      },
    });
    assert.equal(response.status, status, label);
    assert.equal(response.body.data.assigned_to, TOM.id, `${label} primary`);
    assert.equal(response.body.data.assigned_name, 'Tom', `${label} primary name`);
    assert.equal(response.body.data.assigned_color, '#FF9500', `${label} primary color`);
    assert.deepEqual(response.body.data.assigned_users.map((user) => ({
      id: user.id,
      display_name: user.display_name,
      color: user.color,
    })), [
      { id: MARIA.id, display_name: 'Maria', color: '#34C759' },
      { id: TOM.id, display_name: 'Tom', color: '#FF9500' },
    ], `${label} full assignment projection`);
  }
});

test('first-visible following edits preserve off-rule DTSTART and reminder anchors', async () => {
  for (const fixture of [
    {
      label: 'month end',
      start: '2046-01-15T09:00:00',
      end: '2046-01-15T10:00:00',
      recurrenceId: '2046-01-31',
      displayedStart: '2046-01-31T09:00:00',
      displayedEnd: '2046-01-31T10:00:00',
      rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    },
    {
      label: 'weekday',
      start: '2046-01-03T09:00:00',
      end: '2046-01-03T10:00:00',
      recurrenceId: '2046-01-08',
      displayedStart: '2046-01-08T09:00:00',
      displayedEnd: '2046-01-08T10:00:00',
      rule: 'FREQ=WEEKLY;BYDAY=MO',
    },
  ]) {
    const seriesId = Number(insertEvent({
      title: `Off-rule ${fixture.label}`,
      start_datetime: fixture.start,
      end_datetime: fixture.end,
      recurrence_rule: fixture.rule,
    }));
    db.prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('event', ?, ?, ?)
    `).run(seriesId, fixture.start.replace('09:00:00', '08:00:00'), ADMIN.id);

    const response = await call(
      'PUT',
      `/${seriesId}/occurrences/${fixture.recurrenceId}/following`,
      { body: {
        start_datetime: fixture.displayedStart,
        end_datetime: fixture.displayedEnd,
        recurrence_rule: fixture.rule,
      } },
    );
    assert.equal(response.status, 200, fixture.label);
    assert.deepEqual({ ...db.prepare(`
      SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?
    `).get(seriesId) }, {
      start_datetime: fixture.start,
      end_datetime: fixture.end,
    }, `${fixture.label}: persisted anchor`);
    assert.equal(db.prepare(`
      SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
    `).get(seriesId).remind_at, fixture.start.replace('09:00:00', '08:00:00'),
    `${fixture.label}: reminder anchor`);

    const edited = await call(
      'PUT',
      `/${seriesId}/occurrences/${fixture.recurrenceId}/following`,
      { body: {
        start_datetime: fixture.displayedStart.replace('09:00:00', '11:00:00'),
        end_datetime: fixture.displayedEnd.replace('10:00:00', '12:00:00'),
        recurrence_rule: fixture.rule,
      } },
    );
    assert.equal(edited.status, 200, `${fixture.label}: edited`);
    assert.deepEqual({ ...db.prepare(`
      SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?
    `).get(seriesId) }, {
      start_datetime: fixture.start.replace('09:00:00', '11:00:00').slice(0, 16),
      end_datetime: fixture.end.replace('10:00:00', '12:00:00').slice(0, 16),
    }, `${fixture.label}: edited anchor delta`);
    assert.equal(db.prepare(`
      SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
    `).get(seriesId).remind_at, fixture.start.replace('09:00:00', '10:00:00'),
    `${fixture.label}: edited reminder anchor`);
  }
});

test('first-visible following edits preserve submitted all-day and timed representations', async () => {
  for (const fixture of [
    {
      label: 'all-day to timed',
      initialAllDay: 1,
      start: '2046-01-15',
      end: '2046-01-16',
      submittedStart: '2046-01-31T09:30',
      submittedEnd: '2046-02-01T10:45',
      allDay: false,
      expectedStart: '2046-01-15T09:30',
      expectedEnd: '2046-01-16T10:45',
    },
    {
      label: 'timed to all-day',
      initialAllDay: 0,
      start: '2046-01-15T09:00',
      end: '2046-01-15T10:00',
      submittedStart: '2046-01-31',
      submittedEnd: '2046-01-31',
      allDay: true,
      expectedStart: '2046-01-15',
      expectedEnd: '2046-01-15',
    },
  ]) {
    const seriesId = Number(insertEvent({
      title: fixture.label,
      start_datetime: fixture.start,
      end_datetime: fixture.end,
      all_day: fixture.initialAllDay,
      recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    }));
    const response = await call('PUT', `/${seriesId}/occurrences/2046-01-31/following`, {
      body: {
        start_datetime: fixture.submittedStart,
        end_datetime: fixture.submittedEnd,
        all_day: fixture.allDay,
        recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
      },
    });
    assert.equal(response.status, 200, fixture.label);
    assert.deepEqual({ ...db.prepare(`
      SELECT start_datetime, end_datetime, all_day FROM calendar_events WHERE id = ?
    `).get(seriesId) }, {
      start_datetime: fixture.expectedStart,
      end_datetime: fixture.expectedEnd,
      all_day: fixture.allDay ? 1 : 0,
    }, fixture.label);
  }
});

test('occurrence mutation routes reject schema-invalid values before persistence', async () => {
  const invalidBodies = [
    { title: null },
    { title: '   ' },
    { start_datetime: null },
    { start_datetime: '' },
    { start_datetime: '2046-02-31T09:00' },
    { start_datetime: '2046-06-02T25:00' },
    { start_datetime: '2046-06-02T09:99' },
    { end_datetime: '' },
    { end_datetime: '2046-02-31' },
    { all_day: 'false' },
    { countdown: 1 },
    { assigned_to: 0 },
    { assigned_to: '3' },
    { assigned_to: [TOM.id, TOM.id] },
    { assigned_to: [999999] },
    { reminder_offsets: [30, 30] },
  ];
  for (const suffix of ['', '/following']) {
    for (const body of invalidBodies) {
      const seriesId = Number(insertEvent({
        title: 'Strict occurrence input',
        start_datetime: '2046-06-01T09:00:00',
        end_datetime: '2046-06-01T10:00:00',
        recurrence_rule: 'FREQ=DAILY',
      }));
      const response = await call('PUT', `/${seriesId}/occurrences/2046-06-02${suffix}`, {
        body,
      });
      assert.equal(response.status, 400, `${suffix || '/only'} ${JSON.stringify(body)}`);
      assert.doesNotMatch(response.body.error, /\bmust\b|unknown user ID|duplicate user IDs/);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?
      `).get(seriesId).count, 0);
    }
  }
});

test('a partial occurrence move cannot persist an inverted interval or disappear from reads', async () => {
  const seriesId = Number(insertEvent({
    title: 'Interval guard',
    start_datetime: '2046-07-01T09:00:00',
    end_datetime: '2046-07-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const response = await call('PUT', `/${seriesId}/occurrences/2046-07-02`, {
    body: { start_datetime: '2046-07-03T11:00:00' },
  });
  assert.equal(response.status, 400);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?
  `).get(seriesId).count, 0);

  const range = await call('GET', '/?from=2046-07-02&to=2046-07-02');
  assert.ok(range.body.data.some((event) => Number(event.series_id) === seriesId
    && event.recurrence_id === '2046-07-02'));
});

test('DELETE occurrence scopes keep only-this suppression and truncate following state', async () => {
  const onlyId = insertEvent({
    title: 'Delete only',
    start_datetime: '2046-05-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${onlyId}/occurrences/2046-05-02`, { body: { title: 'Edited only' } });
  const only = await call('DELETE', `/${onlyId}/occurrences/2046-05-02`);
  assert.equal(only.status, 204);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(onlyId).count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM calendar_event_exceptions
    WHERE event_id = ? AND exception_date = '2046-05-02'
  `).get(onlyId).count, 1);

  const followingId = insertEvent({
    title: 'Delete following',
    start_datetime: '2046-06-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  for (const recurrenceId of ['2046-06-02', '2046-06-03']) {
    await call('PUT', `/${followingId}/occurrences/${recurrenceId}`, {
      body: { title: `Edited ${recurrenceId}` },
    });
  }
  const following = await call('DELETE', `/${followingId}/occurrences/2046-06-03/following`);
  assert.equal(following.status, 204);
  assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(followingId).recurrence_rule, 'FREQ=DAILY;UNTIL=20460602');
  assert.deepEqual(db.prepare(`
    SELECT recurrence_id FROM calendar_events
    WHERE recurrence_parent_id = ? ORDER BY recurrence_id
  `).all(followingId).map((row) => row.recurrence_id), ['2046-06-02']);
});

test('following delete from the first slot and whole-series delete cascade linked state', async () => {
  const firstId = insertEvent({
    title: 'Delete from first',
    start_datetime: '2046-07-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${firstId}/occurrences/2046-07-02`, { body: { title: 'Child' } });
  const first = await call('DELETE', `/${firstId}/occurrences/2046-07-01/following`);
  assert.equal(first.status, 204);
  assert.equal(db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(firstId), undefined);

  const wholeId = insertEvent({
    title: 'Delete whole',
    start_datetime: '2046-08-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  const child = await call('PUT', `/${wholeId}/occurrences/2046-08-02`, {
    body: { title: 'Whole child', reminder_offsets: [60] },
  });
  const childId = Number(child.body.data.id);
  assert.equal((await call('DELETE', `/${wholeId}`)).status, 204);
  assert.equal(db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(childId), undefined);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM reminders
    WHERE entity_type = 'event' AND entity_id IN (?, ?)
  `).get(wholeId, childId).count, 0);
});

test('PUT occurrence following creates a successor and reparents future replacements', async () => {
  const seriesId = insertEvent({
    title: 'Split old',
    start_datetime: '2046-09-01T09:00:00',
    end_datetime: '2046-09-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-09-02`, { body: { title: 'Split new' } });
  await call('PUT', `/${seriesId}/occurrences/2046-09-03`, { body: { description: 'Future note' } });

  const split = await call('PUT', `/${seriesId}/occurrences/2046-09-02/following`, {
    body: {
      title: 'Split new',
      start_datetime: '2046-09-02T09:00:00',
      end_datetime: '2046-09-02T10:00:00',
      recurrence_rule: 'FREQ=DAILY',
    },
  });

  assert.equal(split.status, 201);
  const successorId = Number(split.body.data.id);
  assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY;UNTIL=20460901');
  assert.equal(db.prepare(`
    SELECT recurrence_parent_id FROM calendar_events WHERE recurrence_id = '2046-09-03'
  `).get().recurrence_parent_id, successorId);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events
    WHERE recurrence_parent_id = ? AND recurrence_id = '2046-09-02'
  `).get(successorId).count, 0);
});

test('whole-series rule update requires the exact orphan count and detaches confirmed rows', async () => {
  const seriesId = insertEvent({
    title: 'Orphan route',
    start_datetime: '2046-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-10-02`, {
    body: { title: 'Orphaned Friday' },
  });
  await call('PUT', `/${seriesId}/occurrences/2046-10-08`, {
    body: { title: 'Still Thursday' },
  });
  db.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)
  `).run(seriesId, '2046-10-04');

  const first = await call('PUT', `/${seriesId}`, {
    body: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' },
  });
  assert.equal(first.status, 409);
  assert.deepEqual(first.body, {
    error: 'Die Änderung benötigt eine aktuelle Bestätigung. Prüfe die Anzahl der betroffenen Einzelausnahmen und bestätige, dass sie als eigenständige Termine erhalten bleiben sollen.',
    code: 409,
    conflict: 'calendar_override_orphans',
    orphaned_override_count: 1,
  });

  const stale = await call('PUT', `/${seriesId}`, {
    body: {
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      confirmed_orphan_count: 0,
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.orphaned_override_count, 1);
  assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY');

  const confirmed = await call('PUT', `/${seriesId}`, {
    body: {
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      confirmed_orphan_count: 1,
    },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(db.prepare(`
    SELECT recurrence_parent_id FROM calendar_events WHERE title = 'Orphaned Friday'
  `).get().recurrence_parent_id, null);
  assert.equal(db.prepare(`
    SELECT recurrence_parent_id FROM calendar_events WHERE title = 'Still Thursday'
  `).get().recurrence_parent_id, seriesId);
  assert.deepEqual(db.prepare(`
    SELECT exception_date FROM calendar_event_exceptions
    WHERE event_id = ? ORDER BY exception_date
  `).all(seriesId).map((row) => row.exception_date), [
    '2046-10-02',
    '2046-10-04',
    '2046-10-08',
  ]);
});

test('visible non-owner keeps generic whole-series edit and delete authorization after children exist', async () => {
  const seriesId = insertEvent({
    title: 'Shared non-owner series',
    start_datetime: '2046-10-12T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: MARIA.id,
    visibility: 'all',
  });
  const beforeChild = await call('PUT', `/${seriesId}`, {
    actor: TOM,
    body: { title: 'Shared non-owner before child' },
  });
  assert.equal(beforeChild.status, 200);

  const childId = insertEvent({
    title: 'Shared non-owner occurrence',
    start_datetime: '2046-10-13T09:00:00',
    recurrence_parent_id: seriesId,
    recurrence_id: '2046-10-13',
    overridden_fields: '["title"]',
    created_by: MARIA.id,
  });
  const afterChild = await call('PUT', `/${seriesId}`, {
    actor: TOM,
    body: { title: 'Shared non-owner after child' },
  });
  assert.equal(afterChild.status, 200);
  assert.equal(afterChild.body.data.title, 'Shared non-owner after child');
  assert.equal(afterChild.body.data.series_id, seriesId);
  assert.equal(afterChild.body.data.recurrence_id, '2046-10-12');
  assert.equal(afterChild.body.data.is_local_recurring_series, true);
  assert.equal(afterChild.body.data.can_override_occurrence, true);
  assert.equal(db.prepare('SELECT title FROM calendar_events WHERE id = ?').get(childId).title,
    'Shared non-owner occurrence');

  const deleted = await call('DELETE', `/${seriesId}`, { actor: TOM });
  assert.equal(deleted.status, 204);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events WHERE id = ? OR recurrence_parent_id = ?
  `).get(seriesId, seriesId).count, 0);
});

test('setting an Outlook owner with an unpushable target preserves linked occurrence editing', async () => {
  for (const selection of [{ enabled: 0, canEdit: 1 }, { enabled: 1, canEdit: 0 }, null]) {
    const accountId = db.prepare(`INSERT INTO outlook_accounts
      (name, access_token, refresh_token, auto_sync_calendar_id)
      VALUES ('Inactive target edit guard', 'token', 'refresh', 'inactive-target')`).run().lastInsertRowid;
    if (selection) db.prepare(`INSERT INTO outlook_calendar_selection
      (account_id, calendar_id, calendar_name, enabled, can_edit)
      VALUES (?, 'inactive-target', 'Inactive target', ?, ?)`)
      .run(accountId, selection.enabled, selection.canEdit);
    const seriesId = insertEvent({
      title: 'Inactive target series', start_datetime: '2046-10-01T09:00:00',
      recurrence_rule: 'FREQ=DAILY', visibility: 'all',
    });
    const created = await call('PUT', `/${seriesId}/occurrences/2046-10-02`, {
      body: { title: 'Linked before owner change' },
    });
    assert.equal(created.status, 200);
    const accountUpdated = await call('PUT', `/outlook/accounts/${accountId}`, {
      body: { ownerUserId: MARIA.id },
    });
    assert.equal(accountUpdated.status, 200);
    const read = await call('GET', `/${seriesId}`);
    assert.equal(read.body.data.can_override_occurrence, true);
    assert.equal(read.body.data.can_detach_occurrence, false);
    const editedSeries = await call('PUT', `/${seriesId}`, { body: { title: 'Series still editable' } });
    assert.equal(editedSeries.status, 200);
    const editedChild = await call('PUT', `/${seriesId}/occurrences/2046-10-02`, {
      body: { title: 'Linked after owner change' },
    });
    assert.equal(editedChild.status, 200);
    assert.equal(editedChild.body.data.series_id, seriesId);
    assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
      .get(editedChild.body.data.id).recurrence_parent_id, seriesId);
    assert.equal(editedChild.body.data.can_override_occurrence, true);
    assert.equal(editedChild.body.data.can_detach_occurrence, false);
    db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(seriesId);
  }
});

test('whole-series Outlook auto-sync visibility and assignment transitions require exact detach confirmation', async () => {
  const accountId = db.prepare(`
    INSERT INTO outlook_accounts
      (name, access_token, refresh_token, needs_reauth, auto_sync_calendar_id, owner_user_id)
    VALUES ('Configured reauth target', 'token', 'refresh', 1, 'configured-cal', ?)
  `).run(TOM.id).lastInsertRowid;
  db.prepare(`INSERT INTO outlook_calendar_selection
    (account_id, calendar_id, calendar_name, can_edit, enabled)
    VALUES (?, 'configured-cal', 'Configured', 1, 1)`).run(accountId);

  const privateMasterId = insertEvent({
    title: 'Private transition',
    start_datetime: '2046-10-20T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: ADMIN.id,
    visibility: 'private',
  });
  const privateChildId = insertEvent({
    title: 'Private transition occurrence',
    start_datetime: '2046-10-21T09:00:00',
    recurrence_parent_id: privateMasterId,
    recurrence_id: '2046-10-21',
    overridden_fields: '["title"]',
  });

  const visibilityConflict = await call('PUT', `/${privateMasterId}`, {
    actor: ADMIN,
    body: { visibility: 'all' },
  });
  assert.equal(visibilityConflict.status, 409);
  assert.equal(visibilityConflict.body.orphaned_override_count, 1);
  assert.equal(db.prepare('SELECT visibility FROM calendar_events WHERE id = ?')
    .get(privateMasterId).visibility, 'private');

  const visibilityConfirmed = await call('PUT', `/${privateMasterId}`, {
    actor: ADMIN,
    body: { visibility: 'all', confirmed_orphan_count: 1 },
  });
  assert.equal(visibilityConfirmed.status, 200);
  assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(privateChildId).recurrence_parent_id, null);

  const assigneeMasterId = insertEvent({
    title: 'Assignee transition',
    start_datetime: '2046-10-25T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
    created_by: ADMIN.id,
    visibility: 'assignees',
  });
  assignEvent(assigneeMasterId, ADMIN.id);
  const assigneeChildId = insertEvent({
    title: 'Assignee transition occurrence',
    start_datetime: '2046-10-26T09:00:00',
    recurrence_parent_id: assigneeMasterId,
    recurrence_id: '2046-10-26',
    overridden_fields: '["title"]',
  });

  const assignmentConflict = await call('PUT', `/${assigneeMasterId}`, {
    actor: ADMIN,
    body: { assigned_to: [TOM.id] },
  });
  assert.equal(assignmentConflict.status, 409);
  assert.equal(assignmentConflict.body.orphaned_override_count, 1);
  assert.deepEqual(db.prepare(
    'SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id'
  ).all(assigneeMasterId).map((row) => row.user_id), [ADMIN.id]);

  const assignmentConfirmed = await call('PUT', `/${assigneeMasterId}`, {
    actor: ADMIN,
    body: { assigned_to: [TOM.id], confirmed_orphan_count: 1 },
  });
  assert.equal(assignmentConfirmed.status, 200);
  assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(assigneeChildId).recurrence_parent_id, null);

  db.prepare('DELETE FROM outlook_accounts WHERE id = ?').run(accountId);
});

test('whole-series stale orphan confirmation is rejected after the count reaches zero', async () => {
  const seriesId = insertEvent({
    title: 'Zero orphan retry',
    start_datetime: '2046-10-10T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-10-11`, {
    body: { title: 'Temporary override' },
  });
  await call('PUT', `/${seriesId}/occurrences/2046-10-11`, {
    body: { title: 'Zero orphan retry' },
  });

  const response = await call('PUT', `/${seriesId}`, {
    body: {
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
      confirmed_orphan_count: 1,
    },
  });
  assert.deepEqual(response, {
    status: 409,
    body: {
      error: 'Die Änderung benötigt eine aktuelle Bestätigung. Prüfe die Anzahl der betroffenen Einzelausnahmen und bestätige, dass sie als eigenständige Termine erhalten bleiben sollen.',
      code: 409,
      conflict: 'calendar_override_orphans',
      orphaned_override_count: 0,
    },
  });
  assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY');
});

test('first-slot following update returns and accepts the exact orphan confirmation', async () => {
  const seriesId = insertEvent({
    title: 'First following confirmation',
    start_datetime: '2046-10-16T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-10-17`, {
    body: { title: 'Child to detach' },
  });
  const route = `/${seriesId}/occurrences/2046-10-16/following`;
  const body = { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' };

  const first = await call('PUT', route, { body });
  assert.deepEqual(first, {
    status: 409,
    body: {
      error: 'Die Änderung benötigt eine aktuelle Bestätigung. Prüfe die Anzahl der betroffenen Einzelausnahmen und bestätige, dass sie als eigenständige Termine erhalten bleiben sollen.',
      code: 409,
      conflict: 'calendar_override_orphans',
      orphaned_override_count: 1,
    },
  });
  const invalid = await call('PUT', route, {
    body: { ...body, confirmed_orphan_count: '1' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 400);

  const confirmed = await call('PUT', route, {
    body: { ...body, confirmed_orphan_count: 1 },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.recurrence_rule, body.recurrence_rule);
  assert.equal(db.prepare(`
    SELECT recurrence_parent_id FROM calendar_events WHERE title = 'Child to detach'
  `).get().recurrence_parent_id, null);
});

test('whole-series outbound transition confirms detachment before setting the target', async () => {
  const seriesId = insertEvent({
    title: 'Outbound detach route',
    start_datetime: '2046-11-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-11-02`, {
    body: { title: 'Outbound edited occurrence' },
  });

  const first = await call('PUT', `/${seriesId}`, {
    body: { target_google_calendar_id: 'family@test' },
  });
  assert.equal(first.status, 409);
  assert.equal(first.body.orphaned_override_count, 1);
  assert.equal(db.prepare('SELECT target_google_calendar_id FROM calendar_events WHERE id = ?')
    .get(seriesId).target_google_calendar_id, null);

  const confirmed = await call('PUT', `/${seriesId}`, {
    body: {
      target_google_calendar_id: 'family@test',
      confirmed_orphan_count: 1,
    },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.target_google_calendar_id, 'family@test');
  assert.equal(db.prepare(`
    SELECT recurrence_parent_id FROM calendar_events
    WHERE title = 'Outbound edited occurrence'
  `).get().recurrence_parent_id, null);
});

test('following route validates and persists a selected target with exact future-child detachment', async () => {
  const seriesId = insertEvent({
    title: 'Following target route',
    start_datetime: '2046-11-10T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  await call('PUT', `/${seriesId}/occurrences/2046-11-11`, {
    body: { title: 'Selected successor' },
  });
  const future = await call('PUT', `/${seriesId}/occurrences/2046-11-12`, {
    body: { title: 'Future detached child' },
  });
  const path = `/${seriesId}/occurrences/2046-11-11/following`;
  const body = { target_google_calendar_id: 'family@test' };

  const conflict = await call('PUT', path, { body });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.orphaned_override_count, 1);
  const confirmed = await call('PUT', path, {
    body: { ...body, confirmed_orphan_count: 1 },
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.data.target_google_calendar_id, 'family@test');
  assert.equal(db.prepare('SELECT target_google_calendar_id FROM calendar_events WHERE id = ?')
    .get(seriesId).target_google_calendar_id, null);
  assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(future.body.data.id).recurrence_parent_id, null);
});

test('first-slot following target selection delegates through exact detachment confirmation', async () => {
  const seriesId = insertEvent({
    title: 'First target delegation',
    start_datetime: '2046-11-15T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  const future = await call('PUT', `/${seriesId}/occurrences/2046-11-16`, {
    body: { title: 'First target detached child' },
  });
  const path = `/${seriesId}/occurrences/2046-11-15/following`;

  const conflict = await call('PUT', path, {
    body: { target_outlook_account_id: 9, target_outlook_calendar_id: 'calendar-9' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.orphaned_override_count, 1);
  const confirmed = await call('PUT', path, {
    body: {
      target_outlook_account_id: 9,
      target_outlook_calendar_id: 'calendar-9',
      confirmed_orphan_count: 1,
    },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.id, seriesId);
  assert.equal(confirmed.body.data.target_outlook_account_id, 9);
  assert.equal(confirmed.body.data.target_outlook_calendar_id, 'calendar-9');
  assert.equal(db.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(future.body.data.id).recurrence_parent_id, null);
});

test('following route accepts explicit target clear and rejects malformed provider pairs before splitting', async () => {
  const cases = [
    { target_google_calendar_id: 'x'.repeat(2049) },
    { target_caldav_account_id: 7 },
    { target_outlook_account_id: 8 },
  ];
  for (const body of cases) {
    const seriesId = insertEvent({
      title: 'Invalid target split',
      start_datetime: '2046-11-20T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
    });
    const response = await call('PUT', `/${seriesId}/occurrences/2046-11-21/following`, { body });
    assert.equal(response.status, 400);
    assert.equal(db.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
      .get(seriesId).recurrence_rule, 'FREQ=DAILY');
  }

  const clearSeriesId = insertEvent({
    title: 'Explicit local successor',
    start_datetime: '2046-11-25T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  });
  const cleared = await call('PUT', `/${clearSeriesId}/occurrences/2046-11-26/following`, {
    body: {
      target_google_calendar_id: null,
      target_caldav_account_id: null,
      target_caldav_calendar_url: null,
      target_outlook_account_id: null,
      target_outlook_calendar_id: null,
    },
  });
  assert.equal(cleared.status, 201);
  for (const field of [
    'target_google_calendar_id',
    'target_caldav_account_id',
    'target_caldav_calendar_url',
    'target_outlook_account_id',
    'target_outlook_calendar_id',
  ]) assert.equal(cleared.body.data[field], null, `${field} was not cleared`);
});

// ════════════════════════════════════════════════════════════════════════════════
// DELETE /:id
// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
// Schreibrechte folgen der Sichtbarkeit (GHSA-fmrw-mmjw-5v9c)
// ════════════════════════════════════════════════════════════════════════════════
// PUT und DELETE luden den Termin nur per ID. Ein Mitglied konnte einen fremden
// privaten Termin umschreiben (die Antwort trug die Beschreibung, die GET ihm
// verweigert), per visibility='all' dauerhaft sichtbar machen oder loeschen.
// Die Antwort ist 404 wie bei GET und bei den Aufgaben - kein 403, das die
// Existenz verriete. Kein Admin-Bypass (#474).

test('PUT /:id — fremder privater Termin: 404, nichts geaendert, nichts geleakt', async () => {
  const id = insertEvent({ title: 'Therapie', start_datetime: '2035-09-01T09:00', created_by: TOM.id, visibility: 'private' });
  db.prepare('UPDATE calendar_events SET description = ? WHERE id = ?').run('GEHEIM-BESCHREIBUNG', id);

  const put = await call('PUT', `/${id}`, { actor: MARIA, body: { title: 'Von Maria', start_datetime: '2035-09-01T09:00' } });
  assert.equal(put.status, 404, `erwartet 404, bekommen ${put.status}`);
  assert.equal(JSON.stringify(put.body).includes('GEHEIM-BESCHREIBUNG'), false, 'die Antwort darf nichts vom Termin tragen');

  // Sichtbarmachen als Angriffskette: erst PUT visibility=all, dann GET.
  const unhide = await call('PUT', `/${id}`, { actor: MARIA, body: { title: 'x', start_datetime: '2035-09-01T09:00', visibility: 'all' } });
  assert.equal(unhide.status, 404);
  const get = await call('GET', `/${id}`, { actor: MARIA });
  assert.equal(get.status, 404, 'nach dem Versuch bleibt der Termin verborgen');

  const row = db.prepare('SELECT title, visibility FROM calendar_events WHERE id = ?').get(id);
  assert.deepEqual(row, { title: 'Therapie', visibility: 'private' }, 'die Zeile ist unveraendert');

  // Kein Admin-Bypass: dieselbe Antwort fuer den Admin.
  const admin = await call('PUT', `/${id}`, { actor: ADMIN, body: { title: 'Admin', start_datetime: '2035-09-01T09:00' } });
  assert.equal(admin.status, 404);

  // Die Erstellerin selbst darf weiter.
  const own = await call('PUT', `/${id}`, { actor: TOM, body: { title: 'Therapie (neu)', start_datetime: '2035-09-01T09:00' } });
  assert.equal(own.status, 200);
});

test('DELETE /:id — fremder privater Termin: 404, Zeile bleibt', async () => {
  const id = insertEvent({ title: 'Ueberraschung', start_datetime: '2035-09-02T09:00', created_by: TOM.id, visibility: 'private' });
  const del = await call('DELETE', `/${id}`, { actor: MARIA });
  assert.equal(del.status, 404, `erwartet 404, bekommen ${del.status}`);
  const admin = await call('DELETE', `/${id}`, { actor: ADMIN });
  assert.equal(admin.status, 404, 'kein Admin-Bypass');
  assert.ok(db.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(id), 'der Termin existiert noch');
  const own = await call('DELETE', `/${id}`, { actor: TOM });
  assert.equal(own.status, 204);
});

test('PUT/DELETE /:id — assignees: nur Zugewiesene und Ersteller, wie bei GET', async () => {
  const id = insertEvent({ title: 'Nur-Zugewiesene', start_datetime: '2035-09-03T09:00', created_by: TOM.id, visibility: 'assignees' });
  const before = await call('PUT', `/${id}`, { actor: MARIA, body: { title: 'x', start_datetime: '2035-09-03T09:00' } });
  assert.equal(before.status, 404, 'ohne Zuweisung unsichtbar');
  assignEvent(id, MARIA.id);
  const after = await call('PUT', `/${id}`, { actor: MARIA, body: { title: 'Von Maria', start_datetime: '2035-09-03T09:00' } });
  assert.equal(after.status, 200, 'als Zugewiesene darf sie aendern');
  const del = await call('DELETE', `/${id}`, { actor: MARIA });
  assert.equal(del.status, 204, 'und loeschen');
});

test('DELETE /:id — 404 + 204', async () => {
  assert.equal((await call('DELETE', '/9999999')).status, 404);
  const id = insertEvent({ title: 'TO-DELETE', start_datetime: '2043-01-01T09:00' });
  assert.equal((await call('DELETE', `/${id}`)).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE id=?').get(id).n, 0);
});

test('POST / — der gespeicherte Start bleibt stehen, das erste Vorkommen ist der Monatsletzte (#960)', async () => {
  // GEPRUEFT WIRD UEBER DIE EXPANSION, NICHT UEBER DIE SPALTE. Dass der Server
  // das Datum in Ruhe laesst, ist nur die halbe Zusage - die andere ist, dass
  // trotzdem der 31. der erste Termin ist. Beides steht deshalb in EINEM Test:
  // wuerde die Route wieder anfangen zu ziehen, faellt die erste Zusage; ginge
  // die Expansion verloren, die zweite.
  const r = await call('POST', '/', {
    body: {
      title: 'SERIE-MONATSLETZTER', start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T11:00',
      recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    },
  });
  assert.equal(r.status, 201);
  assert.match(r.body.data.start_datetime, /^2026-01-15/,
    `der Server aendert das eingegebene Datum nicht: ${r.body.data.start_datetime}`);
  assert.match(r.body.data.end_datetime, /^2026-01-15T11:00/, 'und das Ende ebensowenig');

  const fenster = await call('GET', '/?from=2026-01-01&to=2026-04-30');
  const tage = fenster.body.data
    .filter((e) => e.title === 'SERIE-MONATSLETZTER')
    .map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(tage, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
    `der 15. ist kein Vorkommen der Regel: ${tage.join(', ')}`);
});

test('POST / — eine Regel ohne jedes Vorkommen wird abgelehnt', async () => {
  // FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120 ab dem 15. Januar: der erste
  // Monatsletzte liegt hinter dem UNTIL. Gespeichert waere das ein Termin, den
  // niemand je zu sehen bekaeme - eine leere Serie, kein Termin am 15.
  const r = await call('POST', '/', {
    body: {
      title: 'Nie', start_datetime: '2026-01-15T09:00',
      recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120',
    },
  });
  assert.equal(r.status, 400, `erwartet 400, bekommen ${r.status}`);
});

test('PUT / — die Regel nachtraeglich ankreuzen verschiebt den Termin nicht (#960)', async () => {
  // Der Server hat den Serienstart einmal beim Speichern auf die Regel gezogen.
  // Das ist zurueckgenommen: `start_datetime` haengt an der Erinnerung, am
  // optimistischen Render und am Ende des Termins, und keine dieser Stellen
  // erfaehrt von einer Verschiebung, die erst in der Route passiert.
  const angelegt = await call('POST', '/', {
    body: { title: 'SERIE-NACHTRAEGLICH', start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T11:00' },
  });
  assert.equal(angelegt.status, 201);

  const bearbeitet = await call('PUT', `/${angelegt.body.data.id}`, {
    body: { recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
  });
  assert.equal(bearbeitet.status, 200);
  assert.match(bearbeitet.body.data.start_datetime, /^2026-01-15/,
    `der Start bleibt, wo er stand: ${bearbeitet.body.data.start_datetime}`);
  assert.match(bearbeitet.body.data.end_datetime, /^2026-01-15T11:00/, 'das Ende ebenso');

  const fenster = await call('GET', '/?from=2026-01-01&to=2026-02-28');
  const tage = fenster.body.data
    .filter((e) => e.title === 'SERIE-NACHTRAEGLICH')
    .map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(tage, ['2026-01-31', '2026-02-28'], `bekommen: ${tage.join(', ')}`);
});

test('PUT / — an einer vorher schon leeren Serie laesst sich der Titel aendern', async () => {
  // DIE PRAESENZ EINES FELDES IST KEINE AENDERUNG. Das Formular schickt bei
  // jedem Speichern `start_datetime` UND `recurrence_rule` mit, auch wenn nur
  // der Titel angefasst wurde. Wer danach fragt, ob das Feld dabei war, bekommt
  // immer ja - und der Guard unten wuerde jede Bearbeitung dieses Datensatzes
  // mit 400 abweisen. Verglichen werden deshalb die WERTE.
  const angelegt = await call('POST', '/', {
    body: { title: 'Leere Serie', start_datetime: '2026-01-15T09:00' },
  });
  const id = angelegt.body.data.id;
  // Am Guard vorbei in die Zeile schreiben, wie es der Sync tut.
  db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120', id);

  const nurTitel = await call('PUT', `/${id}`, {
    body: { title: 'Neuer Titel', start_datetime: '2026-01-15T09:00', recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120' },
  });
  assert.equal(nurTitel.status, 200, `ein Titel-Edit darf nicht scheitern, bekommen ${nurTitel.status}`);
  assert.equal(nurTitel.body.data.title, 'Neuer Titel');

  // Wer die Serie WIRKLICH anfasst und sie damit leer macht, bekommt weiter 400.
  const leerGemacht = await call('PUT', `/${id}`, {
    body: { recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260118' },
  });
  assert.equal(leerGemacht.status, 400, `erwartet 400, bekommen ${leerGemacht.status}`);
});

test('PUT / — ein Titel-Edit laesst eine eingelesene Serie in Ruhe (#756)', async () => {
  // Eine aus einem Fremdkalender eingelesene Serie darf einen absichtlich
  // unsynchronisierten Start haben. Er bleibt in jedem Fall stehen.
  const angelegt = await call('POST', '/', {
    body: { title: 'Fremd', start_datetime: '2026-01-15T09:00', end_datetime: '2026-01-15T10:00' },
  });
  const id = angelegt.body.data.id;
  db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1', id);

  const nurTitel = await call('PUT', `/${id}`, { body: { title: 'Neuer Titel' } });
  assert.equal(nurTitel.status, 200);
  assert.match(nurTitel.body.data.start_datetime, /^2026-01-15/,
    `der Start darf sich nicht bewegen: ${nurTitel.body.data.start_datetime}`);
});

test('PUT / — die Wiederholung abschalten wird nicht gegen die alte Regel geprueft', async () => {
  // `recurrence_rule` steht als einziges der Serienfelder NICHT unter COALESCE:
  // `null` loescht die Regel. Wurde der Guard trotzdem gegen die gespeicherte
  // Regel gerechnet, wies er das Abschalten mit 400 ab - fuer eine Serie, die
  // es nach dem Speichern gar nicht mehr gibt.
  const angelegt = await call('POST', '/', {
    body: { title: 'Abschalten', start_datetime: '2026-01-15T09:00' },
  });
  const id = angelegt.body.data.id;
  db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
    .run('FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260120', id);

  const aus = await call('PUT', `/${id}`, {
    body: { recurrence_rule: null, start_datetime: '2026-01-16T09:00' },
  });
  assert.equal(aus.status, 200, `das Abschalten darf nicht scheitern, bekommen ${aus.status}`);
  assert.equal(aus.body.data.recurrence_rule, null, 'die Regel ist geloescht');
  assert.match(aus.body.data.start_datetime, /^2026-01-16/, 'und das neue Datum steht');
});

test('PUT / — eine Serie mit eigener Zone wird an ihrem Ortstag geprueft', async () => {
  // 31. Januar 20:00 in New York steht als 1. Februar 01:00 UTC in der Zeile.
  // Fuer "am letzten Tag des Monats" zaehlt der Ortstag, also der 31.: die
  // Serie hat ein Vorkommen und ist gueltig. Ohne Zonenhinweis sah der Guard
  // den Ersten, hielt sie fuer leer und wies die Bearbeitung ab - fuer einen
  // Termin, den der Kalender daneben anzeigte.
  const id = insertEvent({ title: 'NY-Serie', start_datetime: '2026-02-01T01:00:00Z' });
  db.prepare('UPDATE calendar_events SET tzid = ? WHERE id = ?').run('America/New_York', id);

  const res = await call('PUT', `/${id}`, { body: {
    title: 'NY-Serie', start_datetime: '2026-02-01T01:00:00Z',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260220',
  } });
  assert.equal(res.status, 200, `erwartet 200, bekommen ${res.status}`);

  // GEGENPROBE IM TEST SELBST: ohne eigene Zone ist der 1. Februar wirklich
  // kein Monatsletzter, und der Guard greift weiter. Sonst waere der Fix eine
  // Abschaltung mit Umweg.
  const ohne = insertEvent({ title: 'Ohne Zone', start_datetime: '2026-02-01T01:00:00Z' });
  const res2 = await call('PUT', `/${ohne}`, { body: {
    title: 'Ohne Zone', start_datetime: '2026-02-01T01:00:00Z',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260220',
  } });
  assert.equal(res2.status, 400, `ohne Zone erwartet 400, bekommen ${res2.status}`);
});
