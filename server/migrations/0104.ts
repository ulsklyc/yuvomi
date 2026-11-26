export default {
    version: 104,
    description: 'Calendar: mark locally edited mirrored events for outbound push (#593)',
    up: `
      -- Gegenstück zu v103 für Änderungen: ein bereits nach Google gespiegelter
      -- Termin wurde nach dem ersten Push nie wieder ausgehend angefasst, weil der
      -- Outbound-Zweig nur external_source='local' selektiert. Titel-, Zeit- oder
      -- Farbänderungen blieben damit in Yuvomi hängen.
      --
      -- outbound_dirty ist bewusst NICHT user_modified: das Flag bedeutet
      -- dauerhaft "lokal angefasst, Farbe nicht überschreiben" und würde als
      -- Push-Signal jeden Sync-Lauf ein Update an Google schicken. outbound_dirty
      -- ist eine Warteschlange - gesetzt beim Bearbeiten, gelöscht nach dem Push.
      --
      -- outbound_attempts begrenzt Fehlversuche analog zu den Tombstones, damit
      -- ein dauerhaft unschreibbares Event nicht jeden Lauf blockiert.
      ALTER TABLE calendar_events ADD COLUMN outbound_dirty INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE calendar_events ADD COLUMN outbound_attempts INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_calendar_outbound_dirty
        ON calendar_events(outbound_dirty) WHERE outbound_dirty = 1;
    `,
  };
