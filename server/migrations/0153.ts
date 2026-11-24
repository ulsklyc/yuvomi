export default {
    version: 153,
    description: 'idempotency keys for retry-safe POST requests on the public api',
    up: `
      -- RETRY-SICHERES ANLEGEN UEBER DIE OEFFENTLICHE API (#822).
      --
      -- Das Problem ist aelter als jeder Endpoint: ein Client schickt POST,
      -- die Antwort geht auf dem Weg verloren, und er kann danach nicht mehr
      -- unterscheiden, ob angelegt wurde oder nicht. Wiederholt er, hat er
      -- womoeglich zwei Aufgaben; wiederholt er nicht, womoeglich keine. Ohne
      -- serverseitiges Gedaechtnis ist das nicht aufloesbar - deshalb steht es
      -- hier und nicht im Prozessspeicher: es muss einen Neustart ueberleben,
      -- sonst ist die Zusage genau dann wertlos, wenn sie zaehlt.
      --
      -- DER SCHLUESSEL GEHOERT DEM AKTEUR, nicht dem Pfad: derselbe
      -- Schluesselwert von zwei Konten sind zwei Vorgaenge, und ein Konto, das
      -- einen Schluessel fuer zwei verschiedene Anfragen benutzt, hat einen
      -- Fehler - den soll es als Konflikt zu sehen bekommen, nicht als still
      -- zurueckgespielte fremde Antwort. Deshalb UNIQUE ueber (user_id, key)
      -- und nicht ueber (user_id, key, path).
      --
      -- request_hash ist der Fingerabdruck aus Methode, Pfad und Rumpf. Er
      -- entscheidet ueber Wiedergabe oder Konflikt.
      --
      -- status NULL heisst LAEUFT NOCH: der Datensatz entsteht, bevor die
      -- Route arbeitet, damit ein gleichzeitiger zweiter Versuch sich am
      -- eindeutigen Index stoesst statt danebenzulaufen.
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL,
        key           TEXT    NOT NULL,
        method        TEXT    NOT NULL,
        path          TEXT    NOT NULL,
        request_hash  TEXT    NOT NULL,
        status        INTEGER,
        response_body TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_actor
        ON idempotency_keys(user_id, key);

      -- Abgelaufenes wird beim naechsten Schluessel-Request weggeraeumt; der
      -- Index haelt dieses Aufraeumen billig, damit es keinen Cron braucht.
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
        ON idempotency_keys(created_at);
    `,
  };
