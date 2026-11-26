export default {
    version: 196,
    description: 'change counter per shopping list, fed by triggers, for live updates',
    up: `
      -- WER GEAENDERT HAT, IST EGAL - DASS SICH ETWAS GEAENDERT HAT, ZAEHLT.
      --
      -- Eine Laufnummer je Liste, die bei jeder Aenderung an der Liste oder
      -- ihren Artikeln steigt. GET /shopping/versions liest nur diese Tabelle;
      -- ein offener Einkaufszettel fragt sie im Takt und laedt eine Liste nach,
      -- deren Nummer sich bewegt hat. Zwei Leute im selben Laden sahen bis
      -- dahin zwei verschiedene Listen, bis einer die Seite neu lud.
      --
      -- ALS TRIGGER, NICHT ALS AUFRUF IN DEN ROUTEN: shopping_items wird aus
      -- sechs Modulen beschrieben (Einkauf, Essensplan, Rezepte, Haushaltshilfe,
      -- MCP, CalDAV-Sync). Ein Vermerk an jeder Schreibstelle waere sechs
      -- Gelegenheiten, ihn zu vergessen, und die siebte Stelle vergaesse ihn
      -- sicher. Hier steht die Regel einmal, und wer immer schreibt, loest sie
      -- aus (docs/DECISIONS.md, Eintrag 2).
      CREATE TABLE shopping_list_changes (
        list_id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0
      );
      -- JEDE LISTE HAT VON ANFANG AN EINE ZEILE. Der Client merkt sich die
      -- Nummer, die er zuerst sieht, als Ausgangsstand - eine Liste ohne Zeile
      -- taucht erst mit ihrer ersten Aenderung auf, und genau die ginge dann
      -- als "Ausgangsstand" verloren. Bestand hier, Neuanlage per Trigger.
      INSERT INTO shopping_list_changes (list_id, version) SELECT id, 0 FROM shopping_lists;
      CREATE TRIGGER trg_shopping_lists_change_ai AFTER INSERT ON shopping_lists BEGIN
        INSERT OR IGNORE INTO shopping_list_changes (list_id, version) VALUES (NEW.id, 0);
      END;
      -- Umbenennen ist eine Aenderung, die die anderen Geraete sehen sollen.
      CREATE TRIGGER trg_shopping_lists_change_au AFTER UPDATE ON shopping_lists BEGIN
        INSERT INTO shopping_list_changes (list_id, version) VALUES (NEW.id, 1)
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER trg_shopping_items_change_ai AFTER INSERT ON shopping_items BEGIN
        INSERT INTO shopping_list_changes (list_id, version) VALUES (NEW.list_id, 1)
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      -- NUR EINE AENDERUNG, DIE DER ZETTEL ZEIGT, ZAEHLT. Ein UPDATE ohne
      -- WHEN bewegte die Nummer auch fuer die Buchhaltung: fuer outbound_dirty
      -- (der CalDAV-Push setzt es nach dem eigenen Haken auf 1 und nach dem
      -- Versand auf 0 - zwei Schritte, die keine Quittung deckt, und der
      -- eigene Haken kostete auf einer gespiegelten Liste doch ein Nachladen),
      -- fuer updated_at (trg_shopping_items_updated_at schreibt es in einem
      -- zweiten UPDATE - jede Aenderung zaehlte doppelt) und fuer den
      -- Inbound-Sync, der jede gespiegelte Zeile bei jedem Lauf unveraendert
      -- neu schreibt. IS NOT statt <>, damit NULL gegen NULL gleich ist.
      -- Die Liste nennt genau die Spalten, die der Zettel zeigt; eine neue
      -- Spalte, die er zeigen soll, braucht eine Migration mit dem Trigger.
      CREATE TRIGGER trg_shopping_items_change_au AFTER UPDATE ON shopping_items
        WHEN NEW.list_id IS NOT OLD.list_id OR NEW.name IS NOT OLD.name
          OR NEW.quantity IS NOT OLD.quantity OR NEW.category IS NOT OLD.category
          OR NEW.is_checked IS NOT OLD.is_checked OR NEW.notes IS NOT OLD.notes
          OR NEW.url IS NOT OLD.url OR NEW.sort_order IS NOT OLD.sort_order
          OR NEW.price_cents IS NOT OLD.price_cents OR NEW.store_id IS NOT OLD.store_id
        BEGIN
        INSERT INTO shopping_list_changes (list_id, version) VALUES (NEW.list_id, 1)
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      -- Ein Artikel, der die Liste wechselt (der CalDAV-Sync schreibt list_id
      -- um, wenn die Zielliste einer Auswahl wechselt), ist auch fuer die
      -- Liste eine Aenderung, die er VERLAESST.
      CREATE TRIGGER trg_shopping_items_change_au_moved AFTER UPDATE OF list_id ON shopping_items
        WHEN OLD.list_id <> NEW.list_id BEGIN
        INSERT INTO shopping_list_changes (list_id, version) VALUES (OLD.list_id, 1)
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER trg_shopping_items_change_ad AFTER DELETE ON shopping_items BEGIN
        INSERT INTO shopping_list_changes (list_id, version) VALUES (OLD.list_id, 1)
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      -- AUCH DIE TAGS EINES ARTIKELS ZAEHLEN. Der Client vergleicht sie beim
      -- Nachladen (liveRefreshPlan), und ihr einziger Schreiber heute - der
      -- CalDAV-To-do-Sync ueber setItemTags() - schreibt zwar gleich nach einem
      -- UPDATE desselben Artikels, aber ein Trigger jetzt kostet weniger als
      -- eine Migration spaeter, wenn der zweite Schreiber kommt. Die Tabelle
      -- traegt keine list_id; die kommt vom Artikel. Faellt der Artikel selbst
      -- (Kaskade), ist seine Zeile schon weg, das SELECT liefert nichts, und
      -- die Loeschung zaehlt nur einmal - ueber den Trigger des Artikels.
      -- Das WHERE im SELECT ist Pflicht: ohne eines liest SQLite das ON
      -- CONFLICT als Teil des SELECT (Parser-Mehrdeutigkeit der Upsert-Syntax).
      CREATE TRIGGER trg_shopping_item_tags_change_ai AFTER INSERT ON shopping_item_tags BEGIN
        INSERT INTO shopping_list_changes (list_id, version)
          SELECT list_id, 1 FROM shopping_items WHERE id = NEW.item_id
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      CREATE TRIGGER trg_shopping_item_tags_change_ad AFTER DELETE ON shopping_item_tags BEGIN
        INSERT INTO shopping_list_changes (list_id, version)
          SELECT list_id, 1 FROM shopping_items WHERE id = OLD.item_id
          ON CONFLICT(list_id) DO UPDATE SET version = version + 1;
      END;
      -- KEIN FREMDSCHLUESSEL auf shopping_lists: der Loesch-Trigger der Artikel
      -- feuert waehrend der Kaskade einer Listenloeschung, und ein Fremdschluessel
      -- liesse genau dieses Einfuegen scheitern. Aufgeraeumt wird stattdessen
      -- hinter der Liste her - und dass die Zeile fehlt, ist fuer den Client
      -- die Nachricht, dass die Liste weg ist.
      CREATE TRIGGER trg_shopping_lists_change_ad AFTER DELETE ON shopping_lists BEGIN
        DELETE FROM shopping_list_changes WHERE list_id = OLD.id;
      END;
    `,
  };
