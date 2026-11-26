// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 270,
    description: 'recipes: servings count',
    // Fuer wie viele Portionen die Mengen eines Rezepts gelten (R24, E12).
    // NULL heisst "nicht angegeben" - ein Bestandsrezept behauptet keine Zahl,
    // und die Oberflaeche rechnet dann in Vielfachen statt in Portionen.
    // Dieselbe Spalte, neben die docs/DECISIONS.md die Naehrwerte je Portion
    // stellt. Bewacht, weil reconcileCriticalSchema sie nicht nachtraegt und
    // ein zweiter Lauf auf einer gedrifteten Datenbank sonst scheiterte.
    up(database) {
      const has = database.prepare('PRAGMA table_info(recipes)').all().some((c) => c.name === 'servings');
      if (!has) {
        database.exec('ALTER TABLE recipes ADD COLUMN servings INTEGER CHECK (servings IS NULL OR servings BETWEEN 1 AND 99)');
      }
    },
  };
