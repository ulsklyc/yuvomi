// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 41,
    description: 'Start date for tasks (scheduled / future tasks)',
    up: `
      ALTER TABLE tasks ADD COLUMN start_date TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_start_date ON tasks(start_date);
    `,
  };
