// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 230,
    description: 'Rewards: reversal instead of deletion on reopen, series id on tasks and earnings (#1607, #1603)',
    // DER LEDGER LÖSCHT NICHT MEHR (#1607). Bis hierher nahm das Wiederöffnen
    // einer erledigten Aufgabe ihre earn-Zeile aus reward_ledger - entgegen dem
    // Satz in v70, jede Zeile sei unveränderlich und nachvollziehbar. Ab jetzt
    // bleibt die earn-Zeile stehen und die Rücknahme ist eine eigene Zeile
    // (Typ 'reversal', negatives Delta, dieselbe task_id); der Satz aus v70
    // stimmt damit erst seit dieser Migration.
    //
    // DAFÜR MUSS uniq_reward_earn FALLEN. Der partielle UNIQUE-Index
    // (task_id, user_id) WHERE type = 'earn' ließ je Aufgabe und Person genau
    // eine earn-Zeile zu. Bleibt die erste stehen, wäre das erneute Erledigen
    // nach dem Wiederöffnen eine zweite - und der Index hätte sie abgewiesen:
    // die Punkte wären nach einmal Hin und Her für immer weg. Die Idempotenz
    // der Vergabe steht seitdem im Code, über den Netto-Stand der Aufgabe je
    // Person (awardForCompletion in server/services/rewards.js).
    //
    // DER ERSATZINDEX IST NICHT EINDEUTIG und trägt genau diese Netto-Frage:
    // sie liest je Statuswechsel die Buchungen einer Aufgabe, und ohne ihn
    // wäre das ein Lauf über den ganzen Ledger. Ein künftiger Rebuild von
    // reward_ledger muss ihn mit anlegen - und darf uniq_reward_earn NICHT
    // wieder anlegen.
    //
    // KEIN BACKFILL: earn-Zeilen, die frühere Versionen beim Wiederöffnen
    // gelöscht haben, sind weg, und aus dem Bestand lässt sich nicht ablesen,
    // welche es gab. Die Salden bleiben, wie sie sind.
    //
    // DREI SPALTEN, DIE DAS LOESCHEN EINER AUFGABE UEBERLEBEN (#1603, #1607).
    // reward_ledger.task_id und tasks.recurrence_origin_id sind beide ON DELETE
    // SET NULL: wird eine erledigte Aufgabe geloescht, weiss die Gutschrift
    // nicht mehr, wofuer sie war, und die Folgeinstanz nicht mehr, woher sie
    // kommt. Alles, was ueber diese Verweise fragt, wird dann blind.
    //   - tasks.recurrence_series_id: die ID des ERSTEN Vorkommens einer Serie,
    //     beim Anlegen jeder Folgeinstanz (und jeder kopierten Teilaufgabe) als
    //     Wert uebernommen. NULL = die Aufgabe ist selbst ein erstes Vorkommen,
    //     oder sie stammt von vor dieser Migration (dann gilt die Wurzel der
    //     Kette, seriesOfTask in server/services/rewards.js).
    //   - reward_ledger.series_id: dieselbe Kennung an der Gutschrift. Der
    //     Deckel "eine Gutschrift je Serie, Person und Haushaltstag" fragt den
    //     Ledger direkt danach. NULL an Zeilen von vor dieser Migration und an
    //     allem, was keine Gutschrift fuer eine Aufgabe ist.
    //   - reward_ledger.reverses_id: an einer Gegenbuchung die ID der
    //     Gutschrift, die sie zuruecknimmt.
    // Keine Fremdschluessel: die Werte sollen gerade dann stehen bleiben, wenn
    // das, worauf sie zeigen, verschwindet. Ein kuenftiger Rebuild von tasks
    // oder reward_ledger muss die Spalten und ihre Indizes mitnehmen.
    //
    // KEIN BACKFILL DER KENNUNGEN: der Deckel ist neu, vor dieser Migration hat
    // nichts gesperrt, also fehlt auch nichts. Offene Folgeinstanzen aus dem
    // Bestand finden ihre Serie ueber die Kette und geben sie beim naechsten
    // Abhaken als Wert weiter.
    //
    // Idempotent: Indizes ueber IF (NOT) EXISTS, Spalten nur, wenn sie fehlen.
    up(db) {
      db.exec(`
        DROP INDEX IF EXISTS uniq_reward_earn;
        CREATE INDEX IF NOT EXISTS idx_reward_ledger_task ON reward_ledger(task_id, user_id);
      `);
      const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
      if (!has('tasks', 'recurrence_series_id')) db.exec('ALTER TABLE tasks ADD COLUMN recurrence_series_id INTEGER');
      if (!has('reward_ledger', 'series_id')) db.exec('ALTER TABLE reward_ledger ADD COLUMN series_id INTEGER');
      if (!has('reward_ledger', 'reverses_id')) db.exec('ALTER TABLE reward_ledger ADD COLUMN reverses_id INTEGER');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_reward_ledger_series ON reward_ledger(series_id, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_reward_ledger_reverses ON reward_ledger(reverses_id);
      `);
    },
  };
