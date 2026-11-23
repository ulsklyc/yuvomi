/**
 * Module: the value lists of the calendar input (#2810, group 10)
 * Purpose: ONE source for what a calendar request may carry, read by the
 *          sides that must not drift apart: the calendar routes
 *          (server/routes/calendar/*.js and their helpers), the local
 *          calendars service and the OpenAPI document
 *          (server/openapi/paths/calendar.js, server/openapi/schemas.js),
 *          whose schemas validateRequest() checks before the handler runs.
 *          Up to #2810 the lists and limits stood inline in the routes, the
 *          service and the document, each its own copy.
 *
 *          The visibility levels stay defined in
 *          server/authorize/rows/assignees.ts (`VISIBILITY_VALUES`), which
 *          the rights read; they stand here again for the document, and
 *          test:validate-calendar holds both equal. The icon names of an
 *          event stay in server/routes/calendar/helpers.js: as an `enum` of
 *          the document they would be some 110 cases for every generated
 *          client, and the alias `drill` is the route's own.
 *
 *          The source and target lists of the provider routes
 *          (`EXTERNAL_CALENDAR_SOURCES`, `REMINDER_LIST_TARGETS`) join this
 *          file with group 10b, where their routes get their schemas.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route files reach
 *          the database.
 */

/** The `external_source` values `GET /calendar?source=` filters by; any other value is ignored. */
export const VALID_SOURCES = /** @type {string[]} */ (Object.freeze(['local', 'google', 'apple', 'ics']));

/** Who sees an event: everyone, its assignees, or its creator. */
export const EVENT_VISIBILITY = /** @type {string[]} */ (Object.freeze(['all', 'assignees', 'private']));

/** The longest name of a local calendar (trimmed); longer or empty answers `calendar_name_invalid`. */
export const CALENDAR_NAME_MAX = 80;

/** The most reminder lead times one occurrence carries. */
export const MAX_REMINDER_OFFSETS = 5;

/** The longest name of an ICS subscription; longer or empty answers `calendar_subscription_name_invalid`. */
export const ICS_SUBSCRIPTION_NAME_MAX = 100;
