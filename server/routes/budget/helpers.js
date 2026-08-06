/**
 * Modul: Budget-Tracker – geteilte Helfer
 * Zweck: Sichtbarkeit/Scope, Formatierung, Locale/Labels, Meta-/Kategorie-Helfer,
 *        Wiederkehrungs-Materialisierung, Loan- und Konto-Helfer, Statistik-Zeitraum.
 * Wird von den Cluster-Routern unter server/routes/budget/ importiert.
 */

import { readFileSync } from 'node:fs';
import path from 'path';
import * as db from '../../db.js';
import { budgetVisibilityWhere, budgetScopeWhere, canEditEntry, resolveBudgetMode } from '../../services/budget-visibility.js';
import { computeLoanSchedule, remainingPrincipalAfter } from '../../services/loan-amortization.js';

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

/** Prüft Schreib-Berechtigung im personal-Modus; im shared-Modus immer erlaubt. */
export function mayEdit(req, row) {
  if (getBudgetMode() !== 'personal') return true;
  return canEditEntry(row, { id: viewerId(req) });
}

const LOCALE_CACHE = new Map();
const SUPPORTED_LANGS = new Set([
  'ar', 'cs', 'de', 'el', 'en', 'es', 'fr', 'hi', 'it', 'ja',
  'nl', 'pl', 'pt', 'ru', 'sv', 'tr', 'uk', 'vi', 'zh',
]);
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

export function normalizeLang(raw) {
  const lang = String(raw || 'en').trim().toLowerCase();
  const base = lang.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(base) ? base : 'en';
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
export const MAX_INTERVAL_COUNT = 99;

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
 * Der Starttag selbst zählt nicht mit: er ist der Eintrag, der die Serie trägt.
 * Wochenserien liefern hier mehrere Tage - genau daran hing bisher, dass es
 * keine gab: die Materialisierung kannte nur einen Termin je Monat.
 *
 * @param {string} startDate  YYYY-MM-DD, Datum des Serien-Originals
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
 * Erstellt fehlende Instanzen wiederkehrender Budget-Einträge für den angefragten Monat.
 * Läuft idempotent - bereits vorhandene oder explizit übersprungene Instanzen werden ignoriert.
 *
 * Virtuelle Serien (recurrence_virtual = 1) halten im Original bereits den
 * geglätteten Monatsanteil (amount); es wird in JEDEM Monat eine Instanz erzeugt.
 * Nicht-virtuelle Serien erzeugen den vollen Betrag nur in Fälligkeitsmonaten
 * (an den Tagen aus occurrenceDatesInMonth).
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {string} month  YYYY-MM
 */
export function generateRecurringInstances(database, month) {
  const [y, m] = month.split('-').map(Number);

  // Alle Serien-Originale, die vor diesem Monat begonnen haben
  const originals = database.prepare(`
    SELECT * FROM budget_entries
    WHERE is_recurring = 1 AND recurrence_parent_id IS NULL
      AND strftime('%Y-%m', date) < ?
  `).all(month);

  const skipStmt = database.prepare(
    'SELECT 1 FROM budget_recurrence_skipped WHERE parent_id = ? AND date = ?'
  );
  const existsStmt = database.prepare(
    'SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date = ?'
  );
  const insertStmt = database.prepare(`
    INSERT INTO budget_entries
      (title, amount, category, subcategory, date, is_recurring, recurrence_parent_id,
       created_by, owner_id, visibility, is_pending)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `);

  for (const orig of originals) {
    const interval = orig.recurrence_interval || 'monthly';

    // Virtuelle Serien tragen im Original bereits den Monatsanteil: sie kommen in
    // JEDEM Monat einmal vor, unabhängig vom Rhythmus - auch bei Wochenserien,
    // deren Anteil sonst über den Monat verstreut läge, ohne dass eine der
    // Buchungen die Zahlung wäre.
    const dates = orig.recurrence_virtual
      ? [`${month}-${String(Math.min(
          parseInt(orig.date.split('-')[2], 10),
          new Date(Date.UTC(y, m, 0)).getUTCDate(),
        )).padStart(2, '0')}`]
      : occurrenceDatesInMonth(orig.date, interval, orig.recurrence_interval_count, month);

    for (const date of dates) {
      // Übersprungen (eine gelöschte Instanz) oder schon vorhanden? Beides wird am
      // Fälligkeitstag geprüft, nicht am Monat: eine Wochenserie hat mehrere pro
      // Monat, und ein gelöschter Dienstag darf die übrigen nicht mitnehmen.
      if (skipStmt.get(orig.id, date)) continue;
      if (existsStmt.get(orig.id, date)) continue;

      // Materialisierte Instanz erbt Eigentümer + Sichtbarkeit des Serien-Originals
      // (#476/#505). Ohne das würde jede Instanz owner_id=NULL + visibility='shared'
      // (Spalten-Default) bekommen: eine private Serie würde im Haushalt sichtbar und
      // für die Eigentümer:in in scope=mine unsichtbar.
      // Verlangt die Serie eine Bestätigung (#637), entsteht die Buchung als
      // erwartet: sichtbar und planbar, aber in keiner Summe. Der Ursprung
      // selbst bleibt eine echte Buchung - er wurde von Hand eingetragen.
      insertStmt.run(
        orig.title, orig.amount, orig.category, orig.subcategory || '', date,
        orig.id, orig.created_by, orig.owner_id, orig.visibility || 'shared',
        orig.recurrence_confirm ? 1 : 0,
      );
    }
  }
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

export function categoryInUseCount(database, key) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE category = ?').get(key).n;
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
  const expenseSubcategories = {};
  for (const sub of subcategories) {
    if (!expenseSubcategories[sub.category_key]) expenseSubcategories[sub.category_key] = [];
    expenseSubcategories[sub.category_key].push(sub);
  }

  return { categories, expenseCategories, incomeCategories, expenseSubcategories };
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

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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

/** Gegenrichtung zu toBudgetAmount: Budget-Betrag zurück in die Darlehenswährung (#582). */
export function fromBudgetAmount(amount, loan) {
  return cents(Number(amount || 0) / loanRate(loan));
}

export function loanSummaryRow(loan, baseCurrency = budgetCurrency()) {
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
  const interest = loanInterestSummary(loan, paidInstallments);
  const installmentAmount = interest ? interest.monthly_payment : cents(loan.total_amount / loan.installment_count);
  // Restschuld: das noch offene Kapital laut Tilgungsplan. remainingAmount oben ist
  // dagegen die Summe der Restraten und enthält die Zinsen der Restlaufzeit - bei
  // verzinsten Darlehen liegen die beiden Werte deshalb auseinander, und die
  // Restschuld ist die Zahl, die auch die Bank meldet. Zinsfreie Darlehen haben
  // keinen Zinsanteil, dort sind beide identisch.
  const remainingPrincipal = interest ? interest.remaining_principal : remainingAmount;

  // Währung je Darlehen (#582): Alle Beträge oben bleiben in der Darlehenswährung.
  // currency=NULL heißt "Budget-Währung" und wird erst hier aufgelöst, damit eine
  // spätere Umstellung der Haushaltswährung den Altbestand mitzieht.
  const currency = loan.currency || baseCurrency;
  const rate = currency === baseCurrency ? 1 : loanRate(loan);

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
    next_installment_number: remainingInstallments > 0 ? paidInstallments + 1 : null,
    next_due_month: remainingInstallments > 0 ? addMonths(loan.start_month, paidInstallments) : null,
    interest,
    payments,
  };
}

// Zins-Darlehen (#569): Kennzahlen für die Anzeige aus dem Amortisationsplan
// (exakte Monatsrate, Gesamtzins, Restschuld nach Zinsbindung). Zinsfreie
// Darlehen liefern null, sodass die Anzeige unverändert bleibt.
// paidInstallments steuert nur remaining_principal (Restschuld zum aktuellen
// Ratenstand); alle anderen Kennzahlen sind vom Zahlungsfortschritt unabhängig.
export function loanInterestSummary(loan, paidInstallments = 0) {
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
    remaining_principal: remainingPrincipalAfter(calc.schedule, loan.principal, paidInstallments),
    remaining_after_binding: calc.remainingAfterBinding,
    binding_end_month: loan.fixed_period_months ? addMonths(loan.start_month, loan.fixed_period_months) : null,
  };
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
  const status = loan.remaining_installments === 0 || loan.remaining_amount <= 0.005 ? 'paid' : 'active';
  if (status !== loan.status) {
    db.get().prepare('UPDATE budget_loans SET status = ? WHERE id = ?').run(status, loanId);
    return loadLoan(loanId);
  }
  return loan;
}

