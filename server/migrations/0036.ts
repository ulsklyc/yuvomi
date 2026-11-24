export default {
    version: 36,
    description: 'Housekeeping payment task linkage',
    up: `
      ALTER TABLE housekeeping_work_sessions ADD COLUMN payment_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_housekeeping_sessions_payment_task ON housekeeping_work_sessions(payment_task_id);
    `,
  };
