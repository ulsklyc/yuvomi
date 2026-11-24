// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 165,
    description: 'Schedule: cycle patterns and per-day overrides (#786)',
    up: `
      CREATE TABLE IF NOT EXISTS schedule_shift_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, short_code TEXT,
        start_time TEXT, end_time TEXT, color TEXT NOT NULL DEFAULT '#6C3AED',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        CHECK ((start_time IS NULL) = (end_time IS NULL))
      );
      CREATE TABLE IF NOT EXISTS schedule_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, anchor_date TEXT NOT NULL,
        cycle_length INTEGER NOT NULL CHECK (cycle_length BETWEEN 1 AND 366),
        valid_from TEXT, valid_until TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS schedule_pattern_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id INTEGER NOT NULL REFERENCES schedule_patterns(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        shift_type_id INTEGER REFERENCES schedule_shift_types(id) ON DELETE RESTRICT,
        UNIQUE (pattern_id, position)
      );
      CREATE TABLE IF NOT EXISTS schedule_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date_key TEXT NOT NULL, shift_type_id INTEGER REFERENCES schedule_shift_types(id) ON DELETE RESTRICT,
        note TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (user_id, date_key)
      );
      CREATE INDEX idx_schedule_patterns_user ON schedule_patterns(user_id);
      CREATE INDEX idx_schedule_overrides_user ON schedule_overrides(user_id, date_key);
      CREATE TRIGGER trg_schedule_shift_types_updated_at AFTER UPDATE ON schedule_shift_types FOR EACH ROW BEGIN
        UPDATE schedule_shift_types SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE TRIGGER trg_schedule_patterns_updated_at AFTER UPDATE ON schedule_patterns FOR EACH ROW BEGIN
        UPDATE schedule_patterns SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
    afterUp(db) {
      const row = db.prepare("SELECT value FROM sync_config WHERE key = 'disabled_modules'").get();
      let disabled = [];
      try { const parsed = JSON.parse(row?.value || '[]'); if (Array.isArray(parsed)) disabled = parsed.filter((key) => typeof key === 'string'); } catch { /* replace invalid legacy value */ }
      if (!disabled.includes('schedule')) disabled.push('schedule');
      db.prepare("INSERT INTO sync_config (key, value) VALUES ('disabled_modules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')").run(JSON.stringify(disabled));
    },
  };
