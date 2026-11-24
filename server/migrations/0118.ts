export default {
    version: 118,
    description: 'Mealie integration: mealie_accounts table + recipe mirror columns',
    up: `
      CREATE TABLE IF NOT EXISTS mealie_accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        base_url    TEXT    NOT NULL,
        api_token   TEXT    NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_sync   TEXT,
        last_error  TEXT,
        -- Eine Rezepttabelle je Mealie-Server: die UNIQUE-Bedingung verhindert,
        -- dass derselbe Server zweimal angelegt wird und alle Rezepte doppelt
        -- gespiegelt ankommen.
        UNIQUE(base_url)
      );

      CREATE TRIGGER IF NOT EXISTS trg_mealie_accounts_updated_at
        AFTER UPDATE ON mealie_accounts FOR EACH ROW
        BEGIN UPDATE mealie_accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- mealie_account_id NULL = eigenes Rezept; gesetzt = Spiegel dieses Kontos.
      ALTER TABLE recipes ADD COLUMN mealie_account_id INTEGER
        REFERENCES mealie_accounts(id) ON DELETE CASCADE;
      -- Mealies eigener Slug/Id, Schlüssel für den Upsert bei jedem Sync-Lauf.
      ALTER TABLE recipes ADD COLUMN mealie_recipe_id TEXT;
      -- Mealies updatedAt: unveränderte Rezepte überspringt der Sync damit.
      ALTER TABLE recipes ADD COLUMN mealie_updated_at TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_mealie_unique
        ON recipes(mealie_account_id, mealie_recipe_id) WHERE mealie_account_id IS NOT NULL;
    `,
  };
