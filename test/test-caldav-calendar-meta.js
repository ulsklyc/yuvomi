// Farbe und Name einer Kalendersammlung kommen getrimmt an (#2157).
//
// Synology schickt `<calendar-color>#008E9E\n</calendar-color>` und einen
// `displayname` mit Newline am Ende, tsdav reicht beides ungetrimmt durch.
// Vorher fiel jede Farbe auf den Fallback (#4A90E2 bzw. die Apple-Farbe), und
// der Name trug den Umbruch. Gemessen wird an jeder Stelle, die eine
// Kalenderliste liest: CalDAV (Konto anlegen, Zugangsdaten aendern, Kalender
// aktualisieren), Apple (Inbound und Upload) und die Erinnerungslisten.
// Die Namen der CardDAV-Adressbuecher kommen ueber denselben tsdav-Pfad und
// folgen derselben Regel (#2160).

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dbmod = await import('../server/db.js');
const caldav = await import('../server/services/caldav-sync.js');
const apple = await import('../server/services/apple-calendar.js');
const { getReminderLists } = await import('../server/services/caldav-reminders-sync.js');
const carddav = await import('../server/services/cardav-sync.js');
const { normalizeCalColor, calendarDisplayName } = await import('../server/utils/calendar-meta.js');

const db = dbmod.get();
db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin','Admin','x','admin')").run();

// Wie Synology sie liefert.
const RAW_COLOR = '#008E9E\n';
const RAW_NAME  = 'Familie\n';
const CAL_URL   = 'https://nas.example/caldav/familie/';
const BLANK_URL = 'https://nas.example/caldav/leer/';
const TODO_URL  = 'https://nas.example/caldav/aufgaben/';

describe('calendar-meta: die geteilten Helfer', () => {
  it('trimmt die Farbe, bevor sie geprueft wird', () => {
    assert.equal(normalizeCalColor(RAW_COLOR), '#008E9E');
    assert.equal(normalizeCalColor('  #008E9EFF\r\n'), '#008E9E', 'Alpha faellt auch nach dem trim weg');
    assert.equal(normalizeCalColor('#008E9E'), '#008E9E');
  });

  it('bleibt bei allem anderen bei null', () => {
    for (const value of [undefined, null, '', ' \n', 'red', '#12345', { color: '#008E9E' }]) {
      assert.equal(normalizeCalColor(value), null, JSON.stringify(value));
    }
  });

  it('trimmt den Namen und faellt bei leerem Rest auf den Fallback', () => {
    assert.equal(calendarDisplayName(RAW_NAME, 'X'), 'Familie');
    assert.equal(calendarDisplayName(' \n\t', 'X'), 'X');
    assert.equal(calendarDisplayName(undefined, 'X'), 'X');
    assert.equal(calendarDisplayName({ _cdata: 'Familie' }, 'X'), 'X');
  });

  it('es gibt nur noch EINE Fassung, und keine Lesestelle umgeht sie', () => {
    // Zwei Kopien waren der Grund, warum der Fehler an zwei Stellen stand.
    const files = ['caldav-sync.js', 'apple-calendar.js', 'caldav-reminders-sync.js', 'caldav-outbound.js', 'cardav-sync.js'];
    for (const file of files) {
      const src = readFileSync(new URL(`../server/services/${file}`, import.meta.url), 'utf8');
      assert.ok(!/function\s+normalizeCalColor\b/.test(src), `${file}: eigene Kopie von normalizeCalColor`);
      assert.ok(!/\.displayName\s*\|\|/.test(src), `${file}: displayName ungetrimmt mit || verwendet`);
    }
  });
});

describe('CalDAV: Kalenderauswahl', () => {
  const client = async () => ({
    fetchCalendars: async () => [
      { url: CAL_URL,   displayName: RAW_NAME, calendarColor: RAW_COLOR, components: ['VEVENT'] },
      { url: BLANK_URL, displayName: ' \n',    calendarColor: ' ',       components: ['VEVENT'] },
    ],
  });
  const rows = (accountId) => Object.fromEntries(
    db.prepare('SELECT calendar_url, calendar_name, calendar_color FROM caldav_calendar_selection WHERE account_id = ?')
      .all(accountId).map((r) => [r.calendar_url, { name: r.calendar_name, color: r.calendar_color }])
  );
  const expected = {
    [CAL_URL]:   { name: 'Familie',          color: '#008E9E' },
    [BLANK_URL]: { name: 'Unnamed Calendar', color: '#4A90E2' },
  };
  const spoil = (accountId) => db.prepare(
    "UPDATE caldav_calendar_selection SET calendar_name = 'alt', calendar_color = '#000000' WHERE account_id = ?"
  ).run(accountId);

  let accountId;
  before(async () => {
    ({ accountId } = await caldav.addAccount('Synology', 'https://nas.example/caldav/', 'u', 'p', { createClient: client }));
  });

  it('Konto anlegen speichert Farbe und Namen getrimmt', () => {
    assert.deepEqual(rows(accountId), expected);
  });

  it('"Kalender aktualisieren" uebernimmt sie fuer ein Bestandskonto', async () => {
    spoil(accountId);
    const result = await caldav.getCalendars(accountId, { refresh: true, createClient: client });
    assert.deepEqual(rows(accountId), expected);
    const fromServer = result.find((c) => c.calendarUrl === CAL_URL);
    assert.equal(fromServer.calendarName, 'Familie');
    assert.equal(fromServer.calendarColor, '#008E9E');
  });

  it('neue Zugangsdaten lesen die Liste ebenso', async () => {
    spoil(accountId);
    await caldav.updateAccount(accountId, { password: 'neu', createClient: client });
    assert.deepEqual(rows(accountId), expected);
  });
});

