// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 151,
    description: 'search index: drop duplicate shopping item rows and make their insert trigger idempotent',
    up: `
      -- JEDER NEU ANGELEGTE EINKAUFSARTIKEL STAND ZWEIMAL IM VOLLTEXT-INDEX.
      --
      -- Zwei AFTER-INSERT-Trigger auf shopping_items, und SQLite sichert die
      -- Reihenfolge zweier Trigger desselben Typs nicht zu. Die tatsaechliche
      -- war:
      --   1. trg_shopping_items_sort_order (Migration 133) macht ein UPDATE auf
      --      dieselbe Zeile, sobald sort_order beim Einfuegen 0 ist - das ist
      --      der Normalfall, denn keiner der neun Einfuegewege setzt sie.
      --   2. Dieses UPDATE loest trg_search_items_au aus. Der loescht (noch
      --      nichts) und schreibt eine Index-Zeile.
      --   3. Erst DANACH laeuft trg_search_items_ai und schreibt eine zweite.
      --
      -- WARUM ES NIE JEMAND GEMERKT HAT: es heilte sich beim ersten Anfassen
      -- selbst, denn trg_search_items_au loescht ueber (entity, entity_id) und
      -- erwischt damit beide Zeilen. Abhaken genuegte. Doppelt waren also genau
      -- die frisch angelegten, unberuehrten Artikel - und das sind die, nach
      -- denen jemand sucht. runSearch deckelt bei fuenf Treffern je Art, also
      -- kamen von fuenf angelegten Artikeln zweieinhalb an.
      --
      -- DER FIX SITZT AM INSERT-TRIGGER UND NICHT AM SORT-ORDER-TRIGGER, obwohl
      -- der das UPDATE ausloest: eine Reihenfolge, die SQLite nicht zusichert,
      -- laesst sich nicht reparieren, indem man sie anders herum annimmt. Mit
      -- DELETE vor INSERT ist der Trigger idempotent und stimmt in BEIDER
      -- Richtung - und er bleibt richtig, wenn morgen ein dritter
      -- AFTER-INSERT-Trigger dazukommt. Es ist derselbe Griff, den der
      -- _au-Trigger nebenan schon macht.
      DROP TRIGGER IF EXISTS trg_search_items_ai;
      CREATE TRIGGER trg_search_items_ai AFTER INSERT ON shopping_items BEGIN
        DELETE FROM search_index WHERE entity = 'item' AND entity_id = NEW.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        SELECT 'item', i.id, COALESCE(i.name, ''),
               TRIM(COALESCE(i.notes, '') || ' ' ||
                    COALESCE((SELECT group_concat(tag, ' ') FROM shopping_item_tags WHERE item_id = i.id), ''))
        FROM shopping_items i WHERE i.id = NEW.id;
      END;

      -- Bestandsdaten: die schon geschriebenen Dubletten wegraeumen.
      --
      -- Ueber die rowid und NICHT ueber einen Neuaufbau des item-Anteils, wie
      -- ihn Migration 77 fuer den ganzen Index gemacht hat. Ein Neuaufbau
      -- muesste die Trigger-Logik ein zweites Mal hinschreiben (inklusive der
      -- Tags im body), und eine Abweichung zwischen beiden Fassungen waere ein
      -- stiller Verlust im Index - hier faellt nur weg, was doppelt ist.
      --
      -- Welche der beiden Zeilen bleibt, ist gleichgueltig: beide Trigger lesen
      -- dieselbe Zeile im selben Zustand und schreiben denselben Inhalt.
      --
      -- Ohne Einschraenkung auf 'item', weil (entity, entity_id) im ganzen
      -- Index eindeutig sein MUSS - genau davon geht jeder _au-Trigger aus,
      -- wenn er vor dem Neuschreiben ueber diese beiden Spalten loescht. Was
      -- sonst noch doppelt liegt, ist derselbe Fehler und geht mit.
      DELETE FROM search_index WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM search_index GROUP BY entity, entity_id
      );
    `,
  };
