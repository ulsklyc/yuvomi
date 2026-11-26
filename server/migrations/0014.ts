export default {
    version: 14,
    description: 'External calendar metadata (name, color) and event association',
    up: `
      CREATE TABLE IF NOT EXISTS external_calendars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT    NOT NULL CHECK(source IN ('google', 'apple')),
        external_id TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        color       TEXT,
        UNIQUE(source, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ext_cal_source ON external_calendars(source, external_id);

      ALTER TABLE calendar_events ADD COLUMN calendar_ref_id INTEGER
        REFERENCES external_calendars(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_cal_events_ref ON calendar_events(calendar_ref_id);
    `,
  };
