// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 62,
    description: 'restore reminders.pushed_at dropped by the migration 57 table rebuild',
    up: `
      ALTER TABLE reminders ADD COLUMN pushed_at TEXT;
    `,
  };
