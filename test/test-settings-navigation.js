import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  SETTINGS_DOMAINS,
  SETTINGS_LEAVES,
  filterSettingsDomains,
  findSettingsLeaf,
  migrateLegacySettingsTab,
} from '../public/settings/registry.js';

const member = { role: 'member' };
const admin = { role: 'admin' };
const settingsTranslationKeys = [
  'domainPersonal',
  'domainModules',
  'domainSync',
  'domainDocuments',
  'domainAdministration',
  'pageAccount',
  'pageAccountDescription',
  'pageAppearance',
  'pageAppearanceDescription',
  'pageDevice',
  'pageDeviceDescription',
  'pageNavigation',
  'pageNavigationDescription',
  'pageKitchen',
  'pageKitchenDescription',
  'pageCalendarModule',
  'pageCalendarModuleDescription',
  'pageBudgetModule',
  'pageBudgetModuleDescription',
  'pageHousekeepingModule',
  'pageHousekeepingModuleDescription',
  'pageDashboardApp',
  'pageDashboardAppDescription',
  'pageSyncCalendar',
  'pageSyncCalendarDescription',
  'pageSyncContacts',
  'pageSyncContactsDescription',
  'pageSyncReminders',
  'pageSyncRemindersDescription',
  'pageDocumentStorage',
  'pageDocumentStorageDescription',
  'pageDocumentDms',
  'pageDocumentDmsDescription',
  'pageFamilyRoles',
  'pageFamilyRolesDescription',
  'pageApiAccess',
  'pageApiAccessDescription',
  'pageBackupRestore',
  'pageBackupRestoreDescription',
  'pageSystem',
  'pageSystemDescription',
  'navigationLabel',
  'mobileOverviewTitle',
  'mobileOverviewDescription',
  'mobileDomainTitle',
  'breadcrumbLabel',
  'backToSettings',
  'retry',
  'loadError',
  'accessRedirected',
  'moreProviders',
  'providerSpecific',
  'legacy',
  'appleLegacyHint',
  'documentBackupWarning',
  'kitchenActiveCount',
  'enabledCalendarCount',
  'lastSyncValue',
  'neverSynced',
];

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

test('all locales contain the settings IA translation foundation', async () => {
  const localesDirectory = new URL('../public/locales/', import.meta.url);
  const localeFiles = (await readdir(localesDirectory)).filter((file) => file.endsWith('.json'));

  assert.equal(localeFiles.length, 19);
  for (const file of localeFiles) {
    const locale = JSON.parse(await readFile(new URL(file, localesDirectory), 'utf8'));
    for (const key of settingsTranslationKeys) {
      assert.equal(typeof locale.settings?.[key], 'string', `${file}: settings.${key}`);
      assert.notEqual(locale.settings[key].trim(), '', `${file}: settings.${key}`);
    }
    for (const key of ['sectionOverview', 'sectionPlan', 'sectionHome']) {
      assert.equal(typeof locale.nav?.[key], 'string', `${file}: nav.${key}`);
    }
    assert.equal(typeof locale.shopping?.manageCategories, 'string', `${file}: shopping.manageCategories`);
  }
});
