/** Existing standalone Savings bookings must survive the hierarchy correction. */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'savings-migration-test';
const { get, MIGRATIONS } = await import('../server/db.js');
const db = get();

test('Savings moves under Financials without losing bookings, series or planned amounts', () => {
  const user = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('saving-test', 'Test', 'x', 'member')").run().lastInsertRowid;
  db.prepare("INSERT INTO budget_categories (key, name, type) VALUES ('saving', 'Saving', 'expense')").run();
  const id = db.prepare("INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by) VALUES ('Existing saving', -125, 'saving', '', '2026-10-06', 1, ?)").run(user).lastInsertRowid;
  db.prepare("INSERT INTO budget_plans (category, amount) VALUES ('saving', 125), ('financial_other', 50)").run();
  db.exec(MIGRATIONS.find(m => m.version === 238).up);
  assert.equal(db.prepare("SELECT key FROM budget_categories WHERE key = 'saving'").get(), undefined);
  assert.equal(db.prepare("SELECT category_key FROM budget_subcategories WHERE key = 'saving'").get().category_key, 'financial_other');
  for (const [table, key] of [['budget_entries', 'id'], ['budget_series', 'anchor_id']]) {
    const row = db.prepare(`SELECT category, subcategory, amount FROM ${table} WHERE ${key} = ?`).get(id);
    assert.deepEqual(row, { category: 'financial_other', subcategory: 'saving', amount: -125 });
  }
  assert.equal(db.prepare("SELECT amount FROM budget_plans WHERE category = 'financial_other'").get().amount, 175);
  assert.equal(db.prepare("SELECT category FROM budget_plans WHERE category = 'saving'").get(), undefined);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // Reapplying the data correction never adds the old plan twice.
  db.exec(MIGRATIONS.find(m => m.version === 238).up);
  assert.equal(db.prepare("SELECT amount FROM budget_plans WHERE category = 'financial_other'").get().amount, 175);
});
