// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 116,
    description: 'Shopping items: tags mirrored from VTODO CATEGORIES (#586)',
    up: `
      -- Einkaufsposten spiegeln dieselbe VTODO-Eigenschaft wie Aufgaben: eine
      -- CalDAV-Erinnerungsliste kann auf beide Module zeigen (#617), und bis
      -- hierher fielen die CATEGORIES eines Einkaufspostens stillschweigend weg.
      --
      -- Bewusst NICHT auf shopping_items.category abgebildet: die Kategorie ist
      -- hier der Gang im Laden, eine verwaltete Liste mit Icon und Sortierung.
      -- Fremdwerte hineinzuspülen hieße, diese Liste bei jedem Sync wachsen zu
      -- lassen - derselbe Fehler, den v115 für Aufgaben vermeidet.
      CREATE TABLE IF NOT EXISTS shopping_item_tags (
        item_id INTEGER NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
        tag     TEXT    NOT NULL,
        tag_key TEXT    NOT NULL,
        PRIMARY KEY (item_id, tag_key)
      );

      CREATE INDEX IF NOT EXISTS idx_shopping_item_tags_key ON shopping_item_tags(tag_key);
    `,
  };
