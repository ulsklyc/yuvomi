export default {
    version: 177,
    description: 'Health: cycle reminders - widen reminders for cycle_period/cycle_log_nudge, add an anchor table',
    foreignKeysOff: true,
    up: `
      -- DIE FUENFTE ERWEITERUNG DERSELBEN SPALTE, gleiche Bauart wie v137/v141/v148/v162.
      -- foreignKeysOff bleibt Pflicht - notification_deliveries.reminder_id
      -- haengt mit ON DELETE CASCADE an dieser Tabelle und wuerde beim
      -- DROP TABLE leerlaufen.
      CREATE TABLE reminders_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type   TEXT    NOT NULL CHECK(entity_type IN ('task', 'event', 'subscription', 'inventory_item', 'inventory_tracked_date', 'pantry_item', 'cycle_period', 'cycle_log_nudge')),
        entity_id     INTEGER NOT NULL,
        remind_at     TEXT    NOT NULL,
        dismissed     INTEGER NOT NULL DEFAULT 0,
        created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        pushed_at     TEXT,
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

      -- Weder ein vorhergesagter naechster Periodenbeginn noch "heute noch
      -- nicht geloggt" ist eine gespeicherte Zeile - predictCycle() berechnet
      -- den ersten rein aus der Perioden-Historie, der zweite ist die
      -- Abwesenheit einer Zeile in cycle_day_logs. Beides hat also keine
      -- stabile Id, an die reminders.entity_id haengen koennte (gleicher
      -- Grund wie schedule_reminder_entries fuer Musterzyklus-Tage). Ein
      -- Anker je (Person, Datum, Art) loest das einheitlich fuer beide
      -- Erinnerungsarten in einer Tabelle statt zwei fast identischen.
      CREATE TABLE cycle_reminder_anchors (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        anchor_date TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('period_predicted', 'log_nudge')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(user_id, anchor_date, kind)
      );

      -- NULL = aus (Standard). Tage Vorlauf vor dem vorhergesagten
      -- Periodenbeginn, ab dem eine Erinnerung erscheint.
      ALTER TABLE cycle_settings ADD COLUMN remind_period_days_before INTEGER;
      -- Taeglicher Hinweis, den heutigen Tag einzutragen, falls noch kein Log
      -- vorliegt. Eigener Schalter statt an remind_period_days_before
      -- gekoppelt: wer nur an die Periode erinnert werden will, ist damit
      -- nicht automatisch jemand, der jeden Tag protokollieren will.
      ALTER TABLE cycle_settings ADD COLUMN remind_log_daily INTEGER NOT NULL DEFAULT 0 CHECK(remind_log_daily IN (0, 1));
    `,
  };
