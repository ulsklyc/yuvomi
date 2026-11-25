/**
 * Modul: withTx (Transaktion ueber beide Treiber)
 * Zweck: `withTx(db, fn)` aus server/db/tx.ts haelt, was `db.transaction()` des
 *        Produktionstreibers zusichert, und zwar auf beiden Treibern gleich:
 *        better-sqlite3-multiple-ciphers (Produktion) und node:sqlite (Suiten,
 *        die ihr Schema ueber test/helpers/schema-db.js holen). Rueckgabe von
 *        fn, Commit bei Rueckkehr, Rollback bei Throw, eine innere Ebene als
 *        SAVEPOINT, ein Fehler bei einem Thenable als Rueckgabe.
 *
 * Jeder Fall laeuft je Treiber. Was eine Ebene geschrieben hat, wird an den
 * Zeilen der Tabelle gemessen, nicht am Ausbleiben eines Fehlers.
 * Abhängigkeiten: node:test, node:assert, node:sqlite,
 *                 server/utils/sqlite-driver.js, server/db/tx.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import Database from '../server/utils/sqlite-driver.js';

import { withTx } from '../server/db/tx.ts';

/**
 * @typedef {{
 *   exec(sql: string): unknown,
 *   prepare(sql: string): { all(...p: unknown[]): any[], run(...p: unknown[]): unknown },
 *   close(): void,
 *   inTransaction?: boolean,
 *   isTransaction?: boolean,
 * }} AnyDatabase
 */

/** @type {{ name: string, open: () => AnyDatabase }[]} */
const DRIVERS = [
  { name: 'cipher', open: () => /** @type {AnyDatabase} */ (new Database(':memory:')) },
  { name: 'node:sqlite', open: () => /** @type {AnyDatabase} */ (/** @type {unknown} */ (new DatabaseSync(':memory:'))) },
];

