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
// Row visibility (B3): one file per data type under rows/, one entry point for
// "visible to this viewer" (rows/index.ts). The single-type fragments behind it are
// not exported here.
export { filterVisible, visibleWhere } from './rows/index.ts';
export { normalizeVisibility, VISIBILITY_VALUES } from './rows/assignees.ts';
export { categoryVisibleTo } from './rows/notes.ts';
export { icsSubscriptionSharedWhere } from './rows/ics-subscriptions.ts';
export {
  asksHouseholdAudience,
  HOUSEHOLD_AUDIENCE_SHOWS,
  householdAudienceAnswer,
  householdAudienceShows,
  householdVisibleWhere,
} from './rows/household.ts';
export {
  applyDocumentAccess,
  ATTACHMENT_NARROW_ONLY,
  attachmentAccessMode,
  canManageDocument,
  documentClonePredicate,
  documentWidenPredicate,
  eventAudienceChanged,
} from './rows/documents.ts';
export {
  BUDGET_MASKED_CATEGORY,
  BUDGET_OBJECT_VISIBILITY_VALUES,
  BUDGET_VISIBILITY_VALUES,
  budgetDetailsHiddenWhere,
  budgetDetailsVisibleWhere,
  budgetScopeWhere,
  canEditEntry,
  hidesBudgetDetails,
  maskBudgetEntry,
  normalizeBudgetVisibility,
  normalizeObjectVisibility,
  resolveBudgetMode,
} from './rows/budget.ts';
export {
  HOUSEHOLD_CHANNEL_POLICY,
  reminderTargetPublicSql,
  reminderTargetVisible,
  TARGET_ENTITY_TYPES,
} from './rows/reminders.ts';
// Care grants and health rows (B4): the one place for "may read / may write whose
// health data" (health_care_grants, #584).
export {
  canWriteFor,
  careAwareClause,
  caredForIds,
  caregiversOf,
  fastingVisibleFilter,
  hasCareGrant,
  OPEN_ALL,
  OPEN_FAMILY,
  readableClause,
  visibilityClause,
  writableChild,
  writableClause,
} from './care.ts';
