// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 180,
    description: 'Health: per-user read-only predicted-cycle ICS feed token',
    // Gleiches Muster wie Migration 61 (calendar_feed_token) und 144
    // (inventory_deadlines_feed_token): das Token haengt an der users-Zeile.
    // Anders als beim Inventar-Feed ist der INHALT hier ohnehin schon
    // personengebunden (cycle_periods.user_id) - kein haushaltweiter
    // Rueckzugs-Nachteil zu vermeiden, aber dieselbe Konvention trotzdem
    // richtig: ein Feed, ein Token, ein Ort, an dem er lebt.
    up: `
      ALTER TABLE users ADD COLUMN cycle_feed_token TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cycle_feed_token
        ON users(cycle_feed_token)
        WHERE cycle_feed_token IS NOT NULL;
    `,
  };
