// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 27,
    description: 'Calendar event attachments',
    up: `
      ALTER TABLE calendar_events ADD COLUMN attachment_name TEXT;
      ALTER TABLE calendar_events ADD COLUMN attachment_mime TEXT;
      ALTER TABLE calendar_events ADD COLUMN attachment_size INTEGER;
      ALTER TABLE calendar_events ADD COLUMN attachment_data TEXT;
    `,
  };
