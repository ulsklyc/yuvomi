// Rights fixture (phase 2, B5, B8c): migrations and seeds write visibility values and may
// compare a row's level while they move data (a migration freezes the rule of its day).
export const MIGRATION = `UPDATE notes SET visibility = 'private' WHERE visibility IN ('x')`;
/** @param {any} row */
export const migrateRow = (row) => (row.visibility === 'all' ? 'family' : row.visibility);
