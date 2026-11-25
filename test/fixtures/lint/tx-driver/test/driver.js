// TX-DRIVER fixture: test/ is outside the rule; a suite uses the driver on purpose. Silent.
const db = { transaction: (/** @type {Function} */ fn) => fn };
db.transaction(() => 1)();
