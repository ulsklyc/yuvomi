// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 144,
    description: 'add per-user read-only inventory deadlines feed token',
    up: `
      -- Gleiches Muster wie Migration 61 (calendar_feed_token): das Token haengt
      -- an der users-Zeile, nicht haushaltweit in sync_config. Der Feed-Inhalt
      -- bleibt haushaltweit - Gegenstaende haben keinen Eigentuemer -, aber ein
      -- haushaltweites Token laesst sich nicht einzeln zurueckziehen: wer einmal
      -- abonniert hat, behaelt Zugriff, bis er allen genommen wird.
      ALTER TABLE users ADD COLUMN inventory_deadlines_feed_token TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_inventory_deadlines_feed_token
        ON users(inventory_deadlines_feed_token)
        WHERE inventory_deadlines_feed_token IS NOT NULL;

      -- Das alte haushaltweite Token faellt weg. Genau das ist der Rueckzug, den
      -- es vorher nicht gab: eine bestehende Abo-URL wird ungueltig, statt als
      -- verwaiste Zeile weiterzugelten.
      DELETE FROM sync_config WHERE key = 'inventory_deadlines_feed_token';
    `,
  };
