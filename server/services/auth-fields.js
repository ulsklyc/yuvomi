/**
 * Module: the value lists and bounds of the sign-in and account input (#2810, group 12)
 * Purpose: ONE source for what a request to /api/v1/auth may carry, read by
 *          the sides that must not drift apart: the auth routes
 *          (server/auth.js) and the OpenAPI document
 *          (server/openapi/schemas.js, server/openapi/paths/auth.js), whose
 *          schemas validateRequest() checks before the handler runs. Up to
 *          #2810 the lists and bounds stood inline in each of them, the
 *          family roles six times in the document alone.
 *
 *          The family roles stand again in the CHECK constraint of
 *          `users.family_role` in server/db.js, the invitation presets in
 *          server/authorize/catalog.ts (`INVITE_PRESETS`, read by the
 *          rights); test:validate-auth holds both equal to this file.
 *
 *          The username format is not here: it stands as a regular
 *          expression literal at every place that checks it, in server/,
 *          public/ and tools/, and test:oidc holds every such literal equal
 *          (#653). A text copy here would be a copy that guard does not see.
 *
 *          This file imports nothing: server/openapi.js must load without
 *          node_modules (the packaging contract), and server/auth.js reaches
 *          the database.
 */

/** The family roles of an account; nothing else stands in `users.family_role`. */
export const FAMILY_ROLES = /** @type {string[]} */ (Object.freeze(['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other']));

/** The start rights an invitation may carry (#869). */
export const INVITE_PRESETS = /** @type {string[]} */ (Object.freeze(['restricted', 'role']));

/** The longest display name, in characters after trimming. */
export const DISPLAY_NAME_MAX = 128;

/** The longest username the sign-in takes (the format allows 64). */
export const LOGIN_USERNAME_MAX = 64;

/**
 * The longest password, at the sign-in and at every way that sets one
 * (setup, reset, invitation, own password, member accounts). Counted in
 * characters (code points), as the schema counts. The shortest stays the
 * handler's rule: it counts after Unicode normalization (NFC), which a
 * schema cannot.
 */
export const PASSWORD_MAX = 1024;

/** The longest second-factor code: a TOTP code or a recovery code. */
export const CODE_MAX = 64;

/** The longest published version `POST /changelog-seen` keeps. */
export const LATEST_MAX = 64;

/** The longest name of an API token, in characters after trimming. */
export const API_TOKEN_NAME_MAX = 100;

/** The longest name of a signed-in device, in characters after trimming. */
export const DEVICE_NAME_MAX = 100;

/** The platform of a signed-in device: a short lowercase name such as `ios`. */
export const DEVICE_PLATFORM_PATTERN = '^[a-z][a-z0-9-]{1,19}$';

/** The id a client chooses for its installation. */
export const DEVICE_ID_PATTERN = '^[A-Za-z0-9._-]{8,128}$';
