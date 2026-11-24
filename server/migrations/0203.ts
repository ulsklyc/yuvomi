// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 203,
    description: 'Waste collection: per-user, per-type pickup reminders (#1063 Phase 8)',
    // Same reminders-table rebuild pattern as migrations 137/141/148/162/177/
    // 184/187 (widening entity_type's CHECK, which SQLite cannot ALTER) - this
    // is the eighth. foreignKeysOff IS load-bearing here (audit finding M-11
    // corrected this comment, which previously claimed otherwise):
    // notification_deliveries.reminder_id REFERENCES reminders(id) ON DELETE
    // CASCADE (see line ~2614) - without foreignKeysOff, this rebuild's own
    // `DROP TABLE reminders` would cascade-delete every row in
    // notification_deliveries, wiping delivery history for every reminder
    // that had ever actually been pushed, not just the ones this migration
    // touches.
    foreignKeysOff: true,
    up(db) {
      db.exec(`
        CREATE TABLE reminders_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup')),
          entity_id   INTEGER NOT NULL,
          remind_at   TEXT    NOT NULL,
          dismissed   INTEGER NOT NULL DEFAULT 0,
          created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          pushed_at   TEXT,
          assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
        INSERT INTO reminders_new (id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at, assigned_from)
          SELECT id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at, assigned_from FROM reminders;
        DROP TABLE reminders;
        ALTER TABLE reminders_new RENAME TO reminders;
        CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
        CREATE INDEX idx_reminders_remind ON reminders(remind_at);
        CREATE INDEX idx_reminders_user ON reminders(created_by);
        CREATE INDEX idx_reminders_assigned_from ON reminders(assigned_from);

        -- Per (user, waste type) opt-in: enabled defaults on once a row
        -- exists, but a row only exists once a user has touched this type's
        -- settings at all (GET .../reminder-settings synthesizes an
        -- all-disabled default for every type without a row - no household-
        -- wide default-on that would silently start pushing to someone).
        -- offset_days/delivery_time are this preference's own lead-time and
        -- household-local delivery time, independent of any other module's
        -- reminder settings (Schedule's users.schedule_reminder_offset_minutes
        -- is a single household-wide-shaped scalar; Waste needs one lead time
        -- PER TYPE PER USER, so it gets its own table instead of widening
        -- that column's meaning).
        CREATE TABLE waste_reminder_settings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type_id       INTEGER NOT NULL REFERENCES waste_types(id) ON DELETE CASCADE,
          enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          offset_days   INTEGER NOT NULL DEFAULT 1,
          delivery_time TEXT    NOT NULL DEFAULT '08:00',
          created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          UNIQUE (user_id, type_id)
        );
        CREATE TRIGGER trg_waste_reminder_settings_updated_at AFTER UPDATE ON waste_reminder_settings FOR EACH ROW BEGIN
          UPDATE waste_reminder_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

        -- Anchor table (same purpose as schedule_reminder_entries/
        -- cycle_reminder_anchors): a Waste occurrence is computed on read,
        -- not a stored row, so reminders.entity_id has nothing stable to
        -- point at without this. One anchor per (user, type, date_key) -
        -- exactly the coalesced occurrence identity waste-domain.js already
        -- uses, so a moved/skipped/coalesced occurrence maps onto the same
        -- or a cleanly different anchor, never a duplicate.
        CREATE TABLE waste_reminder_entries (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type_id    INTEGER NOT NULL REFERENCES waste_types(id) ON DELETE CASCADE,
          date_key   TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          UNIQUE (user_id, type_id, date_key)
        );
        CREATE INDEX idx_waste_reminder_entries_user ON waste_reminder_entries(user_id);
      `);
    },
  };
