/**
 * Modul: Migrations-Runner - Toleranz gegen eine schon verbuchte Migration (#1331)
 * Zweck: Zwei Erststarts auf derselben frischen Datei bestimmen ihre Liste
 *        ausstehender Migrationen, bevor einer von beiden etwas geschrieben
 *        hat. Der Nachzuegler faehrt dieselbe Migration deshalb ein zweites
 *        Mal und starb daran - an der Buchung (`UNIQUE constraint failed:
 *        schema_migrations.version`) oder schon am DDL (`table ... already
 *        exists`). `migrate()` nimmt genau diesen einen Fall hin.
 *
 *        Gemessen wird ohne Rennen: der Zustand wird GESETZT. Eine zweite
 *        Verbindung auf dieselbe Datei ist fuer SQLite dasselbe wie ein
 *        zweiter Prozess - Sperren und Lese-Snapshots haengen an der
 *        Verbindung, nicht am Prozess -, und anders als ein zweiter Prozess
 *        laeuft sie an einer Stelle fertig, die dieser Test bestimmt.
 *
 *        Die Gegenrichtung ist die wichtigere Haelfte: ein echter Fehler in
 *        einer Migration muss weiter durchschlagen. Ohne sie waere die
 *        Toleranz ein stilles catch.
 * Ausfuehren: npm run test:migrate-tolerance
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

// DB_PATH steht als Env-Prefix am Script; db.js initialisiert beim Import.
// Der Runner wird hier trotzdem gegen EIGENE Datei-Datenbanken gefahren: das
// Rennen gibt es nur zwischen zwei Verbindungen auf einer Datei, und
// `:memory:` hat keine zweite.
const { migrate } = await import('../server/db.js');

const DIR = mkdtempSync(join(tmpdir(), 'yuvomi-migrate-tolerance-'));
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* egal */ } });

let counter = 0;
const freshFile = () => join(DIR, `race-${++counter}.db`);

