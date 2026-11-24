export default {
    version: 103,
    description: 'Calendar: tombstones for events deleted locally but still remote (#593)',
    up: `
      -- Lokales Löschen eines gespiegelten Termins muss auch beim Provider löschen
      -- (#593). Die Route kann das nicht selbst tun: der Provider-Call ist async
      -- und darf weder die 204-Antwort verzögern noch bei Netzfehlern den lokalen
      -- Löschvorgang scheitern lassen. Deshalb ein Tombstone - die Zeile überlebt
      -- das gelöschte Event und wird vom Sync abgearbeitet (at-least-once).
      --
      -- Bewusst NICHT als Trigger auf calendar_events: der Inbound-Sync löscht
      -- lokale Zeilen ebenfalls (cancelled-Events, Kalender-Abwahl). Ein Trigger
      -- würde daraus Löschbefehle an den Provider machen und fremde Termine
      -- vernichten. Tombstones entstehen nur im expliziten User-Delete.
      --
      -- source ist von Anfang an vorhanden, damit CalDAV/Apple dieselbe Tabelle
      -- nutzen können; aktuell schreibt nur 'google'.
      CREATE TABLE IF NOT EXISTS calendar_pending_deletions (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        source               TEXT NOT NULL,
        calendar_external_id TEXT NOT NULL,
        event_external_id    TEXT NOT NULL,
        attempts             INTEGER NOT NULL DEFAULT 0,
        last_error           TEXT,
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(source, calendar_external_id, event_external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cal_pending_del_event
        ON calendar_pending_deletions(source, event_external_id);
    `,
  };
