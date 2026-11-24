// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 204,
    description: 'Waste collection: ordinal-weekday monthly schedules (#1063 Phase 9)',
    // recurrence_kind's CHECK only allowed 'weekly'/'monthly_fixed_day' -
    // widening it (and the compound CHECK below it) to add
    // 'monthly_ordinal_weekday' needs the same CREATE+COPY+DROP+RENAME rebuild
    // as every other CHECK-widening in this file. foreignKeysOff avoids the
    // DROP TABLE step cascade-deleting every waste_schedule_overrides row
    // through its own ON DELETE CASCADE (same hazard as migrations 52/202/203).
    //
    // NO NEW COLUMNS: an ordinal-weekday schedule reuses `weekdays` (exactly
    // one code, e.g. 'MO' - not the CSV list a weekly schedule stores) and
    // `month_day` (the ordinal position: -1 for "last", 1-4 for "nth" - its
    // own CHECK already allows exactly this range, since 1-4 sits inside the
    // existing "1 BETWEEN 1 AND 31" bound). `server/services/waste-domain.js`
    // is what gives these two columns their new, kind-dependent meaning;
    // `server/services/recurrence.js`'s own `bydayOrdinal` shape (added
    // earlier in this same phase) is what actually computes the date.
    foreignKeysOff: true,
    up(db) {
      db.exec(`
        CREATE TABLE waste_schedules_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          type_id          INTEGER NOT NULL REFERENCES waste_types(id),
          recurrence_kind  TEXT    NOT NULL CHECK (recurrence_kind IN ('weekly', 'monthly_fixed_day', 'monthly_ordinal_weekday')),
          anchor_date      TEXT    NOT NULL,
          interval         INTEGER NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 52),
          weekdays         TEXT,
          month_day        INTEGER CHECK (month_day IS NULL OR month_day = -1 OR month_day BETWEEN 1 AND 31),
          valid_until      TEXT,
          active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          CHECK (
            (recurrence_kind = 'weekly' AND weekdays IS NOT NULL AND month_day IS NULL)
            OR (recurrence_kind = 'monthly_fixed_day' AND month_day IS NOT NULL AND weekdays IS NULL)
            OR (recurrence_kind = 'monthly_ordinal_weekday' AND month_day IS NOT NULL AND weekdays IS NOT NULL)
          )
        );
        INSERT INTO waste_schedules_new SELECT * FROM waste_schedules;
        DROP TABLE waste_schedules;
        ALTER TABLE waste_schedules_new RENAME TO waste_schedules;
        CREATE TRIGGER trg_waste_schedules_updated_at AFTER UPDATE ON waste_schedules FOR EACH ROW BEGIN
          UPDATE waste_schedules SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
        CREATE INDEX idx_waste_schedules_type_active ON waste_schedules(type_id, active);
      `);
    },
  };
