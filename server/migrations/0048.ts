// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 48,
    description: 'Housekeeping hourly billing: rate_type, hourly_rate, minutes_worked',
    up: `
      ALTER TABLE housekeeping_workers ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'daily'
        CHECK(rate_type IN ('daily', 'hourly'));
      ALTER TABLE housekeeping_workers ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0 CHECK(hourly_rate >= 0);

      ALTER TABLE housekeeping_work_sessions ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'daily';
      ALTER TABLE housekeeping_work_sessions ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0;
      ALTER TABLE housekeeping_work_sessions ADD COLUMN minutes_worked INTEGER;
    `,
  };
