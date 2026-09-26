export const SETTINGS_STORAGE_KEY = 'yuvomi:settings:path';
export const LEGACY_SETTINGS_STORAGE_KEY = 'yuvomi:settings:tab';

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const SETTINGS_DOMAINS = freezeEntries([
  { id: 'personal', labelKey: 'settings.domainPersonal', icon: 'user', adminOnly: false },
  { id: 'modules', labelKey: 'settings.domainModules', icon: 'layout-grid', adminOnly: true },
  { id: 'sync', labelKey: 'settings.domainSync', icon: 'refresh-cw', adminOnly: true },
  { id: 'admin', labelKey: 'settings.domainAdministration', icon: 'shield', adminOnly: true },
]);

/**
 * `options` - DIE EINZELNEN EINSTELLUNGEN EINES BLATTS fuer die Stichwortsuche
 * (Critique 2026-09-26, A7 P1). Die Suche kannte nur Blatt-Titel und
 * -Beschreibung: „Zeitzone", „Dunkel", „Einladung", „Mealie", „Zwei-Faktor"
 * fanden nichts, „Wand" nur die Wandtabletts statt des Wand-Modus. Jede Option
 * ist der i18n-Schluessel ihrer SICHTBAREN Beschriftung auf dem Blatt - daraus
 * entsteht der Treffer, und dieselbe Beschriftung sucht die Shell nach dem
 * Sprung im Blatt, um die Stelle zu zeigen (shell.js, revealSettingsOption).
 * Als Objekt: `also` sind weitere Schluessel, die nur mitgesucht werden (die
 * drei Werte des Theme-Segments), `terms` Produktnamen, die in keiner Sprache
 * uebersetzt werden (Mealie, CalDAV) und deshalb kein Schluessel sind.
 * `test:settings-copy` haelt, dass jeder Schluessel auf SEINEM Blatt
 * gerendert wird - sonst fuehrte ein Treffer auf ein Blatt, das die Option
 * gar nicht zeigt.
 */
