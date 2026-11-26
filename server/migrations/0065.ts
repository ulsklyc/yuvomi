export default {
    version: 65,
    description: 'add health module: vitals, medications, schedules, logs, lab reports/results, activities',
    up: `
      -- Vitalwerte (eine Zeile = eine Messung)
      CREATE TABLE IF NOT EXISTS health_vitals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT    NOT NULL,
        value_num   REAL,
        value_num2  REAL,
        value_num3  REAL,
        unit        TEXT,
        measured_at TEXT    NOT NULL,
        note        TEXT,
        visibility  TEXT    NOT NULL DEFAULT 'private'
                            CHECK(visibility IN ('private', 'family')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Medikamente (Stammdaten)
      CREATE TABLE IF NOT EXISTS medications (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name             TEXT    NOT NULL,
        dosage_text      TEXT,
        form             TEXT,
        active           INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        prn              INTEGER NOT NULL DEFAULT 0 CHECK(prn IN (0, 1)),
        stock_qty        REAL,
        stock_unit       TEXT,
        refill_threshold REAL,
        note             TEXT,
        visibility       TEXT    NOT NULL DEFAULT 'private'
                                 CHECK(visibility IN ('private', 'family')),
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Einnahmeplan (1 Med : n Zeitfenster)
      CREATE TABLE IF NOT EXISTS medication_schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        time_of_day   TEXT    NOT NULL,
        days_mask     INTEGER CHECK(days_mask IS NULL OR (days_mask BETWEEN 0 AND 127)),
        dose_qty      REAL,
        start_date    TEXT,
        end_date      TEXT,
        active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Dosis-Ereignisse (Log)
      CREATE TABLE IF NOT EXISTS medication_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        schedule_id   INTEGER REFERENCES medication_schedules(id) ON DELETE SET NULL,
        scheduled_at  TEXT,
        status        TEXT    NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('taken', 'skipped', 'pending')),
        taken_at      TEXT,
        dose_qty      REAL,
        note          TEXT,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Laborbefund (Kopf)
      CREATE TABLE IF NOT EXISTS health_lab_reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_date TEXT    NOT NULL,
        lab_name    TEXT,
        note        TEXT,
        visibility  TEXT    NOT NULL DEFAULT 'private'
                            CHECK(visibility IN ('private', 'family')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Analyt-Werte je Befund
      CREATE TABLE IF NOT EXISTS health_lab_results (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id  INTEGER NOT NULL REFERENCES health_lab_reports(id) ON DELETE CASCADE,
        analyte    TEXT    NOT NULL,
        value_num  REAL,
        unit       TEXT,
        ref_low    REAL,
        ref_high   REAL,
        flag       TEXT    CHECK(flag IS NULL OR flag IN ('low', 'normal', 'high')),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- Aktivität/Training
      CREATE TABLE IF NOT EXISTS health_activities (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type         TEXT    NOT NULL,
        duration_min REAL,
        distance_km  REAL,
        intensity    TEXT,
        calories     REAL,
        performed_at TEXT    NOT NULL,
        note         TEXT,
        visibility   TEXT    NOT NULL DEFAULT 'private'
                             CHECK(visibility IN ('private', 'family')),
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      -- updated_at-Trigger (je Tabelle mit updated_at)
      CREATE TRIGGER IF NOT EXISTS trg_health_vitals_updated_at
        AFTER UPDATE ON health_vitals FOR EACH ROW
        BEGIN UPDATE health_vitals SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_medications_updated_at
        AFTER UPDATE ON medications FOR EACH ROW
        BEGIN UPDATE medications SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_medication_schedules_updated_at
        AFTER UPDATE ON medication_schedules FOR EACH ROW
        BEGIN UPDATE medication_schedules SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_health_lab_reports_updated_at
        AFTER UPDATE ON health_lab_reports FOR EACH ROW
        BEGIN UPDATE health_lab_reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_health_activities_updated_at
        AFTER UPDATE ON health_activities FOR EACH ROW
        BEGIN UPDATE health_activities SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- Indizes
      CREATE INDEX IF NOT EXISTS idx_health_vitals_user_measured
        ON health_vitals(user_id, measured_at);
      CREATE INDEX IF NOT EXISTS idx_health_activities_user_performed
        ON health_activities(user_id, performed_at);
      CREATE INDEX IF NOT EXISTS idx_health_lab_reports_user_date
        ON health_lab_reports(user_id, report_date);
      CREATE INDEX IF NOT EXISTS idx_health_lab_results_report
        ON health_lab_results(report_id);
      CREATE INDEX IF NOT EXISTS idx_medications_user
        ON medications(user_id);
      CREATE INDEX IF NOT EXISTS idx_medication_logs_med_scheduled
        ON medication_logs(medication_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_medication_schedules_med_active
        ON medication_schedules(medication_id, active);
    `,
  };
