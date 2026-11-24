export default {
    version: 164,
    description: 'Document folders: a folder may live inside a folder (#785)',
    foreignKeysOff: true,
    up: `
      -- AUS ZWEI FLACHEN FILTERREIHEN WIRD EIN BAUM (#785).
      --
      -- Das Dokumentenmodul fuehrt zwei Achsen nebeneinander: category (eine
      -- feste Liste von 14 uebersetzten Schluesseln, als Spalte am Dokument)
      -- und folder_id (diese Tabelle). Beide filtern dieselbe flache Liste,
      -- und nichts in der Oberflaeche zeigt, wie sie zueinander stehen -
      -- gemeldet als "zwei getrennte UI-Zonen, die man beide kennen muss".
      --
      -- Der Vorschlag war, die Ordner UNTER die Kategorien zu haengen. Das geht
      -- nicht: die beiden Achsen sind unabhaengig. Ein Ordner "Wohnung" haelt
      -- Dokumente der Kategorien home, insurance und legal gleichzeitig; unter
      -- einer Kategorie aufgehaengt stuende er entweder dreimal da oder truege
      -- eine Zugehoerigkeit, die es nicht gibt und die beim Migrieren erfunden
      -- werden muesste.
      --
      -- Also die Hierarchie dort, wo sie hingehoert: Ordner in Ordnern. Die
      -- Kategorie bleibt, was sie ist - ein Querschnitts-Etikett am Dokument,
      -- das ueber den ganzen Baum hinweg filtert.
      --
      -- ── WARUM EIN TABELLEN-NEUBAU UND KEIN ALTER TABLE ────────────────────
      --
      -- name traegt seit Migration 60 ein globales UNIQUE. In einem Baum ist
      -- das genau die falsche Zusicherung: "Rechnungen" unter "Auto" und
      -- "Rechnungen" unter "Wohnung" sind zwei verschiedene Ordner, und ein
      -- Baum, in dem jeder Name nur einmal im ganzen Haushalt vorkommen darf,
      -- ist keiner. Ein Constraint laesst sich in SQLite nicht loesen, ohne die
      -- Tabelle neu zu bauen.
      --
      -- DIE MIGRATION KANN AN BESTANDSDATEN NICHT SCHEITERN, und das ist keine
      -- Hoffnung, sondern eine Ableitung: alle uebernommenen Zeilen bekommen
      -- parent_id NULL, also COALESCE(parent_id, 0) = 0 fuer alle. Der neue
      -- Index prueft damit exakt dieselbe Bedingung wie das alte globale
      -- UNIQUE - was vorher hineinpasste, passt weiter hinein. Der Index ist
      -- deshalb auch bewusst NICHT COLLATE NOCASE: das waere strenger als
      -- bisher und koennte an einem Bestand mit "Auto" neben "auto" brechen.
      --
      -- COALESCE UND KEIN SCHLICHTES UNIQUE(parent_id, name): SQLite behandelt
      -- NULL in einem UNIQUE als jeweils verschieden. Ein UNIQUE(parent_id,
      -- name) liesse also beliebig viele Wurzelordner desselben Namens zu -
      -- also genau auf der Ebene keine Zusicherung, auf der es sie heute gibt.
      --
      -- ── ON DELETE CASCADE, UND WARUM DAS HIER NICHTS VERLIERT ─────────────
      --
      -- Ein geloeschter Ordner nimmt seine Unterordner mit, wie in jedem
      -- Dateibrowser. Die DOKUMENTE darin bleiben: family_documents.folder_id
      -- traegt seit jeher ON DELETE SET NULL, sie landen also unter "ohne
      -- Ordner" statt im Nichts. Diese Zusicherung ist aelter als dieser Baum
      -- und bleibt seine Untergrenze - kein Loeschen in diesem Modul kann ein
      -- Dokument kosten.
      --
      -- foreignKeysOff ist Pflicht (gleicher Grund wie v137, v141, v162):
      -- family_documents.folder_id haengt an dieser Tabelle und liefe beim
      -- DROP TABLE leer.
      --
      -- module_key bleibt unangetastet. Er traegt die IDENTITAET eines
      -- Modulordners (v157), nicht seine Position - ein Modulordner darf
      -- deshalb verschoben werden, ohne dass die sechs Module ihn verlieren.
      CREATE TABLE family_document_folders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        parent_id   INTEGER REFERENCES family_document_folders_new(id) ON DELETE CASCADE,
        module_key  TEXT,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT INTO family_document_folders_new (id, name, module_key, created_by, created_at, updated_at)
        SELECT id, name, module_key, created_by, created_at, updated_at FROM family_document_folders;

      DROP TABLE family_document_folders;
      ALTER TABLE family_document_folders_new RENAME TO family_document_folders;

      CREATE UNIQUE INDEX idx_family_document_folders_sibling_name
        ON family_document_folders(COALESCE(parent_id, 0), name);

      -- Unveraendert aus v157 uebernommen: der Schluessel bleibt haushaltsweit
      -- eindeutig, egal wo im Baum der Ordner haengt.
      CREATE UNIQUE INDEX idx_family_document_folders_module_key
        ON family_document_folders(module_key) WHERE module_key IS NOT NULL;

      -- Der Lesepfad holt die Kinder eines Ordners; das ist der eine Index,
      -- den der Baum braucht.
      CREATE INDEX idx_family_document_folders_parent
        ON family_document_folders(parent_id);

      CREATE TRIGGER trg_family_document_folders_updated_at
        AFTER UPDATE ON family_document_folders FOR EACH ROW
        BEGIN UPDATE family_document_folders SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
    `,
  };
