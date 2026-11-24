// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 205,
    description: 'Waste collection: revocable read-only ICS feed (#1063 Phase 10)',
    // Same personal-token-over-household-content pattern as migrations 61
    // (calendar_feed_token), 144 (inventory_deadlines_feed_token) and 176
    // (schedule_feed_token): Waste types/schedules/pickups have no owner or
    // visibility column, so the FEED CONTENT stays household-wide, but the
    // TOKEN is per-user - a revoke costs exactly one subscription, not every
    // subscriber's.
    //
    // waste_feed_type_ids is a nullable JSON array of waste_types.id, stored
    // alongside the token (not as a query-string parameter on the public feed
    // URL): a subscription URL is meant to stay stable across edits, and
    // putting mutable selection state in the URL would force a new URL - and
    // therefore a broken existing subscription - every time the selection
    // changes. NULL means "every active type", mirroring the reminder
    // settings default (no row = not yet touched = show everything).
    up: `
      ALTER TABLE users ADD COLUMN waste_feed_token TEXT;
      ALTER TABLE users ADD COLUMN waste_feed_type_ids TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_waste_feed_token
        ON users(waste_feed_token)
        WHERE waste_feed_token IS NOT NULL;
    `,
  };
