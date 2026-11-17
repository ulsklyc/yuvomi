/**
 * Module: meals - the meal block of GET /dashboard as one overview slice
 *         (phase 2, section D, contract E10)
 * Purpose: everything the overview answer carries from the meals module: today's
 *          meals, filtered by the household's visible meal types, with the image
 *          flags of a linked recipe and the cook (#1679).
 *
 * THE CONTRACT. mealsOverviewSlice(db, actor, ctx, options, guard) is synchronous
 * and reads no clock: "today" is `ctx.today`, the day of the household zone the
 * route reads once for every block. The meal plan belongs to the household and has
 * no row visibility; the route decides the module before it calls the slice. The
 * wall's narrowing of a meal row (display + audience=household, #1903) stays in the
 * route, where the request is.
 *
 * ONE FAILURE, AS BEFORE: the block used to have its own try/catch in the route;
 * `guard` (the route's runSlice()) carries that under the old name `todayMeals` and
 * with the old failure value (MEALS_BLOCK_FAILED). Without a guard a failure
 * throws.
 *
 * THE SQL IS THE ROUTE'S, WORD FOR WORD (the golden master test:overview-golden
 * holds the answers).
 *
 * Dependencies: server/authorize/index.ts (types only), services/meal-cook.js.
 * Erasable TS syntax only.
 */

import type { Database, RowReader } from '../authorize/index.ts';
import type { OverviewContext, SliceGuard } from './tasks-slices.ts';
import { MEAL_COOK_COLUMNS_SQL, MEAL_COOK_JOIN_SQL } from './meal-cook.js';

type MealRow = Record<string, unknown>;

export type MealsOverview = {
  todayMeals: MealRow[];
};

/** The empty form: a denied or switched-off meals module (DENIED_PAYLOAD in the route). */
export function emptyMealsOverview(): MealsOverview {
  return { todayMeals: [] };
}

/** What the block answers when its read fails. Kept as the route wrote it. */
export const MEALS_BLOCK_FAILED: Readonly<MealsOverview> = Object.freeze({
  todayMeals: [],
});

const passThrough: SliceGuard = (_name, read) => read();

const ALL_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * The meal block of the overview.
 *
 * @param db       the connection of the request
 * @param _actor   the row reader of the request (meals have no row rule)
 * @param ctx      today, zone and now of the request (no clock is read here)
 * @param _options no meal option exists yet; the slot keeps the contract's shape
 * @param guard    the route's runSlice(); without it a failing read throws
 */
export function mealsOverviewSlice(
  db: Database,
  _actor: RowReader,
  ctx: OverviewContext,
  _options: Readonly<Record<string, never>> = {},
  guard: SliceGuard = passThrough,
): MealsOverview {
  const { today } = ctx;

  // Today's meals, filtered by the household-wide meal type setting.
  const todayMeals = guard('todayMeals', () => {
    const prefRow = db.prepare('SELECT value FROM sync_config WHERE key = ?').get('visible_meal_types') as
      { value: string } | undefined;
    const visibleTypes = prefRow
      ? prefRow.value.split(',').filter((t) => ALL_MEAL_TYPES.includes(t))
      : ALL_MEAL_TYPES;
    const placeholders = visibleTypes.map(() => '?').join(', ');
    return db.prepare(`
      SELECT m.*,
             -- Wie im Planer (#1059): ob das verknuepfte Rezept ein Bild hat,
             -- entscheidet die Kachel ohne Nachfrage - eigenes zuerst, sonst das
             -- des Providers.
             r.provider_has_image AS recipe_has_image,
             -- Version des Providerbildes fuer ?v= (#2048, routes/recipes.js).
             r.provider_updated_at AS recipe_image_version,
             (r.image_data IS NOT NULL) AS recipe_has_own_image,
             -- Wer kocht (#1679): Name, Farbe und Bild neben der Mahlzeit, aus
             -- derselben Quelle wie im Planer.${MEAL_COOK_COLUMNS_SQL}
      FROM meals m
      LEFT JOIN recipes r ON r.id = m.recipe_id
      ${MEAL_COOK_JOIN_SQL}
      WHERE m.date = ?
        AND m.meal_type IN (${placeholders})
      ORDER BY
        CASE m.meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch'     THEN 1
          WHEN 'dinner'    THEN 2
          WHEN 'snack'     THEN 3
        END
    `).all(today, ...visibleTypes) as MealRow[];
  }, MEALS_BLOCK_FAILED.todayMeals);

  return { todayMeals };
}
