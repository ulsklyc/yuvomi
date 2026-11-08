/**
 * Test: die eingetragene CalDAV-Adresse selbst ist ein Kalender (#2529).
 *
 * Der Fehler: zeigt die `caldav_url` eines Kontos direkt auf eine bestimmte
 * Collection - etwa einen öffentlichen Kalender unter
 * `.../dav/calendars/public/Familienkalender/`, wie ihn Grommunio oder eine
 * geteilte Nextcloud-Collection anbietet -, folgte die Auflistung trotzdem
 * der Discovery zum Principal des angemeldeten Benutzers und nannte nur
 * dessen eigene Kalender. Die eingetragene Adresse kam nie in die Auswahl,
 * und stand sie doch darin, galt sie beim Abgleich als verschwunden und
 * wurde abgeschaltet: gelesen und geschrieben wurde still der
 * Benutzerordner statt des eingetragenen Pfades.
 *
 * Geprüft wird am echten tsdav gegen `test/caldav-fake-server.js`, dessen
 * Home-Auflistung - wie ein echter Server - nur noch nennt, was im
 * Home-Ordner liegt; die öffentliche Collection liegt ausserhalb.
 *
 * Ausführen: node --experimental-sqlite test/test-caldav-configured-path.js
 */

process.env.SESSION_SECRET = 'test-secret-configured-path';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDavServer } from './caldav-fake-server.js';

const dbmod = await import('../server/db.js');
const db = dbmod.get();
const { createCalDAVClient } = await import('../server/utils/caldav-client.js');
const caldavSync = await import('../server/services/caldav-sync.js');

db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')"
).run();

const dav = await startFakeDavServer();
test.after(() => dav.close());

function reset() {
  for (const table of [
    'calendar_pending_deletions', 'calendar_events', 'external_calendars',
    'caldav_calendar_selection', 'caldav_accounts',
  ]) db.prepare(`DELETE FROM ${table}`).run();
  dav.reset();
}

const vevent = (uid, summary) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
  'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`,
  'DTSTART:20350310T090000Z', 'DTEND:20350310T100000Z', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const PUBLIC_PATH = '/dav/calendars/public/Familienkalender/';

test('die Auflistung nennt den Kalender unter der eingetragenen Adresse', async () => {
  reset();
  const personal = dav.addCollection('personal', { name: 'Persönlich' });
  const family = dav.addCollectionAt(PUBLIC_PATH, { name: 'Familienkalender' });

  const client = await createCalDAVClient({ caldav_url: family, username: 'u', password: 'p' });
  const urls = (await client.fetchCalendars()).map((cal) => cal.url);

  assert.ok(urls.includes(family), `eingetragener Kalender fehlt in der Auflistung: ${urls.join(', ')}`);
  assert.ok(urls.includes(personal), 'die Discovery-Kalender bleiben in der Auflistung');
});

test('ein Konto auf die Collection zeigt: Auswahl, Abgleich und Termin laufen über sie', async () => {
  reset();
  dav.addCollection('personal', { name: 'Persönlich' });
  const family = dav.addCollectionAt(PUBLIC_PATH, { name: 'Familienkalender' });
  dav.putObject(family, 'familie.ics', vevent('familie@test', 'Familientermin'));

  const { accountId } = await caldavSync.addAccount('Öffentlich', family, 'u', 'p');
  const chosen = db.prepare(
    'SELECT enabled FROM caldav_calendar_selection WHERE account_id = ? AND calendar_url = ?'
  ).get(accountId, family);
  assert.ok(chosen, 'die eingetragene Collection steht nicht in der Auswahl');

  caldavSync.updateCalendarSelection(accountId, family, true);
  const result = await caldavSync.sync();
  assert.equal(result.success, true);

  const after = db.prepare(
    'SELECT enabled FROM caldav_calendar_selection WHERE account_id = ? AND calendar_url = ?'
  ).get(accountId, family);
  assert.equal(after.enabled, 1, 'der Abgleich hat den eingetragenen Kalender abgeschaltet');

  const mirrored = db.prepare(
    "SELECT title FROM calendar_events WHERE external_source = 'caldav' AND title = 'Familientermin'"
  ).get();
  assert.ok(mirrored, 'der Termin aus der eingetragenen Collection wurde nicht gespiegelt');
});

test('eine verweigerte Tiefenantwort auf die Collection fängt die flache Abfrage auf', async () => {
  reset();
  dav.addCollection('personal', { name: 'Persönlich' });
  const family = dav.addCollectionAt(PUBLIC_PATH, { name: 'Familienkalender' });
  dav.putObject(family, 'familie.ics', vevent('familie@test', 'Familientermin'));
  // tsdav verlangt an jedem Eintrag einer Tiefenantwort einen resourcetype;
  // nennt ein Server an den Objekten keinen, ist die Collection so nicht zu
  // listen - flach gefragt (Depth: 0) nennt sie sich selbst.
  dav.refuse({
    method: 'PROPFIND', path: PUBLIC_PATH, status: 404,
    when: (req) => req.headers.depth === '1',
  });

  const client = await createCalDAVClient({ caldav_url: family, username: 'u', password: 'p' });
  const found = (await client.fetchCalendars()).find((cal) => cal.url === family);

  assert.ok(found, 'die eingetragene Collection fehlt trotz flacher Abfrage');
  assert.equal(found.displayName, 'Familienkalender');
  assert.deepEqual(found.components, ['VEVENT']);
});

