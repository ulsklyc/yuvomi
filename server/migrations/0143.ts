export default {
    version: 143,
    description: 'Inventory: localize the five seeded categories via label_key (matches Task Categories, migration 83)',
    up: `
      -- Gleiches Muster wie task_categories: label_key traegt den i18n-Key fuer
      -- Seed-Kategorien (name = NULL -> lokalisiert), Custom-Kategorien tragen
      -- weiterhin name (label_key = NULL). name war seit Migration 136 NOT NULL
      -- (anders als bei task_categories) - Tabellen-Neubau statt einem simplen
      -- ADD COLUMN, sonst schlaegt die folgende UPDATE...SET name = NULL fehl.
      -- Kein FK verweist auf inventory_categories (inventory_items.category ist
      -- bewusst kein echter FK, siehe Migration 136), foreignKeysOff also nicht noetig.
      CREATE TABLE inventory_categories_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT    NOT NULL UNIQUE,
        name       TEXT,
        label_key  TEXT,
        icon       TEXT    NOT NULL DEFAULT 'package',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      INSERT INTO inventory_categories_new (id, key, name, icon, sort_order, created_at)
        SELECT id, key, name, icon, sort_order, created_at FROM inventory_categories;
      DROP TABLE inventory_categories;
      ALTER TABLE inventory_categories_new RENAME TO inventory_categories;

      -- Nur unveraendert gebliebene Seed-Zeilen umstellen: WHERE name = '<Seed-Wert>'
      -- laesst eine bereits umbenannte Kategorie (jetzt effektiv custom) in Ruhe,
      -- statt ihr die Benutzer-Umbenennung beim naechsten Sprachwechsel zu ueberschreiben.
      UPDATE inventory_categories SET label_key = 'inventory.categoryElectronics', name = NULL
        WHERE key = 'electronics' AND name = 'Elektronik';
      UPDATE inventory_categories SET label_key = 'inventory.categoryVehicles', name = NULL
        WHERE key = 'vehicles' AND name = 'Fahrzeuge';
      UPDATE inventory_categories SET label_key = 'inventory.categoryHousehold', name = NULL
        WHERE key = 'household' AND name = 'Haushalt';
      UPDATE inventory_categories SET label_key = 'inventory.categorySports', name = NULL
        WHERE key = 'sports' AND name = 'Sport';
      UPDATE inventory_categories SET label_key = 'inventory.categoryOther', name = NULL
        WHERE key = 'other' AND name = 'Sonstiges';
    `,
  };
