// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 92,
    description: 'Surface CardDAV sync errors in the UI instead of only the server log (#534)',
    up: `
      -- Bisher landete ein fehlgeschlagener Adressbuch-Abruf ausschließlich im
      -- Server-Log ("501 Not Implemented" in #534). Das UI meldete weiterhin
      -- "zuletzt synchronisiert", während die Hälfte der Kontakte fehlte.
      -- Beide Spalten sind nullable: NULL heißt "letzter Lauf war sauber".
      ALTER TABLE carddav_accounts ADD COLUMN last_error TEXT;
      ALTER TABLE carddav_accounts ADD COLUMN last_error_at TEXT;
    `,
  };
