export default {
    version: 26,
    description: 'Family documents with local storage metadata and visibility ACL',
    up: `
      CREATE TABLE IF NOT EXISTS family_documents (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL,
        description      TEXT,
        category         TEXT    NOT NULL DEFAULT 'other'
                                  CHECK(category IN ('medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other')),
        status           TEXT    NOT NULL DEFAULT 'active'
                                  CHECK(status IN ('active', 'archived')),
        visibility       TEXT    NOT NULL DEFAULT 'family'
                                  CHECK(visibility IN ('family', 'restricted', 'private')),
        original_name    TEXT    NOT NULL,
        mime_type        TEXT    NOT NULL,
        file_size        INTEGER NOT NULL,
        content_data     TEXT    NOT NULL,
        storage_provider TEXT    NOT NULL DEFAULT 'local'
                                  CHECK(storage_provider IN ('local', 'external')),
        storage_key      TEXT,
        created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS family_document_access (
        document_id INTEGER NOT NULL REFERENCES family_documents(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (document_id, user_id)
      );

      CREATE TRIGGER IF NOT EXISTS trg_family_documents_updated_at
        AFTER UPDATE ON family_documents FOR EACH ROW
        BEGIN UPDATE family_documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_family_documents_status     ON family_documents(status);
      CREATE INDEX IF NOT EXISTS idx_family_documents_category   ON family_documents(category);
      CREATE INDEX IF NOT EXISTS idx_family_documents_created_by ON family_documents(created_by);
      CREATE INDEX IF NOT EXISTS idx_family_document_access_user ON family_document_access(user_id);
    `,
  };
