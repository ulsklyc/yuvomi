export default {
    version: 101,
    description: 'Loans: allow a purely variable interest rate (#569 follow-up)',
    foreignKeysOff: true,
    up: `
      -- Rein variables Darlehen (#569-Nachtrag): interest_mode kannte bisher nur
      -- 'fixed' (Sollzins über die ganze Laufzeit) und 'fixed_then_variable'
      -- (Zinsbindung, danach Prognosezins). Ein Darlehen ohne jede Zinsbindung
      -- ließ sich nur als "fester Zins" anlegen - die Anzeige behauptete dann
      -- eine Bindung, die es nicht gibt. 'variable' rechnet identisch zu 'fixed'
      -- (ein Zinssatz, keine Phasen), deklariert ihn aber als aktuellen
      -- Prognosewert ohne Bindung.
      --
      -- SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher Tabelle
      -- neu erstellen (Muster wie v98). foreignKeysOff ist Pflicht: mit aktiver
      -- FK-Durchsetzung würde DROP TABLE die gekoppelten Ratenzahlungen
      -- (budget_loan_payments ... ON DELETE CASCADE) mitlöschen.
      CREATE TABLE budget_loans_new (
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
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        visibility        TEXT    NOT NULL DEFAULT 'shared'
                                  CHECK (visibility IN ('private', 'shared')),
        interest_mode     TEXT    NOT NULL DEFAULT 'none'
                                  CHECK(interest_mode IN ('none', 'fixed', 'variable', 'fixed_then_variable')),
        principal              REAL,
        fixed_rate             REAL,
        initial_repayment_rate REAL,
        fixed_period_months    INTEGER,
        followup_rate          REAL
      );

      INSERT INTO budget_loans_new (
        id, title, borrower, total_amount, installment_count, start_month, notes,
        status, created_by, created_at, updated_at, owner_id, visibility,
        interest_mode, principal, fixed_rate, initial_repayment_rate,
        fixed_period_months, followup_rate
      )
      SELECT
        id, title, borrower, total_amount, installment_count, start_month, notes,
        status, created_by, created_at, updated_at, owner_id, visibility,
        interest_mode, principal, fixed_rate, initial_repayment_rate,
        fixed_period_months, followup_rate
      FROM budget_loans;

      DROP TABLE budget_loans;
      ALTER TABLE budget_loans_new RENAME TO budget_loans;

      CREATE TRIGGER IF NOT EXISTS trg_budget_loans_updated_at
        AFTER UPDATE ON budget_loans FOR EACH ROW
        BEGIN UPDATE budget_loans SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_budget_loans_status ON budget_loans(status);
      CREATE INDEX IF NOT EXISTS idx_budget_loans_start_month ON budget_loans(start_month);
      CREATE INDEX IF NOT EXISTS idx_budget_loans_owner ON budget_loans(owner_id);
    `,
  };
