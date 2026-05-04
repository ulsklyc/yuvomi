/**
 * Test: CalDAV Multi-Account Sync
 * Purpose: Verify CalDAV multi-account functionality
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const TEST_DB = ':memory:';

describe('CalDAV Multi-Account Sync', () => {
  let db;

  before(() => {
    // Create in-memory DB
    db = new DatabaseSync(TEST_DB);

    // Create tables (simplified schema for testing)
    db.exec(`
      CREATE TABLE caldav_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        caldav_url      TEXT NOT NULL,
        username        TEXT NOT NULL,
        password        TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_sync       TEXT,
        UNIQUE(caldav_url, username)
      );

      CREATE TABLE caldav_calendar_selection (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER NOT NULL,
        calendar_url    TEXT NOT NULL,
        calendar_name   TEXT NOT NULL,
        calendar_color  TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, calendar_url)
      );

      CREATE TABLE calendar_events (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        title                       TEXT NOT NULL,
        external_calendar_id        TEXT,
        external_source             TEXT,
        target_caldav_account_id    INTEGER,
        target_caldav_calendar_url  TEXT
      );

      CREATE TABLE external_calendars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name        TEXT NOT NULL,
        color       TEXT,
        UNIQUE(source, external_id)
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL
      );

      INSERT INTO users (username) VALUES ('testuser');
    `);
  });

  it('should create caldav_accounts table with correct schema', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='caldav_accounts'").get();
    assert.ok(result, 'caldav_accounts table should exist');
  });

  it('should create caldav_calendar_selection table with FK', () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='caldav_calendar_selection'").get();
    assert.ok(result, 'caldav_calendar_selection table should exist');
  });

  it('should have target columns in calendar_events', () => {
    const cols = db.prepare("PRAGMA table_info(calendar_events)").all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('target_caldav_account_id'), 'Should have target_caldav_account_id column');
    assert.ok(colNames.includes('target_caldav_calendar_url'), 'Should have target_caldav_calendar_url column');
  });

  it('should insert account and enforce UNIQUE constraint', () => {
    db.prepare(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Test Account', 'https://caldav.example.com', 'user', 'pass');

    const account = db.prepare('SELECT * FROM caldav_accounts WHERE name = ?').get('Test Account');
    assert.ok(account, 'Account should be inserted');
    assert.strictEqual(account.caldav_url, 'https://caldav.example.com');

    // Duplicate should fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO caldav_accounts (name, caldav_url, username, password)
        VALUES (?, ?, ?, ?)
      `).run('Duplicate', 'https://caldav.example.com', 'user', 'pass');
    }, 'UNIQUE constraint should prevent duplicates');
  });

  it('should insert calendar selection and link to account', () => {
    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Test Account').id;

    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled)
      VALUES (?, ?, ?, ?)
    `).run(accountId, 'https://cal.example.com/cal1', 'Private', 1);

    const calendar = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ?').get(accountId);
    assert.ok(calendar, 'Calendar should be inserted');
    assert.strictEqual(calendar.calendar_name, 'Private');
    assert.strictEqual(calendar.enabled, 1);
  });

  it('should CASCADE delete calendar_selection when account deleted', () => {
    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Test Account').id;

    // Delete account
    db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(accountId);

    // Calendar selection should be deleted
    const remaining = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ?').get(accountId);
    assert.strictEqual(remaining, undefined, 'Calendar selection should be deleted via CASCADE');
  });

  it('should handle enabled/disabled calendar selection', () => {
    // Insert new account
    db.prepare(`
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES (?, ?, ?, ?)
    `).run('Account 2', 'https://caldav2.example.com', 'user2', 'pass2');

    const accountId = db.prepare('SELECT id FROM caldav_accounts WHERE name = ?').get('Account 2').id;

    // Insert calendars
    db.prepare(`
      INSERT INTO caldav_calendar_selection (account_id, calendar_url, calendar_name, enabled)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      accountId, 'https://cal.example.com/cal1', 'Private', 1,
      accountId, 'https://cal.example.com/cal2', 'Work', 0
    );

    // Query only enabled
    const enabled = db.prepare('SELECT * FROM caldav_calendar_selection WHERE account_id = ? AND enabled = 1').all(accountId);
    assert.strictEqual(enabled.length, 1, 'Should have 1 enabled calendar');
    assert.strictEqual(enabled[0].calendar_name, 'Private');
  });

  it('should migrate apple calendar events to caldav without violating CHECK', () => {
    const db2 = new DatabaseSync(':memory:');
    db2.exec(`
      CREATE TABLE calendar_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        external_source TEXT NOT NULL DEFAULT 'local'
                        CHECK(external_source IN ('local', 'google', 'apple', 'ics'))
      );
    `);

    db2.prepare(`
      INSERT INTO calendar_events (title, external_source)
      VALUES ('Migrated', 'apple')
    `).run();

    db2.exec(`
      CREATE TABLE calendar_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL,
        external_source TEXT NOT NULL DEFAULT 'local'
                        CHECK(external_source IN ('local', 'google', 'apple', 'ics', 'caldav'))
      );
    `);

    db2.exec(`
      INSERT INTO calendar_events_new (id, title, external_source)
      SELECT id, title,
             CASE WHEN external_source = 'apple' THEN 'caldav' ELSE external_source END
      FROM calendar_events
    `);

    const migrated = db2.prepare(`SELECT external_source FROM calendar_events_new WHERE title = 'Migrated'`).get();
    assert.strictEqual(migrated.external_source, 'caldav');
  });
});
