/**
 * Test: Wem gehoert die Farbe eines Termins (#891, #899)
 * Zweck: Migration 166 baut calendar_events neu auf, um `color` nullable zu
 *        machen - der riskanteste Eingriff dieser Aenderung, weil vier Tabellen
 *        auf die Tabelle zeigen und zwei davon mit ON DELETE CASCADE. Diese
 *        Suite weist an einer befuellten Bestands-DB nach, dass der Rebuild
 *        nichts mitnimmt, und haelt danach die zweite Haelfte fest: dass die
 *        Importpfade die GEERBTE Kalenderfarbe nicht mehr in die Eigenfarb-
 *        Spalte schreiben und der Lesepfad sie trotzdem liefert.
 *
 *        Sie ist die Gegenprobe zu `test:calendar`: der Rangfolge-Test dort war
 *        bis v2.48.0 gruen ueber totem Code, weil ein Termin aus der Datenbank
 *        die unteren Zweige nie erreichen konnte (#856). Ohne diese Suite waere
 *        er es wieder, sobald ein Importpfad seinen Fallback zurueckbekommt.
 *
 *        Seit #899 dazu die Frage, die daran haengt: WEM gehoert die Farbe? Der
 *        Inbound gattert sie, und er tat es an `user_modified` - einem Flag, das
 *        JEDE Bearbeitung setzt. Eine Titelaenderung fror die Farbspalte damit
 *        dauerhaft ein, und weil "keine Farbe" nicht von "nie eine gelernt" zu
 *        unterscheiden war, konnte der Ausgang ein Leeren nicht spiegeln.
 *        Migration 167 gibt der Farbe ihren eigenen Zustand; die Regel-Guards
 *        unten halten fest, dass alle drei Anbieter ihn benutzen.
 * Ausfuehren: node --test test/test-calendar-inherited-color.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'yuvomi-colmig-')), 'unused.db');
const { MIGRATIONS } = await import('../server/db.js');

const NULLABLE_COLOR_VERSION  = 166;
const COLOR_MODIFIED_VERSION  = 167;

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  migration.afterUp?.(db);
}

/**
 * Die Migration laufen lassen, wie `migrate()` es tut - inklusive der
 * Fremdschluessel-Abschaltung, die sie per `foreignKeysOff` anfordert. Ohne sie
 * misst der Test etwas anderes als die Produktion.
 */
function applyWithMigrateSemantics(db, migration) {
  if (!migration.foreignKeysOff) return applyMigration(db, migration);
  db.pragma('foreign_keys = OFF');
  try {
    applyMigration(db, migration);
    const violations = db.pragma('foreign_key_check');
    assert.deepEqual(violations, [], 'die Migration darf keine Fremdschluessel verletzen');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Echte Migrationskette bis kurz vor `version` - der Stand, den ein
 * Bestandsnutzer mitbringt, wenn genau diese Migration ansteht.
 */
function buildDatabaseBefore(version = NULLABLE_COLOR_VERSION) {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-colmig-')), 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS.filter((m) => m.version < version)) {
    applyMigration(db, migration);
  }
  return db;
}

/**
 * Genau das, was ein Rebuild verlieren kann: die zwei CASCADE-Kinder
 * (event_assignments, calendar_event_exceptions) und die zwei SET-NULL-Nachbarn
 * (birthdays, housekeeping_work_sessions).
 */
function seed(db) {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1,'admin','Admin','x','admin')").run();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (2,'maria','Maria','x','member')").run();

  const calRef = db.prepare(
    "INSERT INTO external_calendars (source, external_id, name, color) VALUES ('caldav','fam','Familie','#34A853') RETURNING id"
  ).get().id;

  const insert = db.prepare(`
    INSERT INTO calendar_events
      (title, start_datetime, end_datetime, color, external_source, external_calendar_id,
       calendar_ref_id, recurrence_rule, user_modified, icon, visibility, countdown, created_by)
    VALUES (@title, @start_datetime, @end_datetime, @color, @external_source, @external_calendar_id,
       @calendar_ref_id, @recurrence_rule, @user_modified, @icon, @visibility, @countdown, 1)
  `);

  const rows = [
    { title: 'Elternabend', start_datetime: '2026-09-01T19:00', end_datetime: '2026-09-01T21:00',
      color: '#8156C0', external_source: 'local', external_calendar_id: null, calendar_ref_id: null,
      recurrence_rule: 'FREQ=MONTHLY', user_modified: 0, icon: 'calendar', visibility: 'all', countdown: 1 },
    { title: 'Zahnarzt', start_datetime: '2026-09-05T08:30', end_datetime: '2026-09-05T09:15',
      color: '#34A853', external_source: 'caldav', external_calendar_id: 'uid-1', calendar_ref_id: calRef,
      recurrence_rule: null, user_modified: 1, icon: 'tooth', visibility: 'assignees', countdown: 0 },
    { title: 'Geburtstag Maria', start_datetime: '2026-05-04', end_datetime: null,
      color: '#007AFF', external_source: 'local', external_calendar_id: null, calendar_ref_id: null,
      recurrence_rule: 'FREQ=YEARLY', user_modified: 0, icon: 'cake', visibility: 'all', countdown: 0 },
  ];
  const ids = rows.map((r) => insert.run(r).lastInsertRowid);

  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 2)').run(ids[0]);
  db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1)').run(ids[0]);
  db.prepare("INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, '2026-10-01')").run(ids[0]);
  db.prepare("INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES ('Maria','1990-05-04',?,1)").run(ids[2]);

  return { ids, calRef };
}

