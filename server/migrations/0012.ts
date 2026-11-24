// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 12,
    description: 'calendar_events: replace partial unique index with full index (ON CONFLICT support)',
    up: `
      DROP INDEX IF EXISTS idx_calendar_sub_extid;
      CREATE UNIQUE INDEX idx_calendar_sub_extid
        ON calendar_events (subscription_id, external_calendar_id);
    `,
  };
