export default {
    version: 55,
    description: 'Password reset tokens table',
    up: `
      CREATE TABLE password_resets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT    NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE UNIQUE INDEX idx_password_resets_hash ON password_resets(token_hash);
      CREATE INDEX idx_password_resets_user ON password_resets(user_id);
    `,
  };