function snapshot(db) {
  return db.prepare('SELECT * FROM calendar_events ORDER BY id').all();
}

// --------------------------------------------------------
// Der Rebuild
// --------------------------------------------------------

test('Migration 166 nimmt beim Rebuild keine abhaengige Zeile mit', () => {
  const db = buildDatabaseBefore();
  const seeded = seed(db);
  const before = snapshot(db);
  assert.equal(before.length, 3);

  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === NULLABLE_COLOR_VERSION));

  const after = snapshot(db);
  assert.equal(after.length, 3, 'keine Zeile darf verschwinden');
  for (const [i, row] of after.entries()) {
    for (const [key, value] of Object.entries(before[i])) {
      assert.deepEqual(row[key], value, `Feld ${key} von Termin ${row.id} hat sich geaendert`);
    }
  }

  // Die zwei CASCADE-Kinder. Bei einem DROP TABLE mit aktiver Durchsetzung waeren
  // sie das erste Opfer, und zwar lautlos: die Termine stuenden noch da, nur ohne
  // Zuweisung und ohne ihre geloeschten Serien-Vorkommen.
  assert.deepEqual(
    db.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id').all(seeded.ids[0]),
    [{ user_id: 1 }, { user_id: 2 }],
    'die Zuweisungen muessen den Rebuild ueberleben'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM calendar_event_exceptions WHERE event_id = ?').get(seeded.ids[0]).n,
    1,
    'die EXDATE-Ausnahme muss den Rebuild ueberleben'
  );
  // Der SET-NULL-Nachbar: hier waere der Schaden leiser - der Geburtstag bliebe,
  // nur seine Verbindung zum Termin waere weg.
  assert.equal(
    db.prepare('SELECT calendar_event_id FROM birthdays WHERE name = ?').get('Maria').calendar_event_id,
    seeded.ids[2],
    'die Geburtstags-Verknuepfung muss stehen bleiben'
  );

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'die Durchsetzung ist danach wieder an');
});

test('Migration 166 stellt Trigger und Indizes vollstaendig wieder her', () => {
  const db = buildDatabaseBefore();
  const objectsOf = () => db.prepare(
    "SELECT type, name FROM sqlite_master WHERE tbl_name='calendar_events' AND type IN ('index','trigger') ORDER BY type, name"
  ).all().filter((o) => !o.name.startsWith('sqlite_autoindex'));

  const before = objectsOf();
  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === NULLABLE_COLOR_VERSION));
  assert.deepEqual(objectsOf(), before,
    'ein Rebuild nimmt Trigger und Indizes mit - jeder einzelne muss neu angelegt werden');

  // Der Suchindex haengt an drei dieser Trigger und ist der Grund, warum das
  // zaehlt: faellt trg_search_events_au weg, findet die Suche einen umbenannten
  // Termin weiterhin unter seinem alten Titel, und nichts sagt es.
  assert.equal(before.filter((o) => o.type === 'trigger').length, 4,
    'vier Trigger: updated_at plus die drei des Suchindex');
});

