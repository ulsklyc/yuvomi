// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 54,
    description: 'Web Push: push_subscriptions table + reminders.pushed_at column',
    up(db) {
      db.exec(`
        CREATE TABLE push_subscriptions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint     TEXT    NOT NULL UNIQUE,
          p256dh       TEXT    NOT NULL,
          auth         TEXT    NOT NULL,
          user_agent   TEXT,
          created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_used_at TEXT
        );
        CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);
        ALTER TABLE reminders ADD COLUMN pushed_at TEXT;
      `);
    },
  };
