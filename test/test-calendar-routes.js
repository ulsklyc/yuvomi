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
 *                             Extern-Sperre + Owner-Gate
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

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
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
    title: `EV-${++seq}`, start_datetime: '2035-03-10T09:00', end_datetime: null,
    created_by: 1, color: '#007AFF', icon: 'calendar', visibility: 'all',
    external_source: 'local', all_day: 0, recurrence_rule: null,
    subscription_id: null, calendar_ref_id: null, user_modified: 0,
    ...fields,
  };
  const r = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, created_by, color, icon, visibility,
       external_source, all_day, recurrence_rule, subscription_id, calendar_ref_id, user_modified)
    VALUES (@title,@start_datetime,@end_datetime,@created_by,@color,@icon,@visibility,
       @external_source,@all_day,@recurrence_rule,@subscription_id,@calendar_ref_id,@user_modified)
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
  assert.equal(res.body.data.color, '#007AFF', 'Default-Farbe');
  assert.equal(res.body.data.icon, 'calendar');
  assert.equal(res.body.data.created_by, ADMIN.id);
  assert.equal(res.body.data.visibility, 'all');
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
  // Tom: weder Event-Creator noch Sub-Creator, non-admin -> 403
  assert.equal((await call('POST', `/${icsEv}/reset`, { actor: TOM })).status, 403);
  // Maria (Event- + Sub-Creator) -> Happy
  const ok = await call('POST', `/${icsEv}/reset`, { actor: MARIA });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.reset, true);
  assert.equal(db.prepare('SELECT user_modified AS m FROM calendar_events WHERE id=?').get(icsEv).m, 0);
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

test('POST /:id/exceptions — 403 fremd + 201 EXDATE angelegt', async () => {
  const serie = insertEvent({ title: 'EXC-OK', start_datetime: '2042-03-01T09:00', recurrence_rule: 'FREQ=DAILY', created_by: MARIA.id });
  assert.equal((await call('POST', `/${serie}/exceptions`, { actor: TOM, body: { date: '2042-03-05' } })).status, 403);
  const ok = await call('POST', `/${serie}/exceptions`, { actor: MARIA, body: { date: '2042-03-05' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.exception_date, '2042-03-05');
  const row = db.prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id=? AND exception_date=?').get(serie, '2042-03-05');
  assert.equal(row.n, 1);
});

// ════════════════════════════════════════════════════════════════════════════════
// DELETE /:id
// ════════════════════════════════════════════════════════════════════════════════

test('DELETE /:id — 404 + 204', async () => {
  assert.equal((await call('DELETE', '/9999999')).status, 404);
  const id = insertEvent({ title: 'TO-DELETE', start_datetime: '2043-01-01T09:00' });
  assert.equal((await call('DELETE', `/${id}`)).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE id=?').get(id).n, 0);
});
