// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 9,
    description: 'Migrate task categories to English keys',
    up: `
      UPDATE tasks SET category = CASE category
        WHEN 'Haushalt'   THEN 'household'
        WHEN 'Schule'     THEN 'school'
        WHEN 'Einkauf'    THEN 'shopping'
        WHEN 'Reparatur'  THEN 'repair'
        WHEN 'Gesundheit' THEN 'health'
        WHEN 'Finanzen'   THEN 'finance'
        WHEN 'Freizeit'   THEN 'leisure'
        WHEN 'Sonstiges'  THEN 'misc'
        ELSE category
      END;
    `,
  };
