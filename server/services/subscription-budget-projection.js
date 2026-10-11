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

import { addBillingCycle, convertAmount, parseDateKey } from './subscriptions.js';
import { dateKey } from '../utils/interval-date.js';
import { cachedRatesFor } from './subscription-rates.js';
import { todayKey } from '../utils/timezone.js';

/** Kategorie jeder Abo-Buchung im Budget (Migration v104, syncBudgetExpense). */
export const SUBSCRIPTION_BUDGET_CATEGORY = 'subscriptions';

/**
 * GRENZEN DER ARBEIT JE ANFRAGE. Die Projektion laeuft bei jedem Aufschlagen
 * eines Monats; was sie kostet, darf an nichts haengen, das ein Aufrufer oder
 * ein alter Datenbestand frei waehlt.
 *
 *  - Der VORLAUF wird gesprungen, nicht gezaehlt (stateAfterSteps): ein
 *    taegliches Abo von 1900 kostet fuer den November 2026 dieselben dreissig
 *    Schritte wie eines von gestern.
 *  - Das FENSTER ist hoechstens PROJECTION_WINDOW_DAYS breit. Monatsliste und
 *    Zusammenfassung fragen nach einem Monat und liegen immer darin; nur der
 *    Export kennt einen freien Bereich (`from`/`to`), und dort endet die
 *    Projektion am Fensterende - die Antwort nennt den Tag (`until`).
 *  - Die GESAMTZAHL der Zeilen ueber alle Abos ist auf MAX_EXPECTED_ROWS
 *    begrenzt, und das Zaehlen bricht dort AB, statt erst das Ergebnis zu
 *    kuerzen. Dann gibt es gar keine erwartete Zeile (`omitted: true`): eine
 *    gekuerzte Liste saehe vollstaendig aus, und `pending` wuerde eine
 *    Teilsumme als Summe ausgeben.
 */
export const PROJECTION_WINDOW_DAYS = 366;
export const MAX_EXPECTED_ROWS = 5000;

const MS_PER_DAY = 86_400_000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(key, days) {
  return dateKey(new Date(parseDateKey(key).getTime() + days * MS_PER_DAY));
}

