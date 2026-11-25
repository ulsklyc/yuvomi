export default {
    version: 285,
    description: 'reminders: clearing a task\'s due date removes its reminders (#2705)',
    // EINE ERINNERUNG BRAUCHT EIN FAELLIGKEITSDATUM, und diese Regel stand bis
    // hierher nur im Formular (`tasks.reminderNeedsDueDate`). Erinnerungen
    // gehoeren einer Person, der Aufgaben-Endpunkt fasste die Tabelle nicht an:
    // raeumte ein Mitglied das Datum weg, blieben die Erinnerungen der anderen
    // an einer Aufgabe ohne Datum haengen - ebenso nach einem DUE, das ein
    // CalDAV-Client entfernt. Der Trigger haelt die Regel an EINER Stelle fuer
    // jeden Schreibweg (REST, MCP, CalDAV-Abruf, Haushaltszahlungen), wie die
    // Loesch-Trigger aus v260 die Erinnerungen an ihre Aufgabe binden.
    // Gemessen wird der UEBERGANG (Datum da -> kein Datum), nicht der Zustand:
    // eine Aufgabe, die schon ohne Datum ankam, verliert bei einer
    // Titelkorrektur nichts. Reines SQL, `IF NOT EXISTS` heilt auch eine
    // Datenbank, auf der der Trigger von Hand angelegt wurde.
    up: `
      CREATE TRIGGER IF NOT EXISTS trg_reminders_tasks_due_cleared
      AFTER UPDATE OF due_date ON tasks
      WHEN OLD.due_date IS NOT NULL AND NEW.due_date IS NULL
      BEGIN
        DELETE FROM reminders WHERE entity_type = 'task' AND entity_id = NEW.id;
      END;
    `,
  };
