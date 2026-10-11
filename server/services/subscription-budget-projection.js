/**
 * Modul: Abo-Vorkommen im Budget (#1844)
 * Zweck: Die EINE Stelle, die aus dem Rhythmus eines Abos die Zahlungen
 *        rechnet, die im Budget noch nicht gebucht sind - beim Lesen, ohne
 *        eine Zeile zu schreiben.
 * Abhängigkeiten: services/subscriptions.js (Rhythmus), services/subscription-rates.js
 *        (gespeicherte Kurse), utils/timezone.js ("heute"). KEIN Import von
 *        server/db.js: die Verbindung wird uebergeben, wie bei timezone.js.
 *
 * AUSGANGSLAGE. Ein Abo mit "Ins Budget einbeziehen" haelt genau eine Buchung
 * in `budget_entries`, am Tag seiner naechsten Zahlung
 * (routes/subscriptions.js#syncBudgetExpense). Die naechste entsteht erst mit
 * "Als verlaengert markieren". Die Monatsliste liest `date BETWEEN`, also
 * stand ein Abo in genau EINEM Monat des Budgets, und jeder Monat danach sah
 * aus, als gaebe es das Abo nicht.
 *
 * WARUM BEIM LESEN UND NICHT VORAB GESCHRIEBEN. Eine Serie des Budgets legt
 * ihre Vorkommen beim Aufschlagen eines Monats als Zeilen an
 * (generateRecurringInstances). Fuer ein Abo waere das eine zweite Wahrheit
 * neben `next_payment_date`: jede Aenderung an Betrag, Rhythmus, Ende oder
 * Sichtbarkeit muesste den vorab angelegten Zeilen hinterherlaufen, und
 * "Als verlaengert markieren" faende seine Zeile schon vor. Gerechnet beim
 * Lesen ist die Antwort immer die des Abos, wie es JETZT ist.
 *
 * DIE REGEL FUER SUMMEN IST DIE DER ERWARTETEN BUCHUNGEN (#637), keine zweite:
 * sichtbar und als erwartet gekennzeichnet, in KEINER Summe, in `pending` der
 * Zusammenfassung ausgewiesen, im CSV-Export als `Expected`. Ein Abo wird erst
 * durch "Als verlaengert markieren" zur Buchung - dasselbe Verhaeltnis wie
 * eine Serie, die eine Bestaetigung verlangt. Die Summen selbst muessen dafuer
 * nichts wissen: sie lesen `budget_entries`, und dort steht die Zeile nicht.
 *
 * DER RHYTHMUS IST DER VON /renew. Gerechnet wird mit addBillingCycle(),
 * Schritt fuer Schritt ab `next_payment_date` - genau der Weg, den das
 * Verlaengern geht. Der 31. klemmt im Februar auf den 28. und bleibt danach
 * dort; eine Rechnung, die jeden Monat neu vom 31. ausginge, zeigte Termine,
 * die nie gebucht werden. `test:subscription-budget-projection` haelt die
 * Gleichheit fest, indem sie erst projiziert und dann verlaengert.
 */

import { addBillingCycle, convertAmount } from './subscriptions.js';
import { cachedRatesFor } from './subscription-rates.js';
import { todayKey } from '../utils/timezone.js';

/** Kategorie jeder Abo-Buchung im Budget (Migration v104, syncBudgetExpense). */
export const SUBSCRIPTION_BUDGET_CATEGORY = 'subscriptions';

/**
 * Obergrenze der Schritte je Abo und Anfrage. Ein taegliches Abo braucht 365
 * im Jahr; 40.000 reichen fuer gut hundert Jahre und halten eine Anfrage mit
 * einem unsinnig fernen Monat trotzdem endlich.
 */
const MAX_STEPS = 40_000;

/** Die Budget-Waehrung, wie syncBudgetExpense sie liest. */
export function subscriptionBudgetCurrency(database) {
  return database.prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value
    || database.prepare('SELECT base_currency FROM subscription_settings WHERE id = 1').get()?.base_currency
    || 'EUR';
}

