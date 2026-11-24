// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 35,
    description: 'Housekeeping per-worker sessions and calendar linkage',
    up: `
      ALTER TABLE housekeeping_workers ADD COLUMN calendar_color TEXT NOT NULL DEFAULT '#7C3AED';
      ALTER TABLE housekeeping_work_sessions ADD COLUMN worker_id INTEGER REFERENCES housekeeping_workers(id) ON DELETE SET NULL;
      ALTER TABLE housekeeping_work_sessions ADD COLUMN calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_worker ON housekeeping_work_sessions(worker_id);
      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_calendar ON housekeeping_work_sessions(calendar_event_id);
    `,
  };
