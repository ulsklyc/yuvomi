/**
 * Modul: Budget-Tracker – Budgetplan (Discussion #468)
 * Zweck: geplantes/geschätztes Monatsbudget je Ausgabenkategorie + Sparziel; Plan-vs-Ist.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { num, collectErrors, MONTH_RE } from '../../middleware/validate.js';
import {
  bookedOnly, cents, thisMonthLocalKey, validExpenseCategoryKeys, budgetFilter, budgetCategoryExpr,
} from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

// Reservierter Kategorie-Schlüssel für das Monats-Sparziel in budget_plans.
// '__savings__' kann nicht mit einem echten Kategorie-Slug kollidieren (slugify
// entfernt Unterstriche an den Rändern nicht, aber Nutzerkategorien sind lesbare
// Wörter; zusätzlich validiert das Schreiben gegen die echten Kategorie-Keys).
export const BUDGET_SAVINGS_KEY = '__savings__';

const HOUSEHOLD_WIDE = Object.freeze({
  f: Object.freeze({ clause: '', params: Object.freeze([]) }),
  c: Object.freeze({ expr: 'category', params: Object.freeze([]) }),
});

/** Prueft den Kontext von computePlanProgress; wirft bei fehlendem oder halbem. */
function planContext(context) {
  const { filter, categoryExpr, householdWide } = context || {};
  const isFilter = filter && typeof filter.clause === 'string' && Array.isArray(filter.params);
  const isExpr = categoryExpr && typeof categoryExpr.expr === 'string' && categoryExpr.expr !== ''
    && Array.isArray(categoryExpr.params);
  if (householdWide === true && filter === undefined && categoryExpr === undefined) return HOUSEHOLD_WIDE;
  if (householdWide === undefined && isFilter && isExpr) return { f: filter, c: categoryExpr };
  throw new TypeError('computePlanProgress: context needs { filter, categoryExpr } '
    + 'from budgetFilter()/budgetCategoryExpr(), or an explicit { householdWide: true }');
}

/**
 * Berechnet Plan-vs-Ist für einen Monat.
 * Plan = stetiger Monatsbetrag je Ausgabenkategorie; Ist = tatsächliche Ausgaben
 * des Monats (positiv dargestellt). Das Sparziel vergleicht den geplanten Betrag
 * mit dem Netto-Saldo (Einnahmen − Ausgaben) des Monats.
 *
 * **Kein Urteil über die Vergangenheit (#1005).** `budget_plans` haelt EINEN Betrag je
 * Kategorie ohne Zeitachse - kein `created_at`, und `updated_at` wird bei jeder Aenderung
 * ueberschrieben. Die DB weiss also nicht, was der Plan in einem frueheren Monat sagte.
 * Wer heute seinen Plan senkt, drehte damit das „ueber Budget" auf laengst abgeschlossenen
 * Monaten um. Fuer jeden Monat ausser dem laufenden bleiben `over`/`met` deshalb `null`:
 * geplant und ist sind Tatsachen und werden weiter geliefert, das Urteil nicht. Faellt
 * spaeter eine echte Plan-Historie an (#1001), kann `isCurrentMonth` ersatzlos weg.
 *
 * **Ist ist das, was der Betrachter sieht (#659).** Im personal-Modus gilt dieselbe
 * Regel wie in Summary und Statistik: `filter` aus budgetFilter() (Sichtbarkeit +
 * Mein/Haushalt-Scope), `categoryExpr` aus budgetCategoryExpr(). Fremde private
 * Buchungen zaehlen dann gar nicht, fremde 'shared_amount'-Betraege nur im
 * Sammel-Bucket '__private__'. Fuer den gibt es keinen Plan, er taucht also in
 * keiner Zeile auf und fliesst nur in Einnahmen und Saldo des Sparziels - wie
 * in der Uebersicht, wo sein Betrag zaehlt, sein Zweck aber nicht.
 *
 * **DER KONTEXT IST PFLICHT, FAIL-CLOSED.** Wer einer Person antwortet - Route,
 * Widget, Benachrichtigung -, gibt `{ filter, categoryExpr }` mit. Ein bewusst
 * betrachterloser Aufrufer sagt `{ householdWide: true }` und bekommt den ganzen
 * Haushalt ohne Sichtbarkeit (Altverhalten, identisch zum shared-Modus). Fehlt
 * beides, wirft die Funktion: ein stiller Default auf "alles" hiesse, dass ein
 * kuenftiger Aufrufer, der die Argumente vergisst, fremde private Ausgaben
 * wieder ueber ihre Kategorie-Summe verraet - und zwar gruen, ohne Fehler.
 *
 * @param {object} database
 * @param {string} month  YYYY-MM
 * @param {{ filter: {clause: string, params: any[]}, categoryExpr: {expr: string, params: any[]} }
 *        | { householdWide: true }} context
 * @returns {object} { month, isCurrentMonth, plans: [], savings: {}|null, totalPlanned, totalActual }
 */
