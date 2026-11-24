// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 267,
    description: 'waste: one import label can map to several types (#2273)',
    up: `
      -- EIN LABEL, MEHRERE TYPEN (#2273): Dresden nennt zwei Tonnen in einem
      -- Eintrag ("Leerung Bio-Tonne, Blaue Tonne"). Bisher trug eine Zuordnung
      -- genau eine type_id (Migration 200) und ein Eintrag wurde genau ein
      -- Termin (Migration 201). Ab hier haengen die Typen eines Labels in
      -- waste_source_mapping_types, und ein Eintrag wird ein Termin je Typ -
      -- Farbe, Uebersicht und Erinnerung bleiben je Tonne.
      --
      -- waste_source_mappings wird ohne type_id und ohne ignored neu gebaut:
      -- "ignoriert" ist jetzt genau "keine Typ-Zeile", eine einzige Wahrheit
      -- statt zweier Spalten, die sich widersprechen koennten. Keine Tabelle
      -- verweist auf diese beiden, das DROP raeumt also nichts per CASCADE ab;
      -- die neue Kindtabelle entsteht erst nach dem Umbau. Ein kuenftiger
      -- Umbau von waste_source_mappings mit DROP TABLE muss mit foreignKeysOff
      -- laufen, sonst nimmt CASCADE die Typ-Zeilen mit.
      CREATE TABLE waste_source_mappings_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id         INTEGER NOT NULL REFERENCES waste_sources(id) ON DELETE CASCADE,
        original_label    TEXT    NOT NULL,
        normalized_label  TEXT    NOT NULL,
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (source_id, normalized_label)
      );
      INSERT INTO waste_source_mappings_new (id, source_id, original_label, normalized_label, created_at, updated_at)
        SELECT id, source_id, original_label, normalized_label, created_at, updated_at FROM waste_source_mappings;

      -- type_id ohne CASCADE, wie ueberall in Waste: ein Typ, auf den eine
      -- Zuordnung zeigt, verschwindet nicht still (invariant #5).
      CREATE TABLE waste_source_mapping_types (
        mapping_id INTEGER NOT NULL REFERENCES waste_source_mappings_new(id) ON DELETE CASCADE,
        type_id    INTEGER NOT NULL REFERENCES waste_types(id),
        PRIMARY KEY (mapping_id, type_id)
      );
      INSERT INTO waste_source_mapping_types (mapping_id, type_id)
        SELECT m.id, m.type_id FROM waste_source_mappings m JOIN waste_types t ON t.id = m.type_id
        WHERE m.ignored = 0;

      DROP TABLE waste_source_mappings;
      ALTER TABLE waste_source_mappings_new RENAME TO waste_source_mappings;
      CREATE TRIGGER trg_waste_source_mappings_updated_at AFTER UPDATE ON waste_source_mappings FOR EACH ROW BEGIN
        UPDATE waste_source_mappings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_source_mappings_source ON waste_source_mappings(source_id);
      CREATE INDEX idx_waste_source_mapping_types_type ON waste_source_mapping_types(type_id);

      -- Ein Eintrag (identity_key) traegt jetzt einen Termin je Typ: die
      -- Eindeutigkeit wandert von (source_id, identity_key) auf
      -- (source_id, identity_key, type_id). SQLite aendert keine
      -- Tabellen-Constraint, daher Umbau; ids bleiben erhalten.
      CREATE TABLE waste_imported_pickups_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id          INTEGER NOT NULL REFERENCES waste_sources(id) ON DELETE CASCADE,
        type_id            INTEGER NOT NULL REFERENCES waste_types(id),
        identity_key       TEXT    NOT NULL,
        external_uid       TEXT,
        original_summary   TEXT,
        date_key           TEXT    NOT NULL,
        tz_note            TEXT,
        created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (source_id, identity_key, type_id)
      );
      INSERT INTO waste_imported_pickups_new
        (id, source_id, type_id, identity_key, external_uid, original_summary, date_key, tz_note, created_at, updated_at)
        SELECT id, source_id, type_id, identity_key, external_uid, original_summary, date_key, tz_note, created_at, updated_at
        FROM waste_imported_pickups;
      DROP TABLE waste_imported_pickups;
      ALTER TABLE waste_imported_pickups_new RENAME TO waste_imported_pickups;
      CREATE TRIGGER trg_waste_imported_pickups_updated_at AFTER UPDATE ON waste_imported_pickups FOR EACH ROW BEGIN
        UPDATE waste_imported_pickups SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_waste_imported_pickups_source ON waste_imported_pickups(source_id);
      CREATE INDEX idx_waste_imported_pickups_type_date ON waste_imported_pickups(type_id, date_key);
      CREATE INDEX idx_waste_imported_pickups_source_date ON waste_imported_pickups(source_id, date_key);
    `,
  };
