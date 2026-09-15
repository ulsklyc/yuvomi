/**
 * Test: Geburtstags-Lokalisierung im Kalender (Issues #524, #631, #632)
 *
 * Zwei Schichten, die zusammengehören:
 *
 * 1. Kalender-Read (#524): Der Read MUSS bei Geburtstags-Terminen birthday_name
 *    (+ birthday_date) über den LEFT JOIN auf birthdays mitliefern - und bei
 *    Nicht-Geburtstagen NICHT. Darauf sitzt die clientseitige Übersetzung in
 *    public/utils/birthday-event.js.
 *
 * 2. Gespeicherter Titel (#631, #632): Der Titel in calendar_events ist das, was
 *    REST-API, ICS-Feed, CalDAV-/Google-Outbound und der FTS-Index zu sehen
 *    bekommen - keiner dieser Kanäle durchläuft die Client-Übersetzung. Er wird
 *    deshalb in der Datensprache des Haushalts geschrieben (`language` in
 *    sync_config, ersatzweise aus `region` abgeleitet, sonst Englisch). Ein
 *    Wechsel der Sprache MUSS die Bestandstermine nachziehen, sonst steht in
 *    externen Kalendern noch monatelang die alte Fassung.
 *
 * Geprüft wird der echte Vertrag über Birthdays-, Kalender- und
 * Preferences-Router auf der migrierten DB, plus buildFeed() für den ICS-Export.
 * Ausführen: node --experimental-sqlite --test test/test-birthday-localization.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

const dbmod = await import('../server/db.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const { buildFeed } = await import('../server/services/ics-export.js');
const { hydrateBirthday, syncBirthdayArtifacts } = await import('../server/services/birthdays.js');
const db = dbmod.get();

const USER = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`
).run().lastInsertRowid;

const actor = { id: USER, role: 'member' };
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/birthdays', birthdaysRouter);
app.use('/calendar', calendarRouter);
app.use('/preferences', preferencesRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) =>
  server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

test('GET /calendar liefert birthday_name+birthday_date für Geburtstags-Termine', async () => {
  const created = await call('POST', '/birthdays', { name: 'Lina Müller', birth_date: '1990-05-12' });
  assert.equal(created.status, 201);

  // Serie startet am Geburtsdatum; ein weites Fenster fängt die nächste Instanz.
  const res = await call('GET', '/calendar?from=1990-01-01&to=2100-12-31');
  assert.equal(res.status, 200);

  const bday = res.body.data.find((e) => e.birthday_name);
  assert.ok(bday, 'ein Event trägt birthday_name');
  assert.equal(bday.birthday_name, 'Lina Müller');
  assert.equal(bday.birthday_date, '1990-05-12');
  // Ohne gesetzte Datensprache und ohne Region bleibt es beim englischen
  // Bestandsverhalten - ein Update darf einem Haushalt die Titel nicht still
  // unter den Füßen wegziehen.
  assert.equal(bday.title, 'Birthday: Lina Müller');
});

test('a name day gets its own localized calendar event and the same reminder offset', async () => {
  await asAdmin(() => call('PUT', '/preferences', { language: 'de' }));
  const created = await call('POST', '/birthdays', {
    name: 'Jiří',
    birth_date: '1990-04-23',
    name_day: '04-24',
    reminder_offset: '1440',
  });
  assert.equal(created.status, 201);

  const links = db.prepare(`
    SELECT calendar_event_id, name_day_calendar_event_id
    FROM birthdays WHERE id = ?
  `).get(created.body.data.id);
  assert.ok(links.calendar_event_id);
  assert.ok(links.name_day_calendar_event_id);
  assert.notEqual(links.calendar_event_id, links.name_day_calendar_event_id);

  const nameDayEvent = db.prepare(`
    SELECT title, description, start_datetime, recurrence_rule, icon
    FROM calendar_events WHERE id = ?
  `).get(links.name_day_calendar_event_id);
  assert.equal(nameDayEvent.title, 'Namenstag: Jiří');
  assert.equal(nameDayEvent.description, 'Jiří hat Namenstag.');
  assert.equal(nameDayEvent.start_datetime.slice(5), '04-24');
  assert.equal(nameDayEvent.recurrence_rule, 'FREQ=YEARLY;INTERVAL=1');
  assert.equal(nameDayEvent.icon, 'balloon');
  assert.equal(
    db.prepare('SELECT icon FROM calendar_events WHERE id = ?').get(links.calendar_event_id).icon,
    'cake',
  );

  const reminders = db.prepare(`
    SELECT entity_id, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id IN (?, ?)
    ORDER BY entity_id
  `).all(links.calendar_event_id, links.name_day_calendar_event_id);
  assert.equal(reminders.length, 2, 'one shared setting creates reminders for both occurrences');

  const calendar = await call('GET', '/calendar?from=2026-01-01&to=2026-12-31');
  const nameDay = calendar.body.data.find((event) => event.id === links.name_day_calendar_event_id);
  assert.equal(nameDay.birthday_name, 'Jiří', 'the shared marker keeps the occurrence in the birthday layer');
  assert.equal(nameDay.birthday_event_kind, 'name_day');
  assert.equal(nameDay.name_day, '04-24');
});

test('clearing a name day removes only its calendar event and reminder', async () => {
  const created = await call('POST', '/birthdays', {
    name: 'Klára',
    birth_date: '1991-08-12',
    name_day: '08-13',
  });
  const links = db.prepare(`
    SELECT calendar_event_id, name_day_calendar_event_id
    FROM birthdays WHERE id = ?
  `).get(created.body.data.id);

  const updated = await call('PUT', `/birthdays/${created.body.data.id}`, { name_day: null });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.name_day, null);
  assert.equal(
    db.prepare('SELECT id FROM calendar_events WHERE id = ?').get(links.name_day_calendar_event_id),
    undefined,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE entity_id = ?').get(links.name_day_calendar_event_id).n,
    0,
  );
  assert.ok(
    db.prepare('SELECT id FROM calendar_events WHERE id = ?').get(links.calendar_event_id),
    'the birthday event remains in place',
  );
});

test('29 February name day resolves to the same non-leap-year date in list and calendar', async () => {
  setConfig('household_timezone', 'UTC');
  const created = await call('POST', '/birthdays', {
    name: 'Leap name day',
    birth_date: '1990-08-10',
    name_day: '02-29',
  });
  assert.equal(created.status, 201);

  const row = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(created.body.data.id);
  const listed = hydrateBirthday(db, row, new Date('2027-02-01T12:00:00Z'));
  assert.equal(listed.next_name_day, '2027-02-28');

  const calendar = await call('GET', '/calendar?from=2027-02-01&to=2027-03-05');
  const occurrence = calendar.body.data.find((event) =>
    event.id === row.name_day_calendar_event_id && event.birthday_event_kind === 'name_day');
  assert.ok(occurrence);
  assert.equal(occurrence.start_datetime.slice(0, 10), listed.next_name_day);
});

test('name-day reminder uses local noon in the household time zone', () => {
  setConfig('household_timezone', 'Europe/Prague');
  const id = db.prepare(`
    INSERT INTO birthdays (name, birth_date, name_day, reminder_offset, created_by)
    VALUES ('Prague name day', '1990-08-10', '05-24', '1440', ?)
  `).run(USER).lastInsertRowid;
  const row = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(id);
  const synced = syncBirthdayArtifacts(db, row, new Date('2026-01-15T12:00:00Z'));
  const reminder = db.prepare(`
    SELECT remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND dismissed = 0
  `).get(synced.name_day_calendar_event_id);

  assert.equal(reminder.remind_at, '2026-05-23T10:00:00.000Z');
  setConfig('household_timezone', 'UTC');
});

test('Nicht-Geburtstags-Termine tragen KEIN birthday_name-Feld', async () => {
  db.prepare(`
    INSERT INTO calendar_events (title, start_datetime, all_day, created_by, external_source)
    VALUES ('Zahnarzt', '2026-07-20', 1, ?, 'local')
  `).run(USER);

  const res = await call('GET', '/calendar?from=2026-07-01&to=2026-07-31');
  assert.equal(res.status, 200);
  const plain = res.body.data.find((e) => e.title === 'Zahnarzt');
  assert.ok(plain, 'Nicht-Geburtstags-Termin ist enthalten');
  assert.ok(!('birthday_name' in plain), 'kein birthday_name-Schlüssel bei Nicht-Geburtstagen');
});

test('de-Referenz-Locale trägt alle neuen Keys mit {{name}}-Platzhalter', () => {
  const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url)));
  assert.match(de.birthdays.calendarEventTitle, /\{\{name\}\}/);
  assert.match(de.birthdays.calendarEventDescription, /\{\{name\}\}/);
  assert.match(de.birthdays.calendarEventDescription, /\{\{date\}\}/);
  // Fallback ohne Datum: {{name}}, aber kein {{date}} (keine leere Klammer).
  assert.match(de.birthdays.calendarEventDescriptionNoDate, /\{\{name\}\}/);
  assert.doesNotMatch(de.birthdays.calendarEventDescriptionNoDate, /\{\{date\}\}/);
  assert.match(de.birthdays.nameDayCalendarEventTitle, /\{\{name\}\}/);
  assert.match(de.birthdays.nameDayCalendarEventDescription, /\{\{name\}\}/);
});

// ---------------------------------------------------------------------------
// Datensprache des Haushalts (#631, #632)
// ---------------------------------------------------------------------------

function storedEvent(birthdayId) {
  return db.prepare(`
    SELECT e.title, e.description
    FROM birthdays b JOIN calendar_events e ON e.id = b.calendar_event_id
    WHERE b.id = ?
  `).get(birthdayId);
}

function storedNameDayEvent(birthdayId) {
  return db.prepare(`
    SELECT e.title, e.description
    FROM birthdays b JOIN calendar_events e ON e.id = b.name_day_calendar_event_id
    WHERE b.id = ?
  `).get(birthdayId);
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO sync_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/** Führt einen Aufruf als Admin aus und stellt die Mitglieds-Rolle danach wieder her. */
async function asAdmin(fn) {
  actor.role = 'admin';
  try {
    return await fn();
  } finally {
    actor.role = 'member';
  }
}

