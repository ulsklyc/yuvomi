/**
 * Module: Split Expenses Scheduler
 * Purpose: Generate due recurring shared expenses idempotently.
 */

import { isRestoreRunning } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { buildSplits, insertExpenseLedger, membershipRefusal, SplitInputError } from './split-expenses.js';
import { todayKey } from '../utils/timezone.js';
import { addMonthsClamped, addYearsClamped, dateKey, liftToAnchorDay, parseDateKey } from '../utils/interval-date.js';

const log = createLogger('SplitExpenseScheduler');

// Der naechste Termin einer Serie nach `dateText` - die EINE Rechnung, durch die
// der Buchungslauf (generateRecurringExpense) und das Fortsetzen
// (nextRunNotBefore) gehen.
//
// Monate und Jahre klemmen aufs Monatsende (server/utils/interval-date.js) und
// heben den Tag danach wieder auf `anchorDay`, den Tag, fuer den die Serie
// gedacht ist (`recurring_expenses.anchor_day`): 31.01. -> 28.02. -> 31.03.,
// jaehrlich 29.02. -> 28.02. -> im Schaltjahr wieder 29.02. Bis #1721 stand
// hier `setUTCMonth(+1)`: der 31. lief in den Folgemonat ueber (31.01. ->
// 03.03.), der Februar blieb ohne Buchung, und weil der naechste Schritt vom
// uebergelaufenen Datum ausging, kam die Serie nie zurueck.
//
// Ohne Anker (NULL) klemmt der Schritt nur. Woechentlich sind es sieben Tage,
// der Anker spielt dort nicht mit.
//
// Ein Termin in Datumsform, der kein Datum ist ("2026-02-31"), wird gelesen wie
// vor #1721: als der Tag, auf den `Date` ihn ueberlaufen laesst (03.03.). Die
// Route laesst so etwas nicht herein, aber die geteilten Helfer werfen daran,
// und ein Schritt, der wirft, liesse den Lauf an dieser Serie stuendlich
// scheitern, ohne sie je zu pausieren. Was auch `Date` nicht liest
// ("2026-13-01"), wirft hier wie zuvor.
function addInterval(dateText, frequency, anchorDay = null) {
  const from = dateKey(new Date(`${dateText}T00:00:00Z`));
  if (frequency === 'monthly') return liftToAnchorDay(addMonthsClamped(from, 1), anchorDay);
  if (frequency === 'yearly') return liftToAnchorDay(addYearsClamped(from, 1), anchorDay);
  const date = parseDateKey(from);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  return dateKey(date);
}

// Der erste Termin der Serie, der nicht vor `today` liegt, gezaehlt ab
// `dateText` in ganzen Intervallen - mit addInterval, also mit genau der
// Rechnung, mit der der Lauf nach jeder Buchung weiterrueckt. Bewusst gezaehlt
// und nicht gesprungen: wo die Serie nach n Schritten steht, sagt der Lauf, und
// eine zweite Rechnung daneben muesste ihm erst wieder gleichen (ohne Anker
// haengt der naechste Termin vom vorigen ab: 31.01. -> 28.02. -> 28.03.).
//
// `anchorDay` ist der Ankertag der Zeile; wer ihn weglaesst, bekommt das Raster
// einer Serie ohne Anker.
//
// `skipped` zaehlt die uebergangenen Termine. Ein Termin am Tag `today` gilt
// nicht als versaeumt: der naechste Lauf bucht ihn.
function nextRunNotBefore(dateText, frequency, today, anchorDay = null) {
  // Ein Datum, das keins ist, oder ein Rhythmus, der nicht vorrueckt, bleibt
  // stehen, statt zu werfen oder endlos zu zaehlen.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) return { date: dateText, skipped: 0 };
  let date = dateText;
  let skipped = 0;
  while (date < today) {
    let next;
    // "2026-13-01" hat die Form eines Datums und ist keins.
    try { next = addInterval(date, frequency, anchorDay); } catch { break; }
    if (!(next > date)) break;
    date = next;
    skipped += 1;
  }
  return { date, skipped };
}

function insertActivity(database, groupId, actorId, type, entityType, entityId, metadata = {}) {
  database.prepare(`
    INSERT INTO expense_activity (group_id, actor_id, type, entity_type, entity_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(groupId, actorId, type, entityType, entityId, JSON.stringify(metadata));
}

// Warum eine Serie sich an diesem Termin nicht buchen laesst. `reason` geht in
// den Verlaufseintrag der Gruppe.
class RecurringNotBookable extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RecurringNotBookable';
    this.reason = reason;
  }
}

function readSnapshot(recurring) {
  let snapshot;
  try {
    snapshot = JSON.parse(recurring.split_snapshot || '{}');
  } catch {
    throw new RecurringNotBookable('split_invalid', 'split_snapshot is not valid JSON.');
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new RecurringNotBookable('split_invalid', 'split_snapshot is not an object.');
  }
  return snapshot;
}

function generateRecurringExpense(database, recurring) {
  const snapshot = readSnapshot(recurring);
  const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [recurring.payer_id];
  const splits = buildSplits({
    method: recurring.split_method,
    amountMinor: recurring.amount_minor,
    currency: recurring.currency,
    participants,
    splits: snapshot.splits || [],
  });
  // Mitgliedschaft an JEDEM Termin, mit der Regel der Routen: beim Anlegen war
  // sie geprueft, aber wer seither die Gruppe verlassen hat (oder dessen Konto
  // geloescht ist), bekaeme sonst weiter Schulden in eine Gruppe gebucht, die
  // er nicht mehr sieht. Nach buildSplits, weil erst dort feststeht, dass die
  // Beteiligten ueberhaupt IDs sind.
  const refusal = membershipRefusal(database, recurring.group_id, recurring.payer_id, splits.map((split) => split.user_id));
  if (refusal) throw new RecurringNotBookable('not_a_member', refusal);
  const expenseId = database.prepare(`
    INSERT INTO expenses
      (group_id, title, description, amount_minor, currency, converted_amount_minor, converted_currency,
       payer_id, category, split_method, expense_date, recurring_rule_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recurring.group_id,
    recurring.title,
    recurring.description,
    recurring.amount_minor,
    recurring.currency,
    recurring.amount_minor,
    recurring.currency,
    recurring.payer_id,
    recurring.category,
    recurring.split_method,
    recurring.next_run_date,
    recurring.id,
    recurring.created_by,
  ).lastInsertRowid;

  const insertSplit = database.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_minor, currency) VALUES (?, ?, ?, ?)');
  for (const split of splits) insertSplit.run(expenseId, split.user_id, split.amount_minor, split.currency);

  // Dieselbe Buchungsregel wie die Route (#1444), aus der gespeicherten Zeile
  // gelesen statt aus der Serie: so bucht der Lauf, was in `expenses` steht.
  const expense = database.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  insertExpenseLedger(database, expense, splits);

  insertActivity(database, recurring.group_id, recurring.created_by, 'recurring_generated', 'expense', expenseId, { recurring_expense_id: recurring.id, title: recurring.title });
  database.prepare('UPDATE recurring_expenses SET next_run_date = ? WHERE id = ?')
    .run(addInterval(recurring.next_run_date, recurring.frequency, recurring.anchor_day), recurring.id);
  return expenseId;
}

