// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 152,
    description: 'contact categories carry their own colour instead of a css name list',
    up: `
      -- DER TON EINER KATEGORIE GEHOERT IN DIE DATEN, NICHT IN EINE
      -- SELEKTORLISTE. Er stand als sieben Regeln \`.contact-group--<key>\` in
      -- contacts.css, und der Selektor kann per Konstruktion nur die
      -- SEED-Schluessel treffen: seit #357 legt der Haushalt eigene Kategorien
      -- an, und die fielen deshalb alle auf den Modulton zurueck - im
      -- Demo-Haushalt sahen "Familie" und "Dienstleistungen" gleich aus. Eine
      -- Farbe, die zwei Dinge meint, ist keine (Vollton-Regel, DESIGN.md).
      --
      -- GESPEICHERT WIRD DER TOKEN-AUSDRUCK, NICHT EIN HEX-WERT, und das ist
      -- keine Bequemlichkeit: die sieben Toene sind THEMENABHAENGIG
      -- (--color-success ist #1E7B35 im Light und #30D158 im Dark). Ein Hex in
      -- der Datenbank koennte den Dunkelmodus nicht bedienen. Dasselbe Muster
      -- fuehren die Kontofarben des Budgets seit ihrer Einfuehrung
      -- (\`var(--chart-series-2)\` als gespeicherter Wert).
      --
      -- NULL heisst NEUTRAL, nicht "Vorgabe": eine Kategorie ohne kuratierten
      -- Ton traegt bewusst keine Farbe, statt sich eine zu borgen.
      ALTER TABLE contact_categories ADD COLUMN color TEXT;

      UPDATE contact_categories SET color = 'var(--color-success)'      WHERE key = 'doctor'    AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--color-warning)'      WHERE key = 'school'    AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--color-accent)'       WHERE key = 'authority' AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--module-budget)'      WHERE key = 'insurance' AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--module-meals)'       WHERE key = 'craftsman' AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--color-danger)'       WHERE key = 'emergency' AND color IS NULL;
      UPDATE contact_categories SET color = 'var(--color-text-secondary)' WHERE key = 'misc'    AND color IS NULL;
    `,
  };
