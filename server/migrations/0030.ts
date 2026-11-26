export default {
    version: 30,
    description: 'CardDAV multi-account contacts sync',
    up: `
      -- ========================================
      -- CardDAV Accounts
      -- ========================================
      CREATE TABLE carddav_accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        carddav_url TEXT NOT NULL,
        username    TEXT NOT NULL,
        password    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_sync   TEXT,
        UNIQUE(carddav_url, username)
      );

      -- ========================================
      -- CardDAV Addressbook Selection
      -- ========================================
      CREATE TABLE carddav_addressbook_selection (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id       INTEGER NOT NULL,
        addressbook_url  TEXT NOT NULL,
        addressbook_name TEXT NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(account_id, addressbook_url),
        FOREIGN KEY(account_id) REFERENCES carddav_accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_carddav_addressbook_account
        ON carddav_addressbook_selection(account_id, enabled);

      -- ========================================
      -- Extend Contacts Table for CardDAV
      -- ========================================
      ALTER TABLE contacts ADD COLUMN organization TEXT;
      ALTER TABLE contacts ADD COLUMN job_title TEXT;
      ALTER TABLE contacts ADD COLUMN birthday TEXT;
      ALTER TABLE contacts ADD COLUMN website TEXT;
      ALTER TABLE contacts ADD COLUMN photo TEXT;
      ALTER TABLE contacts ADD COLUMN nickname TEXT;
      ALTER TABLE contacts ADD COLUMN carddav_account_id INTEGER
        REFERENCES carddav_accounts(id) ON DELETE SET NULL;
      ALTER TABLE contacts ADD COLUMN carddav_uid TEXT;
      ALTER TABLE contacts ADD COLUMN carddav_addressbook_url TEXT;

      CREATE INDEX idx_contacts_carddav_uid ON contacts(carddav_uid);
      CREATE INDEX idx_contacts_email ON contacts(email);

      -- UNIQUE constraint for CardDAV UIDs (prevents duplicates per account+addressbook)
      CREATE UNIQUE INDEX idx_contacts_carddav_uid_unique
        ON contacts(carddav_account_id, carddav_addressbook_url, carddav_uid)
        WHERE carddav_uid IS NOT NULL;

      -- ========================================
      -- Contact Phones (Multiple per Contact)
      -- ========================================
      CREATE TABLE contact_phones (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL,
        label      TEXT,
        value      TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_contact_phones_contact ON contact_phones(contact_id);
      CREATE INDEX idx_contact_phones_value ON contact_phones(value);

      -- ========================================
      -- Contact Emails (Multiple per Contact)
      -- ========================================
      CREATE TABLE contact_emails (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER NOT NULL,
        label      TEXT,
        value      TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_contact_emails_contact ON contact_emails(contact_id);
      CREATE INDEX idx_contact_emails_value ON contact_emails(value);

      -- ========================================
      -- Contact Addresses (Multiple per Contact)
      -- ========================================
      CREATE TABLE contact_addresses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id  INTEGER NOT NULL,
        label       TEXT,
        street      TEXT,
        city        TEXT,
        state       TEXT,
        postal_code TEXT,
        country     TEXT,
        is_primary  INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_contact_addresses_contact ON contact_addresses(contact_id);
    `,
  };
