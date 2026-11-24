export default {
    version: 61,
    description: 'add per-user read-only calendar feed token',
    up: `
      ALTER TABLE users ADD COLUMN calendar_feed_token TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_feed_token
        ON users(calendar_feed_token)
        WHERE calendar_feed_token IS NOT NULL;
    `,
  };
