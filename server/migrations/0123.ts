export default {
    version: 123,
    description: 'CalDAV: detach mirrored tasks and shopping items from deleted accounts (#617)',
    up: `
      -- tasks.external_account_id und shopping_items.external_account_id sind
      -- bloße INTEGER-Spalten (v45): löscht jemand ein CalDAV-Konto, nimmt
      -- CASCADE nur mit, was dem Konto selbst gehört - Kalender- und
      -- Listenauswahl und die offenen VTODO-Löschungen. Die gespiegelten
      -- Zeilen bleiben stehen, mit einer Kennung, die auf nichts mehr zeigt.
      --
      -- Das war nicht nur unsauber, sondern eine Sackgasse: beim Löschen so
      -- einer Zeile merkt queueTodoDeletion() sie in
      -- caldav_todo_pending_deletions vor - und DIE Tabelle hat den
      -- Fremdschlüssel sehr wohl. Der INSERT scheiterte, der Eintrag ließ sich
      -- lokal gar nicht mehr löschen, während die entfernte Kopie ohne Konto
      -- ohnehin unerreichbar ist.
      --
      -- Der Fremdschlüssel lässt sich in SQLite nicht nachträglich an eine
      -- bestehende Spalte hängen; das hieße beide Tabellen samt Indizes,
      -- Suchtriggern und den auf sie zeigenden Tabellen neu bauen. Diese
      -- Migration räumt darum den Bestand, und caldavSync.deleteAccount
      -- entkoppelt künftig selbst, bevor das Konto verschwindet.
      --
      -- Entkoppelt heißt lokal, nicht halb-extern: ohne Konto gibt es keine
      -- Liste, in die etwas zurückginge, keinen Inbound, der die Zeile noch
      -- anfasst, und keine UID, die noch etwas bedeutet. Was bleibt, ist eine
      -- gewöhnliche Aufgabe bzw. ein gewöhnlicher Einkaufsposten.
      UPDATE tasks
         SET external_source     = 'local',
             external_uid        = NULL,
             external_account_id = NULL,
             external_object_url = NULL,
             outbound_dirty      = 0,
             outbound_attempts   = 0
       WHERE external_account_id IS NOT NULL
         AND external_account_id NOT IN (SELECT id FROM caldav_accounts);

      UPDATE shopping_items
         SET external_source     = 'local',
             external_uid        = NULL,
             external_account_id = NULL,
             external_object_url = NULL,
             outbound_dirty      = 0,
             outbound_attempts   = 0
       WHERE external_account_id IS NOT NULL
         AND external_account_id NOT IN (SELECT id FROM caldav_accounts);
    `,
  };
