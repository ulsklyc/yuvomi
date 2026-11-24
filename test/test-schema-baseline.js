/**
 * Test: Schema-Baseline (Phase 2, Abschnitt F4)
 *
 * Eine frische Datenbank beginnt mit server/migrations/baseline.sql statt mit
 * allen Migrationen einzeln (server/db/baseline.ts, server/db/migrate.ts). Das
 * ist nur zulaessig, wenn beides DASSELBE ergibt. Diese Suite haelt:
 *
 *   1. Die Dateien sind, was der Erzeuger aus den Migrationen 1 bis N schreibt
 *      (Byte fuer Byte) - niemand hat sie von Hand angefasst, und keine
 *      "eingefrorene" Migration hat ihre Wirkung geaendert.
 *   2. Baseline + Migrationen ueber N == alle Migrationen von Null: derselbe
 *      Schema-Fingerabdruck (Objekte und Trigger in Entstehungsfolge) und
 *      dieselben Zeilen in allen Tabellen - auf dem Cipher-Treiber und auf
 *      node:sqlite. Auf node:sqlite laeuft das Skript dabei Anweisung fuer
 *      Anweisung, ohne Transaktion, mit eingeschalteten Fremdschluesseln.
 *   3. Der Vergleich ist nicht blind: eine Baseline ohne eine Spalte, ohne
 *      einen Index, ohne eine Vorgabezeile, mit vertauschten Triggern faellt auf.
 *   4. migrate() nimmt die Baseline genau auf einer leeren Datenbank mit der
 *      ausgelieferten Migrationsliste, und nie ihren Ersatzweg.
 *   5. Ist die Baseline unbrauchbar oder war ein anderer Prozess schneller,
 *      endet der Start trotzdem im selben Zustand.
 *
 * Ausfuehren: npm run test:schema-baseline
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { tempDir } from './tmp-dir.js';
import Database from '../server/utils/sqlite-driver.js';
import { migrate, MIGRATION_BUSY_ATTEMPTS } from '../server/db/migrate.ts';
import { MIGRATIONS } from '../server/migrations/index.ts';
import { applyBaseline, isPristine, loadBaseline, schemaFingerprint, schemaObjects } from '../server/db/baseline.ts';
import { baselineJson, buildBaseline, tableRows } from '../scripts/lib/schema-baseline.ts';

const STARTED = Date.now();
const SQL_FILE = new URL('../server/migrations/baseline.sql', import.meta.url);
const JSON_FILE = new URL('../server/migrations/baseline.json', import.meta.url);
const shipped = loadBaseline();

/**
 * @typedef {import('../server/db/baseline.ts').Baseline} Baseline
 * @typedef {import('../server/db/baseline.ts').BaselineDatabase & { close(): void }} AnyDatabase
 * @typedef {import('../server/db/handle.ts').SqliteDatabase} CipherDatabase
 * @typedef {{ schema: ReturnType<typeof schemaObjects>, rows: Record<string, unknown[]> }} State
 * @typedef {(typeof MIGRATIONS)[number] & { afterUp?: Function, foreignKeysOff?: boolean }} Migration
 */

/**
 * Schema und Zeilen einer Datenbank, vergleichbar zwischen zwei Laeufen dieser Suite.
 * @param {AnyDatabase} database @returns {State}
 */
function stateOf(database) {
  return { schema: schemaObjects(database), rows: tableRows(database, { from: STARTED, to: Date.now() }) };
}

/** @param {State} actual @param {State} expected */
function assertSameState(actual, expected) {
  assert.deepEqual(actual.schema.triggers.map((t) => t.name), expected.schema.triggers.map((t) => t.name), 'Trigger in derselben Entstehungsfolge');
  assert.deepEqual(actual.schema, expected.schema, 'dasselbe Schema');
  assert.deepEqual(Object.keys(actual.rows), Object.keys(expected.rows), 'dieselben Tabellen');
  for (const table of Object.keys(expected.rows)) {
    assert.deepEqual(actual.rows[table], expected.rows[table], `dieselben Zeilen in ${table}`);
  }
}

