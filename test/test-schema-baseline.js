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
 *      endet der Start trotzdem im selben Zustand; die Schreibsperre wird wie
 *      bei einer Migration neu versucht.
 *   6. Der Erzeuger schreibt verlustfrei (rowid, sqlite_sequence, alle
 *      Speicherklassen, Eltern vor Kindern) und bricht ab, wo er es nicht kann.
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
import { baselineJson, buildBaseline, dumpBaseline, tableRows } from '../scripts/lib/schema-baseline.ts';
import { migrateOnNodeSqlite } from './helpers/schema-db.js';

const STARTED = Date.now();
const SQL_FILE = new URL('../server/migrations/baseline.sql', import.meta.url);
const JSON_FILE = new URL('../server/migrations/baseline.json', import.meta.url);
const shipped = loadBaseline();

/**
 * @typedef {import('../server/db/baseline.ts').Baseline} Baseline
 * @typedef {import('../server/db/baseline.ts').BaselineDatabase & { close(): void }} AnyDatabase
 * @typedef {import('../server/db/handle.ts').SqliteDatabase} ServerDatabase
 * @typedef {ServerDatabase & { transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R }} CipherDatabase
 * @typedef {{ schema: ReturnType<typeof schemaObjects>, rows: Record<string, unknown[]> }} State
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

/**
 * Was der Logger waehrend eines Tests als Warnung und als Fehler schreibt
 * (ausserhalb der Produktion ueber console.warn und console.error). Die drei
 * Auswege aus der Baseline unterscheiden sich fuer den Betreiber nur hier: ein
 * schnellerer Prozess und eine belegte Sperre sind Warnungen, eine unbrauchbare
 * Baseline ist ein Fehler.
 * @param {import('node:test').TestContext} t
 * @returns {{ warn: string[], error: string[] }}
 */
function logged(t) {
  /** @type {{ warn: string[], error: string[] }} */
  const lines = { warn: [], error: [] };
  t.mock.method(console, 'warn', (/** @type {unknown[]} */ ...args) => { lines.warn.push(args.join(' ')); });
  t.mock.method(console, 'error', (/** @type {unknown[]} */ ...args) => { lines.error.push(args.join(' ')); });
  return lines;
}

