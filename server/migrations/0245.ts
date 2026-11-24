export default {
    version: 245,
    description: 'Calendar: first-class local calendars with per-calendar feeds',
    up: `
      CREATE TABLE local_calendars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        color       TEXT    NOT NULL DEFAULT '#007AFF',
        is_default  INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        feed_token  TEXT UNIQUE,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE UNIQUE INDEX idx_local_calendars_default
        ON local_calendars(is_default) WHERE is_default = 1;
      CREATE INDEX idx_local_calendars_sort ON local_calendars(sort_order, name);
      CREATE TRIGGER trg_local_calendars_updated_at
        AFTER UPDATE ON local_calendars FOR EACH ROW
        BEGIN UPDATE local_calendars SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- Local calendar moves never push outward (see MIRRORED_FIELDS).
      ALTER TABLE calendar_events ADD COLUMN local_calendar_id INTEGER
        REFERENCES local_calendars(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_calendar_local_calendar ON calendar_events(local_calendar_id);

      INSERT INTO local_calendars (name, color, is_default, sort_order, created_by)
      SELECT 'Yuvomi', '#007AFF', 1, 0, NULL
      WHERE NOT EXISTS (SELECT 1 FROM local_calendars WHERE is_default = 1);
      CREATE TRIGGER IF NOT EXISTS trg_event_local_calendar_insert
      BEFORE INSERT ON calendar_events
      WHEN NEW.local_calendar_id IS NOT NULL AND (NEW.external_source IS NOT 'local'
        OR NEW.target_google_calendar_id IS NOT NULL OR NEW.target_caldav_account_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'Local and sync calendars are mutually exclusive'); END;
      CREATE TRIGGER IF NOT EXISTS trg_event_local_calendar_update
      BEFORE UPDATE OF local_calendar_id, external_source, target_google_calendar_id, target_caldav_account_id ON calendar_events
      WHEN NEW.local_calendar_id IS NOT NULL AND (NEW.external_source IS NOT 'local'
        OR NEW.target_google_calendar_id IS NOT NULL OR NEW.target_caldav_account_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'Local and sync calendars are mutually exclusive'); END;
    `,
  };
