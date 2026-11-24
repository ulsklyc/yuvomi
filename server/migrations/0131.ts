export default {
    version: 131,
    description: 'Budget: issuing bank and credit limit on credit-card accounts (#541)',
    up: `
      -- Nur die beiden Felder, die für sich stehen: die Bank als Beschriftung, das
      -- Limit als Bezugsgröße für den verfügbaren Rahmen. Abrechnungs- und
      -- Fälligkeitstag kommen mit der Abrechnungslogik, weil erst die festlegt,
      -- welchen Zeitraum ein solcher Tag begrenzt.
      ALTER TABLE budget_accounts ADD COLUMN credit_bank TEXT;
      ALTER TABLE budget_accounts ADD COLUMN credit_limit REAL;
    `,
  };
