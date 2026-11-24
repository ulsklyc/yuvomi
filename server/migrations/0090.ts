// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 90,
    description: 'Link imported birthdays to their source contact',
    up: `
      -- Koppelt einen importierten Geburtstag an seinen Quell-Kontakt. Der
      -- partielle Unique-Index erzwingt Idempotenz: ein Kontakt kann nur einmal
      -- als Geburtstag im Haushalt landen (GET /birthdays ist haushaltsweit, nicht
      -- pro Nutzer). ON DELETE SET NULL: wird der Kontakt gelöscht, bleibt der
      -- Geburtstag als rein lokaler Eintrag bestehen.
      ALTER TABLE birthdays ADD COLUMN contact_id INTEGER
        REFERENCES contacts(id) ON DELETE SET NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_birthdays_contact_id
        ON birthdays(contact_id) WHERE contact_id IS NOT NULL;
    `,
  };
