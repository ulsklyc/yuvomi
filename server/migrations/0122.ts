// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 122,
    description: 'Tasks: link a recurring follow-up instance to the completion that created it (#650)',
    up: `
      -- Ohne diese Spur ist das Abhaken einer Serie nicht umkehrbar: die beim
      -- Erledigen erzeugte Folgeinstanz war von einer regulaeren Aufgabe nicht
      -- zu unterscheiden, blieb beim Zuruecknehmen stehen und stand dann neben
      -- der wieder geoeffneten Aufgabe (#650). parent_task_id kann das nicht
      -- tragen, das bedeutet "Unteraufgabe".
      ALTER TABLE tasks ADD COLUMN recurrence_origin_id INTEGER
        REFERENCES tasks(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_origin
        ON tasks(recurrence_origin_id) WHERE recurrence_origin_id IS NOT NULL;
    `,
  };
