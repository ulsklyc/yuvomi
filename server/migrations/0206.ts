// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 206,
    description: 'Waste collection: index waste types in the global FTS5 search_index (#1063 Phase 10)',
    // Same trigger shape as migration 66 (medications/health_activities) and
    // 68 (shopping_items). Deliberately indexes ONLY waste_types (the finite,
    // stored catalog) - never anything waste-domain.js's expandSchedule()/
    // resolveOccurrences() computes at read time. Those occurrences are
    // unbounded (a weekly schedule has no last date until valid_until) and
    // never materialize as rows; indexing them would mean either truncating
    // the index at an arbitrary horizon or growing it forever. A concrete,
    // dated pickup (waste_one_off_pickups/waste_imported_pickups) is the one
    // other kind of stored, searchable Waste fact, but it has no independent
    // title of its own (its "title" IS the type name) and Phase 10 asks for
    // stable deep links to "types, sources, and concrete pickups" via the
    // existing occurrence list, not a second index entity - so only the type
    // catalog gets indexed here; concrete pickups are still reachable by
    // searching their type's name and confirmed present in the Upcoming list.
    up: `
      CREATE TRIGGER trg_search_waste_types_ai AFTER INSERT ON waste_types BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('waste_type', NEW.id, COALESCE(NEW.name, ''), '');
      END;
      CREATE TRIGGER trg_search_waste_types_ad AFTER DELETE ON waste_types BEGIN
        DELETE FROM search_index WHERE entity = 'waste_type' AND entity_id = OLD.id;
      END;
      CREATE TRIGGER trg_search_waste_types_au AFTER UPDATE ON waste_types BEGIN
        DELETE FROM search_index WHERE entity = 'waste_type' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('waste_type', NEW.id, COALESCE(NEW.name, ''), '');
      END;

      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'waste_type', id, COALESCE(name, ''), '' FROM waste_types;
    `,
  };
