export default {
    version: 46,
    description: 'Budget recurring entries: interval (monthly/half_year/yearly) + virtual (smoothed) budgeting',
    up: `
      -- Intervall einer wiederkehrenden Serie. Bestand = monatlich (rückwärtskompatibel).
      ALTER TABLE budget_entries ADD COLUMN recurrence_interval TEXT NOT NULL DEFAULT 'monthly';
      -- 1 = virtuelles Budget: der Periodenbetrag wird gleichmäßig auf Monate verteilt.
      ALTER TABLE budget_entries ADD COLUMN recurrence_virtual INTEGER NOT NULL DEFAULT 0;
      -- Bei virtuellen Serien der vom Nutzer eingegebene Periodenbetrag (amount hält dann den Monatsanteil).
      ALTER TABLE budget_entries ADD COLUMN recurrence_full_amount REAL;
    `,
  };
