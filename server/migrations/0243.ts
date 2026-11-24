// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 243,
    description: 'Shopping: a mirrored item waits to be carried to the list it was moved to',
    // Ein gespiegelter Artikel, der auf eine andere gespiegelte Liste umzieht
    // (#1700), nimmt sein Objekt auf dem CalDAV-Server mit. `outbound_move = 1`
    // heisst: die Zeile steht schon auf der neuen Liste, ihr Objekt liegt noch
    // in der Collection der alten (`external_object_url`) und soll in die
    // Collection, die der Liste zugeordnet ist, in der die Zeile JETZT steht.
    // Das Ziel steht deshalb nicht hier - es folgt aus `list_id`. Solange die
    // Vormerkung steht, ordnet der Abruf die Zeile nicht nach dem Server um.
    // `outbound_move_attempts` zaehlt die Absagen des Ziels; nach der fuenften
    // faellt die Vormerkung, und die Zeile steht wieder auf der Liste ihres
    // Objekts. Ein eigener Zaehler, weil `outbound_attempts` der Bearbeitung
    // gehoert und mit ihr zurueckgesetzt wird.
    up(db) {
      const has = (column) => db.prepare('PRAGMA table_info(shopping_items)').all().some((c) => c.name === column);
      if (!has('outbound_move')) {
        db.exec('ALTER TABLE shopping_items ADD COLUMN outbound_move INTEGER NOT NULL DEFAULT 0');
      }
      if (!has('outbound_move_attempts')) {
        db.exec('ALTER TABLE shopping_items ADD COLUMN outbound_move_attempts INTEGER NOT NULL DEFAULT 0');
      }
    },
  };
