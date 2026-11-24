export default {
    version: 71,
    description: 'add menstrual cycle tracking to health module: periods, day logs, per-user settings',
    up: `
      -- Perioden-Episoden (eine Zeile = eine Menstruation). end_date bleibt NULL,
      -- solange die Blutung andauert. Scoping/Visibility wie im übrigen Health-Modul
      -- (Eigentümer + optional 'family' für den Personen-Umschalter). Zyklusdaten
      -- sind sensibel → Default 'private'.
      CREATE TABLE IF NOT EXISTS cycle_periods (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_date TEXT    NOT NULL,
        end_date   TEXT,
        note       TEXT,
        visibility TEXT    NOT NULL DEFAULT 'private'
                           CHECK(visibility IN ('private', 'family')),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Tages-Log (Blutungsstärke, Symptome, Stimmung, Notiz) — genau ein Eintrag
      -- je Person und Kalendertag (UNIQUE → Upsert). symptoms hält eine Komma-Liste
      -- stabiler Symptom-Schlüssel (kein lokalisierter Text).
      CREATE TABLE IF NOT EXISTS cycle_day_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        log_date   TEXT    NOT NULL,
        flow       TEXT    CHECK(flow IS NULL OR flow IN ('spotting', 'light', 'medium', 'heavy')),
        symptoms   TEXT,
        mood       TEXT,
        note       TEXT,
        visibility TEXT    NOT NULL DEFAULT 'private'
                           CHECK(visibility IN ('private', 'family')),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(user_id, log_date)
      );

      -- Zyklus-Einstellungen je Person (überschreiben die aus der Historie
      -- abgeleiteten Mittelwerte). NULL = automatisch aus Historie ableiten.
      CREATE TABLE IF NOT EXISTS cycle_settings (
        user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        cycle_length_avg  INTEGER,
        period_length_avg INTEGER,
        luteal_length     INTEGER NOT NULL DEFAULT 14,
        track_fertility   INTEGER NOT NULL DEFAULT 1 CHECK(track_fertility IN (0, 1)),
        created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_cycle_periods_updated_at
        AFTER UPDATE ON cycle_periods FOR EACH ROW
        BEGIN UPDATE cycle_periods SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_cycle_day_logs_updated_at
        AFTER UPDATE ON cycle_day_logs FOR EACH ROW
        BEGIN UPDATE cycle_day_logs SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_cycle_settings_updated_at
        AFTER UPDATE ON cycle_settings FOR EACH ROW
        BEGIN UPDATE cycle_settings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE user_id = OLD.user_id; END;

      CREATE INDEX IF NOT EXISTS idx_cycle_periods_user_start
        ON cycle_periods(user_id, start_date);
      CREATE INDEX IF NOT EXISTS idx_cycle_day_logs_user_date
        ON cycle_day_logs(user_id, log_date);
    `,
  };
