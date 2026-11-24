export default {
    version: 77,
    description: 'FTS-Suchindex diakritik-insensitiv neu aufbauen (unicode61 remove_diacritics 2, #471)',
    up: `
      -- „Muller" soll „Müller", „strasse" soll „Straße" finden — bei Orten/Namen
      -- (Adressen, Personen) der Normalfall. Der FTS5-Tokenizer ist nicht ALTER-bar,
      -- also die virtuelle Tabelle mit remove_diacritics neu anlegen. Die AFTER-Trigger
      -- hängen an den Quelltabellen (nicht an search_index) und bleiben bestehen —
      -- sie schreiben nach dem Neuaufbau unverändert weiter. Nur der Bestand wird
      -- index-weit neu eingelesen (Reihenfolge = Trigger-Bodies der jeweiligen Module).
      DROP TABLE IF EXISTS search_index;
      CREATE VIRTUAL TABLE search_index USING fts5(
        entity UNINDEXED,
        entity_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'task', id, COALESCE(title, ''), COALESCE(description, '') FROM tasks;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'event', id, COALESCE(title, ''),
               TRIM(COALESCE(description, '') || ' ' || COALESCE(location, '')) FROM calendar_events;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'note', id, COALESCE(title, ''), COALESCE(content, '') FROM notes;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'contact', id, COALESCE(name, ''),
               COALESCE(phone, '') || ' ' || COALESCE(email, '') FROM contacts;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', id, COALESCE(name, ''), COALESCE(notes, '') FROM shopping_items;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'medication', id, COALESCE(name, ''), COALESCE(dosage_text, '') FROM medications;
      INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'activity', id, COALESCE(type, ''), COALESCE(note, '') FROM health_activities;
    `,
  };