export function computePlanProgress(database, month, context) {
  const { f, c } = planContext(context);
  const from = `${month}-01`;
  const to   = `${month}-31`;
  const isCurrentMonth = month === thisMonthLocalKey();

  const planRows = database.prepare('SELECT category, amount FROM budget_plans').all();
  const planMap  = new Map(planRows.map((r) => [r.category, cents(r.amount)]));

  // Ist-Ausgaben je Kategorie (als positive Beträge) für den Monat.
  // GROUP BY 1, nicht GROUP BY category: bei gleichnamigem Output-Alias gewinnt
  // in SQLite die ECHTE Spalte, und der maskierte Betrag landete wieder unter
  // seiner echten Kategorie. Der Bind des Ausdrucks steht in der SELECT-Liste,
  // also VOR den WHERE-Binds.
  const spentRows = database.prepare(`
    SELECT ${c.expr} AS category, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spent
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}${bookedOnly()} AND transfer_entry_id IS NULL GROUP BY 1
  `).all(...c.params, from, to, ...f.params);
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
      over: isCurrentMonth ? actual > planned + 0.005 : null,
    });
  }
  // Höchste Auslastung zuerst → die Familie sieht gefährdete Budgets oben.
  plans.sort((a, b) => b.ratio - a.ratio);

  const totalPlanned = cents(plans.reduce((s, p) => s + p.planned, 0));
  const totalActual  = cents(plans.reduce((s, p) => s + p.actual, 0));

  const totals = database.prepare(`
    SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
           SUM(amount) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}${bookedOnly()} AND transfer_entry_id IS NULL
  `).get(from, to, ...f.params);
  const income  = cents(totals.income || 0);
  const balance = cents(totals.balance || 0); // Netto-Ersparnis des Monats

  const savingsPlanned = planMap.get(BUDGET_SAVINGS_KEY);
  const savings = savingsPlanned != null ? {
    planned: savingsPlanned,
    actual: balance,
    remaining: cents(savingsPlanned - balance),
    ratio: savingsPlanned > 0 ? balance / savingsPlanned : 0,
    met: isCurrentMonth ? balance >= savingsPlanned - 0.005 : null,
    income,
  } : null;

  return { month, isCurrentMonth, plans, savings, totalPlanned, totalActual };
}

/**
 * GET /api/v1/budget/plans
 * Budgetplan-Fortschritt für einen Monat: geplant vs. Ist je Kategorie + Sparziel.
 * Query: ?month=YYYY-MM (default: aktueller Monat)
 */
router.get('/plans', (req, res) => {
  try {
    const month = MONTH_RE.test(req.query.month || '') ? req.query.month : thisMonthLocalKey();
    // Sichtbarkeit/Scope wie Summary und Statistik (#476/#505/#659).
    res.json({
      data: computePlanProgress(db.get(), month, {
        filter: budgetFilter(req, 'budget_entries'),
        categoryExpr: budgetCategoryExpr(req, 'budget_entries'),
      }),
    });
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

    const vAmount = num(req.body.amount, 'Amount', { required: true });
    const errors  = collectErrors([vAmount]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (!(vAmount.value > 0))
      return res.status(400).json({ error: 'Amount must be greater than zero.', code: 400 });

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

export default router;
