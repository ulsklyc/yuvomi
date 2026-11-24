// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 217,
    description: 'Reminders of a deleted task or event are removed with it',
    // DIE ERINNERUNG GEHOERT DEM DING, NICHT DEM FENSTER, DAS ES GELOESCHT HAT.
    //
    // `reminders.entity_type`/`entity_id` sind ein WEICHER Verweis - die einzige
    // Fremdschluesselspalte der Tabelle ist `created_by`. Aufgeraeumt hat bisher
    // allein der Client: `deleteTaskWithUndo` schickte hinter dem DELETE der
    // Aufgabe noch ein `DELETE /reminders?entity_type=task&entity_id=...`, mit
    // stummem `catch`. Drei Wege liessen die Zeile stehen, und alle drei kamen
    // vor: der `keepalive`-Aufruf beim Zuklappen des Tabs geht verloren; die
    // Aufgabe wird ueber /api/v1 oder MCP geloescht, wo kein Client mitraeumt;
    // oder der Aufrufer hat `tasks: write` und `calendar: read`, dann antwortet
    // der Loeschweg mit 403 und das `catch` verschluckt ihn. Uebrig blieb eine
    // Erinnerung an eine Aufgabe, die es nicht mehr gibt - sie feuert als
    // Benachrichtigung mit leerem Text (entity_title ist dann NULL, siehe
    // services/notifications.js) und steht in /reminders/pending.
    //
    // Ein VIERTER Fall, den der Client gar nicht abdecken KONNTE: er loescht nur
    // die eigenen Zeilen (`AND created_by = ?`). Die Erinnerung, die sich ein
    // anderes Haushaltsmitglied auf dieselbe Aufgabe gesetzt hatte, ueberlebte
    // sie auch bei perfektem Netz.
    //
    // WARUM EIN TRIGGER UND NICHT EINE ZEILE IN DER ROUTE: Aufgaben und Termine
    // verschwinden an mehr als einer Stelle. DELETE /tasks/:id, die per CASCADE
    // mitgehenden Unteraufgaben, discardRecurrenceFollowup() beim Zuruecknehmen
    // eines Hakens, deleteVisitLinks() in housekeeping.js, dazu bei Terminen der
    // Google-/ICS-/CalDAV-Abgleich und calendar-prune.js. Eine Regel, die in
    // einer Route WOHNT, deckt genau diese eine Route ab; die naechste Stelle
    // erbt sie nicht. Im Trigger gilt sie fuer jedes DELETE, auch fuer das per
    // Fremdschluessel ausgeloeste (nachgemessen: AFTER-DELETE feuert auch fuer
    // CASCADE-Zeilen, ohne dass `recursive_triggers` noetig waere).
    //
    // WAS EIN KUENFTIGER TABELLEN-REBUILD BEACHTEN MUSS: `ALTER TABLE ... RENAME
    // TO tasks` verliert die Trigger der alten Tabelle - genau wie bei
    // `trg_search_tasks_ad`, das die Rebuilds in v114/v117 (tasks) und v166/v194
    // (calendar_events) deshalb jedes Mal neu anlegen.
    // test/test-reminder-orphans.js faehrt die volle Migrationskette und loescht
    // danach wirklich eine Aufgabe, faellt also auf, wenn es jemand vergisst.
    up: `
      DELETE FROM reminders
      WHERE entity_type = 'task'
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = reminders.entity_id);

      DELETE FROM reminders
      WHERE entity_type = 'event'
        AND NOT EXISTS (SELECT 1 FROM calendar_events WHERE calendar_events.id = reminders.entity_id);

      CREATE TRIGGER IF NOT EXISTS trg_reminders_tasks_ad
      AFTER DELETE ON tasks BEGIN
        DELETE FROM reminders WHERE entity_type = 'task' AND entity_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_reminders_events_ad
      AFTER DELETE ON calendar_events BEGIN
        DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = OLD.id;
      END;
    `,
  };
