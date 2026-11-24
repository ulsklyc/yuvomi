/**
 * The most entries an array in a request body may carry (Refs #2810).
 *
 * The body limit (`BODY_LIMIT`) caps bytes, not the work per entry: a list of
 * short ids fits by the tens of thousands into one megabyte, and each of them
 * costs a loop turn, a query or a write. OWASP API4:2023 ("Unrestricted
 * Resource Consumption") names a missing maximum number of array elements as
 * the weakness. So every array in a request body carries `maxItems`, and
 * `test:openapi-structure` refuses one without it.
 *
 * A limit comes from use, not from one flat number: what the own client sends
 * at most and how many rows the set it refers to can realistically hold,
 * generous but finite. A list that reorders a set must take the whole set.
 * Where a route already has its own, lower cap with its own reason and
 * `params.limit` (contacts 20 per kind, reminders 5 distinct instants, cycle
 * symptoms 40 distinct keys, task tags 32 distinct names), that cap stays in
 * the route - its refusal names the number for the form - and the schema
 * bound here is the outer one: those routes dedupe or normalise first, which
 * the schema cannot see.
 *
 * This file is plain data and imports nothing: `server/openapi.js` must load
 * without `node_modules`.
 */

/** Members of one household or one split-expense group: assignees, caregivers, participants, allowed readers. */
export const MAX_MEMBER_IDS = 100;

/** A reorder of a category-like set (categories, locations, calendars, budget meta rows); it names the whole set. */
export const MAX_ORDER_ROWS = 500;

/**
 * Shopping item ids in one request: the reorder of one category, the clean-up
 * of checked items and the hand-overs between shopping list and pantry. 1000
 * ids of the largest JSON-safe integer are about 17 KB, so the clean-up stays
 * well below the 64 KiB a browser allows for `fetch(..., { keepalive: true })`
 * bodies in flight; the shopping page splits a larger clean-up into batches.
 */
export const MAX_SHOPPING_ITEMS = 1000;

/** Ingredients of one recipe or meal, and the ingredient ids of one recipe. */
export const MAX_INGREDIENTS = 200;

/** Planned meals applied at once (a week of every meal type, with room for custom types). */
export const MAX_MEAL_ASSIGNMENTS = 500;

/** Documents attached to one entry. */
export const MAX_ATTACHMENTS = 100;

/** Keys from a small fixed set (weekdays, feelings, meal types, secret field names); doubles are tolerated. */
export const MAX_KEYS = 50;

/** Scopes of one API token: `<module>:read|write` for core and extension modules. */
export const MAX_TOKEN_SCOPES = 100;

/** Raw entries of a list the route dedupes and caps itself (task tags, cycle symptoms, contact entries, reminder instants). */
export const MAX_RAW_ENTRIES = 100;

/** Contact entries per kind (phones, emails, addresses); the route's own cap of 20 answers first. */
export const MAX_CONTACT_ENTRIES = 50;

/** Reminder instants of one entity; the route's own cap of 5 distinct instants answers first. */
export const MAX_REMINDER_INSTANTS = 50;

/** Results of one lab report. */
export const MAX_LAB_RESULTS = 200;

/** Custom fields of one shift type. */
export const MAX_SHIFT_FIELDS = 100;

/** Waste types named in one mapping or feed selection. */
export const MAX_WASTE_TYPES = 100;

/** Label mappings of one waste import or profile (`MAX_DISTINCT_LABELS` in server/services/waste-import.js). */
export const MAX_WASTE_MAPPINGS = 200;

/** Acknowledged event keys of one waste import (`MAX_CANDIDATE_INSTANCES` in server/services/waste-import.js). */
export const MAX_WASTE_EVENT_KEYS = 5000;

/** Moves of one default-assignee backfill: one preview page (`movedCandidatesLimit.max` in server/services/sync-assignment.js). */
export const MAX_BACKFILL_MOVES = 5000;

/** Quick links in one reorder; the route caps creation at 24, older installs may hold more. */
export const MAX_QUICK_LINK_ORDER = 100;
