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
