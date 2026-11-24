// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 176,
    description: 'Notes: user-defined personal and household categories',
    // PERSOENLICHE KATEGORIEN sind Metadaten ihres Besitzers. Sie duerfen an
    // einer geteilten Notiz haengen, bleiben fuer andere Betrachter aber
    // unsichtbar. Deshalb steht der Besitzer an der Kategorie und nicht an der
    // Zuordnung. Beim Loeschen des Kontos verschwinden seine Kategorien samt
    // Zuordnungen; die geteilten Notizen bleiben bestehen.
    //
    // HAUSHALTSKATEGORIEN haben bewusst keinen Besitzer. `created_by` ist nur
    // Audit-Metadatum und steht auf SET NULL, damit eine Kategorie nicht mit
    // dem Konto ihres Erstellers verschwindet.
    //
    // ZWEI PARTIELLE UNIQUE-INDIZES bilden die beiden Namensraeume exakt ab:
    // einmal pro Haushalt, einmal pro Besitzer. `name_key` verwendet die
    // eingebaute Unicode-Normalisierung und Kleinschreibung der Laufzeit.
    up: `
      CREATE TABLE note_categories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
        name_key      TEXT    NOT NULL,
        scope         TEXT    NOT NULL CHECK(scope IN ('personal', 'household')),
        owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        CHECK(
          (scope = 'personal' AND owner_user_id IS NOT NULL)
          OR (scope = 'household' AND owner_user_id IS NULL)
        )
      );

      CREATE TABLE note_category_assignments (
        note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES note_categories(id) ON DELETE CASCADE,
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (note_id, category_id)
      );

      CREATE UNIQUE INDEX idx_note_categories_household_name
        ON note_categories(name_key)
        WHERE scope = 'household';
      CREATE UNIQUE INDEX idx_note_categories_personal_name
        ON note_categories(owner_user_id, name_key)
        WHERE scope = 'personal';
      CREATE INDEX idx_note_categories_visible
        ON note_categories(scope, owner_user_id, sort_order, name COLLATE NOCASE);
      CREATE INDEX idx_note_category_assignments_category
        ON note_category_assignments(category_id, note_id);
      CREATE TRIGGER trg_note_categories_updated_at
        AFTER UPDATE OF name, name_key, sort_order ON note_categories
      BEGIN
        UPDATE note_categories
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = NEW.id;
      END;
    `,
  };