// Welche Fehler bedeuten "DIESE Serie ist unbuchbar" - nur die pausieren sie.
// Erkannt am Typ, nie am Meldungstext. Ein SQLite-Code steht bewusst nicht
// dabei: das geloeschte Konto eines Beteiligten faengt die Mitgliedspruefung
// (die Mitgliedszeile faellt per CASCADE mit), bevor ein Fremdschluessel
// verletzt wird. Alles andere (TypeError, ReferenceError, SQLite) ist ein Fehler im
// Code oder in der Umgebung: er liefert null, die Serie bleibt unpausiert, und
// der naechste Lauf versucht sie wieder. Schluckte der Lauf ihn als "Serie
// kaputt", schaltete ein Bug still gesunde Serien ab.
function pauseReason(err) {
  if (err instanceof RecurringNotBookable) return err.reason;
  if (err instanceof SplitInputError) return 'split_invalid';
  return null;
}

// Pausiert die Serie und schreibt den Grund in den Verlauf der Gruppe - die App
// zeigt Serien nirgends sonst, ohne den Eintrag stuende er nur im Serverlog.
// `actor_id` NULL: das war niemand, die App zeigt dafuer "System".
function pauseUnbookable(database, recurring, reason) {
  database.transaction(() => {
    const paused = database.prepare("UPDATE recurring_expenses SET paused_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND paused_at IS NULL").run(recurring.id);
    if (!paused.changes) return;
    insertActivity(database, recurring.group_id, null, 'recurring_auto_paused', 'recurring_expense', recurring.id, { title: recurring.title, reason });
  })();
}

// `today` in der Haushaltszone (#829): eine wiederkehrende Ausgabe mit
// next_run_date = heute wurde westlich von UTC schon am Vorabend gebucht, weil
// der UTC-Tag dort bereits der folgende ist - die Buchung trug dann das
// Vortagsdatum ihres eigenen Laufs.
//
// Jede Serie bucht in ihrer EIGENEN Transaktion. Frueher war es eine fuer den
// ganzen Lauf: eine einzige unbuchbare Serie rollte alle zurueck, kein Termin
// rueckte vor, und jede Stunde scheiterte der Lauf an derselben Serie neu.
//
// `book` ist die Naht fuer den Test der Fehlerrichtung, sonst immer
// generateRecurringExpense.
function processDueRecurringExpenses(today = todayKey(db.get()), book = generateRecurringExpense) {
  const database = db.get();
  const due = database.prepare(`
    SELECT *
    FROM recurring_expenses
    WHERE paused_at IS NULL AND next_run_date <= ?
    ORDER BY next_run_date ASC, id ASC
    LIMIT 100
  `).all(today);
  const result = { generated: 0, paused: 0, failed: 0 };
  for (const recurring of due) {
    try {
      database.transaction(() => book(database, recurring))();
      result.generated += 1;
    } catch (err) {
      const reason = pauseReason(err);
      if (!reason) {
        result.failed += 1;
        log.error(`Recurring split expense ${recurring.id} failed, left unpaused:`, err);
        continue;
      }
      try {
        pauseUnbookable(database, recurring, reason);
        result.paused += 1;
        log.warn(`Recurring split expense ${recurring.id} paused (${reason}): ${err.message}`);
      } catch (pauseErr) {
        result.failed += 1;
        log.error(`Recurring split expense ${recurring.id} could not be paused:`, pauseErr);
      }
    }
  }
  if (due.length) log.info(`Recurring split expenses: ${result.generated} generated, ${result.paused} paused, ${result.failed} failed.`);
  return result;
}

function startScheduler() {
  setInterval(() => {
    // Rein lokal und ohne await, aber waehrend eines Restores gesperrt: den
    // Lauf auslassen statt am Riegel zu scheitern, der naechste holt nach.
    if (isRestoreRunning()) return;
    try {
      processDueRecurringExpenses();
    } catch (err) {
      log.error('Recurring split expense generation failed:', err);
    }
  }, 60 * 60 * 1000).unref();
}

export { generateRecurringExpense, nextRunNotBefore, processDueRecurringExpenses, startScheduler };
