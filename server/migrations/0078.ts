export default {
    version: 78,
    description: 'Sichtbarkeit pro Aufgabe/Termin: all | assignees | private (#474)',
    up: `
      -- Standard 'all' = bisheriges Verhalten (für alle Familienmitglieder sichtbar);
      -- Bestandsdaten bleiben damit unverändert sichtbar. Durchsetzung erfolgt
      -- serverseitig auf allen Lesepfaden (Liste, Detail, Dashboard, Suche, Reminder).
      ALTER TABLE tasks           ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE calendar_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
    `,
  };
