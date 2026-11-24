export default {
    version: 194,
    description: 'Calendar: linked overrides for local recurring occurrences (#975)',
    up: `
      ALTER TABLE calendar_events ADD COLUMN recurrence_parent_id INTEGER
        REFERENCES calendar_events(id) ON DELETE CASCADE;
      ALTER TABLE calendar_events ADD COLUMN recurrence_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN overridden_fields TEXT;
      CREATE UNIQUE INDEX idx_calendar_occurrence_override_slot
        ON calendar_events(recurrence_parent_id, recurrence_id)
        WHERE recurrence_parent_id IS NOT NULL;
      CREATE INDEX idx_calendar_occurrence_override_range
        ON calendar_events(recurrence_parent_id, start_datetime)
        WHERE recurrence_parent_id IS NOT NULL;

      -- A child inherits text it did not override, so indexing its stored copy
      -- would duplicate the master for ordinary searches and consume LIMIT.
      DROP TRIGGER IF EXISTS trg_search_events_ai;
      DROP TRIGGER IF EXISTS trg_search_events_au;
      DROP TRIGGER IF EXISTS trg_search_events_ad;
      CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
          CASE WHEN NEW.recurrence_parent_id IS NULL
                 OR EXISTS (SELECT 1 FROM json_each(
                      CASE WHEN json_valid(NEW.overridden_fields) THEN
                        CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                      END) WHERE type = 'text' AND value = 'title')
               THEN COALESCE(NEW.title, '') ELSE '' END,
          TRIM(
            CASE WHEN NEW.recurrence_parent_id IS NULL
                    OR EXISTS (SELECT 1 FROM json_each(
                         CASE WHEN json_valid(NEW.overridden_fields) THEN
                           CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                         END) WHERE type = 'text' AND value = 'description')
                 THEN COALESCE(NEW.description, '') ELSE '' END
            || ' ' ||
            CASE WHEN NEW.recurrence_parent_id IS NULL
                    OR EXISTS (SELECT 1 FROM json_each(
                         CASE WHEN json_valid(NEW.overridden_fields) THEN
                           CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                         END) WHERE type = 'text' AND value = 'location')
                 THEN COALESCE(NEW.location, '') ELSE '' END));
      END;
      CREATE TRIGGER trg_search_events_au AFTER UPDATE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
          CASE WHEN NEW.recurrence_parent_id IS NULL
                 OR EXISTS (SELECT 1 FROM json_each(
                      CASE WHEN json_valid(NEW.overridden_fields) THEN
                        CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                      END) WHERE type = 'text' AND value = 'title')
               THEN COALESCE(NEW.title, '') ELSE '' END,
          TRIM(
            CASE WHEN NEW.recurrence_parent_id IS NULL
                    OR EXISTS (SELECT 1 FROM json_each(
                         CASE WHEN json_valid(NEW.overridden_fields) THEN
                           CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                         END) WHERE type = 'text' AND value = 'description')
                 THEN COALESCE(NEW.description, '') ELSE '' END
            || ' ' ||
            CASE WHEN NEW.recurrence_parent_id IS NULL
                    OR EXISTS (SELECT 1 FROM json_each(
                         CASE WHEN json_valid(NEW.overridden_fields) THEN
                           CASE WHEN json_type(NEW.overridden_fields) = 'array' THEN NEW.overridden_fields END
                         END) WHERE type = 'text' AND value = 'location')
                 THEN COALESCE(NEW.location, '') ELSE '' END));
      END;
      CREATE TRIGGER trg_search_events_ad AFTER DELETE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
      END;
      DELETE FROM search_index WHERE entity = 'event';
      INSERT INTO search_index (entity, entity_id, title, body)
      SELECT 'event', id,
        CASE WHEN recurrence_parent_id IS NULL
               OR EXISTS (SELECT 1 FROM json_each(
                    CASE WHEN json_valid(overridden_fields) THEN
                      CASE WHEN json_type(overridden_fields) = 'array' THEN overridden_fields END
                    END) WHERE type = 'text' AND value = 'title')
             THEN COALESCE(title, '') ELSE '' END,
        TRIM(
          CASE WHEN recurrence_parent_id IS NULL
                  OR EXISTS (SELECT 1 FROM json_each(
                       CASE WHEN json_valid(overridden_fields) THEN
                         CASE WHEN json_type(overridden_fields) = 'array' THEN overridden_fields END
                       END) WHERE type = 'text' AND value = 'description')
               THEN COALESCE(description, '') ELSE '' END
          || ' ' ||
          CASE WHEN recurrence_parent_id IS NULL
                  OR EXISTS (SELECT 1 FROM json_each(
                       CASE WHEN json_valid(overridden_fields) THEN
                         CASE WHEN json_type(overridden_fields) = 'array' THEN overridden_fields END
                       END) WHERE type = 'text' AND value = 'location')
               THEN COALESCE(location, '') ELSE '' END)
      FROM calendar_events;    `,
  };
