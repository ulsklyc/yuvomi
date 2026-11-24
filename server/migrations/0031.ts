// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 31,
    description: 'Advanced reminder options for birthdays',
    up: `
      ALTER TABLE birthdays ADD COLUMN reminder_offset TEXT;
      ALTER TABLE birthdays ADD COLUMN reminder_custom_amount INTEGER;
      ALTER TABLE birthdays ADD COLUMN reminder_custom_unit TEXT;
    `,
  };
