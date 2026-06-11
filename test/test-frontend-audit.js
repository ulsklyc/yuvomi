/**
 * Frontend audit regression tests.
 * Guards the accessibility and hard-constraint fixes from the UX audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { SETTINGS_DOMAINS, SETTINGS_LEAVES } from '../public/settings/registry.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');

function walkJsFiles(dir) {
  const entries = readdirSync(new URL(dir, import.meta.url), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return walkJsFiles(`${path}/`);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

function walkFrontendFiles(dir) {
  const entries = readdirSync(new URL(dir, import.meta.url), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return walkFrontendFiles(`${path}/`);
    return entry.isFile() && /\.(html|js)$/.test(entry.name) ? [path] : [];
  });
}

function resolveLocaleKey(obj, key) {
  return key.split('.').reduce((value, part) => (value != null ? value[part] : undefined), obj);
}

function assertKeysExistInEveryLocale(keys) {
  const localeFiles = readdirSync(new URL('../public/locales/', import.meta.url))
    .filter((file) => file.endsWith('.json'));
  const locales = localeFiles.map((file) => ({
    file,
    data: JSON.parse(read(`../public/locales/${file}`)),
  }));
  const missing = [];

  for (const key of keys) {
    for (const locale of locales) {
      if (resolveLocaleKey(locale.data, key) === undefined) {
        missing.push(`${key}:${locale.file}`);
      }
    }
  }

  assert.deepEqual(missing, []);
}

function cssRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? '';
}

function assertRuleUsesToken(css, selector, property, token, file) {
  const body = cssRuleBody(css, selector);
  assert.match(body, new RegExp(`${property}:\\s*var\\(${token}\\)`), `${file} ${selector} ${property} should use ${token}`);
}

test('audited frontend files do not assign innerHTML', () => {
  const files = [
    '../public/components/oikos-install-prompt.js',
    '../public/components/shopping-category-manager.js',
    '../public/pages/notes.js',
    '../public/pages/meals.js',
    '../public/pages/contacts.js',
    '../public/pages/documents.js',
    '../public/pages/housekeeping.js',
  ];

  for (const file of files) {
    assert.doesNotMatch(read(file), /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
  }
});

test('static frontend translation keys exist in every locale', () => {
  const keys = new Set();

  for (const file of walkJsFiles('../public/')) {
    const source = read(file);
    [...source.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)].forEach((match) => keys.add(match[2]));
    [...source.matchAll(/labelKey:\s*['"]([^'"]+)['"]/g)].forEach((match) => keys.add(match[1]));
  }

  for (const file of walkFrontendFiles('../public/')) {
    const source = read(file);
    [...source.matchAll(/data-i18n=["']([^"']+)["']/g)].forEach((match) => keys.add(match[1]));
  }

  assertKeysExistInEveryLocale(keys);
});

test('dynamic frontend translation key domains exist in every locale', () => {
  const familyRoles = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
  const documentCategories = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
  const documentVisibilities = ['family', 'restricted', 'private'];
  const dashboardBudgetLabels = ['catHousing', 'catFood', 'catTransport', 'catPersonalHealth', 'catLeisure', 'catShoppingClothing', 'catEducation', 'catFinancialOther', 'catEarnedIncome', 'catInvestmentIncome', 'catTransferGiftIncome', 'catGovernmentBenefits', 'catOtherIncome'];
  const splitGroupTypes = ['household', 'couple', 'travel', 'event', 'shopping', 'general'];
  const splitMethods = ['equal', 'exact', 'percentage', 'shares'];
  const splitActivityTypes = ['group_created', 'group_updated', 'group_archived', 'member_added', 'guest_created', 'expense_created', 'expense_edited', 'expense_deleted', 'comment_added', 'payment_registered', 'recurring_created', 'recurring_paused', 'recurring_resumed', 'recurring_generated'];

  const keys = [
    ...familyRoles.map((role) => `settings.familyRole${role.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`),
    ...documentCategories.map((category) => `documents.category.${category}`),
    ...documentVisibilities.map((visibility) => `documents.visibility.${visibility}`),
    ...dashboardBudgetLabels.map((key) => `budget.${key}`),
    ...splitGroupTypes.map((type) => `splitExpenses.groupType.${type}`),
    ...splitMethods.map((method) => `splitExpenses.splitHint.${method}`),
    ...splitActivityTypes.map((type) => `splitExpenses.activityType.${type}`),
  ];

  assertKeysExistInEveryLocale(keys);
});

test('settings information-architecture keys exist in every locale', () => {
  const keys = new Set();

  // Registry-derived labels/descriptions — the source of truth, never duplicated here.
  for (const domain of SETTINGS_DOMAINS) keys.add(domain.labelKey);
  for (const leaf of SETTINGS_LEAVES) {
    keys.add(leaf.labelKey);
    keys.add(leaf.descriptionKey);
  }

  // Shared Settings-IA copy that lives outside the registry but is part of the same surface.
  [
    // Shell chrome + overview headings.
    'settings.title',
    'settings.navigationLabel',
    'settings.breadcrumbLabel',
    'settings.backToSettings',
    'settings.loadError',
    'settings.retry',
    // Domain + mobile overview labels.
    'settings.mobileOverviewTitle',
    'settings.mobileOverviewDescription',
    'settings.mobileDomainTitle',
    // Status-first integration copy + progressive disclosure.
    'settings.providerSpecific',
    'settings.moreProviders',
    // Apple-legacy copy.
    'settings.legacy',
    'settings.appleLegacyHint',
    // Document backup warning.
    'settings.documentStorageBackupWarning',
    // Kitchen active count.
    'settings.kitchenActiveCount',
    // App navigation section labels.
    'nav.sectionOverview',
    'nav.sectionPlan',
    'nav.sectionHome',
    // Unauthorized / access-redirected notice.
    'settings.accessRedirected',
  ].forEach((key) => keys.add(key));

  assertKeysExistInEveryLocale([...keys]);
});

test('service worker precaches every supported locale file', () => {
  const i18n = read('../public/i18n.js');
  const sw = read('../public/sw.js');
  const supportedLocales = [...i18n.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]+)\]/)?.[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const localeFiles = readdirSync(new URL('../public/locales/', import.meta.url))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
  const precachedLocales = [...sw.matchAll(/'\/locales\/([^']+)\.json'/g)].map((match) => match[1]).sort();

  assert.deepEqual(supportedLocales.sort(), localeFiles, 'SUPPORTED_LOCALES must match public/locales/*.json');
  assert.deepEqual(precachedLocales, supportedLocales.sort(), 'Service worker APP_LOCALES must precache every supported locale');
});

test('install prompt waits for initial translations before rendering text', () => {
  const i18n = read('../public/i18n.js');
  const prompt = read('../public/components/oikos-install-prompt.js');

  assert.match(i18n, /export function whenI18nReady/);
  assert.match(prompt, /import \{ t,\s*whenI18nReady \} from '\/i18n\.js';/);
  assert.match(prompt, /await whenI18nReady\(\)/);
});

test('date helpers produce local YYYY-MM-DD keys without toISOString slicing', async () => {
  const { toLocalDateKey } = await import('../public/utils/date.js');
  const date = new Date(2026, 4, 24, 2, 30, 0);
  assert.equal(toLocalDateKey(date), '2026-05-24');
});

test('meals and budget pages do not slice toISOString for date keys', () => {
  for (const file of ['../public/pages/meals.js', '../public/pages/budget.js']) {
    assert.doesNotMatch(read(file), /toISOString\(\)\.slice\(0,\s*10\)/, `${file} must use local date keys`);
  }
});

test('shared sub-tabs wire tabs to panels with aria-controls and aria-labelledby support', () => {
  const source = read('../public/utils/sub-tabs.js');
  assert.match(source, /btn\.id\s*=/);
  assert.match(source, /aria-controls/);
  assert.match(source, /aria-labelledby/);
});

test('settings theme toggle exposes pressed state', () => {
  const source = read('../public/settings/pages/personal-appearance.js');
  assert.match(source, /aria-pressed/);
  assert.match(source, /setAttribute\('aria-pressed'/);
});

test('personal settings leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/personal-account.js',
    '../public/settings/pages/personal-appearance.js',
    '../public/settings/pages/personal-device.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    assert.match(read(file), /export async function render\(container,\s*\{\s*user\s*\}\)/);
  }
});

test('personal account leaf preserves self-profile, password, and logout contracts', () => {
  const source = read('../public/settings/pages/personal-account.js');

  assert.match(source, /await auth\.me\(\)/);
  assert.match(source, /Object\.assign\(user,\s*.*user/);
  assert.match(source, /auth\.updateProfile\(\{/);
  assert.match(source, /avatar_data:/);
  assert.match(source, /phone:/);
  assert.match(source, /email:/);
  assert.match(source, /birth_date:/);
  assert.match(source, /api\.patch\('\/auth\/me\/password',\s*\{\s*current_password:/);
  assert.match(source, /await auth\.logout\(\)/);
  assert.match(source, /window\.oikos\?\.navigate\('\/login'\)/);
  assert.match(source, /id="profile-avatar-file"[^>]*aria-label=/);
  assert.match(source, /id="profile-avatar-file"[^>]*tabindex="-1"/);
  assert.match(source, /id="profile-avatar-file"[^>]*aria-describedby="profile-error"/);
  assert.match(source, /id="profile-error"[^>]*role="alert"/);
  assert.match(source, /id="password-error"[^>]*role="alert"/);
  assert.match(source, /id="profile-display-name"[^>]*aria-describedby="profile-error"/);
  assert.match(source, /id="profile-phone"[^>]*aria-describedby="profile-error"/);
  assert.match(source, /id="profile-email"[^>]*aria-describedby="profile-error"/);
  assert.match(source, /id="profile-birth-date"[^>]*aria-describedby="profile-error"/);
  assert.match(source, /id="current-password"[^>]*aria-describedby="password-error"/);
  assert.match(source, /id="new-password"[^>]*aria-describedby="password-error"/);
  assert.match(source, /id="confirm-password"[^>]*aria-describedby="password-error"/);
  assert.match(source, /role="alert"[^>]*>\$\{t\('settings\.loadError'\)\}/);
});

test('personal appearance leaf owns theme, locale, and regional preferences', () => {
  const source = read('../public/settings/pages/personal-appearance.js');

  assert.match(source, /await api\.get\('\/preferences'\)/);
  assert.match(source, /getSupportedLocales\(\)/);
  assert.match(source, /setLocale\(/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /setAttribute\('aria-pressed'/);
  assert.match(source, /data-lucide="monitor"/);
  assert.match(source, /data-lucide="sun"/);
  assert.match(source, /data-lucide="moon"/);
  assert.match(source, /date_format/);
  assert.match(source, /time_format/);
  assert.match(source, /api\.put\('\/preferences'/);
  assert.match(source, /function safeStorageGet\(/);
  assert.match(source, /function safeStorageSet\(/);
  assert.match(source, /function safeStorageRemove\(/);
  assert.match(source, /function safeStorageGet[\s\S]*try \{[\s\S]*localStorage\.getItem[\s\S]*catch/);
  assert.match(source, /function safeStorageSet[\s\S]*try \{[\s\S]*localStorage\.setItem[\s\S]*catch/);
  assert.match(source, /function safeStorageRemove[\s\S]*try \{[\s\S]*localStorage\.removeItem[\s\S]*catch/);
  assert.equal([...source.matchAll(/localStorage\.getItem/g)].length, 1);
  assert.equal([...source.matchAll(/localStorage\.setItem/g)].length, 1);
  assert.equal([...source.matchAll(/localStorage\.removeItem/g)].length, 1);
  assert.match(source, /function bindEvents\(container,\s*user\)/);
  assert.match(source, /await setLocale\(locale\);[\s\S]*await render\(container,\s*\{\s*user\s*\}\)/);
  assert.match(source, /if \(localeSelect\.isConnected\)\s*localeSelect\.disabled = false/);
  assert.match(source, /id="locale-error"[^>]*role="alert"/);
  assert.match(source, /id="date-format-error"[^>]*role="alert"/);
  assert.match(source, /id="time-format-error"[^>]*role="alert"/);
  assert.match(source, /id="locale-select"[^>]*aria-describedby="locale-error"/);
  assert.match(source, /id="date-format-select"[^>]*aria-describedby="date-format-error"/);
  assert.match(source, /id="time-format-select"[^>]*aria-describedby="time-format-error"/);
  assert.match(source, /role="alert"[^>]*>\$\{t\('settings\.loadError'\)\}/);
});

test('personal device leaf owns PWA installation state and disconnect cleanup', () => {
  const source = read('../public/settings/pages/personal-device.js');

  assert.match(
    source,
    /import \{\s*getPwaInstallState,\s*onPwaInstallStateChanged,\s*promptPwaInstall\s*\} from '\/utils\/pwa-install\.js';/,
  );
  assert.match(source, /onPwaInstallStateChanged\(/);
  assert.match(source, /promptPwaInstall\(\)/);
  assert.match(source, /!container\.isConnected/);
  assert.match(source, /if \(unsubscribed\) return/);
  assert.match(source, /stopListening\(\)/);
  assert.match(source, /new MutationObserver\(/);
  // Cleanup observes only the router's persistent swap container (#main-content),
  // not the whole document.body subtree (which fires on every app DOM mutation).
  assert.match(source, /getElementById\('main-content'\)/);
  assert.match(source, /observer\.observe\(swapRoot, \{ childList: true \}\)/);
  assert.doesNotMatch(source, /subtree:\s*true/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /id="pwa-install-status"[^>]*aria-live=/);
  assert.match(source, /id="pwa-install-error"[^>]*role="alert"/);
  assert.match(source, /id="pwa-install-btn"[^>]*aria-describedby="pwa-install-status pwa-install-error"/);
});

test('module-specific settings leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/modules-kitchen.js',
    '../public/settings/pages/modules-calendar.js',
    '../public/settings/pages/modules-budget.js',
    '../public/settings/pages/modules-housekeeping.js',
    '../public/settings/pages/modules-dashboard.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    const source = read(file);
    assert.match(source, /export async function render\(container,\s*\{\s*user\s*\}\)/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must use the shared API client`);
  }
});

test('module-specific settings leaves only reference their owned preferences and endpoints', () => {
  const ownership = {
    '../public/settings/pages/modules-kitchen.js': {
      endpoints: ['/preferences'],
      preferences: ['visible_meal_types'],
    },
    '../public/settings/pages/modules-calendar.js': {
      endpoints: [
        '/preferences',
        '/preferences/holidays/countries',
        '/preferences/holidays/subdivisions/',
        '/preferences/holidays/sync',
      ],
      preferences: [
        'holiday_country',
        'holiday_subdivision',
        'holiday_show_public',
        'holiday_show_school',
        'holiday_public_color',
        'holiday_school_color',
        'holiday_last_sync',
      ],
    },
    '../public/settings/pages/modules-budget.js': {
      endpoints: ['/preferences'],
      preferences: ['currency'],
    },
    '../public/settings/pages/modules-housekeeping.js': {
      endpoints: ['/preferences'],
      preferences: ['housekeeping_payment_tasks'],
    },
    '../public/settings/pages/modules-dashboard.js': {
      endpoints: ['/preferences'],
      preferences: [
        'app_name',
        'weather_provider',
        'weather_lat',
        'weather_lon',
        'weather_city',
        'weather_units',
      ],
    },
  };

  for (const [file, approved] of Object.entries(ownership)) {
    const source = read(file);
    const endpoints = [
      ...source.matchAll(/\bapi\.(?:get|put|post|patch|delete)\(\s*`([^`$]*)/g),
      ...source.matchAll(/\bapi\.(?:get|put|post|patch|delete)\(\s*['"]([^'"]+)/g),
    ].map((match) => match[1]);
    const preferenceKeys = new Set(
      [...source.matchAll(/\b(?:preferences|preferenceData)\.([a-z][a-z0-9_]*)/g)]
        .map((match) => match[1]),
    );
    for (const match of source.matchAll(/api\.put\(\s*['"]\/preferences['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const keyMatch of match[1].matchAll(/\b([a-z][a-z0-9_]*)\s*:/g)) {
        preferenceKeys.add(keyMatch[1]);
      }
    }

    assert.deepEqual(
      [...new Set(endpoints)].sort(),
      [...approved.endpoints].sort(),
      `${file} must only call its approved endpoints`,
    );
    assert.deepEqual(
      [...preferenceKeys].sort(),
      [...approved.preferences].sort(),
      `${file} must only reference its owned preference keys`,
    );
  }
});

test('module-specific settings leaves preserve their required controls and behaviors', () => {
  const kitchen = read('../public/settings/pages/modules-kitchen.js');
  assert.match(kitchen, /const MEAL_TYPES = \['breakfast', 'lunch', 'dinner', 'snack'\]/);
  assert.match(kitchen, /await api\.get\('\/preferences'\)/);
  assert.match(kitchen, /api\.put\('\/preferences', \{ visible_meal_types: checkedMealTypes \}\)/);
  assert.match(kitchen, /MEAL_TYPES\.map\(/);
  assert.doesNotMatch(kitchen, /\/(?:recipes|shopping)|shopping\/categories|recipe_settings|shopping_settings/);

  const calendar = read('../public/settings/pages/modules-calendar.js');
  for (const id of [
    'holiday-country',
    'holiday-subdivision',
    'holiday-show-public',
    'holiday-public-color',
    'holiday-show-school',
    'holiday-school-color',
    'holiday-sync-btn',
  ]) {
    assert.match(calendar, new RegExp(`id="${id}"`));
  }
  assert.match(calendar, /api\.get\('\/preferences\/holidays\/countries'\)/);
  assert.match(calendar, /api\.get\(`\/preferences\/holidays\/subdivisions\/\$\{countryCode\}`\)/);
  assert.match(calendar, /api\.post\('\/preferences\/holidays\/sync', \{\}\)/);
  assert.doesNotMatch(calendar, /caldav|carddav|google|apple|subscriptions|sync accounts/i);
  assert.doesNotMatch(calendar, /#[0-9a-f]{6}/i);
  assert.match(calendar, /id="holiday-country" disabled/);
  assert.ok(
    calendar.indexOf("form.addEventListener('submit'") <
      calendar.indexOf('const countriesResult = await runHolidayDiscovery'),
    'Calendar must bind submit handling before loading holiday discovery data',
  );

  const budget = read('../public/settings/pages/modules-budget.js');
  assert.match(budget, /id="currency-select"/);
  assert.match(budget, /api\.put\('\/preferences', \{ currency: currencySelect\.value \}\)/);
  assert.equal([...budget.matchAll(/<(?:input|select|textarea)\b/g)].length, 1);

  const housekeeping = read('../public/settings/pages/modules-housekeeping.js');
  assert.match(housekeeping, /id="housekeeping-payment-tasks"/);
  assert.match(
    housekeeping,
    /api\.put\('\/preferences', \{ housekeeping_payment_tasks: toggle\.checked \}\)/,
  );
  assert.equal([...housekeeping.matchAll(/<(?:input|select|textarea)\b/g)].length, 1);

  const dashboard = read('../public/settings/pages/modules-dashboard.js');
  for (const id of [
    'weather-lat',
    'weather-lon',
    'weather-city',
    'weather-units',
    'app-name-input',
  ]) {
    assert.match(dashboard, new RegExp(`id="${id}"`));
  }
  assert.match(dashboard, /weather_provider: 'open-meteo'/);
  assert.match(dashboard, /weather_provider: null/);
  assert.match(dashboard, /latitude >= -90/);
  assert.match(dashboard, /latitude <= 90/);
  assert.match(dashboard, /longitude >= -180/);
  assert.match(dashboard, /longitude <= 180/);
  assert.match(dashboard, /localStorage\.setItem\(key, value\)/);
  assert.match(dashboard, /localStorage\.removeItem\(key\)/);
  assert.match(dashboard, /new CustomEvent\('app-name-changed'/);
  assert.match(dashboard, /window\.oikos\?\.showToast/);
  assert.match(dashboard, /await render\(container, \{ user \}\)/);
});

test('synchronization-by-data-type leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/sync-calendar.js',
    '../public/settings/pages/sync-contacts.js',
    '../public/settings/pages/sync-reminders.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    const source = read(file);
    assert.match(source, /export async function render\(container,\s*\{[^}]*\}(?:\s*=\s*\{\})?\)/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must use the shared API client`);
    assert.doesNotMatch(source, /\brequire\(/, `${file} must use import, not require`);
    assert.match(
      source,
      /import \{ api \} from '\/api\.js'/,
      `${file} must import the shared API client`,
    );
  }
});

test('sync-calendar leaf loads CalDAV, ICS, Google, and Apple with independent status', () => {
  const source = read('../public/settings/pages/sync-calendar.js');

  // CalDAV calendar account management + status before forms.
  assert.match(source, /api\.get\('\/calendar\/caldav\/accounts'\)/);
  assert.match(source, /api\.post\('\/calendar\/caldav\/accounts'/);
  assert.match(source, /api\.delete\(`\/calendar\/caldav\/accounts\/\$\{[^}]+\}`\)/);
  assert.match(source, /\/calendar\/caldav\/accounts\/\$\{[^}]+\}\/calendars/);
  assert.match(source, /api\.post\('\/calendar\/caldav\/sync'\)/);
  assert.match(source, /createStatusSummary\(/);
  assert.match(source, /t\('settings\.caldavTitle'\)/);
  assert.match(source, /enabledCalendarCount/);
  assert.match(source, /neverSynced/);

  // Webcal / ICS subscriptions.
  assert.match(source, /api\.get\('\/calendar\/subscriptions'\)/);
  assert.match(source, /api\.post\('\/calendar\/subscriptions'/);
  assert.match(source, /api\.patch\(`\/calendar\/subscriptions\/\$\{[^}]+\}`/);
  assert.match(source, /api\.delete\(`\/calendar\/subscriptions\/\$\{[^}]+\}`\)/);

  // Independent fetches so one failure does not hide the others.
  assert.match(source, /Promise\.allSettled/);

  // Reminder-list collections must NOT leak into the calendar leaf.
  assert.doesNotMatch(source, /reminder-lists/);
  assert.doesNotMatch(source, /\/calendar\/caldav\/reminders\/sync/);

  // Google + Apple live behind one accessible "More providers" disclosure.
  assert.match(source, /createDisclosure\(/);
  assert.match(source, /settings\.moreProviders/);

  // Google: provider-specific labelled, all endpoints preserved.
  assert.match(source, /settings\.providerSpecific/);
  assert.match(source, /api\.get\('\/calendar\/google\/status'\)/);
  assert.match(source, /\/api\/v1\/calendar\/google\/auth/);
  assert.match(source, /api\.post\('\/calendar\/google\/sync'/);
  assert.match(source, /api\.get\('\/calendar\/google\/calendars'\)/);
  assert.match(source, /api\.patch\('\/calendar\/google\/calendars'/);
  assert.match(source, /api\.put\('\/calendar\/google\/readonly'/);
  assert.match(source, /api\.delete\('\/calendar\/google\/disconnect'\)/);

  // Apple: legacy badge + hint steering new users to CalDAV, endpoints preserved.
  assert.match(source, /settings\.legacy/);
  assert.match(source, /settings\.appleLegacyHint/);
  assert.match(source, /api\.get\('\/calendar\/apple\/status'\)/);
  assert.match(source, /api\.post\('\/calendar\/apple\/connect'/);
  assert.match(source, /api\.post\('\/calendar\/apple\/sync'/);
  assert.match(source, /api\.delete\('\/calendar\/apple\/disconnect'\)/);

  // OAuth callback handling: localized banner, expand disclosure, scrub only callback params.
  assert.match(source, /sync_ok/);
  assert.match(source, /sync_error/);
  assert.match(source, /history\.replaceState/);
});

test('sync-contacts leaf owns CardDAV account management', () => {
  const source = read('../public/settings/pages/sync-contacts.js');

  assert.match(source, /api\.get\('\/contacts\/cardav\/accounts'\)/);
  assert.match(source, /api\.post\('\/contacts\/cardav\/accounts'/);
  assert.match(source, /api\.delete\(`\/contacts\/cardav\/accounts\/\$\{[^}]+\}`\)/);
  assert.match(source, /\/contacts\/cardav\/accounts\/\$\{[^}]+\}\/addressbooks/);
  assert.match(source, /addressbooks\/toggle/);
  assert.match(source, /addressbooks\/refresh/);
  assert.match(source, /\/contacts\/cardav\/accounts\/\$\{[^}]+\}\/sync/);
  assert.match(source, /last_sync/);

  // Contacts leaf must not own calendar or reminder concerns.
  assert.doesNotMatch(source, /\/calendar\/caldav/);
  assert.doesNotMatch(source, /\/calendar\/google/);
  assert.doesNotMatch(source, /\/calendar\/apple/);
});

test('sync-reminders leaf maps CalDAV reminder lists and syncs without calendars', () => {
  const source = read('../public/settings/pages/sync-reminders.js');

  // Reuse CalDAV accounts but render only reminder/task collections.
  assert.match(source, /api\.get\('\/calendar\/caldav\/accounts'\)/);
  assert.match(source, /reminder-lists/);
  assert.match(source, /api\.patch\(`\/calendar\/caldav\/accounts\/\$\{[^}]+\}\/reminder-lists`/);
  assert.match(source, /api\.post\('\/calendar\/caldav\/reminders\/sync'\)/);
  assert.match(source, /targetModule/);
  assert.match(source, /settings\.caldavReminderMapTasks/);
  assert.match(source, /settings\.caldavReminderMapShopping/);
  assert.match(source, /settings\.caldavRemindersHint/);

  // Calendar collections must NOT appear in the reminders leaf.
  assert.doesNotMatch(source, /\/calendars\b/);
  assert.doesNotMatch(source, /\/calendar\/caldav\/sync\b/);
});

test('documents-domain leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/documents-storage.js',
    '../public/settings/pages/documents-dms.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    const source = read(file);
    assert.match(source, /export async function render\(container,\s*\{[^}]*\}(?:\s*=\s*\{\})?\)/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must use the shared API client`);
    assert.doesNotMatch(source, /\brequire\(/, `${file} must use import, not require`);
    assert.match(
      source,
      /import \{ api \} from '\/api\.js'/,
      `${file} must import the shared API client`,
    );
  }
});

test('documents-storage leaf owns WebDAV document storage with a status-first layout', () => {
  const source = read('../public/settings/pages/documents-storage.js');

  // Storage config + test endpoints preserved unchanged.
  assert.match(source, /api\.get\('\/documents\/storage\/config'\)/);
  assert.match(source, /api\.put\('\/documents\/storage\/config'/);
  assert.match(source, /api\.post\('\/documents\/storage\/test'/);

  // Status-first: render the active backend and target before the connection fields.
  assert.match(source, /createStatusSummary\(/);
  assert.match(source, /active_upload_backend/);
  assert.match(source, /webdav_document_count/);
  assert.match(source, /documentStorageTarget/);

  // Connection fields live behind an accessible disclosure.
  assert.match(source, /createDisclosure\(/);

  // Protected-change detection + confirm before save.
  assert.match(source, /hasProtectedDocumentStorageChange/);
  assert.match(source, /settings\.documentStorageConfirmExisting/);

  // Env-controlled handling + backup warning preserved.
  assert.match(source, /env_controlled/);
  assert.match(source, /settings\.documentStorageBackupWarning/);

  // Storage leaf must not own DMS concerns.
  assert.doesNotMatch(source, /\/documents\/dms/);
});

test('documents-dms leaf owns Paperless DMS account management', () => {
  const source = read('../public/settings/pages/documents-dms.js');

  assert.match(source, /api\.get\('\/documents\/dms\/accounts'\)/);
  assert.match(source, /api\.post\('\/documents\/dms\/accounts'/);
  assert.match(source, /api\.delete\(`\/documents\/dms\/accounts\/\$\{[^}]+\}`\)/);
  assert.match(source, /\/documents\/dms\/accounts\/\$\{[^}]+\}\/test/);
  assert.match(source, /provider: 'paperless'/);

  // DMS leaf must not own storage concerns.
  assert.doesNotMatch(source, /\/documents\/storage/);
});

test('administration-domain leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/admin-family.js',
    '../public/settings/pages/admin-api.js',
    '../public/settings/pages/admin-backup.js',
    '../public/settings/pages/admin-system.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    const source = read(file);
    assert.match(source, /export async function render\(container,\s*\{[^}]*\}(?:\s*=\s*\{\})?\)/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must use the shared API client`);
    assert.doesNotMatch(source, /\brequire\(/, `${file} must use import, not require`);
    assert.match(
      source,
      /import \{ api(?:,\s*auth)? \} from '\/api\.js'/,
      `${file} must import the shared API client`,
    );
  }
});

test('admin-family leaf owns family member + role management lazily', () => {
  const source = read('../public/settings/pages/admin-family.js');

  // Users are fetched only when the leaf is active, via the auth helper.
  assert.match(source, /auth\.getUsers\(\)/);
  assert.match(source, /auth\.createUser\(/);
  assert.match(source, /auth\.updateUser\(/);
  assert.match(source, /auth\.deleteUser\(/);
  assert.match(source, /buildFamilyRoleOptions/);
  assert.match(source, /family_role/);
  assert.match(source, /birth_date/);

  // Family leaf must not own API token, backup, or version concerns.
  assert.doesNotMatch(source, /\/auth\/api-tokens/);
  assert.doesNotMatch(source, /\/backup\//);
  assert.doesNotMatch(source, /\/version/);
});

test('admin-api leaf owns API token lifecycle with one-time secret display', () => {
  const source = read('../public/settings/pages/admin-api.js');

  assert.match(source, /api\.get\('\/auth\/api-tokens'\)/);
  assert.match(source, /api\.post\('\/auth\/api-tokens'/);
  assert.match(source, /api\.delete\(`\/auth\/api-tokens\/\$\{[^}]+\}`\)/);

  // The raw token is only ever read from the creation response.
  assert.match(source, /res\.token/);

  // API leaf must not own family, backup, or version concerns.
  assert.doesNotMatch(source, /\/auth\/users/);
  assert.doesNotMatch(source, /\/backup\//);
  assert.doesNotMatch(source, /\/version/);
});

test('admin-backup leaf owns database + WebDAV backup without document storage', () => {
  const source = read('../public/settings/pages/admin-backup.js');

  assert.match(source, /\/api\/v1\/backup\/database/);
  assert.match(source, /api\.rawPost\('\/backup\/restore'/);
  assert.match(source, /api\.get\('\/backup\/status'\)/);
  assert.match(source, /api\.post\('\/backup\/trigger'\)/);
  assert.match(source, /api\.get\('\/backup\/webdav\/config'\)/);
  assert.match(source, /api\.put\('\/backup\/webdav\/config'/);
  assert.match(source, /api\.post\('\/backup\/webdav\/test'/);
  assert.match(source, /api\.post\('\/backup\/webdav\/trigger'\)/);

  // CLI recovery guidance lives behind a collapsed disclosure.
  assert.match(source, /createDisclosure\(/);
  assert.match(source, /settings\.backupCliTitle/);

  // Backup leaf must not own document-storage WebDAV or API/version concerns.
  assert.doesNotMatch(source, /\/documents\/storage/);
  assert.doesNotMatch(source, /\/auth\/api-tokens/);
  assert.doesNotMatch(source, /\/version/);
});

test('admin-system leaf reads /version and renders safe translated rows only', () => {
  const source = read('../public/settings/pages/admin-system.js');

  assert.match(source, /api\.get\('\/version'\)/);
  assert.match(source, /settings\.systemVersionLabel/);
  assert.match(source, /MIT/);
  assert.match(source, /setup_required/);

  // System leaf is read-only: no other backend domains, no secrets.
  assert.doesNotMatch(source, /\/documents\//);
  assert.doesNotMatch(source, /\/backup\//);
  assert.doesNotMatch(source, /\/auth\/api-tokens/);
});

test('Shopping owns shopping category management via a dedicated web component', () => {
  const component = read('../public/components/shopping-category-manager.js');
  assert.match(component, /customElements\.define\(\s*'oikos-shopping-category-manager'/);
  assert.match(component, /import \{ api \} from '\/api\.js'/);
  assert.match(component, /import \{ t \} from '\/i18n\.js'/);
  assert.match(component, /import \{ esc \} from '\/utils\/html\.js'/);
  assert.match(component, /api\.get\('\/shopping\/categories'\)/);
  assert.match(component, /api\.post\('\/shopping\/categories'/);
  assert.match(component, /api\.patch\('\/shopping\/categories\/reorder'/);
  assert.match(component, /shopping-categories-changed/);
  assert.match(component, /disconnectedCallback\(\)/);
  assert.match(component, /removeEventListener/);
  assert.doesNotMatch(component, /#[0-9a-f]{6}/i);

  // Optimistisches Reorder muss bei API-Fehler auf den Snapshot zurückrollen.
  const moveFn = component.match(/async _move\([\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(moveFn, /const snapshot = \[\.\.\.this\._cats\]/);
  const moveCatch = moveFn.match(/catch \(err\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(moveCatch, /this\._cats = snapshot/);
  assert.doesNotMatch(moveCatch, /this\._notifyChanged\(\)/);

  const shopping = read('../public/pages/shopping.js');
  assert.match(shopping, /components\/shopping-category-manager\.js/);
  assert.match(shopping, /<oikos-shopping-category-manager>/);
  assert.match(shopping, /shopping\.manageCategories/);
  assert.match(shopping, /shopping-categories-changed/);
  // onClose muss den Listener wieder abräumen (kein Leak bei Modal-Reuse).
  const openMgr = shopping.match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(openMgr, /manager\?\.removeEventListener\('shopping-categories-changed'/);
});

test('Kitchen settings copy directs Recipes and Shopping content settings to their modules', () => {
  const english = JSON.parse(read('../public/locales/en.json'));
  const german = JSON.parse(read('../public/locales/de.json'));

  assert.match(english.settings.pageKitchenDescription, /Recipes/);
  assert.match(english.settings.pageKitchenDescription, /Shopping/);
  assert.match(english.settings.pageKitchenDescription, /modules/);
  assert.match(german.settings.pageKitchenDescription, /Rezepte/);
  assert.match(german.settings.pageKitchenDescription, /Einkauf/);
  assert.match(german.settings.pageKitchenDescription, /Modulen/);
});

test('browser loader supports personal settings API and auth imports', () => {
  const source = read('./test-browser-loader.mjs');

  assert.match(source, /patch:\s*async/);
  assert.match(source, /export const auth/);
  assert.match(source, /me:\s*async/);
  assert.match(source, /getUsers:\s*async/);
  assert.match(source, /'\/utils\/pwa-install\.js'/);
  assert.match(source, /getPwaInstallState/);
  assert.match(source, /onPwaInstallStateChanged/);
  assert.match(source, /promptPwaInstall/);
});

test('legacy settings page remains available during the leaf migration', () => {
  assert.equal(existsSync(new URL('../public/pages/settings.js', import.meta.url)), true);
});

test('responsive settings shell defines desktop and mobile navigation layouts', () => {
  const source = read('../public/styles/settings.css');

  assert.match(
    source,
    /@media \(min-width:\s*960px\)[\s\S]*\.settings-shell__navigation\s*\{[\s\S]*position:\s*sticky/,
  );
  assert.match(
    source,
    /@media \(max-width:\s*959px\)[\s\S]*\.settings-mobile-overview\s*\{/,
  );
});

test('settings disclosure exposes its expanded state and controlled panel', () => {
  const source = read('../public/settings/components.js');

  assert.match(source, /aria-expanded/);
  assert.match(source, /aria-controls/);
});

test('settings rows programmatically label form controls and preserve descriptions', () => {
  const source = read('../public/settings/components.js');

  assert.match(source, /let settingRowIdCounter\s*=\s*0/);
  assert.match(source, /control\?\.matches\?\.\(['"]input,\s*select,\s*textarea,\s*button['"]\)/);
  assert.match(source, /control\?\.querySelector\?\.\(['"]input,\s*select,\s*textarea,\s*button['"]\)/);
  assert.match(source, /if \(formControl && !formControl\.id\)/);
  assert.match(source, /document\.createElement\(formControl \? 'label' : 'div'\)/);
  assert.match(source, /title\.htmlFor\s*=\s*formControl\.id/);
  assert.match(source, /detail\.id\s*=/);
  assert.match(source, /formControl\.getAttribute\('aria-describedby'\)/);
  assert.match(source, /describedBy\.push\(detail\.id\)/);
  assert.match(source, /describedBy\.join\(' '\)/);
  assert.match(source, /formControl\.setAttribute\('aria-describedby'/);
});

test('settings shell marks and focuses the active page', () => {
  const source = read('../public/settings/shell.js');

  assert.match(source, /setAttribute\('aria-current',\s*'page'\)/);
  assert.match(source, /\.tabIndex\s*=\s*-1/);
  assert.match(source, /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});

test('settings retry focus only moves to a connected replacement button after retry failure', () => {
  const source = read('../public/settings/shell.js');

  assert.match(source, /const loadAndRender = async \(\{\s*focusRetry = false\s*\} = \{\}\) =>/);
  assert.match(source, /onRetry:\s*\(\) => loadAndRender\(\{\s*focusRetry:\s*true\s*\}\)/);
  assert.match(
    source,
    /if \(focusRetry\)[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*retryButton\?\.isConnected[\s\S]*retryButton\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
  );
  assert.match(source, /await loadAndRender\(\);/);
});

test('settings shell falls back to the domains overview for orphaned active leaves', () => {
  const source = read('../public/settings/shell.js');

  assert.match(source, /if \(!domain\)\s*\{[\s\S]*console\.error\([\s\S]*renderDomainsOverview\(content,\s*domains\)/);
  assert.match(source, /else\s*\{[\s\S]*await renderLeafContent\(shell,\s*content,\s*activeLeaf,\s*domain,\s*user,\s*query\)/);
});

test('router hides inactive overlays from keyboard focus', () => {
  const source = read('../public/router.js');
  assert.match(source, /\.inert\s*=/);
  assert.match(source, /returnFocus/);
});

test('mobile More sheet trigger controls its dialog and traps keyboard focus', () => {
  const source = read('../public/router.js');

  assert.match(source, /moreBtn\.setAttribute\('aria-controls',\s*'more-sheet'\)/);
  assert.match(source, /const currentMoreBtn = \(\) => container\.querySelector\('#more-btn'\) \|\| moreBtn/);
  assert.match(source, /currentMoreBtn\(\)\.setAttribute\('aria-expanded',\s*'true'\)/);
  assert.match(source, /currentMoreBtn\(\)\.setAttribute\('aria-expanded',\s*'false'\)/);
  assert.match(source, /function\s+createFocusTrap/);
  assert.match(source, /moreSheetTrap/);
  assert.match(source, /addEventListener\('keydown',\s*moreSheetTrap/);
  assert.match(source, /removeEventListener\('keydown',\s*moreSheetTrap/);
});

test('More button active state keeps visible More identity and accessible active context', () => {
  const source = read('../public/router.js');

  assert.match(source, /function\s+setMoreButtonState/);
  assert.match(source, /moreBtn\.setAttribute\('aria-current',\s*'page'\)/);
  assert.match(source, /moreBtn\.setAttribute\('aria-label',\s*moreLabel\)/);
  assert.match(source, /moreBtn\.setAttribute\('title',\s*t\('nav\.more'\)\)/);
  assert.doesNotMatch(source, /moreBtn\.toggleAttribute\('aria-current',\s*inMoreSheet\)/);
});

test('mobile Kitchen and More nav buttons keep colored icon wells while inactive', () => {
  const source = read('../public/router.js');

  assert.match(source, /kitchenBtn\.style\.setProperty\('--item-module-accent',\s*'var\(--module-meals\)'\)/);
  assert.match(source, /moreBtn\.style\.setProperty\('--item-module-accent',\s*'var\(--color-accent\)'\)/);
  assert.doesNotMatch(source, /kitchenNavBtn\.style\.removeProperty\('--item-module-accent'\)/);
  assert.doesNotMatch(source, /moreBtn\.style\.removeProperty\('--item-module-accent'\)/);
});

test('More sheet closes route clicks through delegated handler after rebuilds', () => {
  const source = read('../public/router.js');

  assert.match(source, /sheet\.addEventListener\('click',\s*\(e\) =>/);
  assert.match(source, /e\.target\.closest\('\[data-route\]'\)/);
  assert.doesNotMatch(source, /sheet\.querySelectorAll\('\[data-route\]'\)\.forEach/);
});

test('More sheet search trigger is a native button with visible focus styling', () => {
  const router = read('../public/router.js');
  const layout = read('../public/styles/layout.css');
  const focusRule = cssRuleBody(layout, '.more-sheet__search:focus-visible');

  assert.match(router, /const moreSearchBar = document\.createElement\('button'\)/);
  assert.match(router, /moreSearchBar\.type = 'button'/);
  assert.doesNotMatch(router, /moreSearchBar\.setAttribute\('role',\s*'button'\)/);
  assert.match(focusRule, /outline:/);
  assert.match(focusRule, /box-shadow:/);
});

test('SPA navigation can move focus to main content after route changes', () => {
  const source = read('../public/router.js');

  assert.match(source, /main\.tabIndex\s*=\s*-1/);
  assert.match(source, /function\s+focusMainContentAfterNavigation/);
  assert.match(source, /focusMainContentAfterNavigation\(basePath/);
});

test('bottom navigation labels are constrained against localized overflow', () => {
  const layout = read('../public/styles/layout.css');
  const labelRule = cssRuleBody(layout, '.nav-item__label');

  assert.match(labelRule, /max-width:\s*100%/);
  assert.match(labelRule, /overflow:\s*hidden/);
  assert.match(labelRule, /text-overflow:\s*ellipsis/);
  assert.match(labelRule, /white-space:\s*nowrap/);
});

test('mobile bottom navigation avoids clipped Android labels and sparse icon spacing', () => {
  const layout = read('../public/styles/layout.css');
  const navItemRule = cssRuleBody(layout, '.nav-bottom .nav-item');
  const iconWellRule = cssRuleBody(layout, '.nav-bottom .nav-item__icon-well');
  const labelRule = cssRuleBody(layout, '.nav-item__label');

  assert.match(navItemRule, /padding-block:\s*var\(--space-0h\)/);
  assert.match(iconWellRule, /width:\s*var\(--target-base\)/);
  assert.match(iconWellRule, /height:\s*var\(--target-sm\)/);
  assert.match(iconWellRule, /border-radius:\s*var\(--radius-full\)/);
  assert.match(labelRule, /line-height:\s*1\.2/);
});

test('phase 3 high-frequency controls use tokenized touch targets', () => {
  const tasks = read('../public/styles/tasks.css');
  const shopping = read('../public/styles/shopping.css');
  const notes = read('../public/styles/notes.css');

  assert.match(tasks, /\.task-status-btn::before[\s\S]*var\(--target-base\)/);
  assert.match(tasks, /\.task-bulk-checkbox[\s\S]*(?:min-width|width):\s*var\(--target-base\)/);
  assert.match(tasks, /\.task-card__inline-action[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(tasks, /\.task-card__inline-action[\s\S]*height:\s*var\(--target-base\)/);
  assert.match(tasks, /\.bulk-actions-bar__actions \.btn[\s\S]*min-height:\s*var\(--target-base\)/);
  assert.match(shopping, /\.item-check[\s\S]*(?:min-width|width):\s*var\(--target-base\)/);
  assert.match(shopping, /\.item-delete[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(shopping, /\.item-delete[\s\S]*height:\s*var\(--target-base\)/);
  assert.match(shopping, /\.shopping-item[\s\S]*min-height:\s*var\(--target-base\)/);
  assert.match(notes, /\.note-card__pin[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(notes, /\.note-card__delete[\s\S]*width:\s*var\(--target-base\)/);
});

test('phase 3 mobile Tasks toolbar collapses secondary controls into one overflow trigger', () => {
  const tasksPage = read('../public/pages/tasks.js');
  const tasksCss = read('../public/styles/tasks.css');

  assert.match(tasksPage, /<details class="tasks-toolbar__secondary"/);
  assert.match(tasksPage, /class="btn btn--ghost btn--icon tasks-toolbar__secondary-trigger"/);
  assert.match(tasksPage, /<div class="tasks-toolbar__secondary-panel">[\s\S]*id="group-mode-toggle"[\s\S]*id="view-toggle"[\s\S]*id="btn-bulk-select"/);
  assert.match(
    tasksCss,
    /@media \(max-width:\s*640px\)[\s\S]*\.tasks-toolbar__secondary-panel\s*\{[\s\S]*position:\s*absolute[\s\S]*display:\s*none/
  );
  assert.match(
    tasksCss,
    /@media \(max-width:\s*640px\)[\s\S]*\.tasks-toolbar__secondary\[open\] \.tasks-toolbar__secondary-panel\s*\{[\s\S]*display:\s*flex/
  );
});

test('phase 3 Tasks bulk actions stay de-emphasized until tasks are selected', () => {
  const tasksPage = read('../public/pages/tasks.js');
  const tasksCss = read('../public/styles/tasks.css');

  assert.match(tasksPage, /bar\.hidden\s*=\s*!\(state\.bulkSelectMode && selected > 0\)/);
  assert.match(tasksPage, /bar\.classList\.toggle\('bulk-actions-bar--active',\s*selected > 0\)/);
  assert.match(tasksPage, /toggleBtn\.setAttribute\('aria-pressed',\s*String\(state\.bulkSelectMode\)\)/);
  assert.match(tasksCss, /\.bulk-actions-bar\[hidden\]\s*\{[\s\S]*display:\s*none/);
  assert.match(tasksCss, /\.bulk-actions-bar--active\s*\{/);
});

test('phase 3 mobile Shopping quick-add separates name, quantity, category, and add controls', () => {
  const shoppingPage = read('../public/pages/shopping.js');
  const shoppingCss = read('../public/styles/shopping.css');

  assert.match(shoppingPage, /<div class="quick-add__input-wrap">[\s\S]*id="item-name-input"[\s\S]*id="autocomplete-dropdown" hidden[\s\S]*<\/div>\s*<input class="quick-add__qty"/);
  assert.match(
    shoppingCss,
    /\.quick-add__form\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)\s*var\(--target-base\)/
  );
  assert.match(shoppingCss, /\.quick-add__input-wrap\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(shoppingCss, /\.quick-add__qty\s*\{[\s\S]*position:\s*static[\s\S]*min-height:\s*var\(--target-base\)/);
  assert.match(shoppingCss, /\.quick-add__cat\s*\{[\s\S]*min-width:\s*0[\s\S]*min-height:\s*var\(--target-base\)/);
});

test('phase 6 touched UI files continue using design tokens for target sizes', () => {
  const tasks = read('../public/styles/tasks.css');
  const shopping = read('../public/styles/shopping.css');
  const notes = read('../public/styles/notes.css');
  const contacts = read('../public/styles/contacts.css');
  const targetRules = [
    ['../public/styles/tasks.css', tasks, '.task-status-btn'],
    ['../public/styles/shopping.css', shopping, '.quick-add__btn'],
    ['../public/styles/shopping.css', shopping, '.item-check'],
    ['../public/styles/notes.css', notes, '.note-card__pin'],
    ['../public/styles/notes.css', notes, '.note-card__delete'],
    ['../public/styles/contacts.css', contacts, '.contact-action-btn'],
  ];

  for (const [file, source, selector] of targetRules) {
    const body = cssRuleBody(source, selector);
    assert.doesNotMatch(
      body,
      /\b(?:min-)?(?:height|width):\s*(?:[1-9]|[1-3]\d|4[0-3])px\b/,
      `${file} ${selector} should not use sub-44px hardcoded target sizes`
    );
  }

  for (const property of ['width', 'height']) {
    assertRuleUsesToken(tasks, '.task-status-btn', property, '--target-base', '../public/styles/tasks.css');
    assertRuleUsesToken(shopping, '.quick-add__btn', property, '--target-base', '../public/styles/shopping.css');
    assertRuleUsesToken(shopping, '.item-check', property, '--target-base', '../public/styles/shopping.css');
    assertRuleUsesToken(notes, '.note-card__pin', property, '--target-base', '../public/styles/notes.css');
    assertRuleUsesToken(notes, '.note-card__delete', property, '--target-base', '../public/styles/notes.css');
    assertRuleUsesToken(contacts, '.contact-action-btn', property, '--target-lg', '../public/styles/contacts.css');
  }

  assertRuleUsesToken(contacts, '.contact-action-btn', 'min-height', '--target-lg', '../public/styles/contacts.css');
  assertRuleUsesToken(contacts, '.contact-action-btn', 'min-width', '--target-lg', '../public/styles/contacts.css');
});

test('phase 4 keeps Kitchen navigation identity stable', () => {
  const routerSource = read('../public/router.js');

  assert.match(routerSource, /t\('nav\.kitchen'\)/);
  assert.match(routerSource, /t\('nav\.kitchenActiveLabel',\s*\{\s*section/);
  assert.doesNotMatch(routerSource, /kitchenBtnLabel\.textContent\s*=\s*kitchenTarget\.label/);
  assert.doesNotMatch(routerSource, /kitchenBtnIcon\)\s*kitchenBtnIcon\.dataset\.lucide\s*=\s*kitchenTarget\.icon/);
  assert.doesNotMatch(routerSource, /sidebarLabel\)\s*sidebarLabel\.textContent\s*=\s*kitchenTarget\.label/);
  assert.doesNotMatch(routerSource, /sidebarIcon\)\s*sidebarIcon\.dataset\.lucide\s*=\s*kitchenTarget\.icon/);
});

test('global navigation groups domains with translated section labels', () => {
  const routerSource = read('../public/router.js');

  // The grouped main-app navigation references the Overview, Plan and Home label keys
  // and resolves section labels through t().
  assert.match(routerSource, /'nav\.sectionOverview'/);
  assert.match(routerSource, /'nav\.sectionPlan'/);
  assert.match(routerSource, /'nav\.sectionHome'/);
  assert.match(routerSource, /t\(labelKey\)/);

  // The replaced household section label is no longer referenced.
  assert.doesNotMatch(routerSource, /nav\.section\.household/);
});

test('global navigation derives exactly one Kitchen destination', () => {
  const routerSource = read('../public/router.js');

  // Kitchen is inserted once via sidebarKitchenEl(), gated by a single-shot flag.
  assert.equal((routerSource.match(/elements\.push\(sidebarKitchenEl\(\)\)/g) ?? []).length, 1);
  assert.match(routerSource, /if \(!kitchenAdded\)/);
});

test('navigation settings leaf reuses the canonical module-order helpers', () => {
  const leaf = read('../public/settings/pages/modules-navigation.js');

  assert.match(leaf, /import\s*\{[^}]*normalizeModuleOrder[^}]*\}\s*from\s*'\/settings\/module-order\.js'/s);
  assert.match(leaf, /import\s*\{[^}]*expandModuleOrder[^}]*\}\s*from\s*'\/settings\/module-order\.js'/s);
});

test('phase 4 keeps More bottom-nav identity stable while exposing active section accessibly', () => {
  const routerSource = read('../public/router.js');

  assert.match(routerSource, /t\('nav\.moreActiveLabel',\s*\{\s*section:\s*activeSecondary\.label\s*\}\)/);
  assert.match(routerSource, /moreBtnLabel\.textContent\s*=\s*t\('nav\.more'\)/);
  assert.match(routerSource, /replaceNavIcon\(moreBtn,\s*'\.nav-item__icon',\s*'grid-2x2'\)/);
  assert.doesNotMatch(routerSource, /const\s+moreIcon\s*=\s*activeSecondary\s*\?\s*activeSecondary\.icon/);
  assert.doesNotMatch(routerSource, /moreBtnLabel\.textContent\s*=\s*moreLabel/);
});

test('phase 4 locales include More active accessible label', () => {
  const localesDir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

  assert.ok(files.length >= 16, 'expected at least 16 locale files');
  for (const file of files) {
    const data = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8'));
    assert.equal(typeof data.nav?.moreActiveLabel, 'string', `${file}: nav.moreActiveLabel must be a string`);
    assert.match(data.nav.moreActiveLabel, /\{\{section\}\}/, `${file}: nav.moreActiveLabel must include {{section}}`);
  }
});

test('phase 4 touched icon markup uses icon classes instead of inline icon sizing', () => {
  const files = [
    '../public/router.js',
    '../public/pages/settings.js',
    '../public/pages/meals.js',
    '../public/pages/recipes.js',
    '../public/pages/shopping.js',
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /<i\s+[^>]*data-lucide=[^>]*style=["'][^"']*(?:width|height):/s, `${file} must not inline-size Lucide placeholders`);
    assert.doesNotMatch(source, /\.style\.cssText\s*=\s*['"][^'"]*(?:width|height):/, `${file} must not assign inline icon dimensions`);
  }
});

test('phase 4 settings theme toggle uses Lucide placeholders instead of inline SVG icons', () => {
  const settings = read('../public/settings/pages/personal-appearance.js');

  assert.doesNotMatch(settings, /<svg\s+width="18"\s+height="18"[\s\S]*?data-theme-value=/);
  assert.match(settings, /data-lucide="monitor"/);
  assert.match(settings, /data-lucide="sun"/);
  assert.match(settings, /data-lucide="moon"/);
});

test('phase 4 opens search from More sheet in a single handoff', () => {
  const routerSource = read('../public/router.js');

  assert.match(routerSource, /closeSheet\(\{\s*restoreFocus:\s*false\s*\}\)/);
  assert.match(routerSource, /requestAnimationFrame\(\(\) => \{\s*openSearch\(\);/);
});

test('settings cutover: the controller is a thin shell delegate without the legacy monolith', () => {
  const settingsPage = read('../public/pages/settings.js');

  assert.match(settingsPage, /renderSettingsShell/, 'controller must delegate rendering to the shell');
  assert.match(settingsPage, /readStoredSettingsDestination/, 'controller must read & migrate stored settings state');
  assert.doesNotMatch(settingsPage, /settings-tab-panel/, 'controller must not render legacy tab panels');
  assert.doesNotMatch(settingsPage, /data-panel=/, 'controller must not render legacy data-panel attributes');
  assert.doesNotMatch(settingsPage, /settings-nav\.js/, 'controller must not import the removed settings-nav helpers');
  assert.doesNotMatch(settingsPage, /extraClass:\s*'settings-tabs'/, 'controller must not render the legacy sub-tab bar');

  const lineCount = settingsPage.split('\n').length;
  assert.ok(lineCount <= 160, `settings controller should be a thin shell (was ${lineCount} lines)`);
});

test('settings cutover: obsolete navigation modules and stylesheet are removed', () => {
  assert.equal(existsSync(new URL('../public/utils/settings-nav.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../public/styles/settings-nav.css', import.meta.url)), false);
});

test('settings cutover: no obsolete settings-tab / panel references remain in public', () => {
  const offenders = [];
  for (const file of walkFrontendFiles('../public/')) {
    const source = read(file);
    if (/settings-nav\b|settings-tabs\b|settings-tab-panel\b|data-panel=|renderSettingsSidebar\b/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `obsolete settings navigation references remain: ${offenders.join(', ')}`);
});

test('settings cutover: the access-redirected notice is consumed once on the account leaf', () => {
  const account = read('../public/settings/pages/personal-account.js');

  assert.match(account, /oikos:settings:notice/, 'account leaf must read the one-time redirect notice');
  assert.match(account, /accessRedirected/, 'account leaf must surface the access-redirected message');
  assert.match(account, /removeItem\(/, 'account leaf must consume the notice once');
});

test('settings cutover: route direction treats settings sub-paths as one section', () => {
  const routerSource = read('../public/router.js');

  assert.match(
    routerSource,
    /startsWith\('\/settings'\)/,
    'router must normalise /settings sub-paths for title and direction handling',
  );
});

test('phase 6 shared sub-tabs support keyboard tab navigation', () => {
  const source = read('../public/utils/sub-tabs.js');

  assert.match(source, /bar\.addEventListener\('keydown'/);
  assert.match(source, /e\.key === 'ArrowRight'/);
  assert.match(source, /e\.key === 'ArrowLeft'/);
  assert.match(source, /e\.key === 'Home'/);
  assert.match(source, /e\.key === 'End'/);
  assert.match(source, /\.focus\(\)/);
});

// --------------------------------------------------------
// Liquid-Glass-Migration: Regressions-Guards (UX-Audit)
// --------------------------------------------------------

test('calendar week-view time labels use a readable text token, not the disabled token', () => {
  const calendar = read('../public/styles/calendar.css');
  const body = cssRuleBody(calendar, '.week-view__time-label');

  assert.match(body, /color:\s*var\(--color-text-tertiary\)/, 'time labels must use --color-text-tertiary for WCAG AA contrast');
  assert.doesNotMatch(body, /color:\s*var\(--color-text-disabled\)/, 'time labels must not reuse the disabled token (insufficient contrast)');
});

test('calendar month view uses solid work surfaces and explicit chip boundaries', () => {
  const calendar = read('../public/styles/calendar.css');
  const gridBody = cssRuleBody(calendar, '.month-grid');
  const dayBody = cssRuleBody(calendar, '.month-day');
  const eventBody = cssRuleBody(calendar, '.month-day__event');

  assert.match(gridBody, /background-color:\s*var\(--color-border-subtle\)/, 'month grid should expose clear cell boundaries');
  assert.match(gridBody, /gap:\s*var\(--space-px\)/, 'month grid boundaries should use tokenized one-pixel gaps');
  assert.match(dayBody, /background-color:\s*var\(--color-surface-work\)/, 'month cells should use a stable work surface');
  assert.match(eventBody, /border:\s*var\(--space-px\)\s+solid\s+color-mix/, 'event chips need a visible boundary, not color alone');
  assert.match(eventBody, /box-shadow:\s*var\(--shadow-xs\)/, 'event chips should stand out enough for desktop scanning');
});

test('calendar agenda events and task chips keep readable contrast in mobile agenda', () => {
  const calendar = read('../public/styles/calendar.css');
  const eventBody = cssRuleBody(calendar, '.agenda-event');
  const colorBody = cssRuleBody(calendar, '.agenda-event__color');
  const taskBody = cssRuleBody(calendar, '.cal-task-chip');
  const metaBody = cssRuleBody(calendar, '.agenda-event__meta');

  assert.match(eventBody, /background:\s*var\(--color-surface-work\)/, 'agenda rows need a solid surface for mobile contrast');
  assert.match(eventBody, /border:\s*var\(--space-px\)\s+solid\s+var\(--color-border-subtle\)/, 'agenda rows need a boundary in both themes');
  assert.match(colorBody, /width:\s*var\(--space-1\)/, 'agenda color rail should be tokenized and visible');
  assert.match(taskBody, /background:\s*color-mix\(in srgb,\s*currentColor/, 'task chips should tint from their readable text color');
  assert.match(taskBody, /border-color:\s*color-mix\(in srgb,\s*currentColor/, 'task chips should have more than colored text');
  assert.match(metaBody, /color:\s*var\(--color-text-secondary\)/, 'metadata should remain legible in light and dark themes');
});

test('calendar metadata uses lucide icon markup instead of visible emoji', () => {
  const source = read('../public/pages/calendar.js');

  assert.doesNotMatch(source, /📍|🗓|📅|🎂|👤/, 'calendar metadata must not render visible emoji icons');
  assert.match(source, /calendarMetaIconHtml\('map-pin'\)/, 'location metadata should use the shared metadata icon helper');
  assert.match(source, /class="calendar-meta-icon icon-sm"/, 'metadata icons should use tokenized icon classes');
});

test('calendar attachment removal control honors its hidden state', () => {
  const calendarCss = read('../public/styles/calendar.css');
  assert.match(
    calendarCss,
    /#modal-remove-attachment\[hidden\]\s*\{\s*display:\s*none;/,
    'the remove-attachment button must stay hidden for events without an attachment'
  );
});

test('phase 7 calendar inline polish keeps icons and all-day labels tokenized', () => {
  const source = read('../public/pages/calendar.js');
  const calendar = read('../public/styles/calendar.css');
  const allDayLabel = cssRuleBody(calendar, '.calendar-all-day-label');

  assert.doesNotMatch(source, /data-lucide="(?:x|plus|trash-2|repeat)"\s+style=/, 'Lucide icons should use icon utility classes, not inline sizing');
  assert.doesNotMatch(source, /font-size:10px|color:var\(--color-text-disabled\)/, 'all-day labels should not keep low-contrast inline text styles');
  assert.match(source, /calendarRepeatIconHtml\(\)/, 'recurrence markers should share the tokenized repeat icon helper');
  assert.match(source, /class="calendar-all-day-label"/, 'all-day gutter labels should use the shared label class');
  assert.match(allDayLabel, /font-size:\s*var\(--text-xs\)/, 'all-day labels should use a text token');
  assert.match(allDayLabel, /color:\s*var\(--color-text-secondary\)/, 'all-day labels should use readable secondary text');
  assert.match(allDayLabel, /width:\s*var\(--space-12\)/, 'all-day gutter width should use a spacing token');
});

test('phase 7 Budget row actions stay touch-safe on mobile', () => {
  const source = read('../public/pages/budget.js');
  const budget = read('../public/styles/budget.css');
  const deleteRule = cssRuleBody(budget, '.budget-entry__delete');

  assert.match(deleteRule, /width:\s*var\(--target-base\)/, 'Budget delete buttons should use the base touch target width');
  assert.match(deleteRule, /height:\s*var\(--target-base\)/, 'Budget delete buttons should use the base touch target height');
  assert.match(
    budget,
    /@media \(hover:\s*none\), \(max-width:\s*640px\)[\s\S]*\.budget-entry__delete\s*\{[\s\S]*opacity:\s*1/,
    'Budget row actions should be visible on touch/mobile viewports',
  );
  assert.doesNotMatch(source, /data-lucide="(?:plus|trash-2|pencil)"\s+style=/, 'Budget Lucide actions should use icon utility classes');
});

test('sticky section headers stack above glass cards via --z-sticky', () => {
  const stickyHeaders = [
    ['../public/styles/meals.css', '.day-header'],
    ['../public/styles/calendar.css', '.agenda-day__header'],
    ['../public/styles/contacts.css', '.contact-group__header'],
  ];

  for (const [file, selector] of stickyHeaders) {
    const body = cssRuleBody(read(file), selector);
    assert.match(body, /position:\s*sticky/, `${file} ${selector} should be sticky`);
    assert.match(body, /z-index:\s*var\(--z-sticky\)/, `${file} ${selector} must use --z-sticky so glass cards do not scroll over it`);
    assert.doesNotMatch(body, /z-index:\s*var\(--z-base\)/, `${file} ${selector} must not sit on the base layer`);
  }
});

test('every locale resolves the grouped navigation section labels', () => {
  const localesDir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  const sectionKeys = ['sectionOverview', 'sectionPlan', 'sectionHome'];

  assert.ok(files.length >= 16, 'expected at least 16 locale files');
  for (const file of files) {
    const data = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8'));
    for (const key of sectionKeys) {
      assert.equal(typeof data.nav?.[key], 'string', `${file}: nav.${key} must be a string`);
      assert.ok(data.nav[key].length > 0, `${file}: nav.${key} must not be empty`);
    }
    assert.ok(!('section.household' in data.nav), `${file}: nav must not keep the flat "section.household" key (t() cannot resolve it)`);
  }
});

test('phase 7 locale files keep the de reference key set complete', () => {
  const reference = JSON.parse(readFileSync(new URL('de.json', LOCALE_DIR), 'utf8'));
  const referenceKeys = new Set(flattenLocaleKeys(reference));

  assert.ok(referenceKeys.size > 0, 'de locale should expose reference keys');
  for (const file of LOCALES) {
    const data = JSON.parse(readFileSync(new URL(file, LOCALE_DIR), 'utf8'));
    const keys = new Set(flattenLocaleKeys(data));
    const missing = [...referenceKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !referenceKeys.has(key));

    assert.deepEqual(missing, [], `${file} is missing locale keys`);
    assert.deepEqual(extra, [], `${file} has extra locale keys`);
  }
});

test('dark-mode token blocks stay in sync between @media and [data-theme="dark"]', () => {
  const tokens = read('../public/styles/tokens.css');

  const mediaBlock = tokens.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n {2}\}\n\}/);
  const attrBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);

  assert.ok(mediaBlock, 'expected a prefers-color-scheme dark block');
  assert.ok(attrBlock, 'expected a [data-theme="dark"] block');

  const parseVars = (block) => {
    const map = new Map();
    for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      map.set(name, value.trim());
    }
    return map;
  };

  const media = parseVars(mediaBlock[1]);
  const attr = parseVars(attrBlock[1]);

  assert.ok(media.size > 0 && attr.size > 0, 'both dark blocks must declare variables');
  const allKeys = new Set([...media.keys(), ...attr.keys()]);
  const divergent = [...allKeys].filter((k) => media.get(k) !== attr.get(k));
  assert.deepEqual(divergent, [], `dark token blocks diverge for: ${divergent.join(', ')}`);
});

test('phase 1 defines synchronized surface roles for readable work areas', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const mediaBlock = tokens.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n {2}\}\n\}/);
  const attrBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);

  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(mediaBlock, 'expected a prefers-color-scheme dark block');
  assert.ok(attrBlock, 'expected a [data-theme="dark"] block');

  const root = parseTokenMap(rootBlock[1]);
  const media = parseTokenMap(mediaBlock[1]);
  const attr = parseTokenMap(attrBlock[1]);
  const publicSurfaceTokens = [
    '--color-surface-work',
    '--color-surface-raised',
    '--color-surface-glass',
    '--app-backdrop-accent-strength',
    '--app-backdrop-secondary-strength',
  ];
  const privateSurfaceTokens = [
    '--_color-surface-work',
    '--_color-surface-raised',
    '--_color-surface-glass',
    '--_app-backdrop-accent-strength',
    '--_app-backdrop-secondary-strength',
  ];

  for (const token of publicSurfaceTokens) {
    assert.ok(root.has(token), `${token} should be available as a public design token`);
    assert.match(root.get(token), /var\(--_/, `${token} should point at a private theme value`);
  }

  for (const token of privateSurfaceTokens) {
    assert.ok(root.has(token), `${token} should have a light-mode value`);
    assert.ok(media.has(token), `${token} should have a system dark-mode override`);
    assert.ok(attr.has(token), `${token} should have an explicit dark-mode override`);
    assert.equal(media.get(token), attr.get(token), `${token} dark values must stay synchronized`);
  }
});

test('phase 1 keeps productive list surfaces opaque instead of high-transparency glass', () => {
  const glass = read('../public/styles/glass.css');
  const productiveRules = [
    ['.tasks-page .task-card', '--color-surface-work'],
    ['.tasks-page .task-card:hover', '--color-surface-raised'],
    ['.shopping-page .shopping-item:hover', '--color-surface-raised'],
    ['.contacts-page .contact-item:hover', '--color-surface-raised'],
  ];

  for (const [selector, token] of productiveRules) {
    const body = cssRuleBody(glass, selector);
    assert.match(body, new RegExp(`var\\(${token}\\)`), `${selector} should use ${token}`);
    assert.doesNotMatch(body, /var\(--glass-bg-card(?:-hover)?\)/, `${selector} should not use translucent card glass`);
    assert.doesNotMatch(body, /backdrop-filter/, `${selector} should not add blur inside productive lists`);
  }
});

test('phase 1 app backdrop uses subtle tokenized tint and opaque scroll content', () => {
  const glass = read('../public/styles/glass.css');
  const layout = read('../public/styles/layout.css');
  const shellRule = cssRuleBody(glass, '.app-shell');
  const glassContentRule = cssRuleBody(glass, '.app-content');
  const layoutContentRule = cssRuleBody(layout, '.app-content');

  assert.match(shellRule, /var\(--app-backdrop-accent-strength\)/, 'app-shell tint strength should be tokenized');
  assert.match(shellRule, /var\(--app-backdrop-secondary-strength\)/, 'secondary backdrop tint should be tokenized');
  assert.match(glassContentRule, /background-color:\s*var\(--color-bg\)/, 'glass.css should keep scroll content on an opaque readable base');
  assert.doesNotMatch(layoutContentRule, /radial-gradient/, 'layout.css should not put decorative radial gradients on the scroll container');
});

test('phase 2 dashboard primary titles do not split words mid-token', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const selectors = [
    '.dashboard-overview__title',
    '.today-cockpit-card__value',
  ];

  for (const selector of selectors) {
    const body = cssRuleBody(dashboard, selector);
    assert.match(body, /overflow-wrap:\s*normal/, `${selector} should prefer natural word wrapping`);
    assert.match(body, /word-break:\s*normal/, `${selector} should not break German words mid-token`);
    assert.doesNotMatch(body, /overflow-wrap:\s*anywhere/, `${selector} must not use anywhere wrapping`);
  }
});

test('phase 2 mobile dashboard cockpit uses wider important cards with tokenized stable sizing', () => {
  const dashboard = read('../public/styles/dashboard.css');

  assert.match(
    dashboard,
    /@media \(max-width:\s*520px\)[\s\S]*\.today-cockpit-card\s*\{[\s\S]*min-height:\s*calc\(var\(--target-lg\)\s*\+\s*var\(--space-4\)\)/,
    'mobile cockpit cards should keep stable tokenized min-height'
  );
  assert.match(
    dashboard,
    /@media \(max-width:\s*520px\)[\s\S]*\.today-cockpit-card--task,\s*\n\s*\.today-cockpit-card--event\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/,
    'task and event cards should span the mobile cockpit grid for wider text'
  );
  assert.match(
    dashboard,
    /@media \(max-width:\s*520px\)[\s\S]*\.dashboard-action\s*\{[\s\S]*width:\s*var\(--target-base\)[\s\S]*height:\s*var\(--target-base\)/,
    'mobile quick actions should keep tokenized icon-button dimensions'
  );
});

test('phase 2 dashboard FAB uses tokenized position and reserved mobile scroll room', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const fabRule = cssRuleBody(dashboard, '.fab-container');

  assert.match(fabRule, /bottom:\s*calc\(var\(--nav-bottom-height\)\s*\+\s*var\(--space-6\)\)/);
  assert.doesNotMatch(fabRule, /\b24px\b/, 'FAB position should use spacing tokens');
  assert.match(
    dashboard,
    /@media \(max-width:\s*520px\)[\s\S]*\.dashboard-shell\s*\{[\s\S]*padding-bottom:\s*calc\(var\(--target-lg\)\s*\+\s*var\(--space-8\)\)/,
    'mobile dashboard should reserve scroll room for the fixed FAB'
  );
});

test('phase 2 mobile dashboard quick actions keep accessible names when labels are visually compact', () => {
  const dashboardPage = read('../public/pages/dashboard.js');

  assert.match(dashboardPage, /class="dashboard-action \$\{tone \? `dashboard-action--\$\{tone\}` : ''\}" data-route="\$\{route\}" aria-label="\$\{esc\(label\)\}"/);
});

// ============================================================
// UX-Audit Mai 2026 — P2/P3 (docs/UI-UX-AUDIT-2026-05.md)
// ============================================================

const LOCALE_DIR = new URL('../public/locales/', import.meta.url);
const LOCALES = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));

function flattenLocaleKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flattenLocaleKeys(value, fullKey);
    }
    return [fullKey];
  });
}

// --- Kontrast-Helfer (WCAG 2.x relative luminance) ---
function parseTokenMap(block) {
  const map = new Map();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

function resolveColor(name, map) {
  let value = map.get(name);
  let guard = 0;
  while (value && /^var\(/.test(value) && guard++ < 12) {
    const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!ref) break;
    value = map.get(ref[1]);
  }
  return value;
}

function hexToRgb(hex) {
  const m = String(hex).trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `expected a 6-digit hex color, got: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const l1 = relLum(hexToRgb(a));
  const l2 = relLum(hexToRgb(b));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

test('text/surface token pairs meet WCAG AA 4.5:1 in both themes', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);

  // Normaltext-Paare, die laut Design AA erfüllen müssen.
  const pairs = [
    ['--color-text-primary', '--color-surface'],
    ['--color-text-primary', '--color-bg'],
    ['--color-text-secondary', '--color-surface'],
    ['--color-text-secondary', '--color-bg'],
    ['--color-text-tertiary', '--color-bg'],
    ['--color-accent', '--color-surface'],
  ];

  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const fgHex = resolveColor(fg, map);
      const bgHex = resolveColor(bg, map);
      const ratio = contrastRatio(fgHex, bgHex);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${fg} (${fgHex}) on ${bg} (${bgHex}) is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1`,
      );
    }
  }
});

test('modal Enter submits the form instead of advancing to the next field (audit 1.4)', () => {
  const src = read('../public/components/modal.js');
  const enterBlock = src.match(/if \(e\.key === 'Enter'\) \{[\s\S]*?\n {4}\}/);
  assert.ok(enterBlock, 'expected an Enter keydown handler');
  assert.match(enterBlock[0], /submitBtn\.click\(\)/, 'Enter must trigger the submit button');
  assert.doesNotMatch(enterBlock[0], /next\.focus\(\)/, 'Enter must not advance focus to the next field');
});

test('shared modal centrally escapes title and select labels (audit 1.8)', () => {
  const src = read('../public/components/modal.js');
  assert.match(src, /id="shared-modal-title">\$\{esc\(title\)\}/, 'modal title must be escaped');
  assert.match(src, /<option value="\$\{esc\(o\.value\)\}">\$\{esc\(o\.label\)\}/, 'select options must be escaped');
  assert.match(src, /import \{ esc \} from '\/utils\/html\.js'/, 'modal must import esc');
});

test('modal lifecycle uses an explicit state machine, not the old _isClosing flag (audit 1.5)', () => {
  const src = read('../public/components/modal.js');
  assert.match(src, /let modalState = 'idle';/, 'expected an explicit modalState variable');
  assert.match(src, /modalState === 'closing'/, 'close guard must key off modalState');
  assert.doesNotMatch(src, /_isClosing/, 'legacy _isClosing flag must be removed');
});

test('budget chart exposes a screen-reader summary (audit 1.7)', () => {
  const src = read('../public/pages/budget.js');
  assert.match(src, /<p class="sr-only">\$\{esc\(chartSummary\(/, 'chart must render an .sr-only summary');
  assert.match(src, /function chartSummary\(byCategory\)/, 'expected a chartSummary helper');

  for (const file of LOCALES) {
    const json = JSON.parse(read(`../public/locales/${file}`));
    assert.ok(json.budget?.chartSummary, `${file} must define budget.chartSummary`);
    assert.match(json.budget.chartSummary, /\{\{count\}\}/, `${file} chartSummary must interpolate count`);
    assert.match(json.budget.chartSummary, /\{\{top\}\}/, `${file} chartSummary must interpolate top`);
    assert.match(json.budget.chartSummary, /\{\{pct\}\}/, `${file} chartSummary must interpolate pct`);
  }
});

test('toolbar "new" buttons are hidden via a shared class, not an ID list (audit 1.9)', () => {
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.toolbar-new-btn\s*\{\s*display:\s*none\s*!important;/, 'expected .toolbar-new-btn rule');
  assert.doesNotMatch(layout, /#btn-new-task,\s*\n\s*#notes-add-btn/, 'legacy ID-list selector must be gone');

  const pages = {
    '../public/pages/tasks.js': 'btn-new-task',
    '../public/pages/notes.js': 'notes-add-btn',
    '../public/pages/contacts.js': 'contacts-add-btn',
    '../public/pages/budget.js': 'budget-add',
    '../public/pages/calendar.js': 'cal-add',
  };
  for (const [file, id] of Object.entries(pages)) {
    const src = read(file);
    const btn = src.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(btn, `${file} must keep #${id}`);
    assert.match(btn[0], /toolbar-new-btn/, `${file} #${id} must carry the .toolbar-new-btn class`);
  }
});

test('login keeps username-style input hints, not email (audit 1.6 — login is by username)', () => {
  const src = read('../public/pages/login.js');
  const input = src.match(/<input[\s\S]*?id="username"[\s\S]*?\/>/);
  assert.ok(input, 'expected a username input');
  assert.match(input[0], /type="text"/, 'username field stays type=text (login is by username, not email)');
  assert.match(input[0], /autocomplete="username"/);
  assert.match(input[0], /autocapitalize="none"/);
  assert.match(input[0], /autocorrect="off"/);
  assert.doesNotMatch(input[0], /type="email"|inputmode="email"/, 'must not use email keyboard for username login');
});
