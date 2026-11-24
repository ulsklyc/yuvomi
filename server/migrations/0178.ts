// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 178,
    description: 'Health: graded symptom logging - normalized cycle_day_log_symptoms table, backfilled from the legacy CSV column',
    // Die alte Komma-Spalte (cycle_day_logs.symptoms) bleibt UNVERAENDERT
    // stehen - kein DROP COLUMN, kein Rebuild. Sie ist ab hier nur noch
    // historisch: neue Schreibvorgaenge (server/routes/health/cycle.js)
    // fuellen sie nicht mehr, und die API liest sie nicht mehr aus. Ein
    // rohes DB-Backup aus der Zeit vor dieser Migration bleibt trotzdem
    // lesbar, ohne dass ein zweiter Migrationspfad noetig waere.
    up: (database) => {
      database.exec(`
        CREATE TABLE cycle_day_log_symptoms (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          day_log_id  INTEGER NOT NULL REFERENCES cycle_day_logs(id) ON DELETE CASCADE,
          symptom_key TEXT    NOT NULL,
          intensity   INTEGER CHECK(intensity IS NULL OR intensity BETWEEN 1 AND 3),
          UNIQUE(day_log_id, symptom_key)
        );
        CREATE INDEX idx_cycle_day_log_symptoms_day_log ON cycle_day_log_symptoms(day_log_id);
      `);

      // Rueckwirkend aus der Komma-Liste befuellen, ohne Intensitaet (NULL) -
      // die gab es vor dieser Migration nicht, und sie zu erraten waere eine
      // erfundene Angabe, keine migrierte.
      const rows = database.prepare(
        "SELECT id, symptoms FROM cycle_day_logs WHERE symptoms IS NOT NULL AND symptoms <> ''"
      ).all();
      const insert = database.prepare(
        'INSERT OR IGNORE INTO cycle_day_log_symptoms (day_log_id, symptom_key, intensity) VALUES (?, ?, NULL)'
      );
      for (const row of rows) {
        const keys = new Set(String(row.symptoms).split(',').map((s) => s.trim()).filter(Boolean));
        for (const key of keys) insert.run(row.id, key);
      }
    },
  };
