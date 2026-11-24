export default {
    version: 262,
    description: 'notes: a visibility of their own and a lock on a single note (#1514, #1602)',
    up: `
      -- SICHTBARKEIT (#1514): 'all' (der Haushalt) oder 'private' (nur wer sie
      -- angelegt hat), dieselben Woerter wie Aufgaben und Termine (DECISIONS 5).
      -- Default 'all': jede bestehende Notiz bleibt, wer sie bisher sah.
      ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all'
        CHECK (visibility IN ('all', 'private'));
      -- SPERRE (#1602): 1 = nur Ersteller:in und Admins aendern die Notiz,
      -- auch ihre Checklisten-Haken. Default 0, also wie bisher.
      ALTER TABLE notes ADD COLUMN locked INTEGER NOT NULL DEFAULT 0
        CHECK (locked IN (0, 1));
    `,
  };