/** @param {string} [file] @returns {CipherDatabase} */
function cipher(file = ':memory:') {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  return database;
}

/**
 * Migrationen auf node:sqlite fahren. DatabaseSync hat weder `transaction()`
 * noch `pragma()`, die migrate() braucht; hier laeuft deshalb jede Migration
 * Anweisung fuer Anweisung ohne Transaktion, sonst wie in migrate(): `up`,
 * `afterUp`, bei `foreignKeysOff` die Fremdschluessel aus und danach wieder an
 * mit Pruefung, dann die Buchung.
 * @param {DatabaseSync} database @param {Migration[]} migrations
 */
function migrateOnNodeSqlite(database, migrations) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (migration.foreignKeysOff) database.exec('PRAGMA foreign_keys = OFF');
    if (typeof migration.up === 'function') migration.up(/** @type {any} */ (database));
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    if (migration.foreignKeysOff) {
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], `Migration ${migration.version}`);
      database.exec('PRAGMA foreign_keys = ON');
    }
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description);
  }
}

/**
 * Je Treiber: alle Migrationen von Null, und eine Baseline samt den Migrationen
 * darueber. Auf dem Cipher-Treiber geht beides durch migrate().
 * @type {{ name: string, replayFromZero: () => AnyDatabase, fromBaseline: (baseline: Baseline) => AnyDatabase }[]}
 */
const DRIVERS = [
  {
    name: 'Cipher-Treiber',
    replayFromZero() {
      const database = cipher();
      assert.deepEqual(migrate(database, MIGRATIONS, null), { baseline: null });
      return database;
    },
    fromBaseline(baseline) {
      const database = cipher();
      assert.deepEqual(migrate(database, MIGRATIONS, () => baseline), { baseline: baseline.version });
      return database;
    },
  },
  {
    name: 'node:sqlite',
    replayFromZero() {
      const database = new DatabaseSync(':memory:');
      migrateOnNodeSqlite(database, MIGRATIONS);
      return database;
    },
    fromBaseline(baseline) {
      const database = new DatabaseSync(':memory:');
      assert.equal(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1, 'Fremdschluessel sind an');
      applyBaseline(database, baseline);
      migrateOnNodeSqlite(database, MIGRATIONS);
      return database;
    },
  },
];
const [CIPHER] = DRIVERS;

/**
 * Genau ein Vorkommen ersetzen; ein Mutant, der nichts trifft, belegt nichts.
 * @param {string} sql @param {string} find @param {string} replacement
 */
function mutate(sql, find, replacement) {
  const hits = sql.split(find).length - 1;
  assert.equal(hits, 1, `genau ein Treffer fuer ${JSON.stringify(find.slice(0, 60))}, gefunden ${hits}`);
  return sql.replace(find, () => replacement);
}

test('die Dateien sind, was der Erzeuger aus den Migrationen 1 bis N schreibt', () => {
  assert.ok(MIGRATIONS.some((m) => m.version === shipped.version), `Migration ${shipped.version} gibt es`);
  const built = buildBaseline(shipped.version);
  assert.equal(readFileSync(JSON_FILE, 'utf8'), baselineJson(built), 'baseline.json (node scripts/build-schema-baseline.ts --check)');
  assert.ok(readFileSync(SQL_FILE, 'utf8') === built.sql, 'baseline.sql weicht vom Erzeuger ab (node scripts/build-schema-baseline.ts --check)');
});

test('zweimal erzeugt ergibt zweimal dasselbe', () => {
  assert.deepEqual(buildBaseline(shipped.version), buildBaseline(shipped.version));
});

