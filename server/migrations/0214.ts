export default {
    version: 214,
    description: 'Tasks: record who did a completed task, next to who ticked it off (#1205)',
    // ZWEI PERSONEN AN EINER ERLEDIGUNG, WEIL ES ZWEI FRAGEN SIND. `user_id`
    // beantwortet weiter "wer hat abgehakt" und behaelt seine Bedeutung
    // unveraendert - jede Stelle, die es heute liest, bleibt richtig. Die neue
    // Spalte beantwortet "wer hat es getan". Auf einem geteilten Tablett (#913)
    // sind das regelmaessig verschiedene Personen, und bis hierher konnte die
    // zweite Frage gar nicht gestellt werden (#1205).
    //
    // NULL IST DER NORMALFALL UND BEDEUTET "NICHT BENANNT", NICHT "NIEMAND".
    // Ohne Angabe bleibt alles wie bisher: die Anzeige faellt auf `user_id`
    // zurueck, die Punkte folgen weiter der Zuweisungsregel. Bestandszeilen
    // bekommen deshalb bewusst KEINEN Backfill auf `user_id` - das waere eine
    // erfundene Behauptung ueber Erledigungen, bei denen nie jemand gefragt
    // wurde, wer sie getan hat.
    //
    // SET NULL wie bei `user_id` daneben: verlaesst die Person den Haushalt,
    // verliert der Eintrag seinen Verweis, nicht seine Existenz - der Vorgang
    // hat stattgefunden.
    up: `
      ALTER TABLE task_completions ADD COLUMN done_by_user_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL;

      -- Der Verlauf filtert nach der Person, die er ANZEIGT, also nach
      -- COALESCE(done_by_user_id, user_id). Ein Index auf der neuen Spalte
      -- allein traegt diesen Ausdruck nicht; er steht hier fuer den zweiten
      -- Leser, der "was hat diese Person getan" direkt fragt.
      CREATE INDEX IF NOT EXISTS idx_task_completions_done_by
        ON task_completions(done_by_user_id);
    `,
  };
