// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 276,
    description: 'Pantry: the minimum moves to the product, low and out are read over its total (#1448)',
    // THE MINIMUM IS A STATEMENT ABOUT THE PRODUCT. Toothpaste with 1 in the
    // bathroom and 8 in the attic and a minimum of 3 on the bathroom row read
    // as low, although the household has 9. From here on low and out are read
    // over the product: the sum of its batches against the product's minimum.
    //
    // THE BACKFILL TAKES THE HIGHEST MINIMUM OF A PRODUCT'S BATCHES (#1448,
    // point 1): where batches of one product carry different minimums, the
    // highest warns early rather than late. MAX() skips NULL, so a product
    // whose batches carry no minimum, or that has no batch at all, keeps NULL.
    //
    // `pantry_items.min_quantity` STAYS. No destructive change: nothing reads it
    // for low or out any more, the API returns the product's value in its place
    // and writes a batch's `min_quantity` through to the product for the
    // deprecation window (#1448, point 4). The previous version, started again
    // on this database, still finds the column.
    //
    // Plain SQL, no runtime code. The trigger of pantry_products rests while the
    // minimum is filled in and is created again with the wording of v253: a
    // backfill is not an edit by anybody, so `updated_at` stays.
    up: `
      ALTER TABLE pantry_products ADD COLUMN min_quantity REAL;

      DROP TRIGGER IF EXISTS trg_pantry_products_updated_at;
      UPDATE pantry_products SET min_quantity = (
        SELECT MAX(pi.min_quantity) FROM pantry_items pi WHERE pi.product_id = pantry_products.id
      );
      CREATE TRIGGER IF NOT EXISTS trg_pantry_products_updated_at
        AFTER UPDATE ON pantry_products FOR EACH ROW
        BEGIN UPDATE pantry_products SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
