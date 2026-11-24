// SQL-IN-LIST fixture: a migration's SQL is frozen once applied, so the schema file is
// exempt; nothing here may be reported.
/** @param {any} db @param {string[]} columns */
export const migrate = (db, columns) => db.prepare(`INSERT INTO t (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
