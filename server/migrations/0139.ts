// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 139,
    description: 'Inventory: link items to budget entries with a role (Stage 3)',
    up: `
      -- created_by ist SET NULL, NICHT CASCADE wie bei inventory_item_documents
      -- (Migration 138): eine Buchungsverknuepfung ist Haushaltseigentum wie
      -- der Gegenstand selbst (gleiche Begruendung wie inventory_items.created_by),
      -- keine persoenliche Handlungsnotiz wie ein Dokument-Anhang.
      --
      -- amount_share existiert schon jetzt (nichts in Stufe 3 schreibt je einen
      -- Wert hinein), damit Stufe 5 kein ALTER TABLE mehr braucht - "volles
      -- Schema jetzt, gestufte Umsetzung" (Design-Doc §1).
      CREATE TABLE IF NOT EXISTS inventory_item_entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id      INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        entry_id     INTEGER NOT NULL REFERENCES budget_entries(id) ON DELETE CASCADE,
        role         TEXT    NOT NULL DEFAULT 'purchase'
                     CHECK (role IN ('purchase','refund','instalment','maintenance','accessory')),
        amount_share REAL    CHECK (amount_share IS NULL OR amount_share >= 0),
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(item_id, entry_id, role)
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_item_entries_item ON inventory_item_entries(item_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_item_entries_entry ON inventory_item_entries(entry_id);
    `,
  };
