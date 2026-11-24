// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 33,
    description: 'Housekeeping work sessions, decay tasks, supply requests, and maintenance log',
    up: `
      CREATE TABLE IF NOT EXISTS housekeeping_work_sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        check_in   TEXT    NOT NULL,
        check_out  TEXT,
        daily_rate REAL    NOT NULL DEFAULT 0 CHECK(daily_rate >= 0),
        extras     REAL    NOT NULL DEFAULT 0 CHECK(extras >= 0),
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS housekeeping_decay_tasks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT    NOT NULL,
        area           TEXT    NOT NULL,
        frequency_days INTEGER NOT NULL CHECK(frequency_days > 0),
        last_completed TEXT,
        created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS housekeeping_supply_requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL,
        quantity         TEXT,
        shopping_item_id INTEGER REFERENCES shopping_items(id) ON DELETE SET NULL,
        created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS housekeeping_maintenance_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT    NOT NULL,
        photo_url   TEXT,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_housekeeping_work_sessions_updated_at
        AFTER UPDATE ON housekeeping_work_sessions FOR EACH ROW
        BEGIN UPDATE housekeeping_work_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_housekeeping_decay_tasks_updated_at
        AFTER UPDATE ON housekeeping_decay_tasks FOR EACH ROW
        BEGIN UPDATE housekeeping_decay_tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_housekeeping_maintenance_log_updated_at
        AFTER UPDATE ON housekeeping_maintenance_log FOR EACH ROW
        BEGIN UPDATE housekeeping_maintenance_log SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_check_in ON housekeeping_work_sessions(check_in);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_open ON housekeeping_work_sessions(check_out);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_decay_area ON housekeeping_decay_tasks(area);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_decay_completed ON housekeeping_decay_tasks(last_completed);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_supply_created ON housekeeping_supply_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_maintenance_created ON housekeeping_maintenance_log(created_at);
    `,
  };
