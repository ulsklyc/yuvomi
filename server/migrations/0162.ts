export default {
    version: 162,
    description: 'Pantry: widen reminders for pantry_item so a best-before date can notify (#811)',
    foreignKeysOff: true,
    up: `
      -- DIE VIERTE ERWEITERUNG DERSELBEN SPALTE, und deshalb keine neue Mechanik.
      -- entity_type ist gewachsen: ('task','event') -> +'subscription' (v137)
      -- -> +'inventory_item','inventory_tracked_date' (v141). Ein Vorratsartikel
      -- traegt sein Mindesthaltbarkeitsdatum seit #596; gefehlt hat nur der
      -- Eintrag in dieser Liste.
      --
      -- KEINE eigene Tabelle und KEIN Vorlauf je Artikel: inventory_item_dates
      -- traegt reminder_offset_days, weil eine Frist dort einzeln gepflegt wird
      -- (TUEV, Service - eine Handvoll je Haushalt). Ein Vorrat ist Massenware;
      -- ein Feld, das niemand pro Joghurt pflegt, waere ein halb gefuelltes
      -- Feld. Der Vorlauf ist stattdessen die Schwelle, die der Haushalt schon
      -- kennt: EXPIRY_SOON_DAYS aus public/utils/pantry-status.js, dieselbe
      -- Zahl, die den Chip "laeuft bald ab" gelb faerbt. Die Meldung sagt genau
      -- diesen Zustandswechsel an; zwei Zahlen dafuer waeren zwei Wahrheiten.
      --
      -- foreignKeysOff bleibt Pflicht - gleicher Grund wie v137 und v141:
      -- notification_deliveries.reminder_id haengt mit ON DELETE CASCADE an
      -- dieser Tabelle und wuerde beim DROP TABLE leerlaufen.
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item')),
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
