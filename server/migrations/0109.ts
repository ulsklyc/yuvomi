// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 109,
    description: 'Pantry: keep household stock when the member who entered it is deleted (#596 follow-up)',
    up: `
      -- v108 gab pantry_items.created_by ein ON DELETE CASCADE - übernommen aus
      -- den Modulen, in denen ein Eintrag WIRKLICH seinem Ersteller gehört
      -- (Rezepte, Notizen). Der Vorrat ist aber ausdrücklich Haushaltsbesitz:
      -- server/routes/pantry.js kennt bewusst kein Eigentümer-Gate, weil jeder
      -- die Milch ausbuchen darf, egal wer sie eingetragen hat.
      --
      -- Mit CASCADE hätte das Löschen eines Mitglieds jeden von ihm erfassten
      -- Artikel mitgerissen und damit den Bestand des ganzen Haushalts
      -- vernichtet. created_by wird zum reinen Herkunftsnachweis: nullable und
      -- ON DELETE SET NULL.
      --
      -- SQLite kann eine FK nicht ändern, deshalb der kanonische Zwölf-Schritte-
      -- Rebuild (Tabelle neu, Daten kopieren, tauschen). Indizes und Trigger
      -- hängen an der alten Tabelle und werden danach neu angelegt.
      CREATE TABLE pantry_items_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        quantity     REAL    NOT NULL DEFAULT 1,
        unit         TEXT    NOT NULL DEFAULT 'pcs',
        location_id  INTEGER REFERENCES pantry_locations(id) ON DELETE SET NULL,
        category     TEXT    NOT NULL DEFAULT 'Sonstiges',
        expires_on   TEXT,
        min_quantity REAL,
        notes        TEXT,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO pantry_items_new
        (id, name, quantity, unit, location_id, category, expires_on, min_quantity, notes, created_by, created_at, updated_at)
        SELECT id, name, quantity, unit, location_id, category, expires_on, min_quantity, notes, created_by, created_at, updated_at
        FROM pantry_items;

      DROP TABLE pantry_items;
      ALTER TABLE pantry_items_new RENAME TO pantry_items;

      CREATE INDEX IF NOT EXISTS idx_pantry_items_expires  ON pantry_items(expires_on);
      CREATE INDEX IF NOT EXISTS idx_pantry_items_location ON pantry_items(location_id);
      CREATE INDEX IF NOT EXISTS idx_pantry_items_name     ON pantry_items(name);

      CREATE TRIGGER IF NOT EXISTS trg_pantry_items_updated_at
        AFTER UPDATE ON pantry_items FOR EACH ROW
        BEGIN UPDATE pantry_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
