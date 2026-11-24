// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 184,
    description: 'Schedule: shift-start reminders - widen reminders for schedule_entry, add an anchor table for pattern days',
    foreignKeysOff: true,
    // DIE SECHSTE ERWEITERUNG DERSELBEN SPALTE, gleiche Bauart wie v137/v141/v148/v162/v177.
    up: `
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry')),
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

      -- Ein Musterzyklus-Tag ist keine gespeicherte Zeile (das ist der ganze
      -- Punkt von "computed on read", siehe resolveEntries()) und hat deshalb
      -- keine stabile Id, an die reminders.entity_id haengen koennte - anders
      -- als bei jedem bisherigen entity_type, wo die Zeile schon existiert.
      -- Diese Tabelle ist NICHT die Wahrheit ueber den Schichtplan (die bleibt
      -- resolveEntries()); sie ist nur ein Anker je (Nutzer, Tag), den der
      -- periodische Sync (server/services/schedule-reminders.js) fuer sein
      -- rollierendes Fenster anlegt und wieder abraeumt, sobald der Tag aus
      -- dem Fenster faellt oder keine Erinnerung mehr braucht.
      --
      -- pattern_day_id steht von Anfang an hier (nicht erst ab Migration 188):
      -- ein Musterzyklus-Tag kann mehrere Klassen tragen (Stundenplan, siehe
      -- schedule_pattern_days weiter unten), jede mit ihrem eigenen Anker, und
      -- diese Tabelle hat vor dem allerersten Release noch nie eine andere
      -- Form gehabt - ein Rebuild in einer spaeteren Migration haette nur eine
      -- Tabelle abgerissen, die niemand je mit der alten Form befuellt hat.
      -- NULL bleibt fuer einen Override-Anker (hoechstens einer je Tag).
      CREATE TABLE schedule_reminder_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date_key       TEXT    NOT NULL,
        shift_type_id  INTEGER NOT NULL REFERENCES schedule_shift_types(id) ON DELETE CASCADE,
        pattern_day_id INTEGER
      );
      CREATE UNIQUE INDEX idx_schedule_reminder_entries_slot
        ON schedule_reminder_entries(user_id, date_key, COALESCE(pattern_day_id, 0));

      -- NULL = abgeschaltet (Standard), sonst der Vorlauf in Minuten vor
      -- Schichtbeginn. Anders als calendar_feed_token keine eigene
      -- Aktiv/Inaktiv-Spalte: der Vorlauf selbst ist der Schalter, wie schon
      -- bei den Vorrats-Ablauferinnerungen (EXPIRY_REMINDER_OFFSET_DAYS).
      ALTER TABLE users ADD COLUMN schedule_reminder_offset_minutes INTEGER;
    `,
  };
