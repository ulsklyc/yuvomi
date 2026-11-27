export default {
    version: 285,
    description: 'Native passkey credentials and single-use session-bound challenges',
    up: `
    CREATE TABLE IF NOT EXISTS user_passkey_handles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      user_handle TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS user_passkeys (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);
    CREATE TABLE IF NOT EXISTS passkey_challenges (
      challenge TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL,
      client_hash TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('register', 'authenticate')),
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      UNIQUE(session_hash, operation)
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_challenges_client ON passkey_challenges(client_hash, expires_at) WHERE user_id IS NULL;
`,
};
