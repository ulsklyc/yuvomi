// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 181,
    description: 'Budget: materialisierte Serien-Instanzen erben das Konto ihrer Serie nach (#973)',
    // Der Code-Fix in generateRecurringInstances wirkt nur auf NEUE Zeilen. Jeder
    // Monat, der vor dem Update schon einmal geoeffnet wurde, traegt seine
    // Instanzen bereits - mit account_id NULL, und die Materialisierung
    // ueberspringt vorhandene Zeilen. Ohne diese Nachbesserung bliebe der
    // gemeldete Fehler fuer genau die Daten stehen, an denen er aufgefallen ist.
    //
    // BEWUSST EINMALIG statt im Lesepfad: eine Regel "Instanz erbt das Konto der
    // Serie", die bei jedem Lesen greift, koennte nie wieder unterschieden werden
    // von "diese eine Buchung lief ausdruecklich ueber kein Konto". Einmal
    // reparieren laesst das Modell danach in Ruhe.
    //
    // Drei Einschraenkungen, jede mit Grund:
    //   - nur Instanzen (recurrence_parent_id IS NOT NULL); das Original ist eine
    //     von Hand angelegte Buchung und hat sein Konto immer selbst getragen.
    //   - nur wo bisher NULL steht; ein abweichend gesetztes Konto ist eine
    //     Entscheidung und wird nicht ueberschrieben.
    //   - NICHT bei virtuellen Serien: deren Instanzen sind geglaettete
    //     Planwerte, und ein Konto an ihnen bewegte den Kontosaldo fuer eine
    //     Abbuchung, die so nie stattfindet.
    up: `
      UPDATE budget_entries
      SET account_id = (
        SELECT p.account_id FROM budget_entries p
        WHERE p.id = budget_entries.recurrence_parent_id
      )
      WHERE recurrence_parent_id IS NOT NULL
        AND account_id IS NULL
        AND EXISTS (
          SELECT 1 FROM budget_entries p
          WHERE p.id = budget_entries.recurrence_parent_id
            AND p.account_id IS NOT NULL
            AND p.recurrence_virtual = 0
        );
    `,
  };
