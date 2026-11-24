// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 182,
    description: 'Schedule: an optional icon alongside a shift type\'s color (#786 follow-up)',
    // Ein Lucide-Name wie ueberall sonst, wo ein Symbol erst zur Laufzeit
    // feststeht (quick-links, Kalender-Termine) - nullable, weil bestehende
    // Schichtarten schon ohne Icon leben und weiterhin duerfen.
    up: `
      ALTER TABLE schedule_shift_types ADD COLUMN icon TEXT;
    `,
  };
