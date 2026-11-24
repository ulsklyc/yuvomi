// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 191,
    description: 'responsible members per budget entry',
    up: `
      -- WER SICH UM EINE BUCHUNG KUEMMERT (#1057) - ein Etikett, das kein Geld
      -- bewegt.
      --
      -- NICHT owner_id, und das ist der Kern der Sache: jene Spalte ist die
      -- Datenschutz-Achse. Sie steht auf der anlegenden Person fest und ist
      -- bewusst nicht aenderbar, weil die Sichtbarkeit privater Buchungen an ihr
      -- haengt. Wer sie zum Zustaendigkeitsfeld umwidmet, gibt der zustaendigen
      -- Person die Privatsemantik der Zeile mit - ein Rechtefehler, der wie ein
      -- Feature aussieht. Zustaendigkeit ist eine ZWEITE Achse.
      --
      -- EIGENE TABELLE statt einer Spalte, weil mehrere Personen sich eine
      -- Buchung teilen koennen ("die Versicherung laeuft auf uns beide") -
      -- dieselbe Form wie event_assignments und task_assignments.
      --
      -- UND KEINE FORDERUNG: hier entsteht nichts, was jemand schuldet. Das
      -- Abrechnen zwischen Personen bleibt in den geteilten Ausgaben; diese
      -- Tabelle traegt nur das Etikett.
      CREATE TABLE budget_entry_responsibles (
        entry_id INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (entry_id, user_id)
      );
      -- Fuer "zeig mir alles, wofuer Person X zustaendig ist" - die Richtung,
      -- die der Primaerschluessel nicht bedient.
      CREATE INDEX idx_budget_entry_responsibles_user ON budget_entry_responsibles(user_id);
    `,
  };
