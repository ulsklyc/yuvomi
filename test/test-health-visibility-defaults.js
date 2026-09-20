/**
 * Modul: Health-Test - persoenliche Standard-Sichtbarkeit (#958)
 * Zweck: Die Frage, um die es geht: bekommt ein neuer Eintrag die Sichtbarkeit,
 *        die SEIN EIGENTUEMER gewaehlt hat - und bleibt der ausgelieferte Wert
 *        `private`, solange niemand etwas gewaehlt hat?
 *
 *        Dazu die drei Eigenschaften, an denen der Entwurf haengt:
 *        je Metrik statt je Bereich (Blutdruck teilen heisst nicht Stimmung
 *        teilen), sparse (kein Eintrag = privat), und das Nachziehen der
 *        Bestandsdaten trifft nur den genannten Bereich und nur eigene Zeilen.
 *
 * Ausfuehren: npm run test:health-visibility-defaults
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
  VALUES ('alice', 'Alice', '$2b$12$x', 'member')`).run().lastInsertRowid;
const userB = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('bob', 'Bob', '$2b$12$x', 'member')`).run().lastInsertRowid;

let session = { userId: userA, role: 'member' };
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

const asA = () => { session = { userId: userA, role: 'member' }; };
const asB = () => { session = { userId: userB, role: 'member' }; };

/** Ein Vitalwert des angemeldeten Nutzers, ohne Angabe zur Sichtbarkeit. */
async function postVital(type, extra = {}) {
  const res = await call('POST', '/vitals', {
    type, value_num: 120, unit: 'x', measured_at: '2026-06-01T08:00', ...extra,
  });
  assert.equal(res.status, 201, `POST /vitals fehlgeschlagen: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

// ── Der Bestandsfall ────────────────────────────────────────────────────────

test('ohne jede Wahl bleibt alles privat - wie vor Migration 172', async () => {
  asA();
  assert.equal((await postVital('bp')).visibility, 'private');
  assert.equal((await postVital('mood')).visibility, 'private');
  const meds = await call('POST', '/medications', { name: 'Ibu' });
  assert.equal(meds.body.data.visibility, 'private');
  // Und die Auskunft sagt dasselbe: keine Zeile, keine Abweichung.
  const res = await call('GET', '/visibility-defaults');
  assert.deepEqual(res.body.data.defaults, {});
});

// ── Je Metrik, nicht je Bereich ─────────────────────────────────────────────

test('eine Wahl fuer den Blutdruck laesst die Stimmung unberuehrt', async () => {
  asA();
  const put = await call('PUT', '/visibility-defaults', { defaults: { 'vital:bp': 'family' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.data.defaults, { 'vital:bp': 'family' });

  assert.equal((await postVital('bp')).visibility, 'family');
  // DAS ist der Grund fuer die Trennung: beide sind Vitalwerte, aber wer den
  // Blutdruck teilt, teilt damit nicht, wie es ihm geht.
  assert.equal((await postVital('mood')).visibility, 'private');
});

test('eine ausdrueckliche Angabe im Body gewinnt gegen die Voreinstellung', async () => {
  asA();
  // Voreinstellung steht auf 'family' (Test davor) - der Eintrag trotzdem privat.
  assert.equal((await postVital('bp', { visibility: 'private' })).visibility, 'private');
});

test('die vier uebrigen Bereiche haben je eine Voreinstellung', async () => {
  asA();
  await call('PUT', '/visibility-defaults', {
    defaults: { meds: 'family', labs: 'family', activities: 'family', prevention: 'family' },
  });
  const meds = await call('POST', '/medications', { name: 'Aspirin' });
  assert.equal(meds.body.data.visibility, 'family');
  const labs = await call('POST', '/labs', { report_date: '2026-06-01' });
  assert.equal(labs.body.data.visibility, 'family');
  const act = await call('POST', '/activities', { type: 'walk', performed_at: '2026-06-01T08:00' });
  assert.equal(act.body.data.visibility, 'family');
  // Deckt genau die Luecke ab, die 'prevention' in FLAT_SCOPES ohne einen
  // Eintrag im Settings-Blatt unerreichbar liess: ohne Test haette niemand
  // gemerkt, dass die Person nie speichern konnte, was hier gesetzt wird.
  const prevention = await call('POST', '/prevention/records', { given_on: '2026-06-01', name: 'Reisemedizinische Beratung' });
  assert.equal(prevention.body.data.visibility, 'family');
});

// ── Sparse ──────────────────────────────────────────────────────────────────

test('auf privat zurueck loescht die Zeile, statt sie zu schreiben', async () => {
  asA();
  await call('PUT', '/visibility-defaults', { defaults: { meds: 'private' } });
  const res = await call('GET', '/visibility-defaults');
  assert.equal('meds' in res.body.data.defaults, false, 'privat ist die Abwesenheit einer Zeile');
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM health_visibility_defaults WHERE user_id = ? AND scope_key = 'meds'").get(userA).c,
    0,
  );
  // Und die Wirkung ist wieder die ausgelieferte.
  const meds = await call('POST', '/medications', { name: 'Paracetamol' });
  assert.equal(meds.body.data.visibility, 'private');
});

// Der Server kennt einen Bereich (FLAT_SCOPES), sobald er hier registriert
// ist - aber ohne eine Zeile im Settings-Blatt kann ihn niemand je auf
// 'family' stellen, und defaultVisibilityFor() bliebe fuer immer 'private'
// (genau die Luecke, die 'prevention' hier eine Weile hatte). Ein Fund gegen
// den Quelltext statt gegen den Server, weil das Blatt ein Browser-Modul ist.
test('jeder FLAT_SCOPES-Schluessel hat eine Zeile im Settings-Blatt', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const serverSrc = readFileSync(`${root}server/routes/health/visibility-defaults.js`, 'utf8');
  const clientSrc = readFileSync(`${root}public/settings/pages/personal-health.js`, 'utf8');

  const flatScopesBlock = serverSrc.match(/const FLAT_SCOPES = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
  const serverKeys = [...flatScopesBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();

  // Nur der visibilityScopes()-Block zaehlt - ein `key: '...'` anderswo im
  // Modul (z.B. ein kuenftiges, unverwandtes Feature) soll kein falscher Fund werden.
  const scopesBlock = clientSrc.match(/function visibilityScopes\(\) \{([\s\S]*?)\n\}/)[1];
  const clientKeys = [...scopesBlock.matchAll(/key: '(\w+)'/g)].map((m) => m[1]).sort();

  const missing = serverKeys.filter((k) => !clientKeys.includes(k));
  assert.deepEqual(missing, [], `Settings-Blatt fehlen Zeilen fuer: ${missing.join(', ')}`);
});

test('unbekannte Bereiche und Werte werden abgewiesen', async () => {
  asA();
  assert.equal((await call('PUT', '/visibility-defaults', { defaults: { budget: 'family' } })).status, 400);
  assert.equal((await call('PUT', '/visibility-defaults', { defaults: { 'vital:bp': 'all' } })).status, 400);
  assert.equal((await call('PUT', '/visibility-defaults', { defaults: 'nein' })).status, 400);
});

// ── Die Wahl gehoert dem Eigentuemer ────────────────────────────────────────

test('traegt eine betreuende Person ein, gilt die Wahl der betreuten', async () => {
  // Die Zeile gehoert B, also entscheidet B - nicht A, der sie eintraegt.
  db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(userB, userA);
  asB();
  await call('PUT', '/visibility-defaults', { defaults: { 'vital:temp': 'family' } });
  asA();
  const res = await call('POST', '/vitals', {
    user_id: userB, type: 'temp', value_num: 38.5, unit: 'C', measured_at: '2026-06-02T08:00',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user_id, userB);
  assert.equal(res.body.data.visibility, 'family', 'die Voreinstellung des Eigentuemers zaehlt');
});

// ── Bestandsdaten nachziehen ────────────────────────────────────────────────

test('apply zieht nur den genannten Bereich nach', async () => {
  asA();
  const before = db.prepare(
    "SELECT COUNT(*) c FROM health_vitals WHERE user_id = ? AND type = 'mood' AND visibility = 'private'"
  ).get(userA).c;
  assert.ok(before > 0, 'Vorbedingung: es gibt private Stimmungs-Eintraege');

  const res = await call('PATCH', '/visibility-defaults/apply', { scope: 'vital:bp', visibility: 'private' });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.updated > 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM health_vitals WHERE user_id = ? AND type = 'bp' AND visibility = 'family'").get(userA).c,
    0,
    'die Blutdruck-Zeilen sind umgestellt',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM health_vitals WHERE user_id = ? AND type = 'mood' AND visibility = 'private'").get(userA).c,
    before,
    'die Stimmungs-Zeilen hat niemand angefasst',
  );
});

test('apply fasst fremde Zeilen nicht an', async () => {
  asB();
  await call('POST', '/vitals', {
    type: 'glucose', value_num: 90, unit: 'mg/dL', measured_at: '2026-06-03T08:00', visibility: 'private',
  });
  asA();
  await call('POST', '/vitals', {
    type: 'glucose', value_num: 95, unit: 'mg/dL', measured_at: '2026-06-03T09:00', visibility: 'private',
  });
  const res = await call('PATCH', '/visibility-defaults/apply', { scope: 'vital:glucose', visibility: 'family' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.updated, 1, 'nur die eigene Zeile');
  assert.equal(
    db.prepare("SELECT visibility FROM health_vitals WHERE user_id = ? AND type = 'glucose'").get(userB).visibility,
    'private',
    'Bs Wert steht unveraendert - eine Sichtbarkeit ist die Entscheidung ihres Eigentuemers',
  );
});

test('apply weist einen unbekannten Bereich ab', async () => {
  asA();
  assert.equal((await call('PATCH', '/visibility-defaults/apply', { scope: 'budget', visibility: 'family' })).status, 400);
  assert.equal((await call('PATCH', '/visibility-defaults/apply', { scope: 'meds' })).status, 400);
});

test('teardown: Server schliessen', async () => {
  await new Promise((r) => server.close(r));
});
