// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 107,
    description: 'Subscriptions: optional end condition (never / on date / after N payments) (#594)',
    up: `
      -- Abos sind oft befristet (Leasing, Ratenkauf, Miete bis zum Umzug). Ohne
      -- Ende laufen sie in der Verlängerungsprognose unbegrenzt weiter, und man
      -- muss selbst daran denken, sie zu deaktivieren.
      --
      -- end_type steuert die drei Modi; end_date bzw. occurrence_count tragen den
      -- jeweiligen Grenzwert. Bestandsabos bekommen 'never' und verhalten sich
      -- unverändert.
      ALTER TABLE budget_subscriptions
        ADD COLUMN end_type TEXT NOT NULL DEFAULT 'never'
        CHECK(end_type IN ('never', 'on_date', 'after_count'));
      ALTER TABLE budget_subscriptions ADD COLUMN end_date TEXT;
      ALTER TABLE budget_subscriptions ADD COLUMN occurrence_count INTEGER;

      -- Zählt die bereits verbuchten Zahlungen mit, damit 'after_count' beim
      -- Verlängern gegen occurrence_count laufen kann. Die aktuell anstehende
      -- Zahlung ist immer Nummer occurrences_done + 1.
      ALTER TABLE budget_subscriptions
        ADD COLUMN occurrences_done INTEGER NOT NULL DEFAULT 0;

      -- Gesetzt, sobald die letzte Zahlung durch ist: das Abo gilt als
      -- abgeschlossen (zusätzlich enabled = 0), unterscheidbar vom manuellen
      -- Pausieren.
      ALTER TABLE budget_subscriptions ADD COLUMN completed_at TEXT;
    `,
  };
