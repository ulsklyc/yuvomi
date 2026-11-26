// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 52,
    description: 'DMS: add papra provider, org_id column, updated unique constraint',
    up(db) {
      // SQLite fires ON DELETE SET NULL when the referenced parent table is dropped
      // (even via DROP TABLE, not just individual DELETE statements). Save and restore
      // dms_account_id values around the table rebuild so existing DMS-linked documents
      // keep their account references after the migration.
      db.exec(`
        CREATE TEMP TABLE _m52_refs AS
          SELECT id, dms_account_id FROM family_documents WHERE dms_account_id IS NOT NULL;
        UPDATE family_documents SET dms_account_id = NULL WHERE dms_account_id IS NOT NULL;

        CREATE TABLE dms_accounts_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          provider    TEXT    NOT NULL DEFAULT 'paperless'
                                CHECK(provider IN ('paperless', 'papra')),
          name        TEXT    NOT NULL,
          base_url    TEXT    NOT NULL,
          org_id      TEXT    NOT NULL DEFAULT '',
          api_token   TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_check  TEXT,
          UNIQUE(base_url, org_id)
        );
        INSERT INTO dms_accounts_new (id, provider, name, base_url, org_id, api_token, created_at, last_check)
          SELECT id, provider, name, base_url, '', api_token, created_at, last_check FROM dms_accounts;
        DROP TABLE dms_accounts;
        ALTER TABLE dms_accounts_new RENAME TO dms_accounts;
        CREATE INDEX IF NOT EXISTS idx_family_documents_dms ON family_documents(dms_account_id);

        UPDATE family_documents
          SET dms_account_id = (SELECT dms_account_id FROM _m52_refs r WHERE r.id = family_documents.id)
          WHERE id IN (SELECT id FROM _m52_refs);
        DROP TABLE _m52_refs;
      `);
    },
  };