/** @param {string} [file] @returns {CipherDatabase} */
function cipher(file = ':memory:') {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  return database;
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
 * Eine Spaltenzeile, deren Name im ganzen Skript genau einmal steht: kein
 * Index, kein Trigger und keine Vorgabezeile nennt sie. Fehlt sie, laeuft das
 * Skript ohne Fehler durch - nur der Fingerabdruck kann es merken.
 */
const A_COLUMN = shipped.sql.split('\n').find((line) => {
  const name = /^\s+([a-z_]+)\s+(TEXT|INTEGER),$/.exec(line)?.[1];
  return name !== undefined && shipped.sql.split(name).length - 1 === 1;
});

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

test('eine Baseline ohne eine Spalte faellt am Fingerabdruck auf und schreibt nichts', () => {
  assert.ok(A_COLUMN, 'die Baseline traegt eine Spalte, die sonst nirgends genannt wird');
  const database = cipher();
  try {
    const broken = { ...shipped, sql: mutate(shipped.sql, `${A_COLUMN}\n`, '') };
    // Nur der Fingerabdruck: das Skript selbst laeuft ohne diese Spalte durch.
    assert.throws(() => applyInTransaction(database, broken), /produced schema [0-9a-f]{64}, expected/);
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

test('migrate() beginnt auf einer leeren Datenbank mit der ausgelieferten Baseline', (t) => {
  const log = logged(t);
  const database = cipher();
  const replayed = CIPHER.replayFromZero();
  try {
    assert.deepEqual(migrate(database), { baseline: shipped.version });
    assert.deepEqual(log, { warn: [], error: [] }, 'kein Ersatzweg, kein Neuversuch');
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

test('eine unbrauchbare Baseline: der Start faehrt alle Migrationen, endet im selben Zustand und meldet einen Fehler', (t) => {
  const log = logged(t);
  const replayed = CIPHER.replayFromZero();
  /** @type {Record<string, () => Baseline>} */
  const cases = {
    'laesst sich nicht laden': () => { throw new Error('ENOENT: baseline.sql'); },
    'falscher Fingerabdruck': () => ({ ...shipped, schemaHash: '0'.repeat(64) }),
    // Beide brechen MITTEN im Skript: ohne Transaktion bliebe ein halbes Schema
    // ohne Buchungen stehen, und die erste Migration scheiterte daran.
    'kaputtes SQL': () => ({ ...shipped, sql: mutate(shipped.sql, `${AN_INDEX}\n`, 'CREATE INDEX (;\n') }),
    'verletzter Fremdschluessel': () => ({
      ...shipped,
      sql: mutate(
        shipped.sql,
        'DELETE FROM sqlite_sequence;\n',
        "INSERT INTO budget_subcategories (key, category_key, name) VALUES ('orphan', 'no_such_category', 'x');\nDELETE FROM sqlite_sequence;\n",
      ),
    }),
  };
  try {
    for (const [name, load] of Object.entries(cases)) {
      const database = cipher();
      try {
        log.warn.length = 0;
        log.error.length = 0;
        assert.deepEqual(migrate(database, MIGRATIONS, load), { baseline: null }, name);
        assertSameState(stateOf(database), stateOf(replayed));
        assert.equal(log.error.length, 1, `${name}: genau eine Fehlerzeile`);
        assert.match(log.error[0], /^\[DB\] Schema baseline .*running every migration instead: /, name);
        assert.deepEqual(log.warn, [], name);
      } finally {
        database.close();
      }
    }
  } finally {
    replayed.close();
  }
});

test('ein Fehler der Umgebung nimmt nicht den Ersatzweg: er fliegt weiter, wie er ist', (t) => {
  const log = logged(t);
  const file = path.join(tempDir('yuvomi-baseline-'), 'readonly.db');
  // Eine leere, aber vollstaendige Datenbankdatei, wie createDatabaseFile() sie hinterlaesst.
  const writer = cipher(file);
  writer.pragma('user_version = 0');
  writer.close();
  const readonly = /** @type {CipherDatabase} */ (new Database(file, { readonly: true }));
  try {
    assert.ok(isPristine(readonly));
    assert.throws(
      () => migrate(readonly, MIGRATIONS, () => shipped),
      (err) => /** @type {{ code?: unknown }} */ (err).code === 'SQLITE_READONLY',
    );
    // Nicht "die Baseline ist unbrauchbar": sie ist in Ordnung, die Datei ist nicht beschreibbar.
    assert.deepEqual(log, { warn: [], error: [] });
  } finally {
    readonly.close();
  }
});

test('ein anderer Prozess war schneller: der Nachzuegler endet im selben Zustand und warnt nur (#1331)', (t) => {
  const log = logged(t);
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
    // Kein Fehler: die Baseline ist in Ordnung, nur war die Datei nicht mehr leer.
    assert.deepEqual(log.error, []);
    assert.equal(log.warn.length, 1);
    assert.match(log.warn[0], /no longer empty .* another process was faster \(#1331\)/);
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
 * @returns {{ database: ServerDatabase, waiting: CipherDatabase, holder: CipherDatabase, attempts: () => number }}
 */
function contended(file, busyFor) {
  const holder = cipher(file);
  holder.pragma('journal_mode = WAL');
  const waiting = cipher(file);
  waiting.pragma('busy_timeout = 0');
  let attempts = 0;
  /** @type {ServerDatabase} */
  const database = {
    prepare: (sql) => waiting.prepare(sql),
    // migrate() faehrt seine Transaktionen mit withTx(): jedes aeusserste BEGIN ist
    // ein Versuch.
    exec: (sql) => {
      if (sql !== 'BEGIN') return waiting.exec(sql);
      attempts += 1;
      if (attempts > busyFor) return waiting.exec(sql);
      // Die andere Verbindung schreibt (und haelt damit die Sperre), dann der
      // Versuch: sein erstes Schreiben scheitert mit SQLITE_BUSY, der Treiber rollt
      // ihn zurueck, und sein Fehler rollt auch die andere zurueck.
      return holder.transaction(() => {
        holder.exec('CREATE TABLE held_by_the_other_process (id INTEGER)');
        waiting.transaction(() => waiting.exec('CREATE TABLE attempt_at_the_lock (id INTEGER)'))();
      })();
    },
    get inTransaction() { return waiting.inTransaction; },
    pragma: (source, options) => waiting.pragma(source, options),
    close: () => waiting.close(),
  };
  return { database, waiting, holder, attempts: () => attempts };
}

test('die Schreibsperre ist beim naechsten Versuch frei: die Baseline wird eingespielt', (t) => {
  const log = logged(t);
  const dir = tempDir('yuvomi-baseline-');
  const { database, waiting, holder, attempts } = contended(path.join(dir, 'busy.db'), 1);
  const replayed = CIPHER.replayFromZero();
  try {
    assert.deepEqual(migrate(database, MIGRATIONS, () => shipped), { baseline: shipped.version });
    assert.equal(attempts(), 2, 'ein Versuch an der Sperre, einer danach');
    assert.deepEqual(log.error, []);
    assert.equal(log.warn.length, 1);
    assert.match(log.warn[0], /Schreibsperre \(SQLITE_BUSY\w*\), Versuch 2 von/);
    assertSameState(stateOf(waiting), stateOf(replayed));
  } finally {
    waiting.close();
    holder.close();
    replayed.close();
  }
});

test('eine Schreibsperre, die nie faellt: nach der Obergrenze stirbt der Start mit SQLITE_BUSY und schreibt nichts', (t) => {
  const log = logged(t);
  const dir = tempDir('yuvomi-baseline-');
  const { database, waiting, holder, attempts } = contended(path.join(dir, 'busy.db'), Infinity);
  try {
    assert.throws(
      () => migrate(database, MIGRATIONS, () => shipped),
      (err) => String(/** @type {{ code?: unknown }} */ (err).code).startsWith('SQLITE_BUSY'),
    );
    assert.equal(attempts(), MIGRATION_BUSY_ATTEMPTS, 'genau so viele Versuche wie die Obergrenze');
    assert.ok(isPristine(waiting), 'kein Ersatzweg, nichts geschrieben');
    assert.deepEqual(log.error, [], 'kein Ersatzweg');
    assert.equal(log.warn.length, MIGRATION_BUSY_ATTEMPTS - 1);
  } finally {
    waiting.close();
    holder.close();
  }
});

// --------------------------------------------------------
// Der Erzeuger
// --------------------------------------------------------
//
// Die ausgelieferten Migrationen hinterlassen wenig, woran der Erzeuger
// scheitern koennte. Was er zusagt, wird deshalb an kleinen eigenen
// Datenbanken geprueft: `dumpBaseline()` schreibt den Stand, eine leere
// Datenbank spielt ihn ein, und beide muessen gleich sein.

const SCHEMA_MIGRATIONS = `
  CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );`;

/**
 * Eine Datenbank "auf Stand 1" mit eigenem Schema und eigenen Zeilen.
 * @param {string} sql
 */
function sourceDatabase(sql) {
  const database = cipher();
  database.exec(`${SCHEMA_MIGRATIONS}\n${sql}\nINSERT INTO schema_migrations (version, description) VALUES (1, 'eigene');`);
  return database;
}

/** @param {CipherDatabase} source */
function dumpOf(source) {
  return dumpBaseline(source, 1, { from: STARTED, to: Date.now() });
}

test('der Erzeuger schreibt verlustfrei: Schema, rowid, sqlite_sequence und jede Speicherklasse', () => {
  const source = sourceDatabase(`
    CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, amount REAL, payload BLOB, note TEXT);
    CREATE INDEX things_label ON things(label);
    CREATE TABLE plain (label TEXT);
    CREATE TABLE keyed (code TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
    CREATE VIRTUAL TABLE found USING fts5(body);
    CREATE TRIGGER things_b AFTER INSERT ON things BEGIN INSERT INTO plain (label) VALUES ('b:' || NEW.label); END;
    CREATE TRIGGER things_a AFTER INSERT ON things BEGIN INSERT INTO plain (label) VALUES ('a:' || NEW.label); END;
    INSERT INTO things (label, amount, payload, note) VALUES ('it''s "quoted"', 0.1, x'00ff10', NULL), ('zeile\nzwei', -1e300, x'', 'x');
    DELETE FROM things WHERE id = 2;
    DELETE FROM plain;
    INSERT INTO plain (rowid, label) VALUES (5, 'fuenf'), (9, 'neun');
    INSERT INTO keyed (code, n) VALUES ('b', 2), ('a', 1);
  `);
  const target = cipher();
  try {
    const sql = dumpOf(source);
    target.exec(sql);
    assert.equal(schemaFingerprint(target), schemaFingerprint(source));
    assertSameState(stateOf(target), stateOf(source));
    assert.deepEqual(stateOf(target).rows.plain, [{ '(rowid)': 5, label: 'fuenf' }, { '(rowid)': 9, label: 'neun' }], 'die Trigger feuern nicht auf die Vorgabezeilen, die rowid bleibt');
    assert.deepEqual(target.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'things'").get(), { seq: 2 }, 'der Zaehler steht ueber der hoechsten ID, wie in der Quelle');
    // Die Feuerreihenfolge der zwei Trigger ist dieselbe wie in der Quelle.
    for (const database of [source, target]) database.exec("INSERT INTO things (label) VALUES ('neu')");
    assert.deepEqual(stateOf(target).rows.plain, stateOf(source).rows.plain);
  } finally {
    source.close();
    target.close();
  }
});

test('der Erzeuger schreibt Elternzeilen vor Kindzeilen, auch wenn die Kindtabelle aelter ist', () => {
  const source = sourceDatabase(`
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    CREATE TABLE parent (id INTEGER PRIMARY KEY, up INTEGER REFERENCES parent(id));
    INSERT INTO parent (id, up) VALUES (1, NULL), (2, 1);
    INSERT INTO child (id, parent_id) VALUES (1, 2);
  `);
  const target = new DatabaseSync(':memory:');
  try {
    const sql = dumpOf(source);
    assert.ok(sql.indexOf('INSERT INTO "parent"') < sql.indexOf('INSERT INTO "child"'), 'parent steht vor child');
    // node:sqlite: Anweisung fuer Anweisung, Fremdschluessel an.
    target.exec(sql);
    assertSameState(stateOf(target), stateOf(source));
  } finally {
    source.close();
    target.close();
  }
});

test('der Erzeuger bricht ab, wo er den Stand nicht als Skript schreiben kann', () => {
  /** @type {Record<string, { sql: string, error: RegExp }>} */
  const cases = {
    'Fremdschluessel im Kreis': {
      sql: `
        PRAGMA foreign_keys = OFF;
        CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id));
        CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));
        INSERT INTO a VALUES (1, 1);
        INSERT INTO b VALUES (1, 1);`,
      error: /Foreign keys between a, b form a cycle/,
    },
    'virtuelle Tabelle mit Zeilen': {
      sql: "CREATE VIRTUAL TABLE found USING fts5(body); INSERT INTO found (body) VALUES ('etwas');",
      error: /found is a virtual table with 1 row/,
    },
    'Zeit des Replays ohne Spaltenvorgabe': {
      sql: "CREATE TABLE stamped (id INTEGER PRIMARY KEY, seen_at TEXT); INSERT INTO stamped (seen_at) VALUES (datetime('now'));",
      error: /stamped\.seen_at holds .* a time from this replay, but the column has no 'now' default/,
    },
    'Tag des Replays ohne Spaltenvorgabe': {
      sql: "CREATE TABLE dated (id INTEGER PRIMARY KEY, day TEXT); INSERT INTO dated (day) VALUES (date('now'));",
      error: /dated\.day holds/,
    },
  };
  for (const [name, { sql, error }] of Object.entries(cases)) {
    const source = sourceDatabase(sql);
    try {
      assert.throws(() => dumpOf(source), error, name);
    } finally {
      source.close();
    }
  }
});

test('der Erzeuger schreibt die Zeit des Replays als Spaltenvorgabe, eine feste Zeit als Literal', () => {
  const source = sourceDatabase(`
    CREATE TABLE stamped (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      label TEXT
    );
    INSERT INTO stamped (label) VALUES ('jetzt');
    INSERT INTO stamped (created_at, label) VALUES ('2020-01-02T03:04:05Z', 'damals');
  `);
  try {
    const rows = dumpOf(source).split('\n').filter((line) => line.startsWith('INSERT INTO "stamped"'));
    assert.deepEqual(rows, [
      `INSERT INTO "stamped" ("id", "created_at", "label") VALUES (1, (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), 'jetzt');`,
      `INSERT INTO "stamped" ("id", "created_at", "label") VALUES (2, '2020-01-02T03:04:05Z', 'damals');`,
    ]);
  } finally {
    source.close();
  }
});
