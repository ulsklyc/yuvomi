/**
 * Test: ein gespiegelter Termin gehört zu (Konto, UID), nicht zur UID allein.
 *
 * Der Fehler (#1860): der Abruf suchte die bestehende Zeile nur über die UID,
 * über alle CalDAV-Konten hinweg. Lieferte ein zweites Konto ein Objekt mit
 * derselben UID, übernahm es die Zeile des ersten: Titel, Kalender und
 * Objektadresse gehörten danach dem zweiten Konto, und das Objekt des ersten
 * hatte keine Zeile mehr. Alte UIDs haben die Form `oikos-<Zeilen-Id>@oikos.local`;
 * zwei Installationen oder ein Export, der in ein zweites Konto importiert
 * wurde, treffen sich also ohne jedes Zutun auf derselben UID.
 *
 * Aufgaben und Einkaufsartikel waren schon je Konto geführt
 * (caldav-reminders-sync.js), Termine nicht - und bis hierher gab es keinen
 * einzigen Test mit zwei Konten.
 *
 * Geprüft wird:
 *   - zwei Konten mit derselben UID ergeben zwei Zeilen, jede an ihrem Konto,
 *     und ein weiterer Lauf ändert daran nichts;
 *   - eine Bearbeitung geht an das Objekt der eigenen Zeile, im Sync-Lauf wie
 *     im Sofortversuch, und jede Anfrage bleibt bei dem Konto, zu dem ihre
 *     Zeile gehört;
 *   - eine Löschung bleibt bei ihrem Konto;
 *   - eine Bestandszeile ohne Kalenderbezug wird weiter über die UID gefunden.
 *
 * Wie in test-caldav-http-refusals.js: echte Dienste, echter tsdav-Client,
 * echtes HTTP - hier gegen ZWEI Server aus test/caldav-fake-server.js, einen je
 * Konto.
 *
 * Ausführen: node --experimental-sqlite --test test/test-caldav-two-accounts.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const caldavSync = await import('../server/services/caldav-sync.js');

db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

const servers = { a: await startFakeDavServer(), b: await startFakeDavServer() };
test.after(() => Promise.all([servers.a.close(), servers.b.close()]));

const UID = 'oikos-7@oikos.local';

// ── Fixtures ────────────────────────────────────────────────────────────────────

function vevent(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T090000Z', `SUMMARY:${summary}`,
    'DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Ein Konto je Server, jedes mit einem ausgewählten Kalender, einem Nachbarn
 * darin (der Prune lässt einen Kalender in Ruhe, der gar nichts liefert) und
 * einem Objekt mit DERSELBEN UID wie im anderen Konto.
 */
function twoAccounts() {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();

  const out = {};
  for (const key of ['a', 'b']) {
    const dav = servers[key];
    dav.reset();
    const user = `user-${key}`;
    const accountId = Number(db.prepare(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password) VALUES (?, ?, ?, 'p')
    `).run(`Konto ${key.toUpperCase()}`, dav.url, user).lastInsertRowid);
    const url = dav.addCollection('family', { name: `Familie ${key.toUpperCase()}` });
    dav.putObject(url, 'neighbour.ics', vevent(`neighbour-${key}@test`, `Nachbar ${key}`));
    dav.putObject(url, 'shared.ics', vevent(UID, `Aus ${key.toUpperCase()}`));
    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, calendar_color, enabled)
      VALUES (?, ?, ?, '#4A90E2', 1)
    `).run(accountId, url, `Familie ${key.toUpperCase()}`);
    out[key] = { dav, user, accountId, url, objectUrl: `${url}shared.ics` };
  }
  return out;
}

/** Die Zeilen mit der geteilten UID, je Kalender-URL. */
function rowsByCalendar() {
  const rows = db.prepare(`
    SELECT e.*, c.external_id AS calendar_url
    FROM calendar_events e LEFT JOIN external_calendars c ON c.id = e.calendar_ref_id
    WHERE e.external_calendar_id = ? ORDER BY e.id
  `).all(UID);
  return { rows, of: (account) => rows.find((r) => r.calendar_url === account.url) };
}

