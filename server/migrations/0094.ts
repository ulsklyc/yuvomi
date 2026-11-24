export default {
    version: 94,
    description: 'Store structured vCard N name components for contacts (#535)',
    up: `
      -- Bisher trug ein Kontakt nur den kombinierten Anzeigenamen (aus FN).
      -- Quellen formatieren FN unterschiedlich ("Given Family" vs. "Family, Given",
      -- teils mit Titel oder Spitzname) - dadurch war weder Anzeige noch Sortierung
      -- konsistent. Die vCard-Eigenschaft N trägt die Struktur; sie wird ab jetzt
      -- gespeichert. name bleibt der Anzeigename und wird daraus abgeleitet.
      -- Alle Spalten nullable: NULL heißt "keine Struktur bekannt" (Altbestand,
      -- CardDAV-Kontakte füllen sie beim nächsten Sync nach).
      ALTER TABLE contacts ADD COLUMN first_name TEXT;
      ALTER TABLE contacts ADD COLUMN last_name TEXT;
      ALTER TABLE contacts ADD COLUMN middle_name TEXT;
      ALTER TABLE contacts ADD COLUMN name_prefix TEXT;
      ALTER TABLE contacts ADD COLUMN name_suffix TEXT;
    `,
  };
