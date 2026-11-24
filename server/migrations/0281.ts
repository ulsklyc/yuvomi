export default {
    version: 281,
    description: 'calendar_events: provider_status keeps a cancellation the provider reports',
    // #2499: ein Termin, den der Anbieter per STATUS:CANCELLED absagt, aber
    // stehen laesst, kam ueber ICS-Abo, CalDAV und iCloud als normaler Termin
    // an und erinnerte weiter. Die Spalte gehoert dem Anbieter (der Inbound
    // schreibt sie bei jedem Abruf, auch zurueck auf CONFIRMED oder NULL);
    // lokal angelegte Termine bleiben NULL. Reines SQL fuer den Testspiegel
    // (db-schema-test.js); eine gedriftete Datenbank heilt
    // reconcileCriticalSchema.
    up: `ALTER TABLE calendar_events ADD COLUMN provider_status TEXT CHECK(provider_status IS NULL OR provider_status IN ('TENTATIVE', 'CONFIRMED', 'CANCELLED'));`,
  };
