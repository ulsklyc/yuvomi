export default {
    version: 98,
    description: 'Add Google Drive as a document storage backend',
    foreignKeysOff: true,
    up: `
      CREATE TABLE family_documents_new (
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
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        folder_id        INTEGER REFERENCES family_document_folders(id) ON DELETE SET NULL,
        dms_account_id   INTEGER REFERENCES dms_accounts(id) ON DELETE SET NULL,
        external_url     TEXT,
        external_meta    TEXT,
        storage_backend  TEXT    NOT NULL DEFAULT 'local'
                                  CHECK(storage_backend IN ('local', 'webdav', 'dms', 'google_drive'))
      );

      INSERT INTO family_documents_new (
        id, name, description, category, status, visibility, original_name,
        mime_type, file_size, content_data, storage_provider, storage_key,
        created_by, created_at, updated_at, folder_id, dms_account_id,
        external_url, external_meta, storage_backend
      )
      SELECT
        id, name, description, category, status, visibility, original_name,
        mime_type, file_size, content_data, storage_provider, storage_key,
        created_by, created_at, updated_at, folder_id, dms_account_id,
        external_url, external_meta, storage_backend
      FROM family_documents;

      DROP TABLE family_documents;
      ALTER TABLE family_documents_new RENAME TO family_documents;

      UPDATE family_documents
      SET visibility = CASE
        WHEN EXISTS (
          SELECT 1 FROM calendar_events e
          WHERE e.attachment_document_id = family_documents.id
            AND e.visibility = 'all'
        ) THEN 'family'
        WHEN EXISTS (
          SELECT 1 FROM calendar_events e
          WHERE e.attachment_document_id = family_documents.id
            AND e.visibility = 'assignees'
        ) THEN 'restricted'
        ELSE 'private'
      END
      WHERE EXISTS (
        SELECT 1 FROM calendar_events e
        WHERE e.attachment_document_id = family_documents.id
      );

      DELETE FROM family_document_access
      WHERE document_id IN (
        SELECT attachment_document_id
        FROM calendar_events
        WHERE attachment_document_id IS NOT NULL
      );

      INSERT OR IGNORE INTO family_document_access (document_id, user_id)
      SELECT e.attachment_document_id, ea.user_id
      FROM calendar_events e
      JOIN event_assignments ea ON ea.event_id = e.id
      WHERE e.attachment_document_id IS NOT NULL
        AND e.visibility = 'assignees'
        AND NOT EXISTS (
          SELECT 1 FROM calendar_events family_event
          WHERE family_event.attachment_document_id = e.attachment_document_id
            AND family_event.visibility = 'all'
        );

      CREATE TRIGGER trg_family_documents_updated_at
        AFTER UPDATE ON family_documents FOR EACH ROW
        BEGIN UPDATE family_documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER trg_family_documents_storage_insert
        BEFORE INSERT ON family_documents
        FOR EACH ROW
        BEGIN
          SELECT CASE
            WHEN NOT (
              (NEW.storage_provider = 'local' AND NEW.storage_backend = 'local')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'webdav')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'dms')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'google_drive')
            )
            THEN RAISE(ABORT, 'invalid document storage provider/backend combination')
          END;
          SELECT CASE
            WHEN NEW.storage_backend != 'dms' AND NEW.dms_account_id IS NOT NULL
            THEN RAISE(ABORT, 'dms_account_id requires dms storage backend')
          END;
        END;

      CREATE TRIGGER trg_family_documents_storage_update
        BEFORE UPDATE OF storage_provider, storage_backend, dms_account_id ON family_documents
        FOR EACH ROW
        BEGIN
          SELECT CASE
            WHEN NOT (
              (NEW.storage_provider = 'local' AND NEW.storage_backend = 'local')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'webdav')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'dms')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'google_drive')
            )
            THEN RAISE(ABORT, 'invalid document storage provider/backend combination')
          END;
          SELECT CASE
            WHEN NEW.storage_backend != 'dms' AND NEW.dms_account_id IS NOT NULL
            THEN RAISE(ABORT, 'dms_account_id requires dms storage backend')
          END;
        END;

      CREATE INDEX idx_family_documents_status     ON family_documents(status);
      CREATE INDEX idx_family_documents_category   ON family_documents(category);
      CREATE INDEX idx_family_documents_created_by ON family_documents(created_by);
      CREATE INDEX idx_family_documents_folder     ON family_documents(folder_id);
      CREATE INDEX idx_family_documents_dms        ON family_documents(dms_account_id);
    `,
  };
