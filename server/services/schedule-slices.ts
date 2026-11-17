/**
 * Module: schedule - the own shift of today in GET /dashboard as one overview
 *         slice (phase 2, section D, contract E10)
 * Purpose: the viewer's OWN shift of today for the today sheet - not the
 *          household's, the schedule tile shows that. Free days are no row:
 *          "free" is the absence of an item, not an item.
 *
 * THE CONTRACT. scheduleOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous and sees no request. The day is `ctx.today`, the household day.
 *
 * THE CONNECTION IS SCHEDULE'S OWN: scheduleData() of services/schedule.js
 * opens it through db.get(), as the route's call always did; the `db` slot keeps
 * the contract's shape.
 *
 * ONE FAILURE, AS BEFORE: the block had one try/catch in the route; `guard` (the
 * route's runSlice()) carries that under the old name `myShiftsToday` with the
 * old failure value (an empty list). Without a guard a failure throws.
 *
 * Dependencies: server/authorize/index.ts (types only), services/schedule.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { scheduleData } from './schedule.js';

/** The options of the request that act on the shift block. */
export type ScheduleOverviewOptions = Readonly<{
  /** The viewer (`req.authUserId || req.session.userId`): only their own shifts. */
  userId: number | null;
}>;

type ShiftType = {
  id: unknown;
  name: unknown;
  short_code?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  color?: unknown;
  icon?: unknown;
};
type ScheduleEntry = {
  date_key: unknown;
  source: unknown;
  crosses_midnight: unknown;
  shift_type?: ShiftType | null;
  is_free?: unknown;
};
type TodayShift = {
  date_key: unknown;
  source: unknown;
  crosses_midnight: unknown;
  shift_type: Required<ShiftType>;
};

export type ScheduleOverview = { myShiftsToday: TodayShift[] };

/**
 * The empty form: a denied or switched-off schedule module (DENIED_PAYLOAD in
 * the route). Its own name instead of `schedule`: under that name the browser
 * keeps the slice of the tile (`ensureScheduleSlice`).
 */
export function emptyScheduleOverview(): ScheduleOverview {
  return { myShiftsToday: [] };
}

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The own shift of today.
 *
 * @param _db     the connection of the request (scheduleData() opens its own)
 * @param _actor  the row reader of the request (shifts are read for `options.userId`)
 * @param ctx     today, zone and now of the request
 * @param options the viewer
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function scheduleOverviewSlice(
  _db: Database,
  _actor: RowReader,
  ctx: OverviewContext,
  options: ScheduleOverviewOptions,
  guard: SliceGuard = passThrough,
): ScheduleOverview {
  const { userId } = options;
  const myShiftsToday = guard('myShiftsToday', (): TodayShift[] => (
    scheduleData(ctx.today, ctx.today, userId).entries as ScheduleEntry[])
    .filter((entry) => entry.shift_type && !entry.is_free)
    .map((entry) => ({
      date_key: entry.date_key,
      source: entry.source,
      crosses_midnight: entry.crosses_midnight,
      shift_type: {
        id: entry.shift_type!.id,
        name: entry.shift_type!.name,
        short_code: entry.shift_type!.short_code ?? null,
        start_time: entry.shift_type!.start_time ?? null,
        end_time: entry.shift_type!.end_time ?? null,
        color: entry.shift_type!.color ?? null,
        icon: entry.shift_type!.icon ?? null,
      },
    })), []);
  return { myShiftsToday };
}
