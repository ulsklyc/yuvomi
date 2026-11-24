// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 174,
    description: 'Birthdays: optional name day with its own generated calendar event',
    // A name day is an anniversary, not a birth date. Inventing a year would
    // produce false information in APIs, exports, and date formatting, so it is
    // stored canonically as MM-DD. Its event link is separate from the birthday
    // so either occurrence can move, be removed, or be deleted at a provider.
    up: `
      ALTER TABLE birthdays ADD COLUMN name_day TEXT;
      ALTER TABLE birthdays ADD COLUMN name_day_calendar_event_id INTEGER
        REFERENCES calendar_events(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_birthdays_name_day_calendar_ref
        ON birthdays(name_day_calendar_event_id);
    `,
  };
