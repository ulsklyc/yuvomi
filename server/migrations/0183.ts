// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 183,
    description: 'add per-user read-only schedule feed token',
    up: `
      -- Gleiches Muster wie Migration 61/144, aber hier ist der Inhalt selbst
      -- schon persoenlich (die eigenen aufgeloesten Schichten), nicht nur der
      -- Zugriff - anders als beim haushaltweiten Inventar-Fristen-Feed.
      ALTER TABLE users ADD COLUMN schedule_feed_token TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_schedule_feed_token
        ON users(schedule_feed_token)
        WHERE schedule_feed_token IS NOT NULL;
    `,
  };