/** Titel der Buchung eines Abos: der Name, bei fremder Waehrung mit ihrem Code. */
export function subscriptionBudgetTitle(subscription, budgetCurrency) {
  const suffix = subscription.currency === budgetCurrency ? '' : ` (${subscription.currency})`;
  return `${subscription.name}${suffix}`;
}

/**
 * Betrag eines Abos in der Budget-Waehrung, positiv. Dieselbe Rechnung wie an
 * der gebuchten Zeile, samt ihrem Rueckfall: ohne Kurs steht der Betrag
 * unverrechnet da, statt zu verschwinden.
 */
export function subscriptionBudgetAmount(subscription, budgetCurrency, rates) {
  if (subscription.currency === budgetCurrency) return Math.abs(Number(subscription.amount));
  return Math.abs(convertAmount(subscription.amount, subscription.currency, budgetCurrency, rates)
    ?? Number(subscription.amount));
}

/**
 * Die Zahlungstage eines Abos NACH seiner naechsten Zahlung, innerhalb
 * [from, to], aufsteigend. Rein, ohne Datenbank.
 *
 * Die naechste Zahlung selbst ist nie dabei: sie ist die gebuchte Zeile. Das
 * Ende gilt wie beim Verlaengern (resolveRenewal): an einem Datum ist die
 * Zahlung am Endtag die letzte, nach N Zahlungen zaehlt die anstehende mit.
 *
 * @param {object} subscription  Zeile aus budget_subscriptions
 * @param {string} from  YYYY-MM-DD, einschliesslich
 * @param {string} to    YYYY-MM-DD, einschliesslich
 * @returns {string[]} YYYY-MM-DD
 */
export function upcomingPaymentDates(subscription, from, to) {
  if (!subscription?.enabled || subscription.completed_at) return [];
  let remaining = Infinity;
  if (subscription.end_type === 'after_count') {
    // Verbleibend inklusive der anstehenden (gebuchten) Zahlung - die faellt weg.
    remaining = Number(subscription.occurrence_count) - Number(subscription.occurrences_done || 0) - 1;
  }
  const endDate = subscription.end_type === 'on_date' ? subscription.end_date : null;
  const dates = [];
  let date = subscription.next_payment_date;
  for (let step = 0; step < MAX_STEPS && remaining > 0; step += 1, remaining -= 1) {
    let next;
    // Ein Datum oder Rhythmus, den die Route nie hereinliesse, beendet die
    // Reihe, statt die Monatsliste des Budgets mit einer 500 zu beantworten.
    try { next = addBillingCycle(date, subscription.billing_cycle, subscription.cycle_interval); } catch { break; }
    if (!(next > date) || next > to) break;
    if (endDate && next > endDate) break;
    if (next >= from) dates.push(next);
    date = next;
  }
  return dates;
}

/**
 * Die erwarteten, noch nicht gebuchten Abo-Zahlungen eines Zeitraums, in der
 * Form einer Buchung - fuer jeden Leser, der `budget_entries` als Liste zeigt.
 *
 * WAS EINE ZEILE VON EINER BUCHUNG UNTERSCHEIDET: `expected: true`, `id: null`
 * (es gibt keine Zeile, also nichts zu oeffnen, aendern oder loeschen) und
 * `subscription_id`, das auf das Abo zeigt. `is_pending` steht auf 1, weil sie
 * genau das ist: erwartet, in keiner Summe. Mehr als die gebuchte Zeile
 * verraet sie nicht - Notizen und Kontoname des Abos bleiben im Abo.
 *
 * SICHTBARKEIT. `filter` ist das Fragment, mit dem der Aufrufer auch
 * `budget_entries` filtert (budgetFilter(req, 's')). Es trifft hier auf
 * `owner_id` und `visibility`, wie syncBudgetExpense sie an die gebuchte Zeile
 * schreibt - die erwartete Zeile ist damit fuer genau die sichtbar, die auch
 * die gebuchte sehen.
 *
 * VERGANGENE MONATE BLEIBEN LEER. Was vor dem laufenden Monat des Haushalts
 * liegt und nie verlaengert wurde, ist keine Erwartung mehr, sondern ein
 * Versaeumnis, das im Abo steht (ueberfaellige naechste Zahlung). Im
 * laufenden Monat bleibt ein verstrichener Termin stehen: er wartet.
 *
 * @param {object} database  better-sqlite3-Connection
 * @param {object} range
 * @param {string} range.from  YYYY-MM-DD
 * @param {string} range.to    YYYY-MM-DD
 * @param {{ clause: string, params: any[] }} [range.filter]  beginnt mit ' AND ' oder ist leer; Alias `s`
 * @param {string} [range.today]  YYYY-MM-DD, Vorgabe: heute in der Haushaltszone
 * @returns {object[]} nach Datum absteigend, wie die Monatsliste
 */
