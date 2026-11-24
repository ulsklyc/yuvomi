// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 37,
    description: 'Document folders and housekeeping receipt linkage',
    up: `
      CREATE TABLE IF NOT EXISTS family_document_folders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_family_document_folders_updated_at
        AFTER UPDATE ON family_document_folders FOR EACH ROW
        BEGIN UPDATE family_document_folders SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      ALTER TABLE family_documents ADD COLUMN folder_id INTEGER REFERENCES family_document_folders(id) ON DELETE SET NULL;
      ALTER TABLE housekeeping_work_sessions ADD COLUMN receipt_document_id INTEGER REFERENCES family_documents(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_family_documents_folder ON family_documents(folder_id);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_receipt ON housekeeping_work_sessions(receipt_document_id);
    `,
  };
