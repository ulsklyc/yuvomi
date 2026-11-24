// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 220,
    description: 'Health: configurable fasting reminders and reminder entity types',
    foreignKeysOff: true,
    up: `
      -- Carries v219's 'health_prevention_due' forward: this rebuild replaces
      -- the table v219 just created, so every value it allowed has to be listed
      -- here again or an existing preventive-care reminder stops inserting.
      -- Reminders are polymorphic; SQLite requires a table rebuild to widen
      -- the CHECK constraint while preserving all delivery state columns.
      -- Migration 217 added triggers on tasks/events that reference reminders;
      -- SQLite validates their SQL during the rename, so suspend and restore
      -- them around the interval where the old reminders table is absent.
      DROP TRIGGER IF EXISTS trg_reminders_tasks_ad;
      DROP TRIGGER IF EXISTS trg_reminders_events_ad;
      CREATE TABLE reminders_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge', 'schedule_entry', 'schedule_extra_entry', 'waste_pickup', 'document_expiry', 'health_prevention_due', 'fasting_goal', 'fasting_next_start')),
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

      ALTER TABLE health_fasting_settings ADD COLUMN remind_goal INTEGER NOT NULL DEFAULT 0 CHECK(remind_goal IN (0, 1));
      ALTER TABLE health_fasting_settings ADD COLUMN remind_next_start INTEGER NOT NULL DEFAULT 0 CHECK(remind_next_start IN (0, 1));
    `,
  };
