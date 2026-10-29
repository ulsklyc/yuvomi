/**
 * Modul: Budget-Tracker – geteilte Helfer
 * Zweck: Sichtbarkeit/Scope, Formatierung, Locale/Labels, Meta-/Kategorie-Helfer,
 *        Wiederkehrungs-Materialisierung, Loan- und Konto-Helfer, Statistik-Zeitraum.
 * Wird von den Cluster-Routern unter server/routes/budget/ importiert.
 */

import { readFileSync } from 'node:fs';
import { linkTransfer } from '../../services/budget-transfers.js';
import path from 'path';
import * as db from '../../db.js';
import {
  budgetVisibilityWhere, budgetDetailsVisibleWhere, budgetScopeWhere, budgetDetailsHiddenWhere, canEditEntry,
  resolveBudgetMode, maskBudgetEntry, BUDGET_MASKED_CATEGORY,
} from '../../services/budget-visibility.js';
import { computeLoanSchedule, remainingPrincipalFromPayments, remainingInstallmentsForBalance, rateForInstallment } from '../../services/loan-amortization.js';
import { todayKey } from '../../utils/timezone.js';
import { cachedRate, cachedRateInfo } from '../../services/subscription-rates.js';
import { DEFAULT_LOCALE, resolveHouseholdLocale, supportedLocaleFor } from '../../utils/i18n.js';
import { newNonMembers } from '../../services/household-members.js';
import { MAX_INTERVAL_COUNT } from '../../../public/utils/budget-recurrence.js';
import { SAVINGS_CHART_CATEGORY } from '../../../public/utils/budget-chart-category.js';

// --------------------------------------------------------
// Persönlich/geteilt (#476/#505): Haushalts-Modus + Sichtbarkeits-Enforcement.
// Im 'shared'-Modus (Default/Altverhalten) ist alles ungefiltert; erst der
// 'personal'-Modus filtert nach Sichtbarkeit (private/shared) und Ansichts-Scope.
// --------------------------------------------------------

/** Liest den Haushalts-Budget-Modus aus sync_config (geteilter Helfer). */
export function getBudgetMode() {
  return resolveBudgetMode(db.get());
}

/** Betrachtende User-ID (Session oder Token-Auth). requireAuth setzt authUserId immer. */
export function viewerId(req) {
  return req.authUserId || req.session.userId;
}

/**
 * Baut das Sichtbarkeits-/Scope-WHERE-Fragment (positionale ?-Binds) für einen
 * Lesepfad. Im shared-Modus leer. `scoped:true` fügt den Mein/Haushalt-Filter
 * hinzu (nur für die Eintragsliste/Aggregation sinnvoll; Loans/Subs nutzen
 * scoped:false und folgen nur der Sichtbarkeit).
 *
 * @returns {{ clause: string, params: number[] }}  clause beginnt mit ' AND ' oder ''
 */
export function budgetFilter(req, alias, { scoped = true } = {}) {
  const mode = getBudgetMode();
  if (mode !== 'personal') return { clause: '', params: [] };
  const me = viewerId(req);
  let clause = ` AND ${budgetVisibilityWhere(alias, '?', { mode })}`;
  const params = [me];
  if (scoped) {
    const scope = req.query.scope === 'household' ? 'household' : 'mine';
    clause += ` AND ${budgetScopeWhere(scope, alias, '?')}`;
    if (scope === 'mine') params.push(me); // household-Fragment hat keinen Bind
  }
  return { clause, params };
}

/**
 * Wer sieht die erwarteten Abo-Zahlungen der Folgemonate (#1844)? Das
 * WHERE-Fragment fuer services/subscription-budget-projection.js, Aliase `b`
 * (die verknuepfte Buchung) und `sub` (das Abo).
 *
 * AUSLASSEN STATT MASKIEREN, und zwar an EINER Stelle. Eine erwartete Zeile
 * bekommt nur, wer
 *   - die gebuchte Zeile in dieser Ansicht sieht (budgetFilter, wie jede Buchung),
 *   - sie MIT IHREM ZWECK sieht (budgetDetailsVisibleWhere), und
 *   - das Abo selbst sieht (budgetVisibilityWhere, die Regel der Abo-Liste).
 *
 * Eine Buchung, die nur ihren Betrag teilt, bleibt maskiert in der Liste
 * stehen, weil ihr Betrag in den Summen steckt und sie ohne die Zeile nicht
 * aufgingen (#659). Eine erwartete Zeile steckt in KEINER Summe - ihr Fehlen
 * verfaelscht nichts. Maskiert waere sie dagegen eine Reihe gleicher Betraege
 * im Rhythmus eines Abos: der Zweck, nur ohne Titel, und gegen die Abo-Liste
 * zu lesen. Das ist die Faustregel aus services/budget-visibility.js: geht es
 * um den Zweck und gibt es keinen Saldo, den ein Weglassen verfaelscht, gilt
 * die Zweck-Regel. Eine maskierte erwartete Zeile gibt es deshalb nicht, und
 * damit auch keine Form, an der man sie erkennen koennte.
 *
 * @returns {{ clause: string, params: number[] }}  clause beginnt mit ' AND ' oder ''
 */
export function expectedSubscriptionFilter(req) {
  const mode = getBudgetMode();
  if (mode !== 'personal') return { clause: '', params: [] };
  const me = viewerId(req);
  const entry = budgetFilter(req, 'b');
  return {
    clause: `${entry.clause}`
      + ` AND ${budgetDetailsVisibleWhere('b', '?', { mode })}`
      + ` AND ${budgetVisibilityWhere('sub', '?', { mode })}`,
    params: [...entry.params, me, me],
  };
}

/**
 * Kategorie-Ausdruck für Aggregationen (#659). Fremde 'shared_amount'-Einträge
 * laufen unter einem neutralen Sammel-Bucket statt unter ihrer echten
 * Kategorie - sonst verriete ausgerechnet die Kategorie-Auswertung den Zweck,
 * den die Stufe schützt, obwohl der Betrag korrekt mitzählt.
 *
 * Der Bind gehört in die SELECT-Liste und damit VOR die WHERE-Binds:
 *   .all(...categoryExpr.params, from, to, ...filter.params)
 *
 * @returns {{ expr: string, params: number[] }}
 */
export function budgetCategoryExpr(req, alias, category = `${alias}.category`) {
  const mode = getBudgetMode();
  if (mode !== 'personal') return { expr: category, params: [] };
  return {
    expr: `CASE WHEN ${budgetDetailsHiddenWhere(alias, '?', { mode })}`
        + ` THEN '${BUDGET_MASKED_CATEGORY}' ELSE ${category} END`,
    params: [viewerId(req)],
  };
}

/**
 * Maskiert die Zweck-Felder fremder 'shared_amount'-Einträge in einer bereits
 * geladenen Liste (#659). Betrag, Datum und Konto bleiben stehen; der Saldo
 * bleibt dadurch aus der Liste nachvollziehbar.
 */
export function maskEntries(req, rows) {
  const mode = getBudgetMode();
  if (mode !== 'personal') return rows;
  const me = viewerId(req);
  return rows.map((row) => maskBudgetEntry(row, me, mode));
}

/** Prüft Schreib-Berechtigung im personal-Modus; im shared-Modus immer erlaubt. */
export function mayEdit(req, row) {
  if (getBudgetMode() !== 'personal') return true;
  return canEditEntry(row, { id: viewerId(req) });
}

const LOCALE_CACHE = new Map();
const CATEGORY_LABEL_KEYS = {
  housing: 'catHousing',
  food: 'catFood',
  transport: 'catTransport',
  personal_health: 'catPersonalHealth',
  leisure: 'catLeisure',
  shopping_clothing: 'catShoppingClothing',
  education: 'catEducation',
  financial_other: 'catFinancialOther',
  subscriptions: 'catSubscriptions',
  'Erwerbseinkommen': 'catEarnedIncome',
  'Kapitalerträge': 'catInvestmentIncome',
  'Geschenke & Transfers': 'catTransferGiftIncome',
  'Sozialleistungen': 'catGovernmentBenefits',
  'Sonstiges Einkommen': 'catOtherIncome',
};
const SUBCATEGORY_LABEL_KEYS = {
  saving: 'catSaving',
  rent_mortgage: 'subcatRentMortgage',
  condominium: 'subcatCondominium',
  utilities: 'subcatUtilities',
  internet_tv_phone: 'subcatInternetTvPhone',
  renovation_maintenance: 'subcatRenovationMaintenance',
  cleaning: 'subcatCleaning',
  groceries: 'subcatGroceries',
  restaurants_bars: 'subcatRestaurantsBars',
  snacks_fast_food: 'subcatSnacksFastFood',
  bakery: 'subcatBakery',
  fuel: 'subcatFuel',
  parking_tolls: 'subcatParkingTolls',
  public_transport: 'subcatPublicTransport',
  apps_taxi: 'subcatAppsTaxi',
  maintenance_insurance: 'subcatMaintenanceInsurance',
  pharmacy: 'subcatPharmacy',
  health_insurance: 'subcatHealthInsurance',
  gym_sports: 'subcatGymSports',
  beauty_cosmetics: 'subcatBeautyCosmetics',
  travel: 'subcatTravel',
  streaming: 'subcatStreaming',
  events: 'subcatEvents',
  hobbies: 'subcatHobbies',
  clothes_shoes: 'subcatClothesShoes',
  electronics: 'subcatElectronics',
  gifts: 'subcatGifts',
  courses_college: 'subcatCoursesCollege',
  school_supplies: 'subcatSchoolSupplies',
  languages: 'subcatLanguages',
  loans_interest: 'subcatLoansInterest',
  bank_fees: 'subcatBankFees',
  insurance_other: 'subcatInsuranceOther',
  investments: 'subcatInvestments',
  taxes: 'subcatTaxes',
  subscription_entertainment: 'subcatSubscriptionEntertainment',
  subscription_productivity: 'subcatSubscriptionProductivity',
  subscription_utilities: 'subcatSubscriptionUtilities',
  subscription_health: 'subcatSubscriptionHealth',
  subscription_education: 'subcatSubscriptionEducation',
  subscription_other: 'subcatSubscriptionOther',
};

