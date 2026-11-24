export default {
    version: 129,
    description: 'Budget: recurring series can book only after confirmation (#637)',
    up: `
      -- Nicht jeder Dienst bucht am selben Tag und auf den Cent genau ab. Eine
      -- Serie kann deshalb verlangen, dass jede erzeugte Buchung erst bestaetigt
      -- wird - mit der Moeglichkeit, Betrag und Datum dabei zu korrigieren (#637).
      ALTER TABLE budget_entries ADD COLUMN recurrence_confirm INTEGER NOT NULL DEFAULT 0;

      -- 1 = erwartet, noch nicht gebucht. Solche Zeilen sind sichtbar, zaehlen
      -- aber in keiner Summe mit: genau die Diskrepanz zum Kontoauszug, die den
      -- Wunsch ausgeloest hat, entstuende sonst weiter.
      --
      -- Default 0 und die Zustimmung je Serie sind zusammen die Ruecksicht auf
      -- den Bestand: ohne beides fielen bestehende Serien beim Update aus den
      -- Summen, und jeder Haushalt saehe ueber Nacht andere Zahlen.
      ALTER TABLE budget_entries ADD COLUMN is_pending INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_budget_pending
        ON budget_entries(is_pending) WHERE is_pending = 1;
    `,
  };
