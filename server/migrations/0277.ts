// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 277,
    description: 'tasks: rotation for recurring series',
    // Eine Serie "Muell rausbringen" haengt fuer immer an einer Person.
    // Rotation ist eine reine Zustellungs-Entscheidung an der Folgeinstanz
    // (die RRULE-Engine bleibt unangetastet): Modus, Pool und der Zeiger.
    // Der Zeiger ist eine POSITION im Pool, kein Kopf: ein Mitglied, das den
    // Pool verlaesst, verschiebt den Platz des Zeigers nicht, und die
    // sichtbare Reihenfolge laeuft weiter (upstream #1763: "A pointer that
    // survives"). rotation_last_user wandert als Information mit - die
    // Reihenfolge liest es nie, genau das Lesen hat die Serie frueher beim
    // Rauswurf still nach vorn zurueckgesetzt. Modus, Pool und Zeiger wandern
    // als WERT auf jede Folgeinstanz (dasselbe Prinzip wie
    // recurrence_series_id, #1603): faellt das Ursprungs-Vorkommen, traegt
    // jede laufende Instanz ihre eigene Zuordnung weiter. Bewacht wie
    // ueblich, damit ein zweiter Lauf auf gedrifteter Datenbank nicht
    // scheitert.
    up(database) {
      const cols = database.prepare('PRAGMA table_info(tasks)').all();
      if (!cols.some((c) => c.name === 'rotation_mode')) {
        database.exec(`
          ALTER TABLE tasks ADD COLUMN rotation_mode TEXT
            CHECK (rotation_mode IS NULL OR rotation_mode IN ('round_robin'))
        `);
      }
      if (!cols.some((c) => c.name === 'rotation_last_user')) {
        database.exec('ALTER TABLE tasks ADD COLUMN rotation_last_user INTEGER REFERENCES users(id) ON DELETE SET NULL');
      }
      if (!cols.some((c) => c.name === 'rotation_last_position')) {
        database.exec('ALTER TABLE tasks ADD COLUMN rotation_last_position INTEGER');
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_rotation_pool (
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          PRIMARY KEY (task_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_rotation_pool_order
          ON task_rotation_pool(task_id, position);
      `);
    },
  };
