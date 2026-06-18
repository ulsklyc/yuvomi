export const SETTINGS_STORAGE_KEY = 'oikos:settings:path';
export const LEGACY_SETTINGS_STORAGE_KEY = 'oikos:settings:tab';

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const SETTINGS_DOMAINS = freezeEntries([
  { id: 'personal', labelKey: 'settings.domainPersonal', icon: 'user', adminOnly: false },
  { id: 'modules', labelKey: 'settings.domainModules', icon: 'layout-grid', adminOnly: true },
  { id: 'sync', labelKey: 'settings.domainSync', icon: 'refresh-cw', adminOnly: true },
  { id: 'documents', labelKey: 'settings.domainDocuments', icon: 'files', adminOnly: true },
  { id: 'admin', labelKey: 'settings.domainAdministration', icon: 'shield', adminOnly: true },
]);

export const SETTINGS_LEAVES = freezeEntries([
  {
    id: 'personal-account',
    domainId: 'personal',
    path: '/settings/personal/account',
    labelKey: 'settings.pageAccount',
    descriptionKey: 'settings.pageAccountDescription',
    icon: 'circle-user',
    adminOnly: false,
    loader: () => import('/settings/pages/personal-account.js'),
  },
  {
    id: 'personal-appearance',
    domainId: 'personal',
    path: '/settings/personal/appearance',
    labelKey: 'settings.pageAppearance',
    descriptionKey: 'settings.pageAppearanceDescription',
    icon: 'palette',
    adminOnly: false,
    loader: () => import('/settings/pages/personal-appearance.js'),
  },
  {
    id: 'personal-device',
    domainId: 'personal',
    path: '/settings/personal/device',
    labelKey: 'settings.pageDevice',
    descriptionKey: 'settings.pageDeviceDescription',
    icon: 'smartphone',
    adminOnly: false,
    loader: () => import('/settings/pages/personal-device.js'),
  },
  {
    id: 'personal-notifications',
    domainId: 'personal',
    path: '/settings/personal/notifications',
    labelKey: 'settings.pageNotifications',
    descriptionKey: 'settings.pageNotificationsDescription',
    icon: 'bell',
    adminOnly: false,
    loader: () => import('/settings/pages/notifications.js'),
  },
  {
    id: 'modules-navigation',
    domainId: 'modules',
    path: '/settings/modules/navigation',
    labelKey: 'settings.pageNavigation',
    descriptionKey: 'settings.pageNavigationDescription',
    icon: 'panel-left',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-navigation.js'),
  },
  {
    id: 'modules-kitchen',
    domainId: 'modules',
    path: '/settings/modules/kitchen',
    labelKey: 'settings.pageKitchen',
    descriptionKey: 'settings.pageKitchenDescription',
    icon: 'utensils',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-kitchen.js'),
  },
  {
    id: 'modules-calendar',
    domainId: 'modules',
    path: '/settings/modules/calendar',
    labelKey: 'settings.pageCalendarModule',
    descriptionKey: 'settings.pageCalendarModuleDescription',
    icon: 'calendar-days',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-calendar.js'),
  },
  {
    id: 'modules-budget',
    domainId: 'modules',
    path: '/settings/modules/budget',
    labelKey: 'settings.pageBudgetModule',
    descriptionKey: 'settings.pageBudgetModuleDescription',
    icon: 'wallet',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-budget.js'),
  },
  {
    id: 'modules-housekeeping',
    domainId: 'modules',
    path: '/settings/modules/housekeeping',
    labelKey: 'settings.pageHousekeepingModule',
    descriptionKey: 'settings.pageHousekeepingModuleDescription',
    icon: 'sparkles',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-housekeeping.js'),
  },
  {
    id: 'modules-dashboard',
    domainId: 'modules',
    path: '/settings/modules/dashboard',
    labelKey: 'settings.pageDashboardApp',
    descriptionKey: 'settings.pageDashboardAppDescription',
    icon: 'layout-dashboard',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-dashboard.js'),
  },
  {
    id: 'sync-calendar',
    domainId: 'sync',
    path: '/settings/sync/calendar',
    labelKey: 'settings.pageSyncCalendar',
    descriptionKey: 'settings.pageSyncCalendarDescription',
    icon: 'calendar-sync',
    adminOnly: true,
    loader: () => import('/settings/pages/sync-calendar.js'),
  },
  {
    id: 'sync-contacts',
    domainId: 'sync',
    path: '/settings/sync/contacts',
    labelKey: 'settings.pageSyncContacts',
    descriptionKey: 'settings.pageSyncContactsDescription',
    icon: 'contact-round',
    adminOnly: true,
    loader: () => import('/settings/pages/sync-contacts.js'),
  },
  {
    id: 'sync-reminders',
    domainId: 'sync',
    path: '/settings/sync/reminders',
    labelKey: 'settings.pageSyncReminders',
    descriptionKey: 'settings.pageSyncRemindersDescription',
    icon: 'list-checks',
    adminOnly: true,
    loader: () => import('/settings/pages/sync-reminders.js'),
  },
  {
    id: 'documents-storage',
    domainId: 'documents',
    path: '/settings/documents/storage',
    labelKey: 'settings.pageDocumentStorage',
    descriptionKey: 'settings.pageDocumentStorageDescription',
    icon: 'hard-drive',
    adminOnly: true,
    loader: () => import('/settings/pages/documents-storage.js'),
  },
  {
    id: 'documents-dms',
    domainId: 'documents',
    path: '/settings/documents/dms',
    labelKey: 'settings.pageDocumentDms',
    descriptionKey: 'settings.pageDocumentDmsDescription',
    icon: 'archive',
    adminOnly: true,
    loader: () => import('/settings/pages/documents-dms.js'),
  },
  {
    id: 'admin-family',
    domainId: 'admin',
    path: '/settings/admin/family',
    labelKey: 'settings.pageFamilyRoles',
    descriptionKey: 'settings.pageFamilyRolesDescription',
    icon: 'users',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-family.js'),
  },
  {
    id: 'admin-api',
    domainId: 'admin',
    path: '/settings/admin/api',
    labelKey: 'settings.pageApiAccess',
    descriptionKey: 'settings.pageApiAccessDescription',
    icon: 'key-round',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-api.js'),
  },
  {
    id: 'admin-backup',
    domainId: 'admin',
    path: '/settings/admin/backup',
    labelKey: 'settings.pageBackupRestore',
    descriptionKey: 'settings.pageBackupRestoreDescription',
    icon: 'database-backup',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-backup.js'),
  },
  {
    id: 'admin-email',
    domainId: 'admin',
    path: '/settings/admin/email',
    labelKey: 'settings.pageEmail',
    descriptionKey: 'settings.pageEmailDescription',
    icon: 'mail',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-email.js'),
  },
  {
    id: 'admin-system',
    domainId: 'admin',
    path: '/settings/admin/system',
    labelKey: 'settings.pageSystem',
    descriptionKey: 'settings.pageSystemDescription',
    icon: 'info',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-system.js'),
  },
]);

