export default {
    version: 106,
    description: 'Calendar: remember the CalDAV object URL so edits and deletes can reach the server (#593)',
    up: `
      -- CalDAV/Apple kennen keinen Aufruf "ändere Event X in Kalender Y": ein
      -- Kalenderobjekt wird über SEINE eigene URL per PUT/DELETE angefasst. Bisher
      -- verwarf der Inbound diese URL (obj.url) und der Outbound-Push speicherte
      -- sie nicht, weshalb dort ausgehend nur Anlegen möglich war.
      --
      -- Nullable und ohne Backfill: für Bestandstermine ist die URL schlicht noch
      -- nicht bekannt. Der Sync füllt sie beim nächsten Inbound-Lauf nach, und bis
      -- dahin löst die Löschung die URL über die UID des laufenden Fetches auf -
      -- ein Backfill bräuchte ohnehin genau denselben Netzabruf.
      ALTER TABLE calendar_events ADD COLUMN external_object_url TEXT;

      -- Die Objekt-URL wandert in den Tombstone mit: nach dem lokalen Löschen ist
      -- die Zeile weg, aus der sie sonst zu holen wäre.
      ALTER TABLE calendar_pending_deletions ADD COLUMN object_url TEXT;
    `,
  };
