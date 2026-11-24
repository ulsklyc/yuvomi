export default {
    version: 213,
    description: 'Health: widen cycle_reminder_anchors.kind to add partner_period',
    // SQLite kennt kein ALTER auf einen CHECK - derselbe Tabellen-Rebuild wie
    // v137/v141/v148/v162/v177 fuer reminders.entity_type, nur hier fuer die
    // Anker-Art. `foreignKeysOff` ist NICHT noetig: anders als reminders (an
    // dem notification_deliveries.reminder_id mit ON DELETE CASCADE haengt)
    // referenziert keine andere Tabelle cycle_reminder_anchors per FK - nur
    // reminders.entity_id, und das ist das ueberall gleiche polymorphe Muster
    // ohne echten Fremdschluessel.
    up: `
      CREATE TABLE cycle_reminder_anchors_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        anchor_date TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('period_predicted', 'log_nudge', 'partner_period')),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE(user_id, anchor_date, kind)
      );
      INSERT INTO cycle_reminder_anchors_new (id, user_id, anchor_date, kind, created_at)
        SELECT id, user_id, anchor_date, kind, created_at FROM cycle_reminder_anchors;
      DROP TABLE cycle_reminder_anchors;
      ALTER TABLE cycle_reminder_anchors_new RENAME TO cycle_reminder_anchors;
    `,
  };