// Die Sprachen kommen aus den Locale-Dateien selbst (supportedLocaleFor), nicht
// aus einer Liste hier: die alte hielt 19 Codes, und jede spaeter hinzugekommene
// Sprache bekam ihre Kategorienamen still auf Englisch (#1523).
export function normalizeLang(raw) {
  return supportedLocaleFor(raw) ?? DEFAULT_LOCALE;
}

// Die Sprache einer Leseanfrage: ein brauchbares `?lang=` gewinnt, sonst die
// Haushaltssprache (#1859). Bis dahin fiel ein fehlendes `lang` auf Englisch,
// und der Kategorie-Manager, der die Liste ohne Parameter holt, zeigte die
// eingebauten Kategorien in jedem Haushalt englisch. Ein unbekannter Code
// nimmt denselben Weg wie ein fehlender: er nennt keine Sprache, die sich
// bedienen liesse, und die naechstbeste Antwort ist die des Haushalts, nicht
// Englisch. `resolveHouseholdLocale` endet selbst bei Englisch, wenn der
// Haushalt weder Sprache noch Region gesetzt hat.
export function requestLang(raw) {
  return supportedLocaleFor(raw) ?? resolveHouseholdLocale(db.get());
}

export function budgetMessages(lang) {
  const normalized = normalizeLang(lang);
  if (!LOCALE_CACHE.has(normalized)) {
    const localePath = path.join(import.meta.dirname, '..', '..', '..', 'public', 'locales', `${normalized}.json`);
    const parsed = JSON.parse(readFileSync(localePath, 'utf-8'));
    LOCALE_CACHE.set(normalized, parsed.budget || {});
  }
  return LOCALE_CACHE.get(normalized);
}

export function localizedCategory(category, lang) {
  const budget = budgetMessages(lang);
  const labelKey = CATEGORY_LABEL_KEYS[category.key];
  return {
    ...category,
    label: labelKey ? (budget[labelKey] || category.name) : category.name,
  };
}

export function localizedSubcategory(subcategory, lang) {
  const budget = budgetMessages(lang);
  const labelKey = SUBCATEGORY_LABEL_KEYS[subcategory.key];
  return {
    ...subcategory,
    label: labelKey ? (budget[labelKey] || subcategory.name) : subcategory.name,
  };
}

// --------------------------------------------------------
// Wiederkehrende Einträge: Intervalle + virtuelles (geglättetes) Budget
// --------------------------------------------------------

/**
 * Das Intervall ist eine EINHEIT plus eine Anzahl (#636), nicht mehr eine feste
 * Liste von Rhythmen. Die alten Schlüssel monthly/half_year/yearly konnten nur
 * drei Abstände ausdrücken; eine Zahlung alle zwei Wochen oder alle drei Monate
 * war nicht abbildbar, obwohl genau solche Verträge der Alltag sind.
 *
 * `half_year` ist deshalb kein Schlüssel mehr, sondern monatlich × 6 - Migration
 * 128 rechnet den Bestand um. Zwei Schreibweisen für denselben Rhythmus wären
 * sonst dauerhaft nebeneinander gelaufen, und jede Auswertung müsste beide kennen.
 *
 * Den Wochentag bzw. den Tag im Monat trägt das Datum des Eintrags selbst: eine
 * Serie, die am 15. beginnt, kommt am 15. wieder. Ein eigenes Feld dafür (wie es
 * die Vorlage in #636 kennt) wäre eine zweite Wahrheit neben `date`.
 */
export const RECURRENCE_INTERVAL_KEYS = ['weekly', 'monthly', 'yearly'];

// Obergrenze wie im RRULE-Formular der Aufgaben/Termine: dieselbe Zahl im
// Eingabefeld, damit "alle N" überall dasselbe Höchstmaß hat.
export { MAX_INTERVAL_COUNT };

/** Anzahl auf eine ganze Zahl in [1, MAX_INTERVAL_COUNT] bringen. */
export function normalizeIntervalCount(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_INTERVAL_COUNT);
}

/**
 * Vorkommen pro Jahr - die gemeinsame Größe hinter Glättung und Auswertung.
 * Für Wochen ist das bewusst 52 und nicht 365.25/7: der Monatsanteil einer
 * wöchentlichen Zahlung ist eine Planungsgröße, keine Abrechnung, und 52 ist
 * die Zahl, mit der Verträge rechnen.
 */
export function occurrencesPerYear(interval, count = 1) {
  const n = normalizeIntervalCount(count);
  if (interval === 'weekly') return 52 / n;
  if (interval === 'yearly') return 1 / n;
  return 12 / n;
}

/** Effektiver Monatsanteil eines Periodenbetrags (für virtuelles Budget). */
export function effectiveMonthly(amount, interval, count = 1) {
  return cents(Number(amount || 0) * occurrencesPerYear(interval, count) / 12);
}

/**
 * Erwartete, noch nicht bestätigte Buchungen zählen in KEINER Summe mit (#637).
 *
 * Sie sind sichtbar und planbar, aber sie sind nicht passiert. Zählten sie mit,
 * bliebe genau die Diskrepanz zum Kontoauszug bestehen, wegen der die
 * Bestätigung überhaupt gewünscht wurde.
 *
 * Ein Fragment statt einer Regel pro Abfrage: die Summen liegen über fünf
 * Dateien verstreut (Übersicht, Statistik, Plan, Kontostand, Dashboard), und
 * eine vergessene Stelle fiele niemandem auf - sie zeigte nur eine Zahl, die um
 * eine erwartete Buchung danebenliegt. `test:budget-structure` prüft deshalb
 * jede SUM über budget_entries auf dieses Fragment.
 *
 * @param {string} [alias] Tabellen-Alias der Abfrage, leer für unaliasierte
 * @returns {string} beginnt mit ' AND '
 */
export function bookedOnly(alias = '') {
  return ` AND ${alias ? `${alias}.` : ''}is_pending = 0`;
}

const MS_PER_DAY = 86_400_000;

/**
 * Alle Fälligkeitstage einer Serie innerhalb eines Monats, aufsteigend.
 *
 * Der Starttag selbst zählt nicht mit: dieses Vorkommen ist die erste Buchung,
 * die die Serie trägt - auch wenn ihr Datum seither einzeln korrigiert wurde.
 * Wochenserien liefern hier mehrere Tage - genau daran hing bisher, dass es
 * keine gab: die Materialisierung kannte nur einen Termin je Monat.
 *
 * @param {string} startDate  YYYY-MM-DD, Starttag der Serie (budget_series.start_date)
 * @param {string} interval   'weekly' | 'monthly' | 'yearly'
 * @param {number} count      Anzahl der Einheiten zwischen zwei Vorkommen
 * @param {string} month      YYYY-MM
 * @returns {string[]}        YYYY-MM-DD
 */
export function occurrenceDatesInMonth(startDate, interval, count, month) {
  const step = normalizeIntervalCount(count);
  const [y, m] = month.split('-').map(Number);
  const [sy, sm, sd] = startDate.split('-').map(Number);
  if (!y || !m || !sy) return [];

  if (interval === 'weekly') {
    const start      = Date.UTC(sy, sm - 1, sd);
    const monthStart = Date.UTC(y, m - 1, 1);
    const monthEnd   = Date.UTC(y, m, 0);
    const stepMs     = step * 7 * MS_PER_DAY;
    // Direkt zum ersten Vorkommen im Monat rechnen statt sich hinzuiterieren:
    // eine 2019 begonnene Wochenserie hat sonst hunderte Leerläufe je Aufruf.
    let i = Math.max(1, Math.ceil((monthStart - start) / stepMs));
    const dates = [];
    for (let at = start + i * stepMs; at <= monthEnd; at += stepMs) {
      if (at >= monthStart) dates.push(ymd(new Date(at)));
    }
    return dates;
  }

  const monthsPer = (interval === 'yearly' ? 12 : 1) * step;
  const monthsDiff = (y - sy) * 12 + (m - sm);
  if (monthsDiff < 1 || monthsDiff % monthsPer !== 0) return [];
  // Monatsüberlauf kappen: der 31. wird im April zum 30.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-${String(Math.min(sd, lastDay)).padStart(2, '0')}`];
}

/**
 * Die Serien einer Abfrage: Starttag und Werte aus der Definition, Rhythmus
 * und Eigentuemer vom Anker (#1035, #1545). Ob eine Zeile eine Serie traegt,
 * sagt die Definition - nicht mehr `recurrence_parent_id IS NULL`, das seit
 * #1035 nur "von Hand erfasst" heisst.
 */
