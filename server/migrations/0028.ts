export default {
    version: 28,
    description: 'Budget loans and installment payments',
    up: `
      CREATE TABLE IF NOT EXISTS budget_loans (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        title             TEXT    NOT NULL,
        borrower          TEXT    NOT NULL,
        total_amount      REAL    NOT NULL CHECK(total_amount > 0),
        installment_count INTEGER NOT NULL CHECK(installment_count > 0),
        start_month       TEXT    NOT NULL,
        notes             TEXT,
        status            TEXT    NOT NULL DEFAULT 'active'
                                  CHECK(status IN ('active', 'paid')),
        created_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS budget_loan_payments (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        loan_id            INTEGER NOT NULL REFERENCES budget_loans(id) ON DELETE CASCADE,
        installment_number INTEGER NOT NULL CHECK(installment_number > 0),
        amount             REAL    NOT NULL CHECK(amount > 0),
        paid_date          TEXT    NOT NULL,
        budget_entry_id    INTEGER REFERENCES budget_entries(id) ON DELETE SET NULL,
        created_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(loan_id, installment_number)
      );

      CREATE TRIGGER IF NOT EXISTS trg_budget_loans_updated_at
        AFTER UPDATE ON budget_loans FOR EACH ROW
        BEGIN UPDATE budget_loans SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_budget_loans_status ON budget_loans(status);
      CREATE INDEX IF NOT EXISTS idx_budget_loans_start_month ON budget_loans(start_month);
      CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_loan ON budget_loan_payments(loan_id);
      CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_paid_date ON budget_loan_payments(paid_date);
    `,
  };
