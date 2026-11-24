export default {
    version: 5,
    description: 'Shopping categories as a separate table (customizable, sortable)',
    up: `
      CREATE TABLE IF NOT EXISTS shopping_categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        icon       TEXT    NOT NULL DEFAULT 'tag',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO shopping_categories (name, icon, sort_order) VALUES
        ('Obst & Gemüse',   'apple',           0),
        ('Backwaren',        'wheat',           1),
        ('Milchprodukte',    'milk',            2),
        ('Fleisch & Fisch',  'beef',            3),
        ('Tiefkühl',         'snowflake',       4),
        ('Getränke',         'cup-soda',        5),
        ('Haushalt',         'spray-can',       6),
        ('Drogerie',         'pill',            7),
        ('Sonstiges',        'shopping-basket', 8);
    `,
  };
