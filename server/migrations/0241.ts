// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 241,
    description: 'CalDAV: an upload is noted before it is sent, so a lost answer leaves a trace (#1882)',
    // EIN UPLOAD, DESSEN ANTWORT VERLOREN GING, HINTERLIESS NICHTS. Der PUT kam
    // an, das Objekt liegt auf dem Server, und lokal stand nur eine Zeile wie
    // jede andere, die noch nie hinaufging. Wartet sie weiter auf denselben
    // Platz, uebernimmt der naechste Lauf das Objekt (#1837). Wird sie aber
    // vorher geloescht oder bekommt sie ein anderes Ziel, wusste niemand mehr,
    // dass dort etwas von ihr liegt: der naechste Abruf holte den geloeschten
    // Eintrag als neue Zeile zurueck bzw. legte neben die bestehende eine
    // zweite.
    //
    // Die UID des Objekts allein darf das nicht entscheiden. Sie kommt vom
    // Server, und wer dort schreiben darf, kann eine im Muster dieser
    // Installation bauen (`server/utils/own-uid.js`); nach dem Einspielen
    // eines aelteren Backups traegt ausserdem eine NEUE Zeile die Id einer
    // frueheren, deren Objekt noch oben liegt. Geloescht wird ein Objekt
    // deshalb nur, wenn der LOKALE Stand belegt, dass genau diese Zeile an
    // genau diesen Platz hinaufgeschickt wurde.
    //
    // Dieser Beleg ist die Zeile hier: geschrieben VOR der Anfrage, entfernt,
    // sobald ihr Ergebnis gebucht ist. Bleibt sie stehen, ist die Antwort nie
    // angekommen. Sie ueberlebt die Zeile, von der sie handelt (kein
    // Fremdschluessel auf calendar_events/tasks/shopping_items: drei Tabellen,
    // und der Fall ist gerade der, in dem die Zeile fort ist); ihr Konto
    // ueberlebt sie nicht - ohne Konto gibt es keinen Weg zum Objekt.
    //
    // `account_id` ist NULL fuer iCloud (eine Verbindung, kein Konto). Der
    // Schluessel nennt den Platz: eine Zeile kann nacheinander an mehrere
    // Plaetze geschickt worden sein, ohne dass eine Antwort ankam.
    up: `
      CREATE TABLE IF NOT EXISTS caldav_upload_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        source         TEXT    NOT NULL CHECK (source IN ('caldav', 'apple')),
        account_id     INTEGER REFERENCES caldav_accounts(id) ON DELETE CASCADE,
        kind           TEXT    NOT NULL CHECK (kind IN ('event', 'task', 'item')),
        row_id         INTEGER NOT NULL,
        collection_url TEXT    NOT NULL,
        uid            TEXT    NOT NULL,
        object_url     TEXT    NOT NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_caldav_upload_attempts_place
        ON caldav_upload_attempts(source, COALESCE(account_id, 0), kind, row_id, collection_url);
      CREATE INDEX IF NOT EXISTS idx_caldav_upload_attempts_uid
        ON caldav_upload_attempts(uid);
    `,
  };
