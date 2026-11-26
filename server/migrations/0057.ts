export default {
    version: 57,
    description: 'Allow subscription entities in the existing reminder center',
    up: `
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription')),
        entity_id   INTEGER NOT NULL,
        remind_at   TEXT    NOT NULL,
        dismissed   INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      INSERT INTO reminders_new (id, entity_type, entity_id, remind_at, dismissed, created_by, created_at)
        SELECT id, entity_type, entity_id, remind_at, dismissed, created_by, created_at FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_new RENAME TO reminders;
      CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
      CREATE INDEX idx_reminders_remind ON reminders(remind_at);
      CREATE INDEX idx_reminders_user ON reminders(created_by);
    `,
  };
