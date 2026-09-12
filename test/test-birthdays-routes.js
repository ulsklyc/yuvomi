/**
 * Test: Geburtstags-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Birthdays-Router - härtet die bislang
 *        ungetestete Route-Schicht ab (Sync/Reminder-Logik in
 *        server/services/birthdays.js ist separat getestet; hier geht es um die
 *        ROUTE-Schicht). Fokus: Validierung (400: Name/Datum/Notizen/Foto-Data-URL),
 *        Nicht-gefunden (404), Foto-Data-URL-Regeln (Regex + Größenlimit),
 *        partielle COALESCE-Updates, limit-Clamp bei /upcoming, GET-Seiteneffekt
 *        (syncAllBirthdayReminders materialisiert calendar_events), Löschung mit
 *        Artefakt-Aufräumen (calendar_events + reminders), /meta/options.
 *
 *        EINE Ausnahme vom Route-Fokus steht am Dateiende: der Erinnerungs-
 *        zeitpunkt aus `syncBirthdayReminder` muss der Haushaltszone folgen, und
 *        das lässt sich über die Route nicht prüfen - sie reicht `new Date()`
 *        weiter, der Test braucht aber einen festen Zeitpunkt. Er ruft den
 *        Service deshalb direkt.
 *
 *        Systemuhr: die Handler rufen den Service mit Default `from = new Date()`.
 *        Um nicht an die Uhr zu koppeln, werden taktunabhängige Invarianten
 *        geprüft (next_birthday endet auf der Geburts-MM-DD), Sortierung über
 *        einen Gleichstand-Tiebreak (gleiche MM-DD → Name) und Cross-Checks
 *        (/upcoming = erste N von /) belegt; days_until/next_age werden gegen die
 *        importierten Service-Helfer als Orakel geprüft.
 * Ausführen: node --experimental-sqlite --test test/test-birthdays-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
// Die Uhr steht still, statt vom Rechner geerbt zu werden. Nötig, weil diese
// Datei zwei Uhren nebeneinander liest: die Routen den Haushaltstag
// (`todayKey(database)`), die Orakel in Zeile 126-127 den Serverstichtag über
// den Default-Parameter der Service-Helfer (`todayKey(null)`). Laufen beide auf
// derselben Zone, kann zwischen ihnen nichts driften.
//
// Gesetzt wird die MASCHINEN-Zone, nicht `sync_config.household_timezone`: die
// Einstellung ist optional, und ohne sie fällt `householdTimeZone(db)` auf
// `serverTimeZone()` zurück. Das ist der Zweig, auf dem jede Installation ohne
// gesetzte Zone sitzt, und genau den soll diese Suite fahren. Ein Eintrag in
// `sync_config` nähme ihr den Auslieferungszustand.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const {
  daysUntilBirthday,
  deleteBirthdayArtifacts,
  hydrateBirthday,
  nextBirthdayAge,
  syncBirthdayArtifacts,
} = await import('../server/services/birthdays.js');
const { todayKey } = await import('../server/utils/timezone.js');
const db = dbmod.get();

const USER = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;

let actor = { id: USER, role: 'member' };
const app = express();
app.use(express.json({ limit: '12mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', birthdaysRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
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

const VALID_PHOTO = 'data:image/png;base64,iVBORw0KGgo=';

// --------------------------------------------------------------------------
// POST / (Validierung + Anlegen + Artefakt-Sync)
// --------------------------------------------------------------------------
test('POST /: fehlender Name → 400', async () => {
  const r = await call('POST', '/', { birth_date: '1990-01-01' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Name/);
});

test('POST /: fehlendes/ungültiges Geburtsdatum → 400', async () => {
  const missing = await call('POST', '/', { name: 'Ohne Datum' });
  assert.equal(missing.status, 400);
  const bad = await call('POST', '/', { name: 'Schlechtes Datum', birth_date: '01.01.1990' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Birth date/);
});

test('POST /: ungültige Foto-Data-URL → 400', async () => {
  const r = await call('POST', '/', { name: 'Foto', birth_date: '1990-01-01', photo_data: 'https://example.com/x.png' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /valid image data URL/);
});

test('POST /: zu großes Foto → 400 (Größenlimit vor Regex)', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(7_000_000); // > MAX_PHOTO_LENGTH
  const r = await call('POST', '/', { name: 'Riesig', birth_date: '1990-01-01', photo_data: huge });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too large/);
});

test('POST /: legt Geburtstag an; created_by, Hydration, Foto, Kalender-Artefakt + Reminder', async () => {
  const r = await call('POST', '/', { name: 'Lena', birth_date: '1990-07-20', notes: 'Lieblingskuchen', photo_data: VALID_PHOTO });
  assert.equal(r.status, 201);
  const bd = r.body.data;
  assert.equal(bd.created_by, USER);
  assert.equal(bd.photo_data, VALID_PHOTO);
  // Taktunabhängig: nächster Geburtstag endet auf der Geburts-MM-DD.
  assert.equal(bd.next_birthday.slice(5), '07-20');
  // Orakel-Vergleich gegen die Service-Helfer (gleicher Kalendertag).
  assert.equal(bd.days_until, daysUntilBirthday('1990-07-20'));
  assert.equal(bd.next_age, nextBirthdayAge('1990-07-20'));
  // Default-Reminder (offset null) → syncBirthdayArtifacts hat Kalender-Event + Reminder erzeugt.
  const row = db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(bd.id);
  assert.ok(row.calendar_event_id, 'calendar_event_id gesetzt');
  const ev = db.prepare('SELECT title, recurrence_rule, all_day FROM calendar_events WHERE id = ?').get(row.calendar_event_id);
  assert.equal(ev.title, 'Birthday: Lena');
  assert.equal(ev.recurrence_rule, 'FREQ=YEARLY;INTERVAL=1');
  assert.equal(ev.all_day, 1);
  const rem = db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE entity_type='event' AND entity_id=?`).get(row.calendar_event_id);
  assert.equal(rem.n, 1);
});

test('POST /: stores an optional name day without an invented year', async () => {
  const r = await call('POST', '/', {
    name: 'Mila',
    birth_date: '1990-07-20',
    name_day: '05-24',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name_day, '05-24');
  assert.equal(r.body.data.next_name_day.slice(5), '05-24');
  assert.equal(Number.isInteger(r.body.data.name_day_days_until), true);
});

test('POST /: rejects non-canonical and impossible name days', async () => {
  for (const nameDay of ['24-05', '2026-05-24', '2-03', '02-30', '13-01', '00-10']) {
    const r = await call('POST', '/', {
      name: `Ungültig ${nameDay}`,
      birth_date: '1990-07-20',
      name_day: nameDay,
    });
    assert.equal(r.status, 400, `${nameDay} must be rejected`);
    assert.match(r.body.error, /Name day/);
  }
});

test('POST /: accepts 29 February as a name day', async () => {
  const r = await call('POST', '/', {
    name: 'Leap',
    birth_date: '1992-02-29',
    name_day: '02-29',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name_day, '02-29');
});

test('POST /: reminder_offset "" (keine Benachrichtigung) → kein Kalender-Event', async () => {
  const r = await call('POST', '/', { name: 'Stumm', birth_date: '1985-03-03', reminder_offset: '' });
  assert.equal(r.status, 201);
  const row = db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(r.body.data.id);
  assert.equal(row.calendar_event_id, null);
});

test('POST /: zu lange Notizen → 400 (kein Datensatz)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM birthdays').get().n;
  const r = await call('POST', '/', { name: 'X', birth_date: '1990-01-01', notes: 'a'.repeat(5001) });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM birthdays').get().n, before);
});

// --------------------------------------------------------------------------
// GET / (Seiteneffekt, Filter, Sortierung + Tiebreak)
// --------------------------------------------------------------------------
test('GET /: syncAllBirthdayReminders materialisiert Kalender-Event für roh eingefügten Datensatz', async () => {
  const id = db.prepare(`INSERT INTO birthdays (name, birth_date, created_by) VALUES ('Roh','1970-11-11',?)`).run(USER).lastInsertRowid;
  assert.equal(db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(id).calendar_event_id, null);
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  // GET hat den Sync ausgelöst → Event ist jetzt verknüpft.
  assert.ok(db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(id).calendar_event_id);
});

test('GET /?q=: filtert nach Name (LIKE)', async () => {
  const r = await call('GET', '/?q=Lena');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 1);
  assert.ok(r.body.data.every((b) => b.name.includes('Lena')));
});

test('GET /: aufsteigend nach days_until, Gleichstand → Name (Tiebreak)', async () => {
  // Zwei Geburtstage mit identischer MM-DD → gleiches days_until → Tiebreak über Name.
  await call('POST', '/', { name: 'Zeta', birth_date: '1991-09-09' });
  await call('POST', '/', { name: 'Alpha', birth_date: '1992-09-09' });
  const r = await call('GET', '/');
  const names = r.body.data.map((b) => b.name);
  const ia = names.indexOf('Alpha');
  const iz = names.indexOf('Zeta');
  assert.ok(ia >= 0 && iz >= 0);
  assert.ok(ia < iz, 'Alpha vor Zeta bei gleichem days_until');
  // Global aufsteigend nach days_until.
  const du = r.body.data.map((b) => b.days_until);
  for (let i = 1; i < du.length; i++) assert.ok(du[i] >= du[i - 1], 'days_until aufsteigend');
});

// --------------------------------------------------------------------------
// GET /upcoming (limit-Clamp + Slice)
// --------------------------------------------------------------------------
test('GET /upcoming: limit=2 = erste zwei von GET / (gleiche Sortierung)', async () => {
  const all = await call('GET', '/');
  const up = await call('GET', '/upcoming?limit=2');
  assert.equal(up.status, 200);
  assert.equal(up.body.data.length, 2);
  assert.deepEqual(up.body.data.map((b) => b.id), all.body.data.slice(0, 2).map((b) => b.id));
});

test('GET /upcoming: a closer name day does not change birthday ordering', async () => {
  const monthDayAfter = (days) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const closerBirthday = await call('POST', '/', {
    name: 'Closer birthday',
    birth_date: `2000-${monthDayAfter(5)}`,
  });
  const closerNameDay = await call('POST', '/', {
    name: 'Closer name day',
    birth_date: `2000-${monthDayAfter(40)}`,
    name_day: monthDayAfter(1),
  });

  const upcoming = await call('GET', '/upcoming?limit=50');
  const ids = upcoming.body.data.map((birthday) => birthday.id);
  assert.ok(ids.indexOf(closerBirthday.body.data.id) < ids.indexOf(closerNameDay.body.data.id));
});

test('GET /upcoming: ungültiges limit → Default 5', async () => {
  const up = await call('GET', '/upcoming?limit=abc');
  assert.equal(up.status, 200);
  assert.ok(up.body.data.length <= 5);
});

// --------------------------------------------------------------------------
// Identitätsfarbe des verknüpften Mitglieds
// --------------------------------------------------------------------------
/**
 * REGEL: eine Person zeigt sich überall in ihrer Identitätsfarbe (DESIGN.md,
 * Colors: die Identitätsfarben-Regel).
 *
 * `SELECT * FROM birthdays` lieferte `family_user_id`, aber nicht die Farbe
 * dahinter - und damit saß jedes Haushaltsmitglied in der Geburtstagsliste auf
 * derselben neutralen Scheibe wie eine Tante ohne Zugang, während dieselbe
 * Person auf der Übersichtskachel ihre eigene trug. Der Join gehört zu ALLEN
 * drei Lesewegen (Liste, /upcoming, Einzelabruf nach Schreiben), sonst kommt
 * die Lücke an einem davon zurück.
 */
