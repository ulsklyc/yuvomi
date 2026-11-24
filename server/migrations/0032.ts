// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 32,
    description: 'Multi-person assignment for tasks and calendar events',
    up: `
      CREATE TABLE IF NOT EXISTS task_assignments (
        task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS event_assignments (
        event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (event_id, user_id)
      );
      INSERT OR IGNORE INTO task_assignments (task_id, user_id)
        SELECT id, assigned_to FROM tasks WHERE assigned_to IS NOT NULL;
      INSERT OR IGNORE INTO event_assignments (event_id, user_id)
        SELECT id, assigned_to FROM calendar_events WHERE assigned_to IS NOT NULL;
    `,
  };
