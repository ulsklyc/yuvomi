// Rights fixture (phase 2, B5): a visibility rule spelled in SQL, or a module level
// compared with 'none', outside server/authorize/. test:lint-baseline lints this tree
// with the real .oxlintrc.json and expects exactly the lines marked `rights-N: TAG`
// (a line comment, or a block comment before a template that runs over lines);
// every other line must stay silent.
/**
 * @param {any} db @param {string} alias @param {any} perms @param {any} resolve
 * @param {any} u @param {any} row
 */
export function reads(db, alias, perms, resolve, u, row) {
  const a = db.prepare(`SELECT * FROM t WHERE t.visibility = 'all' AND x = ?`).all(1); // rights-1: RIGHTS-SQL (template)
  const b = db.prepare("SELECT * FROM q WHERE q.visibility <> 'private'").all();      // rights-2: RIGHTS-SQL (string)
  const c = `x ${alias}.visibility IN ('a','b') y`;                                    // rights-3: RIGHTS-SQL (after an interpolation)
  const d = /* rights-4: RIGHTS-SQL (IN over a line break) */ db.prepare(`
    SELECT * FROM n WHERE n.visibility IN
      ('all', 'assignees')
  `).all();
  db.prepare(`UPDATE t SET visibility = 'private' WHERE id = ?`).run(1);                // rights-5: RIGHTS-SQL (a write filter: an exception with a reason)
  const g = db.prepare(`SELECT * FROM t WHERE t.visibility NOT IN ('private')`).all();  // rights-6: RIGHTS-SQL (NOT IN)
  const h = db.prepare("select * from t where t.visibility in ('all')").all();           // rights-7: RIGHTS-SQL (lower case)
  const k = db.prepare(`SELECT * FROM t WHERE t.visibility != 'private'`).all();        // rights-8: RIGHTS-SQL (!=)
  if (perms.modules.health === 'none') return null;                                     // rights-9: RIGHTS-MODULE
  if (resolve(u).modules.tasks !== 'none') return null;                                 // rights-10: RIGHTS-MODULE (behind a call)
  if ('none' === perms.modules.notes) return null;                                      // rights-11: RIGHTS-MODULE (reversed)
  if (perms.modules.budget != 'none') return null;                                      // rights-12: RIGHTS-MODULE (loose comparison)
  // Silent: a JS comparison of a row, a bind parameter, another level, a comment.
  // SELECT * FROM t WHERE t.visibility = 'all'
  const ok = row.visibility === 'all';
  const e = db.prepare(`SELECT 1 FROM t WHERE visibility = ?`).get('all');
  const f = perms.modules.health === 'read';
  return [a, b, c, d, g, h, k, ok, e, f];
}
