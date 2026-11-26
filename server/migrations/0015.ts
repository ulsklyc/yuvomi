export default {
    version: 15,
    description: 'Budget expense categories as stable keys with subcategories',
    up: `
      ALTER TABLE budget_entries ADD COLUMN subcategory TEXT NOT NULL DEFAULT '';

      UPDATE budget_entries
      SET category = CASE category
        WHEN 'Lebensmittel' THEN 'food'
        WHEN 'Miete' THEN 'housing'
        WHEN 'Versicherung' THEN 'financial_other'
        WHEN 'Mobilität' THEN 'transport'
        WHEN 'Freizeit' THEN 'leisure'
        WHEN 'Kleidung' THEN 'shopping_clothing'
        WHEN 'Gesundheit' THEN 'personal_health'
        WHEN 'Bildung' THEN 'education'
        WHEN 'Sonstiges' THEN 'financial_other'
        ELSE category
      END
      WHERE amount < 0;

      UPDATE budget_entries
      SET subcategory = CASE category
        WHEN 'housing' THEN 'rent_mortgage'
        WHEN 'food' THEN 'groceries'
        WHEN 'transport' THEN 'fuel'
        WHEN 'personal_health' THEN 'pharmacy'
        WHEN 'leisure' THEN 'events'
        WHEN 'shopping_clothing' THEN 'clothes_shoes'
        WHEN 'education' THEN 'courses_college'
        WHEN 'financial_other' THEN 'insurance_other'
        ELSE ''
      END
      WHERE amount < 0 AND subcategory = '';

      UPDATE budget_entries
      SET category = 'Sonstiges Einkommen'
      WHERE amount > 0 AND category = 'Sonstiges';
    `,
  };
