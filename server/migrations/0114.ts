// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 114,
    description: 'Tasks: repair the category default left behind by v83 (#586)',
    // Der Rebuild droppt `tasks` und nimmt dabei alle Indizes und die drei
    // Suchindex-Trigger mit - beide werden unten vollständig neu angelegt. Ohne
    // Fremdschlüssel-Pause würde das DROP die referenzierenden Zeilen
    // (task_assignments, task_documents, reward_ledger, Unteraufgaben) per
    // CASCADE mitreißen.
    foreignKeysOff: true,
    up: `
      -- v83 hat die Kategorien in eine eigene Tabelle überführt und den Bestand
      -- von 'Sonstiges' auf den Key 'misc' gezogen, den Spalten-Default der
      -- Tabelle aber stehen lassen. Seitdem trägt jede Zeile, die ohne
      -- ausdrückliche Kategorie entsteht, einen Key, den es in task_categories
      -- nicht gibt. Über den CalDAV-Spiegel passiert genau das bei jeder
      -- eingespielten Aufgabe (#586): sie landet in einer Kategorie, die in
      -- keinem Dropdown und keinem Filter auftaucht, und springt beim ersten
      -- Speichern im Modal still auf die erste echte Kategorie.
      CREATE TABLE tasks_new (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        title               TEXT    NOT NULL,
        description         TEXT,
        category            TEXT    NOT NULL DEFAULT 'misc',
        priority            TEXT    NOT NULL DEFAULT 'none'
                                    CHECK(priority IN ('none', 'low', 'medium', 'high', 'urgent')),
        status              TEXT    NOT NULL DEFAULT 'open'
                                    CHECK(status IN ('open', 'in_progress', 'done', 'archived')),
        due_date            TEXT,
        due_time            TEXT,
        assigned_to         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_recurring        INTEGER NOT NULL DEFAULT 0,
        recurrence_rule     TEXT,
        parent_task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        start_date          TEXT,
        external_uid        TEXT,
        external_source     TEXT    NOT NULL DEFAULT 'local',
        external_account_id INTEGER,
        points              INTEGER NOT NULL DEFAULT 0,
        visibility          TEXT    NOT NULL DEFAULT 'all',
        external_object_url TEXT,
        outbound_dirty      INTEGER NOT NULL DEFAULT 0,
        outbound_attempts   INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO tasks_new (
        id, title, description, category, priority, status, due_date, due_time,
        assigned_to, created_by, is_recurring, recurrence_rule, parent_task_id,
        created_at, updated_at, start_date, external_uid, external_source,
        external_account_id, points, visibility, external_object_url,
        outbound_dirty, outbound_attempts
      )
      SELECT
        id, title, description, category, priority, status, due_date, due_time,
        assigned_to, created_by, is_recurring, recurrence_rule, parent_task_id,
        created_at, updated_at, start_date, external_uid, external_source,
        external_account_id, points, visibility, external_object_url,
        outbound_dirty, outbound_attempts
      FROM tasks;

      -- Den AUTOINCREMENT-Hochstand mitnehmen. Ein Rebuild kopiert nur die
      -- überlebenden Zeilen, also fällt sqlite_sequence auf deren höchste ID
      -- zurück. Wurde vor dem Upgrade die höchste Aufgabe gelöscht, vergäbe die
      -- nächste Aufgabe eine schon einmal benutzte ID. Die Tabelle reminders zeigt
      -- entity_type/entity_id auf Aufgaben, ohne Fremdschlüssel und ohne
      -- Aufräumen beim Löschen - eine verwaiste Erinnerung fiele damit einer
      -- fremden neuen Aufgabe zu.
      CREATE TEMP TABLE _tasks_seq AS
        SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tasks'), 0) AS seq;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      -- Auch wenn keine einzige Aufgabe überlebt, greift das: eine Kopie mit
      -- null Zeilen legt für tasks_new trotzdem einen sqlite_sequence-Eintrag
      -- an (seq = 0), den das RENAME mitnimmt. Das UPDATE hebt ihn dann an.
      UPDATE sqlite_sequence
         SET seq = (SELECT seq FROM _tasks_seq)
       WHERE name = 'tasks' AND seq < (SELECT seq FROM _tasks_seq);

      DROP TABLE _tasks_seq;

      -- Bestand einsammeln: nicht nur 'Sonstiges', sondern jeden Key, für den es
      -- keine Kategorie (mehr) gibt. Nach v83 konnten weitere entstehen.
      UPDATE tasks SET category = 'misc'
      WHERE category NOT IN (SELECT key FROM task_categories);

      CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned   ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent     ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_start_date ON tasks(start_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_external
        ON tasks(external_source, external_account_id, external_uid);

      -- Die Suchindex-Trigger hingen an der gedroppten Tabelle. Fehlen sie, läuft
      -- die Suche still auf einem einfrierenden Index weiter.
      DROP TRIGGER IF EXISTS trg_search_tasks_ai;
      DROP TRIGGER IF EXISTS trg_search_tasks_au;
      DROP TRIGGER IF EXISTS trg_search_tasks_ad;

      CREATE TRIGGER trg_search_tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;

      CREATE TRIGGER trg_search_tasks_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
        INSERT INTO search_index (entity, entity_id, title, body)
        VALUES ('task', NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.description, ''));
      END;

      CREATE TRIGGER trg_search_tasks_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM search_index WHERE entity = 'task' AND entity_id = OLD.id;
      END;
    `,
  };