export function expectedSubscriptionEntries(database, { from, to, filter, today = todayKey(database) }) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lower = from > monthStart ? from : monthStart;
  if (lower > to) return [];

  const f = filter?.clause ? filter : { clause: '', params: [] };
  const subscriptions = database.prepare(`
    SELECT s.*, u.display_name AS creator_name
    FROM (
      SELECT sub.id, sub.name, sub.amount, sub.currency, sub.billing_cycle, sub.cycle_interval,
             sub.next_payment_date, sub.enabled, sub.completed_at, sub.end_type, sub.end_date,
             sub.occurrence_count, sub.occurrences_done, sub.created_by,
             COALESCE(sub.owner_id, sub.created_by) AS owner_id,
             COALESCE(sub.visibility, 'shared') AS visibility,
             COALESCE(c.budget_subcategory_key, '') AS subcategory
      FROM budget_subscriptions sub
      LEFT JOIN subscription_categories c ON c.id = sub.category_id
      WHERE sub.enabled = 1 AND sub.completed_at IS NULL AND sub.next_payment_date < ?
    ) s
    LEFT JOIN users u ON u.id = s.created_by
    WHERE 1 = 1${f.clause}
  `).all(to, ...f.params);
  if (!subscriptions.length) return [];

  const currency = subscriptionBudgetCurrency(database);
  const foreign = [...new Set(subscriptions.map((s) => s.currency).filter((c) => c !== currency))];
  // Gespeicherte Kurse, ohne Abruf: ein Lesepfad des Budgets wartet nicht auf
  // einen Kursdienst und schreibt keinen Cache.
  const rates = foreign.length ? cachedRatesFor(database, currency) : {};

  const entries = [];
  for (const subscription of subscriptions) {
    const dates = upcomingPaymentDates(subscription, lower, to);
    if (!dates.length) continue;
    const amount = -subscriptionBudgetAmount(subscription, currency, rates);
    const title = subscriptionBudgetTitle(subscription, currency);
    for (const date of dates) {
      entries.push({
        id: null,
        expected: true,
        subscription_id: subscription.id,
        title,
        amount,
        category: SUBSCRIPTION_BUDGET_CATEGORY,
        subcategory: subscription.subcategory,
        date,
        is_recurring: 0,
        recurrence_parent_id: null,
        is_pending: 1,
        account_id: null,
        created_by: subscription.created_by,
        creator_name: subscription.creator_name ?? null,
        owner_id: subscription.owner_id,
        visibility: subscription.visibility,
        responsible_users: [],
        attachments: [],
      });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.subscription_id - b.subscription_id));
  return entries;
}

/**
 * Anzahl und Summen der erwarteten Abo-Zahlungen - das, was `pending` der
 * Zusammenfassung zu den erwarteten Buchungen aus `budget_entries` dazuzaehlt.
 * @returns {{ count: number, income: number, expenses: number }}
 */
export function expectedSubscriptionTotals(database, range) {
  const entries = expectedSubscriptionEntries(database, range);
  const cents = entries.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0);
  return { count: entries.length, income: 0, expenses: cents / 100 };
}
