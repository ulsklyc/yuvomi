// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { log } from './helpers.ts';

export default {
    version: 253,
    description: 'Pantry: a household product above the batch, every batch belongs to one (#1448)',
    // A STOCK ROW STAYS ONE BATCH (comment at v108), AND NOW BELONGS TO A
    // PRODUCT. What is really a statement about the product - the minimum, later
    // the target and the preferred shop, a confirmed recipe match - needs a row
    // that outlives a single bottle. This is the first step of #1448 and changes
    // nothing anybody sees: the reads stay on the batch, the API only gains
    // `pantry_items.product_id`.
    //
    // Identity is the household's own wording (docs/DECISIONS.md, 7): same name
    // (trimmed, whitespace collapsed, case-insensitive) and same unit, the unit
    // compared as stored. `name_key` is that normalised name, built in JS and
    // stored, because SQLite's lower() folds ASCII only ("Öl" stays "Öl").
    // NULL = a name with nothing left after normalising: such a batch gets a
    // product of its own, and UNIQUE lets any number of them stand.
    //
    // No minimum here yet: it moves to the product in a later step, with the
    // highest of its batches, together with the reading of low and out.
    //
    // `pantry_items.product_id` is ON DELETE CASCADE: deleting a product deletes
    // its batches. Nothing deletes a product in this step (a product outlives
    // its last batch); the later "delete product" action relies on it. Nullable
    // because ADD COLUMN cannot add a NOT NULL reference, and because a batch
    // written by an older version (DB_ALLOW_NEWER_SCHEMA) arrives without one -
    // init() adopts those at start, with the live grouping of the writers.
    up: `
      CREATE TABLE IF NOT EXISTS pantry_products (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        name_key   TEXT,
        unit       TEXT    NOT NULL,
        category   TEXT    NOT NULL DEFAULT 'Sonstiges',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (name_key, unit)
      );

      CREATE TRIGGER IF NOT EXISTS trg_pantry_products_updated_at
        AFTER UPDATE ON pantry_products FOR EACH ROW
        BEGIN UPDATE pantry_products SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      ALTER TABLE pantry_items ADD COLUMN product_id INTEGER REFERENCES pantry_products(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_pantry_items_product ON pantry_items(product_id);
    `,
    // The existing stock, grouped into products. THIS ENTRY CARRIES ITS OWN
    // FROZEN GROUPING, as of this migration: the key (a copy of
    // public/utils/ingredient-match-key.js) and the rules (by key and unit as
    // stored; a name with nothing left gets a product of its own with NULL
    // key; name and category from the most recently updated batch, author and
    // created_at from the oldest; the pantry_items triggers rest so batches
    // keep their updated_at). It reads and writes only what exists at v253 and
    // imports nothing, so a later change to the live grouping
    // (the grouping in server/services/pantry-products.js, which
    // the start of the server uses for batches without a product) or to the
    // key cannot change what this migration does on an installation that has
    // not run it yet. It lives in this entry, so test:migrations-append-only
    // holds it once merged. test:pantry-products asserts that the frozen and
    // the live grouping still agree today.
    afterUp(database) {
      const frozenKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase() || null;
      const rows = database.prepare(`
        SELECT id, name, unit, category, created_by, created_at, updated_at
        FROM pantry_items WHERE product_id IS NULL ORDER BY id
      `).all();
      if (rows.length === 0) return;

      const groups = new Map();
      for (const row of rows) {
        const key = frozenKey(row.name);
        const groupId = key === null ? `#${row.id}` : `${row.unit}\u0000${key}`;
        if (!groups.has(groupId)) groups.set(groupId, { key, unit: row.unit, rows: [] });
        groups.get(groupId).rows.push(row);
      }

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

      for (const group of groups.values()) {
        const latest = group.rows.reduce((a, b) => (
          b.updated_at > a.updated_at || (b.updated_at === a.updated_at && b.id > a.id) ? b : a
        ));
        const oldest = group.rows.reduce((a, b) => (
          b.created_at < a.created_at || (b.created_at === a.created_at && b.id < a.id) ? b : a
        ));
        const productId = Number(insertProduct.run(
          latest.name, group.key, group.unit, latest.category,
          oldest.created_by, oldest.created_at, latest.updated_at
        ).lastInsertRowid);
        for (const row of group.rows) setProduct.run(productId, row.id);
      }

      for (const trigger of triggers) database.exec(trigger.sql);
      log.info(`Grouped ${rows.length} pantry batch(es) into ${groups.size} product(s).`);
    },
  };
