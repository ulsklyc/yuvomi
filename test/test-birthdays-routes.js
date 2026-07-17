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

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { daysUntilBirthday, nextBirthdayAge } = await import('../server/services/birthdays.js');
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

test('GET /upcoming: ungültiges limit → Default 5', async () => {
  const up = await call('GET', '/upcoming?limit=abc');
  assert.equal(up.status, 200);
  assert.ok(up.body.data.length <= 5);
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

// --------------------------------------------------------------------------
// DELETE /:id (404, Artefakt-Aufräumen)
// --------------------------------------------------------------------------
test('DELETE /:id: nicht existent → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: löscht Geburtstag inkl. Kalender-Event + Reminder', async () => {
  const created = await call('POST', '/', { name: 'ToDelete', birth_date: '1993-04-04' });
  const id = created.body.data.id;
  const eventId = db.prepare('SELECT calendar_event_id FROM birthdays WHERE id = ?').get(id).calendar_event_id;
  assert.ok(eventId);
  const r = await call('DELETE', `/${id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT id FROM birthdays WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT id FROM calendar_events WHERE id = ?').get(eventId), undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE entity_id = ?`).get(eventId).n, 0);
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
