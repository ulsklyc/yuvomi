export default {
    version: 233,
    description: 'Budget loans: an optional due day of the month (#1631)',
    // EIN DARLEHEN KENNT DEN MONAT SEINER RATE, ABER KEINEN TAG (#1631). "Als
    // bezahlt markieren" datierte die Rate deshalb auf den Tag des Tippens: bei
    // einem Einzug am 27. landete sie am 25. oder am 2. des Folgemonats, im
    // zweiten Fall im falschen Budgetmonat. `due_day` ist der Tag im Monat,
    // 1 bis 31; in kuerzeren Monaten gilt der letzte Tag - das Klemmen steht
    // einmal, in `dueDateInMonth()` (server/routes/budget/helpers.js).
    //
    // NULL = kein Faelligkeitstag, also das Verhalten bis hierher. KEIN
    // BACKFILL: kein Bestandsdarlehen hat je einen Tag genannt, und
    // `budget_loan_payments` bleibt, wie es ist - gebuchte Raten behalten ihr
    // Datum, auch wenn der Tag spaeter gesetzt oder geaendert wird.
    //
    // Der CHECK geht mit ADD COLUMN, weil die Spalte NULL als Default hat und
    // der Ausdruck NULL zulaesst (SQLite prueft ihn beim Hinzufuegen gegen den
    // Bestand). `typeof` steht dabei, weil INTEGER-Affinitaet 1.5 als REAL
    // stehen laesst und BETWEEN es durchliesse.
    //
    // Ein kuenftiger Rebuild von budget_loans muss die Spalte samt CHECK
    // mitnehmen.
    up: `
      ALTER TABLE budget_loans ADD COLUMN due_day INTEGER
        CHECK (due_day IS NULL OR (typeof(due_day) = 'integer' AND due_day BETWEEN 1 AND 31));
    `,
  };
