import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  SETTINGS_DOMAINS,
  SETTINGS_LEAVES,
  filterSettingsDomains,
  findSettingsLeaf,
  migrateLegacySettingsTab,
  resolveSettingsDestination,
  settingsOverviewUrl,
} from '../public/settings/registry.js';
import {
  KITCHEN_CHILD_IDS,
  expandModuleOrder,
  groupBuiltInModules,
  normalizeModuleOrder,
} from '../public/settings/module-order.js';
import {
  resolveHolidayLocation,
  runHolidayDiscovery,
  shouldApplySubdivisionResponse,
} from '../public/settings/pages/modules-calendar.js';
import {
  persistCurrencySelection,
} from '../public/settings/pages/modules-budget.js';
import {
  isConnectedWeatherControl,
} from '../public/settings/pages/modules-dashboard.js';
import {
  persistMealTypeSelection,
} from '../public/settings/pages/modules-kitchen.js';

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
  assert.equal(SETTINGS_LEAVES.length, 18);
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