describe('CalDAV: Erinnerungslisten', () => {
  it('der Listenname kommt getrimmt an, ein leerer faellt auf "Reminders"', async () => {
    const { accountId } = await caldav.addAccount('Synology Aufgaben', 'https://nas2.example/caldav/', 'u', 'p', {
      createClient: async () => ({ fetchCalendars: async () => [{ url: CAL_URL, displayName: 'Kalender' }] }),
    });
    const client = async () => ({
      fetchCalendars: async () => [
        { url: TODO_URL,  displayName: 'Einkauf\n', components: ['VTODO'] },
        { url: BLANK_URL, displayName: '\n',        components: ['VTODO'] },
      ],
    });
    const lists = await getReminderLists(accountId, { refresh: true, createClient: client });
    assert.deepEqual(lists.map((l) => l.listName).sort(), ['Einkauf', 'Reminders']);
    const stored = db.prepare('SELECT list_name FROM caldav_reminder_selection WHERE account_id = ? ORDER BY list_name')
      .all(accountId).map((r) => r.list_name);
    assert.deepEqual(stored, ['Einkauf', 'Reminders']);
  });
});

describe('Apple: Kalender-Metadaten', () => {
  const row = () => db.prepare("SELECT name, color FROM external_calendars WHERE source = 'apple' AND external_id = ?").get(CAL_URL);

  before(() => {
    apple.saveCredentials('https://caldav.icloud.test/', 'placeholder-user', 'placeholder-pass');
  });

  it('der Inbound speichert Farbe und Namen getrimmt', async () => {
    await apple.sync({
      makeClient: async () => ({
        fetchCalendars: async () => [{ url: CAL_URL, displayName: RAW_NAME, calendarColor: RAW_COLOR }],
        fetchCalendarObjects: async () => [],
        createCalendarObject: async () => ({}),
      }),
    });
    assert.deepEqual({ ...row() }, { name: 'Familie', color: '#008E9E' });
  });

  it('der Upload in den ersten Kalender ebenso', async () => {
    // Der Inbound scheitert an diesem Kalender, also schreibt nur der Upload
    // die Zeile - so misst der Fall dessen eigene Lesestelle.
    db.prepare("UPDATE external_calendars SET name = 'alt', color = '#000000' WHERE source = 'apple'").run();
    db.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, external_source)
      VALUES ('Geht hinauf', '2035-05-01T10:00:00Z', '2035-05-01T11:00:00Z', 1, 'local')
    `).run();
    const uploads = [];
    await apple.sync({
      makeClient: async () => ({
        fetchCalendars: async () => [{ url: CAL_URL, displayName: RAW_NAME, calendarColor: RAW_COLOR }],
        fetchCalendarObjects: async () => { throw new Error('nicht erreichbar'); },
        createCalendarObject: async ({ filename }) => { uploads.push(filename); return {}; },
      }),
    });
    assert.equal(uploads.length, 1, 'der Termin muss hinaufgehen, sonst misst der Fall nichts');
    assert.deepEqual({ ...row() }, { name: 'Familie', color: '#008E9E' });
  });
});

describe('CardDAV: Adressbuchnamen (#2160)', () => {
  const ABOOK_URL = 'https://nas.example/carddav/kontakte/';
  const EMPTY_URL = 'https://nas.example/carddav/leer/';
  const serverBooks = [
    { url: ABOOK_URL, displayName: 'Kontakte\n' },
    { url: EMPTY_URL, displayName: ' \n' },
  ];
  const rows = (accountId) => Object.fromEntries(
    db.prepare('SELECT addressbook_url, addressbook_name FROM carddav_addressbook_selection WHERE account_id = ?')
      .all(accountId).map((r) => [r.addressbook_url, r.addressbook_name])
  );
  const expected = { [ABOOK_URL]: 'Kontakte', [EMPTY_URL]: 'Unnamed Addressbook' };

  let accountId;
  before(async () => {
    carddav._mockTestConnection(async () => ({ ok: true, addressbooks: serverBooks }));
    ({ account: { id: accountId } } = await carddav.addAccount('Synology Kontakte', 'https://nas.example/carddav/', 'u', 'p'));
  });
  after(() => carddav._mockTestConnection(null));

  it('Konto anlegen speichert den Namen getrimmt', () => {
    assert.deepEqual(rows(accountId), expected);
  });

  it('"Adressbuecher aktualisieren" uebernimmt ihn fuer ein Bestandskonto', async () => {
    db.prepare("UPDATE carddav_addressbook_selection SET addressbook_name = 'alt' WHERE account_id = ?").run(accountId);
    const result = await carddav.discoverAddressbooks(accountId);
    assert.deepEqual(rows(accountId), expected);
    assert.equal(result.find((a) => a.url === ABOOK_URL).name, 'Kontakte');
  });

  it('die Fehlermeldung eines Adressbuchs traegt den getrimmten Namen', async () => {
    const client = { fetchVCards: async () => { throw new Error('nicht erreichbar'); } };
    const named = await carddav.syncAddressbook(accountId, ABOOK_URL, client, serverBooks[0]);
    assert.equal(named.errorMessage, 'Kontakte: nicht erreichbar');
    const blank = await carddav.syncAddressbook(accountId, EMPTY_URL, client, serverBooks[1]);
    assert.equal(blank.errorMessage, `${EMPTY_URL}: nicht erreichbar`);
  });
});
