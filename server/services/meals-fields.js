/**
 * Module: the value lists of the meal-plan input (#2810)
 * Purpose: ONE source for what a meal-plan request may carry, read by two
 *          sides that must not drift apart: the route handlers in
 *          server/routes/meals.js and the OpenAPI document
 *          (server/openapi/paths/meals.js), whose schemas validateRequest()
 *          checks before the handler runs. Up to #2810 the meal types stood
 *          as a literal in the route and three more times in the document,
 *          and an unknown `scope` fell back silently to "this meal only".
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route file reaches
 *          the database.
 */

/** The meal types of a slot in the plan (the CHECK of `meals.meal_type`). */
export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * `?scope=` of PUT /meals/{id}: `single` (this meal; also without the
 * parameter) or `series` (the weekly series and all its meals).
 */
export const MEAL_UPDATE_SCOPES = Object.freeze(['single', 'series']);

/**
 * `?scope=` of DELETE /meals/{id}: `single` (this meal; also without the
 * parameter), `future` (end the series before this meal) or `series` (the
 * whole series). The page asks exactly these three (mealDeleteScopeQuestion in
 * public/pages/meals.js).
 */
export const MEAL_DELETE_SCOPES = Object.freeze(['single', 'future', 'series']);
