// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 63,
    description: 'Remove existing family members incorrectly added to split_expense_guest_users',
    up: `
      DELETE FROM split_expense_guest_users
      WHERE user_id NOT IN (
        SELECT DISTINCT entity_id FROM expense_activity
        WHERE type = 'guest_created' AND entity_type = 'member' AND entity_id IS NOT NULL
      );
    `,
  };
