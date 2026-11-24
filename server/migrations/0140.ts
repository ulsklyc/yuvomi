// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 140,
    description: 'Allow inventory_item entities in the existing reminder center (Stage 4)',
    foreignKeysOff: true,
    up: `
      -- SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher Tabelle
      -- neu erstellen (Muster wie v98/v101). foreignKeysOff ist Pflicht: mit
      -- aktiver FK-Durchsetzung wuerde DROP TABLE reminders die gekoppelten
      -- Zustellprotokolle (notification_deliveries.reminder_id ... ON DELETE
      -- CASCADE) auf jeder bestehenden Installation mitloeschen.
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item')),
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