const SERIES_SELECT = `
    SELECT a.id, a.transfer_entry_id, COALESCE(s.start_date, a.date) AS start_date, a.created_by, a.owner_id,
           a.recurrence_interval, a.recurrence_interval_count,
           a.recurrence_virtual, a.recurrence_confirm,
           s.title, s.amount, s.category, s.subcategory, s.account_id, s.visibility,
           s.grid_from
      FROM budget_series s
      JOIN budget_entries a ON a.id = s.anchor_id
     WHERE a.is_recurring = 1`;

/**
 * Schreibt ein Vorkommen einer Serie an einem Tag - oder nichts, wenn es dort
 * schon eines gibt oder es geloescht (uebersprungen) wurde. Die eine Stelle,
 * an der aus einer Definition eine Buchung wird: generateRecurringInstances()
 * und materializeSeriesStart() teilen sie.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @returns {(orig: object, date: string) => boolean} true, wenn eine Buchung entstand
 */
function occurrenceWriter(database) {
  const skipStmt = database.prepare(
    'SELECT 1 FROM budget_recurrence_skipped WHERE parent_id = ? AND date = ?'
  );
  const existsStmt = database.prepare(
    'SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date = ?'
  );
  const insertStmt = database.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring, recurrence_parent_id,
       created_by, owner_id, visibility, is_pending, account_id)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);
  // Die Zustaendigen der Serie auf die frische Instanz kopieren (#1057) - aus
  // der Definition, nicht vom Anker (#1035).
  const copyResponsiblesStmt = database.prepare(`
    INSERT OR IGNORE INTO budget_entry_responsibles (entry_id, user_id)
    SELECT ?, user_id FROM budget_series_responsibles WHERE anchor_id = ?
  `);

  const write = (orig, date) => {
    if (orig.transfer_entry_id) {
      const partner = database.prepare(`${SERIES_SELECT} AND a.id = ?`).get(orig.transfer_entry_id);
      if (!partner) throw new Error('Transfer series partner missing');
      return database.transaction(() => {
        if ((orig.grid_from && date < orig.grid_from) || (partner.grid_from && date < partner.grid_from)) return false;
        if (skipStmt.get(orig.id, date) || skipStmt.get(partner.id, date)) return false;
        const first = existsStmt.get(orig.id, date);
        const second = existsStmt.get(partner.id, date);
        if (first && second) return false;
        if (first || second) throw new Error('Unpaired transfer occurrence');
        write({ ...orig, transfer_entry_id: null }, date);
        write({ ...partner, transfer_entry_id: null }, date);
        const firstId = existsStmt.get(orig.id, date).id;
        const secondId = existsStmt.get(partner.id, date).id;
        linkTransfer(database, firstId, secondId);
        return true;
      })();
    }
    // VOR DER LETZTEN RASTERAENDERUNG ENTSTEHT NICHTS (#1545, Review-Befund in
    // #1585). Hat eine Serien-Aenderung den Starttag oder den Rhythmus
    // verschoben, stehen die Buchungen davor auf dem ALTEN Raster - ein
    // Vorkommen auf dem neuen daneben waere eine zweite Buchung fuer denselben
    // Zeitraum. Ein Monat davor, der noch nie aufgeschlagen wurde, bleibt
    // deshalb leer: welches Raster damals galt, weiss die Serie nicht mehr.
    if (orig.grid_from && date < orig.grid_from) return false;
    // Übersprungen (eine gelöschte Instanz) oder schon vorhanden? Beides wird am
    // Fälligkeitstag geprüft, nicht am Monat: eine Wochenserie hat mehrere pro
    // Monat, und ein gelöschter Dienstag darf die übrigen nicht mitnehmen.
    if (skipStmt.get(orig.id, date)) return false;
    if (existsStmt.get(orig.id, date)) return false;

    // Materialisierte Instanz erbt Eigentümer + Sichtbarkeit der Serie
    // (#476/#505). Ohne das würde jede Instanz owner_id=NULL + visibility='shared'
    // (Spalten-Default) bekommen: eine private Serie würde im Haushalt sichtbar und
    // für die Eigentümer:in in scope=mine unsichtbar.
    // Verlangt die Serie eine Bestätigung (#637), entsteht die Buchung als
    // erwartet: sichtbar und planbar, aber in keiner Summe. Der Ursprung
    // selbst bleibt eine echte Buchung - er wurde von Hand eingetragen.
    // Das KONTO gehört in dieselbe Liste (#973): eine Dauerlastschrift geht
    // jeden Monat vom selben Konto ab. Es fehlte hier, seit es die Spalte
    // gibt, und die Wirkung war unauffällig, weil nur die erste Buchung von
    // Hand entsteht - ab dem zweiten Monat trug die Instanz kein Konto, und
    // wer nach Konto filtert, sah die Serie ab dort nicht mehr.
    //
    // AUSSER bei einer virtuellen Serie, und das ist keine Feinheit:
    // deren Instanzen sind Planwerte, keine Zahlungen. 1200 im Jahr stehen
    // dort als 100 je Monat, während die Bank einmal 1200 abbucht.
    // `listAccounts()` summiert jeden nicht-erwarteten Eintrag mit Konto in
    // den Saldo, und die Instanz trägt kein eigenes `recurrence_virtual` -
    // die Saldo-Abfrage könnte einen Planwert also gar nicht erkennen.
    // Gemessen: acht Monate einer virtuellen Jahresserie ergaben -800
    // Kontosaldo für eine Abbuchung, die noch gar nicht stattgefunden hat.
    // Ohne Konto bleibt der Saldo exakt so, wie er vor #973 war.
    const inheritsAccount = orig.recurrence_virtual ? null : (orig.account_id ?? null);
    const created = insertStmt.run(
      orig.title, orig.amount, orig.category, orig.subcategory || '', date,
      orig.id, orig.created_by, orig.owner_id, orig.visibility || 'shared',
      orig.recurrence_confirm ? 1 : 0, inheritsAccount,
    );

    // ZUSTAENDIGE ERBEN MIT (#1057). Anders als das Konto gilt das auch fuer
    // virtuelle Serien: das Etikett bewegt kein Geld, es kann also keinen
    // Saldo verfaelschen - und "wer kuemmert sich darum" ist am Planwert
    // genauso richtig wie an der Zahlung. Als eigene Anweisung statt im
    // INSERT, weil die Zustaendigkeit in einer n:m-Tabelle liegt.
    copyResponsiblesStmt.run(created.lastInsertRowid, orig.id);
    return true;
  };
  return write;
}

/**
 * Die Faelligkeitstage einer Serie (Zeile aus SERIES_SELECT) in einem Monat.
 *
 * Virtuelle Serien tragen in der Definition bereits den Monatsanteil: sie
 * kommen in JEDEM Monat einmal vor, am Tag des Starts, unabhaengig vom
 * Rhythmus - auch Wochenserien, deren Anteil sonst ueber den Monat verstreut
 * laege, ohne dass eine der Buchungen die Zahlung waere.
 * @param {object} orig
 * @param {string} month  YYYY-MM
 * @returns {string[]}
 */
function seriesDatesInMonth(orig, month) {
  if (!orig.recurrence_virtual) {
    return occurrenceDatesInMonth(orig.start_date, orig.recurrence_interval || 'monthly',
      orig.recurrence_interval_count, month);
  }
  const [y, m] = month.split('-').map(Number);
  const day = Math.min(parseInt(orig.start_date.split('-')[2], 10), new Date(Date.UTC(y, m, 0)).getUTCDate());
  return [`${month}-${String(day).padStart(2, '0')}`];
}

/**
 * Erstellt fehlende Instanzen wiederkehrender Budget-Einträge für den angefragten Monat.
 * Läuft idempotent - bereits vorhandene oder explizit übersprungene Instanzen werden ignoriert.
 *
 * Virtuelle Serien (recurrence_virtual = 1) halten in der Definition bereits den
 * geglätteten Monatsanteil (amount); es wird in JEDEM Monat eine Instanz erzeugt.
 * Nicht-virtuelle Serien erzeugen den vollen Betrag nur in Fälligkeitsmonaten
 * (an den Tagen aus occurrenceDatesInMonth).
 *
 * DIE WERTE KOMMEN AUS DER DEFINITION, NICHT VOM ANKER (#1035). Titel, Betrag,
 * Kategorie, Unterkategorie, Konto, Sichtbarkeit und Zustaendige stehen in
 * `budget_series` / `budget_series_responsibles`; der Anker - die erste, von
 * Hand erfasste Buchung - traegt nur noch seine eigenen. Bis v227 las diese
 * Funktion sie von dort, und deshalb schrieb jede Serien-Aenderung auf eine
 * Buchung, die schon passiert war. Vom Anker kommen weiterhin der Rhythmus und
 * Ersteller/Eigentuemer, die nie wechseln.
 *
 * AUCH DER STARTTAG KOMMT AUS DER DEFINITION (#1545), nicht aus dem Datum der
 * ersten Buchung. Aus ihm folgt das ganze Raster (Tag im Monat, Wochentag,
 * "alle N"); stand er am Anker, verschob eine Korrektur NUR der ersten Buchung
 * jedes Vorkommen, das noch nicht angelegt war. Ohne Starttag (eine Zeile, die
 * an v229 vorbei entstand) gilt das Datum des Ankers - das Verhalten bis v228.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {string} month  YYYY-MM
 */
