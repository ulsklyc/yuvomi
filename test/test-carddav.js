/**
 * Test: CardDAV Contacts Schema
 * Purpose: Verify Migration 30 - CardDAV multi-account contacts sync tables
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../server/db.js';
import { pruneRemovedContacts, fetchVCardsResilient } from '../server/services/cardav-sync.js';

const TEST_DB = ':memory:';

describe('CardDAV Contacts Schema (Migration 30)', () => {
  let db;

  before(() => {
    // Create in-memory DB with better-sqlite3 to apply migrations
    db = new Database(TEST_DB);
    db.pragma('foreign_keys = ON');

    // Create minimal schema to satisfy Migration 30 dependencies
    // Migration 30 expects: users table and contacts table to exist
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      CREATE TABLE contacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT 'Sonstiges',
        phone      TEXT,
        email      TEXT,
        address    TEXT,
        notes      TEXT,
        family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO users (username) VALUES ('testuser');
    `);

    // Find and apply Migration 30 from the MIGRATIONS array
    const migration30 = MIGRATIONS.find(m => m.version === 30);
    if (!migration30) {
      throw new Error('Migration 30 not found in MIGRATIONS array');
    }

    // Apply Migration 30 (it's a string, not a function)
    db.exec(migration30.up);
  });

  // ========================================
  // Table Existence Tests
  // ========================================

  it('should create carddav_accounts table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='carddav_accounts'").get();
    assert.ok(result, 'carddav_accounts table should exist');
  });

  it('should create carddav_addressbook_selection table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='carddav_addressbook_selection'").get();
    assert.ok(result, 'carddav_addressbook_selection table should exist');
  });

  it('should create contact_phones table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_phones'").get();
    assert.ok(result, 'contact_phones table should exist');
  });

  it('should create contact_emails table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_emails'").get();
    assert.ok(result, 'contact_emails table should exist');
  });

  it('should create contact_addresses table', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_addresses'").get();
    assert.ok(result, 'contact_addresses table should exist');
  });

  // ========================================
  // Contacts Table Extension Tests
  // ========================================

  it('should extend contacts table with CardDAV columns', () => {
    const cols = db.prepare("PRAGMA table_info(contacts)").all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('organization'), 'Should have organization column');
    assert.ok(colNames.includes('job_title'), 'Should have job_title column');
    assert.ok(colNames.includes('birthday'), 'Should have birthday column');
    assert.ok(colNames.includes('website'), 'Should have website column');
    assert.ok(colNames.includes('photo'), 'Should have photo column');
    assert.ok(colNames.includes('nickname'), 'Should have nickname column');
    assert.ok(colNames.includes('carddav_account_id'), 'Should have carddav_account_id column');
    assert.ok(colNames.includes('carddav_uid'), 'Should have carddav_uid column');
    assert.ok(colNames.includes('carddav_addressbook_url'), 'Should have carddav_addressbook_url column');
  });

  // ========================================
  // Index Tests
  // ========================================

  it('should create index on contacts.carddav_uid', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contacts_carddav_uid'").get();
    assert.ok(result, 'Index on carddav_uid should exist');
  });

  it('should create index on contacts.email', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contacts_email'").get();
    assert.ok(result, 'Index on email should exist');
  });

  it('should create index on contact_phones.contact_id', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_phones_contact'").get();
    assert.ok(result, 'Index on contact_phones.contact_id should exist');
  });

  it('should create index on contact_phones.value', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_phones_value'").get();
    assert.ok(result, 'Index on contact_phones.value should exist');
  });

  it('should create index on contact_emails.contact_id', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_emails_contact'").get();
    assert.ok(result, 'Index on contact_emails.contact_id should exist');
  });

  it('should create index on contact_emails.value', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_emails_value'").get();
    assert.ok(result, 'Index on contact_emails.value should exist');
  });

  it('should create index on contact_addresses.contact_id', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_addresses_contact'").get();
    assert.ok(result, 'Index on contact_addresses.contact_id should exist');
  });

  it('should create unique index on carddav_uid per account+addressbook', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contacts_carddav_uid_unique'").get();
    assert.ok(result, 'Unique index on carddav_uid should exist');
  });

  // ========================================
  // UNIQUE Constraint Tests
  // ========================================

  it('should enforce UNIQUE(carddav_url, username) on carddav_accounts', () => {
    db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Test Account', 'https://carddav.example.com', 'user1', 'pass1');

    const account = db.prepare('SELECT * FROM carddav_accounts WHERE name = ?').get('Test Account');
    assert.ok(account, 'Account should be inserted');

    // Duplicate should fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Duplicate', 'https://carddav.example.com', 'user1', 'pass2');
    }, 'UNIQUE constraint should prevent duplicate carddav_url+username');
  });

  it('should enforce UNIQUE(account_id, addressbook_url) on addressbook_selection', () => {
    const accountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Test Account').id;

    db.prepare(`
      INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name)
      VALUES (?, ?, ?)
    `).run(accountId, 'https://carddav.example.com/addressbooks/main', 'Main Addressbook');

    // Duplicate should fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name)
        VALUES (?, ?, ?)
      `).run(accountId, 'https://carddav.example.com/addressbooks/main', 'Duplicate');
    }, 'UNIQUE constraint should prevent duplicate account_id+addressbook_url');
  });

  // ========================================
  // Foreign Key Cascade Tests
  // ========================================

  it('should CASCADE delete addressbook_selection when account deleted', () => {
    const accountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Test Account').id;

    // Verify addressbook exists
    const beforeDelete = db.prepare('SELECT * FROM carddav_addressbook_selection WHERE account_id = ?').get(accountId);
    assert.ok(beforeDelete, 'Addressbook selection should exist before delete');

    // Delete account
    db.prepare('DELETE FROM carddav_accounts WHERE id = ?').run(accountId);

    // Addressbook selection should be deleted
    const afterDelete = db.prepare('SELECT * FROM carddav_addressbook_selection WHERE account_id = ?').get(accountId);
    assert.strictEqual(afterDelete, undefined, 'Addressbook selection should CASCADE delete');
  });

  it('should CASCADE delete contact_phones when contact deleted', () => {
    // Create contact
    db.prepare(`
      INSERT INTO contacts (name, category)
      VALUES (?, ?)
    `).run('John Doe', 'Sonstiges');

    const contactId = db.prepare('SELECT id FROM contacts WHERE name = ?').get('John Doe').id;

    // Add phones
    db.prepare(`
      INSERT INTO contact_phones (contact_id, label, value, is_primary)
      VALUES (?, ?, ?, ?)
    `).run(contactId, 'mobile', '+1234567890', 1);

    db.prepare(`
      INSERT INTO contact_phones (contact_id, label, value)
      VALUES (?, ?, ?)
    `).run(contactId, 'work', '+0987654321');

    // Verify phones exist
    const phonesBefore = db.prepare('SELECT * FROM contact_phones WHERE contact_id = ?').all(contactId);
    assert.strictEqual(phonesBefore.length, 2, 'Should have 2 phone numbers');

    // Delete contact
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

    // Phones should be deleted
    const phonesAfter = db.prepare('SELECT * FROM contact_phones WHERE contact_id = ?').all(contactId);
    assert.strictEqual(phonesAfter.length, 0, 'Phone numbers should CASCADE delete');
  });

  it('should CASCADE delete contact_emails when contact deleted', () => {
    // Create contact
    db.prepare(`
      INSERT INTO contacts (name, category)
      VALUES (?, ?)
    `).run('Jane Smith', 'Sonstiges');

    const contactId = db.prepare('SELECT id FROM contacts WHERE name = ?').get('Jane Smith').id;

    // Add emails
    db.prepare(`
      INSERT INTO contact_emails (contact_id, label, value, is_primary)
      VALUES (?, ?, ?, ?)
    `).run(contactId, 'work', 'jane@work.com', 1);

    db.prepare(`
      INSERT INTO contact_emails (contact_id, label, value)
      VALUES (?, ?, ?)
    `).run(contactId, 'home', 'jane@home.com');

    // Verify emails exist
    const emailsBefore = db.prepare('SELECT * FROM contact_emails WHERE contact_id = ?').all(contactId);
    assert.strictEqual(emailsBefore.length, 2, 'Should have 2 email addresses');

    // Delete contact
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

    // Emails should be deleted
    const emailsAfter = db.prepare('SELECT * FROM contact_emails WHERE contact_id = ?').all(contactId);
    assert.strictEqual(emailsAfter.length, 0, 'Email addresses should CASCADE delete');
  });

  it('should CASCADE delete contact_addresses when contact deleted', () => {
    // Create contact
    db.prepare(`
      INSERT INTO contacts (name, category)
      VALUES (?, ?)
    `).run('Bob Johnson', 'Sonstiges');

    const contactId = db.prepare('SELECT id FROM contacts WHERE name = ?').get('Bob Johnson').id;

    // Add addresses
    db.prepare(`
      INSERT INTO contact_addresses (contact_id, label, street, city, is_primary)
      VALUES (?, ?, ?, ?, ?)
    `).run(contactId, 'home', '123 Main St', 'Springfield', 1);

    db.prepare(`
      INSERT INTO contact_addresses (contact_id, label, street, city)
      VALUES (?, ?, ?, ?)
    `).run(contactId, 'work', '456 Office Blvd', 'Metropolis');

    // Verify addresses exist
    const addressesBefore = db.prepare('SELECT * FROM contact_addresses WHERE contact_id = ?').all(contactId);
    assert.strictEqual(addressesBefore.length, 2, 'Should have 2 addresses');

    // Delete contact
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

    // Addresses should be deleted
    const addressesAfter = db.prepare('SELECT * FROM contact_addresses WHERE contact_id = ?').all(contactId);
    assert.strictEqual(addressesAfter.length, 0, 'Addresses should CASCADE delete');
  });

  it('should SET NULL on contacts.carddav_account_id when account deleted', () => {
    // Create new account
    db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('iCloud', 'https://contacts.icloud.com', 'user@icloud.com', 'pass');

    const accountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud').id;

    // Create contact linked to account
    db.prepare(`
      INSERT INTO contacts (name, category, carddav_account_id, carddav_uid)
      VALUES (?, ?, ?, ?)
    `).run('Alice Cooper', 'Sonstiges', accountId, 'urn:uuid:12345');

    const contactId = db.prepare('SELECT id FROM contacts WHERE name = ?').get('Alice Cooper').id;

    // Verify link
    const beforeDelete = db.prepare('SELECT carddav_account_id FROM contacts WHERE id = ?').get(contactId);
    assert.strictEqual(beforeDelete.carddav_account_id, accountId, 'Contact should be linked to account');

    // Delete account
    db.prepare('DELETE FROM carddav_accounts WHERE id = ?').run(accountId);

    // Contact should remain but link should be NULL
    const afterDelete = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    assert.ok(afterDelete, 'Contact should still exist');
    assert.strictEqual(afterDelete.carddav_account_id, null, 'carddav_account_id should be SET NULL');
  });

  // ========================================
  // Data Integrity Tests
  // ========================================

  it('should handle enabled/disabled addressbook selection', () => {
    // Create account
    db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Nextcloud', 'https://nextcloud.example.com/dav', 'user@example.com', 'pass');

    const accountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Nextcloud').id;

    // Add addressbooks
    db.prepare(`
      INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      accountId, 'https://nextcloud.example.com/dav/contacts/private', 'Private', 1,
      accountId, 'https://nextcloud.example.com/dav/contacts/work', 'Work', 0
    );

    // Query enabled only
    const enabled = db.prepare('SELECT * FROM carddav_addressbook_selection WHERE account_id = ? AND enabled = 1').all(accountId);
    assert.strictEqual(enabled.length, 1, 'Should have 1 enabled addressbook');
    assert.strictEqual(enabled[0].addressbook_name, 'Private');

    // Query all
    const all = db.prepare('SELECT * FROM carddav_addressbook_selection WHERE account_id = ?').all(accountId);
    assert.strictEqual(all.length, 2, 'Should have 2 total addressbooks');
  });

  it('should handle is_primary flag on contact phones', () => {
    // Create contact
    db.prepare(`
      INSERT INTO contacts (name, category)
      VALUES (?, ?)
    `).run('Test Primary', 'Sonstiges');

    const contactId = db.prepare('SELECT id FROM contacts WHERE name = ?').get('Test Primary').id;

    // Add multiple phones with one primary
    db.prepare(`
      INSERT INTO contact_phones (contact_id, label, value, is_primary)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      contactId, 'mobile', '+1111111111', 1,
      contactId, 'home', '+2222222222', 0
    );

    // Query primary
    const primary = db.prepare('SELECT * FROM contact_phones WHERE contact_id = ? AND is_primary = 1').get(contactId);
    assert.ok(primary, 'Should have a primary phone');
    assert.strictEqual(primary.value, '+1111111111');
    assert.strictEqual(primary.label, 'mobile');
  });

  it('should allow manual contacts (NULL carddav_account_id)', () => {
    db.prepare(`
      INSERT INTO contacts (name, category, phone, email, carddav_account_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('Manual Contact', 'Sonstiges', '+9999999999', 'manual@example.com', null);

    const contact = db.prepare('SELECT * FROM contacts WHERE name = ?').get('Manual Contact');
    assert.ok(contact, 'Manual contact should be created');
    assert.strictEqual(contact.carddav_account_id, null, 'Manual contact should have NULL carddav_account_id');
  });

  it('should enforce UNIQUE constraint on carddav_uid per account+addressbook', () => {
    // Create account
    db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Test Sync Account', 'https://carddav.test.com', 'sync@test.com', 'pass');

    const accountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Test Sync Account').id;

    // Create first contact with CardDAV UID
    db.prepare(`
      INSERT INTO contacts (name, category, carddav_account_id, carddav_uid, carddav_addressbook_url)
      VALUES (?, ?, ?, ?, ?)
    `).run('Contact A', 'Sonstiges', accountId, 'urn:uuid:12345', 'https://carddav.test.com/addressbooks/main');

    const firstContact = db.prepare('SELECT * FROM contacts WHERE name = ?').get('Contact A');
    assert.ok(firstContact, 'First contact should be created');

    // Attempt to create duplicate with same account_id, addressbook_url, and uid should fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO contacts (name, category, carddav_account_id, carddav_uid, carddav_addressbook_url)
        VALUES (?, ?, ?, ?, ?)
      `).run('Contact B', 'Sonstiges', accountId, 'urn:uuid:12345', 'https://carddav.test.com/addressbooks/main');
    }, 'UNIQUE constraint should prevent duplicate carddav_uid in same account+addressbook');

    // But same UID in different addressbook should work
    db.prepare(`
      INSERT INTO contacts (name, category, carddav_account_id, carddav_uid, carddav_addressbook_url)
      VALUES (?, ?, ?, ?, ?)
    `).run('Contact C', 'Sonstiges', accountId, 'urn:uuid:12345', 'https://carddav.test.com/addressbooks/work');

    const differentAddressbook = db.prepare('SELECT * FROM contacts WHERE name = ?').get('Contact C');
    assert.ok(differentAddressbook, 'Same UID in different addressbook should be allowed');

    // Create another account
    db.prepare(`
      INSERT INTO carddav_accounts (name, carddav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Another Account', 'https://other.carddav.com', 'user@other.com', 'pass');

    const otherAccountId = db.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Another Account').id;

    // Same UID in different account should work
    db.prepare(`
      INSERT INTO contacts (name, category, carddav_account_id, carddav_uid, carddav_addressbook_url)
      VALUES (?, ?, ?, ?, ?)
    `).run('Contact D', 'Sonstiges', otherAccountId, 'urn:uuid:12345', 'https://other.carddav.com/addressbooks/main');

    const differentAccount = db.prepare('SELECT * FROM contacts WHERE name = ?').get('Contact D');
    assert.ok(differentAccount, 'Same UID in different account should be allowed');
  });
});

// ========================================
// CardDAV Sync Service Tests
// ========================================

describe('CardDAV Sync Service', () => {
  let testDb;
  let parseVCard;

  before(async () => {
    // Create in-memory test database
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');

    // Create minimal schema
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      CREATE TABLE contacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT 'Sonstiges',
        phone      TEXT,
        email      TEXT,
        address    TEXT,
        notes      TEXT,
        family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO users (username) VALUES ('testuser');
    `);

    // Apply Migration 30
    const migration30 = MIGRATIONS.find(m => m.version === 30);
    if (!migration30) {
      throw new Error('Migration 30 not found');
    }
    testDb.exec(migration30.up);

    // Import parseVCard helper for testing
    const cardavSync = await import('../server/services/cardav-sync.js');
    parseVCard = cardavSync.parseVCard;
  });

  // ========================================
  // vCard Parsing Tests
  // ========================================

  describe('parseVCard', () => {
    it('should parse basic vCard with FN and UID', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.uid, 'urn:uuid:12345');
      assert.strictEqual(result.name, 'John Doe');
    });

    it('should parse N as fallback when FN missing', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
N:Doe;John;Middle;Mr.;Jr.
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.uid, 'urn:uuid:12345');
      assert.ok(result.name.includes('Doe'));
      assert.ok(result.name.includes('John'));
    });

    it('should parse TEL fields with types', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
TEL;TYPE=CELL:+1234567890
TEL;TYPE=WORK:+0987654321
TEL;TYPE=HOME:+1111111111
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.phones.length, 3);

      const cellPhone = result.phones.find(p => p.label === 'cell');
      assert.ok(cellPhone);
      assert.strictEqual(cellPhone.value, '+1234567890');

      const workPhone = result.phones.find(p => p.label === 'work');
      assert.ok(workPhone);
      assert.strictEqual(workPhone.value, '+0987654321');
    });

    it('should parse EMAIL fields with types', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
EMAIL;TYPE=HOME:john@home.com
EMAIL;TYPE=WORK:john@work.com
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.emails.length, 2);

      const homeEmail = result.emails.find(e => e.label === 'home');
      assert.ok(homeEmail);
      assert.strictEqual(homeEmail.value, 'john@home.com');
    });

    it('should parse ADR fields', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
ADR;TYPE=HOME:;;123 Main St;Springfield;IL;62701;USA
ADR;TYPE=WORK:;;456 Office Blvd;Metropolis;NY;10001;USA
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.addresses.length, 2);

      const homeAddr = result.addresses.find(a => a.label === 'home');
      assert.ok(homeAddr);
      assert.strictEqual(homeAddr.street, '123 Main St');
      assert.strictEqual(homeAddr.city, 'Springfield');
      assert.strictEqual(homeAddr.state, 'IL');
      assert.strictEqual(homeAddr.postalCode, '62701');
      assert.strictEqual(homeAddr.country, 'USA');
    });

    it('should parse organization and job title', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
ORG:Acme Corporation
TITLE:Senior Engineer
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.organization, 'Acme Corporation');
      assert.strictEqual(result.jobTitle, 'Senior Engineer');
    });

    it('should parse birthday in various formats', () => {
      const vCardText1 = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
BDAY:1990-05-15
END:VCARD`;

      const result1 = parseVCard(vCardText1);
      assert.strictEqual(result1.birthday, '1990-05-15');

      const vCardText2 = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:Jane Doe
BDAY:19850312
END:VCARD`;

      const result2 = parseVCard(vCardText2);
      assert.strictEqual(result2.birthday, '1985-03-12');
    });

    it('should parse URL, NICKNAME, NOTE, CATEGORIES', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
URL:https://example.com
NICKNAME:Johnny
NOTE:Important contact
CATEGORIES:Friends
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.website, 'https://example.com');
      assert.strictEqual(result.nickname, 'Johnny');
      assert.strictEqual(result.notes, 'Important contact');
      assert.strictEqual(result.categories, 'Friends');
    });

    it('should handle line folding', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
NOTE:This is a very long note that spans
 multiple lines and should be
 concatenated properly
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.ok(result.notes.includes('very long note'));
      assert.ok(result.notes.includes('multiple lines'));
      assert.ok(result.notes.includes('concatenated properly'));
    });

    it('should handle vCards with minimal data', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:minimal
FN:Minimal Contact
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.uid, 'urn:uuid:minimal');
      assert.strictEqual(result.name, 'Minimal Contact');
      assert.strictEqual(result.phones.length, 0);
      assert.strictEqual(result.emails.length, 0);
      assert.strictEqual(result.addresses.length, 0);
    });

    it('should handle TEL without TYPE parameter', () => {
      const vCardText = `BEGIN:VCARD
VERSION:3.0
UID:urn:uuid:12345
FN:John Doe
TEL;CELL:+1234567890
TEL;VOICE;WORK:+0987654321
END:VCARD`;

      const result = parseVCard(vCardText);
      assert.strictEqual(result.phones.length, 2);

      // Should extract CELL and WORK from parameter names
      const cellPhone = result.phones.find(p => p.label === 'cell');
      assert.ok(cellPhone);

      const workPhone = result.phones.find(p => p.label === 'work');
      assert.ok(workPhone);
    });
  });

  // ========================================
  // Database Integration Tests
  // ========================================

  describe('Account Management (DB)', () => {
    it('should store and retrieve account correctly', () => {
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Test Account', 'https://carddav.example.com', 'user@example.com', 'password123');

      const account = testDb.prepare('SELECT * FROM carddav_accounts WHERE name = ?').get('Test Account');
      assert.ok(account);
      assert.strictEqual(account.name, 'Test Account');
      assert.strictEqual(account.carddav_url, 'https://carddav.example.com');
      assert.strictEqual(account.username, 'user@example.com');
      assert.strictEqual(account.password, 'password123');
    });

    it('should create addressbook selections for account', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Account For Addressbooks', 'https://example.com/dav', 'user1@example.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Account For Addressbooks').id;

      testDb.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        accountId, 'https://example.com/dav/addressbooks/personal', 'Personal', 1,
        accountId, 'https://example.com/dav/addressbooks/work', 'Work', 0
      );

      const enabled = testDb.prepare(`
        SELECT * FROM carddav_addressbook_selection
        WHERE account_id = ? AND enabled = 1
      `).all(accountId);

      assert.strictEqual(enabled.length, 1);
      assert.strictEqual(enabled[0].addressbook_name, 'Personal');

      const all = testDb.prepare(`
        SELECT * FROM carddav_addressbook_selection
        WHERE account_id = ?
      `).all(accountId);

      assert.strictEqual(all.length, 2);
    });

    it('should reject duplicate accounts (same URL + username)', () => {
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Nextcloud Test', 'https://nextcloud.test.com/dav', 'user@nextcloud.com', 'pass1');

      // Attempt to insert duplicate
      assert.throws(() => {
        testDb.prepare(`
          INSERT INTO carddav_accounts (name, carddav_url, username, password)
          VALUES (?, ?, ?, ?)
        `).run('Nextcloud Test 2', 'https://nextcloud.test.com/dav', 'user@nextcloud.com', 'pass2');
      }, 'UNIQUE constraint should prevent duplicate carddav_url+username');
    });

    it('should delete account and set carddav_account_id = NULL on contacts', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Account For Deletion', 'https://delete.example.com', 'user@delete.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Account For Deletion').id;

      // Create contact linked to this account
      testDb.prepare(`
        INSERT INTO contacts (name, category, carddav_account_id, carddav_uid)
        VALUES (?, ?, ?, ?)
      `).run('Test Contact For Deletion', 'Sonstiges', accountId, 'urn:uuid:test-contact-delete');

      const contactId = testDb.prepare('SELECT id FROM contacts WHERE name = ?').get('Test Contact For Deletion').id;

      // Verify contact is linked
      const beforeDelete = testDb.prepare('SELECT carddav_account_id FROM contacts WHERE id = ?').get(contactId);
      assert.strictEqual(beforeDelete.carddav_account_id, accountId);

      // Delete account
      testDb.prepare('DELETE FROM carddav_accounts WHERE id = ?').run(accountId);

      // Contact should remain but carddav_account_id should be NULL
      const afterDelete = testDb.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
      assert.ok(afterDelete, 'Contact should still exist');
      assert.strictEqual(afterDelete.carddav_account_id, null, 'carddav_account_id should be SET NULL');
    });

    it('should retrieve password correctly from database', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud Password Test', 'https://contacts.icloud.com', 'test@icloud.com', 'my-secret-password');

      const account = testDb.prepare('SELECT * FROM carddav_accounts WHERE name = ?').get('iCloud Password Test');
      assert.strictEqual(account.password, 'my-secret-password', 'Password should be retrievable');
    });
  });

  describe('Addressbook Discovery UPSERT', () => {
    it('should insert new addressbook for account', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud UPSERT', 'https://contacts.upsert.icloud.com', 'test@upsert.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud UPSERT').id;

      testDb.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, ?)
      `).run(accountId, 'https://contacts.upsert.icloud.com/123456/personal', 'Personal', 1);

      const addressbook = testDb.prepare(`
        SELECT * FROM carddav_addressbook_selection
        WHERE account_id = ? AND addressbook_url = ?
      `).get(accountId, 'https://contacts.upsert.icloud.com/123456/personal');

      assert.ok(addressbook);
      assert.strictEqual(addressbook.addressbook_name, 'Personal');
      assert.strictEqual(addressbook.enabled, 1);
    });

    it('should update existing addressbook name while preserving enabled state', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud Update', 'https://contacts.update.icloud.com', 'test@update.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud Update').id;

      // Create initial addressbook
      testDb.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, ?)
      `).run(accountId, 'https://contacts.update.icloud.com/123456/personal', 'Personal', 1);

      const existing = testDb.prepare(`
        SELECT id, enabled FROM carddav_addressbook_selection
        WHERE account_id = ? AND addressbook_url = ?
      `).get(accountId, 'https://contacts.update.icloud.com/123456/personal');

      // Disable it
      testDb.prepare('UPDATE carddav_addressbook_selection SET enabled = 0 WHERE id = ?').run(existing.id);

      // Update name (simulating rediscovery)
      testDb.prepare(`
        UPDATE carddav_addressbook_selection
        SET addressbook_name = ?
        WHERE id = ?
      `).run('Personal Contacts', existing.id);

      const updated = testDb.prepare('SELECT * FROM carddav_addressbook_selection WHERE id = ?').get(existing.id);
      assert.strictEqual(updated.addressbook_name, 'Personal Contacts', 'Name should be updated');
      assert.strictEqual(updated.enabled, 0, 'Enabled state should be preserved');
    });

    it('should not insert duplicate addressbook for same account+url', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud Duplicate', 'https://contacts.duplicate.icloud.com', 'test@dup.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud Duplicate').id;

      // Create first addressbook
      testDb.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, ?)
      `).run(accountId, 'https://contacts.duplicate.icloud.com/123456/personal', 'Personal', 1);

      assert.throws(() => {
        testDb.prepare(`
          INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
          VALUES (?, ?, ?, ?)
        `).run(accountId, 'https://contacts.duplicate.icloud.com/123456/personal', 'Duplicate', 1);
      }, 'UNIQUE constraint should prevent duplicate account_id+addressbook_url');
    });
  });

  describe('Addressbook Toggle', () => {
    it('should toggle addressbook enabled state', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud Toggle', 'https://contacts.toggle.icloud.com', 'test@toggle.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud Toggle').id;

      // Create addressbook with enabled=0
      testDb.prepare(`
        INSERT INTO carddav_addressbook_selection (account_id, addressbook_url, addressbook_name, enabled)
        VALUES (?, ?, ?, ?)
      `).run(accountId, 'https://contacts.toggle.icloud.com/123456/personal', 'Personal', 0);

      const addressbook = testDb.prepare(`
        SELECT * FROM carddav_addressbook_selection
        WHERE account_id = ? AND addressbook_url = ?
      `).get(accountId, 'https://contacts.toggle.icloud.com/123456/personal');

      // Initially disabled
      assert.strictEqual(addressbook.enabled, 0);

      // Enable it
      testDb.prepare('UPDATE carddav_addressbook_selection SET enabled = 1 WHERE id = ?').run(addressbook.id);

      const enabled = testDb.prepare('SELECT * FROM carddav_addressbook_selection WHERE id = ?').get(addressbook.id);
      assert.strictEqual(enabled.enabled, 1);

      // Disable it again
      testDb.prepare('UPDATE carddav_addressbook_selection SET enabled = 0 WHERE id = ?').run(addressbook.id);

      const disabled = testDb.prepare('SELECT * FROM carddav_addressbook_selection WHERE id = ?').get(addressbook.id);
      assert.strictEqual(disabled.enabled, 0);
    });
  });

  describe('Contact Merge Logic (DB)', () => {
    let aliceContact;
    let accountId;

    before(() => {
      // Create account
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Account For vCard', 'https://vcard.example.com', 'user@vcard.com', 'pass');

      accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('Account For vCard').id;

      // Create Alice Smith
      testDb.prepare(`
        INSERT INTO contacts (
          name, category, organization, job_title, birthday, website,
          nickname, notes,
          carddav_account_id, carddav_uid, carddav_addressbook_url
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'Alice Smith',
        'Sonstiges',
        'Tech Corp',
        'Developer',
        '1990-01-15',
        'https://alice.dev',
        'Ali',
        'Great developer',
        accountId,
        'urn:uuid:alice-123',
        'https://vcard.example.com/addressbooks/personal'
      );

      aliceContact = testDb.prepare('SELECT * FROM contacts WHERE name = ?').get('Alice Smith');
    });

    it('should create new contact from vCard', () => {
      assert.ok(aliceContact);
      assert.strictEqual(aliceContact.organization, 'Tech Corp');
      assert.strictEqual(aliceContact.job_title, 'Developer');
      assert.strictEqual(aliceContact.birthday, '1990-01-15');
      assert.strictEqual(aliceContact.carddav_uid, 'urn:uuid:alice-123');
    });

    it('should add multiple phones to contact', () => {
      testDb.prepare(`
        INSERT INTO contact_phones (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        aliceContact.id, 'mobile', '+1234567890', 1,
        aliceContact.id, 'work', '+0987654321', 0
      );

      const phones = testDb.prepare('SELECT * FROM contact_phones WHERE contact_id = ?').all(aliceContact.id);
      assert.strictEqual(phones.length, 2);

      const primary = phones.find(p => p.is_primary === 1);
      assert.ok(primary);
      assert.strictEqual(primary.value, '+1234567890');
    });

    it('should add multiple emails to contact', () => {
      testDb.prepare(`
        INSERT INTO contact_emails (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run(
        aliceContact.id, 'home', 'alice@home.com', 1,
        aliceContact.id, 'work', 'alice@work.com', 0
      );

      const emails = testDb.prepare('SELECT * FROM contact_emails WHERE contact_id = ?').all(aliceContact.id);
      assert.strictEqual(emails.length, 2);

      const primary = emails.find(e => e.is_primary === 1);
      assert.ok(primary);
      assert.strictEqual(primary.value, 'alice@home.com');
    });

    it('should add multiple addresses to contact', () => {
      testDb.prepare(`
        INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        aliceContact.id, 'home', '123 Main St', 'Springfield', 'IL', '62701', 'USA', 1
      );

      const addresses = testDb.prepare('SELECT * FROM contact_addresses WHERE contact_id = ?').all(aliceContact.id);
      assert.strictEqual(addresses.length, 1);
      assert.strictEqual(addresses[0].street, '123 Main St');
      assert.strictEqual(addresses[0].is_primary, 1);
    });

    it('should preserve primary entries when updating multi-values', () => {
      // Mark first phone as primary (manually set)
      testDb.prepare('UPDATE contact_phones SET is_primary = 1 WHERE contact_id = ? AND label = ?')
        .run(aliceContact.id, 'mobile');

      // Delete non-primary phones (simulating sync update)
      testDb.prepare('DELETE FROM contact_phones WHERE contact_id = ? AND is_primary = 0')
        .run(aliceContact.id);

      // Add new phones from vCard
      testDb.prepare(`
        INSERT INTO contact_phones (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(aliceContact.id, 'home', '+9999999999', 0);

      const phones = testDb.prepare('SELECT * FROM contact_phones WHERE contact_id = ?').all(aliceContact.id);

      // Should have primary mobile + new home phone
      assert.strictEqual(phones.length, 2);

      const primaryPhone = phones.find(p => p.is_primary === 1);
      assert.ok(primaryPhone);
      assert.strictEqual(primaryPhone.label, 'mobile');
    });

    it('should find contact by email match', () => {
      // Create manual contact with email
      testDb.prepare(`
        INSERT INTO contacts (name, category, email)
        VALUES (?, ?, ?)
      `).run('Bob Jones', 'Sonstiges', 'bob@example.com');

      const contactId = testDb.prepare('SELECT id FROM contacts WHERE name = ?').get('Bob Jones').id;

      // Also add to contact_emails
      testDb.prepare(`
        INSERT INTO contact_emails (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'work', 'bob@work.com', 0);

      // Search by email (simulating merge logic)
      const foundByOldEmail = testDb.prepare(`
        SELECT c.* FROM contacts c
        WHERE c.email = ?
      `).get('bob@example.com');

      assert.ok(foundByOldEmail);
      assert.strictEqual(foundByOldEmail.name, 'Bob Jones');

      const foundByNewEmail = testDb.prepare(`
        SELECT c.* FROM contacts c
        LEFT JOIN contact_emails ce ON c.id = ce.contact_id
        WHERE ce.value = ?
      `).get('bob@work.com');

      assert.ok(foundByNewEmail);
      assert.strictEqual(foundByNewEmail.name, 'Bob Jones');
    });

    it('should find contact by phone match', () => {
      // Create manual contact with phone
      testDb.prepare(`
        INSERT INTO contacts (name, category, phone)
        VALUES (?, ?, ?)
      `).run('Carol White', 'Sonstiges', '+5555555555');

      const contactId = testDb.prepare('SELECT id FROM contacts WHERE name = ?').get('Carol White').id;

      // Also add to contact_phones
      testDb.prepare(`
        INSERT INTO contact_phones (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'mobile', '+6666666666', 0);

      // Search by phone (simulating merge logic)
      const foundByOldPhone = testDb.prepare(`
        SELECT c.* FROM contacts c
        WHERE c.phone = ?
      `).get('+5555555555');

      assert.ok(foundByOldPhone);
      assert.strictEqual(foundByOldPhone.name, 'Carol White');

      const foundByNewPhone = testDb.prepare(`
        SELECT c.* FROM contacts c
        LEFT JOIN contact_phones cp ON c.id = cp.contact_id
        WHERE cp.value = ?
      `).get('+6666666666');

      assert.ok(foundByNewPhone);
      assert.strictEqual(foundByNewPhone.name, 'Carol White');
    });

    it('should only update NULL fields when merging', () => {
      // Create contact with some fields filled
      testDb.prepare(`
        INSERT INTO contacts (name, category, organization, job_title)
        VALUES (?, ?, ?, ?)
      `).run('Dave Brown', 'Sonstiges', 'Local Company', 'Manager');

      const contactId = testDb.prepare('SELECT id FROM contacts WHERE name = ?').get('Dave Brown').id;

      // Simulate merge: only update NULL fields
      const updates = [];
      const values = [];

      const contact = testDb.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);

      // birthday is NULL, should update
      if (contact.birthday === null) {
        updates.push('birthday = ?');
        values.push('1985-07-20');
      }

      // organization is NOT NULL, should not update
      if (contact.organization === null) {
        updates.push('organization = ?');
        values.push('New Company');
      }

      values.push(contactId);

      if (updates.length > 0) {
        testDb.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      const updated = testDb.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);

      // birthday should be updated
      assert.strictEqual(updated.birthday, '1985-07-20');

      // organization should remain unchanged
      assert.strictEqual(updated.organization, 'Local Company');
    });

    it('should update existing contact when cardav_uid matches', () => {
      // Create own account first
      testDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('iCloud Sync Account', 'https://contacts.sync.icloud.com', 'test@sync.com', 'pass');

      const accountId = testDb.prepare('SELECT id FROM carddav_accounts WHERE name = ?').get('iCloud Sync Account').id;

      // Create initial contact from CardDAV
      testDb.prepare(`
        INSERT INTO contacts (
          name, category, organization, job_title,
          carddav_account_id, carddav_uid, carddav_addressbook_url
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'John Sync',
        'Sonstiges',
        'SyncCorp',
        'Engineer',
        accountId,
        'urn:uuid:sync-test-123',
        'https://contacts.sync.icloud.com/123456/personal'
      );

      const contactId = testDb.prepare('SELECT id FROM contacts WHERE name = ?').get('John Sync').id;

      // User manually sets birthday
      testDb.prepare('UPDATE contacts SET birthday = ? WHERE id = ?').run('1990-05-15', contactId);

      // Simulate sync update (only update NULL fields)
      const contact = testDb.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);

      const updates = [];
      const values = [];

      // website is NULL, should update
      if (contact.website === null) {
        updates.push('website = ?');
        values.push('https://john.example.com');
      }

      // birthday is NOT NULL (user set it), should not update
      if (contact.birthday === null) {
        updates.push('birthday = ?');
        values.push('1985-01-01');
      }

      // organization is NOT NULL, should not update
      if (contact.organization === null) {
        updates.push('organization = ?');
        values.push('Different Corp');
      }

      if (updates.length > 0) {
        values.push(contactId);
        testDb.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      const updated = testDb.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);

      // website should be updated (was NULL)
      assert.strictEqual(updated.website, 'https://john.example.com');

      // birthday should remain unchanged (user's manual value)
      assert.strictEqual(updated.birthday, '1990-05-15');

      // organization should remain unchanged
      assert.strictEqual(updated.organization, 'SyncCorp');
    });
  });
});

// ========================================
// Multi-Value Validators
// ========================================

describe('Multi-Value Validators', () => {
  let validatePhones, validateEmails, validateAddresses;

  before(async () => {
    const validators = await import('../server/routes/contacts.js');
    validatePhones = validators.validatePhones;
    validateEmails = validators.validateEmails;
    validateAddresses = validators.validateAddresses;
  });

  describe('validatePhones', () => {
    it('should reject non-array input', () => {
      const result = validatePhones('not-an-array');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phones must be an array');
    });

    it('should reject null element', () => {
      const result = validatePhones([null]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone entry must be an object');
    });

    it('should reject primitive element', () => {
      const result = validatePhones(['string']);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone entry must be an object');
    });

    it('should reject phone without label', () => {
      const result = validatePhones([{ value: '+123' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone requires label and value');
    });

    it('should reject phone with whitespace-only label', () => {
      const result = validatePhones([{ label: '   ', value: '+123' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone label invalid or too long');
    });

    it('should reject phone with whitespace-only value', () => {
      const result = validatePhones([{ label: 'mobile', value: '   ' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone value invalid or too long');
    });

    it('should reject phone with too long label', () => {
      const result = validatePhones([{ label: 'x'.repeat(51), value: '+123' }]);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('Phone label invalid or too long'));
    });

    it('should reject non-boolean isPrimary', () => {
      const result = validatePhones([{ label: 'mobile', value: '+123', isPrimary: 'true' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Phone isPrimary must be boolean');
    });

    it('should reject array exceeding max length', () => {
      const phones = Array(21).fill({ label: 'mobile', value: '+123' });
      const result = validatePhones(phones);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Too many phone entries (max 20)');
    });

    it('should accept valid phones array', () => {
      const result = validatePhones([
        { label: 'mobile', value: '+1234567890', isPrimary: true },
        { label: 'work', value: '+0987654321' }
      ]);
      assert.strictEqual(result.valid, true);
    });

    it('should accept phones at max array length', () => {
      const phones = Array(20).fill({ label: 'mobile', value: '+123' });
      const result = validatePhones(phones);
      assert.strictEqual(result.valid, true);
    });
  });

  describe('validateEmails', () => {
    it('should reject non-array input', () => {
      const result = validateEmails('not-an-array');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Emails must be an array');
    });

    it('should reject null element', () => {
      const result = validateEmails([null]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email entry must be an object');
    });

    it('should reject primitive element', () => {
      const result = validateEmails([42]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email entry must be an object');
    });

    it('should reject email without value', () => {
      const result = validateEmails([{ label: 'work' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email requires label and value');
    });

    it('should reject email with whitespace-only label', () => {
      const result = validateEmails([{ label: '  ', value: 'test@example.com' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email label invalid or too long');
    });

    it('should reject email with whitespace-only value', () => {
      const result = validateEmails([{ label: 'work', value: '   ' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email value invalid or too long');
    });

    it('should reject invalid email format', () => {
      const result = validateEmails([{ label: 'work', value: 'notanemail' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email value must be a valid email address');
    });

    it('should reject email with too long value', () => {
      const result = validateEmails([{ label: 'work', value: 'x'.repeat(256) }]);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('Email value invalid or too long'));
    });

    it('should reject non-boolean isPrimary', () => {
      const result = validateEmails([{ label: 'work', value: 'test@example.com', isPrimary: 1 }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Email isPrimary must be boolean');
    });

    it('should reject array exceeding max length', () => {
      const emails = Array(21).fill({ label: 'work', value: 'test@example.com' });
      const result = validateEmails(emails);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Too many email entries (max 20)');
    });

    it('should accept valid emails array', () => {
      const result = validateEmails([
        { label: 'work', value: 'john@work.com', isPrimary: true },
        { label: 'home', value: 'john@home.com' }
      ]);
      assert.strictEqual(result.valid, true);
    });

    it('should accept emails at max array length', () => {
      const emails = Array(20).fill({ label: 'work', value: 'test@example.com' });
      const result = validateEmails(emails);
      assert.strictEqual(result.valid, true);
    });
  });

  describe('validateAddresses', () => {
    it('should reject non-array input', () => {
      const result = validateAddresses('not-an-array');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Addresses must be an array');
    });

    it('should reject null element', () => {
      const result = validateAddresses([null]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Address entry must be an object');
    });

    it('should reject undefined element', () => {
      const result = validateAddresses([undefined]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Address entry must be an object');
    });

    it('should reject address without label', () => {
      const result = validateAddresses([{ street: '123 Main St' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Address requires label');
    });

    it('should reject address with whitespace-only label', () => {
      const result = validateAddresses([{ label: '\t\n  ', street: '123 Main St' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Address label invalid or too long');
    });

    it('should reject address with too long street', () => {
      const result = validateAddresses([{ label: 'home', street: 'x'.repeat(256) }]);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('Address street invalid or too long'));
    });

    it('should reject non-boolean isPrimary', () => {
      const result = validateAddresses([{ label: 'home', street: '123 Main', isPrimary: 'yes' }]);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Address isPrimary must be boolean');
    });

    it('should reject array exceeding max length', () => {
      const addresses = Array(21).fill({ label: 'home' });
      const result = validateAddresses(addresses);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Too many address entries (max 20)');
    });

    it('should accept valid addresses array', () => {
      const result = validateAddresses([
        {
          label: 'home',
          street: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'USA',
          isPrimary: true
        },
        {
          label: 'work',
          street: '456 Office Blvd',
          city: 'Metropolis'
        }
      ]);
      assert.strictEqual(result.valid, true);
    });

    it('should accept addresses at max array length', () => {
      const addresses = Array(20).fill({ label: 'home' });
      const result = validateAddresses(addresses);
      assert.strictEqual(result.valid, true);
    });
  });
});

// ========================================
// CardDAV API Routes
// ========================================

describe('CardDAV API Routes', () => {
  let apiTestDb;

  before(async () => {
    // Create in-memory test database for API routes
    apiTestDb = new Database(':memory:');
    apiTestDb.pragma('foreign_keys = ON');

    // Create minimal schema
    apiTestDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      CREATE TABLE contacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT 'Sonstiges',
        phone      TEXT,
        email      TEXT,
        address    TEXT,
        notes      TEXT,
        family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO users (username) VALUES ('testuser');
    `);

    // Apply Migration 30 to create CardDAV tables
    const migration30 = MIGRATIONS.find(m => m.version === 30);
    if (!migration30) {
      throw new Error('Migration 30 not found');
    }
    apiTestDb.exec(migration30.up);

    // Override db.get() to use our test database
    const dbModule = await import('../server/db.js');
    dbModule._setTestDatabase(apiTestDb);

    // Mock testConnection for API route tests
    const cardavSync = await import('../server/services/cardav-sync.js');
    cardavSync._mockTestConnection(async () => ({
      ok: true,
      addressbooks: [
        { url: 'https://example.com/carddav/addressbook1', displayName: 'Contacts' },
        { url: 'https://example.com/carddav/addressbook2', displayName: 'Work' }
      ]
    }));

    // Mock syncAccount for API route tests
    cardavSync._mockSyncAccount(async () => ({
      synced: true,
      contactsAdded: 5,
      contactsUpdated: 3
    }));
  });

  after(async () => {
    // Restore original database
    const dbModule = await import('../server/db.js');
    dbModule._resetTestDatabase();

    // Reset testConnection mock
    const cardavSync = await import('../server/services/cardav-sync.js');
    cardavSync._mockTestConnection(null);

    // Reset syncAccount mock
    cardavSync._mockSyncAccount(null);
  });

  describe('Account Management', () => {
    it('GET /accounts - should return empty array when no accounts', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = { params: {}, query: {}, body: {} };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      assert.ok(getHandler, 'GET /accounts handler should exist');
      await getHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.data.data));
      assert.strictEqual(res.data.data.length, 0);
    });

    it('GET /accounts - should return accounts with correct shape', async () => {
      // Insert test account
      apiTestDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('Test iCloud', 'https://contacts.icloud.com', 'test@icloud.com', 'secret', '2026-05-01T10:00:00Z');

      const cardavRouter = await import('../server/routes/cardav.js');
      const req = { params: {}, query: {}, body: {} };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      await getHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.data.data));
      assert.strictEqual(res.data.data.length, 1);

      const account = res.data.data[0];
      assert.strictEqual(account.name, 'Test iCloud');
      assert.strictEqual(account.cardavUrl, 'https://contacts.icloud.com');
      assert.strictEqual(account.username, 'test@icloud.com');
      assert.strictEqual(account.createdAt, '2026-05-01T10:00:00Z');
      assert.ok(!account.password, 'Password should not be exposed');
    });

    it('POST /accounts - should create account and discover addressbooks', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: {},
        query: {},
        body: {
          name: 'Test Account',
          cardavUrl: 'https://example.com/carddav',
          username: 'testuser',
          password: 'testpass'
        }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      assert.ok(postHandler, 'POST /accounts handler should exist');
      await postHandler(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.ok(res.data.data.account);
      assert.ok(res.data.data.account.id);
      assert.strictEqual(res.data.data.account.name, 'Test Account');
      assert.ok(Array.isArray(res.data.data.addressbooks));
    });

    it('POST /accounts - should return 400 for missing name', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: {},
        query: {},
        body: {
          cardavUrl: 'https://example.com/carddav',
          username: 'testuser',
          password: 'testpass'
        }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.data.error.includes('Name'));
    });

    it('DELETE /accounts/:id - should delete account and cascade addressbooks', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      // First create an account to delete
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Account to Delete',
          cardavUrl: 'https://example.com/carddav',
          username: 'deleteuser',
          password: 'deletepass'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(createReq, createRes);
      const accountId = createRes.data.data.account.id;

      // Now delete it
      const req = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const deleteHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id' && layer.route.methods.delete
      )?.route?.stack[0]?.handle;

      assert.ok(deleteHandler, 'DELETE /accounts/:id handler should exist');
      await deleteHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.data.deleted, true);
    });

    it('DELETE /accounts/:id - should return 400 for invalid ID', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: { id: 'invalid' },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const deleteHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id' && layer.route.methods.delete
      )?.route?.stack[0]?.handle;

      await deleteHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.data.error.includes('Invalid ID'));
    });
  });

  describe('Connection & Discovery', () => {
    it('POST /accounts/:id/test - should test connection', async () => {
      // Insert test account directly into DB
      const result = apiTestDb.prepare(`
        INSERT INTO carddav_accounts (name, carddav_url, username, password, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('Test Connection Account', 'https://example.com/carddav-test', 'testuser-connection', 'testpass', '2026-05-04T10:00:00Z');

      const accountId = result.lastInsertRowid;

      const cardavRouter = await import('../server/routes/cardav.js');

      // Test connection
      const req = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const testHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/test' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      assert.ok(testHandler, 'POST /accounts/:id/test handler should exist');
      await testHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok('ok' in res.data.data);
      assert.ok(Array.isArray(res.data.data.addressbooks));
    });

    it('GET /accounts/:id/addressbooks - should list addressbooks', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      // Create account first
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Addressbooks Test Account',
          cardavUrl: 'https://example.com/carddav-ab',
          username: 'testuser-ab',
          password: 'testpass'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postAccountHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postAccountHandler(createReq, createRes);
      const accountId = createRes.data.data.account.id;

      // Get addressbooks
      const req = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/addressbooks' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      assert.ok(getHandler, 'GET /accounts/:id/addressbooks handler should exist');
      await getHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.data.data));
      if (res.data.data.length > 0) {
        const ab = res.data.data[0];
        assert.ok(ab.id);
        assert.ok(ab.url);
        assert.ok(ab.name);
        assert.ok('enabled' in ab);
      }
    });

    it('GET /accounts/:id/addressbooks - should return empty array when none', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: { id: '99999' },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/addressbooks' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      await getHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.data.data));
      assert.strictEqual(res.data.data.length, 0);
    });

    it('POST /accounts/:id/addressbooks/refresh - should refresh addressbooks', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      // Create account first
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Refresh Test Account',
          cardavUrl: 'https://example.com/carddav-refresh',
          username: 'testuser-refresh',
          password: 'testpass'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postAccountHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postAccountHandler(createReq, createRes);
      const accountId = createRes.data.data.account.id;

      // Refresh addressbooks
      const req = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const refreshHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/addressbooks/refresh' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      assert.ok(refreshHandler, 'POST /accounts/:id/addressbooks/refresh handler should exist');
      await refreshHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(Array.isArray(res.data.data));
    });
  });

  describe('Addressbook Management', () => {
    it('PUT /addressbooks/:id - should toggle addressbook enabled/disabled', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      // First create an account (which creates addressbooks)
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Toggle Test Account',
          cardavUrl: 'https://example.com/carddav-toggle',
          username: 'testuser-toggle',
          password: 'testpass'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postAccountHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postAccountHandler(createReq, createRes);
      const accountId = createRes.data.data.account.id;

      // Get addressbooks with IDs via GET /accounts/:id/addressbooks
      const getReq = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const getRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getAddressbooksHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/addressbooks' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      await getAddressbooksHandler(getReq, getRes);

      const addressbooks = getRes.data.data;
      assert.ok(addressbooks.length > 0, 'Should have at least one addressbook');

      const addressbookId = addressbooks[0].id;
      const initialEnabled = addressbooks[0].enabled;

      // Toggle the addressbook
      const req = {
        params: { id: String(addressbookId) },
        query: {},
        body: { enabled: !initialEnabled }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const putHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/addressbooks/:id' && layer.route.methods.put
      )?.route?.stack[0]?.handle;

      assert.ok(putHandler, 'PUT /addressbooks/:id handler should exist');
      await putHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.data.updated, true);
      assert.strictEqual(res.data.data.enabled, !initialEnabled);
    });

    it('PUT /addressbooks/:id - should return 400 for invalid enabled value', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: { id: '1' },
        query: {},
        body: { enabled: 'invalid' }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const putHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/addressbooks/:id' && layer.route.methods.put
      )?.route?.stack[0]?.handle;

      await putHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.data.error.includes('enabled'));
    });
  });

  describe('Sync', () => {
    it('POST /accounts/:id/sync - should sync all enabled addressbooks', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      // Create account (which creates addressbooks)
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Sync Test Account',
          cardavUrl: 'https://example.com/carddav-sync',
          username: 'testuser-sync',
          password: 'testpass'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postAccountHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postAccountHandler(createReq, createRes);
      const accountId = createRes.data.data.account.id;

      // Sync the account
      const req = {
        params: { id: String(accountId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const syncHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/sync' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      assert.ok(syncHandler, 'POST /accounts/:id/sync handler should exist');
      await syncHandler(req, res);

      assert.strictEqual(res.statusCode, 200);
      assert.ok('synced' in res.data.data);
      assert.ok('contactsAdded' in res.data.data);
      assert.ok('contactsUpdated' in res.data.data);
    });

    it('POST /accounts/:id/sync - should return 404 for non-existent account', async () => {
      const cardavRouter = await import('../server/routes/cardav.js');

      const req = {
        params: { id: '99999' },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const syncHandler = cardavRouter.default.stack.find(
        layer => layer.route?.path === '/accounts/:id/sync' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await syncHandler(req, res);

      assert.strictEqual(res.statusCode, 404);
      assert.ok(res.data.error);
    });
  });
});

// ========================================
// Contacts API - Multi-Value Fields
// ========================================

describe('Contacts API - Multi-Value Fields', () => {
  let contactsApiDb;

  before(async () => {
    // Create in-memory test database
    contactsApiDb = new Database(':memory:');
    contactsApiDb.pragma('foreign_keys = ON');

    // Create minimal schema
    contactsApiDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      CREATE TABLE contacts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT 'Sonstiges',
        phone      TEXT,
        email      TEXT,
        address    TEXT,
        notes      TEXT,
        family_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Seit #357 validiert der Contacts-Router category dynamisch gegen
      -- contact_categories. Dieses Fixture sendet weiterhin die Legacy-Werte
      -- 'Arzt'/'Sonstiges'; beide werden hier als gültige Keys mitgeführt.
      CREATE TABLE contact_categories (
        key TEXT PRIMARY KEY, name TEXT, label_key TEXT,
        icon TEXT NOT NULL DEFAULT 'tag', sort_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO contact_categories (key, sort_order) VALUES
        ('doctor',0),('school',1),('authority',2),('insurance',3),
        ('craftsman',4),('emergency',5),('misc',6),('Arzt',7),('Sonstiges',8);

      INSERT INTO users (username) VALUES ('testuser');
    `);

    // Apply Migration 30 to create Multi-Value tables
    const migration30 = MIGRATIONS.find(m => m.version === 30);
    if (!migration30) {
      throw new Error('Migration 30 not found');
    }
    contactsApiDb.exec(migration30.up);

    // Override db.get() to use our test database
    const dbModule = await import('../server/db.js');
    dbModule._setTestDatabase(contactsApiDb);
  });

  after(async () => {
    // Restore original database
    const dbModule = await import('../server/db.js');
    dbModule._resetTestDatabase();
  });

  describe('GET /contacts/:id', () => {
    it('should return contact with multi-value fields (phones, emails, addresses)', async () => {
      // Insert test contact
      const result = contactsApiDb.prepare(`
        INSERT INTO contacts (name, category, phone, email, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run('Max Mustermann', 'Arzt', '+49123456789', 'max@example.com', 'Test notes');

      const contactId = result.lastInsertRowid;

      // Insert phones
      contactsApiDb.prepare(`
        INSERT INTO contact_phones (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'Mobil', '+49171234567', 1);

      contactsApiDb.prepare(`
        INSERT INTO contact_phones (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'Arbeit', '+49301234567', 0);

      // Insert emails
      contactsApiDb.prepare(`
        INSERT INTO contact_emails (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'Privat', 'max.privat@example.com', 1);

      contactsApiDb.prepare(`
        INSERT INTO contact_emails (contact_id, label, value, is_primary)
        VALUES (?, ?, ?, ?)
      `).run(contactId, 'Arbeit', 'max.work@example.com', 0);

      // Insert addresses
      contactsApiDb.prepare(`
        INSERT INTO contact_addresses (contact_id, label, street, city, state, postal_code, country, is_primary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(contactId, 'Privat', 'Musterstraße 1', 'Berlin', 'BE', '10115', 'Deutschland', 1);

      contactsApiDb.prepare(`
        INSERT INTO contact_addresses (contact_id, label, street, city, postal_code, country, is_primary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(contactId, 'Arbeit', 'Arbeitsweg 10', 'München', '80331', 'Deutschland', 0);

      // Call GET /contacts/:id
      const contactsRouter = await import('../server/routes/contacts.js');

      const req = {
        params: { id: String(contactId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getByIdHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/:id' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      assert.ok(getByIdHandler, 'GET /contacts/:id handler should exist');
      await getByIdHandler(req, res);

      // Verify response
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.data.data, 'Response should have data field');

      const contact = res.data.data;
      assert.strictEqual(contact.id, contactId);
      assert.strictEqual(contact.name, 'Max Mustermann');
      assert.strictEqual(contact.category, 'Arzt');

      // Verify phones array
      assert.ok(Array.isArray(contact.phones), 'phones should be an array');
      assert.strictEqual(contact.phones.length, 2);

      const mobilePhone = contact.phones.find(p => p.label === 'Mobil');
      assert.ok(mobilePhone, 'Should have mobile phone');
      assert.strictEqual(mobilePhone.value, '+49171234567');
      assert.strictEqual(mobilePhone.isPrimary, true);

      const workPhone = contact.phones.find(p => p.label === 'Arbeit');
      assert.ok(workPhone, 'Should have work phone');
      assert.strictEqual(workPhone.value, '+49301234567');
      assert.strictEqual(workPhone.isPrimary, false);

      // Verify emails array
      assert.ok(Array.isArray(contact.emails), 'emails should be an array');
      assert.strictEqual(contact.emails.length, 2);

      const privateEmail = contact.emails.find(e => e.label === 'Privat');
      assert.ok(privateEmail, 'Should have private email');
      assert.strictEqual(privateEmail.value, 'max.privat@example.com');
      assert.strictEqual(privateEmail.isPrimary, true);

      // Verify addresses array
      assert.ok(Array.isArray(contact.addresses), 'addresses should be an array');
      assert.strictEqual(contact.addresses.length, 2);

      const homeAddress = contact.addresses.find(a => a.label === 'Privat');
      assert.ok(homeAddress, 'Should have home address');
      assert.strictEqual(homeAddress.street, 'Musterstraße 1');
      assert.strictEqual(homeAddress.city, 'Berlin');
      assert.strictEqual(homeAddress.state, 'BE');
      assert.strictEqual(homeAddress.postalCode, '10115');
      assert.strictEqual(homeAddress.country, 'Deutschland');
      assert.strictEqual(homeAddress.isPrimary, true);

      const workAddress = contact.addresses.find(a => a.label === 'Arbeit');
      assert.ok(workAddress, 'Should have work address');
      assert.strictEqual(workAddress.street, 'Arbeitsweg 10');
      assert.strictEqual(workAddress.city, 'München');
      assert.strictEqual(workAddress.postalCode, '80331');
      assert.strictEqual(workAddress.isPrimary, false);
    });

    it('should return empty arrays when contact has no multi-value fields', async () => {
      // Insert contact without multi-value fields
      const result = contactsApiDb.prepare(`
        INSERT INTO contacts (name, category)
        VALUES (?, ?)
      `).run('Anna Schmidt', 'Sonstiges');

      const contactId = result.lastInsertRowid;

      // Call GET /contacts/:id
      const contactsRouter = await import('../server/routes/contacts.js');

      const req = {
        params: { id: String(contactId) },
        query: {},
        body: {}
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const getByIdHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/:id' && layer.route.methods.get
      )?.route?.stack[0]?.handle;

      await getByIdHandler(req, res);

      // Verify response has empty arrays
      assert.strictEqual(res.statusCode, 200);
      const contact = res.data.data;
      assert.strictEqual(contact.name, 'Anna Schmidt');
      assert.ok(Array.isArray(contact.phones), 'phones should be an array');
      assert.strictEqual(contact.phones.length, 0, 'phones should be empty');
      assert.ok(Array.isArray(contact.emails), 'emails should be an array');
      assert.strictEqual(contact.emails.length, 0, 'emails should be empty');
      assert.ok(Array.isArray(contact.addresses), 'addresses should be an array');
      assert.strictEqual(contact.addresses.length, 0, 'addresses should be empty');
    });
  });

  describe('POST /contacts', () => {
    it('should create contact with multi-value fields', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      const req = {
        params: {},
        query: {},
        body: {
          name: 'Dr. Schmidt',
          category: 'Arzt',
          notes: 'Hausarzt',
          phones: [
            { label: 'Praxis', value: '+4930123456', isPrimary: true },
            { label: 'Mobil', value: '+491701234567', isPrimary: false }
          ],
          emails: [
            { label: 'Praxis', value: 'praxis@schmidt.de', isPrimary: true }
          ],
          addresses: [
            { 
              label: 'Praxis', 
              street: 'Hauptstraße 10', 
              city: 'Berlin', 
              postalCode: '10115', 
              country: 'Deutschland',
              isPrimary: true 
            }
          ]
        }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      assert.ok(postHandler, 'POST /contacts handler should exist');
      await postHandler(req, res);

      // Verify response
      assert.strictEqual(res.statusCode, 201);
      assert.ok(res.data.data, 'Response should have data field');

      const contact = res.data.data;
      assert.strictEqual(contact.name, 'Dr. Schmidt');
      assert.strictEqual(contact.category, 'Arzt');

      // Verify multi-value fields were created
      assert.ok(Array.isArray(contact.phones), 'phones should be in response');
      assert.strictEqual(contact.phones.length, 2);
      
      const praxisPhone = contact.phones.find(p => p.label === 'Praxis');
      assert.ok(praxisPhone, 'Should have Praxis phone');
      assert.strictEqual(praxisPhone.value, '+4930123456');
      assert.strictEqual(praxisPhone.isPrimary, true);

      assert.ok(Array.isArray(contact.emails), 'emails should be in response');
      assert.strictEqual(contact.emails.length, 1);
      assert.strictEqual(contact.emails[0].value, 'praxis@schmidt.de');

      assert.ok(Array.isArray(contact.addresses), 'addresses should be in response');
      assert.strictEqual(contact.addresses.length, 1);
      assert.strictEqual(contact.addresses[0].street, 'Hauptstraße 10');
      assert.strictEqual(contact.addresses[0].city, 'Berlin');

      // Verify data persisted in database
      const contactId = contact.id;
      const dbPhones = contactsApiDb.prepare('SELECT * FROM contact_phones WHERE contact_id = ?').all(contactId);
      assert.strictEqual(dbPhones.length, 2, 'Should have 2 phones in DB');

      const dbEmails = contactsApiDb.prepare('SELECT * FROM contact_emails WHERE contact_id = ?').all(contactId);
      assert.strictEqual(dbEmails.length, 1, 'Should have 1 email in DB');

      const dbAddresses = contactsApiDb.prepare('SELECT * FROM contact_addresses WHERE contact_id = ?').all(contactId);
      assert.strictEqual(dbAddresses.length, 1, 'Should have 1 address in DB');
    });

    it('should validate phones array and return 400 on invalid data', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      const req = {
        params: {},
        query: {},
        body: {
          name: 'Test Contact',
          phones: [
            { label: 'Invalid' } // missing value
          ]
        }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.data.error, 'Should have error message');
      assert.ok(res.data.error.includes('Phone'), 'Error should mention Phone');
    });

    it('should create contact without multi-value fields (backwards compatible)', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      const req = {
        params: {},
        query: {},
        body: {
          name: 'Simple Contact',
          category: 'Sonstiges'
        }
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(req, res);

      assert.strictEqual(res.statusCode, 201);
      const contact = res.data.data;
      assert.strictEqual(contact.name, 'Simple Contact');
      
      // Should have empty arrays
      assert.ok(Array.isArray(contact.phones));
      assert.strictEqual(contact.phones.length, 0);
      assert.ok(Array.isArray(contact.emails));
      assert.strictEqual(contact.emails.length, 0);
      assert.ok(Array.isArray(contact.addresses));
      assert.strictEqual(contact.addresses.length, 0);
    });
  });

  describe('PUT /contacts/:id', () => {
    it('should update contact with multi-value fields (replacement semantics)', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      // First create a contact with multi-value fields
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Original Contact',
          category: 'Arzt',
          phones: [{ label: 'Mobil', value: '+49171111111', isPrimary: true }],
          emails: [{ label: 'Privat', value: 'original@example.com', isPrimary: true }],
          addresses: [{ label: 'Privat', street: 'Alte Straße 1', city: 'Berlin', postalCode: '10115', country: 'Deutschland', isPrimary: true }]
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(createReq, createRes);
      const contactId = createRes.data.data.id;

      // Now update it with new multi-value fields (replacement)
      const updateReq = {
        params: { id: String(contactId) },
        query: {},
        body: {
          name: 'Updated Contact',
          phones: [
            { label: 'Arbeit', value: '+49302222222', isPrimary: true },
            { label: 'Mobil', value: '+49173333333', isPrimary: false }
          ],
          emails: [
            { label: 'Arbeit', value: 'new.work@example.com', isPrimary: true }
          ],
          addresses: [
            { label: 'Arbeit', street: 'Neue Straße 10', city: 'München', postalCode: '80331', country: 'Deutschland', isPrimary: true }
          ]
        }
      };
      const updateRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const putHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/:id' && layer.route.methods.put
      )?.route?.stack[0]?.handle;

      await putHandler(updateReq, updateRes);

      assert.strictEqual(updateRes.statusCode, 200);
      const updated = updateRes.data.data;

      // Check name was updated
      assert.strictEqual(updated.name, 'Updated Contact');

      // Check phones were replaced (old deleted, new inserted)
      assert.strictEqual(updated.phones.length, 2);
      assert.strictEqual(updated.phones[0].label, 'Arbeit');
      assert.strictEqual(updated.phones[0].value, '+49302222222');
      assert.strictEqual(updated.phones[0].isPrimary, true);
      assert.strictEqual(updated.phones[1].label, 'Mobil');
      assert.strictEqual(updated.phones[1].value, '+49173333333');
      assert.strictEqual(updated.phones[1].isPrimary, false);

      // Check emails were replaced
      assert.strictEqual(updated.emails.length, 1);
      assert.strictEqual(updated.emails[0].label, 'Arbeit');
      assert.strictEqual(updated.emails[0].value, 'new.work@example.com');
      assert.strictEqual(updated.emails[0].isPrimary, true);

      // Check addresses were replaced
      assert.strictEqual(updated.addresses.length, 1);
      assert.strictEqual(updated.addresses[0].label, 'Arbeit');
      assert.strictEqual(updated.addresses[0].street, 'Neue Straße 10');
      assert.strictEqual(updated.addresses[0].city, 'München');
      assert.strictEqual(updated.addresses[0].isPrimary, true);
    });

    it('should return 400 for invalid multi-value data', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      // Create a contact first
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Test Contact',
          category: 'Sonstiges'
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(createReq, createRes);
      const contactId = createRes.data.data.id;

      // Try to update with invalid phone data
      const updateReq = {
        params: { id: String(contactId) },
        query: {},
        body: {
          phones: [{ label: 'Mobil', value: '', isPrimary: 'invalid' }] // empty value + invalid isPrimary
        }
      };
      const updateRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const putHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/:id' && layer.route.methods.put
      )?.route?.stack[0]?.handle;

      await putHandler(updateReq, updateRes);

      assert.strictEqual(updateRes.statusCode, 400);
      assert.ok(updateRes.data.error, 'Should have error message');
    });

    it('should update contact without multi-value fields (backwards compatible)', async () => {
      const contactsRouter = await import('../server/routes/contacts.js');

      // Create contact with multi-value fields
      const createReq = {
        params: {},
        query: {},
        body: {
          name: 'Test Contact',
          category: 'Sonstiges',
          phones: [{ label: 'Mobil', value: '+49171111111', isPrimary: true }]
        }
      };
      const createRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const postHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/' && layer.route.methods.post
      )?.route?.stack[0]?.handle;

      await postHandler(createReq, createRes);
      const contactId = createRes.data.data.id;

      // Update without touching multi-value fields (only scalar fields)
      const updateReq = {
        params: { id: String(contactId) },
        query: {},
        body: {
          name: 'Updated Name Only',
          category: 'Arzt'
        }
      };
      const updateRes = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.data = data; return this; },
      };

      const putHandler = contactsRouter.default.stack.find(
        layer => layer.route?.path === '/:id' && layer.route.methods.put
      )?.route?.stack[0]?.handle;

      await putHandler(updateReq, updateRes);

      assert.strictEqual(updateRes.statusCode, 200);
      const updated = updateRes.data.data;

      // Scalar fields should be updated
      assert.strictEqual(updated.name, 'Updated Name Only');
      assert.strictEqual(updated.category, 'Arzt');

      // Multi-value fields should remain unchanged
      assert.strictEqual(updated.phones.length, 1);
      assert.strictEqual(updated.phones[0].value, '+49171111111');
    });
  });
});

describe('pruneRemovedContacts: server-side contact deletions', () => {
  let db;
  const ABOOK = 'https://dav.example.com/abook/';

  function setup() {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE contacts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        name                    TEXT NOT NULL,
        notes                   TEXT,
        carddav_account_id      INTEGER,
        carddav_uid             TEXT,
        carddav_addressbook_url TEXT,
        carddav_origin          TEXT CHECK (carddav_origin IN ('remote', 'merged'))
      );
    `);
  }

  function addContact(name, uid, origin, accountId = 1, abook = ABOOK) {
    db.prepare(`
      INSERT INTO contacts (name, carddav_uid, carddav_origin, carddav_account_id, carddav_addressbook_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, uid, origin, accountId, abook);
  }

  const names = () => db.prepare('SELECT name FROM contacts ORDER BY id').all().map(r => r.name);

  it('deletes a purely remote contact the server no longer returns', () => {
    setup();
    addContact('Bleibt', 'uid-1', 'remote');
    addContact('Remote geloescht', 'uid-2', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1']));

    assert.deepStrictEqual(result, { deleted: 1, decoupled: 0 });
    assert.deepStrictEqual(names(), ['Bleibt']);
  });

  it('only decouples an adopted contact instead of deleting it (no data loss)', () => {
    setup();
    // Lokal angelegt, mit Notizen gepflegt, spaeter per Smart-Merge adoptiert.
    addContact('Oma Erna', 'uid-2', 'merged');
    db.prepare(`UPDATE contacts SET notes = 'Lieblingskuchen: Bienenstich' WHERE carddav_uid = 'uid-2'`).run();
    addContact('Anker', 'uid-1', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1']));

    assert.deepStrictEqual(result, { deleted: 0, decoupled: 1 });

    const erna = db.prepare(`SELECT * FROM contacts WHERE name = 'Oma Erna'`).get();
    assert.ok(erna, 'Der adoptierte Kontakt muss erhalten bleiben');
    assert.strictEqual(erna.notes, 'Lieblingskuchen: Bienenstich', 'Lokale Daten bleiben erhalten');
    assert.strictEqual(erna.carddav_uid, null, 'CardDAV-Verknuepfung ist geloest');
    assert.strictEqual(erna.carddav_account_id, null);
    assert.strictEqual(erna.carddav_addressbook_url, null);
    assert.strictEqual(erna.carddav_origin, null);
  });

  it('treats pre-v89 contacts (origin merged) conservatively', () => {
    setup();
    // Bestand aus der Zeit vor der Migration: Herkunft unbekannt -> 'merged'.
    addContact('Altkontakt', 'uid-old', 'merged');
    addContact('Anker', 'uid-1', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1']));

    assert.deepStrictEqual(result, { deleted: 0, decoupled: 1 });
    assert.deepStrictEqual(names(), ['Altkontakt', 'Anker']);
  });

  it('does nothing when the addressbook returned no contacts (fetch-error guard)', () => {
    setup();
    addContact('A', 'uid-1', 'remote');
    addContact('B', 'uid-2', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set());

    assert.deepStrictEqual(result, { deleted: 0, decoupled: 0 });
    assert.deepStrictEqual(names(), ['A', 'B']);
  });

  it('never touches purely local contacts', () => {
    setup();
    db.prepare(`INSERT INTO contacts (name) VALUES ('Nur lokal')`).run();
    addContact('Remote geloescht', 'uid-2', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1']));

    assert.deepStrictEqual(result, { deleted: 1, decoupled: 0 });
    assert.deepStrictEqual(names(), ['Nur lokal']);
  });

  it('never touches contacts of another addressbook or account', () => {
    setup();
    addContact('Anderes Adressbuch', 'uid-x', 'remote', 1, 'https://dav.example.com/other/');
    addContact('Anderer Account', 'uid-y', 'remote', 2, ABOOK);
    addContact('Remote geloescht', 'uid-2', 'remote');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1']));

    assert.deepStrictEqual(result, { deleted: 1, decoupled: 0 });
    assert.deepStrictEqual(names(), ['Anderes Adressbuch', 'Anderer Account']);
  });

  it('does nothing when the server still has every contact', () => {
    setup();
    addContact('A', 'uid-1', 'remote');
    addContact('B', 'uid-2', 'merged');

    const result = pruneRemovedContacts(db, 1, ABOOK, new Set(['uid-1', 'uid-2']));

    assert.deepStrictEqual(result, { deleted: 0, decoupled: 0 });
    assert.deepStrictEqual(names(), ['A', 'B']);
  });
});

// ========================================================
// fetchVCardsResilient: FN-Filter-Fallback (Issue #529, mailbox.org)
// ========================================================

describe('fetchVCardsResilient (#529 mailbox.org FN-filter fallback)', () => {
  const addressBook = { url: 'https://dav.example.com/carddav/abook/' };

  it('gibt das Ergebnis der Standard-Abfrage zurück, wenn es nicht leer ist', async () => {
    let propfindCalled = false;
    const client = {
      fetchVCards: async () => [{ url: 'c1', data: 'BEGIN:VCARD' }],
      propfind: async () => { propfindCalled = true; return []; },
    };
    const out = await fetchVCardsResilient(client, addressBook);
    assert.equal(out.length, 1);
    assert.equal(propfindCalled, false, 'kein Fallback, wenn die Standard-Abfrage liefert');
  });

  it('fällt bei 0 Ergebnissen auf PROPFIND + Multiget zurück (mailbox.org)', async () => {
    const calls = [];
    const client = {
      fetchVCards: async (params) => {
        calls.push(params);
        // Erster Aufruf (ohne objectUrls) = FN-gefilterte Query → leer.
        if (!params.objectUrls) return [];
        // Zweiter Aufruf (mit objectUrls) = Multiget → liefert die Karten.
        return params.objectUrls.map((u) => ({ url: u, data: `BEGIN:VCARD\nUID:${u}` }));
      },
      propfind: async () => ([
        // Die Kollektion selbst wird von PROPFIND depth:1 mitgeliefert und muss raus.
        { href: '/carddav/abook/' },
        { href: '/carddav/abook/1.vcf' },
        { href: 'https://dav.example.com/carddav/abook/2.vcf' },
      ]),
    };
    const out = await fetchVCardsResilient(client, addressBook);
    assert.equal(out.length, 2, 'zwei Kontakte über den Fallback');
    // Zweiter fetchVCards-Aufruf bekommt exakt die zwei Objekt-URLs (Kollektion gefiltert).
    assert.deepStrictEqual(calls[1].objectUrls, [
      'https://dav.example.com/carddav/abook/1.vcf',
      'https://dav.example.com/carddav/abook/2.vcf',
    ]);
  });

  it('bleibt leer, wenn PROPFIND nur die Kollektion selbst liefert', async () => {
    const client = {
      fetchVCards: async () => [],
      propfind: async () => ([{ href: 'https://dav.example.com/carddav/abook/' }]),
    };
    const out = await fetchVCardsResilient(client, addressBook);
    assert.deepStrictEqual(out, []);
  });

  it('gibt leer zurück, wenn der PROPFIND-Fallback fehlschlägt (kein Wurf)', async () => {
    const client = {
      fetchVCards: async () => [],
      propfind: async () => { throw new Error('PROPFIND 500'); },
    };
    const out = await fetchVCardsResilient(client, addressBook);
    assert.deepStrictEqual(out, []);
  });
});
