// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 29,
    description: 'Generic CalDAV multi-account support',
    up: (db) => {
      // Create caldav_accounts table
      db.exec(`
        CREATE TABLE caldav_accounts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL,
          caldav_url      TEXT NOT NULL,
          username        TEXT NOT NULL,
          password        TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_sync       TEXT,
          UNIQUE(caldav_url, username)
        )
      `);

      // Create caldav_calendar_selection table
      db.exec(`
        CREATE TABLE caldav_calendar_selection (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id      INTEGER NOT NULL,
          calendar_url    TEXT NOT NULL,
          calendar_name   TEXT NOT NULL,
          calendar_color  TEXT,
          enabled         INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
          UNIQUE(account_id, calendar_url)
        )
      `);

      // Create index for performance
      db.exec(`
        CREATE INDEX idx_caldav_selection_enabled
          ON caldav_calendar_selection(account_id, enabled)
      `);

      // Update external_calendars to allow 'caldav' source
      db.exec(`
        CREATE TABLE external_calendars_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          source      TEXT    NOT NULL CHECK(source IN ('google', 'apple', 'caldav')),
          external_id TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          color       TEXT,
          UNIQUE(source, external_id)
        )
      `);

      db.exec(`
        INSERT INTO external_calendars_new (id, source, external_id, name, color)
        SELECT id, source, external_id, name, color
        FROM external_calendars
      `);

      db.exec(`DROP TABLE external_calendars`);
      db.exec(`ALTER TABLE external_calendars_new RENAME TO external_calendars`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ext_cal_source ON external_calendars(source, external_id)`);

      // Migrate existing Apple data
      const appleUrl = db.prepare("SELECT value FROM sync_config WHERE key='apple_caldav_url'").get()?.value;
      const appleUser = db.prepare("SELECT value FROM sync_config WHERE key='apple_username'").get()?.value;
      const applePwd = db.prepare("SELECT value FROM sync_config WHERE key='apple_app_password'").get()?.value;
      const appleLastSync = db.prepare("SELECT value FROM sync_config WHERE key='apple_last_sync'").get()?.value;

      if (appleUrl && appleUser && applePwd) {
        // Insert migrated Apple account
        const result = db.prepare(`
          INSERT INTO caldav_accounts (name, caldav_url, username, password, last_sync)
          VALUES (?, ?, ?, ?, ?)
        `).run('Apple Calendar (migriert)', appleUrl, appleUser, applePwd, appleLastSync);

        const accountId = result.lastInsertRowid;

        // Migrate Apple calendars from external_calendars
        const appleCalendars = db.prepare(`
          SELECT external_id, name, color FROM external_calendars WHERE source='apple'
        `).all();

        for (const cal of appleCalendars) {
          db.prepare(`
            INSERT INTO caldav_calendar_selection
              (account_id, calendar_url, calendar_name, calendar_color, enabled)
            VALUES (?, ?, ?, ?, 1)
          `).run(accountId, cal.external_id, cal.name, cal.color);
        }

        // Update external_calendars source
        db.prepare(`UPDATE external_calendars SET source='caldav' WHERE source='apple'`).run();

      }

      // Add caldav to external_source CHECK constraint by recreating table
      db.exec(`
        CREATE TABLE calendar_events_new (
          id                           INTEGER PRIMARY KEY AUTOINCREMENT,
          title                        TEXT    NOT NULL,
          description                  TEXT,
          start_datetime               TEXT    NOT NULL,
          end_datetime                 TEXT,
          all_day                      INTEGER NOT NULL DEFAULT 0,
          location                     TEXT,
          color                        TEXT    NOT NULL DEFAULT '#007AFF',
          assigned_to                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_by                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          external_calendar_id         TEXT,
          external_source              TEXT    NOT NULL DEFAULT 'local'
                                               CHECK(external_source IN ('local', 'google', 'apple', 'ics', 'caldav')),
          recurrence_rule              TEXT,
          subscription_id              INTEGER REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
          user_modified                INTEGER NOT NULL DEFAULT 0,
          calendar_ref_id              INTEGER REFERENCES external_calendars(id) ON DELETE SET NULL,
          icon                         TEXT    NOT NULL DEFAULT 'calendar',
          attachment_name              TEXT,
          attachment_mime              TEXT,
          attachment_size              INTEGER,
          attachment_data              TEXT,
          target_caldav_account_id     INTEGER,
          target_caldav_calendar_url   TEXT,
          created_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `);

      db.exec(`
        INSERT INTO calendar_events_new
          (id, title, description, start_datetime, end_datetime, all_day, location, color,
           assigned_to, created_by, external_calendar_id, external_source, recurrence_rule,
           subscription_id, user_modified, calendar_ref_id, icon,
           attachment_name, attachment_mime, attachment_size, attachment_data,
           created_at, updated_at)
        SELECT id, title, description, start_datetime, end_datetime, all_day, location, color,
               assigned_to, created_by, external_calendar_id,
               CASE WHEN external_source = 'apple' THEN 'caldav' ELSE external_source END,
               recurrence_rule, subscription_id, user_modified, calendar_ref_id, icon,
               attachment_name, attachment_mime, attachment_size, attachment_data,
               created_at, updated_at
        FROM calendar_events
      `);

      db.exec(`DROP TRIGGER IF EXISTS trg_calendar_events_updated_at`);
      db.exec(`DROP TABLE calendar_events`);
      db.exec(`ALTER TABLE calendar_events_new RENAME TO calendar_events`);

      db.exec(`
        CREATE TRIGGER trg_calendar_events_updated_at
          AFTER UPDATE ON calendar_events FOR EACH ROW
          BEGIN UPDATE calendar_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_datetime)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_assigned ON calendar_events(assigned_to)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_external_id ON calendar_events(external_calendar_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_sub ON calendar_events(subscription_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_events_ref ON calendar_events(calendar_ref_id)`);
      db.exec(`CREATE UNIQUE INDEX idx_calendar_sub_extid ON calendar_events (subscription_id, external_calendar_id)`);
    },
  };
