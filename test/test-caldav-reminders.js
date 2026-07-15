/**
 * Test: CalDAV Reminders Sync (Apple Reminders / VTODO → Tasks & Shopping)
 * Purpose: Verify VTODO field mapping, schema, and read-only upsert logic.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { mapVtodoPriority, splitDue, pruneRemoved } from '../server/services/caldav-reminders-sync.js';

describe('VTODO field mapping', () => {
  it('maps RFC-5545 PRIORITY to task priority', () => {
    assert.strictEqual(mapVtodoPriority(null), 'none');
    assert.strictEqual(mapVtodoPriority(1), 'high');
    assert.strictEqual(mapVtodoPriority(4), 'high');
    assert.strictEqual(mapVtodoPriority(5), 'medium');
    assert.strictEqual(mapVtodoPriority(6), 'low');
    assert.strictEqual(mapVtodoPriority(9), 'low');
  });

  it('splits a date-only DUE into date with no time', () => {
    assert.deepStrictEqual(splitDue('2026-07-01'), { date: '2026-07-01', time: null });
  });

  it('splits a datetime DUE into date and HH:MM time', () => {
    assert.deepStrictEqual(splitDue('2026-07-01T14:30:00Z'), { date: '2026-07-01', time: '14:30' });
  });

  it('returns nulls for an empty DUE', () => {
    assert.deepStrictEqual(splitDue(null), { date: null, time: null });
  });
});

describe('pruneRemoved (#508)', () => {
  let db;

  function setup() {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        title               TEXT NOT NULL,
        external_uid        TEXT,
        external_source     TEXT,
        external_account_id INTEGER
      );
      CREATE TABLE shopping_items (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        name                TEXT NOT NULL,
        external_uid        TEXT,
        external_source     TEXT,
        external_account_id INTEGER
      );
    `);
  }

  function addTask(title, uid, source, accountId) {
    db.prepare(`
      INSERT INTO tasks (title, external_uid, external_source, external_account_id)
      VALUES (?, ?, ?, ?)
    `).run(title, uid, source, accountId);
  }

  function taskTitles() {
    return db.prepare('SELECT title FROM tasks ORDER BY id').all().map(r => r.title);
  }

  it('deletes mirrored tasks the server no longer returns', () => {
    setup();
    addTask('Bleibt', 'uid-1', 'caldav', 1);
    addTask('In iCloud geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Bleibt']);
  });

  it('does NOT wipe every task when the server returns nothing (fetch-error guard)', () => {
    setup();
    addTask('A', 'uid-1', 'caldav', 1);
    addTask('B', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, []);

    assert.strictEqual(removed, 0, 'An empty reminder fetch must not wipe the account');
    assert.deepStrictEqual(taskTitles(), ['A', 'B']);
  });

  it('never touches locally created tasks', () => {
    setup();
    addTask('Lokale Aufgabe', null, null, null);
    addTask('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Lokale Aufgabe']);
  });

  it('never touches tasks of another account', () => {
    setup();
    addTask('Anderer Account', 'uid-other', 'caldav', 2);
    addTask('Remote geloescht', 'uid-2', 'caldav', 1);

    const removed = pruneRemoved(db, 'tasks', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(taskTitles(), ['Anderer Account']);
  });

  it('prunes shopping_items the same way', () => {
    setup();
    db.prepare(`
      INSERT INTO shopping_items (name, external_uid, external_source, external_account_id)
      VALUES ('Bleibt', 'uid-1', 'caldav', 1), ('Weg', 'uid-2', 'caldav', 1)
    `).run();

    const removed = pruneRemoved(db, 'shopping_items', 1, ['uid-1']);

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(
      db.prepare('SELECT name FROM shopping_items ORDER BY id').all().map(r => r.name),
      ['Bleibt']
    );
  });

  it('refuses to prune a table outside the whitelist', () => {
    setup();
    assert.throws(
      () => pruneRemoved(db, 'users; DROP TABLE tasks', 1, ['uid-1']),
      /refusing to prune unknown table/
    );
  });
});

describe('caldav_reminder_selection schema & upsert logic', () => {
  let db;

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE caldav_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        caldav_url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        UNIQUE(caldav_url, username)
      );
      CREATE TABLE caldav_reminder_selection (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    INTEGER NOT NULL,
        list_url      TEXT NOT NULL,
        list_name     TEXT NOT NULL,
        target_module TEXT NOT NULL DEFAULT 'tasks'
                      CHECK(target_module IN ('tasks', 'shopping')),
        target_list_id INTEGER,
        enabled       INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, list_url)
      );
      CREATE TABLE shopping_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
      CREATE TABLE shopping_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        quantity TEXT,
        category TEXT NOT NULL DEFAULT 'Sonstiges',
        is_checked INTEGER NOT NULL DEFAULT 0,
        external_uid TEXT,
        external_source TEXT NOT NULL DEFAULT 'local',
        external_account_id INTEGER
      );
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL);
      INSERT INTO users (username) VALUES ('owner');
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT NOT NULL DEFAULT 'none',
        status TEXT NOT NULL DEFAULT 'open',
        due_date TEXT,
        due_time TEXT,
        created_by INTEGER NOT NULL,
        external_uid TEXT,
        external_source TEXT NOT NULL DEFAULT 'local',
        external_account_id INTEGER
      );
      INSERT INTO caldav_accounts (name, caldav_url, username, password)
      VALUES ('iCloud', 'https://caldav.icloud.com', 'u', 'p');
    `);
  });

  it('reminder selection defaults to disabled and tasks module', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    db.prepare(`
      INSERT INTO caldav_reminder_selection (account_id, list_url, list_name)
      VALUES (?, ?, ?)
    `).run(accId, 'https://caldav.icloud.com/reminders/list1', 'Einkauf');
    const sel = db.prepare('SELECT * FROM caldav_reminder_selection WHERE list_name = ?').get('Einkauf');
    assert.strictEqual(sel.enabled, 0, 'should default disabled');
    assert.strictEqual(sel.target_module, 'tasks', 'should default to tasks');
  });

  it('rejects an invalid target_module via CHECK constraint', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    assert.throws(() => {
      db.prepare(`
        INSERT INTO caldav_reminder_selection (account_id, list_url, list_name, target_module)
        VALUES (?, ?, ?, 'calendar')
      `).run(accId, 'https://x/bad', 'Bad');
    });
  });

  it('CASCADE deletes reminder selections when the account is removed', () => {
    const tmp = new DatabaseSync(':memory:');
    tmp.exec(`
      CREATE TABLE caldav_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      CREATE TABLE caldav_reminder_selection (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        list_url TEXT NOT NULL, list_name TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES caldav_accounts(id) ON DELETE CASCADE
      );
    `);
    tmp.exec('PRAGMA foreign_keys = ON');
    tmp.prepare('INSERT INTO caldav_accounts (name) VALUES (?)').run('A');
    const id = tmp.prepare('SELECT id FROM caldav_accounts').get().id;
    tmp.prepare('INSERT INTO caldav_reminder_selection (account_id, list_url, list_name) VALUES (?,?,?)')
      .run(id, 'u', 'n');
    tmp.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(id);
    const left = tmp.prepare('SELECT * FROM caldav_reminder_selection WHERE account_id = ?').get(id);
    assert.strictEqual(left, undefined, 'reminder selection should cascade-delete');
  });

  it('upserts a VTODO into tasks keyed on external_uid (insert then update, no duplicate)', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
    const upsertTask = (uid, title, status) => {
      const existing = db.prepare(
        `SELECT id FROM tasks WHERE external_uid = ? AND external_source = 'caldav'`
      ).get(uid);
      if (existing) {
        db.prepare(`UPDATE tasks SET title = ?, status = ? WHERE id = ?`).run(title, status, existing.id);
      } else {
        db.prepare(`
          INSERT INTO tasks (title, status, created_by, external_uid, external_source, external_account_id)
          VALUES (?, ?, ?, ?, 'caldav', ?)
        `).run(title, status, owner, uid, accId);
      }
    };
    upsertTask('todo-1@x', 'Milch kaufen', 'open');
    upsertTask('todo-1@x', 'Milch & Brot kaufen', 'done');
    const rows = db.prepare(`SELECT * FROM tasks WHERE external_uid = 'todo-1@x'`).all();
    assert.strictEqual(rows.length, 1, 'should not create a duplicate task');
    assert.strictEqual(rows[0].title, 'Milch & Brot kaufen', 'should update title');
    assert.strictEqual(rows[0].status, 'done', 'should update status');
  });

  it('deletes local caldav tasks that disappeared from the remote list', () => {
    const accId = db.prepare('SELECT id FROM caldav_accounts').get().id;
    const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO tasks (title, status, created_by, external_uid, external_source, external_account_id)
      VALUES ('Stale', 'open', ?, 'stale@x', 'caldav', ?)`).run(owner, accId);
    // Remote returns only 'fresh@x'
    const seenUids = ['fresh@x'];
    const placeholders = seenUids.map(() => '?').join(',');
    db.prepare(`DELETE FROM tasks
      WHERE external_source = 'caldav' AND external_account_id = ?
        AND external_uid NOT IN (${placeholders})`).run(accId, ...seenUids);
    const stale = db.prepare(`SELECT * FROM tasks WHERE external_uid = 'stale@x'`).get();
    assert.strictEqual(stale, undefined, 'stale caldav task should be removed');
  });
});
