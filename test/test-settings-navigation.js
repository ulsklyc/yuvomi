import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_DOMAINS,
  SETTINGS_LEAVES,
  SETTINGS_STORAGE_KEY,
  filterSettingsDomains,
  findSettingsLeaf,
  migrateLegacySettingsTab,
  readStoredSettingsDestination,
  resolveSettingsDestination,
  settingsOverviewUrl,
} from '../public/settings/registry.js';
import {
  DEFAULT_MOBILE_NAV_ORDER,
  KITCHEN_CHILD_IDS,
  NAV_SECTION,
  expandModuleOrder,
  groupBuiltInModules,
  moduleSection,
  normalizeModuleOrder,
  normalizeMobileNavOrder,
  resolveMobileNavOrder,
  sortNavigationItems,
} from '../public/settings/module-order.js';
import {
  applyHolidaySubdivisionSelection,
  ensureHolidayLayerSelection,
  isHolidayCountryResolved,
  resolveHolidayLocation,
  runHolidayDiscovery,
  shouldApplySubdivisionResponse,
} from '../public/settings/pages/modules-calendar.js';
import {
  persistCurrencySelection,
  SUPPORTED_CURRENCIES,
} from '../public/settings/currency.js';
import {
  isConnectedWeatherControl,
} from '../public/settings/pages/modules-dashboard.js';
import {
  persistMealTypeSelection,
} from '../public/settings/pages/modules-kitchen.js';
import {
  buildMobileNavigationPayload,
  buildNavigationPayload,
  persistModuleToggle,
} from '../public/settings/pages/modules-navigation.js';

const member = { role: 'member' };
const admin = { role: 'admin' };
const registryTranslationKeys = [
  ...SETTINGS_DOMAINS.map((domain) => domain.labelKey),
  ...SETTINGS_LEAVES.flatMap((leaf) => [leaf.labelKey, leaf.descriptionKey]),
];
const sharedTranslationKeys = [
  'settings.navigationLabel',
  'settings.mobileOverviewTitle',
  'settings.mobileOverviewDescription',
  'settings.mobileDomainTitle',
  'settings.breadcrumbLabel',
  'settings.backToSettings',
  'settings.retry',
  'settings.loadError',
  'settings.accessRedirected',
  'settings.moreProviders',
  'settings.providerSpecific',
  'settings.legacy',
  'settings.appleLegacyHint',
  'settings.documentBackupWarning',
  'settings.kitchenActiveCount',
  'settings.enabledCalendarCount',
  'settings.lastSyncValue',
  'settings.neverSynced',
  'settings.mobileNavigationTitle',
  'settings.mobileNavigationHint',
  'settings.mobileNavigationSlotLabel',
  'settings.mobileNavigationSaved',
  'settings.desktopNavigationTitle',
  'settings.desktopNavigationHint',
  'nav.sectionOverview',
  'nav.sectionPlan',
  'nav.sectionHome',
  'shopping.manageCategories',
];
const settingsTranslationKeys = [...new Set([...registryTranslationKeys, ...sharedTranslationKeys])];

function getTranslation(locale, key) {
  return key.split('.').reduce((value, segment) => value?.[segment], locale);
}

test('settings leaves have unique IDs and paths', () => {
  assert.equal(SETTINGS_LEAVES.length, 20);
  assert.equal(new Set(SETTINGS_LEAVES.map((leaf) => leaf.id)).size, SETTINGS_LEAVES.length);
  assert.equal(new Set(SETTINGS_LEAVES.map((leaf) => leaf.path)).size, SETTINGS_LEAVES.length);
});

test('settings registry is immutable', () => {
  assert.equal(Object.isFrozen(SETTINGS_DOMAINS), true);
  assert.equal(Object.isFrozen(SETTINGS_LEAVES), true);
  assert.equal(SETTINGS_DOMAINS.every(Object.isFrozen), true);
  assert.equal(SETTINGS_LEAVES.every(Object.isFrozen), true);
});

