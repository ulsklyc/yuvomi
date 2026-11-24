export default {
    version: 82,
    description: 'Schwangerschafts-Modus im Zyklus-Tab: pausiert Vorhersagen, optionaler Entbindungstermin (#450)',
    up: `
      -- 0 = aus (bisheriges Verhalten). 1 = Schwangerschaft aktiv → alle Zyklus-
      -- Vorhersagen (nächste Periode, Eisprung, fruchtbares Fenster, Ring/Kalender-
      -- Projektion) werden angehalten; stattdessen wird der Schwangerschafts-Status
      -- angezeigt. Perioden-/Tages-Logging bleibt unberührt.
      ALTER TABLE cycle_settings ADD COLUMN pregnancy_mode INTEGER NOT NULL DEFAULT 0
        CHECK(pregnancy_mode IN (0, 1));
      -- Optionaler errechneter Entbindungstermin (YYYY-MM-DD); NULL = ohne Termin,
      -- dann wird nur der Schwangerschafts-Zustand ohne SSW/Countdown gezeigt.
      ALTER TABLE cycle_settings ADD COLUMN pregnancy_due_date TEXT;
    `,
  };
