// Lint fixture (phase 1b, section D; withTx since phase 2, F6): four findings of the transaction rules.
// better-sqlite3 throws on a returned promise and rolls back; code after the
// first await runs outside any transaction. Blind spots: a function passed by name, an
// aliased import of withTx, a synchronous function that returns a promise; the thenable
// guard in db.transaction() and withTx() catches these when they run.
const db = { transaction: (/** @type {Function} */ fn) => fn, prepare: (/** @type {string} */ sql) => ({ sql, run() {} }) };
db.transaction(async () => { await 1; db.prepare('x').run(); })();                // tx-async
db.transaction(() => { db.prepare('x').run(); })();                                // allowed
db.transaction(function () { const g = async () => { await 2; }; return g(); })(); // tx-await
// withTx() from server/db/tx.ts stands under the same two rules (it throws on a returned promise as well).
const withTx = (/** @type {object} */ conn, /** @type {Function} */ fn) => fn(conn);
withTx(db, async () => { await 1; db.prepare('x').run(); });                       // tx-async
withTx(db, () => { db.prepare('x').run(); });                                      // allowed
withTx(db, function () { const g = async () => { await 2; }; return g(); });       // tx-await