test('personal settings leaf modules import without browser globals', async () => {
  const modules = await Promise.all([
    import('/settings/pages/personal-account.js'),
    import('/settings/pages/personal-appearance.js'),
    import('/settings/pages/personal-device.js'),
  ]);

  for (const module of modules) {
    assert.equal(typeof module.render, 'function');
  }
});

test('settings reuse the authenticated router user instead of blocking on auth.me', async () => {
  const source = await readFile(
    new URL('../public/pages/settings.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /async function refreshUser\(user\) \{\s*if \(user\) return user;/,
    'settings should only refresh auth when the router did not provide a user',
  );
});

test('navigation settings leaf imports without browser globals and exports render', async () => {
  const module = await import('/settings/pages/modules-navigation.js');
  assert.equal(typeof module.render, 'function');
});

test('navigation settings leaf reuses the canonical module-order helpers', async () => {
  const source = await readFile(
    new URL('../public/settings/pages/modules-navigation.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /normalizeModuleOrder/);
  assert.match(source, /expandModuleOrder/);
  assert.match(source, /sortNavigationItems/);
  assert.match(source, /resolveMobileNavOrder/);
  assert.match(source, /from\s*'\/settings\/module-order\.js'/);
});

test('navigation settings expose separate mobile slots and grouped desktop lists', async () => {
  const source = await readFile(
    new URL('../public/settings/pages/modules-navigation.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /data-mobile-nav-slot/);
  assert.match(source, /data-module-section/);
  assert.match(source, /window\.oikos\?\.setMobileNavOrder/);
});

test('members only see the personal settings domain', () => {
  assert.deepEqual(filterSettingsDomains(member).map((domain) => domain.id), ['personal']);
});

test('admins see all settings domains', () => {
  assert.deepEqual(
    filterSettingsDomains(admin).map((domain) => domain.id),
    ['personal', 'modules', 'sync', 'documents', 'admin'],
  );
});

test('legacy settings tabs migrate to their new destinations', () => {
  assert.equal(migrateLegacySettingsTab('general'), '/settings/personal/appearance');
  assert.equal(migrateLegacySettingsTab('shopping'), '/shopping?manage=categories');
  assert.equal(migrateLegacySettingsTab('sync'), '/settings/sync/calendar');
  assert.equal(migrateLegacySettingsTab('backup'), '/settings/admin/backup');
});

test('legacy settings migration covers every previous tab', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['general', 'meals', 'budget', 'shopping', 'calendar', 'sync', 'account', 'family', 'api-tokens', 'backup']
        .map((tab) => [tab, migrateLegacySettingsTab(tab)]),
    ),
    {
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
    },
  );
});

test('findSettingsLeaf enforces role access', () => {
  assert.equal(findSettingsLeaf('/settings/admin/system', member), null);
  assert.equal(findSettingsLeaf('/settings/admin/system', admin)?.id, 'admin-system');
});

test('settingsOverviewUrl builds the settings domains overview URL', () => {
  assert.equal(settingsOverviewUrl(), '/settings?view=domains');
});

test('settingsOverviewUrl builds an encoded domain overview URL', () => {
  assert.equal(
    settingsOverviewUrl('sync'),
    '/settings?view=domain&domain=sync',
  );
});

test('resolveSettingsDestination restores an allowed stored leaf at the settings root', () => {
  assert.equal(
    resolveSettingsDestination('/settings', admin, '/settings/documents/storage'),
    '/settings/documents/storage',
  );
});

test('resolveSettingsDestination falls back when a stored leaf is invalid or forbidden', () => {
  assert.equal(
    resolveSettingsDestination('/settings', member, '/settings/admin/system'),
    '/settings/personal/account',
  );
  assert.equal(
    resolveSettingsDestination('/settings', member, '/settings/unknown'),
    '/settings/personal/account',
  );
});

test('resolveSettingsDestination preserves a directly allowed leaf', () => {
  assert.equal(
    resolveSettingsDestination('/settings/personal/device', member),
    '/settings/personal/device',
  );
});

test('resolveSettingsDestination falls back from an unknown direct settings path', () => {
  assert.equal(
    resolveSettingsDestination('/settings/not-a-page', admin),
    '/settings/personal/account',
  );
});

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    has: (key) => map.has(key),
    get size() {
      return map.size;
    },
  };
}

