// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 273,
    description: 'ICS subscriptions: feed values kept for reset (D#2330), ETag cleared for backfill',
    // Der Feed-Stand eines ICS-Termins (Titel, Beschreibung, Start, Ende, Ganztag,
    // Ort, Farbe) als JSON. Jeder Sync schreibt ihn, auch an lokal geaenderte
    // Termine, deren Felder der Sync nicht anfasst. Der Reset stellt daraus sofort
    // und ohne Netz her. NULL heisst: der Feed-Stand ist noch nicht gespeichert.
    //
    // Altbestand: Abos, die vor dieser Migration gesynct wurden, haben keinen
    // Feed-Stand. Ihr ETag (und Last-Modified) wird geleert, damit der naechste
    // Abruf den vollen Feed (200) statt 304 ohne Text liefert und der Stand
    // einmal vollstaendig geschrieben wird.
    up(database) {
      const cols = database.prepare('PRAGMA table_info(calendar_events)').all();
      if (!cols.some((col) => col.name === 'feed_original')) {
        database.exec('ALTER TABLE calendar_events ADD COLUMN feed_original TEXT');
      }
      database.exec('UPDATE ics_subscriptions SET etag = NULL, last_modified = NULL');
    },
  };
