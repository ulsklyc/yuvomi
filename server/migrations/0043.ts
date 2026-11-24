export default {
    version: 43,
    description: 'Performance indexes: assignment lookups by user, loan-payment entries, recurring events',
    up: `
      -- "assigned to me" lookups: the PKs are (event_id|task_id, user_id),
      -- so a user_id-leading index is missing for filtering by assignee.
      CREATE INDEX IF NOT EXISTS idx_event_assignments_user
        ON event_assignments(user_id);
      CREATE INDEX IF NOT EXISTS idx_task_assignments_user
        ON task_assignments(user_id);

      -- budget month list LEFT JOINs loan payments on budget_entry_id (only
      -- loan_id and paid_date were indexed) -> probed with a scan per row.
      CREATE INDEX IF NOT EXISTS idx_budget_loan_payments_entry
        ON budget_loan_payments(budget_entry_id);

      -- calendar GET expands all recurring events; partial index keeps that
      -- scan to just the recurring rows instead of the full events table.
      CREATE INDEX IF NOT EXISTS idx_calendar_recurring
        ON calendar_events(start_datetime) WHERE recurrence_rule IS NOT NULL;

    `,
  };
