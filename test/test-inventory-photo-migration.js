/**
 * Test: Inventory photo migration (v139)
 * Purpose: Verify that the photo_data column is properly added as a nullable TEXT column
 * to inventory_items, and that existing rows inserted without photo_data default to NULL.
 * Run: node --test test/test-inventory-photo-migration.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const db = dbmod.get();

test('inventory_items has a nullable photo_data column after migration', () => {
  const columns = db.prepare('PRAGMA table_info(inventory_items)').all();
  const photoCol = columns.find((c) => c.name === 'photo_data');
  assert.ok(photoCol, 'photo_data column is missing from inventory_items');
  assert.equal(photoCol.notnull, 0, 'photo_data must be nullable');

  // Pre-existing rows (simulated: any row inserted without photo_data) default to NULL.
  // Ensure the category exists (seeded by migrations)
  const categoryExists = db.prepare(`
    SELECT 1 FROM inventory_categories WHERE key = 'other'
  `).get();
  if (!categoryExists) {
    db.prepare(`
      INSERT INTO inventory_categories (key, name, icon, sort_order) VALUES ('other', 'Other', 'package', 0)
    `).run();
  }
  const result = db.prepare(`
    INSERT INTO inventory_items (name, category) VALUES ('Test Item', 'other')
  `).run();
  const row = db.prepare('SELECT photo_data FROM inventory_items WHERE id = ?').get(result.lastInsertRowid);
  assert.equal(row.photo_data, null);
});
