// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 188,
    description: 'Schedule: multiple pattern days at the same cycle position (timetables, not just one shift/day)',
    foreignKeysOff: true,
    // schedule_pattern_days trug bisher UNIQUE(pattern_id, position) - genau
    // EIN Schichttyp je Zyklustag. Fuer einen Stunden-/Vorlesungsplan reicht
    // das nicht: ein Wochentag traegt dort mehrere Bloecke zu verschiedenen
    // Zeiten (Mathe 8-9, Bio 9-10, ...), jeder sein eigener shift_type_id.
    // SQLite kennt kein ALTER TABLE ... DROP CONSTRAINT, daher der Neubau -
    // rein additiv/rueckwirkungsfrei, jede bestehende Zeile erfuellt die
    // lockerere Form schon 1:1.
    //
    // schedule_reminder_entries traegt pattern_day_id bereits seit ihrer
    // Entstehung (Migration 184) - kein zweiter Rebuild hier noetig, siehe
    // deren eigener Kommentar.
    up: `
      CREATE TABLE schedule_pattern_days_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id INTEGER NOT NULL REFERENCES schedule_patterns(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        shift_type_id INTEGER REFERENCES schedule_shift_types(id) ON DELETE RESTRICT
      );
      INSERT INTO schedule_pattern_days_new (id, pattern_id, position, shift_type_id)
        SELECT id, pattern_id, position, shift_type_id FROM schedule_pattern_days;
      DROP TABLE schedule_pattern_days;
      ALTER TABLE schedule_pattern_days_new RENAME TO schedule_pattern_days;
      CREATE INDEX idx_schedule_pattern_days_pattern_position ON schedule_pattern_days(pattern_id, position);
    `,
  };