function edit(id, title) {
  db.prepare('UPDATE calendar_events SET title = ?, outbound_dirty = 1 WHERE id = ?').run(title, id);
}

/** Konto, unter dem eine Anfrage beim Server ankam. */
function accountOf(request) {
  const [scheme, value] = String(request.headers.authorization || '').split(' ');
  return scheme === 'Basic' ? Buffer.from(value, 'base64').toString('utf8').split(':')[0] : null;
}

/** Jeder Server sieht nur Anfragen seines eigenen Kontos. */
function assertRequestsStayWithTheirAccount(accounts) {
  for (const account of Object.values(accounts)) {
    const foreign = account.dav.requests.filter((r) => accountOf(r) !== account.user);
    assert.deepEqual(
      foreign.map((r) => `${r.method} ${r.path} (${accountOf(r)})`), [],
      `beim Server von ${account.user} kamen Anfragen eines anderen Kontos an`
    );
  }
}

const summaryAt = (account) => /SUMMARY:(.*)/.exec(account.dav.getObject(account.url, 'shared.ics').data)[1].trim();

// ── Abruf ───────────────────────────────────────────────────────────────────────

test('dieselbe UID in zwei Konten: zwei Zeilen, jede an ihrem Konto', async () => {
  const accounts = twoAccounts();
  await caldavSync.sync();

  let { rows, of } = rowsByCalendar();
  assert.equal(rows.length, 2, `aus zwei Objekten in zwei Konten wurde(n) ${rows.length} Zeile(n)`);
  for (const key of ['a', 'b']) {
    const row = of(accounts[key]);
    assert.ok(row, `das Objekt aus Konto ${key.toUpperCase()} hat keine Zeile an seinem Kalender`);
    assert.equal(row.title, `Aus ${key.toUpperCase()}`);
    assert.equal(row.external_object_url, accounts[key].objectUrl);
  }
  const ids = rows.map((r) => r.id);

  // Ein zweiter Lauf: dieselben zwei Zeilen, nichts wandert hin und her.
  await caldavSync.sync();
  ({ rows, of } = rowsByCalendar());
  assert.deepEqual(rows.map((r) => r.id), ids, 'der Folgelauf hat Zeilen neu angelegt oder zusammengelegt');
  assert.equal(of(accounts.a).title, 'Aus A');
  assert.equal(of(accounts.b).title, 'Aus B');
  assertRequestsStayWithTheirAccount(accounts);
});

test('dieselbe UID in zwei Konten: ein Termin, der nur im ersten lag, bleibt dessen Zeile', async () => {
  const accounts = twoAccounts();
  // Zuerst nur Konto A: seine Zeile entsteht und wird hier zugewiesen.
  const bObject = accounts.b.dav.getObject(accounts.b.url, 'shared.ics').data;
  accounts.b.dav.reset();
  const urlB = accounts.b.dav.addCollection('family', { name: 'Familie B' });
  accounts.b.dav.putObject(urlB, 'neighbour.ics', vevent('neighbour-b@test', 'Nachbar b'));
  await caldavSync.sync();
  const first = rowsByCalendar().of(accounts.a);
  assert.ok(first);

  // Dann taucht dieselbe UID im zweiten Konto auf.
  accounts.b.dav.putObject(urlB, 'shared.ics', bObject);
  await caldavSync.sync();

  const { rows, of } = rowsByCalendar();
  assert.equal(rows.length, 2);
  assert.equal(of(accounts.a).id, first.id, 'die Zeile des ersten Kontos ist nicht mehr dieselbe');
  assert.equal(of(accounts.a).title, 'Aus A', 'das zweite Konto hat die Zeile des ersten überschrieben');
  assert.equal(of(accounts.a).external_object_url, accounts.a.objectUrl);
  assert.equal(of(accounts.b).title, 'Aus B');
});

// ── Ausgang ─────────────────────────────────────────────────────────────────────

