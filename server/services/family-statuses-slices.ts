/**
 * Module: family statuses - the availability block of GET /dashboard as one
 *         overview slice (phase 2, section D, contract E10)
 * Purpose: the per-member availability status for the family card (#1591):
 *          state, note, expiry and when it was last updated, for every
 *          household member with an active (non-expired) status.
 *
 * THE CONTRACT. familyStatusesOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous, reads no clock passed in (the SQL compares against the DB's own
 * `now`) and sees no request. The list is household-wide and has no row
 * visibility: every active status is listed for every viewer, same as the
 * member list (members-slices.ts) - the status belongs to the person, not to
 * a module a viewer could be denied.
 *
 * ONE FAILURE: the block had its own try/catch in the route that answered `[]`
 * and logged nothing. `guard` (the route's runSlice()) carries it under the
 * name `familyStatuses` with the same failure value `[]`, and now logs
 * `familyStatuses error:` like every other block. Without a guard a failure
 * throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD (moved from getAllStatuses() in
 * routes/availability.js, which keeps its own copy for its own GET).
 *
 * THE EMPTY KEY STAYS IN THE ROUTE (emptyAnswer): this block carries no module
 * gate, so there is no DENIED_PAYLOAD entry for it to come from.
 *
 * Dependencies: server/authorize/index.ts (types only), services/household-members.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { householdMemberSql } from './household-members.js';

type FamilyStatus = {
  user_id: number;
  state: string;
  note: string | null;
  expires_at: string;
  updated_at: string;
};

/** The family-statuses block reads no query option of the overview. */
export type FamilyStatusesOverviewOptions = Readonly<Record<string, never>>;

export type FamilyStatusesOverview = { familyStatuses: FamilyStatus[] };

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The active availability statuses of the household, most recently updated
 * first.
 *
 * @param db       the connection of the request
 * @param _actor   the row reader of the request (the list is household-wide)
 * @param _ctx     today, zone and now of the request (not read; the SQL compares
 *                 against the database's own clock, as getAllStatuses() always did)
 * @param _options none
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function familyStatusesOverviewSlice(
  db: Database,
  _actor: RowReader,
  _ctx: OverviewContext,
  _options: FamilyStatusesOverviewOptions = {},
  guard: SliceGuard = passThrough,
): FamilyStatusesOverview {
  const familyStatuses = guard('familyStatuses', (): FamilyStatus[] => db.prepare(`
    SELECT a.user_id,
           a.state,
           a.note,
           a.expires_at,
           a.updated_at
    FROM user_availability a
    JOIN users u ON u.id = a.user_id
    WHERE ${householdMemberSql('u')}
      AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    ORDER BY a.updated_at DESC
  `).all() as FamilyStatus[], []);
  return { familyStatuses };
}
