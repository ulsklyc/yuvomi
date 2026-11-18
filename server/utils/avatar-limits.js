/**
 * Module: the size limit of a profile picture sent as a data URL (#2810)
 * Purpose: ONE source for normalizeAvatarData() in server/auth.js, which
 *          refuses a longer `avatar_data`, and for the OpenAPI document, whose
 *          `maxLength` validateRequest() checks before the handler. Both count
 *          the text as sent. This file imports nothing: server/openapi.js has
 *          to load without node_modules.
 */

/** Characters of an `avatar_data` data URL (768 KiB). */
export const MAX_AVATAR_DATA_LENGTH = 768 * 1024;
