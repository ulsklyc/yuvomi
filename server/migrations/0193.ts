export default {
    version: 193,
    description: 'price and shop on a shopping item, managed shop list',
    up: `
      -- WAS HAT ES GEKOSTET, UND WO (#1003, erster Schnitt).
      --
      -- Ein Preis ist eine Tatsache ueber einen EINKAUF: einmal bezahlt, in
      -- einem Laden, an einem Tag - und danach fuer immer wahr. Niemand muss
      -- ihn pflegen, damit er richtig bleibt, und ein alter Preis ist ein
      -- brauchbarer alter Preis. Genau diese Probe besteht ein Naehrwert oder
      -- eine Packungsgroesse nicht, und deshalb steht hier kein Produktkatalog
      -- (#714).
      --
      -- DER LADEN ALS TABELLE, NICHT ALS FREITEXT. Ein Haushalt besucht wenige
      -- genug Laeden, dass Pflegen billig ist; Freitext ist ab der ersten Woche
      -- unordentlich (REWE, Rewe, rewe City sind dann drei Laeden).
      CREATE TABLE shopping_stores (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (name)
      );

      -- Der Preis in CENT als ganze Zahl, nicht als Gleitkomma: Geld in einem
      -- REAL zu fuehren summiert sich sichtbar falsch, und die Historie, die
      -- spaeter darauf aufbaut, addiert genau solche Zahlen.
      --
      -- KEIN FREMDSCHLUESSEL-CASCADE auf den Laden, sondern SET NULL: ein
      -- geloeschter Laden darf den bezahlten Preis nicht mitnehmen. Was einmal
      -- bezahlt wurde, bleibt wahr, auch wenn der Laden aus der Liste
      -- verschwindet.
      ALTER TABLE shopping_items ADD COLUMN price_cents INTEGER;
      ALTER TABLE shopping_items ADD COLUMN store_id INTEGER REFERENCES shopping_stores(id) ON DELETE SET NULL;
      CREATE INDEX idx_shopping_items_store ON shopping_items(store_id);
    `,
  };
