// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 108,
    description: 'Pantry: food inventory with quantity, storage location and expiry date (#596)',
    up: `
      -- Der Küchen-Kreislauf hatte bisher drei Seiten - planen (Mahlzeiten),
      -- kochen (Rezepte), einkaufen (Einkauf) - und keine vierte: was tatsächlich
      -- im Haus ist. Ohne Bestand beantwortet die App weder "wie viel Mehl noch?"
      -- noch "was läuft bald ab?" (#596).

      -- Lagerorte analog shopping_categories: eigene Tabelle, sortierbar,
      -- umbenennbar. Deutsche Seed-Namen, die Anzeige übersetzt über
      -- DEFAULT_LOCATION_I18N - umbenannte Orte behalten ihren Klartext.
      CREATE TABLE IF NOT EXISTS pantry_locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        icon       TEXT    NOT NULL DEFAULT 'package',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO pantry_locations (name, icon, sort_order) VALUES
        ('Vorratsschrank', 'archive',      0),
        ('Kühlschrank',    'refrigerator', 1),
        ('Gefrierschrank', 'snowflake',    2),
        ('Keller',         'warehouse',    3),
        ('Sonstiges',      'package',      4);

      CREATE TABLE IF NOT EXISTS pantry_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        -- REAL statt des Freitexts von recipe_ingredients.quantity: nur eine Zahl
        -- lässt sich per Stepper verringern, gegen min_quantity prüfen und beim
        -- Einkaufs-Import zusammenzählen. Der Vorrat ist die einzige Küchen-
        -- Tabelle, die rechnen muss.
        quantity     REAL    NOT NULL DEFAULT 1,
        -- Bewusst OHNE CHECK-Constraint: eine zusätzliche Einheit wäre in SQLite
        -- sonst ein Tabellen-Rebuild. Gültigkeit erzwingt der Router gegen die
        -- geteilte Liste in public/utils/pantry-units.js.
        unit         TEXT    NOT NULL DEFAULT 'pcs',
        -- ON DELETE SET NULL: einen Lagerort zu löschen darf nie Bestand
        -- vernichten. Ortlose Zeilen sammelt die Seite unter "Ohne Lagerort".
        location_id  INTEGER REFERENCES pantry_locations(id) ON DELETE SET NULL,
        category     TEXT    NOT NULL DEFAULT 'Sonstiges',
        -- YYYY-MM-DD; NULL = unbegrenzt haltbar (Salz, Reis, Konserven ohne MHD).
        expires_on   TEXT,
        -- NULL = kein Mindestbestand überwacht. Ist er gesetzt, meldet die Zeile
        -- "fast leer", sobald quantity <= min_quantity.
        min_quantity REAL,
        notes        TEXT,
        created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Eine Zeile = eine Charge. Zwei Packungen Milch mit verschiedenem MHD
      -- sind zwei Zeilen; eine Chargen-Hierarchie unter dem Produkt kostet
      -- Komplexität, die eine Familienküche nicht braucht.

      CREATE INDEX IF NOT EXISTS idx_pantry_items_expires  ON pantry_items(expires_on);
      CREATE INDEX IF NOT EXISTS idx_pantry_items_location ON pantry_items(location_id);
      CREATE INDEX IF NOT EXISTS idx_pantry_items_name     ON pantry_items(name);

      CREATE TRIGGER IF NOT EXISTS trg_pantry_items_updated_at
        AFTER UPDATE ON pantry_items FOR EACH ROW
        BEGIN UPDATE pantry_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