test('readStoredSettingsDestination restores a valid stored leaf', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/documents/storage' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/documents/storage');
});

test('readStoredSettingsDestination falls back to account for an invalid stored leaf', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/not-a-page' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/personal/account');
});

test('readStoredSettingsDestination ignores a stored admin leaf for a member', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/admin/system' });
  assert.equal(readStoredSettingsDestination(member, storage), '/settings/personal/account');
});

test('readStoredSettingsDestination removes the legacy key only after a successful migration', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'backup' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/admin/backup');
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), false);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), '/settings/admin/backup');
});

test('readStoredSettingsDestination keeps an unmigratable legacy key in place', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'totally-unknown' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/personal/account');
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), true);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
});

test('readStoredSettingsDestination does not persist a migration that leaves Settings', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'shopping' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/shopping?manage=categories');
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), false);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
});

test('readStoredSettingsDestination defaults to account when storage is empty', () => {
  const storage = createMemoryStorage();
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/personal/account');
});

test('every approved settings leaf is registered as an exact SPA route', async () => {
  const source = await readFile(
    new URL('../public/router.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /import\s*\{\s*SETTINGS_LEAVES\s*\}\s*from\s*'\/settings\/registry\.js'/);
  assert.match(
    source,
    /SETTINGS_LEAVES\.map\(\(\{\s*path\s*\}\)\s*=>\s*\(\{\s*path,\s*page:\s*'\/pages\/settings\.js',\s*requiresAuth:\s*true,\s*module:\s*'settings'\s*\}\)\)/,
  );
});

test('the live Settings controller contains no page-specific endpoint strings', async () => {
  const source = await readFile(
    new URL('../public/pages/settings.js', import.meta.url),
    'utf8',
  );
  const forbiddenEndpoints = [
    '/preferences',
    '/auth/api-tokens',
    '/auth/me/password',
    '/calendar/google',
    '/calendar/apple',
    '/calendar/caldav',
    '/calendar/subscriptions',
    '/contacts/cardav',
    '/documents/dms',
    '/shopping/categories',
    '/modules?admin=1',
  ];
  for (const endpoint of forbiddenEndpoints) {
    assert.equal(
      source.includes(endpoint),
      false,
      `controller must not reference endpoint ${endpoint}`,
    );
  }
});

test('the former Shopping category tab and handlers are absent from Settings', async () => {
  const source = await readFile(
    new URL('../public/pages/settings.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /data-panel="shopping"/);
  assert.doesNotMatch(source, /CATEGORY_I18N/);
  assert.doesNotMatch(source, /catLabel/);
});

test('the Settings controller delegates to the shell instead of rendering tab panels', async () => {
  const source = await readFile(
    new URL('../public/pages/settings.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /renderSettingsShell/);
  assert.match(source, /readStoredSettingsDestination/);
  assert.doesNotMatch(source, /settings-tab-panel/);
  assert.doesNotMatch(source, /settings-nav\.js/);
});

test('the Settings controller forces a full shell render when the locale changes', async () => {
  const source = await readFile(
    new URL('../public/pages/settings.js', import.meta.url),
    'utf8',
  );
  // Locale muss aus i18n importiert und beim Mount sowie im Soft-Update verglichen
  // werden, damit ein Sprachwechsel die Sidebar/den Seitenkopf nicht stale lässt.
  assert.match(source, /import\s*\{\s*getLocale\s*\}\s*from\s*'\/i18n\.js'/);
  assert.match(source, /renderedLocale\s*=\s*getLocale\(\)/);
  assert.match(source, /const\s+localeChanged\s*=\s*renderedLocale\s*!==\s*currentLocale/);
  // Beide Soft-Update-Pfade dürfen bei Sprachwechsel nicht inkrementell rendern.
  assert.doesNotMatch(source, /incremental:\s*true/);
  const incrementalFlags = source.match(/incremental:\s*!localeChanged/g) ?? [];
  assert.equal(incrementalFlags.length, 2);
});

test('Kitchen child IDs use the canonical order', () => {
  assert.deepEqual(KITCHEN_CHILD_IDS, ['meals', 'recipes', 'shopping']);
  assert.equal(Object.isFrozen(KITCHEN_CHILD_IDS), true);
});

test('groupBuiltInModules enables Kitchen while any child is enabled', () => {
  const modules = groupBuiltInModules(['recipes']);
  const kitchen = modules.find((module) => module.id === 'kitchen');

  assert.deepEqual(kitchen.children, [
    { id: 'meals', enabled: true },
    { id: 'recipes', enabled: false },
    { id: 'shopping', enabled: true },
  ]);
  assert.equal(kitchen.enabledChildren, 2);
  assert.equal(kitchen.enabled, true);
});

test('groupBuiltInModules disables Kitchen when every child is disabled', () => {
  const [kitchen] = groupBuiltInModules(['meals', 'recipes', 'shopping']);

  assert.equal(kitchen.id, 'kitchen');
  assert.equal(kitchen.enabledChildren, 0);
  assert.equal(kitchen.enabled, false);
});

test('groupBuiltInModules replaces Kitchen children at their first definition position', () => {
  const calendar = { id: 'calendar', icon: 'calendar-days', enabled: false };
  const recipes = { id: 'recipes', icon: 'book-text' };
  const tasks = { id: 'tasks', icon: 'list-checks', custom: true };
  const meals = { id: 'meals', icon: 'utensils' };
  const shopping = { id: 'shopping', icon: 'shopping-cart' };

  const modules = groupBuiltInModules([], [calendar, recipes, tasks, meals, shopping]);

  assert.deepEqual(modules.map((module) => module.id), ['calendar', 'kitchen', 'tasks']);
  assert.equal(modules[0], calendar);
  assert.equal(modules[2], tasks);
});

test('groupBuiltInModules replaces an explicit Kitchen definition in place', () => {
  const calendar = { id: 'calendar', icon: 'calendar-days', enabled: false };
  const kitchen = { id: 'kitchen', icon: 'utensils', legacy: true };
  const tasks = { id: 'tasks', icon: 'list-checks', custom: true };

  const modules = groupBuiltInModules([], [calendar, kitchen, tasks]);

  assert.deepEqual(modules.map((module) => module.id), ['calendar', 'kitchen', 'tasks']);
  assert.equal(modules[0], calendar);
  assert.equal(modules[2], tasks);
  assert.notEqual(modules[1], kitchen);
});

test('normalizeModuleOrder replaces legacy Kitchen children with one Kitchen position', () => {
  assert.deepEqual(
    normalizeModuleOrder(['calendar', 'recipes', 'tasks', 'shopping', 'meals']),
    ['calendar', 'kitchen', 'tasks'],
  );
});

test('expandModuleOrder restores canonical Kitchen children', () => {
  assert.deepEqual(
    expandModuleOrder(['calendar', 'kitchen', 'tasks']),
    ['calendar', 'meals', 'recipes', 'shopping', 'tasks'],
  );
});

test('module order helpers handle empty orders', () => {
  assert.deepEqual(normalizeModuleOrder(), []);
  assert.deepEqual(expandModuleOrder([]), []);
});

test('module order helpers deduplicate repeated Kitchen children', () => {
  const order = ['meals', 'recipes', 'meals', 'shopping', 'recipes'];

  assert.deepEqual(normalizeModuleOrder(order), ['kitchen']);
  assert.deepEqual(expandModuleOrder(order), ['meals', 'recipes', 'shopping']);
});

test('explicit Kitchen and legacy children produce one Kitchen position', () => {
  const order = ['calendar', 'kitchen', 'recipes', 'tasks', 'shopping', 'meals'];

  assert.deepEqual(normalizeModuleOrder(order), ['calendar', 'kitchen', 'tasks']);
  assert.deepEqual(
    expandModuleOrder(order),
    ['calendar', 'meals', 'recipes', 'shopping', 'tasks'],
  );
});

test('module order helpers preserve stable unique non-Kitchen IDs', () => {
  const order = ['tasks', 'calendar', 'tasks', 'recipes', 'notes', 'calendar', 'shopping'];

  assert.deepEqual(normalizeModuleOrder(order), ['tasks', 'calendar', 'kitchen', 'notes']);
  assert.deepEqual(
    expandModuleOrder(order),
    ['tasks', 'calendar', 'meals', 'recipes', 'shopping', 'notes'],
  );
});

test('navigation sections match the grouped desktop information architecture', () => {
  assert.equal(moduleSection('dashboard'), NAV_SECTION.overview);
  assert.equal(moduleSection('calendar'), NAV_SECTION.plan);
  assert.equal(moduleSection('tasks'), NAV_SECTION.plan);
  assert.equal(moduleSection('notes'), NAV_SECTION.plan);
  assert.equal(moduleSection('kitchen'), NAV_SECTION.home);
  assert.equal(moduleSection('contacts'), NAV_SECTION.home);
  assert.equal(moduleSection('third-party-weather-station'), NAV_SECTION.home);
  assert.equal(moduleSection('settings'), NAV_SECTION.home);
});

test('desktop navigation order is applied only inside each section', () => {
  const items = [
    { module: 'contacts' },
    { module: 'calendar' },
    { module: 'dashboard' },
    { module: 'budget' },
    { module: 'notes' },
    { module: 'tasks' },
    { module: 'settings' },
  ];

  assert.deepEqual(
    sortNavigationItems(items, ['budget', 'tasks', 'contacts', 'calendar', 'notes']),
    [
      { module: 'dashboard' },
      { module: 'tasks' },
      { module: 'calendar' },
      { module: 'notes' },
      { module: 'budget' },
      { module: 'contacts' },
      { module: 'settings' },
    ],
  );
});

test('mobile navigation defaults to Calendar, Tasks, and Kitchen', () => {
  assert.deepEqual(DEFAULT_MOBILE_NAV_ORDER, ['calendar', 'tasks', 'kitchen']);
});

test('mobile navigation normalization deduplicates Kitchen aliases and limits favorites', () => {
  assert.deepEqual(
    normalizeMobileNavOrder(['recipes', 'tasks', 'meals', 'calendar', 'notes']),
    ['kitchen', 'tasks', 'calendar'],
  );
  assert.deepEqual(
    normalizeMobileNavOrder(['dashboard', 'settings', 'notes', 'budget']),
    ['notes', 'budget'],
  );
});

test('mobile navigation fills unavailable favorites from defaults and remaining destinations', () => {
  assert.deepEqual(
    resolveMobileNavOrder(
      ['notes', 'budget', 'contacts'],
      ['calendar', 'tasks', 'kitchen', 'notes', 'budget'],
    ),
    ['notes', 'budget', 'calendar'],
  );
  assert.deepEqual(
    resolveMobileNavOrder(
      ['notes', 'budget', 'contacts'],
      ['tasks', 'kitchen'],
    ),
    ['tasks', 'kitchen'],
  );
});

test('stale holiday subdivision responses are rejected', () => {
  assert.equal(shouldApplySubdivisionResponse({
    requestId: 1,
    latestRequestId: 2,
    requestedCountry: 'DE',
    currentCountry: 'AT',
  }), false);
  assert.equal(shouldApplySubdivisionResponse({
    requestId: 2,
    latestRequestId: 2,
    requestedCountry: 'AT',
    currentCountry: 'AT',
  }), true);
});

test('holiday location preserves persisted values until discovery is ready', () => {
  assert.deepEqual(resolveHolidayLocation({
    countryReady: false,
    subdivisionReady: false,
    selectedCountry: '',
    selectedSubdivision: '',
    persistedCountry: 'DE',
    persistedSubdivision: 'DE-BY',
  }), {
    country: 'DE',
    subdivision: 'DE-BY',
  });

  assert.deepEqual(resolveHolidayLocation({
    countryReady: true,
    subdivisionReady: false,
    selectedCountry: 'DE',
    selectedSubdivision: '',
    persistedCountry: 'DE',
    persistedSubdivision: 'DE-BY',
  }), {
    country: 'DE',
    subdivision: 'DE-BY',
  });
});

test('holiday sync enables public holidays when every layer is disabled', () => {
  assert.deepEqual(ensureHolidayLayerSelection({
    showPublic: false,
    showSchool: false,
  }), {
    showPublic: true,
    showSchool: false,
  });
  assert.deepEqual(ensureHolidayLayerSelection({
    showPublic: false,
    showSchool: true,
  }), {
    showPublic: false,
    showSchool: true,
  });
});

test('holiday country remains unresolved until discovery contains the persisted value', () => {
  assert.equal(isHolidayCountryResolved([], 'DE'), false);
  assert.equal(isHolidayCountryResolved([{ isoCode: 'AT' }], 'DE'), false);
  assert.equal(isHolidayCountryResolved([{ isoCode: 'DE' }], 'DE'), true);
  assert.equal(isHolidayCountryResolved([], null), true);
});

test('holiday subdivision replacement resolves an incomplete discovery selection', () => {
  const discoveryState = {
    countryReady: true,
    subdivisionReady: false,
    persistedCountry: 'DE',
    persistedSubdivision: 'DE-BY',
  };
  assert.deepEqual(resolveHolidayLocation({
    ...discoveryState,
    selectedCountry: 'DE',
    selectedSubdivision: 'DE-HE',
  }), {
    country: 'DE',
    subdivision: 'DE-BY',
  });

  applyHolidaySubdivisionSelection(discoveryState);

  assert.deepEqual(resolveHolidayLocation({
    ...discoveryState,
    selectedCountry: 'DE',
    selectedSubdivision: 'DE-HE',
  }), {
    country: 'DE',
    subdivision: 'DE-HE',
  });
  assert.deepEqual(resolveHolidayLocation({
    ...discoveryState,
    selectedCountry: 'DE',
    selectedSubdivision: '',
  }), {
    country: 'DE',
    subdivision: null,
  });
});

test('holiday discovery failures stay local to the calendar leaf', async () => {
  const errors = [];
  const result = await runHolidayDiscovery(
    async () => {
      throw new Error('discovery failed');
    },
    (error) => errors.push(error.message),
  );

  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.deepEqual(errors, ['discovery failed']);
});

test('Kitchen persistence disables controls and restores the saved selection on failure', async () => {
  const inputs = [
    { value: 'breakfast', checked: false, disabled: false },
    { value: 'lunch', checked: true, disabled: false },
  ];
  let rejectSave;
  const save = new Promise((resolve, reject) => {
    void resolve;
    rejectSave = reject;
  });
  const persistence = persistMealTypeSelection(
    inputs,
    ['lunch'],
    ['breakfast'],
    () => save,
  );

  assert.equal(inputs.every((input) => input.disabled), true);
  rejectSave(new Error('save failed'));
  await assert.rejects(persistence, /save failed/);
  assert.deepEqual(inputs.map(({ checked }) => checked), [true, false]);
  assert.equal(inputs.every((input) => !input.disabled), true);
});

test('Budget persistence restores the previous currency on failure', async () => {
  const select = { value: 'USD', disabled: false };
  const persistence = persistCurrencySelection(
    select,
    'EUR',
    async () => {
      assert.equal(select.disabled, true);
      throw new Error('save failed');
    },
  );

  await assert.rejects(persistence, /save failed/);
  assert.equal(select.value, 'EUR');
  assert.equal(select.disabled, false);
});

test('Budget currency options match the existing preferences API contract', async () => {
  const source = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  const declaration = source.match(/const VALID_CURRENCIES = \[([^\]]+)\]/);
  assert.ok(declaration, 'preferences route must declare VALID_CURRENCIES');
  const backendCurrencies = [...declaration[1].matchAll(/'([A-Z]{3})'/g)]
    .map((match) => match[1]);

  assert.deepEqual(SUPPORTED_CURRENCIES, backendCurrencies);
});

test('weather geolocation callbacks only update the active leaf', () => {
  assert.equal(
    isConnectedWeatherControl({ isConnected: true }, { isConnected: true }),
    true,
  );
  assert.equal(
    isConnectedWeatherControl({ isConnected: false }, { isConnected: true }),
    false,
  );
  assert.equal(
    isConnectedWeatherControl({ isConnected: true }, { isConnected: false }),
    false,
  );
});

test('buildNavigationPayload expands the visible order back to canonical Kitchen children', () => {
  const payload = buildNavigationPayload(
    ['notes'],
    new Set(['meals', 'recipes', 'shopping']),
    ['calendar', 'tasks', 'kitchen', 'notes'],
  );

  assert.deepEqual(payload, {
    disabled_modules: ['notes'],
    module_order: ['calendar', 'tasks', 'meals', 'recipes', 'shopping', 'notes'],
  });
});

test('buildNavigationPayload yields an empty module order for an empty visible order', () => {
  const payload = buildNavigationPayload([], new Set(['meals', 'recipes', 'shopping']), []);

  assert.deepEqual(payload, { disabled_modules: [], module_order: [] });
});

test('buildNavigationPayload keeps the single Kitchen position when expanding', () => {
  const payload = buildNavigationPayload([], new Set(KITCHEN_CHILD_IDS), ['kitchen']);

  assert.deepEqual(payload.module_order, ['meals', 'recipes', 'shopping']);
});

test('buildNavigationPayload disables Kitchen children that are not enabled', () => {
  const payload = buildNavigationPayload(
    ['budget'],
    new Set(['meals']),
    ['kitchen', 'budget'],
  );

  assert.deepEqual(payload.disabled_modules, ['budget', 'recipes', 'shopping']);
  assert.deepEqual(payload.module_order, ['meals', 'recipes', 'shopping', 'budget']);
});

test('buildMobileNavigationPayload normalizes aliases, duplicates, and slot count', () => {
  assert.deepEqual(
    buildMobileNavigationPayload(['recipes', 'tasks', 'meals', 'calendar', 'budget']),
    { mobile_nav_order: ['kitchen', 'tasks', 'calendar'] },
  );
});

test('persistModuleToggle restores the toggle and re-enables it when saving fails', async () => {
  const input = { checked: true, disabled: true };
  let rerendered = false;

  await assert.rejects(
    persistModuleToggle(input, true, async () => {
      throw new Error('save failed');
    }, async () => {
      rerendered = true;
    }),
    /save failed/,
  );

  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.equal(rerendered, false);
});

test('persistModuleToggle re-renders only after a successful save', async () => {
  const input = { checked: false, disabled: true };
  const calls = [];

  await persistModuleToggle(input, false, async () => {
    calls.push('save');
  }, async () => {
    calls.push('render');
  });

  assert.deepEqual(calls, ['save', 'render']);
  assert.equal(input.checked, false);
});

test('persistModuleToggle does not restore the input when the re-render fails', async () => {
  const input = { checked: true, disabled: true };

  await assert.rejects(
    persistModuleToggle(input, true, async () => {}, async () => {
      throw new Error('render failed');
    }),
    /render failed/,
  );

  // Save succeeded, so the toggle must keep its new state and not be reverted.
  assert.equal(input.checked, true);
});

test('all locales contain the settings IA translation foundation', async () => {
  const localesDirectory = new URL('../public/locales/', import.meta.url);
  const localeFiles = (await readdir(localesDirectory)).filter((file) => file.endsWith('.json'));

  for (const file of localeFiles) {
    const locale = JSON.parse(await readFile(new URL(file, localesDirectory), 'utf8'));
    for (const key of settingsTranslationKeys) {
      const translation = getTranslation(locale, key);
      assert.equal(typeof translation, 'string', `${file}: ${key}`);
      assert.notEqual(translation.trim(), '', `${file}: ${key}`);
    }
  }
});
