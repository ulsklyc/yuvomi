// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 68,
    description: 'Shopping items: optionale notes/url-Attribute; notes im FTS-Suchindex',
    up: `
      ALTER TABLE shopping_items ADD COLUMN notes TEXT;
      ALTER TABLE shopping_items ADD COLUMN url   TEXT;

      -- Item-Suche: title bleibt der Name, body nimmt jetzt die Notizen auf,
      -- damit Artikel auch über ihre Notiz gefunden werden. Trigger neu aufbauen
      -- (Trigger sind nicht ALTER-bar) und bestehende Item-Zeilen backfillen.
      DROP TRIGGER IF EXISTS trg_search_items_ai;
      DROP TRIGGER IF EXISTS trg_search_items_au;

      CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('item', NEW.id, COALESCE(NEW.name, ''), COALESCE(NEW.notes, ''));
      END;
      CREATE TRIGGER trg_search_items_au AFTER UPDATE ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('item', NEW.id, COALESCE(NEW.name, ''), COALESCE(NEW.notes, ''));
      END;

      DELETE FROM search_index WHERE entity = 'item';
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', id, COALESCE(name, ''), COALESCE(notes, '') FROM shopping_items;
    `,
  };
