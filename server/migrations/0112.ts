export default {
    version: 112,
    description: 'budget entries: receipt/document attachments (#583)',
    up: `
      -- Belege an Buchungen (#583). Eigene Tabelle statt einer Spalte auf
      -- budget_entries, weil ein Kauf mehr als einen Beleg tragen kann
      -- (Kassenbon + Rechnung + Garantie). Spiegelt bewusst expense_attachments,
      -- damit Split-Expenses und Budget dieselbe Form haben.
      --
      -- Kein kind-Feld: expense_attachments führt eines, das dort nie gesetzt
      -- wird. Eine Spalte, die immer denselben Wert hätte, bleibt hier weg.
      --
      -- ON DELETE CASCADE auf beiden Seiten: verschwindet die Buchung, ist die
      -- Verknüpfung sinnlos; verschwindet das Dokument, zeigt sie ins Leere. Das
      -- Dokument selbst bleibt beim Löschen der Buchung erhalten - es lebt im
      -- Dokumenten-Modul weiter und kann dort an anderer Stelle hängen.
      CREATE TABLE IF NOT EXISTS budget_entry_attachments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id    INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(entry_id, document_id)
      );

      CREATE INDEX IF NOT EXISTS idx_budget_entry_attachments_entry
        ON budget_entry_attachments(entry_id);
      CREATE INDEX IF NOT EXISTS idx_budget_entry_attachments_document
        ON budget_entry_attachments(document_id);
    `,
  };
