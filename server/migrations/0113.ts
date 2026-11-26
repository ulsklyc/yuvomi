export default {
    version: 113,
    description: 'CalDAV VTODO: push local changes and deletions back to the server (#617)',
    up: `
      -- Der VTODO-Spiegel war einseitig: eine hier abgehakte, umbenannte oder
      -- gelöschte Aufgabe blieb auf dem CalDAV-Server unverändert stehen, und der
      -- nächste Inbound-Lauf machte die lokale Änderung wieder rückgängig. Die
      -- Rückrichtung braucht dieselben drei Dinge wie die Termine (#593):
      --
      --   Weg zum Objekt  → external_object_url
      --   Absicht merken  → outbound_dirty
      --   Aufgeben können → outbound_attempts
      --
      -- Nullable und ohne Backfill: für bereits gespiegelte Einträge ist die URL
      -- noch nicht bekannt. Der nächste Inbound-Lauf trägt sie nach, und bis dahin
      -- löst der Sync das Objekt über die UID des laufenden Abrufs auf.
      ALTER TABLE tasks ADD COLUMN external_object_url TEXT;
      ALTER TABLE tasks ADD COLUMN outbound_dirty      INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN outbound_attempts   INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE shopping_items ADD COLUMN external_object_url TEXT;
      ALTER TABLE shopping_items ADD COLUMN outbound_dirty      INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shopping_items ADD COLUMN outbound_attempts   INTEGER NOT NULL DEFAULT 0;

      -- Eigene Tombstone-Tabelle statt calendar_pending_deletions: dort ist der
      -- Schlüssel (source, calendar_external_id, event_external_id) auf Kalender
      -- und Termin zugeschnitten, während eine VTODO-Löschung ihr Konto und ihr
      -- Modul kennen muss - tasks und shopping_items sind getrennte Ziele mit
      -- eigenen UID-Räumen. Die Fehler- und Aufgeberegeln bleiben trotzdem
      -- geteilt (calendar-outbound.js: outboundFailureAction).
      --
      -- Die Zeile überlebt bewusst den gelöschten Eintrag: danach ist die Zeile
      -- weg, aus der UID und Objekt-URL sonst zu holen wären.
      CREATE TABLE IF NOT EXISTS caldav_todo_pending_deletions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        module     TEXT    NOT NULL CHECK(module IN ('tasks', 'shopping')),
        uid        TEXT    NOT NULL,
        object_url TEXT,
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(account_id, module, uid)
      );

      CREATE INDEX IF NOT EXISTS idx_caldav_todo_deletions_account
        ON caldav_todo_pending_deletions(account_id);
    `,
  };
