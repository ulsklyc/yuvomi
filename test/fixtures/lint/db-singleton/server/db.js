// DB-SINGLETON fixture: the module the others import.
/** @param {unknown} [_x] */
export const get = (_x) => ({ prepare: (/** @type {string} */ _sql) => ({ get: () => null }) });
