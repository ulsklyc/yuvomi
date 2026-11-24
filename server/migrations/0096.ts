// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 96,
    description: 'Add default_visibility to cycle_settings so new cycle entries can default to family-visible',
    up: `
      -- Persönliche Voreinstellung für die Sichtbarkeit neu geloggter Zyklus-Daten
      -- (Perioden + Tageslogs). Bestehende Zeilen bleiben unberührt; 'private' hält
      -- das bisherige Verhalten als Default bei. Das UI wählt diesen Wert nur vor -
      -- pro Event bleibt die Sichtbarkeit weiterhin einzeln überschreibbar.
      ALTER TABLE cycle_settings ADD COLUMN default_visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(default_visibility IN ('private', 'family'));
    `,
  };
