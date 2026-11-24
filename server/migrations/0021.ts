export default {
    version: 21,
    description: 'Calendar event icons',
    up: `
      ALTER TABLE calendar_events ADD COLUMN icon TEXT NOT NULL DEFAULT 'calendar';
    `,
  };
