// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 265,
    description: 'sync: several default assignees per calendar, subscription and reminder list (#1897, #1221)',
    up: `
      -- MEHRERE STANDARD-PERSONEN JE QUELLE (#1897): ein gemeinsamer Kalender
      -- ("Zusammen") bringt seine Termine fuer beide Personen herein. Bisher trug
      -- jede Quelle genau eine Person in default_assignee_user_id (Migration 79).
      -- Je Elterntabelle eine Join-Tabelle, damit beide Seiten einen echten
      -- Fremdschluessel haben: verschwindet der Kalender, das Abo, die
      -- Erinnerungsliste oder das Konto, gehen die Zeilen mit.
      --
      -- position: die Reihenfolge der Wahl. Die erste Person ist die primaere
      -- Zuweisung eines neuen Termins (calendar_events.assigned_to), und deren
      -- Farbe traegt ein Termin ohne eigene (#891).
      --
      -- Die alte Spalte bleibt stehen (Migrationen wachsen nur am Ende, und
      -- Bestandsinstallationen tragen sie), wird ab hier aber nicht mehr gelesen;
      -- nur das Entfernen eines Kontos leert sie noch. Ein kuenftiger Umbau einer der drei Elterntabellen mit
      -- DROP TABLE muss mit foreignKeysOff laufen, sonst raeumt CASCADE diese
      -- Zeilen ab.
      CREATE TABLE external_calendar_assignees (
        calendar_id INTEGER NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (calendar_id, user_id)
      );
      CREATE INDEX idx_external_calendar_assignees_user ON external_calendar_assignees(user_id);

      CREATE TABLE ics_subscription_assignees (
        subscription_id INTEGER NOT NULL REFERENCES ics_subscriptions(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (subscription_id, user_id)
      );
      CREATE INDEX idx_ics_subscription_assignees_user ON ics_subscription_assignees(user_id);

      -- Erinnerungslisten (#1221): nur fuer Listen, die auf Aufgaben zeigen; die
      -- Route lehnt eine Einkaufsliste ab, der Sync liest sie dort nicht.
      CREATE TABLE caldav_reminder_assignees (
        selection_id INTEGER NOT NULL REFERENCES caldav_reminder_selection(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (selection_id, user_id)
      );
      CREATE INDEX idx_caldav_reminder_assignees_user ON caldav_reminder_assignees(user_id);

      -- Die bestehende Einzelperson kommt als einzige Zeile mit. Eine verwaiste
      -- Referenz (Konto geloescht, die Spalte hatte keinen Fremdschluessel)
      -- faellt am JOIN heraus - der Sync hat sie ohnehin uebergangen.
      INSERT INTO external_calendar_assignees (calendar_id, user_id, position)
        SELECT ec.id, ec.default_assignee_user_id, 0
          FROM external_calendars ec JOIN users u ON u.id = ec.default_assignee_user_id;
      INSERT INTO ics_subscription_assignees (subscription_id, user_id, position)
        SELECT s.id, s.default_assignee_user_id, 0
          FROM ics_subscriptions s JOIN users u ON u.id = s.default_assignee_user_id;
    `,
  };
