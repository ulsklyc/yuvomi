// SQL-IN-LIST fixture (Refs #2810, follow-up 5a): every line marked `sql-N` must be
// reported, every other line must stay silent. Each marked line is one spelling of a list
// built with one SQL placeholder per value.
/** @param {any} db @param {any[]} ids @param {any[]} rows @param {string | null} named @param {number} n */
export function spellings(db, ids, rows, named, n) {
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => '?').join(',')})`); // sql-1
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => "?").join(', ')})`); // sql-2
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => `?`).join(',')})`); // sql-3
  db.prepare(`INSERT INTO t (a, b) VALUES ${rows.map(() => '(?, ?)').join(', ')}`); // sql-4
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map((_v, i) => `@f${i}`).join(',')})`); // sql-5
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map((_, i) => (named ? `@${named}${i}` : '?')).join(', ')})`); // sql-6
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(function () { return '?'; }).join(',')})`); // sql-7
  db.prepare(`SELECT * FROM t WHERE id IN (${Array(n).fill('?').join(',')})`); // sql-8
  db.prepare(`SELECT * FROM t WHERE id IN (${'?, '.repeat(n).slice(0, -2)})`); // sql-9
  db.prepare(`SELECT * FROM t WHERE id IN (${new Array(n + 1).join('?,').slice(0, -1)})`); // sql-10
  db.prepare(`SELECT * FROM t WHERE id IN (${Array.from({ length: n }, () => '?').join(',')})`); // sql-11
  db.prepare(`SELECT * FROM t WHERE id IN (${ids.map((_v, i) => `:d${i}`).join(',')})`); // sql-12
}

/** @param {any} db @param {any[]} ids @param {string} alias @param {string} url */
export function silent(db, ids, alias, url) {
  // One parameter for the whole list.
  db.prepare('SELECT * FROM t WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
  // A fixed subquery or two columns are no value list.
  db.prepare(`SELECT * FROM t WHERE ${alias}.id IN (${alias}.a, ${alias}.b)`);
  // A single placeholder as a default, a map that builds something else.
  const bind = '?';
  db.prepare(`SELECT * FROM t WHERE a = ${bind}`);
  ids.map((id) => `${alias}.${id}`);
  ids.map((id) => id.split('?')[0]);
  ids.map(() => 'x');
  return [url.split('?')[0], ids.join(', '), ids.map(String).join(',')];
}
