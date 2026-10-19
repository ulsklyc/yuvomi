/**
 * Test: Einzeltermin-Ausnahmen für Serien (EXDATE, #489)
 * Zweck: Migration v85 (calendar_event_exceptions) + POST /calendar/:id/exceptions
 *        + Filterung in GET /calendar (expandRecurringEvents). Prüft: Ausnahme
 *        blendet genau eine Instanz aus, andere bleiben; nicht-wiederkehrend → 400;
 *        externe Serie → 400; Serien-Löschung entfernt Ausnahmen (CASCADE).
 * Ausführen: node --experimental-sqlite --test test/test-calendar-exceptions.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

// Geteilte :memory:-DB (Singleton) → Events zwischen Tests zurücksetzen.
// Ausnahmen verschwinden per ON DELETE CASCADE mit ihren Events.
beforeEach(() => {
  db.get().prepare('DELETE FROM calendar_events').run();
});

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = 1; req.authRole = 'admin'; next(); });
  app.use('/', calendarRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${s.address().port}`,
      close: () => new Promise((r) => s.close(r)),
    }));
  });
}

function seedUser() {
  db.get().prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role)
     VALUES (1, 'admin', 'Admin', 'x', 'admin')`
  ).run();
  // Das Fenster von GET /calendar ist in Haushaltstagen gemeint: fest, damit
  // die Suite unter jeder Prozesszone dieselben Tage fragt.
  db.get().prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', 'Europe/Berlin')").run();
}

// Weekly-Gym-Serie ab Dienstag, 14.07.2026 (lokale, naive Zeit).
// external_source ist NOT NULL DEFAULT 'local' → für lokale Events weglassen.
function seedWeeklyEvent({ external = null } = {}) {
  if (external) {
    return db.get().prepare(
      `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, external_source, created_by)
       VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', ?, 1)`
    ).run(external).lastInsertRowid;
  }
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, recurrence_rule, created_by)
     VALUES ('Gym', '2026-07-14T18:00', '2026-07-14T19:00', 0, 'FREQ=WEEKLY;BYDAY=TU', 1)`
  ).run().lastInsertRowid;
}

const RANGE = '?from=2026-07-14&to=2026-07-28';

test('POST exceptions: single occurrence removed from GET, others remain', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const before = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const beforeDates = before.data.map((e) => e.start_datetime);
    assert.deepEqual(beforeDates, ['2026-07-14T18:00', '2026-07-21T18:00', '2026-07-28T18:00']);

    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 201);

    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const afterDates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(afterDates, ['2026-07-14T18:00', '2026-07-28T18:00'], 'nur die ausgenommene Instanz fehlt');
  } finally { await close(); }
});

test('POST exceptions: master start date can be excluded, series continues', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 201);
    const after = await (await fetch(`${baseUrl}/${RANGE}`)).json();
    const dates = after.data.map((e) => e.start_datetime);
    assert.deepEqual(dates, ['2026-07-21T18:00', '2026-07-28T18:00']);
  } finally { await close(); }
});

test('POST exceptions: 400 for non-recurring event', async () => {
  seedUser();
  const id = db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, created_by) VALUES ('Einmalig', '2026-07-14T18:00', 1)`
  ).run().lastInsertRowid;
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-14' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for externally synced series', async () => {
  seedUser();
  const id = seedWeeklyEvent({ external: 'google' });
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

test('POST exceptions: 400 for invalid date', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    const post = await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '14.07.2026' }),
    });
    assert.equal(post.status, 400);
  } finally { await close(); }
});

// --- Beide Schluesselformen (#2034) ---
// Eine Ausnahme in Format A trifft genau ihr Vorkommen, eine alte (`YYYY-MM-DD`)
// das, was sie auf main traf. Beide Formen stehen nach Schritt 4 nebeneinander
// in derselben Tabelle, ohne Migration.

function seedZonedDaily() {
  // Europe/Berlin taeglich 01:30, Start im Sommer 2034: im Maerz 2035 laeuft die
  // Schleife auf Ortstagen, und der 24. und 25.03. teilen den alten Schluessel
  // `2035-03-24` (UTC-Tag ueber die alte Uhr).
  return db.get().prepare(
    `INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, tzid, recurrence_rule, created_by)
     VALUES ('Nacht', '2034-06-30T23:30:00Z', '2034-07-01T00:30:00Z', 0, 'Europe/Berlin', 'FREQ=DAILY', 1)`
  ).run().lastInsertRowid;
}

function exclude(id, key) {
  db.get().prepare('INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)').run(id, key);
}

const NIGHT_RANGE = '?from=2035-03-23&to=2035-03-26';

test('Format A: eine exakte Ausnahme blendet in der Umstellungsnacht genau ein Vorkommen aus', async () => {
  seedUser();
  const id = seedZonedDaily();
  const { baseUrl, close } = await startApp();
  try {
    const before = (await (await fetch(`${baseUrl}/${NIGHT_RANGE}`)).json()).data.map((e) => e.start_datetime);
    // 01:30 MEZ = 00:30Z bis zum 25.03. (Umstellung um 02:00), danach 01:30 MESZ = 23:30Z.
    assert.deepEqual(before, [
      '2035-03-23T00:30:00Z', '2035-03-24T00:30:00Z', '2035-03-25T00:30:00Z', '2035-03-25T23:30:00Z',
    ]);
    exclude(id, '2035-03-25T00:30:00Z');
    const after = (await (await fetch(`${baseUrl}/${NIGHT_RANGE}`)).json()).data.map((e) => e.start_datetime);
    assert.deepEqual(after, ['2035-03-23T00:30:00Z', '2035-03-24T00:30:00Z', '2035-03-25T23:30:00Z']);
  } finally { await close(); }
});

test('Altform: eine alte Ausnahme trifft weiter, was sie auf main traf - hier beide Naechte', async () => {
  seedUser();
  const id = seedZonedDaily();
  const { baseUrl, close } = await startApp();
  try {
    exclude(id, '2035-03-24');
    const after = (await (await fetch(`${baseUrl}/${NIGHT_RANGE}`)).json()).data.map((e) => e.start_datetime);
    assert.deepEqual(after, ['2035-03-23T00:30:00Z', '2035-03-25T23:30:00Z']);
  } finally { await close(); }
});

test('Format A: schwebender Schluessel an einer lokalen Serie, alte Form daneben', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    exclude(id, '2026-07-21T18:00:00');
    exclude(id, '2026-07-28');
    const after = (await (await fetch(`${baseUrl}/${RANGE}`)).json()).data.map((e) => e.start_datetime);
    assert.deepEqual(after, ['2026-07-14T18:00']);
  } finally { await close(); }
});

test('DELETE series removes its exceptions (ON DELETE CASCADE)', async () => {
  seedUser();
  const id = seedWeeklyEvent();
  const { baseUrl, close } = await startApp();
  try {
    await fetch(`${baseUrl}/${id}/exceptions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-21' }),
    });
    const countBefore = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countBefore, 1);

    const del = await fetch(`${baseUrl}/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const countAfter = db.get().prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(id).n;
    assert.equal(countAfter, 0, 'Ausnahmen der gelöschten Serie sind mitentfernt');
  } finally { await close(); }
});
