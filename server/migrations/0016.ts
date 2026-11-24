export default {
    version: 16,
    description: 'Move budget categories and subcategories to separate tables',
    up: `
      CREATE TABLE IF NOT EXISTS budget_categories (
        key        TEXT PRIMARY KEY,
        name       TEXT    NOT NULL,
        type       TEXT    NOT NULL CHECK(type IN ('expense', 'income')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS budget_subcategories (
        key          TEXT PRIMARY KEY,
        category_key TEXT    NOT NULL REFERENCES budget_categories(key) ON DELETE CASCADE,
        name         TEXT    NOT NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(category_key, name)
      );

      INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order) VALUES
        ('housing', 'Housing / Home', 'expense', 0),
        ('food', 'Food', 'expense', 1),
        ('transport', 'Transport', 'expense', 2),
        ('personal_health', 'Personal Care / Health', 'expense', 3),
        ('leisure', 'Leisure and Entertainment', 'expense', 4),
        ('shopping_clothing', 'Shopping and Clothing', 'expense', 5),
        ('education', 'Education', 'expense', 6),
        ('financial_other', 'Financial Services and Other', 'expense', 7),
        ('Erwerbseinkommen', 'Erwerbseinkommen', 'income', 0),
        ('Kapitalerträge', 'Kapitalerträge', 'income', 1),
        ('Geschenke & Transfers', 'Geschenke & Transfers', 'income', 2),
        ('Sozialleistungen', 'Sozialleistungen', 'income', 3),
        ('Sonstiges Einkommen', 'Sonstiges Einkommen', 'income', 4);

      INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order) VALUES
        ('rent_mortgage', 'housing', 'Rent / Mortgage', 0),
        ('condominium', 'housing', 'Condominium fees', 1),
        ('utilities', 'housing', 'Electricity / Water / Gas', 2),
        ('internet_tv_phone', 'housing', 'Internet / TV / Phone', 3),
        ('renovation_maintenance', 'housing', 'Renovation / Maintenance', 4),
        ('cleaning', 'housing', 'Cleaning', 5),
        ('groceries', 'food', 'Groceries', 0),
        ('restaurants_bars', 'food', 'Restaurants / Bars', 1),
        ('snacks_fast_food', 'food', 'Snacks / Fast Food', 2),
        ('bakery', 'food', 'Bakery', 3),
        ('fuel', 'transport', 'Fuel', 0),
        ('parking_tolls', 'transport', 'Parking / Tolls', 1),
        ('public_transport', 'transport', 'Public transport', 2),
        ('apps_taxi', 'transport', 'Apps / Taxi', 3),
        ('maintenance_insurance', 'transport', 'Maintenance / Insurance', 4),
        ('pharmacy', 'personal_health', 'Pharmacy', 0),
        ('health_insurance', 'personal_health', 'Health insurance', 1),
        ('gym_sports', 'personal_health', 'Gym / Sports', 2),
        ('beauty_cosmetics', 'personal_health', 'Beauty / Cosmetics', 3),
        ('travel', 'leisure', 'Travel', 0),
        ('streaming', 'leisure', 'Streaming', 1),
        ('events', 'leisure', 'Events', 2),
        ('hobbies', 'leisure', 'Hobbies', 3),
        ('clothes_shoes', 'shopping_clothing', 'Clothes / Shoes', 0),
        ('electronics', 'shopping_clothing', 'Electronics', 1),
        ('gifts', 'shopping_clothing', 'Gifts', 2),
        ('courses_college', 'education', 'Courses / College', 0),
        ('school_supplies', 'education', 'School supplies', 1),
        ('languages', 'education', 'Languages', 2),
        ('loans_interest', 'financial_other', 'Loans / Interest', 0),
        ('bank_fees', 'financial_other', 'Bank fees', 1),
        ('insurance_other', 'financial_other', 'Insurance', 2),
        ('investments', 'financial_other', 'Investments', 3),
        ('taxes', 'financial_other', 'Taxes', 4);

      INSERT OR IGNORE INTO budget_categories (key, name, type, sort_order)
      SELECT category, category, CASE WHEN amount < 0 THEN 'expense' ELSE 'income' END, 1000
      FROM budget_entries
      WHERE category NOT IN (SELECT key FROM budget_categories)
      GROUP BY category;

      INSERT OR IGNORE INTO budget_subcategories (key, category_key, name, sort_order)
      SELECT subcategory, category, subcategory, 1000
      FROM budget_entries
      WHERE subcategory != ''
        AND subcategory NOT IN (SELECT key FROM budget_subcategories)
        AND category IN (SELECT key FROM budget_categories WHERE type = 'expense')
      GROUP BY category, subcategory;
    `,
  };
