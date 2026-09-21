/**
 * Modul: Health-Test - Naehrwerte (Tagesziel, Tagebuch, Tagesbilanz) - #1326
 * Zweck: Die vier Zusicherungen, die dieser Bereich braucht und die kein
 *        anderer Test haelt:
 *
 *   1. SCHEMA UND ROUTE EXISTIEREN. Die ehrliche rote Erstmessung: gegen den
 *      Stand vor Migration 223 liefert `PRAGMA table_info(health_nutrition_entries)`
 *      nichts und `GET /nutrition/entries` ist 404.
 *   2. ALLE ACHT NAEHRWERTE EINZELN BEIM NAMEN, durch POST und GET. Acht
 *      Spalten, die in Migration, Route, CSV und Formular von Hand geschrieben
 *      werden, sind genau die Bauform, in der eine davon an einer Stelle anders
 *      heisst - und keine Suite es meldet.
 *   3. EIGENTUM UND SICHTBARKEIT GEGEN DIE HTTP-ROUTE, nicht gegen den Helfer:
 *      ein fremder privater Eintrag bleibt unsichtbar, ein offener nicht; eine
 *      betreuende Person darf schreiben, und die Zeile traegt die Vorgabe des
 *      EIGENTUEMERS; ohne Freigabe gibt es 403.
 *   4. "KEINE ZEILE" UND "ZIEL 0" SIND UNTERSCHEIDBAR. Wer die Spalte als falsy
 *      liest, macht aus "null Gramm Zucker, ausdruecklich" ein "kein Ziel".
 *
 *   Dazu die Tagesgrenze: `todayKey()` folgt der HAUSHALTSZONE. Ein Eintrag,
 *   dessen UTC-Tag und lokaler Tag auseinanderfallen, muss in der Bilanz des
 *   LOKALEN Tages stehen - sonst besteht die Suite in einer Zone und versteckt
 *   den Fehler in jeder anderen.
 *
 * Ausfuehren: npm run test:health-nutrition
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: healthRouter } = await import('../server/routes/health.js');
const { NUTRIENT_KEYS } = await import('../server/services/health-nutrition.js');
const { HEALTH_EXPORT_HEADERS } = await import('../server/services/health-export.js');
// `utcDateKey` ist hier die RICHTIGE Funktion und nicht der Fehler, den sie
// sonst markiert: dieser Test vergleicht den Haushaltstag ausdruecklich GEGEN
// den UTC-Tag. Genau dafuer gibt es sie als benannte Funktion (siehe ihren
// Dokblock in server/utils/timezone.js) - wer sie ruft, sagt mit dem Namen,
// dass er den UTC-Tag wirklich meint.
const { todayKey, utcDateKey } = await import('../server/utils/timezone.js');

// DIE ZONE IST FESTGENAGELT, und zwar auf eine mit positivem Offset: in
// Europe/Berlin (UTC+1/+2) ist der 23:30-Eintrag eines Tages UTC noch der
// Vortag. Genau daran faellt ein `toISOString().slice(0, 10)` auf, und ohne
// diese Zeile haette die Suite die Zone der Maschine gemessen statt eine
// bekannte.
const ZONE = 'Europe/Berlin';

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
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(ZONE);
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
// Dave betreut Bob (#584); Carol betreut niemanden.
const userD = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('dave', 'Dave', '$2b$12$x', 'member')`).run().lastInsertRowid;
db.prepare('INSERT INTO health_care_grants (subject_id, caregiver_id) VALUES (?, ?)').run(userB, userD);

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
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') && text ? JSON.parse(text) : null, text };
}

const asA = () => { session = { userId: userA, role: 'admin' }; };
const asB = () => { session = { userId: userB, role: 'member' }; };
const asC = () => { session = { userId: userC, role: 'member' }; };
const asD = () => { session = { userId: userD, role: 'member' }; };

/** Die acht mit je einem UNTERSCHIEDLICHEN Wert - so faellt eine Vertauschung auf. */
const EIGHT = {
  energy_kcal: 651,
  fat_g: 21.5,
  saturated_fat_g: 8.25,
  carbs_g: 72.5,
  sugar_g: 12.75,
  protein_g: 31.5,
  salt_g: 1.85,
  fiber_g: 6.5,
};

const today = () => todayKey(db);

test.after(() => server.close());

// ── 1. Schema + Migration ───────────────────────────────────────────────────

