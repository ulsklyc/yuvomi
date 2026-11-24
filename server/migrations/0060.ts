export default {
    version: 60,
    description: 'add notification channel delivery tracking',
    up: `
      CREATE TABLE IF NOT EXISTS notification_channels (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        provider        TEXT    NOT NULL,
        name            TEXT    NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 0,
        scope           TEXT    NOT NULL DEFAULT 'household',
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        config_json     TEXT    NOT NULL DEFAULT '{}',
        secret_json     TEXT    NOT NULL DEFAULT '{}',
        last_test_at    TEXT,
        last_success_at TEXT,
        last_error      TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_notification_channels_provider
        ON notification_channels(provider);

      CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled
        ON notification_channels(enabled);

      CREATE INDEX IF NOT EXISTS idx_notification_channels_user
        ON notification_channels(user_id);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id     INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
        provider        TEXT    NOT NULL,
        channel_id      INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
        target_key      TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending'
                                  CHECK(status IN ('pending', 'sent', 'failed', 'skipped')),
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        sent_at         TEXT,
        error           TEXT,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(reminder_id, provider, target_key)
      );

      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_reminder
        ON notification_deliveries(reminder_id);

      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_retry
        ON notification_deliveries(status, next_attempt_at);
    `,
  };