/** Die Verbindung, die `migrate()` faehrt - wie in Produktion (WAL, FK an). */
function openMigrating(file) {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

/**
 * Die Verbindung des anderen Prozesses.
 *
 * Ohne `journal_mode`: das steht in der Datei und ist gesetzt, sobald die
 * erste Verbindung offen ist - ein zweites Setzen braucht eine Sperre, die
 * genau der Fall hier nicht hergeben soll.
 */
function openOther(file) {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  return database;
}

/**
 * Der andere Prozess wendet die Migration VOLLSTAENDIG an und committet:
 * Wirkung und Buchung in einer Transaktion, so wie `migrate()` es tut.
 */
function applyElsewhere(file, migration) {
  const other = openOther(file);
  try {
    other.transaction(() => {
      if (typeof migration.up === 'function') migration.up(other);
      else other.exec(migration.up);
      other.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
        .run(migration.version, migration.description);
    })();
  } finally {
    other.close();
  }
}

/** Kennzeichnet, was der ANDERE geschrieben hat - der eigene Lauf schreibt nie so. */
const FOREIGN = (migration) => ({ ...migration, description: `${migration.description} (anderer Prozess)` });

/**
 * Dieselbe Migration, aber der andere Prozess wird mittendrin fertig - und
 * zwar VOR dem ersten eigenen Schreiben dieser Transaktion. Die Transaktion
 * beginnt deferred, hat an dieser Stelle also weder Schreibsperre noch
 * Lese-Snapshot: der fremde Commit geht durch, und danach laeuft dieser Lauf
 * in genau die Kollision, die #1331 gemessen hat.
 */
function stolenFirst(file, migration) {
  return {
    ...migration,
    up(database) {
      applyElsewhere(file, FOREIGN(migration));
      if (typeof migration.up === 'function') migration.up(database);
      else database.exec(migration.up);
    },
  };
}

const ALPHA = { version: 1, description: 'alpha', up: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY, name TEXT NOT NULL)' };
const GAMMA = { version: 3, description: 'gamma', up: 'CREATE INDEX idx_beta_alpha ON beta(alpha_id)' };
const betaMigration = (idempotent) => ({
  version: 2,
  description: 'beta',
  up: `CREATE TABLE ${idempotent ? 'IF NOT EXISTS ' : ''}beta (id INTEGER PRIMARY KEY, alpha_id INTEGER REFERENCES alpha(id))`,
});

const versions = (database) => database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
const descriptionOf = (database, version) => database.prepare('SELECT description FROM schema_migrations WHERE version = ?').get(version)?.description;
const schemaOf = (database) => database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
const tables = (database) => schemaOf(database).filter((o) => o.type === 'table').map((o) => o.name);

// ---------------------------------------------------------------------------
// Der Kernfall: die Migration ist schon verbucht, der Lauf haelt sie fuer offen
// ---------------------------------------------------------------------------

test('idempotentes DDL: der Lauf stirbt nicht an der fremden Buchung, sondern faehrt durch', () => {
  const file = freshFile();
  const database = openMigrating(file);
  const beta = betaMigration(true);

  migrate(database, [ALPHA, stolenFirst(file, beta), GAMMA]);

  assert.deepEqual(versions(database), [1, 2, 3], 'alle drei Migrationen sind verbucht');
  // Der Beleg, dass die Kollision wirklich stattgefunden hat: die Buchung
  // stammt vom anderen Prozess, die eigene ist mit der Transaktion zurueck.
  assert.equal(descriptionOf(database, 2), 'beta (anderer Prozess)');
  assert.deepEqual(tables(database).sort(), ['alpha', 'beta', 'schema_migrations']);
  // Und die Migration DANACH ist gelaufen, nicht nur ueberlebt.
  assert.ok(schemaOf(database).some((o) => o.type === 'index' && o.name === 'idx_beta_alpha'));
});

test('nicht idempotentes DDL: `table ... already exists` ist derselbe Fall', () => {
  const file = freshFile();
  const database = openMigrating(file);
  const beta = betaMigration(false);

  migrate(database, [ALPHA, stolenFirst(file, beta), GAMMA]);

  assert.deepEqual(versions(database), [1, 2, 3]);
  assert.equal(descriptionOf(database, 2), 'beta (anderer Prozess)');
  assert.ok(schemaOf(database).some((o) => o.type === 'index' && o.name === 'idx_beta_alpha'));
});

test('der tolerierte Lauf endet mit demselben Schema wie ein ungestoerter', () => {
  const stolenPath = freshFile();
  const stolen = openMigrating(stolenPath);
  migrate(stolen, [ALPHA, stolenFirst(stolenPath, betaMigration(false)), GAMMA]);

  const cleanPath = freshFile();
  const clean = openMigrating(cleanPath);
  migrate(clean, [ALPHA, betaMigration(false), GAMMA]);

  assert.deepEqual(schemaOf(stolen), schemaOf(clean));
  assert.deepEqual(versions(stolen), versions(clean));
});

// ---------------------------------------------------------------------------
// Die Gegenrichtung: ein echter Fehler schlaegt weiter durch
// ---------------------------------------------------------------------------

const REAL_FAILURES = [
  {
    name: 'Syntaxfehler im Migrations-SQL',
    migration: { version: 2, description: 'kaputt', up: 'CREATE TABL kaputt (id INTEGER)' },
    // Denselben Code traegt `table ... already exists` (gemessen) - deshalb
    // entscheidet der Code allein nichts, und der Meldungstext erst recht nicht.
    code: 'SQLITE_ERROR',
    message: /syntax error/,
  },
  {
    name: 'Tabelle existiert schon, aber NIEMAND hat die Version verbucht',
    migration: { version: 2, description: 'doppelt', up: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY)' },
    code: 'SQLITE_ERROR',
    message: /table alpha already exists/,
  },
  {
    name: 'PRIMARY-KEY-Konflikt aus der Migration selbst',
    migration: {
      version: 2,
      description: 'eigener Konflikt',
      up: `INSERT INTO alpha (id, name) VALUES (1, 'a');
           INSERT INTO alpha (id, name) VALUES (1, 'b');`,
    },
    // Derselbe Code wie bei der doppelten Buchung - und trotzdem ein Fehler,
    // weil niemand diese Version verbucht hat.
    code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    message: /UNIQUE constraint failed: alpha\.id/,
  },
  {
    name: 'Fremdschluessel-Verletzung, die der Runner selbst findet',
    migration: {
      version: 2,
      description: 'fk',
      foreignKeysOff: true,
      up: `CREATE TABLE child (id INTEGER PRIMARY KEY, alpha_id INTEGER NOT NULL REFERENCES alpha(id));
           INSERT INTO child (id, alpha_id) VALUES (1, 999);`,
    },
    code: undefined,
    message: /left 1 foreign key violation/,
  },
  {
    name: 'Programmfehler im up()-Hook',
    // Absicht: der Aufruf gibt es nicht. Ein Tippfehler in einem up()-Hook ist
    // ein Programmfehler und darf nie als "war schon verbucht" durchgehen.
    migration: { version: 2, description: 'tippfehler', up() { gibtEsNicht(); } },
    code: undefined,
    message: /gibtEsNicht is not defined/,
  },
];

for (const failure of REAL_FAILURES) {
  test(`stirbt weiter: ${failure.name}`, () => {
    const database = openMigrating(freshFile());

    assert.throws(
      () => migrate(database, [ALPHA, failure.migration, GAMMA]),
      (err) => {
        assert.equal(err.code, failure.code);
        assert.match(err.message, failure.message);
        return true;
      },
    );

    // Nichts verbucht, was nicht lief - und der Lauf ist wirklich stehen
    // geblieben, statt mit der naechsten Migration weiterzumachen.
    assert.deepEqual(versions(database), [1]);
    assert.ok(!schemaOf(database).some((o) => o.name === 'idx_beta_alpha'));
    // Die Fremdschluessel-Durchsetzung steht danach wieder, auch im Fehlerfall.
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  });
}

// ---------------------------------------------------------------------------
// SQLITE_BUSY ist ein Warten, kein Erfolg
// ---------------------------------------------------------------------------

test('SQLITE_BUSY bleibt ein Fehler, auch wenn der andere Prozess die Version schon traegt', () => {
  const file = freshFile();
  const database = openMigrating(file);
  const beta = betaMigration(false);

  const readsBeforeTheOtherCommits = {
    ...beta,
    up(handle) {
      // Erst LESEN: damit steht der Lese-Snapshot dieser Transaktion fest,
      // bevor der andere Prozess committet. Das eigene Schreiben danach kommt
      // dann gar nicht mehr an die Sperre - SQLite antwortet SOFORT mit
      // SQLITE_BUSY_SNAPSHOT, ein busy_timeout wartet darauf nicht (gemessen:
      // 0 ms bei 5000 ms Vorgabe des Treibers).
      handle.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get();
      applyElsewhere(file, FOREIGN(beta));
      handle.exec(beta.up);
    },
  };

  assert.throws(
    () => migrate(database, [ALPHA, readsBeforeTheOtherCommits, GAMMA]),
    (err) => err.code?.startsWith('SQLITE_BUSY') === true,
  );

  // Der heikle Teil dieses Falls: die Version STEHT da. Wer allein danach
  // urteilt, verbucht ein Warten als Erfolg - der Lauf war aber nicht dran.
  assert.equal(descriptionOf(database, 2), 'beta (anderer Prozess)');
  assert.ok(!schemaOf(database).some((o) => o.name === 'idx_beta_alpha'));
});