test('Migration 223 legt beide Tabellen mit den acht Spalten an', () => {
  // DIE ROTE ERSTMESSUNG IN IHRER EHRLICHEN FORM: gegen den Stand vor der
  // Migration ist `columns` leer, und alles darunter faellt mit ihr.
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const entries = columns('health_nutrition_entries');
  assert.ok(entries.length > 0, 'health_nutrition_entries existiert nicht');
  for (const key of NUTRIENT_KEYS) {
    assert.ok(entries.includes(key), `health_nutrition_entries.${key} fehlt`);
  }
  for (const key of ['user_id', 'consumed_at', 'meal_type', 'title', 'note', 'visibility', 'created_by']) {
    assert.ok(entries.includes(key), `health_nutrition_entries.${key} fehlt`);
  }
  // `calories` ist auf health_activities die VERBRANNTE Energie. Ein Wort fuer
  // beide Richtungen faellt zuerst im CSV-Export auf, wo beide Bereiche in
  // einer Datei liegen - hier steht die Grenze als Zusicherung.
  assert.ok(!entries.includes('calories'),
    'health_nutrition_entries darf keine Spalte `calories` tragen - die gibt es auf health_activities und meint das Gegenteil');

  const targets = columns('health_nutrition_targets');
  assert.ok(targets.length > 0, 'health_nutrition_targets existiert nicht');
  assert.deepEqual(
    NUTRIENT_KEYS.filter((k) => !targets.includes(k)), [],
    'health_nutrition_targets fehlen Naehrwert-Spalten',
  );
  assert.ok(targets.includes('user_id'), 'health_nutrition_targets.user_id fehlt');
});

test('acht Naehrwerte, nicht sieben und nicht neun (DECISIONS Abschnitt 8)', () => {
  assert.equal(NUTRIENT_KEYS.length, 8, `NUTRIENT_KEYS hat ${NUTRIENT_KEYS.length} Eintraege`);
  assert.deepEqual([...NUTRIENT_KEYS], [
    'energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugar_g', 'protein_g', 'salt_g', 'fiber_g',
  ]);
});

test('der Index auf (user_id, consumed_at) steht - die eine Abfrage dieser Tabelle', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'health_nutrition_entries'").all();
  assert.ok(indexes.some((i) => i.name === 'idx_health_nutrition_entries_user_date'),
    `Index fehlt, vorhanden: ${indexes.map((i) => i.name).join(', ')}`);
});

test('ein Eintrag mit negativem Naehrwert prallt am CHECK ab', () => {
  assert.throws(() => db.prepare(`
    INSERT INTO health_nutrition_entries (user_id, consumed_at, title, fat_g, visibility, created_by)
    VALUES (?, '2026-09-21T12:00', 'Test', -1, 'private', ?)
  `).run(userA, userA), /CONSTRAINT/i);
});

test('visibility fuehrt den kanonischen Satz, nicht das Paar der uebrigen Gesundheit', () => {
  // 'family' ist die Schreibweise, die die Gesundheit sonst benutzt - hier ist
  // sie ein Fehler. Das ist die Zusicherung aus DECISIONS Abschnitt 5: neue
  // Module nehmen den kanonischen Satz von Anfang an.
  assert.throws(() => db.prepare(`
    INSERT INTO health_nutrition_entries (user_id, consumed_at, title, visibility, created_by)
    VALUES (?, '2026-09-21T12:00', 'Test', 'family', ?)
  `).run(userA, userA), /CONSTRAINT/i);

  for (const value of ['private', 'all']) {
    const id = db.prepare(`
      INSERT INTO health_nutrition_entries (user_id, consumed_at, title, visibility, created_by)
      VALUES (?, '2026-09-21T12:00', 'Test', ?, ?)
    `).run(userA, value, userA).lastInsertRowid;
    db.prepare('DELETE FROM health_nutrition_entries WHERE id = ?').run(id);
  }
});

// ── 2. Alle acht, durch POST und GET, einzeln beim Namen ────────────────────

let entryId;

