export default {
    version: 66,
    description: 'index medications and health activities in the FTS5 search_index (visibility scoping applied at query time)',
    up: `
      -- ---- medications ----
      CREATE TRIGGER trg_search_meds_ai AFTER INSERT ON medications BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('medication', NEW.id, COALESCE(NEW.name, ''), COALESCE(NEW.dosage_text, ''));
      END;
      CREATE TRIGGER trg_search_meds_ad AFTER DELETE ON medications BEGIN
        DELETE FROM search_index WHERE entity = 'medication' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_meds_au AFTER UPDATE ON medications BEGIN
        DELETE FROM search_index WHERE entity = 'medication' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('medication', NEW.id, COALESCE(NEW.name, ''), COALESCE(NEW.dosage_text, ''));
      END;

      -- ---- health_activities ----
      CREATE TRIGGER trg_search_activities_ai AFTER INSERT ON health_activities BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('activity', NEW.id, COALESCE(NEW.type, ''), COALESCE(NEW.note, ''));
      END;
      CREATE TRIGGER trg_search_activities_ad AFTER DELETE ON health_activities BEGIN
        DELETE FROM search_index WHERE entity = 'activity' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_activities_au AFTER UPDATE ON health_activities BEGIN
        DELETE FROM search_index WHERE entity = 'activity' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('activity', NEW.id, COALESCE(NEW.type, ''), COALESCE(NEW.note, ''));
      END;

      -- Backfill from existing rows.
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'medication', id, COALESCE(name, ''), COALESCE(dosage_text, '') FROM medications;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'activity', id, COALESCE(type, ''), COALESCE(note, '') FROM health_activities;
    `,
  };
