// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 100,
    description: 'Loans: optional interest phases (fixed rate + forecast follow-up rate, #569)',
    up: `
      -- Zins-Darlehen (#569): Bisher waren Darlehen zinsfrei (total_amount fest,
      -- installment_count manuell). Optional wird jetzt ein Annuitätendarlehen
      -- nach deutschem Muster abgebildet: Sollzins (fixed_rate) + Anfangstilgung
      -- (initial_repayment_rate) auf die Kreditsumme (principal) ergeben die
      -- konstante Monatsrate; die Laufzeit wird daraus berechnet. Nach der
      -- Zinsbindung (fixed_period_months) rechnet der Prognose-Anschlusszins
      -- (followup_rate) weiter. Der Server leitet daraus total_amount +
      -- installment_count ab, sodass die bestehende Raten-/Status-Logik
      -- unverändert weiterläuft. interest_mode='none' = bisheriges Verhalten.
      -- Validierung bewusst in der Route (wie #517), daher hier nur der Enum-CHECK.
      ALTER TABLE budget_loans ADD COLUMN interest_mode TEXT NOT NULL DEFAULT 'none'
        CHECK(interest_mode IN ('none', 'fixed', 'fixed_then_variable'));
      ALTER TABLE budget_loans ADD COLUMN principal REAL;
      ALTER TABLE budget_loans ADD COLUMN fixed_rate REAL;
      ALTER TABLE budget_loans ADD COLUMN initial_repayment_rate REAL;
      ALTER TABLE budget_loans ADD COLUMN fixed_period_months INTEGER;
      ALTER TABLE budget_loans ADD COLUMN followup_rate REAL;
    `,
  };
