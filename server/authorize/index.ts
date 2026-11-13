/**
 * Module: authorize (phase 2, section B)
 * Purpose: The interface of server/authorize/. Other modules import from this file
 *          only, never from the files behind it.
 */

export { actorForUser, actorFromRequest, householdAudience, resolveRequestModuleAccess } from './actor.ts';
export type { Actor } from './types.ts';
export type { Database } from './catalog.ts';
export {
  applyChildStartPermissions,
  CHILD_START_PERMISSIONS,
  CHILD_START_PREFERENCES,
  getSubjectPermissions,
  INVITE_PRESET_DEFAULT,
  INVITE_RESTRICTED_MODULES,
  invitePresetPermissions,
  isValidFamilyRole,
  isValidInvitePreset,
  normalizePermissionInput,
  PERMISSION_CAPABILITIES,
  PERMISSION_MODULES,
  PERMISSION_WIDGETS,
  permissionCatalog,
  replaceSubjectPermissions,
  resolvePermissions,
  setExtensionPermissionCatalog,
  writeSubjectPermissions,
} from './catalog.ts';
export {
  authorize,
  buildSessionModuleAccess,
  clientPermissions,
  deniedModules,
  hiddenModulesFor,
  mayChangeRecord,
  mayReadModule,
  mayWriteModule,
  MODULE_ACCESS_ALLOW,
  MODULE_ACCESS_DENIED,
  MODULE_ACCESS_READ_ONLY,
  moduleAccessVerdict,
  requestHasCapability,
  sendNotOwner,
  userForRequest,
  userHasCapability,
} from './modules.ts';