export function generateRecurringInstances(database, month) {
  // Alle laufenden Serien, die vor diesem Monat begonnen haben.
  const originals = database.prepare(`
    ${SERIES_SELECT}
       AND strftime('%Y-%m', COALESCE(s.start_date, a.date)) < ?
  `).all(month);

  const writeOccurrence = occurrenceWriter(database);

  for (const orig of originals) {
    for (const date of seriesDatesInMonth(orig, month)) writeOccurrence(orig, date);
  }
}

/**
 * Legt das Vorkommen AM Starttag einer Serie an (#1545).
 *
 * generateRecurringInstances() laesst den Starttag bewusst aus: dieses
 * Vorkommen ist die erste Buchung, der Anker - auch nachdem ihr Datum einzeln
 * korrigiert wurde. Verlegt "alle kuenftigen aendern" den Starttag aber,
 * waehrend die erste Buchung schon gebucht ist, bleibt sie, wo sie war (sie
 * behaelt ihre Werte, #1035), und der neue Starttag hat keine Buchung. Liegt
 * er ab heute, entsteht sie hier; was davor liegt, ist gebucht und wird von
 * einer Serien-Aenderung nicht mehr angefasst.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number} anchorId
 */
export function materializeSeriesStart(database, anchorId) {
  const orig = database.prepare(`${SERIES_SELECT} AND a.id = ?`).get(anchorId);
  if (orig) occurrenceWriter(database)(orig, orig.start_date);
}

/**
 * Friert die Vergangenheit einer Serie ein, BEVOR sich ihr Raster aendert
 * (#1545, Entscheidung in #1585): jedes Vorkommen vom Monat nach dem Start
 * bis vor `cutoffDate`, das noch nicht angelegt ist, entsteht jetzt - im
 * ALTEN Raster, mit den Werten der Definition, wie es ein Aufruf des Monats
 * vor der Aenderung angelegt haette.
 *
 * Ohne das waere ein vergangener Monat, der nie aufgeschlagen wurde, nach der
 * Aenderung leer: vor grid_from entsteht nichts mehr, und das alte Raster
 * kennt danach niemand. Vorhandene und geloeschte (uebersprungene) Vorkommen
 * laesst occurrenceWriter() stehen, ein zweiter Aufruf legt also nichts
 * doppelt an. Laeuft in der Transaktion des Aufrufers, vor jeder Aenderung
 * an Anker und Definition.
 *
 * Menge: der kleinste Schritt ist eine Woche (52 im Jahr). Gemessen, einmalig
 * je Aenderung: woechentlich seit 2000 rund 1400 Zeilen in 24 ms, seit 1970
 * rund 3000 in 54 ms; das Aeusserste, was die Datumspruefung zulaesst
 * (woechentlich seit dem Jahr 1000), rund 54.000 in 0,9 s. Linear nur dank
 * idx_budget_parent_date (v229) - ohne ihn las jede Existenzfrage alle
 * Buchungen der Serie. Eine Obergrenze gibt es deshalb nicht: sie risse
 * genau die Luecken wieder auf, die das Einfrieren schliesst.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {number} anchorId
 * @param {string} cutoffDate  YYYY-MM-DD, heute in der Haushaltszone
 * @returns {number} neu angelegte Vorkommen
 */
export function freezeSeriesPast(database, anchorId, cutoffDate) {
  const orig = database.prepare(`${SERIES_SELECT} AND a.id = ?`).get(anchorId);
  if (!orig) return 0;
  const writeOccurrence = occurrenceWriter(database);
  const lastMonth = cutoffDate.slice(0, 7);
  // Wie generateRecurringInstances(): ab dem Monat NACH dem Starttag (dessen
  // Monat gehoert der ersten Buchung), und vor einer frueheren
  // Rasteraenderung entsteht ohnehin nichts (grid_from) - dort beginnen.
  let [y, m] = orig.start_date.slice(0, 7).split('-').map(Number);
  m += 1;
  if (orig.grid_from) {
    const [gy, gm] = orig.grid_from.slice(0, 7).split('-').map(Number);
    if (gy * 12 + gm > y * 12 + m) { y = gy; m = gm; }
  }
  let created = 0;
  for (;;) {
    if (m > 12) { y += 1; m = 1; }
    const month = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    if (month > lastMonth) break;
    for (const date of seriesDatesInMonth(orig, month)) {
      if (date < cutoffDate && writeOccurrence(orig, date)) created += 1;
    }
    m += 1;
  }
  return created;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const STATS_RANGES = new Set(['week', 'month', 'year']);

export function ymd(d) { return d.toISOString().slice(0, 10); }        // YYYY-MM-DD (UTC)
export function ym(d)  { return d.toISOString().slice(0, 7);  }        // YYYY-MM   (UTC)

export function todayLocalDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function thisMonthLocalKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Leitet Zeitraum, Vorperiode und lückenlose Bucket-Keys aus range+anchor ab.
 * @param {'week'|'month'|'year'} range
 * @param {string} anchor  YYYY-MM-DD
 */
export function computeStatsRange(range, anchor) {
  if (!STATS_RANGES.has(range)) throw new Error('invalid range');
  if (!DATE_RE.test(anchor)) throw new Error('invalid anchor');
  const a = new Date(`${anchor}T00:00:00Z`);
  if (Number.isNaN(a.getTime())) throw new Error('invalid anchor');

  if (range === 'week') {
    const dow = (a.getUTCDay() + 6) % 7; // Mo=0 .. So=6
    const start = new Date(a); start.setUTCDate(a.getUTCDate() - dow);
    const end   = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
    const prevS = new Date(start); prevS.setUTCDate(start.getUTCDate() - 7);
    const prevE = new Date(start); prevE.setUTCDate(start.getUTCDate() - 1);
    const bucketKeys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
      bucketKeys.push(ymd(d));
    }
    return { range, from: ymd(start), to: ymd(end), prevFrom: ymd(prevS), prevTo: ymd(prevE), granularity: 'day', bucketKeys };
  }

  if (range === 'month') {
    const y = a.getUTCFullYear(), m = a.getUTCMonth();
    const start = new Date(Date.UTC(y, m, 1));
    const end   = new Date(Date.UTC(y, m + 1, 0));
    const prevS = new Date(Date.UTC(y, m - 1, 1));
    const prevE = new Date(Date.UTC(y, m, 0));
    const bucketKeys = [];
    for (let d = 1; d <= end.getUTCDate(); d++) bucketKeys.push(ymd(new Date(Date.UTC(y, m, d))));
    return { range, from: ymd(start), to: ymd(end), prevFrom: ymd(prevS), prevTo: ymd(prevE), granularity: 'day', bucketKeys };
  }

  // year
  const y = a.getUTCFullYear();
  const bucketKeys = [];
  for (let mo = 0; mo < 12; mo++) bucketKeys.push(ym(new Date(Date.UTC(y, mo, 1))));
  return {
    range, from: `${y}-01-01`, to: `${y}-12-31`,
    prevFrom: `${y - 1}-01-01`, prevTo: `${y - 1}-12-31`,
    granularity: 'month', bucketKeys,
  };
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'category';
}

export function uniqueKey(table, base) {
  const normalized = slugify(base);
  let key = normalized;
  let i = 2;
  const exists = db.get().prepare(`SELECT 1 FROM ${table} WHERE key = ?`);
  while (exists.get(key)) {
    key = `${normalized}_${i}`;
    i += 1;
  }
  return key;
}

/**
 * Wer eine Kategorie traegt: Buchungen, und seit Migration 271 auch Ausgaben
 * und Serien der Aufteilung (`budget_category`). Zaehlte bis Codex an #2364
 * nur Buchungen - eine Kategorie, die nur Aufteilungs-Ausgaben trugen, liess
 * sich loeschen, und danach scheiterte jedes Speichern dieser Ausgaben.
 */
export function categoryInUseCount(database, key) {
  return database.prepare(`
    SELECT (SELECT COUNT(*) FROM budget_entries WHERE category = @key)
         + (SELECT COUNT(*) FROM expenses WHERE budget_category = @key)
         + (SELECT COUNT(*) FROM recurring_expenses WHERE budget_category = @key) AS n
  `).get({ key }).n;
}

export function subcategoryInUseCount(database, key) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE subcategory = ?').get(key).n;
}

export function categoryCountByType(database, type) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_categories WHERE type = ?').get(type).n;
}

export function subcategoryCountForCategory(database, categoryKey) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_subcategories WHERE category_key = ?').get(categoryKey).n;
}

export function loadBudgetMeta() {
  const categories = db.get().prepare(`
    SELECT key, name, type, sort_order
    FROM budget_categories
    ORDER BY type DESC, sort_order ASC, name COLLATE NOCASE ASC
  `).all();
  const subcategories = db.get().prepare(`
    SELECT key, category_key, name, sort_order
    FROM budget_subcategories
    ORDER BY sort_order ASC, name COLLATE NOCASE ASC
  `).all();

  const expenseCategories = categories.filter((c) => c.type === 'expense');
  const incomeCategories = categories.filter((c) => c.type === 'income');
  // Nach Kategorie gruppiert, über beide Typen: Subkategorien gehören seit
  // #691 auch an Einnahmen-Kategorien. Der Schlüssel ist die Kategorie, nicht
  // ihr Typ - eine Aufteilung nach expense/income hätte hier keinen Leser.
  const subcategoriesByCategory = {};
  for (const sub of subcategories) {
    if (!subcategoriesByCategory[sub.category_key]) subcategoriesByCategory[sub.category_key] = [];
    subcategoriesByCategory[sub.category_key].push(sub);
  }

  return { categories, expenseCategories, incomeCategories, subcategories: subcategoriesByCategory };
}

