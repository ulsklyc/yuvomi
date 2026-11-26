export default {
  version: 285,
  description: 'Documents: Paperless live folders, member access and connection settings',
  up: `
  CREATE TABLE paperless_view_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    account_id INTEGER NOT NULL REFERENCES dms_accounts(id) ON DELETE CASCADE,
    view_id INTEGER CHECK(view_id > 0),
    tag_filter TEXT CHECK(tag_filter IS NULL OR (json_valid(tag_filter) AND json_type(tag_filter) = 'object')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'restricted', 'family')),
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK((view_id IS NOT NULL AND tag_filter IS NULL) OR (view_id IS NULL AND tag_filter IS NOT NULL))
  );
  CREATE INDEX idx_paperless_view_folders_account ON paperless_view_folders(account_id);
  CREATE TABLE paperless_view_folder_access (
    folder_id INTEGER NOT NULL REFERENCES paperless_view_folders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, user_id)
  );
  CREATE TABLE paperless_live_settings (
    account_id INTEGER PRIMARY KEY REFERENCES dms_accounts(id) ON DELETE CASCADE,
    token_mode TEXT NOT NULL DEFAULT 'shared' CHECK(token_mode IN ('shared', 'personal')),
    allowed_tag_ids TEXT CHECK(allowed_tag_ids IS NULL OR (json_valid(allowed_tag_ids) AND json_type(allowed_tag_ids) = 'array')),
    display_fields TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(display_fields) AND json_type(display_fields) = 'array'),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE TABLE paperless_user_tokens (
    account_id INTEGER NOT NULL REFERENCES dms_accounts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_token TEXT NOT NULL CHECK(length(api_token) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (account_id, user_id)
  );
  `,
};
