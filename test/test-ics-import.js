/**
 * Modul: ICS-Import-Test (Discussion #437, Kalender-Migration)
 * Zweck: Einmaliger Import von Terminen aus ICS-Text/Feed als echte,
 *        bearbeitbare lokale Termine (external_source='local', subscription_id=NULL).
 *        Deckt toLocalRRule-Normalisierung, importToLocal-Service und die
 *        POST /calendar/import-Route (inkl. Fehlerfälle) ab.
 * Ausführen: node --test test/test-ics-import.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'test-secret-ics-import';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { importToLocal, toLocalRRule } = await import('../server/services/ics-subscription.js');
const { expandRecurringEvents, loadEventExceptions } = await import('../server/services/calendar-events.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

// --------------------------------------------------------
// Test-DB via vollständige Migrationskette
// --------------------------------------------------------
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;
const otherUid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Acme//Test//EN',
  'BEGIN:VEVENT',
  'UID:evt-timed@acme',
  'SUMMARY:Team Standup',
  'DESCRIPTION:Daily sync',
  'LOCATION:Room 1',
  'DTSTART:20260210T090000Z',
  'DTEND:20260210T093000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-allday@acme',
  'SUMMARY:Company Holiday',
  'DTSTART;VALUE=DATE:20260501',
  'DTEND;VALUE=DATE:20260502',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-count@acme',
  'SUMMARY:Limited Series',
  'DTSTART:20260301T120000Z',
  'DTEND:20260301T130000Z',
  'RRULE:FREQ=WEEKLY;COUNT=5',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// --------------------------------------------------------
// toLocalRRule (pure)
// --------------------------------------------------------
test('toLocalRRule: strips RRULE: prefix and keeps supported subset', () => {
  assert.equal(toLocalRRule('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
});

test('toLocalRRule: preserves COUNT so finite series stay finite (#513)', () => {
  assert.equal(toLocalRRule('RRULE:FREQ=WEEKLY;COUNT=5'), 'FREQ=WEEKLY;COUNT=5');
});

test('toLocalRRule: COUNT wins over UNTIL when both present (RFC 5545, #513)', () => {
  assert.equal(toLocalRRule('FREQ=WEEKLY;COUNT=5;UNTIL=20261231T235959Z'), 'FREQ=WEEKLY;COUNT=5');
});

test('toLocalRRule: rejects non-positive COUNT, falls back to open series', () => {
  assert.equal(toLocalRRule('FREQ=WEEKLY;COUNT=0'), 'FREQ=WEEKLY');
});

test('toLocalRRule: keeps UNTIL', () => {
  assert.equal(toLocalRRule('FREQ=DAILY;UNTIL=20261231T235959Z'), 'FREQ=DAILY;UNTIL=20261231T235959Z');
});

test('toLocalRRule: drops ordinal BYDAY (e.g. 2MO)', () => {
  assert.equal(toLocalRRule('FREQ=MONTHLY;BYDAY=2MO'), 'FREQ=MONTHLY');
});

test('toLocalRRule: returns null for null / unsupported FREQ', () => {
  assert.equal(toLocalRRule(null), null);
  assert.equal(toLocalRRule('FREQ=HOURLY'), null);
});

test('toLocalRRule result is compatible with the rrule() validator regex', () => {
  const RRULE_RE = /^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?(;(UNTIL=\d{8}(T\d{6}Z)?|COUNT=\d{1,4}))?)?$/;
  for (const r of ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2', 'FREQ=WEEKLY;COUNT=5', 'FREQ=DAILY;UNTIL=20261231T235959Z']) {
    assert.ok(RRULE_RE.test(toLocalRRule(r)), `not validator-compatible: ${toLocalRRule(r)}`);
  }
});

// --------------------------------------------------------
// importToLocal (service, raw ICS text path)
// --------------------------------------------------------
test('importToLocal: inserts events as editable local events', async () => {
  const res = await importToLocal(uid, { ics: SAMPLE_ICS });
  assert.equal(res.total, 3);
  assert.equal(res.imported, 3);
  assert.equal(res.skipped, 0);

  const rows = db.prepare(
    `SELECT * FROM calendar_events WHERE created_by = ? ORDER BY external_calendar_id`,
  ).all(uid);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.external_source, 'local', 'must be local (editable)');
    assert.equal(row.subscription_id, null, 'must not be bound to a subscription');
    assert.equal(row.user_modified, 0);
  }
});

test('importToLocal: keeps recurrence as a series without RRULE: prefix', () => {
  const timed = db.prepare(`SELECT * FROM calendar_events WHERE external_calendar_id = 'evt-timed@acme'`).get();
  assert.equal(timed.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.equal(timed.all_day, 0);

  const count = db.prepare(`SELECT * FROM calendar_events WHERE external_calendar_id = 'evt-count@acme'`).get();
  assert.equal(count.recurrence_rule, 'FREQ=WEEKLY;COUNT=5');
});

test('importToLocal: all-day event is stored as date-only all_day', () => {
  const allday = db.prepare(`SELECT * FROM calendar_events WHERE external_calendar_id = 'evt-allday@acme'`).get();
  assert.equal(allday.all_day, 1);
  assert.equal(allday.start_datetime, '2026-05-01');
});

test('importToLocal: re-import of the same feed is deduplicated per user', async () => {
  const res = await importToLocal(uid, { ics: SAMPLE_ICS });
  assert.equal(res.total, 3);
  assert.equal(res.imported, 0, 'all duplicates skipped');
  assert.equal(res.skipped, 3);
  const n = db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE created_by = ?`).get(uid).c;
  assert.equal(n, 3, 'no duplicate rows created');
});

test('importToLocal: another user can import the same feed independently', async () => {
  const res = await importToLocal(otherUid, { ics: SAMPLE_ICS });
  assert.equal(res.imported, 3);
  const n = db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE created_by = ?`).get(otherUid).c;
  assert.equal(n, 3);
});

test('importToLocal: applies fallback color to events without their own color', () => {
  const timed = db.prepare(`SELECT color FROM calendar_events WHERE external_calendar_id = 'evt-timed@acme' AND created_by = ?`).get(uid);
  assert.equal(timed.color, '#007AFF');
});

test('importToLocal: throws when neither ics nor url is provided', async () => {
  await assert.rejects(() => importToLocal(uid, {}), /required/i);
});

// --------------------------------------------------------
// POST /calendar/import route
// --------------------------------------------------------
let currentUid = uid;
const app = express();
app.use(express.json({ limit: '7mb' }));
app.use((req, _res, next) => {
  req.authUserId = currentUid;
  req.user = { id: currentUid, role: 'admin' };
  req.session = { userId: currentUid, role: 'admin' };
  next();
});
app.use('/api/v1/calendar', calendarRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /import: imports from raw ICS body and returns counts', async () => {
  // Fresh user so counts are deterministic.
  const freshUid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('carol', 'Carol', '$2b$12$x', 'member')`).run().lastInsertRowid;
  currentUid = freshUid;
  const res = await request('POST', '/api/v1/calendar/import', { ics: SAMPLE_ICS });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.imported, 3);
  assert.equal(res.body.data.total, 3);
  currentUid = uid;
});

test('POST /import: 400 when neither ics nor url provided', async () => {
  const res = await request('POST', '/api/v1/calendar/import', {});
  assert.equal(res.status, 400);
});

test('POST /import: 400 on invalid color', async () => {
  const res = await request('POST', '/api/v1/calendar/import', { ics: SAMPLE_ICS, color: 'not-a-color' });
  assert.equal(res.status, 400);
});

// --------------------------------------------------------
// #513: COUNT-begrenzte Serie mit EXDATE bleibt endlich
// (Repro aus dem Issue: Google-Export FREQ=WEEKLY;COUNT=10 + EXDATE 25.11.)
// --------------------------------------------------------
const REPRO_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Yuvomi COUNT reproduction//EN',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20240930T170000',
  'DTEND;TZID=Europe/Vienna:20240930T180000',
  'RRULE:FREQ=WEEKLY;COUNT=10',
  'EXDATE;TZID=Europe/Vienna:20241125T170000',
  'UID:yuvomi-count-reproduction@example.invalid',
  'SUMMARY:Kinderturnen',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('#513: COUNT+EXDATE import stays finite (10 instances, 9 visible, none after Dec 2)', async () => {
  const reproUid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('repro', 'Repro', '$2b$12$x', 'member')`).run().lastInsertRowid;

  await importToLocal(reproUid, { ics: REPRO_ICS });
  const master = db.prepare(
    `SELECT * FROM calendar_events WHERE created_by = ? AND external_calendar_id = 'yuvomi-count-reproduction@example.invalid'`,
  ).get(reproUid);
  assert.ok(master, 'imported as a single series master');
  assert.equal(master.recurrence_rule, 'FREQ=WEEKLY;COUNT=10', 'COUNT preserved on import');

  // EXDATE 25.11. wurde als Instanz-Ausnahme gespeichert.
  const exceptions = loadEventExceptions(db, [master.id]);
  assert.deepEqual([...(exceptions.get(master.id) ?? [])], ['2024-11-25']);

  // Expansion über ein weites Fenster: genau 9 sichtbare Vorkommen, keins nach 02.12.
  const expanded = expandRecurringEvents([master], '2024-01-01', '2025-12-31', exceptions);
  const dates = expanded.map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(dates, [
    '2024-09-30', '2024-10-07', '2024-10-14', '2024-10-21', '2024-10-28',
    '2024-11-04', '2024-11-11', '2024-11-18', '2024-12-02',
  ], 'exactly nine occurrences, 25.11. excluded, none after 02.12.');
});

test('#513: COUNT counts excluded occurrences (EXDATE does not shift the limit)', () => {
  // COUNT=3, mittleres Vorkommen ausgenommen → 2 sichtbar, NICHT 3.
  const ev = { id: 999, start_datetime: '2024-09-30T15:00:00Z', end_datetime: null,
    recurrence_rule: 'FREQ=WEEKLY;COUNT=3', all_day: 0 };
  const exceptions = new Map([[999, new Set(['2024-10-07'])]]);
  const dates = expandRecurringEvents([ev], '2024-01-01', '2025-12-31', exceptions)
    .map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(dates, ['2024-09-30', '2024-10-14']);
});

test.after(() => server.close());