export function entryWithLoanMeta(id) {
  return db.get().prepare(`
    SELECT b.*, u.display_name AS creator_name,
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
  `).get(id);
}

// --------------------------------------------------------
// Konten (#495): getrennte Konten mit Startsaldo + laufendem Saldo
// --------------------------------------------------------

export const ACCOUNT_TYPE_KEYS = ['checking', 'savings', 'cash', 'credit', 'investment', 'other'];

/**
 * Prüft eine optionale Konto-Zuordnung aus dem Request.
 * @returns {{ value: number|null }|{ error: string }} value=null ⇒ keinem Konto zugeordnet.
 */
export function validateAccountRef(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: 'account_id muss eine gültige Konto-ID sein.' };
  const row = db.get().prepare('SELECT id FROM budget_accounts WHERE id = ?').get(id);
  if (!row) return { error: 'Konto nicht gefunden.' };
  return { value: id };
}

/**
 * Lädt Konten inkl. berechnetem Saldo.
 * current_balance  = Startsaldo + Summe zugeordneter Einträge bis heute (aktueller Stand)
 * projected_balance = Startsaldo + Summe aller zugeordneter Einträge (inkl. künftiger)
 * @param {boolean} includeArchived
 */
export function listAccounts(includeArchived = false, filter = { clause: '', params: [] }) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
  return rows.map((a) => {
    const currentBalance = cents(a.current_balance);
    // Verfügbarer Rahmen nur für Kreditkarten mit gepflegtem Limit. Ein negativer
    // Saldo ist die offene Schuld; ein positiver (Guthaben auf der Karte) vergrößert
    // den Rahmen nicht, deshalb der Clamp auf 0.
    const availableLimit = a.type === 'credit' && a.credit_limit != null
      ? Math.max(0, cents(a.credit_limit) - Math.max(0, -currentBalance))
      : null;
    return {
      ...a,
      starting_balance:  cents(a.starting_balance),
      current_balance:   currentBalance,
      projected_balance: cents(a.projected_balance),
      available_limit:   availableLimit,
    };
  });
}

export function nextAccountSortOrder() {
  const row = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budget_accounts').get();
  return row.next;
}
