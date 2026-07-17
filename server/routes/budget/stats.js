/**
 * Modul: Budget-Tracker – Statistik-Tab
 * Zweck: Aggregation über Woche/Monat/Jahr inkl. Vorperiode, Kategorie- und Zeitreihen.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { computeStatsRange, cents, budgetFilter, todayLocalDateKey, STATS_RANGES, DATE_RE } from './helpers.js';
import { BUDGET_SAVINGS_KEY } from './plans.js';

const log = createLogger('Budget');
const router = express.Router();

/**
 * Aggregiert Budget-Daten für den Statistik-Tab.
 * @param {object} database  better-sqlite3/node:sqlite-Instanz mit .prepare()
 */
export function computeStats(database, { range, anchor }, filter = { clause: '', params: [] }) {
  const r = computeStatsRange(range, anchor);
  const f = filter && filter.clause ? filter : { clause: '', params: [] };

  const totalsRow = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}
  `).get(r.from, r.to, ...f.params);

  const prevRow = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}
  `).get(r.prevFrom, r.prevTo, ...f.params);

  const byCategory = database.prepare(`
    SELECT category,
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
           COALESCE(SUM(amount), 0) AS total
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}
    GROUP BY category ORDER BY ABS(SUM(amount)) DESC
  `).all(r.from, r.to, ...f.params);

  // Bucket-Schlüssel: bei 'day' das volle Datum, bei 'month' die ersten 7 Zeichen.
  const keyExpr = r.granularity === 'month' ? "substr(date, 1, 7)" : "date";
  const rawSeries = database.prepare(`
    SELECT ${keyExpr} AS period,
           COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
           COALESCE(SUM(amount), 0) AS balance
    FROM budget_entries WHERE date BETWEEN ? AND ?${f.clause}
    GROUP BY period
  `).all(r.from, r.to, ...f.params);

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

    res.json({ data: computeStats(db.get(), { range, anchor }, budgetFilter(req, 'budget_entries')) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
}

router.get('/stats', statsHandler);

export default router;
