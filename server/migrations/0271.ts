// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 271,
    description: 'split expenses: budget category',
    // Die Aufteilung nimmt die Kategorien des Budgets (R24, E12; Critique
    // G4-Aufteilung-P2-6). Bis hier fuehrte sie eine eigene Liste von zwoelf
    // Schluesseln (groceries, rent ...) mit Icon-Mulden neben den
    // Budget-Kategorien mit Farbpunkt - zwei Codierungen fuer dieselbe Frage.
    // `budget_category` ist der Schluessel aus budget_categories, NULL heisst
    // "ohne Kategorie". Die alte Spalte `category` bleibt stehen: die
    // /api/v1-Oberflaeche liefert und nimmt sie weiter (zugesagt), die
    // Oberflaeche liest sie nicht mehr.
    // Der Bestand wird uebertragen, wo ein Budget-Schluessel die Frage traegt;
    // baby, pets und general haben keinen und bleiben ohne Kategorie, statt
    // eine falsche zu behaupten. Ein Ziel, das ein Haushalt im Budget geloescht
    // hat, wird nicht gesetzt. Bewacht (Spalte nur, wenn sie fehlt; nur leere
    // Zellen), damit ein zweiter Lauf auf einer gedrifteten Datenbank weder
    // scheitert noch eine spaetere Wahl ueberschreibt.
    up(database) {
      const map = [
        ['groceries', 'food'], ['rent', 'housing'], ['utilities', 'housing'], ['home', 'housing'],
        ['school', 'education'], ['travel', 'leisure'], ['subscriptions', 'leisure'],
        ['shopping', 'shopping_clothing'], ['health', 'personal_health'],
      ];
      const hasBudgetCategories = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'budget_categories'").get();
      for (const table of ['expenses', 'recurring_expenses']) {
        const cols = database.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.length) continue;
        if (!cols.some((c) => c.name === 'budget_category')) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN budget_category TEXT`);
        }
        if (!hasBudgetCategories) continue;
        const update = database.prepare(`
          UPDATE ${table} SET budget_category = @to
           WHERE category = @from AND budget_category IS NULL
             AND EXISTS (SELECT 1 FROM budget_categories WHERE key = @to AND type = 'expense')`);
        for (const [from, to] of map) update.run({ from, to });
      }
    },
  };
