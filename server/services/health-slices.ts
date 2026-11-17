/**
 * Module: health - the health blocks of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the health module: the
 *          doses of the viewer's own medications due today with the refill hint
 *          (`health`), the fasting state (`fasting`) and today's nutrition balance
 *          (`nutrition`).
 *
 * THE CONTRACT. healthOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock: the due day of a dose and the nutrition day are `ctx.today`
 * (the household day the route reads once for every block), the weekday of the
 * dose mask is derived from that key.
 *
 * WHO SEES WHAT IS UNCHANGED, AND IT STAYS WHERE IT WAS:
 * - whether the module is read at all (rights, token scopes, the household switch,
 *   the wall audience) is the route's `allows('health')`; the slice only runs
 *   when the module is open.
 * - medications: strictly the viewer's OWN active medications (`user_id = ?`
 *   bound to the reader's id), no family visibility and no care grant (#592) -
 *   shared medications stay on the health page.
 * - fasting: getFastingDashboardState() checks the subject itself; its 403
 *   (FastingError) is the empty fasting form WITHOUT a log line, as before.
 * - nutrition: nutritionSummaryFor() with the viewer as viewer AND owner; the
 *   care-aware row clause and the target rule live in that service.
 *
 * THREE FAILURES, AS BEFORE: the three reads used to have one try/catch each in
 * the route; `guard` (the route's runSlice()) carries each under its old name
 * (`health`, `fasting`, `nutrition`) with its old failure value. Without a guard a
 * failure throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD. The golden master (test:overview-golden)
 * holds the answers.
 *
 * Dependencies: server/authorize/index.ts (types only), services/fasting.js,
 * services/health-nutrition.js. Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import { careAwareClause } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import type { IndexSearchQuery, SearchActor, SearchRow } from './search-text.ts';
import { SEARCH_LIMIT, withExcerpt } from './search-text.ts';
import { FastingError, getFastingDashboardState } from './fasting.js';
import { NUTRIENT_KEYS, nutritionSummaryFor } from './health-nutrition.js';

type HealthTile = {
  hasMeds: boolean;
  dosesTotal: number;
  dosesTaken: number;
  dosesSkipped: number;
  nextDose: { name: unknown; time: string } | null;
  lowStockCount: number;
};

type FastingWidget = {
  settings: { clock_mode: string; zone_mode: string };
  active: unknown;
  lastCompleted: unknown;
};

type NutritionWidget = {
  date: string | null;
  target: unknown;
  totals: Record<string, number>;
  entryCount: number;
};

export type HealthOverview = {
  health: HealthTile;
  fasting: FastingWidget | null;
  nutrition: NutritionWidget;
};

/** Query options of the overview that act on the health blocks (none today). */
export type HealthOverviewOptions = Readonly<Record<string, never>>;

/** The empty fasting state: also what a 403 from the fasting service answers. */
export function emptyFastingWidget(): FastingWidget {
  return {
    settings: { clock_mode: 'auto', zone_mode: 'timer' },
    active: null,
    lastCompleted: null,
  };
}

/**
 * The empty nutrition balance: no target, nothing eaten.
 *
 * `target: null` is the right empty form here and not a target of zeros - "no
 * target set" and "target 0" are two different statements (#1326), and the tile
 * says "no target" for the first instead of "0 of 0".
 */
export function emptyNutritionWidget(): NutritionWidget {
  const totals: Record<string, number> = {};
  for (const key of NUTRIENT_KEYS as readonly string[]) totals[key] = 0;
  return { date: null, target: null, totals, entryCount: 0 };
}

/** What the medication block answers when its read fails (and its empty form). */
export function healthBlockFailed(): HealthTile {
  return { hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0, nextDose: null, lowStockCount: 0 };
}

/**
 * The empty form: a denied or switched-off health module (DENIED_PAYLOAD in the
 * route). The key order is the route's old one.
 */
export function emptyHealthOverview(): HealthOverview {
  return {
    health: {
      hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0,
      nextDose: null, lowStockCount: 0,
    },
    fasting: emptyFastingWidget(),
    nutrition: emptyNutritionWidget(),
  };
}

const passThrough: SliceGuard = (_name, read) => read();

type MedRow = { id: number; name: unknown; stock_qty: unknown; refill_threshold: unknown };
type ScheduleRow = { time_of_day: string | null; days_mask: unknown; start_date: string | null; end_date: string | null };
type LogRow = { status: string } | undefined;

