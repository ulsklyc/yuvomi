export default {
    version: 138,
    description: 'Inventory: link items to documents from the Documents module (Stage 2)',
    up: `
      -- Spiegelt budget_entry_attachments 1:1 (server/db.js, Migration 112):
      -- gleiche Spaltenform, gleiche CASCADE-Begruendung. Das Dokument selbst
      -- bleibt beim Loeschen des Gegenstands im Dokumente-Modul erhalten -
      -- CASCADE steht nur auf der Verknuepfungszeile, nicht auf family_documents.
      CREATE TABLE IF NOT EXISTS inventory_item_documents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id     INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(item_id, document_id)
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_item_documents_item
        ON inventory_item_documents(item_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_item_documents_document
        ON inventory_item_documents(document_id);
    `,
  };
