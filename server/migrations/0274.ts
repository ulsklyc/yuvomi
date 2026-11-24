// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 274,
    description: 'api_tokens: kind, platform, device_id for signed-in devices',
    // Ein Telefon mit nativem Client ist ein angemeldetes Geraet: eine Person mit
    // einem Device Credential. Es liegt in `api_tokens`, damit Widerruf beim
    // Deaktivieren, die CSRF-Ausnahme und jede Pruefung auf `authMethod` von
    // selbst gelten. `kind` trennt es von den Integrationen, die der Admin
    // verwaltet. Der Index haelt: ein Telefon, ein gueltiges Credential.
    up(database) {
      const cols = database.prepare('PRAGMA table_info(api_tokens)').all();
      if (!cols.some((col) => col.name === 'kind')) {
        database.exec("ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'integration'");
      }
      if (!cols.some((col) => col.name === 'platform')) {
        database.exec('ALTER TABLE api_tokens ADD COLUMN platform TEXT');
      }
      if (!cols.some((col) => col.name === 'device_id')) {
        database.exec('ALTER TABLE api_tokens ADD COLUMN device_id TEXT');
      }
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_active_device
          ON api_tokens (subject_user_id, device_id)
          WHERE kind = 'device' AND revoked_at IS NULL
      `);
    },
  };
