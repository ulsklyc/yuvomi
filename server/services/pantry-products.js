/**
 * Module: Household products above the stock batches (#1448, part 1)
 * Purpose: Which product a pantry batch belongs to, for every path that writes a
 *          batch, and the live grouping that puts batches without a product into
 *          products at the start of the server (migration 253 has a frozen copy).
 * Dependencies: public/utils/ingredient-match-key.js (isomorphic)
 *
 * IDENTITY IS THE HOUSEHOLD'S OWN WORDING (docs/DECISIONS.md, 7). A batch joins
 * the product with the same name and the same unit; the name is compared trimmed,
 * with whitespace collapsed and case-insensitive, the normalisation of
 * `ingredientMatchKey()`. No similarity, no catalogue. The unit is compared as
 * stored: "Rice, kg" and "Rice, g" are two products (no unit conversion).
 *
 * A NAME WITH NOTHING LEFT AFTER NORMALISING has no key (`name_key` NULL). Such a
 * batch gets a product of its own and is never grouped with another one: two
 * unnamed rows are not known to be the same thing, and joining them would add up
 * stock that has nothing in common. The routes refuse an empty name, so only
 * rows from before that validation can be like this.
 *
 * A PRODUCT OUTLIVES ITS LAST BATCH. Moving or deleting a batch never deletes a
 * product; deleting a product is its own action (a later step of #1448).
 *
 * Every function takes the database handle and runs inside the caller's
 * transaction: the batch and its product are written together or not at all.
 */

import { ingredientMatchKey } from '../../public/utils/ingredient-match-key.js';

/**
 * The key under which a product is found, or null for a name with nothing left.
 * The runtime rule: the writers and the adoption at start use it. Migration 253
 * carries its own frozen copy of key and grouping, see there.
 * @param {unknown} name
 * @returns {string|null}
 */
export function productKey(name) {
  return ingredientMatchKey(name) || null;
}

/**
 * Put a batch into the product its name and unit belong to, after the batch was
 * written. Call it from every path that writes a batch's name, unit or category.
 *
 * - The batch stays in its product while key and unit still match.
 * - Otherwise it joins the product with that key and unit, which is created when
 *   there is none. The product it leaves stays, with or without batches.
 * - The product's NAME is set when it is created and does not follow a batch:
 *   renaming one batch moves it to another product (#1448, point 5), a case or
 *   whitespace change keeps it where it is, and renaming the product with all
 *   its batches is an action of its own (a later step).
 * - The product's CATEGORY follows the batch written last. The category belongs
 *   to the product, and until the product can be edited on its own the batch
 *   dialog is the only place to change it; the same rule migration 253 applies
 *   to existing stock (the most recently updated batch of a group).
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number|bigint} itemId
 * `syncCategory` decides whether the batch's category is written to the product
 * when it stays in the same one: set it when the write changed the category (a
 * new batch, or an edit that set another category). A write that leaves the
 * category as it was (an edit of the expiry, say) does not push a stale batch
 * category onto the product. A batch that moves to another product always
 * brings its category along.
 *
 * @param {{ userId?: number|null, syncCategory?: boolean }} [options] who wrote,
 *   for a product created here; whether the category flows to the product
 * @returns {number|null} the product id, null when the batch does not exist
 */
export function assignPantryProduct(database, itemId, { userId = null, syncCategory = true } = {}) {
  const item = database.prepare(
    'SELECT id, name, unit, category, product_id FROM pantry_items WHERE id = ?'
  ).get(itemId);
  if (!item) return null;

  const key = productKey(item.name);
  let product = item.product_id == null
    ? null
    : database.prepare('SELECT id, name, name_key, unit, category FROM pantry_products WHERE id = ?').get(item.product_id);

  if (!product || product.unit !== item.unit || product.name_key !== key) {
    product = key === null
      ? null
      : database.prepare(
        'SELECT id, name, name_key, unit, category FROM pantry_products WHERE name_key = ? AND unit = ?'
      ).get(key, item.unit);
    if (!product) {
      const created = database.prepare(`
        INSERT INTO pantry_products (name, name_key, unit, category, created_by)
        VALUES (?, ?, ?, ?, (SELECT id FROM users WHERE id = ?))
      `).run(item.name, key, item.unit, item.category, userId);
      product = { id: Number(created.lastInsertRowid), name: item.name, category: item.category };
    }
  }

  const moved = item.product_id !== product.id;
  if ((syncCategory || moved) && product.category !== item.category) {
    database.prepare('UPDATE pantry_products SET category = ? WHERE id = ?').run(item.category, product.id);
  }
  if (moved) {
    database.prepare('UPDATE pantry_items SET product_id = ? WHERE id = ?').run(product.id, item.id);
  }
  return product.id;
}

