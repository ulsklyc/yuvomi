/**
 * Module: the date-time and day-key shapes the API accepts as input (#2810)
 * Purpose: ONE source for the text a date-time input field may have, read by
 *          two sides that must never drift apart:
 *            - the hand check `datetime()` in server/middleware/validate.js
 *              (as `DATETIME_RE`), which every route with a time input runs;
 *            - the OpenAPI document, where it is the `pattern` of the
 *              reminder times (`remind_at`, `remind_ats[]`, `from`, `to`),
 *              checked by validateRequest() before the handler.
 *          Accepted: a date alone, or a date with `T`, hours and minutes,
 *          optional seconds with an optional fraction, and an optional `Z` or
 *          numeric offset (`+02:00`, `+0200`). Not the RFC 3339 `date-time`
 *          of Ajv: that one needs seconds and a zone, and takes a lowercase
 *          `t`, a space or `+02`, which the handlers refuse.
 *
 *          A string, not a RegExp: the document carries it as text. This file
 *          imports nothing, because server/openapi.js has to load without
 *          node_modules (the packaging contract), and the pattern must stay
 *          linear for the ReDoS guard of test:openapi-ajv.
 */

export const DATETIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$';

/**
 * The day key `YYYY-MM-DD` as text, the shape only: whether the day exists is
 * the handler's (calendar). Read by `DATE_RE` in server/middleware/validate.js,
 * by the `today` check of server/routes/kitchen.js and, as
 * OPTIONAL_DATE_PATTERN, by the `today` parameter of `GET /kitchen/summary`.
 */
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** A day key or the empty text: `today=` is "no day given", as before #2810. */
export const OPTIONAL_DATE_PATTERN = `^(?:${DATE_PATTERN.slice(1, -1)})?$`;

/**
 * DATETIME_PATTERN or the empty text: `datetime()` reads `""` as "no value"
 * (`last_completed` of a housekeeping task, where it clears the date).
 */
export const OPTIONAL_DATETIME_PATTERN = `^(?:${DATETIME_PATTERN.slice(1, -1)})?$`;

/**
 * A wall-clock time `HH:MM` (00:00 to 23:59), read by `time()` in
 * server/middleware/validate.js and by the time fields of the OpenAPI
 * document (waste reminder `delivery_time`, shift `start_time`/`end_time`).
 */
export const TIME_PATTERN = '^(?:[01]\\d|2[0-3]):[0-5]\\d$';

/**
 * A HEX color `#RRGGBB`, read by `color()` in server/middleware/validate.js
 * and by the color fields of the OpenAPI document (#2810).
 */
export const COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';
