export default {
    version: 264,
    description: 'subscriptions: an account as the default for every payment it books (#1277)',
    up: `
      -- KONTO AM ABO (#1277): die Vorgabe fuer jede Buchung, die das Abo
      -- schreibt. NULL = ohne Konto, wie bisher jede Abo-Buchung. Dieselbe
      -- Referenz wie budget_entries.account_id und budget_loans.account_id;
      -- die DELETE-Route eines Kontos leert sie zusaetzlich ausdruecklich.
      ALTER TABLE budget_subscriptions ADD COLUMN account_id INTEGER
        REFERENCES budget_accounts(id) ON DELETE SET NULL;
    `,
  };
