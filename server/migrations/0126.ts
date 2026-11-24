// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 126,
    description: 'Budget loans: lending direction (lent vs. borrowed) and an optional account for the installments (#638)',
    up: `
      -- Das Darlehensmodul wurde fuer verliehenes Geld gebaut: die Rate war immer
      -- eine Einnahme (positiver Betrag, income-Kategorie). Mit den Zinsfeldern
      -- aus #569 kam der aufgenommene Kredit dazu, ohne dass die Buchung nachzog -
      -- eine Hypothekenrate erschien deshalb als Einnahme (#638).
      --
      -- 'lent'     = der Haushalt hat verliehen, die Rate kommt herein (Einnahme).
      -- 'borrowed' = der Haushalt hat aufgenommen, die Rate geht raus (Ausgabe).
      -- Default 'lent', damit Bestandsdaten ihr heutiges Verhalten behalten; wer
      -- ein Darlehen auf 'borrowed' umstellt, bekommt die bereits gebuchten Raten
      -- von der Route mit umgebucht.
      ALTER TABLE budget_loans ADD COLUMN direction TEXT NOT NULL DEFAULT 'lent';

      -- Bis hierher hatte der Raten-Eintrag nie eine Kontozuordnung, eine Rate
      -- konnte also kein Konto belasten. Das Konto haengt am Darlehen und wird auf
      -- neue Raten vererbt (rueckwirkend umbuchen wuerde historische Kontosalden
      -- verfaelschen, ein Bankwechsel mitten in der Laufzeit ist legitim).
      ALTER TABLE budget_loans ADD COLUMN account_id INTEGER REFERENCES budget_accounts(id) ON DELETE SET NULL;
    `,
  };
