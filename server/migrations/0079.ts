export default {
    version: 79,
    description: 'Standard-Zuweisung pro Kalender-Sync-Ziel (#459)',
    up: `
      -- Optionale Standard-Person je Sync-Ziel: neu importierte Termine werden ihr
      -- automatisch zugewiesen. NULL = keine Zuweisung (bisheriges Verhalten).
      -- ON DELETE ist nicht per ALTER setzbar; Aufräumen bei Nutzer-Löschung
      -- übernimmt server/services/sync-assignment.js beim nächsten Zugriff.
      ALTER TABLE external_calendars ADD COLUMN default_assignee_user_id INTEGER;
      ALTER TABLE ics_subscriptions  ADD COLUMN default_assignee_user_id INTEGER;
    `,
  };
