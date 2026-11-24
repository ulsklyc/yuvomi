// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 238,
    description: 'CalDAV: a mirrored event and its pending deletion carry their account (#1860)',
    // EIN GESPIEGELTER TERMIN GEHOERT ZU EINEM KONTO, UND DAS STEHT JETZT IN
    // DER ZEILE (#1860). Bis hierher war die UID die ganze Identitaet, ueber
    // alle CalDAV-Konten hinweg; welches Konto einen Termin sendet, ergab sich
    // erst zur Laufzeit aus Kalender-URL und Objektadresse.
    //
    // `caldav_account_id` IST DIE TATSACHE, `target_caldav_account_id` DER
    // WUNSCH. Das Ziel schreibt die Route aus dem Formular; das Konto schreibt
    // nur der Sync, und nur an Zeilen mit external_source = 'caldav'. Apple,
    // Google, ICS und lokale Zeilen bleiben NULL.
    //
    // EINE ZEILE JE UID, DAS ERSTE KONTO BESITZT SIE. Deshalb KEIN
    // Unique-Index auf (Konto, UID): bringt ein zweites Konto dieselbe UID,
    // legt es keine zweite Zeile an. Der Index hier beschleunigt nur.
    //
    // ON DELETE SET NULL an den Terminen: wer ein Konto loescht, behaelt seine
    // Termine, und das naechste Konto, das die UID liefert, uebernimmt sie.
    // ON DELETE CASCADE an den Loeschauftraegen: ohne Konto gibt es keinen
    // Server mehr, an den sie gehen koennten.
    //
    // ADD COLUMN, KEIN REBUILD: Trigger und Indizes von calendar_events
    // bleiben, wie sie sind. Ein kuenftiger Rebuild einer der beiden Tabellen
    // muss die Spalte samt Fremdschluessel mitnehmen (Guard in test-db.js).
    //
    // BESTAND, nur Zeilen mit external_source = 'caldav':
    //   - kein Konto: nichts zuzuordnen;
    //   - genau ein Konto: alles gehoert ihm;
    //   - mehrere: eine Zeile gehoert dem Konto, in dessen Auswahl der
    //     Schluessel ihres Kalenders (external_calendars.external_id) steht -
    //     aber nur, wenn er in genau EINER Auswahl steht. Beide Seiten hat
    //     derselbe Code geschrieben, verglichen wird zeichengleich.
    //   Alles andere bleibt NULL: eine solche Zeile wird nicht gesendet und
    //   vom ersten Konto uebernommen, das ihre UID liefert. Das Upload-Ziel
    //   und die Objektadresse entscheiden hier bewusst nichts.
    // Fuer die Loeschauftraege gilt dasselbe ueber `calendar_external_id`.
    //
    // DIE TRIGGER VON calendar_events RUHEN WAEHREND DES NACHTRAGS: der
    // Such-Trigger `trg_search_events_au` schreibt die FTS-Zeile je UPDATE neu
    // (teuer, bei vielen Terminen Sekunden), und `trg_calendar_events_updated_at`
    // setzte jede zugeordnete Zeile auf "eben geaendert". Beides soll ein reiner
    // Konto-Nachtrag nicht ausloesen. Sie werden mit ihrem gespeicherten
    // Wortlaut wieder angelegt, in derselben Reihenfolge, in derselben
    // Transaktion. (Migration 239 verengt den Such-Trigger dauerhaft auf seine
    // indizierten Spalten; dieses Ruhen bleibt für den einmaligen Nachtrag.)
    up(database) {
      // Eine gedriftete Datenbank kann die Spalte schon tragen
      // (reconcileCriticalSchema): dann nur noch Index und Nachtrag.
      const hasColumn = (table) => database.prepare(`PRAGMA table_info(${table})`).all()
        .some((column) => column.name === 'caldav_account_id');
      if (!hasColumn('calendar_events')) {
        database.exec(`
          ALTER TABLE calendar_events ADD COLUMN caldav_account_id INTEGER
            REFERENCES caldav_accounts(id) ON DELETE SET NULL;
        `);
      }
      if (!hasColumn('calendar_pending_deletions')) {
        database.exec(`
          ALTER TABLE calendar_pending_deletions ADD COLUMN caldav_account_id INTEGER
            REFERENCES caldav_accounts(id) ON DELETE CASCADE;
        `);
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_calendar_caldav_account_uid
          ON calendar_events(caldav_account_id, external_calendar_id)
          WHERE caldav_account_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_cal_pending_del_account
          ON calendar_pending_deletions(caldav_account_id)
          WHERE caldav_account_id IS NOT NULL;
      `);

      const accounts = database.prepare('SELECT id FROM caldav_accounts ORDER BY id').all();
      if (accounts.length === 0) return;

      const triggers = database.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'calendar_events' AND sql IS NOT NULL
        ORDER BY rowid
      `).all();
      for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);

      if (accounts.length === 1) {
        database.prepare(
          "UPDATE calendar_events SET caldav_account_id = ? WHERE external_source = 'caldav'"
        ).run(accounts[0].id);
        database.prepare(
          "UPDATE calendar_pending_deletions SET caldav_account_id = ? WHERE source = 'caldav'"
        ).run(accounts[0].id);
      } else {
        // COUNT(*) zaehlt Konten: (account_id, calendar_url) ist eindeutig.
        database.exec(`
          UPDATE calendar_events
          SET caldav_account_id = (
            SELECT MIN(s.account_id)
            FROM external_calendars x
            JOIN caldav_calendar_selection s ON s.calendar_url = x.external_id
            WHERE x.id = calendar_events.calendar_ref_id AND x.source = 'caldav'
          )
          WHERE external_source = 'caldav' AND calendar_ref_id IS NOT NULL
            AND (
              SELECT COUNT(*)
              FROM external_calendars x
              JOIN caldav_calendar_selection s ON s.calendar_url = x.external_id
              WHERE x.id = calendar_events.calendar_ref_id AND x.source = 'caldav'
            ) = 1;

          UPDATE calendar_pending_deletions
          SET caldav_account_id = (
            SELECT MIN(s.account_id) FROM caldav_calendar_selection s
            WHERE s.calendar_url = calendar_pending_deletions.calendar_external_id
          )
          WHERE source = 'caldav' AND calendar_external_id <> ''
            AND (
              SELECT COUNT(*) FROM caldav_calendar_selection s
              WHERE s.calendar_url = calendar_pending_deletions.calendar_external_id
            ) = 1;
        `);
      }

      for (const trigger of triggers) database.exec(trigger.sql);
    },
  };