test('Migration 166 macht color nullable, ohne einen Bestandswert anzufassen', () => {
  const db = buildDatabaseBefore();
  seed(db);
  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === NULLABLE_COLOR_VERSION));

  const col = db.prepare('PRAGMA table_info(calendar_events)').all().find((c) => c.name === 'color');
  assert.equal(col.notnull, 0, 'die Spalte muss NULL annehmen');
  assert.equal(col.dflt_value, null, 'und keinen Default mehr aufdraengen');

  // BESTANDSDATEN BLEIBEN. '#007AFF' sieht aus wie "nie gewaehlt" - der Wert
  // steht in keiner heutigen Palette. Er stand aber bis zum OKLCH-Wechsel an
  // erster Stelle von EVENT_COLORS, ein Termin aus der v1-Zeit kann ihn also
  // bewusst tragen. Wer ihn hier auf NULL setzt, wirft eine Wahl weg, die er
  // nicht von einem Default unterscheiden kann.
  const farben = db.prepare('SELECT color FROM calendar_events ORDER BY id').all().map((r) => r.color);
  assert.deepEqual(farben, ['#8156C0', '#34A853', '#007AFF'],
    'die Migration darf keine bestehende Farbe loeschen, auch nicht die, die nach einem Default aussieht');

  // Und der neue Zustand ist wirklich schreibbar.
  db.prepare('UPDATE calendar_events SET color = NULL WHERE id = 1').run();
  assert.equal(db.prepare('SELECT color FROM calendar_events WHERE id = 1').get().color, null);
});

test('Migration 166 uebersteht eine DB, der die tzid-Spalte fehlt (#549)', () => {
  // Der Rebuild liest eine feste Spaltenliste. `tzid` steht in CRITICAL_COLUMNS,
  // weil es DBs gibt, auf denen Migration 97 als angewendet GILT, die Spalte aber
  // fehlt - und `reconcileCriticalSchema()` repariert das erst NACH `migrate()`.
  // Ohne die Absicherung in der Migration braeche das Update genau dieser
  // Bestandsinstallationen mit "no such column: tzid".
  const db = buildDatabaseBefore();
  seed(db);

  // Den Schaden nachbauen: Spalte weg, Migration 97 weiterhin als angewendet.
  // (Der Rebuild hier ist der ehrlichste Weg - SQLite kann keine Spalte droppen,
  // und genau darum ging es bei #549 auch in der Produktion.)
  db.pragma('foreign_keys = OFF');
  const spalten = db.prepare('PRAGMA table_info(calendar_events)').all()
    .map((c) => c.name).filter((n) => n !== 'tzid');
  const liste = spalten.join(', ');
  db.exec(`CREATE TABLE ce_ohne_tzid AS SELECT ${liste} FROM calendar_events`);
  db.exec('DROP TABLE calendar_events');
  db.exec('ALTER TABLE ce_ohne_tzid RENAME TO calendar_events');
  db.pragma('foreign_keys = ON');
  assert.ok(
    !db.prepare('PRAGMA table_info(calendar_events)').all().some((c) => c.name === 'tzid'),
    'die Vorbedingung muss stimmen, sonst prueft dieser Test nichts'
  );

  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === NULLABLE_COLOR_VERSION));

  const nachher = db.prepare('PRAGMA table_info(calendar_events)').all();
  assert.ok(nachher.some((c) => c.name === 'tzid'), 'die Migration muss die fehlende Spalte nachtragen');
  assert.equal(nachher.find((c) => c.name === 'color').notnull, 0, 'und ihre eigentliche Arbeit trotzdem tun');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 3, 'ohne Zeilen zu verlieren');
});

