// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 76,
    description: 'Kalender-Events: Ort (location) zusätzlich im FTS-Suchindex (#471)',
    up: `
      -- Termin-Suche: title bleibt der Titel, body nimmt jetzt neben der
      -- Beschreibung auch den Ort auf, damit Termine bei unbekanntem Datum auch
      -- über Adresse/Ortsstichwort gefunden werden (Discussion #471). Trigger sind
      -- nicht ALTER-bar → ai/au neu aufbauen und Bestandstermine backfillen.
      -- (trg_search_events_ad bleibt unverändert: löscht nur.)
      DROP TRIGGER IF EXISTS trg_search_events_ai;
      DROP TRIGGER IF EXISTS trg_search_events_au;

      CREATE TRIGGER trg_search_events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
                COALESCE(NEW.title, ''),
                TRIM(COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.location, '')));
      END;
      CREATE TRIGGER trg_search_events_au AFTER UPDATE ON calendar_events BEGIN
        DELETE FROM search_index WHERE entity = 'event' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('event', NEW.id,
                COALESCE(NEW.title, ''),
                TRIM(COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.location, '')));
      END;

      DELETE FROM search_index WHERE entity = 'event';
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'event', id,
               COALESCE(title, ''),
               TRIM(COALESCE(description, '') || ' ' || COALESCE(location, ''))
        FROM calendar_events;
    `,
  };
