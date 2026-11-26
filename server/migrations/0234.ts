// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

import { todayKey } from '../utils/timezone.js';
import { addMonthsClamped, liftToAnchorDay } from '../utils/interval-date.js';

export default {
    version: 234,
    description: 'Recurring shared expenses: the series keeps its anchor day (#1721)',
    // EINE SERIE KANNTE NUR IHREN NAECHSTEN TERMIN, NICHT DEN TAG, FUER DEN SIE
    // GEDACHT IST (#1721). Der Lauf rueckte mit `setUTCMonth(+1)` weiter: der
    // 31.01. lief in den Maerz ueber (03.03.), der Februar blieb ohne Buchung,
    // und weil der naechste Schritt vom uebergelaufenen Datum ausging, stand
    // die Serie danach fuer immer am 1., 2. oder 3. `anchor_day` ist der Tag im
    // Monat, 1 bis 31; der Schritt klemmt in kuerzeren Monaten aufs Monatsende
    // und hebt danach wieder auf diesen Tag (addInterval in
    // server/services/split-expenses-scheduler.js).
    //
    // BESTAND, SCHRITT 1 - JEDE Serie bekommt den Tag ihres heutigen
    // `next_run_date`. Das ist fuer fast alle die Wahrheit und fuer den Rest das
    // Verhalten von bisher.
    //
    // BESTAND, SCHRITT 2 - ZURUECKGESTELLT WIRD NUR, WAS BELEGT IST. Eine Zeile
    // am 1. bis 3. sagt nicht, ob sie dort angelegt wurde oder dort ankam. Der
    // Beleg ist die ERSTE aus der Serie gebuchte Ausgabe (kleinste id mit
    // `expenses.recurring_rule_id`): der Lauf hat ihr den ersten Termin als
    // Datum gegeben. Belegt ist die Drift, wenn
    //   - monatlich: jene Ausgabe am 29., 30. oder 31. liegt und der Termin
    //     heute hoechstens so weit im Monat steht, wie der Ueberlauf ihn tragen
    //     konnte (29 -> 1; 30 -> 1, 2; 31 -> 1, 2, 3);
    //   - jaehrlich: jene Ausgabe an einem 29.02. liegt und der Termin heute an
    //     einem 01.03.;
    //   - und die Ausgabe vor dem Termin liegt, nicht geloescht ist und NIE
    //     BEARBEITET wurde.
    // Ist die erste Ausgabe geloescht (die App markiert sie nur) oder ganz weg
    // (dann ist die "erste" eine spaetere, schon gedriftete), gibt es keinen
    // Beleg und keine Reparatur. Woechentliche Serien driften nicht.
    //
    // BEARBEITET: `PUT /expenses/:id` kann das Datum einer Serienbuchung
    // aendern. Eine Serie, die wirklich am 01.06. angelegt und deren erste
    // Ausgabe auf den 31.05. umdatiert wurde, saehe aus wie eine Drift. Zwei
    // Spuren, jede fuer sich genug: der Verlaufseintrag `expense_edited`, den
    // die Route seit dem ersten Tag der geteilten Ausgaben in derselben
    // Transaktion schreibt (und den nichts loescht ausser der Gruppe selbst),
    // und `updated_at <> created_at` - der Trigger bewegt es bei jedem UPDATE,
    // sieht aber eine Bearbeitung in der Sekunde des Anlegens nicht. Beide,
    // weil eine echte Drift, die stehen bleibt, der kleinere Schaden ist als
    // eine echte Serie, die verstellt wird. WAS die Bearbeitung geaendert hat
    // (nur den Titel?), steht nirgends: jede zaehlt.
    //
    // Dann: Anker = Tag jener Ausgabe, und der Termin geht auf den Anker,
    // geklemmt aufs Monatsende - und zwar
    //   - in den Monat NACH der letzten Buchung der Serie, wenn der Termin dort
    //     nicht vergangen ist und vor dem gedrifteten liegt. Das ist der
    //     ausgelassene Monat, solange er noch vor uns liegt (letzte Buchung
    //     31.10., Termin 01.12., Migration am 10.11. -> 30.11.);
    //   - sonst in den Monat des gedrifteten Termins (jaehrlich: in den Februar
    //     desselben Jahres), mit den zwei Riegeln unten.
    // Jaehrlich gibt es den ersten Weg nicht: der Ueberlauf vom 29.02. auf den
    // 01.03. laesst kein Jahr aus, das Folgejahr der letzten Buchung IST das
    // Jahr des gedrifteten Termins.
    // Nachgebucht wird in keinem Fall - die Migration schreibt keine Ausgabe,
    // und kein Termin, den sie setzt, liegt vor heute.
    //
    // ZWEI RIEGEL, an denen der Termin stehen bleibt:
    //   - die Serie hat in diesem Monat (jaehrlich: Jahr) schon gebucht, oder
    //     ihre letzte Buchung liegt gar nicht vor dem neuen Termin - gemessen
    //     an ALLEN Ausgaben der Serie, auch geloeschten: der Monat hatte seine
    //     Buchung;
    //   - der neue Termin laege vor heute (Tag des Haushalts): der Lauf buchte
    //     ihn sonst binnen einer Stunde rueckdatiert nach.
    // Monatlich kommt dann nur der Anker, und die Serie kehrt mit dem naechsten
    // Schritt zurueck (03.11. -> 31.12.). Jaehrlich bleibt die Zeile ganz, wie
    // sie ist: der Anker ist ein Tag ohne Monat, ein Anker 29 an einem Termin
    // im Maerz hoebe den naechsten Schritt auf den 29. Maerz.
    //
    // Der CHECK folgt dem von `budget_loans.due_day` (v233). NULL bleibt
    // moeglich (ADD COLUMN) und heisst "kein Anker": der Schritt klemmt dann
    // nur. Ein kuenftiger Rebuild von recurring_expenses muss die Spalte samt
    // CHECK mitnehmen.
    up(db) {
      db.exec(`
        ALTER TABLE recurring_expenses ADD COLUMN anchor_day INTEGER
          CHECK (anchor_day IS NULL OR (typeof(anchor_day) = 'integer' AND anchor_day BETWEEN 1 AND 31));
        UPDATE recurring_expenses
          SET anchor_day = CAST(substr(next_run_date, 9, 2) AS INTEGER)
          WHERE next_run_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND CAST(substr(next_run_date, 9, 2) AS INTEGER) BETWEEN 1 AND 31;
      `);

      const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
      const today = todayKey(db);
      const firstBooked = db.prepare(`
        SELECT e.expense_date, e.status,
               (e.updated_at IS NOT e.created_at
                OR EXISTS (SELECT 1 FROM expense_activity a
                           WHERE a.type = 'expense_edited' AND a.entity_type = 'expense' AND a.entity_id = e.id)) AS edited
        FROM expenses e WHERE e.recurring_rule_id = ? ORDER BY e.id ASC LIMIT 1
      `);
      const lastBooked = db.prepare('SELECT MAX(expense_date) AS date FROM expenses WHERE recurring_rule_id = ?');
      const setAnchor = db.prepare('UPDATE recurring_expenses SET anchor_day = ? WHERE id = ?');
      const setBack = db.prepare('UPDATE recurring_expenses SET anchor_day = ?, next_run_date = ? WHERE id = ?');

      const series = db.prepare(
        "SELECT id, frequency, next_run_date FROM recurring_expenses WHERE frequency IN ('monthly', 'yearly')"
      ).all();
      for (const row of series) {
        const next = DATE.exec(row.next_run_date);
        const first = firstBooked.get(row.id);
        const booked = first && first.status !== 'deleted' && !first.edited ? DATE.exec(first.expense_date) : null;
        if (!next || !booked || !(first.expense_date < row.next_run_date)) continue;

        const [, nextYear, nextMonth] = next;
        const nextDay = Number(next[3]);
        const bookedDay = Number(booked[3]);
        const yearly = row.frequency === 'yearly';
        const drifted = yearly
          ? booked[2] === '02' && bookedDay === 29 && nextMonth === '03' && nextDay === 1
          : bookedDay >= 29 && nextDay >= 1 && nextDay <= bookedDay - 28;
        if (!drifted) continue;

        // Der 1. des Zielmonats, auf den Anker gehoben: derselbe Helfer wie im
        // Lauf, also dieselbe Klemmung aufs Monatsende.
        // Ein Termin in Datumsform, der kein Datum ist ("2026-13-01"), bleibt
        // stehen: eine Migration, die daran wirft, haelt den Start an.
        let target;
        try {
          target = liftToAnchorDay(`${nextYear}-${yearly ? '02' : nextMonth}-01`, bookedDay);
        } catch { continue; }
        const period = yearly ? 4 : 7;
        const last = lastBooked.get(row.id).date;

        // Der ausgelassene Monat liegt noch vor uns: der Monat NACH der
        // letzten Buchung, sofern sein Termin nicht vergangen ist und vor dem
        // gedrifteten liegt. `last` ist das spaeteste Datum der Serie, der
        // Monat danach hat also keine Buchung von ihr.
        if (!yearly) {
          let ahead = null;
          try {
            ahead = liftToAnchorDay(addMonthsClamped(`${last.slice(0, 7)}-01`, 1), bookedDay);
          } catch { /* letzte Buchung ohne lesbares Datum: weiter mit dem Monat des Termins */ }
          if (ahead && ahead >= today && ahead < row.next_run_date) {
            setBack.run(bookedDay, ahead, row.id);
            continue;
          }
        }

        const alreadyBooked = last >= target || last.slice(0, period) === target.slice(0, period);
        if (alreadyBooked || target < today) {
          if (!yearly) setAnchor.run(bookedDay, row.id);
          continue;
        }
        setBack.run(bookedDay, target, row.id);
      }
    },
  };