/**
 * The health blocks of the overview.
 *
 * @param db       the connection of the request
 * @param actor    the row reader of the request (its `userId` is the viewer)
 * @param ctx      today, zone and now of the request
 * @param _options none today
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function healthOverviewSlice(
  db: Database,
  actor: RowReader,
  ctx: OverviewContext,
  _options: HealthOverviewOptions = {},
  guard: SliceGuard = passThrough,
): HealthOverview {
  const userId = actor.userId;
  const todayLocalKey = ctx.today;
  // The weekday from the key, not from a clock: Monday = 0 ... Sunday = 6, the
  // convention of public/utils/health-meds.js. A Date WITH an argument reads no
  // clock, and getDay() would read the container's zone instead of the household's.
  const localWeekdayIdx = (new Date(`${todayLocalKey}T00:00:00Z`).getUTCDay() + 6) % 7;

  // Due doses of the OWN medications (private and family-visible alike) plus the
  // refill hint. The overview is strictly personal: foreign medications never
  // appear, not even with visibility='family' (#592). Due-ness is computed inline
  // (days_mask, period, log status) because public/utils/health-meds.js imports
  // browser paths and cannot load on the server.
  const health = guard('health', (): HealthTile => {
    const meds = db.prepare(`
      SELECT id, name, stock_qty, refill_threshold
      FROM medications
      WHERE active = 1 AND user_id = ?
      `).all(userId) as MedRow[];
    const scheduleStmt = db.prepare(`
      SELECT time_of_day, days_mask, start_date, end_date
      FROM medication_schedules
      WHERE medication_id = ? AND active = 1
      `);
    const logStmt = db.prepare(`
      SELECT status FROM medication_logs
      WHERE medication_id = ? AND substr(scheduled_at, 1, 10) = ? AND substr(scheduled_at, 12, 5) = ?
      ORDER BY id DESC LIMIT 1
      `);
    let dosesTotal = 0;
    let dosesTaken = 0;
    let dosesSkipped = 0;
    let lowStockCount = 0;
    let nextDose: HealthTile['nextDose'] = null;
    for (const med of meds) {
      if (med.stock_qty != null && Number.isFinite(Number(med.stock_qty))) {
        const stock = Number(med.stock_qty);
        const thr = med.refill_threshold != null && Number.isFinite(Number(med.refill_threshold))
          ? Number(med.refill_threshold)
          : null;
        if (stock <= 0 || (thr != null && stock <= thr)) lowStockCount += 1;
      }
      for (const s of scheduleStmt.all(med.id) as ScheduleRow[]) {
        if (s.start_date && todayLocalKey < s.start_date) continue;
        if (s.end_date && todayLocalKey > s.end_date) continue;
        const mask = s.days_mask;
        const matches = mask === null || mask === undefined
          ? true
          : (Number(mask) & (1 << localWeekdayIdx)) !== 0;
        if (!matches) continue;
        dosesTotal += 1;
        const time = s.time_of_day || '00:00';
        const logRow = logStmt.get(med.id, todayLocalKey, time) as LogRow;
        if (logRow?.status === 'taken') dosesTaken += 1;
        else if (logRow?.status === 'skipped') dosesSkipped += 1;
        else if (!nextDose || time < nextDose.time) nextDose = { name: med.name, time };
      }
    }
    return {
      hasMeds: meds.length > 0,
      dosesTotal,
      dosesTaken,
      dosesSkipped,
      nextDose,
      lowStockCount,
    };
  }, healthBlockFailed());

  // A 403 of the fasting service is the empty form and no failure (no log line);
  // every other throw is the old failure value `null`.
  const fasting = guard('fasting', (): FastingWidget | null => {
    try {
      return getFastingDashboardState(db, { id: userId }) as FastingWidget;
    } catch (err) {
      if (err instanceof FastingError && (err as FastingError & { status?: number }).status === 403) return emptyFastingWidget();
      throw err;
    }
  }, null);

  // The day is ctx.today, the HOUSEHOLD day of every block of this answer. A
  // toISOString().slice(0, 10) would stand on the next day in the evening west of
  // UTC and show an empty balance next to a full diary.
  const nutrition = guard('nutrition', (): NutritionWidget => (
    nutritionSummaryFor(db, userId as number, userId as number, todayLocalKey) as NutritionWidget
  ), emptyNutritionWidget());

  return { health, fasting, nutrition };
}

/*
 * THE HEALTH HITS OF THE GLOBAL SEARCH (services/search.js runSearch, buckets
 * `meds` and `activities`). Two functions, not one: the orchestration checks each
 * bucket on its own (`allows('meds')`, `allows('activities')`) and writes each to
 * its own key, so one slice per bucket keeps that one to one. The SQL is the
 * search's, word for word.
 *
 * Health: the row rule of the health lists (GET /health/medications,
 * GET /health/activities) - the viewer's own rows, `family` rows, and every
 * row of a person whose care was granted to the viewer (#584). The clause
 * binds positionally, so these two queries do as a whole: match, the
 * clause's parameters, limit - in the order of the placeholders.
 */

/** Medications: hits on name and dosage text. */
export function healthMedsSearchSlice(db: Database, actor: SearchActor, query: IndexSearchQuery): SearchRow[] {
  const { match } = query;
  const userId = actor.userId;
  const limit = SEARCH_LIMIT;
  const visible = careAwareClause('m', userId, null);
  return db.prepare(`
      SELECT m.id, m.name AS title, m.dosage_text, m.active
      FROM search_index s
      JOIN medications m ON m.id = s.entity_id
      WHERE s.entity = 'medication' AND s.search_index MATCH ?
        AND ${visible.sql}
      ORDER BY m.active DESC, m.name ASC
      LIMIT ?
    `).all(match, ...visible.params, limit) as SearchRow[];
}

/** Activities: hits on type and note, the same row rule. */
export function healthActivitiesSearchSlice(db: Database, actor: SearchActor, query: IndexSearchQuery): SearchRow[] {
  const { text: q, match } = query;
  const userId = actor.userId;
  const limit = SEARCH_LIMIT;
  const visible = careAwareClause('a', userId, null);
  return (db.prepare(`
      SELECT a.id, a.type AS title, a.note, a.performed_at
      FROM search_index s
      JOIN health_activities a ON a.id = s.entity_id
      WHERE s.entity = 'activity' AND s.search_index MATCH ?
        AND ${visible.sql}
      ORDER BY a.performed_at DESC
      LIMIT ?
    `).all(match, ...visible.params, limit) as SearchRow[]).map((row) => withExcerpt(row, q, [row.note]));
}
