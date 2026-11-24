export default {
    version: 83,
    description: 'Task categories as a customizable, sortable table (#494, #357)',
    up: `
      -- Aufgaben-Kategorien werden verwaltbar (hinzufügen/umbenennen/ordnen/löschen),
      -- analog zu Budget/Shopping. Bestands-Keys behalten ihren i18n-Wert über
      -- label_key (name = NULL → lokalisiert); Custom-Kategorien tragen name, label_key NULL.
      CREATE TABLE IF NOT EXISTS task_categories (
        key        TEXT    PRIMARY KEY,
        name       TEXT,
        label_key  TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT OR IGNORE INTO task_categories (key, name, label_key, sort_order) VALUES
        ('household', NULL, 'tasks.categoryHousehold', 0),
        ('school',    NULL, 'tasks.categorySchool',    1),
        ('shopping',  NULL, 'tasks.categoryShopping',  2),
        ('repair',    NULL, 'tasks.categoryRepair',    3),
        ('health',    NULL, 'tasks.categoryHealth',    4),
        ('finance',   NULL, 'tasks.categoryFinance',   5),
        ('leisure',   NULL, 'tasks.categoryLeisure',   6),
        ('misc',      NULL, 'tasks.categoryMisc',      7);

      -- Legacy-Default 'Sonstiges' auf den kanonischen Key 'misc' ziehen.
      UPDATE tasks SET category = 'misc' WHERE category = 'Sonstiges' OR category IS NULL OR category = '';

      -- Vorhandene freie Kategorie-Werte als Custom-Kategorien übernehmen (Daten erhalten).
      INSERT OR IGNORE INTO task_categories (key, name, label_key, sort_order)
      SELECT category, category, NULL, 1000
      FROM tasks
      WHERE category IS NOT NULL AND category != ''
        AND category NOT IN (SELECT key FROM task_categories)
      GROUP BY category;
    `,
  };
