/**
 * Modul: Health-Test - Vorsorge & Impfungen
 * Zweck: Typen-/Protokoll-CRUD, `careAwareClause`-Lesen (eine betreuende Person
 *        sieht auch private Datensätze der betreuten Person, ein unbetreutes
 *        drittes Mitglied nicht), Betreuungs-Schreibweg über `resolveOwner`,
 *        die Sichtbarkeits-Voreinstellung gilt für den EIGENTÜMER statt die
 *        eintragende Person, das Löschen eines Typs lässt seine Datensätze mit
 *        der `name`-Momentaufnahme bestehen, und kein Admin-Sonderzugriff auf
 *        fremde Datensätze (DECISIONS #1 - Privatsphäre schlägt Admin-Bequemlichkeit).
 * Ausführen: npm run test:health-prevention
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);

const userA = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('alice', 'Alice', '$2b$12$x', 'admin')`).run().lastInsertRowid;
const userB = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;
const userC = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('carol', 'Carol', '$2b$12$x', 'member')`).run().lastInsertRowid;
const userD = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('dave', 'Dave', '$2b$12$x', 'member')`).run().lastInsertRowid;

let session = { userId: userA, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = session.userId;
  req.authRole = session.role;
  req.session = { userId: session.userId, role: session.role };
  next();
});
app.use('/api/v1/health', healthRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/health`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const asA = () => { session = { userId: userA, role: 'admin' }; };
const asB = () => { session = { userId: userB, role: 'member' }; };
const asC = () => { session = { userId: userC, role: 'member' }; };

// ── Typen-Register ──────────────────────────────────────────────────────────

test('nur Admins legen Typen an, alle Mitglieder lesen sie', async () => {
  asB();
  const denied = await call('POST', '/prevention/types', { name: 'Tetanus', kind: 'vaccination' });
  assert.equal(denied.status, 403);

  asA();
  const created = await call('POST', '/prevention/types', {
    name: 'Tetanus', kind: 'vaccination', default_interval_months: 120,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.icon, 'syringe');

  asB();
  const list = await call('GET', '/prevention/types');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((t) => t.name === 'Tetanus'));
});

test('ein Typ ohne Intervall ist einmalig (default_interval_months NULL)', async () => {
  asA();
  const res = await call('POST', '/prevention/types', { name: 'Grippeimpfung', kind: 'vaccination', default_interval_months: 12 });
  assert.equal(res.status, 201);
  const oneOff = await call('POST', '/prevention/types', { name: 'Zahnarzt', kind: 'checkup' });
  assert.equal(oneOff.status, 201);
  assert.equal(oneOff.body.data.default_interval_months, null);
});

// ── Protokoll-CRUD + Betreuung ──────────────────────────────────────────────

let tetanusTypeId;
test('Vorbedingung: tetanus-Typ-ID einsammeln', async () => {
  asB();
  const list = await call('GET', '/prevention/types');
  tetanusTypeId = list.body.data.find((t) => t.name === 'Tetanus').id;
  assert.ok(tetanusTypeId);
});

test('POST /prevention/records legt einen Datensatz an, Standard-Sichtbarkeit privat', async () => {
  asB();
  const res = await call('POST', '/prevention/records', {
    type_id: tetanusTypeId, given_on: '2026-01-15', dose_number: 1,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user_id, userB);
  assert.equal(res.body.data.visibility, 'private');
});

test('ein Datensatz ohne type_id braucht einen eigenen Namen', async () => {
  asB();
  const withoutName = await call('POST', '/prevention/records', { given_on: '2026-02-01' });
  assert.equal(withoutName.status, 400);

  const withName = await call('POST', '/prevention/records', { given_on: '2026-02-01', name: 'Reisemedizinische Beratung' });
  assert.equal(withName.status, 201);
  assert.equal(withName.body.data.name, 'Reisemedizinische Beratung');
});

test('careAwareClause: eine betreuende Person sieht auch private Datensätze der betreuten Person, ein unbetreutes Mitglied nicht', async () => {
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(userB, userC);

  asC();
  const asCaregiver = await call('GET', `/prevention/records?user_id=${userB}`);
  assert.equal(asCaregiver.status, 200);
  assert.ok(asCaregiver.body.data.length > 0, 'die betreuende Person sieht die privaten Datensätze');

  // Ein viertes, unbeteiligtes Mitglied ohne Betreuungs-Zusage sieht nichts.
  session = { userId: userD, role: 'member' };
  const asStranger = await call('GET', `/prevention/records?user_id=${userB}`);
  assert.equal(asStranger.status, 200);
  assert.deepEqual(asStranger.body.data, [], 'ein unbetreutes Mitglied sieht keine privaten Datensätze');
});

test('Betreuungs-Schreibweg: resolveOwner lässt eine betreuende Person für die betreute Person eintragen', async () => {
  asC();
  const res = await call('POST', '/prevention/records', {
    user_id: userB, type_id: tetanusTypeId, given_on: '2026-03-01',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user_id, userB, 'gehört der betreuten Person');
  assert.equal(res.body.data.created_by, userC, 'eingetragen von der betreuenden Person');
});

test('ein Fremder ohne Betreuungs-Zusage darf nicht für eine andere Person eintragen', async () => {
  asB();
  const userE = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('erin', 'Erin', '$2b$12$x', 'member')`).run().lastInsertRowid;
  const res = await call('POST', '/prevention/records', { user_id: userE, type_id: tetanusTypeId, given_on: '2026-03-01' });
  assert.equal(res.status, 403);
});

test('die Sichtbarkeits-Voreinstellung gilt für den EIGENTÜMER, nicht die eintragende Person', async () => {
  // B setzt die eigene Voreinstellung fuer den Bereich 'prevention' auf 'family'.
  asB();
  await call('PUT', '/visibility-defaults', { defaults: { prevention: 'family' } });

  // C traegt (als Betreuer) fuer B ein, ohne eigene Sichtbarkeits-Wahl im Body.
  asC();
  const res = await call('POST', '/prevention/records', { user_id: userB, type_id: tetanusTypeId, given_on: '2026-04-01' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.visibility, 'family', 'die Wahl des Eigentuemers (B) zaehlt, nicht die Cs');
});

test('PATCH aktualisiert Felder, DELETE entfernt den Datensatz', async () => {
  asB();
  const created = await call('POST', '/prevention/records', { type_id: tetanusTypeId, given_on: '2026-05-01' });
  const id = created.body.data.id;

  const patched = await call('PATCH', `/prevention/records/${id}`, { note: 'linker Oberarm' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.note, 'linker Oberarm');

  const deleted = await call('DELETE', `/prevention/records/${id}`);
  assert.equal(deleted.status, 204);
  const gone = await call('GET', `/prevention/records?user_id=${userB}`);
  assert.ok(!gone.body.data.some((r) => r.id === id));
});

test('ein Admin hat keinen Sonderzugriff auf fremde Datensätze (DECISIONS #1)', async () => {
  // A ist Admin, aber weder Betreuer noch Eigentuemer von B - und B hat kein
  // family-sichtbares tetanus-Datum aus diesem Test uebrig, das A treffen duerfte
  // (das eine 'family'-Datum von oben ist genau eines - hier wird gezielt ein
  // NEUES privates geprueft, das Admin-Status allein nicht oeffnen darf).
  asB();
  const priv = await call('POST', '/prevention/records', {
    type_id: tetanusTypeId, given_on: '2026-06-01', visibility: 'private',
  });
  const privId = priv.body.data.id;

  asA();
  const asAdmin = await call('GET', `/prevention/records?user_id=${userB}`);
  assert.ok(!asAdmin.body.data.some((r) => r.id === privId), 'Admin sieht das private Datum von B nicht');
});

// ── Typ-Löschung erhält die Historie ────────────────────────────────────────

test('das Löschen eines Typs lässt seine Datensätze mit der name-Momentaufnahme bestehen', async () => {
  asA();
  const type = await call('POST', '/prevention/types', { name: 'Mumps', kind: 'vaccination', default_interval_months: 60 });
  const typeId = type.body.data.id;

  asB();
  const record = await call('POST', '/prevention/records', { type_id: typeId, given_on: '2026-01-01' });
  const recordId = record.body.data.id;

  asA();
  const del = await call('DELETE', `/prevention/types/${typeId}`);
  assert.equal(del.status, 204);

  asB();
  const after = await call('GET', `/prevention/records?user_id=${userB}`);
  const survivor = after.body.data.find((r) => r.id === recordId);
  assert.ok(survivor, 'der Datensatz bleibt bestehen');
  assert.equal(survivor.type_id, null, 'type_id wurde auf NULL gesetzt (FK ON DELETE SET NULL)');
  assert.equal(survivor.name, 'Mumps', 'die name-Momentaufnahme traegt den zuletzt bekannten Typnamen');
});

test('das Löschen eines Typs überschreibt einen bereits eigenen Datensatz-Namen nicht', async () => {
  asA();
  const type = await call('POST', '/prevention/types', { name: 'Röteln', kind: 'vaccination', default_interval_months: 120 });
  const typeId = type.body.data.id;

  asB();
  const record = await call('POST', '/prevention/records', {
    type_id: typeId, name: 'Eigener Name', given_on: '2026-01-01',
  });
  const recordId = record.body.data.id;

  asA();
  const del = await call('DELETE', `/prevention/types/${typeId}`);
  assert.equal(del.status, 204);

  asB();
  const after = await call('GET', `/prevention/records?user_id=${userB}`);
  const survivor = after.body.data.find((r) => r.id === recordId);
  assert.equal(survivor.name, 'Eigener Name', 'ein bereits gesetzter eigener Name bleibt unangetastet');
});

// ── GET /prevention/due ──────────────────────────────────────────────────────

test('GET /prevention/due berechnet die Fälligkeit aus dem jüngsten Datensatz je Typ', async () => {
  asA();
  const type = await call('POST', '/prevention/types', { name: 'Halbjahres-Check', kind: 'checkup', default_interval_months: 6 });
  const typeId = type.body.data.id;

  asB();
  await call('POST', '/prevention/records', { type_id: typeId, given_on: '2026-01-31', visibility: 'family' });
  const due = await call('GET', `/prevention/due?user_id=${userB}`);
  assert.equal(due.status, 200);
  const item = due.body.data.find((i) => i.type_id === typeId);
  assert.ok(item, 'der Typ erscheint in der Faelligkeitsliste');
  assert.equal(item.due_on, '2026-07-31', '31. Jan + 6 Monate, kein Schaltmonat-Problem hier');
});

test('GET /prevention/due: ein unbeteiligtes Mitglied (weder Eigentuemer noch Betreuung) sieht nur, was der juengste Datensatz je Typ als familiensichtbar markiert', async () => {
  asA();
  const type = await call('POST', '/prevention/types', { name: 'Jahres-Check', kind: 'checkup', default_interval_months: 12 });
  const typeId = type.body.data.id;

  // Dave (userD) ist weder Eigentuemer noch Betreuung - dieselbe Person wie im
  // careAwareClause-Test oben ("ein unbetreutes Mitglied sieht keine privaten
  // Datensätze"), hier gegen /prevention/due statt /prevention/records.
  asB();
  const privateRecord = await call('POST', '/prevention/records', {
    type_id: typeId, given_on: '2026-01-15', visibility: 'private',
  });
  assert.equal(privateRecord.status, 201);

  session = { userId: userD, role: 'member' };
  const asStrangerPrivate = await call('GET', `/prevention/due?user_id=${userB}`);
  assert.equal(asStrangerPrivate.status, 200);
  assert.ok(!asStrangerPrivate.body.data.some((i) => i.type_id === typeId),
    'ein privater Datensatz darf einem unbeteiligten Mitglied nicht ueber /due verraten werden');

  // Derselbe Typ, aber der juengste Datensatz ist jetzt familiensichtbar -
  // computeDueForUser() nimmt ohnehin den juengsten je Typ, die Sichtbarkeits-
  // Pruefung in prevention.js muss also denselben Datensatz treffen.
  asB();
  const familyRecord = await call('POST', '/prevention/records', {
    type_id: typeId, given_on: '2026-02-15', visibility: 'family',
  });
  assert.equal(familyRecord.status, 201);

  session = { userId: userD, role: 'member' };
  const asStrangerFamily = await call('GET', `/prevention/due?user_id=${userB}`);
  assert.equal(asStrangerFamily.status, 200);
  const item = asStrangerFamily.body.data.find((i) => i.type_id === typeId);
  assert.ok(item, 'ein familiensichtbarer juengster Datensatz muss einem unbeteiligten Mitglied ueber /due sichtbar sein');
});

test('PATCH next_due_on auf null faellt zurueck auf die intervall-abgeleitete Faelligkeit', async () => {
  asA();
  const type = await call('POST', '/prevention/types', { name: 'PATCH-Test-Typ', kind: 'checkup', default_interval_months: 6 });
  const typeId = type.body.data.id;

  asB();
  const created = await call('POST', '/prevention/records', {
    type_id: typeId, given_on: '2026-01-10', next_due_on: '2026-12-25', visibility: 'family',
  });
  const id = created.body.data.id;

  const withOverride = await call('GET', `/prevention/due?user_id=${userB}`);
  const beforePatch = withOverride.body.data.find((i) => i.type_id === typeId);
  assert.equal(beforePatch.due_on, '2026-12-25', 'die explizite Vorgabe zaehlt, solange sie gesetzt ist');

  const patched = await call('PATCH', `/prevention/records/${id}`, { next_due_on: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.next_due_on, null);

  const afterPatch = await call('GET', `/prevention/due?user_id=${userB}`);
  const item = afterPatch.body.data.find((i) => i.type_id === typeId);
  assert.equal(item.due_on, '2026-07-10', 'ohne Vorgabe zaehlt given_on + Intervall (6 Monate)');
});

test('GET /prevention/due: eine betreuende Person sieht auch ein privates Faelligkeits-Item der betreuten Person', async () => {
  // Carol (userC) ist seit dem careAwareClause-Test oben Betreuerin von Bob (userB).
  asA();
  const type = await call('POST', '/prevention/types', { name: 'Betreuungs-Sichtbarkeits-Test', kind: 'checkup', default_interval_months: 3 });
  const typeId = type.body.data.id;

  asB();
  const record = await call('POST', '/prevention/records', {
    type_id: typeId, given_on: '2026-01-01', visibility: 'private',
  });
  assert.equal(record.status, 201);

  asC();
  const asCaregiver = await call('GET', `/prevention/due?user_id=${userB}`);
  assert.equal(asCaregiver.status, 200);
  const item = asCaregiver.body.data.find((i) => i.type_id === typeId);
  assert.ok(item, 'eine echte Betreuung sieht ein privates Faelligkeits-Item, nicht nur familiensichtbare');
});

test('PATCH on a type moves updated_at, not created_at', async () => {
  const id = db.prepare(`INSERT INTO health_prevention_types (name, kind, created_at, updated_at)
    VALUES ('Masern', 'vaccination', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`).run().lastInsertRowid;
  asA();
  const res = await call('PATCH', `/prevention/types/${id}`, { name: 'MMR' });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.data.updated_at, '2000-01-01T00:00:00Z');
  assert.equal(res.body.data.created_at, '2000-01-01T00:00:00Z');
});

test('teardown: Server schliessen', async () => {
  await new Promise((r) => server.close(r));
});
