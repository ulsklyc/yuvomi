// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 189,
    description: 'Schedule: custom field registry, per-shift-type assignment, and per-occurrence values',
    up: `
      CREATE TABLE schedule_custom_fields (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_schedule_custom_fields_updated_at AFTER UPDATE ON schedule_custom_fields FOR EACH ROW BEGIN
        UPDATE schedule_custom_fields SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- Welche Felder an welchem Schichttyp haengen, in welcher Reihenfolge und
      -- ob der Wert in der Kalender-Overlay-Zeile mitgezeigt wird. Ein Feld
      -- (z.B. "Raum") ist einmal definiert und kann an vielen Schichttypen
      -- haengen - deshalb eine eigene Zuordnungstabelle statt einer Spalte an
      -- schedule_custom_fields.
      CREATE TABLE schedule_shift_type_fields (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_type_id    INTEGER NOT NULL REFERENCES schedule_shift_types(id) ON DELETE CASCADE,
        custom_field_id  INTEGER NOT NULL REFERENCES schedule_custom_fields(id) ON DELETE CASCADE,
        position         INTEGER NOT NULL DEFAULT 0,
        show_in_overlay  INTEGER NOT NULL DEFAULT 0 CHECK (show_in_overlay IN (0, 1)),
        UNIQUE (shift_type_id, custom_field_id)
      );
      CREATE INDEX idx_schedule_shift_type_fields_type ON schedule_shift_type_fields(shift_type_id, position);

      -- Der eigentliche Wert je Vorkommen. entry_id ist bewusst OHNE echten
      -- Fremdschluessel (polymorph ueber drei Elterntabellen - schedule_pattern_days,
      -- schedule_overrides, schedule_extra_shifts - dasselbe Zugestaendnis wie
      -- reminders.entity_id). custom_field_id zeigt dagegen immer auf genau eine
      -- Tabelle und traegt deshalb einen echten Fremdschluessel. "Keine Zeile"
      -- heisst "nicht gesetzt" - eine leere Zeichenkette wird nie gespeichert.
      CREATE TABLE schedule_custom_field_values (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_type       TEXT    NOT NULL CHECK (entry_type IN ('pattern_day', 'override', 'extra_shift')),
        entry_id         INTEGER NOT NULL,
        custom_field_id  INTEGER NOT NULL REFERENCES schedule_custom_fields(id) ON DELETE CASCADE,
        value            TEXT    NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
        UNIQUE (entry_type, entry_id, custom_field_id)
      );
      CREATE INDEX idx_schedule_custom_field_values_entry ON schedule_custom_field_values(entry_type, entry_id);
    `,
  };
