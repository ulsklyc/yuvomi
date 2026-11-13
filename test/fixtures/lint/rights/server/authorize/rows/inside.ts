// Rights fixture (phase 2, B5): the same spellings under server/authorize/ are the rule
// itself and stay silent.
export function inside(db: any, perms: any): unknown[] {
  const a = db.prepare(`SELECT * FROM t WHERE t.visibility = 'all' AND x = ?`).all(1);
  const b = db.prepare("SELECT * FROM q WHERE q.visibility <> 'private'").all();
  const c = perms.modules.health === 'none';
  return [a, b, c];
}
