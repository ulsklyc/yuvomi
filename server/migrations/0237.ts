export default {
    version: 237,
    description: 'Subscriptions: optional payment reminder (#1708, from D#1226)',
    up: `
      ALTER TABLE budget_subscriptions ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 1
        CHECK(reminder_enabled IN (0,1));
    `,
  };
