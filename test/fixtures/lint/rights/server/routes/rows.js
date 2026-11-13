// Rights fixture (phase 2, B8c): a visibility level compared in JavaScript outside
// server/authorize/. test:lint-baseline lints this tree with the real .oxlintrc.json and
// expects exactly the lines marked `rights-N: TAG`; every other line must stay silent.
/**
 * @param {any} row @param {any} a @param {any} stmt @param {number} id @param {string} visibility
 * @param {string} open @param {string} OPEN_FAMILY @param {string[]} VISIBILITIES @param {any} db
 */
export function rows(row, a, stmt, id, visibility, open, OPEN_FAMILY, VISIBILITIES, db) {
  const out = [];
  if (row.visibility === 'all') out.push(1);                     // rights-1: RIGHTS-ROW (member)
  if (row.visibility !== 'all') out.push(2);                     // rights-2: RIGHTS-ROW (member, !==)
  if (a.b.visibility !== 'private') out.push(3);                 // rights-3: RIGHTS-ROW (deep member)
  if (stmt.get(id).visibility === 'family') out.push(4);         // rights-4: RIGHTS-ROW (behind a call)
  if (row?.visibility === 'family') out.push(5);                 // rights-5: RIGHTS-ROW (optional chain)
  if (stmt.get(id)?.visibility !== 'family') out.push(6);        // rights-6: RIGHTS-ROW (optional chain behind a call)
  if (visibility === 'restricted') out.push(7);                  // rights-7: RIGHTS-ROW (local variable)
  if (visibility !== 'restricted') out.push(8);                  // rights-8: RIGHTS-ROW (local variable, !==)
  if (row['visibility'] === 'all') out.push(9);                  // rights-9: RIGHTS-ROW (computed key)
  if (row['visibility'] !== 'all') out.push(10);                 // rights-10: RIGHTS-ROW (computed key, !==)
  if (row?.['visibility'] === 'all') out.push(11);               // rights-11: RIGHTS-ROW (optional computed key)
  if ('all' === row.visibility) out.push(12);                    // rights-12: RIGHTS-ROW (reversed)
  if ('all' !== visibility) out.push(13);                        // rights-13: RIGHTS-ROW (reversed, local variable)
  if ('private' === row?.visibility) out.push(14);               // rights-14: RIGHTS-ROW (reversed, optional chain)
  if (row.visibility == 'all') out.push(15);                     // rights-15: RIGHTS-ROW (loose ==)
  if (row.visibility != 'all') out.push(16);                     // rights-16: RIGHTS-ROW (loose !=)
  switch (row.visibility) { case 'all': out.push(17); break; default: break; } // rights-17: RIGHTS-ROW (switch case)
  if (['all', 'family'].includes(row.visibility)) out.push(18);  // rights-18: RIGHTS-ROW (literal list includes)
  if (['all'].includes(visibility)) out.push(19);                // rights-19: RIGHTS-ROW (literal list, local variable)
  if ((row.visibility ?? 'private') !== 'private') out.push(28);  // rights-20: RIGHTS-ROW (behind ??)
  if ((visibility || row.visibility) === 'restricted') out.push(29); // rights-21: RIGHTS-ROW (right side of ||)
  // Silent: a variable or constant level, an assignment, an object literal, SQL (that is
  // RIGHTS-SQL's), another field, null/undefined, a named list, a key held in a variable.
  if (row.visibility === open) out.push(20);
  if (row.visibility === OPEN_FAMILY) out.push(21);
  row.visibility = 'all';
  const o = { visibility: 'all' };
  const e = db.prepare('SELECT 1 FROM t WHERE visibility = ?').get('all');
  if (row.status === 'all') out.push(22);
  if (row.visibility == null || row.visibility === undefined) out.push(23);
  if (row[visibility] === 'all') out.push(24);
  if (VISIBILITIES.includes(row.visibility)) out.push(25);
  if ([open, OPEN_FAMILY].includes(row.visibility)) out.push(26);
  switch (row.status) { case 'all': out.push(27); break; default: break; }
  if ((row.status ?? 'all') === 'all') out.push(30);
  return [out, o, e];
}
