export default {
    version: 4,
    description: 'Allow "none" priority and set it as default',
    up: `
      -- SQLite erlaubt kein ALTER CHECK, daher Tabelle neu erstellen
      CREATE TABLE tasks_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT    NOT NULL,
        description     TEXT,
        category        TEXT    NOT NULL DEFAULT 'Sonstiges',
        priority        TEXT    NOT NULL DEFAULT 'none'
                                CHECK(priority IN ('none', 'low', 'medium', 'high', 'urgent')),
        status          TEXT    NOT NULL DEFAULT 'open'
                                CHECK(status IN ('open', 'in_progress', 'done')),
        due_date        TEXT,
        due_time        TEXT,
        assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_recurring    INTEGER NOT NULL DEFAULT 0,
        recurrence_rule TEXT,
        parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO tasks_new SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX IF NOT EXISTS idx_tasks_status         ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned       ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent         ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due            ON tasks(due_date);
    `,
  };
