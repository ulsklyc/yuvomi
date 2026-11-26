// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 47,
    description: 'Multiple Google calendars: per-calendar selection + sync token, per-event Google target',
    up: `
      CREATE TABLE IF NOT EXISTS google_calendar_selection (
        calendar_id  TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        color        TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        sync_token   TEXT,
        last_sync    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_google_selection_enabled
        ON google_calendar_selection(enabled);

      ALTER TABLE calendar_events ADD COLUMN target_google_calendar_id TEXT;
    `,
    // Data migration: carry the single selected Google calendar (Issue #220)
    // into the new selection table so existing installs keep syncing it.
    afterUp: (database) => {
      const calId = database.prepare(
        "SELECT value FROM sync_config WHERE key = 'google_calendar_id'"
      ).get()?.value;
      const connected = database.prepare(
        "SELECT value FROM sync_config WHERE key = 'google_access_token'"
      ).get()?.value;
      if (!connected) return; // not connected → nothing to migrate

      const id = calId || 'primary';
      const meta = database.prepare(
        "SELECT name, color FROM external_calendars WHERE source = 'google' AND external_id = ?"
      ).get(id);
      const syncToken = database.prepare(
        "SELECT value FROM sync_config WHERE key = 'google_sync_token'"
      ).get()?.value || null;

      database.prepare(`
        INSERT OR IGNORE INTO google_calendar_selection
          (calendar_id, name, color, enabled, sync_token)
        VALUES (?, ?, ?, 1, ?)
      `).run(id, meta?.name || id, meta?.color || null, syncToken);
    },
  };
