export default {
    version: 133,
    description: 'Shopping: manual item order within a category (#678)',
    up: `
      -- Die Artikelreihenfolge war bisher die Eingabereihenfolge: die Liste
      -- sortierte nach Kategorie, dann created_at. Wer seine Liste nach dem
      -- Ladenlayout ordnen will, konnte bisher nur die KATEGORIEN umsortieren
      -- (shopping_categories.sort_order) - innerhalb einer Kategorie gab es
      -- keinen Griff. Diese Spalte ist dieser Griff.
      ALTER TABLE shopping_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

      -- Bestand durchnummerieren, damit die heute sichtbare Reihenfolge exakt
      -- erhalten bleibt. Ab 1, weil 0 dem Trigger unten als Marke "noch nicht
      -- eingeordnet" dient.
      UPDATE shopping_items SET sort_order = (
        SELECT COUNT(*) + 1 FROM shopping_items AS prev
         WHERE prev.list_id  = shopping_items.list_id
           AND prev.category = shopping_items.category
           AND (prev.created_at < shopping_items.created_at
                OR (prev.created_at = shopping_items.created_at AND prev.id < shopping_items.id))
      );

      -- Neue Artikel ans Ende ihrer Kategorie. Bewusst als Trigger und nicht in
      -- den Insert-Aufrufen: es gibt NEUN Einfügewege (shopping, meals, recipes,
      -- housekeeping, mcp/tools, caldav-reminders-sync). Als Regel an der Tabelle
      -- gilt sie auch für den zehnten, der sie sonst vergessen hätte; ein Artikel
      -- mit sort_order 0 wäre sonst still nach oben gesprungen.
      CREATE TRIGGER IF NOT EXISTS trg_shopping_items_sort_order
        AFTER INSERT ON shopping_items FOR EACH ROW WHEN NEW.sort_order = 0
        BEGIN
          UPDATE shopping_items SET sort_order = COALESCE((
            SELECT MAX(sort_order) FROM shopping_items
             WHERE list_id = NEW.list_id AND category = NEW.category AND id != NEW.id
          ), 0) + 1 WHERE id = NEW.id;
        END;

      CREATE INDEX IF NOT EXISTS idx_shopping_items_sort
        ON shopping_items(list_id, category, sort_order);
    `,
  };