/** @param {AnyDatabase} db */
function open(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE notes (
      label     TEXT NOT NULL UNIQUE,
      parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED
    );
  `);
  return db;
}

/** @param {AnyDatabase} db @param {string} label */
const write = (db, label) => db.prepare('INSERT INTO notes (label) VALUES (?)').run(label);
/** @param {AnyDatabase} db @returns {string[]} */
const labels = (db) => db.prepare('SELECT label FROM notes ORDER BY label').all().map((row) => row.label);
/** Der Zustand der Verbindung, je Treiber unter anderem Namen. @param {AnyDatabase} db */
const inTransaction = (db) => db.inTransaction ?? db.isTransaction;

/**
 * @param {string} name
 * @param {(db: AnyDatabase) => void} body
 */
function onBothDrivers(name, body) {
  for (const driver of DRIVERS) {
    test(`${driver.name}: ${name}`, () => {
      const db = open(driver.open());
      try {
        body(db);
      } finally {
        db.close();
      }
    });
  }
}

// --------------------------------------------------------
// Eine Ebene
// --------------------------------------------------------

onBothDrivers('gibt die Rueckgabe von fn zurueck und schreibt fest', (db) => {
  const result = withTx(db, () => {
    write(db, 'a');
    assert.equal(inTransaction(db), true, 'fn laeuft in einer Transaktion');
    return { answer: 42 };
  });
  assert.deepEqual(result, { answer: 42 });
  assert.equal(inTransaction(db), false, 'nach der Rueckkehr ist die Transaktion zu');
  assert.deepEqual(labels(db), ['a']);
});

onBothDrivers('falsy Rueckgaben kommen unveraendert an', (db) => {
  assert.equal(withTx(db, () => 0), 0);
  assert.equal(withTx(db, () => ''), '');
  assert.equal(withTx(db, () => null), null);
  assert.equal(withTx(db, () => undefined), undefined);
  assert.equal(inTransaction(db), false);
});

onBothDrivers('ein Throw rollt zurueck und kommt als derselbe Fehler an', (db) => {
  const boom = new Error('boom');
  assert.throws(() => withTx(db, () => {
    write(db, 'a');
    throw boom;
  }), (err) => err === boom);
  assert.equal(inTransaction(db), false, 'die Transaktion bleibt nicht offen');
  assert.deepEqual(labels(db), [], 'nichts geschrieben');
  // Die Verbindung ist danach benutzbar wie zuvor.
  withTx(db, () => write(db, 'b'));
  assert.deepEqual(labels(db), ['b']);
});

// --------------------------------------------------------
// Verschachtelt: die innere Ebene ist ein SAVEPOINT
// --------------------------------------------------------

onBothDrivers('Throw in der inneren Ebene, aussen gefangen: nur die innere Ebene faellt', (db) => {
  const inner = new Error('inner');
  withTx(db, () => {
    write(db, 'outer-before');
    assert.throws(() => withTx(db, () => {
      write(db, 'inner');
      throw inner;
    }), (err) => err === inner);
    assert.equal(inTransaction(db), true, 'die aeussere Transaktion steht noch');
    assert.deepEqual(labels(db), ['outer-before'], 'die innere Zeile ist weg, die aeussere steht');
    write(db, 'outer-after');
  });
  assert.equal(inTransaction(db), false);
  assert.deepEqual(labels(db), ['outer-after', 'outer-before']);
});

onBothDrivers('Throw in der inneren Ebene, nicht gefangen: alles faellt', (db) => {
  const inner = new Error('inner');
  assert.throws(() => withTx(db, () => {
    write(db, 'outer');
    withTx(db, () => {
      write(db, 'inner');
      throw inner;
    });
  }), (err) => err === inner);
  assert.equal(inTransaction(db), false);
  assert.deepEqual(labels(db), []);
});

onBothDrivers('die innere Ebene schreibt erst mit der aeusseren fest', (db) => {
  const outer = new Error('outer');
  assert.throws(() => withTx(db, () => {
    assert.equal(withTx(db, () => {
      write(db, 'inner');
      return 'inner-result';
    }), 'inner-result');
    assert.equal(inTransaction(db), true, 'die innere Rueckkehr schliesst die aeussere nicht');
    throw outer;
  }), (err) => err === outer);
  assert.deepEqual(labels(db), [], 'die gelungene innere Ebene faellt mit der aeusseren');
});

onBothDrivers('drei Ebenen: ein Throw in der mittleren nimmt die innerste mit, die aeusserste bleibt', (db) => {
  const middle = new Error('middle');
  withTx(db, () => {
    write(db, 'level-1');
    assert.throws(() => withTx(db, () => {
      write(db, 'level-2');
      withTx(db, () => write(db, 'level-3'));
      assert.deepEqual(labels(db), ['level-1', 'level-2', 'level-3']);
      throw middle;
    }), (err) => err === middle);
    // Zwei Geschwister nacheinander auf derselben Ebene.
    withTx(db, () => write(db, 'level-2b'));
  });
  assert.deepEqual(labels(db), ['level-1', 'level-2b']);
});

/**
 * Die Verbindung, aber jede Anweisung von withTx wird mitgeschrieben.
 * @param {AnyDatabase} db @returns {{ spy: import('../server/db/tx.ts').TxDatabase, statements: string[] }}
 */
function recording(db) {
  /** @type {string[]} */
  const statements = [];
  const spy = {
    exec(/** @type {string} */ sql) {
      statements.push(sql);
      return db.exec(sql);
    },
    get inTransaction() { return inTransaction(db); },
  };
  return { spy, statements };
}

onBothDrivers('die Folge der Anweisungen: eine innere Ebene laesst keinen Savepoint liegen', (db) => {
  // Gelungen wie gescheitert wird der Savepoint der inneren Ebene wieder
  // freigegeben (wie db.transaction() des Treibers): ein liegengebliebener
  // aenderte kein Ergebnis, wuechse aber in einer langen Transaktion mit jeder
  // gescheiterten Ebene.
  const { spy, statements } = recording(db);
  withTx(spy, () => {
    withTx(spy, () => write(db, 'inner-ok'));
    assert.throws(() => withTx(spy, () => {
      write(db, 'inner-fails');
      throw new Error('inner');
    }), /inner/);
  });
  assert.deepEqual(statements, [
    'BEGIN',
    'SAVEPOINT yuvomi_tx', 'RELEASE yuvomi_tx',
    'SAVEPOINT yuvomi_tx', 'ROLLBACK TO yuvomi_tx', 'RELEASE yuvomi_tx',
    'COMMIT',
  ]);
  assert.deepEqual(labels(db), ['inner-ok']);

  statements.length = 0;
  assert.throws(() => withTx(spy, () => { throw new Error('outer'); }), /outer/);
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
});

// --------------------------------------------------------
// Thenable als Rueckgabe: fn muss synchron sein
// --------------------------------------------------------

onBothDrivers('async fn: Fehler, und was vor dem ersten await geschrieben wurde, faellt', (db) => {
  // Per Namen uebergeben - genau die Schreibweise, die TX-ASYNC-FN im Lint nicht
  // sieht und fuer die es den Laufzeitriegel gibt. Die Typpruefung wird dafuer
  // umgangen: `() => Promise<void>` waere als fn sonst still erlaubt.
  const asyncBody = async () => {
    write(db, 'before-await');
    await null;
  };
  assert.throws(
    () => withTx(db, /** @type {() => void} */ (/** @type {unknown} */ (asyncBody))),
    (err) => err instanceof TypeError && /withTx/.test(err.message) && /promise/i.test(err.message),
  );
  assert.equal(inTransaction(db), false);
  assert.deepEqual(labels(db), [], 'der synchrone Teil wurde zurueckgerollt');
});

onBothDrivers('ein Thenable, das kein Promise ist, zaehlt genauso; ein Objekt ohne then nicht', (db) => {
  assert.throws(() => withTx(db, () => {
    write(db, 'a');
    return { then() {} };
  }), TypeError);
  assert.deepEqual(labels(db), []);
  assert.deepEqual(withTx(db, () => ({ then: 'kein Aufruf' })), { then: 'kein Aufruf' });
});

onBothDrivers('async fn in der inneren Ebene: nur die innere Ebene faellt', (db) => {
  withTx(db, () => {
    write(db, 'outer');
    assert.throws(() => withTx(db, () => {
      write(db, 'inner');
      return Promise.resolve();
    }), TypeError);
    assert.equal(inTransaction(db), true);
  });
  assert.deepEqual(labels(db), ['outer']);
});

// --------------------------------------------------------
// SQLite beendet die Transaktion selbst
// --------------------------------------------------------

/** @param {unknown} err */
const isUniqueViolation = (err) => /UNIQUE constraint failed/.test(String(/** @type {{ message?: unknown }} */ (err)?.message));

onBothDrivers('INSERT OR ROLLBACK: der Fehler von SQLite kommt an, nicht einer vom Aufraeumen', (db) => {
  write(db, 'taken');
  assert.throws(() => withTx(db, () => {
    write(db, 'a');
    // SQLite rollt bei dieser Verletzung die GANZE Transaktion selbst zurueck.
    db.prepare("INSERT OR ROLLBACK INTO notes (label) VALUES ('taken')").run();
  }), isUniqueViolation);
  assert.equal(inTransaction(db), false);
  assert.deepEqual(labels(db), ['taken']);
});

onBothDrivers('INSERT OR ROLLBACK in der inneren Ebene: kein ROLLBACK TO auf einen Savepoint, den es nicht mehr gibt', (db) => {
  write(db, 'taken');
  assert.throws(() => withTx(db, () => {
    write(db, 'outer');
    withTx(db, () => db.prepare("INSERT OR ROLLBACK INTO notes (label) VALUES ('taken')").run());
  }), isUniqueViolation);
  assert.equal(inTransaction(db), false);
  assert.deepEqual(labels(db), ['taken']);
});

onBothDrivers('das COMMIT selbst scheitert (aufgeschobener Fremdschluessel): Rollback, nichts bleibt offen', (db) => {
  assert.throws(() => withTx(db, () => {
    write(db, 'a');
    // Der Verweis wird erst beim COMMIT geprueft.
    db.prepare("INSERT INTO notes (label, parent_id) VALUES ('orphan', 999)").run();
  }), (err) => /FOREIGN KEY constraint failed/.test(String(/** @type {{ message?: unknown }} */ (err)?.message)));
  assert.equal(inTransaction(db), false, 'eine am COMMIT gescheiterte Transaktion wird zurueckgerollt');
  assert.deepEqual(labels(db), []);
});

// --------------------------------------------------------
// Neben db.transaction() des Produktionstreibers
// --------------------------------------------------------

test('cipher: withTx in db.transaction() und umgekehrt - die innere Ebene faellt allein', () => {
  const db = /** @type {any} */ (open(DRIVERS[0].open()));
  try {
    db.transaction(() => {
      write(db, 'driver-outer');
      assert.throws(() => withTx(db, () => {
        write(db, 'withtx-inner');
        throw new Error('inner');
      }), /inner/);
    })();
    assert.deepEqual(labels(db), ['driver-outer']);

    withTx(db, () => {
      write(db, 'withtx-outer');
      assert.throws(() => db.transaction(() => {
        write(db, 'driver-inner');
        throw new Error('inner');
      })(), /inner/);
    });
    assert.deepEqual(labels(db), ['driver-outer', 'withtx-outer']);
    assert.equal(db.inTransaction, false);
  } finally {
    db.close();
  }
});

// --------------------------------------------------------
// Eine Verbindung, die ihren Zustand nicht nennt
// --------------------------------------------------------

test('eine Verbindung ohne inTransaction/isTransaction wird abgelehnt, bevor etwas laeuft', () => {
  /** @type {string[]} */
  const statements = [];
  let called = false;
  const blind = { exec: (/** @type {string} */ sql) => { statements.push(sql); } };
  assert.throws(() => withTx(blind, () => { called = true; }), TypeError);
  assert.deepEqual(statements, [], 'keine Anweisung');
  assert.equal(called, false, 'fn lief nicht');
});
