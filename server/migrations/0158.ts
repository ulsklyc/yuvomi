// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 158,
    description: 'Google calendar: drop the sync token where the first user was deleted, so the missed events come back',
    up(db) {
      // DER FIX ALLEIN HOLT NICHTS NACH.
      //
      // Bis #839 stand der Besitzer eines importierten Termins als feste ID 1
      // im INSERT, und `created_by` ist ein Fremdschluessel auf `users`. Wer den
      // bei der Installation angelegten Nutzer geloescht hatte, bei dem scheiterte
      // jeder einzelne Insert - der Lauf selbst lief aber weiter und speicherte
      // am Ende brav seinen syncToken. Fuer Google sind diese Termine damit
      // zugestellt: der naechste inkrementelle Lauf fragt nur nach Aenderungen
      // SEIT dem Token und liefert sie nie wieder. Der Kalender bliebe also
      // dauerhaft luecken behaftet, obwohl der Fehler behoben ist.
      //
      // Ohne Token faellt der naechste Lauf auf einen Full-Resync zurueck und
      // holt den vollen Zeitraum erneut. Das ist gefahrlos: der Upsert
      // vergleicht Werte und fasst keine Zeile an, die sich nicht unterscheidet.
      //
      // Nur fuer betroffene Installationen: fehlt der Nutzer mit der ID 1, ist
      // genau die Bedingung erfuellt, unter der der Fehler zuschlug. Wo er noch
      // existiert, hat nie etwas gefehlt, und ein unnoetiger Full-Resync kostete
      // Kontingent bei Googles API.
      const hasFirstUser = db.prepare('SELECT 1 FROM users WHERE id = 1').get();
      if (hasFirstUser) return;

      db.prepare(`UPDATE google_calendar_selection
                     SET sync_token = NULL, last_sync = NULL
                   WHERE sync_token IS NOT NULL`).run();
    },
  };
