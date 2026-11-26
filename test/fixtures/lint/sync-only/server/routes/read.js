// SYNC-ONLY fixture: a route is no synchronous area; silent.
/** @param {Promise<void>} p */
export async function handler(p) { await p; }
