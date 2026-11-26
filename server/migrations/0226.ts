// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { log } from './helpers.ts';

export default {
    version: 226,
    description: 'Split: rebuild ledger rows of active expenses lost to an account deletion',
    // v225 hat den Autor der noch vorhandenen Ledger-Zeilen korrigiert; die
    // Zeilen, die ein Kontoloeschen vorher schon per created_by ON DELETE
    // CASCADE genommen hatte, konnte ein UPDATE nicht zurueckholen (#1382).
    // Eine aktive Ausgabe ohne eine einzige 'expense'-Zeile zaehlte seitdem in
    // keinem Saldo. Alle Zeilen einer Ausgabe entstehen gemeinsam mit einem
    // created_by und fallen deshalb nur gemeinsam - "keine Zeile" ist die Suche.
    //
    // Neu aufgebaut aus expenses + expense_splits nach der Regel von
    // insertExpenseLedger (server/routes/split-expenses.js), hier als SQL
    // EINGEFROREN: eine Migration laeuft auf dem Schema ihrer Version, ein
    // Aufruf der lebenden Funktion braeche sie, sobald die Regel eine spaetere
    // Spalte schreibt. test:split-ledger-rebuild-migration vergleicht beide
    // Fassungen; wird er rot, hat sich die Buchungsregel geaendert - diese
    // Migration dann NICHT anfassen.
    //
    // Nur aktive Ausgaben (geloeschte sind ohne Zeilen richtig), nur fehlende
    // Zeilen; ein zweiter Lauf findet nichts mehr. Das Log nennt Ausgabe und
    // Gruppe, damit ein Admin eine veraenderte Bilanz erklaeren kann.
    //
    // Die Gruppe sieht es selbst im Verlauf: je wiederhergestellter Ausgabe
    // genau ein Eintrag 'ledger_restored' (entity 'expense', actor_id NULL -
    // niemand hat gehandelt, die Oberflaeche zeigt "System"). metadata traegt
    // Titel und den gebuchten (umgerechneten) Betrag - als
    // {title, amount_minor, currency} und nicht wie payment_* als
    // {amount: Dezimal, currency}, weil eingefrorenes SQL die Nachkommastellen
    // je Waehrung (ISO 4217, server/services/split-expenses.js) nicht anwenden
    // kann; die Dezimalform ergaenzt GET /groups/:id/activity. Das Schema von
    // expense_activity ist hier dasselbe wie bei seiner Anlage in v39: keine
    // Spalte ist seitdem dazugekommen, und type hat keinen CHECK. Die Spalten
    // stehen ausdruecklich im INSERT, created_at kommt aus dem Default - eine
    // spaetere Spalte bricht das nur, wenn sie NOT NULL ohne Default ist, und
    // die verbietet .claude/rules/db-migrations.md ohnehin.
    up(db) {
      db.exec(`
        DROP TABLE IF EXISTS temp._v226_missing;
        CREATE TEMP TABLE _v226_missing AS
          SELECT e.id FROM expenses e
          WHERE e.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM expense_ledger_entries l
                            WHERE l.source_type = 'expense' AND l.source_id = e.id);
      `);
      const rebuilt = db.prepare(`
        SELECT e.id, e.group_id FROM expenses e JOIN _v226_missing m ON m.id = e.id ORDER BY e.id
      `).all();
      db.exec(`
        INSERT INTO expense_ledger_entries
          (group_id, source_type, source_id, user_id, counterparty_id, amount_minor, currency, memo, created_by)
        SELECT x.group_id, 'expense', x.id, x.user_id, x.counterparty_id, x.amount_minor, x.currency, x.title, x.created_by
        FROM (
          SELECT e.id, 0 AS ord, e.group_id, e.payer_id AS user_id, NULL AS counterparty_id,
                 e.converted_amount_minor AS amount_minor, e.converted_currency AS currency, e.title, e.created_by
          FROM expenses e JOIN _v226_missing m ON m.id = e.id
          UNION ALL
          SELECT e.id, s.id, e.group_id, s.user_id, e.payer_id, -s.amount_minor, s.currency, e.title, e.created_by
          FROM expenses e JOIN _v226_missing m ON m.id = e.id JOIN expense_splits s ON s.expense_id = e.id
        ) x
        ORDER BY x.id, x.ord;
        INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
        SELECT e.group_id, NULL, 'ledger_restored', 'expense', e.id,
               json_object('title', e.title, 'amount_minor', e.converted_amount_minor, 'currency', e.converted_currency)
        FROM expenses e JOIN _v226_missing m ON m.id = e.id
        ORDER BY e.id;
        DROP TABLE _v226_missing;
      `);
      for (const row of rebuilt) {
        log.info(`Rebuilt the ledger rows of shared expense ${row.id} in group ${row.group_id}; its balances change accordingly.`);
      }
    },
  };
