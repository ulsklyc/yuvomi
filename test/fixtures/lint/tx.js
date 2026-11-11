// Lint fixture (phase 1b, section D): two findings of the transaction rules.
// better-sqlite3 commits an async transaction function at its first await, so
// everything after it runs outside the transaction.
const db = { transaction: (/** @type {Function} */ fn) => fn, prepare: (/** @type {string} */ sql) => ({ sql, run() {} }) };
db.transaction(async () => { await 1; db.prepare('x').run(); })();                // tx-async
db.transaction(() => { db.prepare('x').run(); })();                                // allowed
db.transaction(function () { const g = async () => { await 2; }; return g(); })(); // tx-await
