// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 239,
    description: 'Calendar: the search index update trigger fires only on the indexed columns (#1860)',
    // DER SUCH-TRIGGER FEUERTE BEI JEDEM UPDATE AN calendar_events. Sein Rumpf
    // loescht und schreibt die FTS-Zeile des Termins neu - teuer. Bei einem
    // UPDATE ueber viele Zeilen, das die durchsuchten Felder gar nicht anfasst
    // (das SET NULL beim Loeschen eines CalDAV-Kontos, #1860), lief das je
    // Zeile mit und machte das Loeschen eines Kontos mit vielen Terminen
    // sekundenlang.
    //
    // `AFTER UPDATE OF <spalten>`: die Spalten sind GENAU die, die der Rumpf
    // von trg_search_events_ai/au liest (NEW.title, NEW.description,
    // NEW.location, NEW.recurrence_parent_id, NEW.overridden_fields) - eine
    // Aenderung an irgendeiner anderen Spalte kann die FTS-Zeile nicht
    // veraendern. Nur trg_search_events_au wird neu angelegt; sein Rumpf bleibt
    // WORTGLEICH. Die Insert- und Delete-Trigger (ai, ad) und die uebrigen
    // (updated_at, reminders) bleiben unberuehrt. au war schon bisher der
    // juengste AFTER-UPDATE-Trigger (v194, juenger als updated_at aus v106);
    // neu angelegt bleibt er der juengste, die Feuerreihenfolge aendert sich
    // nicht.
    up: `
      DROP TRIGGER IF EXISTS trg_search_events_au;
      CREATE TRIGGER trg_search_events_au
        AFTER UPDATE OF title, description, location, recurrence_parent_id, overridden_fields
        ON calendar_events BEGIN
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
    `,
  };
