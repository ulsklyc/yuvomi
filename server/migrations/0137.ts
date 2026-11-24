export default {
    version: 137,
    description: 'Inventory: locations, categories, items (Stage 1 of the full design)',
    up: `
      -- Zwei-Ebenen-Hierarchie ueber parent_id. Kein Umhaengen zwischen Eltern in der
      -- API (siehe Plan), daher ist ein Zyklus ueber diese Spalte nicht erreichbar -
      -- die Spalte existiert trotzdem als echte Selbstreferenz, falls eine spaetere
      -- Stufe das Umhaengen doch braucht.
      CREATE TABLE IF NOT EXISTS inventory_locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        parent_id  INTEGER REFERENCES inventory_locations(id) ON DELETE SET NULL,
        icon       TEXT    NOT NULL DEFAULT 'package',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_locations_parent ON inventory_locations(parent_id);

      CREATE TRIGGER IF NOT EXISTS trg_inventory_locations_updated_at
        AFTER UPDATE ON inventory_locations FOR EACH ROW
        BEGIN UPDATE inventory_locations SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- 'key' ist der stabile Fremdschluessel fuer inventory_items.category (siehe
      -- dort) - unabhaengig vom (umbenennbaren) Anzeigenamen.
      CREATE TABLE IF NOT EXISTS inventory_categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT    NOT NULL UNIQUE,
        name       TEXT    NOT NULL,
        icon       TEXT    NOT NULL DEFAULT 'package',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO inventory_categories (key, name, icon, sort_order) VALUES
        ('electronics', 'Elektronik', 'cpu',      0),
        ('vehicles',    'Fahrzeuge',  'car',      1),
        ('household',   'Haushalt',   'home',     2),
        ('sports',      'Sport',      'dumbbell', 3),
        ('other',       'Sonstiges',  'package',  4);

      CREATE TABLE IF NOT EXISTS inventory_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT    NOT NULL,
        brand           TEXT,
        model           TEXT,
        serial_number   TEXT,
        -- Kein echter FK auf inventory_categories.key - siehe Plan (Global
        -- Constraints): Loeschen einer Kategorie haengt Gegenstaende per Route auf
        -- 'other' um, das kann eine DB-Constraint nicht mit einem konkreten
        -- Rueckfallwert (nur mit NULL).
        category        TEXT    NOT NULL DEFAULT 'other',
        location_id     INTEGER REFERENCES inventory_locations(id) ON DELETE SET NULL,
        purchase_date   TEXT,
        purchase_price  REAL    CHECK (purchase_price IS NULL OR purchase_price >= 0),
        currency        TEXT,
        vendor          TEXT,
        warranty_months INTEGER CHECK (warranty_months IS NULL OR (warranty_months >= 0 AND warranty_months <= 600)),
        condition       TEXT    NOT NULL DEFAULT 'good' CHECK (condition IN ('new','good','fair','poor')),
        status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','disposed','lost')),
        notes           TEXT,
        -- SET NULL von Anfang an, nicht CASCADE: Inventar ist Haushaltseigentum wie
        -- der Vorrat. pantry_items brauchte dafuer eine Nachfolgemigration (v109) -
        -- hier wird der gleiche Fehler nicht wiederholt.
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_items_location ON inventory_items(location_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);
      CREATE INDEX IF NOT EXISTS idx_inventory_items_status   ON inventory_items(status);

      CREATE TRIGGER IF NOT EXISTS trg_inventory_items_updated_at
        AFTER UPDATE ON inventory_items FOR EACH ROW
        BEGIN UPDATE inventory_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
