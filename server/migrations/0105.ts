export default {
    version: 105,
    description: 'Calendar: queue a pending calendar move for mirrored Google events (#593)',
    up: `
      -- Wechselt der Zielkalender eines bereits gespiegelten Termins, muss er in
      -- Google per events.move umziehen; ein Patch im alten Kalender würde ihn
      -- dort belassen.
      --
      -- Der anstehende Umzug wird als eigener Wert vorgemerkt statt beim Sync aus
      -- target_google_calendar_id != calendar_ref_id abgeleitet. Bestandsdaten
      -- können diese Abweichung längst enthalten: target_google_calendar_id ließ
      -- sich immer setzen, blieb für bereits gespiegelte Termine aber folgenlos.
      -- Ein Zustandsvergleich würde daraus beim ersten Sync nach dem Update eine
      -- stille Umzugswelle in fremden Google-Kalendern machen. So zieht nur um,
      -- was ein Nutzer nach dem Update ausdrücklich umstellt.
      ALTER TABLE calendar_events ADD COLUMN outbound_move_to TEXT;
    `,
  };
