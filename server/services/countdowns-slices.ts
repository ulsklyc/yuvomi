/**
 * Module: countdowns - the countdown block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: marked events and tasks and documents expiring soon (#647, #1705) in
 *          ONE list sorted by nearness, and the total behind it.
 *
 * THE CONTRACT. countdownsOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous and sees no request. The day is `ctx.today`, the household day,
 * not the UTC day: "1 day left" against "today" is decided on the viewer's
 * calendar day, and west of UTC that is another one.
 *
 * THE ONE PART OF THE ANSWER THAT BELONGS TO SEVERAL MODULES, and therefore its
 * lock is not a row of DENIED_PAYLOAD but an argument: whoever lost the calendar
 * loses the event countdowns and keeps the task countdowns. An all-or-nothing
 * would have dropped the tile when ONE of the two modules was locked - the same
 * trap the household module switch set in the review of PR #793. The total is
 * built in getCountdowns() behind the same filter, so cut and number mean the
 * same set. The set (`options.hiddenModules`) and whether the block is read at
 * all (`wants('countdowns')`, the wall allowlist) stay decisions of the route.
 *
 * ONE FAILURE, AS BEFORE: the block had one try/catch in the route; `guard` (the
 * route's runSlice()) carries that under the old name `countdowns` with the old
 * failure value (no items, total 0). Without a guard a failure throws.
 *
 * Dependencies: server/authorize/index.ts (types only), services/countdowns.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import * as countdownReader from './countdowns.js';

// The JS reader infers its option types from its defaults (`userId = null`);
// this is the shape the overview calls it with. Same function, same call.
const getCountdowns = countdownReader.getCountdowns as unknown as (
  db: Database, options: Readonly<Record<string, unknown>>,
) => { items: unknown[]; total: number };

/** The options of the request that act on the countdown block. */
export type CountdownsOverviewOptions = Readonly<{
  /** The viewer (`req.authUserId || req.session.userId`). */
  userId: number | null;
  /** The modules the viewer may not read (hiddenModulesFor, `denied` in the route). */
  hiddenModules: ReadonlySet<string>;
}>;

export type CountdownsOverview = {
  countdowns: unknown[];
  countdownTotal: number;
};

/** The empty form, as the route's emptyAnswer() wrote it: no items, total 0. */
export function emptyCountdownsOverview(): CountdownsOverview {
  return { countdowns: [], countdownTotal: 0 };
}

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The countdown block of the overview.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request: the event and task countdowns of
 *                a paired display follow the wall rule (rowReader)
 * @param ctx     today, zone and now of the request
 * @param options the viewer and the modules hidden from them
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function countdownsOverviewSlice(
  db: Database,
  actor: RowReader,
  ctx: OverviewContext,
  options: CountdownsOverviewOptions,
  guard: SliceGuard = passThrough,
): CountdownsOverview {
  const { userId, hiddenModules } = options;
  return guard('countdowns', (): CountdownsOverview => {
    const countdowns = getCountdowns(db, {
      userId,
      todayKey: ctx.today,
      hiddenModules,
      // The event and task countdowns of a paired display follow the wall rule (rowReader).
      reader: actor,
    });
    return {
      countdowns: countdowns.items,
      // Like `birthdayCount` next to `birthdays`: the list is the stock for the
      // largest tile size, the number is the truth about the whole.
      countdownTotal: countdowns.total,
    };
  }, emptyCountdownsOverview());
}