test('dieselbe UID in zwei Konten: eine Bearbeitung geht im Sync-Lauf an das Objekt der eigenen Zeile', async () => {
  const accounts = twoAccounts();
  await caldavSync.sync();
  const { of } = rowsByCalendar();
  edit(of(accounts.a).id, 'A bearbeitet');
  edit(of(accounts.b).id, 'B bearbeitet');

  await caldavSync.sync();

  assert.equal(summaryAt(accounts.a), 'A bearbeitet');
  assert.equal(summaryAt(accounts.b), 'B bearbeitet');
  const now = rowsByCalendar();
  assert.equal(now.of(accounts.a).outbound_dirty, 0);
  assert.equal(now.of(accounts.b).outbound_dirty, 0);
  assertRequestsStayWithTheirAccount(accounts);

  // Und der Abruf danach lässt beide stehen.
  await caldavSync.sync();
  assert.equal(rowsByCalendar().of(accounts.a).title, 'A bearbeitet');
  assert.equal(rowsByCalendar().of(accounts.b).title, 'B bearbeitet');
});

/** Zwei schon gespiegelte Zeilen mit derselben UID, ohne Abruf davor. */
function mirroredInBoth(accounts) {
  const ids = {};
  for (const key of ['a', 'b']) {
    const account = accounts[key];
    const refId = db.prepare(`
      INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav', ?, ?, '#4A90E2') RETURNING id
    `).get(account.url, `Familie ${key.toUpperCase()}`).id;
    ids[key] = Number(db.prepare(`
      INSERT INTO calendar_events
        (title, start_datetime, end_datetime, all_day, created_by, external_source,
         external_calendar_id, calendar_ref_id, external_object_url)
      VALUES (?, '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?, ?, ?)
    `).run(`Aus ${key.toUpperCase()}`, UID, refId, account.objectUrl).lastInsertRowid);
  }
  return ids;
}

test('dieselbe UID in zwei Konten: der Sofortversuch schreibt jede Bearbeitung in ihr eigenes Konto', async () => {
  const accounts = twoAccounts();
  const ids = mirroredInBoth(accounts);
  edit(ids.a, 'A bearbeitet');
  edit(ids.b, 'B bearbeitet');

  await caldavSync.flushOutbound();

  assertRequestsStayWithTheirAccount(accounts);
  assert.equal(summaryAt(accounts.a), 'A bearbeitet');
  assert.equal(summaryAt(accounts.b), 'B bearbeitet');
  for (const key of ['a', 'b']) {
    assert.equal(accounts[key].dav.seen('PUT').length, 1, `Konto ${key.toUpperCase()} bekam nicht genau eine Änderung`);
  }
});

test('zwei Konten mit je einer wartenden Löschung: jede läuft in ihrem eigenen Konto', async () => {
  const accounts = twoAccounts();
  const tombstone = db.prepare(`
    INSERT INTO calendar_pending_deletions (source, calendar_external_id, event_external_id, object_url)
    VALUES ('caldav', ?, ?, ?)
  `);
  for (const account of Object.values(accounts)) tombstone.run(account.url, UID, account.objectUrl);

  await caldavSync.flushOutbound();

  assertRequestsStayWithTheirAccount(accounts);
  for (const key of ['a', 'b']) {
    assert.equal(accounts[key].dav.getObject(accounts[key].url, 'shared.ics'), null,
      `das Objekt in Konto ${key.toUpperCase()} wurde nicht gelöscht`);
    assert.equal(accounts[key].dav.seen('DELETE').length, 1);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_pending_deletions').get().n, 0);
});

// ── Bestand ─────────────────────────────────────────────────────────────────────

test('Bestandszeile ohne Kalenderbezug: der Abruf findet sie weiter über die UID', async () => {
  const accounts = twoAccounts();
  // Nur Konto A liefert die UID; die Zeile stammt aus der Zeit vor calendar_ref_id.
  accounts.b.dav.reset();
  const id = Number(db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, all_day, created_by, external_source, external_calendar_id)
    VALUES ('Alt', '2035-03-10T09:00Z', '2035-03-10T10:00Z', 0, 1, 'caldav', ?)
  `).run(UID).lastInsertRowid);

  await caldavSync.sync();

  const { rows, of } = rowsByCalendar();
  assert.equal(rows.length, 1, 'die Bestandszeile wurde verdoppelt statt übernommen');
  assert.equal(of(accounts.a)?.id, id);
  assert.equal(rows[0].title, 'Aus A');
});
