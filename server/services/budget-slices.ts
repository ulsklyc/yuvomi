/**
 * Module: budget - the budget block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the budget module's own
 *          tables: the month's income, expenses, balance and entry count, the
 *          largest expense categories and the monthly savings goal.
 *
 * THE CONTRACT. budgetOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock: the month comes in `options.month` (the month of the
 * household day the route reads once for every block). Personal or shared comes
 * from authorize (resolveBudgetMode), read inside the guard as before, so a
 * failing mode read still empties only this block; in personal mode the reader's
 * own id is the owner bind.
 *
 * NOT HERE: the split balance (`splitBalance`). It reads the split tables of the
 * shared expenses (expense_groups, expense_group_members, expense_ledger_entries)
 * through services/split-expenses.js, none of the budget's own tables, and stays
 * in the route for its own cut.
 *
 * ONE FAILURE, AS BEFORE: the three reads used to share one try/catch in the
 * route; `guard` (the route's runSlice()) carries that under the old name `budget`
 * and with the old failure value (budgetBlockFailed(month): the empty form WITHOUT
 * `savingsGoal`, exactly what the old catch wrote). The savings goal keeps its own
 * inner guard: a missing budget_plans table means no goal, not a failed block.
 * Without a guard a failure throws.
 *
 * MONEY IS WORD FOR WORD: the SQL (SUM(CASE ...), ABS(SUM(...)), the month bounds
 * `-01`/`-31`, the pending and transfer exclusions), the rounding of the goal and
 * every Math.abs are the route's. The golden master (test:overview-golden) holds
 * the answers.
 *
 * Dependencies: server/authorize/index.ts (budget mode). Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import { resolveBudgetMode } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';

/** Query options of the overview that act on the budget block. */
export type BudgetOverviewOptions = Readonly<{
  /** YYYY-MM, the month of the household day (ctx.today). */
  month: string;
}>;

type BudgetTopExpense = { category: unknown; amount: number };

type BudgetTile = {
  month: string;
  income: number;
  expenses: number;
  balance: number;
  entryCount: number;
  topExpenseCategory: unknown;
  topExpenseAmount: number;
  topExpenses: BudgetTopExpense[];
  savingsGoal?: number | null;
};

export type BudgetOverview = { budget: BudgetTile };

/**
 * The empty form: a denied or switched-off budget module (DENIED_PAYLOAD in the
 * route). The month stays: it is no budget figure but the period the tile is
 * labelled with. The key order is the route's old emptyBudget().
 */
export function emptyBudgetOverview(month: string): BudgetOverview {
  return {
    budget: {
      month,
      income: 0,
      expenses: 0,
      balance: 0,
      entryCount: 0,
      topExpenseCategory: null,
      topExpenseAmount: 0,
      topExpenses: [],
      savingsGoal: null,
    },
  };
}

/**
 * What the block answers when one of its reads fails. Kept as the route wrote it:
 * unlike the empty form it has NO `savingsGoal` key.
 */
export function budgetBlockFailed(month: string): BudgetOverview {
  return {
    budget: {
      month,
      income: 0,
      expenses: 0,
      balance: 0,
      entryCount: 0,
      topExpenseCategory: null,
      topExpenseAmount: 0,
      topExpenses: [],
    },
  };
}

const passThrough: SliceGuard = (_name, read) => read();

type TotalsRow = { income: number | null; expenses: number | null; balance: number | null; entry_count: number | null };
type TopExpenseRow = { category: unknown; amount: number | null };

/**
 * The budget block of the overview.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request (its `userId` is the owner in personal mode)
 * @param _ctx    today, zone and now of the request (the month comes in options)
 * @param options the month of the household day
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function budgetOverviewSlice(
  db: Database,
  actor: RowReader,
  _ctx: OverviewContext,
  options: BudgetOverviewOptions,
  guard: SliceGuard = passThrough,
): BudgetOverview {
  const userId = actor.userId;
  const currentMonth = options.month;
  return guard('budget', (): BudgetOverview => {
    const from = `${currentMonth}-01`;
    const to = `${currentMonth}-31`;
    // Personal or shared (#476/#505): in personal mode the dashboard widget shows
    // the own budget (owner_id = me), otherwise the whole household budget.
    const ownerClause = resolveBudgetMode(db) === 'personal' ? ' AND owner_id = ?' : '';
    const ownerParams = ownerClause ? [userId] : [];

    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance,
        COUNT(*) AS entry_count
      FROM budget_entries
      -- Erwartete, noch unbestaetigte Buchungen zaehlen nicht mit (#637), wie in
      -- Uebersicht, Statistik, Plan und Kontostand.
      WHERE date BETWEEN ? AND ?${ownerClause} AND is_pending = 0 AND transfer_entry_id IS NULL
    `).get(from, to, ...ownerParams) as TotalsRow | undefined;

    // The largest expense categories, not only the largest one: the tall budget
    // tile (1x2) fills its height with content instead of an empty band above the
    // footer (critique 2026-09-23). It shows three; FIVE, because a stretched tile
    // shows more (U14, height becomes content) - the same grouping, two rows more.
    // The first stays as `topExpenseCategory`/`topExpenseAmount` as well - the flat
    // tile and older clients read exactly these two fields.
    const topExpenses = db.prepare(`
      SELECT category, SUM(amount) AS amount
      FROM budget_entries
      WHERE amount < 0 AND date BETWEEN ? AND ?${ownerClause} AND is_pending = 0 AND transfer_entry_id IS NULL
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
      LIMIT 5
    `).all(from, to, ...ownerParams) as TopExpenseRow[];
    const topExpense = topExpenses[0];

    // Monthly savings goal (budget plan #468): its own guard, so older or minimal
    // databases without a budget_plans table do not fail the budget aggregation.
    let savingsGoal: number | null = null;
    try {
      const goalRow = db.prepare("SELECT amount FROM budget_plans WHERE category = '__savings__'").get() as { amount: number } | undefined;
      if (goalRow) savingsGoal = Math.round(goalRow.amount * 100) / 100;
    } catch { /* table missing (legacy/test) -> no savings goal */ }

    return {
      budget: {
        month: currentMonth,
        income: totals?.income || 0,
        expenses: Math.abs(totals?.expenses || 0),
        balance: totals?.balance || 0,
        entryCount: totals?.entry_count || 0,
        topExpenseCategory: topExpense?.category || null,
        topExpenseAmount: Math.abs(topExpense?.amount || 0),
        topExpenses: topExpenses.map((row) => ({ category: row.category, amount: Math.abs(row.amount || 0) })),
        savingsGoal,
      },
    };
  }, budgetBlockFailed(currentMonth));
}