test('der Test-Schema-Auszug haelt die Spalte ebenfalls nullable', async () => {
  // `server/db-schema-test.js` ist ein handgeschriebener AUSZUG, aus dem viele
  // Suiten ihre Datenbank bauen statt die ganze Migrationskette zu fahren. Er
  // driftet still: haelt er `color` weiter NOT NULL, laufen genau die Suiten
  // gruen darueber, die den neuen Zustand pruefen wollten - ihre Fixtures
  // koennen ihn gar nicht herstellen. Dieselbe Datei lag schon einmal sieben
  // Eintraege daneben, und `test:schema-mirror` faellt das nicht auf: der Guard
  // prueft die Zuordnung der Migrationsnummern, nicht die Spaltendefinitionen.
  const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');

  for (const key of [1, 11]) {
    const sql = MIGRATIONS_SQL[key];
    if (!sql || !/CREATE TABLE[^;]*calendar_events/.test(sql)) continue;
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-auszug-')), 'db.sqlite'));
    // Jeder Eintrag ist fuer sich lesbar, seine Nachbartabellen fehlen aber - die
    // Suiten fahren jeweils die, die sie brauchen. Geprueft wird hier die
    // Spalte, nicht die Verweisintegritaet, deshalb ohne Fremdschluessel.
    db.pragma('foreign_keys = OFF');
    db.exec(sql);
    const col = db.prepare('PRAGMA table_info(calendar_events)').all().find((c) => c.name === 'color');
    assert.equal(col.notnull, 0, `MIGRATIONS_SQL[${key}]: color muss NULL annehmen wie in Produktion`);

    // Und es wirklich koennen - eine Spaltendefinition ist eine Behauptung,
    // ein INSERT ist der Beleg.
    db.prepare(`INSERT INTO calendar_events (title, start_datetime, color, created_by)
                VALUES ('Farblos', '2040-01-01T09:00', NULL, 1)`).run();
    assert.equal(db.prepare('SELECT color FROM calendar_events').get().color, null);
    db.close();
  }
});

// --------------------------------------------------------
// Die Farbe bekommt einen eigenen Zustand (Migration 167, #899)
// --------------------------------------------------------

test('Migration 167 uebernimmt den bisherigen Schutz Zeile fuer Zeile', () => {
  const db = buildDatabaseBefore(COLOR_MODIFIED_VERSION);
  seed(db);

  const vorher = db.prepare('SELECT user_modified FROM calendar_events ORDER BY id').all()
    .map((r) => r.user_modified);
  // VORBEDINGUNG. Waeren alle drei Zeilen gleich, sagte der Vergleich unten
  // nichts: `color_modified = 0` waere dann von `color_modified = user_modified`
  // nicht zu unterscheiden.
  assert.ok(new Set(vorher).size > 1, `der Bestand muss beide Faelle tragen: ${vorher.join()}`);

  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === COLOR_MODIFIED_VERSION));

  const nachher = db.prepare('SELECT user_modified, color_modified FROM calendar_events ORDER BY id').all();
  assert.deepEqual(nachher.map((r) => r.color_modified), vorher,
    'der Backfill ist konservativ: was heute geschuetzt ist, bleibt geschuetzt');
  assert.deepEqual(nachher.map((r) => r.user_modified), vorher,
    'und user_modified behaelt seine eigene Bedeutung');

  const spalte = db.prepare('PRAGMA table_info(calendar_events)').all()
    .find((c) => c.name === 'color_modified');
  assert.equal(spalte.notnull, 1, 'das Flag ist nie unbekannt');
  assert.equal(spalte.dflt_value, '0', 'ein neuer Termin faengt ohne eigene Farbwahl an');
});

