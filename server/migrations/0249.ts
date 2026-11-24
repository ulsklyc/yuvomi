// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 249,
    description: 'Birthdays: independently revocable ICS subscriptions',
    up: `
      ALTER TABLE users ADD COLUMN birthday_feed_token TEXT;
      ALTER TABLE users ADD COLUMN calendar_feed_include_birthdays INTEGER NOT NULL DEFAULT 1
        CHECK(calendar_feed_include_birthdays IN (0, 1));
      CREATE UNIQUE INDEX idx_users_birthday_feed_token ON users(birthday_feed_token)
        WHERE birthday_feed_token IS NOT NULL;
    `,
  };
