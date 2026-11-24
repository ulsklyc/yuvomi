// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 23,
    description: 'Link family members with contacts and birthdays',
    up: `
      ALTER TABLE contacts ADD COLUMN family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_family_user
        ON contacts(family_user_id) WHERE family_user_id IS NOT NULL;

      ALTER TABLE birthdays ADD COLUMN family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_birthdays_family_user
        ON birthdays(family_user_id) WHERE family_user_id IS NOT NULL;

      INSERT INTO contacts (name, category, family_user_id)
      SELECT display_name, 'Sonstiges', id
      FROM users
      WHERE NOT EXISTS (
        SELECT 1 FROM contacts WHERE contacts.family_user_id = users.id
      );
    `,
  };