test('gesetzte Datensprache bestimmt Titel und Beschreibung des Termins', async () => {
  setConfig('language', 'de');
  setConfig('date_format', 'dmy');

  const created = await call('POST', '/birthdays', { name: 'Jonas', birth_date: '1988-03-04' });
  assert.equal(created.status, 201);

  const event = storedEvent(created.body.data.id);
  assert.equal(event.title, 'Geburtstag: Jonas');
  // Das Datum in der Beschreibung folgt der Haushalts-Einstellung date_format,
  // damit ein exportierter Termin dasselbe Datum zeigt wie die Oberfläche.
  assert.equal(event.description, 'Geburtstagserinnerung für Jonas (04.03.1988).');
});

test('ohne gesetzte Sprache leitet die Region sie ab', async () => {
  db.prepare(`DELETE FROM sync_config WHERE key = 'language'`).run();
  setConfig('region', 'fr-FR');

  const created = await call('POST', '/birthdays', { name: 'Chloé', birth_date: '1995-11-20' });
  assert.equal(created.status, 201);
  assert.equal(storedEvent(created.body.data.id).title, 'Anniversaire : Chloé');
});

test('ohne Sprache und ohne Region gilt Englisch, nicht die Referenz-Locale', async () => {
  db.prepare(`DELETE FROM sync_config WHERE key IN ('language', 'region')`).run();

  const created = await call('POST', '/birthdays', { name: 'Sam', birth_date: '2001-01-09' });
  assert.equal(created.status, 201);
  assert.equal(storedEvent(created.body.data.id).title, 'Birthday: Sam');
});