test('Migration 167 laesst einen neuen Termin bei 0 anfangen', () => {
  // Die Gegenprobe zum Backfill: er darf nicht als Default durchschlagen, sonst
  // waere jeder frisch importierte Termin gegen die Farbe seines Anbieters
  // gesperrt - genau der Zustand, den #899 aufloest.
  const db = buildDatabaseBefore(COLOR_MODIFIED_VERSION);
  seed(db);
  db.prepare("UPDATE calendar_events SET user_modified = 1").run();
  applyWithMigrateSemantics(db, MIGRATIONS.find((m) => m.version === COLOR_MODIFIED_VERSION));

  db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
              VALUES ('Frisch importiert', '2040-01-01T09:00', 1)`).run();
  const neu = db.prepare("SELECT color_modified FROM calendar_events WHERE title = 'Frisch importiert'").get();
  assert.equal(neu.color_modified, 0);
});

test('der Test-Schema-Auszug kennt den Zustand ebenfalls', async () => {
  // Dieselbe Falle wie bei der nullable Farbe darueber: fehlt die Spalte im
  // Auszug, stirbt jede Suite, die einen Sync-Upsert faehrt, an `no such
  // column` - und zwar an einer Stelle, die mit ihrem Pruefzweck nichts zu tun
  // hat. Der Beleg ist deshalb ein INSERT, keine Spaltendefinition.
  const { MIGRATIONS_SQL } = await import('../server/db-schema-test.js');
  const sql = MIGRATIONS_SQL[11];
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'yuvomi-auszug-')), 'db.sqlite'));
  db.pragma('foreign_keys = OFF');
  db.exec(sql);
  db.prepare(`INSERT INTO calendar_events (title, start_datetime, created_by)
              VALUES ('Farblos', '2040-01-01T09:00', 1)`).run();
  assert.equal(db.prepare('SELECT color_modified FROM calendar_events').get().color_modified, 0);
  db.close();
});

// --------------------------------------------------------
// Wer das Gatter bedient (#899)
// --------------------------------------------------------

/**
 * Quelltext ohne Kommentare. Ein Guard, der im Rohtext sucht, liest einen
 * Kommentar als Regel - und die Kommentare an genau diesen Stellen ERKLAEREN
 * den alten Zustand, nennen also `user_modified` mit voller Absicht.
 */
function ohneKommentare(quelle) {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((zeile) => !/^\s*(\/\/|--)/.test(zeile))
    .join('\n');
}

const SYNC_DIENSTE = [
  'server/services/caldav-sync.js',
  'server/services/apple-calendar.js',
  'server/services/google-calendar.js',
];

test('jedes Farb-Gatter des Inbound haengt an color_modified (#899)', async () => {
  // Eine Regel statt einer Allowlist, aus demselben Grund wie beim Fallback
  // darunter: die Stelle sieht in allen drei Diensten gleich aus. Gefunden wird
  // der Ausdruck selbst, nicht seine Datei - der vierte Anbieter faellt damit
  // automatisch unter die Regel.
  const { readFile } = await import('node:fs/promises');
  const GATTER_RE = /CASE\s+WHEN\s+(\w+)\s*=\s*0\s+THEN\s+\?\s+ELSE\s+color\s+END/g;

  let gefunden = 0;
  const falsch = [];
  for (const datei of SYNC_DIENSTE) {
    const quelle = ohneKommentare(await readFile(new URL(`../${datei}`, import.meta.url), 'utf8'));
    for (const treffer of quelle.matchAll(GATTER_RE)) {
      gefunden++;
      if (treffer[1] !== 'color_modified') falsch.push(`${datei}: ${treffer[0]}`);
    }
  }

  // VORBEDINGUNG: findet das Muster nichts, ist die Zusicherung darunter leer.
  // Genau so waere sie gruen geblieben, als das Gatter noch falsch war.
  assert.ok(gefunden >= 5, `nur ${gefunden} Farb-Gatter gefunden - stimmt das Muster noch?`);
  assert.deepEqual(falsch, [],
    'user_modified wird bei JEDER Bearbeitung gesetzt; ein Titel-Edit fror die Farbe damit ein (#899)');
});

