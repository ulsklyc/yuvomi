/**
 * Module: members - the member list of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: the household members with name, avatar colour, avatar and position
 *          (`users`): the widgets colour their people from it, and the family card
 *          asks each of them for their events.
 *
 * THE CONTRACT. membersOverviewSlice(db, actor, ctx, options, guard) is synchronous,
 * reads no clock and sees no request. The list is household-wide and has no row
 * visibility: every member is listed for every viewer, in the one member order
 * (household-members.js).
 *
 * ONE FAILURE: the block had its own try/catch in the route that answered `[]`
 * and logged nothing. `guard` (the route's runSlice()) carries it under the name
 * `users` with the same failure value `[]`, and now logs `users error:` like every
 * other block. Without a guard a failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD.
 *
 * Dependencies: server/authorize/index.ts (types only), services/household-members.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { householdMemberSql, memberOrderSql, memberPositionSql } from './household-members.js';

type Member = {
  id: number;
  display_name: string;
  avatar_color: string | null;
  avatar_data: string | null;
  sort_order: number | null;
};

/** The member list reads no query option of the overview. */
export type MembersOverviewOptions = Readonly<Record<string, never>>;

export type MembersOverview = { users: Member[] };

/** The empty form: the member list of an answer that reads nothing (emptyAnswer in the route). */
export function emptyMembersOverview(): MembersOverview {
  return { users: [] };
}

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The household members in the household order.
 *
 * @param db       the connection of the request
 * @param _actor   the row reader of the request (the list is household-wide)
 * @param _ctx     today, zone and now of the request (not read)
 * @param _options none
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function membersOverviewSlice(
  db: Database,
  _actor: RowReader,
  _ctx: OverviewContext,
  _options: MembersOverviewOptions = {},
  guard: SliceGuard = passThrough,
): MembersOverview {
  const users = guard('users', (): Member[] => db.prepare(
    `SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, ${memberPositionSql('u')} AS sort_order FROM users u
       WHERE ${householdMemberSql('u')}
       ORDER BY ${memberOrderSql('u')}`
  ).all() as Member[], []);
  return { users };
}
