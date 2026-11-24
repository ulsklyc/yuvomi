// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 149,
    description: 'comments on tasks (#734)',
    up: `
      -- Discussion #734: über eine Aufgabe wird geredet - bisher woanders.
      -- Das Vorbild steht im selben Schema: expense_comments (Migration 44)
      -- führt dieselben vier Spalten für die geteilten Ausgaben.
      --
      -- Abweichung an einer Stelle: updated_at. Ein Kommentar ist Fließtext, in
      -- dem sich vertippt wird, und ein stillschweigend geänderter Beitrag ist
      -- in einer Unterhaltung etwas anderes als ein korrigierter Betrag. Die
      -- Spalte bleibt NULL, solange niemand nachbessert - so trägt nur der
      -- geänderte Kommentar den Hinweis.
      --
      -- CASCADE auf beiden Wegen, wie beim Vorbild: mit der Aufgabe geht ihre
      -- Unterhaltung, mit dem Konto gehen dessen Beiträge.
      CREATE TABLE IF NOT EXISTS task_comments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    INTEGER NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
        comment    TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT
      );

      -- Gelesen wird immer je Aufgabe und in Reihenfolge.
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
    `,
  };