/**
 * Put every batch without a matching product into one: a batch with no product,
 * and a batch whose name key or unit no longer matches its product's (renamed by
 * an older version, which does not know products). Grouped by key and unit,
 * joining an existing product with that key and unit, otherwise creating one;
 * a product left without batches stays. THE LIVE GROUPING, used by the start of
 * the server (with the runtime key) for batches an older version wrote or
 * renamed. A batch that matches its product is not touched, so a second run
 * finds nothing.
 *
 * A new product takes name and category from the most recently updated batch of
 * its group (the household's latest wording), `created_by` and `created_at` from
 * the oldest batch (the product existed since then). An existing product is
 * joined as it is.
 *
 * MIGRATION 253 DOES NOT CALL THIS FUNCTION. It carries its own frozen copy of
 * key and grouping (see the entry in server/db.js), so this function may change
 * with later steps (the minimum, say) without changing what the migration does.
 * test:pantry-products asserts that both give the same products today; when a
 * change here turns that test red on purpose, adjust the test, not the
 * migration.
 *
 * Batches keep their `updated_at`: the triggers of pantry_items rest while
 * `product_id` is set and are put back with their stored text, in the caller's
 * transaction. Grouping is not an edit by anybody.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {(name: unknown) => string} keyOf the normalisation; '' means no key
 * @returns {{ batches: number, created: number }}
 */
export function groupBatchesIntoProducts(database, keyOf) {
  // One query over batch and product; the key is compared in JS, because it is
  // built there (SQLite's lower() folds ASCII only).
  const orphans = database.prepare(`
    SELECT pi.id, pi.name, pi.unit, pi.category, pi.created_by, pi.created_at, pi.updated_at,
           pp.id AS product, pp.name_key AS product_key, pp.unit AS product_unit
    FROM pantry_items pi LEFT JOIN pantry_products pp ON pp.id = pi.product_id
    ORDER BY pi.id
  `).all().filter((row) => row.product === null
    || row.product_unit !== row.unit
    || row.product_key !== (keyOf(row.name) || null));
  if (orphans.length === 0) return { batches: 0, created: 0 };

  const groups = new Map();
  for (const row of orphans) {
    const key = keyOf(row.name) || null;
    // A batch without a key is a group of its own (see the module comment).
    const groupId = key === null ? `#${row.id}` : `${row.unit}\u0000${key}`;
    if (!groups.has(groupId)) groups.set(groupId, { key, unit: row.unit, rows: [] });
    groups.get(groupId).rows.push(row);
  }

  const findProduct = database.prepare('SELECT id FROM pantry_products WHERE name_key = ? AND unit = ?');
  const insertProduct = database.prepare(`
    INSERT INTO pantry_products (name, name_key, unit, category, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), ?, ?)
  `);
  const setProduct = database.prepare('UPDATE pantry_items SET product_id = ? WHERE id = ?');

  const triggers = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'pantry_items' AND sql IS NOT NULL
    ORDER BY rowid
  `).all();
  for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);

  let created = 0;
  for (const group of groups.values()) {
    let productId = group.key === null ? null : findProduct.get(group.key, group.unit)?.id ?? null;
    if (productId === null) {
      const latest = group.rows.reduce((a, b) => (
        b.updated_at > a.updated_at || (b.updated_at === a.updated_at && b.id > a.id) ? b : a
      ));
      const oldest = group.rows.reduce((a, b) => (
        b.created_at < a.created_at || (b.created_at === a.created_at && b.id < a.id) ? b : a
      ));
      productId = Number(insertProduct.run(
        latest.name, group.key, group.unit, latest.category,
        oldest.created_by, oldest.created_at, latest.updated_at
      ).lastInsertRowid);
      created += 1;
    }
    for (const row of group.rows) setProduct.run(productId, row.id);
  }

  for (const trigger of triggers) database.exec(trigger.sql);
  return { batches: orphans.length, created };
}