/** Letzter Tag des Monats mit laufendem Index `index` (Jahr * 12 + Monat 0-11). */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function lastDayOfMonthIndex(index) {
  const month = index % 12;
  if (month !== 1) return MONTH_DAYS[month];
  const year = Math.floor(index / 12);
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

/** Das Schaltjahrmuster wiederholt sich nach 400 Jahren. */
const LEAP_PERIOD_MONTHS = 4800;

/**
 * Der Tag, auf dem ein Abo nach `steps` Verlaengerungen steht - GERECHNET,
 * und zwar so, dass dasselbe herauskommt wie nach `steps` Aufrufen von
 * addBillingCycle().
 *
 * Tage und Wochen sind reine Addition. Monate und Jahre klemmen aufs
 * Monatsende, und der geklemmte Tag bleibt (31.01. -> 28.02. -> 28.03.): der
 * Tag nach k Schritten ist der kleinste letzte Tag aller Monate, durch die
 * die Reihe gegangen ist, hoechstens der Starttag. Bis zum 28. klemmt nie
 * etwas. Darueber genuegt es, die ersten 4800 Monate der Reihe anzusehen -
 * danach wiederholt sich jeder Monat samt Schaltjahr -, und sobald der 28.
 * erreicht ist, geht es nicht tiefer.
 *
 * `test:subscription-budget-projection` vergleicht den Sprung gegen das
 * schrittweise Zaehlen, an Monatsenden, Schalttagen und Abstaenden bis 48.
 */
function stateAfterSteps(subscription, steps) {
  const start = subscription.next_payment_date;
  const interval = Number(subscription.cycle_interval);
  if (steps <= 0) return start;
  if (subscription.billing_cycle === 'daily') return addDays(start, steps * interval);
  if (subscription.billing_cycle === 'weekly') return addDays(start, steps * interval * 7);

  const monthsPer = interval * (subscription.billing_cycle === 'yearly' ? 12 : 1);
  const [y, m, d] = start.split('-').map(Number);
  const startIndex = y * 12 + (m - 1);
  let day = d;
  if (day > 28) {
    const look = Math.min(steps, LEAP_PERIOD_MONTHS);
    for (let i = 1; i <= look && day > 28; i += 1) {
      day = Math.min(day, lastDayOfMonthIndex(startIndex + i * monthsPer));
    }
  }
  const index = startIndex + steps * monthsPer;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Wie viele Verlaengerungen sich ueberspringen lassen, ohne einen Tag ab
 * `from` zu verpassen: der Stand danach liegt sicher VOR `from`.
 */
function stepsBefore(subscription, from) {
  const start = subscription.next_payment_date;
  if (!(start < from)) return 0;
  const interval = Number(subscription.cycle_interval);
  const cycle = subscription.billing_cycle;
  if (cycle === 'daily' || cycle === 'weekly') {
    const stepDays = interval * (cycle === 'weekly' ? 7 : 1);
    const days = Math.round((parseDateKey(from).getTime() - parseDateKey(start).getTime()) / MS_PER_DAY);
    // Der letzte Schritt, der noch vor `from` landet.
    return Math.max(0, Math.ceil(days / stepDays) - 1);
  }
  const monthsPer = interval * (cycle === 'yearly' ? 12 : 1);
  const [y, m] = start.split('-').map(Number);
  const [fy, fm] = from.split('-').map(Number);
  // Der letzte Schritt, der in einem Monat VOR dem von `from` landet.
  return Math.max(0, Math.ceil(((fy * 12 + fm) - (y * 12 + m)) / monthsPer) - 1);
}

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
 * @param {{ steps: number, budget?: number }} [stats]  zaehlt die Schritte;
 *        mit `budget` bricht die Reihe ab, sobald es aufgebraucht ist, und
 *        setzt `stats.exhausted`
 * @returns {string[]} YYYY-MM-DD
 */
export function upcomingPaymentDates(subscription, from, to, stats = { steps: 0 }) {
  if (!subscription?.enabled || subscription.completed_at) return [];
  const interval = Number(subscription.cycle_interval);
  // Was die Route nie hereinliesse, ergibt keine Reihe - statt die Monatsliste
  // des Budgets mit einer 500 zu beantworten.
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return [];
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(subscription.billing_cycle)) return [];
  // `to` darf "2026-11-31" heissen (so fragen die Monatsrouten): es wird nur
  // als Text verglichen. `from` und der Start werden gerechnet, also geprueft.
  try { parseDateKey(subscription.next_payment_date); parseDateKey(from); } catch { return []; }

  let remaining = Infinity;
  if (subscription.end_type === 'after_count') {
    // Verbleibend inklusive der anstehenden (gebuchten) Zahlung - die faellt weg.
    remaining = Number(subscription.occurrence_count) - Number(subscription.occurrences_done || 0) - 1;
  }
  const endDate = subscription.end_type === 'on_date' ? subscription.end_date : null;
  if (endDate && endDate < from) return [];

  // Den Vorlauf springen: nach `skipped` Verlaengerungen steht das Abo noch
  // vor `from`, und keine davon gehoert in den Bereich.
  const skipped = Math.min(stepsBefore(subscription, from), remaining === Infinity ? Infinity : Math.max(0, remaining));
  let date = stateAfterSteps(subscription, skipped);
  remaining -= skipped;

  const dates = [];
  while (remaining > 0) {
    if (stats.budget !== undefined && stats.steps >= stats.budget) { stats.exhausted = true; break; }
    stats.steps += 1;
    let next;
    try { next = addBillingCycle(date, subscription.billing_cycle, interval); } catch { break; }
    if (!(next > date) || next > to) break;
    if (endDate && next > endDate) break;
    if (next >= from) dates.push(next);
    date = next;
    remaining -= 1;
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
 * @param {{ steps: number }} [range.stats]  zaehlt die Schritte (Tests)
 * @returns {{ entries: object[], omitted: boolean, until: string|null }}
 *          `entries` nach Datum absteigend, wie die Monatsliste. `omitted`:
 *          MAX_EXPECTED_ROWS waere ueberschritten, es gibt KEINE erwartete
 *          Zeile. `until`: der Bereich war breiter als das Fenster, die
 *          Projektion endet an diesem Tag (einschliesslich); sonst null.
 */
export function expectedSubscriptionEntries(database, { from, to, filter, today = todayKey(database), stats = { steps: 0 } }) {
  const none = { entries: [], omitted: false, until: null };
  if (!DATE_KEY_RE.test(String(from)) || !DATE_KEY_RE.test(String(to))) return none;
  const monthStart = `${today.slice(0, 7)}-01`;
  const lower = from > monthStart ? from : monthStart;
  if (lower > to) return none;
  // DAS FENSTER STEHT, BEVOR GEZAEHLT WIRD. `to` kommt beim Export vom
  // Aufrufer; ohne diese Zeile bestimmte er, wie weit jede Reihe laeuft.
  let windowEnd;
  // "2026-02-30" hat die Form eines Datums und ist keins (der Export prueft
  // nur die Form): dann gibt es nichts zu projizieren.
  try { windowEnd = addDays(lower, PROJECTION_WINDOW_DAYS - 1); } catch { return none; }
  const until = to > windowEnd ? windowEnd : null;
  if (until) to = until;

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
  if (!subscriptions.length) return { entries: [], omitted: false, until };

  const currency = subscriptionBudgetCurrency(database);
  const foreign = [...new Set(subscriptions.map((s) => s.currency).filter((c) => c !== currency))];
  // Gespeicherte Kurse, ohne Abruf: ein Lesepfad des Budgets wartet nicht auf
  // einen Kursdienst und schreibt keinen Cache.
  const rates = foreign.length ? cachedRatesFor(database, currency) : {};

  // Ein Schritt ergibt hoechstens eine Zeile, dazu je Abo bis zu drei ohne
  // (vor dem Bereich, dahinter). Mit diesem Budget endet das Zaehlen, sobald
  // die Gesamtgrenze nicht mehr zu halten ist - nicht erst danach.
  stats.budget = stats.steps + MAX_EXPECTED_ROWS + subscriptions.length * 3;
  const entries = [];
  for (const subscription of subscriptions) {
    const dates = upcomingPaymentDates(subscription, lower, to, stats);
    if (stats.exhausted || entries.length + dates.length > MAX_EXPECTED_ROWS) {
      return { entries: [], omitted: true, until };
    }
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
  return { entries, omitted: false, until };
}

/**
 * Anzahl und Summen der erwarteten Abo-Zahlungen - das, was `pending` der
 * Zusammenfassung zu den erwarteten Buchungen aus `budget_entries` dazuzaehlt.
 * `omitted` reicht die Gesamtgrenze durch: dann ist die Zahl unvollstaendig,
 * und der Aufrufer sagt es, statt 0 als Antwort auszugeben.
 * @returns {{ count: number, income: number, expenses: number, omitted: boolean }}
 */
export function expectedSubscriptionTotals(database, range) {
  const { entries, omitted } = expectedSubscriptionEntries(database, range);
  const cents = entries.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0);
  return { count: entries.length, income: 0, expenses: cents / 100, omitted };
}
