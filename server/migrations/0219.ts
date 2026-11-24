// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 219,
    description: 'Health: preventive care & vaccinations log (household type registry + per-person records)',
    foreignKeysOff: true,
    up: `
      -- reminders.entity_type erneut erweitern (Muster wie v137/v140/v141):
      -- SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher
      -- Tabelle neu erstellen. foreignKeysOff bleibt Pflicht - gleicher Grund
      -- wie dort: notification_deliveries.reminder_id ... ON DELETE CASCADE
      -- wuerde sonst beim DROP TABLE auf jeder bestehenden Installation
      -- mitgeloescht. 'health_prevention_due' ist der einzige neue Wert hier -
      -- v218 (Dokumente) hat 'document_expiry' bereits eigenstaendig
      -- nachgezogen, statt beide Werte in einem Schritt zu buendeln
      -- (Review-Feedback #1255/#1256: ein Wert ohne Schreiber waere unter der
      -- Anhaenge-Regel dauerhaft im CHECK fest gewesen, ohne Issue und ohne
      -- SCOPE-/DECISIONS-Eintrag).
      --
      -- ERST DIE ZWEI TRIGGER AUS V217 ABRAEUMEN, aus demselben Grund wie
      -- bereits in v218 dokumentiert: ihr Koerper nennt "reminders" beim
      -- Namen, und SQLites ALTER TABLE ... RENAME TO reminders reparst dabei
      -- die ganze Schema, was mitten in diesem Umbau auf ein momentan
      -- fehlendes "reminders" trifft ("no such table: main.reminders").
      -- Abraeumen vor dem Umbau und am Ende neu anlegen umgeht das. IF EXISTS
      -- wie in v218 (Review #1255 nice-to-have): kostet hier nichts, haelt
      -- aber eine Installation nicht auf 218 stecken, falls diese Annahme je
      -- nicht mehr gilt.
      DROP TRIGGER IF EXISTS trg_reminders_tasks_ad;
      DROP TRIGGER IF EXISTS trg_reminders_events_ad;

      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup', 'document_expiry', 'health_prevention_due')),
        entity_id   INTEGER NOT NULL,
        remind_at   TEXT    NOT NULL,
        dismissed   INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        pushed_at   TEXT,
        assigned_from INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      INSERT INTO reminders_new (id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at, assigned_from)
        SELECT id, entity_type, entity_id, remind_at, dismissed, created_by, created_at, pushed_at, assigned_from FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_new RENAME TO reminders;
      CREATE INDEX idx_reminders_entity ON reminders(entity_type, entity_id);
      CREATE INDEX idx_reminders_remind ON reminders(remind_at);
      CREATE INDEX idx_reminders_user ON reminders(created_by);
      CREATE INDEX idx_reminders_assigned_from ON reminders(assigned_from);

      CREATE TRIGGER trg_reminders_tasks_ad
      AFTER DELETE ON tasks BEGIN
        DELETE FROM reminders WHERE entity_type = 'task' AND entity_id = OLD.id;
      END;

      CREATE TRIGGER trg_reminders_events_ad
      AFTER DELETE ON calendar_events BEGIN
        DELETE FROM reminders WHERE entity_type = 'event' AND entity_id = OLD.id;
      END;

      -- Haushalts-Register der Vorsorge-Arten (D2) - NICHTS VORBEFUELLT.
      -- docs/SCOPE.md schliesst mitgelieferte Kataloge aus, die veralten
      -- (deutsche U-Untersuchungen etc.); der Haushalt legt seine eigenen an.
      CREATE TABLE health_prevention_types (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        name                    TEXT    NOT NULL,
        kind                    TEXT    NOT NULL CHECK (kind IN ('vaccination', 'checkup')),
        default_interval_months INTEGER CHECK (default_interval_months IS NULL OR (default_interval_months BETWEEN 1 AND 600)),
        icon                    TEXT    NOT NULL DEFAULT 'syringe',
        sort_order              INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_health_prevention_types_updated_at AFTER UPDATE ON health_prevention_types FOR EACH ROW BEGIN
        UPDATE health_prevention_types SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      -- Das eine Modell fuer Impfung UND Vorsorgeuntersuchung (D1) - eine
      -- Tetanus-Auffrischung alle 10 Jahre und ein Zahnarzttermin alle 6 Monate
      -- sind dieselbe Zeile: Person + Art + wann es war + Intervall zum
      -- naechsten Mal. Zwei Tabellen wuerden docs/DECISIONS.md #6 ("ein
      -- Modell, nicht zwei") erneut aufmachen.
      CREATE TABLE health_prevention_records (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type_id              INTEGER REFERENCES health_prevention_types(id) ON DELETE SET NULL,
        -- Momentaufnahme/Ausweich-Name: bleibt lesbar, wenn der Typ umbenannt
        -- oder geloescht wird (SET NULL oben) - Loeschen eines Typs darf seine
        -- Historie nicht mitreissen.
        name                 TEXT,
        given_on             TEXT    NOT NULL,
        dose_number          INTEGER,
        batch                TEXT,
        provider             TEXT,
        note                 TEXT,
        -- NULL = der Typ-Standard gilt; ein Wert hier ueberschreibt ihn nur
        -- fuer DIESEN Datensatz.
        interval_months      INTEGER CHECK (interval_months IS NULL OR (interval_months BETWEEN 1 AND 600)),
        -- Explizite Faelligkeit; NULL = aus given_on + Intervall abgeleitet
        -- (server/services/prevention-due.js, die einzige Stelle, die das rechnet).
        next_due_on          TEXT,
        -- NULL = Modul-Standard (30 Tage, DEFAULT_REMINDER_OFFSET_DAYS).
        reminder_offset_days INTEGER CHECK (reminder_offset_days IS NULL OR (reminder_offset_days BETWEEN 0 AND 365)),
        visibility           TEXT    NOT NULL CHECK (visibility IN ('private', 'family')),
        created_by           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TRIGGER trg_health_prevention_records_updated_at AFTER UPDATE ON health_prevention_records FOR EACH ROW BEGIN
        UPDATE health_prevention_records SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;
      CREATE INDEX idx_health_prevention_records_user_date ON health_prevention_records(user_id, given_on);
    `,
  };
