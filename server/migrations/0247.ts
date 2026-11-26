// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 247,
    description: 'waste: a source remembers the case of its last failed fetch',
    // DER FALL DES LETZTEN FEHLSCHLAGS STEHT NEBEN SEINEM TEXT (#1909). Bisher
    // trug die Quelle nur `last_error`, den englischen Text des Servers ("No
    // calendar entries in the response"), und der Quellen-Dialog zeigte ihn
    // so. `last_error_reason` haelt den Grund, den dieselbe Antwort schon als
    // `reason` trug (waste_source_fetch_*), `last_error_params` seine Zahlen
    // als JSON (Status, Grenze) - den Satz baut die App. Bestandszeilen
    // bleiben NULL: sie bekommen den allgemeinen Satz, bis der naechste Abruf
    // seinen Fall schreibt.
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(waste_sources)').all().map((c) => c.name));
      if (!columns.has('last_error_reason')) database.exec('ALTER TABLE waste_sources ADD COLUMN last_error_reason TEXT');
      if (!columns.has('last_error_params')) database.exec('ALTER TABLE waste_sources ADD COLUMN last_error_params TEXT');
    },
  };