test('POST /nutrition/entries speichert alle acht Naehrwerte, GET gibt sie einzeln zurueck', async () => {
  asA();
  const created = await call('POST', '/nutrition/entries', {
    title: 'Linsensuppe', consumed_at: `${today()}T12:30`, meal_type: 'lunch', ...EIGHT,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  entryId = created.body.data.id;

  // EINZELN BEIM NAMEN, und mit acht verschiedenen Werten: eine Vertauschung
  // zweier Spalten (etwa carbs_g und sugar_g) faellt nur so auf.
  for (const key of NUTRIENT_KEYS) {
    assert.equal(created.body.data[key], EIGHT[key], `POST: ${key} kam als ${created.body.data[key]} zurueck, erwartet ${EIGHT[key]}`);
  }

  const list = await call('GET', '/nutrition/entries');
  assert.equal(list.status, 200);
  const row = list.body.data.find((r) => r.id === entryId);
  assert.ok(row, 'Eintrag fehlt in der Liste');
  for (const key of NUTRIENT_KEYS) {
    assert.equal(row[key], EIGHT[key], `GET: ${key} kam als ${row[key]} zurueck, erwartet ${EIGHT[key]}`);
  }
  assert.equal(row.title, 'Linsensuppe');
  assert.equal(row.meal_type, 'lunch');
  // Ohne eigene Angabe und ohne Voreinstellung: der engere Wert.
  assert.equal(row.visibility, 'private');
});

test('ein nicht angegebener Naehrwert bleibt NULL und wird nicht zu 0', async () => {
  asA();
  const created = await call('POST', '/nutrition/entries', {
    title: 'Apfel', consumed_at: `${today()}T16:00`, energy_kcal: 52,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.energy_kcal, 52);
  for (const key of NUTRIENT_KEYS.filter((k) => k !== 'energy_kcal')) {
    assert.equal(created.body.data[key], null,
      `${key} muss null bleiben ("nicht angegeben"), kam aber als ${created.body.data[key]}`);
  }
  await call('DELETE', `/nutrition/entries/${created.body.data.id}`);
});

test('PATCH: eine ausdrueckliche 0 bleibt 0, ein null loescht den Wert', async () => {
  asA();
  const patched = await call('PATCH', `/nutrition/entries/${entryId}`, { sugar_g: 0, fiber_g: null });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.sugar_g, 0, 'eine eingetragene 0 darf nicht zu null werden');
  assert.equal(patched.body.data.fiber_g, null, 'ein ausdrueckliches null muss den Wert loeschen');
  // Alles andere bleibt unangetastet.
  assert.equal(patched.body.data.carbs_g, EIGHT.carbs_g);
  await call('PATCH', `/nutrition/entries/${entryId}`, { sugar_g: EIGHT.sugar_g, fiber_g: EIGHT.fiber_g });
});

test('POST lehnt einen unmoeglichen Naehrwert ab', async () => {
  asA();
  const negative = await call('POST', '/nutrition/entries', { title: 'X', consumed_at: `${today()}T08:00`, fat_g: -5 });
  assert.equal(negative.status, 400);
  const huge = await call('POST', '/nutrition/entries', { title: 'X', consumed_at: `${today()}T08:00`, fat_g: 1e9 });
  assert.equal(huge.status, 400);
  const noTitle = await call('POST', '/nutrition/entries', { consumed_at: `${today()}T08:00` });
  assert.equal(noTitle.status, 400);
});

test('der CSV-Export fuehrt dieselben acht Spalten unter denselben Namen', async () => {
  asA();
  const res = await call('GET', '/export/nutrition');
  assert.equal(res.status, 200);
  const header = res.text.replace(/^﻿/, '').split('\n')[0];
  for (const key of NUTRIENT_KEYS) {
    assert.ok(header.includes(`"${key}"`), `CSV-Kopfzeile fuehrt ${key} nicht: ${header}`);
  }
  // Und die Kopfzeile stammt aus derselben Liste, die die Route schreibt.
  assert.deepEqual(
    NUTRIENT_KEYS.filter((k) => !HEALTH_EXPORT_HEADERS.nutrition.includes(k)), [],
    'HEALTH_EXPORT_HEADERS.nutrition und NUTRIENT_KEYS laufen auseinander',
  );
  assert.ok(!HEALTH_EXPORT_HEADERS.nutrition.includes('calories'),
    'der Naehrwert-Export darf keine Spalte `calories` fuehren - die steht im Aktivitaets-Export und meint das Gegenteil');
});

// ── 3. Eigentum und Sichtbarkeit, gegen die HTTP-Route ──────────────────────

test('ein Mitglied sieht den privaten Eintrag eines anderen NICHT', async () => {
  asB();
  const own = await call('POST', '/nutrition/entries', {
    title: 'Bobs Fruehstueck', consumed_at: `${today()}T07:00`, visibility: 'private', energy_kcal: 300,
  });
  assert.equal(own.status, 201);
  const privateId = own.body.data.id;

  asC();
  const all = await call('GET', '/nutrition/entries');
  assert.equal(all.status, 200);
  assert.ok(!all.body.data.some((r) => r.id === privateId), 'ein fremder privater Eintrag darf nicht in der Liste stehen');

  const filtered = await call('GET', `/nutrition/entries?user_id=${userB}`);
  assert.equal(filtered.status, 200);
  assert.ok(!filtered.body.data.some((r) => r.id === privateId), 'auch mit ?user_id= bleibt der private Eintrag weg');

  // Und aendern darf ihn erst recht niemand: 404 statt 403, damit die Antwort
  // nicht verraet, dass es die Zeile gibt.
  const patch = await call('PATCH', `/nutrition/entries/${privateId}`, { title: 'geklaut' });
  assert.equal(patch.status, 404);
  const del = await call('DELETE', `/nutrition/entries/${privateId}`);
  assert.equal(del.status, 404);
});

test('ein Eintrag mit visibility `all` ist fuer den Haushalt lesbar', async () => {
  asB();
  const shared = await call('POST', '/nutrition/entries', {
    title: 'Bobs Abendessen', consumed_at: `${today()}T19:00`, visibility: 'all', energy_kcal: 700,
  });
  assert.equal(shared.status, 201);
  assert.equal(shared.body.data.visibility, 'all');

  asC();
  const all = await call('GET', '/nutrition/entries');
  assert.ok(all.body.data.some((r) => r.id === shared.body.data.id), 'ein offener Eintrag muss fuer den Haushalt lesbar sein');
});

test('eine betreuende Person darf fuer die betreute eintragen; die Zeile traegt die Vorgabe des EIGENTUEMERS', async () => {
  // Bob waehlt "familiensichtbar" als seine Voreinstellung fuer diesen Bereich.
  // Gespeichert wird das im Paar private/family (health_visibility_defaults);
  // die Naehrwert-Zeile muss daraus 'all' machen, nicht 'family' - sonst
  // schriebe die Route gegen einen CHECK, den es so nicht gibt.
  asB();
  const pref = await call('PUT', '/visibility-defaults', { defaults: { nutrition: 'family' } });
  assert.equal(pref.status, 200, JSON.stringify(pref.body));

  asD();
  const forBob = await call('POST', '/nutrition/entries', {
    user_id: userB, title: 'Mittag fuer Bob', consumed_at: `${today()}T12:00`, energy_kcal: 500,
  });
  assert.equal(forBob.status, 201, JSON.stringify(forBob.body));
  assert.equal(forBob.body.data.user_id, userB, 'die Zeile muss Bob gehoeren, nicht Dave');
  assert.equal(forBob.body.data.created_by, userD, 'created_by nennt die erfassende Person');
  assert.equal(forBob.body.data.visibility, 'all',
    'die Sichtbarkeit folgt Bobs Wahl (family -> all), nicht Daves Voreinstellung');

  // Gegenprobe an Dave selbst: SEINE Voreinstellung ist unveraendert privat,
  // sein eigener Eintrag also auch. Ohne sie waere der Test oben auch dann
  // gruen, wenn die Route schlicht immer 'all' schriebe.
  const forSelf = await call('POST', '/nutrition/entries', {
    title: 'Daves Mittag', consumed_at: `${today()}T12:05`, energy_kcal: 400,
  });
  assert.equal(forSelf.body.data.visibility, 'private');

  asB();
  await call('PUT', '/visibility-defaults', { defaults: { nutrition: 'private' } });
});

test('PATCH /visibility-defaults/apply zieht Bestandszeilen in der Schreibweise DIESER Tabelle nach', async () => {
  // Der Nachzieh-Knopf spricht das Paar private/family (so steht es in den
  // Einstellungen), die Tabelle fuehrt private/all. Ohne die Uebersetzung in
  // visibility-defaults.js schriebe dieser Zweig ein 'family' gegen einen
  // CHECK, der es nicht kennt - der Knopf endete in einem 500, und zwar erst
  // beim Benutzen.
  asC();
  const a = await call('POST', '/nutrition/entries', { title: 'A', consumed_at: '2026-06-01T08:00', visibility: 'private', energy_kcal: 10 });
  const b = await call('POST', '/nutrition/entries', { title: 'B', consumed_at: '2026-06-01T09:00', visibility: 'private', energy_kcal: 20 });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const applied = await call('PATCH', '/visibility-defaults/apply', { scope: 'nutrition', visibility: 'family' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.ok(applied.body.data.updated >= 2, `erwartet mindestens 2 nachgezogene Zeilen, waren ${applied.body.data.updated}`);

  const after = await call('GET', '/nutrition/entries');
  for (const id of [a.body.data.id, b.body.data.id]) {
    const row = after.body.data.find((r) => r.id === id);
    assert.equal(row.visibility, 'all', 'nachgezogen wird auf `all`, nicht auf `family`');
  }

  // Und zurueck: 'private' ist in beiden Vokabularen dasselbe Wort.
  assert.equal((await call('PATCH', '/visibility-defaults/apply', { scope: 'nutrition', visibility: 'private' })).status, 200);
  const back = await call('GET', '/nutrition/entries');
  assert.equal(back.body.data.find((r) => r.id === a.body.data.id).visibility, 'private');

  await call('DELETE', `/nutrition/entries/${a.body.data.id}`);
  await call('DELETE', `/nutrition/entries/${b.body.data.id}`);
});

test('eine Person ohne Betreuungs-Freigabe bekommt 403 statt einer fremden Zeile', async () => {
  asC();
  const denied = await call('POST', '/nutrition/entries', {
    user_id: userB, title: 'Carol traegt fuer Bob ein', consumed_at: `${today()}T13:00`, energy_kcal: 100,
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const deniedTarget = await call('PUT', '/nutrition/targets', { user_id: userB, energy_kcal: 1 });
  assert.equal(deniedTarget.status, 403);
});

test('ein Admin hat keinen Sonderzugriff auf fremde Eintraege (DECISIONS Abschnitt 1)', async () => {
  asB();
  const own = await call('POST', '/nutrition/entries', {
    title: 'Bobs Snack', consumed_at: `${today()}T15:00`, visibility: 'private', energy_kcal: 120,
  });
  const id = own.body.data.id;

  asA();  // Alice ist admin
  const list = await call('GET', '/nutrition/entries');
  assert.ok(!list.body.data.some((r) => r.id === id), 'ein Admin darf fremde private Eintraege nicht sehen');
  assert.equal((await call('DELETE', `/nutrition/entries/${id}`)).status, 404);
});

test('das Tagesziel ist keine Zeile mit Sichtbarkeit: fremd heisst 403, nicht "leer"', async () => {
  asB();
  assert.equal((await call('PUT', '/nutrition/targets', { energy_kcal: 2000 })).status, 200);

  asC();
  const foreign = await call('GET', `/nutrition/targets?user_id=${userB}`);
  assert.equal(foreign.status, 403);

  asD();  // Betreuer
  const asCaregiver = await call('GET', `/nutrition/targets?user_id=${userB}`);
  assert.equal(asCaregiver.status, 200);
  assert.equal(asCaregiver.body.data.target.energy_kcal, 2000);

  // Und die Bilanz gibt das Ziel unter derselben Regel heraus: Carol sieht
  // Bobs offene Eintraege, sein Ziel aber nicht.
  asC();
  const summary = await call('GET', `/nutrition/summary?user_id=${userB}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.target, null, 'ohne Betreuung darf die Bilanz kein fremdes Ziel ausliefern');
});

// ── 4. Sparsames Ziel: "keine Zeile" != "Ziel 0" ───────────────────────────

test('ohne Zeile ist das Ziel null - nicht ein Ziel aus Nullen', async () => {
  asC();
  const res = await call('GET', '/nutrition/targets');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.target, null,
    'keine Zeile muss als null ankommen, sonst liest die Kachel "0 von 0" als erreichtes Ziel');
  assert.equal((await call('GET', '/nutrition/summary')).body.data.target, null);
});

test('ein ausdrueckliches Ziel von 0 ist ein Ziel und ueberlebt den Round-Trip', async () => {
  asC();
  const saved = await call('PUT', '/nutrition/targets', { energy_kcal: 1800, sugar_g: 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.target.sugar_g, 0, 'eine 0 darf nicht als "nicht gesetzt" gespeichert werden');
  assert.equal(saved.body.data.target.energy_kcal, 1800);
  assert.equal(saved.body.data.target.fat_g, null, 'ein nicht genanntes Ziel bleibt nicht gesetzt');

  const read = await call('GET', '/nutrition/targets');
  assert.equal(read.body.data.target.sugar_g, 0, 'die 0 muss auch beim Lesen 0 bleiben');
  assert.notEqual(read.body.data.target.sugar_g, null);

  // DER UNTERSCHIED, UM DEN ES GEHT: beide Faelle sind ueber `=== null`
  // unterscheidbar, ueber `!value` nicht.
  assert.ok(read.body.data.target.sugar_g !== null && read.body.data.target.fat_g === null,
    'Ziel 0 und "kein Ziel" muessen unterscheidbar bleiben');
});

test('ein Ziel, in dem alle acht leer sind, LOESCHT die Zeile (sparse)', async () => {
  asC();
  const cleared = await call('PUT', '/nutrition/targets', {});
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.target, null);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM health_nutrition_targets WHERE user_id = ?').get(userC).n;
  assert.equal(rows, 0, 'ein geleertes Ziel darf keine Zeile aus Nullen hinterlassen');
});

// ── 5. Die Tagesgrenze kommt aus der Haushaltszone ─────────────────────────

test('Vorbedingung: die Zone ist festgenagelt und die Suite misst nicht die Maschine', () => {
  assert.equal(
    db.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value,
    ZONE,
    'ohne gesetzte Haushaltszone misst diese Suite die Zone der Maschine',
  );
});

test('die Tagesbilanz folgt dem LOKALEN Tag, auch wenn der UTC-Tag ein anderer ist', async () => {
  // 23:30 Ortszeit in Europe/Berlin ist 21:30 oder 22:30 UTC - derselbe Tag.
  // Umgekehrt ist 00:30 Ortszeit der VORTAG in UTC, und genau das ist der
  // Eintrag, an dem ein `toISOString().slice(0, 10)` auf den falschen Tag
  // faellt. Gemessen wird gegen einen FESTEN Tag, nicht gegen "heute": so
  // haengt die Zusicherung nicht daran, wann die Suite laeuft.
  const localDay = '2026-03-15';
  const utcDayOfThatMoment = new Date('2026-03-15T00:30:00+01:00').toISOString().slice(0, 10);
  assert.equal(utcDayOfThatMoment, '2026-03-14',
    'Vorbedingung: der 00:30-Eintrag muss in UTC auf dem Vortag liegen, sonst misst dieser Test nichts');

  asA();
  const early = await call('POST', '/nutrition/entries', {
    title: 'Mitternachtssnack', consumed_at: `${localDay}T00:30`, energy_kcal: 111,
  });
  assert.equal(early.status, 201);
  const late = await call('POST', '/nutrition/entries', {
    title: 'Spaetes Abendessen', consumed_at: `${localDay}T23:30`, energy_kcal: 222,
  });
  assert.equal(late.status, 201);

  const summary = await call('GET', `/nutrition/summary?date=${localDay}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.date, localDay);
  assert.equal(summary.body.data.entryCount, 2,
    'beide Eintraege gehoeren zum LOKALEN 15.03. - der fruehe faellt sonst auf den UTC-Vortag');
  assert.equal(summary.body.data.totals.energy_kcal, 333);

  // Der UTC-Nachbartag hat sie NICHT. Ohne diese Zeile waere der Test auch
  // dann gruen, wenn die Rechnung schlicht alles zusammenzaehlte.
  const neighbour = await call('GET', `/nutrition/summary?date=${utcDayOfThatMoment}`);
  assert.equal(neighbour.body.data.entryCount, 0,
    `am UTC-Tag ${utcDayOfThatMoment} darf nichts stehen - dort liegt nur der UTC-Zeitpunkt, nicht der Kalendertag`);

  await call('DELETE', `/nutrition/entries/${early.body.data.id}`);
  await call('DELETE', `/nutrition/entries/${late.body.data.id}`);
});

test('GET /nutrition/summary ohne date nimmt todayKey() der Haushaltszone', async () => {
  asA();
  const res = await call('GET', '/nutrition/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.date, today(),
    'die Bilanz ohne date muss den Haushaltstag nehmen, nicht den UTC-Tag');
});

test('der Tag ohne date faellt in einer Zone, deren Kalendertag NICHT der UTC-Tag ist', async () => {
  // DIE ZEILE DARUEBER ALLEIN BEWEIST NICHTS, und zwar zu den meisten
  // Tageszeiten: in Europe/Berlin stimmen Haushaltstag und UTC-Tag ueberein,
  // solange es hier noch nicht Abend ist - ein `toISOString().slice(0, 10)` in
  // der Route waere morgens gruen und abends rot, also eine Suite, die je nach
  // Uhrzeit etwas anderes misst.
  //
  // Zwei Zonen an den Enden der Skala loesen das ohne feste Uhrzeit: bei
  // UTC+14 liegt der Kalendertag ab 10:00 UTC schon auf morgen, bei UTC-11
  // davor noch auf gestern. Fuer JEDEN Zeitpunkt weicht also mindestens eine
  // der beiden vom UTC-Tag ab - und in dieser wird gemessen.
  const setZone = (zone) => db.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(zone);
  const utcDay = utcDateKey();
  let abweichendeZonenGeprueft = 0;

  try {
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Niue']) {
      setZone(zone);
      const erwartet = todayKey(db);
      if (erwartet === utcDay) continue;  // diese Zone trifft den UTC-Tag gerade
      abweichendeZonenGeprueft += 1;
      asA();
      const res = await call('GET', '/nutrition/summary');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.date, erwartet,
        `in ${zone} muss die Bilanz auf ${erwartet} stehen, der UTC-Tag ist ${utcDay}`);
    }
  } finally {
    setZone(ZONE);
  }

  assert.ok(abweichendeZonenGeprueft > 0,
    'keine der beiden Extremzonen wich vom UTC-Tag ab - dann misst dieser Test nichts (UTC+14 und UTC-11 koennen nicht beide den UTC-Tag treffen)');
});

test('die Bilanz zaehlt nur, was die lesende Person sehen darf', async () => {
  const day = '2026-05-04';
  asB();
  const hidden = await call('POST', '/nutrition/entries', {
    title: 'privat', consumed_at: `${day}T08:00`, visibility: 'private', energy_kcal: 400,
  });
  const shown = await call('POST', '/nutrition/entries', {
    title: 'offen', consumed_at: `${day}T12:00`, visibility: 'all', energy_kcal: 600,
  });

  const own = await call('GET', `/nutrition/summary?date=${day}`);
  assert.equal(own.body.data.totals.energy_kcal, 1000, 'der Eigentuemer sieht beide');

  asC();
  const foreign = await call('GET', `/nutrition/summary?user_id=${userB}&date=${day}`);
  assert.equal(foreign.body.data.totals.energy_kcal, 600, 'ein Mitglied sieht nur die offene Zeile');

  asD();  // Betreuer sieht wieder beide
  const caregiver = await call('GET', `/nutrition/summary?user_id=${userB}&date=${day}`);
  assert.equal(caregiver.body.data.totals.energy_kcal, 1000, 'eine betreuende Person sieht beide');

  asB();
  await call('DELETE', `/nutrition/entries/${hidden.body.data.id}`);
  await call('DELETE', `/nutrition/entries/${shown.body.data.id}`);
});

// ── 6. Das Widget ist default-AUS ──────────────────────────────────────────

// ── 7. Die reine Logik der Anzeige ─────────────────────────────────────────

test('nutrientProgress unterscheidet "kein Ziel", "Ziel 0" und den gewoehnlichen Anteil', async () => {
  const { nutrientProgress, NUTRIENTS, NUTRIENT_KEYS: CLIENT_KEYS } =
    await import('../public/utils/health-nutrition.js');

  // Die Oberflaeche fuehrt DIESELBEN acht wie der Server. Zwei Listen, die
  // auseinanderlaufen, faenden sonst erst die Nutzer.
  assert.deepEqual([...CLIENT_KEYS], [...NUTRIENT_KEYS],
    'die Naehrwert-Liste der Oberflaeche und die des Servers laufen auseinander');
  assert.equal(NUTRIENTS.length, 8);

  // Kein Ziel: die Kachel darf keinen Balken zeichnen.
  assert.deepEqual(nutrientProgress(50, null), { hasTarget: false, ratio: 0, over: false });
  assert.deepEqual(nutrientProgress(50, undefined), { hasTarget: false, ratio: 0, over: false });

  // Ziel 0 IST ein Ziel: bei 0 erreicht, bei allem darueber ueberschritten.
  // Ein `if (!target)` haette beide Zeilen als "kein Ziel" gelesen, und eine
  // Division durch 0 haette Infinity oder NaN in die Balkenbreite geschrieben.
  assert.deepEqual(nutrientProgress(0, 0), { hasTarget: true, ratio: 0, over: false });
  assert.deepEqual(nutrientProgress(3, 0), { hasTarget: true, ratio: 1, over: true });

  // Der gewoehnliche Fall, und die Klemmung an beiden Enden.
  assert.equal(nutrientProgress(50, 200).ratio, 0.25);
  assert.equal(nutrientProgress(250, 200).ratio, 1);
  assert.equal(nutrientProgress(250, 200).over, true);
  assert.equal(nutrientProgress(-5, 200).ratio, 0, 'ein negativer Wert darf den Balken nicht ruecklaeufig machen');
});

test('die Zeilen des Tabs werden wirklich gerendert und lassen einen nicht angegebenen Wert weg', async () => {
  // NIEMAND FAEHRT SIE SONST ALS PROGRAMM: die Zusicherungen darueber waren bis
  // hier Textguards gegen den Quelltext. Diese beiden Renderer sind rein genug,
  // um sie wirklich aufzurufen - ein Tippfehler in einem Schluessel oder eine
  // vertauschte Einheit faellt damit auf, statt bis in die Oberflaeche zu gehen.
  const { __test: health } = await import('../public/pages/health.js');

  const zeile = health.nutritionRowMarkup({
    id: 7, title: 'Linsensuppe <b>', consumed_at: '2026-06-01T12:30', meal_type: 'lunch',
    energy_kcal: 651, fat_g: null, saturated_fat_g: null, carbs_g: null,
    sugar_g: null, protein_g: 31.5, salt_g: null, fiber_g: null, note: null,
  }, true);

  assert.match(zeile, /data-entry-id="7"/);
  assert.match(zeile, /data-nutrition-edit="7"/, 'mit Schreibrecht muss der Bearbeiten-Knopf da sein');
  // User-Daten laufen durch esc() (CLAUDE.md-Invariante).
  assert.ok(!zeile.includes('<b>'), 'der Titel muss escaped sein');
  assert.match(zeile, /&lt;b&gt;/);

  // GEZAEHLT, NICHT NACH TEXT GESUCHT. Der erste Anlauf hier suchte nach der
  // Zeichenkette "0 g" - und war gruen, auch nachdem der Renderer jeden
  // nicht angegebenen Wert als 0 ausgab: unter dem Browser-Loader ist keine
  // Locale geladen, `t()` gibt den Schluessel zurueck, und die Einheit steht
  // als "health.nutrition.unit.g" da. Ein Test, der eine uebersetzte Zeichen-
  // kette sucht, misst hier also nichts.
  //
  // Die Anzahl der Chips misst es: eine Mahlzeitenart plus GENAU die zwei
  // angegebenen Werte. Waeren die sechs leeren dabei, stuenden neun da.
  const chips = zeile.match(/health-nutrition-row__chip/g) || [];
  assert.equal(chips.length, 3,
    `erwartet 3 Chips (Mahlzeit + die zwei angegebenen Werte), gefunden ${chips.length} - `
    + 'ein nicht angegebener Wert darf nicht als 0 erscheinen');
  assert.match(zeile, /nutrient\.energyKcal[^<]*651/, 'der angegebene Energiewert fehlt');
  assert.match(zeile, /nutrient\.protein[^<]*31[,.]5/, 'der angegebene Eiweisswert fehlt');
  for (const leer of ['fat', 'saturatedFat', 'carbs', 'sugar', 'salt', 'fiber']) {
    assert.ok(!zeile.includes(`nutrient.${leer}`),
      `der nicht angegebene Wert ${leer} darf gar nicht erst als Chip erscheinen`);
  }

  const ohneRecht = health.nutritionRowMarkup({
    id: 8, title: 'Apfel', consumed_at: '2026-06-01T16:00', meal_type: null,
    ...Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])), note: null,
  }, false);
  assert.ok(!ohneRecht.includes('data-nutrition-edit'), 'ohne Schreibrecht darf kein Bearbeiten-Knopf entstehen');

  // Und die Fortschrittszeile: mit Ziel ein Balken, ohne Ziel keiner.
  const mitZiel = health.nutritionProgressRowMarkup(
    { key: 'energy_kcal', labelKey: 'health.nutrition.nutrient.energyKcal', unitKey: 'health.nutrition.unit.kcal', step: 1 },
    { totals: { energy_kcal: 900 }, target: { energy_kcal: 1800 } },
  );
  assert.match(mitZiel, /--nutrition-scale:0\.5/, 'der Balken muss auf halbem Weg stehen');
  assert.match(mitZiel, /role="img"/, 'der Balken braucht einen zugaenglichen Namen');

  const ohneZiel = health.nutritionProgressRowMarkup(
    { key: 'fat_g', labelKey: 'health.nutrition.nutrient.fat', unitKey: 'health.nutrition.unit.g', step: 0.1 },
    { totals: { fat_g: 12 }, target: { fat_g: null } },
  );
  assert.ok(!ohneZiel.includes('nutrition-scale'), 'ohne Ziel darf kein Balken gezeichnet werden');
  assert.match(ohneZiel, /12/, 'der erreichte Wert steht auch ohne Ziel da');
});

test('nutrition steht in DEFAULT_HIDDEN_WIDGETS - sonst ist es nach dem Update ueberall an', async () => {
  const widgets = await import('../public/utils/dashboard-widgets.js');
  assert.ok(widgets.WIDGET_IDS.includes('nutrition'), 'die Id fehlt in WIDGET_IDS');
  assert.ok(widgets.DEFAULT_HIDDEN_WIDGETS.has('nutrition'),
    'eine Id, die hier fehlt, ist bei JEDEM Bestandshaushalt nach dem Update eingeblendet');
  assert.equal(widgets.defaultWidgetVisible('nutrition'), false);

  // Und die Probe an einem BESTANDSLAYOUT, das die Id noch nicht kennt: es
  // bekommt sie ausgeblendet dazu, nicht sichtbar.
  const altesLayout = widgets.DEFAULT_WIDGET_CONFIG
    .filter((w) => w.id !== 'nutrition')
    .map((w, i) => ({ ...w, order: i }));
  const merged = widgets.normalizeDashboardConfig(altesLayout);
  const eintrag = merged.find((w) => w.id === 'nutrition');
  assert.ok(eintrag, 'die neue Id muss in ein Bestandslayout einsortiert werden');
  assert.equal(eintrag.visible, false, 'sie muss AUSGEBLENDET ankommen');
});
