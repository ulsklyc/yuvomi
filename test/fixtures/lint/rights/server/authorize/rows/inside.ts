// Rights fixture (phase 2, B5, B8c): the same spellings under server/authorize/ are the rule
// itself and stay silent.
export function inside(db: any, perms: any, row: any, visibility: string): unknown[] {
  const a = db.prepare(`SELECT * FROM t WHERE t.visibility = 'all' AND x = ?`).all(1);
  const b = db.prepare("SELECT * FROM q WHERE q.visibility <> 'private'").all();
  const c = perms.modules.health === 'none';
  const d = row.visibility === 'all' || row?.visibility !== 'family' || row['visibility'] == 'all';
  const e = visibility === 'restricted' || 'all' === row.visibility;
  const f = ['all', 'family'].includes(row.visibility);
  switch (row.visibility) { case 'private': return [a, b, c, d, e, f]; default: break; }
  return [a, b, c, d, e, f];
}
