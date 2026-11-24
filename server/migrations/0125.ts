// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 125,
    description: 'CalDAV: remember that a reminder-list discovery ran, even when it found nothing (#617)',
    up: `
      -- Die Aufgabenseite sucht beim ersten Oeffnen selbst nach Listen, statt
      -- einen leeren Zustand zu zeigen. "Zum ersten Mal" liess sich bisher nur
      -- daran ablesen, dass caldav_reminder_selection fuer das Konto leer ist -
      -- fuer einen Server ohne VTODO-Sammlungen bleibt sie das aber fuer immer,
      -- und jeder Aufruf der Seite haette erneut den Server befragt.
      --
      -- Der Zeitstempel trennt die beiden Faelle: NULL heisst "nie gesucht",
      -- gesetzt heisst "gesucht, Ergebnis gilt". Bestandskonten starten auf NULL
      -- und suchen damit genau einmal.
      ALTER TABLE caldav_accounts ADD COLUMN reminders_discovered_at TEXT;
    `,
  };
