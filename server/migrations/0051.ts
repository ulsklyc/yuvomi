export default {
    version: 51,
    description: 'Document storage backend discriminator and consistency constraints',
    up: `
      ALTER TABLE family_documents ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'local'
        CHECK(storage_backend IN ('local', 'webdav', 'dms'));

      UPDATE family_documents
      SET storage_backend = CASE storage_provider
        WHEN 'external' THEN 'dms'
        ELSE 'local'
      END;

      UPDATE family_documents
      SET dms_account_id = NULL
      WHERE storage_backend != 'dms' AND dms_account_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS trg_family_documents_storage_insert
        BEFORE INSERT ON family_documents
        FOR EACH ROW
        BEGIN
          SELECT CASE
            WHEN NOT (
              (NEW.storage_provider = 'local' AND NEW.storage_backend = 'local')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'webdav')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'dms')
            )
            THEN RAISE(ABORT, 'invalid document storage provider/backend combination')
          END;
          SELECT CASE
            WHEN NEW.storage_backend != 'dms' AND NEW.dms_account_id IS NOT NULL
            THEN RAISE(ABORT, 'dms_account_id requires dms storage backend')
          END;
        END;

      CREATE TRIGGER IF NOT EXISTS trg_family_documents_storage_update
        BEFORE UPDATE OF storage_provider, storage_backend, dms_account_id ON family_documents
        FOR EACH ROW
        BEGIN
          SELECT CASE
            WHEN NOT (
              (NEW.storage_provider = 'local' AND NEW.storage_backend = 'local')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'webdav')
              OR (NEW.storage_provider = 'external' AND NEW.storage_backend = 'dms')
            )
            THEN RAISE(ABORT, 'invalid document storage provider/backend combination')
          END;
          SELECT CASE
            WHEN NEW.storage_backend != 'dms' AND NEW.dms_account_id IS NOT NULL
            THEN RAISE(ABORT, 'dms_account_id requires dms storage backend')
          END;
        END;
    `,
  };
