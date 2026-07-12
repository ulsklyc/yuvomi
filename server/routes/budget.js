/**
 * Modul: Budget-Tracker (Budget)
 * Zweck: REST-API-Routen für Einnahmen/Ausgaben, Monatsübersicht, CSV-Export
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'path';
import * as db from '../db.js';
import { str, oneOf, date as validateDate, month as validateMonth, num, rrule, color as validateColor, collectErrors, MAX_TITLE, MAX_SHORT, MONTH_RE } from '../middleware/validate.js';

const log = createLogger('Budget');

const router  = express.Router();
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

function normalizeLang(raw) {
  const lang = String(raw || 'en').trim().toLowerCase();
  const base = lang.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(base) ? base : 'en';
}

function budgetMessages(lang) {
  const normalized = normalizeLang(lang);
  if (!LOCALE_CACHE.has(normalized)) {
    const localePath = path.join(import.meta.dirname, '..', '..', 'public', 'locales', `${normalized}.json`);
    const parsed = JSON.parse(readFileSync(localePath, 'utf-8'));
    LOCALE_CACHE.set(normalized, parsed.budget || {});
  }
  return LOCALE_CACHE.get(normalized);
}

function localizedCategory(category, lang) {
  const budget = budgetMessages(lang);
  const labelKey = CATEGORY_LABEL_KEYS[category.key];
  return {
    ...category,
    label: labelKey ? (budget[labelKey] || category.name) : category.name,
  };
}

function localizedSubcategory(subcategory, lang) {
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

const RECURRENCE_INTERVAL_KEYS = ['monthly', 'half_year', 'yearly'];

/** Anzahl Monate zwischen zwei Vorkommen einer Serie. */
function monthsPerInterval(interval) {
  return interval === 'yearly' ? 12 : interval === 'half_year' ? 6 : 1;
}

/** Effektiver Monatsanteil eines Periodenbetrags (für virtuelles Budget). */
function effectiveMonthly(amount, interval) {
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
function generateRecurringInstances(database, month) {
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

    database.prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, recurrence_parent_id, created_by)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(orig.title, orig.amount, orig.category, orig.subcategory || '', instanceDate, orig.id, orig.created_by);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATS_RANGES = new Set(['week', 'month', 'year']);

function ymd(d) { return d.toISOString().slice(0, 10); }        // YYYY-MM-DD (UTC)
function ym(d)  { return d.toISOString().slice(0, 7);  }        // YYYY-MM   (UTC)

function todayLocalDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function thisMonthLocalKey() {
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

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'category';
}

function uniqueKey(table, base) {
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

function categoryInUseCount(database, key) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE category = ?').get(key).n;
}

function subcategoryInUseCount(database, key) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_entries WHERE subcategory = ?').get(key).n;
}

function categoryCountByType(database, type) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_categories WHERE type = ?').get(type).n;
}

function subcategoryCountForCategory(database, categoryKey) {
  return database.prepare('SELECT COUNT(*) AS n FROM budget_subcategories WHERE category_key = ?').get(categoryKey).n;
}

