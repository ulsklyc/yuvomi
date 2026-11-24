/**
 * Module: the value lists of the budget and subscriptions input (#2810, group 9)
 * Purpose: ONE source for what a budget or subscription request may carry,
 *          read by the sides that must not drift apart: the budget routes
 *          (server/routes/budget/*.js through their helpers), the subscriptions
 *          route and service, and the OpenAPI document
 *          (server/openapi/paths/budget.js), whose schemas validateRequest()
 *          checks before the handler runs. Up to #2810 the lists stood in the
 *          routes, some inline twice, and an unknown value fell back silently
 *          (`interest_mode: "bad"` became a loan without interest,
 *          `visibility: "bad"` the default).
 *
 *          The visibility levels stay defined in server/authorize/rows/budget.ts,
 *          which the rights read; they stand here again for the document, and
 *          test:validate-budget holds both equal. Category and subcategory keys
 *          live in the database, currency codes in public/utils/currency-codes.js.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route files reach
 *          the database.
 */

/** The kinds of a budget account. */
export const ACCOUNT_TYPE_KEYS = /** @type {string[]} */ (Object.freeze(['checking', 'savings', 'cash', 'credit', 'investment', 'other']));

/** The two kinds of a budget category. */
export const CATEGORY_TYPES = /** @type {string[]} */ (Object.freeze(['expense', 'income']));

/** The rhythm of a recurring entry or transfer (a count of them: `recurrence_interval_count`). */
export const RECURRENCE_INTERVAL_KEYS = /** @type {string[]} */ (Object.freeze(['weekly', 'monthly', 'yearly']));

/** Who owes whom on a loan. */
export const LOAN_DIRECTIONS = /** @type {string[]} */ (Object.freeze(['lent', 'borrowed']));

/** How a loan bears interest; `none` is a loan of fixed installments. */
export const INTEREST_MODES = /** @type {string[]} */ (Object.freeze(['none', 'fixed', 'variable', 'fixed_then_variable']));

/** The view of the personal budget mode: own entries or the shared pot. */
export const BUDGET_SCOPES = /** @type {string[]} */ (Object.freeze(['mine', 'household']));

/** The periods of the statistics. */
export const STATS_RANGES = /** @type {string[]} */ (Object.freeze(['week', 'month', 'year']));

/** Who sees a budget entry (server/authorize/rows/budget.ts BUDGET_VISIBILITY_VALUES). */
export const ENTRY_VISIBILITIES = /** @type {string[]} */ (Object.freeze(['private', 'shared', 'shared_amount']));

/** Who sees a loan or a subscription (BUDGET_OBJECT_VISIBILITY_VALUES there). */
export const OBJECT_VISIBILITIES = /** @type {string[]} */ (Object.freeze(['private', 'shared']));

/** The billing cycles of a subscription. */
export const BILLING_CYCLES = /** @type {string[]} */ (Object.freeze(['daily', 'weekly', 'monthly', 'yearly']));

/** How a subscription ends. */
export const END_TYPES = /** @type {string[]} */ (Object.freeze(['never', 'on_date', 'after_count']));

/** The status filter of the subscription list. */
export const SUBSCRIPTION_STATUSES = /** @type {string[]} */ (Object.freeze(['active', 'paused', 'completed']));
