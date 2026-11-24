export default {
    version: 84,
    description: 'Contact categories as a customizable, sortable table with icons (#357)',
    up: `
      -- Kontakt-Kategorien werden verwaltbar. Bestands-Kategorien wechseln von
      -- deutschen Namens-Strings ('Arzt') zu stabilen Keys ('doctor'), die zugleich
      -- den CSS-Farb-Slug (.contact-group--doctor) und (über label_key) die
      -- Lokalisierung tragen. icon speichert das Lucide-Icon je Kategorie.
      CREATE TABLE IF NOT EXISTS contact_categories (
        key        TEXT    PRIMARY KEY,
        name       TEXT,
        label_key  TEXT,
        icon       TEXT    NOT NULL DEFAULT 'tag',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      INSERT OR IGNORE INTO contact_categories (key, name, label_key, icon, sort_order) VALUES
        ('doctor',    NULL, 'contacts.categoryDoctor',    'stethoscope',    0),
        ('school',    NULL, 'contacts.categorySchool',    'graduation-cap', 1),
        ('authority', NULL, 'contacts.categoryAuthority', 'landmark',       2),
        ('insurance', NULL, 'contacts.categoryInsurance', 'shield',         3),
        ('craftsman', NULL, 'contacts.categoryCraftsman', 'wrench',         4),
        ('emergency', NULL, 'contacts.categoryEmergency', 'siren',          5),
        ('misc',      NULL, 'contacts.categoryOther',     'tag',            6);

      -- Bestandswerte (deutsche Namen) auf stabile Keys migrieren.
      UPDATE contacts SET category = CASE category
        WHEN 'Arzt'         THEN 'doctor'
        WHEN 'Schule/Kita'  THEN 'school'
        WHEN 'Behörde'      THEN 'authority'
        WHEN 'Versicherung' THEN 'insurance'
        WHEN 'Handwerker'   THEN 'craftsman'
        WHEN 'Notfall'      THEN 'emergency'
        WHEN 'Sonstiges'    THEN 'misc'
        ELSE category
      END;
      UPDATE contacts SET category = 'misc' WHERE category IS NULL OR category = '';

      -- Verbliebene freie Werte als Custom-Kategorien übernehmen (Daten erhalten).
      INSERT OR IGNORE INTO contact_categories (key, name, label_key, icon, sort_order)
      SELECT category, category, NULL, 'tag', 1000
      FROM contacts
      WHERE category IS NOT NULL AND category != ''
        AND category NOT IN (SELECT key FROM contact_categories)
      GROUP BY category;
    `,
  };
