export const SETTINGS_STORAGE_KEY = 'yuvomi:settings:path';
export const LEGACY_SETTINGS_STORAGE_KEY = 'yuvomi:settings:tab';

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const SETTINGS_DOMAINS = freezeEntries([
  { id: 'personal', labelKey: 'settings.domainPersonal', icon: 'user', adminOnly: false },
  { id: 'modules', labelKey: 'settings.domainModules', icon: 'layout-grid', adminOnly: true },
  { id: 'sync', labelKey: 'settings.domainSync', icon: 'refresh-cw', adminOnly: true },
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
    // `calendar_default_reminders` und `calendar_default_assign_me` schreiben
    // per `cfgUserSet` pro Nutzer, lagen aber im adminOnly-`modules-calendar`
    // (Critique 2026-07-27). Wochenstart, Standarddauer und Feiertage bleiben
    // dort: die gelten haushaltweit.
    id: 'personal-calendar',
    domainId: 'personal',
    path: '/settings/personal/calendar',
    labelKey: 'settings.pageCalendarDefaults',
    descriptionKey: 'settings.pageCalendarDefaultsDescription',
    icon: 'calendar-clock',
    adminOnly: false,
    loader: () => import('/settings/pages/personal-calendar.js'),
  },
  {
    id: 'personal-weather',
    domainId: 'personal',
    path: '/settings/personal/weather',
    labelKey: 'settings.pageWeather',
    descriptionKey: 'settings.pageWeatherDescription',
    icon: 'cloud-sun',
    adminOnly: false,
    loader: () => import('/settings/pages/personal-weather.js'),
  },
  {
    // Reihenfolge und Mobil-Slots sind per-user (cfgUserSet, kein Admin-Check in
    // server/routes/preferences.js). Das Blatt lag trotzdem hinter adminOnly, also
    // konnten 5 von 6 Familienmitgliedern ihre eigene Navigation nicht einstellen
    // (Critique 2026-07-27). Die haushaltweiten Schalter sind im Blatt gegated.
    id: 'modules-navigation',
    domainId: 'personal',
    path: '/settings/personal/navigation',
    labelKey: 'settings.pageNavigation',
    descriptionKey: 'settings.pageNavigationDescription',
    icon: 'panel-left',
    adminOnly: false,
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
    // Budget, Gesundheit und Haushaltshilfe hatten je ein eigenes Blatt für je
    // eine Checkbox - drei Sidebar-Einträge und drei Requests für drei Schalter
    // (Critique 2026-07-27).
    id: 'modules-options',
    domainId: 'modules',
    path: '/settings/modules/options',
    labelKey: 'settings.pageModuleOptions',
    descriptionKey: 'settings.pageModuleOptionsDescription',
    icon: 'sliders-horizontal',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
  },
  {
    id: 'modules-rewards',
    domainId: 'modules',
    path: '/settings/modules/rewards',
    labelKey: 'settings.pageRewardsModule',
    descriptionKey: 'settings.pageRewardsModuleDescription',
    icon: 'award',
    adminOnly: true,
    loader: () => import('/settings/pages/modules-rewards.js'),
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
    // Dateiname und ID bleiben `documents-*`: interne Bezeichner, die sonst den
    // sw.js-Precache und zwei Test-Dateien mitziehen. Nutzersichtbar ist die
    // Domäne, und externe Dienste anzubinden ist Synchronisation.
    id: 'documents-storage',
    domainId: 'sync',
    path: '/settings/sync/storage',
    labelKey: 'settings.pageDocumentStorage',
    descriptionKey: 'settings.pageDocumentStorageDescription',
    icon: 'hard-drive',
    adminOnly: true,
    loader: () => import('/settings/pages/documents-storage.js'),
  },
  {
    id: 'documents-dms',
    domainId: 'sync',
    path: '/settings/sync/dms',
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
    id: 'admin-permissions',
    domainId: 'admin',
    path: '/settings/admin/permissions',
    labelKey: 'settings.pagePermissions',
    descriptionKey: 'settings.pagePermissionsDescription',
    icon: 'shield-check',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-permissions.js'),
  },
  {
    // Der Haushalts-Standardstandort lag als "Übersicht" in `modules` und trug
    // dort keine einzige Widget-Einstellung (Critique 2026-07-27). Er ist eine
    // haushaltweite Ressource, also Administration - das Gegenstück je Mitglied
    // ist `personal-weather`.
    id: 'admin-weather',
    domainId: 'admin',
    path: '/settings/admin/weather',
    labelKey: 'settings.pageHouseholdWeather',
    descriptionKey: 'settings.pageHouseholdWeatherDescription',
    icon: 'cloud-sun',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-weather.js'),
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
    id: 'admin-immich',
    domainId: 'admin',
    path: '/settings/admin/immich',
    labelKey: 'settings.pageImmich',
    descriptionKey: 'settings.pageImmichDescription',
    icon: 'images',
    adminOnly: true,
    loader: () => import('/settings/pages/admin-immich.js'),
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
  // Kategorienpflege lebt bewusst im Modul, neben ihren Daten.
  shopping: '/shopping?manage=categories',
  calendar: '/settings/modules/calendar',
  sync: '/settings/sync/calendar',
  account: '/settings/personal/account',
  family: '/settings/admin/family',
  'api-tokens': '/settings/admin/api',
  backup: '/settings/admin/backup',
});

