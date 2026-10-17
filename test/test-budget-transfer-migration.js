/** Transfer storage is additive: household categories and financial history stay intact. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'transfer-migration-test';
const { MIGRATIONS, migrate } = await import('../server/db.js');
const migration = MIGRATIONS.find(item => item.description.startsWith('Budget transfers:'));

function beforeTransferMigration() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database, MIGRATIONS.filter(item => item.version < migration.version));
  return database;
}

test('transfer migration creates its final categories and a cascading pair link without a standalone Saving category', () => {
  const database = beforeTransferMigration();
  try {
    migrate(database, [migration]);
    assert.equal(database.prepare("SELECT key FROM budget_categories WHERE key = 'saving'").get(), undefined);
    assert.equal(database.prepare("SELECT category_key FROM budget_subcategories WHERE key = 'saving'").get().category_key, 'financial_other');
    assert.equal(database.prepare("SELECT type FROM budget_categories WHERE key = 'Geschenke & Transfers'").get().type, 'income');
    const foreignKey = database.pragma('foreign_key_list(budget_entries)').find(row => row.from === 'transfer_entry_id');
    assert.equal(foreignKey.table, 'budget_entries');
    assert.equal(foreignKey.to, 'id');
    assert.equal(foreignKey.on_delete, 'CASCADE');
    assert.ok(database.pragma('index_list(budget_entries)').some(row => row.name === 'idx_budget_transfer'));
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally { database.close(); }
});

test('transfer migration preserves a household Saving category, its subcategories, entries, series and separate plans', () => {
  const database = beforeTransferMigration();
  try {
    const user = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('saving-test', 'Test', 'x', 'member')").run().lastInsertRowid;
    database.prepare("INSERT INTO budget_categories (key, name, type) VALUES ('saving', 'Saving', 'expense')").run();
    database.prepare("INSERT INTO budget_subcategories (key, category_key, name) VALUES ('household_saving', 'saving', 'Emergency fund')").run();
    const id = database.prepare("INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by) VALUES ('Existing saving', -125, 'saving', 'household_saving', '2026-10-06', 1, ?)").run(user).lastInsertRowid;
    assert.equal(database.prepare('SELECT category FROM budget_series WHERE anchor_id = ?').get(id).category, 'saving');
    database.prepare("INSERT INTO budget_plans (category, amount) VALUES ('saving', 125), ('financial_other', 50)").run();
    const snapshots = {
      categories: database.prepare("SELECT * FROM budget_categories WHERE key IN ('saving', 'financial_other') ORDER BY key").all(),
      subcategories: database.prepare("SELECT * FROM budget_subcategories WHERE category_key = 'saving' ORDER BY key").all(),
      entries: database.prepare('SELECT * FROM budget_entries ORDER BY id').all(),
      series: database.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all(),
      plans: database.prepare('SELECT * FROM budget_plans ORDER BY category').all(),
    };
    migrate(database, [migration]);
    assert.deepEqual(database.prepare("SELECT * FROM budget_categories WHERE key IN ('saving', 'financial_other') ORDER BY key").all(), snapshots.categories);
    assert.deepEqual(database.prepare("SELECT * FROM budget_subcategories WHERE category_key = 'saving' ORDER BY key").all(), snapshots.subcategories);
    const entries = database.prepare('SELECT * FROM budget_entries ORDER BY id').all();
    assert.ok(entries.every(row => row.transfer_entry_id === null));
    assert.deepEqual(entries.map(({ transfer_entry_id, ...row }) => row), snapshots.entries);
    assert.deepEqual(database.prepare('SELECT * FROM budget_series ORDER BY anchor_id').all(), snapshots.series);
    assert.deepEqual(database.prepare('SELECT * FROM budget_plans ORDER BY category').all(), snapshots.plans);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally { database.close(); }
});

test('transfer migration does not restore deleted Financials or transfer-income categories', () => {
  const database = beforeTransferMigration();
  try {
    database.prepare("DELETE FROM budget_subcategories WHERE category_key = 'financial_other'").run();
    database.prepare("DELETE FROM budget_categories WHERE key IN ('financial_other', 'Geschenke & Transfers')").run();
    const categories = database.prepare('SELECT * FROM budget_categories ORDER BY key').all();
    const subcategories = database.prepare('SELECT * FROM budget_subcategories ORDER BY key').all();
    migrate(database, [migration]);
    assert.deepEqual(database.prepare('SELECT * FROM budget_categories ORDER BY key').all(), categories);
    assert.deepEqual(database.prepare('SELECT * FROM budget_subcategories ORDER BY key').all(), subcategories);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally { database.close(); }
});

test('transfer migration keeps an existing household Savings subcategory without renaming or duplicating it', () => {
  const database = beforeTransferMigration();
  try {
    database.prepare("INSERT INTO budget_subcategories (key, category_key, name, sort_order) VALUES ('my_savings', 'financial_other', 'Savings', 3)").run();
    const before = database.prepare("SELECT * FROM budget_subcategories WHERE category_key = 'financial_other' ORDER BY key").all();
    migrate(database, [migration]);
    assert.deepEqual(database.prepare("SELECT * FROM budget_subcategories WHERE category_key = 'financial_other' ORDER BY key").all(), before);
    assert.equal(database.prepare("SELECT 1 FROM budget_subcategories WHERE key = 'saving'").get(), undefined);
  } finally { database.close(); }
});
