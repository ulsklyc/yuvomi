// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 6,
    description: 'Recipe URL for meals',
    up: `
      ALTER TABLE meals ADD COLUMN recipe_url TEXT;
    `,
  };
