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

export const RECURRENCE_INTERVAL_KEYS = ['monthly', 'half_year', 'yearly'];

/** Anzahl Monate zwischen zwei Vorkommen einer Serie. */
export function monthsPerInterval(interval) {
  return interval === 'yearly' ? 12 : interval === 'half_year' ? 6 : 1;
}

/** Effektiver Monatsanteil eines Periodenbetrags (für virtuelles Budget). */
export function effectiveMonthly(amount, interval) {
  return cents(Number(amount || 0) / monthsPerInterval(interval));
}

/**
 * Erstellt fehlende Instanzen wiederkehrender Budget-Einträge für den angefragten Monat.
 * Läuft idempotent - bereits vorhandene oder explizit übersprungene Instanzen werden ignoriert.
 *
 * Virtuelle Serien (recurrence_virtual = 1) halten im Original bereits den
 * geglätteten Monatsanteil (amount); es wird in JEDEM Monat eine Instanz erzeugt.
 * Nicht-virtuelle Serien erzeugen den vollen Betrag nur in Fälligkeitsmonaten
 * (alle monthsPerInterval(interval) Monate ab dem Startmonat).
 * @param {import('better-sqlite3').Database} database
 * @param {string} month  YYYY-MM
 */
export function generateRecurringInstances(database, month) {
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd   = `${month}-31`;

  // Alle Serien-Originale, die vor diesem Monat begonnen haben
  const originals = database.prepare(`
    SELECT * FROM budget_entries
    WHERE is_recurring = 1 AND recurrence_parent_id IS NULL
      AND strftime('%Y-%m', date) < ?
  `).all(month);

  for (const orig of originals) {
    // Übersprungener Monat?
    const skipped = database.prepare(
      'SELECT 1 FROM budget_recurrence_skipped WHERE parent_id = ? AND month = ?'
    ).get(orig.id, month);
    if (skipped) continue;

    // Instanz schon vorhanden?
    const existing = database.prepare(`
      SELECT id FROM budget_entries
      WHERE recurrence_parent_id = ? AND date BETWEEN ? AND ?
    `).get(orig.id, monthStart, monthEnd);
    if (existing) continue;

    // Bei nicht-virtuellen Serien nur in Fälligkeitsmonaten erzeugen.
    const interval = orig.recurrence_interval || 'monthly';
    if (!orig.recurrence_virtual) {
      const [oy, om] = orig.date.split('-').map(Number);
      const monthsDiff = (y - oy) * 12 + (m - om);
      if (monthsDiff < 1 || monthsDiff % monthsPerInterval(interval) !== 0) continue;
    }

    // Datum berechnen: gleicher Tag, am letzten Tag des Monats gekappt
    const origDay    = parseInt(orig.date.split('-')[2], 10);
    const lastDay    = new Date(y, m, 0).getDate();
    const instanceDay = Math.min(origDay, lastDay);
    const instanceDate = `${month}-${String(instanceDay).padStart(2, '0')}`;

    // Materialisierte Instanz erbt Eigentümer + Sichtbarkeit des Serien-Originals
    // (#476/#505). Ohne das würde jede Instanz owner_id=NULL + visibility='shared'
    // (Spalten-Default) bekommen: eine private Serie würde im Haushalt sichtbar und
    // für die Eigentümer:in in scope=mine unsichtbar.
    database.prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, recurrence_parent_id, created_by, owner_id, visibility)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(orig.title, orig.amount, orig.category, orig.subcategory || '', instanceDate, orig.id, orig.created_by, orig.owner_id, orig.visibility || 'shared');
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
  if (!validExpenseCategoryKeys().includes(category)) return '';
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

export function loanSummaryRow(loan) {
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
  const installmentAmount = cents(loan.total_amount / loan.installment_count);

  return {
    ...loan,
    total_amount: cents(loan.total_amount),
    installment_amount: installmentAmount,
    paid_amount: paidAmount,
    paid_installments: paidInstallments,
    remaining_amount: remainingAmount,
    remaining_installments: remainingInstallments,
    next_installment_number: remainingInstallments > 0 ? paidInstallments + 1 : null,
    next_due_month: remainingInstallments > 0 ? addMonths(loan.start_month, paidInstallments) : null,
    payments,
  };
}

export function loadLoan(id) {
  const loan = db.get().prepare(`
    SELECT l.*, u.display_name AS creator_name
    FROM budget_loans l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = ?
  `).get(id);
  return loan ? loanSummaryRow(loan) : null;
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
             WHERE e.account_id = a.id AND e.date <= ?${f.clause}
           ), 0) AS current_balance,
           a.starting_balance + COALESCE((
             SELECT SUM(e.amount) FROM budget_entries e
             WHERE e.account_id = a.id${f.clause}
           ), 0) AS projected_balance,
           (SELECT COUNT(*) FROM budget_entries e WHERE e.account_id = a.id${f.clause}) AS entry_count
    FROM budget_accounts a
    WHERE ? = 1 OR a.archived = 0
    ORDER BY a.sort_order ASC, a.name COLLATE NOCASE ASC
  `).all(today, ...f.params, ...f.params, ...f.params, includeArchived ? 1 : 0);
  return rows.map((a) => ({
    ...a,
    starting_balance:  cents(a.starting_balance),
    current_balance:   cents(a.current_balance),
    projected_balance: cents(a.projected_balance),
  }));
}

export function nextAccountSortOrder() {
  const row = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budget_accounts').get();
  return row.next;
}
