/**
 * Modul: Transaktion (withTx)
 * Zweck: `withTx(db, fn)` faehrt `fn` in einer Transaktion der Verbindung `db`:
 *        Commit bei Rueckkehr, Rollback bei Throw, die Rueckgabe von `fn` als
 *        Ergebnis. Ein Aufruf innerhalb einer offenen Transaktion wird ein
 *        SAVEPOINT - scheitert er, faellt nur seine Ebene, und der Fehler geht
 *        weiter an den Aufrufer, der ihn fangen oder die aeussere Ebene mit
 *        fallen lassen kann.
 *
 * Warum nicht `db.transaction()`: den Helfer hat nur der Produktionstreiber
 * (better-sqlite3-multiple-ciphers). Module, die `db` als Parameter nehmen,
 * laufen in Suiten auch auf node:sqlite, und schrieben ihr BEGIN/COMMIT/ROLLBACK
 * deshalb bisher jedes fuer sich von Hand - ohne Savepoint und ohne den Riegel
 * gegen ein Promise. Hier steht dieselbe Folge einmal, fuer beide Treiber auf
 * demselben Weg; sie ist `db.transaction()` des Treibers nachgebaut
 * (lib/methods/transaction.js) und vertraegt sich mit ihm in beiden
 * Richtungen, weil beide die Ebene am Zustand der Verbindung ablesen.
 *
 * `fn` MUSS synchron sein. Der Treiber ist synchron, und jedes `await` ist ein
 * Yield-Punkt: was danach laeuft, laeuft nach dem Commit und ausserhalb der
 * Transaktion. Ein Thenable als Rueckgabe ist deshalb ein Fehler, und die Ebene
 * wird zurueckgerollt (TX-ASYNC-FN und TX-AWAIT-INSIDE finden die Schreibweise
 * schon im Lint; eine per Namen uebergebene Funktion sieht nur dieser Riegel).
 *
 * Hier stehen die Transaktionsanweisungen, damit sie sonst nirgends stehen:
 * TX-MANUAL meldet jedes von Hand geschriebene BEGIN/COMMIT/ROLLBACK/SAVEPOINT.
 * Abhängigkeiten: keine
 */

/**
 * Eine Verbindung, so weit withTx sie braucht. Ihren Zustand nennt
 * better-sqlite3-multiple-ciphers `inTransaction`, node:sqlite `isTransaction`.
 */
export type TxDatabase = {
  exec(sql: string): unknown;
  readonly inTransaction?: boolean;
  readonly isTransaction?: boolean;
};

/**
 * Steht auf der Verbindung eine Transaktion offen? Eine Verbindung, die das
 * nicht sagt, wird abgelehnt: ohne den Zustand liesse sich weder die Ebene
 * waehlen noch erkennen, dass SQLite die Transaktion selbst beendet hat.
 */
function isOpen(db: TxDatabase): boolean {
  if (typeof db.inTransaction === 'boolean') return db.inTransaction;
  if (typeof db.isTransaction === 'boolean') return db.isTransaction;
  throw new TypeError('withTx needs a connection that reports its transaction state (inTransaction or isTransaction).');
}

function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * `fn` in einer Transaktion von `db` fahren und seine Rueckgabe liefern.
 * Aeusserste Ebene: BEGIN, dann COMMIT oder ROLLBACK. Innere Ebene: SAVEPOINT,
 * dann RELEASE oder ROLLBACK TO und RELEASE. Der Fehler von `fn` kommt als
 * derselbe Fehler an.
 */
export function withTx<Result>(db: TxDatabase, fn: () => Result): Result {
  const nested = isOpen(db);
  // Ein fester Name genuegt: Savepoints gleichen Namens stapeln sich, RELEASE
  // und ROLLBACK TO treffen den juengsten.
  if (nested) db.exec('SAVEPOINT yuvomi_tx');
  else db.exec('BEGIN');
  try {
    const result = fn();
    if (isThenable(result)) {
      throw new TypeError('withTx: fn returned a promise. The function must be synchronous; code after an await would run outside the transaction.');
    }
    if (nested) db.exec('RELEASE yuvomi_tx');
    else db.exec('COMMIT');
    return result;
  } catch (err) {
    // SQLite kann die ganze Transaktion schon selbst beendet haben (OR ROLLBACK,
    // RAISE(ROLLBACK), SQLITE_FULL): dann gibt es nichts mehr zurueckzurollen,
    // und ein ROLLBACK wuerde den eigentlichen Fehler durch seinen ersetzen.
    if (isOpen(db)) {
      if (nested) {
        db.exec('ROLLBACK TO yuvomi_tx');
        db.exec('RELEASE yuvomi_tx');
      } else {
        db.exec('ROLLBACK');
      }
    }
    throw err;
  }
}
