export default {
    version: 218,
    description: 'Documents: optional expiry date + reminder lead, widen reminders for document_expiry',
    foreignKeysOff: true,
    up: `
      -- YYYY-MM-DD, nullable. Range validation (0-365 for the lead) lives in
      -- the route, not here - ADD COLUMN cannot carry a useful CHECK for it.
      ALTER TABLE family_documents ADD COLUMN expires_at TEXT;
      ALTER TABLE family_documents ADD COLUMN expiry_reminder_days INTEGER;

      -- reminders.entity_type erneut erweitern (Muster wie v137/v140/v141):
      -- SQLite kann einen Spalten-CHECK nicht per ALTER erweitern, daher
      -- Tabelle neu erstellen. foreignKeysOff bleibt Pflicht - gleicher Grund
      -- wie dort: notification_deliveries.reminder_id ... ON DELETE CASCADE
      -- wuerde sonst beim DROP TABLE auf jeder bestehenden Installation
      -- mitgeloescht. Nur der hier auch tatsaechlich geschriebene Typ kommt
      -- dazu - 'health_prevention_due' bleibt Sache der Migration, die ihn
      -- zuerst beschreibt (Review-Feedback #1256: ein CHECK laesst sich unter
      -- der Anhaenge-Regel nie wieder verengen, ein Wert ohne Schreiber waere
      -- also dauerhaft fest, ohne Issue und ohne SCOPE-/DECISIONS-Eintrag).
      --
      -- ERST DIE ZWEI TRIGGER AUS V217 ABRAEUMEN. Sie haengen an tasks/
      -- calendar_events, nicht an reminders, ueberleben also strukturell -
      -- aber ihr KOERPER nennt 'reminders' beim Namen, und genau das bringt
      -- SQLites CREATE-TABLE-RENAME-Ablauf hier zum Absturz: waehrend ALTER
      -- TABLE reminders_new RENAME TO reminders laeuft, parst SQLite jeden
      -- Trigger/View der Datenbank neu durch, und trifft dabei fuer einen
      -- kurzen Moment auf einen Trigger, dessen Textkoerper eine Tabelle
      -- nennt, die gerade nicht existiert (das alte reminders ist schon weg,
      -- das neue noch nicht umbenannt) - "no such table: main.reminders",
      -- mitten in dieser Migration, auf jeder Installation, reproduziert
      -- ausserhalb dieser Datei mit einem Fuenfzeiler gegen better-sqlite3.
      -- Abraeumen vor dem Umbau und am Ende neu anlegen umgeht das - derselbe
      -- Kniff wie bei trg_search_tasks_ad in v114/v117/v166/v194, nur in der
      -- umgekehrten Richtung (dort verlor die umgebaute Tabelle ihre EIGENEN
      -- Trigger, hier verliert ein FREMDER Trigger kurzzeitig sein Ziel).
      DROP TRIGGER IF EXISTS trg_reminders_tasks_ad;
      DROP TRIGGER IF EXISTS trg_reminders_events_ad;

      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup', 'document_expiry')),
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
    `,
  };
