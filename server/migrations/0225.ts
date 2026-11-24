// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 225,
    description: 'Split: ledger rows carry the author of the record they book',
    up: `
      -- Ledger-Zeilen und der Datensatz, den sie buchen, haengen per
      -- created_by ON DELETE CASCADE an einem Konto. Stand dort eine andere
      -- Person als am Datensatz, riss eine Kontoloeschung das Paar
      -- auseinander (#1309): ein PUT /expenses/:id stempelte die neu
      -- geschriebenen Zeilen mit der BEARBEITENDEN Person, das Loeschen ihres
      -- Kontos nahm sie mit, und die weiter aktive Ausgabe fiel still aus
      -- allen Salden. Die Route schreibt seit dieser Version
      -- expenses.created_by; hier werden die schon geschriebenen Zeilen
      -- nachgezogen. Nur UPDATE, und nur wo sich etwas unterscheidet - ein
      -- zweiter Lauf findet nichts mehr.
      --
      -- expense_reversal gehoert dazu: eine Gegenbuchung einer Ausgabe teilt
      -- source_id und damit expenses.created_by mit ihrer Buchung - blieben
      -- nur die 'expense'-Zeilen im Blick, risse diese Migration genau so ein
      -- Paar auseinander.
      --
      -- Nicht angefasst: Zeilen ohne ihre Ausgabe (source_id ist kein echter
      -- Fremdschluessel, es gibt also keinen Ersteller, den man eintragen
      -- koennte) und eine Ausgabe ohne created_by (die Spalte ist NOT NULL,
      -- der Filter haelt das nur fest, statt eine NULL in eine NOT-NULL-Spalte
      -- zu schreiben), und ein Autor, den es in users nicht gibt (der
      -- Fremdschluessel wuerde beim Serverstart werfen). Ledger-Zeilen, deren Bearbeiter schon geloescht ist,
      -- gibt es nicht mehr - die hat die Kaskade genommen, und ein UPDATE kann
      -- sie nicht zurueckholen.
      UPDATE expense_ledger_entries
      SET created_by = (SELECT e.created_by FROM expenses e WHERE e.id = expense_ledger_entries.source_id)
      WHERE source_type IN ('expense', 'expense_reversal')
        AND EXISTS (
          SELECT 1 FROM expenses e
          WHERE e.id = expense_ledger_entries.source_id
            AND e.created_by IS NOT NULL
            AND e.created_by <> expense_ledger_entries.created_by
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.created_by)
        );

      -- Dasselbe fuer das Storno einer Zahlung: die Gegenbuchung
      -- (settlement_reversal) trug die STORNIERENDE Person, die Buchung
      -- (settlement) die erfassende. Beide Zeilen einer Buchung tragen
      -- dieselbe Person (sie entstehen in einem Request); die Gegenbuchung
      -- bekommt deren created_by. Eine Gegenbuchung ohne Buchung bleibt, wie
      -- sie ist - es gibt keinen Partner, dessen Autor sie uebernehmen koennte.
      UPDATE expense_ledger_entries
      SET created_by = (
        SELECT s.created_by FROM expense_ledger_entries s
        WHERE s.source_type = 'settlement' AND s.source_id = expense_ledger_entries.source_id
        ORDER BY s.id ASC LIMIT 1
      )
      WHERE source_type = 'settlement_reversal'
        AND EXISTS (
          SELECT 1 FROM expense_ledger_entries s
          WHERE s.source_type = 'settlement' AND s.source_id = expense_ledger_entries.source_id
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = s.created_by)
        )
        AND created_by <> (
          SELECT s.created_by FROM expense_ledger_entries s
          WHERE s.source_type = 'settlement' AND s.source_id = expense_ledger_entries.source_id
          ORDER BY s.id ASC LIMIT 1
        );
    `,
  };
