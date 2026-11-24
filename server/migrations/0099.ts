export default {
    version: 99,
    description: 'Add per-group default split method and config for shared expenses (#517)',
    up: `
      -- Persistente Standard-Aufteilung pro Ausgaben-Gruppe (#517): neue Ausgaben
      -- übernehmen Methode und - bei percentage/shares - die pro-Mitglied-Werte,
      -- statt jedes Mal auf 'equal' zu starten. default_split_config ist JSON
      -- ([{ user_id, percentage }] bzw. [{ user_id, shares }]) oder NULL bei
      -- equal/exact. Reine UI-Vorbelegung: die harte Split-Validierung bleibt pro
      -- Ausgabe (buildSplits), daher hier bewusst keine Summen-/FK-Constraints.
      ALTER TABLE expense_groups ADD COLUMN default_split_method TEXT NOT NULL DEFAULT 'equal'
        CHECK(default_split_method IN ('equal', 'exact', 'percentage', 'shares'));
      ALTER TABLE expense_groups ADD COLUMN default_split_config TEXT;
    `,
  };
