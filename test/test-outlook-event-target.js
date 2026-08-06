/**
 * Test: Outlook-Push-Ziel an Events persistieren
 * Zweck: Stellt sicher, dass POST/PUT auf /calendar die Felder
 *        target_outlook_account_id + target_outlook_calendar_id speichern,
 *        leeren können und ungültige Werte mit 400 ablehnen
 *        (Klon von test-caldav-event-target.js für den Outlook-Provider).
 * Ausführen: node --experimental-sqlite test/test-outlook-event-target.js
 */

// Env vor dem Import der Route setzen (auth.js erwartet SESSION_SECRET,
// db.js initialisiert mit DB_PATH eine In-Memory-DB inkl. aller Migrationen).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const db = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

describe('Outlook-Push-Ziel an Events', () => {
  let server;
  let baseUrl;
  let userId;
  let accountId;
  const calId = 'AAMkAGVmMDEzcalendarid==';

  before(async () => {
    const d = db.get();
    userId = d.prepare(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ('outlook-target-tester', 'Tester', 'x', 'admin')`
    ).run().lastInsertRowid;
    accountId = d.prepare(
      `INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token)
       VALUES ('Papa', 'ms-user-t', 'papa@example.com', 'tok', 'ref')`
    ).run().lastInsertRowid;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { req.authUserId = userId; req.authRole = 'admin'; next(); });
    app.use('/calendar', calendarRouter);

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => { server?.close(); });

  function eventRow(id) {
    return db.get().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  }

  it('POST /calendar speichert das Outlook-Ziel', async () => {
    const res = await fetch(`${baseUrl}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Zahnarzt',
        start_datetime: '2026-06-10T10:00',
        end_datetime: '2026-06-10T11:00',
        target_outlook_account_id: accountId,
        target_outlook_calendar_id: calId,
      }),
    });
    assert.strictEqual(res.status, 201, `Status sollte 201 sein, war ${res.status}`);
    const { data } = await res.json();

    const row = eventRow(data.id);
    assert.strictEqual(row.target_outlook_account_id, accountId, 'account_id muss persistiert sein');
    assert.strictEqual(row.target_outlook_calendar_id, calId, 'calendar_id muss persistiert sein');
    assert.strictEqual(data.target_outlook_account_id, accountId, 'Response muss account_id enthalten');
    assert.strictEqual(data.target_outlook_calendar_id, calId, 'Response muss calendar_id enthalten');
  });

  it('PUT /calendar/:id aktualisiert das Outlook-Ziel', async () => {
    const id = db.get().prepare(
      `INSERT INTO calendar_events (title, start_datetime, color, created_by)
       VALUES ('Termin', '2026-06-11T09:00', '#007AFF', ?)`
    ).run(userId).lastInsertRowid;

    const res = await fetch(`${baseUrl}/calendar/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_outlook_account_id: accountId,
        target_outlook_calendar_id: calId,
      }),
    });
    assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);

    const row = eventRow(id);
    assert.strictEqual(row.target_outlook_account_id, accountId, 'account_id muss aktualisiert sein');
    assert.strictEqual(row.target_outlook_calendar_id, calId, 'calendar_id muss aktualisiert sein');
  });

  it('PUT /calendar/:id kann das Outlook-Ziel zurück auf Lokal setzen', async () => {
    const id = db.get().prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, color, created_by, target_outlook_account_id, target_outlook_calendar_id)
       VALUES ('Termin2', '2026-06-12T09:00', '#007AFF', ?, ?, ?)`
    ).run(userId, accountId, calId).lastInsertRowid;

    const res = await fetch(`${baseUrl}/calendar/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_outlook_account_id: null,
        target_outlook_calendar_id: null,
      }),
    });
    assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);

    const row = eventRow(id);
    assert.strictEqual(row.target_outlook_account_id, null, 'account_id muss geleert sein');
    assert.strictEqual(row.target_outlook_calendar_id, null, 'calendar_id muss geleert sein');
  });

  it('PUT /calendar/:id ohne Outlook-Felder lässt das Ziel unangetastet', async () => {
    const id = db.get().prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, color, created_by, target_outlook_account_id, target_outlook_calendar_id)
       VALUES ('Termin3', '2026-06-13T09:00', '#007AFF', ?, ?, ?)`
    ).run(userId, accountId, calId).lastInsertRowid;

    const res = await fetch(`${baseUrl}/calendar/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Termin3 umbenannt' }),
    });
    assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);

    const row = eventRow(id);
    assert.strictEqual(row.target_outlook_account_id, accountId, 'account_id darf nicht verloren gehen');
    assert.strictEqual(row.target_outlook_calendar_id, calId, 'calendar_id darf nicht verloren gehen');
  });

  it('POST /calendar lehnt ungültige account_id ab', async () => {
    const res = await fetch(`${baseUrl}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ungültig',
        start_datetime: '2026-06-14T10:00',
        target_outlook_account_id: 'abc',
        target_outlook_calendar_id: calId,
      }),
    });
    assert.strictEqual(res.status, 400, `Status sollte 400 sein, war ${res.status}`);
  });

  it('POST /calendar lehnt account_id ohne calendar_id ab', async () => {
    const res = await fetch(`${baseUrl}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ungültig',
        start_datetime: '2026-06-15T10:00',
        target_outlook_account_id: accountId,
      }),
    });
    assert.strictEqual(res.status, 400, `Status sollte 400 sein, war ${res.status}`);
  });
});
