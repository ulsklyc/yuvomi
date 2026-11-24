export default {
    version: 280,
    description: 'Shopping: purchase price history (#1003)',
    // A PURCHASE HISTORY IS A RECORD OF FACTS (#1003). When a priced item is
    // ticked off or cleared, a purchase entry is written with the item name,
    // price in cents, shop reference, and date. Names match ignoring case
    // (COLLATE NOCASE). shopping_item_id keeps uniqueness while on the list
    // and turns to NULL when cleared, preserving the history row forever.
    up: `
      CREATE TABLE IF NOT EXISTS shopping_purchases (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name        TEXT    NOT NULL,
        price_cents      INTEGER NOT NULL CHECK(price_cents >= 0),
        store_id         INTEGER REFERENCES shopping_stores(id) ON DELETE SET NULL,
        shopping_item_id INTEGER REFERENCES shopping_items(id) ON DELETE SET NULL,
        purchased_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_shopping_purchases_name_date
        ON shopping_purchases(item_name COLLATE NOCASE, purchased_at DESC, id DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_purchases_item
        ON shopping_purchases(shopping_item_id)
        WHERE shopping_item_id IS NOT NULL;
    `,
  };
