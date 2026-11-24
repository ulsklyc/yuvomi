// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 142,
    description: 'Inventory: add optional photo per item',
    up: `
      -- Ein Foto je Gegenstand, kein Galerie-Bedarf (Mockup-Vergleich, Design-
      -- Doc §2) - gleiches Speichermuster wie birthdays.photo_data: Data-URL,
      -- serverseitig validiert (server/routes/inventory/items.js), keine
      -- eigene Tabelle noetig fuer ein einzelnes optionales Feld.
      ALTER TABLE inventory_items ADD COLUMN photo_data TEXT;
    `,
  };
