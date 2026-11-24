export default {
    version: 261,
    description: 'CalDAV: remember whether a calendar or list takes new entries (#1840)',
    up: `
      -- DARF HIER GESCHRIEBEN WERDEN (#1840). Die Auflistung liest je
      -- Collection current-user-privilege-set (RFC 3744); die Ziel-Auswahl der
      -- Formulare bietet nur an, was neue Eintraege annimmt. 1 = ja, 0 = nein,
      -- NULL = der Server sagt es nicht (oder die Liste ist von vor dem
      -- Update): gilt als beschreibbar, wie bisher.
      ALTER TABLE caldav_calendar_selection ADD COLUMN writable INTEGER;
      ALTER TABLE caldav_reminder_selection ADD COLUMN writable INTEGER;
    `,
  };
