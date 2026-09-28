import { sortNavigationItems } from './module-order.js';

export const SETTINGS_STORAGE_KEY = 'yuvomi:settings:path';
export const LEGACY_SETTINGS_STORAGE_KEY = 'yuvomi:settings:tab';

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

/**
 * DREI BEREICHE, JE MODUL EIN BLATT (Re-Critique 2026-09-27, A7 P1-3).
 *
 * Bis R10 lagen 32 Blaetter in vier Bereichen, und ein Modul war an bis zu fuenf
 * Orten eingestellt (Kalender: Termin-Vorgaben, Kalender-Abos, Feed-Abos,
 * Module > Kalender, Sync > Kalender). Jetzt gilt Apples Einstellungen > App:
 * Konto (meine Sachen), Haushalt (Administration) und Module - darin je Modul
 * EIN Blatt mit den Abschnitten "Fuer mich" und "Fuer den Haushalt".
 *
 * Die IDs bleiben der Pfad-Namensraum (`/settings/personal/...`,
 * `/settings/admin/...`): die Blaetter, die 1:1 weiterleben, behalten ihre
 * Adresse, und keine Lesezeichen gehen verloren. Nur die Beschriftung zeigt
 * den neuen Schnitt. Ein Bereich erscheint, sobald eines seiner Blaetter
 * sichtbar ist - `modules` ist deshalb nicht mehr adminOnly: Navigation und die
 * "Fuer mich"-Abschnitte von Kalender, Aufgaben und Gesundheit gehoeren allen.
 */
export const SETTINGS_DOMAINS = freezeEntries([
  { id: 'personal', labelKey: 'settings.domainAccount', icon: 'user', adminOnly: false },
  { id: 'admin', labelKey: 'settings.domainHousehold', icon: 'house', adminOnly: true },
  { id: 'modules', labelKey: 'settings.domainModules', icon: 'layout-grid', adminOnly: false },
]);

/** Reichweite eines Abschnitts: meine Vorgaben oder die des ganzen Haushalts. */
export const SETTINGS_SCOPES = Object.freeze(['mine', 'household']);

/**
 * DIE ABSCHNITTE - jedes Blatt von vor R10 ist genau einer (gleiche `id`,
 * gleicher Loader, gleiche Rechte, gleiche Datenhaltung), ausser
 * `modules-options`, das in einen Abschnitt je Modul zerfaellt (`part`).
 * `sheetId` sagt, in welchem Blatt er steht, `scope`, fuer wen er gilt.
 *
 * `options` - DIE EINZELNEN EINSTELLUNGEN fuer die Stichwortsuche (Critique
 * 2026-09-26, A7 P1). Jede Option ist der i18n-Schluessel ihrer SICHTBAREN
 * Beschriftung im Abschnitt - daraus entsteht der Treffer, und dieselbe
 * Beschriftung sucht die Shell nach dem Sprung im Blatt, um die Stelle zu
 * zeigen (shell.js, revealSettingsOption). Als Objekt: `also` sind weitere
 * Schluessel, die nur mitgesucht werden (die drei Werte des Theme-Segments),
 * `terms` Produktnamen, die in keiner Sprache uebersetzt werden (Mealie,
 * CalDAV) und deshalb kein Schluessel sind. `test:settings-copy` haelt, dass
 * jeder Schluessel in SEINEM Abschnitt gerendert wird.
 *
 * `labelKey`/`descriptionKey` sind die Namen der frueheren Blaetter: die Suche
 * findet "Feed-Abos" oder "Kalender-Synchronisation" weiter und springt an den
 * Abschnitt.
 *
 * `adminOnly` UND `loader` stehen je Eintrag direkt hintereinander:
 * test:settings-admin-gate liest genau diese Form aus dem Quelltext.
 */
