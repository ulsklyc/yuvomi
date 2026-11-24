// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 141,
    description: 'Inventory: custom tracked dates per item, widen reminders for inventory_tracked_date',
    foreignKeysOff: true,
    up: `
      -- Neue Tabelle fuer frei definierbare Fristen je Gegenstand (TÜV, Service, ...).
      CREATE TABLE IF NOT EXISTS inventory_item_dates (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id              INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        label                TEXT    NOT NULL,
        date                 TEXT    NOT NULL,
        reminder_offset_days INTEGER NOT NULL DEFAULT 30 CHECK (reminder_offset_days BETWEEN 0 AND 365),
        created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_item_dates_item ON inventory_item_dates(item_id);

      CREATE TRIGGER IF NOT EXISTS trg_inventory_item_dates_updated_at
        AFTER UPDATE ON inventory_item_dates FOR EACH ROW
        BEGIN UPDATE inventory_item_dates SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- reminders.entity_type erneut erweitern (Muster wie v137): SQLite kann
      -- einen Spalten-CHECK nicht per ALTER erweitern, daher Tabelle neu
      -- erstellen. foreignKeysOff bleibt Pflicht - gleicher Grund wie v137
      -- (notification_deliveries.reminder_id ... ON DELETE CASCADE wuerde sonst
      -- beim DROP TABLE mitgeloescht).
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date')),
        entity_id   INTEGER NOT NULL,
        remind_at   TEXT    NOT NULL,
        dismissed   INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        pushed_at   TEXT
      );
      INSERT INTO reminders_new (id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at)
        SELECT id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_new RENAME TO reminders;
      CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
      CREATE INDEX idx_reminders_remind ON reminders(remind_at);
      CREATE INDEX idx_reminders_user ON reminders(created_by);
    `,
  };
