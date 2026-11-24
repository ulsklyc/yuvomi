export default {
    version: 209,
    description: 'Health: fasting records, sparse settings, and safety acknowledgement',
    up: `
      CREATE TABLE health_fasts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_at     TEXT NOT NULL,
        end_at       TEXT,
        start_tzid   TEXT NOT NULL,
        goal_minutes INTEGER CHECK(goal_minutes IS NULL OR (goal_minutes BETWEEN 60 AND 20160 AND goal_minutes % 60 = 0)),
        rating       INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 5),
        note         TEXT CHECK(note IS NULL OR length(note) <= 2000),
        visibility   TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'family')),
        revision     INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        CHECK(end_at IS NULL OR end_at > start_at)
      );
      CREATE UNIQUE INDEX idx_health_fasts_one_active ON health_fasts(user_id) WHERE end_at IS NULL;
      CREATE INDEX idx_health_fasts_owner_interval ON health_fasts(user_id, start_at, end_at);

      CREATE TABLE health_fasting_settings (
        user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        default_goal_minutes   INTEGER CHECK(default_goal_minutes IS NULL OR (default_goal_minutes BETWEEN 60 AND 20160 AND default_goal_minutes % 60 = 0)),
        zone_mode              TEXT NOT NULL DEFAULT 'timer' CHECK(zone_mode IN ('timer', 'educational')),
        safety_acknowledged_at TEXT,
        safety_acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
    `,
  };
