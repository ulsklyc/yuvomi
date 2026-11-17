/**
 * Module: rewards - the reward block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the rewards module: the
 *          participating members with their points, the view of the reader, the
 *          pending reward and money requests, the active catalog and the reader's
 *          recent credits.
 *
 * PROGRESS INSTEAD OF A RANKING (critique 2026-09-23, persona Emma). The answer
 * splits by the question the module itself asks - who may APPROVE (isAdminRequest,
 * the same check as PATCH /rewards/redemptions) -, not by `family_role`:
 *
 *   approver - every participating member by NAME (no place), plus all pending
 *              requests;
 *   self     - who does not approve but collects: ONLY the own row, the own
 *              pending requests and the most recently earned points. Siblings do
 *              not go over the wire at all;
 *   family   - who neither approves nor collects (wall tablet, grandparents):
 *              everybody by name, without other people's requests.
 *
 * THE CONTRACT. rewardsOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock (no read here needs a day). What the route knows from the
 * request comes in `options`: whether the reader approves (isAdminRequest) and the
 * money reader (moneyReader(req), the same predicate as the money routes). The
 * reader's id is `actor.userId`, the same value the route used as `userId`.
 *
 * ONE FAILURE, AS BEFORE: the reads used to share one try/catch in the route;
 * `guard` (the route's runSlice()) carries that under the old name `rewards` and
 * with the old failure value (REWARDS_BLOCK_FAILED, without `me`). Without a guard
 * a failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD (the golden master test:overview-golden
 * holds the answers).
 *
 * Dependencies: services/household-members.js, services/rewards.js,
 * services/reward-money.js. Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { householdMemberSql, memberOrderSql, memberPositionSql } from './household-members.js';
import { activeCatalog, ledgerBalanceSql } from './rewards.js';
import { moneyParams, moneyVisibleSql } from './reward-money.js';

/** The money reader of a request (services/reward-money.js moneyReader()). */
type MoneyReader = Readonly<{ admin: boolean; display: boolean; me: number | null }>;

/** What the route knows from the request and the slice needs. */
export type RewardsOverviewOptions = Readonly<{
  /** Whether the reader may approve (isAdminRequest(req)). */
  approver: boolean;
  /** The money reader of the request (moneyReader(req)). */
  moneyReader: MoneyReader;
}>;

type Row = Record<string, unknown>;
type MemberRow = Row & { id: number };

type RewardsTile = {
  view: 'approver' | 'self' | 'family' | null;
  me?: unknown;
  standings: Row[];
  participantCount: number;
  pending: number;
  moneyPending: number;
  catalog: Row[];
  recent: Row[];
};

export type RewardsOverview = { rewards: RewardsTile };

/**
 * The empty form: a denied or switched-off rewards module (DENIED_PAYLOAD in the
 * route). The key order is the order the route has always written them in.
 */
export function emptyRewardsOverview(): RewardsOverview {
  return {
    rewards: { view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [] },
  };
}

/** What the block answers when one of its reads fails. Kept as the route wrote it (no `me`). */
export const REWARDS_BLOCK_FAILED: Readonly<RewardsOverview> = Object.freeze({
  rewards: Object.freeze({
    view: null, standings: [], participantCount: 0, pending: 0, moneyPending: 0, catalog: [], recent: [],
  }) as RewardsTile,
});

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The reward block of the overview.
 *
 * @param db      the connection of the request
 * @param actor   the row reader of the request (its `userId` is the viewer)
 * @param _ctx    today, zone and now of the request (no read here needs them)
 * @param options approver flag and money reader of the request
 * @param guard   the route's runSlice(); without it a failing read throws
 */
export function rewardsOverviewSlice(
  db: Database,
  actor: RowReader,
  _ctx: OverviewContext,
  options: RewardsOverviewOptions,
  guard: SliceGuard = passThrough,
): RewardsOverview {
  const userId = actor.userId;
  return guard('rewards', (): RewardsOverview => {
    const MEMBER_FILTER = householdMemberSql('u');
    const members = db.prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
             ${memberPositionSql('u')} AS sort_order,
             ${ledgerBalanceSql('points', 'u.id')} AS balance
      FROM users u
      JOIN reward_participants rp ON rp.user_id = u.id AND rp.enabled = 1
      WHERE ${MEMBER_FILTER}
      ORDER BY ${memberOrderSql('u')}
    `).all() as MemberRow[];
    const approver = options.approver;
    const own = members.find((m) => m.id === Number(userId));
    const view = approver ? 'approver' : own ? 'self' : 'family';
    const standings = view === 'self' ? [own as MemberRow] : members;
    // The same people as the list above (#1207): an old enrolment of staff or a
    // guest stays, but does not count.
    const participantCount = members.length;
    // `pending` STAYS THE NUMBER OF REWARD REQUESTS. Money requests (#1734) stand
    // next to it in `moneyPending`, so a client reading the old field finds nothing
    // else in it. Who counts what, the branches say: who approves is an admin and
    // may read every one; who collects counts only the own; the `family` view
    // (wall tablet, grandparents) gets 0 for rewards. The tile shows no money
    // itself - neither balance nor entry.
    const countPending = (kindSql: string): number => (view === 'approver'
      ? (db.prepare(`SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending' AND ${kindSql}`).get() as { n: number }).n
      : view === 'self'
        ? (db.prepare(`SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending' AND user_id = ? AND ${kindSql}`).get(userId) as { n: number }).n
        : 0);
    const pending = countPending("kind = 'reward'");
    // THE OWN MONEY COUNTER DOES NOT HANG ON THE POINTS ENROLMENT. A child with a
    // pocket money account that collects no points falls into the `family` view
    // and got 0 here although its deposit was pending (review on #1745). Counted
    // through the same predicate as the money routes: admins all, a member the
    // own, a display none.
    const reader = options.moneyReader;
    const moneyPending = (db.prepare(`
      SELECT COUNT(*) AS n FROM reward_redemptions r
      WHERE r.status = 'pending' AND r.kind != 'reward' AND ${moneyVisibleSql(reader, 'r.user_id')}
    `).get(moneyParams(reader)) as { n: number }).n;
    // Who collects sees the latest credits - earned or given. Redemptions and
    // reversals are no "earned".
    //
    // AND NEITHER IS A CREDIT THAT WAS TAKEN BACK (#1607). Since reopening books a
    // counter entry instead of deleting, the earn row stays in the ledger. Here it
    // would otherwise stand as "recently earned" although the task is open again -
    // the full history with both rows belongs on the rewards page, this list shows
    // only what holds. The counter entry points at its credit (`reverses_id`) and
    // not only at the same task: when the task is deleted both rows lose their
    // task_id, and a comparison over it would never match again.
    const ownRecent = own && (view === 'self' || members.length === 1)
      ? db.prepare(`
          SELECT delta, type, reason, created_at FROM reward_ledger l
          WHERE user_id = ? AND delta > 0 AND type IN ('earn', 'bonus') AND l.unit = 'points'
            AND NOT EXISTS (SELECT 1 FROM reward_ledger r WHERE r.reverses_id = l.id)
          ORDER BY created_at DESC, id DESC
          LIMIT 3
        `).all(userId) as Row[]
      : [];
    const catalog = (activeCatalog(db) as Row[]).map((c) => ({ id: c.id, name: c.name, cost: c.cost, remaining: c.remaining }));
    return { rewards: { view, me: userId, standings, participantCount, pending, moneyPending, catalog, recent: ownRecent } };
  }, { rewards: { ...REWARDS_BLOCK_FAILED.rewards, standings: [], catalog: [], recent: [] } });
}
