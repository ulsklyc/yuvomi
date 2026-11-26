export default {
    version: 8,
    description: 'Reminders for tasks and calendar events',
    up: `
      CREATE TABLE IF NOT EXISTS reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event')),
        entity_id   INTEGER NOT NULL,
        remind_at   TEXT    NOT NULL,
        dismissed   INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_entity ON reminders(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_user   ON reminders(created_by);
    `,
  };