test('ein Konto auf die Server-Wurzel sieht nur die Discovery, nichts dazu', async () => {
  reset();
  const personal = dav.addCollection('personal', { name: 'Persönlich' });
  dav.addCollectionAt(PUBLIC_PATH, { name: 'Familienkalender' });

  const client = await createCalDAVClient({ caldav_url: dav.url, username: 'u', password: 'p' });
  const urls = (await client.fetchCalendars()).map((cal) => cal.url);

  assert.deepEqual(urls, [personal], 'ohne eingetragenen Pfad bleibt die Auflistung die der Discovery');
});

test('Eine leere Auflistung laesst jeden eingeschalteten Kalender eingeschaltet', async () => {
  const personal = dav.addCollection('personal', { name: 'Personal' });
  const work = dav.addCollection('work', { name: 'Work' });
  // Das Konto zeigt auf eine Collection IM Home-Ordner, wie es eine
  // eingefügte Kalenderadresse üblicherweise tut.
  const account = await caldavSync.addAccount({
    name: 'CfgEmpty', caldav_url: personal, username: 'cfg-empty', password: 'secret',
  });
  await caldavSync.updateCalendarSelection(account.id, [
    { calendar_url: personal, calendar_name: 'Personal', enabled: true },
    { calendar_url: work, calendar_name: 'Work', enabled: true },
  ]);
  // Der Server antwortet gueltig, aber leer: der Multistatus nennt nur
  // die Home-Collection selbst, keinen Kalender (#508).
  dav.refuse({
    method: 'PROPFIND', path: '/cal/', status: 207,
    contentType: 'application/xml', body: dav.homeOnlyListing(),
  });

  // Die Zusatzabfrage darf aus der leeren Antwort keinen Treffer machen.
  const client = await createCalDAVClient({
    caldav_url: personal, username: 'cfg-empty', password: 'secret',
  });
  assert.deepEqual(await client.fetchCalendars(), []);

  await assert.doesNotReject(() => caldavSync.sync());
  const rows = db.get().prepare(
    'SELECT calendar_url, enabled FROM caldav_calendar_selection WHERE account_id = ?'
  ).all(account.id);
  assert.equal(rows.find((r) => r.calendar_url === personal)?.enabled, 1,
    'der eingetragene Kalender bleibt eingeschaltet');
  assert.equal(rows.find((r) => r.calendar_url === work)?.enabled, 1,
    'der zweite Kalender gilt nicht als verschwunden');
});

test('Eine Principal-Adresse ist kein Kalender und loest keine Zusatzabfrage aus', async () => {
  const personal = dav.addCollection('personal', { name: 'Personal' });
  const principal = `${dav.origin}/principals/u/`;
  const client = await createCalDAVClient({
    caldav_url: principal, username: 'cfg-principal', password: 'secret',
  });
  const listed = await client.fetchCalendars();
  assert.deepEqual(listed.map((cal) => cal.url), [personal],
    'die Auflistung bleibt die der Discovery');

  // Vergleichskonto an der Server-Wurzel: dort ist keine Zusatzabfrage
  // moeglich. Nach der ersten Auflistung (Discovery eingerechnet) muss
  // eine zweite beim Principal-Konto denselben Verkehr erzeugen.
  const control = await createCalDAVClient({
    caldav_url: dav.url, username: 'cfg-root', password: 'secret',
  });
  await control.fetchCalendars();
  const profile = async (c) => {
    dav.requests.length = 0;
    await c.fetchCalendars();
    return dav.requests.map((r) => `${r.method} ${r.path} ${r.headers.depth ?? ''}`);
  };
  assert.deepEqual(await profile(client), await profile(control),
    'keine PROPFINDs ausser denen der Discovery selbst');
});

test('Die eingetragene Collection wird flach gefragt, nicht tief aufgelistet', async () => {
  dav.addCollection('personal', { name: 'Personal' });
  const pub = dav.addCollectionAt(PUBLIC_PATH, { name: 'Familienkalender' });
  dav.putObject(pub, 'a.ics', icsEvent('cfg-public-1@fake', 'Oeffentlicher Termin'));
  const client = await createCalDAVClient({
    caldav_url: pub, username: 'cfg-depth', password: 'secret',
  });
  const listed = await client.fetchCalendars();
  assert.ok(listed.some((cal) => cal.url === pub), 'die Collection steht in der Auflistung');
  const probes = dav.requests.filter((r) => r.method === 'PROPFIND' && r.path === PUBLIC_PATH);
  assert.ok(probes.length >= 1, 'die Adresse wurde selbst gefragt');
  assert.ok(probes.every((r) => r.headers.depth === '0'),
    'keine Tiefenabfrage (Depth: 1) auf die eingetragene Collection');
});
