/**
 * Module: waste - the pickup block of the today sheet in GET /dashboard as one
 *         overview slice (phase 2, section D, contract E10)
 * Purpose: the pickups of today (bin goes out) and tomorrow (put it out tonight).
 *          The same resolution as tile, module and calendar (`getOccurrences`,
 *          invariant #3: never twice), only the two-day window and only the
 *          fields a row needs. The type selection of the tile does not apply
 *          here: the row speaks only when the tile is NOT visible.
 *
 * THE CONTRACT. wasteOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous, reads no clock and sees no request. The window is `ctx.today`
 * to the day after, both in the household zone.
 *
 * ITS OWN KEY NAME instead of `waste`: under that name the browser keeps the
 * slice of the tile (`ensureWasteSlice`), and a field of the same name here
 * would never let it load again.
 *
 * ONE FAILURE, AS BEFORE: the block had one try/catch in the route; `guard` (the
 * route's runSlice()) carries that under the old name `wastePickups` with the old
 * failure value (an empty list). Without a guard a failure throws.
 *
 * Dependencies: server/authorize/index.ts (types only), services/waste-store.js,
 * utils/timezone.js. Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import * as wasteStore from './waste-store.js';
import { shiftDateKey } from '../utils/timezone.js';

type WasteOccurrence = {
  date_key: unknown;
  type_id: unknown;
  type_name: unknown;
  type_icon: unknown;
  type_color: unknown;
  deep_link: unknown;
};

// The JS reader infers its types from its body; this is the shape the overview
// calls it with. Same function, same call.
const getWasteOccurrences = wasteStore.getOccurrences as unknown as (
  db: Database, range: Readonly<{ from: string; to: string }>,
) => WasteOccurrence[];

/** The waste block reads no query option of the overview. */
export type WasteOverviewOptions = Readonly<Record<string, never>>;

export type WasteOverview = { wastePickups: WasteOccurrence[] };

/** The empty form: a denied or switched-off waste module (DENIED_PAYLOAD in the route). */
export function emptyWasteOverview(): WasteOverview {
  return { wastePickups: [] };
}

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The pickups of today and tomorrow.
 *
 * @param db       the connection of the request
 * @param _actor   the row reader of the request (pickups are household-wide)
 * @param ctx      today, zone and now of the request
 * @param _options none
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function wasteOverviewSlice(
  db: Database,
  _actor: RowReader,
  ctx: OverviewContext,
  _options: WasteOverviewOptions = {},
  guard: SliceGuard = passThrough,
): WasteOverview {
  const wastePickups = guard('wastePickups', (): WasteOccurrence[] => {
    const tomorrow = shiftDateKey(ctx.today, 1);
    return getWasteOccurrences(db, { from: ctx.today, to: tomorrow })
      .map((o) => ({
        date_key: o.date_key,
        type_id: o.type_id,
        type_name: o.type_name,
        type_icon: o.type_icon,
        type_color: o.type_color,
        deep_link: o.deep_link,
      }));
  }, []);
  return { wastePickups };
}
