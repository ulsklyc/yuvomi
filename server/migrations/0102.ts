export default {
    version: 102,
    description: 'Loans: own currency per loan with a fixed conversion rate (#582)',
    up: `
      -- Eigene Währung je Darlehen (#582): Ein Auslandskredit läuft in einer
      -- anderen Währung als das Budget. Alle Geldfelder des Darlehens
      -- (total_amount, principal, budget_loan_payments.amount) bleiben in DIESER
      -- Währung gespeichert - nur so bleiben Tilgungsplan und Restschuld exakt.
      --
      -- currency = NULL bedeutet "Budget-Währung" (Altbestand und der Normalfall);
      -- die Route löst das gegen sync_config.currency auf, statt hier einen
      -- Default einzubrennen, der bei einer Währungsumstellung falsch würde.
      --
      -- exchange_rate ist ein FESTER, manuell gepflegter Kurs statt eines
      -- Tageskurses: ein Tilgungsplan über 30 Jahre darf seine Restschuld nicht
      -- täglich ändern, und der Live-Kurs-Pfad des Abo-Moduls braucht einen
      -- FIXER_API_KEY, den die meisten Installationen nicht setzen.
      -- Semantik: 1 Einheit Darlehenswährung = exchange_rate Einheiten
      -- Budget-Währung, also budget_amount = loan_amount * exchange_rate.
      -- Nur die Budget-Buchung der Rate und die währungsübergreifende
      -- Summenkarte rechnen damit um; das Darlehen selbst rechnet ungewandelt.
      ALTER TABLE budget_loans ADD COLUMN currency TEXT;
      ALTER TABLE budget_loans ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1;
    `,
  };
