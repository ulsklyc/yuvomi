import { log } from './helpers.ts';

export default {
    version: 285,
    description: 'Recipes: a confirmed match names a household product and holds in every recipe (#1448)',
    // A CONFIRMED MATCH SAYS "THIS WORDING MEANS THIS PRODUCT", FOR THE WHOLE
    // HOUSEHOLD (#1448, part 4). Until here a match pointed at one batch of one
    // recipe (v222): it was gone with the bottle (ON DELETE CASCADE on
    // `pantry_item_id`), although another bottle stood in the garage fridge,
    // and the same wording had to be confirmed again in every recipe.
    //
    // KEYED BY THE WORDING ALONE. `ingredient_key` is the ingredient name
    // trimmed, whitespace collapsed and lowercased, the key of v222
    // (public/utils/ingredient-match-key.js). One wording names at most one
    // product; confirming it again replaces the statement. No recipe id: the
    // statement is not owned by a recipe, so a recipe save and the provider
    // mirror no longer delete it, and a recipe confirmed later finds it.
    //
    // `product_id` IS ON DELETE CASCADE: a product outlives its last batch, so
    // using up a batch no longer removes the match; deleting the product (an
    // action of its own) does, because then the statement has no subject left.
    // A merge of two products (a later step) moves the matches with one
    // `UPDATE pantry_product_matches SET product_id = ? WHERE product_id = ?`.
    //
    // NO "CONFIRMED: NOT IN STOCK" STATE. v222 had none either: clearing a match
    // deleted its row, and an unmatched ingredient is unknown, not missing
    // (docs/DECISIONS.md, 7).
    //
    // `recipe_ingredient_pantry_matches` STAYS, UNREAD AND UNWRITTEN, for one
    // release (the answer on #1448): the previous version, started again on this
    // database, still finds its matches there. A later migration drops it.
    up: `
      CREATE TABLE IF NOT EXISTS pantry_product_matches (
        ingredient_key TEXT    NOT NULL PRIMARY KEY CHECK (ingredient_key <> ''),
        product_id     INTEGER NOT NULL REFERENCES pantry_products(id) ON DELETE CASCADE,
        -- Provenance only, SET NULL as in v222 and v109: a member who leaves
        -- takes no household data along.
        confirmed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- For the cascade when a product goes, and for the merge of a later step.
      CREATE INDEX IF NOT EXISTS idx_ppm_product ON pantry_product_matches(product_id);

      CREATE TRIGGER IF NOT EXISTS trg_ppm_updated_at
        AFTER UPDATE ON pantry_product_matches FOR EACH ROW
        BEGIN
          UPDATE pantry_product_matches
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE ingredient_key = OLD.ingredient_key;
        END;
    `,
    // THE EXISTING MATCHES, CARRIED OVER (#1448, point 2). A batch match becomes
    // a match on that batch's product. Where one wording pointed at different
    // products in different recipes, the most recently confirmed one is kept
    // (`updated_at`; on the same second the row inserted later into the old
    // table, which is not necessarily the one confirmed later: a re-confirmation
    // updated its row in place) and the number of such wordings is logged.
    // `confirmed_by` and `updated_at` are the kept row's, `created_at` the
    // earliest of the rows that named the kept product. A row with an empty
    // `ingredient_key` (v222 had no CHECK; its route never wrote one) names no
    // wording and is left out, before anything is counted.
    //
    // A batch without a product (written by an older version under
    // DB_ALLOW_NEWER_SCHEMA; init() adopts it only after the migrations) is
    // looked up by its own wording and unit among the products, with a frozen
    // copy of the key of v253. When there is no such product yet, the match is
    // not carried over and counted in the log line; the batch match itself stays
    // in the old table.
    //
    // FROZEN: this entry reads only `recipe_ingredient_pantry_matches` (v222),
    // `pantry_items.product_id` and `pantry_products` (v253) and imports nothing,
    // so a later change to the live key or the grouping cannot change what it
    // does on an installation that has not run it yet.
    /** @param database the connection migrate() runs the entry on */
    afterUp(database: import('../authorize/index.ts').Database) {
      const frozenKey = (name: unknown): string | null => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase() || null;
      const rows = database.prepare(`
        SELECT m.rowid AS seq, m.ingredient_key, m.confirmed_by, m.created_at, m.updated_at,
               pi.product_id, pi.name AS item_name, pi.unit AS item_unit
        FROM recipe_ingredient_pantry_matches m
        JOIN pantry_items pi ON pi.id = m.pantry_item_id
        WHERE m.ingredient_key <> ''
        ORDER BY m.rowid
      `).all() as Array<{
        seq: number, ingredient_key: string, confirmed_by: number | null, created_at: string, updated_at: string,
        product_id: number | null, item_name: string | null, item_unit: string,
      }>;
      if (rows.length === 0) return;

      const findProduct = database.prepare('SELECT id FROM pantry_products WHERE name_key = ? AND unit = ?');
      const byKey = new Map<string, Array<{ seq: number, created_at: string, updated_at: string, confirmed_by: number | null, productId: number }>>();
      let notCarried = 0;
      for (const row of rows) {
        let productId = row.product_id;
        if (productId == null) {
          const key = frozenKey(row.item_name);
          productId = key === null ? null : ((findProduct.get(key, row.item_unit) as { id: number } | undefined)?.id ?? null);
        }
        if (productId == null) {
          notCarried += 1;
          continue;
        }
        if (!byKey.has(row.ingredient_key)) byKey.set(row.ingredient_key, []);
        byKey.get(row.ingredient_key)?.push({ ...row, productId });
      }

      const insert = database.prepare(`
        INSERT INTO pantry_product_matches (ingredient_key, product_id, confirmed_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      let conflicts = 0;
      for (const [key, list] of byKey) {
        const kept = list.reduce((a, b) => (
          b.updated_at > a.updated_at || (b.updated_at === a.updated_at && b.seq > a.seq) ? b : a
        ));
        if (new Set(list.map((row) => row.productId)).size > 1) conflicts += 1;
        const createdAt = list.filter((row) => row.productId === kept.productId)
          .reduce((a, b) => (b.created_at < a.created_at ? b : a)).created_at;
        insert.run(key, kept.productId, kept.confirmed_by, createdAt, kept.updated_at);
      }

      log.info(
        `Found ${rows.length} recipe match(es); carried ${rows.length - notCarried} of them over to ${byKey.size} household product match(es); `
        + `${conflicts} wording(s) named different products in different recipes and kept the most recently confirmed one; `
        + `${notCarried} match(es) of a batch without a product were not carried over.`
      );
    },
  };