const LEGACY_SETTINGS_PATHS = Object.freeze({
  general: '/settings/personal/appearance',
  meals: '/settings/modules/kitchen',
  budget: '/settings/modules/budget',
  shopping: '/shopping?manage=categories',
  calendar: '/settings/modules/calendar',
  sync: '/settings/sync/calendar',
  account: '/settings/personal/account',
  family: '/settings/admin/family',
  'api-tokens': '/settings/admin/api',
  backup: '/settings/admin/backup',
});

export function filterSettingsDomains(user) {
  const isAdmin = user?.role === 'admin';
  return SETTINGS_DOMAINS.filter((domain) => isAdmin || !domain.adminOnly);
}

export function findSettingsLeaf(path, user) {
  const leaf = SETTINGS_LEAVES.find((entry) => entry.path === path);
  if (!leaf || (leaf.adminOnly && user?.role !== 'admin')) return null;
  return leaf;
}

export function settingsOverviewUrl(domainId = null) {
  return domainId
    ? `/settings?view=domain&domain=${encodeURIComponent(domainId)}`
    : '/settings?view=domains';
}

export function resolveSettingsDestination(path, user, storedPath) {
  if (path !== '/settings') return findSettingsLeaf(path, user)?.path ?? '/settings/personal/account';
  return findSettingsLeaf(storedPath, user)?.path ?? '/settings/personal/account';
}

export function migrateLegacySettingsTab(value) {
  return LEGACY_SETTINGS_PATHS[value] ?? null;
}

export function readStoredSettingsDestination(user, storage = sessionStorage) {
  const current = storage.getItem(SETTINGS_STORAGE_KEY);
  if (findSettingsLeaf(current, user)) return current;
  const legacy = storage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
  const migrated = migrateLegacySettingsTab(legacy);
  if (migrated) {
    storage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    if (migrated.startsWith('/settings/') && findSettingsLeaf(migrated, user)) {
      storage.setItem(SETTINGS_STORAGE_KEY, migrated);
    }
    return migrated;
  }
  return '/settings/personal/account';
}
