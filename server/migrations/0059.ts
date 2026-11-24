// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 59,
    description: 'Mirror subscription categories into Budget and recategorize linked expenses',
    up: `
      ALTER TABLE subscription_categories ADD COLUMN budget_subcategory_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_categories_budget_subcategory
        ON subscription_categories(budget_subcategory_key)
        WHERE budget_subcategory_key IS NOT NULL;
    `,
    afterUp: (database) => {
      const nextOrder = database.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM budget_categories WHERE type = 'expense'
      `).get().n;
      database.prepare(`
        INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order)
        VALUES ('subscriptions', 'Subscription', 'expense', ?)
      `).run(nextOrder);

      const defaultKeys = new Map([
        ['entertainment', 'subscription_entertainment'],
        ['productivity', 'subscription_productivity'],
        ['utilities', 'subscription_utilities'],
        ['health', 'subscription_health'],
        ['education', 'subscription_education'],
        ['other', 'subscription_other'],
      ]);
      const categories = database.prepare(`
        SELECT id, name, sort_order FROM subscription_categories ORDER BY sort_order, id
      `).all();
      const updateCategory = database.prepare(`
        UPDATE subscription_categories SET budget_subcategory_key = ? WHERE id = ?
      `);
      const upsertSubcategory = database.prepare(`
        INSERT INTO budget_subcategories (key, category_key, name, sort_order)
        VALUES (?, 'subscriptions', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          category_key = excluded.category_key,
          name = excluded.name,
          sort_order = excluded.sort_order
      `);
      for (const category of categories) {
        const key = defaultKeys.get(category.name.toLowerCase()) || `subscription_category_${category.id}`;
        updateCategory.run(key, category.id);
        upsertSubcategory.run(key, category.name, category.sort_order);
      }

      database.prepare(`
        UPDATE budget_entries
        SET category = 'subscriptions',
            subcategory = COALESCE((
              SELECT c.budget_subcategory_key
              FROM budget_subscriptions s
              LEFT JOIN subscription_categories c ON c.id = s.category_id
              WHERE s.budget_entry_id = budget_entries.id
            ), '')
        WHERE id IN (
          SELECT budget_entry_id FROM budget_subscriptions WHERE budget_entry_id IS NOT NULL
        )
      `).run();
    },
  };
