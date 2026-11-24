// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 260,
    description: 'Shopping: tell whoever moved a mirrored item when the move was taken back (#1912)',
    foreignKeysOff: true,
    up: `
      -- WER HAT VERSCHOBEN (#1912). Geht ein Umzug zurueck (fuenfte Absage des
      -- Ziels, Zielliste auf dem Server fort, Frist aus #1911), bekommt die
      -- Person, die verschoben hat, eine Meldung an der Glocke. Die Zeile
      -- kannte sie bisher nicht. NULL heisst: unbekannt (Umzug von vor dem
      -- Update, Konto geloescht) - dann gibt es keine Meldung, nur das Log.
      ALTER TABLE shopping_items ADD COLUMN outbound_move_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

      -- DIE MELDUNG SELBST, als Momentaufnahme. Namen statt nur Verweise: nach
      -- der Frist steht der Artikel auf einer abgeschalteten Liste, und der
      -- naechste Abruf nimmt ihn dort lokal fort (sein Eintrag lebt auf dem
      -- Server weiter). Die Meldung muss trotzdem sagen koennen, was passiert
      -- ist. Die Verweise tragen nur den Sprung auf die Liste.
      CREATE TABLE shopping_move_notices (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id          INTEGER REFERENCES shopping_items(id) ON DELETE SET NULL,
        item_name        TEXT    NOT NULL,
        back_list_id     INTEGER REFERENCES shopping_lists(id) ON DELETE SET NULL,
        back_list_name   TEXT    NOT NULL,
        target_list_name TEXT    NOT NULL,
        -- 'refused': das Ziel hat nicht angenommen (fuenfte Absage, Liste fort);
        -- 'waited': die alte Liste war zu lange abgeschaltet (#1911).
        reason           TEXT    NOT NULL CHECK(reason IN ('refused', 'waited')),
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX idx_shopping_move_notices_user ON shopping_move_notices(user_id);

      -- Die Glocke ist die Erinnerungstabelle; ihr CHECK waechst nur per
      -- Rebuild (wie v220, dessen Werte hier alle wieder stehen muessen).
      DROP TRIGGER IF EXISTS trg_reminders_tasks_ad;
      DROP TRIGGER IF EXISTS trg_reminders_events_ad;
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup', 'document_expiry', 'health_prevention_due', 'fasting_goal', 'fasting_next_start', 'shopping_move_returned')),
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
      -- Die Meldung geht mit ihrer Momentaufnahme (Konto geloescht).
      CREATE TRIGGER trg_reminders_shopping_move_notices_ad
      AFTER DELETE ON shopping_move_notices BEGIN
        DELETE FROM reminders WHERE entity_type = 'shopping_move_returned' AND entity_id = OLD.id;
      END;
    `,
  };
