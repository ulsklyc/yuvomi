/**
 * Test: Notiz-Kategorien
 * Zweck: Schema- und Sichtbarkeitsinvarianten fuer persoenliche und
 *        haushaltsweite Kategorien absichern.
 * Ausfuehren: node --experimental-sqlite --test test/test-note-categories.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import * as noteCategoryNameContract from '../public/utils/note-category-name.js';
import {
  categoryNameKey,
  hydrateNotesWithCategories,
  listVisibleCategories,
  pruneCategoryFromDashboardConfigs,
  replaceEditableAssignments,
  validateCategoryName,
} from '../server/services/note-categories.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATIONS_SQL[1]);
  db.exec(MIGRATIONS_SQL[2]);
  db.exec(MIGRATIONS_SQL[74]);
  db.exec(MIGRATIONS_SQL[175]);
  db.exec(MIGRATIONS_SQL[176]);
  return db;
}

test('migration 176 creates scoped note categories without seed data', () => {
  const db = database();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_categories').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_category_assignments').get().count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_note_categories_updated_at'").get().count,
    1,
  );
  db.close();
});

test('category name keys normalize canonical composition and ordinary Unicode case', () => {
  assert.equal(categoryNameKey('Česká'), categoryNameKey('česká'));
  assert.equal(categoryNameKey('Café'), categoryNameKey('Cafe\u0301'));
  assert.equal(categoryNameKey('Μάϊος'), categoryNameKey('ΜΆΪΟΣ'));
  assert.equal(categoryNameKey('Straße'), categoryNameKey('STRASSE'));
  assert.equal(categoryNameKey('ẞ'), categoryNameKey('ß'));
  assert.equal(categoryNameKey('ß'), categoryNameKey('SS'));
  assert.equal(categoryNameKey(categoryNameKey('ẞ')), categoryNameKey('ẞ'));
});

test('note category names have one shared 80-character contract', () => {
  assert.equal(noteCategoryNameContract.NOTE_CATEGORY_NAME_MAX_LENGTH, 80);
});

test('server accepts an 80-character category name and rejects 81 characters', () => {
  assert.equal(validateCategoryName('a'.repeat(80)), 'a'.repeat(80));
  assert.throws(
    () => validateCategoryName('a'.repeat(81)),
    { message: 'Category name must contain 1 to 80 characters' },
  );
});

test('server validation and its error message use the shared name limit', () => {
  const source = readFileSync(new URL('../server/services/note-categories.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /import\s*\{[^}]*NOTE_CATEGORY_NAME_MAX_LENGTH[^}]*\}\s*from\s*'\.\.\/\.\.\/public\/utils\/note-category-name\.js'/,
  );
  assert.match(source, /name\.length\s*>\s*NOTE_CATEGORY_NAME_MAX_LENGTH/);
  assert.match(source, /Category name must contain 1 to \$\{NOTE_CATEGORY_NAME_MAX_LENGTH\} characters/);
});

test('category names are unique case-insensitively inside their scope', () => {
  const db = database();
  const add = db.prepare(`
    INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  const userA = db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('a', 'A', 'x')").run().lastInsertRowid;
  const userB = db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('b', 'B', 'x')").run().lastInsertRowid;

  add.run('Rodina', categoryNameKey('Rodina'), 'household', null, userA);
  assert.throws(() => add.run('rodina', categoryNameKey('rodina'), 'household', null, userB), /UNIQUE/);

  add.run('Česká', categoryNameKey('Česká'), 'personal', userA, userA);
  assert.throws(() => add.run('česká', categoryNameKey('česká'), 'personal', userA, userA), /UNIQUE/);
  add.run('Straße', categoryNameKey('Straße'), 'personal', userA, userA);
  assert.throws(() => add.run('STRASSE', categoryNameKey('STRASSE'), 'personal', userA, userA), /UNIQUE/);
  add.run('ẞ', categoryNameKey('ẞ'), 'personal', userB, userB);
  assert.throws(() => add.run('SS', categoryNameKey('SS'), 'personal', userB, userB), /UNIQUE/);
  assert.doesNotThrow(() => add.run('Česká', categoryNameKey('Česká'), 'personal', userB, userB));
  db.close();
});

test('category ownership, assignments and timestamps follow their foreign-key lifecycle', () => {
  const db = database();
  const addUser = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)');
  const owner = Number(addUser.run('owner', 'Owner', 'x').lastInsertRowid);
  const noteOwner = Number(addUser.run('note-owner', 'Note owner', 'x').lastInsertRowid);
  const note = Number(db.prepare('INSERT INTO notes (content, created_by) VALUES (?, ?)').run('Shared', noteOwner).lastInsertRowid);
  const addCategory = db.prepare(`
    INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const household = Number(addCategory.run('House', categoryNameKey('House'), 'household', null, owner, '2000-01-01T00:00:00Z').lastInsertRowid);
  const personal = Number(addCategory.run('Mine', categoryNameKey('Mine'), 'personal', owner, owner, '2000-01-01T00:00:00Z').lastInsertRowid);
  const assign = db.prepare('INSERT INTO note_category_assignments (note_id, category_id, assigned_by) VALUES (?, ?, ?)');
  assign.run(note, household, owner);
  assign.run(note, personal, owner);

  db.prepare('UPDATE note_categories SET name = ?, name_key = ? WHERE id = ?')
    .run('Household', categoryNameKey('Household'), household);
  assert.notEqual(db.prepare('SELECT updated_at FROM note_categories WHERE id = ?').get(household).updated_at, '2000-01-01T00:00:00Z');

  db.prepare('DELETE FROM users WHERE id = ?').run(owner);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_categories WHERE id = ?').get(personal).count, 0);
  assert.deepEqual(
    { ...db.prepare('SELECT created_by FROM note_categories WHERE id = ?').get(household) },
    { created_by: null },
  );
  assert.deepEqual(
    db.prepare('SELECT category_id, assigned_by FROM note_category_assignments WHERE note_id = ?').all(note).map((row) => ({ ...row })),
    [{ category_id: household, assigned_by: null }],
  );

  db.prepare('DELETE FROM notes WHERE id = ?').run(note);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM note_category_assignments').get().count, 0);
  db.close();
});

function fixture() {
  const db = database();
  const addUser = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)');
  const alice = Number(addUser.run('alice', 'Alice', 'x').lastInsertRowid);
  const bob = Number(addUser.run('bob', 'Bob', 'x').lastInsertRowid);
  const note = Number(db.prepare('INSERT INTO notes (content, created_by) VALUES (?, ?)').run('Shared', alice).lastInsertRowid);
  const addCategory = db.prepare('INSERT INTO note_categories (name, name_key, scope, owner_user_id, created_by) VALUES (?, ?, ?, ?, ?)');
  const household = Number(addCategory.run('Home', categoryNameKey('Home'), 'household', null, alice).lastInsertRowid);
  const alicePersonal = Number(addCategory.run('Alice only', categoryNameKey('Alice only'), 'personal', alice, alice).lastInsertRowid);
  const bobPersonal = Number(addCategory.run('Bob only', categoryNameKey('Bob only'), 'personal', bob, bob).lastInsertRowid);
  const assign = db.prepare('INSERT INTO note_category_assignments (note_id, category_id, assigned_by) VALUES (?, ?, ?)');
  assign.run(note, household, alice);
  assign.run(note, alicePersonal, alice);
  assign.run(note, bobPersonal, bob);
  return { db, alice, bob, note, household, alicePersonal, bobPersonal };
}

test('users only list and hydrate household plus their own personal categories', () => {
  const { db, alice, bob, note } = fixture();
  assert.deepEqual(listVisibleCategories(db, alice).map((item) => item.name), ['Home', 'Alice only']);
  assert.deepEqual(listVisibleCategories(db, bob).map((item) => item.name), ['Home', 'Bob only']);

  const aliceView = hydrateNotesWithCategories(db, [{ id: note, content: 'Shared' }], alice);
  const bobView = hydrateNotesWithCategories(db, [{ id: note, content: 'Shared' }], bob);
  assert.deepEqual(aliceView[0].categories.map((item) => item.name), ['Home', 'Alice only']);
  assert.deepEqual(bobView[0].categories.map((item) => item.name), ['Home', 'Bob only']);
  db.close();
});

test('category hydration chunks note ids below the SQLite variable limit', () => {
  const db = database();
  const user = Number(db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('bulk', 'Bulk', 'x')").run().lastInsertRowid);
  const notes = Array.from({ length: 32_767 }, (_, index) => ({ id: index + 1, content: '' }));

  const hydrated = hydrateNotesWithCategories(db, notes, user);

  assert.equal(hydrated.length, notes.length);
  assert.deepEqual(hydrated[0].categories, []);
  assert.deepEqual(hydrated.at(-1).categories, []);
  db.close();
});

test('assignment replacement never removes another user personal metadata', () => {
  const { db, alice, note, household, bobPersonal } = fixture();

  replaceEditableAssignments(db, { noteId: note, categoryIds: [], userId: alice });
  assert.deepEqual(
    db.prepare('SELECT category_id FROM note_category_assignments WHERE note_id = ? ORDER BY category_id').all(note).map((row) => row.category_id),
    [bobPersonal],
  );
  db.close();
});

test('assignment replacement accepts household categories but rejects invisible personal ids', () => {
  const { db, alice, note, household, bobPersonal } = fixture();
  assert.throws(
    () => replaceEditableAssignments(db, { noteId: note, categoryIds: [bobPersonal], userId: alice }),
    /not available/,
  );
  assert.doesNotThrow(
    () => replaceEditableAssignments(db, { noteId: note, categoryIds: [household], userId: alice }),
  );
  assert.deepEqual(
    db.prepare('SELECT category_id FROM note_category_assignments WHERE note_id = ? ORDER BY category_id').all(note).map((row) => row.category_id),
    [household, bobPersonal].sort((a, b) => a - b),
  );
  db.close();
});

test('deleting a category can prune it from all dashboard note widget filters', () => {
  const db = database();
  const config = [
    { id: 'notes', options: { categories: ['3', '8'] } },
    { id: 'tasks', options: { categories: ['household'] } },
  ];
  const insert = db.prepare('INSERT INTO sync_config (key, value) VALUES (?, ?)');
  for (const key of ['dashboard_widgets', 'dashboard_widgets_default', 'dashboard_widgets:user:12', 'dashboard_widgets:user:13']) {
    insert.run(key, JSON.stringify(config));
  }
  insert.run('dashboard_widgets:user:14', JSON.stringify([{ id: 'notes', options: { categories: ['3'] } }]));
  insert.run('unrelated', JSON.stringify(config));
  pruneCategoryFromDashboardConfigs(db, 3);
  for (const key of ['dashboard_widgets', 'dashboard_widgets_default', 'dashboard_widgets:user:12', 'dashboard_widgets:user:13']) {
    const stored = JSON.parse(db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key).value);
    assert.deepEqual(stored[0].options.categories, ['8'], key);
    assert.deepEqual(stored[1].options.categories, ['household'], key);
  }
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT value FROM sync_config WHERE key = ?').get('unrelated').value),
    config,
  );
  assert.deepEqual(
    JSON.parse(db.prepare("SELECT value FROM sync_config WHERE key = 'dashboard_widgets:user:14'").get().value),
    [{ id: 'notes' }],
  );
  db.close();
});