test('PUT /preferences betitelt bestehende Geburtstags-Termine um', async () => {
  db.prepare(`DELETE FROM sync_config WHERE key IN ('language', 'region')`).run();
  const created = await call('POST', '/birthdays', {
    name: 'Nora',
    birth_date: '1992-06-30',
    name_day: '07-01',
  });
  assert.equal(storedEvent(created.body.data.id).title, 'Birthday: Nora');
  assert.equal(storedNameDayEvent(created.body.data.id).title, 'Name day: Nora');

  const saved = await asAdmin(() => call('PUT', '/preferences', { language: 'de' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.language, 'de');
  assert.equal(saved.body.data.language_effective, 'de');
  // Ohne Region fiele die Automatik auf Englisch - das Label der
  // Automatik-Option darf nicht die gerade gewählte Sprache versprechen.
  assert.equal(saved.body.data.language_auto, 'en');

  // Der Kern von #632: der Wechsel muss die bereits gespeicherten Zeilen
  // erreichen, nicht nur künftige Termine.
  assert.equal(storedEvent(created.body.data.id).title, 'Geburtstag: Nora');
  assert.equal(storedNameDayEvent(created.body.data.id).title, 'Namenstag: Nora');
  const first = db.prepare(`SELECT id FROM birthdays ORDER BY id ASC`).get().id;
  assert.equal(storedEvent(first).title, 'Geburtstag: Lina Müller');
});

test('ICS-Feed exportiert den lokalisierten Titel', async () => {
  // Vorbedingung selbst setzen statt sie vom vorigen Test zu erben: ein
  // eingeschobener Test würde sonst diese Zusicherung still verschieben.
  await asAdmin(() => call('PUT', '/preferences', { language: 'de' }));

  const feed = buildFeed(db, USER);
  assert.match(feed, /SUMMARY:Geburtstag: Nora/);
  assert.doesNotMatch(feed, /SUMMARY:Birthday: /);
});

test('Zurück auf automatisch stellt die abgeleitete Sprache wieder her', async () => {
  setConfig('region', 'en-GB');
  const saved = await asAdmin(() => call('PUT', '/preferences', { language: null }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.language, null);
  assert.equal(saved.body.data.language_effective, 'en');

  const first = db.prepare(`SELECT id FROM birthdays ORDER BY id ASC`).get().id;
  assert.equal(storedEvent(first).title, 'Birthday: Lina Müller');
});

test('PUT /preferences weist ungültige Sprachen ab und verlangt Admin', async () => {
  const invalid = await asAdmin(() => call('PUT', '/preferences', { language: 'klingon' }));
  assert.equal(invalid.status, 400);

  const forbidden = await call('PUT', '/preferences', { language: 'de' });
  assert.equal(forbidden.status, 403, 'Mitglieder ändern keine haushaltweite Datensprache');
});

// Die Datensprache lässt sich über drei Felder verschieben. Ein Guard nur auf
// `language` deckt die Beispiele ab, nicht die Regel: `region` und `date_format`
// führen genauso in den Backfill, und `region` ist der Weg, über den ein
// Mitglied das Admin-Gate sonst umginge.

test('region allein verschiebt die Sprache bestehender Termine', async () => {
  db.prepare(`DELETE FROM sync_config WHERE key = 'language'`).run();
  setConfig('region', 'en-GB');
  await asAdmin(() => call('PUT', '/preferences', { region: 'en-GB' }));

  const first = db.prepare(`SELECT id FROM birthdays ORDER BY id ASC`).get().id;
  assert.equal(storedEvent(first).title, 'Birthday: Lina Müller');

  const saved = await asAdmin(() => call('PUT', '/preferences', { region: 'it-IT' }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.language_effective, 'it');
  assert.equal(storedEvent(first).title, 'Compleanno: Lina Müller');
});

test('region ist Mitgliedern verwehrt, sonst wäre das Sprach-Gate umgehbar', async () => {
  const forbidden = await call('PUT', '/preferences', { region: 'de-DE' });
  assert.equal(forbidden.status, 403);
  assert.equal(
    db.prepare(`SELECT value FROM sync_config WHERE key = 'region'`).get()?.value,
    'it-IT',
    'die abgewiesene Anfrage darf die Region nicht verändert haben',
  );
});

test('date_format allein zieht die Beschreibung nach', async () => {
  const first = db.prepare(`SELECT id FROM birthdays ORDER BY id ASC`).get().id;

  await asAdmin(() => call('PUT', '/preferences', { date_format: 'ymd' }));
  assert.match(storedEvent(first).description, /1990-05-12/);

  await asAdmin(() => call('PUT', '/preferences', { date_format: 'dmy' }));
  assert.match(storedEvent(first).description, /12\.05\.1990/);
});

test('gespiegelte Termine werden für den Push vorgemerkt', async () => {
  // Ein Geburtstags-Termin, den der Apple-Sync bereits hochgeladen hat: er trägt
  // danach external_source='apple' und eine Kalender-Zuordnung. Ohne den Marker
  // holt pendingUpdates() ihn nie ab und iCloud behielte den alten Titel (#632).
  const first = db.prepare(`SELECT id, calendar_event_id FROM birthdays ORDER BY id ASC`).get();
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'apple', external_calendar_id = 'oikos-test@oikos.local',
        outbound_dirty = 0
    WHERE id = ?
  `).run(first.calendar_event_id);

  await asAdmin(() => call('PUT', '/preferences', { language: 'de' }));

  const row = db.prepare('SELECT title, outbound_dirty FROM calendar_events WHERE id = ?')
    .get(first.calendar_event_id);
  assert.equal(row.title, 'Geburtstag: Lina Müller');
  assert.equal(row.outbound_dirty, 1, 'der umbenannte Termin muss zum Provider nachgezogen werden');
});

test('ein rein lokaler Termin wird nicht für den Push vorgemerkt', async () => {
  const created = await call('POST', '/birthdays', { name: 'Timo', birth_date: '1999-02-02' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;

  await asAdmin(() => call('PUT', '/preferences', { language: 'fr' }));

  const row = db.prepare('SELECT title, outbound_dirty FROM calendar_events WHERE id = ?').get(eventId);
  assert.equal(row.title, 'Anniversaire : Timo');
  assert.equal(row.outbound_dirty, 0, 'ohne Provider-Zuordnung gibt es nichts zu pushen');
});

test('ein unveränderter Termin wird nicht erneut geschrieben', async () => {
  const first = db.prepare(`SELECT calendar_event_id AS id FROM birthdays ORDER BY id ASC`).get();
  db.prepare('UPDATE calendar_events SET outbound_dirty = 0 WHERE id = ?').run(first.id);

  // Sprache bleibt fr: derselbe Titel, also kein Schreibvorgang und kein Marker.
  await asAdmin(() => call('PUT', '/preferences', { language: 'fr' }));

  assert.equal(
    db.prepare('SELECT outbound_dirty FROM calendar_events WHERE id = ?').get(first.id).outbound_dirty,
    0,
    'ein Lauf ohne Textänderung darf keinen Push auslösen',
  );
});

test('Namen mit Ersetzungssyntax landen wörtlich im Titel', async () => {
  await asAdmin(() => call('PUT', '/preferences', { language: 'de' }));

  // `$&` und `` $` `` sind in einem String-Ersatz Rückverweise auf den Treffer
  // bzw. auf den Text davor. Vor dem Fix wurde aus "A $& B" ein "A {{name}} B",
  // und `` $` `` zog den halben Titel in den Namen.
  const created = await call('POST', '/birthdays', { name: 'A $& B $` C', birth_date: '1980-07-07' });
  assert.equal(created.status, 201);
  assert.equal(storedEvent(created.body.data.id).title, 'Geburtstag: A $& B $` C');
});

test('ein Name, der wie ein Platzhalter aussieht, wird nicht erneut ersetzt', async () => {
  const created = await call('POST', '/birthdays', { name: '{{date}}', birth_date: '1975-01-02' });
  assert.equal(created.status, 201);
  // Der Name bleibt stehen; nur der echte {{date}}-Platzhalter der Vorlage wird
  // gefüllt. Nacheinander ersetzt, wäre hier zweimal das Datum gelandet.
  assert.equal(
    storedEvent(created.body.data.id).description,
    'Geburtstagserinnerung für {{date}} (02.01.1975).',
  );
});

test('ein abgelehntes Feld hinterlässt keine Sprache ohne passende Titel', async () => {
  await asAdmin(() => call('PUT', '/preferences', { language: 'en' }));
  const first = db.prepare(`SELECT id FROM birthdays ORDER BY id ASC`).get().id;
  assert.equal(storedEvent(first).title, 'Birthday: Lina Müller');

  // Gültige Sprache zusammen mit einem Feld, das später scheitert: der Handler
  // schreibt im Durchlauf und verlässt sich über ein early return.
  const rejected = await asAdmin(() => call('PUT', '/preferences', {
    language: 'de',
    app_name: 'x'.repeat(5000),
  }));
  assert.equal(rejected.status, 400);

  const after = await call('GET', '/preferences');
  assert.equal(after.body.data.language, 'de', 'die Sprache ist geschrieben');
  assert.equal(
    storedEvent(first).title,
    'Geburtstag: Lina Müller',
    'dann müssen die Titel ihr auch folgen, sonst meldet GET einen Zustand, den die Daten nicht haben',
  );
});

// ---------------------------------------------------------------------------
// Bearbeiten und Löschen eines bereits gespiegelten Geburtstags
//
// Das Umbenennen läuft über syncBirthdayCalendarEvent, nicht über den Backfill.
// Diese Anweisung setzte `external_source` auf 'local' zurück - seit dem ersten
// Geburtstags-Commit, lange vor dem Outbound-Sync. Mit 'local' UND gesetzter
// Kalender-ID fiel der Termin aus beiden Pfaden: pendingUpdates sucht nach
// 'apple', der Neu-Upload nach external_calendar_id IS NULL. Er fror beim
// Provider ein, ohne dass irgendetwas ihn je wieder abgeholt hätte.
// ---------------------------------------------------------------------------

// Die Warteschlange ist auf (source, calendar_external_id, event_external_id)
// eindeutig - zwei Termine mit derselben UID ergaeben nur eine Vormerkung, und
// der zweite Test haette gegen den Eintrag des ersten geprueft.
// Provider-Konfiguration einmal fuer alle Tests dieses Blocks: acceptsOutbound()
// prueft sie, und in einem Peer-Test gesetzt haetten die Folgetests von dessen
// Ausfuehrung abgehangen (ein einzeln laufender Test waere rot gewesen).
setConfig('apple_caldav_url', 'https://caldav.example/');

function mirrorEvent(eventId) {
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'apple', external_calendar_id = ?,
        external_object_url = ?, outbound_dirty = 0
    WHERE id = ?
  `).run(`bd-mirror-${eventId}@oikos.local`, `https://caldav.example/bd-${eventId}.ics`, eventId);
}

test('ein umbenannter Geburtstag bleibt mit seiner Kopie beim Provider verbunden', async () => {
  const created = await call('POST', '/birthdays', { name: 'Oma', birth_date: '1950-04-01' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  mirrorEvent(eventId);

  const renamed = await call('PUT', `/birthdays/${created.body.data.id}`, {
    name: 'Großmutter',
    birth_date: '1950-04-01',
  });
  assert.equal(renamed.status, 200);

  const row = db.prepare('SELECT title, external_source, outbound_dirty FROM calendar_events WHERE id = ?')
    .get(eventId);
  assert.match(row.title, /Großmutter/);
  assert.equal(row.external_source, 'apple', 'die Zuordnung zum Provider darf nicht verlorengehen');
  assert.equal(row.outbound_dirty, 1, 'sonst erreicht der neue Name den Provider nie');
});

test('ein Sync ohne echte Änderung löst keinen Push aus', async () => {
  const created = await call('POST', '/birthdays', { name: 'Onkel', birth_date: '1960-03-03' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  mirrorEvent(eventId);

  // Der Weg über den Provider ist nicht wertneutral: der ICS-Export schreibt für
  // einen ganztägigen Termin immer ein DTEND, und die Farbe überträgt er nicht -
  // der Inbound schreibt also ein end_datetime, wo NULL stand, und die Farbe des
  // Kalenders. Genau diesen Rückweg stellen die beiden Zeilen nach.
  db.prepare(`
    UPDATE calendar_events SET end_datetime = start_datetime, color = '#FC3C44' WHERE id = ?
  `).run(eventId);

  // syncAllBirthdayReminders hängt an GET /birthdays, GET /reminders und am
  // Benachrichtigungs-Scheduler. Zählte der Vergleich die normalisierten Felder
  // mit, wäre das ein Push pro Geburtstag pro Abruf - endlos.
  for (let i = 0; i < 3; i++) await call('GET', '/birthdays');

  assert.equal(
    db.prepare('SELECT outbound_dirty FROM calendar_events WHERE id = ?').get(eventId).outbound_dirty,
    0,
    'Provider-Normalisierung darf keinen Push auslösen',
  );
});

test('ein verschobenes Geburtsdatum nimmt das Ende des Termins mit', async () => {
  const created = await call('POST', '/birthdays', { name: 'Papa', birth_date: '1955-04-01' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  mirrorEvent(eventId);
  // Der Inbound legt bei einem ganztägigen Termin ein Ende gleich dem Start ab.
  db.prepare('UPDATE calendar_events SET end_datetime = start_datetime WHERE id = ?').run(eventId);

  await call('PUT', `/birthdays/${created.body.data.id}`, { name: 'Papa', birth_date: '1955-09-15' });

  const row = db.prepare('SELECT start_datetime, end_datetime FROM calendar_events WHERE id = ?').get(eventId);
  assert.equal(row.start_datetime, '1955-09-15');
  assert.equal(
    row.end_datetime, '1955-09-15',
    'ein stehengebliebenes Ende läge vor dem Beginn - die Serializer machten daraus ein DTEND vor DTSTART',
  );
});

test('im Nur-Lesen-Modus bleibt die lokale Änderung gegen den Inbound geschützt', async () => {
  // Ein schreibgeschützter Provider nimmt den Push nicht an. Der Marker ist aber
  // auch der Schutz davor, dass der Inbound die lokale Fassung überschreibt
  // (`if (existing?.outbound_dirty) continue`) - er muss deshalb trotzdem stehen.
  setConfig('google_refresh_token', 'token');
  setConfig('google_readonly', '1');

  const created = await call('POST', '/birthdays', { name: 'Cousine', birth_date: '1985-02-02' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  db.prepare(`
    UPDATE calendar_events
    SET external_source = 'google', external_calendar_id = ?, outbound_dirty = 0 WHERE id = ?
  `).run(`bd-ro-${eventId}@google`, eventId);

  await call('PUT', `/birthdays/${created.body.data.id}`, { name: 'Cousine Mia', birth_date: '1985-02-02' });

  const row = db.prepare('SELECT title, outbound_dirty FROM calendar_events WHERE id = ?').get(eventId);
  assert.match(row.title, /Mia/);
  assert.equal(row.outbound_dirty, 1, 'ohne Marker überschriebe der nächste Inbound den neuen Namen');

  db.prepare(`DELETE FROM sync_config WHERE key IN ('google_refresh_token', 'google_readonly')`).run();
});

test('ein gelöschter Geburtstag räumt die Kopie beim Provider mit ab', async () => {
  const created = await call('POST', '/birthdays', { name: 'Opa', birth_date: '1948-09-09' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  mirrorEvent(eventId);
  const before = db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c;

  const deleted = await call('DELETE', `/birthdays/${created.body.data.id}`);
  assert.ok([200, 204].includes(deleted.status), `unerwarteter Status ${deleted.status}`);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_events WHERE id = ?').get(eventId).c,
    0,
    'lokal gelöscht',
  );
  assert.ok(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c > before,
    'ohne Vormerkung bliebe der Termin beim Provider stehen und käme beim nächsten Inbound zurück',
  );
});

test('"keine Benachrichtigung" räumt die Kopie beim Provider ebenfalls ab', async () => {
  const created = await call('POST', '/birthdays', { name: 'Tante', birth_date: '1970-01-15' });
  const eventId = db.prepare('SELECT calendar_event_id AS id FROM birthdays WHERE id = ?')
    .get(created.body.data.id).id;
  mirrorEvent(eventId);
  const before = db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c;

  // reminder_offset = '' entfernt den Termin, ohne den Geburtstag zu löschen.
  const muted = await call('PUT', `/birthdays/${created.body.data.id}`, {
    name: 'Tante',
    birth_date: '1970-01-15',
    reminder_offset: '',
  });
  assert.equal(muted.status, 200);

  assert.equal(
    db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(created.body.data.id).calendar_event_id,
    null,
  );
  assert.ok(
    db.prepare('SELECT COUNT(*) AS c FROM calendar_pending_deletions').get().c > before,
    'auch dieser Pfad löscht einen gespiegelten Termin',
  );
});

test('GET /preferences liefert die drei Sprachfelder', async () => {
  // Eigene Vorbedingung: die drei Felder sind nur dann unterscheidbar, wenn
  // gewählte Sprache und Region auseinanderfallen.
  setConfig('region', 'it-IT');
  await asAdmin(() => call('PUT', '/preferences', { language: 'fr' }));

  const res = await call('GET', '/preferences');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.language, 'fr', 'explizit gesetzt');
  assert.equal(res.body.data.language_effective, 'fr', 'was gilt');
  assert.equal(res.body.data.language_auto, 'it', 'was die Automatik aus der Region ergäbe');
});
