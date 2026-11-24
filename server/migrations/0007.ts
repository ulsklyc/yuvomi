export default {
    version: 7,
    description: 'Category per ingredient for shopping list transfer',
    up: `
      ALTER TABLE meal_ingredients ADD COLUMN category TEXT NOT NULL DEFAULT 'Sonstiges';
    `,
  };
