// SQL-IN-LIST fixture: the permission module is no exception; the marked line is reported.
export const rowsIn = (db: any, ids: number[]) => db.prepare(`SELECT id FROM d WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids); // sql-13
