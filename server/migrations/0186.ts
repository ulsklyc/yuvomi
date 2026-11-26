export default {
    version: 186,
    description: 'Schedule: extra shifts, additive to the primary pattern/override slot (on-call alongside a regular shift)',
    // Bewusst OHNE UNIQUE(user_id, date_key) - anders als schedule_overrides,
    // dessen genau eine Zeile je Tag der ganze Punkt ist. Ein "extra" ist
    // additiv zu dem, was resolveEntries() fuer den Tag ohnehin ausgibt (auch
    // wenn das nichts ist - ein reiner Bereitschaftstag ohne regulaere Schicht
    // braucht keine Sonderbehandlung), nie ein Ersatz dafuer, daher beliebig
    // viele Zeilen je Nutzer und Tag, auch mit demselben shift_type_id.
    // shift_type_id ist NOT NULL, weil ein Extra nur existiert, um eine
    // zusaetzliche Schicht hinzuzufuegen - anders als bei einem Override gibt
    // es kein "Extra, das ausdruecklich frei bedeutet".
    up: `
      CREATE TABLE schedule_extra_shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date_key TEXT NOT NULL,
        shift_type_id INTEGER NOT NULL REFERENCES schedule_shift_types(id) ON DELETE RESTRICT,
        note TEXT,
        reminder_offset_minutes INTEGER,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX idx_schedule_extra_shifts_user ON schedule_extra_shifts(user_id, date_key);
    `,
  };
