// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 117,
    description: 'Search index: tags belong to the searchable text (#586)',
    up: `
      -- Ein Tag ist Freitext und damit Inhalt. Die Aufgabenliste filtert danach,
      -- die globale Suche fand ihn bisher nicht - dasselbe Wort führte je nach
      -- Eingabefeld zu einem Treffer oder zu keinem.
      --
      -- Die Tags liegen in eigenen Tabellen, die bestehenden Trigger hängen aber
      -- an tasks bzw. shopping_items und sehen nur die Zeile. Es braucht deshalb
      -- beides: erweiterte Trigger auf der Hauptzeile UND eigene Trigger auf den
      -- Tag-Tabellen, sonst bliebe eine reine Tag-Änderung unindiziert.
      --
      -- Alle Neuaufnahmen laufen als INSERT ... SELECT über die Haupttabelle.
      -- Das ist kein Stil, sondern der Schutz gegen das Löschen: beim Entfernen
      -- einer Aufgabe räumt CASCADE die Tag-Zeilen ab und feuert den
      -- Tag-Trigger. Ein VALUES-INSERT legte dann eine Karteileiche für eine
      -- Aufgabe an, die es nicht mehr gibt; das SELECT findet nichts und fügt
      -- folgerichtig nichts ein.

      DROP TRIGGER IF EXISTS trg_search_tasks_ai;
      DROP TRIGGER IF EXISTS trg_search_tasks_au;
      DROP TRIGGER IF EXISTS trg_search_tasks_ad;
      DROP TRIGGER IF EXISTS trg_search_items_ai;
      DROP TRIGGER IF EXISTS trg_search_items_au;
      DROP TRIGGER IF EXISTS trg_search_items_ad;

      CREATE TRIGGER trg_search_tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', t.id, COALESCE(t.title, ''),
               TRIM(COALESCE(t.description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = t.id), ''))
        FROM tasks t WHERE t.id = NEW.id;
      END;

      CREATE TRIGGER trg_search_tasks_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', t.id, COALESCE(t.title, ''),
               TRIM(COALESCE(t.description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = t.id), ''))
        FROM tasks t WHERE t.id = NEW.id;
      END;

      CREATE TRIGGER trg_search_tasks_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
      END;

      CREATE TRIGGER trg_search_task_tags_ai AFTER INSERT ON task_tags BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = NEW.task_id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', t.id, COALESCE(t.title, ''),
               TRIM(COALESCE(t.description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = t.id), ''))
        FROM tasks t WHERE t.id = NEW.task_id;
      END;

      CREATE TRIGGER trg_search_task_tags_ad AFTER DELETE ON task_tags BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.task_id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', t.id, COALESCE(t.title, ''),
               TRIM(COALESCE(t.description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = t.id), ''))
        FROM tasks t WHERE t.id = OLD.task_id;
      END;

      CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i WHERE i.id = NEW.id;
      END;

      CREATE TRIGGER trg_search_items_au AFTER UPDATE ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i WHERE i.id = NEW.id;
      END;

      CREATE TRIGGER trg_search_items_ad AFTER DELETE ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
      END;

      CREATE TRIGGER trg_search_item_tags_ai AFTER INSERT ON shopping_item_tags BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = NEW.item_id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i WHERE i.id = NEW.item_id;
      END;

      CREATE TRIGGER trg_search_item_tags_ad AFTER DELETE ON shopping_item_tags BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.item_id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i WHERE i.id = OLD.item_id;
      END;

      -- Bestand neu einlesen: die Tags der bereits gespiegelten Zeilen stehen
      -- sonst erst nach der nächsten Bearbeitung im Index.
      DELETE FROM search_index WHERE entity IN ('task', 'item');
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', id, COALESCE(title, ''),
               TRIM(COALESCE(description, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM task_tags WHERE task_id = tasks.id), ''))
        FROM tasks;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', id, COALESCE(name, ''),
               TRIM(COALESCE(notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = shopping_items.id), ''))
        FROM shopping_items;
    `,
  };