/**
 * Blatt-Pfade, die ein IA-Umbau verschoben hat. Ohne diese Tabelle landen alte
 * Bookmarks und gespeicherte sessionStorage-Ziele stumm auf `personal/account`
 * statt am umbenannten Blatt.
 */
const RENAMED_SETTINGS_PATHS = Object.freeze({
  // Domäne `documents` aufgelöst: beide Blätter binden externe Dienste an und
  // gehören damit zu Synchronisation (Critique 2026-07-27).
  '/settings/documents/storage': '/settings/sync/storage',
  '/settings/documents/dms': '/settings/sync/dms',
  // Navigation ist überwiegend eine persönliche Einstellung, siehe Leaf-Kommentar.
  '/settings/modules/navigation': '/settings/personal/navigation',
  // `modules-dashboard` aufgelöst: der Anwendungsname sitzt jetzt bei den
  // Systemangaben, der Haushalts-Standardstandort in einem eigenen Blatt.
  '/settings/modules/dashboard': '/settings/admin/weather',
  // Drei Blätter für drei Checkboxen zu einem zusammengelegt.
  '/settings/modules/budget': '/settings/modules/options',
  '/settings/modules/health': '/settings/modules/options',
  '/settings/modules/housekeeping': '/settings/modules/options',
});

export function filterSettingsDomains(user) {
  const isAdmin = user?.role === 'admin';
  return SETTINGS_DOMAINS.filter((domain) => isAdmin || !domain.adminOnly);
}

/**
 * Die verschobenen Alt-Pfade. Der Router muss sie als Routen kennen, sonst
 * matcht ein direkter Aufruf (Bookmark, geteilter Link) überhaupt nichts und
 * die Umleitung unten käme nie zum Zug.
 */
export const RENAMED_SETTINGS_SOURCE_PATHS = Object.freeze(Object.keys(RENAMED_SETTINGS_PATHS));

/** Löst einen verschobenen Pfad auf seinen aktuellen auf; sonst unverändert. */
export function currentSettingsPath(path) {
  return RENAMED_SETTINGS_PATHS[path] ?? path;
}

export function findSettingsLeaf(path, user) {
  const target = currentSettingsPath(path);
  const leaf = SETTINGS_LEAVES.find((entry) => entry.path === target);
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
  const legacy = LEGACY_SETTINGS_PATHS[value];
  // Die Tabelle bleibt historisch (Tab-Name -> Blatt von damals); dass ein Blatt
  // seither weitergezogen ist, weiß nur `currentSettingsPath`. Ohne diesen
  // Durchlauf käme ein Alt-Tab am Zwischenstand von 2026-06 an.
  return legacy ? currentSettingsPath(legacy) : null;
}

export function readStoredSettingsDestination(user, storage = sessionStorage) {
  const current = storage.getItem(SETTINGS_STORAGE_KEY);
  // Den kanonischen Pfad zurückgeben, nicht den gespeicherten: ein vor dem
  // IA-Umbau abgelegtes Ziel soll am neuen Ort landen, nicht auf der alten URL.
  const leaf = findSettingsLeaf(current, user);
  if (leaf) return leaf.path;
  const legacy = storage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
  const migrated = migrateLegacySettingsTab(legacy);
  if (migrated) {
    storage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    if (migrated.startsWith('/settings/') && findSettingsLeaf(migrated, user)) {
      storage.setItem(SETTINGS_STORAGE_KEY, migrated);
    }
    return migrated;
  }
  // `null` statt eines erfundenen Ziels: wer noch nie in den Einstellungen war,
  // hat kein "zuletzt besuchtes Blatt". Vorher landete der erste Besuch
  // wortlos im Konto-Formular, und die Übersicht war über die App-Navigation
  // gar nicht erreichbar (Critique 2026-07-27). Der Aufrufer entscheidet.
  return null;
}
