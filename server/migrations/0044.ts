// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 44,
    description: 'FTS5 full-text search index across tasks, calendar events, notes, contacts, and shopping items',
    up: `
      CREATE VIRTUAL TABLE search_index USING fts5(
        entity UNINDEXED,
        entity_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61'
      );

      -- ---- tasks ----
      CREATE TRIGGER trg_search_tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;
      CREATE TRIGGER trg_search_tasks_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_tasks_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;

      -- ---- calendar_events ----
      CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;
      CREATE TRIGGER trg_search_events_ad AFTER DELETE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_events_au AFTER UPDATE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;

      -- ---- notes ----
      CREATE TRIGGER trg_search_notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('note', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''));
      END;
      CREATE TRIGGER trg_search_notes_ad AFTER DELETE ON notes BEGIN
        DELETE FROM search_index WHERE entity = 'note' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_notes_au AFTER UPDATE ON notes BEGIN
        DELETE FROM search_index WHERE entity = 'note' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('note', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.content, ''));
      END;

      -- ---- contacts ----
      CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('contact', NEW.id, COALESCE(NEW.name, ''),
                COALESCE(NEW.phone, '') || ' ' || COALESCE(NEW.email, ''));
      END;
      CREATE TRIGGER trg_search_contacts_ad AFTER DELETE ON contacts BEGIN
        DELETE FROM search_index WHERE entity = 'contact' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
        DELETE FROM search_index WHERE entity = 'contact' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('contact', NEW.id, COALESCE(NEW.name, ''),
                COALESCE(NEW.phone, '') || ' ' || COALESCE(NEW.email, ''));
      END;

      -- ---- shopping_items ----
      CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('item', NEW.id, COALESCE(NEW.name, ''), '');
      END;
      CREATE TRIGGER trg_search_items_ad AFTER DELETE ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_items_au AFTER UPDATE ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('item', NEW.id, COALESCE(NEW.name, ''), '');
      END;

      -- Backfill from existing rows.
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', id, COALESCE(title, ''), COALESCE(description, '') FROM tasks;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'event', id, COALESCE(title, ''), COALESCE(description, '') FROM calendar_events;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'note', id, COALESCE(title, ''), COALESCE(content, '') FROM notes;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'contact', id, COALESCE(name, ''),
               COALESCE(phone, '') || ' ' || COALESCE(email, '') FROM contacts;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', id, COALESCE(name, ''), '' FROM shopping_items;
    `,
  };
