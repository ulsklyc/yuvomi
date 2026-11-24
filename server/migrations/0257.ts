// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 257,
    description: 'Budget transfers: linked account entries (#781)',
    // NULL preserves every ordinary entry. The service creates and mirrors pairs
    // in one transaction; no trigger writes the other financial fact.
    up: `
      ALTER TABLE budget_entries ADD COLUMN transfer_entry_id INTEGER NULL
        REFERENCES budget_entries(id) ON DELETE CASCADE;
      CREATE INDEX idx_budget_transfer ON budget_entries(transfer_entry_id);
      -- A deleted parent stays deleted; an existing household Savings name keeps its own key.
      INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order)
        SELECT 'saving', key, 'Savings', 5 FROM budget_categories
        WHERE key = 'financial_other';
    `,
  };