test('der Upload merkt sich, dass die hinausgeschickte Farbe unsere ist (#899)', async () => {
  // Der dritte Befund aus #899: beide Abbildungen sind verlustbehaftet (CSS3-
  // Name bzw. eine von elf colorIds). Ohne das Flag holt der naechste
  // Inbound-Lauf den gerundeten Wert zurueck und ersetzt die gewaehlte Farbe.
  //
  // Die Regel haengt an der Stelle, an der ein LOKALER Termin zu einem
  // gespiegelten wird - das ist genau der Moment, in dem die Farbe erstmals
  // hinausgeht, und er ist in jedem Dienst als `external_source = '<anbieter>'`
  // in einer UPDATE-SET-Liste erkennbar.
  const { readFile } = await import('node:fs/promises');
  const UPDATE_RE = /UPDATE calendar_events\s+SET([\s\S]*?)WHERE/g;

  let gefunden = 0;
  const ohneFlag = [];
  for (const datei of SYNC_DIENSTE) {
    const quelle = ohneKommentare(await readFile(new URL(`../${datei}`, import.meta.url), 'utf8'));
    for (const treffer of quelle.matchAll(UPDATE_RE)) {
      const setListe = treffer[1];
      if (!/external_source\s*=\s*'(caldav|apple|google)'/.test(setListe)) continue;
      gefunden++;
      if (!/color_modified/.test(setListe)) ohneFlag.push(datei);
    }
  }

  assert.equal(gefunden, 3, `drei Anbieter, drei Upload-Stellen - gefunden: ${gefunden}`);
  assert.deepEqual(ohneFlag, [],
    'der Upload muss color_modified setzen, sonst verliert der Termin seine exakte Farbe an die gemappte');
});

// --------------------------------------------------------
// Die Importpfade
// --------------------------------------------------------

test('kein Importpfad schreibt die geerbte Kalenderfarbe in die Eigenfarb-Spalte', async () => {
  // Eine Regel statt einer Allowlist: die Stelle sieht in allen vier Diensten
  // gleich aus, und der fuenfte Provider wuerde sie nachbauen. Der Test liest
  // deshalb die Dateien und verbietet das Muster, statt vier Faelle zu zaehlen.
  const { readFile } = await import('node:fs/promises');
  const DIENSTE = [
    'server/services/caldav-sync.js',
    'server/services/apple-calendar.js',
    'server/services/google-calendar.js',
    'server/services/ics-subscription.js',
  ];
  // `x.color || <irgendein Kalender-/Abo-Farbwert>` - genau die Form, die die
  // geerbte Farbe zur Eigenfarbe macht.
  const FALLBACK_RE = /\.color\s*\|\|\s*[A-Za-z_$][\w$.]*(?:[Cc]olor|COLOR)/g;

  for (const datei of DIENSTE) {
    const quelle = await readFile(new URL(`../${datei}`, import.meta.url), 'utf8');
    const treffer = [...quelle.matchAll(FALLBACK_RE)].map((m) => m[0]);
    // `importToLocal` ist die eine begruendete Ausnahme: dort werden aus
    // Abo-Terminen LOKALE Termine ohne Quelle, sie haben danach keinen Kalender
    // mehr, von dem sie erben koennten - und der Wert ist der, den der Nutzer
    // fuer genau diesen Import angegeben hat.
    const echte = treffer.filter((t) => !/fallbackColor/.test(t));
    assert.deepEqual(echte, [],
      `${datei}: die geerbte Farbe gehoert nicht in calendar_events.color (#891), gefunden: ${echte.join(', ')}`);
  }
});

test('der Lesepfad speist cal_color aus beiden Toepfen', async () => {
  // ICS-Abos haben keinen external_calendars-Eintrag - ihre geerbte Farbe steht
  // in ics_subscriptions. Wer beim Umbau nur den einen Join sieht, nimmt den
  // Abo-Terminen ihre Farbe ganz weg statt sie nur umzuhaengen.
  const { readFile } = await import('node:fs/promises');
  const LESEPFADE = [
    'server/routes/calendar/read.js',
    'server/routes/calendar/crud.js',
    'server/services/calendar-event-reader.js',
  ];
  for (const datei of LESEPFADE) {
    const quelle = await readFile(new URL(`../${datei}`, import.meta.url), 'utf8');
    const anzahl = (quelle.match(/AS cal_color/g) || []).length;
    assert.ok(anzahl > 0, `${datei}: liefert kein cal_color`);
    assert.equal((quelle.match(/COALESCE\(ec\.color,\s*isub\.color\) AS cal_color/g) || []).length, anzahl,
      `${datei}: jedes cal_color muss beide Quellen lesen, sonst verlieren Abo-Termine ihre Farbe`);
    assert.ok(/LEFT JOIN ics_subscriptions isub ON isub\.id = e\.subscription_id/.test(quelle),
      `${datei}: der Join auf ics_subscriptions fehlt`);
  }
});
