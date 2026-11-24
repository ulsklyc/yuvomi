// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 93,
    description: 'Attach CardDAV sync errors to the failing address book, not just the account (#534)',
    up: `
      -- Der Konto-Fehler nennt zwar das Adressbuch im Text, aber als Fließtext:
      -- die Liste kann die betroffene Zeile damit nicht markieren, und der Name
      -- im Fehler muss nicht mit dem Namen in der Liste übereinstimmen.
      -- NULL heißt "dieses Adressbuch lief zuletzt sauber durch".
      ALTER TABLE carddav_addressbook_selection ADD COLUMN last_error TEXT;
    `,
  };
