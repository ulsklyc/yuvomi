// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 235,
    description: 'Meal plan: one member as the cook of a meal and of a series (#1679)',
    // EINE MAHLZEIT KANNTE NUR, WER SIE EINGETRAGEN HAT (`created_by`), NICHT,
    // WER KOCHT (#1679, Discussion #1661). `cook_user_id` ist ein Verweis auf
    // eine Person des Haushalts wie `tasks.assigned_to`: eine Zustaendigkeit an
    // einem gemeinsamen Eintrag, kein Besitz - wer eine Mahlzeit sieht oder
    // aendert, haengt weiter allein am `meals`-Recht.
    //
    // ZWEI SPALTEN, WEIL EINE SERIE IHREN KOCH BEHAELT: die Vorlage traegt ihn,
    // und `materializeRecurringMeals` (server/routes/meals.js) kopiert ihn in
    // jede Mahlzeit, die aus ihr entsteht - ohne die Spalte an der Vorlage
    // ginge er beim Aufschlagen der naechsten Woche verloren.
    //
    // KEIN BACKFILL: NULL heisst "niemand gesetzt", und das ist jede Mahlzeit
    // von bisher. ON DELETE SET NULL: verschwindet das Konto, bleibt die
    // Mahlzeit ohne Koch stehen. Wer waehlbar ist, entscheidet nicht das
    // Schema, sondern `householdMemberSql()` an der Route (docs/DECISIONS.md,
    // Eintrag 4).
    //
    // Ein kuenftiger Rebuild von meals oder meal_recurrence_templates muss die
    // Spalte mitnehmen.
    up: `
      ALTER TABLE meals ADD COLUMN cook_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE meal_recurrence_templates ADD COLUMN cook_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `,
  };
