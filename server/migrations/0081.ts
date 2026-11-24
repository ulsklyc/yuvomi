// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 81,
    description: 'Budget-Konten mit Startsaldo + optionale Konto-Zuordnung je Eintrag (#495)',
    up: `
      -- Getrennte Konten (Giro, Sparen, Bar …) mit fortlaufendem Saldo.
      -- Der aktuelle Kontostand = starting_balance + Summe der zugeordneten Einträge.
      CREATE TABLE IF NOT EXISTS budget_accounts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL,
        type             TEXT    NOT NULL DEFAULT 'checking',
        starting_balance REAL    NOT NULL DEFAULT 0,
        currency         TEXT,
        color            TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_budget_accounts_updated_at
        AFTER UPDATE ON budget_accounts FOR EACH ROW
        BEGIN UPDATE budget_accounts SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- Optionale Konto-Zuordnung je Eintrag; NULL = keinem Konto zugeordnet
      -- (bisheriges Verhalten, Bestandsdaten bleiben unverändert). Beim Löschen
      -- eines Kontos bleiben die Einträge erhalten (Zuordnung wird geleert; die
      -- DELETE-Route setzt account_id zusätzlich explizit auf NULL).
      ALTER TABLE budget_entries ADD COLUMN account_id INTEGER
        REFERENCES budget_accounts(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_budget_account ON budget_entries(account_id);
    `,
  };
