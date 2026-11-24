// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 91,
    description: 'Heal CardDAV contacts synced with escaped names, missing details, wrong category (#531)',
    up: `
      -- Bereits per CardDAV synchronisierte Kontakte (carddav_uid IS NOT NULL)
      -- heilen, die vor dem #531-Fix falsch abgelegt wurden. Nur Sync-Kontakte,
      -- damit manuell angelegte Kontakte unberührt bleiben.

      -- 1) Nicht abgebildete Kategorie 'Sonstiges' auf den stabilen Key 'misc'.
      UPDATE contacts SET category = 'misc'
        WHERE carddav_uid IS NOT NULL AND category = 'Sonstiges';

      -- 2) Literale vCard-Escapes im Namen auflösen. Backslash ist in SQLite-LIKE
      -- kein Metazeichen, daher matcht '%\\,%' die Sequenz Backslash+Komma direkt.
      UPDATE contacts
        SET name = REPLACE(REPLACE(REPLACE(name, '\\,', ','), '\\;', ';'), '\\\\', '\\')
        WHERE carddav_uid IS NOT NULL
          AND (name LIKE '%\\,%' OR name LIKE '%\\;%' OR name LIKE '%\\\\%');

      -- 3) Fehlende Legacy-Skalarfelder aus den Multi-Value-Tabellen nachfüllen,
      -- damit Liste und Bearbeiten-Dialog Telefon/E-Mail sofort zeigen (die Adresse
      -- wird beim nächsten Sync ergänzt). Nur NULL-Spalten, keine manuellen Werte.
      UPDATE contacts SET phone = (
          SELECT value FROM contact_phones
          WHERE contact_id = contacts.id ORDER BY is_primary DESC, id ASC LIMIT 1
        )
        WHERE carddav_uid IS NOT NULL AND phone IS NULL
          AND EXISTS (SELECT 1 FROM contact_phones WHERE contact_id = contacts.id);

      UPDATE contacts SET email = (
          SELECT value FROM contact_emails
          WHERE contact_id = contacts.id ORDER BY is_primary DESC, id ASC LIMIT 1
        )
        WHERE carddav_uid IS NOT NULL AND email IS NULL
          AND EXISTS (SELECT 1 FROM contact_emails WHERE contact_id = contacts.id);
    `,
  };
