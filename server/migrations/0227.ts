// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { log } from './helpers.ts';

export default {
    version: 227,
    description: 'Split: remove ledger rows of expenses that no longer exist',
    // Das Gegenstueck zu v226 (#1445): bis v225 stempelte PUT /expenses/:id
    // die Ledger-Zeilen mit der BEARBEITENDEN Person. Wurde danach das Konto
    // geloescht, das die Ausgabe angelegt hatte, nahm expenses.created_by
    // ON DELETE CASCADE Ausgabe und Anteile, die Zeilen (am Bearbeiter)
    // blieben. Die Salden summieren das Ledger ohne Blick auf expenses - die
    // Zeilen verschoben sie weiter, und keine Liste zeigte eine Ausgabe, die
    // das erklaert. v225 hat sie bewusst liegen lassen (kein Autor, den man
    // eintragen koennte), v226 baut nur fuer existierende Ausgaben auf.
    //
    // Seit v225 tragen die Zeilen expenses.created_by und fallen mit der
    // Ausgabe; neue Waisen entstehen nicht mehr, es ist ein endlicher
    // Altbestand. Darum hier einmal entfernt statt dauerhaft in jeder
    // Saldenabfrage herausgefiltert. Nebenbei haelt eine Waise ueber
    // user_id ON DELETE RESTRICT kein Konto mehr fest.
    //
    // Massstab ist "die expenses-Zeile EXISTIERT", nicht "sie ist aktiv": eine
    // geloeschte Ausgabe behaelt ihre Zeile in expenses, und wer ihre
    // Buchung samt Gegenbuchung (expense_reversal, #1382) haelt, verliert sie
    // hier nicht. source_type gehoert in jede Abfrage - Zahlungen zaehlen ihre
    // source_id in einem anderen Namensraum.
    //
    // Die Spur bleibt: je entfernter Ausgabe ein Log (Ausgabe, Gruppe) und
    // genau ein Verlaufseintrag 'ledger_removed' in ihrer Gruppe, gleiche Form
    // wie 'ledger_restored' in v226 (actor_id NULL, metadata {title,
    // amount_minor, currency}; die Dezimalform ergaenzt GET
    // /groups/:id/activity). Titel und Betrag kommen aus der Zahler-Zeile
    // (counterparty_id NULL): memo ist der Titel, amount_minor der gebuchte
    // (umgerechnete) Gesamtbetrag. Fehlt sie, nennt der Eintrag nur den Titel
    // irgendeiner Zeile. Ein zweiter Lauf findet nichts mehr.
    up(db) {
      db.exec(`
        DROP TABLE IF EXISTS temp._v227_orphans;
        CREATE TEMP TABLE _v227_orphans AS
          SELECT DISTINCT l.group_id, l.source_id AS id
          FROM expense_ledger_entries l
          WHERE l.source_type IN ('expense', 'expense_reversal')
            AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = l.source_id);
      `);
      const removed = db.prepare('SELECT id, group_id FROM _v227_orphans ORDER BY id, group_id').all();
      db.exec(`
        INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
        SELECT o.group_id, NULL, 'ledger_removed', 'expense', o.id,
               CASE WHEN p.id IS NULL
                 THEN json_object('title', (
                   SELECT x.memo FROM expense_ledger_entries x
                   WHERE x.source_type IN ('expense', 'expense_reversal')
                     AND x.source_id = o.id AND x.group_id = o.group_id
                   ORDER BY x.id LIMIT 1))
                 ELSE json_object('title', p.memo, 'amount_minor', p.amount_minor, 'currency', p.currency)
               END
        FROM _v227_orphans o
        LEFT JOIN expense_ledger_entries p ON p.id = (
          SELECT MIN(y.id) FROM expense_ledger_entries y
          WHERE y.source_type = 'expense' AND y.source_id = o.id AND y.group_id = o.group_id
            AND y.counterparty_id IS NULL)
        ORDER BY o.id, o.group_id;
        DELETE FROM expense_ledger_entries
        WHERE source_type IN ('expense', 'expense_reversal')
          AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_ledger_entries.source_id);
        DROP TABLE _v227_orphans;
      `);
      for (const row of removed) {
        log.info(`Removed the ledger rows of shared expense ${row.id} in group ${row.group_id}: the expense no longer exists, and the group's balances change accordingly.`);
      }
    },
  };