export function validCategoryKeys() {
  return db.get().prepare('SELECT key FROM budget_categories').all().map((c) => c.key);
}

export function validExpenseCategoryKeys() {
  return db.get().prepare("SELECT key FROM budget_categories WHERE type = 'expense'").all().map((c) => c.key);
}

export function defaultCategory(type) {
  const row = db.get().prepare(`
    SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order ASC, name COLLATE NOCASE ASC LIMIT 1
  `).get(type);
  return row?.key || (type === 'expense' ? 'financial_other' : 'Sonstiges Einkommen');
}

export function defaultSubcategory(category) {
  const row = db.get().prepare(`
    SELECT key FROM budget_subcategories WHERE category_key = ? ORDER BY sort_order ASC, name COLLATE NOCASE ASC LIMIT 1
  `).get(category);
  return row?.key || '';
}

export function validateSubcategory(category, subcategory) {
  if (!subcategory) return defaultSubcategory(category);
  const row = db.get().prepare(`
    SELECT 1 FROM budget_subcategories WHERE category_key = ? AND key = ?
  `).get(category, subcategory);
  return row ? subcategory : null;
}

/** Ganze Monate von `from` bis `to` (beide YYYY-MM); 0, wenn eines fehlt. */
export function monthsBetween(from, to) {
  const re = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const a = re.exec(String(from ?? ''));
  const b = re.exec(String(to ?? ''));
  if (!a || !b) return 0;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Der Faelligkeitstag eines Darlehens in einem Monat, als Tagesschluessel (#1631).
 *
 * DIE EINE STELLE, AN DER GEKLEMMT WIRD: ein Tag, den der Monat nicht hat, wird
 * zu dessen letztem - der 31. im April zum 30., im Februar zum 28. oder 29.
 * Gerechnet wird am Schluessel, nicht an einem Zeitpunkt: `Date.UTC(y, m, 0)`
 * fragt nur nach der Laenge des Monats, eine Zone kommt nicht vor, und "heute"
 * auch nicht - der Faelligkeitstag einer Rate haengt nicht daran, wann jemand
 * fragt.
 *
 * @param {string} ym       Monat "YYYY-MM"
 * @param {unknown} dueDay  1 bis 31; alles andere heisst "kein Faelligkeitstag"
 * @returns {string|null}   "YYYY-MM-DD" oder null
 */
export function dueDateInMonth(ym, dueDay) {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(Math.min(dueDay, lastDay)).padStart(2, '0')}`;
}

/**
 * Das Datum, das ein Darlehen fuer seine naechste Rate nennt (`next_due_date`).
 *
 * Mit Faelligkeitstag ist es dieser Tag im Faelligkeitsmonat (#1631) - keine
 * Frage an die Uhr. Ohne Faelligkeitstag kennt das Darlehen nur den Monat, und
 * dann entscheidet der Monat des Haushalts (#1741):
 *   - liegt der Faelligkeitsmonat VOR dem laufenden, ist es dessen Erster. Wer
 *     ein Darlehen von 2022 nachtraegt, bucht die Raten sonst alle in den Monat
 *     des Tippens. Der Erste ist die Konvention, die "bereits gezahlte Raten"
 *     (`seedPaidInstallments`) ohne Faelligkeitstag schon benutzen - eine
 *     Buchungskonvention, keine Faelligkeit: die Karte nennt weiter den Monat.
 *   - sonst (laufender oder kuenftiger Monat) null, und "Als bezahlt markieren"
 *     bleibt bei heute.
 *
 * @param {string} ym       Faelligkeitsmonat "YYYY-MM"
 * @param {unknown} dueDay  1 bis 31 oder kein Faelligkeitstag
 * @param {string} today    Tagesschluessel des Haushalts (`todayKey(db)`), nie der UTC-Tag
 * @returns {string|null}   "YYYY-MM-DD" oder null
 */
export function nextInstallmentDate(ym, dueDay, today) {
  const onDueDay = dueDateInMonth(ym, dueDay);
  if (onDueDay) return onDueDay;
  if (dueDay != null) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym ?? ''))) return null;
  return ym < String(today ?? '').slice(0, 7) ? `${ym}-01` : null;
}

export function cents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

// --------------------------------------------------------
// Währung je Darlehen (#582)
// --------------------------------------------------------

export const CURRENCY_RE = /^[A-Z]{3}$/;

/** Haushaltweite Budget-Währung aus sync_config (Fallback wie in /preferences). */
export function budgetCurrency() {
  return db.get().prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value || 'EUR';
}

export function budgetChartCategorySql(alias) {
  return `CASE WHEN ${alias}.category = 'financial_other' AND ${alias}.subcategory = 'saving'
    THEN '${SAVINGS_CHART_CATEGORY}' ELSE ${alias}.category END`;
}

/** Transfers carry one amount, so both accounts must use the same effective currency. */
export function transferCurrenciesMatch(firstId, secondId) {
  const currency = budgetCurrency();
  const account = db.get().prepare('SELECT currency FROM budget_accounts WHERE id = ?');
  const first = account.get(firstId);
  const second = account.get(secondId);
  return Boolean(first && second && (first.currency || currency) === (second.currency || currency));
}

export function isArchivedBudgetAccount(id) {
  return Boolean(db.get().prepare('SELECT archived FROM budget_accounts WHERE id = ?').get(id)?.archived);
}

export function budgetAccountCurrency(id) {
  return db.get().prepare('SELECT currency FROM budget_accounts WHERE id = ?').get(id)?.currency || budgetCurrency();
}

function accountFractionDigits(currency) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().minimumFractionDigits; }
  catch { return 2; }
}

export function transferAmountFitsCurrency(amount, accountId) {
  const value = Number(amount);
  return Number.isFinite(value) && value !== 0
    && Number(value.toFixed(accountFractionDigits(budgetAccountCurrency(accountId)))) === value;
}

/**
 * Fester Umrechnungskurs eines Darlehens in die Budget-Währung (#582).
 * Semantik: 1 Einheit Darlehenswährung = rate Einheiten Budget-Währung.
 * Unplausible oder fehlende Werte fallen auf 1 zurück, damit Altbestand und
 * Darlehen in Budget-Währung nie durch einen Kurs verfälscht werden.
 */
export function loanRate(loan) {
  const rate = Number(loan?.exchange_rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/** Rechnet einen Darlehensbetrag in die Budget-Währung um (#582). */
export function toBudgetAmount(amount, loan) {
  return cents(Number(amount || 0) * loanRate(loan));
}

/**
 * Kurs von der Darlehenswaehrung in die Waehrung der Buchung einer Rate
 * (#2302): eine Buchung steht in der Waehrung ihres Kontos, ohne Konto in der
 * Budget-Waehrung. Traegt das Konto die Darlehenswaehrung, bucht die Rate
 * ohne Umrechnung; traegt es die Budget-Waehrung, gilt der feste Kurs des
 * Darlehens (#582). Eine dritte Waehrung geht ueber den festen Kurs bis zur
 * Budget-Waehrung und von dort ueber den Kurs-Cache - null, wenn der keinen
 * kennt: dann gibt es keine richtige Zahl, und der Aufrufer lehnt ab.
 */
export function loanEntryRate(loan, accountId, { bookedRate = null } = {}) {
  const base = budgetCurrency();
  const target = accountId != null ? budgetAccountCurrency(accountId) : base;
  if (target === (loan?.currency || base)) return 1;
  if (target === base) return loanRate(loan);
  // Eine schon gebuchte Rate behaelt ihren Kurs: der Cache aendert sich, die
  // Buchung nicht (Codex zu #2302).
  if (bookedRate > 0 && Number.isFinite(bookedRate)) return bookedRate;
  const onward = cachedRate(base, target);
  return onward == null ? null : loanRate(loan) * onward;
}

/**
 * Das Nettovermoegen der aktiven Konten (#2302). Jedes Konto fuehrt seinen
 * Saldo in seiner Waehrung; eine Rohsumme ueber Dollar und Euro waere eine
 * falsche Zahl. Stehen alle in der Budget-Waehrung, bleibt es die Summe. Sonst
 * rechnet der Kurs-Cache in die Budget-Waehrung um, und die Antwort sagt, dass
 * es eine Naeherung ist und von wann ihr aeltester Kurs stammt. Fehlt ein Kurs,
 * ist `net_worth` null, und `net_worth_by_currency` traegt die Summe je Waehrung -
 * keine Zahl ist besser als eine falsche.
 */
export function netWorthSummary(accounts) {
  const base = budgetCurrency();
  const totals = new Map();
  for (const a of accounts) {
    if (a.archived) continue;
    const currency = a.currency || base;
    totals.set(currency, (totals.get(currency) ?? 0) + Number(a.current_balance || 0));
  }
  // Jede Teilsumme in den Stellen IHRER Waehrung (KWD drei, JPY keine) -
  // gerundet wird erst die umgerechnete Summe (Codex zu #2335).
  const inDigits = (amount, currency) => {
    const f = 10 ** accountFractionDigits(currency);
    return Math.round(amount * f) / f;
  };
  const byCurrency = [...totals].map(([currency, amount]) => ({ currency, amount: inDigits(amount, currency) }))
    .sort((x, y) => (x.currency === base ? -1 : y.currency === base ? 1 : x.currency.localeCompare(y.currency)));
  if (byCurrency.every((p) => p.currency === base)) return { net_worth: byCurrency[0]?.amount ?? 0 };
  let sum = 0;
  let ratesAt = null;
  for (const part of byCurrency) {
    const info = cachedRateInfo(part.currency, base);
    if (!info) return { net_worth: null, net_worth_by_currency: byCurrency };
    sum += part.amount * info.rate;
    if (info.fetchedAt && (!ratesAt || info.fetchedAt < ratesAt)) ratesAt = info.fetchedAt;
  }
  return { net_worth: cents(sum), net_worth_approx: true, net_worth_rates_at: ratesAt, net_worth_by_currency: byCurrency };
}

// --------------------------------------------------------
// Richtung eines Darlehens (#638)
// --------------------------------------------------------

// Das Modul war ursprünglich nur für verliehenes Geld gedacht - die Rate wurde
// deshalb immer als Einnahme gebucht. Ein aufgenommener Kredit zahlt aber raus,
// seine Rate ist eine Ausgabe.
export const LOAN_DIRECTIONS = ['lent', 'borrowed'];

// Wie eine Rate ins Budget gebucht wird. Vorzeichen UND Kategorie hängen an der
// Richtung: stats.js liest den Typ am Vorzeichen ab (amount > 0 = Einnahme), die
// Kategorie muss dazu passen, sonst steht eine Ausgabe unter einer income-Kategorie.
//
// Diese Regel steht hier und nicht im Loans-Router, weil sie an DREI Stellen gilt:
// beim Buchen einer Rate, beim Umbuchen nach einem Richtungswechsel und beim
// Bearbeiten des gekoppelten Budget-Eintrags. Solange sie nur der Loans-Router
// kannte, erzwang der Eintrags-Router weiter das alte "Rate = Einnahme" und
// sperrte damit jede Korrektur an der Rate eines aufgenommenen Kredits (#859).
export const REPAYMENT_BOOKING = {
  lent: { sign: 1, category: 'Geschenke & Transfers', subcategory: '' },
  borrowed: { sign: -1, category: 'financial_other', subcategory: 'loans_interest' },
};

/** Buchungsregel eines Darlehens; unbekannte/fehlende Richtung fällt auf 'lent' zurück. */
export function bookingFor(direction) {
  return REPAYMENT_BOOKING[direction] || REPAYMENT_BOOKING.lent;
}

/**
 * @param {object} loan
 * @param {string} [baseCurrency]
 * @param {string} [today]  Tagesschluessel des Haushalts; die Liste reicht ihn
 *                          einmal durch, statt ihn je Darlehen neu zu lesen.
 */
export function loanSummaryRow(loan, baseCurrency = budgetCurrency(), today = todayKey(db.get())) {
  const payments = db.get().prepare(`
    SELECT p.*, u.display_name AS creator_name,
           b.title AS entry_title,
           b.category AS entry_category,
           b.subcategory AS entry_subcategory,
           b.is_recurring AS entry_is_recurring,
           b.recurrence_parent_id AS entry_recurrence_parent_id
    FROM budget_loan_payments p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN budget_entries b ON b.id = p.budget_entry_id
    WHERE p.loan_id = ?
    ORDER BY p.installment_number ASC
  `).all(loan.id);
  const paidAmount = cents(payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
  const paidInstallments = payments.length;
  const remainingAmount = Math.max(0, cents(loan.total_amount - paidAmount));
  const remainingInstallments = Math.max(0, loan.installment_count - paidInstallments);
  // Zins-Darlehen (#569): reale monatliche Belastung ist die konstante Annuität,
  // nicht der Durchschnitt total_amount/installment_count (die letzte Rate ist
  // kleiner). Sonst weicht der gebuchte Ratenbetrag von der angezeigten Monatsrate
  // ab. Die letzte Rate wird im Zahlungs-Default ohnehin über remaining_amount getrued.
  // Wo der VERTRAG heute steht (#1706): die Rate, die im laufenden Monat des
  // Haushalts faellig ist, mindestens die naechste ungebuchte. Wer Raten nicht
  // nachgetragen hat, steht im Vertrag trotzdem dort, wo der Kalender ihn
  // hinstellt - die Zinsbindung endet nicht spaeter, weil Buchungen fehlen.
  const currentMonth = String(today ?? '').slice(0, 7);
  const lagMonths = Math.max(0, monthsBetween(addMonths(loan.start_month, paidInstallments), currentMonth));
  const interest = loanInterestSummary(loan, payments, paidInstallments + 1 + lagMonths);
  const installmentAmount = interest ? interest.monthly_payment : cents(loan.total_amount / loan.installment_count);
  // Restschuld: das noch offene Kapital, seit #954 aus den gebuchten Beträgen
  // nachgerechnet statt an der Planposition abgelesen. remainingAmount oben ist
  // dagegen die Summe der Restraten und enthält die Zinsen der Restlaufzeit - bei
  // verzinsten Darlehen liegen die beiden Werte deshalb auseinander, und die
  // Restschuld ist die Zahl, die auch die Bank meldet. Zinsfreie Darlehen haben
  // keinen Zinsanteil, dort sind beide identisch.
  const remainingPrincipal = interest ? interest.remaining_principal : remainingAmount;

  // Fertig ist ein Darlehen, wenn kein Kapital mehr offen ist - beim Zins-Darlehen
  // entscheidet das seit #954 die REALE Restschuld: wer frueh tilgt, schuldet die
  // kuenftigen Planzinsen nicht nach, also darf danach auch keine Rate mehr buchbar
  // sein. remaining_installments zaehlt weiter die ungebuchten Plan-Raten (eine
  // Zaehlung, keine Schuld); zinsfreie Darlehen laufen ueber denselben Ausdruck,
  // weil remainingPrincipal dort remainingAmount IST.
  const settled = remainingInstallments <= 0 || remainingPrincipal <= 0.005;

  // Währung je Darlehen (#582): Alle Beträge oben bleiben in der Darlehenswährung.
  // currency=NULL heißt "Budget-Währung" und wird erst hier aufgelöst, damit eine
  // spätere Umstellung der Haushaltswährung den Altbestand mitzieht.
  const currency = loan.currency || baseCurrency;
  const rate = currency === baseCurrency ? 1 : loanRate(loan);

  const nextDueMonth = !settled ? addMonths(loan.start_month, paidInstallments) : null;

  // Restlaufzeit, die dem Geld folgt (#964); ohne Zinsteil ist die Planzahl die
  // Antwort. Ein Zins-Darlehen ohne Prognose (die Rate deckt den Zins nicht)
  // hat kein Enddatum - die Planzahl wuerde dort eines behaupten.
  const forecastInstallments = forecastRemainingInstallments(loan, interest, paidInstallments);
  const installmentsToGo = interest ? forecastInstallments : remainingInstallments;
  // Gezaehlt wird ab dem spaeteren von naechster Faelligkeit und laufendem
  // Monat: ein laufendes Darlehen mit Buchungsrueckstand endet nicht in der
  // Vergangenheit. Die ungebuchten Raten stehen noch aus, also ab heute.
  const projectedEndMonth = nextDueMonth && installmentsToGo > 0
    ? addMonths(nextDueMonth, lagMonths + installmentsToGo - 1)
    : null;

  return {
    ...loan,
    currency,
    exchange_rate: rate,
    is_foreign_currency: currency !== baseCurrency,
    total_amount: cents(loan.total_amount),
    installment_amount: installmentAmount,
    paid_amount: paidAmount,
    paid_installments: paidInstallments,
    remaining_amount: remainingAmount,
    remaining_principal: remainingPrincipal,
    remaining_installments: remainingInstallments,
    // Dieselbe Zahl, aber am Kontostand statt am Vertrag gerechnet (#964).
    // Ohne Zinsteil oder bei nicht amortisierender Rate bleibt sie null, und die
    // Oberflaeche zeigt dann allein die Planzahl.
    remaining_installments_forecast: forecastInstallments,
    // Der Monat der letzten Rate (#1706), aus DERSELBEN Restlaufzeit gerechnet:
    // die naechste Faelligkeit plus die noch faelligen Raten. Null, wenn nichts
    // mehr offen ist oder die Restlaufzeit selbst keine Antwort hat.
    projected_end_month: projectedEndMonth,
    is_settled: settled,
    next_installment_number: !settled ? paidInstallments + 1 : null,
    next_due_month: nextDueMonth,
    // Der Tag dazu (#1631), wenn das Darlehen einen nennt. Ohne Faelligkeitstag
    // der Erste des Monats, sobald dieser vorbei ist (#1741), sonst null, und
    // "Als bezahlt markieren" bleibt bei heute. Die Oberflaeche reicht den Wert
    // als paid_date durch, statt selbst zu rechnen.
    next_due_date: nextDueMonth ? nextInstallmentDate(nextDueMonth, loan.due_day, today) : null,
    interest,
    payments,
  };
}

// Zins-Darlehen (#569): Kennzahlen für die Anzeige aus dem Amortisationsplan
// (exakte Monatsrate, Gesamtzins, Restschuld nach Zinsbindung). Zinsfreie
// Darlehen liefern null, sodass die Anzeige unverändert bleibt.
// payments steuert nur remaining_principal: die Restschuld folgt seit #954 den
// gebuchten Beträgen (Sondertilgung senkt sie, Minderzahlung nicht), alle
// anderen Kennzahlen bleiben planbasiert und vom Zahlungsfortschritt unabhängig.
export function loanInterestSummary(loan, payments = [], currentInstallment = payments.length + 1) {
  if (!loan.interest_mode || loan.interest_mode === 'none' || loan.principal == null) return null;
  const calc = computeLoanSchedule({
    principal: loan.principal,
    fixedRate: loan.fixed_rate,
    initialRepaymentRate: loan.initial_repayment_rate,
    interestMode: loan.interest_mode,
    fixedPeriodMonths: loan.fixed_period_months,
    followupRate: loan.followup_rate,
  });
  if (!calc.ok) return null;
  return {
    mode: loan.interest_mode,
    principal: cents(loan.principal),
    fixed_rate: loan.fixed_rate,
    initial_repayment_rate: loan.initial_repayment_rate,
    fixed_period_months: loan.fixed_period_months,
    followup_rate: loan.followup_rate,
    monthly_payment: calc.monthlyPayment,
    total_interest: calc.totalInterest,
    remaining_principal: remainingPrincipalFromPayments({
      principal: loan.principal,
      fixedRate: loan.fixed_rate,
      interestMode: loan.interest_mode,
      fixedPeriodMonths: loan.fixed_period_months,
      followupRate: loan.followup_rate,
    }, payments),
    // Der Satz, der HEUTE gilt (#1706): nach ihm sortiert die Darlehensliste.
    // Es ist der Satz der Rate, die im laufenden Monat faellig ist (mindestens
    // der naechsten ungebuchten) - waehrend der Zinsbindung der feste, danach
    // der Anschlusssatz, nach derselben Phasenregel wie der Tilgungsplan.
    current_rate: rateForInstallment({
      fixedRate: loan.fixed_rate,
      interestMode: loan.interest_mode,
      fixedPeriodMonths: loan.fixed_period_months,
      followupRate: loan.followup_rate,
    }, currentInstallment),
    remaining_after_binding: calc.remainingAfterBinding,
    binding_end_month: loan.fixed_period_months ? addMonths(loan.start_month, loan.fixed_period_months) : null,
  };
}

/**
 * Die Restlaufzeit, die dem Geld folgt (#964).
 *
 * `remaining_installments` an der Zeile zaehlt weiter die ungebuchten
 * PLAN-Raten - das beschreibt den Vertrag und bleibt stehen. Diese Zahl daneben
 * beantwortet die andere Frage: wie viele Raten sind es bei der REALEN
 * Restschuld noch? Wer sondertilgt, sieht sie sinken, waehrend die Planzahl
 * unveraendert bleibt; die Oberflaeche zeigt beide, damit der Vertragsblick
 * nicht still verschwindet.
 *
 * `null`, wo die Frage keinen Sinn hat: zinsfreie Darlehen (dort IST die
 * Planzahl die Antwort), nicht amortisierende Raten, und alles, was
 * computeLoanSchedule schon nicht rechnen konnte.
 */
function forecastRemainingInstallments(loan, interest, paidInstallments) {
  if (!interest) return null;
  const zahl = remainingInstallmentsForBalance({
    balance: interest.remaining_principal,
    monthlyPayment: interest.monthly_payment,
    fixedRate: loan.fixed_rate,
    interestMode: loan.interest_mode,
    fixedPeriodMonths: loan.fixed_period_months,
    followupRate: loan.followup_rate,
    paidInstallments,
  });
  return zahl;
}

export function loadLoan(id, baseCurrency = budgetCurrency()) {
  const loan = db.get().prepare(`
    SELECT l.*, u.display_name AS creator_name
    FROM budget_loans l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = ?
  `).get(id);
  return loan ? loanSummaryRow(loan, baseCurrency) : null;
}

export function refreshLoanStatus(loanId) {
  const loan = loadLoan(loanId);
  if (!loan) return null;
  // is_settled traegt seit #954 auch die reale Restschuld des Zins-Darlehens -
  // eine fruehe Volltilgung stellt den Status auf paid, obwohl Plan-Raten
  // ungebucht bleiben (deren Zinsen schuldet niemand nach).
  const status = loan.is_settled ? 'paid' : 'active';
  if (status !== loan.status) {
    db.get().prepare('UPDATE budget_loans SET status = ? WHERE id = ?').run(status, loanId);
    return loadLoan(loanId);
  }
  return loan;
}

/* DIE ZUSTAENDIGEN EINER BUCHUNG ALS JSON (#1057).
 *
 * Als Unterabfrage und nicht als JOIN: ein JOIN auf eine n:m-Tabelle
 * vervielfacht die Zeile je zustaendiger Person, und jede Summe darueber waere
 * still falsch. Dieselbe Form, die der Kalender fuer `assigned_users` benutzt.
 *
 * Der Baustein erwartet die Buchung als `b` - alle drei Lesepfade dieses Moduls
 * benennen sie so.
 */
export const RESPONSIBLE_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', ru.id, 'display_name', ru.display_name, 'color', ru.avatar_color
  ))
  FROM budget_entry_responsibles ber JOIN users ru ON ru.id = ber.user_id
  WHERE ber.entry_id = b.id
) AS responsible_users_json`;

/**
 * Die Zustaendigen einer Buchung ersetzen (#1057).
 *
 * ERSETZEN, NICHT ERGAENZEN: das Formular sendet die vollstaendige Auswahl, und
 * "niemand" muss ausdrueckbar sein. Ein leeres Array loescht also alle Zeilen.
 * `undefined` dagegen heisst "nicht mitgeschickt" und laesst alles stehen -
 * sonst raeumte jeder Teil-Request (etwa das Abhaken einer Buchung) die
 * Zustaendigkeit ab.
 *
 * @param {number} entryId
 * @param {Array<number>|undefined} rawUserIds
 */
export function replaceResponsibles(entryId, rawUserIds) {
  if (rawUserIds === undefined) return;
  const ids = Array.isArray(rawUserIds)
    ? [...new Set(rawUserIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  db.get().prepare('DELETE FROM budget_entry_responsibles WHERE entry_id = ?').run(entryId);
  if (!ids.length) return;
  // Unbekannte IDs fallen still weg statt den Request zu kippen: die Auswahl
  // kann eine Person nennen, die zwischen Laden und Absenden entfernt wurde.
  const ins = db.get().prepare(`
    INSERT OR IGNORE INTO budget_entry_responsibles (entry_id, user_id)
    SELECT ?, id FROM users WHERE id = ?
  `);
  for (const id of ids) ins.run(entryId, id);
}

/**
 * Die Zustaendigen einer Serien-DEFINITION ersetzen (#1035) - dieselbe Regel
 * wie replaceResponsibles(), nur fuer die Vorlage statt fuer eine Buchung.
 * Ohne Definition (Serie beendet) gibt es nichts zu schreiben.
 *
 * @param {number} anchorId
 * @param {Array<number>|undefined} rawUserIds
 */
export function replaceSeriesResponsibles(anchorId, rawUserIds) {
  if (rawUserIds === undefined) return;
  if (!db.get().prepare('SELECT 1 FROM budget_series WHERE anchor_id = ?').get(anchorId)) return;
  const ids = Array.isArray(rawUserIds)
    ? [...new Set(rawUserIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  db.get().prepare('DELETE FROM budget_series_responsibles WHERE anchor_id = ?').run(anchorId);
  const ins = db.get().prepare(`
    INSERT OR IGNORE INTO budget_series_responsibles (anchor_id, user_id)
    SELECT ?, id FROM users WHERE id = ?
  `);
  for (const id of ids) ins.run(anchorId, id);
}

/**
 * Wird eine Buchung zur Serie, ist sie deren Vorlage - auch fuer die
 * Zustaendigen (#1035). Die Werte uebernimmt der Trigger aus v228; die
 * Zustaendigen liegen in einer eigenen Tabelle und werden erst NACH dem
 * Insert/Update der Buchung geschrieben, deshalb hier.
 *
 * @param {number} anchorId
 */
export function seedSeriesResponsibles(anchorId) {
  if (!db.get().prepare('SELECT 1 FROM budget_series WHERE anchor_id = ?').get(anchorId)) return;
  db.get().prepare('DELETE FROM budget_series_responsibles WHERE anchor_id = ?').run(anchorId);
  db.get().prepare(`
    INSERT OR IGNORE INTO budget_series_responsibles (anchor_id, user_id)
    SELECT entry_id, user_id FROM budget_entry_responsibles WHERE entry_id = ?
  `).run(anchorId);
}

/**
 * Wer unter den mitgeschickten Zustaendigen NEU waere und kein Haushaltsmitglied
 * ist (#1207) - gegen den gespeicherten Stand des Eintrags `entryId`: wer dort
 * schon steht, bleibt gueltig. `undefined` heisst "nicht mitgeschickt", wie in
 * replaceResponsibles(). Vor jedem Schreiben zu fragen: replaceResponsibles()
 * laeuft erst nach dem eigentlichen Update und verwirft Unbekannte still.
 *
 * @param {number|null} entryId
 * @param {Array<number>|undefined} rawUserIds
 * @returns {number[]}
 */
export function responsibleNonMembers(entryId, rawUserIds, { series = false } = {}) {
  if (!Array.isArray(rawUserIds)) return [];
  const ids = rawUserIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  // Fuer eine Serien-Aenderung zaehlt der Stand der Definition (#1035), nicht
  // der ihrer ersten Buchung.
  const sql = series
    ? 'SELECT user_id FROM budget_series_responsibles WHERE anchor_id = ?'
    : 'SELECT user_id FROM budget_entry_responsibles WHERE entry_id = ?';
  const stored = entryId == null ? [] : db.get().prepare(sql).all(entryId).map((r) => r.user_id);
  return newNonMembers(ids, { stored });
}

/** Das JSON aus RESPONSIBLE_USERS_SQL in ein Array wandeln. */
export function withResponsibles(row) {
  if (!row) return row;
  const { responsible_users_json, ...rest } = row;
  let parsed = [];
  try { parsed = responsible_users_json ? JSON.parse(responsible_users_json) : []; } catch { parsed = []; }
  return { ...rest, responsible_users: parsed };
}

export function entryWithLoanMeta(id) {
  return withResponsibles(db.get().prepare(`
    SELECT b.*, u.display_name AS creator_name,
           ${RESPONSIBLE_USERS_SQL},
           p.id AS loan_payment_id,
           p.loan_id AS loan_id,
           p.installment_number AS loan_installment_number,
           l.title AS loan_title,
           l.borrower AS loan_borrower
    FROM budget_entries b
    LEFT JOIN users u ON u.id = b.created_by
    LEFT JOIN budget_loan_payments p ON p.budget_entry_id = b.id
    LEFT JOIN budget_loans l ON l.id = p.loan_id
    WHERE b.id = ?
  `).get(id));
}

// --------------------------------------------------------
// Konten (#495): getrennte Konten mit Startsaldo + laufendem Saldo
// --------------------------------------------------------

export const ACCOUNT_TYPE_KEYS = ['checking', 'savings', 'cash', 'credit', 'investment', 'other'];

/**
 * Eine Absage mit ihrem Grund (#1656, #1668).
 *
 * Der Satz bleibt, wie er war - er ist die zugesagte Antwort der API. Der Grund
 * kommt dazu, damit die Seite die Absage am Feld und in der Sprache der
 * Oberflaeche zeigen kann, statt den Satz des Servers durchzureichen. Wer hier
 * einen Grund ergaenzt, ordnet ihn in `LOAN_REFUSALS` bzw. `BUDGET_REFUSALS`
 * (public/pages/budget.js) ein; test:budget-ui haelt die Listen deckungsgleich.
 *
 * `extra` traegt, was der Satz der Oberflaeche nennen soll und nur der Server
 * weiss - heute `max` (die Grenze, an der die Absage haengt).
 */
export const refusal = (reason, error, extra = {}) => ({ ...extra, reason, error });

/** Die Fehler allgemeiner Validatoren (str/num/date/oneOf) unter einem Grund. */
export const refusals = (reason, results) => results
  .filter((result) => result.error)
  .map((result) => refusal(reason, result.error));

/**
 * Absage aus einer Liste: alle Saetze wie bisher in `error`, Grund (und `max`)
 * der ERSTEN in `reason` - ein Dialog zeigt ohnehin ein Feld nach dem anderen.
 */
export function refuse(res, errors, status = 400) {
  const [first] = errors;
  return res.status(status).json({
    error: errors.map((e) => e.error).join(' '),
    code: status,
    reason: first.reason,
    ...(first.max !== undefined ? { max: first.max } : {}),
  });
}

/**
 * Prüft eine optionale Konto-Zuordnung aus dem Request.
 * @returns {{ value: number|null }|{ error: string }} value=null ⇒ keinem Konto zugeordnet.
 */
export function validateAccountRef(raw, filter) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: 'account_id must be a valid account id.' };
  const row = db.get().prepare('SELECT id, archived FROM budget_accounts WHERE id = ?').get(id);
  // Eine Huelle (ACCOUNT_SHELL) ist fuer wen sie nichts traegt "nicht gefunden",
  // wie ein geloeschtes Konto. Ohne Filter (alte Aufrufer) zaehlt nur das Dasein.
  if (!row || (filter && accountGoneFor(row, filter))) return { error: 'Account not found.' };
  return { value: id };
}

/**
 * Lädt Konten inkl. berechnetem Saldo.
 * current_balance  = Startsaldo + Summe zugeordneter Einträge bis heute (aktueller Stand)
 * projected_balance = Startsaldo + Summe aller zugeordneter Einträge (inkl. künftiger)
 * @param {boolean} includeArchived
 */
export function listAccounts(includeArchived = false, filter = { clause: '', params: [] }) {
  const today = todayKey(db.get()); // YYYY-MM-DD in der Haushaltszone (#829)
  // Sichtbarkeits-Filter (#476/#505): im personal-Modus dürfen fremde private
  // Einträge weder Saldo noch entry_count beeinflussen, sonst verrät ein geteiltes
  // Konto Betrag/Existenz privater Fremd-Einträge. Im shared-Modus ist f leer.
  const f = filter && filter.clause ? filter : { clause: '', params: [] };
  const rows = db.get().prepare(`
    SELECT a.*,
           a.starting_balance + COALESCE((
             SELECT SUM(e.amount) FROM budget_entries e
             WHERE e.account_id = a.id AND e.date <= ?${f.clause}${bookedOnly('e')}
           ), 0) AS current_balance,
           a.starting_balance + COALESCE((
             SELECT SUM(e.amount) FROM budget_entries e
             WHERE e.account_id = a.id${f.clause}${bookedOnly('e')}
           ), 0) AS projected_balance,
           (SELECT COUNT(*) FROM budget_entries e WHERE e.account_id = a.id${f.clause}) AS entry_count
    FROM budget_accounts a
    WHERE ? = 1 OR a.archived = 0
    ORDER BY a.sort_order ASC, a.name COLLATE NOCASE ASC
  `).all(today, ...f.params, ...f.params, ...f.params, includeArchived ? 1 : 0);
  // Eine Kontohuelle (archived = ACCOUNT_SHELL, siehe DELETE /accounts/:id)
  // sieht nur, wer noch Buchungen daran sieht - fuer alle anderen ist das
  // Konto geloescht, ununterscheidbar von einem echt geloeschten.
  return rows.filter((a) => a.archived !== ACCOUNT_SHELL || a.entry_count > 0).map((a) => {
    // Preserve three-decimal account currencies, including linked transfers.
    // Keep existing fractional values on zero-decimal accounts as before.
    const digits = Math.max(2, accountFractionDigits(a.currency || budgetCurrency()));
    const round = value => Number(Number(value).toFixed(digits));
    const currentBalance = round(a.current_balance);
    // Verfügbarer Rahmen nur für Kreditkarten mit gepflegtem Limit. Ein negativer
    // Saldo ist die offene Schuld; ein positiver (Guthaben auf der Karte) vergrößert
    // den Rahmen nicht, deshalb der Clamp auf 0.
    const availableLimit = a.type === 'credit' && a.credit_limit != null
      ? Math.max(0, round(a.credit_limit) - Math.max(0, -currentBalance))
      : null;
    return {
      ...a,
      archived:          a.archived ? 1 : 0, // die Huelle zeigt sich ihrem Rest-Besitzer als archiviert
      starting_balance:  round(a.starting_balance),
      current_balance:   currentBalance,
      projected_balance: round(a.projected_balance),
      available_limit:   availableLimit,
    };
  });
}

/**
 * DIE KONTOHUELLE (Critique R23, Sicherheitspruefung). Ein Konto zu loeschen
 * nimmt seinen Buchungen die Zuordnung. Im personal-Modus koennen daran
 * private Buchungen anderer haengen, die der Loeschende nicht sieht - ueber die
 * entscheidet er nicht mit. Jede eigene Antwort darauf (409, ein Bit in der
 * Liste) waere ein Orakel: wer ein scheinbar leeres Konto loescht, wuesste,
 * dass dort Fremdes liegt. Deshalb loest der Loeschende nur, was er sieht, und
 * bleibt danach Fremdes am Konto, steht es als HUELLE weiter (archived = 2):
 * fuer ihn und jeden ohne sichtbare Buchung daran ist es geloescht (Liste,
 * PUT, DELETE, Kontowahl antworten wie bei einem echt geloeschten), der
 * Besitzer der privaten Buchungen sieht es als archiviert.
 */
export const ACCOUNT_SHELL = 2;

/** Ist Konto `row` fuer diesen Betrachter weg - nicht da, oder eine Huelle ohne sichtbare Buchung? */
export function accountGoneFor(row, filter = { clause: '', params: [] }) {
  if (!row) return true;
  if (row.archived !== ACCOUNT_SHELL) return false;
  const f = filter && filter.clause ? filter : { clause: '', params: [] };
  return !db.get().prepare(`SELECT 1 FROM budget_entries e WHERE e.account_id = ?${f.clause} LIMIT 1`)
    .get(row.id, ...f.params);
}

export function nextAccountSortOrder() {
  // Huellen zaehlen nicht: sonst verriete die naechste Position eines neuen
  // Kontos, dass hinter einem geloeschten noch eine Huelle steht.
  const row = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budget_accounts WHERE archived <> ?')
    .get(ACCOUNT_SHELL);
  return row.next;
}
