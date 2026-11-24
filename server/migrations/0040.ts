// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 40,
    description: 'Restricted Split guest accounts',
    up: `
      CREATE TABLE IF NOT EXISTS split_expense_guest_users (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        group_id   INTEGER REFERENCES expense_groups(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT OR IGNORE INTO split_expense_guest_users (user_id, group_id, created_by, created_at)
      SELECT a.entity_id, a.group_id, a.actor_id, a.created_at
      FROM expense_activity a
      WHERE a.type = 'guest_created'
        AND a.entity_type = 'member'
        AND a.entity_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_split_guest_group ON split_expense_guest_users(group_id);
    `,
  };
