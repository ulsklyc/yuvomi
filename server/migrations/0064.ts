// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 64,
    description: 'add recurring meal templates',
    up: `
      CREATE TABLE IF NOT EXISTS meal_recurrence_templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        start_date TEXT    NOT NULL,
        weekday    INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
        meal_type  TEXT    NOT NULL
                           CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
        title      TEXT    NOT NULL,
        notes      TEXT,
        recipe_url TEXT,
        recipe_id  INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS meal_recurrence_ingredients (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES meal_recurrence_templates(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        quantity    TEXT,
        category    TEXT    NOT NULL DEFAULT 'Sonstiges',
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS meal_recurrence_exceptions (
        template_id INTEGER NOT NULL REFERENCES meal_recurrence_templates(id) ON DELETE CASCADE,
        date        TEXT    NOT NULL,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (template_id, date)
      );

      ALTER TABLE meals ADD COLUMN recurrence_template_id INTEGER REFERENCES meal_recurrence_templates(id) ON DELETE SET NULL;

      CREATE TRIGGER IF NOT EXISTS trg_meal_recurrence_templates_updated_at
        AFTER UPDATE ON meal_recurrence_templates FOR EACH ROW
        BEGIN UPDATE meal_recurrence_templates SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE TRIGGER IF NOT EXISTS trg_meal_recurrence_ingredients_updated_at
        AFTER UPDATE ON meal_recurrence_ingredients FOR EACH ROW
        BEGIN UPDATE meal_recurrence_ingredients SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = OLD.id; END;

      CREATE INDEX IF NOT EXISTS idx_meal_recurrence_templates_weekday
        ON meal_recurrence_templates(weekday, start_date);
      CREATE INDEX IF NOT EXISTS idx_meal_recurrence_ingredients_template
        ON meal_recurrence_ingredients(template_id);
      CREATE INDEX IF NOT EXISTS idx_meals_recurrence_template
        ON meals(recurrence_template_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meals_recurrence_occurrence
        ON meals(recurrence_template_id, date)
        WHERE recurrence_template_id IS NOT NULL;
    `,
  };
