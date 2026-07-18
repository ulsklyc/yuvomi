/**
 * Test: Geburtstags-Import aus CardDAV-/lokalen Kontakten (#518)
 * Zweck: Migration v90 (birthdays.contact_id + partieller Unique-Index),
 *        Service (listBirthdayImportCandidates + importBirthdaysFromContacts,
 *        idempotent) und die Route-Schicht (GET /import/candidates, POST /import).
 *
 *        Muster wie test-birthdays-routes.js: eine geteilte In-Memory-DB
 *        (db.get()-Singleton, den auch der Router nutzt), Router gemountet mit
 *        injizierter Auth. Tests isolieren sich über eindeutige Kontaktnamen und
 *        prüfen gegen konkrete IDs statt globaler COUNTs.
 * Ausführen: node --experimental-sqlite --test test/test-birthday-import.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: birthdaysRouter } = await import('../server/routes/birthdays.js');
const { listBirthdayImportCandidates, importBirthdaysFromContacts } = await import('../server/services/birthdays.js');
const db = dbmod.get();

const USER = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`,
).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.authRole = 'member';
  req.session = { userId: USER, role: 'member' };
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

function addContact(name, birthday = null) {
  return db.prepare(
    "INSERT INTO contacts (name, category, birthday) VALUES (?, 'Sonstiges', ?)",
  ).run(name, birthday).lastInsertRowid;
}

// --------------------------------------------------------------------------
// Migration v90
// --------------------------------------------------------------------------
test('Migration v90: birthdays.contact_id + partieller Unique-Index existieren', () => {
  const cols = db.prepare("PRAGMA table_info('birthdays')").all().map((c) => c.name);
  assert.ok(cols.includes('contact_id'), 'Spalte birthdays.contact_id fehlt');

  const indexes = db.prepare("PRAGMA index_list('birthdays')").all().map((i) => i.name);
  assert.ok(indexes.includes('idx_birthdays_contact_id'), 'Index idx_birthdays_contact_id fehlt');
});

test('Migration v90: Unique-Index verhindert doppelte contact_id', () => {
  const cid = addContact('Uniq Anchor', '1990-01-01');
  db.prepare('INSERT INTO birthdays (name, birth_date, created_by, contact_id) VALUES (?,?,?,?)')
    .run('Uniq Anchor', '1990-01-01', USER, cid);
  assert.throws(() => {
    db.prepare('INSERT INTO birthdays (name, birth_date, created_by, contact_id) VALUES (?,?,?,?)')
      .run('Uniq Anchor 2', '1991-01-01', USER, cid);
  }, /UNIQUE|constraint/i);
  // Aufräumen, damit spätere Kandidaten-Tests diesen Kontakt nicht sehen.
  db.prepare('DELETE FROM birthdays WHERE contact_id = ?').run(cid);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(cid);
});

// --------------------------------------------------------------------------
// Service: listBirthdayImportCandidates
// --------------------------------------------------------------------------
test('listBirthdayImportCandidates: trennt Kontakte mit/ohne Geburtstag', () => {
  const withId = addContact('Anna Kandidat', '1990-05-04');
  const withoutId = addContact('Ben Ohne', null);

  const { withBirthday, withoutBirthday } = listBirthdayImportCandidates(db);
  const anna = withBirthday.find((c) => c.id === withId);
  const ben = withoutBirthday.find((c) => c.id === withoutId);

  assert.ok(anna, 'Kontakt mit Geburtstag fehlt in withBirthday');
  assert.equal(anna.birthday, '1990-05-04');
  assert.equal(anna.already_imported, false);
  assert.ok(ben, 'Kontakt ohne Geburtstag fehlt in withoutBirthday');
  assert.equal(ben.name, 'Ben Ohne');
});

test('listBirthdayImportCandidates: markiert bereits importierte Kontakte', () => {
  const cid = addContact('Cora Importiert', '1988-01-02');
  db.prepare('INSERT INTO birthdays (name, birth_date, created_by, contact_id) VALUES (?,?,?,?)')
    .run('Cora Importiert', '1988-01-02', USER, cid);

  const { withBirthday } = listBirthdayImportCandidates(db);
  const cora = withBirthday.find((c) => c.id === cid);
  assert.ok(cora);
  assert.equal(cora.already_imported, true);
});

test('listBirthdayImportCandidates: schließt Housekeeping-Worker aus', () => {
  const workerUser = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role) VALUES ('worker1','Worker','x','member')`,
  ).run().lastInsertRowid;
  db.prepare('INSERT INTO housekeeping_workers (user_id) VALUES (?)').run(workerUser);
  const cid = db.prepare(
    "INSERT INTO contacts (name, category, birthday, family_user_id) VALUES ('Worker Kontakt','Sonstiges','1980-03-03',?)",
  ).run(workerUser).lastInsertRowid;

  const { withBirthday } = listBirthdayImportCandidates(db);
  assert.equal(withBirthday.find((c) => c.id === cid), undefined, 'Worker-Kontakt darf kein Kandidat sein');
});

// --------------------------------------------------------------------------
// Service: importBirthdaysFromContacts
// --------------------------------------------------------------------------
test('importBirthdaysFromContacts: legt Geburtstage an, koppelt contact_id, erzeugt Kalendereintrag', () => {
  const c1 = addContact('Dora Import', '1991-03-03');
  const c2 = addContact('Egon Import', '1975-12-24');

  const res = importBirthdaysFromContacts(db, [c1, c2], USER, new Date('2026-07-18T00:00:00Z'));
  assert.equal(res.imported, 2);
  assert.equal(res.skipped, 0);

  const b1 = db.prepare('SELECT * FROM birthdays WHERE contact_id = ?').get(c1);
  assert.ok(b1, 'Geburtstag für Dora fehlt');
  assert.equal(b1.birth_date, '1991-03-03');
  assert.equal(b1.created_by, USER);
  assert.ok(b1.calendar_event_id, 'Kalendereintrag wurde nicht erzeugt');
});

test('importBirthdaysFromContacts: idempotent (kein Doppelimport)', () => {
  const cid = addContact('Fritz Idem', '1980-08-08');

  const first = importBirthdaysFromContacts(db, [cid], USER, new Date('2026-07-18T00:00:00Z'));
  const second = importBirthdaysFromContacts(db, [cid], USER, new Date('2026-07-18T00:00:00Z'));
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM birthdays WHERE contact_id = ?').get(cid).n, 1);
});

test('importBirthdaysFromContacts: überspringt Kontakte ohne Geburtstag und unbekannte IDs', () => {
  const noBday = addContact('Gustl Ohne', null);

  const res = importBirthdaysFromContacts(db, [noBday, 9_999_999], USER, new Date('2026-07-18T00:00:00Z'));
  assert.equal(res.imported, 0);
  assert.equal(res.skipped, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM birthdays WHERE contact_id = ?').get(noBday).n, 0);
});

// --------------------------------------------------------------------------
// Routen
// --------------------------------------------------------------------------
test('GET /import/candidates: liefert getrennte Listen', async () => {
  const withId = addContact('Hilde Route', '1965-06-06');
  const withoutId = addContact('Ida Route', null);

  const r = await call('GET', '/import/candidates');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.withBirthday.some((c) => c.id === withId));
  assert.ok(r.body.data.withoutBirthday.some((c) => c.id === withoutId));
});

test('POST /import: importiert ausgewählte Kontakte', async () => {
  const cid = addContact('Jonas Route', '1999-09-09');

  const r = await call('POST', '/import', { contact_ids: [cid] });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.imported, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM birthdays WHERE contact_id = ?').get(cid).n, 1);
});

test('POST /import: 400 bei fehlendem/leerem contact_ids', async () => {
  const empty = await call('POST', '/import', { contact_ids: [] });
  assert.equal(empty.status, 400);
  const missing = await call('POST', '/import', {});
  assert.equal(missing.status, 400);
});

test('POST /import: 400 bei zu vielen IDs (> 500)', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => i + 1);
  const r = await call('POST', '/import', { contact_ids: ids });
  assert.equal(r.status, 400);
});
