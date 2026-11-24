// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 17,
    description: 'API tokens for non-interactive authentication',
    up: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        token_hash   TEXT    NOT NULL UNIQUE,
        token_prefix TEXT    NOT NULL,
        created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at   TEXT,
        revoked_at   TEXT,
        last_used_at TEXT,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_created_by ON api_tokens(created_by);
    `,
  };
