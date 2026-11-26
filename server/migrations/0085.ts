export default {
    version: 85,
    description: 'Single-occurrence exceptions for recurring calendar events (EXDATE, #489)',
    up: `
      -- Ausnahmen einzelner Vorkommen einer wiederkehrenden Serie (EXDATE).
      -- Spiegelt das Muster von budget_recurrence_skipped: eine Zeile je
      -- ausgenommenem Instanz-Datum. ON DELETE CASCADE entfernt die Ausnahmen,
      -- wenn die ganze Serie gelöscht wird.
      CREATE TABLE IF NOT EXISTS calendar_event_exceptions (
        event_id       INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        exception_date TEXT    NOT NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (event_id, exception_date)
      );
    `,
  };
