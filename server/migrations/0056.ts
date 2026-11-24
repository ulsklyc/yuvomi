export default {
    version: 56,
    description: 'Budget subscription tracker with categories, payment methods, settings, and exchange-rate cache',
    up: `
      CREATE TABLE IF NOT EXISTS subscription_categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
        color      TEXT    NOT NULL DEFAULT '#0F766E',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT OR IGNORE INTO subscription_categories (name, color, sort_order) VALUES
        ('Entertainment', '#7C3AED', 0),
        ('Productivity',  '#2563EB', 1),
        ('Utilities',     '#0F766E', 2),
        ('Health',        '#DC2626', 3),
        ('Education',     '#D97706', 4),
        ('Other',         '#64748B', 5);

      CREATE TABLE IF NOT EXISTS subscription_payment_methods (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT OR IGNORE INTO subscription_payment_methods (name, sort_order) VALUES
        ('Credit Card', 0),
        ('Debit Card',  1),
        ('PayPal',      2),
        ('Apple Pay',   3),
        ('Google Pay',  4),
        ('Bank Transfer', 5),
        ('Other',       6);

      CREATE TABLE IF NOT EXISTS budget_subscriptions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT    NOT NULL,
        description       TEXT,
        amount            REAL    NOT NULL CHECK(amount >= 0),
        currency          TEXT    NOT NULL,
        billing_cycle     TEXT    NOT NULL CHECK(billing_cycle IN ('daily', 'weekly', 'monthly', 'yearly')),
        cycle_interval    INTEGER NOT NULL DEFAULT 1 CHECK(cycle_interval BETWEEN 1 AND 365),
        next_payment_date TEXT    NOT NULL,
        category_id       INTEGER REFERENCES subscription_categories(id) ON DELETE SET NULL,
        payment_method_id INTEGER REFERENCES subscription_payment_methods(id) ON DELETE SET NULL,
        reminder_days     INTEGER NOT NULL DEFAULT 3 CHECK(reminder_days BETWEEN 0 AND 365),
        enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        website_url       TEXT,
        logo_data         TEXT,
        brand_color       TEXT,
        notes             TEXT,
        created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS subscription_settings (
        id             INTEGER PRIMARY KEY CHECK(id = 1),
        monthly_budget REAL    NOT NULL DEFAULT 0 CHECK(monthly_budget >= 0),
        base_currency  TEXT    NOT NULL DEFAULT 'EUR',
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      INSERT OR IGNORE INTO subscription_settings (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS subscription_exchange_rates (
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate          REAL NOT NULL CHECK(rate > 0),
        fetched_at    TEXT NOT NULL,
        PRIMARY KEY(base_currency, quote_currency)
      );

      CREATE TRIGGER IF NOT EXISTS trg_budget_subscriptions_updated_at
        AFTER UPDATE ON budget_subscriptions FOR EACH ROW
        BEGIN UPDATE budget_subscriptions SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_subscription_settings_updated_at
        AFTER UPDATE ON subscription_settings FOR EACH ROW
        BEGIN UPDATE subscription_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 1; END;

      CREATE INDEX IF NOT EXISTS idx_budget_subscriptions_next_payment
        ON budget_subscriptions(enabled, next_payment_date);
      CREATE INDEX IF NOT EXISTS idx_budget_subscriptions_category
        ON budget_subscriptions(category_id);
      CREATE INDEX IF NOT EXISTS idx_budget_subscriptions_payment_method
        ON budget_subscriptions(payment_method_id);
    `,
  };
