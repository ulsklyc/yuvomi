/**
 * Module: birthdays - the birthday block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries as the birthday tile: the next
 *          occasions (birthday and name day, one row each), the person count, the
 *          occasion count and the uncapped "within three days" count of the nav
 *          badge.
 *
 * THE CONTRACT. birthdaysOverviewSlice(db, actor, ctx, options, guard) is
 * synchronous and reads no clock: the days until an occasion are counted from
 * `ctx.now` in the household zone (hydrateBirthdayOccurrences), the same single
 * reading the route takes for every block. Birthdays have no row visibility.
 *
 * WHETHER THE TILE IS READ AT ALL stays in the route: birthdays belong to the
 * calendar as a RIGHT and are a module of their own as a SWITCH
 * (`birthdaysLeftOut` = calendar denied OR the household switch `birthdays` off).
 * The route writes the empty form at that early point of the answer, and the
 * position of the keys in the answer depends on it; the slice only runs when the
 * tile is read.
 *
 * ONE FAILURE, AS BEFORE: the block used to have one try/catch in the route;
 * `guard` (the route's runSlice()) carries that under the old name `birthdays`
 * and with the old failure value (BIRTHDAYS_BLOCK_FAILED). Without a guard a
 * failure throws.
 *
 * KEY ORDER. A read answers its keys in the order the route used to write them
 * on success (`birthdaySoonCount` first); the failure value and the empty form in
 * the order of the old emptyBirthdays(). Both orders reach the answer unchanged
 * (the golden master test:overview-golden holds it).
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD.
 *
 * Dependencies: server/authorize/index.ts (types only), services/birthdays.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { hydrateBirthdayOccurrences } from './birthdays.js';

type BirthdayRow = Record<string, unknown> & { name: string };
type Occurrence = BirthdayRow & { kind: string; days_until: number };

export type BirthdaysOverview = {
  birthdays: Occurrence[];
  birthdayCount: number;
  birthdayTotal: number;
  birthdaySoonCount: number;
};

/**
 * The empty form of the birthday tile: a denied calendar or the household switch
 * `birthdays` off (#1660). The key order is the one of the route's old
 * emptyBirthdays().
 */
export function emptyBirthdaysOverview(): BirthdaysOverview {
  return { birthdays: [], birthdayCount: 0, birthdayTotal: 0, birthdaySoonCount: 0 };
}

/** What the block answers when its read fails. Kept as the route wrote it. */
export const BIRTHDAYS_BLOCK_FAILED: Readonly<BirthdaysOverview> = Object.freeze({
  birthdays: [],
  birthdayCount: 0,
  birthdayTotal: 0,
  birthdaySoonCount: 0,
});

const passThrough: SliceGuard = (_name, read) => read();

/**
 * The birthday block of the overview.
 *
 * @param db       the connection of the request
 * @param _actor   the row reader of the request (birthdays have no row rule)
 * @param ctx      today, zone and now of the request (no clock is read here)
 * @param _options no birthday option exists (`events_birthdays` acts on the event
 *                 readers, not on this tile); the slot keeps the contract's shape
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function birthdaysOverviewSlice(
  db: Database,
  _actor: RowReader,
  ctx: OverviewContext,
  _options: Readonly<Record<string, never>> = {},
  guard: SliceGuard = passThrough,
): BirthdaysOverview {
  const { now } = ctx;
  return guard('birthdays', (): BirthdaysOverview => {
    // family_user_color: the identity colour of the linked member. The widget
    // shows family birthdays in the same colour language as the family tile;
    // contacts without a link stay NULL and keep the neutral module tint in the
    // frontend (stage 4, critique 2026-08-17).
    const rows = db.prepare(`
      SELECT b.*, u.avatar_color AS family_user_color
        FROM birthdays b
        LEFT JOIN users u ON u.id = b.family_user_id
       -- A unique last key: the stable sort below inherits it for equal names.
       ORDER BY b.name COLLATE NOCASE ASC, b.id ASC
    `).all() as BirthdayRow[];
    const hydrated = rows
      .flatMap((row) => hydrateBirthdayOccurrences(db, row, now) as Occurrence[])
      .sort((a, b) => a.days_until - b.days_until
        || a.name.localeCompare(b.name)
        || a.kind.localeCompare(b.kind));

    /* THE NUMBER FOR THE NAV BADGE, UNCAPPED (#868).
     *
     * It must NOT be derived from `birthdays`: the list is cut right away, and
     * that is the stock of the TILE, not a statement about the whole. A household
     * with seven birthdays in three days would otherwise get a five at the nav
     * target on start and a seven after the first visit of the page - one
     * question, two answers.
     *
     * The cut at THREE days is the same as in the browser
     * (`BIRTHDAY_BADGE_DAYS` in public/utils/nav-badges.js); a guard in
     * test:frontend-audit holds both together. */
    const birthdaySoonCount = hydrated.filter((b) => (b.days_until ?? 9999) <= 3).length;

    const birthdays = hydrated
      // EIGHT, BECAUSE THE TILE MAY BE TALL. The cut stood at three and was the
      // ceiling for EVERY tile size: in the 1x2 default a third of the card stayed
      // empty because the server gave no more. How many rows really show is the
      // tile's decision (`listRowCap` in public/pages/dashboard.js) - the server
      // only delivers the stock for the largest form. EIGHT since U14: a tall
      // tile that stretches the packing shows more rows in the gained space
      // (measured 1440px to 93px, almost two rows). The list is sorted in memory
      // already, three more entries cost nothing; the today sheet reads only
      // what is today.
      .slice(0, 8);
    // The list counts OCCASIONS (birthday and name day one row each),
    // `birthdayCount` the people. Badge and the tile's "+N more" need the set the
    // list is cut from - otherwise the rest is right only while nobody has a name
    // day.
    return {
      birthdaySoonCount,
      birthdays,
      birthdayCount: rows.length,
      birthdayTotal: hydrated.length,
    };
  }, { ...BIRTHDAYS_BLOCK_FAILED, birthdays: [] });
}
