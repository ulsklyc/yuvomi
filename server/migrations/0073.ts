// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 73,
    description: 'recipe meal type suitability for planner integrations',
    up: `
      ALTER TABLE recipes ADD COLUMN meal_types TEXT NOT NULL DEFAULT 'breakfast,lunch,dinner,snack';
    `,
  };
