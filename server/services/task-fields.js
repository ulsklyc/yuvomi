/**
 * Module: the value lists of the task input (#2810, group 11a)
 * Purpose: ONE source for what a task request may carry, read by the sides
 *          that must not drift apart: the task routes
 *          (server/routes/tasks.js), the rotation service
 *          (server/services/task-rotation.js), the MCP tools
 *          (server/mcp/tools.js), the settings values
 *          (server/settings/values.ts, the bound of `tasks_default_points`)
 *          and the OpenAPI document (server/openapi/paths/tasks.js,
 *          server/openapi/schemas.js), whose schemas validateRequest() checks
 *          before the handler runs. Up to #2810 the lists and limits stood
 *          inline in each of them, each its own copy.
 *
 *          The visibility levels stay defined in
 *          server/authorize/rows/assignees.ts (`VISIBILITY_VALUES`), which
 *          the rights read; they stand here again for the document, and
 *          test:validate-tasks holds both equal, as it holds the priorities
 *          and statuses equal to the CHECK constraints of `tasks` in
 *          server/db.js. The categories are not here: they are rows of
 *          `task_categories`, a list each household keeps itself.
 *          public/utils/task-fields.js (the labels of the page) is not read
 *          from here either: it imports the translations.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and the route file reaches
 *          the database.
 */

/** The priorities of a task, lowest first. */
export const TASK_PRIORITIES = /** @type {string[]} */ (Object.freeze(['none', 'low', 'medium', 'high', 'urgent']));

/** The states a task runs through; nothing else stands in its status column. */
export const TASK_REAL_STATUSES = /** @type {string[]} */ (Object.freeze(['open', 'in_progress', 'done']));

/**
 * `archived` was a fourth status up to v1.86.2 and has been a separate axis
 * since #688 (`tasks.archived_at`). As an input it stays: older clients, the
 * MCP bridge and the filter chip of the page still say it, and for them it
 * still means "file away" or "show the archive".
 */
export const ARCHIVE_STATUS = 'archived';

/** What a request may send as a status: the real states and `archived`. */
export const TASK_STATUSES = /** @type {string[]} */ (Object.freeze([...TASK_REAL_STATUSES, ARCHIVE_STATUS]));

/** Who sees a task: everyone, its assignees, or its creator. */
export const TASK_VISIBILITY = /** @type {string[]} */ (Object.freeze(['all', 'assignees', 'private']));

/** The rotation modes of a recurring series (#1763): a fixed order only. */
export const ROTATION_MODES = /** @type {string[]} */ (Object.freeze(['round_robin']));

/** The highest point value a task carries; more is cut to it, never refused. */
export const TASK_MAX_POINTS = 10000;

/** The most tasks one bulk request (tags, archive, order) names. */
export const MAX_BULK_TASKS = 500;

/** The most members a rotation pool holds. */
export const MAX_ROTATION_POOL = 10;
