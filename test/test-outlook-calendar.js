/**
 * Modul: Outlook Calendar Push – Unit- und Sync-Tests
 * Zweck: Validiert das RRULE→Graph-Mapping, die Ganztags-/Datetime-Konvertierung
 *        und den One-Way-Push-Algorithmus (Create/No-Op/Update/Move/Delete/
 *        Recreate-nach-Remote-Delete/invalid_grant) mit injiziertem fetch.
 * Ausführen: node test/test-outlook-calendar.js
 */

// Env VOR den Imports setzen: db.js verbindet sich beim Import mit DB_PATH,
// der Service liest die MS_*-Variablen zur Laufzeit.
process.env.DB_PATH = ':memory:';
process.env.MS_CLIENT_ID = 'test-client';
process.env.MS_CLIENT_SECRET = 'test-secret';
process.env.MS_REDIRECT_URI = 'http://localhost/api/v1/calendar/outlook/callback';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('../server/db.js')).get();
const outlook = await import('../server/services/outlook-calendar.js');
const { rruleToGraphRecurrence, allDayEndToExclusive, toGraphDateTime,
        localEventToGraph, contentHash } = outlook.__test;

// --------------------------------------------------------
// Fake-fetch-Helfer
// --------------------------------------------------------

function jsonRes(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

/** Zeichnet alle Requests auf und delegiert an einen Handler. */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const call = {
      url,
      method: options.method || 'GET',
      body: options.body && options.headers?.['Content-Type'] === 'application/json'
        ? JSON.parse(options.body)
        : options.body || null,
    };
    calls.push(call);
    return handler(call);
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------------
// RRULE → Graph recurrence
// --------------------------------------------------------

describe('rruleToGraphRecurrence', () => {
  it('DAILY mit INTERVAL und offenem Ende', () => {
    const r = rruleToGraphRecurrence('FREQ=DAILY;INTERVAL=2', '2026-06-10');
    assert.deepEqual(r.pattern, { type: 'daily', interval: 2 });
    assert.equal(r.range.type, 'noEnd');
    assert.equal(r.range.startDate, '2026-06-10');
    assert.equal(r.range.recurrenceTimeZone, 'Europe/Berlin');
  });

  it('WEEKLY mit BYDAY und COUNT', () => {
    const r = rruleToGraphRecurrence('FREQ=WEEKLY;BYDAY=MO,TH;COUNT=10', '2026-06-10');
    assert.equal(r.pattern.type, 'weekly');
    assert.deepEqual(r.pattern.daysOfWeek, ['monday', 'thursday']);
    assert.equal(r.pattern.firstDayOfWeek, 'monday');
    assert.deepEqual(
      { type: r.range.type, numberOfOccurrences: r.range.numberOfOccurrences },
      { type: 'numbered', numberOfOccurrences: 10 }
    );
  });

  it('WEEKLY ohne BYDAY fällt auf den Start-Wochentag zurück', () => {
    // 2026-06-10 ist ein Mittwoch.
    const r = rruleToGraphRecurrence('FREQ=WEEKLY', '2026-06-10');
    assert.deepEqual(r.pattern.daysOfWeek, ['wednesday']);
  });

  it('MONTHLY mit UNTIL wird absoluteMonthly mit endDate', () => {
    const r = rruleToGraphRecurrence('FREQ=MONTHLY;UNTIL=20261231', '2026-06-15');
    assert.deepEqual(r.pattern, { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 });
    assert.equal(r.range.type, 'endDate');
    assert.equal(r.range.endDate, '2026-12-31');
  });

  it('YEARLY trägt Monat und Tag aus dem Startdatum', () => {
    const r = rruleToGraphRecurrence('FREQ=YEARLY', '2026-03-07');
    assert.deepEqual(r.pattern, { type: 'absoluteYearly', interval: 1, dayOfMonth: 7, month: 3 });
  });

  it('akzeptiert das RRULE:-Präfix', () => {
    const r = rruleToGraphRecurrence('RRULE:FREQ=DAILY', '2026-06-10');
    assert.equal(r.pattern.type, 'daily');
  });

  it('liefert null für nicht unterstützte/ungültige Regeln', () => {
    assert.equal(rruleToGraphRecurrence('FREQ=HOURLY', '2026-06-10'), null);
    assert.equal(rruleToGraphRecurrence('', '2026-06-10'), null);
    assert.equal(rruleToGraphRecurrence('FREQ=DAILY', ''), null);
  });
});

// --------------------------------------------------------
// Datums-/Payload-Konvertierung
// --------------------------------------------------------

describe('Datums- und Payload-Konvertierung', () => {
  it('allDayEndToExclusive addiert einen Tag (inklusive → exklusive)', () => {
    assert.equal(allDayEndToExclusive('2026-01-02'), '2026-01-03');
    assert.equal(allDayEndToExclusive('2026-02-28'), '2026-03-01');
    assert.equal(allDayEndToExclusive(null), null);
  });

  it('toGraphDateTime ergänzt Sekunden bei naiver Lokalzeit', () => {
    assert.deepEqual(toGraphDateTime('2026-06-10T10:00'),
      { dateTime: '2026-06-10T10:00:00', timeZone: 'Europe/Berlin' });
  });

  it('toGraphDateTime normalisiert Z-Zeiten nach UTC', () => {
    assert.deepEqual(toGraphDateTime('2026-06-10T10:00:00Z'),
      { dateTime: '2026-06-10T10:00:00', timeZone: 'UTC' });
  });

  it('localEventToGraph baut getimte Events mit Ort und Beschreibung', () => {
    const p = localEventToGraph({
      title: 'Zahnarzt', description: 'Kontrolle', location: 'Praxis',
      all_day: 0, start_datetime: '2026-06-10T10:00', end_datetime: '2026-06-10T11:00',
    });
    assert.equal(p.subject, 'Zahnarzt');
    assert.deepEqual(p.body, { contentType: 'text', content: 'Kontrolle' });
    assert.deepEqual(p.location, { displayName: 'Praxis' });
    assert.equal(p.start.dateTime, '2026-06-10T10:00:00');
    assert.equal(p.end.dateTime, '2026-06-10T11:00:00');
    assert.equal(p.isAllDay, undefined);
  });

  it('localEventToGraph baut Ganztags-Events Mitternacht-zu-Mitternacht exklusiv', () => {
    const p = localEventToGraph({
      title: 'Urlaub', all_day: 1,
      start_datetime: '2026-01-01', end_datetime: '2026-01-02',
    });
    assert.equal(p.isAllDay, true);
    assert.equal(p.start.dateTime, '2026-01-01T00:00:00');
    assert.equal(p.end.dateTime, '2026-01-03T00:00:00');
  });

  it('localEventToGraph hängt die Graph-Recurrence an Serien', () => {
    const p = localEventToGraph({
      title: 'Sport', all_day: 0,
      start_datetime: '2026-06-10T18:00', end_datetime: '2026-06-10T19:00',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
    });
    assert.equal(p.recurrence.pattern.type, 'weekly');
    assert.equal(p.recurrence.range.startDate, '2026-06-10');
  });

  it('contentHash ist stabil und kalender-sensitiv', () => {
    const payload = { subject: 'A', start: { dateTime: 'x' } };
    assert.equal(contentHash(payload, 'cal-1'), contentHash({ ...payload }, 'cal-1'));
    assert.notEqual(contentHash(payload, 'cal-1'), contentHash(payload, 'cal-2'));
  });
});

// --------------------------------------------------------
// One-Way-Push (sync mit injiziertem fetch)
// --------------------------------------------------------

// Antwort der Drift-Erkennung (GET .../events?$select=id,changeKey) aus den
// aktuellen Link-Zeilen bauen - Default "kein Drift": remote sieht exakt so
// aus, wie Yuvomi zuletzt geschrieben hat.
function remoteListFor(calendarId) {
  return db.prepare(
    'SELECT outlook_event_id AS id, outlook_change_key AS changeKey FROM outlook_event_links WHERE outlook_calendar_id = ?'
  ).all(calendarId);
}

const DRIFT_LIST_RE = /\/me\/calendars\/([^/]+)\/events\?/;

/** GET-Listing der Drift-Erkennung beantworten; null, wenn der Call keiner ist. */
function answerDriftList(call, overrides = {}) {
  const m = call.method === 'GET' ? call.url.match(DRIFT_LIST_RE) : null;
  if (!m) return null;
  const calId = decodeURIComponent(m[1]);
  const value = calId in overrides ? overrides[calId] : remoteListFor(calId);
  return jsonRes(200, { value });
}

describe('Outlook one-way push', () => {
  let userId;
  let accountId;
  let eventId;
  const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

  const linkRow = (id) =>
    db.prepare('SELECT * FROM outlook_event_links WHERE event_id = ?').get(id);
  const accountRow = () =>
    db.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountId);

  before(() => {
    userId = db.prepare(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ('outlook-tester', 'Tester', 'x', 'admin')`
    ).run().lastInsertRowid;

    accountId = db.prepare(
      `INSERT INTO outlook_accounts (name, ms_user_id, email, access_token, refresh_token, token_expiry)
       VALUES ('Papa', 'ms-user-1', 'papa@example.com', 'access-tok', 'refresh-tok', ?)`
    ).run(futureExpiry).lastInsertRowid;

    const insCal = db.prepare(
      `INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
       VALUES (?, ?, ?, ?, 1)`
    );
    insCal.run(accountId, 'cal-A', 'Kalender A', 1);
    insCal.run(accountId, 'cal-B', 'Kalender B', 1);
    insCal.run(accountId, 'cal-RO', 'Nur lesen', 0);

    eventId = db.prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, end_datetime, color, created_by,
          target_outlook_account_id, target_outlook_calendar_id)
       VALUES ('Zahnarzt', '2026-06-10T10:00', '2026-06-10T11:00', '#007AFF', ?, ?, 'cal-A')`
    ).run(userId, accountId).lastInsertRowid;
  });

  it('legt neue Events im Zielkalender an und speichert Link + changeKey', async () => {
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/me/calendars/cal-A/events')) {
        return jsonRes(201, { id: 'graph-evt-1', changeKey: 'ck-1' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.pushed, 1);
    assert.equal(result.syncedAccounts, 1);
    // Ohne bestehende Links kein Drift-Listing → genau der eine Create.
    assert.equal(fetchImpl.calls.length, 1);

    const link = linkRow(eventId);
    assert.equal(link.outlook_event_id, 'graph-evt-1');
    assert.equal(link.outlook_calendar_id, 'cal-A');
    assert.equal(link.outlook_change_key, 'ck-1');
    assert.ok(link.content_hash);
    assert.equal(accountRow().last_error, null);
  });

  it('unverändertes Event kostet nur das eine Drift-Listing pro Kalender', async () => {
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(fetchImpl.calls.length, 1, 'genau ein GET-Listing, keine Schreibzugriffe');
    assert.equal(fetchImpl.calls[0].method, 'GET');
    assert.equal(result.pushed + result.updated + result.deleted, 0);
  });

  it('geändertes Event wird per PATCH aktualisiert und trägt den neuen changeKey', async () => {
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run('Zahnarzt (neu)', eventId);
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      if (call.method === 'PATCH' && call.url.includes('/me/events/graph-evt-1')) {
        return jsonRes(200, { id: 'graph-evt-1', changeKey: 'ck-2' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.deepEqual(fetchImpl.calls.map((c) => c.method), ['GET', 'PATCH']);
    assert.equal(fetchImpl.calls[1].body.subject, 'Zahnarzt (neu)');
    assert.equal(linkRow(eventId).outlook_change_key, 'ck-2');
  });

  it('in Outlook veränderter Termin (changeKey-Drift) wird zurückgesetzt', async () => {
    // Lokal unverändert - nur der remote gemeldete changeKey weicht ab.
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call, {
        'cal-A': [{ id: 'graph-evt-1', changeKey: 'ck-extern' }],
      });
      if (drift) return drift;
      if (call.method === 'PATCH' && call.url.includes('/me/events/graph-evt-1')) {
        return jsonRes(200, { id: 'graph-evt-1', changeKey: 'ck-3' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1, 'Reassert trotz unverändertem lokalen Hash');
    assert.equal(fetchImpl.calls[1].body.subject, 'Zahnarzt (neu)', 'Yuvomi-Stand gewinnt');
    assert.equal(linkRow(eventId).outlook_change_key, 'ck-3');
  });

  it('Zielkalender-Wechsel löst Delete + Create aus', async () => {
    db.prepare('UPDATE calendar_events SET target_outlook_calendar_id = ? WHERE id = ?').run('cal-B', eventId);
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      if (call.method === 'DELETE' && call.url.includes('/me/events/graph-evt-1')) return jsonRes(204);
      if (call.method === 'POST' && call.url.includes('/me/calendars/cal-B/events')) {
        return jsonRes(201, { id: 'graph-evt-2', changeKey: 'ck-b1' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.deepEqual(fetchImpl.calls.map((c) => c.method), ['GET', 'DELETE', 'POST']);
    assert.equal(linkRow(eventId).outlook_event_id, 'graph-evt-2');
    assert.equal(linkRow(eventId).outlook_calendar_id, 'cal-B');
  });

  it('in Outlook gelöschter Termin wird ohne lokale Änderung neu angelegt', async () => {
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call, { 'cal-B': [] });
      if (drift) return drift;
      if (call.method === 'POST' && call.url.includes('/me/calendars/cal-B/events')) {
        return jsonRes(201, { id: 'graph-evt-3', changeKey: 'ck-b2' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.deepEqual(fetchImpl.calls.map((c) => c.method), ['GET', 'POST']);
    assert.equal(linkRow(eventId).outlook_event_id, 'graph-evt-3');
  });

  it('Fallback ohne Drift-Listing: PATCH-404 legt neu an', async () => {
    db.prepare('UPDATE calendar_events SET title = ? WHERE id = ?').run('Zahnarzt (v3)', eventId);
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET' && DRIFT_LIST_RE.test(call.url)) {
        return jsonRes(500, { error: { message: 'listing down' } });
      }
      if (call.method === 'PATCH') return jsonRes(404, { error: { message: 'ErrorItemNotFound' } });
      if (call.method === 'POST' && call.url.includes('/me/calendars/cal-B/events')) {
        return jsonRes(201, { id: 'graph-evt-4', changeKey: 'ck-b3' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 1);
    assert.equal(linkRow(eventId).outlook_event_id, 'graph-evt-4');
  });

  it('Events mit Nur-lesen-Ziel werden übersprungen', async () => {
    const roEventId = db.prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, color, created_by, target_outlook_account_id, target_outlook_calendar_id)
       VALUES ('RO', '2026-06-11T10:00', '#007AFF', ?, ?, 'cal-RO')`
    ).run(userId, accountId).lastInsertRowid;

    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.pushed + result.updated, 0);
    assert.equal(linkRow(roEventId), undefined);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(roEventId);
  });

  it('lokal gelöschtes Event: remote schon weg → Tombstone ohne DELETE-Request', async () => {
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
    assert.ok(linkRow(eventId), 'Link-Zeile muss das Event-Delete überleben');

    // Listing meldet den Termin als nicht (mehr) vorhanden → kein DELETE nötig.
    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call, { 'cal-B': [] });
      if (drift) return drift;
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.deleted, 1);
    assert.equal(fetchImpl.calls.length, 1, 'nur das Drift-Listing');
    assert.equal(linkRow(eventId), undefined);
  });

  it('invalid_grant beim Token-Refresh setzt needs_reauth und überspringt das Konto (letzter Test dieser Suite)', async () => {
    db.prepare('UPDATE outlook_accounts SET token_expiry = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), accountId);

    const fetchImpl = makeFetch((call) => {
      if (call.url.includes('login.microsoftonline.com') && call.url.includes('/token')) {
        return jsonRes(400, { error: 'invalid_grant', error_description: 'AADSTS70000: expired' });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.syncedAccounts, 0);
    assert.equal(accountRow().needs_reauth, 1);
    assert.match(accountRow().last_error, /Reconnect required/);

    // Folge-Sync fasst das Konto nicht mehr an (kein Token-Request).
    const quietFetch = makeFetch((call) => {
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    await outlook.sync({ fetchImpl: quietFetch });
    assert.equal(quietFetch.calls.length, 0);
  });
});
// --------------------------------------------------------
// Auto-Sync (v2): alle für den Konto-Owner sichtbaren lokalen Events
// --------------------------------------------------------

describe('Outlook auto-sync', () => {
  let anna;      // Owner von Konto A
  let ben;       // Owner von Konto B
  let stranger;  // Dritte Person (private Events)
  let accountA;
  let accountB;
  const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

  const linksFor = (eventId) =>
    db.prepare('SELECT * FROM outlook_event_links WHERE event_id = ? ORDER BY account_id').all(eventId);

  function insertUser(name) {
    return db.prepare(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES (?, ?, 'x', 'member')`
    ).run(name.toLowerCase(), name).lastInsertRowid;
  }

  function insertAccount(name, ownerId, autoCalId) {
    const id = db.prepare(
      `INSERT INTO outlook_accounts
         (name, ms_user_id, email, access_token, refresh_token, token_expiry,
          auto_sync_calendar_id, owner_user_id)
       VALUES (?, ?, ?, 'tok', 'ref', ?, ?, ?)`
    ).run(name, `ms-${name}`, `${name.toLowerCase()}@example.com`, futureExpiry, autoCalId, ownerId).lastInsertRowid;
    db.prepare(
      `INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
       VALUES (?, ?, 'Yuvomi', 1, 1)`
    ).run(id, autoCalId);
    return id;
  }

  function insertEvent({ title, createdBy, visibility = 'all', source = 'local', assignees = [] }) {
    const id = db.prepare(
      `INSERT INTO calendar_events
         (title, start_datetime, color, created_by, visibility, external_source)
       VALUES (?, '2026-09-01T10:00', '#007AFF', ?, ?, ?)`
    ).run(title, createdBy, visibility, source).lastInsertRowid;
    for (const uid of assignees) {
      db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(id, uid);
    }
    return id;
  }

  before(() => {
    // Saubere Ausgangslage: Events/Links/Konten der vorherigen Suite entfernen,
    // damit die sichtbarkeitsbasierte Kandidatenmenge deterministisch ist.
    db.prepare('DELETE FROM calendar_events').run();
    db.prepare('DELETE FROM outlook_event_links').run();
    db.prepare('DELETE FROM outlook_calendar_selection').run();
    db.prepare('DELETE FROM outlook_accounts').run();

    anna = insertUser('Anna');
    ben = insertUser('Ben');
    stranger = insertUser('Zoe');
    accountA = insertAccount('Anna Outlook', anna, 'yuvomi-cal-A');
    accountB = insertAccount('Ben Outlook', ben, 'yuvomi-cal-B');
  });

  it('updateAccount validiert den Zielkalender und aktiviert ihn implizit', () => {
    db.prepare(
      `INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
       VALUES (?, 'extra-cal', 'Extra', 1, 0)`
    ).run(accountA);

    outlook.updateAccount(accountA, { autoSyncCalendarId: 'extra-cal' });
    const row = db.prepare(
      'SELECT enabled FROM outlook_calendar_selection WHERE account_id = ? AND calendar_id = ?'
    ).get(accountA, 'extra-cal');
    assert.equal(row.enabled, 1, 'Auto-Sync-Kalender muss implizit aktiviert werden');

    assert.throws(() => outlook.updateAccount(accountA, { autoSyncCalendarId: 'does-not-exist' }));

    db.prepare(
      `INSERT INTO outlook_calendar_selection (account_id, calendar_id, calendar_name, can_edit, enabled)
       VALUES (?, 'ro-cal', 'ReadOnly', 0, 1)`
    ).run(accountA);
    assert.throws(() => outlook.updateAccount(accountA, { autoSyncCalendarId: 'ro-cal' }));

    // Zurück auf den eigentlichen Auto-Kalender.
    outlook.updateAccount(accountA, { autoSyncCalendarId: 'yuvomi-cal-A' });
  });

  it('collectCandidates: sichtbar-für-Owner, keine externen Events, explizites Ziel gewinnt', () => {
    const familyEvent  = insertEvent({ title: 'Familienessen', createdBy: anna, assignees: [anna, ben] });
    const plainEvent   = insertEvent({ title: 'Testtermin', createdBy: ben });
    const privateEvent = insertEvent({ title: 'Geheim', createdBy: stranger, visibility: 'private' });
    const icsEvent     = insertEvent({ title: 'Feiertag', createdBy: anna, source: 'ics' });
    const explicitEvent = insertEvent({ title: 'Explizit', createdBy: anna });
    db.prepare(
      'UPDATE calendar_events SET target_outlook_account_id = ?, target_outlook_calendar_id = ? WHERE id = ?'
    ).run(accountA, 'extra-cal', explicitEvent);

    const account = db.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountA);
    const candidates = outlook.__test.collectCandidates(db, account);

    assert.ok(candidates.has(familyEvent), 'für alle sichtbares Event ist Kandidat');
    assert.ok(candidates.has(plainEvent), 'Event ohne Zuweisung ist Kandidat');
    assert.ok(!candidates.has(privateEvent), 'privates Event einer anderen Person ist KEIN Kandidat');
    assert.ok(!candidates.has(icsEvent), 'extern synchronisiertes Event ist KEIN Kandidat');
    assert.equal(candidates.get(familyEvent).calendarId, 'yuvomi-cal-A');
    assert.equal(candidates.get(explicitEvent).calendarId, 'extra-cal', 'explizites Ziel gewinnt');

    const names = JSON.parse(candidates.get(familyEvent).event.assignee_names_json);
    assert.deepEqual(names, ['Anna', 'Ben'], 'Zuweisungs-Namen alphabetisch');

    // Aufräumen für die Sync-Tests: nur familyEvent + plainEvent behalten.
    db.prepare('DELETE FROM calendar_events WHERE id IN (?, ?, ?)').run(privateEvent, icsEvent, explicitEvent);
  });

  it('pusht in beide Konten mit Titel-Suffix (Composite-PK) bzw. ohne Suffix', async () => {
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'POST' && /\/me\/calendars\/yuvomi-cal-[AB]\/events\??$/.test(call.url)) {
        const side = call.url.includes('cal-A') ? 'A' : 'B';
        return jsonRes(201, { id: `graph-${side}-${call.body.subject}`, changeKey: `ck-${side}-1` });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    const result = await outlook.sync({ fetchImpl });
    // 2 Events × 2 Konten = 4 Creates.
    assert.equal(result.pushed, 4);
    assert.equal(result.syncedAccounts, 2);

    const subjects = fetchImpl.calls.map((c) => c.body.subject).sort();
    assert.deepEqual(subjects, [
      'Familienessen (Anna, Ben)', 'Familienessen (Anna, Ben)',
      'Testtermin', 'Testtermin',
    ], 'Suffix nur bei Zuweisungen, kein "Synced"-Zusatz');

    const familyEvent = db.prepare(`SELECT id FROM calendar_events WHERE title = 'Familienessen'`).get().id;
    assert.equal(linksFor(familyEvent).length, 2, 'ein Link je (Event, Konto)');
  });

  it('Zuweisungs-Änderung ändert den Hash und löst PATCH aus', async () => {
    const familyEvent = db.prepare(`SELECT id FROM calendar_events WHERE title = 'Familienessen'`).get().id;
    db.prepare('DELETE FROM event_assignments WHERE event_id = ? AND user_id = ?').run(familyEvent, ben);

    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      if (call.method === 'PATCH') return jsonRes(200, { changeKey: 'ck-after-patch' });
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.updated, 2, 'beide Konten patchen');
    for (const call of fetchImpl.calls.filter((c) => c.method === 'PATCH')) {
      assert.equal(call.body.subject, 'Familienessen (Anna)');
    }
  });

  it('Sichtbarkeits-Verlust entfernt das Remote-Event (Orphan-Pass)', async () => {
    const familyEvent = db.prepare(`SELECT id FROM calendar_events WHERE title = 'Familienessen'`).get().id;
    // Nur noch privat für Zoe sichtbar → fällt aus beiden Kandidatenmengen.
    db.prepare(`UPDATE calendar_events SET visibility = 'private', created_by = ? WHERE id = ?`)
      .run(stranger, familyEvent);
    db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(familyEvent);

    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      if (call.method === 'DELETE') return jsonRes(204);
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.deleted, 2, 'Remote-Delete in beiden Konten');
    assert.equal(linksFor(familyEvent).length, 0, 'Tombstone-Links abgeräumt');
  });

  it('Auto-Sync-Deaktivierung räumt alle Remote-Events des Kontos ab', async () => {
    outlook.updateAccount(accountB, { autoSyncCalendarId: null });

    const fetchImpl = makeFetch((call) => {
      const drift = answerDriftList(call);
      if (drift) return drift;
      if (call.method === 'DELETE') return jsonRes(204);
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const result = await outlook.sync({ fetchImpl });
    assert.equal(result.deleted, 1, 'verbliebenes Testtermin-Event von Konto B entfernt');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM outlook_event_links WHERE account_id = ?').get(accountB).c,
      0
    );
  });

  it('refreshCalendarSelection legt neue Kalender deaktiviert an, bekannte behalten ihren Zustand', async () => {
    const account = db.prepare('SELECT * FROM outlook_accounts WHERE id = ?').get(accountA);
    const fetchImpl = makeFetch((call) => {
      if (call.method === 'GET' && call.url.includes('/me/calendars')) {
        return jsonRes(200, { value: [
          { id: 'yuvomi-cal-A', name: 'Yuvomi', canEdit: true },
          { id: 'brand-new-cal', name: 'Neu', canEdit: true },
        ] });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    await outlook.__test.refreshCalendarSelection(account.id, 'tok', fetchImpl);

    const rows = Object.fromEntries(
      db.prepare('SELECT calendar_id, enabled FROM outlook_calendar_selection WHERE account_id = ?')
        .all(account.id).map((r) => [r.calendar_id, r.enabled])
    );
    assert.equal(rows['yuvomi-cal-A'], 1, 'bekannter aktivierter Kalender bleibt aktiv');
    assert.equal(rows['brand-new-cal'], 0, 'neuer Kalender startet deaktiviert');
  });
});

// --------------------------------------------------------
// Konfigurations-Guard (Parität zum Google-Verhalten)
// --------------------------------------------------------

describe('assertConfigured', () => {
  it('wirft ohne MS_*-Env denselben lauten Konfigurationsfehler wie Google', () => {
    const saved = process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_ID;
    try {
      assert.throws(() => outlook.assertConfigured(), /MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REDIRECT_URI/);
    } finally {
      process.env.MS_CLIENT_ID = saved;
    }
  });

  it('ist mit gesetzter Konfiguration ein No-Op', () => {
    assert.doesNotThrow(() => outlook.assertConfigured());
  });
});
