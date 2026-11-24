/**
 * Module: housekeeping - the housekeeping block of GET /dashboard as one overview
 *         slice (phase 2, section D, contract E10)
 * Purpose: a compact status instead of a list: presence (an open work session),
 *          the visits of the running month, the unpaid amount and the last visit.
 *
 * THE CONTRACT. housekeepingOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous and reads no clock: the month is the month of `ctx.today` and the
 * zone is `ctx.zone`, the household day and zone the route reads once for every
 * block.
 *
 * MONEY IS A CAPABILITY (R20): without `housekeeping_view_amounts` the unpaid
 * amount is `null`, as in the module. Whether the viewer has it, only the request
 * knows; the route hands the question in as `options.viewsAmounts`, and the slice
 * asks it inside the guard at the place the old block asked it - after every read
 * of the block, so a failing capability read still empties only this block.
 *
 * ONE FAILURE, AS BEFORE: the block used to have one try/catch in the route;
 * `guard` (the route's runSlice()) carries that under the old name `housekeeping`
 * and with the old failure value (HOUSEKEEPING_BLOCK_FAILED). Without a guard a
 * failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD. The golden master (test:overview-golden)
 * holds the answers.
 *
 * Dependencies: server/authorize/index.ts (types only), services/housekeeping-month.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { finishedVisitsInMonth, latestVisit } from './housekeeping-month.js';

/** Query options of the overview that act on the housekeeping block. */
export type HousekeepingOverviewOptions = Readonly<{
  /** Asked once, inside the guard: may the viewer see amounts (housekeeping_view_amounts)? */
  viewsAmounts: () => boolean;
}>;

type HousekeepingTile = {
  configured: boolean;
  present: boolean;
  presentSince: unknown;
  workerName: unknown;
  visitsThisMonth: number;
  unpaidAmount: number | null;
  lastVisit: unknown;
};

export type HousekeepingOverview = { housekeeping: HousekeepingTile };

/**
 * The empty form: a denied or switched-off housekeeping module (DENIED_PAYLOAD in
 * the route). The key order is the route's old one.
 */
export function emptyHousekeepingOverview(): HousekeepingOverview {
  return {
    housekeeping: {
      configured: false, present: false, presentSince: null, workerName: null,
      visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null,
    },
  };
}

/** What the block answers when one of its reads fails. Kept as the route wrote it. */
export function housekeepingBlockFailed(): HousekeepingOverview {
  return {
    housekeeping: {
      configured: false, present: false, presentSince: null, workerName: null, visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null,
    },
  };
}

const passThrough: SliceGuard = (_name, read) => read();

type Visit = { worker_id?: unknown; check_in?: unknown } | undefined;

/**
 * The housekeeping block of the overview.
 *
 * @param db      the connection of the request
 * @param _actor  the row reader of the request (the block has no row visibility)
 * @param ctx     today, zone and now of the request
 * @param options the capability question of the request
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function housekeepingOverviewSlice(
  db: Database,
  _actor: RowReader,
  ctx: OverviewContext,
  options: HousekeepingOverviewOptions,
  guard: SliceGuard = passThrough,
): HousekeepingOverview {
  return guard('housekeeping', (): HousekeepingOverview => {
    // "The latest begun" and "the last visit" are the latest INSTANT, not the
    // largest text of `check_in` - the same rule as in the module (`latestVisit`),
    // otherwise the tile names another visit than the module page.
    const hkZone = ctx.zone;
    const openSession = latestVisit(db, hkZone, 'check_out IS NULL') as Visit;
    const openWorker = openSession?.worker_id ? db.prepare(`
      SELECT u.display_name AS worker_name
      FROM housekeeping_workers hw
      LEFT JOIN users u ON u.id = hw.user_id
      WHERE hw.id = ?
    `).get(openSession.worker_id) as { worker_name?: unknown } | undefined : null;
    // The month of the HOUSEHOLD, not the UTC month of `check_in` (#1451):
    // `substr(check_in, 1, 7)` counted a visit on the first at 00:30 in Berlin into
    // the previous month - the same rule as in the module (#1387).
    const month = finishedVisitsInMonth(db, ctx.today.slice(0, 7), hkZone) as { visits: number; unpaid: number };
    const lastRow = latestVisit(db, hkZone, 'check_out IS NOT NULL') as Visit;
    const anyRow = db.prepare('SELECT 1 FROM housekeeping_work_sessions LIMIT 1').get()
      || db.prepare('SELECT 1 FROM housekeeping_workers LIMIT 1').get();
    return {
      housekeeping: {
        configured: Boolean(anyRow),
        present: Boolean(openSession),
        presentSince: openSession?.check_in || null,
        workerName: openWorker?.worker_name || null,
        visitsThisMonth: month.visits,
        // The unpaid wage is money (R20): without `housekeeping_view_amounts` -
        // new child accounts start that way - it comes as `null`, as in the module.
        unpaidAmount: options.viewsAmounts() ? month.unpaid : null,
        lastVisit: lastRow?.check_in || null,
      },
    };
  }, housekeepingBlockFailed());
}
