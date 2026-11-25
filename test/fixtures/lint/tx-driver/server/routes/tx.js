// TX-DRIVER fixture (phase 2, F6d): a call of a method named `transaction` under server/ is
// a finding, one line per spelling (`// tx-N`); withTx(db, fn) is the one way. The two
// withTx lines with a third argument stay under TX-ASYNC-FN (`// async-N`) and
// TX-AWAIT-INSIDE (`// await-N`). Silent: withTx, `transactions`, `transaction` as a name,
// in a string or in a comment.
/** @param {() => unknown} fn */
const build = (fn) => Object.assign(() => fn(), { immediate: () => fn() });
const db = { transaction: build, get: () => db, prepare: (/** @type {string} */ sql) => ({ sql, run() {} }) };
const database = db;
const dbModule = { transaction: build };
const withTx = (/** @type {object} */ conn, /** @type {Function} */ fn, _options = {}) => fn(conn);
const fn = () => 1;

db.transaction(fn)(); // tx-1
database.transaction(fn).immediate(); // tx-2
db.get().transaction(fn); // tx-3
dbModule.transaction(fn); // tx-4

withTx(db, fn);
withTx(db, () => { db.prepare('x').run(); }, { immediate: true });
withTx(db, async () => { await 1; }, { immediate: true }); // async-1
withTx(db, function () { const g = async () => { await 2; }; return g(); }, { immediate: true }); // await-1
const idb = { transactions: [], transaction: 'x' };
export const names = [idb.transactions, idb.transaction];
const transaction = fn;
transaction();
export const text = 'db.transaction(fn)()';
// db.transaction(fn)() in a comment
