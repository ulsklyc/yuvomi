// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 88,
    description: 'Budget personal/shared: owner_id + visibility on entries, loans, subscriptions (#476/#505)',
    up: `
      -- Persönliche vs. geteilte Budget-Objekte (Lean, #476/#505). Jedes Objekt
      -- bekommt eine:n Eigentümer:in (owner_id, fix = Ersteller:in) und eine
      -- Sichtbarkeit (private/shared). Bestand → shared = bisheriges Haushalts-
      -- Verhalten, voll rückwärtskompatibel. owner_id ist ON DELETE SET NULL:
      -- Löschen eines Mitglieds macht seine Objekte zu verwaisten (nur im
      -- Shared-Modus sichtbaren) Haushalts-Objekten, statt sie mitzureißen.
      ALTER TABLE budget_entries ADD COLUMN owner_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE budget_entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
        CHECK (visibility IN ('private', 'shared'));
      UPDATE budget_entries SET owner_id = created_by WHERE owner_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_budget_owner ON budget_entries(owner_id);

      ALTER TABLE budget_loans ADD COLUMN owner_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE budget_loans ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
        CHECK (visibility IN ('private', 'shared'));
      UPDATE budget_loans SET owner_id = created_by WHERE owner_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_budget_loans_owner ON budget_loans(owner_id);

      ALTER TABLE budget_subscriptions ADD COLUMN owner_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE budget_subscriptions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
        CHECK (visibility IN ('private', 'shared'));
      UPDATE budget_subscriptions SET owner_id = created_by WHERE owner_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_budget_subs_owner ON budget_subscriptions(owner_id);
    `,
  };
