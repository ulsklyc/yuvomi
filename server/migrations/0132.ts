export default {
    version: 132,
    description: 'Tasks: archive as its own axis instead of a status value (#688)',
    up: `
      -- Das Archiv lag bisher IM Statusfeld. Wer eine erledigte Aufgabe ablegte,
      -- überschrieb damit ihr 'done' - die Aufgabe kam als unerledigt zurück, und
      -- syncTaskRewards stornierte im selben Zug die Punkte-Gutschrift (#688).
      -- Ablegen und Erledigen sind zwei Aussagen; sie brauchen zwei Felder.
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;

      -- Bestandsdaten: der frühere Status ist nicht mehr rekonstruierbar. 'done'
      -- ist die einzige belastbare Annahme - archiviert wird, was durch ist (so
      -- beschreibt es auch docs/SPEC.md), und das Archiv blendet die Zeile ohnehin
      -- aus. Ein Zurückholen zeigt sie dann als erledigt statt als offen, was der
      -- gemeldeten Erwartung entspricht. Punkte werden bewusst NICHT nachgebucht:
      -- reward_ledger hat für diese Aufgaben keine offene Buchung, und ein
      -- nachträglicher Geldsegen aus einer Migration wäre die schlechtere Überraschung.
      UPDATE tasks
         SET archived_at = COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
             status      = 'done'
       WHERE status = 'archived';

      CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
    `,
  };