function loadBudgetMeta() {
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

function validCategoryKeys() {
  return db.get().prepare('SELECT key FROM budget_categories').all().map((c) => c.key);
}

function validExpenseCategoryKeys() {
  return db.get().prepare("SELECT key FROM budget_categories WHERE type = 'expense'").all().map((c) => c.key);
}

function defaultCategory(type) {
  const row = db.get().prepare(`
    SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order ASC, name COLLATE NOCASE ASC LIMIT 1
  `).get(type);
  return row?.key || (type === 'expense' ? 'financial_other' : 'Sonstiges Einkommen');
}

function defaultSubcategory(category) {
  const row = db.get().prepare(`
    SELECT key FROM budget_subcategories WHERE category_key = ? ORDER BY sort_order ASC, name COLLATE NOCASE ASC LIMIT 1
  `).get(category);
  return row?.key || '';
}

function validateSubcategory(category, subcategory) {
  if (!validExpenseCategoryKeys().includes(category)) return '';
  if (!subcategory) return defaultSubcategory(category);
  const row = db.get().prepare(`
    SELECT 1 FROM budget_subcategories WHERE category_key = ? AND key = ?
  `).get(category, subcategory);
  return row ? subcategory : null;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function cents(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function loanSummaryRow(loan) {
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

function loadLoan(id) {
  const loan = db.get().prepare(`
    SELECT l.*, u.display_name AS creator_name
    FROM budget_loans l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = ?
  `).get(id);
  return loan ? loanSummaryRow(loan) : null;
}

function refreshLoanStatus(loanId) {
  const loan = loadLoan(loanId);
  if (!loan) return null;
  const status = loan.remaining_installments === 0 || loan.remaining_amount <= 0.005 ? 'paid' : 'active';
  if (status !== loan.status) {
    db.get().prepare('UPDATE budget_loans SET status = ? WHERE id = ?').run(status, loanId);
    return loadLoan(loanId);
  }
  return loan;
}

function entryWithLoanMeta(id) {
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

const ACCOUNT_TYPE_KEYS = ['checking', 'savings', 'cash', 'credit', 'investment', 'other'];

/**
 * Prüft eine optionale Konto-Zuordnung aus dem Request.
 * @returns {{ value: number|null }|{ error: string }} value=null ⇒ keinem Konto zugeordnet.
 */
function validateAccountRef(raw) {
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
function listAccounts(includeArchived = false) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = db.get().prepare(`
    SELECT a.*,
           a.starting_balance + COALESCE((
             SELECT SUM(e.amount) FROM budget_entries e
             WHERE e.account_id = a.id AND e.date <= ?
           ), 0) AS current_balance,
           a.starting_balance + COALESCE((
             SELECT SUM(e.amount) FROM budget_entries e
             WHERE e.account_id = a.id
           ), 0) AS projected_balance,
           (SELECT COUNT(*) FROM budget_entries e WHERE e.account_id = a.id) AS entry_count
    FROM budget_accounts a
    WHERE ? = 1 OR a.archived = 0
    ORDER BY a.sort_order ASC, a.name COLLATE NOCASE ASC
  `).all(today, includeArchived ? 1 : 0);
  return rows.map((a) => ({
    ...a,
    starting_balance:  cents(a.starting_balance),
    current_balance:   cents(a.current_balance),
    projected_balance: cents(a.projected_balance),
  }));
}

function nextAccountSortOrder() {
  const row = db.get().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM budget_accounts').get();
  return row.next;
}

// --------------------------------------------------------
// Statische Routen vor /:id
// --------------------------------------------------------

/**
 * GET /api/v1/budget/summary
 * Monatsübersicht: Einnahmen, Ausgaben, Saldo, Aufschlüsselung nach Kategorie.
 * Query: ?month=YYYY-MM  (default: aktueller Monat)
 * Response: { data: { month, income, expenses, balance, byCategory: [] } }
 */
router.get('/summary', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 7); // YYYY-MM
    const month = req.query.month || today;

    if (!MONTH_RE.test(month))
      return res.status(400).json({ error: 'month muss YYYY-MM sein', code: 400 });

    const from = `${month}-01`;
    const to   = `${month}-31`;

    const totals = db.get().prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance
      FROM budget_entries
      WHERE date BETWEEN ? AND ?
    `).get(from, to);

    const byCategory = db.get().prepare(`
      SELECT category,
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
             SUM(amount) AS total
      FROM budget_entries
      WHERE date BETWEEN ? AND ?
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
    `).all(from, to);

    res.json({
      data: {
        month,
        income:     totals.income   || 0,
        expenses:   totals.expenses || 0,
        balance:    totals.balance  || 0,
        byCategory,
      },
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// --------------------------------------------------------
// Budgetplan (geplantes/geschätztes Budget) — Discussion #468
// --------------------------------------------------------

// Reservierter Kategorie-Schlüssel für das Monats-Sparziel in budget_plans.
// '__savings__' kann nicht mit einem echten Kategorie-Slug kollidieren (slugify
// entfernt Unterstriche an den Rändern nicht, aber Nutzerkategorien sind lesbare
// Wörter; zusätzlich validiert das Schreiben gegen die echten Kategorie-Keys).
export const BUDGET_SAVINGS_KEY = '__savings__';

/**
 * Berechnet Plan-vs-Ist für einen Monat.
 * Plan = stetiger Monatsbetrag je Ausgabenkategorie; Ist = tatsächliche Ausgaben
 * des Monats (positiv dargestellt). Das Sparziel vergleicht den geplanten Betrag
 * mit dem Netto-Saldo (Einnahmen − Ausgaben) des Monats.
 * @returns {object} { month, plans: [], savings: {}|null, totalPlanned, totalActual }
 */
export function computePlanProgress(database, month) {
  const from = `${month}-01`;
  const to   = `${month}-31`;

  const planRows = database.prepare('SELECT category, amount FROM budget_plans').all();
  const planMap  = new Map(planRows.map((r) => [r.category, cents(r.amount)]));

  // Ist-Ausgaben je Kategorie (als positive Beträge) für den Monat.
  const spentRows = database.prepare(`
    SELECT category, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spent
    FROM budget_entries WHERE date BETWEEN ? AND ? GROUP BY category
  `).all(from, to);
  const spentMap = new Map(spentRows.map((r) => [r.category, cents(r.spent || 0)]));

  const plans = [];
  for (const [category, planned] of planMap) {
    if (category === BUDGET_SAVINGS_KEY) continue;
    const actual = spentMap.get(category) || 0;
    plans.push({
      category,
      planned,
      actual,
      remaining: cents(planned - actual),
      ratio: planned > 0 ? actual / planned : 0,
      over: actual > planned + 0.005,
    });
  }
  // Höchste Auslastung zuerst → die Familie sieht gefährdete Budgets oben.
  plans.sort((a, b) => b.ratio - a.ratio);

  const totalPlanned = cents(plans.reduce((s, p) => s + p.planned, 0));
  const totalActual  = cents(plans.reduce((s, p) => s + p.actual, 0));

  const totals = database.prepare(`
    SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
           SUM(amount) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?
  `).get(from, to);
  const income  = cents(totals.income || 0);
  const balance = cents(totals.balance || 0); // Netto-Ersparnis des Monats

  const savingsPlanned = planMap.get(BUDGET_SAVINGS_KEY);
  const savings = savingsPlanned != null ? {
    planned: savingsPlanned,
    actual: balance,
    remaining: cents(savingsPlanned - balance),
    ratio: savingsPlanned > 0 ? balance / savingsPlanned : 0,
    met: balance >= savingsPlanned - 0.005,
    income,
  } : null;

  return { month, plans, savings, totalPlanned, totalActual };
}

/**
 * GET /api/v1/budget/plans
 * Budgetplan-Fortschritt für einen Monat: geplant vs. Ist je Kategorie + Sparziel.
 * Query: ?month=YYYY-MM (default: aktueller Monat)
 */
router.get('/plans', (req, res) => {
  try {
    const month = MONTH_RE.test(req.query.month || '') ? req.query.month : thisMonthLocalKey();
    res.json({ data: computePlanProgress(db.get(), month) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/plans/:category
 * Legt den geplanten Monatsbetrag einer Ausgabenkategorie (oder das Sparziel via
 * BUDGET_SAVINGS_KEY) fest. Body: { amount } — positiv, sonst 400.
 */
router.put('/plans/:category', (req, res) => {
  try {
    const category  = req.params.category;
    const isSavings = category === BUDGET_SAVINGS_KEY;
    if (!isSavings && !validExpenseCategoryKeys().includes(category))
      return res.status(400).json({ error: 'Invalid category.', code: 400 });

    const vAmount = num(req.body.amount, 'Betrag', { required: true });
    const errors  = collectErrors([vAmount]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!(vAmount.value > 0))
      return res.status(400).json({ error: 'Betrag muss größer als 0 sein.', code: 400 });

    const amount = cents(vAmount.value);
    db.get().prepare(`
      INSERT INTO budget_plans (category, amount, created_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(category) DO UPDATE SET
        amount = excluded.amount, updated_at = excluded.updated_at
    `).run(category, amount, req.authUserId || req.session.userId);

    res.json({ data: { category, amount } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/plans/:category
 * Entfernt den Budgetplan einer Kategorie bzw. das Sparziel.
 */
router.delete('/plans/:category', (req, res) => {
  try {
    db.get().prepare('DELETE FROM budget_plans WHERE category = ?').run(req.params.category);
    res.json({ data: { deleted: true } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * Leitet Zeitraum aus from/to oder month ab.
 * @param {object} query - { from?, to?, month? }
 * @returns {object} { from: YYYY-MM-DD, to: YYYY-MM-DD }
 */
export function resolveExportRange({ from, to, month }) {
  if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) return { from, to };
  const m = MONTH_RE.test(month || '') ? month : thisMonthLocalKey();
  return { from: `${m}-01`, to: `${m}-31` };
}

/**
 * GET /api/v1/budget/export
 * Monatseinträge als CSV-Download.
 * Query: ?month=YYYY-MM or ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Response: text/csv
 */
router.get('/export', (req, res) => {
  try {
    const { from, to } = resolveExportRange(req.query);
    const filename = (DATE_RE.test(req.query.from || '') && DATE_RE.test(req.query.to || ''))
      ? `budget-${from}_${to}.csv`
      : `budget-${req.query.month || thisMonthLocalKey()}.csv`;
    const entries = db.get().prepare(`
      SELECT b.*, u.display_name AS creator_name
      FROM budget_entries b
      LEFT JOIN users u ON u.id = b.created_by
      WHERE b.date BETWEEN ? AND ?
      ORDER BY b.date ASC
    `).all(from, to);

    const header = 'Date,Title,Amount,Category,Subcategory,Recurring,Created by\n';
    const csvSafe = (val) => {
      let s = String(val || '').replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s}"`;
    };
    const rows   = entries.map((e) =>
      [
        e.date,
        csvSafe(e.title),
        e.amount.toFixed(2).replace('.', ','),
        e.category,
        e.subcategory || '',
        e.is_recurring ? 'Yes' : 'No',
        csvSafe(e.creator_name),
      ].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + header + rows); // BOM für Excel
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/budget/meta
 * Kategorien-Liste für Dropdowns.
 * Response: { data: { categories } }
 */
router.get('/meta', (req, res) => {
  res.json({ data: loadBudgetMeta() });
});

router.get('/categories', (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const categories = db.get().prepare(`
      SELECT key, name, type, sort_order
      FROM budget_categories
      ORDER BY type DESC, sort_order ASC, name COLLATE NOCASE ASC
    `).all();
    const subRows = db.get().prepare(`
      SELECT key, category_key, name, sort_order
      FROM budget_subcategories
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `).all();

    res.json({
      data: categories.map((category) => ({
        ...localizedCategory(category, lang),
        subcategories: subRows
          .filter((s) => s.category_key === category.key)
          .map((s) => localizedSubcategory(s, lang)),
      })),
      lang,
    });
  } catch (err) {
    log.error('GET /categories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/categories/:categoryKey/subcategories', (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const category = db.get().prepare(`
      SELECT key, name, type, sort_order
      FROM budget_categories
      WHERE key = ?
    `).get(req.params.categoryKey);
    if (!category) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const subcategories = db.get().prepare(`
      SELECT key, category_key, name, sort_order
      FROM budget_subcategories
      WHERE category_key = ?
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `).all(category.key);

    res.json({
      data: subcategories.map((subcategory) => localizedSubcategory(subcategory, lang)),
      category: localizedCategory(category, lang),
      lang,
    });
  } catch (err) {
    log.error('GET /categories/:categoryKey/subcategories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/loans', (req, res) => {
  try {
    const loans = db.get().prepare(`
      SELECT l.*, u.display_name AS creator_name
      FROM budget_loans l
      LEFT JOIN users u ON u.id = l.created_by
      ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END,
               l.start_month ASC,
               l.created_at DESC
    `).all().map(loanSummaryRow);
    const active = loans.filter((loan) => loan.status === 'active');
    const totals = loans.reduce((acc, loan) => {
      acc.total_amount += loan.total_amount;
      acc.paid_amount += loan.paid_amount;
      acc.remaining_amount += loan.remaining_amount;
      acc.remaining_installments += loan.remaining_installments;
      return acc;
    }, { total_amount: 0, paid_amount: 0, remaining_amount: 0, remaining_installments: 0 });

    res.json({
      data: {
        loans,
        summary: {
          active_count: active.length,
          total_count: loans.length,
          total_amount: cents(totals.total_amount),
          paid_amount: cents(totals.paid_amount),
          remaining_amount: cents(totals.remaining_amount),
          remaining_installments: totals.remaining_installments,
        },
      },
    });
  } catch (err) {
    log.error('GET /loans error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/loans', (req, res) => {
  try {
    const vTitle = str(req.body.title || req.body.borrower, 'Title', { max: MAX_TITLE });
    const vBorrower = str(req.body.borrower, 'Borrower', { max: MAX_SHORT });
    const vAmount = num(req.body.total_amount, 'Amount', { required: true });
    const vStartMonth = validateMonth(req.body.start_month, 'Start month');
    const vNotes = str(req.body.notes, 'Notes', { max: 1000, required: false });
    const installmentCount = parseInt(req.body.installment_count, 10);
    const errors = collectErrors([vTitle, vBorrower, vAmount, vStartMonth, vNotes]);
    if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240) {
      errors.push('Installment count must be between 1 and 240.');
    }
    if (vAmount.value !== null && vAmount.value <= 0) errors.push('Amount must be greater than zero.');
    if (!vStartMonth.value) errors.push('Start month is required.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const result = db.get().prepare(`
      INSERT INTO budget_loans (title, borrower, total_amount, installment_count, start_month, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vTitle.value,
      vBorrower.value,
      cents(vAmount.value),
      installmentCount,
      vStartMonth.value,
      vNotes.value,
      req.authUserId || req.session.userId
    );

    res.status(201).json({ data: loadLoan(result.lastInsertRowid) });
  } catch (err) {
    log.error('POST /loans error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/loans/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = db.get().prepare('SELECT * FROM budget_loans WHERE id = ?').get(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });

    const checks = [];
    if (req.body.title !== undefined) checks.push(str(req.body.title, 'Title', { max: MAX_TITLE }));
    if (req.body.borrower !== undefined) checks.push(str(req.body.borrower, 'Borrower', { max: MAX_SHORT }));
    if (req.body.total_amount !== undefined) checks.push(num(req.body.total_amount, 'Amount'));
    if (req.body.start_month !== undefined) checks.push(validateMonth(req.body.start_month, 'Start month'));
    if (req.body.notes !== undefined) checks.push(str(req.body.notes, 'Notes', { max: 1000, required: false }));
    const errors = collectErrors(checks);
    const installmentCount = req.body.installment_count === undefined ? null : parseInt(req.body.installment_count, 10);
    if (req.body.installment_count !== undefined && (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240)) {
      errors.push('Installment count must be between 1 and 240.');
    }
    const paidCount = db.get().prepare('SELECT COUNT(*) AS c FROM budget_loan_payments WHERE loan_id = ?').get(id).c;
    if (installmentCount !== null && installmentCount < paidCount) {
      errors.push('Installment count cannot be lower than paid installments.');
    }
    if (req.body.total_amount !== undefined && Number(req.body.total_amount) <= 0) errors.push('Amount must be greater than zero.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE budget_loans
      SET title = COALESCE(?, title),
          borrower = COALESCE(?, borrower),
          total_amount = COALESCE(?, total_amount),
          installment_count = COALESCE(?, installment_count),
          start_month = COALESCE(?, start_month),
          notes = ?
      WHERE id = ?
    `).run(
      req.body.title?.trim() ?? null,
      req.body.borrower?.trim() ?? null,
      req.body.total_amount !== undefined ? cents(req.body.total_amount) : null,
      installmentCount,
      req.body.start_month ?? null,
      req.body.notes !== undefined ? (req.body.notes?.trim() || null) : loan.notes,
      id
    );

    res.json({ data: refreshLoanStatus(id) });
  } catch (err) {
    log.error('PUT /loans/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/loans/:id/payments', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = loadLoan(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });
    if (loan.remaining_installments <= 0) return res.status(409).json({ error: 'Loan is already paid.', code: 409 });

    const installmentNumber = req.body.installment_number === undefined
      ? loan.next_installment_number
      : parseInt(req.body.installment_number, 10);
    const defaultAmount = installmentNumber === loan.installment_count
      ? loan.remaining_amount
      : Math.min(loan.installment_amount, loan.remaining_amount);
    const vAmount = num(req.body.amount ?? defaultAmount, 'Amount', { required: true });
    const vDate = validateDate(req.body.paid_date, 'Paid date', true);
    const errors = collectErrors([vAmount, vDate]);
    if (!Number.isInteger(installmentNumber) || installmentNumber < 1 || installmentNumber > loan.installment_count) {
      errors.push('Installment number is invalid.');
    }
    if (vAmount.value !== null && vAmount.value <= 0) errors.push('Amount must be greater than zero.');
    if (vAmount.value !== null && vAmount.value - loan.remaining_amount > 0.005) {
      errors.push('Amount cannot be greater than the remaining loan amount.');
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const existing = db.get().prepare(`
      SELECT 1 FROM budget_loan_payments WHERE loan_id = ? AND installment_number = ?
    `).get(id, installmentNumber);
    if (existing) return res.status(409).json({ error: 'Installment already paid.', code: 409 });

    const paymentAmount = cents(vAmount.value);
    const tx = db.get().transaction(() => {
      const budgetResult = db.get().prepare(`
        INSERT INTO budget_entries (title, amount, category, subcategory, date, is_recurring, created_by)
        VALUES (?, ?, ?, '', ?, 0, ?)
      `).run(
        `Loan repayment: ${loan.borrower}`,
        paymentAmount,
        'Geschenke & Transfers',
        vDate.value,
        req.authUserId || req.session.userId
      );
      const paymentResult = db.get().prepare(`
        INSERT INTO budget_loan_payments
          (loan_id, installment_number, amount, paid_date, budget_entry_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, installmentNumber, paymentAmount, vDate.value, budgetResult.lastInsertRowid, req.authUserId || req.session.userId);
      return paymentResult.lastInsertRowid;
    });

    const paymentId = tx();
    res.status(201).json({
      data: {
        payment: db.get().prepare('SELECT * FROM budget_loan_payments WHERE id = ?').get(paymentId),
        loan: refreshLoanStatus(id),
      },
    });
  } catch (err) {
    log.error('POST /loans/:id/payments error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/loans/:id/payments/:paymentId', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const paymentId = parseInt(req.params.paymentId, 10);
    const payment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE id = ? AND loan_id = ?
    `).get(paymentId, id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.', code: 404 });

    const tx = db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_loan_payments WHERE id = ?').run(paymentId);
      if (payment.budget_entry_id) {
        db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.budget_entry_id);
      }
    });
    tx();
    refreshLoanStatus(id);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /loans/:id/payments/:paymentId error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/loans/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const loan = db.get().prepare('SELECT * FROM budget_loans WHERE id = ?').get(id);
    if (!loan) return res.status(404).json({ error: 'Loan not found.', code: 404 });

    const payments = db.get().prepare('SELECT budget_entry_id FROM budget_loan_payments WHERE loan_id = ?').all(id);
    const tx = db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_loans WHERE id = ?').run(id);
      for (const payment of payments) {
        if (payment.budget_entry_id) {
          db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.budget_entry_id);
        }
      }
    });
    tx();
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /loans/:id error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/categories', (req, res) => {
  try {
    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType = oneOf(req.body.type || 'expense', ['expense', 'income'], 'Typ');
    const errors = collectErrors([vName, vType]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_categories WHERE type = ? AND name = ? COLLATE NOCASE
    `).get(vType.value, vName.value);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM budget_categories WHERE type = ?
    `).get(vType.value).m;
    const key = uniqueKey('budget_categories', vName.value);

    db.get().prepare(`
      INSERT INTO budget_categories (key, name, type, sort_order) VALUES (?, ?, ?, ?)
    `).run(key, vName.value, vType.value, maxOrder + 1);

    const cat = db.get().prepare('SELECT key, name, type, sort_order FROM budget_categories WHERE key = ?').get(key);
    res.status(201).json({ data: cat });
  } catch (err) {
    log.error('POST /categories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM budget_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_categories WHERE type = ? AND name = ? COLLATE NOCASE AND key != ?
    `).get(cat.type, vName.value, cat.key);
    if (conflict) return res.status(409).json({ error: 'Category already exists.', code: 409, reason: 'category_exists' });

    db.get().prepare('UPDATE budget_categories SET name = ? WHERE key = ?').run(vName.value, cat.key);
    const updated = db.get().prepare('SELECT key, name, type, sort_order FROM budget_categories WHERE key = ?').get(cat.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /categories/:key error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/categories/:key', (req, res) => {
  try {
    const cat = db.get().prepare('SELECT * FROM budget_categories WHERE key = ?').get(req.params.key);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const inUse = categoryInUseCount(db.get(), cat.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Category is in use by ${inUse} entr${inUse === 1 ? 'y' : 'ies'}.`, code: 409, count: inUse, reason: 'category_in_use' });
    }
    if (categoryCountByType(db.get(), cat.type) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last category.', code: 409, reason: 'category_last' });
    }
    db.get().prepare('DELETE FROM budget_categories WHERE key = ?').run(cat.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /categories/:key error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.patch('/categories/reorder', (req, res) => {
  try {
    const vType = oneOf(req.body.type || 'expense', ['expense', 'income'], 'Typ');
    if (vType.error) return res.status(400).json({ error: vType.error, code: 400 });
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const tx = db.get().transaction((keys) => {
      keys.forEach((key, i) => {
        db.get().prepare('UPDATE budget_categories SET sort_order = ? WHERE key = ? AND type = ?').run(i, key, vType.value);
      });
    });
    tx(order);
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH /categories/reorder error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/categories/:categoryKey/subcategories', (req, res) => {
  try {
    const cat = db.get().prepare(`
      SELECT * FROM budget_categories WHERE key = ? AND type = 'expense'
    `).get(req.params.categoryKey);
    if (!cat) return res.status(404).json({ error: 'Category not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_subcategories WHERE category_key = ? AND name = ? COLLATE NOCASE
    `).get(cat.key, vName.value);
    if (conflict) return res.status(409).json({ error: 'Subcategory already exists.', code: 409, reason: 'subcategory_exists' });

    const maxOrder = db.get().prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS m FROM budget_subcategories WHERE category_key = ?
    `).get(cat.key).m;
    const key = uniqueKey('budget_subcategories', `${cat.key}_${vName.value}`);

    db.get().prepare(`
      INSERT INTO budget_subcategories (key, category_key, name, sort_order) VALUES (?, ?, ?, ?)
    `).run(key, cat.key, vName.value, maxOrder + 1);

    const sub = db.get().prepare(`
      SELECT key, category_key, name, sort_order FROM budget_subcategories WHERE key = ?
    `).get(key);
    res.status(201).json({ data: sub });
  } catch (err) {
    log.error('POST /categories/:categoryKey/subcategories error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.put('/categories/:key/subcategories/:subKey', (req, res) => {
  try {
    const sub = db.get().prepare('SELECT * FROM budget_subcategories WHERE key = ? AND category_key = ?').get(req.params.subKey, req.params.key);
    if (!sub) return res.status(404).json({ error: 'Subcategory not found.', code: 404 });

    const vName = str(req.body.name, 'Name', { max: MAX_SHORT });
    if (vName.error) return res.status(400).json({ error: vName.error, code: 400 });

    const conflict = db.get().prepare(`
      SELECT key FROM budget_subcategories WHERE category_key = ? AND name = ? COLLATE NOCASE AND key != ?
    `).get(sub.category_key, vName.value, sub.key);
    if (conflict) return res.status(409).json({ error: 'Subcategory already exists.', code: 409, reason: 'subcategory_exists' });

    db.get().prepare('UPDATE budget_subcategories SET name = ? WHERE key = ?').run(vName.value, sub.key);
    const updated = db.get().prepare('SELECT key, category_key, name, sort_order FROM budget_subcategories WHERE key = ?').get(sub.key);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT subcategory error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/categories/:key/subcategories/:subKey', (req, res) => {
  try {
    const sub = db.get().prepare('SELECT * FROM budget_subcategories WHERE key = ? AND category_key = ?').get(req.params.subKey, req.params.key);
    if (!sub) return res.status(404).json({ error: 'Subcategory not found.', code: 404 });

    const inUse = subcategoryInUseCount(db.get(), sub.key);
    if (inUse > 0) {
      return res.status(409).json({ error: `Subcategory is in use by ${inUse} entr${inUse === 1 ? 'y' : 'ies'}.`, code: 409, count: inUse, reason: 'subcategory_in_use' });
    }
    if (subcategoryCountForCategory(db.get(), sub.category_key) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last subcategory.', code: 409, reason: 'subcategory_last' });
    }
    db.get().prepare('DELETE FROM budget_subcategories WHERE key = ?').run(sub.key);
    res.status(204).end();
  } catch (err) {
    log.error('DELETE subcategory error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.patch('/categories/:key/subcategories/reorder', (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const tx = db.get().transaction((keys) => {
      keys.forEach((key, i) => {
        db.get().prepare('UPDATE budget_subcategories SET sort_order = ? WHERE key = ? AND category_key = ?').run(i, key, req.params.key);
      });
    });
    tx(order);
    res.json({ data: true });
  } catch (err) {
    log.error('PATCH subcategory reorder error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

// --------------------------------------------------------
// CRUD-Routen
// --------------------------------------------------------

/**
 * GET /api/v1/budget
 * Einträge eines Monats abrufen.
 * Query: ?month=YYYY-MM&category=<cat>
 * Response: { data: Entry[] }
 */
/**
 * GET /api/v1/budget/accounts
 * Listet Konten mit Startsaldo und laufendem Saldo; zusätzlich das Gesamt-Nettovermögen.
 * Query: ?include_archived=1  (default: nur aktive Konten)
 * Response: { data: { accounts: [], net_worth } }
 */
router.get('/accounts', (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const accounts = listAccounts(includeArchived);
    const netWorth = cents(accounts
      .filter((a) => !a.archived)
      .reduce((sum, a) => sum + a.current_balance, 0));
    res.json({ data: { accounts, net_worth: netWorth } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * POST /api/v1/budget/accounts
 * Neues Konto anlegen.
 * Body: { name, type?, starting_balance?, currency?, color? }
 * Response: { data: Account }
 */
router.post('/accounts', (req, res) => {
  try {
    const vName    = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType    = oneOf(req.body.type || 'checking', ACCOUNT_TYPE_KEYS, 'Kontotyp');
    const vBalance = num(req.body.starting_balance ?? 0, 'Startsaldo', { required: false });
    const vColor   = validateColor(req.body.color, 'Farbe');
    const errors   = collectErrors([vName, vType, vBalance, vColor]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null;
    const color    = vColor.value;

    const result = db.get().prepare(`
      INSERT INTO budget_accounts (name, type, starting_balance, currency, color, sort_order, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value, vType.value, cents(vBalance.value ?? 0),
      currency, color, nextAccountSortOrder(),
      req.authUserId || req.session.userId
    );

    const account = listAccounts(true).find((a) => a.id === Number(result.lastInsertRowid));
    res.status(201).json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/accounts/:id
 * Konto aktualisieren (Name, Typ, Startsaldo, Währung, Farbe, Archiv-Status).
 * Response: { data: Account }
 */
router.put('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT * FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(str(req.body.name, 'Name', { max: MAX_SHORT }));
    if (req.body.type !== undefined) checks.push(oneOf(req.body.type, ACCOUNT_TYPE_KEYS, 'Kontotyp'));
    if (req.body.starting_balance !== undefined) checks.push(num(req.body.starting_balance, 'Startsaldo'));
    if (req.body.color !== undefined) checks.push(validateColor(req.body.color, 'Farbe'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency !== undefined
      ? (req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null)
      : existing.currency;
    const color = req.body.color !== undefined
      ? validateColor(req.body.color, 'Farbe').value
      : existing.color;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;

    db.get().prepare(`
      UPDATE budget_accounts
      SET name             = COALESCE(?, name),
          type             = COALESCE(?, type),
          starting_balance = COALESCE(?, starting_balance),
          currency         = ?,
          color            = ?,
          archived         = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? String(req.body.name).trim() : null,
      req.body.type !== undefined ? req.body.type : null,
      req.body.starting_balance !== undefined ? cents(req.body.starting_balance) : null,
      currency, color, archived, id
    );

    const account = listAccounts(true).find((a) => a.id === id);
    res.json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/accounts/:id
 * Konto löschen. Zugeordnete Einträge bleiben erhalten (account_id wird geleert).
 * Response: 204 No Content
 */
router.delete('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT id FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const tx = db.get().transaction(() => {
      // Zuordnung explizit leeren (unabhängig vom FK-Pragma), Einträge bleiben bestehen.
      db.get().prepare('UPDATE budget_entries SET account_id = NULL WHERE account_id = ?').run(id);
      db.get().prepare('DELETE FROM budget_accounts WHERE id = ?').run(id);
    });
    tx();

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 7);
    const month = req.query.month || today;
    const loanId = req.query.loan_id ? parseInt(req.query.loan_id, 10) : null;

    if (!loanId && !MONTH_RE.test(month))
      return res.status(400).json({ error: 'month muss YYYY-MM sein', code: 400 });

    if (!loanId) generateRecurringInstances(db.get(), month);

    const from   = `${month}-01`;
    const to     = `${month}-31`;
    let sql      = `
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
    `;
    const params = [];

    if (loanId) {
      sql += ' WHERE p.loan_id = ?';
      params.push(loanId);
    } else {
      sql += ' WHERE b.date BETWEEN ? AND ?';
      params.push(from, to);
    }

    if (req.query.category && validCategoryKeys().includes(req.query.category)) {
      sql += ' AND b.category = ?';
      params.push(req.query.category);
    }

    if (req.query.account_id) {
      const accountId = parseInt(req.query.account_id, 10);
      if (Number.isInteger(accountId) && accountId > 0) {
        sql += ' AND b.account_id = ?';
        params.push(accountId);
      }
    }

    sql += ' ORDER BY b.date DESC, b.created_at DESC';

    const entries = db.get().prepare(sql).all(...params);
    res.json({ data: entries });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * POST /api/v1/budget
 * Neuen Eintrag anlegen.
 * Body: { title, amount, category?, subcategory?, date, is_recurring?, recurrence_rule? }
 * Response: { data: Entry }
 */
router.post('/', (req, res) => {
  try {
    const vTitle  = str(req.body.title,    'Titel',  { max: MAX_TITLE });
    const vAmount = num(req.body.amount,  'Betrag', { required: true });
    const fallbackCategory = defaultCategory(Number(req.body.amount) < 0 ? 'expense' : 'income');
    const vCat    = oneOf(req.body.category || fallbackCategory, validCategoryKeys(), 'Kategorie');
    const vDate   = validateDate(req.body.date,   'Datum',  true);
    const vRrule  = rrule(req.body.recurrence_rule, 'Wiederholung');
    const vInterval = oneOf(req.body.recurrence_interval || 'monthly', RECURRENCE_INTERVAL_KEYS, 'Intervall');
    const errors  = collectErrors([vTitle, vAmount, vCat, vDate, vRrule, vInterval]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const subcategory = validateSubcategory(vCat.value, req.body.subcategory);
    if (subcategory === null) {
      return res.status(400).json({ error: 'Invalid subcategory.', code: 400 });
    }

    const accountRef = validateAccountRef(req.body.account_id);
    if (accountRef.error) return res.status(400).json({ error: accountRef.error, code: 400 });

    // Intervall + virtuelles Budget nur für wiederkehrende Einträge.
    const isRecurring = req.body.is_recurring ? 1 : 0;
    const interval    = isRecurring ? vInterval.value : 'monthly';
    const isVirtual   = isRecurring && req.body.recurrence_virtual ? 1 : 0;
    // Virtuell: amount hält den geglätteten Monatsanteil, full den eingegebenen Periodenbetrag.
    const storeAmount = isVirtual ? effectiveMonthly(vAmount.value, interval) : vAmount.value;
    const fullAmount  = isVirtual ? cents(vAmount.value) : null;

    const result = db.get().prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, recurrence_rule,
         recurrence_interval, recurrence_virtual, recurrence_full_amount, account_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vTitle.value, storeAmount, vCat.value || fallbackCategory, subcategory, vDate.value,
      isRecurring, vRrule.value,
      interval, isVirtual, fullAmount, accountRef.value,
      req.authUserId || req.session.userId
    );

    const entry = entryWithLoanMeta(result.lastInsertRowid);

    res.status(201).json({ data: entry });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id/series
 * Aktualisiert das Serien-Original und löscht zukünftige Instanzen (ab aktuellem Monat),
 * sodass sie beim nächsten Monatsaufruf mit den neuen Werten neu erzeugt werden.
 * Body: wie PUT /:id (date wird ignoriert – das Datum des Originals bleibt erhalten)
 * Response: { data: Parent-Entry }
 */
router.put('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return res.status(400).json({ error: 'Not a recurring entry.', code: 400 });

    const parent = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(parentId);
    if (!parent) return res.status(404).json({ error: 'Series parent not found', code: 404 });

    const checks = [];
    if (req.body.title    !== undefined) checks.push(str(req.body.title,    'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.amount   !== undefined) checks.push(num(req.body.amount,   'Betrag'));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validCategoryKeys(), 'Kategorie'));
    if (req.body.recurrence_rule !== undefined) checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    if (req.body.recurrence_interval !== undefined) checks.push(oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Intervall'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const { title, amount, category, subcategory: requestedSubcategory, is_recurring, recurrence_rule } = req.body;
    const finalTitle    = title     !== undefined ? title.trim()                        : parent.title;
    const finalAmount   = amount    !== undefined ? Number(amount)                     : parent.amount;
    const finalCategory = category  !== undefined ? category                           : parent.category;
    const finalSubcat   = requestedSubcategory !== undefined
      ? (validateSubcategory(finalCategory, requestedSubcategory) ?? parent.subcategory)
      : parent.subcategory;
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : parent.is_recurring;
    const finalInterval  = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (parent.recurrence_interval || 'monthly');
    const finalVirtual   = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : parent.recurrence_virtual;
    const finalFull      = finalVirtual
      ? (amount !== undefined ? cents(finalAmount) : (parent.recurrence_full_amount ?? parent.amount))
      : null;
    const storeAmount    = finalVirtual ? effectiveMonthly(finalFull, finalInterval) : finalAmount;
    const finalRrule     = recurrence_rule !== undefined ? (recurrence_rule || null) : parent.recurrence_rule;

    const currentMonthStart = new Date().toISOString().slice(0, 7) + '-01';

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE budget_entries SET
          title                  = ?,
          amount                 = ?,
          category               = ?,
          subcategory            = ?,
          is_recurring           = ?,
          recurrence_rule        = ?,
          recurrence_interval    = ?,
          recurrence_virtual     = ?,
          recurrence_full_amount = ?
        WHERE id = ?
      `).run(finalTitle, storeAmount, finalCategory, finalSubcat,
             finalRecurring, finalRrule, finalInterval, finalVirtual, finalFull,
             parentId);

      db.get().prepare(`
        DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?
      `).run(parentId, currentMonthStart);
    })();

    const updated = entryWithLoanMeta(parentId);
    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id/series
 * Löscht das Serien-Original und alle zugehörigen Instanzen.
 * Response: 204 No Content
 */
router.delete('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return res.status(400).json({ error: 'Not a recurring entry.', code: 400 });

    db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ?').run(parentId);
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(parentId);
    })();

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id
 * Eintrag bearbeiten.
 * Body: alle Felder optional
 * Response: { data: Entry }
 */
router.put('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });

    const checks = [];
    if (req.body.title    !== undefined) checks.push(str(req.body.title,    'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.amount   !== undefined) checks.push(num(req.body.amount,   'Betrag'));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validCategoryKeys(), 'Kategorie'));
    if (req.body.date     !== undefined) checks.push(validateDate(req.body.date,    'Datum'));
    if (req.body.recurrence_rule !== undefined) checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    if (req.body.recurrence_interval !== undefined) checks.push(oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Intervall'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const { title, amount, category, subcategory: requestedSubcategory, date, is_recurring, recurrence_rule } = req.body;
    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);
    if (linkedPayment && amount !== undefined && Number(amount) <= 0) {
      return res.status(400).json({ error: 'Loan repayment entries must remain income.', code: 400 });
    }
    if (linkedPayment && amount !== undefined) {
      const loan = db.get().prepare('SELECT total_amount FROM budget_loans WHERE id = ?').get(linkedPayment.loan_id);
      const otherPaid = db.get().prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM budget_loan_payments
        WHERE loan_id = ? AND id != ?
      `).get(linkedPayment.loan_id, linkedPayment.id).total;
      if (Number(amount) - (Number(loan?.total_amount || 0) - Number(otherPaid || 0)) > 0.005) {
        return res.status(400).json({ error: 'Amount cannot be greater than the remaining loan amount.', code: 400 });
      }
    }
    const nextCategory = category ?? entry.category;
    const subcategory = requestedSubcategory !== undefined || category !== undefined
      ? validateSubcategory(nextCategory, requestedSubcategory ?? entry.subcategory)
      : undefined;
    if (subcategory === null) {
      return res.status(400).json({ error: 'Invalid subcategory.', code: 400 });
    }

    // Konto-Zuordnung: undefined ⇒ unverändert; null/'' ⇒ Zuordnung entfernen; id ⇒ setzen.
    const accountProvided = req.body.account_id !== undefined;
    let accountValue = null;
    if (accountProvided) {
      const accountRef = validateAccountRef(req.body.account_id);
      if (accountRef.error) return res.status(400).json({ error: accountRef.error, code: 400 });
      accountValue = accountRef.value;
    }

    // Wiederkehrungs-Felder auflösen (Intervall + virtuelles Budget).
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : entry.is_recurring;
    const finalInterval = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (entry.recurrence_interval || 'monthly');
    let finalVirtual = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : entry.recurrence_virtual;
    if (!finalRecurring) finalVirtual = 0;
    // Konfigurierter Periodenbetrag (vorzeichenbehaftet): neue Eingabe, sonst bisheriger Vollbetrag.
    const configuredFull = amount !== undefined
      ? Number(amount)
      : (entry.recurrence_full_amount != null ? entry.recurrence_full_amount : entry.amount);
    const nextAmount = finalVirtual ? effectiveMonthly(configuredFull, finalInterval) : cents(configuredFull);
    const nextFull   = finalVirtual ? cents(configuredFull) : null;

    const tx = db.get().transaction(() => {
      db.get().prepare(`
        UPDATE budget_entries
        SET title                  = COALESCE(?, title),
            amount                 = ?,
            category               = COALESCE(?, category),
            subcategory            = COALESCE(?, subcategory),
            date                   = COALESCE(?, date),
            is_recurring           = ?,
            recurrence_rule        = ?,
            recurrence_interval    = ?,
            recurrence_virtual     = ?,
            recurrence_full_amount = ?,
            account_id             = CASE WHEN ? = 1 THEN ? ELSE account_id END
        WHERE id = ?
      `).run(
        title?.trim() ?? null,
        nextAmount,
        category ?? null,
        subcategory !== undefined ? subcategory : null,
        date ?? null,
        finalRecurring,
        recurrence_rule !== undefined ? (recurrence_rule || null) : entry.recurrence_rule,
        finalInterval,
        finalVirtual,
        nextFull,
        accountProvided ? 1 : 0,
        accountValue,
        id
      );

      if (linkedPayment) {
        db.get().prepare(`
          UPDATE budget_loan_payments
          SET amount = COALESCE(?, amount),
              paid_date = COALESCE(?, paid_date)
          WHERE id = ?
        `).run(
          amount !== undefined ? cents(amount) : null,
          date ?? null,
          linkedPayment.id
        );
        refreshLoanStatus(linkedPayment.loan_id);
      }
    });
    tx();

    const updated = entryWithLoanMeta(id);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id
 * Eintrag löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });

    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);

    const tx = db.get().transaction(() => {
      if (linkedPayment) {
        db.get().prepare('DELETE FROM budget_loan_payments WHERE id = ?').run(linkedPayment.id);
      }
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(id);
      if (linkedPayment) refreshLoanStatus(linkedPayment.loan_id);
    });
    tx();

    // Wenn eine Instanz gelöscht wird: Monat als übersprungen markieren
    if (entry.recurrence_parent_id) {
      const month = entry.date.slice(0, 7);
      db.get().prepare(
        'INSERT OR IGNORE INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)'
      ).run(entry.recurrence_parent_id, month);
    }

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * Aggregiert Budget-Daten für den Statistik-Tab.
 * @param {object} database  better-sqlite3/node:sqlite-Instanz mit .prepare()
 */
export function computeStats(database, { range, anchor }) {
  const r = computeStatsRange(range, anchor);

  const totalsRow = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?
  `).get(r.from, r.to);

  const prevRow = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?
  `).get(r.prevFrom, r.prevTo);

  const byCategory = database.prepare(`
    SELECT category,
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
           COALESCE(SUM(amount), 0) AS total
    FROM budget_entries WHERE date BETWEEN ? AND ?
    GROUP BY category ORDER BY ABS(SUM(amount)) DESC
  `).all(r.from, r.to);

  // Bucket-Schlüssel: bei 'day' das volle Datum, bei 'month' die ersten 7 Zeichen.
  const keyExpr = r.granularity === 'month' ? "substr(date, 1, 7)" : "date";
  const rawSeries = database.prepare(`
    SELECT ${keyExpr} AS period,
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
           COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?
    GROUP BY period
  `).all(r.from, r.to);

  const byPeriod = new Map(rawSeries.map((row) => [row.period, row]));
  const series = r.bucketKeys.map((period) =>
    byPeriod.get(period) || { period, income: 0, expenses: 0, balance: 0 });

  // Geplante Monatsbeträge je Ausgabenkategorie (Budgetplan). Der Reports-Tab
  // blendet daraus nur bei range='month' einen Ziel-Marker ein — dort deckt sich
  // der Zeitraum exakt mit dem stetigen Monatsplan; Wochen/Jahre würden ein
  // Hochskalieren erfordern, das leicht in die Irre führt (daher client-seitig
  // bewusst nur im Monat genutzt).
  const plans = {};
  for (const row of database.prepare('SELECT category, amount FROM budget_plans').all()) {
    if (row.category === BUDGET_SAVINGS_KEY) continue;
    plans[row.category] = cents(row.amount);
  }

  return {
    range: r.range, from: r.from, to: r.to,
    totals: { income: totalsRow.income, expenses: totalsRow.expenses, balance: totalsRow.balance },
    series,
    byCategory,
    comparison: { income: prevRow.income, expenses: prevRow.expenses, balance: prevRow.balance },
    plans,
  };
}

/**
 * GET /api/v1/budget/stats
 * Statistik-Aggregation über Woche/Monat/Jahr.
 * Query: ?range=week|month|year&anchor=YYYY-MM-DD
 */
export function statsHandler(req, res) {
  try {
    const range  = req.query.range || 'month';
    const anchor = req.query.anchor || todayLocalDateKey();
    if (!STATS_RANGES.has(range))
      return res.status(400).json({ error: 'range muss week|month|year sein', code: 400 });
    if (!DATE_RE.test(anchor))
      return res.status(400).json({ error: 'anchor muss YYYY-MM-DD sein', code: 400 });

    res.json({ data: computeStats(db.get(), { range, anchor }) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
}

router.get('/stats', statsHandler);

export default router;
export {
  generateRecurringInstances, monthsPerInterval, effectiveMonthly, RECURRENCE_INTERVAL_KEYS,
  categoryInUseCount, subcategoryInUseCount, categoryCountByType, subcategoryCountForCategory,
};