test('GET /, /upcoming und PUT liefern Farbe und Namen des verknüpften Mitglieds', async () => {
  const member = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, avatar_color)
     VALUES ('emma','Emma Johnson','x','member','#DB2777')`,
  ).run().lastInsertRowid;
  const created = await call('POST', '/', { name: 'Emma', birth_date: '2015-03-04' });
  db.prepare('UPDATE birthdays SET family_user_id = ? WHERE id = ?').run(member, created.body.data.id);

  const inList = (res) => res.body.data.find((b) => b.id === created.body.data.id);

  const list = await call('GET', '/');
  assert.equal(inList(list).family_avatar_color, '#DB2777');
  assert.equal(inList(list).family_display_name, 'Emma Johnson');

  const upcoming = await call('GET', '/upcoming?limit=50');
  assert.equal(inList(upcoming).family_avatar_color, '#DB2777');

  const updated = await call('PUT', `/${created.body.data.id}`, { notes: 'mag Kuchen' });
  assert.equal(updated.body.data.family_avatar_color, '#DB2777');

  // Und die Gegenrichtung: wer zu niemandem gehört, bekommt keine Farbe
  // angedichtet - er ist neutral, nicht modul-getönt.
  const loose = await call('POST', '/', { name: 'Tante Claire', birth_date: '1989-08-30' });
  const after = await call('GET', '/');
  assert.equal(after.body.data.find((b) => b.id === loose.body.data.id).family_avatar_color, null);
});

// --------------------------------------------------------------------------
// PUT /:id (404, Validierung, partielles COALESCE-Update)
// --------------------------------------------------------------------------
test('PUT /:id: nicht existent → 404', async () => {
  const r = await call('PUT', '/999999', { name: 'egal' });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültiges Geburtsdatum → 400', async () => {
  const base = await call('POST', '/', { name: 'PutBase', birth_date: '1990-06-06' });
  const r = await call('PUT', `/${base.body.data.id}`, { birth_date: 'kaputt' });
  assert.equal(r.status, 400);
});

test('PUT /:id: partielles Update - nur notes ändert sich, Name/Datum bleiben (COALESCE)', async () => {
  const base = await call('POST', '/', { name: 'Orig', birth_date: '1990-05-15', notes: 'n1' });
  const id = base.body.data.id;
  const r = await call('PUT', `/${id}`, { notes: 'n2' });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT name, birth_date, notes FROM birthdays WHERE id = ?').get(id);
  assert.equal(row.name, 'Orig');        // unverändert
  assert.equal(row.birth_date, '1990-05-15'); // unverändert
  assert.equal(row.notes, 'n2');         // aktualisiert
});

test('PUT /:id: notes leer → NULL; Name aktualisierbar', async () => {
  const base = await call('POST', '/', { name: 'Vorher', birth_date: '1988-08-08', notes: 'weg' });
  const id = base.body.data.id;
  const r = await call('PUT', `/${id}`, { name: 'Nachher', notes: '' });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT name, notes FROM birthdays WHERE id = ?').get(id);
  assert.equal(row.name, 'Nachher');
  assert.equal(row.notes, null);
});

test('PUT /:id: preserves a name day on partial update and can clear it', async () => {
  const base = await call('POST', '/', {
    name: 'NamenstagPut',
    birth_date: '1988-08-08',
    name_day: '03-19',
  });
  const id = base.body.data.id;

  const partial = await call('PUT', `/${id}`, { notes: 'unverändert am Namenstag' });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.data.name_day, '03-19');

  const cleared = await call('PUT', `/${id}`, { name_day: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.name_day, null);
  assert.equal(cleared.body.data.next_name_day, null);
  assert.equal(cleared.body.data.name_day_days_until, null);
});

test('PUT /:id: ungültiges Foto → 400 (Bestand unverändert)', async () => {
  const base = await call('POST', '/', { name: 'FotoPut', birth_date: '1994-02-02', photo_data: VALID_PHOTO });
  const id = base.body.data.id;
  const r = await call('PUT', `/${id}`, { photo_data: 'kein-data-url' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /valid image data URL/);
  assert.equal(db.prepare('SELECT photo_data FROM birthdays WHERE id = ?').get(id).photo_data, VALID_PHOTO);
});

test('PUT /:id: gültiges Foto ersetzt Bestand; leeres Foto → NULL', async () => {
  const base = await call('POST', '/', { name: 'FotoSwap', birth_date: '1995-03-03' });
  const id = base.body.data.id;
  // Ein echter WebP-Kopf: 'RIFF' + Groesse + 'WEBP'. Vorher stand hier nur
  // 'UklGRg==' ('RIFF'), was ein gueltiger String, aber nie ein gueltiges Bild
  // war - seit #937 prueft der Upload den Inhalt und nicht nur die Deklaration.
  const newPhoto = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA==';
  const put = await call('PUT', `/${id}`, { photo_data: newPhoto });
  assert.equal(put.status, 200);
  assert.equal(db.prepare('SELECT photo_data FROM birthdays WHERE id = ?').get(id).photo_data, newPhoto);
  const cleared = await call('PUT', `/${id}`, { photo_data: '' });
  assert.equal(cleared.status, 200);
  assert.equal(db.prepare('SELECT photo_data FROM birthdays WHERE id = ?').get(id).photo_data, null);
});

// --------------------------------------------------------------------------
// DELETE /:id (404, Artefakt-Aufräumen)
// --------------------------------------------------------------------------
test('DELETE /:id: nicht existent → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: removes birthday and name day with both calendar events and reminders', async () => {
  const created = await call('POST', '/', {
    name: 'ToDelete',
    birth_date: '1993-04-04',
    name_day: '04-05',
  });
  const id = created.body.data.id;
  const links = db.prepare(`
    SELECT calendar_event_id, name_day_calendar_event_id FROM birthdays WHERE id = ?
  `).get(id);
  assert.ok(links.calendar_event_id);
  assert.ok(links.name_day_calendar_event_id);
  const r = await call('DELETE', `/${id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT id FROM birthdays WHERE id = ?').get(id), undefined);
  for (const eventId of [links.calendar_event_id, links.name_day_calendar_event_id]) {
    assert.equal(db.prepare('SELECT id FROM calendar_events WHERE id = ?').get(eventId), undefined);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE entity_id = ?`).get(eventId).n, 0);
  }
});

// --------------------------------------------------------------------------
// GET /meta/options
// --------------------------------------------------------------------------
test('GET /meta/options: liefert Foto-Limit + akzeptierte Bildtypen', async () => {
  const r = await call('GET', '/meta/options');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.photoMaxBytes, 6_990_507);
  assert.deepEqual(r.body.data.acceptedImageTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

// --------------------------------------------------------------------------
// Stichtag und Zone: die des Haushalts, nicht die der Maschine
// --------------------------------------------------------------------------
/* Diese Probe verschiebt die Haushaltszone BEWUSST - sonst bliebe die Suite
 * gegen genau die Fehlerklasse blind, die sie sehen müsste.
 *
 * Zwei Stellen lesen den Haushalt (#829): `syncBirthdayReminder` für den
 * Erinnerungszeitpunkt, `hydrateBirthday` für das, was die Leserouten
 * ausliefern. Beide je zweimal, über `todayKey(database, from)` und
 * `householdTimeZone(database)`.
 *
 * Gemessen am 2026-09-09 gegen main, und zwar je Sonde EINZELN - die beiden
 * Fassungen sind unterschiedlich gut gedeckt:
 *
 *   `todayKey(null, from)` (zweiargumentig)   sechzehn Suiten grün, alle blind
 *   `householdTimeZone(null)` (einargumentig) test:household-timezone fällt,
 *                                             test:birthday-localization fällt
 *                                             unter TZ=UTC (der CI-Zone)
 *
 * Der Unterschied ist kein Zufall: der Guard in test/test-household-timezone.js
 * fängt die einargumentige Form und lässt die zweiargumentige durch.
 *
 * Die Form, gegen die keine der beiden Fassungen ankommt: EIN fester Zeitpunkt,
 * zweimal gelesen, beiderseits der Datumsgrenze. 2026-01-01T11:00Z ist in
 * Honolulu (-10) noch der 1. Januar, in Kiritimati (+14) schon der 2. - und der
 * Geburtstag liegt auf dem 1. Januar:
 *
 *   Honolulu    Stichtag 2026-01-01 → nächster 2026-01-01 → Mittag = 22:00Z
 *   Kiritimati  Stichtag 2026-01-02 → nächster 2027-01-01 → Mittag = 22:00Z
 *
 * Ein Jahr Abstand aus demselben Zeitpunkt. Die Erwartungen sind Literale, und
 * keine Serverzone erfüllt beide zugleich: die erste verlangt Offset -10, die
 * zweite +14, und im Lauf ist die Serverzone konstant. Über alle 418 Zonen aus
 * `Intl.supportedValuesOf('timeZone')` durchgerechnet überlebt keine.
 */
test('Stichtag und Erinnerung folgen der Haushaltszone, nicht der des Servers', () => {
  // reminder_offset explizit auf "keine Vorlaufzeit": ohne den Wert stünde in
  // der Spalte NULL, und die Literale unten hingen still an dem 0, das
  // `getOffsetMinutes` daraus macht. Bekäme die Spalte je einen Default,
  // verschöben sich beide Erwartungen - und die Meldung zeigte auf die Zone.
  const rowId = db.prepare(`
    INSERT INTO birthdays (name, birth_date, reminder_offset, created_by) VALUES (?, ?, '0', ?)
  `).run('Zonenprobe', '1990-01-01', USER).lastInsertRowid;
  const FROM = new Date('2026-01-01T11:00:00Z');

  const withHouseholdIn = (zone) => {
    db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)')
      .run('household_timezone', zone);
    const row = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(rowId);
    const synced = syncBirthdayArtifacts(db, row, FROM);
    assert.ok(synced.calendar_event_id, `kein Kalender-Event angelegt (${zone})`);
    const reminder = db.prepare(`
      SELECT remind_at FROM reminders
      WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND dismissed = 0
      ORDER BY id DESC LIMIT 1
    `).get(synced.calendar_event_id, USER);
    return {
      stichtag:  todayKey(db, FROM),
      remind_at: reminder?.remind_at,
      hydriert:  hydrateBirthday(db, row, FROM),
    };
  };

  try {
    const honolulu   = withHouseholdIn('Pacific/Honolulu');
    const kiritimati = withHouseholdIn('Pacific/Kiritimati');

    // Die Prämisse zuerst, sonst sagt ein Fehlschlag unten das Falsche: liegen
    // die beiden Zonen bei FROM nicht auf verschiedenen Kalendertagen, prüft
    // der Rest nichts mehr. Kiritimati ist die einzige Zone der Erde auf +14;
    // eine tzdata-Änderung dort meldet sich hier, nicht als Zonenfehler.
    assert.equal(honolulu.stichtag,   '2026-01-01', 'Honolulu (-10) muss bei FROM noch der 1. Januar sein');
    assert.equal(kiritimati.stichtag, '2026-01-02', 'Kiritimati (+14) muss bei FROM schon der 2. Januar sein');

    // syncBirthdayReminder
    assert.equal(honolulu.remind_at, '2026-01-01T22:00:00.000Z',
      'in Honolulu ist der Geburtstag heute - erinnert wird mittags, dort');
    assert.equal(kiritimati.remind_at, '2026-12-31T22:00:00.000Z',
      'in Kiritimati ist der Geburtstag vorbei - erinnert wird nächstes Jahr, mittags dort');

    // hydrateBirthday - dieselbe Frage an der Stelle, die GET / und /upcoming
    // ausliefern. Ohne diese zwei Zeilen bliebe die Route-Schicht der Suite
    // gegen dieselbe Verwechslung blind.
    assert.equal(honolulu.hydriert.next_birthday,   '2026-01-01');
    assert.equal(honolulu.hydriert.days_until,      0);
    assert.equal(kiritimati.hydriert.next_birthday, '2027-01-01');
    assert.equal(kiritimati.hydriert.days_until,    364);
  } finally {
    // Zurück in den Ausgangszustand dieser Suite: KEIN Eintrag. Der Test steht
    // heute zuletzt in der Datei, aber darauf verlässt sich das Aufräumen
    // nicht - wer hier einen Test anfügt, soll dieselbe Zone vorfinden wie die
    // Tests darüber.
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    deleteBirthdayArtifacts(db, db.prepare('SELECT * FROM birthdays WHERE id = ?').get(rowId));
    db.prepare('DELETE FROM birthdays WHERE id = ?').run(rowId);
  }
});

// Eine verworfene Geburtstagserinnerung kam zurueck: `syncBirthdayReminder`
// suchte nur UNverworfene Zeilen, fand nach dem Verwerfen keine, loeschte alles
// und legte dieselbe Erinnerung unverworfen neu an. `GET /reminders/pending`
// gleicht bei jedem Poll ab, also stand sie nach einer Minute wieder da, und der
// Push-Scheduler sah ein leeres `pushed_at`. Gefunden am 13.09.2026 beim
// Handlauf-Fix zu #1160. Verglichen wird relativ zur ersten Zeile, damit die
// Maschinenzone der Suite hier keine Rolle spielt.
test('eine verworfene Geburtstagserinnerung bleibt verworfen, bis sich ihr Termin aendert', () => {
  const rowId = db.prepare(`
    INSERT INTO birthdays (name, birth_date, reminder_offset, created_by) VALUES (?, ?, '1440', ?)
  `).run('Verwerfprobe', '1990-03-10', USER).lastInsertRowid;
  const ON_BIRTHDAY = new Date('2026-03-10T12:00:00Z');
  const sync = () => syncBirthdayArtifacts(db, db.prepare('SELECT * FROM birthdays WHERE id = ?').get(rowId), ON_BIRTHDAY);
  const rows = (eventId) => db.prepare(`
    SELECT id, remind_at, dismissed, pushed_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? ORDER BY id
  `).all(eventId, USER);

  try {
    const { calendar_event_id: eventId } = sync();
    assert.ok(eventId, 'Fixture: der Geburtstag hat einen Kalendertermin');
    const [first, ...rest] = rows(eventId);
    assert.equal(rest.length, 0, 'Fixture: genau eine Erinnerung');

    const PUSHED = '2026-03-09T12:00:00.000Z';
    db.prepare('UPDATE reminders SET dismissed = 1, pushed_at = ? WHERE id = ?').run(PUSHED, first.id);
    sync();
    assert.deepEqual(rows(eventId), [{ ...first, dismissed: 1, pushed_at: PUSHED }],
      'derselbe Termin: die verworfene Zeile bleibt, und keine unverworfene kommt daneben');

    // Aendert sich der Termin der Erinnerung, ist es eine neue Erinnerung.
    db.prepare("UPDATE birthdays SET reminder_offset = '2880' WHERE id = ?").run(rowId);
    sync();
    const [moved, ...others] = rows(eventId);
    assert.equal(others.length, 0, 'der alte Termin wird ersetzt, nicht ergaenzt');
    assert.notEqual(moved.remind_at, first.remind_at);
    assert.equal(moved.dismissed, 0, 'ein anderer Vorlauf erinnert neu');
  } finally {
    deleteBirthdayArtifacts(db, db.prepare('SELECT * FROM birthdays WHERE id = ?').get(rowId));
    db.prepare('DELETE FROM birthdays WHERE id = ?').run(rowId);
  }
});