export const SETTINGS_SECTIONS = freezeEntries([
  // ── Konto ──────────────────────────────────────────────────────────────────
  {
    id: 'personal-account',
    sheetId: 'personal-account',
    scope: 'mine',
    labelKey: 'settings.pageAccount',
    descriptionKey: 'settings.pageAccountDescription',
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
    sheetId: 'personal-appearance',
    scope: 'mine',
    labelKey: 'settings.pageAppearance',
    descriptionKey: 'settings.pageAppearanceDescription',
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
    sheetId: 'personal-device',
    scope: 'mine',
    labelKey: 'settings.pageDevice',
    descriptionKey: 'settings.pageDeviceDescription',
    options: [
      { key: 'settings.pwaInstallTitle', terms: ['PWA'] },
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-device.js'),
  },
  {
    id: 'personal-notifications',
    sheetId: 'personal-notifications',
    scope: 'mine',
    labelKey: 'settings.pageNotifications',
    descriptionKey: 'settings.pageNotificationsDescription',
    options: [
      'settings.pushToggleTitle',
      { key: 'settings.notificationChannelsTitle', terms: ['ntfy', 'Gotify', 'Webhook'] },
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/notifications.js'),
  },
  {
    id: 'personal-weather',
    sheetId: 'personal-weather',
    scope: 'mine',
    labelKey: 'settings.pageWeather',
    descriptionKey: 'settings.pageWeatherDescription',
    options: [
      'settings.personalWeatherTitle',
      'settings.weatherAutoLocateLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-weather.js'),
  },

  // ── Haushalt ───────────────────────────────────────────────────────────────
  {
    id: 'admin-family',
    sheetId: 'admin-family',
    scope: 'household',
    labelKey: 'settings.pageFamilyRoles',
    descriptionKey: 'settings.pageFamilyRolesDescription',
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
    sheetId: 'admin-permissions',
    scope: 'household',
    labelKey: 'settings.pagePermissions',
    descriptionKey: 'settings.pagePermissionsDescription',
    options: [
      'settings.permCapabilitiesHeading',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-permissions.js'),
  },
  {
    // Ein Wandtablett anzulegen heisst, einem Geraet dauerhaft Zugang zum
    // Haushalt zu geben; jede Route des Blatts traegt `requireAdmin` (#1208).
    id: 'admin-displays',
    sheetId: 'admin-displays',
    scope: 'household',
    labelKey: 'settings.pageDisplays',
    descriptionKey: 'settings.pageDisplaysDescription',
    options: [
      'settings.displayPairingCodeLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-displays.js'),
  },
  {
    id: 'admin-email',
    sheetId: 'admin-email',
    scope: 'household',
    labelKey: 'settings.pageEmail',
    descriptionKey: 'settings.pageEmailDescription',
    options: [
      { key: 'email.host', terms: ['SMTP'] },
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-email.js'),
  },
  {
    id: 'admin-backup',
    sheetId: 'admin-backup',
    scope: 'household',
    labelKey: 'settings.pageBackupRestore',
    descriptionKey: 'settings.pageBackupRestoreDescription',
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
    id: 'admin-system',
    sheetId: 'admin-system',
    scope: 'household',
    labelKey: 'settings.pageSystem',
    descriptionKey: 'settings.pageSystemDescription',
    options: [
      'settings.appNameLabel',
      'settings.systemVersionLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-system.js'),
  },
  {
    id: 'admin-api',
    sheetId: 'admin-api',
    scope: 'household',
    labelKey: 'settings.pageApiAccess',
    descriptionKey: 'settings.pageApiAccessDescription',
    options: [
      'settings.apiTokensTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-api.js'),
  },
  {
    // Serverweite Dienstanbindung, deren Zugangsdaten der Browser nie sieht (#693).
    id: 'admin-immich',
    sheetId: 'admin-integrations',
    scope: 'household',
    labelKey: 'settings.pageImmich',
    descriptionKey: 'settings.pageImmichDescription',
    options: [
      'settings.immichServerUrl',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-immich.js'),
  },
  {
    // Der Haushalts-Standardstandort des Wetters - eine haushaltweite Quelle;
    // das Gegenstueck je Mitglied ist `personal-weather` im Konto.
    id: 'admin-weather',
    sheetId: 'admin-integrations',
    scope: 'household',
    labelKey: 'settings.pageHouseholdWeather',
    descriptionKey: 'settings.pageHouseholdWeatherDescription',
    options: [
      'settings.weatherTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/admin-weather.js'),
  },

  // ── Module: Querschnitt ────────────────────────────────────────────────────
  {
    // Der EINE Ort, an dem ein Modul fuer den Haushalt an- und ausgeht. Die
    // Modulblaetter zeigen den Zustand und verlinken hierher (shell.js,
    // Statuszeile) - kein Schalter steht doppelt (A7 P1-3).
    id: 'modules-active',
    sheetId: 'modules-active',
    scope: 'household',
    labelKey: 'settings.pageActiveModules',
    descriptionKey: 'settings.pageActiveModulesDescription',
    options: [
      'settings.activeModulesTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-active.js'),
  },
  {
    // Reihenfolge und Mobil-Slots sind per-user (cfgUserSet, kein Admin-Check in
    // server/routes/preferences.js) - das Blatt gehoert allen.
    id: 'modules-navigation',
    sheetId: 'modules-navigation',
    scope: 'mine',
    labelKey: 'settings.pageNavigation',
    descriptionKey: 'settings.pageNavigationDescription',
    options: [
      'settings.desktopNavigationTitle',
      'settings.mobileNavigationTitle',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/modules-navigation.js'),
  },

  // ── Module: je Modul ein Blatt ─────────────────────────────────────────────
  {
    // Die Nachfrist der Stichtag-Kachel ist haushaltweit und admin-only (#969).
    id: 'modules-countdowns',
    sheetId: 'module-dashboard',
    scope: 'household',
    labelKey: 'settings.pageCountdownsModule',
    descriptionKey: 'settings.pageCountdownsModuleDescription',
    options: [
      'settings.countdownGraceDaysTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-countdowns.js'),
  },
  {
    // `calendar_default_reminders` und `calendar_default_assign_me` schreiben per
    // `cfgUserSet` pro Nutzer (Critique 2026-07-27).
    id: 'personal-calendar',
    sheetId: 'module-calendar',
    scope: 'mine',
    labelKey: 'settings.pageCalendarDefaults',
    descriptionKey: 'settings.pageCalendarDefaultsDescription',
    options: [
      'settings.calendarAssignMeLabel',
      'settings.calendarDefaultTargetLabel',
      'settings.calendarDefaultRemindersLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-calendar.js'),
  },
  {
    // Der Server ist hier eigentuemerbasiert: `GET /calendar/subscriptions`
    // liefert `shared = 1 OR created_by = ich`, PATCH/DELETE/sync antworten 403
    // fuer fremde Abos - jedes Mitglied verwaltet sein eigenes Abo (#772).
    id: 'personal-calendar-subscriptions',
    sheetId: 'module-calendar',
    scope: 'mine',
    labelKey: 'settings.pageCalendarSubscriptions',
    descriptionKey: 'settings.pageCalendarSubscriptionsDescription',
    options: [
      { key: 'settings.ics.title', terms: ['ICS', 'iCal'] },
      'settings.calendarImport.title',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-calendar-subscriptions.js'),
  },
  {
    // Beide Feed-Tokens haengen an der eigenen users-Zeile, beide Routen tragen
    // bewusst keinen Admin-Check (#770).
    id: 'personal-feeds',
    sheetId: 'module-calendar',
    scope: 'mine',
    labelKey: 'settings.pageFeeds',
    descriptionKey: 'settings.pageFeedsDescription',
    // Nur noch der Kalender-Feed (R14, A7 P2-3): die Exporte der anderen
    // Module stehen im Blatt ihres Moduls (`feed-*` unten), dieselbe Datei
    // rendert je Abschnitt einen Feed (`props.part`).
    options: [
      { key: 'settings.feedExportTitle', terms: ['ICS', 'iCal'] },
      'settings.feedExportShowAssignees',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
    props: { part: 'calendar' },
  },
  {
    id: 'modules-calendar',
    sheetId: 'module-calendar',
    scope: 'household',
    labelKey: 'settings.pageCalendarModule',
    descriptionKey: 'settings.pageCalendarModuleDescription',
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
    // CalDAV und Google/Apple haengen an Zugangsdaten des Haushalts, ihre
    // Routen tragen `requireAdmin`.
    id: 'sync-calendar',
    sheetId: 'module-calendar',
    scope: 'household',
    labelKey: 'settings.pageSyncCalendar',
    descriptionKey: 'settings.pageSyncCalendarDescription',
    options: [
      { key: 'settings.caldavTitle', terms: ['CalDAV', 'Nextcloud'] },
      { key: 'settings.moreProviders', terms: ['Google', 'Apple', 'iCloud', 'Outlook'] },
      'settings.sync.backfillTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/sync-calendar.js'),
  },
  {
    // Vorlauf, Ueberstunden und Wochenstunden haengen an der eigenen users-
    // Zeile (server/routes/schedule-preferences.js), die Route traegt keinen
    // Admin-Check. Bis R14 stand das als Karte im Tab "Auswertung"
    // (Re-Critique 2026-09-28, A2 P2-3).
    id: 'personal-schedule',
    sheetId: 'module-schedule',
    scope: 'mine',
    labelKey: 'schedule.mySettings',
    descriptionKey: 'settings.pageScheduleMineDescription',
    options: [
      'schedule.reminderToggle',
      'schedule.overtimeTrackingToggle',
      'schedule.weeklyHoursLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-schedule.js'),
  },
  {
    id: 'options-schedule',
    sheetId: 'module-schedule',
    scope: 'household',
    labelKey: 'settings.scheduleTemplatesTitle',
    descriptionKey: 'settings.scheduleTemplatesHint',
    options: [
      'settings.scheduleTemplatesTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
    props: { part: 'schedule' },
  },
  {
    // `tasks_default_target` schreibt per `cfgUserSet` pro Nutzer: in welche
    // Erinnerungsliste MEINE neuen Aufgaben laufen, entscheide ich (#695).
    id: 'personal-tasks',
    sheetId: 'module-tasks',
    scope: 'mine',
    labelKey: 'settings.pageTaskDefaults',
    descriptionKey: 'settings.pageTaskDefaultsDescription',
    options: [
      'settings.tasksDefaultTargetLabel',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-tasks.js'),
  },
  {
    id: 'options-tasks',
    sheetId: 'module-tasks',
    scope: 'household',
    labelKey: 'settings.tasksSubtasksExpandedTitle',
    descriptionKey: 'settings.tasksSubtasksExpandedHint',
    options: [
      'settings.tasksSubtasksExpandedLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
    props: { part: 'tasks' },
  },
  {
    // Welche Erinnerungslisten der Haushalt abgleicht, entscheidet der Admin.
    id: 'sync-reminders',
    sheetId: 'module-tasks',
    scope: 'household',
    labelKey: 'settings.pageSyncReminders',
    descriptionKey: 'settings.pageSyncRemindersDescription',
    options: [
      'settings.caldavSyncReminders',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/sync-reminders.js'),
  },
  {
    id: 'modules-kitchen',
    sheetId: 'module-kitchen',
    scope: 'household',
    labelKey: 'settings.pageKitchen',
    descriptionKey: 'settings.pageKitchenDescription',
    options: [
      'settings.mealTypesLabel',
      'settings.mealTypeNamesLabel',
      { key: 'settings.recipeProvidersTitle', terms: ['Mealie', 'Tandoor'] },
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-kitchen.js'),
  },
  {
    id: 'sync-contacts',
    sheetId: 'module-contacts',
    scope: 'household',
    labelKey: 'settings.pageSyncContacts',
    descriptionKey: 'settings.pageSyncContactsDescription',
    options: [
      { key: 'settings.cardavTitle', terms: ['CardDAV', 'Nextcloud'] },
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/sync-contacts.js'),
  },
  {
    id: 'options-budget',
    sheetId: 'module-budget',
    scope: 'household',
    labelKey: 'settings.budgetModeTitle',
    descriptionKey: 'settings.budgetModeHint',
    options: [
      'settings.budgetModePersonalLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
    props: { part: 'budget' },
  },
  {
    // Dateiname und ID bleiben `documents-*`: interne Bezeichner, die sonst den
    // sw.js-Precache und zwei Test-Dateien mitziehen.
    id: 'documents-storage',
    sheetId: 'module-documents',
    scope: 'household',
    labelKey: 'settings.pageDocumentStorage',
    descriptionKey: 'settings.pageDocumentStorageDescription',
    options: [
      { key: 'settings.documentStorageWebdavTitle', terms: ['Nextcloud'] },
      'settings.documentStorageGoogleDriveTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/documents-storage.js'),
  },
  {
    id: 'documents-dms',
    sheetId: 'module-documents',
    scope: 'household',
    labelKey: 'settings.pageDocumentDms',
    descriptionKey: 'settings.pageDocumentDmsDescription',
    options: [
      { key: 'settings.dmsTitle', terms: ['Paperless'] },
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/documents-dms.js'),
  },
  {
    id: 'options-housekeeping',
    sheetId: 'module-housekeeping',
    scope: 'household',
    labelKey: 'settings.housekeepingPaymentsTitle',
    descriptionKey: 'settings.housekeepingPaymentTasksHint',
    options: [
      'settings.housekeepingPaymentTasksLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
    props: { part: 'housekeeping' },
  },
  {
    // Ohne den frueheren Schalter "Belohnungen aktivieren": der war ein
    // zweiter An/Aus neben Aktive Module (A7 P1-3).
    id: 'modules-rewards',
    sheetId: 'module-rewards',
    scope: 'household',
    labelKey: 'settings.pageRewardsModule',
    descriptionKey: 'settings.sheetRewardsDescription',
    options: [
      'settings.rewardsApprovalLabel',
      'settings.rewardsDefaultPointsLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-rewards.js'),
  },
  {
    // Ob ICH den Zyklus sehen will, entscheide ich (#760) - ob der Haushalt ihn
    // fuehrt, steht in `options-health` darunter.
    id: 'personal-health',
    sheetId: 'module-health',
    scope: 'mine',
    labelKey: 'settings.pageHealthPersonal',
    descriptionKey: 'settings.pageHealthPersonalDescription',
    options: [
      'settings.healthCyclePersonalLabel',
      'settings.healthPreventionNotifyCaregiversLabel',
      'settings.healthVisibilityTitle',
    ],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-health.js'),
  },
  {
    id: 'options-health',
    sheetId: 'module-health',
    scope: 'household',
    labelKey: 'health.tabs.cycle',
    descriptionKey: 'settings.healthCycleHint',
    options: [
      'settings.healthCycleEnableLabel',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-options.js'),
    props: { part: 'health' },
  },
  {
    // Der Vorsorge-Typregister ist ein Haushaltskatalog ohne Voreinstellung (D2).
    id: 'modules-health',
    sheetId: 'module-health',
    scope: 'household',
    labelKey: 'settings.pageHealthModule',
    descriptionKey: 'settings.pageHealthModuleDescription',
    options: [
      'settings.healthPreventionTypesTitle',
    ],
    adminOnly: true,
    loader: () => import('/settings/pages/modules-health.js'),
  },
  // DIE EXPORTE STEHEN IM BLATT IHRES MODULS (R14, A7 P2-3). Oma Ingrid sucht
  // den Schichtplan-Export im Blatt Schichtplan, nicht unter Kalender. Jeder
  // Token haengt an der eigenen users-Zeile, keine Route traegt einen
  // Admin-Check (#770) - deshalb "Fuer mich". Inventar und Entsorgung hatten
  // kein Blatt; ihr Feed ist ihr erster Abschnitt.
  {
    id: 'feed-schedule',
    sheetId: 'module-schedule',
    scope: 'mine',
    labelKey: 'settings.scheduleFeedTitle',
    descriptionKey: 'settings.scheduleFeedDescription',
    options: [{ key: 'settings.scheduleFeedTitle', terms: ['ICS', 'iCal'] }],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
    props: { part: 'schedule' },
  },
  {
    id: 'feed-cycle',
    sheetId: 'module-health',
    scope: 'mine',
    labelKey: 'settings.cycleFeedTitle',
    descriptionKey: 'settings.cycleFeedDescription',
    options: [{ key: 'settings.cycleFeedTitle', terms: ['ICS', 'iCal'] }],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
    props: { part: 'cycle' },
  },
  {
    id: 'feed-inventory',
    sheetId: 'module-inventory',
    scope: 'mine',
    labelKey: 'settings.inventoryFeedTitle',
    descriptionKey: 'settings.inventoryFeedDescription',
    options: [{ key: 'settings.inventoryFeedTitle', terms: ['ICS', 'iCal'] }],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
    props: { part: 'inventory' },
  },
  {
    id: 'feed-waste',
    sheetId: 'module-waste',
    scope: 'mine',
    labelKey: 'settings.wasteFeedTitle',
    descriptionKey: 'settings.wasteFeedDescription',
    options: [{ key: 'settings.wasteFeedTitle', terms: ['ICS', 'iCal'] }],
    adminOnly: false,
    loader: () => import('/settings/pages/personal-feeds.js'),
    props: { part: 'waste' },
  },
]);

/**
 * DIE BLAETTER - was die Seitenleiste und die Wurzel zeigen und was der Router
 * als Route kennt (`SETTINGS_LEAVES.map(({ path }) => ...)`, router.js). Ein
 * Blatt hat keine eigenen Rechte: es ist sichtbar, sobald einer seiner
 * Abschnitte es ist. Die Abschnitte stehen in SETTINGS_SECTIONS (Reihenfolge
 * dort = Reihenfolge im Blatt, "Fuer mich" vor "Fuer den Haushalt").
 *
 * `module` macht ein Blatt zum Modulblatt: Markenfarbe (shell.js,
 * createLeafMark), Statuszeile des Moduls und die Scope-Ueberschriften.
 */
export const SETTINGS_LEAVES = freezeEntries([
  // Konto
  { id: 'personal-account', domainId: 'personal', path: '/settings/personal/account', labelKey: 'settings.pageAccount', descriptionKey: 'settings.pageAccountDescription', icon: 'circle-user' },
  { id: 'personal-appearance', domainId: 'personal', path: '/settings/personal/appearance', labelKey: 'settings.pageAppearance', descriptionKey: 'settings.pageAppearanceDescription', icon: 'palette' },
  { id: 'personal-device', domainId: 'personal', path: '/settings/personal/device', labelKey: 'settings.pageDevice', descriptionKey: 'settings.pageDeviceDescription', icon: 'smartphone' },
  { id: 'personal-notifications', domainId: 'personal', path: '/settings/personal/notifications', labelKey: 'settings.pageNotifications', descriptionKey: 'settings.pageNotificationsDescription', icon: 'bell' },
  { id: 'personal-weather', domainId: 'personal', path: '/settings/personal/weather', labelKey: 'settings.pageWeather', descriptionKey: 'settings.pageWeatherDescription', icon: 'cloud-sun' },
  // Haushalt
  { id: 'admin-family', domainId: 'admin', path: '/settings/admin/family', labelKey: 'settings.pageFamilyRoles', descriptionKey: 'settings.pageFamilyRolesDescription', icon: 'users' },
  { id: 'admin-permissions', domainId: 'admin', path: '/settings/admin/permissions', labelKey: 'settings.pagePermissions', descriptionKey: 'settings.pagePermissionsDescription', icon: 'shield-check' },
  { id: 'admin-displays', domainId: 'admin', path: '/settings/admin/displays', labelKey: 'settings.pageDisplays', descriptionKey: 'settings.pageDisplaysDescription', icon: 'tablet-smartphone' },
  { id: 'admin-email', domainId: 'admin', path: '/settings/admin/email', labelKey: 'settings.pageEmail', descriptionKey: 'settings.pageEmailDescription', icon: 'mail' },
  { id: 'admin-backup', domainId: 'admin', path: '/settings/admin/backup', labelKey: 'settings.pageBackupRestore', descriptionKey: 'settings.pageBackupRestoreDescription', icon: 'database-backup' },
  { id: 'admin-system', domainId: 'admin', path: '/settings/admin/system', labelKey: 'settings.pageSystem', descriptionKey: 'settings.pageSystemDescription', icon: 'info' },
  { id: 'admin-api', domainId: 'admin', path: '/settings/admin/api', labelKey: 'settings.pageApiAccess', descriptionKey: 'settings.pageApiAccessDescription', icon: 'key-round' },
  { id: 'admin-integrations', domainId: 'admin', path: '/settings/admin/integrations', labelKey: 'settings.pageIntegrations', descriptionKey: 'settings.pageIntegrationsDescription', icon: 'plug' },
  // Module - in der Reihenfolge der Seitenleiste ohne eigene Anordnung
  // (settingsSheetsForDomain sortiert nach Gruppe und Haushalts-Reihenfolge).
  { id: 'modules-active', domainId: 'modules', path: '/settings/modules/active', labelKey: 'settings.pageActiveModules', descriptionKey: 'settings.pageActiveModulesDescription', icon: 'toggle-right' },
  { id: 'modules-navigation', domainId: 'modules', path: '/settings/modules/navigation', labelKey: 'settings.pageNavigation', descriptionKey: 'settings.pageNavigationDescription', icon: 'panel-left' },
  { id: 'module-dashboard', domainId: 'modules', path: '/settings/modules/overview', labelKey: 'nav.dashboard', descriptionKey: 'settings.sheetDashboardDescription', icon: 'layout-dashboard', module: 'dashboard' },
  { id: 'module-calendar', domainId: 'modules', path: '/settings/modules/calendar', labelKey: 'nav.calendar', descriptionKey: 'settings.sheetCalendarDescription', icon: 'calendar', module: 'calendar' },
  { id: 'module-schedule', domainId: 'modules', path: '/settings/modules/schedule', labelKey: 'nav.schedule', descriptionKey: 'settings.sheetScheduleDescription', icon: 'calendar-clock', module: 'schedule' },
  { id: 'module-tasks', domainId: 'modules', path: '/settings/modules/tasks', labelKey: 'nav.tasks', descriptionKey: 'settings.sheetTasksDescription', icon: 'check-square', module: 'tasks' },
  { id: 'module-kitchen', domainId: 'modules', path: '/settings/modules/kitchen', labelKey: 'nav.kitchen', descriptionKey: 'settings.pageKitchenDescription', icon: 'utensils', module: 'kitchen' },
  { id: 'module-housekeeping', domainId: 'modules', path: '/settings/modules/housekeeping', labelKey: 'nav.housekeeping', descriptionKey: 'settings.sheetHousekeepingDescription', icon: 'paintbrush', module: 'housekeeping' },
  { id: 'module-waste', domainId: 'modules', path: '/settings/modules/waste', labelKey: 'nav.waste', descriptionKey: 'settings.sheetWasteDescription', icon: 'trash-2', module: 'waste' },
  { id: 'module-documents', domainId: 'modules', path: '/settings/modules/documents', labelKey: 'nav.documents', descriptionKey: 'settings.sheetDocumentsDescription', icon: 'folder-lock', module: 'documents' },
  { id: 'module-inventory', domainId: 'modules', path: '/settings/modules/inventory', labelKey: 'nav.inventory', descriptionKey: 'settings.sheetInventoryDescription', icon: 'package', module: 'inventory' },
  { id: 'module-rewards', domainId: 'modules', path: '/settings/modules/rewards', labelKey: 'nav.rewards', descriptionKey: 'settings.sheetRewardsDescription', icon: 'award', module: 'rewards' },
  { id: 'module-contacts', domainId: 'modules', path: '/settings/modules/contacts', labelKey: 'nav.contacts', descriptionKey: 'settings.pageSyncContactsDescription', icon: 'book-user', module: 'contacts' },
  { id: 'module-health', domainId: 'modules', path: '/settings/modules/health', labelKey: 'nav.health', descriptionKey: 'settings.sheetHealthDescription', icon: 'heart-pulse', module: 'health' },
  { id: 'module-budget', domainId: 'modules', path: '/settings/modules/budget', labelKey: 'nav.budget', descriptionKey: 'settings.sheetBudgetDescription', icon: 'wallet', module: 'budget' },
]);

/**
 * JEDE ADRESSE VON VOR R10 LEBT WEITER (S2). Blaetter, die 1:1 weiterleben,
 * behalten ihren Pfad und stehen hier nicht. Alles andere: altes Blatt ->
 * neues Blatt plus Abschnitt, an den die Shell springt (`?section=`; der
 * Router kennt keine `#`-Anker - sein Pfadvergleich endet am `?`).
 *
 * Mit darin: die Alt-Pfade aelterer Umbauten (Domaene `documents`,
 * `modules-dashboard`) - sie zeigen direkt aufs heutige Ziel, nicht auf einen
 * Zwischenstand. `/settings/modules/budget` und `/housekeeping` waren Alias
 * auf `modules-options` und sind jetzt wieder eigene Blaetter.
 */
const MOVED_SETTINGS_PATHS = Object.freeze({
  '/settings/personal/calendar': { path: '/settings/modules/calendar', section: 'personal-calendar' },
  '/settings/personal/calendar-subscriptions': { path: '/settings/modules/calendar', section: 'personal-calendar-subscriptions' },
  // Seit R14 aufgeteilt (A7 P2-3): eine mitgegebene Option folgt ihrem Feed
  // in das Blatt seines Moduls (`dissolved`, movedSettingsUrl).
  '/settings/personal/feeds': { path: '/settings/modules/calendar', section: 'personal-feeds', dissolved: true },
  '/settings/personal/tasks': { path: '/settings/modules/tasks', section: 'personal-tasks' },
  '/settings/personal/health': { path: '/settings/modules/health', section: 'personal-health' },
  '/settings/personal/navigation': { path: '/settings/modules/navigation', section: 'modules-navigation' },
  '/settings/modules/options': { path: '/settings/modules/budget', section: 'options-budget', dissolved: true },
  '/settings/modules/countdowns': { path: '/settings/modules/overview', section: 'modules-countdowns' },
  '/settings/sync/calendar': { path: '/settings/modules/calendar', section: 'sync-calendar' },
  '/settings/sync/contacts': { path: '/settings/modules/contacts', section: 'sync-contacts' },
  '/settings/sync/reminders': { path: '/settings/modules/tasks', section: 'sync-reminders' },
  '/settings/sync/storage': { path: '/settings/modules/documents', section: 'documents-storage' },
  '/settings/sync/dms': { path: '/settings/modules/documents', section: 'documents-dms' },
  '/settings/admin/weather': { path: '/settings/admin/integrations', section: 'admin-weather' },
  '/settings/admin/immich': { path: '/settings/admin/integrations', section: 'admin-immich' },
  // Aeltere Umbauten (Critique 2026-07-27).
  '/settings/documents/storage': { path: '/settings/modules/documents', section: 'documents-storage' },
  '/settings/documents/dms': { path: '/settings/modules/documents', section: 'documents-dms' },
  '/settings/modules/dashboard': { path: '/settings/admin/integrations', section: 'admin-weather' },
});

/**
 * AUSGEMUSTERTE OPTIONEN. Ein Suchtreffer traegt seine Option in der Adresse
 * (`?option=<key>`), und Lesezeichen von vor R10 leben weiter (S2). Gibt es
 * die Option nicht mehr, weil ihr Schalter in einem anderen Blatt aufging,
 * fuehrt die Adresse dorthin - egal, von welchem Blatt sie kommt. Sonst
 * landete der Link auf seinem alten Blatt, ohne die Option und ohne Hinweis.
 */
const RETIRED_SETTINGS_OPTIONS = Object.freeze({
  // Der zweite An/Aus neben Aktive Module (A7 P1-3): an und aus geht ein
  // Modul nur dort.
  'settings.rewardsEnableLabel': { path: '/settings/modules/active', section: 'modules-active' },
});

/**
 * Die Sessions-Tabs von vor dem Blatt-Umbau (2026-06). Historisch: Tab-Name ->
 * Blatt von damals; `currentSettingsPath` hebt es aufs heutige Ziel.
 */
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

const isAdminUser = (user) => user?.role === 'admin';

function sectionVisible(section, user) {
  return !section.adminOnly || isAdminUser(user);
}

/** Die Abschnitte eines Blatts in Anzeigereihenfolge: erst "Fuer mich", dann der Haushalt. */
export function settingsSheetSections(sheet, user = null, { all = false } = {}) {
  const sections = SETTINGS_SECTIONS.filter((section) => section.sheetId === sheet?.id
    && (all || sectionVisible(section, user)));
  return SETTINGS_SCOPES.flatMap((scope) => sections.filter((section) => section.scope === scope));
}

function sheetVisible(sheet, user) {
  return settingsSheetSections(sheet, user).length > 0;
}

/* DIE MODULBLAETTER FOLGEN DER SEITENLEISTE (R14, A7 P3). Sie standen in
 * der Reihenfolge dieser Datei - Budget vor Gesundheit, Kontakte vor
 * Dokumenten -, waehrend die Seitenleiste daneben Gruppen und die Anordnung
 * des Haushalts zeigt. Dieselbe Sortierung wie dort (sortNavigationItems:
 * Gruppe, dann die gewaehlte Reihenfolge), dieselbe Quelle (der Router haelt
 * sie, `window.yuvomi.moduleOrder`). Ohne Router (Tests) gilt die Reihenfolge
 * dieser Datei innerhalb der Gruppen. */
function currentModuleOrder() {
  try {
    return globalThis.window?.yuvomi?.moduleOrder?.() ?? [];
  } catch {
    return [];
  }
}

/** Die Blaetter eines Bereichs, die diese Rolle sieht. */
export function settingsSheetsForDomain(domainId, user, { moduleOrder = currentModuleOrder() } = {}) {
  const sheets = SETTINGS_LEAVES.filter((sheet) => sheet.domainId === domainId && sheetVisible(sheet, user));
  if (!sheets.some((sheet) => sheet.module)) return sheets;
  return [
    ...sheets.filter((sheet) => !sheet.module),
    ...sortNavigationItems(sheets.filter((sheet) => sheet.module), moduleOrder),
  ];
}

export function filterSettingsDomains(user) {
  return SETTINGS_DOMAINS.filter((domain) => (isAdminUser(user) || !domain.adminOnly)
    && settingsSheetsForDomain(domain.id, user).length > 0);
}

/**
 * Die verschobenen Alt-Pfade. Der Router muss sie als Routen kennen, sonst
 * matcht ein direkter Aufruf (Bookmark, geteilter Link) ueberhaupt nichts und
 * die Umleitung kaeme nie zum Zug.
 */
export const RENAMED_SETTINGS_SOURCE_PATHS = Object.freeze(Object.keys(MOVED_SETTINGS_PATHS));

/** Loest einen verschobenen Pfad auf sein heutiges Blatt auf; sonst unveraendert. */
export function currentSettingsPath(path) {
  return MOVED_SETTINGS_PATHS[path]?.path ?? path;
}

/** Der Abschnitt, auf den ein Alt-Pfad zeigt (oder null). */
export function movedSettingsSection(path) {
  return MOVED_SETTINGS_PATHS[path]?.section ?? null;
}

/**
 * Die volle neue Adresse eines Alt-Pfads: Blatt + `?section=`, die uebrigen
 * Parameter (OAuth-Ergebnis, `?option=`) bleiben. Ein aufgeloestes Blatt
 * (`modules-options`) folgt einer mitgegebenen Option in den Abschnitt, der sie
 * heute fuehrt - der Suchtreffer von gestern landet an der richtigen Stelle.
 * Eine ausgemusterte Option (RETIRED_SETTINGS_OPTIONS) fuehrt auch von einem
 * lebenden Blatt weg, an den Ort, der sie heute traegt; sie selbst faellt aus
 * der Adresse.
 *
 * @param {string} path
 * @param {URLSearchParams|string} [search]
 * @returns {string|null} null, wenn weder Pfad noch Option verschoben sind
 */
export function movedSettingsUrl(path, search = '') {
  const params = new URLSearchParams(search);
  const option = params.get('option');
  const retired = option ? RETIRED_SETTINGS_OPTIONS[option] : null;
  const moved = MOVED_SETTINGS_PATHS[path];
  if (!moved && !retired) return null;
  let target = retired ?? moved;
  if (retired) params.delete('option');
  else if (moved.dissolved && option) {
    const owner = SETTINGS_SECTIONS.find((section) => (section.options ?? [])
      .some((entry) => (typeof entry === 'string' ? entry : entry.key) === option));
    const sheet = owner && SETTINGS_LEAVES.find((entry) => entry.id === owner.sheetId);
    if (sheet) target = { path: sheet.path, section: owner.id };
  }
  params.delete('section');
  const rest = params.toString();
  return `${target.path}?section=${encodeURIComponent(target.section)}${rest ? `&${rest}` : ''}`;
}

export function findSettingsLeaf(path, user) {
  const target = currentSettingsPath(path);
  const sheet = SETTINGS_LEAVES.find((entry) => entry.path === target);
  if (!sheet || !sheetVisible(sheet, user)) return null;
  return sheet;
}

export function settingsOverviewUrl(domainId = null) {
  return domainId
    ? `/settings?view=domain&domain=${encodeURIComponent(domainId)}`
    : '/settings?view=domains';
}

/** Adresse eines Abschnitts in seinem Blatt. */
export function settingsSectionUrl(sheet, sectionId) {
  return `${sheet.path}?section=${encodeURIComponent(sectionId)}`;
}

/**
 * Das Blatt, das am Desktop vorgewaehlt wird, wenn die Adresse keines nennt
 * (S3): das erste sichtbare des gewuenschten Bereichs, sonst das erste
 * ueberhaupt.
 */
export function firstSettingsSheet(user, domainId = null) {
  const domains = filterSettingsDomains(user);
  const domain = domains.find((entry) => entry.id === domainId) ?? domains[0];
  return domain ? settingsSheetsForDomain(domain.id, user)[0] ?? null : null;
}

export function resolveSettingsDestination(path, user, storedPath) {
  if (path !== '/settings') return findSettingsLeaf(path, user)?.path ?? '/settings/personal/account';
  return findSettingsLeaf(storedPath, user)?.path ?? '/settings/personal/account';
}

export function migrateLegacySettingsTab(value) {
  const legacy = LEGACY_SETTINGS_PATHS[value];
  // Die Tabelle bleibt historisch (Tab-Name -> Blatt von damals); dass ein Blatt
  // seither weitergezogen ist, weiss nur `currentSettingsPath`.
  return legacy ? currentSettingsPath(legacy) : null;
}

export function readStoredSettingsDestination(user, storage = sessionStorage) {
  const current = storage.getItem(SETTINGS_STORAGE_KEY);
  // Den kanonischen Pfad zurueckgeben, nicht den gespeicherten: ein vor dem
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
  // hat kein "zuletzt besuchtes Blatt" (Critique 2026-07-27). Der Aufrufer
  // entscheidet (mobil die Uebersicht, am Desktop das erste Blatt).
  return null;
}

/**
 * Vergleichsform der Suche: Kleinschreibung, Diakritika weg, damit "wetter"
 * auch "Wetter" findet und "prazdniny" auch "prázdniny".
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
 * Stichwortsuche ueber Blaetter, ihre Abschnitte UND deren einzelne Optionen -
 * die EINE Suche der Einstellungen, von der Wurzel (Kopf-Suche) und der
 * Seitenleiste gleich benutzt. Rein und ohne DOM: `translate` kommt vom
 * Aufrufer (im Browser `t`, im Test das de-Locale).
 *
 * Ein Blatt trifft ueber Titel, Beschreibung und Bereich; ein Abschnitt ueber
 * den Namen und die Beschreibung des frueheren Blatts ("Feed-Abos"), sofern er
 * nicht schon ueber sein Blatt trifft; eine Option ueber ihre Beschriftung,
 * ihre `also`-Schluessel und ihre `terms`.
 *
 * @param {string} query
 * @param {{ user?: object, translate: (key: string) => string }} opts
 * @returns {{ leaves: object[], sections: { leaf: object, section: object, label: string }[],
 *   options: { leaf: object, section: object, key: string, label: string }[] }}
 */
export function searchSettings(query, { user, translate }) {
  const needle = normalizeSettingsSearch(String(query ?? '').trim());
  if (!needle) return { leaves: [], sections: [], options: [] };
  const domainLabels = new Map(filterSettingsDomains(user).map((domain) => [domain.id, translate(domain.labelKey)]));
  const visible = SETTINGS_LEAVES.filter((leaf) => domainLabels.has(leaf.domainId) && sheetVisible(leaf, user));
  const hit = (text) => normalizeSettingsSearch(text).includes(needle);

  const leaves = visible.filter((leaf) => hit(
    `${translate(leaf.labelKey)} ${translate(leaf.descriptionKey)} ${domainLabels.get(leaf.domainId)}`,
  ));
  const leafIds = new Set(leaves.map((leaf) => leaf.id));

  const sections = [];
  const options = [];
  for (const leaf of visible) {
    for (const section of settingsSheetSections(leaf, user)) {
      const label = translate(section.labelKey);
      // Ein Abschnitt, der sein Blatt IST (Konto, Haushalt), traegt denselben
      // Namen - der Treffer staende doppelt da.
      if (!leafIds.has(leaf.id) && section.id !== leaf.id
        && hit(`${label} ${translate(section.descriptionKey)}`)) {
        sections.push({ leaf, section, label });
      }
      for (const option of (section.options ?? []).map(optionEntry)) {
        const optionLabel = translate(option.key);
        const haystack = [optionLabel, ...option.also.map(translate), ...option.terms].join(' ');
        if (hit(haystack)) options.push({ leaf, section, key: option.key, label: optionLabel });
      }
    }
  }
  return { leaves, sections, options };
}

/** Sprungziel eines Options-Treffers: das Blatt, mit der Option als Anker. */
export function settingsOptionUrl(leaf, key) {
  return `${leaf.path}?option=${encodeURIComponent(key)}`;
}
