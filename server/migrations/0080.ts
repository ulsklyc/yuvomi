export default {
    version: 80,
    description: 'Opt-in: zugewiesene Personen im Kalender-Feed-Titel anzeigen (#482)',
    up: `
      -- 0 = aus (bisheriges Verhalten, unveränderte Titel für Bestands-Abonnenten);
      -- 1 = SUMMARY im read-only ICS-Feed erhält Suffix "(Name, Name)".
      ALTER TABLE users ADD COLUMN calendar_feed_show_assignees INTEGER NOT NULL DEFAULT 0;
    `,
  };
