// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 136,
    description: 'Outbound target for locally created tasks (CalDAV reminder list, #695)',
    up: `
      -- Mirrors the shape calendar events have carried since the CalDAV sync was
      -- built (target_caldav_account_id + target_caldav_calendar_url): a locally
      -- created row names where it wants to go, and the sync run uploads it and
      -- turns it into a mirror. Without a target nothing changes - a task with
      -- NULL here stays local, which is every task that exists today.
      ALTER TABLE tasks ADD COLUMN target_caldav_account_id INTEGER;
      ALTER TABLE tasks ADD COLUMN target_caldav_list_url   TEXT;

      CREATE INDEX idx_tasks_target_caldav
        ON tasks(target_caldav_account_id)
        WHERE target_caldav_account_id IS NOT NULL;
    `,
  };
