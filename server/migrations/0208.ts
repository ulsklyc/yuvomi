// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 208,
    description: 'Schedule: an explicit toggle to turn overtime tracking off entirely (UX audit S-24)',
    up: `
      -- NULL/1 = an (Vorgabe, kein stiller Verhaltenswechsel fuer Bestandshaushalte),
      -- 0 = aus. Ein eigener Schalter statt schedule_weekly_hours selbst auf 0 zu
      -- erlauben: 0 als "aus" gelesen zwingt jede lesende Stelle, sich diese
      -- Sonderbedeutung zu merken, und ein Sollwert von 0 Stunden ist ohnehin keine
      -- gueltige Vollzeit-/Teilzeit-Angabe (der Server weist 0 seit jeher als
      -- ungueltig zurueck - das bewusst NICHT umgedeutet, siehe PLAN.md D-C).
      ALTER TABLE users ADD COLUMN schedule_overtime_enabled INTEGER;
    `,
  };
