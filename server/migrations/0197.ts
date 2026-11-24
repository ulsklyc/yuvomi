// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 197,
    description: 'Waste collection: types, manual schedules, per-occurrence overrides, and one-off pickups (#1063)',
    up: `
      CREATE TABLE waste_types (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        icon        TEXT    NOT NULL DEFAULT 'trash-2',
        color       TEXT    NOT NULL,
        archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_waste_types_updated_at AFTER UPDATE ON waste_types FOR EACH ROW BEGIN
        UPDATE waste_types SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_types_sort ON waste_types(archived, sort_order);

      -- recurrence_kind picks which of weekdays / month_day is authoritative for a
      -- schedule; the trailing CHECK keeps the other one NULL so a row can never
      -- carry both or neither. month_day=-1 means "last day of the month" (mirrors
      -- recurrence.js's own BYMONTHDAY=-1 convention); 1..31 means a fixed day, and
      -- anchor_date's own day-of-month must equal it (enforced in waste-domain.js,
      -- not here, since SQLite CHECK can't read a substring of another column
      -- portably across the two representations the codebase already has).
      CREATE TABLE waste_schedules (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id          INTEGER NOT NULL REFERENCES waste_types(id),
        recurrence_kind  TEXT    NOT NULL CHECK (recurrence_kind IN ('weekly', 'monthly_fixed_day')),
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
        )
      );
      CREATE TRIGGER trg_waste_schedules_updated_at AFTER UPDATE ON waste_schedules FOR EACH ROW BEGIN
        UPDATE waste_schedules SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_schedules_type_active ON waste_schedules(type_id, active);

      -- One row per exception to a schedule's calculated occurrences.
      -- replacement_date NULL = explicit skip; a date = moved. UNIQUE(schedule_id,
      -- original_date) keeps a single calculated occurrence from carrying two
      -- contradictory overrides.
      CREATE TABLE waste_schedule_overrides (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id       INTEGER NOT NULL REFERENCES waste_schedules(id) ON DELETE CASCADE,
        original_date     TEXT    NOT NULL,
        replacement_date  TEXT,
        note              TEXT,
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (schedule_id, original_date),
        CHECK (replacement_date IS NULL OR replacement_date <> original_date)
      );
      CREATE TRIGGER trg_waste_schedule_overrides_updated_at AFTER UPDATE ON waste_schedule_overrides FOR EACH ROW BEGIN
        UPDATE waste_schedule_overrides SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_schedule_overrides_schedule ON waste_schedule_overrides(schedule_id);

      -- A one-off is a domain fact (irregular/special collection), not a schedule
      -- with a fake recurrence. UNIQUE(type_id, date) keeps re-adding the same
      -- manual fact from silently duplicating an occurrence.
      CREATE TABLE waste_one_off_pickups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type_id     INTEGER NOT NULL REFERENCES waste_types(id),
        date        TEXT    NOT NULL,
        note        TEXT,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (type_id, date)
      );
      CREATE TRIGGER trg_waste_one_off_pickups_updated_at AFTER UPDATE ON waste_one_off_pickups FOR EACH ROW BEGIN
        UPDATE waste_one_off_pickups SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_one_off_pickups_type_date ON waste_one_off_pickups(type_id, date);
    `,
  };
