// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { toE164, defaultCountryFromConfig } from '../utils/phone.js';

export default {
    version: 95,
    description: 'Add additive value_e164 column to contact_phones for format-independent CardDAV matching (libphonenumber-js)',
    up: `
      -- STRIKT ADDITIV. value bleibt die Wahrheit (roher User-String) und wird nie
      -- verändert. value_e164 ist eine reine Zusatzspalte fürs format-unabhängige
      -- Kontakt-Matching beim CardDAV-Sync (verhindert Duplikate durch Format-
      -- Varianz). Nullable: NULL heißt "nicht parsebar" → das Matching fällt auf den
      -- exakten Rohwert-Vergleich zurück. Der Backfill läuft in afterUp() (JS/E.164).
      ALTER TABLE contact_phones ADD COLUMN value_e164 TEXT;
      CREATE INDEX idx_contact_phones_e164 ON contact_phones(value_e164);
    `,
    afterUp: (db) => {
      // E.164 pro Zeile aus dem ROHWERT berechnen; value bleibt unangetastet.
      // Default-Land aus der haushaltweiten Konfiguration; fehlt es, werden nur
      // Nummern mit internationaler Vorwahl (+) normalisiert.
      const defaultCountry = defaultCountryFromConfig(db);
      const rows = db.prepare('SELECT id, value FROM contact_phones').all();
      const upd = db.prepare('UPDATE contact_phones SET value_e164 = ? WHERE id = ?');
      for (const row of rows) {
        const e164 = toE164(row.value, defaultCountry);
        if (e164) upd.run(e164, row.id); // nur wo parsebar; sonst bleibt NULL
      }
    },
  };
