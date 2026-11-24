export default {
    version: 34,
    description: 'Housekeeping worker profile and payment tracking',
    up: `
      CREATE TABLE IF NOT EXISTS housekeeping_workers (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        daily_rate       REAL    NOT NULL DEFAULT 0 CHECK(daily_rate >= 0),
        payment_schedule TEXT    NOT NULL DEFAULT 'monthly'
                                  CHECK(payment_schedule IN ('daily', 'twice_monthly', 'monthly')),
        notes            TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      ALTER TABLE housekeeping_work_sessions ADD COLUMN paid_at TEXT;

      CREATE TRIGGER IF NOT EXISTS trg_housekeeping_workers_updated_at
        AFTER UPDATE ON housekeeping_workers FOR EACH ROW
        BEGIN UPDATE housekeeping_workers SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_housekeeping_workers_user ON housekeeping_workers(user_id);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_paid ON housekeeping_work_sessions(paid_at);
    `,
  };
