// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 97,
    description: 'Add tzid to calendar_events for DST-correct recurrence expansion (#549)',
    up: `
      -- IANA-Zeitzone (z.B. Europe/Berlin) des Serien-Starts. Nur für zeitgebundene
      -- CalDAV/Apple-Wiederholungen relevant, die am Anzeige-Zeitpunkt expandiert
      -- werden: ohne die Zone behält jede Instanz den festen UTC-Zeit-Suffix des
      -- Masters, sodass die lokale Uhrzeit über die Sommer-/Winterzeit-Grenze um
      -- eine Stunde driftet (#549). NULL = wie bisher (floating/UTC, kein DST-Bezug).
      ALTER TABLE calendar_events ADD COLUMN tzid TEXT;
    `,
  };
