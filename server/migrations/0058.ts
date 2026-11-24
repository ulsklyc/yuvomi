// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 58,
    description: 'Link each active subscription renewal to its pending Budget expense',
    up: `
      ALTER TABLE budget_subscriptions ADD COLUMN budget_entry_id INTEGER
        REFERENCES budget_entries(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_budget_subscriptions_budget_entry
        ON budget_subscriptions(budget_entry_id);
    `,
    afterUp: (database) => {
      const subscriptions = database.prepare(`
        SELECT * FROM budget_subscriptions
        WHERE enabled = 1 AND budget_entry_id IS NULL
      `).all();
      const insert = database.prepare(`
        INSERT INTO budget_entries
          (title, amount, category, subcategory, date, is_recurring, created_by)
        VALUES (?, ?, 'financial_other', 'bank_fees', ?, 0, ?)
      `);
      const link = database.prepare(`
        UPDATE budget_subscriptions SET budget_entry_id = ? WHERE id = ?
      `);
      for (const subscription of subscriptions) {
        const entry = insert.run(
          subscription.name,
          -Math.abs(subscription.amount),
          subscription.next_payment_date,
          subscription.created_by,
        );
        link.run(entry.lastInsertRowid, subscription.id);
      }
    },
  };
