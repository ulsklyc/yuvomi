/**
 * Test: CalDAV-Ziel an Events persistieren (Regression Issue #241)
 * Zweck: Stellt sicher, dass POST/PUT auf /calendar die Felder
 *        target_caldav_account_id + target_caldav_calendar_url speichern.
 *        Vor dem Fix wurden sie vom Route-Handler ignoriert -> Auswahl
 *        sprang nach dem Speichern zurück auf "Lokal".
 *        Zweite Invariante (Issue #618): GET /calendar/sync-targets liefert die
 *        Auswahlliste des Dropdowns auch Nicht-Admins - vorher hing sie an den
 *        admin-only Verwaltungsrouten und blieb fuer Familienmitglieder leer.
 * Ausführen: node --experimental-sqlite test/test-caldav-event-target.js
 */

// Env vor dem Import der Route setzen (auth.js erwartet SESSION_SECRET,
// db.js initialisiert mit DB_PATH eine In-Memory-DB inkl. aller Migrationen).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Dynamisch importieren, damit die oben gesetzten Env-Vars greifen:
// statische ES-Imports werden gehoistet und würden db.js sonst mit der
// echten DB_PATH initialisieren, bevor die Zuweisungen oben laufen.
const db = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');

describe('CalDAV-Ziel an Events (Issue #241)', () => {
  let server;
  let baseUrl;
  let userId;
  let accountId;
  let role = 'admin';
  const calUrl = 'https://caldav.example.com/cal/familie/';

  before(async () => {
    const d = db.get();
    userId = d.prepare(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ('caldav-target-tester', 'Tester', 'x', 'admin')`
    ).run().lastInsertRowid;
    accountId = d.prepare(
      `INSERT INTO caldav_accounts (name, caldav_url, username, password)
       VALUES ('mailbox', 'https://caldav.example.com', 'u', 'p')`
    ).run().lastInsertRowid;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // Auth-Middleware aus index.js wird hier durch eine Stub-Injection ersetzt.
    // authRole ist umschaltbar, damit derselbe Server auch die Sicht eines
    // Familienmitglieds (Rolle "user", Issue #618) abbilden kann.
    app.use((req, _res, next) => { req.authUserId = userId; req.authRole = role; next(); });
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

  it('POST /calendar speichert das CalDAV-Ziel', async () => {
    const res = await fetch(`${baseUrl}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Zahnarzt',
        start_datetime: '2026-06-10T10:00',
        end_datetime: '2026-06-10T11:00',
        target_caldav_account_id: accountId,
        target_caldav_calendar_url: calUrl,
      }),
    });
    assert.strictEqual(res.status, 201, `Status sollte 201 sein, war ${res.status}`);
    const { data } = await res.json();

    const row = eventRow(data.id);
    assert.strictEqual(row.target_caldav_account_id, accountId, 'account_id muss persistiert sein');
    assert.strictEqual(row.target_caldav_calendar_url, calUrl, 'calendar_url muss persistiert sein');
    assert.strictEqual(data.target_caldav_account_id, accountId, 'Response muss account_id enthalten');
    assert.strictEqual(data.target_caldav_calendar_url, calUrl, 'Response muss calendar_url enthalten');
  });

  it('PUT /calendar/:id aktualisiert das CalDAV-Ziel', async () => {
    // Event zunächst ohne Ziel anlegen.
    const id = db.get().prepare(
      `INSERT INTO calendar_events (title, start_datetime, color, created_by)
       VALUES ('Termin', '2026-06-11T09:00', '#007AFF', ?)`
    ).run(userId).lastInsertRowid;

    const res = await fetch(`${baseUrl}/calendar/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_caldav_account_id: accountId,
        target_caldav_calendar_url: calUrl,
      }),
    });
    assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);

    const row = eventRow(id);
    assert.strictEqual(row.target_caldav_account_id, accountId, 'account_id muss aktualisiert sein');
    assert.strictEqual(row.target_caldav_calendar_url, calUrl, 'calendar_url muss aktualisiert sein');
  });

  it('PUT /calendar/:id kann das CalDAV-Ziel zurück auf Lokal setzen', async () => {
    const id = db.get().prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, color, created_by, target_caldav_account_id, target_caldav_calendar_url)
       VALUES ('Termin2', '2026-06-12T09:00', '#007AFF', ?, ?, ?)`
    ).run(userId, accountId, calUrl).lastInsertRowid;

    const res = await fetch(`${baseUrl}/calendar/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_caldav_account_id: null,
        target_caldav_calendar_url: null,
      }),
    });
    assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);

    const row = eventRow(id);
    assert.strictEqual(row.target_caldav_account_id, null, 'account_id muss geleert sein');
    assert.strictEqual(row.target_caldav_calendar_url, null, 'calendar_url muss geleert sein');
  });

  it('POST /calendar lehnt ungültige account_id ab', async () => {
    const res = await fetch(`${baseUrl}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ungültig',
        start_datetime: '2026-06-13T10:00',
        target_caldav_account_id: 'abc',
        target_caldav_calendar_url: calUrl,
      }),
    });
    assert.strictEqual(res.status, 400, `Status sollte 400 sein, war ${res.status}`);
  });

  // ------------------------------------------------------------------
  // Sync-Ziele auch ohne Admin-Rolle (Issue #618)
  // ------------------------------------------------------------------

  describe('GET /calendar/sync-targets (Issue #618)', () => {
    before(() => {
      const d = db.get();
      d.prepare(
        `INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
         VALUES (?, ?, 'Familie', '#4A90E2', 1)`
      ).run(accountId, calUrl);
      d.prepare(
        `INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
         VALUES (?, ?, 'Archiv', '#4A90E2', 0)`
      ).run(accountId, 'https://caldav.example.com/cal/archiv/');
      role = 'user';
    });

    after(() => { role = 'admin'; });

    it('liefert einem Familienmitglied die aktivierten CalDAV-Kalender', async () => {
      const res = await fetch(`${baseUrl}/calendar/sync-targets`);
      assert.strictEqual(res.status, 200, `Status sollte 200 sein, war ${res.status}`);
      const { data } = await res.json();

      assert.deepStrictEqual(
        data.caldav,
        [{ accountId, accountName: 'mailbox', calendarUrl: calUrl, calendarName: 'Familie', defaultAssigneeUserId: null }],
        'Nicht-Admins müssen die aktivierten CalDAV-Ziele sehen'
      );
      // Ohne Google-Verbindung bleibt die Gruppe leer statt die Antwort zu kippen.
      assert.deepStrictEqual(data.google, [], 'Google-Gruppe ohne Verbindung leer');
    });

    it('trägt die Standard-Zuweisung des Kalenders mit (#1060)', async () => {
      // Das Formular liest sie rückwärts: ein neuer Termin für diese Person
      // bekommt diesen Kalender als Ziel. Sie hängt an der Kalender-URL.
      const d = db.get();
      d.prepare(
        `INSERT INTO external_calendars (source, external_id, name, color, default_assignee_user_id)
         VALUES ('caldav', ?, 'Familie', '#4A90E2', ?)`
      ).run(calUrl, userId);
      try {
        const res = await fetch(`${baseUrl}/calendar/sync-targets`);
        const { data } = await res.json();
        assert.strictEqual(data.caldav[0].defaultAssigneeUserId, userId,
          'ohne das Feld kann das Formular den Kalender der Person nicht finden');
      } finally {
        d.prepare(`DELETE FROM external_calendars WHERE source = 'caldav' AND external_id = ?`).run(calUrl);
      }
    });

    it('gibt keine Zugangsdaten oder Server-URLs preis', async () => {
      const res = await fetch(`${baseUrl}/calendar/sync-targets`);
      const body = await res.text();
      assert.ok(!body.includes('"password"'), 'Antwort darf kein Passwort-Feld enthalten');
      assert.ok(!body.includes('"username"'), 'Antwort darf keinen Benutzernamen enthalten');
      assert.ok(!body.includes('"caldavUrl"'), 'Antwort darf die Konto-Server-URL nicht enthalten');
    });

    it('lässt die Kontenverwaltung für Nicht-Admins weiterhin gesperrt', async () => {
      const res = await fetch(`${baseUrl}/calendar/caldav/accounts`);
      assert.strictEqual(res.status, 403, `Verwaltungsroute muss 403 bleiben, war ${res.status}`);
    });

    it('wird nicht vom CRUD-Router /:id verschluckt', async () => {
      const res = await fetch(`${baseUrl}/calendar/sync-targets`);
      const { data } = await res.json();
      assert.ok(data && Array.isArray(data.caldav), 'Antwort muss die Sync-Ziel-Form haben, nicht die eines Events');
    });
  });
});