export const SETTINGS_LEAVES = freezeEntries([
  {
    id: 'personal-account',
    domainId: 'personal',
    path: '/settings/personal/account',
    labelKey: 'settings.pageAccount',
    descriptionKey: 'settings.pageAccountDescription',
    icon: 'circle-user',
    options: [
      'settings.displayNameLabel',
      'settings.colorLabel',
      { key: 'settings.contactDetailsLegend', also: ['settings.memberPhoneLabel', 'settings.memberEmailLabel', 'settings.memberBirthDateLabel'] },
      'settings.changePassword',
      { key: 'settings.twoFactorTitle', terms: ['2FA', 'TOTP'] },
      'settings.otherSessionsTitle',
      { key: 'settings.oidcLinkTitle', terms: ['SSO', 'OIDC'] },
    ],
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
    options: [
      { key: 'settings.sectionDesign', also: ['settings.themeSystem', 'settings.themeLight', 'settings.themeDark'] },
      'settings.wallModeLabel',
      'settings.localeLabel',
      'settings.dataLanguageLabel',
      'settings.regionLabel',
      'settings.currencyLabel',
      'settings.timezoneLabel',
      'settings.dateFormatLabel',
      'settings.timeFormatLabel',
    ],
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
    options: [
      { key: 'settings.pwaInstallTitle', terms: ['PWA'] },
    ],
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
    options: [
      'settings.pushToggleTitle',
      { key: 'settings.notificationChannelsTitle', terms: ['ntfy', 'Gotify', 'Webhook'] },
    ],
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
    module: 'calendar',
    options: [
      'settings.calendarAssignMeLabel',
      'settings.calendarDefaultTargetLabel',
      'settings.calendarDefaultRemindersLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-calendar.js'),
  },
  {
    // `tasks_default_target` schreibt per `cfgUserSet` pro Nutzer. Welche
    // Erinnerungslisten der Haushalt abgleicht, entscheidet der Admin in
    // `sync-reminders`; in welche davon MEINE neuen Aufgaben laufen, entscheide
    // ich - und dieses Blatt darf deshalb nicht adminOnly sein (#695).
    id: 'personal-tasks',
    domainId: 'personal',
    path: '/settings/personal/tasks',
    labelKey: 'settings.pageTaskDefaults',
    descriptionKey: 'settings.pageTaskDefaultsDescription',
    icon: 'list-checks',
    module: 'tasks',
    options: [
      'settings.tasksDefaultTargetLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-tasks.js'),
  },
  {
    // Der Zyklus-Tab hat zwei Schalter: ob der Haushalt ihn führt, entscheidet
    // der Admin in `modules-options`; ob ich ihn sehen will, entscheide ich -
    // nicht jede Person im Haushalt hat einen Zyklus (#760). Deshalb personal
    // und nicht adminOnly.
    id: 'personal-health',
    domainId: 'personal',
    path: '/settings/personal/health',
    labelKey: 'settings.pageHealthPersonal',
    descriptionKey: 'settings.pageHealthPersonalDescription',
    icon: 'heart-pulse',
    module: 'health',
    options: [
      'settings.healthCyclePersonalLabel',
      'settings.healthPreventionNotifyCaregiversLabel',
      'settings.healthVisibilityTitle',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-health.js'),
  },
  {
    id: 'personal-weather',
    domainId: 'personal',
    path: '/settings/personal/weather',
    labelKey: 'settings.pageWeather',
    descriptionKey: 'settings.pageWeatherDescription',
    icon: 'cloud-sun',
    options: [
      'settings.personalWeatherTitle',
      'settings.weatherAutoLocateLabel',
    ],
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
    options: [
      'settings.desktopNavigationTitle',
      'settings.mobileNavigationTitle',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/modules-navigation.js'),
  },
  {
    // Beide Feed-Tokens haengen an der eigenen users-Zeile (calendar_feed_token,
    // Migration 61; inventory_deadlines_feed_token, Migration 144), und beide
    // Routen tragen serverseitig bewusst keinen Admin-Check. Die Abschnitte
    // lagen trotzdem auf dem adminOnly-`sync-calendar`, also konnte in einem
    // fuenfkoepfigen Haushalt genau eine Person ihr eigenes Abo einrichten oder
    // zurueckziehen. Was in den Kalender HINEIN kommt, bleibt dort Haushaltssache.
    id: 'personal-feeds',
    domainId: 'personal',
    path: '/settings/personal/feeds',
    labelKey: 'settings.pageFeeds',
    descriptionKey: 'settings.pageFeedsDescription',
    icon: 'rss',
    options: [
      { key: 'settings.feedExportTitle', terms: ['ICS', 'iCal'] },
      'settings.feedExportShowAssignees',
      'settings.inventoryFeedTitle',
      'settings.cycleFeedTitle',
      'settings.scheduleFeedTitle',
      'settings.wasteFeedTitle',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
  },
  {
    // Die Gegenrichtung zu `personal-feeds`: was in den Kalender HEREIN kommt,
    // ohne dass ein Haushaltskonto daran haengt. Der Server ist hier
    // eigentuemerbasiert und war es immer - `GET /calendar/subscriptions`
    // liefert `shared = 1 OR created_by = ich`, und PATCH/DELETE/sync
    // antworten 403 fuer fremde Abos, wobei `isAdmin` ein ZUSATZrecht ist.
    // Jedes Mitglied durfte sein eigenes Abo also laengst verwalten und kam
    // nur nicht an die Oberflaeche, weil `sync-calendar` adminOnly ist.
    // CalDAV und Google/Apple bleiben dort: die haengen an Zugangsdaten des
    // Haushalts und ihre Routen tragen `requireAdmin`.
    id: 'personal-calendar-subscriptions',
    domainId: 'personal',
    path: '/settings/personal/calendar-subscriptions',
    labelKey: 'settings.pageCalendarSubscriptions',
    descriptionKey: 'settings.pageCalendarSubscriptionsDescription',
    icon: 'calendar-plus',
    module: 'calendar',
    options: [
      { key: 'settings.ics.title', terms: ['ICS', 'iCal'] },
      'settings.calendarImport.title',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-calendar-subscriptions.js'),
  },
  {
    // Der haushaltweite Modul-Schalter, gezogen aus `modules-navigation`
    // (Critique 2026-08-16). Dort stand er inline hinter `isAdmin` neben dem
    // persoenlichen Ausblenden-Knopf aus #673: zwei unbeschriftete
    // Bedienelemente, zwoelf Pixel auseinander, das eine fuer mich, das andere
    // fuer sechs Personen ohne Rueckfrage. Ein Blatt, eine Reichweite.
    id: 'modules-active',
    domainId: 'modules',
    path: '/settings/modules/active',
    labelKey: 'settings.pageActiveModules',
    descriptionKey: 'settings.pageActiveModulesDescription',
    icon: 'toggle-right',
    options: [
      'settings.activeModulesTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-active.js'),
  },
  {
    id: 'modules-kitchen',
    domainId: 'modules',
    path: '/settings/modules/kitchen',
    labelKey: 'settings.pageKitchen',
    descriptionKey: 'settings.pageKitchenDescription',
    icon: 'utensils',
    module: 'kitchen',
    options: [
      'settings.mealTypesLabel',
      'settings.mealTypeNamesLabel',
      { key: 'settings.recipeProvidersTitle', terms: ['Mealie', 'Tandoor'] },
    ],
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
    module: 'calendar',
    options: [
      'settings.calendarDurationTitle',
      'settings.weekStartTitle',
      'settings.holidayPublicLabel',
      'settings.holidaySchoolLabel',
    ],
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
    options: [
      'settings.budgetModePersonalLabel',
      'settings.healthCycleEnableLabel',
      'settings.housekeepingPaymentTasksLabel',
      'settings.tasksSubtasksExpandedLabel',
      'settings.scheduleTemplatesTitle',
    ],
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
    module: 'rewards',
    options: [
      'settings.rewardsEnableLabel',
      'settings.rewardsApprovalLabel',
      'settings.rewardsDefaultPointsLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-rewards.js'),
  },
  {
    // Der Vorsorge-Typregister ist ein Haushaltskatalog (D2, docs/SCOPE.md
    // schliesst mitgelieferte Kataloge aus, die veralten) - der Admin legt die
    // Arten selbst an, es gibt keine Voreinstellung.
    id: 'modules-health',
    domainId: 'modules',
    path: '/settings/modules/health',
    labelKey: 'settings.pageHealthModule',
    descriptionKey: 'settings.pageHealthModuleDescription',
    icon: 'syringe',
    module: 'health',
    options: [
      'settings.healthPreventionTypesTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-health.js'),
  },
  {
    // Nicht an ein einzelnes Modul gebunden (die Kachel sammelt aus Kalender
    // UND Aufgaben, #647) - deshalb kein `module:`, wie modules-options.js.
    id: 'modules-countdowns',
    domainId: 'modules',
    path: '/settings/modules/countdowns',
    labelKey: 'settings.pageCountdownsModule',
    descriptionKey: 'settings.pageCountdownsModuleDescription',
    icon: 'hourglass',
    options: [
      'settings.countdownGraceDaysTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-countdowns.js'),
  },
  {
    id: 'sync-calendar',
    domainId: 'sync',
    path: '/settings/sync/calendar',
    labelKey: 'settings.pageSyncCalendar',
    descriptionKey: 'settings.pageSyncCalendarDescription',
    icon: 'calendar-sync',
    module: 'calendar',
    options: [
      { key: 'settings.caldavTitle', terms: ['CalDAV', 'Nextcloud'] },
      { key: 'settings.moreProviders', terms: ['Google', 'Apple', 'iCloud', 'Outlook'] },
      'settings.sync.backfillTitle',
    ],
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
    module: 'contacts',
    options: [
      { key: 'settings.cardavTitle', terms: ['CardDAV', 'Nextcloud'] },
    ],
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
    module: 'tasks',
    options: [
      'settings.caldavSyncReminders',
    ],
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
    module: 'documents',
    options: [
      { key: 'settings.documentStorageWebdavTitle', terms: ['Nextcloud'] },
      'settings.documentStorageGoogleDriveTitle',
    ],
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
    module: 'documents',
    options: [
      { key: 'settings.dmsTitle', terms: ['Paperless'] },
    ],
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
    options: [
      'settings.sectionFamily',
      'settings.invites.title',
      { key: 'settings.twoFactorTitle', also: ['settings.twoFactorRequireLabel'], terms: ['2FA'] },
    ],
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
    options: [
      'settings.permCapabilitiesHeading',
    ],
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
    options: [
      'settings.weatherTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-weather.js'),
  },
  {
    id: 'admin-displays',
    domainId: 'admin',
    path: '/settings/admin/displays',
    labelKey: 'settings.pageDisplays',
    descriptionKey: 'settings.pageDisplaysDescription',
    icon: 'tablet-smartphone',
    options: [
      'settings.displayPairingCodeLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-displays.js'),
  },
  {
    id: 'admin-api',
    domainId: 'admin',
    path: '/settings/admin/api',
    labelKey: 'settings.pageApiAccess',
    descriptionKey: 'settings.pageApiAccessDescription',
    icon: 'key-round',
    options: [
      'settings.apiTokensTitle',
    ],
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
    options: [
      'settings.backupDownloadTitle',
      'settings.backupRestoreTitle',
      'settings.backupSchedulerTitle',
      'settings.backupWebdavEnabled',
    ],
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
    options: [
      { key: 'email.host', terms: ['SMTP'] },
    ],
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
    options: [
      'settings.immichServerUrl',
    ],
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
    options: [
      'settings.appNameLabel',
      'settings.systemVersionLabel',
    ],
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
  // Zwei Blätter für zwei Checkboxen zu einem zusammengelegt. `/settings/modules/health`
  // gehörte einst dazu (dritte Checkbox) - der Pfad trägt jetzt wieder eigenen
  // Inhalt (das Vorsorge-Typregister), also kein Alias mehr auf
  // `modules-options`. Der Haushalts-Schalter für das Modul selbst bleibt dort.
  '/settings/modules/budget': '/settings/modules/options',
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

/**
 * Vergleichsform der Suche: Kleinschreibung, Diakritika weg, damit „wetter"
 * auch „Wetter" findet und „prazdniny" auch „prázdniny".
 */
export function normalizeSettingsSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** Eine Option aus `options` in einheitlicher Form. */
function optionEntry(option) {
  return typeof option === 'string'
    ? { key: option, also: [], terms: [] }
    : { key: option.key, also: option.also ?? [], terms: option.terms ?? [] };
}

/**
 * Stichwortsuche ueber die Blaetter UND ihre einzelnen Optionen - die EINE
 * Suche der Einstellungen, von der Wurzel (Kopf-Suche) und der Seitenleiste
 * (Desktop-Blatt) gleich benutzt.
 *
 * Ein Blatt trifft ueber Titel, Beschreibung und Bereich; eine Option ueber
 * ihre Beschriftung, ihre `also`-Schluessel und ihre `terms`. Rein und ohne
 * DOM: `translate` kommt vom Aufrufer (im Browser `t`, im Test das de-Locale).
 *
 * @param {string} query
 * @param {{ user?: object, translate: (key: string) => string }} opts
 * @returns {{ leaves: object[], options: { leaf: object, key: string, label: string }[] }}
 */
export function searchSettings(query, { user, translate }) {
  const needle = normalizeSettingsSearch(String(query ?? '').trim());
  if (!needle) return { leaves: [], options: [] };
  const domainLabels = new Map(filterSettingsDomains(user).map((domain) => [domain.id, translate(domain.labelKey)]));
  const visible = SETTINGS_LEAVES.filter((leaf) => domainLabels.has(leaf.domainId)
    && (!leaf.adminOnly || user?.role === 'admin'));

  const leaves = visible.filter((leaf) => normalizeSettingsSearch(
    `${translate(leaf.labelKey)} ${translate(leaf.descriptionKey)} ${domainLabels.get(leaf.domainId)}`,
  ).includes(needle));

  const options = [];
  for (const leaf of visible) {
    for (const option of (leaf.options ?? []).map(optionEntry)) {
      const label = translate(option.key);
      const haystack = [label, ...option.also.map(translate), ...option.terms].join(' ');
      if (normalizeSettingsSearch(haystack).includes(needle)) options.push({ leaf, key: option.key, label });
    }
  }
  return { leaves, options };
}

/** Sprungziel eines Options-Treffers: das Blatt, mit der Option als Anker. */
export function settingsOptionUrl(leaf, key) {
  return `${leaf.path}?option=${encodeURIComponent(key)}`;
}
