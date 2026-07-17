/**
 * Modul: Budget-Tracker – Budgetplan (Discussion #468)
 * Zweck: geplantes/geschätztes Monatsbudget je Ausgabenkategorie + Sparziel; Plan-vs-Ist.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { num, collectErrors, MONTH_RE } from '../../middleware/validate.js';
import { cents, thisMonthLocalKey, validExpenseCategoryKeys } from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

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

export default router;
