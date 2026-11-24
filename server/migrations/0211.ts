// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 211,
    description: 'Health: multi-select feelings per day log - normalized cycle_day_log_feelings table, backfilled from the legacy mood column',
    // Gleiches Muster wie Migration 178 (cycle_day_log_symptoms): die alte
    // Skalar-Spalte (cycle_day_logs.mood) bleibt UNVERAENDERT stehen - kein
    // DROP COLUMN, kein Rebuild. Sie ist ab hier nur noch historisch: neue
    // Schreibvorgaenge (server/routes/health/cycle.js) fuellen sie nicht mehr.
    // Die API liest sie zur Abwaertskompatibilitaet zwar noch zurueck, aber ihr
    // Wert wandert nach dieser Migration nie wieder in die Datenbank. Ein
    // rohes Backup von vor dieser Migration bleibt trotzdem lesbar, ohne einen
    // zweiten Migrationspfad zu brauchen.
    //
    // DER BACKFILL NORMALISIERT UND FILTERT: `mood` war freier Text (keine
    // Werte-Liste erzwungen), `feelings` ist seit dieser Migration ein
    // GESCHLOSSENES Set (MOOD_VALUES, sieben Schluessel: great/good/neutral/
    // sensitive/sad/irritable/anxious - public/utils/health-cycle.js). Nur
    // Werte, die (nach LOWER(TRIM(...))) in dieser Liste stehen, werden
    // uebernommen; alles andere bleibt AUSSCHLIESSLICH in der eingefrorenen
    // `mood`-Spalte lesbar. Zwei Gruende, keine Kompromisse: freier Text war
    // als Chip nie darstellbar (die UI kennt nur die sieben Presets), und eine
    // erfundene Zuordnung (z. B. "tired" -> "sensitive") waere ein Datensatz,
    // den die Person nie eingetragen hat - eine fabrizierte Aussage ist
    // schlimmer als eine fehlende.
    up: `
      CREATE TABLE cycle_day_log_feelings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        day_log_id  INTEGER NOT NULL REFERENCES cycle_day_logs(id) ON DELETE CASCADE,
        feeling_key TEXT    NOT NULL,
        UNIQUE(day_log_id, feeling_key)
      );
      CREATE INDEX idx_cycle_day_log_feelings_day_log ON cycle_day_log_feelings(day_log_id);

      -- Rueckwirkend aus der alten Skalar-Spalte befuellen: genau eine Zeile
      -- je Tages-Log mit gesetztem, GUELTIGEM mood-Wert. Anders als bei
      -- Migration 178 (Komma-Liste, mehrere Symptome je Zeile) ist hier keine
      -- Zerlegung noetig - mood trug schon immer genau einen Wert.
      INSERT INTO cycle_day_log_feelings (day_log_id, feeling_key)
      SELECT id, LOWER(TRIM(mood)) FROM cycle_day_logs
      WHERE mood IS NOT NULL AND TRIM(mood) <> ''
        AND LOWER(TRIM(mood)) IN ('great', 'good', 'neutral', 'sensitive', 'sad', 'irritable', 'anxious');
    `,
  };