for (const driver of DRIVERS) {
  test(`${driver.name}: Baseline + Migrationen ueber N == alle Migrationen von Null`, () => {
    const replayed = driver.replayFromZero();
    const based = driver.fromBaseline(shipped);
    try {
      assertSameState(stateOf(based), stateOf(replayed));
      assert.equal(schemaFingerprint(based), schemaFingerprint(replayed));
      assert.deepEqual(
        based.prepare('SELECT version, description FROM schema_migrations ORDER BY version').all().map((r) => ({ .../** @type {object} */ (r) })),
        MIGRATIONS.map((m) => ({ version: m.version, description: m.description })),
        'jede Migration ist verbucht',
      );
    } finally {
      replayed.close();
      based.close();
    }
  });

  test(`${driver.name}: der Stand der Baseline traegt den Fingerabdruck aus baseline.json`, () => {
    const database = driver.fromBaseline(shipped);
    try {
      if (shipped.version === Math.max(...MIGRATIONS.map((m) => m.version))) {
        assert.equal(schemaFingerprint(database), shipped.schemaHash);
      }
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
}

// --------------------------------------------------------
// Der Vergleich ist nicht blind
// --------------------------------------------------------

/** Eine Zeile `CREATE INDEX ...;` und eine Vorgabezeile, an denen die Mutanten ansetzen. */
const AN_INDEX = shipped.sql.split('\n').find((line) => /^CREATE INDEX \S+ ON \S+\([^()]*\);$/.test(line));
const A_ROW = shipped.sql.split('\n').find((line) => line.startsWith('INSERT INTO "task_categories" '));

/**
 * Eine Baseline in einer Transaktion einspielen, wie migrate() es tut.
 * @param {CipherDatabase} database @param {Baseline} baseline
 */
function applyInTransaction(database, baseline) {
  database.transaction(() => applyBaseline(database, baseline))();
}

test('eine Baseline ohne einen Index faellt am Fingerabdruck auf und schreibt nichts', () => {
  assert.ok(AN_INDEX, 'die Baseline traegt einen einzeiligen Index');
  const database = cipher();
  try {
    const broken = { ...shipped, sql: mutate(shipped.sql, `${AN_INDEX}\n`, '') };
    assert.throws(() => applyInTransaction(database, broken), /produced schema [0-9a-f]{64}, expected/);
    assert.ok(isPristine(database), 'zurueckgerollt');
  } finally {
    database.close();
  }
});

test('eine Baseline ohne eine Spalte faellt am Fingerabdruck auf', () => {
  const database = cipher();
  try {
    const column = "\n      description TEXT    NOT NULL,";
    const broken = { ...shipped, sql: mutate(shipped.sql, column, '') };
    assert.throws(() => applyInTransaction(database, broken), /produced schema|no column named description/);
    assert.ok(isPristine(database), 'zurueckgerollt');
  } finally {
    database.close();
  }
});

test('eine Baseline ohne eine Vorgabezeile faellt am Zeilenvergleich auf', () => {
  assert.ok(A_ROW, 'die Baseline traegt eine Vorgabezeile in task_categories');
  const replayed = CIPHER.replayFromZero();
  // applyBaseline() direkt: der Fingerabdruck stimmt, migrate() naehme diese Baseline an.
  const based = cipher();
  applyInTransaction(based, { ...shipped, sql: mutate(shipped.sql, `${A_ROW}\n`, '') });
  migrate(based, MIGRATIONS, null);
  try {
    assert.equal(schemaFingerprint(based), schemaFingerprint(replayed), 'das Schema ist gleich - nur der Zeilenvergleich sieht es');
    assert.throws(() => assertSameState(stateOf(based), stateOf(replayed)), /dieselben Zeilen in task_categories/);
  } finally {
    replayed.close();
    based.close();
  }
});

test('eine Baseline mit zwei vertauschten Triggern derselben Tabelle faellt auf', () => {
  const replayed = CIPHER.replayFromZero();
  const database = cipher();
  try {
    const { triggers } = schemaObjects(replayed);
    const first = triggers.find((t) => triggers.some((other) => other !== t && other.tbl_name === t.tbl_name));
    const second = triggers.find((t) => t !== first && t.tbl_name === first?.tbl_name);
    assert.ok(first && second, 'es gibt eine Tabelle mit zwei Triggern');
    let sql = mutate(shipped.sql, `${first.sql};\n`, '\u0000FIRST\u0000');
    sql = mutate(sql, `${second.sql};\n`, `${first.sql};\n`);
    sql = mutate(sql, '\u0000FIRST\u0000', `${second.sql};\n`);
    assert.throws(() => applyInTransaction(database, { ...shipped, sql }), /produced schema/);
    assert.ok(isPristine(database), 'zurueckgerollt');
  } finally {
    replayed.close();
    database.close();
  }
});

// --------------------------------------------------------
// Wann migrate() die Baseline nimmt
// --------------------------------------------------------

test('migrate() beginnt auf einer leeren Datenbank mit der ausgelieferten Baseline', () => {
  const database = cipher();
  const replayed = CIPHER.replayFromZero();
  try {
    assert.deepEqual(migrate(database), { baseline: shipped.version });
    assertSameState(stateOf(database), stateOf(replayed));
    assert.deepEqual(migrate(database), { baseline: null }, 'ein zweiter Lauf findet nichts zu tun');
  } finally {
    database.close();
    replayed.close();
  }
});

test('migrate() nimmt die Baseline nicht fuer eine eigene Migrationsliste', () => {
  const database = cipher();
  try {
    const own = [{ version: 1, description: 'eigene', up: 'CREATE TABLE own_table (id INTEGER PRIMARY KEY);' }];
    assert.deepEqual(migrate(database, own), { baseline: null });
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => /** @type {{ name: string }} */ (r).name),
      ['own_table', 'schema_migrations'],
    );
  } finally {
    database.close();
  }
});

test('migrate() nimmt die Baseline nicht auf einer Datenbank, die schon etwas traegt', () => {
  const database = cipher();
  const replayed = CIPHER.replayFromZero();
  try {
    migrate(database, MIGRATIONS.filter((m) => m.version <= 10), null);
    assert.deepEqual(migrate(database), { baseline: null });
    assertSameState(stateOf(database), stateOf(replayed));
  } finally {
    database.close();
    replayed.close();
  }
});

// --------------------------------------------------------
// Ersatzweg und Rennen
// --------------------------------------------------------

test('eine unbrauchbare Baseline: der Start faehrt alle Migrationen und endet im selben Zustand', () => {
  const replayed = CIPHER.replayFromZero();
  /** @type {Record<string, () => Baseline>} */
  const cases = {
    'laesst sich nicht laden': () => { throw new Error('ENOENT: baseline.sql'); },
    'falscher Fingerabdruck': () => ({ ...shipped, schemaHash: '0'.repeat(64) }),
    'kaputtes SQL': () => ({ ...shipped, sql: `${shipped.sql}\nCREATE TABLE (;` }),
    'verletzter Fremdschluessel': () => ({
      ...shipped,
      sql: `${shipped.sql}\nINSERT INTO budget_subcategories (key, category_key, name) VALUES ('orphan', 'no_such_category', 'x');`,
    }),
  };
  try {
    for (const [name, load] of Object.entries(cases)) {
      const database = cipher();
      try {
        assert.deepEqual(migrate(database, MIGRATIONS, load), { baseline: null }, name);
        assertSameState(stateOf(database), stateOf(replayed));
      } finally {
        database.close();
      }
    }
  } finally {
    replayed.close();
  }
});

test('ein anderer Prozess war schneller: der Nachzuegler endet im selben Zustand (#1331)', () => {
  const dir = tempDir('yuvomi-baseline-');
  const file = path.join(dir, 'race.db');
  const first = cipher(file);
  const second = cipher(file);
  const replayed = CIPHER.replayFromZero();
  try {
    first.pragma('journal_mode = WAL');
    // Der zweite Prozess hat die Datei leer gesehen und liest die Baseline; in
    // genau diesem Augenblick wird der erste fertig.
    const loadWhileTheOtherFinishes = () => {
      assert.deepEqual(migrate(first), { baseline: shipped.version });
      return shipped;
    };
    assert.deepEqual(migrate(second, MIGRATIONS, loadWhileTheOtherFinishes), { baseline: null });
    assertSameState(stateOf(second), stateOf(replayed));
  } finally {
    first.close();
    second.close();
    replayed.close();
  }
});

// --------------------------------------------------------
// Schreibsperre (SQLITE_BUSY)
// --------------------------------------------------------
//
// Das BUSY ist echt: eine zweite Verbindung haelt die Schreibsperre in ihrer
// eigenen Transaktion, waehrend die erste die Baseline einspielen will. Die
// Verbindung unter Test zaehlt ihre Versuche und fuehrt die ersten `busyFor`
// davon INNERHALB der Transaktion der anderen aus; deren Rollback gibt die
// Sperre wieder frei, bevor der naechste Versuch kommt.

/**
 * @param {string} file @param {number} busyFor wie viele Versuche auf die gehaltene Sperre treffen
 * @returns {{ database: CipherDatabase, waiting: CipherDatabase, holder: CipherDatabase, attempts: () => number }}
 */
function contended(file, busyFor) {
  const holder = cipher(file);
  holder.pragma('journal_mode = WAL');
  const waiting = cipher(file);
  waiting.pragma('busy_timeout = 0');
  let attempts = 0;
  /** @type {CipherDatabase} */
  const database = {
    prepare: (sql) => waiting.prepare(sql),
    exec: (sql) => waiting.exec(sql),
    pragma: (source, options) => waiting.pragma(source, options),
    close: () => waiting.close(),
    transaction(fn) {
      const run = waiting.transaction(fn);
      return (...args) => {
        attempts += 1;
        if (attempts > busyFor) return run(...args);
        // Die andere Verbindung schreibt (und haelt damit die Sperre), dann der
        // Versuch; sein Fehler rollt auch die andere zurueck.
        return holder.transaction(() => {
          holder.exec('CREATE TABLE held_by_the_other_process (id INTEGER)');
          return run(...args);
        })();
      };
    },
  };
  return { database, waiting, holder, attempts: () => attempts };
}

test('die Schreibsperre ist beim naechsten Versuch frei: die Baseline wird eingespielt', () => {
  const dir = tempDir('yuvomi-baseline-');
  const { database, waiting, holder, attempts } = contended(path.join(dir, 'busy.db'), 1);
  const replayed = CIPHER.replayFromZero();
  try {
    assert.deepEqual(migrate(database, MIGRATIONS, () => shipped), { baseline: shipped.version });
    assert.equal(attempts(), 2, 'ein Versuch an der Sperre, einer danach');
    assertSameState(stateOf(waiting), stateOf(replayed));
  } finally {
    waiting.close();
    holder.close();
    replayed.close();
  }
});

test('eine Schreibsperre, die nie faellt: nach der Obergrenze stirbt der Start mit SQLITE_BUSY und schreibt nichts', () => {
  const dir = tempDir('yuvomi-baseline-');
  const { database, waiting, holder, attempts } = contended(path.join(dir, 'busy.db'), Infinity);
  try {
    assert.throws(
      () => migrate(database, MIGRATIONS, () => shipped),
      (err) => String(/** @type {{ code?: unknown }} */ (err).code).startsWith('SQLITE_BUSY'),
    );
    assert.equal(attempts(), MIGRATION_BUSY_ATTEMPTS, 'genau so viele Versuche wie die Obergrenze');
    assert.ok(isPristine(waiting), 'kein Ersatzweg, nichts geschrieben');
  } finally {
    waiting.close();
    holder.close();
  }
});
