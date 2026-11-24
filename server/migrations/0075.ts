export default {
    version: 75,
    description: 'planned/estimated budget: per-category monthly caps + monthly savings goal (#468)',
    up: `
      -- Geplantes Budget je Ausgabenkategorie und ein Monats-Sparziel (Discussion #468).
      -- Bewusst als „stetiger" Monatsplan modelliert: EIN Betrag pro Kategorie, der für
      -- jeden Monat gilt — das ist der 80/20-Fall („mein Lebensmittelbudget sind 400/Monat")
      -- und vermeidet eine Pro-Monat-Pflege. Der Ist-Wert variiert pro Monat, der Plan bleibt.
      --
      --   category  = Ausgabenkategorie-Schlüssel (budget_categories.key, type='expense')
      --               ODER der reservierte Sentinel '__savings__' für das Monats-Sparziel.
      --   amount    = geplanter Monatsbetrag, immer positiv (Deckel bzw. Sparziel), 2 Nachkommastellen.
      --
      -- Kein FK auf budget_categories: Kategorien können umbenannt/gelöscht werden; ein
      -- verwaister Plan schadet nicht (wird bei GET einfach ohne Ist-Bezug geführt) und die
      -- Validierung beim Schreiben stellt gültige Ziele sicher. Append-only.
      CREATE TABLE IF NOT EXISTS budget_plans (
        category    TEXT NOT NULL PRIMARY KEY,
        amount      REAL NOT NULL,
        created_by  TEXT,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
    `,
  };
