// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 50,
    description: 'DMS integration: dms_accounts table + external document reference columns',
    up: `
      CREATE TABLE IF NOT EXISTS dms_accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider    TEXT    NOT NULL DEFAULT 'paperless'
                              CHECK(provider IN ('paperless')),
        name        TEXT    NOT NULL,
        base_url    TEXT    NOT NULL,
        api_token   TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_check  TEXT,
        UNIQUE(base_url)  -- one DMS account per server (intentional)
      );

      ALTER TABLE family_documents ADD COLUMN dms_account_id INTEGER
        REFERENCES dms_accounts(id) ON DELETE SET NULL;
      ALTER TABLE family_documents ADD COLUMN external_url TEXT;
      -- external_meta: JSON { correspondent, tags } mirrored from the DMS for display only (not queried)
      ALTER TABLE family_documents ADD COLUMN external_meta TEXT;

      CREATE INDEX IF NOT EXISTS idx_family_documents_dms ON family_documents(dms_account_id);
    `,
  };
