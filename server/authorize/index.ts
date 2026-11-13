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
// Row visibility (B3): one file per data type under rows/.
export { normalizeVisibility, visibilityWhere, VISIBILITY_VALUES } from './rows/assignees.ts';
export { categoryVisibleTo, categoryVisibleWhere, noteVisibleWhere } from './rows/notes.ts';
export { icsSubscriptionSharedWhere, icsSubscriptionVisibleWhere } from './rows/ics-subscriptions.ts';
export {
  asksHouseholdAudience,
  HOUSEHOLD_AUDIENCE_SHOWS,
  householdAudienceAnswer,
  householdAudienceShows,
  householdVisibleWhere,
} from './rows/household.ts';
export { CARED_FOR_SUBQUERY, careAwareClause, OPEN_FAMILY } from './rows/health.ts';
export {
  applyDocumentAccess,
  ATTACHMENT_NARROW_ONLY,
  attachmentAccessMode,
  canManageDocument,
  documentClonePredicate,
  documentVisibleSql,
  documentWidenPredicate,
  eventAudienceChanged,
  filterVisibleDocumentIds,
} from './rows/documents.ts';
export {
  BUDGET_MASKED_CATEGORY,
  BUDGET_OBJECT_VISIBILITY_VALUES,
  BUDGET_VISIBILITY_VALUES,
  budgetDetailsHiddenWhere,
  budgetDetailsVisibleWhere,
  budgetScopeWhere,
  budgetVisibilityWhere,
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
  reminderTargetVisibleSql,
  TARGET_ENTITY_TYPES,
} from './rows/reminders.ts';
