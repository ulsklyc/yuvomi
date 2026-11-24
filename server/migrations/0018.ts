// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 18,
    description: 'Birthdays with calendar integration',
    up: `
      CREATE TABLE IF NOT EXISTS birthdays (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT    NOT NULL,
        birth_date        TEXT    NOT NULL,
        notes             TEXT,
        photo_data        TEXT,
        calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
        created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_birthdays_updated_at
        AFTER UPDATE ON birthdays FOR EACH ROW
        BEGIN UPDATE birthdays SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_birthdays_name         ON birthdays(name);
      CREATE INDEX IF NOT EXISTS idx_birthdays_birth_date   ON birthdays(birth_date);
      CREATE INDEX IF NOT EXISTS idx_birthdays_created_by   ON birthdays(created_by);
      CREATE INDEX IF NOT EXISTS idx_birthdays_calendar_ref ON birthdays(calendar_event_id);
    `,
  };
