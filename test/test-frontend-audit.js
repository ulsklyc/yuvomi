/**
 * Frontend audit regression tests.
 * Guards the accessibility and hard-constraint fixes from the UX audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { SETTINGS_DOMAINS, SETTINGS_LEAVES } from '../public/settings/registry.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');

// Control-IDs stehen seit dem Toggle-Primitiv in zwei Formen im Quelltext:
// literal im Markup (`id="foo"`) und als Option von toggleRowHtml
// (`attrs: { id: 'foo' }`). Beide meinen dasselbe gerenderte Attribut.
const controlIdPattern = (id) => new RegExp(`id="${id}"|id:\\s*['"]${id}['"]`);

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

// Zerlegt jedes `Promise.allSettled([...])` einer Datei in die Namen der
// Destrukturierung und die Top-Level-Eintraege des Arrays, damit der Index eines
// Aufrufs zu seinem Ergebnis-Bezeichner passt.
function settledCalls(source) {
  const marker = 'Promise.allSettled([';
  const calls = [];
  let from = 0;

  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) return calls;

    const names = source.slice(0, start).match(/const\s*\[([^\]]*)\]\s*=\s*await\s*$/);
    const entries = [''];
    let depth = 1;
    let index = start + marker.length;

    while (index < source.length && depth > 0) {
      const char = source[index];
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth -= 1;
      if (depth === 0) break;
      if (char === ',' && depth === 1) entries.push('');
      else entries[entries.length - 1] += char;
      index += 1;
    }

    if (names) calls.push({ names: names[1].split(',').map((name) => name.trim()), entries });
    from = index + 1;
  }
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

// Jeder aus Quelltext gelesene Bezeichner, der in ein RegExp-Literal wandert,
// muss vollstaendig escaped werden - ein Teil-Escape (nur `.`) laesst
// Backslash und die uebrigen Metazeichen stehen und baut ein anderes Muster
// als gemeint (CodeQL js/incomplete-sanitization).
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cssRuleBody(css, selector) {
  const match = css.match(new RegExp(`${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? '';
}

function assertRuleUsesToken(css, selector, property, token, file) {
  const body = cssRuleBody(css, selector);
  assert.match(body, new RegExp(`${property}:\\s*var\\(${token}\\)`), `${file} ${selector} ${property} should use ${token}`);
}

test('audited frontend files do not assign innerHTML', () => {
  const files = [
    '../public/components/yuvomi-install-prompt.js',
    '../public/components/category-manager.js',
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

test('app locale values do not ship German placeholder markers', () => {
  const localeFiles = readdirSync(new URL('../public/locales/', import.meta.url))
    .filter((file) => file.endsWith('.json'));
  const violations = [];

  function collect(value, path, file) {
    if (typeof value === 'string') {
      if (value.includes('[de:')) violations.push(`${file}:${path}`);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) collect(child, path ? `${path}.${key}` : key, file);
  }

  for (const file of localeFiles) {
    collect(JSON.parse(read(`../public/locales/${file}`)), '', file);
  }

  assert.deepEqual(violations, []);
});

test('English and French user multi-select none labels are localized', () => {
  const en = JSON.parse(read('../public/locales/en.json'));
  const fr = JSON.parse(read('../public/locales/fr.json'));

  assert.equal(en.userMultiSelect.nobody, '- No one -');
  assert.equal(fr.userMultiSelect.nobody, '- Personne -');
});

test('dynamic frontend translation key domains exist in every locale', () => {
  const familyRoles = ['dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other'];
  const documentCategories = ['medical', 'school', 'identity', 'insurance', 'finance', 'home', 'vehicle', 'legal', 'travel', 'pets', 'warranty', 'taxes', 'work', 'other'];
  const documentVisibilities = ['family', 'restricted', 'private'];
  const dashboardBudgetLabels = ['catHousing', 'catFood', 'catTransport', 'catPersonalHealth', 'catLeisure', 'catShoppingClothing', 'catEducation', 'catFinancialOther', 'catEarnedIncome', 'catInvestmentIncome', 'catTransferGiftIncome', 'catGovernmentBenefits', 'catOtherIncome'];
  const splitGroupTypes = ['household', 'couple', 'travel', 'event', 'shopping', 'general'];
  const splitMethods = ['equal', 'exact', 'percentage', 'shares'];
  // Handpflege dieser Liste reicht nicht — sie hatte member_removed jahrelang
  // nicht. Der Guard „split activity feed translates every type the backend
  // writes" leitet die Typen direkt aus dem Server-Code ab.
  const splitActivityTypes = ['group_created', 'group_updated', 'group_archived', 'member_added', 'member_removed', 'guest_created', 'expense_created', 'expense_edited', 'expense_deleted', 'comment_added', 'payment_registered', 'recurring_created', 'recurring_paused', 'recurring_resumed', 'recurring_generated'];

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
    'nav.sectionHousehold',
    'nav.sectionPeople',
    'nav.sectionFinance',
    'nav.sectionCustomModules',
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

test('service worker release caches track package version and include the early locale bootstrap', () => {
  const pkg = JSON.parse(read('../package.json'));
  const sw = read('../public/sw.js');
  const release = sw.match(/const APP_RELEASE\s*=\s*['"]([^'"]+)['"]/)?.[1];

  assert.equal(release, pkg.version, 'Service worker APP_RELEASE must match package.json');
  assert.match(sw, /const SHELL_CACHE\s*=\s*`yuvomi-shell-\$\{APP_RELEASE\}`/);
  assert.match(sw, /const PAGES_CACHE\s*=\s*`yuvomi-pages-\$\{APP_RELEASE\}`/);
  assert.match(sw, /['"]\/lang-init\.js['"]/, 'early lang/dir bootstrap must be available offline');
});

test('an announced update stops the router from loading further page modules (#616)', () => {
  const router = read('../public/router.js');

  // Die Modul-Map eines Dokuments lässt sich nicht leeren. Wird nach einem
  // SW-Update noch ein Seitenmodul nachgeladen, bindet der Browser es gegen die
  // bereits geladenen, alten geteilten Module - ein neu hinzugekommener Export
  // fliegt dann als SyntaxError auf. Erlaubt ist deshalb nur noch der Reload.
  assert.match(router, /shellStale\s*=\s*true;/, 'SW_UPDATED must mark the running shell as stale');
  assert.match(router, /if \(shellStale && reloadOnce\(\)\)/, 'importPage() must reload instead of importing a page module');
  assert.match(router, /function prefetchRoute\(path\) \{[\s\S]*?if \(shellStale\) return;/, 'prefetchRoute() must stop warming modules after an update');
  assert.doesNotMatch(
    router,
    /SW_UPDATED[\s\S]{0,400}moduleCache\.clear\(\)/,
    'moduleCache.clear() on SW_UPDATED is ineffective - it empties only the router map, not the document module map',
  );
});

test('runtime locale changes keep language and writing direction synchronized', () => {
  const i18n = read('../public/i18n.js');
  const router = read('../public/router.js');

  assert.match(i18n, /const RTL_LOCALES\s*=\s*new Set\(\[['"]ar['"],\s*['"]fa['"]\]\)/);
  assert.match(i18n, /function applyDocumentLocale\(locale\)/);
  assert.match(i18n, /document\.documentElement\.lang\s*=\s*locale/);
  assert.match(i18n, /document\.documentElement\.dir\s*=\s*RTL_LOCALES\.has\(locale\)\s*\?\s*['"]rtl['"]\s*:\s*['"]ltr['"]/);
  assert.equal((i18n.match(/applyDocumentLocale\(/g) || []).length, 3);
  assert.match(
    router,
    /window\.addEventListener\(['"]locale-changed['"],\s*\(\)\s*=>\s*\{[\s\S]*rebuildNavigation\(\);[\s\S]*refreshCurrentRoute\(\);[\s\S]*\}\);/
  );
});

test('install prompt waits for initial translations before rendering text', () => {
  const i18n = read('../public/i18n.js');
  const prompt = read('../public/components/yuvomi-install-prompt.js');

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
  assert.match(source, /window\.yuvomi\?\.navigate\('\/login'\)/);
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

  assert.match(source, /await getPreferences\(\)/);
  assert.match(source, /getSupportedLocales\(\)/);
  assert.match(source, /setLocale\(/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /setAttribute\('aria-pressed'/);
  assert.match(source, /data-lucide="monitor"/);
  assert.match(source, /data-lucide="sun"/);
  assert.match(source, /data-lucide="moon"/);
  assert.match(source, /date_format/);
  assert.match(source, /time_format/);
  assert.match(source, /savePreferences\(\{/);
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
  // Datums- und Zeitformat gelten haushaltweit und sind fuer jedes Mitglied
  // aenderbar (server/routes/preferences.js). Der Hinweis muss an beiden
  // Selects haengen, sonst behauptet das Blatt wieder das Gegenteil.
  assert.match(source, /id="formats-household-hint"[^>]*>\$\{t\('settings\.formatsHouseholdHint'\)\}/);
  assert.match(source, /id="date-format-select"[^>]*aria-describedby="formats-household-hint date-format-error"/);
  assert.match(source, /id="time-format-select"[^>]*aria-describedby="formats-household-hint time-format-error"/);
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
    '../public/settings/pages/modules-options.js',
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
        '/preferences/holidays/groups/',
        '/preferences/holidays/subdivisions/',
        '/preferences/holidays/sync',
      ],
      preferences: [
        'calendar_default_duration',
        'week_start',
        'holiday_country',
        'holiday_subdivision',
        'holiday_group',
        'holiday_show_public',
        'holiday_show_school',
        'holiday_public_color',
        'holiday_school_color',
        'holiday_last_sync',
      ],
    },
    '../public/settings/pages/modules-options.js': {
      endpoints: ['/preferences'],
      preferences: ['budget_mode', 'health_cycle_enabled', 'housekeeping_payment_tasks', 'tasks_subtasks_expanded'],
    },
  };

  for (const [file, approved] of Object.entries(ownership)) {
    const source = read(file);
    const endpoints = [
      ...source.matchAll(/\bapi\.(?:get|put|post|patch|delete)\(\s*`([^`$]*)/g),
      ...source.matchAll(/\bapi\.(?:get|put|post|patch|delete)\(\s*['"]([^'"]+)/g),
    ].map((match) => match[1]);
    // getPreferences()/savePreferences() sind `/preferences` - der Cache steht
    // dazwischen, der Endpunkt bleibt derselbe (Critique 2026-07-27).
    if (/\b(?:get|save)Preferences\(/.test(source)) endpoints.push('/preferences');
    const preferenceKeys = new Set(
      [...source.matchAll(/\b(?:preferences|preferenceData)\.([a-z][a-z0-9_]*)/g)]
        .map((match) => match[1]),
    );
    for (const match of source.matchAll(/savePreferences\(\s*\{([\s\S]*?)\}\s*\)/g)) {
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

// `api.get('/preferences')` liefert den `{ data }`-Envelope, `getPreferences()`
// dagegen das bereits entpackte Objekt. Beim Umstellen der Blaetter auf den
// Cache blieb in modules-navigation.js ein `?.data` stehen: `preferences` war ab
// v1.49.0 dauerhaft leer, `disabled_modules` kam nie an, und jede abgehakte
// Checkbox sprang beim Re-Render zurueck (#615). Der Guard laeuft ueber jede
// Datei, die den Cache benutzt - eine Allowlist deckte nur diese eine Datei ab,
// nicht die Regel.
test('preferences cache consumers never unwrap a data envelope', () => {
  const consumers = walkJsFiles('../public/').filter((file) => /\bgetPreferences\(/.test(read(file)));
  assert.ok(consumers.length >= 8, 'expected the settings leaves to read preferences through the cache');

  for (const file of consumers) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /getPreferences\(\)\s*\)*\s*\??\.data\b/,
      `${file} must not read .data off getPreferences() - it already returns the preferences object`,
    );

    const bindings = [...source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+getPreferences\(\)/g)]
      .map((match) => match[1]);
    for (const call of settledCalls(source)) {
      call.entries.forEach((entry, index) => {
        if (/\bgetPreferences\(/.test(entry) && call.names[index]) bindings.push(`${call.names[index]}.value`);
      });
    }

    for (const binding of bindings) {
      assert.doesNotMatch(
        source,
        new RegExp(`${escapeForRegExp(binding)}\\s*\\??\\.data\\b`),
        `${file} must not read .data off the cached preferences (${binding})`,
      );
    }
  }
});

test('module-specific settings leaves preserve their required controls and behaviors', () => {
  const kitchen = read('../public/settings/pages/modules-kitchen.js');
  assert.match(kitchen, /const MEAL_TYPES = \['breakfast', 'lunch', 'dinner', 'snack'\]/);
  assert.match(kitchen, /await getPreferences\(\)/);
  assert.match(kitchen, /savePreferences\(\{ visible_meal_types: checkedMealTypes \}\)/);
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
    assert.match(calendar, controlIdPattern(id));
  }
  assert.match(calendar, /api\.get\('\/preferences\/holidays\/countries'\)/);
  assert.match(calendar, /api\.get\(`\/preferences\/holidays\/subdivisions\/\$\{countryCode\}`\)/);
  assert.match(calendar, /api\.post\('\/preferences\/holidays\/sync', \{\}\)/);
  // Die per-user-Vorgaben sind nach personal-calendar gezogen; hier bleibt nur
  // Haushaltweites plus der Verweis dorthin (Critique 2026-07-27).
  assert.doesNotMatch(calendar, /id="calendar-default-assign-me"|js-default-reminder/);
  assert.match(calendar, /\/settings\/personal\/calendar/);
  assert.doesNotMatch(calendar, /caldav|carddav|google|apple|subscriptions|sync accounts/i);
  assert.doesNotMatch(calendar, /#[0-9a-f]{6}/i);
  assert.match(calendar, /id="holiday-country" disabled/);
  assert.ok(
    calendar.indexOf("form.addEventListener('submit'") <
      calendar.indexOf('const countriesResult = await runHolidayDiscovery'),
    'Calendar must bind submit handling before loading holiday discovery data',
  );

  // Budget, Gesundheit und Haushaltshilfe hatten je ein Blatt für je eine
  // Checkbox (Critique 2026-07-27). Sie teilen sich jetzt eines - mit genau
  // diesen Schaltern (Aufgaben kam später dazu) und einem einzigen
  // /preferences-Request statt einem pro Schalter.
  const options = read('../public/settings/pages/modules-options.js');
  for (const id of ['budget-mode-personal', 'health-cycle-enabled', 'housekeeping-payment-tasks', 'tasks-subtasks-expanded']) {
    assert.match(options, controlIdPattern(id));
  }
  // Genau diese Schalter, sonst nichts: sie kommen aus dem geteilten Primitiv,
  // deshalb zählt das Blatt keine `<input>`-Literale mehr.
  assert.equal([...options.matchAll(/toggleRowHtml\(\{/g)].length, 4);
  assert.equal([...options.matchAll(/<(?:input|select|textarea)\b/g)].length, 0);
  assert.equal([...options.matchAll(/getPreferences\(\)/g)].length, 1);
  assert.match(options, /budget_mode: checked \? 'personal' : 'shared'/);
  // Die Währung sitzt in der vereinheitlichten Region/Format-Karte; das Blatt
  // trägt nur noch den Verweis dorthin, keine eigene Auswahl.
  assert.doesNotMatch(options, /id="currency-select"/);
  assert.match(options, /\/settings\/personal\/appearance/);
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

  // Konto-Felder kommen als camelCase aus listAccounts() - snake_case lieferte
  // dauerhaft „Nie synchronisiert" und verschluckte die URL (#534-Nachlauf).
  assert.match(source, /account\.lastSync/);
  assert.match(source, /account\.caldavUrl/);
  assert.doesNotMatch(source, /account\.last_sync|account\.caldav_url/);
  // Checkbox-Toggles geben den Tastaturfokus zurück.
  assert.match(source, /import \{ withBusy \} from '\/utils\/ux\.js'/);
  assert.doesNotMatch(source, /checkbox\.disabled = true/);
  // Gleiche Aufklapp-Grammatik wie Kontakt-Sync (createDisclosure, kein <details>),
  // und die Löschbestätigung nennt das Konto beim Namen.
  assert.match(source, /createDisclosure\(\{[\s\S]*?caldav-calendars-/);
  assert.doesNotMatch(source, /createElement\('details'\)/);
  assert.match(source, /disconnectAccountConfirmTitle', \{ name: account\.name \}/);

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
  // Toggle geht per PUT auf die Adressbuch-ID, nicht auf einen Konto-Unterpfad (#534).
  assert.match(source, /api\.put\(`\/contacts\/cardav\/addressbooks\/\$\{[^}]+\}`/);
  assert.doesNotMatch(source, /addressbooks\/toggle/);
  assert.match(source, /addressbooks\/refresh/);
  assert.match(source, /\/contacts\/cardav\/accounts\/\$\{[^}]+\}\/sync/);
  // Konto-Felder kommen als camelCase aus getAllAccounts (#534).
  assert.match(source, /account\.lastSync/);
  assert.doesNotMatch(source, /account\.last_sync|account\.cardav_url/);

  // Audit-Nachlauf: Toggles und Aktionen laufen über withBusy (Fokus-Rückgabe,
  // aria-busy), zerstörende Aktion ist als danger-outline ausgewiesen, und die
  // Fehlerkarte bietet einen Ausweg statt einer Sackgasse.
  assert.match(source, /import \{ withBusy \} from '\/utils\/ux\.js'/);
  assert.match(source, /withBusy\(checkbox/);
  assert.match(source, /loadingClass: 'btn--loading'/);
  assert.match(source, /btn--danger-outline/);
  assert.match(source, /function buildUnreachableAccount/);
  assert.match(source, /t\('common\.retry'\)/);

  // Critique-Nachlauf: Bestätigung nennt das Konto, Passwortfeld ist ein neues
  // (nicht das App-Passwort), Formularfehler sind feldbezogen, und der Sync
  // meldet keinen Erfolg ohne aktiviertes Adressbuch.
  assert.match(source, /disconnectAccountConfirmTitle', \{ name: account\.name \}/);
  // Fremdserver-Passwort: weder das App-Passwort anbieten (current-password)
  // noch ein generiertes vorschlagen (new-password).
  assert.match(source, /id="cardav-password"[^>]*autocomplete="off"/);
  assert.doesNotMatch(source, /autocomplete="(current|new)-password"/);
  assert.match(source, /cardavCredentialsTrustHint/);
  assert.match(source, /wireBlurValidation\(form\)/);
  assert.match(source, /if \(!validateAll\(form\)\) return;/);
  assert.doesNotMatch(source, /t\('common\.allFieldsRequired'\)/);
  // Inaktiver Sync-Button bleibt tabbar: aria-disabled statt disabled, Klick
  // wird im Handler verworfen, Grund steht sichtbar in der Statuszeile.
  assert.match(source, /syncBtn\.setAttribute\('aria-disabled'/);
  assert.doesNotMatch(source, /syncBtn\.disabled = /);
  assert.doesNotMatch(source, /syncBtn\.title = /);
  assert.match(source, /aria-disabled'\) === 'true'\) return;/);
  assert.match(source, /syncBtn\.setAttribute\('aria-describedby'/);
  assert.match(source, /noAddressbookEnabled/);
  assert.match(source, /notSyncedYet/);
  // Genau eine Zahl je Karte: „N von M", kein zweiter Zähler als Aufzählungspunkt.
  assert.match(source, /addressbooksEnabledOfTotal/);
  assert.doesNotMatch(source, /key: 'addressbook-count'/);

  // Konto bearbeiten (statt löschen + neu anlegen), Sammelschalter und
  // sichtbare Sync-Teilfehler - die drei offenen Punkte aus dem Critique.
  assert.match(source, /api\.put\(`\/contacts\/cardav\/accounts\/\$\{account\.id\}`/);
  assert.match(source, /settings\.cardavEditAccount/);
  assert.match(source, /settings\.enableAll/);
  assert.match(source, /settings\.disableAll/);
  assert.match(source, /account\.lastError/);
  assert.match(source, /settings\.syncErrorDetail/);
  // Geteilte Aufklapp-Komponente statt rohem <details>.
  assert.match(source, /createDisclosure\(\{/);
  assert.doesNotMatch(source, /createElement\('details'\)/);
  assert.doesNotMatch(source, /details = \[t\('settings\.cardavTitle'\)\]/, 'Modultitel nicht als Detailzeile wiederholen');

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

  // Konto-Felder als camelCase, Toggle mit Fokus-Rückgabe (#534-Nachlauf).
  assert.match(source, /account\.lastSync/);
  assert.match(source, /account\.caldavUrl/);
  assert.doesNotMatch(source, /account\.last_sync|account\.caldav_url/);
  assert.match(source, /import \{ withBusy \} from '\/utils\/ux\.js'/);

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
      /import \{ api \} from (['"])\/api\.js\1/,
      `${file} must import the shared API client`,
    );
  }
});

test('documents-storage leaf owns hybrid document storage with a status-first layout', () => {
  const source = read('../public/settings/pages/documents-storage.js');

  // Storage config + test endpoints preserved unchanged.
  assert.match(source, /api\.get\((['"])\/documents\/storage\/config\1\)/);
  assert.match(source, /api\.put\((['"])\/documents\/storage\/config\1/);
  assert.match(source, /api\.post\((['"])\/documents\/storage\/test\1/);

  // Status-first: render the active backend and target before the connection fields.
  assert.match(source, /createStatusSummary\(/);
  assert.match(source, /active_upload_backend/);
  assert.match(source, /selected_upload_backend/);
  assert.match(source, /webdav_document_count/);
  assert.match(source, /google_drive/);
  assert.match(source, /documentStorageTarget/);

  // Drive uses the shared API client and a normal anchor for OAuth.
  assert.match(source, /\/documents\/storage\/google-drive\/auth/);
  assert.match(source, /api\.post\((['"])\/documents\/storage\/google-drive\/test\1/);
  assert.match(source, /api\.delete\((['"])\/documents\/storage\/google-drive\/disconnect\1/);
  assert.match(source, /createSettingRow\(/);
  assert.match(source, /drive_ok/);
  assert.match(source, /drive_error/);
  assert.match(source, /history\.replaceState/);
  assert.match(source, /settings\.documentStorageGoogleDrivePrivacy/);

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

test('documents-dms leaf owns DMS account management (Paperless + Papra)', () => {
  const source = read('../public/settings/pages/documents-dms.js');

  assert.match(source, /api\.get\('\/documents\/dms\/accounts'\)/);
  assert.match(source, /api\.post\('\/documents\/dms\/accounts'/);
  assert.match(source, /api\.delete\(`\/documents\/dms\/accounts\/\$\{[^}]+\}`\)/);
  assert.match(source, /\/documents\/dms\/accounts\/\$\{[^}]+\}\/test/);
  assert.match(source, /value="paperless"/);
  assert.match(source, /value="papra"/);

  // DMS leaf must not own storage concerns.
  assert.doesNotMatch(source, /\/documents\/storage/);
});

test('administration-domain leaves exist and export async render functions', () => {
  const files = [
    '../public/settings/pages/admin-family.js',
    '../public/settings/pages/admin-api.js',
    '../public/settings/pages/admin-backup.js',
    '../public/settings/pages/admin-weather.js',
    '../public/settings/pages/admin-system.js',
  ];

  for (const file of files) {
    assert.equal(existsSync(new URL(file, import.meta.url)), true, `${file} must exist`);
    const source = read(file);
    assert.match(source, /export async function render\(container,\s*\{[^}]*\}(?:\s*=\s*\{\})?\)/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, `${file} must not assign innerHTML`);
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must use the shared API client`);
    assert.doesNotMatch(source, /\brequire\(/, `${file} must use import, not require`);
    // Entweder direkt oder über einen geteilten Settings-Baustein
    // (preferences-cache, weather-location) - nie über rohes fetch.
    assert.match(
      source,
      /import \{ api(?:,\s*auth)? \} from '\/api\.js'|from '\/settings\/(?:preferences-cache|weather-location)\.js'/,
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

test('personal-calendar leaf owns only the per-user event defaults', () => {
  const source = read('../public/settings/pages/personal-calendar.js');

  assert.match(source, controlIdPattern('calendar-default-assign-me'));
  assert.match(source, /id="calendar-default-reminders"/);
  assert.match(source, /savePreferences\(\{ calendar_default_assign_me: value \}\)/);
  assert.match(source, /savePreferences\(\{ calendar_default_reminders: selected \}\)/);
  // Die Grenze muss auf dem Blatt stehen, sonst erklärt nichts, warum
  // Standarddauer und Wochenstart hier fehlen.
  assert.match(source, /settings\.calendarDefaultsScopeHint/);

  // Haushaltweites bleibt im adminOnly-Kalenderblatt.
  assert.doesNotMatch(source, /week_start|calendar_default_duration|holiday_/);
});

// Das Standortformular selbst liegt in weather-location.js: admin-weather und
// personal-weather rendern dieselben fünf Felder mit denselben i18n-Keys, und
// requestLocation samt Koordinatenvalidierung lag zweimal im Baum
// (Critique 2026-07-27).
test('beide Wetter-Blätter rendern dasselbe Standortformular', () => {
  const shared = read('../public/settings/weather-location.js');
  for (const field of ['lat', 'lon', 'city', 'units', 'auto-locate', 'locate-btn']) {
    assert.match(shared, new RegExp(`id="\\$\\{scope\\}-${field}"|id: \`\\$\\{scope\\}-${field}\``));
  }
  assert.match(shared, /latitude >= -90/);
  assert.match(shared, /latitude <= 90/);
  assert.match(shared, /longitude >= -180/);
  assert.match(shared, /longitude <= 180/);
  // Genau ein requestLocation im ganzen Settings-Baum.
  const owners = walkFrontendFiles('../public/settings/')
    .filter((path) => /function requestLocation\(/.test(read(path)));
  assert.deepEqual(owners, ['../public/settings/weather-location.js']);

  for (const leaf of ['admin-weather', 'personal-weather']) {
    const source = read(`../public/settings/pages/${leaf}.js`);
    assert.match(source, /weatherLocationFieldsHtml\(\{/, `${leaf} muss das geteilte Formular rendern`);
    assert.match(source, /bindWeatherLocationEvents\(container, SCOPE\)/);
    assert.match(source, /hasValidWeatherCoords\(location\.lat, location\.lon\)/);
    assert.doesNotMatch(source, /navigator\.geolocation/, `${leaf} darf Geolocation nicht selbst anfassen`);
  }
});

test('admin-weather leaf owns the household default location', () => {
  const source = read('../public/settings/pages/admin-weather.js');

  assert.match(source, /HOUSEHOLD_WEATHER_SCOPE as SCOPE/);
  assert.match(source, /weather_provider: 'open-meteo'/);
  assert.match(source, /weather_provider: null/);
  assert.match(source, /window\.yuvomi\?\.showToast/);
  assert.match(source, /await render\(container, \{ user \}\)/);
  // Die Vorrangregel muss auf dem Blatt stehen: personal-weather überschreibt
  // diesen Standort, und ohne den Hinweis erklärt das nichts (Critique 2026-07-27).
  assert.match(source, /settings\.householdWeatherOverrideHint/);

  // Der Anwendungsname ist beim IA-Umbau zu admin-system gewandert.
  assert.doesNotMatch(source, /app_name|app-name-input|APP_NAME_STORAGE_KEY/);
  assert.doesNotMatch(source, /\/version/);
});

test('admin-system leaf owns the app name next to the read-only version rows', () => {
  const source = read('../public/settings/pages/admin-system.js');

  assert.match(source, /api\.get\('\/version'\)/);
  assert.match(source, /settings\.systemVersionLabel/);
  assert.match(source, /MIT/);
  assert.match(source, /setup_required/);

  // Der Anwendungsname lag in "Übersicht", während die Description dieses Blatts
  // ihn versprach und nur read-only zeigte (Critique 2026-07-27).
  assert.match(source, /id="app-name-input"/);
  assert.match(source, /savePreferences\(\{ app_name: value \}\)/);
  assert.match(source, /new CustomEvent\('app-name-changed'/);
  assert.match(source, /localStorage\.setItem\(key, value\)/);
  assert.match(source, /localStorage\.removeItem\(key\)/);
  // Die read-only Zeile daneben wäre der gleiche Wert zweimal auf einer Seite.
  assert.doesNotMatch(source, /systemAppNameLabel/);

  // System leaf owns no other backend domain and no secrets.
  assert.doesNotMatch(source, /\/documents\//);
  assert.doesNotMatch(source, /\/backup\//);
  assert.doesNotMatch(source, /\/auth\/api-tokens/);
  assert.doesNotMatch(source, /weather_/);
});

test('Shopping uses the shared category manager component (Audit F-15)', () => {
  const component = read('../public/components/category-manager.js');
  assert.match(component, /customElements\.define\(\s*'yuvomi-category-manager'/);
  assert.match(component, /import \{ api \} from '\/api\.js'/);
  assert.match(component, /import \{ t \} from '\/i18n\.js'/);
  assert.match(component, /import \{ esc \} from '\/utils\/html\.js'/);
  // Schlüssel-Helper: Budget/Tasks/Kontakte liefern `key`, Einkauf numerische `id`.
  assert.match(component, /item\.key \?\? item\.id/);
  assert.match(component, /disconnectedCallback\(\)/);
  assert.match(component, /removeEventListener/);
  assert.doesNotMatch(component, /#[0-9a-f]{6}/i);

  const shopping = read('../public/pages/shopping.js');
  assert.match(shopping, /components\/category-manager\.js/);
  assert.match(shopping, /<yuvomi-category-manager>/);
  assert.match(shopping, /basePath: '\/shopping\/categories'/);
  assert.match(shopping, /shopping\.manageCategories/);
  assert.match(shopping, /category-manager-changed/);
  // onClose muss den Listener wieder abräumen (kein Leak bei Modal-Reuse).
  const openMgr = shopping.match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(openMgr, /manager\?\.removeEventListener\('category-manager-changed'/);

  // Die frühere Shopping-Sonderkomponente ist entfernt — kein Duplikat mehr.
  assert.equal(existsSync(new URL('../public/components/shopping-category-manager.js', import.meta.url)), false);
});

test('Kitchen settings copy directs Recipes and Shopping content settings to their modules', () => {
  const english = JSON.parse(read('../public/locales/en.json'));
  const german = JSON.parse(read('../public/locales/de.json'));
  const kitchenPage = read('../public/settings/pages/modules-kitchen.js');

  // Der Zeiger stand in der Leaf-Description und machte sie zum einzigen
  // Zweisatz unter 24 (Critique 2026-07-27). Er lebt jetzt als Hinweis auf dem
  // Blatt selbst - dieselbe Information, an der Stelle, wo sie gebraucht wird.
  assert.match(kitchenPage, /t\('settings\.kitchenExternalHint'\)/);
  assert.match(english.settings.kitchenExternalHint, /Recipes/);
  assert.match(english.settings.kitchenExternalHint, /Shopping/);
  assert.match(english.settings.kitchenExternalHint, /modules/);
  assert.match(german.settings.kitchenExternalHint, /Rezepte/);
  assert.match(german.settings.kitchenExternalHint, /Einkauf/);
  assert.match(german.settings.kitchenExternalHint, /Modulen/);
});

test('Recipes expose meal-type suitability controls for planner integrations', () => {
  const recipesPage = read('../public/pages/recipes.js');
  const recipesCss = read('../public/styles/recipes.css');

  assert.match(recipesPage, /normalizeRecipeMealTypes/);
  assertKeysExistInEveryLocale(['recipes.dragToMealsHint']);
  assert.match(recipesPage, /id="recipe-meal-types"/);
  assert.match(recipesPage, /input type="checkbox" value="\$\{option\.key\}" checked/);
  assert.match(recipesPage, /meal_types/);
  assert.match(recipesCss, /\.recipe-meal-types\s*\{/);
  assert.match(recipesCss, /\.recipe-card__meal-types\s*\{/);
});

test('Meals page adds a recipe sidebar and randomize planner controls', () => {
  const mealsPage = read('../public/pages/meals.js');
  const mealsCss = read('../public/styles/meals.css');

  assert.match(mealsPage, /id="week-randomize"/);
  assert.match(mealsPage, /id="recipe-sidebar"/);
  assert.match(mealsPage, /recipes\.dragToMealsHint/);
  assert.match(mealsPage, /function renderRecipeSidebar/);
  assert.match(mealsPage, /function openRandomizeModal/);
  assert.match(mealsPage, /function wireRecipeSidebar/);
  assert.match(mealsPage, /confirmModal\(t\('meals\.replaceExistingConfirm'\)/, 'dropping onto occupied slots should use a dedicated localized confirmation string');
  assert.match(mealsPage, /recipeSupportsMealType/);
  assert.match(mealsCss, /\.meals-layout\s*\{/);
  assert.match(mealsCss, /\.recipe-sidebar\s*\{/);
  assert.match(mealsCss, /\.week-nav__randomize\s*\{/);
  assertKeysExistInEveryLocale([
    'meals.randomizePlan',
    'meals.randomizeTitle',
    'meals.randomizeReplaceExisting',
    'meals.replaceExistingConfirm',
    'meals.randomizeSuccess',
    'meals.randomizeWeekFull',
    'meals.randomizeNoRecipes',
  ]);
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

test('user multi-select option is the containing block of its hidden checkbox (#483)', () => {
  // The checkbox is position:absolute + opacity:0 (visually hidden but focusable).
  // Without position:relative on the option, it resolves against the overflow:hidden
  // .modal-panel, so tapping a member scrolls the panel instead of the modal body —
  // a large blank block appears and later fields become unreachable on mobile.
  const css = read('../public/styles/user-multi-select.css');
  assert.match(
    css,
    /\.user-ms__option\s*\{[^}]*position:\s*relative/,
    '.user-ms__option must declare position: relative',
  );
  assert.match(
    css,
    /\.user-ms__checkbox\s*\{[^}]*position:\s*absolute/,
    'guard assumes .user-ms__checkbox stays position: absolute',
  );
});

test('responsive settings shell defines desktop and mobile navigation layouts', () => {
  const source = read('../public/styles/settings.css');

  assert.match(
    source,
    /@media \(min-width:\s*1024px\)[\s\S]*\.settings-shell__navigation\s*\{[\s\S]*position:\s*sticky/,
  );
  assert.match(
    source,
    /@media \(max-width:\s*1023px\)[\s\S]*\.settings-mobile-overview\s*\{/,
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

test('push client re-registers an orphaned subscription', () => {
  const source = read('../public/push.js');

  // App-Start: bestehendes Abo nachregistrieren, sonst bleibt ein serverseitig
  // entferntes Abo (410, DB-Restore) dauerhaft stumm.
  assert.match(source, /if \(st\.subscribed\) await resyncSubscription\(\)/);
  assert.match(source, /async function resyncSubscription\(\)/);
  assert.match(source, /api\.post\('\/push\/subscribe', sub\.toJSON\(\)\)/);
  // Reparatur erkennt ein Abo auf einem veralteten VAPID-Key und legt es neu an.
  assert.match(source, /async function repairPush\(\)/);
  assert.match(source, /!matchesServerKey\(sub, serverKey\)/);
  assert.match(source, /await sub\.unsubscribe\(\)/);
  // Nie ungefragt nachfragen: Reparatur setzt eine erteilte Berechtigung voraus.
  assert.match(source, /Notification\.permission !== 'granted'\) return false/);
});

test('notification settings report real delivery and self-heal once', () => {
  const source = read('../public/settings/pages/notifications.js');

  // Erfolgsmeldung nur bei tatsaechlich zugestelltem Push.
  assert.match(source, /sent = Number\(res\?\.data\?\.sent\) \|\| 0/);
  assert.match(source, /if \(sent > 0\) status\.textContent = t\('settings\.pushTestSent'\)/);
  assert.match(source, /t\('settings\.pushTestFailed'\)/);
  assert.match(source, /t\('settings\.pushTestNoDevice'\)/);
  // Genau ein Reparaturversuch, kein Retry-Loop: ein regulaerer Versand plus
  // hoechstens einer nach der Reparatur.
  assert.match(source, /repaired = await repairPush\(\)/);
  assert.equal(source.match(/await sendTest\(\)/g).length, 2);
  // iOS ohne Home-Screen-Installation bekommt den Grund genannt, nicht "nicht unterstuetzt".
  assert.match(source, /getPwaInstallState\(\)\.ios/);
  assert.match(source, /t\('settings\.pushIosNotInstalled'\)/);
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

  assert.match(source, /if \(!domain\)\s*\{[\s\S]*console\.error\([\s\S]*renderDomainsOverview\(content,\s*domains(?:,\s*user)?\)/);
  assert.match(source, /else\s*\{[\s\S]*await renderLeafContent\(content,\s*activeLeaf,\s*domain,\s*user,\s*query\)/);
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
  // Der zugängliche Name muss aus `moreLabel` entstehen (es trägt den aktiven
  // Abschnitt). Ob noch etwas angehängt wird - seit #490 der Update-Hinweis -
  // ist offen; ersetzt werden darf `moreLabel` nicht.
  assert.match(source, /moreBtn\.setAttribute\('aria-label',[^;]*\bmoreLabel\b/);
  assert.match(source, /moreBtn\.setAttribute\('title',\s*t\('nav\.more'\)\)/);
  // Der sichtbare Text bleibt „Mehr", egal was im Namen steht.
  assert.match(source, /moreBtnLabel\.textContent\s*=\s*t\('nav\.more'\)/);
  assert.doesNotMatch(source, /moreBtn\.toggleAttribute\('aria-current',\s*inMoreSheet\)/);
});

test('mobile navigation derives five stable destinations from three favorites', () => {
  const source = read('../public/router.js');

  assert.match(source, /const\s+MOBILE_FAVORITE_COUNT\s*=\s*3/);
  assert.match(source, /resolveMobileNavOrder/);
  assert.match(source, /function\s+mobileFavoriteItems/);
  assert.match(source, /function\s+buildBottomNavItems/);
});

test('jede verwendete btn--Variante ist im Stylesheet definiert', () => {
  // `btn--danger-outline` wurde an zehn Stellen verwendet, war aber nirgends
  // definiert: der Button fiel auf die UA-Farbe `buttontext` zurück (im Dark
  // Mode 1.32:1). Undefinierte Utility-Klassen sind unsichtbare Bugs.
  const css = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((file) => file.endsWith('.css'))
    .map((file) => read(`../public/styles/${file}`))
    .join('\n');
  const defined = new Set([...css.matchAll(/\.(btn--[a-z0-9-]+)/g)].map((m) => m[1]));

  const used = new Set();
  for (const file of walkFrontendFiles('../public/')) {
    if (file.includes('/vendor/') || file.includes('lucide')) continue;
    // Lookbehind grenzt gegen fremde Blöcke ab: `task-status-btn--done` ist
    // keine Variante von `.btn`.
    for (const match of read(file).matchAll(/(?<![\w-])btn--[a-z0-9-]+/g)) used.add(match[0]);
  }

  const missing = [...used].filter((cls) => !defined.has(cls)).sort();
  assert.deepEqual(missing, [], `btn-Varianten ohne CSS-Regel: ${missing.join(', ')}`);
});

test('Sync-Kontolisten decken die Grid-Spalte, damit mobil nichts abgeschnitten wird', () => {
  const settings = read('../public/styles/settings.css');
  // Ohne minmax(0, 1fr) wächst die implizite Spalte auf max-content: eine lange
  // Konto-URL schob die Aktionsleiste bei 375px aus dem Viewport.
  assert.match(
    settings,
    /\.settings-sync-accounts\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  assert.match(
    settings,
    /\.settings-status-summary__details li\s*\{[^}]*overflow-wrap:\s*anywhere/,
  );
  assert.match(
    settings,
    /\.caldav-calendars-summary\s*\{[^}]*min-height:\s*var\(--target-lg\)/,
  );
  // Genau EINE Rahmenebene, und zwar um das Konto: die Karte trägt den Rahmen,
  // die Statuszeile darin ist Kopfzeile ohne eigene Fläche. Ohne diese Grenze
  // verliert „Trennen" bei mehreren Konten seinen Besitzer.
  // Rahmenfarbe aus der Tinte gemischt, nicht --color-border: das ist im Dark
  // Mode dunkler als die Kartenfläche und damit unsichtbar (gemessen 1.06:1).
  assert.match(
    settings,
    /\.caldav-account-item\s*\{[\s\S]*?border:\s*var\(--space-px\) solid color-mix\(in srgb, var\(--color-text-primary\)/,
  );
  assert.match(
    settings,
    /\.caldav-account-item \.settings-status-summary\s*\{[^}]*border:\s*0/,
  );
  assert.match(
    settings,
    /\.caldav-account-item \.settings-disclosure\s*\{[^}]*border:\s*0/,
  );
  // Glas-Tokens sind weiß-transparent und auf der weißen Karte unsichtbar -
  // deshalb Flächen-Tokens, oben positiv gepinnt.
  assert.doesNotMatch(
    settings,
    /\.caldav-account-item\s*\{[^}]*border:\s*var\(--space-px\) solid var\(--glass-border-subtle\)/,
  );
});

test('mobile navigation uses neutral inactive wells and one active indicator', () => {
  const layout = read('../public/styles/layout.css');

  assert.match(
    layout,
    /\.nav-item__icon-well\s*\{[\s\S]*?background:\s*var\(--color-surface-elevated\)/,
  );
  assert.match(
    layout,
    /\.nav-item\[aria-current="page"\] \.nav-item__icon-well,[\s\S]*?background:\s*transparent/,
  );
  assert.doesNotMatch(layout, /\.nav-bottom__indicator\s*\{[\s\S]*?width\s+0\.45s/);
});

test('mobile navigation Quiet Precision keeps state feedback stable and accessible', () => {
  const layout = read('../public/styles/layout.css');
  const glass = read('../public/styles/glass.css');
  const indicatorRule = cssRuleBody(layout, '.nav-bottom__indicator');
  const indicatorSurfaceRule = cssRuleBody(layout, '.nav-bottom__indicator::before');
  const indicatorSurfaceGlass = cssRuleBody(glass, '.nav-bottom__indicator::before');
  const focusRule = cssRuleBody(layout, '.nav-bottom .nav-item:focus-visible');
  const pressedWellRule = cssRuleBody(layout, '.nav-bottom .nav-item:active .nav-item__icon-well');

  assert.match(indicatorSurfaceRule, /inset-inline:\s*var\(--space-1\)/);
  assert.doesNotMatch(indicatorRule, /transition:[^;]*\bwidth\b/);
  assert.match(
    layout,
    /\.nav-bottom \.nav-item\[aria-current="page"\] \.nav-item__label,\s*\.nav-bottom \.nav-item--active \.nav-item__label\s*\{[\s\S]*?color:\s*var\(--item-module-accent,\s*var\(--active-module-accent,\s*var\(--color-accent\)\)\)/,
  );
  assert.match(
    layout,
    /\.nav-bottom \.nav-item\[aria-current="page"\] \.nav-item__label,\s*\.nav-bottom \.nav-item--active \.nav-item__label\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-semibold\)/,
  );
  // Fokusring liegt AUSSEN um die Icon-Well (nicht innen ins Item) — so ist er
  // für Tastatur-/Sehbeeinträchtigte klar zu orten statt hinter Icon+Label zu
  // verschwinden.
  assert.match(focusRule, /outline:\s*none/);
  const focusWellRule = cssRuleBody(layout, '.nav-bottom .nav-item:focus-visible .nav-item__icon-well');
  // Breite und Offset kommen aus den geteilten Fokus-Tokens (tokens.css §7b),
  // vorher aus --space-0h. Abweichen darf hier nur die FARBE: ein Nav-Item zeigt
  // auf SEIN Modul, nicht auf das gerade offene.
  assert.match(focusWellRule, /outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring-color\)/);
  assert.match(focusWellRule, /outline-offset:\s*var\(--focus-ring-offset\)/);
  assert.match(focusWellRule, /--focus-ring-color:\s*var\(--item-module-accent,/);
  assert.match(pressedWellRule, /transform:\s*translateY\(var\(--space-px\)\) scale\(0\.96\)/);
  assert.doesNotMatch(layout, /(^|\n)\.nav-item:active\s*\{[\s\S]*?transform:/);
  assert.doesNotMatch(layout, /\.nav-bottom \.nav-item:active\s*\{[\s\S]*?transform:/);
  // EINE Tint-Schicht: der Akzent-Fill sitzt am Indikator selbst; das ::before
  // trägt nur noch den Specular-Highlight (kein zweiter Tint → keine matschige
  // Kante der gleitenden Pille).
  assert.match(
    glass,
    /\.nav-bottom__indicator\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--active-module-accent,\s*var\(--color-accent\)\)/,
  );
  assert.doesNotMatch(indicatorSurfaceGlass, /background:/);
  assert.match(
    glass,
    /@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\.nav-bottom__indicator\s*\{[\s\S]*?background:/,
  );
  assert.match(
    layout,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nav-bottom \.nav-item:active \.nav-item__icon-well\s*\{[\s\S]*?transform:\s*none/,
  );
  assert.match(
    layout,
    /@media \(prefers-contrast: more\)[\s\S]*?\.nav-item\[aria-current="page"\],\s*\.nav-item--active\s*\{[\s\S]*?text-decoration:\s*underline/,
  );
  assert.match(
    layout,
    /@media \(forced-colors: active\)[\s\S]*?\.nav-item\[aria-current="page"\],\s*\.nav-item--active\s*\{[\s\S]*?border-bottom:\s*2px solid Highlight/,
  );
});

test('More-Sheet honours prefers-reduced-motion (no vestibular slide-up)', () => {
  const layout = read('../public/styles/layout.css');

  // Normalzustand: der Slide trägt einen transform-Transition.
  assert.match(cssRuleBody(layout, '.more-sheet'), /transition:\s*transform/);

  // Reduced-Motion: der translateY-Slide wird durch einen bewegungsfreien
  // Opacity-Fade ersetzt — der Transform snappt ohne Bewegung.
  assert.match(
    layout,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.more-sheet\s*\{[\s\S]*?transition:\s*opacity[\s\S]*?opacity:\s*0/,
  );
  assert.match(
    layout,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.more-sheet\[aria-hidden="false"\]\s*\{[\s\S]*?opacity:\s*1/,
  );

  // Das Such-Overlay der More-Sheet teilt denselben Slide und muss ebenfalls
  // bewegungsfrei faden.
  assert.match(cssRuleBody(layout, '.search-overlay'), /transition:\s*transform/);
  assert.match(
    layout,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.search-overlay\s*\{[\s\S]*?transition:\s*opacity[\s\S]*?opacity:\s*0/,
  );
});

test('bottom-nav labels wrap to two lines instead of clipping across locales', () => {
  const layout = read('../public/styles/layout.css');
  const labelRule = cssRuleBody(layout, '.nav-bottom .nav-item__label');

  // Zweizeiliges Wrapping statt Single-Line-Ellipsis; Langwörter brechen um.
  assert.match(labelRule, /white-space:\s*normal/);
  assert.match(labelRule, /-webkit-line-clamp:\s*2/);
  assert.match(labelRule, /overflow-wrap:\s*anywhere/);

  // Die Items-Reihe wächst mit dem Inhalt (min-height statt fixer Höhe).
  assert.match(cssRuleBody(layout, '.nav-bottom__items'), /min-height:\s*var\(--nav-height-mobile\)/);
  assert.doesNotMatch(cssRuleBody(layout, '.nav-bottom__items'), /(^|[^-])height:\s*var\(--nav-height-mobile\)/);

  // Longest-String-Guard: kein bottom-bar-Nav-Label darf so lang werden, dass
  // selbst zwei Zeilen in einem ~72px-Slot es nicht mehr fassen.
  const NAV_KEYS = [
    'dashboard', 'calendar', 'tasks', 'notes', 'kitchen', 'contacts', 'birthdays',
    'budget', 'documents', 'housekeeping', 'rewards', 'health', 'settings', 'more',
    'shopping', 'meals', 'recipes',
  ];
  const localeFiles = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  const offenders = [];
  for (const file of localeFiles) {
    const nav = JSON.parse(read(`../public/locales/${file}`)).nav || {};
    for (const key of NAV_KEYS) {
      const value = nav[key];
      if (typeof value === 'string' && value.length > 24) offenders.push(`${file}:nav.${key} (${value.length}) "${value}"`);
    }
  }
  assert.deepEqual(offenders, [], `bottom-bar nav labels over 24 chars need a shorter canonical label:\n${offenders.join('\n')}`);
});

test('bottom-nav icon-well fills the 44x44 touch-comfort zone', () => {
  const layout = read('../public/styles/layout.css');
  const tokens = read('../public/styles/tokens.css');
  const wellRule = cssRuleBody(layout, '.nav-bottom .nav-item__icon-well');

  // Sichtbares Well: 44 breit × 40 hoch (kein 32px-Streifen mehr).
  assert.match(wellRule, /width:\s*var\(--target-base\)/);
  assert.match(wellRule, /height:\s*var\(--target-md\)/);
  assert.doesNotMatch(wellRule, /height:\s*var\(--target-sm\)/);

  // Bar-Höhe innerhalb der iOS/Android-Norm (≥60px exkl. Safe-Area).
  assert.match(tokens, /--nav-height-mobile:\s*6[0-4]px/);
});

test('bottom nav keeps a navigation landmark with a disclosure button, not a tablist', () => {
  const source = read('../public/router.js');

  // Landmark statt ARIA-Tablist (Navigation, keine Tabs in einem Tabpanel).
  assert.match(source, /bottomNav\.setAttribute\('aria-label', t\('nav\.navigation'\)\)/);
  assert.doesNotMatch(source, /'role',\s*'tablist'/);
  assert.doesNotMatch(source, /setAttribute\('role', 'tab'\)/);

  // More bleibt ein korrekter Disclosure-Button.
  assert.match(source, /moreBtn\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(source, /moreBtn\.setAttribute\('aria-controls', 'more-sheet'\)/);
});

test('kitchen tab discloses its (variable) destination in the accessible name', () => {
  const source = read('../public/router.js');

  // Beide Zustände legen die Sektion offen — inaktiv nicht mehr nur "Küche".
  assert.match(
    source,
    /function kitchenNavAriaLabel\(path\)\s*\{[\s\S]*?nav\.kitchenActiveLabel[\s\S]*?nav\.kitchenGoLabel[\s\S]*?\}/,
  );
  assertKeysExistInEveryLocale(['nav.kitchenGoLabel']);

  // Der Zielhinweis trägt den {{section}}-Platzhalter in jeder Locale.
  const localeFiles = readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'));
  for (const file of localeFiles) {
    const value = JSON.parse(read(`../public/locales/${file}`)).nav?.kitchenGoLabel;
    assert.match(value ?? '', /\{\{section\}\}/, `${file}: nav.kitchenGoLabel must interpolate {{section}}`);
  }
});

test('mobile bottom navigation remains visible while content scrolls', () => {
  const source = read('../public/router.js');
  const layout = read('../public/styles/layout.css');

  assert.doesNotMatch(source, /initNavHideOnScroll/);
  assert.doesNotMatch(layout, /\.nav-bottom--hidden\s*\{/);
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
  // Well 44×40 (--target-md) füllt die Komfortzone besser als das alte 44×32.
  assert.match(iconWellRule, /height:\s*var\(--target-md\)/);
  assert.match(iconWellRule, /border-radius:\s*var\(--radius-full\)/);
  assert.match(labelRule, /line-height:\s*1\.2/);
});

/**
 * Verborgene Reveal-Aktionen bleiben nicht klickbar.
 *
 * Ein Element, das im Ruhezustand `opacity: 0` trägt und per :hover/:focus-within
 * eingeblendet wird, ist ohne `pointer-events: none` ein volles Trefferziel, das
 * niemand sieht. Gefunden wurde das Muster in der Küchen-Critique vom
 * 2026-07-30 (18 unsichtbare 146x40-Bänder im Wochenboard); der Guard zeigte,
 * dass es repo-weit auftrat - unter anderem an einem unsichtbaren
 * Löschen-Button in Notizen.
 *
 * Bewusste Ausnahmen: Textbeschriftungen, die INNERHALB eines sichtbaren,
 * klickbaren Elternteils ausblenden. Sie erzeugen kein eigenes Trefferziel, der
 * Elternteil bleibt das Ziel.
 */
test('verborgene Reveal-Aktionen bleiben nicht klickbar', () => {
  const ALLOW = new Set(['nav-item__label', 'nav-section-label']);
  const findings = [];

  for (const file of readdirSync(new URL('../public/styles/', import.meta.url))) {
    if (!file.endsWith('.css')) continue;
    const rules = cssRules(read(`../public/styles/${file}`));

    // Klassen, die im Ruhezustand unsichtbar sind (Keyframe-Schritte ausgenommen).
    const hidden = new Map();
    for (const { selectors, body } of rules) {
      if (selectors.some((s) => /^(from|to|\d+%)$/.test(s))) continue;
      if (!/(^|[\s;])opacity:\s*0\s*;/.test(body)) continue;
      const guarded = /pointer-events/.test(body);
      for (const selector of selectors) {
        // Nur die RECHTESTE Klasse: sie benennt das Element, das versteckt wird.
        // Vorfahren im Selektor (`html.sidebar-collapsed .nav-sidebar .x`) sind
        // selbst nicht unsichtbar und dürfen nicht mitgezählt werden.
        const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
        const subject = classes[classes.length - 1];
        if (subject && !hidden.has(subject)) hidden.set(subject, guarded);
      }
    }

    // Wer davon wird per Hover/Fokus eingeblendet?
    for (const { selectors, body } of rules) {
      if (!selectors.some((s) => /:hover|:focus-within/.test(s))) continue;
      if (!/opacity:\s*1/.test(body)) continue;
      for (const selector of selectors) {
        const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
        const cls = classes[classes.length - 1];
        if (!cls || !hidden.has(cls) || hidden.get(cls) || ALLOW.has(cls)) continue;
        hidden.delete(cls);
        findings.push(`${file} .${cls}`);
      }
    }
  }

  assert.deepEqual(findings, [], `opacity:0 ohne pointer-events:none in Reveal-Regeln:\n${findings.join('\n')}`);
});

/**
 * Die Küche baut Leerzustände nur über den geteilten Renderer.
 *
 * `utils/empty-state.js` erzwingt Reihenfolge (Icon, Titel, Beschreibung,
 * Hinweis, CTA) und die ARIA-Rolle je Variante. Solange Seiten das Markup
 * daneben von Hand zusammensetzen, driften die Zustände wieder auseinander -
 * genau das war der Ausgangsbefund (drei Grammatiken, drei vertikale Achsen).
 *
 * Absichtlich auf die Küche begrenzt: die übrigen 15 Seiten bauen ihre
 * Leerzustände noch von Hand (152 Fundstellen, Stand 2026-07-30). Das ist ein
 * bekannter Rückstand, kein Regressionsrisiko - dieser Guard hält fest, was
 * bereits migriert ist.
 */
test('die Küchen-Seiten bauen Leerzustände nur über den geteilten Renderer', () => {
  for (const page of ['meals', 'recipes', 'shopping', 'pantry']) {
    const src = read(`../public/pages/${page}.js`);
    const handRolled = [...src.matchAll(/class="empty-state|className\s*=\s*['"]empty-state/g)];
    assert.equal(handRolled.length, 0,
      `${page}.js baut .empty-state-Markup von Hand (${handRolled.length}x) statt emptyStateEl()/mountEmptyState() zu rufen`);
    assert.match(src, /\b(mountEmptyState|emptyStateEl)\b/,
      `${page}.js ruft den geteilten Leerzustands-Renderer nicht auf`);
  }
});

/**
 * Ein fehlgeschlagener Ladevorgang zeigt nie den Leerzustand.
 *
 * Ausgangsbefund (Critique P0, 2026-07-30): bei erzwungenem HTTP 500 sagte
 * `/shopping` „Keine Listen · [Neue Liste erstellen]" bei 31 vorhandenen
 * Artikeln, `/meals` dasselbe bei 28 geplanten Mahlzeiten. Beide Loader fingen
 * den Fehler, leerten den State und legten die Meldung in einen Toast - von den
 * zwei Aussagen überlebte damit die falsche, denn der Toast verging und der
 * Leerzustand blieb. Ein Leerzustand ist die schädlichste Antwort auf einen
 * Serverfehler: er behauptet Datenverlust und bietet als einzige Handlung eine
 * schreibende an.
 *
 * Der Guard hält die drei Bedingungen fest, die den Defekt strukturell
 * ausschließen. Die dritte ist die eigentliche: Reihenfolge im Rumpf. Ein
 * Fehler-Feld, das erst NACH dem Leer-Zweig geprüft wird, ist wirkungslos -
 * `state.items` ist nach einem Fehler ebenfalls leer, und nur die Reihenfolge
 * trennt „nichts angelegt" von „nicht geladen".
 */
test('die Küchen-Seiten zeigen bei einem Ladefehler den Fehlerzustand, nicht den Leerzustand', () => {
  for (const page of ['meals', 'recipes', 'shopping', 'pantry']) {
    const src = read(`../public/pages/${page}.js`);

    // 1. Es gibt überhaupt einen Fehlerzustand.
    assert.match(src, /\bmountLoadError\s*\(/,
      `${page}.js ruft den geteilten Fehler-Renderer mountLoadError() nicht auf`);

    // 2. Jedes gesetzte Fehler-Feld wird auch gelesen. Ein Feld, das nur
    //    geschrieben wird, ist genau der Zustand vor dem Fix: der Fehler ist
    //    bekannt und wird trotzdem nicht gezeigt.
    const assigned = new Set(
      [...src.matchAll(/\bstate\.(\w*[eE]rror)\s*=/g)].map((m) => m[1]),
    );
    for (const field of assigned) {
      const readPattern = new RegExp(`(if\\s*\\(|&&|\\|\\||!)\\s*!?state\\.${field}\\b`);
      assert.match(src, readPattern,
        `${page}.js setzt state.${field}, prüft es aber nirgends - der Fehler bleibt unsichtbar`);
    }

    // 3. Wo beide Zustände im selben Funktionsrumpf gerendert werden, kommt der
    //    Fehlerzustand zuerst.
    for (const [name, body] of topLevelFunctions(src)) {
      const errorAt = body.search(/\bmountLoadError\s*\(/);
      const emptyAt = body.search(/\bmountEmptyState\s*\(/);
      if (errorAt === -1 || emptyAt === -1) continue;
      assert.ok(errorAt < emptyAt,
        `${page}.js: ${name}() rendert den Leerzustand vor dem Fehlerzustand - `
        + 'nach einem Ladefehler ist die Sammlung ebenfalls leer, der Leer-Zweig greift also zuerst');
    }

    // 4. Kein Ladefehler wird nur noch in einen Toast gelegt.
    for (const [name, body] of topLevelFunctions(src)) {
      if (!/\bcatch\b/.test(body)) continue;
      const toastOnly = /showToast\s*\(\s*t\(\s*['"][\w.]*[lL]oadError/.test(body);
      assert.ok(!toastOnly,
        `${page}.js: ${name}() meldet einen Ladefehler per Toast - der vergeht, `
        + 'während der falsche Zustand darunter stehen bleibt');
    }
  }
});

/**
 * Der Fokusring hat genau eine Spezifikation.
 *
 * Ausgangsbefund (Critique P1, 2026-07-30): sechs. Zwei konkurrierende
 * Basisregeln - reset.css (2px, App-Akzent, offset 2px) und glass.css, das den
 * Offset global auf 3px hob - plus rund 45 lokale Regeln darüber. Auf
 * /shopping alternierte der Ring beim Durchtabben violett → orange → violett →
 * orange, sechs Farbwechsel in 15 Tabstops, weil ein Teil der Komponenten
 * `--active-module-accent` las und der andere `--color-accent` festverdrahtet
 * hatte. Der Fokusring ist das einzige Bauteil, das ein Tastaturnutzer
 * ununterbrochen sieht; ein Farbwechsel darin liest sich als Kontextwechsel.
 *
 * Der Guard erlaubt genau zwei Formen: die Tokens lesen, oder - für die
 * begründeten Ausnahmen - `--focus-ring-color` lokal überschreiben. Eine eigene
 * `outline`-Farbe in einer Fokusregel ist die siebte Spezifikation.
 */
test('Fokusringe lesen die Tokens aus tokens.css §7b', () => {
  const tokens = read('../public/styles/tokens.css');
  for (const token of ['--focus-ring-width', '--focus-ring-color', '--focus-ring-offset', '--focus-ring-offset-inset']) {
    assert.ok(tokens.includes(`${token}:`), `tokens.css führt ${token} nicht`);
  }

  const findings = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url))) {
    if (!file.endsWith('.css')) continue;
    const lines = read(`../public/styles/${file}`).split('\n');

    lines.forEach((line, i) => {
      const decl = line.split('/*')[0];
      // `outline` muss eine Deklaration sein, kein Namensteil: `\b` matcht auch
      // in `.btn--danger-outline:focus-visible`. Also nur nach Zeilenanfang,
      // `{` oder `;`.
      if (!/(^|[{;])\s*outline(-color|-offset|-width)?\s*:/.test(decl)) return;
      if (/outline\s*:\s*(none|0)\s*[;}]/.test(decl)) return;
      if (/var\(--focus-ring/.test(decl)) return;

      // Nur Fokusregeln. Eine `outline` als Zustandsmarkierung (Drop-Target,
      // „heute", aria-current) ist kein Fokusring und darf eigene Werte tragen.
      let selector = null;
      let depth = 0;
      for (let j = i; j >= 0; j--) {
        depth += (lines[j].match(/\}/g) || []).length - (lines[j].match(/\{/g) || []).length;
        if (depth < 0) { selector = lines[j]; break; }
      }
      if (!selector || !/:focus-visible|:focus-within/.test(selector)) return;

      findings.push(`${file}:${i + 1}  ${selector.split('{')[0].trim().slice(0, 50)} → ${decl.trim().slice(0, 50)}`);
    });
  }

  assert.deepEqual(findings, [],
    'Fokusregeln mit eigenen Werten statt der --focus-ring-*-Tokens. Begründete '
    + 'Ausnahmen überschreiben --focus-ring-color lokal und lesen Breite/Offset '
    + `weiter aus den Tokens:\n${findings.join('\n')}`);
});

/**
 * Zerlegt eine Modulquelle in ihre Top-Level-Funktionen.
 * Grob, aber ausreichend: die Küchen-Seiten deklarieren durchgängig mit
 * `function name()` an der linken Spalte.
 */
function topLevelFunctions(src) {
  const out = [];
  const pattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  const starts = [...src.matchAll(pattern)];
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    out.push([match[1], src.slice(match.index, end)]);
  });
  return out;
}

/**
 * Die Küchen-Listen teilen EINE Zeilen-Grammatik.
 *
 * Ausgangsbefund (Critique 2026-07-30, gemessen bei 1440px): die vier Tabs
 * teilten Akzent, Kopf, Tab-Leiste und Leerzustand - und darin vier verschiedene
 * Zeilen. Radius 8/20/12/14px, drei weiße Zeilen und eine transparente, vier
 * Innenpolsterungen, zwei Sichtbarkeitsregeln für dieselbe Aktion, acht
 * Eigenbau-Klassen in Aktionsrolle neben `.row-action`.
 *
 * Jede einzelne Assertion hier hätte einen der gemessenen Defekte gefunden.
 * Der Essensplan ist bewusst NICHT dabei: sein 148px-Slot im Wochenraster kann
 * keine 48px-Aktionsgruppe tragen (begründet in meals.css), er erbt nur die
 * Token. Das ist eine dokumentierte Ausnahme, kein vergessener Tab.
 */
test('die Küchen-Listen teilen eine Zeilen-Grammatik', () => {
  const shared = read('../public/styles/kitchen-row.css');
  const indexHtml = read('../public/index.html');

  assert.match(indexHtml, /<link rel="stylesheet" href="\/styles\/kitchen-row\.css" \/>/,
    'kitchen-row.css muss in index.html eingehängt sein (Router lädt nur EIN Page-CSS pro Seite)');

  // Die Gruppe trägt die Fläche, die Zeile nur Inhalt.
  const rowsBlock = shared.match(/\.kitchen-rows\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rowsBlock, /background-color:\s*var\(--color-surface-work\)/,
    '.kitchen-rows muss die opake Arbeitsfläche tragen (DESIGN.md: kein Glas unter Fließtext)');
  assert.match(rowsBlock, /border-radius:\s*var\(--radius-md\)/,
    '.kitchen-rows muss den Inhaltsflächen-Radius aus DESIGN.md §5 tragen');

  // Keine Zeilenaktion an der rechten Zeilenkante: das ist die Ecke, die der
  // fixierte FAB besetzt (87% Überdeckung auf dem Vorrats-Warenkorb im
  // Ruhezustand, Critique 2026-07-30). Kontextuelle Aktionen sitzen in einem
  // festen Slot am Anfang der Bedienzone.
  assert.doesNotMatch(shared.replace(/\/\*[\s\S]*?\*\//g, ''), /\.kitchen-row__end-action/,
    'an der Zeilenkante verankerte Aktionen liegen in der FAB-Ecke - fester Slot am Anfang der Bedienzone stattdessen');
  const pantryCss = read('../public/styles/pantry.css');
  const slot = pantryCss.match(/\.pantry-row__cart-slot\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(slot, /width:\s*var\(--target-lg\)/,
    'der Warenkorb-Slot muss die volle .row-action-Breite reservieren, sonst springt der Stepper je Zeile');
  assert.match(slot, /flex-shrink:\s*0/, 'der Slot darf nicht schrumpfen');
  assert.match(read('../public/pages/pantry.js'), /cartSlot\.className = 'pantry-row__cart-slot'/,
    'pantry.js muss den Slot IMMER rendern, auch ohne Warenkorb');

  // Umbrechen statt abschneiden. Ein gekürzter Artikelname ("Broc…") war bei
  // 320px der Verlust des einzigen Zwecks der Einkaufsliste.
  const nameBlock = shared.match(/\.kitchen-row__name\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(nameBlock, /text-overflow|white-space:\s*nowrap/,
    '.kitchen-row__name darf nicht ellipsieren: bei 320px blieben vier lesbare Zeichen');
  assert.match(nameBlock, /overflow-wrap:\s*anywhere/,
    '.kitchen-row__name muss umbrechen dürfen');

  // Keine Zeile bringt ihre eigene Fläche mit.
  //
  // Geprüft wird `padding:` exakt, nicht die gerichteten Varianten: eine
  // dokumentierte Reserve am Zeilenende ist erlaubt (Vorrat für den Warenkorb
  // über --reserve-end, Einkauf für den Swipe-Hinweis-Pfeil aus layout.css).
  // Ein vollständiges padding wäre dagegen eine zweite Zeilen-Geometrie.
  const perTab = {
    shopping: ['.shopping-item', '../public/styles/shopping.css'],
    pantry:   ['.pantry-row',    '../public/styles/pantry.css'],
  };
  for (const [tab, [selector, path]] of Object.entries(perTab)) {
    const css = read(path);
    const blocks = [...css.matchAll(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]).join('\n');
    for (const prop of ['border-radius', 'background-color', 'padding']) {
      assert.doesNotMatch(blocks, new RegExp(`^\\s*${prop}:`, 'm'),
        `${tab}: ${selector} darf kein eigenes ${prop} setzen - das trägt .kitchen-row bzw. .kitchen-rows`);
    }
  }

  // Alle drei Listen-Tabs benutzen die geteilten Klassen im Markup.
  for (const page of ['shopping', 'pantry', 'recipes']) {
    const src = read(`../public/pages/${page}.js`);
    for (const cls of ['kitchen-list', 'kitchen-rows', 'kitchen-row', 'kitchen-row__main', 'kitchen-row__name', 'kitchen-row__actions']) {
      assert.ok(src.includes(cls), `${page}.js muss ${cls} verwenden`);
    }
  }

  // Zeilenaktionen sind dauerhaft sichtbar, nicht hover-enthüllt. Die Enthüllung
  // per opacity hat in diesem Repo zweimal dieselbe Defektklasse produziert.
  for (const path of ['../public/styles/shopping.css', '../public/styles/pantry.css', '../public/styles/recipes.css']) {
    const css = read(path);
    assert.doesNotMatch(css, /@media\s*\(hover:\s*hover\)\s*\{[^}]*opacity:\s*0/,
      `${path}: Zeilenaktionen der Listen-Tabs dürfen nicht per hover-Reveal versteckt werden`);
  }

  // `hidden` muss durchgesetzt sein, wo eine Klasse `display` setzt.
  //
  // Dritte Fundstelle derselben Defektklasse in diesem Repo: .recipe-detail
  // trägt `display: grid` und schlägt damit das UA-`[hidden] { display: none }`
  // bei gleicher Spezifität. Das Panel stand offen, während sein Chevron „zu"
  // zeigte - und ein Prüfskript, das nur die DOM-Property `hidden` liest, sieht
  // das nicht. Vorgänger: .page-fab/.btn/.form-group, dann .page-toolbar.
  const recipesCssForHidden = read('../public/styles/recipes.css');
  const layoutCss = read('../public/styles/layout.css');
  if (/\.recipe-detail\s*\{[^}]*display:/.test(recipesCssForHidden)) {
    assert.match(layoutCss, /\.recipe-detail\[hidden\],/,
      '.recipe-detail setzt display und muss deshalb in der [hidden]-Durchsetzungsliste in layout.css stehen');
  }

  // Die Content-Spalte darf pro Ahnenkette genau einmal gesetzt werden.
  // #list-content trägt sie im Einkauf; .items-list trug sie ein zweites Mal und
  // begann deshalb 16px neben Kopf, Rezepten und Vorrat.
  const shoppingCss = read('../public/styles/shopping.css');
  const itemsList = shoppingCss.match(/^\.items-list\s*\{([^}]*)\}/m)?.[1] ?? '';
  assert.doesNotMatch(itemsList, /padding-inline:|padding:\s*\S+\s+\S+/,
    '.items-list darf kein horizontales Polster setzen: #list-content trägt schon --page-inline-pad');
  assert.doesNotMatch(shared.match(/\.kitchen-list\s*\{([^}]*)\}/)?.[1] ?? '', /padding-inline:/,
    '.kitchen-list darf kein padding-inline setzen: wo der Spalten-Träger sitzt, ist pro Tab verschieden');

  // Die Kappung aufs Lesemaß sitzt an den KINDERN des Scrollers, nicht am
  // Scroller selbst (PR #614). Die Begründung dafür stand bisher nur als
  // Kommentar im CSS.
  //
  // Gescannt wird JEDE Regel JEDER Stylesheet-Datei, nicht der erste Textblock
  // je Selektor. Zwei Wege führen sonst am Guard vorbei: ein zweiter Block
  // hinter einem Breakpoint, und das Modul-CSS, das später lädt und auf
  // demselben Element sitzt (`class="kitchen-list items-list"`).
  //
  // Und jede Regel weiß, OB sie bedingt gilt. cssRules() wirft das At-Rule-
  // Präludium weg; eine geforderte Kappung, die nur unter `@media (max-width:
  // 640px)` steht, ist auf jedem breiteren Fenster keine.
  const styleDir = new URL('../public/styles/', import.meta.url);
  const allRules = readdirSync(styleDir).filter((f) => f.endsWith('.css'))
    .flatMap((file) => scopedRules(read(`../public/styles/${file}`)).map((rule) => ({ file, ...rule })));

  // Der WIRKSAME Wert einer Eigenschaft, oder null. Drei Fallen stecken darin:
  //
  //   - Eine Deklaration ist kein Textvorkommen: `--eigene-max-width: 40rem`
  //     setzt keine Breite, und `--x: var(--content-max-width-narrow)` erfüllt
  //     keine Zusage.
  //   - Die LETZTE Deklaration gewinnt, wie im Browser. Sonst gilt
  //     `max-width: var(--content-max-width-narrow); max-width: none` als
  //     erfüllt, obwohl das Element bildschirmbreit läuft.
  //   - Kurzschreibweisen setzen dieselbe Eigenschaft mit: `place-self:
  //     stretch` setzt `align-self` zurück. Deshalb nimmt die Funktion eine
  //     Liste und gibt bei `place-*` den ersten Teilwert (die Block-Achse).
  //   - `!important` schlägt die Quellreihenfolge. `max-width: none !important;
  //     max-width: var(…)` sieht sonst erfüllt aus, obwohl das `none` gewinnt.
  const declaredValue = (body, props, axis = 'block') => {
    const list = [].concat(props);
    const alternatives = list.map((p) => escapeForRegExp(p)).join('|');
    // Standard-Eigenschaften sind ASCII-case-insensitiv (`MAX-WIDTH` wirkt),
    // Custom Properties dagegen nicht: `--Foo` und `--foo` sind zwei Namen.
    const flags = list.some((p) => p.startsWith('--')) ? 'gm' : 'gmi';
    const hits = [...body.matchAll(new RegExp(`(?:^|;)\\s*(${alternatives})\\s*:\\s*([^;]+)`, flags))]
      .map(([, prop, raw]) => ({ prop, raw: raw.trim() }));
    if (!hits.length) return null;
    const important = hits.filter(({ raw }) => /!\s*important$/i.test(raw));
    const { prop, raw } = (important.length ? important : hits).at(-1);
    const value = raw.replace(/!\s*important$/i, '').trim();
    if (!prop.toLowerCase().startsWith('place-')) return value;
    // `place-self: <align> <justify>` - fehlt der zweite Wert, gilt der erste
    // fuer beide Achsen.
    const parts = value.split(/\s+/);
    return axis === 'inline' ? (parts[1] ?? parts[0]) : parts[0];
  };
  const NARROW = 'var(--content-max-width-narrow)';
  const ALIGN_SELF = ['align-self', 'place-self'];
  // Eine Kappung ist eine Kappung, egal wie buchstabiert: die logischen Formen
  // wirken im Schreibmodus dieser App auf dieselbe Achse. Dasselbe Paar prüft
  // der Modul-Root-Breiten-Guard weiter unten schon.
  // ZWEI Gruppen, nicht eine Liste: `width` und `max-width` konkurrieren nicht,
  // sie beschränken die Box gemeinsam. Als eine Liste gelesen gewönne bei
  // `max-width: 20rem; width: 100%` das erlaubte `100%` - und die Kappung auf
  // 20rem stünde ungeprüft daneben. Innerhalb einer Gruppe konkurrieren die
  // Schreibweisen sehr wohl (logisch gegen physisch, gleiche Achse).
  const WIDTH_AXES = [['width', 'inline-size'], ['max-width', 'max-inline-size']];
  const MAX_WIDTH = ['max-width', 'max-inline-size'];
  // Werte, die dem Scroller NICHTS wegnehmen. Ein Modul darf `max-width: none`
  // ausdrücklich hinschreiben - verboten ist die Kappung, nicht die Erwähnung.
  const FREE_WIDTH = ['none', 'auto', 'initial', 'unset', 'revert', '100%'];
  // Ausrichtungen, die das Element seine Spur füllen lassen.
  const FILLS = ['stretch', 'normal', 'auto', 'initial', 'unset', 'revert'];

  // Die WIRKSAMEN Inline-Margen einer Regel. In Deklarationsreihenfolge
  // aufgelöst, weil der Shorthand die Langformen zurücksetzt: nach
  // `margin-inline-end: 20rem; margin: 0` ist die Marge null, und wer nur
  // sammelt statt zu kaskadieren, meldet dort einen Verstoß, den es
  // nicht gibt.
  const inlineMargins = (body) => {
    let start = null;
    let end = null;
    let startFixed = false;   // von einer !important-Deklaration gesetzt
    let endFixed = false;
    const setStart = (value, important) => {
      if (startFixed && !important) return;
      start = value;
      startFixed = startFixed || important;
    };
    const setEnd = (value, important) => {
      if (endFixed && !important) return;
      end = value;
      endFixed = endFixed || important;
    };
    const pattern = /(?:^|;)\s*(margin|margin-inline|margin-inline-start|margin-inline-end|margin-left|margin-right)\s*:\s*([^;]+)/gim;
    for (const [, rawProp, rawValue] of body.matchAll(pattern)) {
      const prop = rawProp.toLowerCase();
      // Eine wichtige Langform überlebt einen späteren gewöhnlichen
      // Shorthand - sonst meldete `margin-inline-end: 20rem !important;
      // margin: 0` eine Marge von null, die der Browser nie sieht.
      const important = /!\s*important$/i.test(rawValue.trim());
      const value = rawValue.replace(/!\s*important$/i, '').trim();
      const parts = value.split(/\s+/);
      if (prop === 'margin') {
        const [top, right = top, , left = right] = parts;
        setStart(left, important);
        setEnd(right, important);
      } else if (prop === 'margin-inline') {
        const [first, second = first] = parts;
        setStart(first, important);
        setEnd(second, important);
      } else if (prop === 'margin-inline-start' || prop === 'margin-left') {
        setStart(value, important);
      } else {
        setEnd(value, important);
      }
    }
    return [['margin-inline-start', start], ['margin-inline-end', end]].filter(([, value]) => value !== null);
  };

  // Zielt der Selektor auf das Element selbst, nicht auf einen Nachfahren?
  // Geprüft wird der LETZTE Compound, damit auch `.kitchen-list#items-list`,
  // `.kitchen-list:hover` und `:is(.kitchen-list)` als Treffer gelten -
  // `.kitchen-list .row` dagegen nicht.
  //
  // `:not(…)` und `:has(…)` fallen vorher weg, und zwar VOR dem Zerlegen:
  // beide nennen die Klasse, ohne dass die Regel sie stylt. `.page:has(
  // .kitchen-list)` gestaltet den Vorfahren, nicht den Scroller - dort rot zu
  // werden hieße, eine korrekte Layoutregel zu blockieren.
  // Das Token ist `.klasse` oder `#id`: dasselbe Element lässt sich über beide
  // ansprechen, und eine Regel auf der ID nennt keine seiner Klassen.
  const targets = (selector, token) => {
    const subject = selector.replace(/:(?:not|has)\([^)]*\)/g, '');
    const compound = subject.trim().split(/[\s>+~]+/).pop() ?? '';
    // Ein Pseudo-Element ist ein eigener Kasten, nicht das Element selbst:
    // `.recipes-list::before { width: 1rem }` kappt den Scroller nicht, und
    // dort rot zu werden hieße, eine harmlose Dekoration zu verbieten.
    if (/::|:(?:before|after|first-line|first-letter|marker|backdrop|selection|placeholder)\b/.test(compound)) return false;
    return new RegExp(`${escapeForRegExp(token)}(?![\\w-])`).test(compound);
  };
  const rulesFor = (token) => allRules.filter(({ selectors }) => selectors.some((s) => targets(s, token)));

  // 1. Der Scroller selbst darf nicht gekappt werden. Er ist das Element mit
  //    `overflow-y: auto`; kappt man es aufs Lesemaß, endet damit auch sein
  //    eigener Trefferbereich fürs Mausrad an der Lesespalten-Kante, und auf
  //    einem breiten Fenster greift das Rad rechts davon ins Leere.
  //
  //    Welche Klassen den Scroller mitbenennen, sagt das Markup, nicht diese
  //    Liste: wer auf demselben Element sitzt, kann seine Breite kappen.
  //    JEDE geprüfte Seite muss ihre eigene Kombination liefern. Eine globale
  //    Mindestzahl genügt nicht: fiele nur eine Seite aus der Erkennung, würden
  //    die beiden anderen sie weiter erfüllen, und deren Modul-Klasse wäre
  //    ungeprüft.
  const scrollerTokens = new Set(['.kitchen-list']);
  for (const page of ['shopping', 'pantry', 'recipes']) {
    const src = read(`../public/pages/${page}.js`);
    const combos = [...src.matchAll(/class(?:Name)?\s*=\s*(['"`])([^'"`]*\bkitchen-list\b[^'"`]*)\1/g)];
    assert.ok(combos.length > 0,
      `${page}.js hängt seine Klasse nicht mehr literal an .kitchen-list - dieser Scan findet sie dann nicht und prüft den Scroller des Tabs ungewollt gar nicht`);
    combos.forEach(([, , combo]) => combo.trim().split(/\s+/).forEach((cls) => scrollerTokens.add(`.${cls}`)));

    // Und über die ID, die alle drei Scroller tragen: `#recipes-list` trifft
    // dasselbe Element, ohne eine seiner Klassen zu nennen. Keine ID im
    // Markup heißt umgekehrt, dass kein ID-Selektor es treffen kann - deshalb
    // ist hier nichts zu fordern, nur einzusammeln.
    const inTag = (src.match(/<[^>]*\bkitchen-list\b[^>]*>/g) ?? [])
      .map((tag) => tag.match(/\bid="([^"]+)"/)?.[1]);
    const nextToClassName = [...src.matchAll(
      /(\w+)\.className\s*=\s*['"`][^'"`]*\bkitchen-list\b[^'"`]*['"`];\s*\1\.id\s*=\s*['"`]([^'"`]+)/g)]
      .map(([, , id]) => id);
    [...inTag, ...nextToClassName].filter(Boolean).forEach((id) => scrollerTokens.add(`#${id}`));

    // Inline-Styles stehen in keiner der gescannten Dateien und schlagen
    // trotzdem jede Regel darin. Der Scroller wird im JS gebaut, also muss
    // der Scan dort nachsehen - an derselben Variablen, die die Klasse bekommt,
    // und im Tag, das sie im Markup trägt.
    for (const [, variable] of src.matchAll(/(\w+)\.className\s*=\s*['"`][^'"`]*\bkitchen-list\b/g)) {
      const name = escapeForRegExp(variable);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.style\\.(?:max)?(?:Width|InlineSize)\\s*=`, 'i'),
        `${page}.js setzt eine Inline-Breite am Scroller - die schlägt jede Regel im Stylesheet und damit auch diesen Guard`);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.style\\.(?:alignSelf|placeSelf)\\s*=`),
        `${page}.js setzt align-self inline am Scroller - das nimmt ihm die volle Breite`);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.style\\.setProperty\\(\\s*['"\`](?:(?:max-)?(?:width|inline-size)|align-self|place-self|margin(?:-inline)?(?:-start|-end)?|margin-left|margin-right)`, 'i'),
        `${page}.js setzt eine Breite, Ausrichtung oder Marge inline am Scroller (setProperty)`);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.style\\.cssText\\s*=`),
        `${page}.js überschreibt den Stil des Scrollers per cssText - was darin steht, sieht dieser Guard nicht`);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.setAttribute\\(\\s*['"\`]style`, 'i'),
        `${page}.js setzt den Stil des Scrollers per setAttribute - derselbe Inline-Stil über einen anderen Weg`);
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\.style\\.margin(?:Inline|Left|Right)?[A-Za-z]*\\s*=`),
        `${page}.js setzt eine Inline-Marge am Scroller - die zieht als gestrecktes Flex-Item direkt von seiner Breite ab`);
    }
    (src.match(/<[^>]*\bkitchen-list\b[^>]*>/g) ?? []).forEach((tag) => {
      assert.doesNotMatch(tag, /\sstyle\s*=/,
        `${page}.js gibt dem Scroller ein style-Attribut - Inline-Stile schlagen jede Regel im Stylesheet`);
    });
  }
  assert.ok(rulesFor('.kitchen-list').length > 0,
    '.kitchen-list ist nirgends definiert: ein leerer Treffer darf hier nicht still grün bleiben');
  for (const cls of scrollerTokens) {
    for (const { file, selectors, body } of rulesFor(cls)) {
      for (const axis of WIDTH_AXES) {
        const cap = declaredValue(body, axis);
        assert.ok(cap === null || FREE_WIDTH.includes(cap),
          `${file} ${selectors.join(', ')}: ${axis[0]}: ${cap} kappt den Scroller - dann endet sein Mausrad-Trefferbereich an der Lesespalten-Kante`);
      }

      // Dieselbe Verengung ohne Breitenangabe: als gestrecktes Flex-Item zieht
      // eine Inline-Marge direkt von der Randbox ab. `margin-inline-end: 20rem`
      // beendet den Trefferbereich 20rem vor der Seitenkante.
      for (const [prop, value] of inlineMargins(body)) {
        assert.ok(/^0[a-z%]*$/.test(value),
          `${file} ${selectors.join(', ')}: ${prop}: ${value} nimmt dem Scroller Breite - der Trefferbereich endet dann davor`);
      }

      // Dieselbe Kante ohne jede Breitenangabe: der Scroller ist Flex-Item
      // seines Modul-Roots (.recipes-page & Co. sind flex column). Ein
      // `align-self: start` nimmt ihm das voreingestellte Strecken und lässt
      // ihn auf Inhaltsbreite schrumpfen - der Trefferbereich fürs Mausrad
      // endet dann genau dort. Erlaubt bleibt nur, was ihn füllen lässt.
      const spread = declaredValue(body, ALIGN_SELF);
      assert.ok(spread === null || FILLS.includes(spread),
        `${file} ${selectors.join(', ')}: align-self: ${spread} nimmt dem Scroller die volle Breite - dann greift das Mausrad rechts daneben ins Leere`);

      // `all` setzt jede der oben geprüften Eigenschaften mit zurück, ohne
      // eine davon zu nennen.
      assert.equal(declaredValue(body, 'all'), null,
        `${file} ${selectors.join(', ')}: die all-Kurzschreibweise setzt Breite und Ausrichtung des Scrollers zurück`);
    }
  }

  //    Und das Lesemaß behält EINE Quelle. Definierte ein Modul
  //    --content-max-width-narrow lokal um, trüge das Kind zwar weiter die
  //    geforderte Deklaration, löste sie aber auf ein anderes Maß auf - der
  //    Guard unten vergliche dann zwei Texte, die dasselbe sagen und
  //    Verschiedenes bedeuten.
  for (const { file, selectors, body } of allRules) {
    // Ausgenommen ist die KANONISCHE Deklaration, nicht die Datei: eine auf
    // einen Selektor gescopte Neudefinition in tokens.css selbst umginge
    // dieselbe Invariante, die dieser Block schützt.
    if (file === 'tokens.css' && selectors.every((s) => /^:root\b/.test(s.trim()))) continue;
    assert.equal(declaredValue(body, '--content-max-width-narrow'), null,
      `${file} ${selectors.join(', ')}: --content-max-width-narrow wird hier lokal umdefiniert - das Lesemaß kommt aus tokens.css und nirgendwo sonst`);
  }

  //    Und es muss sie geben: fehlt die :root-Deklaration, wird jedes
  //    `var(--content-max-width-narrow)` ungültig und das max-width fällt auf
  //    `none` zurück - die Listen liefen bildschirmbreit, während dieser Test
  //    weiter zwei Texte vergleicht, die zueinander passen.
  // Die GEWINNENDE Deklaration über alle kanonischen Regeln. Weder „die
  // letzte" noch „die erste" genügt: `!important` schlägt die
  // Quellreihenfolge auch zwischen zwei :root-Blöcken. Deshalb werden die
  // Rümpfe in Quellreihenfolge aneinandergehängt und einmal ausgewertet -
  // declaredValue() kennt die Vorrangregel bereits.
  const canonicalBodies = allRules
    .filter(({ file, selectors, conditional }) => file === 'tokens.css' && !conditional
      && selectors.some((sel) => /^:root\b/.test(sel)))
    .map(({ body }) => body).join(';');
  const tokenValue = declaredValue(canonicalBodies, '--content-max-width-narrow');
  assert.ok(tokenValue !== null,
    'tokens.css muss --content-max-width-narrow unbedingt in :root definieren - ohne die Deklaration löst var(…) auf nichts auf und die Kappung entfällt');
  assert.match(tokenValue, /^(?:\d+(?:\.\d+)?(?:px|rem|em|ch|ex|vw|vmin|vmax|%)|(?:min|max|clamp|calc)\(.*\))$/,
    `--content-max-width-narrow ist auf "${tokenValue}" gesetzt - das ist keine Breite, und die Kappung der Kinder läuft ins Leere`);

  // 2. Tragen muss die Kappung stattdessen jedes Kind, das ALLEIN Kind des
  //    Scrollers sein kann: .kitchen-group bei gruppierten Tabs (Einkauf,
  //    Vorrat), .kitchen-rows ungruppiert (Rezepte). Fehlt sie an einem der
  //    beiden, läuft der betroffene Tab bildschirmbreit - und ein zweiter
  //    Block darf sie auch nicht auf einen abweichenden Wert ziehen.
  for (const cls of ['.kitchen-group', '.kitchen-rows']) {
    const rules = rulesFor(cls);
    // Unbedingt heißt dreierlei: nicht hinter einem Breakpoint, nicht an einen
    // Zustand gebunden, und nicht an einen Vorfahren geknüpft.
    // `.kitchen-rows:hover` kappt nur unter dem Mauszeiger;
    // `.shopping-page .kitchen-rows` kappt die Rezeptliste gar nicht, obwohl
    // der Selektor die Klasse nennt und dieser Scan ihn findet.
    // Anders als in targets() bleiben :not() und :has() hier STEHEN. Dort
    // sagen sie nur, dass die genannte Klasse nicht das Subjekt ist; hier
    // sagen sie, dass die Kappung an eine Bedingung geknüpft ist -
    // `.kitchen-rows:not(.uncapped)` lässt jede Zeile mit dieser Klasse
    // ungekappt. `:is()`/`:where()` gehören zum Subjekt: Inhalt behalten.
    const plain = (sel) => {
      const bare = sel.replace(/:(?:is|where)\(([^)]*)\)/g, '$1');
      return !/:/.test(bare) && !/[\s>+~,]/.test(bare);
    };
    assert.ok(rules.some(({ body, conditional, selectors }) =>
      !conditional && selectors.some(plain) && declaredValue(body, MAX_WIDTH) === NARROW),
    `${cls} muss das Lesemaß UNBEDINGT tragen: eine Kappung hinter einem Breakpoint, an einem Zustand (:hover) oder unter einem Vorfahren (.foo ${cls}) greift nicht in jedem Kontext, in dem das Element gerendert wird`);
    for (const { file, body } of rules) {
      // Eine feste Breite schlägt die Kappung, ohne sie anzufassen: mit
      // `width: 20rem` bleibt das max-width korrekt stehen und die Liste steht
      // trotzdem schmal. Prozentwerte und `auto` sind unschädlich - sie messen
      // den (ungekappten) Scroller, und das max-width begrenzt weiter.
      const definite = declaredValue(body, ['width', 'inline-size']);
      assert.ok(definite === null || definite === 'auto' || definite === '100%',
        `${file}: ${cls} bekommt hier eine feste Breite (${definite}) - gekappt wird über max-width, sonst steht die Liste unabhängig vom Lesemaß schmal`);

      // Dasselbe ohne Breitenangabe: als Grid-Item von .kitchen-list füllt das
      // Kind seine Spur per Voreinstellung. `justify-self: start` nimmt ihm
      // das, und die auto-Breite fällt auf den Inhalt zusammen - das Lesemaß
      // bleibt dabei unangetastet und unwirksam.
      const inline = declaredValue(body, ['justify-self', 'place-self'], 'inline');
      assert.ok(inline === null || FILLS.includes(inline),
        `${file}: ${cls} bekommt justify-self: ${inline} - dann schrumpft die Gruppe auf ihren Inhalt, statt das Lesemaß auszufüllen`);
      assert.equal(declaredValue(body, 'all'), null,
        `${file}: ${cls} wird per all-Kurzschreibweise zurückgesetzt - das nimmt Kappung und Ausrichtung mit`);

      const width = declaredValue(body, MAX_WIDTH);
      if (width === null) continue;
      assert.equal(width, NARROW,
        `${file}: ${cls} bekommt hier eine zweite, abweichende Breite - das Lesemaß ist EIN Wert`);
    }
  }

  // 3. Und wer aufs Lesemaß kappt UND clippt, muss auf seine Inhaltshöhe
  //    wachsen dürfen.
  //
  //    Absichtlich eine Regel und keine Allowlist: `overflow: hidden` (hier für
  //    die Eckenradien) macht aus dem gekappten Kind einen Clipper. Ohne
  //    `align-self: start` streckt das voreingestellte `align-items: stretch`
  //    es auf die volle Spurhöhe, und es schneidet alles darüber still ab,
  //    bevor .kitchen-list den Überlauf je sieht. Gemessen an einer Rezeptliste
  //    mit 50 gespiegelten Einträgen: scrollHeight 3249px gegen clientHeight
  //    657px, kein Scrollbalken, kein Weg an die übrigen Zeilen. Harmlos ist
  //    das nur, solange mehrere kurze Gruppen dieselbe Spur teilen.
  //
  //    Der Scan bleibt auf kitchen-row.css, wo die geteilten Bausteine
  //    definiert werden. Andere Module kappen mit demselben Token Elemente, die
  //    nie Grid-Item dieses Scrollers werden (shopping.css die Eingabezeile,
  //    layout.css den Leerzustand) - für die wäre `align-self: start` falsch.
  //    Innerhalb dieser Datei gilt dieselbe Einschränkung für .kitchen-bulkbar:
  //    sie steht ÜBER dem Scroller (siehe dort) und trägt das Lesemaß, clippt
  //    aber nicht. Käme dort ein `overflow: hidden` dazu, meldet dieser Guard
  //    einen Fall, den ein Mensch entscheiden muss.
  //    Kombiniert wird über REGELGRENZEN hinweg: der Browser sammelt die
  //    Deklarationen aller passenden Regeln, bevor er den Wert bestimmt.
  //    Stünden Kappung und `overflow` in zwei getrennten Blöcken, sähe eine
  //    Prüfung pro Block in keinem von beiden ein gekapptes, clippendes
  //    Element - und genau das ist es.
  //    Gruppiert wird nach dem ELEMENT, nicht nach dem Selektortext: `.kitchen-rows`
  //    und `ul.kitchen-rows` treffen dasselbe `ul`, stünden als zwei Einträge
  //    aber je unvollständig da. Maßgeblich sind die Klassen und IDs im
  //    Subjekt; eine Regel zählt zu jedem Element, dessen Merkmale sie
  //    vollständig enthält.
  const subjectKeys = (selector) => {
    const subject = selector
      .replace(/:(?:not|has)\([^)]*\)/g, '')
      .replace(/:(?:is|where)\(([^)]*)\)/g, '$1')
      .trim().split(/[\s>+~]+/).pop() ?? '';
    return new Set(subject.match(/[.#][\w-]+/g) ?? []);
  };
  //    Der Vorfahren-Kontext bleibt dabei erhalten. Ohne ihn landeten
  //    `.context-a .kitchen-rows { overflow: hidden }` und
  //    `.context-b .kitchen-rows { align-self: start }` im selben Topf,
  //    obwohl kein Element je beide Regeln sieht - der Guard hielte das
  //    Clipping für ausgeglichen, das es in Kontext A nicht ist.
  const contextOf = (selector) => {
    const parts = selector.replace(/:(?:is|where)\(([^)]*)\)/g, '$1').trim().split(/[\s>+~]+/);
    return parts.slice(0, -1).join(' ');
  };
  // Der Zustand des Subjekts gehört ebenfalls zum Schlüssel: sonst gliche
  // `.kitchen-rows:hover { align-self: start }` eine Lücke aus, die im
  // Ruhezustand - also fast immer - besteht.
  const stateOf = (selector) => {
    const subject = selector.replace(/:(?:is|where)\(([^)]*)\)/g, '$1')
      .trim().split(/[\s>+~]+/).pop() ?? '';
    return (subject.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).sort().join('');
  };
  const sharedRules = scopedRules(shared)
    .flatMap(({ selectors, body }) => selectors.map((sel) => ({
      keys: subjectKeys(sel), context: contextOf(sel), state: stateOf(sel), sel, body,
    })))
    .filter(({ keys }) => keys.size > 0);
  const elements = new Map();
  for (const { keys, context, state, sel } of sharedRules) {
    const id = `${context}|${state}|${[...keys].sort().join('')}`;
    if (!elements.has(id)) elements.set(id, { keys, context, state, label: sel });
  }
  for (const [, { keys, context, state, label }] of elements) {
    const body = sharedRules
      // Eine kontext- und zustandsfreie Regel trifft das Element immer; eine
      // gebundene nur in ihrem eigenen Kontext beziehungsweise Zustand.
      .filter(({ keys: own, context: ownContext, state: ownState }) =>
        [...own].every((key) => keys.has(key))
        && (ownContext === '' || ownContext === context)
        && (ownState === '' || ownState === state))
      .map(({ body: part }) => part).join(';');
    const selectors = [label];
    if (declaredValue(body, MAX_WIDTH) !== NARROW) continue;
    // `clip` kappt wie `hidden`, nur ohne Scrollport - und die Block-Achse
    // lässt sich auch als Langform setzen. Der Grund für die Zusicherung ist
    // das Abschneiden, nicht die eine Schreibweise dafür.
    const overflow = declaredValue(body, ['overflow', 'overflow-y', 'overflow-block']);
    if (overflow === null || !/\b(?:hidden|clip)\b/.test(overflow)) continue;
    assert.equal(declaredValue(body, ALIGN_SELF), 'start',
      `${selectors.join(', ')} kappt aufs Lesemaß und clippt zugleich, ist also ein gekapptes Kind des Scroller-Grids: ohne align-self: start schneidet es den Überlauf ab, bevor .kitchen-list ihn sieht`);
  }

  // Und kein später geladenes Modul-Stylesheet biegt den Wert wieder um -
  // auch nicht über die Kurzschreibweise place-self.
  for (const { file, body } of rulesFor('.kitchen-rows')) {
    const align = declaredValue(body, ALIGN_SELF);
    if (align === null) continue;
    assert.equal(align, 'start',
      `${file}: .kitchen-rows bekommt hier ein anderes align-self - genau der Rückfall, den die Regel darüber verhindert`);
  }
});

/**
 * EINE Antwort auf den FAB, nicht zwei entgegengesetzte.
 *
 * Ausgangslage (Critique 2026-07-30): der FAB ist fixiert in der unteren rechten
 * Ecke und lag über den Zeilenaktionen. Es gab zwei Antworten im selben Modul.
 * Einkauf und Vorrat reservierten eine 76px-Gasse in JEDER Zeile
 * (`padding-inline-end: var(--fab-lane)`) - kollisionsfrei in 12/12 Messungen,
 * aber bei 320px 24% der Viewportbreite und Artikelnamen auf rund vier lesbare
 * Zeichen gekürzt. Mahlzeiten und Rezepte reservierten nichts und sammelten
 * 14 Überdeckungen bis 53.2%.
 *
 * Die Antwort ist ein kürzerer Scrollport (`--fab-safe-zone`), nicht Platz in
 * der Zeile - und ausdrücklich auch kein Wegfahren des FAB mehr (siehe unten,
 * #634).
 */
test('der FAB weicht der Zeile, statt eine Gasse zu reservieren', () => {
  const layout = read('../public/styles/layout.css');
  const tokens = read('../public/styles/tokens.css');
  const router = read('../public/router.js');

  // Die Gasse darf nicht zurückkehren - in keinem Modul-CSS.
  const styleDir = new URL('../public/styles/', import.meta.url);
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const css = read(`../public/styles/${file}`);
    const live = css
      .replace(/\/\*[\s\S]*?\*\//g, '')  // Kommentare dürfen die Historie nennen
      .match(/var\(--fab-lane\)/g);
    assert.equal(live, null, `${file} reserviert wieder eine FAB-Gasse (var(--fab-lane))`);
  }
  assert.doesNotMatch(tokens.replace(/\/\*[\s\S]*?\*\//g, ''), /--fab-lane\s*:/,
    '--fab-lane ist stillgelegt und darf nicht wieder definiert werden');

  // Die FAB-Zone ist eine Höhe, kein Padding. `padding-bottom` am scrollenden
  // Element sitzt am Inhaltsende und wandert beim Scrollen mit - es wirkte
  // deshalb nur, wenn der Nutzer schon unten war, und ließ bei scrollTop=0 bis
  // 80,6% einer Zeilenaktion verdeckt (Critique P1, 2026-07-30).
  assert.match(tokens, /--fab-safe-zone:\s*calc\([^;]*--fab-gap[^;]*--fab-size[^;]*;/,
    '--fab-safe-zone muss aus --fab-gap und --fab-size abgeleitet werden');
  assert.match(tokens, /--fab-offset-bottom:\s*calc\([^;]*--fab-gap[^;]*\)/,
    '--fab-offset-bottom und --fab-safe-zone müssen dieselbe Quelle (--fab-gap) haben');
  assert.match(layout, /\.app-content:has\(\.page-fab[\s\S]*?\{[^}]*margin-block-end:\s*var\(--fab-safe-zone\)/,
    'der Scrollport muss über der FAB-Zone enden (Marge an .app-content)');

  // Die drei auseinandergedrifteten Kopien bleiben abgeschafft. Sie rechneten
  // `--target-lg + --space-6 + --space-4` = 88px und zählten --nav-bottom-height
  // nicht mit - mobil also um mehr als 60px zu klein.
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const live = read(`../public/styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(live, /--[\w-]*fab-clearance/,
      `${file} führt wieder ein eigenes FAB-Freiraum-Token statt --fab-safe-zone`);
  }

  // #634: Der FAB darf sich beim Scrollen nicht mehr zurückziehen.
  //
  // Er tat es einmal, um die Zeilenaktion unter sich freizugeben - eine
  // Begründung, die `--fab-safe-zone` (oben geprüft) vollständig übernommen hat.
  // Übrig blieb ein Zustand an einer Klasse, den nur ein weiteres Scroll-
  // Ereignis wieder abnahm: ein einziges Abwärts-Delta ohne Nutzergeste (die
  // iOS-Adressleiste, Scroll-Anchoring beim Nachladen einer Liste) machte die
  // Primäraktion des Moduls unerreichbar. Gemeldet für /tasks auf iPhone-Safari,
  // möglich in jedem Modul mit FAB.
  //
  // Diese Zusicherung ist absichtlich eine Regel und keine Allowlist: sie
  // verbietet die MECHANIK, nicht den einen Klassennamen, unter dem sie stand.
  assert.doesNotMatch(layout.replace(/\/\*[\s\S]*?\*\//g, ''), /\.page-fab--retracted/,
    '.page-fab--retracted ist entfallen (#634) und darf nicht zurückkehren');
  assert.doesNotMatch(router, /fab-scroll\.js|installFabRetract/,
    'router.js darf keinen Scroll-Mechanismus mehr am FAB verdrahten (#634)');
  assert.equal(existsSync(new URL('../public/utils/fab-scroll.js', import.meta.url)), false,
    'utils/fab-scroll.js ist entfallen (#634)');
  assert.doesNotMatch(read('../public/sw.js'), /fab-scroll\.js/,
    'sw.js darf die entfallene Datei nicht precachen - ein 404 lässt die gesamte SW-Installation scheitern');

  // Und niemand baut sie unter anderem Namen nach: kein Modul darf dem FAB seine
  // Bedienbarkeit nehmen und sie an einen Zustand hängen, den der Nutzer nicht
  // selbst wieder auflöst.
  //
  // AUSGENOMMEN ist `.keyboard-visible` - der einzige Zustand, der den FAB
  // legitim verbirgt. Hier stand, er ende „immer, wenn der Nutzer die Tastatur
  // schließt". Das war die unbelegte Annahme, die den Melder ein zweites Mal
  // traf: die Erkennung las nur den Viewport, und den schrumpft die
  // iOS-Adressleiste ohne jede Tastatur. Was die Ausnahme trägt, ist nicht der
  // Klassenname, sondern die Bedingung dahinter - und die prüft der Test
  // „die Tastatur-Erkennung hängt am Fokus, nicht nur am Viewport".
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const live = read(`../public/styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');
    const fabRules = (live.match(/[^{}]*\.page-fab[^{]*\{[^}]*\}/g) ?? [])
      .filter((rule) => !/keyboard-visible/.test(rule));
    for (const rule of fabRules) {
      assert.doesNotMatch(rule, /opacity:\s*0\s*[;}]/,
        `${file} blendet den FAB per opacity aus - genau der Zustand aus #634`);
      assert.doesNotMatch(rule, /pointer-events:\s*none/,
        `${file} nimmt dem FAB die Bedienbarkeit - genau der Zustand aus #634`);
    }
  }
});

/**
 * #634, zweite Runde: auch eine falsch erkannte Tastatur darf den FAB nicht
 * nehmen.
 *
 * Nach dem Entfernen des Scroll-Retracts meldete derselbe Nutzer denselben
 * Defekt weiter, jetzt in /tasks UND /pantry. Übrig war der zweite Zustand, der
 * den FAB verbirgt: `.keyboard-visible`. Er wurde allein aus einem geschrumpften
 * visualViewport geschlossen - eine Messung, die auf iOS auch die ausfahrende
 * Adressleiste auslöst, ganz ohne Tastatur. Und er hing an genau einem
 * `resize`: blieb ein zweites aus, blieb der FAB weg.
 *
 * Damit hatte der Retract-Fix die Mechanik entfernt, aber nicht ihre Form. Die
 * Form ist: ein Zustand, der die Primäraktion verbirgt, aus einem Signal
 * geschlossen wird, das nicht bedeutet was es soll, und keinen Rückweg hat, der
 * garantiert kommt. Dieser Test hält die Gegenform fest - nicht den Namen der
 * Funktion, sondern die drei Eigenschaften.
 */
test('die Tastatur-Erkennung hängt am Fokus, nicht nur am Viewport', () => {
  const router = read('../public/router.js');

  const sync = router.match(/function syncKeyboardVisible\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(sync, 'syncKeyboardVisible() muss es geben - sie hält die Bedingung an einer Stelle');

  // 1. Das Signal muss bedeuten, was es behauptet: eine Tastatur ist offen,
  //    wenn ein Texteingabefeld den Fokus hat. Der Viewport bestätigt nur.
  assert.match(sync, /isTextEntry\(document\.activeElement\)/,
    'die Tastatur gilt nur als offen, wenn ein Texteingabefeld den Fokus hat (#634)');
  assert.match(sync, /focused && shrunk|shrunk && focused/,
    'Fokus UND Viewport - eine der beiden Bedingungen allein reicht nicht (#634)');

  // 2. Der Rückweg, der dem Retract fehlte: focusout kommt immer, und jede
  //    Navigation fokussiert #main-content, was die Bedingung ebenfalls löst.
  assert.match(router, /addEventListener\('focusout', scheduleKeyboardSync\)/,
    'focusout muss den Zustand auflösen - der Rückweg, der nicht ausbleiben kann (#634)');
  assert.match(router, /addEventListener\('focusin', scheduleKeyboardSync\)/,
    'focusin muss den Zustand nachziehen');

  // 3. Eine Stelle, nicht zwei: ein zweiter Setzer hätte einen eigenen Rückweg,
  //    und genau daran ist die erste Fassung gestorben.
  assert.equal((router.match(/keyboard-visible/g) ?? []).length, 1,
    'keyboard-visible darf nur in syncKeyboardVisible() gesetzt werden (#634)');

  // 4. Und der Rückweg selbst darf nicht wieder an einem Ereignis hängen, das
  //    ausbleiben kann: `requestAnimationFrame` ruht in verborgenen Tabs. Beim
  //    Nachmessen im Browser blieb der Zustand damit stehen - dieselbe Form wie
  //    der Defekt, nur eine Ebene tiefer. Timer werden gedrosselt, aber laufen.
  const scheduler = router.match(/function scheduleKeyboardSync\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(scheduler, 'scheduleKeyboardSync() muss es geben');
  assert.doesNotMatch(scheduler, /requestAnimationFrame/,
    'der Rückweg darf nicht an rAF hängen - das ruht in verborgenen Tabs (#634)');
  assert.match(scheduler, /setTimeout/,
    'der aufgeschobene Abgleich läuft über einen Timer, der auch verborgen feuert (#634)');

  // Picker öffnen keine Tastatur. Ohne diese Trennung verschwände der FAB,
  // sobald jemand ein Datums- oder Farbfeld antippt.
  const nonText = router.match(/NON_TEXT_INPUT_TYPES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  for (const type of ['date', 'checkbox', 'radio', 'color', 'file', 'range']) {
    assert.match(nonText, new RegExp(`'${type}'`),
      `input[type=${type}] öffnet keine Tastatur und darf den FAB nicht verbergen`);
  }
});

// --------------------------------------------------------
// Küche: der Weg in eine fremde Liste
// --------------------------------------------------------

/**
 * Alle Aufrufe, mit denen eine Seite Artikel in einen anderen Tab schiebt.
 *
 * Erkannt am Muster, nicht an einer Liste: letztes Segment `to-shopping-list`
 * oder `import-<etwas>`. Ein künftiger Geschwister-Pfad fällt damit auf, ohne
 * dass jemand daran denken muss, ihn hier einzutragen.
 */
function transferCalls(source) {
  return [...source.matchAll(/api\.post\(\s*[`'"]([^`'"]+)[`'"]/g)]
    .map((match) => match[1])
    .filter((url) => /\/to-shopping-list$|\/import-[a-z-]+$/.test(url));
}

/** Dieselben Pfade auf der Serverseite. */
function transferRoutes(source) {
  const heads = [...source.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)'/gm)];
  return heads
    .map((head, index) => ({
      method: head[1],
      path: head[2],
      body: source.slice(head.index, heads[index + 1]?.index ?? source.length),
    }))
    .filter(({ method, path }) => method === 'post' && /\/to-shopping-list$|\/import-[a-z-]+$/.test(path));
}

/**
 * Wege mit eigenem Bestätigungsdialog. Dort ist die Rückfrage der Schutz, und
 * der Nutzer steht beim Auslösen auf dem ZIEL - beides fehlt den drei Ein-Tipp-
 * Pfaden, um die es hier geht.
 */
const CONFIRMED_TRANSFERS = new Map([
  ['import-meal-plan', 'Einkauf holt sich den Essensplan: eigener Dialog mit Zeitraum-Wahl und '
    + 'Vorschau („X Zutaten aus Y Mahlzeiten"), bestätigt auf der Zielliste selbst.'],
  ['import-shopping', 'Einkauf räumt in den Vorrat ein: eigener Dialog, in dem Menge, Einheit und '
    + 'Lagerort pro Artikel gesetzt werden - kein versehentlich auslösbarer Knopf.'],
]);

const isConfirmedTransfer = (url) => [...CONFIRMED_TRANSFERS.keys()].some((name) => url.endsWith(name));

/**
 * Der Zustand „es gibt noch keine Einkaufsliste" hatte VIER Antworten.
 *
 * Gemessen (Audit 2026-07-30, P1-A): zwei Zeichenketten, zwei Töne und genau ein
 * Ausweg. `pantry.js` sagte in `warning`, was zu tun ist; `recipes.js` und
 * `meals.js` benannten in `danger` nur den Zustand - rot behauptet dabei, etwas
 * sei kaputt, obwohl eine noch nicht angelegte Liste bloß eine fehlende
 * Voraussetzung ist. Im Mahlzeiten-Modal stand derselbe Satz ein viertes Mal als
 * deaktiviertes `<option>` neben einem Knopf, der nichts tat. Und `recipes.js`
 * lieh sich dafür `meals.noShoppingLists`: ein Refactor im Essensplan hätte den
 * Text der Rezepte stillschweigend mitgenommen.
 *
 * Der Guard hält die Regel, nicht die vier Dateien: er findet JEDEN Transfer im
 * Seitenbestand und verlangt, dass dessen Vorprüfung aus dem geteilten Baustein
 * kommt.
 */
test('der Zustand „keine Einkaufsliste" hat genau eine Antwort', () => {
  const de = JSON.parse(read('../public/locales/de.json'));
  const helper = read('../public/utils/kitchen-transfer.js');

  // Der Helfer kapselt Prüfung UND Antwort. Ein geteilter Locale-Key allein
  // hätte Ton, Ausweg und Vorprüfung unberührt gelassen - genau die Teile, die
  // auseinandergelaufen waren.
  assert.match(helper, /export async function resolveShoppingTarget/,
    'die Vorprüfung gehört in den geteilten Baustein, nicht in die drei Aufrufer');
  assert.match(helper, /showToast\(message, 'warning', TRANSFER_TOAST_MS, action\)/,
    'Ton warning statt danger: eine fehlende Voraussetzung ist keine Störung');
  assert.match(helper, /navigate\('\/shopping'\)/,
    'die Antwort muss einen Ausweg tragen, nicht nur den Zustand benennen');
  assert.match(helper, /isModuleDisabled\?\.\('shopping'\)/,
    'ist der Einkauf abgeschaltet, wäre der Ausweg eine Sackgasse - dann entfällt er');

  const pagesDir = new URL('../public/pages/', import.meta.url);
  let checked = 0;
  for (const entry of readdirSync(pagesDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = read(`../public/pages/${entry}`);
    for (const url of transferCalls(source)) {
      if (isConfirmedTransfer(url)) continue;
      checked += 1;
      assert.match(source, /from '\/utils\/kitchen-transfer\.js'/,
        `${entry} überträgt nach ${url} und muss dafür den geteilten Baustein importieren`);
      assert.match(source, /resolveShoppingTarget\(/,
        `${entry} muss sein Transfer-Ziel über resolveShoppingTarget() bestimmen, nicht selbst prüfen`);
    }
  }
  assert.ok(checked >= 3, `mindestens die drei erzeugenden Pfade müssen erfasst sein, gefunden: ${checked}`);

  // Keine Seite hält eine EIGENE Antwort auf diesen Zustand. Die beiden
  // verbliebenen Vorkommen sind ein anderer Zustand: dort hat der Nutzer gar
  // keine Liste UND steht auf der Fläche, auf der er eine anlegt - beide tragen
  // ihren eigenen Anlege-CTA und sind keine Vorbedingung eines Transfers.
  const ownEmptyStates = new Set(['shopping.noLists', 'dashboard.noShoppingLists']);
  for (const entry of readdirSync(pagesDir)) {
    if (!entry.endsWith('.js')) continue;
    for (const [, key] of read(`../public/pages/${entry}`)
      .matchAll(/t\('([a-zA-Z]+\.(?:noShoppingLists|noLists))'/g)) {
      assert.ok(
        key.startsWith('kitchen.') || ownEmptyStates.has(key),
        `${entry} beantwortet „keine Einkaufsliste" mit ${key} statt über den geteilten Baustein`,
      );
    }
  }

  // Der Key gehört der Gruppe, nicht einem der drei Aufrufer.
  assertKeysExistInEveryLocale(['kitchen.noShoppingLists', 'kitchen.createShoppingList']);
  assert.equal(de.meals.noShoppingLists, undefined,
    'der Text darf nicht in meals.* liegen - die Rezepte liehen ihn sich von dort');
  assert.equal(de.pantry.noLists, undefined, 'auch der Vorrat besitzt den Zustand nicht mehr allein');
  assert.doesNotMatch(de.kitchen.noShoppingLists, /Tab/,
    'den Zielort nennt der Knopf; ein zweites Mal im Satz wäre der Tab-Name doppelt');
});

/**
 * Zurücknehmen konnte man nur im Vorrat.
 *
 * Gemessen (Audit 2026-07-30, P1-B): drei Wege erzeugen mit EINEM Tippen Artikel
 * in einer Liste, die der Nutzer gerade nicht ansieht - und nur `pantry.js` bot
 * eine Rücknahme an. Das Rezept überträgt dabei am meisten auf einmal, eine
 * ganze Zutatenliste. Dazu zwei Abweichungen auf demselben Pfad: die Standzeit
 * des Toasts (Vorrat 5000, sonst Default) und das Sperren des Knopfes während
 * des Transfers (Rezepte ja, Vorrat nein).
 *
 * Auch dieser Guard sucht den Bestand ab: jeder Transfer-Aufruf im Seitenbestand
 * und jeder Transfer-Handler im Routenbestand muss die Regel erfüllen. Ausnahmen
 * stehen mit Begründung in CONFIRMED_TRANSFERS.
 */
test('jeder Ein-Tipp-Transfer in eine fremde Liste ist rücknehmbar', () => {
  const helper = read('../public/utils/kitchen-transfer.js');

  // Eine Standzeit für alle, und sie ist länger als der Default: diese Toasts
  // tragen eine Aktion, der Nutzer muss lesen UND entscheiden können.
  assert.match(helper, /export const TRANSFER_TOAST_MS = 5000/);
  assert.match(helper, /showToast\(message, 'success', TRANSFER_TOAST_MS, undo\)/,
    'der Erfolgs-Toast muss die Rücknahme tragen');
  assert.match(helper, /ids\.length\s*\?/,
    'ohne IDs darf kein Undo-Knopf erscheinen, der nichts zurücknehmen kann');
  assert.match(helper, /api\.post\('\/shopping\/items\/undo-transfer', \{ ids \}\)/,
    'die Rücknahme läuft über EINEN Aufruf - N einzelne DELETEs können zur Hälfte scheitern');
  assert.match(helper, /refreshKitchenBadges\(\)/,
    'die Zahl des Einkaufs-Tabs ändert sich in beide Richtungen, beide Male hier');

  // Serverbestand: was einen Transfer entgegennimmt, liefert die erzeugten IDs.
  // Ohne sie gibt es nichts zurückzunehmen - die Anzahl kennt erst der Server,
  // weil er Duplikate überspringt.
  const routesDir = new URL('../server/routes/', import.meta.url);
  let routesChecked = 0;
  for (const entry of readdirSync(routesDir)) {
    if (!entry.endsWith('.js')) continue;
    for (const route of transferRoutes(read(`../server/routes/${entry}`))) {
      if (isConfirmedTransfer(route.path)) continue;
      routesChecked += 1;
      assert.match(route.body, /added_ids/,
        `POST ${route.path} (${entry}) muss die erzeugten IDs zurückgeben`);
      assert.match(route.body, /lastInsertRowid/,
        `POST ${route.path} (${entry}) muss die IDs beim Einfügen einsammeln`);
      assert.match(route.body, /added_ids: \[\] \} \}\)/,
        `POST ${route.path} (${entry}) muss auch im Leerfall added_ids liefern, damit der Client nicht raten muss`);
    }
  }
  assert.ok(routesChecked >= 3, `mindestens drei Transfer-Routen erwartet, gefunden: ${routesChecked}`);

  // Die Rücknahme nimmt den GANZEN Übertrag zurück, nicht nur seine Artikel: der
  // Mahlzeit-Pfad setzt beim Übertragen `on_shopping_list`. Wer nur die
  // Einkaufsartikel löscht, lässt die Zutaten für immer als „schon übertragen"
  // zurück - weder auf der Liste noch erneut übertragbar.
  const shoppingRoute = read('../server/routes/shopping.js');
  const undoBlock = shoppingRoute.slice(shoppingRoute.indexOf("router.post('/items/undo-transfer'"));
  assert.match(undoBlock, /UPDATE meal_ingredients SET on_shopping_list = 0/,
    'das Undo muss das Zutaten-Flag mit zurücknehmen');
  assert.match(undoBlock, /db\.get\(\)\.transaction\(/,
    'die Rücknahme ist eine Handlung und gehört in eine Transaktion');

  // Seitenbestand: jeder Transfer meldet über den geteilten Baustein - damit
  // erbt er Standzeit, Tab-Zahl und Rücknahme, statt sie je Modul zu setzen.
  const pagesDir = new URL('../public/pages/', import.meta.url);
  for (const entry of readdirSync(pagesDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = read(`../public/pages/${entry}`);
    for (const url of transferCalls(source)) {
      if (isConfirmedTransfer(url)) continue;
      assert.match(source, /announceTransfer\(\{/,
        `${entry} überträgt nach ${url} und muss den Erfolg über announceTransfer() melden`);
      assert.match(source, /added_ids/,
        `${entry} muss die added_ids der Antwort weiterreichen, sonst gibt es nichts zurückzunehmen`);
      assert.doesNotMatch(source, /showToast\([^)]*'success',\s*\d+/,
        `${entry} darf keine eigene Toast-Standzeit für einen Transfer setzen`);
    }
  }

  // Knopf-Sperre während des Transfers in allen drei Aufrufern: ohne sie erzeugt
  // jedes weitere Tippen einen eigenen Toast mit eigenem Undo, von denen nur der
  // letzte etwas zurücknimmt.
  for (const page of ['pantry.js', 'recipes.js', 'meals.js']) {
    assert.match(read(`../public/pages/${page}`), /if \(btn\) btn\.disabled = true;/,
      `${page} muss den auslösenden Knopf während des Transfers sperren`);
  }

  assertKeysExistInEveryLocale(['kitchen.transferUndone']);
});

/**
 * Der Einkauf trug mobil 439 von 852px Chrome, bevor ein Artikel sichtbar war.
 *
 * Ausgangslage (Critique 2026-07-30, P1), selbst nachgemessen: erste Datenzeile bei
 * y=439 von 852 (52%) bei 393px, y=495 von 720 (69%) bei 320px. Darüber sieben
 * gestapelte Bänder, 17 Tabstops bis zum ersten Artikel (gegen 3 in den Rezepten).
 * Der Kopf allein war 173px hoch (229px bei 320px), weil fünf Bedienelemente nicht
 * in 361px passen - drei davon unbeschriftete Icons, darunter „Liste löschen" für
 * die Liste des ganzen Haushalts.
 *
 * Drei Züge, jeder mit eigener Begründung:
 *   1. Die drei dauerhaften Aktionen wandern MIT LABEL in ein Überlaufmenü.
 *   2. Die zwei Abschluss-Aktionen wandern in die geteilte .kitchen-bulkbar -
 *      dieselbe Leiste, in der der Vorrat seine Sammelaktion trägt.
 *   3. Das Quick-Add klappt auf Touch ein; der FAB öffnet es und tut damit
 *      dasselbe wie in den drei Geschwistertabs.
 *
 * Gemessen danach: Kopf 65px auf beiden Breiten, erste Zeile y=308 (36% / 43%),
 * 11 Tabstops.
 */
test('der Einkaufs-Kopf trägt mobil keine unbeschrifteten Aktionen', () => {
  const page = read('../public/pages/shopping.js');
  const css = read('../public/styles/shopping.css');
  const menu = read('../public/utils/popover-menu.js');
  const layout = read('../public/styles/layout.css');

  // Das Menü ist der geteilte Baustein, keine vierte private Kopie.
  assert.match(page, /import \{ popoverMenuHtml, installPopoverMenus \} from '\/utils\/popover-menu\.js'/,
    'shopping.js muss das geteilte Überlaufmenü nutzen');
  assert.match(layout, /^\.popover-menu \{/m, '.popover-menu muss in layout.css stehen, nicht im Modul-CSS');
  assert.match(layout, /\.popover-menu:popover-open\s*\{\s*display:\s*flex/,
    'das Panel braucht display erst bei :popover-open, sonst schlägt es das UA-display:none');

  // JEDER Eintrag trägt ein Label. Das ist der ganze Zweck: die drei Kopf-Aktionen
  // waren mobil nackte Glyphen.
  assert.match(menu, /<span>\$\{esc\(item\.label\)\}<\/span>/,
    'jeder Menü-Eintrag muss ein sichtbares Textlabel tragen');
  const items = page.slice(page.indexOf('id: \'list-head-menu\''), page.indexOf('</div>\n        </div>'));
  for (const key of ['shopping.importMeals', 'shopping.manageCategories', 'shopping.deleteListLabel']) {
    assert.ok(items.includes(`t('${key}')`), `das Überlaufmenü muss ${key} als Label führen`);
  }
  assert.match(items, /danger:\s*true/, '„Liste löschen" muss im Menü als destruktiv gekennzeichnet sein');

  // Genau eine Fassung je Breite - sonst doppelte Tabstops.
  assert.match(css, /\.list-header__more\s*\{\s*display:\s*none/,
    'das Menü ist ab 768px ausgeblendet, dort trägt die Leiste die Aktionen');
  assert.match(css, /@media \(max-width: 767px\)[\s\S]{0,400}\.list-header__inline-actions\s*\{\s*display:\s*none/,
    'unter 768px muss die Inline-Leiste ausgeblendet sein');

  // Das Icon-only-Import-Label darf nicht zurückkommen: es war der Grund, warum
  // drei unbeschriftete Glyphen nebeneinander standen.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.list-header__import-btn span\s*\{\s*display:\s*none/,
    '„Aus dem Essensplan" darf mobil nicht auf ein nacktes Icon reduziert werden - es steht mit Label im Menü');

  // Quick-Add als Disclosure, und der FAB meldet den Zustand.
  assert.match(css, /@media \(hover: none\)[\s\S]{0,600}\.quick-add\s*\{\s*display:\s*none/,
    'das Quick-Add muss auf Touch eingeklappt sein');
  assert.match(css, /\.shopping-page--adding \.quick-add\s*\{\s*display:\s*block/,
    'der FAB muss es aufklappen können');
  assert.match(page, /fab\.setAttribute\('aria-expanded', String\(open\)\)/,
    'der FAB muss seinen Aufklapp-Zustand melden');
  assert.match(page, /fab\.removeAttribute\('aria-expanded'\)/,
    'auf Zeigergeräten klappt der FAB nichts auf und darf keinen Zustand behaupten');
  assert.match(page, /e\.key !== 'Escape'/, 'Esc muss das Quick-Add wieder schließen');

  // Der dritte Add-Weg entfällt, wo das Eingabefeld selbst sichtbar ist.
  assert.match(css, /@media \(hover: hover\)[\s\S]{0,400}\.empty-state__cta\s*\{\s*display:\s*none/,
    'auf Zeigergeräten ist der Leerzustands-CTA eine dritte Tür in denselben Raum');

  assertKeysExistInEveryLocale(['common.moreActions', 'shopping.checkedHint', 'shopping.checkedHint_one']);
});

/**
 * Eine Sammelaktions-Leiste, zwei Tabs.
 *
 * Der Vorrat hatte `.pantry-bulkbar` („Alles auf die Einkaufsliste" plus eine Zeile,
 * die sagt, worauf sie wirkt) - der Critique nannte sie als das, was funktioniert.
 * Der Einkauf hatte für dieselbe Sache zwei Buttons im Kopf, ohne erklärende Zeile,
 * und zahlte dafür zwei Kopfzeilen. Jetzt ist es derselbe Baustein.
 */
test('die Küchen-Tabs teilen eine Sammelaktions-Leiste', () => {
  const shared = read('../public/styles/kitchen-row.css');
  const layout = read('../public/styles/layout.css');
  const pantryCss = read('../public/styles/pantry.css');

  assert.match(shared, /^\.kitchen-bulkbar \{/m,
    '.kitchen-bulkbar gehört in die geteilte Grammatik, nicht in ein Modul-CSS');
  assert.doesNotMatch(pantryCss.replace(/\/\*[\s\S]*?\*\//g, ''), /^\.pantry-bulkbar\s*\{/m,
    'der Vorrat darf keine private Kopie der Leiste behalten');

  for (const page of ['shopping', 'pantry']) {
    const src = read(`../public/pages/${page}.js`);
    assert.ok(src.includes('kitchen-bulkbar'), `${page}.js muss die geteilte Leiste verwenden`);
    assert.ok(src.includes('kitchen-bulkbar__label'),
      `${page}.js muss die erklärende Zeile führen - sie ist der Teil, der im Einkauf fehlte`);
  }

  // Die Leiste hat Fläche, Rahmen und Polsterung: leer wäre sie ein sichtbarer
  // Streifen. `display: flex` schlägt das UA-`[hidden]`, also braucht sie die
  // Durchsetzung - vierte Fundstelle derselben Falle in diesem Repo.
  assert.match(layout, /\.kitchen-bulkbar\[hidden\][^{}]*\{\s*display:\s*none\s*!important/,
    '.kitchen-bulkbar setzt display und muss deshalb in der [hidden]-Durchsetzungsliste stehen');
  assert.match(read('../public/pages/shopping.js'), /wrap\.hidden = !checkedCount/,
    'ohne abgehakte Artikel muss die Leiste verschwinden, nicht leer stehen');

  // Sie steht ÜBER dem Scroller, nicht darin: im Vorrat scrollte sie weg, obwohl
  // sie die ganze gefilterte Liste betrifft.
  const pantry = read('../public/pages/pantry.js');
  assert.match(pantry, /pantry-bulkbar-slot/, 'der Vorrat braucht einen Slot außerhalb des Scrollers');
  assert.match(pantry, /page\.append\(title, live, toolbar, filters, bulk, list, fab\)/,
    'der Slot muss zwischen Filterleiste und Liste stehen');
  assert.doesNotMatch(pantry, /list\.appendChild\(bulkBarEl\(\)\)/,
    'die Leiste darf nicht wieder als Kind der scrollenden Liste hängen');
});

/**
 * Die Vorratszeile entscheidet nach ihrer EIGENEN Breite, nicht nach der des
 * Fensters.
 *
 * Gemessen bei 320px (Critique-Nachlauf 2026-07-30): der Stepper belegte 167px der
 * 262px Zeilenbreite, davon 71px allein das Mengenfeld (`min-width: 7ch`). Für den
 * Namen blieben 31px - „Olivenöl extra vergine" auf 8 Zeilen, Zeilenhöhen 89 bis
 * 369px. Danach: 106px Namensbreite, Zeilenhöhen 85 bis 155px.
 */
test('die Vorratszeile misst sich selbst, nicht das Fenster', () => {
  const shared = read('../public/styles/kitchen-row.css');
  const pantryCss = read('../public/styles/pantry.css');

  const rows = shared.match(/\.kitchen-rows\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rows, /container-type:\s*inline-size/,
    '.kitchen-rows muss abfragbarer Container sein - ein Container kann sich selbst nicht abfragen');
  assert.match(rows, /container-name:\s*kitchen-rows/, 'der Container braucht einen Namen');

  assert.match(pantryCss, /@container kitchen-rows \(max-width: 30rem\)/,
    'die Kompaktform muss an der ZEILENbreite hängen, nicht an einem Viewport-Breakpoint');
  const compact = pantryCss.slice(pantryCss.indexOf('@container kitchen-rows'));
  assert.match(compact, /\.pantry-stepper\s*\{[\s\S]*?flex-wrap:\s*wrap/,
    'der Stepper muss umbrechen dürfen');
  assert.match(compact, /width:\s*calc\(var\(--pantry-step-btn\) \* 2 \+ var\(--space-1\)\)/,
    'ohne feste Breite wickelt der Flex-Container nie um: seine max-content-Breite ist die Summe aller drei Kinder');
  assert.match(compact, /\.pantry-stepper__value\s*\{[\s\S]*?order:\s*-1/,
    'der Wert rückt über die Knöpfe - per order, damit die Vorlesereihenfolge Minus/Wert/Plus bleibt');
  assert.match(compact, /min-width:\s*0/, 'die 7ch des Mengenfelds müssen in der Kompaktform fallen');

  // Eine Variable, zwei Zeigerklassen: die Kompaktbreite muss mit derselben Zahl
  // rechnen wie die Knöpfe selbst.
  assert.match(pantryCss, /--pantry-step-btn:\s*var\(--target-md\)/, 'Zeiger: --target-md');
  assert.match(pantryCss, /@media \(hover: none\)\s*\{\s*\.pantry-stepper\s*\{\s*--pantry-step-btn:\s*var\(--target-base\)/,
    'Touch: --target-base, gesetzt an derselben Variable');
  assert.doesNotMatch(pantryCss, /\.pantry-stepper__btn\s*\{[^}]*width:\s*var\(--target-md\)/,
    'die Knopfgröße darf nicht doppelt gepflegt werden');
});

/**
 * Der Kreislauf lebt nicht mehr nur im Leerzustand.
 *
 * Die vier Leerzustands-Hinweise erzählten planen → kochen → einkaufen → lagern
 * vollständig - und verschwanden mit dem ersten Datensatz. Übrig blieben vier
 * Schubladen (Critique 2026-07-30, P1). Die Tab-Leiste trägt den Zustand jetzt
 * dauerhaft: „Mahlzeiten 10" neben „Einkaufen 23" neben „Vorrat 10".
 */
test('die Küchen-Tab-Leiste trägt den Zustand des Kreislaufs', () => {
  const route = read('../server/routes/kitchen.js');
  const tabs = read('../public/utils/kitchen-tabs.js');
  const sub = read('../public/utils/sub-tabs.js');
  const index = read('../server/index.js');

  // Eine Abfrage, vier Zahlen - keine drei Fremd-Endpunkte pro Seitenaufruf.
  assert.match(index, /app\.use\('\/api\/v1\/kitchen', kitchenRouter\)/,
    'der Kitchen-Router muss gemountet sein');
  assert.match(read('../server/openapi/paths/kitchen.js'), /'\/api\/v1\/kitchen\/summary'/,
    'die Route muss in der OpenAPI-Spec stehen');
  assert.match(route, /router\.get\('\/summary'[\s\S]*?try \{[\s\S]*?\} catch \(err\)/,
    'jeder Route-Handler in try/catch (Hard Constraint)');

  // `today` kommt vom Client: „abgelaufen" hängt am lokalen Kalendertag, der Server
  // rechnet in UTC. Dieselbe Entscheidung wie im Kopf von pantry-status.js.
  assert.match(tabs, /kitchen\/summary\?today=\$\{encodeURIComponent\(toLocalDateKey\(\)\)\}/,
    'der Client muss seinen lokalen Tag mitgeben, sonst rechnet der Server in UTC');
  assert.match(route, /DATE_RE\.test\(req\.query\.today/, 'die Route muss `today` validieren');

  // Die Zählbedingungen müssen mit pantryItemStatus() übereinstimmen, sonst zeigt
  // die Leiste eine andere Zahl als die Filter-Chips daneben.
  const status = read('../public/utils/pantry-status.js');
  assert.match(status, /const out = quantity <= 0/);
  assert.match(route, /quantity <= 0/, 'leer: dieselbe Bedingung wie pantryItemStatus');
  assert.match(route, /min_quantity IS NOT NULL AND quantity <= min_quantity/,
    'fast leer: dieselbe Bedingung wie pantryItemStatus');
  assert.match(route, /expires_on IS NOT NULL AND expires_on < \?/,
    'abgelaufen: reiner Stringvergleich wie im Client (YYYY-MM-DD ist lexikografisch chronologisch)');

  // Kein Badge auf dem aktiven Tab: dort sagt die Seite es vollständiger, und eine
  // Zahl dort müsste nach jeder Mutation nachgezogen werden.
  assert.match(tabs, /route === _activeRoute \? 0 :/,
    'der aktive Tab darf kein Badge tragen - sonst veraltet es bei jeder eigenen Mutation');

  // Das aria-label ERSETZT den Tab-Namen, es ergänzt ihn nicht.
  for (const [tabKey, stateKey] of [['nav.shopping', 'nav.shoppingOpen'], ['nav.pantry', 'nav.pantryAttention']]) {
    assert.ok(tabs.includes(`\${t('${tabKey}')}: \${t('${stateKey}'`),
      `${stateKey} muss den Tabnamen voranstellen, sonst hört ein Screenreader nur die Zahl`);
  }
  assert.match(sub, /badge\.setAttribute\('aria-hidden', 'true'\)/,
    'die Zahl ist redundant, sobald das Label sie nennt');
  // `display: inline-flex` schlägt das UA-`[hidden]`: der aktive Tab trug ohne diese
  // Regel ein 16 x 0px breites totes Innenmaß. Fünfte Fundstelle dieser Falle.
  const subCss = read('../public/styles/sub-tabs.css');
  assert.match(subCss, /\.sub-tab__badge\[hidden\]\s*\{\s*display:\s*none/,
    'ohne diese Regel bleibt das leere Badge 16px breit stehen');
  // Getönter Grund plus currentColor ergab auf inaktiven Tabs 4.02:1 bei 12px/600,
  // unter der AA-Schwelle 4.5. Gemessen nach dem Fix: 11.0 hell, 16.43 dunkel.
  assert.match(subCss, /\.sub-tab__badge\s*\{[\s\S]*?color:\s*var\(--color-text-primary\)/,
    'die Zahl braucht Ink, nicht die zurückgenommene Tab-Tinte');
  assertKeysExistInEveryLocale([
    'nav.shoppingOpen', 'nav.shoppingOpen_one',
    'nav.pantryAttention', 'nav.pantryAttention_one',
  ]);

  // Ein Badge zählt, was WARTET - nie, was fehlt.
  //
  // Rezepte bekamen nie eins („6 Rezepte" ist eine Bestandszahl), der Essensplan
  // hatte eins und es zählte die Gegenrichtung: freie Slots der Woche, also
  // Mahlzeitentypen × 7 minus die belegten. Bei leerer Woche stand dort 28 - das
  // Maximum, die lauteste Zahl der Leiste, ausgerechnet für „nichts geplant" -
  // und mitgezählt wurden Tage, die schon vorbei waren. Übrig bleiben die zwei
  // Stationen mit echtem offenem Vorrat.
  //
  // Nur die BADGES-Liste prüfen - `/meals` und `/recipes` stehen
  // selbstverständlich weiter in TABS().
  const badges = tabs.slice(tabs.indexOf('const BADGES = ['), tabs.indexOf('/** Aktuelle Leiste'));
  assert.ok(badges.includes("route: '/shopping'") && badges.includes("route: '/pantry'"),
    'die zwei Stationen mit offenem Zustand brauchen ein Badge');
  for (const route of ['/recipes', '/meals']) {
    assert.ok(!badges.includes(`route: '${route}'`),
      `${route}: ein Badge, das Bestand oder Abwesenheit zählt, entwertet die zwei, die etwas verlangen`);
  }
  // Und die Rechnung dahinter ist mit weg: kein toter COUNT auf jedem
  // Seitenaufruf. Ohne Kommentare geprüft - beide Dateien erklären in ihrem Kopf,
  // was hier entfallen ist, und würden sich sonst selbst auslösen.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code(route), /\bgaps\b|FROM meals\b|visible_meal_types/,
    'server/routes/kitchen.js: die Lücken-Rechnung ist ohne Badge tot - sie darf nicht stehenbleiben');
  assert.doesNotMatch(code(tabs), /meals\?\.gaps|mealsGaps/,
    'kitchen-tabs.js: kein Rest des entfallenen Mahlzeiten-Badges');
});

/**
 * EIN Vokabular für den Kreislauf.
 *
 * Gemessen (Critique 2026-07-30, P1/P2): dieselbe Aktion hieß in drei Keys
 * („meals.transferToShoppingList", „recipes.toShoppingList", „pantry.toShopping") -
 * auf Deutsch zufällig gleich, auf Englisch schon auseinandergelaufen („To the
 * shopping list" gegen „Add to shopping list"). Der Transfer-Toast nannte sein Ziel
 * nicht („5 Zutaten übernommen." - wohin?). Der Tab hieß „Mahlzeiten", die Seite
 * darunter „Essensplan". Dasselbe Feld hieß „Titel" und „Bezeichnung". Und
 * gelöscht wurde „entfernt" im Einkauf und „gelöscht" in Mahlzeiten und Rezepten.
 */
test('die Küche benutzt ein Vokabular für eine Sache', () => {
  const de = JSON.parse(read('../public/locales/de.json'));
  const pages = Object.fromEntries(['meals', 'recipes', 'shopping', 'pantry']
    .map((p) => [p, read(`../public/pages/${p}.js`)]));

  // EIN Transfer-Label und EIN „auf welche Liste?" für alle vier Tabs.
  assertKeysExistInEveryLocale(['common.toShoppingList', 'common.toShoppingListWhich']);
  for (const dead of ['meals.transferToShoppingList', 'recipes.toShoppingList', 'recipes.toShoppingListTitle', 'pantry.toShopping', 'pantry.chooseList']) {
    const [block, key] = dead.split('.');
    assert.equal(de[block]?.[key], undefined,
      `${dead} ist durch common.toShoppingList ersetzt - zwei Keys für ein Label laufen auseinander (auf Englisch war das schon passiert)`);
  }
  for (const page of ['meals', 'recipes', 'pantry']) {
    assert.ok(pages[page].includes("t('common.toShoppingList')"),
      `${page}.js muss das geteilte Transfer-Label nutzen`);
  }

  // Jeder Transfer-Toast nennt sein ZIEL.
  for (const key of ['meals.transferSuccess', 'recipes.toShoppingSuccess', 'pantry.toShoppingDone']) {
    const [block, name] = key.split('.');
    assert.match(de[block][name], /\{\{list\}\}/,
      `${key} muss die Ziel-Liste nennen: „übernommen" allein sagt nicht, wohin`);
  }
  assert.match(de.shopping.toPantryDoneAt, /\{\{location\}\}/,
    'der Weg in den Vorrat muss den gewählten Lagerort nennen');
  // Geprüft wird der AUFRUF, nicht die Zeile, aus der der Name stammt: die drei
  // holten ihn vorher je anders (`state.lists.find`, eine lokale `listName`), und
  // ein Guard auf diese Schreibweisen scheiterte am nächsten Refactor, obwohl die
  // Regel weiter galt.
  for (const [page, key] of [['meals', 'meals.transferSuccess'], ['recipes', 'recipes.toShoppingSuccess'], ['pantry', 'pantry.toShoppingDone']]) {
    assert.match(pages[page], new RegExp(`t\\('${key}',\\s*\\{[^}]*list:`),
      `${page}.js muss den Listennamen an ${key} übergeben`);
  }

  // EIN Name pro Modul: der sichtbare Tab und die sr-only-Überschrift derselben
  // Seite dürfen nicht zwei verschiedene Wörter sein.
  for (const dead of ['meals.title', 'recipes.title', 'shopping.title', 'pantry.title']) {
    const [block, key] = dead.split('.');
    assert.equal(de[block]?.[key], undefined,
      `${dead} ist durch nav.${block} ersetzt - ein Screenreader hörte sonst „Mahlzeiten" im Tab und „Essensplan" in der Überschrift`);
  }
  for (const [page, key] of [['meals', 'nav.meals'], ['recipes', 'nav.recipes'], ['shopping', 'nav.shopping'], ['pantry', 'nav.pantry']]) {
    assert.ok(pages[page].includes(`t('${key}')`), `${page}.js muss ${key} als Seitentitel nutzen`);
  }

  // EIN Feld-Label für „wie heißt dieses Ding".
  assertKeysExistInEveryLocale(['common.nameLabel', 'common.nameRequired']);
  for (const dead of ['meals.titleLabel', 'meals.titleRequired', 'recipes.titleLabel', 'recipes.titleRequired', 'pantry.nameLabel', 'pantry.nameRequired']) {
    const [block, key] = dead.split('.');
    assert.equal(de[block]?.[key], undefined, `${dead} ist durch common.nameLabel/nameRequired ersetzt`);
  }

  // EIN Verb fürs Löschen. „entfernt" bleibt genau dort, wo etwas von einer Liste
  // genommen wird, ohne zu verschwinden: das Undo des Vorrats-Transfers.
  for (const key of ['meals.deletedToast', 'meals.seriesDeletedToast', 'recipes.deleted', 'pantry.deleted', 'shopping.deletedListToast', 'shopping.itemDeletedToast', 'shopping.itemsRemovedToast']) {
    const [block, name] = key.split('.');
    assert.match(de[block][name], /gelöscht/,
      `${key} muss „gelöscht" sagen - „entfernt" im Einkauf gegen „gelöscht" in Mahlzeiten war dieselbe Handlung mit zwei Verben`);
    // Toast-Interpunktion: ganze Sätze enden auf einen Punkt. „Mahlzeit gelöscht"
    // stand ohne, „Rezept gelöscht." mit (Critique 2026-07-30).
    assert.match(de[block][name], /\.$/, `${key} muss auf einen Punkt enden`);
  }
  assert.match(de.kitchen.transferUndone, /entfernt/,
    'das Undo nimmt den Artikel von der Einkaufsliste, ohne ihn zu löschen - hier ist „entfernt" korrekt');
});

/**
 * Zwei Editoren für dieselbe Handlung, und einer davon war ein halber.
 *
 * Gemessen (Critique 2026-07-30, P2): der Einkaufs-Dialog trug den DATENWERT als
 * Titel („Cherry tomatoes"), hatte zwei Felder (Link, Notiz), Schließen und
 * Speichern - kein Abbrechen -, und Name und Menge waren dort nicht änderbar. Das
 * strukturgleiche Vorrats-Modal hieß „Artikel bearbeiten", hatte acht Felder und
 * Löschen / Abbrechen / Speichern.
 */
test('die beiden Küchen-Editoren sind derselbe Dialog', () => {
  const shopping = read('../public/pages/shopping.js');
  const pantry = read('../public/pages/pantry.js');
  const de = JSON.parse(read('../public/locales/de.json'));

  // Ein Titel-Key für beide.
  assertKeysExistInEveryLocale(['common.editItem']);
  assert.equal(de.pantry?.editItem, undefined, 'pantry.editItem ist durch common.editItem ersetzt');
  for (const [name, src] of [['shopping', shopping], ['pantry', pantry]]) {
    assert.ok(src.includes("t('common.editItem')"), `${name}.js muss den geteilten Dialog-Titel nutzen`);
  }
  const details = shopping.slice(shopping.indexOf('function openItemDetails'), shopping.indexOf('function updateItemsList'));
  assert.doesNotMatch(details, /title: item\.name/,
    'der Datenwert ist kein Dialogtitel - er sagt nicht, was der Dialog tut');

  // Abbrechen neben Speichern, wie im Vorrat.
  assert.match(details, /id="item-details-cancel"/, 'der Dialog braucht ein Abbrechen');
  assert.match(details, /#item-details-cancel'\)\?\.addEventListener\('click', \(\) => closeModal\(\)\)/,
    'Abbrechen muss auch verdrahtet sein');

  // Name, Menge und Kategorie editierbar.
  for (const field of ['item-details-name', 'item-details-qty', 'item-details-cat']) {
    assert.ok(details.includes(`id="${field}"`), `${field} muss im Dialog editierbar sein`);
  }
  assert.match(details, /reportFieldError\(nameEl, t\('common\.nameRequired'\)\)/,
    'ein leerer Name muss am Feld gemeldet werden, nicht per Toast');

  // Die zwei Modal-Checkboxen tragen das geteilte Control.
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /^\.form-check \{/m, '.form-check gehört in layout.css, nicht in ein Modul-CSS');
  // --active-module-accent muss in der Kette stehen: das Modal hängt im Top-Layer
  // außerhalb der Modul-Wurzel, und mit --module-accent allein fiel die Checkbox auf
  // den violetten App-Akzent zurück (gemessen rgb(108,58,237) in einem Dialog, der
  // rundum #C2410C trug).
  assert.match(layout, /\.form-check input\[type="checkbox"\]\s*\{[\s\S]*?accent-color:\s*var\(--module-accent,\s*var\(--active-module-accent/,
    'die Checkbox muss den Modul-Akzent tragen, auch im Modal - sechs andere Module kleiden ihre Checkboxen schon ein');
  assert.match(shopping, /class="form-check pantry-transfer__clear"/,
    'die folgenreichste Checkbox des Moduls („Artikel von der Einkaufsliste löschen", standardmäßig aktiv) war die unauffälligste');
  assert.match(read('../public/pages/recipes.js'), /class="form-check recipe-meal-types__option"/,
    'die Mahlzeit-Typen im Rezept-Formular waren die zweite nackte System-Checkbox');
  // Die Modul-CSS dürfen die Geometrie nicht zurückholen.
  for (const [file, selector] of [['shopping.css', '.pantry-transfer__clear'], ['recipes.css', '.recipe-meal-types__option']]) {
    const block = read(`../public/styles/${file}`).match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.doesNotMatch(block, /display:|align-items:|cursor:/,
      `${file}: ${selector} darf Geometrie und Zielgröße nicht doppelt pflegen - das leistet .form-check`);
  }

  // „Übernehmen" darf bei 0 Treffern nicht klickbar sein. Die Schwesteraktion
  // („Plan zufällig füllen") macht das seit dem Audit korrekt.
  assert.match(shopping, /id="shopping-import-submit" disabled/,
    'der Import-Knopf muss deaktiviert starten');
  assert.match(shopping, /submitBtn\.disabled = !transferred/,
    'die Vorschau muss ihn freischalten, sobald der Zeitraum Zutaten enthält');
});

/**
 * DESIGN.md und tokens.css widersprachen sich über die Touch-Zielgröße.
 *
 * DESIGN.md: „size touch targets at 48px (mobile) or 40px (desktop) minimum. The
 * --target-lg and --target-md tokens encode this — never go below them."
 * tokens.css: `--target-base: 44px` mit der Begründung „iOS-Minimum 44pt", benutzt
 * an 111 Stellen in 18 Modulen - darunter sechs der meistbenutzten Bedienelemente
 * der Küche (.sub-tab, .item-check, #item-qty-input, .quick-add__btn,
 * .pantry-stepper__btn, #week-randomize). Auf Touch lagen die damit 4px unter dem
 * eigenen dokumentierten Minimum (Critique 2026-07-30: „Eine der beiden Zahlen ist
 * falsch.").
 *
 * Falsch war die 44 - und nur auf Touch. Der Wert kennt jetzt die
 * Zeigerfähigkeit: Desktop unverändert 44 (über der 40er-Grenze), Touch 48.
 * Nachgemessen über 4 Routen × 3 Viewports: kein Bedienelement der Küche mehr
 * unter 48px, und kein horizontaler Dokumentüberlauf.
 */
test('die Touch-Zielgröße folgt DESIGN.md statt einer dritten Zahl', () => {
  const tokens = read('../public/styles/tokens.css');

  // Die Quelle der Untergrenze ist DESIGN.md: „size touch targets at 48px (mobile)
  // or 40px (desktop) minimum. The --target-lg and --target-md tokens encode this -
  // never go below them on interactive elements."
  //
  // Der Satz wird hier ZITIERT und nicht gelesen: DESIGN.md steht in .gitignore
  // (Zeile 44), liegt also nur lokal und fehlt in der CI. Ein Guard, der eine
  // ignorierte Datei liest, ist lokal grün und im Build rot - genau so ist dieser
  // Test beim Release v1.59.0 aufgefallen.
  assert.match(tokens, /--target-base:\s*44px/, 'auf Zeigergeräten bleibt es bei 44px (über der 40er-Grenze)');
  assert.match(tokens, /@media \(hover: none\)\s*\{\s*:root\s*\{\s*--target-base:\s*var\(--target-lg\)/,
    'auf Fingergeräten muss --target-base die 48px aus DESIGN.md erreichen');

  // Das Kriterium ist die Zeigerfähigkeit, nicht die Breite: ein schmales
  // Desktop-Fenster wird mit der Maus bedient, ein 1180px-Tablet mit dem Finger.
  const scope = tokens.slice(tokens.indexOf('Touch-Ziele auf Fingergeräten'));
  assert.doesNotMatch(scope.slice(0, 1400), /--target-base[\s\S]{0,80}@media \(max-width/,
    'die Touch-Größe darf nicht an einer Viewport-Breite hängen');
});

/**
 * Nicht-Text-Kontrast: gemessen, dokumentiert, bewusst offen.
 *
 * Die Kanten der Bedienelemente erreichen die 3:1 aus WCAG 1.4.11 nicht (1.13:1
 * hell / 1.96:1 dunkel an den Eingabefeldern). Der Betreiber hat am 2026-07-30
 * entschieden, das vorerst nur zu dokumentieren statt --color-border anzuheben -
 * die Änderung ginge durch jedes Modul.
 *
 * Der Guard hält die MESSUNG fest, nicht den Fix: verschwindet der Kommentar,
 * verschwindet auch das Wissen, warum die Zahl so steht.
 */
test('der offene Nicht-Text-Kontrast bleibt an den Tokens dokumentiert', () => {
  const tokens = read('../public/styles/tokens.css');
  const block = tokens.slice(0, tokens.indexOf('--color-border:'));
  assert.match(block, /WCAG 1\.4\.11/, 'der Befund muss an --color-border dokumentiert bleiben');
  assert.match(block, /1\.13:1/, 'der gemessene Ist-Wert gehört dazu');
  assert.match(block, /#8A8A86/, 'der Zielwert für 3:1 gehört dazu, sonst muss ihn jeder neu ausrechnen');
  assert.match(block, /nicht für dekorative Gruppierung/,
    'die Abgrenzung Bedienelement gegen Kartenkante gehört dazu - der Critique warf beides zusammen');
});

/**
 * Feinschliff: benannte Transitions, eine Abbrechen-Optik, dokumentierte
 * Nicht-Entscheidungen.
 */
test('die Küche animiert benannte Properties und sagt Abbrechen überall gleich', () => {
  // `transition: all` zieht implizit Layout-Properties mit. Im Modul wurden sonst
  // 0 animierte Layout-Properties gemessen - drei Stellen in shopping.css waren die
  // einzige Lücke in dieser Zusage (Critique 2026-07-30).
  // filter-chip.css und sub-tabs.css gehören dazu: die Küche nutzt beide (Vorrats-
  // Filter, Tab-Leiste), und `transition: all` auf .filter-chip war der Rest, den
  // die auf die vier Modul-CSS beschränkte Prüfung nicht sah.
  for (const file of ['shopping.css', 'meals.css', 'recipes.css', 'pantry.css', 'kitchen-row.css', 'kitchen-tabs.css', 'filter-chip.css', 'sub-tabs.css']) {
    const css = read(`../public/styles/${file}`);
    assert.doesNotMatch(css, /transition:\s*all\b/,
      `${file}: transition: all animiert implizit auch Layout-Properties`);
  }

  // EINE Abbrechen-Optik. Sie war `btn--secondary` in den Seiten-Modalen und
  // `btn--ghost` in den drei geteilten Helfern - also genau im Löschen-Confirm,
  // wo sie am wichtigsten ist, am unauffälligsten.
  const modal = read('../public/components/modal.js');
  for (const which of ['prompt', 'select', 'confirm']) {
    assert.match(modal, new RegExp(`class="btn btn--secondary" id="${which}-modal-cancel"`),
      `${which}Modal: Abbrechen muss dieselbe Optik tragen wie in den Seiten-Modalen`);
  }
  assert.doesNotMatch(modal, /btn--ghost" id="\w+-modal-cancel"/,
    'kein Abbrechen darf als Ghost zurückkommen');

  // Zwei geprüfte Nicht-Änderungen. Ohne die Begründung im Code wird beides beim
  // nächsten Lauf erneut als Befund gemeldet und erneut untersucht.
  assert.match(read('../public/styles/filter-chip.css'), /WARUM DIE LANGEN LISTEN KEINEN Y-FADE BEKOMMEN/,
    'die Entscheidung gegen den vertikalen Fade gehört an die geteilte Konvention');
  assert.match(read('../public/styles/tokens.css'), /Semantik-Kollision|GEPRÜFT UND BEWUSST SO GELASSEN/,
    'die Farbgleichheit der Mahlzeit-Punkte mit warning/accent gehört an die Tokens');
  assert.match(read('../public/styles/meals.css'), /1920px\s+Content-Spalte gedeckelt auf 1280 → passt/,
    'die Wochenboard-Rechnung gehört ins CSS: „auf keiner Desktop-Breite" stimmt nicht, es fehlen 52px bei 1440');
});

/**
 * Der geteilte Zeilenname überlebt auch einen FLEX-Elternteil.
 *
 * Die schwerste Regression des Umbaus (Critique 2026-07-30, P0), gemessen bei 320px:
 * `.kitchen-row__name` = **8px breit, 432px hoch**. „Chicken Tikka Masala" stand ein
 * Zeichen pro Zeile, eine Zeile war 448px hoch, auf den Bildschirm passte EIN
 * Rezept.
 *
 * Die Ursache ist die Kombination zweier für sich richtiger Entscheidungen:
 *   - `overflow-wrap: anywhere` am Namen (rettete den Artikelnamen im Einkauf, der
 *     bei 320px auf vier lesbare Zeichen ellipsiert war)
 *   - `.recipe-row__toggle { display: flex }` in den Rezepten
 * Als Flex-Item löst `flex-basis: auto` auf min-content auf, und mit
 * `overflow-wrap: anywhere` ist min-content die Breite des breitesten
 * EINZELZEICHENS. Drei von vier Aufrufstellen hatten einen Grid-Elternteil und
 * blieben unauffällig.
 *
 * Danach: Namensbreite 182px bei 320px, Zeilenhöhe 69px, Desktop unverändert.
 */
test('der Zeilenname bricht in Wörtern, nicht in Zeichen', () => {
  const shared = read('../public/styles/kitchen-row.css');
  const recipes = read('../public/styles/recipes.css');
  const recipesJs = read('../public/pages/recipes.js');

  const nameBlock = shared.match(/\.kitchen-row__name\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(nameBlock, /overflow-wrap:\s*anywhere/,
    'der Name muss umbrechen dürfen - die Ellipse war der P0 des vorigen Laufs');
  assert.match(nameBlock, /flex:\s*1 1 auto/,
    'ohne flex-basis fällt der Name in einem Flex-Elternteil auf min-content, also auf ein Zeichen');

  // Die Rezeptzeile hatte drei Zeilenaktionen: 3 × 48 + 2 × 8 = 152px von 262px
  // Zeilenbreite bei 320px. Sie wandern unter 30rem ins geteilte Überlaufmenü.
  assert.match(recipesJs, /import \{ popoverMenuHtml, installPopoverMenus \} from '\/utils\/popover-menu\.js'/,
    'die Zeile muss das geteilte Überlaufmenü nutzen, keine vierte Eigenkonstruktion');
  assert.match(recipesJs, /id: `recipe-menu-\$\{recipe\.id\}`/, 'jede Zeile braucht eine eigene Menü-ID');
  assert.match(recipesJs, /installPopoverMenus\(page\)/, 'das Menü muss an der stabilen Seitenwurzel verdrahtet sein');

  assert.match(recipes, /@container kitchen-rows \(max-width: 30rem\)/,
    'die Umschaltung hängt an der ZEILENbreite, wie beim Vorrats-Stepper');
  // Die Quellreihenfolge entscheidet: `@container` erhöht die Spezifität nicht.
  const inlineBase = recipes.indexOf('.recipe-row__inline-actions {');
  const query = recipes.indexOf('@container kitchen-rows');
  assert.ok(inlineBase !== -1 && inlineBase < query,
    'der Basiszustand muss VOR der Container-Query stehen, sonst gewinnt er gegen sie');
  const compact = recipes.slice(query);
  assert.match(compact, /\.recipe-row__inline-actions\s*\{\s*display:\s*none/,
    'die drei Inline-Aktionen müssen in der schmalen Zeile weichen');
  assert.match(compact, /\.recipe-row__toggle \.kitchen-row__meta\s*\{[\s\S]*?flex:\s*1 0 100%/,
    'die Zutatenzahl muss unter den Namen rücken - sie ist flex-shrink: 0 und nähme ihm sonst 70px');
});

test('phase 3 high-frequency controls use tokenized touch targets', () => {
  const tasks = read('../public/styles/tasks.css');
  const shopping = read('../public/styles/shopping.css');
  const notes = read('../public/styles/notes.css');
  const layout = read('../public/styles/layout.css');

  assert.match(tasks, /\.task-status-btn::before[\s\S]*var\(--target-base\)/);
  assert.match(tasks, /\.task-bulk-checkbox[\s\S]*(?:min-width|width):\s*var\(--target-base\)/);
  assert.match(tasks, /\.task-card__inline-action[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(tasks, /\.task-card__inline-action[\s\S]*height:\s*var\(--target-base\)/);
  assert.match(tasks, /\.bulk-actions-bar__actions \.btn[\s\S]*min-height:\s*var\(--target-base\)/);
  assert.match(shopping, /\.item-check[\s\S]*(?:min-width|width):\s*var\(--target-base\)/);
  // Die Zeilenhöhe liegt seit der geteilten Zeilen-Grammatik in
  // kitchen-row.css und ist dort mit --target-lg (48px) strenger als die alte
  // --target-base-Untergrenze (44px) auf .shopping-item. Ein Tab-lokales
  // min-height gibt es nicht mehr - es wäre genau die Divergenz, die der Guard
  // „die Küchen-Listen teilen eine Zeilen-Grammatik" verbietet.
  assert.match(read('../public/styles/kitchen-row.css'),
    /\.kitchen-row\s*\{[\s\S]*?min-height:\s*var\(--target-lg\)/);
  // Die beiden Zeilenaktionen der Einkaufsliste trugen bis zum Audit
  // 2026-07-29 eigene .item-details/.item-delete-Regeln mit --target-base.
  // Sie nutzen jetzt die geteilte .row-action-Komponente aus layout.css, die
  // mit --target-lg (48px) über der alten Größe liegt - die Invariante
  // („tokenisierte Trefferfläche, nicht kleiner als --target-base") gilt
  // dadurch strenger, aber an einer anderen Stelle. Deshalb hier auf die
  // Komponente geprüft statt auf die entfallenen Modul-Klassen.
  const shoppingPage = read('../public/pages/shopping.js');
  assert.match(shoppingPage, /class="row-action"\s+data-action="item-details"/);
  assert.match(shoppingPage, /class="row-action row-action--danger"\s+data-action="delete-item"/);
  assert.match(layout, /\.row-action\s*\{[\s\S]*?width:\s*var\(--target-lg\)/);
  assert.match(layout, /\.row-action\s*\{[\s\S]*?height:\s*var\(--target-lg\)/);
  assert.match(notes, /\.note-card__pin[\s\S]*width:\s*var\(--target-base\)/);
  assert.match(notes, /\.note-card__delete[\s\S]*width:\s*var\(--target-base\)/);
});

test('Tasks toolbar keeps secondary controls visible instead of an overflow slider', () => {
  const tasksPage = read('../public/pages/tasks.js');
  const tasksCss = read('../public/styles/tasks.css');

  // Das frühere <details>-Overflow-Panel versteckte Ansicht/Gruppierung hinter
  // einem Klick und zeigte deren Zustand nicht — dasselbe Muster wurde in
  // Dokumente (#506) verworfen. Aufgaben nutzt jetzt die geteilte Grammatik:
  // umbrechender Kopf plus sichtbare Filterzeile.
  assert.doesNotMatch(tasksPage, /<details class="tasks-toolbar__secondary"/);
  assert.doesNotMatch(tasksCss, /tasks-toolbar__secondary/);
  assert.match(tasksPage, /class="page-toolbar page-toolbar--wrap tasks-toolbar"/);

  // Ansichtswechsel bleibt im Kopf, Gruppierung wandert in die Filterzeile.
  assert.match(tasksPage, /<div class="page-toolbar__actions">[\s\S]*id="view-toggle"[\s\S]*id="btn-bulk-select"/);
  assert.match(tasksPage, /<div class="tasks-filters-row">[\s\S]*id="filter-bar"[\s\S]*id="group-mode-toggle"/);
  assert.match(tasksCss, /\.tasks-filters-row\s*\{[\s\S]*display:\s*flex/);

  // [hidden] muss gegen display:flex/inline-flex gewinnen, sonst bleiben die in
  // der Kanban-Ansicht ausgeblendeten Controls sichtbar.
  assert.match(tasksCss, /\.tasks-filters-row \[hidden\]\s*\{[\s\S]*display:\s*none/);
});

test('Tasks and Notes expose every click target as a real control', () => {
  const tasksPage = read('../public/pages/tasks.js');
  const notesPage = read('../public/pages/notes.js');

  // Filter-Chips waren <span> ohne Tastaturzugang, während Dokumente und
  // Kontakte dieselbe .filter-chip-Klasse als <button aria-pressed> rendern.
  assert.match(tasksPage, /function makeChip\(/);
  assert.match(tasksPage, /chip\s*=\s*document\.createElement\('button'\)/);
  assert.doesNotMatch(tasksPage, /className\s*=\s*'filter-chip[^']*';?[\s\S]{0,80}createElement\('span'\)/);

  // Titel öffnet die Aufgabe, Fortschrittsbalken klappt die Unteraufgaben auf,
  // Kanban-Titel öffnet die Karte — alle drei waren Divs.
  assert.match(tasksPage, /<button type="button" class="task-card__title/);
  assert.match(tasksPage, /<button type="button" class="subtask-progress"[\s\S]*aria-expanded=/);
  assert.match(tasksPage, /<button type="button" class="kanban-card__title/);

  // Notizkarte: der einzige Tastaturweg in die Notiz.
  assert.match(notesPage, /class="note-card__open" data-action="open"/);

  // Umschalter melden ihren Zustand nicht nur über Farbe.
  assert.match(tasksPage, /data-view="list"[\s\S]*aria-pressed=/);
  assert.match(tasksPage, /data-mode="category" aria-pressed="true"/);
});

test('showToast is never called with an unsupported variant', () => {
  // showToast kennt nur default | success | warning | danger. 'error' landete
  // still im polite-Container ohne Fehlerkennzeichnung.
  const files = [
    '../public/router.js',
    '../public/pages/notes.js',
    '../public/pages/tasks.js',
    '../public/pages/budget.js',
    '../public/pages/calendar.js',
    '../public/pages/contacts.js',
    '../public/pages/dashboard.js',
    '../public/pages/meals.js',
    '../public/pages/recipes.js',
    '../public/pages/budget-plans.js',
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /showToast\([^;]*?,\s*'error'\)/s, `${file} uses showToast(..., 'error')`);
  }
});

test('responsive adaptation keeps Notes vertical and prevents intrinsic-width overflow', () => {
  const notes = read('../public/styles/notes.css');
  const dashboard = read('../public/styles/dashboard.css');
  const pageSearch = read('../public/styles/page-search.css');

  // The shared search control guards its own intrinsic-width overflow.
  assert.match(pageSearch, /\.page-search\s*\{[\s\S]*min-width:\s*0/);
  assert.match(notes, /\.notes-toolbar\s+\.page-toolbar__title\s*\{[\s\S]*flex:\s*0\s+0\s+auto/);
  assert.match(notes, /\.notes-grid\s*\{[\s\S]*display:\s*grid/);
  assert.match(notes, /\.notes-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(notes, /\.notes-grid\s*\{[\s\S]*?columns:\s*2/);
  assert.match(
    notes,
    /@container notes-page \(min-width:\s*520px\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    notes,
    /@container notes-page \(min-width:\s*720px\)[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    dashboard,
    /\.notes-grid-widget\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(notes, /\.note-card\s*\{[\s\S]*min-width:\s*0/);
  assert.match(notes, /\.note-card__title\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(
    notes,
    /\.note-card__title,[\s\S]*\.note-card__content\s*\{[\s\S]*unicode-bidi:\s*plaintext/
  );
});

test('dashboard weather widget adapts to selected widget size', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const wrapperRule = cssRuleBody(dashboard, '.widget-wrapper');

  assert.match(wrapperRule, /container:\s*dashboard-widget\s*\/\s*inline-size/);
  assert.match(
    dashboard,
    /@container dashboard-widget \(min-width:\s*480px\)[\s\S]*\.weather-widget__inner\s*\{[\s\S]*flex-direction:\s*row/,
    'weather should switch to horizontal layout from its widget width, not viewport width',
  );
  assert.match(
    dashboard,
    /\.widget-size--1x1\s*>\s*\.weather-widget \.weather-widget__meta,[\s\S]*\.widget-size--1x1\s*>\s*\.weather-widget \.weather-forecast\s*\{[\s\S]*display:\s*none/,
    'tiny weather widgets should not force rich forecast content into the tile',
  );
  assert.match(
    dashboard,
    /\.widget-size--2x1\s*>\s*\.weather-widget \.weather-widget__meta,[\s\S]*\.widget-size--4x1\s*>\s*\.weather-widget \.weather-widget__meta\s*\{[\s\S]*display:\s*none/,
    'one-row weather widgets should use a denser summary',
  );
  assert.doesNotMatch(
    dashboard,
    /@media \(min-width:\s*(?:768|1024|1440)px\)\s*\{\s*\.weather-widget\s*\{/,
    'weather layout must not be driven by viewport breakpoints',
  );
  assert.doesNotMatch(dashboard, /\.weather-widget\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('responsive adaptation keeps all four Kitchen tabs readable on narrow phones', () => {
  const kitchenTabs = read('../public/styles/kitchen-tabs.css');

  // Platz für die Labels kommt seit dem vierten Tab (Vorrat) daher, dass der
  // Modultitel mobil entfällt - die Bottom-Nav trägt dasselbe Wort bereits.
  // Vorher fraß er ~70px, wodurch alle drei inaktiven Labels ellipsierten.
  // Ersetzt das frühere padding-inline: var(--space-2), das den Platz nur
  // umverteilt statt geschaffen hat; die Leiste erbt jetzt --page-inline-pad
  // aus .sub-tabs-bar und fluchtet damit mit dem Body-Inhalt.
  assert.match(
    kitchenTabs,
    /@media \(max-width:\s*640px\)[\s\S]*\.kitchen-tabs-bar \.sub-tabs-bar__title\s*\{[\s\S]*display:\s*none/
  );
  assert.doesNotMatch(
    kitchenTabs,
    /@media \(max-width:\s*640px\)[\s\S]*\.kitchen-tabs-bar\s*\{[^}]*padding-inline/,
    'kitchen-tabs-bar darf --page-inline-pad aus .sub-tabs-bar nicht überschreiben',
  );
  // Die Labels werden NICHT gekürzt - die Leiste scrollt lieber.
  //
  // Hier stand `flex: 1 1 0` + `min-width: 0` + `text-overflow: ellipsis`: alle vier
  // Tabs gleich breit, wer nicht passt wird gekürzt. Das ging auf, solange die Tabs
  // nur Labels trugen. Mit den Zustandszahlen der Küchen-Leiste kostet jeder Badge
  // 20-22px aus derselben Zelle, und gemessen war „Mahlzeiten" bei 393px wieder
  // gekürzt (61 von 72px), bei 320px drei von vier Labels.
  //
  // Ohne Gleichverteilung: 72+55+66+41 Label + 42 Badge + Polster = 344px. Bei 393px
  // passt das mit 49px Luft, bei 320px scrollt die Leiste (Überlauf 58px, gemessen)
  // mit has-fade-Maske und scrollActiveSubTabIntoView().
  //
  // Der Test prüft jetzt die INVARIANTE („kein Label wird gekürzt") statt des
  // Mechanismus, mit dem sie damals erreicht wurde.
  assert.match(
    kitchenTabs,
    /\.kitchen-tabs-bar \.sub-tab\s*\{[^}]*flex:\s*0 0 auto/,
    'die Tabs behalten ihre natürliche Breite - Gleichverteilung kürzt Labels, sobald ein Badge dazukommt',
  );
  assert.doesNotMatch(
    kitchenTabs,
    /\.kitchen-tabs-bar \.sub-tab__label\s*\{[^}]*text-overflow:\s*ellipsis/,
    'ein gekürztes „Mahlz…" kostet mehr Orientierung als ein Tab, für den man wischen muss',
  );
  // Die Leiste muss scrollen KÖNNEN, sonst wird aus „nicht kürzen" ein Überlauf.
  const subTabs = read('../public/styles/sub-tabs.css');
  assert.match(subTabs, /\.sub-tabs-bar\s*\{[^}]*overflow-x:\s*auto/,
    'ohne overflow-x: auto läuft die Leiste bei natürlicher Breite über statt zu scrollen');
  assert.match(read('../public/utils/sub-tabs.js'), /export function scrollActiveSubTabIntoView/,
    'der aktive Tab muss nachträglich eingescrollt werden können: die Badges kommen asynchron und verbreitern die Leiste');
  assert.match(read('../public/utils/kitchen-tabs.js'), /scrollActiveSubTabIntoView\(_bar\)/,
    'nach dem Setzen der Badges muss der aktive Tab wieder ins Bild geholt werden');
});

test('responsive adaptation uses tablet space without crowding module toolbars', () => {
  const documents = read('../public/styles/documents.css');
  const settings = read('../public/styles/settings.css');

  // Der Dokument-Kopf lehnt sich am kanonischen page-toolbar--wrap-Muster an
  // (Titel + Suche + Aktionen brechen bei Bedarf um), die Filter leben in einer
  // eigenen Zeile darunter — kein in die Kopfzeile gequetschter Filter-Block (#506).
  const documentsPageSrc = read('../public/pages/documents.js');
  assert.match(documentsPageSrc, /class="page-toolbar page-toolbar--wrap documents-toolbar"/);
  assert.match(documentsPageSrc, /<div class="documents-filters">/);
  assert.match(
    documents,
    /\.documents-filter-chips\s*\{[^}]*overflow-x:\s*auto/
  );
  assert.match(
    settings,
    /@media \(min-width:\s*768px\) and \(max-width:\s*1023px\)[\s\S]*\.settings-mobile-overview__links\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
});

test('Birthday page exposes a single creation action (FAB), no duplicate toolbar button', () => {
  const birthdays = read('../public/pages/birthdays.js');

  assert.match(birthdays, /class="page-fab" id="fab-new-birthday"/);
  assert.doesNotMatch(birthdays, /toolbar-new-btn/);
});

test('dashboard polish keeps one page heading and native quick-action controls', () => {
  const dashboard = read('../public/pages/dashboard.js');
  const css = read('../public/styles/dashboard.css');

  assert.equal((dashboard.match(/<h1\b/g) || []).length, 1, 'dashboard must expose one h1');
  assert.match(dashboard, /<h2 class="dashboard-overview__title(?: dashboard-overview__title--\$\{greetingPeriod\(\)\})?"/);
  assert.match(dashboard, /<button type="button" class="fab-action"/);
  assert.doesNotMatch(dashboard, /class="fab-action"[^>]*role="button"/);
  assert.doesNotMatch(dashboard, /<button class="fab-action__btn"/);
  assert.match(css, /\.dashboard-icon-btn\s*\{[\s\S]*width:\s*var\(--target-lg\);[\s\S]*height:\s*var\(--target-lg\)/);
  // width/height müssen INNERHALB derselben .dashboard-icon-btn-Regel liegen
  // ([^{}] überschreitet keine Regelgrenze) — sonst matcht die Regex fälschlich
  // ein --target-base aus einer beliebigen späteren Regel (z.B. dem
  // pointer:coarse-Block der Edit-Controls) quer über die Datei.
  assert.doesNotMatch(
    css,
    /@media \(max-width:\s*640px\)[\s\S]*?\.dashboard-icon-btn\s*\{[^{}]*width:\s*var\(--target-base\)[^{}]*height:\s*var\(--target-base\)/,
    'mobile dashboard controls must keep the large touch target through the final cascade'
  );
  assert.match(
    css,
    /@media \(min-width:\s*1024px\)[\s\S]*\.dashboard-icon-btn\s*\{[\s\S]*width:\s*var\(--target-md\);[\s\S]*height:\s*var\(--target-md\)/,
  );
});

test('dashboard today cockpit keeps content visibly below its section heading', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const typography = read('../public/styles/typography.css');
  const valueRule = cssRuleBody(dashboard, '.today-cockpit-card__value');

  assert.match(
    typography,
    /\.today-cockpit__header h2,[\s\S]*?font-size:\s*var\(--type-section-title\)/,
    'Heute wichtig must keep the section-title role',
  );
  // Der Value trägt die Card-Title-Rolle (16px): dominant genug, um den
  // Icon-Chip zu überwiegen (das glanzbare Datum der Karte), aber weiterhin
  // unter der 18px-Section-Heading „Heute wichtig".
  assert.match(
    valueRule,
    /font-size:\s*var\(--type-card-title\)/,
    'cockpit value must carry the 16px card-title role, still below the 18px section heading',
  );
});

test('polished rounded cards use subtle full borders instead of thick accent caps', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const housekeeping = read('../public/styles/housekeeping.css');

  const overview = dashboard.match(/\.dashboard-overview\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const cockpit = dashboard.match(/\.today-cockpit\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const widget = dashboard.match(/\.dashboard \.widget::before\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const housekeepingCard = housekeeping.match(/\.housekeeping-card\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.doesNotMatch(overview, /border-top:\s*(?:3px|var\(--space-1\))/);
  assert.doesNotMatch(cockpit, /border-top:\s*(?:3px|var\(--space-1\))/);
  assert.match(widget, /height:\s*1px/);
  assert.doesNotMatch(housekeepingCard, /border-top:\s*3px/);
});

test('hardening keeps Birthday cards bounded with extreme localized content', () => {
  const birthdays = read('../public/styles/birthdays.css');

  assert.match(birthdays, /\.birthday-item__body\s*\{[\s\S]*min-width:\s*0/);
  assert.match(birthdays, /\.birthday-item__name\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(birthdays, /\.birthday-item__name\s*\{[\s\S]*unicode-bidi:\s*plaintext/);
  assert.match(birthdays, /\.birthday-item__notes\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(birthdays, /\.birthday-item__notes\s*\{[\s\S]*unicode-bidi:\s*plaintext/);
  assert.match(
    birthdays,
    /@media \(max-width:\s*640px\)[\s\S]*\.birthday-item__row\s*\{[\s\S]*flex-wrap:\s*wrap/
  );
});

test('hardening uses logical alignment for RTL-sensitive adapted controls', () => {
  const notes = read('../public/styles/notes.css');
  const tasks = read('../public/styles/tasks.css');
  const pageSearch = read('../public/styles/page-search.css');

  assert.match(notes, /margin-inline-start:\s*auto/);
  // The shared search control's leading icon uses logical inset for RTL.
  assert.match(pageSearch, /\.page-search__icon\s*\{[\s\S]*inset-inline-start:/);
  assert.match(notes, /\.note-card__pin\s*\{[\s\S]*inset-inline-end:/);
  // Das absolut positionierte Overflow-Panel (mit eigenen RTL-Insets) ist
  // entfallen; die Filterzeile richtet ihre Gruppierungswahl jetzt über eine
  // logische Property aus und braucht deshalb keine [dir=rtl]-Sonderregel.
  assert.match(tasks, /\.tasks-filters__end\s*\{[\s\S]*margin-inline-start:\s*auto/);
  assert.doesNotMatch(tasks, /margin-(left|right):\s*auto/);
});

test('route failures expose a localized recoverable alert instead of raw technical errors', () => {
  const router = read('../public/router.js');
  const notesPage = read('../public/pages/notes.js');

  assert.match(router, /function renderError\(container,\s*err\)[\s\S]*state\.setAttribute\(['"]role['"],\s*['"]alert['"]\)/);
  assert.match(router, /desc\.textContent\s*=\s*friendlyError\(err\)/);
  assert.match(router, /state\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(router, /Failed to fetch\|NetworkError\|Load failed/i);
  assert.match(router, /return t\(['"]common\.errorServer['"]\)/);
  assert.match(router, /err\?\.name === ['"]TypeError['"][\s\S]*return t\(['"]common\.unexpectedError['"]\)/);
  assert.match(notesPage, /catch \(err\)\s*\{[\s\S]*console\.error\([\s\S]*throw err;/);
});

test('Notes uses the shared WCAG contrast helper without dimming readable content', () => {
  const notesPage = read('../public/pages/notes.js');
  const notesCss = read('../public/styles/notes.css');

  assert.match(notesPage, /import \{ getReadableTextColor \} from '\/utils\/color\.js'/);
  assert.doesNotMatch(notesPage, /function isLightColor/);
  assert.match(notesPage, /getReadableTextColor\(note\.color\)/);
  assert.match(notesPage, /const avatarColor\s*=\s*note\.creator_color[\s\S]*getReadableTextColor\(avatarColor\)/);
  assert.doesNotMatch(
    notesCss.match(/\.note-card__content\s*\{[\s\S]*?\n\}/)?.[0] ?? '',
    /opacity:/,
  );
  assert.match(
    notesCss.match(/\.note-card__footer\s*\{[\s\S]*?\n\}/)?.[0] ?? '',
    /color:\s*inherit/,
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
  // Zeilen-Aktionen nutzen jetzt die geteilte .row-action-Grammatik in
  // layout.css (Audit F1) statt pro Modul eigener Klassen (früher
  // .contact-action-btn/.birthday-action-btn/.budget-entry__action).
  const layout = read('../public/styles/layout.css');
  const targetRules = [
    ['../public/styles/tasks.css', tasks, '.task-status-btn'],
    ['../public/styles/shopping.css', shopping, '.quick-add__btn'],
    ['../public/styles/shopping.css', shopping, '.item-check'],
    ['../public/styles/notes.css', notes, '.note-card__pin'],
    ['../public/styles/notes.css', notes, '.note-card__delete'],
    ['../public/styles/layout.css', layout, '.row-action'],
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
    assertRuleUsesToken(layout, '.row-action', property, '--target-lg', '../public/styles/layout.css');
  }

  assertRuleUsesToken(layout, '.row-action', 'min-height', '--target-lg', '../public/styles/layout.css');
  assertRuleUsesToken(layout, '.row-action', 'min-width', '--target-lg', '../public/styles/layout.css');
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

  // The grouped main-app navigation references every section label key and
  // resolves section labels through t().
  assert.match(routerSource, /'nav\.sectionOverview'/);
  assert.match(routerSource, /'nav\.sectionPlan'/);
  assert.match(routerSource, /'nav\.sectionHousehold'/);
  assert.match(routerSource, /'nav\.sectionPeople'/);
  assert.match(routerSource, /'nav\.sectionFinance'/);
  assert.match(routerSource, /'nav\.sectionCustomModules'/);
  assert.match(routerSource, /t\(labelKey\)/);

  // The replaced household section label is no longer referenced.
  assert.doesNotMatch(routerSource, /nav\.section\.household/);
});

test('global navigation derives exactly one Kitchen destination', () => {
  const routerSource = read('../public/router.js');

  // Kitchen is inserted once via sidebarKitchenEl(), gated by a single-shot flag.
  // It is appended into the current section group via appendNavEl().
  assert.equal((routerSource.match(/appendNavEl\(sidebarKitchenEl\(\)\)/g) ?? []).length, 1);
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
  assert.match(routerSource, /replaceNavIcon\(moreBtn,\s*'\.nav-item__icon',\s*'more-horizontal'\)/);
  assert.doesNotMatch(routerSource, /const\s+moreIcon\s*=\s*activeSecondary\s*\?\s*activeSecondary\.icon/);
  assert.doesNotMatch(routerSource, /moreBtnLabel\.textContent\s*=\s*moreLabel/);

  // More nutzt den eindeutigen Overflow-Glyph, nicht das mehrdeutige 3×3-Raster.
  const navIcons = read('../public/nav-icons.js');
  assert.match(navIcons, /'more-horizontal':\s*\(\)\s*=>/);
  assert.match(routerSource, /const iconFactory = NAV_ICONS\['more-horizontal'\]/);
  assert.doesNotMatch(routerSource, /grid-2x2/);
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
  assert.ok(lineCount <= 170, `settings controller should be a thin shell (was ${lineCount} lines)`);
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

  assert.match(account, /yuvomi:settings:notice/, 'account leaf must read the one-time redirect notice');
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

test('calendar month view uses tinted event surfaces derived from --ev-color', () => {
  const calendar = read('../public/styles/calendar.css');
  const gridBody = cssRuleBody(calendar, '.month-grid');
  const dayBody = cssRuleBody(calendar, '.month-day');
  const eventBody = cssRuleBody(calendar, '.month-day__event');

  assert.match(gridBody, /background-color:\s*var\(--color-border-subtle\)/, 'month grid should expose clear cell boundaries');
  assert.match(gridBody, /gap:\s*var\(--space-px\)/, 'month grid boundaries should use tokenized one-pixel gaps');
  assert.match(dayBody, /background-color:\s*var\(--color-surface-work\)/, 'month cells should use a stable work surface');
  // Getönte „Ton"-Fläche statt vollgesättigter Füllung: Tönung, lesbare Tinte und
  // Kante werden per color-mix aus --ev-color abgeleitet — theme-korrekt, weil
  // --color-surface-work und --color-text-primary im Dark Mode kippen.
  assert.match(eventBody, /background:\s*color-mix\(in srgb,\s*var\(--ev-color\)\s*\d+%,\s*var\(--color-surface-work\)\)/, 'event chips should sit on a tinted work surface, not a saturated fill');
  assert.match(eventBody, /color:\s*color-mix\(in srgb,\s*var\(--ev-color\)\s*\d+%,\s*var\(--color-text-primary\)\)/, 'event chip text should be a readable ink derived from the event colour');
  assert.match(eventBody, /border:\s*var\(--space-px\)\s+solid\s+color-mix\(in srgb,\s*var\(--ev-color\)/, 'event chips need a visible boundary derived from --ev-color, not color alone');
  assert.doesNotMatch(eventBody, /box-shadow/, 'tinted event chips should read flat, without a drop shadow');
});

test('calendar agenda events and task chips keep readable contrast in mobile agenda', () => {
  const calendar = read('../public/styles/calendar.css');
  const eventBody = cssRuleBody(calendar, '.agenda-event');
  const colorBody = cssRuleBody(calendar, '.agenda-event__color');
  const taskBody = cssRuleBody(calendar, '.cal-task-chip');
  const metaBody = cssRuleBody(calendar, '.agenda-event__meta');

  assert.match(eventBody, /background:\s*var\(--color-surface-work\)/, 'agenda rows need a solid surface for mobile contrast');
  assert.match(eventBody, /border:\s*var\(--space-px\)\s+solid\s+var\(--color-border-subtle\)/, 'agenda rows need a boundary in both themes');
  // Kalenderfarbe ist ein zentrierter Dot (kein vollhoher Seitenstreifen) —
  // tokenisiert und sichtbar, konsistent mit den Status-Dots der Aufgabenliste.
  assert.match(colorBody, /width:\s*var\(--space-2\)/, 'agenda color dot should use a spacing token for its width');
  assert.match(colorBody, /height:\s*var\(--space-2\)/, 'agenda color dot should be a fixed-size dot, not a full-height rail');
  assert.match(colorBody, /border-radius:\s*var\(--radius-full\)/, 'agenda color dot should be round');
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

test('desktop Meals and Calendar date-navigation icons use the accent color', () => {
  const meals = read('../public/styles/meals.css');
  const calendar = read('../public/styles/calendar.css');

  // Meals folgt der Module-Accent-Leads-Rule (DESIGN.md §2, 2026-07): innerhalb
  // eines Moduls führt der Modul-Akzent, globales Violett bleibt der Shell
  // vorbehalten. Die Wochennavigation ist Modul-Bedienung, keine Shell-Chrome -
  // vorher stand die violette „Heute"-Pille direkt neben dem orangen
  // Zufallsplan-Button und beide lasen sich wie Controls aus zwei Apps.
  // Calendar zieht bewusst noch nicht mit: eigenes Modul, eigener Durchgang.
  assert.match(cssRuleBody(meals, '.week-nav .btn--icon'), /color:\s*var\(--module-accent\)/);
  assert.match(cssRuleBody(calendar, '.cal-toolbar__nav .btn--icon'), /color:\s*var\(--color-accent\)/);
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
  const layout = read('../public/styles/layout.css');
  // Zeilen-Aktionen (Löschen UND Bearbeiten) teilen die geteilte .row-action-
  // Grammatik (layout.css, Audit F1): 48px-Touch-Fläche, immer sichtbar (kein
  // Hover-Reveal → auch auf Touch nutzbar), Löschen trägt row-action--danger.
  const actionRule = cssRuleBody(layout, '.row-action');

  assert.match(actionRule, /width:\s*var\(--target-lg\)/, 'Row action buttons should use the large touch target width');
  assert.match(actionRule, /height:\s*var\(--target-lg\)/, 'Row action buttons should use the large touch target height');
  assert.doesNotMatch(actionRule, /opacity:\s*0/, 'Row actions stay visible without hover (touch-safe)');
  assert.match(source, /class="row-action row-action--danger"/, 'Budget delete uses the shared danger row action');
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
  const sectionKeys = ['sectionOverview', 'sectionPlan', 'sectionHousehold', 'sectionPeople', 'sectionFinance', 'sectionCustomModules'];

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

test('Brazilian Portuguese uses localized Help navigation copy', () => {
  const data = JSON.parse(read('../public/locales/pt.json'));

  assert.equal(data.nav?.help, 'Ajuda');
  assert.equal(data.help?.title, 'Ajuda');
  assert.doesNotMatch(JSON.stringify({ nav: data.nav, help: data.help }), /Hilfe/);
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

test('phase 2 mobile dashboard cockpit uses a 2x2 glance grid with tokenized stable sizing', () => {
  const dashboard = read('../public/styles/dashboard.css');

  assert.match(
    dashboard,
    /@media \(max-width:\s*640px\)[\s\S]*\.today-cockpit-card\s*\{[\s\S]*min-height:\s*calc\(var\(--target-lg\)\s*\+\s*var\(--space-4\)\)/,
    'mobile cockpit cards should keep stable tokenized min-height'
  );
  // 2×2-Glance-Raster: zwei Spalten auf Mobil, halbe Höhe ggü. 1×4
  assert.match(
    dashboard,
    /@media \(max-width:\s*640px\)[\s\S]*\.today-cockpit__grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    'mobile cockpit should use a two-column glance grid'
  );
  // Karten erzwingen keine Vollbreite mehr — sonst entsteht wieder ein 1×4-Stapel
  assert.doesNotMatch(
    dashboard,
    /\.today-cockpit-card--task,\s*\n\s*\.today-cockpit-card--event\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/,
    'task/event cards must not force full-width on mobile (breaks the 2×2 grid)'
  );
  // Sehr schmale Container fallen auf eine Spalte zurück (Container-Query, kein Viewport-BP)
  assert.match(
    dashboard,
    /@container today-cockpit \(max-width:\s*270px\)[\s\S]*grid-template-columns:\s*1fr/,
    'very narrow cockpit container should fall back to a single column'
  );
});

test('phase 2 dashboard FAB uses tokenized position and reserved mobile scroll room', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const fabRule = cssRuleBody(dashboard, '.fab-container');

  assert.match(fabRule, /bottom:\s*calc\(var\(--nav-bottom-height\)\s*\+\s*var\(--space-6\)\)/);
  assert.doesNotMatch(fabRule, /\b24px\b/, 'FAB position should use spacing tokens');
  // Die Scroll-Reserve traegt .dashboard selbst (FAB-Clearance); eine zweite
  // Reserve auf .dashboard-shell stapelte sich zu ~200px totem Raum (Audit A1-16).
  assert.match(
    dashboard,
    /\.dashboard\s*\{[\s\S]*?padding-bottom:\s*calc\(52px \+ var\(--space-6\) \* 2 \+ var\(--space-4\)\)/,
    'mobile dashboard should reserve scroll room for the fixed FAB'
  );
  assert.doesNotMatch(
    dashboard,
    /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-shell\s*\{[^}]*padding-bottom/,
    'the mobile shell must not stack a second FAB clearance (Audit A1-16)'
  );
});

test('calendar draws its gutter from the shared page token and compacts weekday headers', () => {
  const calendar = read('../public/styles/calendar.css');

  // Bis #577 holte der Kalender seinen Seitenrand aus einem modul-eigenen
  // `padding: var(--space-6) var(--space-8)` plus `padding-inline: var(--space-10)`
  // ab 1440px. Das machte ihn mit 1200px zum schmalsten Modul und setzte den
  // sticky Kopf 24px vom oberen Rand ab, obwohl er top:0 klebt. Der Rand kommt
  // jetzt aus derselben Quelle wie überall.
  assert.match(
    calendar,
    /#cal-body\s*\{[^}]*padding-inline:\s*var\(--page-inline-pad\)/,
    'calendar body should take its gutter from the shared --page-inline-pad',
  );
  assert.doesNotMatch(
    calendar,
    /\.calendar-page\s*\{[^}]*padding(-inline)?:\s*var\(--space-/,
    'calendar must not reintroduce a module-specific page gutter (#577)',
  );
  assert.match(
    calendar,
    /@media \(min-width:\s*1024px\)[\s\S]*?\.week-view__day-header\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center/,
    'desktop weekday and date should sit side by side',
  );
  assert.match(
    calendar,
    /@media \(min-width:\s*1024px\)[\s\S]*?\.week-view__day-num\s*\{[\s\S]*?width:\s*var\(--target-sm\);[\s\S]*?height:\s*var\(--target-sm\)/,
    'desktop date markers should use the compact touch-size token',
  );
});

test('dashboard and calendar keep distinct navigation accents in light and dark themes', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);

  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  for (const [theme, block] of [['light', rootBlock[1]], ['dark', darkBlock[1]]]) {
    const values = parseTokenMap(block);
    assert.notEqual(
      values.get('--_module-dashboard')?.toLowerCase(),
      values.get('--_module-calendar')?.toLowerCase(),
      `${theme} dashboard and calendar accents must be visually distinct`,
    );
  }
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

function parseCssRgb(value) {
  const hex = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [...hexToRgb(value), 1];

  const rgba = String(value).trim().match(/^rgba?\(([^)]+)\)$/i);
  assert.ok(rgba, `expected a hex, rgb, or rgba color, got: ${value}`);
  const parts = rgba[1].split(',').map((part) => Number(part.trim()));
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function compositeColor(foreground, background) {
  const [fr, fg, fb, fa] = parseCssRgb(foreground);
  const [br, bg, bb] = parseCssRgb(background);
  const channels = [
    fr * fa + br * (1 - fa),
    fg * fa + bg * (1 - fa),
    fb * fa + bb * (1 - fa),
  ];
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
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

test('module accents stay readable as text on the page background in both themes', () => {
  // `.btn--secondary` faerbt seine Beschriftung mit --active-module-accent
  // (layout.css). Steht so ein Button auf dem Seitenhintergrund statt in einer
  // Karte, entscheidet allein die Modulfarbe ueber die Lesbarkeit - im Light-
  // Theme lagen sechs Farben darunter (Settings-Audit 2026-07-27: 4.13:1 bei
  // "Kanal hinzufuegen", 4.20:1 bei "Aus Kontakten importieren").
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock && darkBlock, 'expected :root and [data-theme="dark"] token blocks');

  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);

  const moduleTokens = [...light.keys()].filter((name) => /^--module-[\w-]+$/.test(name));
  assert.ok(moduleTokens.length >= 15, `expected the module palette, found ${moduleTokens.length}`);

  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    const background = resolveColor('--color-bg', map);
    for (const token of moduleTokens) {
      const accent = resolveColor(token, map);
      const ratio = contrastRatio(accent, background);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${token} (${accent}) on --color-bg (${background}) is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1`,
      );
    }
  }
});

// Fuellflaechen, die zur Laufzeit entstehen und daher in tokens.css GAR NICHT
// stehen. Sie einfach nachzuschlagen liefert undefined - und ein Guard, der
// undefined still ueberspringt, bewacht genau die Stellen nicht, um die es
// geht (drei von acht Mutationen blieben so gruen):
//
//   --active-module-accent  setzt der Router auf <html>, je nach offener Seite.
//   --module-accent         setzt jedes Modul-CSS scoped auf seiner Page-Root
//                           (`--module-accent: var(--module-birthdays)`).
//
// Die zweite laesst sich pro Datei exakt aufloesen, die erste nicht - dort ist
// jede Modulfarbe moeglich, also zaehlt der schlechteste Fall.
const RUNTIME_FILL_TOKENS = new Set(['--active-module-accent', '--module-accent']);

// Das lokale `--module-accent: var(--module-x)` einer Modul-CSS-Datei.
function localModuleAccent(src) {
  const m = src.match(/--module-accent\s*:\s*var\(\s*(--module-[\w-]+)\s*\)/);
  return m ? m[1] : null;
}

function themeTokenMaps() {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock && darkBlock, 'expected :root and [data-theme="dark"] token blocks');
  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);
  return { light, dark };
}

// Die Flaechen, die ein Fuell-Token in einem Theme annehmen kann. Fuer
// --active-module-accent sind das alle Modulfarben, sonst genau eine.
function fillColors(token, map, scopedAccent) {
  if (RUNTIME_FILL_TOKENS.has(token)) {
    const names = token === '--module-accent' && scopedAccent
      ? [scopedAccent]
      : [...map.keys()].filter((name) => /^--module-[\w-]+$/.test(name));
    return names.map((name) => ({ label: name, hex: resolveColor(name, map) }));
  }
  const hex = resolveColor(token, map);
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? [{ label: token, hex }] : [];
}

/**
 * Genau die Flaechen, um die es geht: die, die zwischen den Themes die
 * TEXTPOLARITAET wechseln - im Light gesaettigt-dunkel (weiss traegt), im Dark
 * pastellig-hell (weiss traegt nicht). Das ist das Muster der gesamten
 * Yuvomi-Akzentpalette und der Grund, warum eine statische Textfarbe dort
 * zwangslaeufig in einem der beiden Themes falsch liegt.
 *
 * Ruhige Flaechen (Surfaces, Rahmen) kippen nicht: sie sind in beiden Themes
 * auf derselben Seite. Sie gehoeren nicht unter diese Regel, sonst zieht der
 * Guard jeden gewoehnlichen Text-auf-Karte-Fall herein und misst etwas, das er
 * gar nicht meint.
 */
function flipsTextPolarity(lightHex, darkHex) {
  if (!lightHex || !darkHex) return false;
  return contrastRatio('#ffffff', lightHex) >= 4.5 && contrastRatio('#ffffff', darkHex) < 4.5;
}

/**
 * Die Regel, nicht die Fundstellen.
 *
 * `--color-text-on-accent` ist statisches Weiss und wird in KEINEM Dark-Block
 * redefiniert. Die vividen Fuellfarben kippen dagegen alle: im Light sind sie
 * gesaettigt-dunkel (weiss traegt), im Dark pastellig-hell (weiss traegt nicht).
 * Gemessen lagen alle 18 Modulakzente im Dark zwischen 1,44:1 (Notizen #FCD34D)
 * und 3,21:1 - der Datepicker faerbte den gewaehlten Tag so unlesbar ein.
 *
 * Der Guard listet keine Dateien auf, sondern RECHNET: jede Deklaration, die
 * eine Textfarbe auf eine Fuellflaeche setzt, muss in beiden Themes 4,5:1
 * halten. Damit faellt auch ein kuenftiges Token durch, das heute noch nicht
 * existiert. Eine Allowlist haette genau das nicht geleistet - sie deckt N
 * Dateien ab, nicht die Regel.
 */
test('Textfarbe auf vividen Fuellflaechen haelt WCAG AA in beiden Themes', () => {
  const { light, dark } = themeTokenMaps();
  const dir = new URL('../public/styles/', import.meta.url);
  const violations = [];

  for (const file of readdirSync(dir).filter((n) => n.endsWith('.css') && n !== 'tokens.css')) {
    const src = read(`../public/styles/${file}`);
    const scopedAccent = localModuleAccent(src);
    // Flache Deklarationsbloecke; @media-Verschachtelung faellt in den aeusseren
    // Selektor-Teil, der Block selbst bleibt korrekt.
    for (const [, selector, body] of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      // Nur eine PURE Token-Fuellung (ggf. mit var()-Fallback). color-mix und
      // Gradienten sind bewusst ausgenommen: dort entscheidet die Mischung,
      // nicht das Token (`.birthday-chip--today` mischt 72% mit Schwarz und
      // traegt weiss mit gemessenen 4,87:1).
      const fill = body.match(
        /(?:^|[\s;])background(?:-color)?\s*:\s*var\(\s*(--[\w-]+)\s*(?:,\s*var\(\s*(--[\w-]+)\s*\)\s*)?\)\s*(?:;|$)/,
      );
      const textColor = body.match(/(?:^|[\s;])color\s*:\s*var\(\s*(--[\w-]+)\s*\)\s*(?:;|$)/);
      if (!fill || !textColor) continue;

      const fillToken = fill[1];
      const lightFills = fillColors(fillToken, light, scopedAccent);
      const darkFills = new Map(
        fillColors(fillToken, dark, scopedAccent).map((f) => [f.label, f.hex]),
      );

      for (const surface of lightFills) {
        const darkHex = darkFills.get(surface.label);
        if (!flipsTextPolarity(surface.hex, darkHex)) continue;

        for (const [theme, map, surfaceHex] of [
          ['light', light, surface.hex],
          ['dark', dark, darkHex],
        ]) {
          const ink = resolveColor(textColor[1], map);
          if (!ink || !/^#[0-9a-f]{6}$/i.test(ink)) continue;
          const ratio = contrastRatio(ink, surfaceHex);
          if (ratio >= 4.5) continue;
          violations.push(
            `${file} {${selector.trim().split('\n').pop().trim()}}: ${theme} ` +
            `${textColor[1]} (${ink}) auf ${surface.label} (${surfaceHex}) = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }

  assert.deepEqual(violations, [],
    'Textfarbe auf vivider Fuellflaeche unter 4,5:1 - --color-ink-on-vivid kippt mit dem Theme, --color-text-on-accent nicht');
});

test('--color-ink-on-vivid traegt auf jedem Modulakzent, --color-text-on-accent nicht', () => {
  // Die Gegenprobe zum Guard darueber: sie belegt, dass der vorgeschriebene
  // Token die Schwelle ueberhaupt halten KANN, und dass der alte es nicht tut.
  // Ohne diese Haelfte koennte jemand die Regel erfuellen, indem er auf ein
  // drittes, ebenso untaugliches Token ausweicht.
  const { light, dark } = themeTokenMaps();

  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    const ink = resolveColor('--color-ink-on-vivid', map);
    const modules = [...map.keys()].filter((name) => /^--module-[\w-]+$/.test(name));
    assert.ok(modules.length >= 15, `expected the module palette, found ${modules.length}`);

    for (const token of modules) {
      const surface = resolveColor(token, map);
      const ratio = contrastRatio(ink, surface);
      assert.ok(ratio >= 4.5,
        `${theme}: --color-ink-on-vivid (${ink}) auf ${token} (${surface}) ist ${ratio.toFixed(2)}:1`);
    }
  }

  // Im Dark-Theme muss das statische Weiss messbar durchfallen - sonst waere
  // der ganze Umbau unnoetig und dieser Guard wuerde eine tote Regel bewachen.
  const staticWhite = resolveColor('--color-text-on-accent', dark);
  assert.equal(staticWhite.toLowerCase(), '#ffffff', '--color-text-on-accent ist statisches Weiss');
  const worst = [...dark.keys()]
    .filter((name) => /^--module-[\w-]+$/.test(name))
    .map((name) => contrastRatio(staticWhite, resolveColor(name, dark)));
  assert.ok(Math.min(...worst) < 3,
    'Dark-Modulakzente muessen weissen Text unterschreiten, sonst ist die Regel gegenstandslos');
});

/**
 * Der Test darueber prueft die Token-WERTE pro Theme. Er sagt nichts darueber,
 * ob die App zur Laufzeit auch den Wert des aktiven Themes benutzt - und genau
 * da lag die Luecke: `--active-module-accent` steht als AUFGELOESTE Farbe im
 * Inline-Style von <html> (der Router liest --module-<name> beim Seitenwechsel
 * aus). Ein Inline-Style folgt keiner Kaskade. Wer im Hellmodus /tasks oeffnete
 * und dann auf Dunkel schaltete, behielt #15803D statt #4ADE80: Text in
 * Modul-Akzentfarbe kam auf 2.71:1 statt 7.81:1 - unter WCAG AA. Betroffen war
 * die ganze Shell (.btn--primary, .btn--secondary, --focus-ring-color, FAB,
 * aktive Nav-Pille). Nach einem Reload im Zielmodus stimmte alles wieder,
 * deshalb faellt es beim Testen im Zielmodus nicht auf.
 *
 * Der Guard formuliert die Regel, nicht die Fundstelle: die Momentaufnahme darf
 * nur an EINER Stelle entstehen, und jeder Weg, der das Theme zur Laufzeit
 * umschaltet, muss sie neu berechnen.
 */
test('module accent is recomputed on every runtime theme switch', () => {
  const router = read('../public/router.js');

  // 1. Genau ein Schreiber im ganzen Frontend. Ein zweiter waere eine zweite
  //    Momentaufnahme, die dieser Guard nicht mitzoege.
  const writers = walkJsFiles('../public/')
    .filter((path) => !path.includes('/vendor/'))
    .flatMap((path) => {
      const hits = read(path).match(/setProperty\(\s*'--active-module-accent'/g) ?? [];
      return hits.map(() => path);
    });
  assert.deepEqual(
    writers,
    ['../public/router.js'],
    `--active-module-accent must be written in exactly one place, found: ${writers.join(', ')}`,
  );

  const helper = router.match(/function applyModuleAccentForRoute\([\s\S]*?\n\}/);
  assert.ok(helper, 'expected applyModuleAccentForRoute to own the write');
  assert.match(
    helper[0],
    /setProperty\(\s*'--active-module-accent'/,
    'the single write must live inside applyModuleAccentForRoute',
  );

  // 2. Der Seitenwechsel geht durch denselben Helfer (keine Inline-Kopie).
  assert.match(router, /applyModuleAccentForRoute\(route\)/, 'navigate() must use the helper');

  // 3. Expliziter Theme-Wechsel (window.yuvomi.applyTheme) berechnet neu.
  const applyTheme = router.match(/applyTheme:\s*\(value\) => \{[\s\S]*?\n {2}\},/);
  assert.ok(applyTheme, 'expected the applyTheme export');
  assert.match(
    applyTheme[0],
    /data-theme/,
    'sanity: applyTheme is the function that flips the theme',
  );
  assert.match(
    applyTheme[0],
    /applyModuleAccentForRoute\(currentRoute\(\)\)/,
    'applyTheme must recompute the module accent for the current route',
  );

  // 4. Theme "Automatisch" schaltet ohne applyTheme um - rein per CSS-Media-
  //    Query. Ohne Listener liefe derselbe Kontrast-Bruch beim Sonnenuntergang
  //    des Systems, nur ohne Nutzeraktion.
  //
  //    Die MediaQueryList muss dabei in einem Modul-Binding leben. Als
  //    Wegwerf-Ausdruck (`matchMedia(...).addEventListener(...)`) darf die
  //    Engine sie einsammeln - der Listener verstummt dann still, und der
  //    Fehler kaeme genau in der Sitzung zurueck, die lange genug offen war.
  assert.match(
    router,
    /const darkSchemeQuery = window\.matchMedia\??\.?\(\s*'\(prefers-color-scheme: dark\)'\s*\)/,
    'the prefers-color-scheme query must be held in a module binding, not a throwaway expression',
  );
  assert.doesNotMatch(
    router,
    /matchMedia\??\.?\(\s*'\(prefers-color-scheme: dark\)'\s*\)\s*\??\.?\s*addEventListener/,
    'do not attach the listener to an unreferenced MediaQueryList',
  );

  const listener = router.match(
    /darkSchemeQuery\s*\??\.?\s*addEventListener[\s\S]{0,120}?'change'[\s\S]{0,200}?;/,
  );
  assert.ok(listener, 'expected a prefers-color-scheme change listener for auto mode');
  assert.match(
    listener[0],
    /applyModuleAccentForRoute\(currentRoute\(\)\)/,
    'the auto-mode listener must recompute the module accent too',
  );

  // 5. Das Anwenden darf nicht hinter einem werfenden localStorage haengen:
  //    stand die Persistenz zuerst, brach ein Quota-Fehler ab, bevor der Akzent
  //    neu berechnet war.
  assert.ok(
    applyTheme[0].indexOf('applyModuleAccentForRoute')
      < applyTheme[0].indexOf("localStorage.setItem('yuvomi-theme'"),
    'applyTheme must apply theme and accent before persisting the choice',
  );
});

/**
 * Der Akzent ist nicht die einzige eingefrorene Momentaufnahme.
 *
 * `updateThemeColorForRoute` loest `--module-<name>` ueber denselben
 * `getCSSToken` auf und schreibt das Ergebnis in beide
 * `<meta name="theme-color">`. Ein Attribut nimmt an keiner Kaskade teil, also
 * behielt die Statusbar nach hell/dunkel die Modulfarbe des alten Themes,
 * waehrend die Shell darunter laengst umgeschaltet hatte. Sichtbar nur in der
 * installierten PWA (`setThemeColor` steigt sonst frueh aus), weshalb es neben
 * dem Akzent-Befund durchrutschte - die Regel ist aber dieselbe: Jeder Weg, der
 * das Theme zur Laufzeit umschaltet, muss BEIDE neu berechnen.
 */
test('the standalone status bar colour is recomputed on a runtime theme switch too', () => {
  const router = read('../public/router.js');

  const helper = router.match(/function refreshThemeColorForTheme\(\)[\s\S]*?\n\}/);
  assert.ok(helper, 'expected refreshThemeColorForTheme to own the status bar refresh');
  assert.match(
    helper[0],
    /updateThemeColorForRoute\(currentRoute\(\)\)/,
    'the helper must recompute the status bar colour for the current route',
  );
  // Ein offenes Modal haelt die Statusbar abgedunkelt und stellt sie beim
  // Schliessen ueber restoreThemeColor selbst wieder her. Zoege der Auto-Modus
  // die Routenfarbe nach, waere die Abdunklung mitten im Modal weg.
  assert.match(
    helper[0],
    /shared-modal-overlay/,
    'the helper must leave the status bar alone while a modal dims it',
  );

  // Beide Umschaltwege ziehen nach - derselbe Anspruch wie beim Modul-Akzent.
  const applyTheme = router.match(/applyTheme:\s*\(value\) => \{[\s\S]*?\n {2}\},/);
  assert.ok(applyTheme, 'expected the applyTheme export');
  assert.match(
    applyTheme[0],
    /refreshThemeColorForTheme\(\)/,
    'applyTheme must refresh the status bar colour',
  );

  const listener = router.match(
    /darkSchemeQuery\s*\??\.?\s*addEventListener[\s\S]{0,120}?'change'[\s\S]{0,300}?\n {4}\}\);/,
  );
  assert.ok(listener, 'expected a prefers-color-scheme change listener for auto mode');
  assert.match(
    listener[0],
    /refreshThemeColorForTheme\(\)/,
    'the auto-mode listener must refresh the status bar colour too',
  );
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

test('shared prompt and select dialogs expose persistent form labels', () => {
  const src = read('../public/components/modal.js');

  assert.match(
    src,
    /<label class="sr-only" for="prompt-modal-input">\$\{esc\(label\)\}<\/label>/,
    'promptModal input needs a connected label',
  );
  assert.match(
    src,
    /<label class="sr-only" for="select-modal-input">\$\{esc\(label\)\}<\/label>/,
    'selectModal control needs a connected label',
  );
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

test('Budget places Subscriptions between Budget and Loans with secure rendering', () => {
  const budget = read('../public/pages/budget.js');
  const subscriptions = read('../public/pages/subscriptions.js');
  // Tab-Reihenfolge liegt in der Definitionsliste (data-tab-id wird daraus
  // generiert): Abonnements müssen zwischen Budget und Darlehen stehen.
  const budgetTab = budget.indexOf("['budget',");
  const subscriptionsTab = budget.indexOf("['subscriptions',");
  const loansTab = budget.indexOf("['loans',");

  assert.ok(budgetTab >= 0 && subscriptionsTab > budgetTab && loansTab > subscriptionsTab);
  assert.match(budget, /renderSubscriptions/);
  assert.doesNotMatch(subscriptions, /\.innerHTML\s*=/);
  assert.match(subscriptions, /replaceChildren\(\)/);
  assert.match(subscriptions, /insertAdjacentHTML\(/);
});

test('search fields keep visible labels after users enter a query', () => {
  // The shared page-search building block renders the label+input pair once;
  // page-toolbar modules opt in by calling renderPageSearch with their field id.
  // Split-expenses keeps its own sidebar-filter markup (visible label above the
  // control, server-side reload) as a documented, distinct pattern.
  const pageSearch = read('../public/utils/page-search.js');
  assert.match(pageSearch, /<label[^>]*for="\$\{esc\(id\)\}"/);
  assert.match(pageSearch, /<input[^>]*id="\$\{esc\(id\)\}"/);

  const viaComponent = [
    ['../public/pages/birthdays.js', 'birthdays-search'],
    ['../public/pages/contacts.js', 'contacts-search'],
    ['../public/pages/notes.js', 'notes-search'],
    ['../public/pages/documents.js', 'documents-search'],
    ['../public/pages/tasks.js', 'tasks-search'],
    ['../public/pages/pantry.js', 'pantry-search'],
    ['../public/pages/recipes.js', 'recipes-search'],
  ];
  for (const [file, id] of viaComponent) {
    const source = read(file);
    assert.match(
      source,
      new RegExp(`renderPageSearch\\(\\{[^}]*id:\\s*['"]${id}['"]`),
      `${file} must render #${id} via the shared page-search component`,
    );
  }

  // Die Liste oben ist eine Allowlist und hat genau deshalb zwei Jahre lang
  // nichts gemerkt: pantry.js und recipes.js bauten je ein eigenes
  // `<input type="search">` nach - ohne Lupe, ohne Leeren-Knopf, ohne `<label>`,
  // ohne Debounce und mit dem Placeholder als einziger Beschriftung. Sie standen
  // nicht in der Liste, also gab es keinen Fehlschlag (Audit 2026-07-30).
  //
  // Ein Guard über eine Allowlist deckt keine Regel ab, sondern N Dateien. Diese
  // Schleife dreht die Richtung um: sie findet JEDES Suchfeld im Seitenbestand
  // und verlangt, dass es aus dem geteilten Baustein stammt oder als Ausnahme
  // benannt ist. Ein neues Modul mit eigenem Nachbau fällt damit auf, ohne dass
  // jemand daran denken muss, es hier einzutragen.
  const documentedExceptions = new Set([
    // Kalender: schwergewichtige Server-FTS-Ergebnisansicht mit eigener
    // Icon-Reveal-Leiste, kein Client-Filter (siehe utils/page-search.js).
    'calendar.js',
    // Split-Expenses: sichtbares Label über dem Feld, Server-Reload. Der
    // inlineLabel-Block unten prüft es separat.
    'split-expenses.js',
    // Abos: eigenes Markup, aber die Substanz stimmt - Lupe, `<label>` mit
    // sr-only-Text, autocomplete="off" und eine 250ms-Debounce um einen
    // SERVER-Filter (`?q=`), nicht um einen Client-Filter. Damit liegt es näher
    // am Kalender als an der Küche und ist kein Fall der Defektklasse, die
    // dieser Guard fängt. Offen bleibt allein der Leeren-Knopf; eine
    // Konsolidierung wäre Aufräumen, keine Fehlerbehebung.
    'subscriptions.js',
  ]);
  const pagesDir = new URL('../public/pages/', import.meta.url);
  for (const entry of readdirSync(pagesDir)) {
    if (!entry.endsWith('.js') || documentedExceptions.has(entry)) continue;
    const source = read(`../public/pages/${entry}`);
    if (!/type=['"]search['"]|\.type\s*=\s*['"]search['"]/.test(source)) continue;
    assert.match(
      source,
      /renderPageSearch\(\{/,
      `${entry} builds a search input by hand; use renderPageSearch() from `
      + 'utils/page-search.js or add it to documentedExceptions with a reason',
    );
  }

  const inlineLabel = [
    ['../public/pages/split-expenses.js', 'split-group-search'],
  ];
  for (const [file, id] of inlineLabel) {
    const source = read(file);
    assert.match(
      source,
      new RegExp(`<label[^>]*for="${id}"[^>]*>[\\s\\S]*?<input[^>]*id="${id}"|<label[^>]*>[\\s\\S]*?<input[^>]*id="${id}"`),
      `${file} must expose a persistent visible label for #${id}`,
    );
  }
});

test('split-expenses archive is reachable and offers a way back (#574)', () => {
  // Archivieren war eine Einbahnstraße: die API kannte ?status=archived, die
  // Oberfläche hatte weder Filter noch Wiederherstellen.
  const page = read('../public/pages/split-expenses.js');
  // Die Statusleiste läuft seit der Budget-Zusammenführung über den geteilten
  // Umschalter-Baustein (data-tab-id + wireTablist) statt über eigene Chips.
  assert.match(page, /data-tab-id="\$\{id\}"/, 'group list needs a status switcher');
  assert.match(page, /'active', 'splitExpenses\.statusActive'/, 'group list needs an active option');
  assert.match(page, /'archived', 'splitExpenses\.statusArchived'/, 'group list needs an archived option');
  assert.match(
    page,
    /\/split-expenses\/groups\?status=\$\{state\.groupStatus\}/,
    'group list must load the selected status, not only active groups',
  );
  assert.match(page, /groups\/\$\{groupId\}\/unarchive/, 'archived groups need a restore action');

  // Das Gruppen-Panel ist ein Grid-Item: ohne min-width:0 wächst es auf die
  // Breite der breitesten Gruppenkarte und schiebt Suche und Filter aus dem
  // Viewport (auf 375px war das Suchfeld rechts abgeschnitten).
  const css = read('../public/styles/split-expenses.css');
  const panelRules = [...css.matchAll(/\.split-groups-panel\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(
    panelRules.some((body) => /min-width:\s*0/.test(body)),
    '.split-groups-panel must not stretch past its grid track',
  );

  assertKeysExistInEveryLocale([
    'splitExpenses.statusLabel',
    'splitExpenses.statusActive',
    'splitExpenses.statusArchived',
    'splitExpenses.restoreGroup',
    'splitExpenses.emptyArchivedTitle',
    // Dynamisch gerendert (activityType.${item.type}), deshalb hier explizit.
    'splitExpenses.activityType.group_unarchived',
  ]);
});

test('German housekeeping visit copy contains no English fallback strings', () => {
  const locale = JSON.parse(read('../public/locales/de.json'));
  const expected = {
    reports: 'Berichte',
    visitRecordedAt: 'Einsatz erfasst um',
    checkedInToday: 'Heute erfasst',
    editVisit: 'Einsatz bearbeiten',
    paymentPaid: 'Bezahlt',
    paymentPending: 'Ausstehend',
    filterMonth: 'Monat',
  };

  for (const [key, value] of Object.entries(expected)) {
    assert.equal(locale.housekeeping[key], value, `housekeeping.${key} must be German`);
  }

  const housekeepingCss = read('../public/styles/housekeeping.css');
  assert.match(
    housekeepingCss,
    /\.housekeeping-worker-strip__identity\s*\{[\s\S]*gap:\s*var\(--space-1\)/,
    'housekeeper name and status need an explicit visual gap',
  );
});

test('holiday chips derive readable ink from each configured color', () => {
  const calendarPage = read('../public/pages/calendar.js');
  const calendarCss = read('../public/styles/calendar.css');

  assert.match(calendarPage, /import \{ getReadableTextColor \} from '\/utils\/color\.js'/);
  assert.match(calendarPage, /--holi-ink:\$\{esc\(getReadableTextColor\(h\.color\)\)\}/);
  for (const selector of ['.month-day__holiday', '.allday-holiday']) {
    const body = cssRuleBody(calendarCss, selector);
    assert.match(body, /color:\s*var\(--holi-ink,\s*var\(--color-text-on-accent\)\)/);
    assert.doesNotMatch(body, /color:\s*#fff/);
  }
});

test('user-selected avatar colors derive readable text ink', () => {
  const dashboard = read('../public/pages/dashboard.js');
  const multiSelect = read('../public/components/user-multi-select.js');
  const color = read('../public/utils/color.js');

  // Single source of truth for the neutral avatar fallback (concrete hex —
  // getReadableTextColor needs a value it can measure luminance on).
  assert.match(color, /export const AVATAR_FALLBACK_COLOR = '#[0-9a-fA-F]{6}';/);

  assert.match(dashboard, /import \{ getReadableTextColor, AVATAR_FALLBACK_COLOR \} from '\/utils\/color\.js'/);
  assert.match(
    dashboard,
    /color:\$\{getReadableTextColor\(u\.avatar_color \|\| AVATAR_FALLBACK_COLOR\)\}/,
  );
  assert.match(multiSelect, /import \{ getReadableTextColor, AVATAR_FALLBACK_COLOR \} from '\/utils\/color\.js'/);
  assert.match(
    multiSelect,
    /color:\$\{getReadableTextColor\(u\.color \?\? AVATAR_FALLBACK_COLOR\)\}/,
  );
  assert.match(
    multiSelect,
    /color:\$\{getReadableTextColor\(u\.avatar_color \?\? AVATAR_FALLBACK_COLOR\)\}/,
  );
});

test('mobile meal actions remain visible and touch-safe after the full cascade', () => {
  const meals = read('../public/styles/meals.css');

  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*640px\)[\s\S]*?\.meal-card__actions\s*\{[\s\S]*?opacity:\s*1/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*640px\)[\s\S]*?\.meal-card__action-btn\s*\{[\s\S]*?width:\s*var\(--target-lg\)[\s\S]*?height:\s*var\(--target-lg\)/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*640px\)[\s\S]*?\.week-nav__today,[\s\S]*?\.meal-slot__add-more-btn\s*\{[\s\S]*?min-height:\s*var\(--target-lg\)/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*640px\)[\s\S]*?\.meal-card__action-btn\s*\{[\s\S]*?color:\s*var\(--color-text-secondary\)/,
  );
});

test('audited profile, birthday, navigation, and budget controls meet mobile touch targets', () => {
  const settings = read('../public/styles/settings.css');
  const layout = read('../public/styles/layout.css');
  const budget = read('../public/styles/budget.css');
  const contacts = read('../public/styles/contacts.css');
  const housekeeping = read('../public/styles/housekeeping.css');
  const subTabs = read('../public/styles/sub-tabs.css');

  assert.match(settings, /\.settings-avatar-action\s*\{[\s\S]*width:\s*var\(--target-md\)[\s\S]*height:\s*var\(--target-md\)/);
  assert.match(
    settings,
    /@media \(max-width:\s*640px\)[\s\S]*\.settings-avatar-action\s*\{[\s\S]*width:\s*var\(--target-lg\)[\s\S]*height:\s*var\(--target-lg\)/,
  );
  assert.match(settings, /\.settings-module-move\s*\{[\s\S]*width:\s*var\(--target-base\)[\s\S]*height:\s*var\(--target-base\)/);
  // Zeilen-Aktionen (Bearbeiten/Löschen in Geburtstags-/Budget-/Kontakt-Karten)
  // teilen jetzt .row-action mit 48px-Touch-Fläche (Audit F1).
  assert.match(layout, /\.row-action\s*\{[\s\S]*width:\s*var\(--target-lg\)[\s\S]*height:\s*var\(--target-lg\)/);
  // Budget-Tabs nutzen jetzt das geteilte .sub-tab (sub-tabs.css) statt eigener
  // .budget-tab-Buttons — Touch-Target dort prüfen (44px, iOS-Minimum, wie alle
  // Sub-Tab-Module: Belohnungen/Haushaltshilfe/Küche/Gesundheit).
  assert.match(subTabs, /\.sub-tab\s*\{[\s\S]*height:\s*var\(--target-base\)/);
  assert.match(budget, /\.budget-nav__today\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/);
  assert.match(
    contacts,
    /@media \(max-width:\s*767px\)[\s\S]*\.contact-filter-chip\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/,
  );
  assert.match(housekeeping, /\.housekeeping-log-action\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/);
});

test('remaining audited mobile controls use 48px touch targets', () => {
  const tasks = read('../public/styles/tasks.css');
  const calendar = read('../public/styles/calendar.css');
  const budget = read('../public/styles/budget.css');
  const settings = read('../public/styles/settings.css');

  assertRuleUsesToken(tasks, '.filter-toggle-btn', 'min-height', '--target-lg', '../public/styles/tasks.css');
  assertRuleUsesToken(calendar, '.cal-toolbar__today', 'min-height', '--target-lg', '../public/styles/calendar.css');
  // Der Darlehens-Statusfilter ist in .budget-segmented aufgegangen. Der Baustein
  // nimmt --target-base (44px Zeiger / 48px Finger) statt --target-lg fest: das
  // Kriterium ist die Zeigerfähigkeit, nicht die Viewport-Breite (tokens.css).
  assertRuleUsesToken(budget, '.budget-segmented__item', 'min-height', '--target-base', '../public/styles/budget.css');
  assertRuleUsesToken(budget, '.budget-loan-card__filter', 'width', '--target-lg', '../public/styles/budget.css');
  assertRuleUsesToken(budget, '.budget-loan-card__filter', 'height', '--target-lg', '../public/styles/budget.css');
  assert.match(
    settings,
    /@media \(max-width:\s*767px\)[\s\S]*\.settings-breadcrumb__link\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/,
  );
});

test('contacts keep one primary call action and disclose the rest through a labeled More menu', () => {
  const contactsPage = read('../public/pages/contacts.js');
  const contactsCss = read('../public/styles/contacts.css');

  // Genau eine stets sichtbare Primäraktion pro Zeile: Anrufen (falls Telefon da).
  // Nutzt die geteilte .row-action-Grammatik mit semantischer Erfolgs-Färbung
  // (grün) über row-action--success (Audit F1).
  assert.match(contactsPage, /href="tel:[\s\S]*class="row-action row-action--success"/);
  // Sekundäraktionen leben im „Mehr"-Menü als BESCHRIFTETE Einträge (Icon + Text),
  // identisch auf Desktop und Mobile — behebt das „nackte Icons"-Problem.
  assert.match(contactsPage, /class="contact-menu-item"[\s\S]*contact-menu-item__icon[\s\S]*<span>/);
  // Löschen ist ein abgesetzter Danger-Eintrag im selben Menü.
  assert.match(contactsPage, /contact-menu-item contact-menu-item--danger[\s\S]*data-action="delete"/);
  // Menü-Eintrag trägt Textlabel (kein reines Icon mehr).
  assert.match(contactsCss, /\.contact-menu-item\s*\{[\s\S]*min-height:\s*var\(--target-md\)/);
  // Das Panel ist ein Popover (Top-Layer) statt eines absolut positionierten
  // Menüs im Scroll-Container.
  assert.match(contactsCss, /\.contact-more-menu__panel\s*\{[\s\S]*position:\s*fixed/);
  assert.match(contactsPage, /popovertarget="\$\{menuId\}"/);
  assert.match(contactsPage, /id="\$\{menuId\}" popover/);
});

test('contacts keyboard shortcut and aria-live result count are wired', () => {
  const contactsPage = read('../public/pages/contacts.js');

  // sr-only Live-Region sagt die Trefferzahl an
  assert.match(contactsPage, /id="contacts-status"[^>]*role="status"[^>]*aria-live="polite"/);
  // „/" fokussiert die Suche; document-Listener meldet sich bei Teardown selbst ab
  assert.match(contactsPage, /e\.key === '\/'/);
  assert.match(contactsPage, /pageRoot\.isConnected/);
});

test('contacts bulk selection is opt-in and hidden by default', () => {
  const contactsPage = read('../public/pages/contacts.js');
  const contactsCss = read('../public/styles/contacts.css');

  // Toggle in der Toolbar + Auswahl-Leiste, die per hidden startet (Default clean)
  assert.match(contactsPage, /id="contacts-select-btn"/);
  assert.match(contactsPage, /id="contacts-selectbar"[\s\S]*?hidden>/);
  // Sammel-Löschen mit Undo-Toast
  assert.match(contactsPage, /async function deleteSelected/);
  assert.match(contactsPage, /bulkDeletedToast/);
  // Familien-Kontakte bleiben nicht wählbar (deaktivierte Checkbox)
  assert.match(contactsPage, /c\.family_user_id \? ' disabled' : ''/);
  assert.match(contactsCss, /\.contacts-selectbar\s*\{/);
  // display:flex würde das hidden-Attribut schlagen — der [hidden]-Guard hält die
  // Leiste im Default-Zustand wirklich unsichtbar.
  assert.match(contactsCss, /\.contacts-selectbar\[hidden\]\s*\{[\s\S]*display:\s*none/);
});

test('documents and navigation settings use progressive disclosure instead of stacked control cards', () => {
  const documentsPage = read('../public/pages/documents.js');
  const documentsCss = read('../public/styles/documents.css');
  const navigationPage = read('../public/settings/pages/modules-navigation.js');
  const settingsCss = read('../public/styles/settings.css');

  // Dokumente folgen dem Kontakte-Muster (Issue #506): Filter leben in einer
  // eigenen, horizontal scrollenden Zeile unter dem Kopf — nicht mehr hinter
  // einem <details>-Slider in die Kopfzeile gequetscht.
  assert.doesNotMatch(documentsPage, /documents-secondary-controls/);
  assert.match(documentsPage, /<div class="documents-filters">/);
  assert.match(documentsPage, /class="documents-filter-group" id="documents-status"/);
  assert.match(documentsPage, /class="documents-filter-chips" id="documents-category"/);
  // Nur die Kategorie-Facette scrollt; die Filterzeile selbst nicht. Das hält
  // Status, Sortierung und Auswahl immer sichtbar und verhindert verschachtelte
  // Scroller. Vorher brach die Facette um und wuchs unbegrenzt in die Höhe.
  assert.match(
    documentsCss,
    /\.documents-filter-chips\s*\{[^}]*overflow-x:\s*auto/,
  );
  assert.match(documentsCss, /\.documents-filters\s*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(documentsCss, /documents-secondary-controls/);
  assert.match(navigationPage, /class="settings-navigation-panel"/);
  assert.doesNotMatch(navigationPage, /<div class="settings-card">/);
  assert.match(settingsCss, /\.settings-navigation-panel\s*\{[\s\S]*border-bottom:\s*var\(--space-px\)\s+solid\s+var\(--color-border-subtle\)/);
  assert.match(
    settingsCss,
    /@media \(max-width:\s*640px\)[\s\S]*\.settings-module-drag\s*\{[\s\S]*display:\s*none/,
  );
});

test('birthday and navigation headings keep a sequential hierarchy', () => {
  const birthdays = read('../public/pages/birthdays.js');
  const navigation = read('../public/settings/pages/modules-navigation.js');

  assert.match(birthdays, /<h1 class="page-toolbar__title">/);
  assert.doesNotMatch(birthdays, /<h3>/);
  assert.match(navigation, /<h2 class="settings-navigation-panel__title"/);
  assert.match(navigation, /<h3 class="settings-navigation-group__title"/);
  assert.doesNotMatch(navigation, /<h4 class="settings-navigation-group__title"/);
});

test('housekeeping exposes its page title as the primary heading', () => {
  const housekeeping = read('../public/pages/housekeeping.js');

  assert.match(housekeeping, /<h1 class="page-toolbar__title" id="housekeeping-title">/);
  assert.doesNotMatch(housekeeping, /<div class="page-toolbar__title" id="housekeeping-title">/);
});

// Modulkopf-Familien (R2/F4): Es gibt ZWEI bewusste, in utils/tablist.js
// dokumentierte Kopf-Muster, kein Ausreißer:
//   (1) In-Page-Tabs  — Tabs leben im kanonischen `.page-toolbar` mit sichtbarem
//       `<h1 class="page-toolbar__title">`, verdrahtet via wireTablist. Der Tab-
//       wechsel tauscht Inhalt INNERHALB einer Route (budget/housekeeping/rewards).
//   (2) Routen-Cluster — geteilte sticky `.sub-tabs-bar` via renderSubTabs mit
//       dekorativem Inline-Titel + separater `sr-only` <h1>; die Leiste NAVIGIERT
//       zwischen Deep-Link-Routen (health, kitchen: meals/recipes/shopping).
// Der Web-Audit flaggte health als Kopf-Ausreißer; tatsächlich teilt es exakt das
// Muster von kitchen. health auf ein page-toolbar zu zwingen würde es von seinen
// vier Geschwister-Modulen wegbrechen. Dieser Guard pinnt die Grenze, damit ein
// künftiges „Köpfe vereinheitlichen"-Refactor die Routen-Cluster-Familie nicht
// still zerlegt.
// Issue #577: Die Kopf-FAMILIEN (in-page tabs vs. route clusters, Test unten)
// sind bewusst verschieden — die Kopf-BREITEN waren es nie. Bis v1.45.14 trug
// jeder Modul-Root sein eigenes max-width, wodurch der Kopf mit im gedeckelten
// Container saß: der 3px-Akzentstreifen endete 210px vor der Shell-Kante, und
// die Module drifteten auf vier verschiedene Breiten (1700/1280/1200/720).
// Dieser Guard hält die eine Regel fest, die damals nirgends aufgeschrieben war.
// Kommentare VOR jeder Prüfung entfernen: ein Regex über rohen CSS-Text matcht
// sonst auch in /* ... */ und die halbe Vertragsprüfung wäre durch eine
// Erwähnung im Fließtext erfüllbar.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Wie cssRules(), aber jede Regel kennt zusaetzlich ihren Kontext:
//
//   - `conditional` sagt, ob sie nur unter einer Bedingung gilt. Fuer eine
//     GEFORDERTE Deklaration ist das der Unterschied zwischen „gilt immer" und
//     „gilt unterhalb von 640px". Entscheidend ist die SEMANTIK der At-Rule,
//     nicht ihr '@': `@media`/`@supports`/`@container`/`@scope` schraenken ein,
//     `@layer` ordnet nur die Kaskade und gilt ueberall.
//   - Verschachtelte Regeln werden mitgelesen, mit aufgeloestem Selektor.
//     Ein flacher Scanner nimmt die erste schliessende Klammer als Rumpfende
//     und uebersieht `.foo { & { max-width: 20rem } }` vollstaendig - er
//     prueft dann still weniger, als er behauptet.
const CONDITIONAL_AT_RULE = /^@(?:media|supports|container|scope|document|starting-style)\b/i;

// Deklarationen dieser Ebene, ohne die Rumpfe verschachtelter Regeln (die
// kommen als eigene Eintraege) und ohne deren Praeludien.
function ownDeclarations(body) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') {
      if (depth === 0) {
        const cut = Math.max(out.lastIndexOf(';'), out.lastIndexOf('}'));
        out = out.slice(0, cut + 1);
      }
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

function scopedRules(css) {
  const live = stripCssComments(css);
  const rules = [];

  const parse = (from, to, conditional, parents) => {
    let i = from;
    let start = from;
    while (i < to) {
      const char = live[i];
      // Statement-At-Rules (@import, @charset, @layer x;) oeffnen keinen Block;
      // ohne diesen Zweig waechst das Praeludium ueber sie hinaus und die
      // naechste echte Regel wird als At-Rule-Rumpf verschluckt.
      if (char === ';' || char === '}') {
        i += 1;
        start = i;
        continue;
      }
      if (char !== '{') {
        i += 1;
        continue;
      }

      const prelude = live.slice(start, i).replace(/\s+/g, ' ').trim();
      let depth = 1;
      let j = i + 1;
      while (j < to && depth > 0) {
        if (live[j] === '{') depth += 1;
        else if (live[j] === '}') depth -= 1;
        j += 1;
      }
      const close = j - 1;

      if (prelude.startsWith('@')) {
        const inner = conditional || CONDITIONAL_AT_RULE.test(prelude);
        // Steht die Gruppe IN einer Style-Regel, gelten ihre eigenen
        // Deklarationen dem Elternselektor: `.kitchen-list { @media … {
        // max-width: 20rem } }`. Ohne diesen Zweig verschwindet die Kappung.
        if (parents.length) {
          const own = ownDeclarations(live.slice(i + 1, close));
          if (own.trim()) rules.push({ selectors: parents, body: own, conditional: inner });
        }
        parse(i + 1, close, inner, parents);
      } else {
        const own = prelude.split(',').map((sel) => sel.trim()).filter(Boolean);
        const selectors = parents.length
          ? own.flatMap((sel) => parents.map((parent) => (sel.includes('&')
            ? sel.replace(/&/g, parent)
            : `${parent} ${sel}`)))
          : own;
        rules.push({ selectors, body: ownDeclarations(live.slice(i + 1, close)), conditional });
        parse(i + 1, close, conditional, selectors);
      }

      i = close + 1;
      start = i;
    }
  };

  parse(0, live.length, false, []);
  return rules;
}

// Flacher Regelblock-Scanner. At-Rule-Präludien (@media, @supports, @container)
// fallen automatisch weg, weil [^{}]* kein '{' fressen kann und der Selektor
// dann mit '@' beginnt.
function cssRules(css) {
  const rules = [];
  for (const [, rawSelector, body] of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector.replace(/\s+/g, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    rules.push({ selectors: selector.split(',').map((s) => s.trim()), body });
  }
  return rules;
}

// Horizontale Padding-Werte einer Regel. padding-block/-top/-bottom sind bewusst
// NICHT enthalten - die vertikale Achse darf jedes Modul frei setzen.
function horizontalPaddings(body) {
  const values = [];
  for (const [, prop, raw] of body.matchAll(/(?:^|;)\s*(padding(?:-inline(?:-start|-end)?|-left|-right)?)\s*:\s*([^;]+)/g)) {
    const value = raw.trim();
    if (prop !== 'padding') { values.push(value); continue; }
    // Shorthand: die horizontale Achse ist der zweite Wert (bzw. der erste,
    // wenn nur einer angegeben ist). var(--x) und calc(...) zählen als ein Wert.
    const parts = value.match(/(?:[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|\S)+/gi) || [];
    values.push(parts.length === 1 ? parts[0] : parts[1]);
  }
  return values.filter(Boolean);
}

const ALLOWED_INLINE = /^(0|0px|var\(--page-inline-pad\))$/;

// Dokumentierte Ausnahmen. Bewusst als Liste MIT Begründung statt als stille
// Lücke im Scan: wer hier etwas einträgt, muss den Grund hinschreiben.
const RAIL_PAD_EXCEPTIONS = [
  {
    file: 'kitchen-tabs.css',
    selector: '.kitchen-tabs-bar .sub-tab',
    // Der Tab-Button liegt IN der Rail, er ist nicht die Rail: sein
    // padding-inline ist Innenabstand zwischen Icon und Pill-Rand, nicht die
    // Einrückung der Content-Spalte. Vorher stand hier die Rail selbst
    // (.kitchen-tabs-bar mit padding-inline: var(--space-2)) und deckte diesen
    // Selektor per Substring-Match versehentlich mit ab. Seit der Modultitel
    // mobil entfällt (Critique 2026-07-29), braucht die Rail keinen Override
    // mehr und erbt --page-inline-pad - der 8px-Versatz zum Body ist damit weg.
    reason: 'Button-Innenabstand des Tabs, keine Rail-Einrückung',
  },
];

const isException = (file, selector) => RAIL_PAD_EXCEPTIONS.some(
  (e) => file === e.file && selector.includes(e.selector),
);

// Issue #577: Die Kopf-FAMILIEN (in-page tabs vs. route clusters, Test unten)
// sind bewusst verschieden - die Kopf-BREITEN waren es nie. Bis v1.45.14 trug
// jeder Modul-Root sein eigenes max-width, wodurch der Kopf mit im gedeckelten
// Container saß: der 3px-Akzentstreifen endete 210px vor der Shell-Kante, und
// die Module drifteten auf vier verschiedene Breiten (1700/1280/1200/720).
//
// Der erste Anlauf dieses Guards prüfte nur, ob das Token je Datei VORKOMMT.
// Das fing weder den glass.css-Override (andere Datei, Co-Klassen-Selektor)
// noch den health.css-Mobil-Override (dieselbe Datei, zusätzliche Regel) -
// also genau die beiden Fälle, deretwegen er geschrieben wurde. Jetzt wird
// jeder Regelblock jedes Stylesheets geprüft.
//
// Gegenverifiziert: rot bei (1) Rail-Override in fremder Datei, (2) Mobil-
// Override in derselben Datei, (3) max-width auf einem Modul-Root, (4) Token
// nur noch im Kommentar.
//
// BEKANNTE GRENZE: Ein Textscan sieht keine Verschachtelung. Polstert ein
// NACHFAHRE eines Spaltenträgers noch einmal horizontal (z. B. .budget-summary
// unterhalb von #budget-body), addieren sich die Ränder, ohne dass hier etwas
// anschlägt - der Selektor ist weder ein Rail noch selbst ein Träger. Genau so
// entstand der 16px-Versatz im Budget-Modul nach dem ersten #577-Anlauf.
// Dagegen hilft nur echte Geometrie: ein Playwright-Durchlauf über alle
// Modulrouten, der die Kopf-Kante gegen die erste Inhaltskante vergleicht.
// Der gehört nicht in npm test (braucht Server und DB), sondern in die
// Screenshot-Pipeline.
test('page-inline-pad contract holds across every stylesheet (#577)', () => {
  // Dashboard und Settings sind dokumentierte Ausnahmen: beide haben keinen
  // Canonical Page Head und behalten ihren zentrierten Block.
  const bleedModules = [
    'tasks', 'notes', 'contacts', 'documents', 'housekeeping', 'rewards',
    'budget', 'calendar', 'birthdays', 'meals', 'shopping', 'recipes', 'health',
  ];

  // Rail-Aliasse aus dem Markup lesen. glass.css traf `.tasks-toolbar`, nicht
  // `.page-toolbar` - ein Scan, der nur den Basisnamen kennt, ist dafür blind.
  const rails = new Set(['.page-toolbar', '.sub-tabs-bar']);
  for (const file of walkJsFiles('../public/pages/')) {
    const src = stripCssComments(read(file));
    for (const [, classList] of src.matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g)) {
      classList.split(/\s+/).filter(Boolean).forEach((c) => rails.add(`.${c}`));
    }
    for (const [, classList] of src.matchAll(/className\s*=\s*'([^']*\bpage-toolbar\b[^']*)'/g)) {
      classList.split(/\s+/).filter(Boolean).forEach((c) => rails.add(`.${c}`));
    }
  }
  for (const util of ['kitchen-tabs', 'health-tabs']) {
    for (const [, cls] of read(`../public/utils/${util}.js`).matchAll(/extraClass:\s*'([^']+)'/g)) {
      cls.split(/\s+/).filter(Boolean).forEach((c) => rails.add(`.${c}`));
    }
  }
  assert.ok(rails.size >= 4, 'Rail-Aliasse konnten nicht aus dem Markup gelesen werden');

  const styleFiles = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((f) => f.endsWith('.css'));

  // (1) Kein Stylesheet darf ein Rail horizontal umpolstern - egal welche Datei,
  //     welcher Breakpoint, welche Spezifität.
  for (const file of styleFiles) {
    for (const rule of cssRules(read(`../public/styles/${file}`))) {
      const hitsRail = rule.selectors.some((sel) => [...rails].some(
        (rail) => new RegExp(`${rail.replace('.', '\\.')}(?![\\w-])`).test(sel),
      ));
      if (!hitsRail) continue;
      for (const value of horizontalPaddings(rule.body)) {
        if (isException(file, rule.selectors.join(', '))) continue;
        assert.ok(
          ALLOWED_INLINE.test(value),
          `${file}: "${rule.selectors.join(', ')}" setzt horizontales Padding "${value}" auf einem Full-bleed-Rail. `
          + 'Erlaubt sind nur 0 und var(--page-inline-pad) (#577)',
        );
      }
    }
  }

  // (2) Wer die Content-Spalte trägt, darf sie nirgends mit einem Festwert
  //     überschreiben - auch nicht in einem späteren @media-Block derselben Datei.
  for (const mod of bleedModules) {
    const css = read(`../public/styles/${mod}.css`);
    const rules = cssRules(css);
    const carriers = new Set(
      rules.filter((r) => /padding-inline:\s*var\(--page-inline-pad\)|margin-inline:\s*var\(--page-inline-pad\)/.test(r.body))
        .flatMap((r) => r.selectors),
    );
    assert.ok(carriers.size > 0, `${mod}: kein Träger der Content-Spalte (--page-inline-pad) gefunden (#577)`);

    for (const rule of rules) {
      for (const sel of rule.selectors.filter((s) => carriers.has(s))) {
        for (const value of horizontalPaddings(rule.body)) {
          assert.ok(
            ALLOWED_INLINE.test(value),
            `${mod}.css: "${sel}" trägt die Content-Spalte, überschreibt sie aber mit "${value}" (#577)`,
          );
        }
      }
    }

    // (3) Kein Modul-Root deckelt sich selbst - das war die Ursache von #577.
    for (const rule of rules) {
      if (!rule.selectors.some((s) => new RegExp(`\\.${mod === 'split-expenses' ? 'split' : '[a-z-]+'}-page$`).test(s))) continue;
      assert.doesNotMatch(
        rule.body,
        /(?:^|;)\s*(?:max-)?(?:width|inline-size)\s*:/,
        `${mod}: Modul-Root darf sich nicht selbst deckeln — die Content-Spalte kommt aus --page-inline-pad (#577)`,
      );
    }
  }

  // (4) Die Token-Definition selbst.
  const tokens = stripCssComments(read('../public/styles/tokens.css'));
  assert.match(
    tokens,
    /--page-inline-pad:\s*max\(\s*var\(--page-gutter\),\s*calc\(\(100% - var\(--content-max-width\)\) \/ 2\)\s*\)/,
    'tokens.css muss --page-inline-pad aus --page-gutter und --content-max-width ableiten',
  );
  assert.match(
    tokens,
    /@media \(min-width:\s*1024px\)\s*\{\s*:root\s*\{\s*--page-gutter:\s*var\(--space-8\)/,
    '--page-gutter muss ab 1024px auf --space-8 gehen (eine Quelle für Kopf und Body)',
  );
});

test('wer seinen Körper aufs Lesemaß kappt, kappt auch seinen Kopf', () => {
  // REGEL, KEINE LISTE: geprüft wird jede Seite, die .kitchen-list rendert -
  // nicht eine Aufzählung der heute drei Küchen-Listen. Genau als Aufzählung
  // stand die Vorgängerregel da (je ein `> * { max-width }`-Block in
  // shopping.css und pantry.css), und die Rezepte fehlten darin schlicht.
  //
  // Was sie außerdem nicht leistete: `max-width` kappt die BREITE eines Slots,
  // der Slot war aber ohnehin schmaler - `.page-toolbar__actions
  // { margin-left: auto }` schob ihn danach unverändert an die äußere Kante.
  // Gemessen bei 1280px: Liste bis x=972, Lagerort-Knopf bis x=1248.
  // `.page-toolbar--narrow` (layout.css) setzt die Marge am LETZTEN Slot und
  // trifft damit das Ende der Zeile statt der Slot-Breiten.
  const narrowBody = /class(?:Name)?\s*=\s*['"`][^'"`]*\bkitchen-list\b/;
  const pages = walkJsFiles('../public/pages/')
    .filter((file) => narrowBody.test(read(file)));
  assert.ok(pages.length >= 3, 'keine Seite mit .kitchen-list gefunden - Scan ist blind geworden');

  for (const file of pages) {
    const src = read(file);
    // Jeder Kopf dieser Seite, egal ob als Template-Literal oder über className.
    const heads = [
      ...src.matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g),
      ...src.matchAll(/className\s*=\s*'([^']*\bpage-toolbar\b[^']*)'/g),
    ].map(([, classList]) => classList);
    assert.ok(heads.length > 0, `${file}: kappt den Körper auf das Lesemaß, hat aber keinen kanonischen Kopf`);
    for (const classList of heads) {
      assert.ok(
        /\bpage-toolbar--narrow\b/.test(classList),
        `${file}: "${classList}" - der Körper endet bei --content-max-width-narrow, `
        + 'der Kopf muss dieselbe Kante halten (page-toolbar--narrow)',
      );
    }
  }

  // Und die Variante muss das auch tun: Marge am letzten Slot, gegen dasselbe
  // Token, das .kitchen-list kappt.
  const layout = stripCssComments(read('../public/styles/layout.css'));
  assert.match(
    layout,
    /\.page-toolbar--narrow\s*>\s*:last-child\s*\{[^}]*margin-inline-end:\s*max\(\s*0px,\s*calc\(100% - var\(--content-max-width-narrow\)\)\s*\)/,
    'layout.css: .page-toolbar--narrow muss den letzten Slot auf --content-max-width-narrow zurückholen',
  );
  // Ohne Breakpoint: .kitchen-list kappt unbedingt, der Kopf muss das auch.
  // Der Vorgänger stand in `@media (min-width: 1024px)` und ließ den Versatz
  // zwischen 720px und 1024px stehen (gemessen 148px bei 900px Fensterbreite).
  for (const file of ['shopping.css', 'pantry.css', 'recipes.css', 'kitchen-row.css']) {
    assert.doesNotMatch(
      stripCssComments(read(`../public/styles/${file}`)),
      /page-toolbar[^{]*>\s*\*\s*\{[^}]*max-width/,
      `${file}: Slot-Breiten kappen holt den Kopf nicht zurück - das macht .page-toolbar--narrow`,
    );
  }
});

test('module-head families stay split: in-page tabs vs route clusters', () => {
  // Familie 1: page-toolbar-Kopf + wireTablist, keine sub-tabs-bar.
  for (const mod of ['budget', 'housekeeping', 'rewards']) {
    const src = read(`../public/pages/${mod}.js`);
    assert.match(src, /wireTablist/, `${mod}: erwartet wireTablist (In-Page-Tab-Familie)`);
    assert.match(src, /<h1 class="page-toolbar__title"/, `${mod}: erwartet sichtbares <h1 page-toolbar__title>`);
    assert.match(src, /role="tablist"/, `${mod}: Tabs tragen role="tablist" im page-toolbar`);
    assert.doesNotMatch(src, /renderSubTabs\b/, `${mod}: In-Page-Tab-Familie nutzt keine sub-tabs-bar`);
  }

  // Familie 2: geteilte sub-tabs-bar via renderSubTabs, sichtbarer Titel in der
  // Leiste, separates sr-only <h1> als semantische Überschrift.
  const healthTabs = read('../public/utils/health-tabs.js');
  const kitchenTabs = read('../public/utils/kitchen-tabs.js');
  assert.match(healthTabs, /renderSubTabs/, 'health-tabs.js: erwartet renderSubTabs');
  assert.match(healthTabs, /title:\s*t\('nav\.health'\)/, 'health-tabs.js: sichtbarer Inline-Titel in der Leiste');
  assert.match(kitchenTabs, /renderSubTabs/, 'kitchen-tabs.js: erwartet renderSubTabs');

  const health = read('../public/pages/health.js');
  assert.match(health, /renderHealthTabsBar/, 'health: erwartet renderHealthTabsBar');
  assert.match(health, /<h1 class="sr-only">/, 'health: sr-only <h1> (die sub-tabs-bar trägt den sichtbaren Titel)');
  // Präzise auf den Import des geteilten wireTablist-Utils prüfen — der lokale
  // Helfer `wireTablistKeys` (Panel-interne Pfeiltasten) ist bewusst unberührt.
  assert.doesNotMatch(health, /from '\/utils\/tablist\.js'/, 'health bleibt Routen-Cluster (kein wireTablist-Util-Import)');

  // Der Interaktions-Baustein dokumentiert den bewussten Split (eine Grammatik,
  // zwei Layout-Familien) — damit der Guard eine benannte Quelle hat.
  const tablist = read('../public/utils/tablist.js');
  assert.match(tablist, /renderSubTabs/, 'tablist.js dokumentiert die Abgrenzung zu renderSubTabs');
});

// #565: Element.scrollIntoView() beim aktiven Tab scrollt jeden scrollbaren
// Vorfahren mit — auch overflow:hidden-Container wie .calendar-page, die per JS
// scrollbar bleiben, aber weder Scrollbar noch Touch zum Zurückscrollen bieten.
// Auf schmalen Viewports kippte das die ganze Kalenderseite horizontal weg.
// Der Guard hält die Leiste beim reinen Container-Scroll (nur scrollLeft).
test('wireTablist scrolls only its own bar, never via scrollIntoView (#565)', () => {
  const tablist = read('../public/utils/tablist.js');
  assert.doesNotMatch(
    tablist,
    /\.scrollIntoView\(/,
    'tablist.js darf scrollIntoView() nicht nutzen — es scrollt overflow:hidden-Vorfahren mit (#565)',
  );
  assert.match(
    tablist,
    /container\.scrollLeft/,
    'tablist.js muss den aktiven Tab durch container-eigenes scrollLeft ins Bild holen',
  );
});

test('priority badges and meal labels meet WCAG AA contrast in both themes', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = tokens.match(/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [key, value] of parseTokenMap(darkBlock[1])) dark.set(key, value);

  const pairs = [
    ['--color-priority-low', '--color-priority-low-bg'],
    ['--color-priority-medium', '--color-priority-medium-bg'],
    ['--color-priority-high', '--color-priority-high-bg'],
    ['--color-priority-urgent', '--color-priority-urgent-bg'],
  ];

  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    const surface = resolveColor('--color-surface-work', map);
    for (const [foregroundToken, backgroundToken] of pairs) {
      const foreground = resolveColor(foregroundToken, map);
      const background = compositeColor(resolveColor(backgroundToken, map), surface);
      const ratio = contrastRatio(foreground, background);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${foregroundToken} on ${backgroundToken} is ${ratio.toFixed(2)}:1`,
      );
    }

    for (const mealToken of ['--meal-breakfast', '--meal-lunch', '--meal-dinner', '--meal-snack']) {
      const mealColor = resolveColor(mealToken, map);
      const mealRatio = contrastRatio(mealColor, surface);
      assert.ok(mealRatio >= 4.5, `${theme}: ${mealToken} is ${mealRatio.toFixed(2)}:1`);
    }
  }
});

/**
 * Locks in the Tandoor badge contrast fix from the recipe-provider-adapter
 * review (was 4.24:1, below WCAG AA). Discovers the provider list from the
 * actual `.source-badge--<provider>` CSS rules in recipes.css instead of
 * hardcoding 'mealie'/'tandoor' here — a future third provider's badge falls
 * under this same check automatically, without this test needing an edit.
 */
test('recipe provider source badges meet WCAG AA contrast in both themes', () => {
  const recipesCss = read('../public/styles/recipes.css');
  const providers = [...recipesCss.matchAll(
    /\.source-badge--([\w-]+)\s*\{\s*background:\s*var\(--source-\1-light\);\s*color:\s*var\(--source-\1\);\s*\}/g,
  )].map((m) => m[1]);
  assert.ok(providers.length >= 2, `expected at least the mealie/tandoor badge rules, found ${providers.length}`);

  const { light, dark } = themeTokenMaps();
  for (const [theme, map] of [['light', light], ['dark', dark]]) {
    for (const provider of providers) {
      const foreground = resolveColor(`--source-${provider}`, map);
      const background = resolveColor(`--source-${provider}-light`, map);
      assert.ok(foreground && background, `${theme}: --source-${provider}/-light must resolve to hex colors`);
      const ratio = contrastRatio(foreground, background);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --source-${provider} (${foreground}) on --source-${provider}-light (${background}) ` +
        `is ${ratio.toFixed(2)}:1, below WCAG AA 4.5:1`,
      );
    }
  }
});

test('budget bars animate with transforms instead of layout-driving widths', () => {
  const budgetPage = read('../public/pages/budget.js');
  const budgetCss = read('../public/styles/budget.css');

  assert.doesNotMatch(budgetCss, /transition:\s*width/);
  assert.match(budgetCss, /\.budget-bar-row__fill\s*\{[\s\S]*transform:\s*scaleX\(var\(--bar-scale,\s*0\)\)[\s\S]*transition:\s*transform/);
  assert.match(budgetCss, /\.budget-loan-card__progress span\s*\{[\s\S]*transform:\s*scaleX\(var\(--bar-scale,\s*0\)\)/);
  assert.match(budgetPage, /style="--bar-scale:\$\{pct\s*\/\s*100\}"/);
  assert.match(budgetPage, /style="--bar-scale:\$\{paidPct\s*\/\s*100\}"/);
  assert.doesNotMatch(budgetPage, /style="width:\$\{(?:pct|paidPct)\}%/);
});

test('dashboard and task progress bars animate with transforms instead of widths', () => {
  const dashboardPage = read('../public/pages/dashboard.js');
  const dashboardCss = read('../public/styles/dashboard.css');
  const tasksPage = read('../public/pages/tasks.js');
  const tasksCss = read('../public/styles/tasks.css');

  assert.match(
    dashboardCss,
    /\.shopping-widget-list__bar\s*\{[\s\S]*transform-origin:\s*left[\s\S]*transform:\s*scaleX\(var\(--progress-scale,\s*0\)\)[\s\S]*transition:\s*transform/,
  );
  assert.doesNotMatch(cssRuleBody(dashboardCss, '.shopping-widget-list__bar'), /transition:\s*width/);
  assert.match(dashboardPage, /style="--progress-scale:\$\{progress\s*\/\s*100\}"/);
  assert.doesNotMatch(dashboardPage, /shopping-widget-list__bar" style="width:/);

  assert.match(
    tasksCss,
    /\.subtask-progress__bar-fill\s*\{[\s\S]*transform-origin:\s*left[\s\S]*transform:\s*scaleX\(var\(--progress-scale,\s*0\)\)[\s\S]*transition:\s*transform/,
  );
  assert.doesNotMatch(cssRuleBody(tasksCss, '.subtask-progress__bar-fill'), /transition:\s*width/);
  assert.match(tasksPage, /style="--progress-scale:\$\{progress\s*\/\s*100\}"/);
  assert.doesNotMatch(tasksPage, /subtask-progress__bar-fill" style="width:/);
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

// Der Split-Tab lebt eingebettet im Budget: die ausgeklappte Sidebar zieht rund
// 345px ab, sodass bei 1024px Viewport nur ~680px übrig bleiben. Eine
// Viewport-Query bei 1023px hielt das Kartenraster dort zweispaltig, die
// Salden-Karte schrumpfte auf 120px und „vereinfachte Schulden" schob sich über
// die Nachbarkarte. Der Guard pinnt beide Container-Ebenen (die Seite steuert
// das Panel-Layout, der Hauptbereich das Kartenraster) und hält die verbleibenden
// Viewport-Queries auf echte Geräte-Entscheidungen begrenzt.
test('split expenses reflows from container width, not viewport width', () => {
  const split = read('../public/styles/split-expenses.css');

  assert.match(
    cssRuleBody(split, '.split-page'),
    /container:\s*split-page\s*\/\s*inline-size/,
    '.split-page muss ein inline-size-Container sein (Gast-Route und Budget-Tab teilen die Regeln)',
  );
  assert.match(
    cssRuleBody(split, '.split-main'),
    /container:\s*split-main\s*\/\s*inline-size/,
    '.split-main braucht eine eigene Ebene — es steht hinter dem Gruppen-Panel und hat weniger Platz als .split-page',
  );

  assert.match(
    split,
    /@container split-page \(max-width:\s*719px\)[\s\S]*\.split-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    '.split-layout stapelt nach eigener Breite; minmax(0, 1fr) verhindert, dass die 240px-Gruppenkachel die Spalte aufbläht',
  );
  assert.match(
    split,
    /@container split-main \(max-width:\s*639px\)[\s\S]*\.split-content-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    'das Kartenraster stapelt nach der Breite von .split-main, nicht nach dem Viewport',
  );
  // cssRuleBody träfe die geteilte Glass-Regel weiter oben; hier ist die
  // eigenständige .split-groups-panel-Regel gemeint.
  assert.match(
    split,
    /\n\.split-groups-panel\s*\{[^}]*min-width:\s*0/,
    'Grid-Items haben min-width: auto — ohne 0 schiebt die Gruppen-Leiste die Seite über ihren Rand',
  );
  assert.match(
    cssRuleBody(split, '.split-card-head'),
    /flex-wrap:\s*wrap/,
    'Titel und Zusatz der Kartenköpfe brechen um, statt in die Nachbarkarte zu laufen',
  );

  assert.doesNotMatch(
    split,
    /@media \(max-width:\s*1023px\)/,
    'Spaltenumbrüche gehören in @container-Queries — der 1023px-Breakpoint misst den Viewport statt den verfügbaren Platz',
  );
  // Was an @media bleiben darf: Seitengutter und Bottom-Nav-Freiraum sind echte
  // Geräte-Entscheidungen, keine Reflows nach verfügbarer Breite.
  assert.doesNotMatch(
    split,
    /@media[^{]*\{[\s\S]*grid-template-columns/,
    'kein Raster darf mehr an einer Viewport-Query hängen',
  );
});

// Der Aktivitäts-Feed übersetzt über `splitExpenses.activityType.<type>`, wobei
// <type> ungeprüft aus der DB-Spalte kommt. Fehlt der Key, rendert t() den Key
// selbst (i18n.js: `?? key`) — im Feed stand so sichtbar
// „splitExpenses.activityType.expense_added". Ursache waren zwei Typen, die nur
// scripts/seed-demo.js erfand (expense_added, settlement_added), plus eine echte
// Lücke: member_removed schreibt der Server seit jeher, übersetzt war es nie.
// Handgepflegte Listen haben das nicht gefunden — dieser Guard leitet die Typen
// aus dem Quellcode ab, damit jeder neue activity()-Aufruf seinen Key erzwingt.
test('split activity feed translates every type the backend writes', () => {
  const sources = {
    'server/routes/split-expenses.js': read('../server/routes/split-expenses.js'),
    'server/services/split-expenses-scheduler.js': read('../server/services/split-expenses-scheduler.js'),
    'scripts/seed-demo.js': read('../scripts/seed-demo.js'),
  };

  // activity(groupId, actor, 'type', …) bzw. insertActivity(db, …, 'type', …).
  // Der Typ ist das String-Literal vor dem entity_type-Argument; ein Aufruf
  // wählt ihn per Ternary (recurring_resumed/recurring_paused), daher der
  // optionale Vorlauf-Zweig.
  const ENTITY_TYPES = String.raw`'(?:expense|group|member|settlement|recurring_expense)'`;
  const found = new Map();
  for (const [file, src] of Object.entries(sources)) {
    const pattern = new RegExp(String.raw`(?:'([a-z_]+)'\s*:\s*)?'([a-z_]+)',\s*${ENTITY_TYPES}`, 'g');
    for (const [, ternaryBranch, type] of src.matchAll(pattern)) {
      for (const found_type of [ternaryBranch, type]) {
        if (found_type && !found.has(found_type)) found.set(found_type, file);
      }
    }
  }

  // Ein zu kleiner Treffersatz hieße, das Regex passt nicht mehr auf den
  // Quellcode — der Guard wäre dann still wirkungslos statt rot.
  assert.ok(found.size >= 15, `erwartet mindestens 15 Aktivitätstypen, gefunden: ${[...found.keys()].join(', ')}`);

  const de = JSON.parse(read('../public/locales/de.json'));
  const translated = Object.keys(de.splitExpenses.activityType);

  const untranslated = [...found].filter(([type]) => !translated.includes(type));
  assert.deepEqual(
    untranslated.map(([type, file]) => `${type} (${file})`),
    [],
    'jeder geschriebene Aktivitätstyp braucht splitExpenses.activityType.<type> — sonst rendert der Feed den rohen Key',
  );

  // Gegenrichtung: übersetzte Typen, die niemand schreibt, sind entweder tot
  // oder ein Tippfehler gegenüber dem, was der Server tatsächlich einträgt.
  const unwritten = translated.filter((type) => !found.has(type));
  assert.deepEqual(unwritten, [], 'verwaiste activityType-Keys — kein Codepfad schreibt diesen Typ');
});

// ============================================================
// Konsistenz-Audit (UX/UI): Invarianten, die der Audit hergestellt hat.
// Jeder Guard hier hält genau einen Befund geschlossen — die Befunde
// entstanden alle in Bereichen, in denen vorher kein Test hinsah.
// ============================================================

function stylesheetFiles() {
  return readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((file) => file.endsWith('.css'))
    .map((file) => ({ file, css: read(`../public/styles/${file}`) }));
}

test('Viewport-Breakpoints halten den Kontrakt aus tokens.css §11c', () => {
  // Vier strukturelle Grenzen plus ihre max-width-Komplemente. Alles andere
  // ist eine private Schwelle, an der genau ein Modul anders umbricht als der
  // Rest der App. Komponenten-interne Umbrüche gehören in @container-Queries
  // (die dieser Guard bewusst nicht anfasst) oder in fluide clamp()-Werte.
  const allowed = new Set([639, 640, 767, 768, 1023, 1024, 1439, 1440]);
  const offenders = [];

  for (const { file, css } of stylesheetFiles()) {
    for (const match of css.matchAll(/@media[^{]*?\((?:min|max)-width:\s*(\d+)px\)/g)) {
      const px = Number(match[1]);
      if (!allowed.has(px)) {
        const line = css.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} → ${px}px`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'nicht-kanonischer Viewport-Breakpoint — erlaubt sind nur 640/768/1024/1440 (+ Komplemente)',
  );
});

test('Icon-Größen kommen aus der Utility-Skala, nie aus Inline-Styles', () => {
  const offenders = [];
  for (const path of walkFrontendFiles('../public/pages/')
    .concat(walkFrontendFiles('../public/settings/'))
    .concat(walkFrontendFiles('../public/components/'))
    .concat(walkFrontendFiles('../public/utils/'))) {
    const src = read(path);
    // <i data-lucide="…"> mit inline gesetzter Breite/Höhe im selben Tag
    for (const match of src.matchAll(/<i\b[^>]*data-lucide[^>]*>/g)) {
      if (/(?:style="[^"]*(?:width|height)|(?:^|\s)(?:width|height)=)/.test(match[0])) {
        const line = src.slice(0, match.index).split('\n').length;
        offenders.push(`${path}:${line}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Icon-Größe inline gesetzt — icon-sm/md/lg/xl verwenden (Werte: --icon-* in tokens.css)',
  );
});

test('die Icon-Skala hat genau einen Namen pro Stufe', () => {
  const layout = read('../public/styles/layout.css');
  const tokens = read('../public/styles/tokens.css');

  const sizes = new Map();
  for (const match of layout.matchAll(/^\.(icon-[a-z0-9]+)\s*\{([^}]*)\}/gm)) {
    const width = match[2].match(/width:\s*var\((--icon-[a-z]+)\)/);
    assert.ok(width, `${match[1]} muss seine Breite aus einem --icon-*-Token ziehen`);
    sizes.set(match[1], width[1]);
  }

  assert.deepEqual(
    [...sizes.keys()].sort(),
    ['icon-lg', 'icon-md', 'icon-sm', 'icon-xl'],
    'genau vier Icon-Klassen — frühere Aliase (.icon-xs/.icon-11/.icon-base/.icon-2xl) trugen dieselben Werte',
  );

  // Kein Token doppelt belegt: sonst sind zwei Klassennamen wieder dieselbe Größe.
  const used = [...sizes.values()];
  assert.equal(new Set(used).size, used.length, 'zwei Icon-Klassen zeigen auf dasselbe --icon-*-Token');

  const values = used.map((token) => {
    const declared = tokens.match(new RegExp(`\\${token}:\\s*(\\d+)px`));
    assert.ok(declared, `${token} fehlt in tokens.css`);
    return Number(declared[1]);
  });
  assert.equal(new Set(values).size, values.length, 'zwei --icon-*-Tokens haben denselben px-Wert');
});

test('Dialoge laufen über die Modal-Komponente, nicht über native Browser-Dialoge', () => {
  // window.confirm blockiert den Thread, ignoriert das Design-System, hat
  // keinen Fokus-Trap und keine Danger-Farbe. confirmModal/promptModal/
  // selectModal aus components/modal.js decken alle Fälle ab.
  const native = /(?:\bwindow\.(?:confirm|alert|prompt)\s*\(|(?:^|[^.\w])(?:confirm|alert|prompt)\s*\()/;
  const offenders = [];

  for (const path of walkFrontendFiles('../public/pages/')
    .concat(walkFrontendFiles('../public/settings/'))
    .concat(walkFrontendFiles('../public/components/'))
    .concat(walkFrontendFiles('../public/utils/'))) {
    read(path).split('\n').forEach((line, index) => {
      if (native.test(line)) offenders.push(`${path}:${index + 1}`);
    });
  }

  assert.deepEqual(offenders, [], 'nativer Browser-Dialog — confirmModal/promptModal aus components/modal.js verwenden');
});

test('border-radius wird ausschließlich über Radius-Tokens gesetzt', () => {
  const offenders = [];
  for (const { file, css } of stylesheetFiles()) {
    if (file === 'tokens.css') continue;
    for (const match of css.matchAll(/border-radius(?:-[a-z-]+)?:\s*([^;}]+)/g)) {
      const value = match[1].trim();
      if (/^(0|none|inherit|initial|unset)$/.test(value)) continue;
      if (/%|var\(--radius|var\(--lg-card-radius/.test(value)) continue;
      const line = css.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line} → ${value}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'roher border-radius — --radius-* aus tokens.css verwenden (calc(var(--radius-x) ± Npx) ist erlaubt)',
  );
});

test('der neutralisierte Modal-Footer ist eine Klasse, kein Inline-Style', () => {
  // Zwanzig Stellen bauten border/padding/margin desselben Footers inline nach —
  // mit drei verschiedenen Abständen (space-4/5/6) für dieselbe Rolle.
  const offenders = [];
  for (const path of walkFrontendFiles('../public/pages/')
    .concat(walkFrontendFiles('../public/settings/'))
    .concat(walkFrontendFiles('../public/components/'))) {
    const src = read(path);
    for (const match of src.matchAll(/<div[^>]*modal-panel__footer[^>]*>/g)) {
      if (/style="/.test(match[0])) {
        offenders.push(`${path}:${src.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'Modal-Footer inline neutralisiert — modal-panel__footer--plain verwenden');

  const layout = read('../public/styles/layout.css');
  assert.match(
    layout,
    /\.modal-panel__footer\.modal-panel__footer--plain\s*\{/,
    'die --plain-Variante braucht Spezifität (0,2,0), sonst gewinnt die Basisregel',
  );
});

// Vier Primitives standen für dieselbe Boolean-Entscheidung nebeneinander:
// `toggle-row`, `settings-toggle`, der iOS-Switch aus `toggle`/`toggle__track`
// und nackte Checkboxen (Critique 2026-07-27). Ursache war die Lücke im
// Komponenten-Set - solange `components.js` keinen Schalter anbot, erfand jedes
// neue Blatt eine weitere Variante.
test('Settings-Schalter kommen aus createToggleRow, nicht aus handgeschriebenem Markup', () => {
  const components = read('../public/settings/components.js');
  assert.match(components, /export function toggleRowHtml\(/);
  assert.match(components, /export function createToggleRow\(/);

  const offenders = [];
  for (const path of walkFrontendFiles('../public/settings/')) {
    if (path.endsWith('components.js')) continue;
    const src = read(path);

    // Handgeschriebenes `<label class="toggle-row">` und die drei Ausweich-
    // Primitives sind ab hier Bugs.
    for (const pattern of [
      /<label[^>]*class="[^"]*\btoggle-row\b/g,
      /class="[^"]*\bsettings-toggle\b/g,
      /class="[^"]*\btoggle__track\b/g,
    ]) {
      for (const match of src.matchAll(pattern)) {
        offenders.push(`${path}:${src.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'Schalter über toggleRowHtml()/createToggleRow() bauen');

  // Und die tote Klasse darf nicht zurückkommen: `settings-notice` stand in
  // admin-email im Markup, ohne je in public/styles/ definiert zu sein.
  const styles = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((file) => file.endsWith('.css'))
    .map((file) => read(`../public/styles/${file}`))
    .join('\n');
  assert.ok(!styles.includes('.settings-notice'), 'settings-notice ist keine echte Klasse');
  for (const path of walkFrontendFiles('../public/settings/')) {
    assert.ok(
      !/class(Name)?\s*=\s*["'][^"']*\bsettings-notice\b/.test(read(path)),
      `${path} referenziert die klassenlose settings-notice`,
    );
  }
});

// Neun Blätter holten `GET /preferences` jeweils selbst; fünf Blattwechsel
// kosteten fünf identische Requests (Critique 2026-07-27).
test('Settings-Blätter lesen und schreiben Preferences über den geteilten Cache', () => {
  const offenders = [];
  for (const path of walkFrontendFiles('../public/settings/')) {
    if (path.endsWith('preferences-cache.js')) continue;
    const src = read(path);
    for (const match of src.matchAll(/api\.(get|put)\(\s*['"]\/preferences['"]/g)) {
      offenders.push(`${path}:${src.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], 'getPreferences()/savePreferences() aus preferences-cache.js verwenden');

  const cache = read('../public/settings/preferences-cache.js');
  assert.match(cache, /export function resetPreferencesCache\(/);
  // Der Cache muss beim Schreiben fallen, sonst rendert das nächste Blatt einen
  // Stand, den der Server nicht mehr hat.
  assert.match(cache, /finally\s*\{\s*pending = null;/);

  // Und die Shell muss ihn beim Mounten einer frischen Shell verwerfen.
  assert.match(read('../public/settings/shell.js'), /resetPreferencesCache\(\)/);
});

// Ein fehlender Import ist im Blatt ein ReferenceError zur Render-Zeit, den
// keine Quelltext-Assertion sieht: das Blatt landet im Retry-State, die Suite
// bleibt grün. Genau so ist toggleRowHtml in modules-navigation durchgerutscht.
test('jedes Settings-Blatt importiert die geteilten Helfer, die es aufruft', () => {
  const sharedModules = [
    'components.js',
    'preferences-cache.js',
    'weather-location.js',
    'module-order.js',
    'currency.js',
    'region-presets.js',
  ];
  const owners = new Map();
  for (const mod of sharedModules) {
    const src = read(`../public/settings/${mod}`);
    for (const match of src.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)) {
      owners.set(match[1] ?? match[2], mod);
    }
  }
  assert.ok(owners.has('toggleRowHtml'), 'Der Guard braucht die Export-Liste, sonst prüft er nichts');

  const missing = [];
  for (const path of walkFrontendFiles('../public/settings/')) {
    if (sharedModules.some((mod) => path.endsWith(mod))) continue;
    const src = read(path);
    const imported = new Set(
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from/gs)]
        .flatMap((match) => match[1].split(','))
        .map((part) => part.trim().split(/\s+as\s+/).pop().trim())
        .filter(Boolean),
    );
    for (const [name, mod] of owners) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(src) && !imported.has(name)) {
        missing.push(`${path}: ruft ${name}() aus ${mod}, importiert es aber nicht`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// Rechtevergabe war bei 390px die schlechteste Flaeche in Settings, ausgerechnet
// bei der Aufgabe mit den groessten sozialen Folgen: 32px-Chips, 32px-Modus-
// umschalter und 34x30px-Zugriffsstufen, deren Klartext nur im `title` stand -
// und `title` erscheint auf Touch nie (Critique 2026-07-27).
test('Rechtevergabe ist auf dem Telefon beschriftet und mit dem Finger bedienbar', () => {
  const source = read('../public/settings/pages/admin-permissions.js');
  // Der Klartext muss im Markup stehen, nicht nur in title/aria-label.
  assert.match(source, /<span class="perm-seg__label">\$\{esc\(o\.label\)\}<\/span>/);
  // aria-label bleibt der spezifischere Name ("Kalender: Kein Zugriff") und
  // enthaelt den sichtbaren Text - sonst bricht WCAG 2.5.3 (Label in Name).
  assert.match(source, /aria-label="\$\{esc\(label \|\| group\)\}: \$\{esc\(o\.label\)\}"/);

  const css = read('../public/styles/settings.css');
  // Die Grenze ist NICHT der Mobile-Breakpoint: iPad Portrait ist 768px, dort
  // galt die kompakte Icon-Variante wieder (gemessen bei 820px: 59 Segmente
  // à 34x30px). `pointer: coarse` deckt das Tablet im Querformat.
  const touchQuery = '@media (max-width: 1023px), (pointer: coarse)';
  assert.ok(css.includes(touchQuery), 'Touch endet nicht bei 767px');
  const mobile = css.slice(css.indexOf(touchQuery, css.indexOf('.perm-modeswitch {')));
  assert.ok(mobile.includes('.perm-seg__label'), 'Der Touch-Block muss das Label sichtbar schalten');
  assert.match(mobile, /\.perm-modeswitch__btn,\s*\.perm-chip \{ min-height: var\(--target-base\); \}/);
  assert.match(mobile, /\.perm-seg__opt \{[^}]*min-height: var\(--target-base\);/s);
  // Gestapelt statt segmentiert: vier Stufen mit Wort passen bei 390px nicht
  // neben den Modulnamen.
  assert.match(mobile, /\.perm-row \{[^}]*flex-direction: column;/s);
  assert.match(mobile, /\.perm-seg \{[^}]*grid-template-columns: repeat\(var\(--seg-count, 3\), 1fr\);/s);

  // Am Zeiger bleibt es kompakt: das Label ist dort ausgeblendet.
  assert.match(css, /\.perm-seg__label \{ display: none; \}/);
});

// "Automatische Backups" mit Titel, Hinweis und leerem Inhalt liest sich als
// "es gibt keine" - die gefaehrlichste Fehldeutung auf einer Backup-Seite.
// Beide Ladepfade schrieben den Fehler nur in die Konsole (Critique
// 2026-07-27), waehrend admin-system es nebenan richtig machte.
test('admin-backup sagt bei Ladefehlern, dass der Stand unbekannt ist', () => {
  const source = read('../public/settings/pages/admin-backup.js');
  assert.match(source, /import \{[\s\S]*?createRetryState[\s\S]*?\} from '\/settings\/components\.js'/);

  // Kein catch darf nur noch loggen.
  const silentCatches = [...source.matchAll(/catch \((\w+)\) \{\s*console\.error\([^)]*\);?\s*\}/g)];
  assert.deepEqual(
    silentCatches.map((m) => m[0].slice(0, 60)),
    [],
    'Ladefehler brauchen einen sichtbaren Zustand, nicht nur console.error',
  );
  assert.equal([...source.matchAll(/createRetryState\(\{/g)].length, 2);

  // Das WebDAV-Formular verschwindet im Fehlerfall: ein leeres Formular sieht
  // aus wie "nichts konfiguriert" und wuerde beim Speichern eine bestehende
  // Verbindung ueberschreiben.
  assert.match(source, /form\.hidden = true;/);

  // ... und `hidden` muss auf der Settings-Flaeche auch wirken: `.settings-form`
  // setzt display:flex mit derselben Spezifitaet wie das UA-`[hidden]` und
  // stand spaeter im Stylesheet, also blieb das Formular sichtbar.
  assert.match(
    read('../public/styles/settings.css'),
    /\.settings-page \[hidden\] \{ display: none !important; \}/,
  );
});

// Das API-Token ist genau einmal sichtbar und stand in einem readonly Input,
// aus dem es von Hand markiert werden musste - der riskanteste Moment der
// Oberflaeche hatte die schwaechste Behandlung (Critique 2026-07-27).
test('das einmalig sichtbare API-Token laesst sich kopieren', () => {
  const source = read('../public/settings/pages/admin-api.js');
  assert.match(source, /id="api-token-copy"/);
  assert.match(source, /settings\.apiTokenCopy/);
  assert.match(source, /navigator\.clipboard\?\.writeText\(value\)/);
  assert.match(source, /settings\.apiTokenCopied/);
  // Der Lucide-Platzhalter im erst spaeter eingeblendeten Block braucht seinen
  // eigenen createIcons-Aufruf.
  assert.match(source, /window\.lucide\?\.createIcons\(\{ el: output \}\)/);
  assertKeysExistInEveryLocale(['settings.apiTokenCopy', 'settings.apiTokenCopied', 'email.saveFailed']);
});

// `housekeeping.deleteTaskConfirm` schrieb `{name}` statt `{{name}}` - in allen
// 23 Locales. Der Loesch-Dialog der Haushaltshilfe zeigte woertlich
// `Aufgabe "{name}" wirklich loeschen?` (public/pages/housekeeping.js:507).
// Der Guard prueft die ganze Klasse, nicht den einen Key.
test('kein Locale-String traegt einen einfach geklammerten Platzhalter', () => {
  const offenders = [];
  for (const file of readdirSync(new URL('../public/locales/', import.meta.url)).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(read(`../public/locales/${file}`));
    const walk = (node, path) => {
      for (const [key, value] of Object.entries(node)) {
        const at = path ? `${path}.${key}` : key;
        if (typeof value === 'string') {
          // `{x}` ohne doppelte Klammern - t() interpoliert nur `{{x}}`.
          const single = value.match(/(?<!\{)\{[a-zA-Z_][a-zA-Z0-9_]*\}(?!\})/g);
          if (single) offenders.push(`${file}: ${at} -> ${single.join(', ')}`);
        } else if (value && typeof value === 'object') {
          walk(value, at);
        }
      }
    };
    walk(data, '');
  }
  assert.deepEqual(offenders, []);
});

test('settings.css haelt Zeilenlaenge, Token-Disziplin und keine toten Regeln', () => {
  const css = read('../public/styles/settings.css');

  // Fließtext lief ueber die volle Content-Spalte (gemessene 794-896px bei
  // 1440px). Der Wert ist an echtem Satztext kalibriert, siehe Kommentar dort.
  assert.match(
    css,
    /\.settings-page \.form-hint,\s*\.settings-page \.settings-card-description,\s*\.settings-page \.settings-leaf-header__description \{\s*max-width: 50ch;/,
  );

  // 23x `1px solid` gegen 21x `var(--space-px) solid` in derselben Datei.
  assert.equal([...css.matchAll(/\b1px solid\b/g)].length, 0, 'Rahmenbreite kommt aus --space-px');

  // Tote Regeln: der Mobile-Override auf einen Breadcrumb, der unter 768px
  // `display: none` ist, und eine Klasse, die shell.js nie erzeugt.
  // Auf den Selektor prüfen, nicht auf das Wort: der Kommentar an der Fundstelle
  // nennt die entfernte Klasse absichtlich.
  assert.ok(
    !/^\s*\.settings-breadcrumb__current\b/m.test(css),
    'shell.js erzeugt settings-breadcrumb__item--current, nicht __current',
  );
  const shell = read('../public/settings/shell.js');
  for (const cls of ['settings-breadcrumb__item--current', 'settings-breadcrumb__link']) {
    assert.ok(shell.includes(cls), `${cls} muss im Markup vorkommen, sonst ist die CSS-Regel tot`);
  }

  // Design-Werte gehoeren nicht ins JS.
  const backup = read('../public/settings/pages/admin-backup.js');
  assert.ok(!/\.style\.(opacity|color)\s*=/.test(backup), 'Tone/Opazitaet ueber Klassen, nicht inline');
  assert.match(css, /\.form-hint--success \{ color: var\(--color-success\); \}/);
  assert.match(css, /\.settings-page \.form-input:disabled \{/);
});

// Avatare tragen die Farbe, die sich das Mitglied selbst aussucht; die
// Initialen standen darauf immer in Weiss. Gemessen 3,5:1 auf #ec4899 und
// 2,8:1 auf #f97316 - noetig sind 4,5:1 (Critique 2026-07-27).
test('Avatar-Initialen waehlen die lesbare Textfarbe', async () => {
  const { contrastRatio, prefersInkText } = await import('../public/utils/contrast.js');

  // Die beiden Befund-Farben wechseln auf dunkle Tinte und halten die Schwelle.
  for (const bg of ['#ec4899', '#f97316']) {
    assert.equal(prefersInkText(bg), true, `${bg} traegt Weiss nicht`);
    assert.ok(contrastRatio(bg, '#000000') >= 4.5);
  }

  // Wo Weiss reicht, bleibt es Weiss: kein flaechendeckendes Umfaerben.
  for (const bg of ['#7c3aed', '#2563eb']) {
    assert.equal(prefersInkText(bg), false, `${bg} haelt die Schwelle mit Weiss`);
    assert.ok(contrastRatio(bg, '#ffffff') >= 4.5);
  }

  // Nicht auswertbare Werte fallen auf die Standardfarbe der Komponente zurueck.
  assert.equal(prefersInkText('var(--color-accent)'), false);
  assert.equal(prefersInkText(null), false);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  // Kurzform-Hex muss dasselbe ergeben wie die Langform.
  assert.equal(contrastRatio('#fff', '#000000'), contrastRatio('#ffffff', '#000000'));

  // Und die Blaetter muessen die Utility auch benutzen.
  for (const leaf of ['admin-family', 'personal-account', 'admin-permissions']) {
    const source = read(`../public/settings/pages/${leaf}.js`);
    assert.match(source, /import \{ prefersInkText \} from '\/utils\/contrast\.js'/, `${leaf} importiert sie nicht`);
    assert.match(source, /prefersInkText\(/, `${leaf} ruft sie nicht auf`);
  }
  assert.match(read('../public/styles/settings.css'), /\.settings-avatar--ink,\s*\.perm-chip__avatar--ink \{\s*color: var\(--color-ink-on-bright\);/);
});


// In einer selbstgehosteten Familieninstanz gibt es weder Support noch Undo.
// Wer die Folgen nicht im Dialog liest, liest sie nie - und "{{name}} wirklich
// loeschen?" loeschte einen Menschen, ohne eine davon zu nennen, waehrend der
// harmlosere Budget-Dialog "Zugeordnete Buchungen bleiben erhalten" sagt
// (Critique 2026-07-27, zweiter Lauf).
//
// Der Guard war zuerst eine Allowlist aus fuenf Dateien und deckte damit nicht
// die Regel ab, sondern fuenf Dateien: 25 weitere danger-Dialoge standen ohne
// Folgentext da, ohne dass er anschlug. Er laeuft jetzt ueber ganz public/.
// Acht davon waren `confirmOverModal` - ein Scan, der nur nach `confirmModal(`
// sucht, findet die nie, weil der Name den kuerzeren nicht enthaelt.
//
// `readCall` liest die Argumentliste per Klammer-Balancing statt mit einem
// Fenster fester Laenge. Das Fenster war die zweite Schwachstelle der alten
// Fassung: ein mehrzeiliger Aufruf ragt darueber hinaus, und `detail:` faellt
// still hinten runter - der Test bleibt gruen, der Dialog schweigt trotzdem.
const DIALOG_FNS = ['confirmModal', 'confirmOverModal'];

// Liest ab der oeffnenden Klammer bis zur passenden schliessenden. Strings,
// Template-Literals samt `${}` und Kommentare werden uebersprungen, damit eine
// Klammer im Anzeigetext den Aufruf nicht vorzeitig beendet.
function readCall(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const prev = src[i - 1];
    if (quote) {
      if (c === quote && prev !== '\\') quote = null;
      else if (quote === '`' && c === '{' && prev === '$') {
        let d = 1;
        i++;
        while (i < src.length && d > 0) {
          if (src[i] === '{') d++;
          else if (src[i] === '}') d--;
          i++;
        }
        continue;
      }
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; }
    else if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
    i++;
  }
  return null;
}

// Schneidet aus einer gelesenen Argumentliste das Options-Objekt heraus - das
// letzte Argument der obersten Ebene, das mit `{` beginnt. Ohne diesen Schnitt
// sucht der Guard im ganzen Aufruf, und ein `detail`-Platzhalter in der
// Titel-Interpolation (`confirmModal(t('x', { detail: … }), { danger: true })`)
// wuerde ihn zufriedenstellen, obwohl der Dialog keine Folgen nennt.
function readOptionsArg(call) {
  const inner = call.slice(1, -1);
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote && inner[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
  }
  args.push(inner.slice(start));
  const rest = args.slice(1).map((arg) => arg.trim()).filter(Boolean);
  // Ein Spread im Options-Literal ist genauso undurchsichtig wie eine Variable:
  // `{ ...destructiveOptions }` sieht nach einem lesbaren Objekt aus, waehrend
  // `danger: true` von aussen kommt und der Regex nichts findet.
  const literal = rest.filter((arg) => arg.startsWith('{') && !arg.includes('...')).pop();
  // `null` heisst: es gibt ein Options-Argument, aber es ist von hier aus nicht
  // lesbar (etwa eine Variable). Das darf der Guard nicht als "keine Optionen"
  // verbuchen - sonst faellt `const o = { danger: true }; confirmModal(t, o)`
  // still aus der Pruefung. Der Aufrufer entscheidet, was damit geschieht.
  if (!literal && rest.length) return null;
  return literal ?? '';
}

// Liest den Wert einer Option aus einer gelesenen Argumentliste: ab `name:` bis
// zum Komma, das ihn beendet - Klammern, Strings und Template-Literals werden
// mitgezaehlt, damit ein Komma in `t('key', { count })` nicht vorzeitig trennt.
function readOptionValue(call, name) {
  const at = call.search(new RegExp(`\\b${name}\\s*:`));
  if (at === -1) return '';
  let i = call.indexOf(':', at) + 1;
  const start = i;
  let depth = 0;
  let quote = null;
  for (; i < call.length; i++) {
    const c = call[i];
    if (quote) {
      if (c === quote && call[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return call.slice(start, i);
}

function collectDialogCalls() {
  const base = new URL('../public/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) return walk(child);
    return entry.name.endsWith('.js') ? [child] : [];
  });

  const calls = [];
  for (const file of walk(base)) {
    const src = readFileSync(file, 'utf8').replace(/\r/g, '');
    const label = decodeURIComponent(file.href.slice(base.href.length));
    for (const fn of DIALOG_FNS) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
      let match;
      while ((match = re.exec(src)) !== null) {
        // JSDoc- und Kommentarzeilen nennen die Funktionen ebenfalls, und die
        // Definition selbst ist kein Aufruf: `export async function
        // confirmOverModal(message, opts = {})` sah sonst wie ein Dialog aus,
        // dessen Optionen nicht lesbar sind.
        const lineStart = src.lastIndexOf('\n', match.index) + 1;
        const vorText = src.slice(lineStart, match.index);
        if (/^\s*(\*|\/\/)/.test(vorText)) continue;
        if (/\bfunction\s+$/.test(vorText)) continue;
        const call = readCall(src, match.index + match[0].length - 1);
        const line = src.slice(0, match.index).split('\n').length;
        calls.push({ file: label, line, fn, call });
      }
    }
  }
  return calls;
}

test('jeder als gefaehrlich markierte Dialog nennt seine Folgen', () => {
  const calls = collectDialogCalls();
  // Reisst der Scanner, ist das ein Befund und kein Grund, still nichts zu
  // pruefen - sonst faellt der Guard bei einem Syntaxfehler auf null Dialoge.
  const unparsed = calls.filter((c) => c.call === null);
  assert.deepEqual(unparsed.map((c) => `${c.file}:${c.line}`), [],
    'Aufruf liess sich nicht bis zur schliessenden Klammer lesen');
  assert.ok(calls.length >= 40, `Scanner findet nur ${calls.length} Dialoge - laeuft er noch ueber public/?`);

  // Ab hier zaehlt nur noch das Options-Objekt, nicht der ganze Aufruf.
  const mitOptionen = calls.map((c) => ({ ...c, options: readOptionsArg(c.call) }));

  // Ein Options-Argument, das der Guard nicht lesen kann (eine Variable etwa),
  // faellt sonst lautlos aus der Pruefung - `danger: true` waere dort
  // unsichtbar. Ausgenommen ist die Datei, die die Dialoge selbst definiert:
  // dort IST das Durchreichen fremder Optionen die Implementierung. Das ist
  // eine Eigenschaft des Moduls, keine Namensliste - wer `confirmModal`
  // exportiert, ist die Definitionsstelle.
  const undurchsichtig = mitOptionen.filter((c) => {
    if (c.options !== null) return false;
    const src = readFileSync(new URL(`../public/${c.file}`, import.meta.url), 'utf8');
    return !new RegExp(`export (async )?function ${c.fn}\\b`).test(src);
  });
  assert.deepEqual(
    undurchsichtig.map((c) => `${c.file}:${c.line} (${c.fn})`),
    [],
    'Die Optionen des Dialogs stehen nicht als Objektliteral im Aufruf. So laesst sich '
    + 'nicht pruefen, ob er danger: true traegt - schreib sie direkt in den Aufruf.',
  );

  const gefaehrlich = mitOptionen.filter((c) => /\bdanger\s*:\s*true\b/.test(c.options ?? ''));
  assert.ok(gefaehrlich.length >= 30, `nur ${gefaehrlich.length} danger-Dialoge gefunden`);

  const ohneFolgen = gefaehrlich.filter((c) => !/\bdetail\s*:/.test(c.options));
  assert.deepEqual(
    ohneFolgen.map((c) => `${c.file}:${c.line} (${c.fn})`),
    [],
    'danger: true ohne detail - der Dialog sagt nicht, was er zerstoert. Nennt er keine '
    + 'unwiederbringliche Folge, gehoert danger: true weg statt ein erfundener Detailtext hin.',
  );

  // Jeder Folgentext kommt aus t(), nicht aus einem hartkodierten String. Der
  // Wert wird bis zum trennenden Komma gelesen statt per Regex: `detail` ist
  // nicht immer ein blankes t() - subscriptions.js setzt einen Grundtext und
  // haengt bei belegten Kategorien die Nutzungswarnung davor. Beide Zweige
  // muessen einen Key nennen, ein `: null` faellt damit auf.
  // Grenze: ueber eine Variable eingeschleuste Texte sieht der Guard nicht.
  const detailKeys = new Set();
  for (const call of gefaehrlich) {
    const value = readOptionValue(call.options, 'detail');
    const keys = [...value.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
    // `t(this._…Key)` ist die zulaessige zweite Form: eine geteilte Komponente,
    // deren Folgen erst der Aufrufer kennt. Wer so delegiert, wird vom Guard
    // darunter geprueft - dort, wo die Keys tatsaechlich gesetzt werden.
    const delegiert = /\bt\(\s*this\._\w*[Kk]ey\b/.test(value);
    assert.ok(keys.length || delegiert,
      `${call.file}:${call.line}: detail muss aus t('key') kommen, ist aber \`${value.trim()}\``);
    assert.ok(!/(^|[^\w.])null([^\w]|$)/.test(value),
      `${call.file}:${call.line}: detail faellt in einem Zweig auf null zurueck - dann nennt der Dialog nichts`);
    keys.forEach((key) => detailKeys.add(key));
  }

  assertKeysExistInEveryLocale([...detailKeys]);

  // Der Text muss die Folgen benennen, nicht nur warnen: Mindestlaenge als
  // grober Schutz gegen ein spaeteres "Wirklich?" als Detail. Geprueft wird pro
  // Dialog, nicht pro Key - ein Aufruf darf ein kurzes Fragment voranstellen
  // (subscriptions.js haengt die Nutzungswarnung an), solange mindestens ein
  // Key die Folge ausformuliert.
  const de = JSON.parse(read('../public/locales/de.json'));
  const laenge = (key) => {
    const value = key.split('.').reduce((o, k) => o?.[k], de);
    return typeof value === 'string' ? value.length : 0;
  };
  const zuKnapp = gefaehrlich
    .map((call) => ({ call, value: readOptionValue(call.options, 'detail') }))
    .map(({ call, value }) => ({
      call,
      value,
      keys: [...value.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]),
    }))
    // Delegierte Aufrufe kennen ihren Key hier nicht - deren Laenge prueft der
    // Guard, der die Aufrufer der geteilten Komponente durchgeht.
    .filter(({ value }) => !/\bt\(\s*this\._\w*[Kk]ey\b/.test(value))
    .filter(({ keys }) => !keys.some((key) => laenge(key) >= 80))
    .map(({ call, keys }) => `${call.file}:${call.line} (${keys.join(', ')})`);
  assert.deepEqual(zuKnapp, [], 'kein Folgentext des Dialogs ist lang genug fuer eine Folgenbeschreibung');

  // Alle genannten Keys muessen es trotzdem in jede Locale geschafft haben.
  assert.ok(detailKeys.size >= 25, `nur ${detailKeys.size} Folgen-Keys gefunden`);
});

// Gegenstueck zur Delegation oben. Der Category-Manager bedient fuenf Module,
// und deren Server-Semantik geht auseinander: Budget, Aufgaben und Kontakte
// weisen eine belegte Kategorie mit 409 ab, der Einkauf schiebt die Artikel auf
// die naechste Kategorie, der Vorrat laesst sie unzugeordnet zurueck. Ein
// geteilter Folgentext waere fuer zwei der fuenf schlicht falsch - eine
// Fehlerklasse, die es hier schon einmal gab (der Platzhalter „Neue Kategorie"
// im Lagerort-Dialog). Der Guard sucht die Aufrufer im Bestand, statt sie zu
// kennen: wer die Komponente einbindet, muss den Folgentext mitliefern.
test('jeder Nutzer des Category-Managers liefert seinen eigenen Folgentext', () => {
  const base = new URL('../public/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) return walk(child);
    return entry.name.endsWith('.js') ? [child] : [];
  });

  const de = JSON.parse(read('../public/locales/de.json'));
  const laenge = (key) => {
    const value = key.split('.').reduce((o, k) => o?.[k], de);
    return typeof value === 'string' ? value.length : 0;
  };

  const nutzer = [];
  for (const file of walk(base)) {
    const src = readFileSync(file, 'utf8').replace(/\r/g, '');
    const label = decodeURIComponent(file.href.slice(base.href.length));
    if (label === 'components/category-manager.js') continue;
    if (!src.includes('yuvomi-category-manager')) continue;
    // JEDER configure()-Aufruf der Datei, nicht der erste: eine Seite darf zwei
    // Manager mounten, und der zweite waere sonst ungeprueft durchgelaufen.
    // `basePath` ist die Signatur dieser Komponente und haelt fremde
    // configure()-Aufrufe draussen.
    const vorher = nutzer.length;
    const re = /\.configure\s*\(/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const call = readCall(src, match.index + match[0].length - 1);
      assert.ok(call, `${label}: configure()-Aufruf liess sich nicht lesen`);
      if (!/\bbasePath\s*:/.test(call)) continue;
      const line = src.slice(0, match.index).split('\n').length;
      nutzer.push({ label: `${label}:${line}`, call });
    }
    assert.notEqual(vorher, nutzer.length,
      `${label}: bindet den Category-Manager ein, ruft aber configure() nicht auf`);
  }

  // Faellt die Erkennung aus, soll der Test das sagen und nicht still bestehen.
  assert.ok(nutzer.length >= 5, `nur ${nutzer.length} Nutzer des Category-Managers gefunden`);

  const keys = new Set();
  for (const { label, call } of nutzer) {
    const del = readOptionValue(call, 'deleteDetailKey').match(/'([^']+)'/);
    assert.ok(del, `${label}: configure() braucht deleteDetailKey - was das Loeschen anrichtet, `
      + 'weiss nur der Server dieses Moduls');
    keys.add(del[1]);
    // Unterkategorien hat nur, wer sie einschaltet - dann braucht auch der
    // zweite Dialog seinen eigenen Text.
    if (/\bsupportsSubcategories\s*:\s*true\b/.test(call)) {
      const sub = readOptionValue(call, 'subDeleteDetailKey').match(/'([^']+)'/);
      assert.ok(sub, `${label}: mit supportsSubcategories braucht configure() auch subDeleteDetailKey`);
      keys.add(sub[1]);
    }
  }

  assertKeysExistInEveryLocale([...keys]);
  const zuKnapp = [...keys].filter((key) => laenge(key) < 80);
  assert.deepEqual(zuKnapp, [], 'zu knapp fuer eine Folgenbeschreibung');
});

// Die fuenf Dialoge aus dem urspruenglichen Befund bleiben namentlich verankert:
// die Regel oben wuerde auch gruen, wenn jemand `danger: true` entfernte, statt
// die Folgen zu nennen. Bei einem geloeschten Menschen oder einem
// zurueckgespielten Backup ist das keine zulaessige Antwort.
test('die schwersten Settings-Dialoge bleiben als gefaehrlich markiert', () => {
  const dialoge = [
    ['admin-family.js', 'settings.deleteMemberConfirm', 'settings.deleteMemberConfirmDetail'],
    ['admin-family.js', 'settings.invites.revokeConfirm', 'settings.invites.revokeConfirmDetail'],
    ['admin-api.js', 'settings.apiTokenRevokeConfirm', 'settings.apiTokenRevokeDetail'],
    ['admin-permissions.js', 'settings.permResetConfirm', 'settings.permResetConfirmDetail'],
    ['admin-backup.js', 'settings.backupRestoreConfirm', 'settings.backupRestoreDetail'],
  ];

  for (const [datei, confirmKey, detailKey] of dialoge) {
    const source = read(`../public/settings/pages/${datei}`);
    const at = source.indexOf(confirmKey);
    assert.notEqual(at, -1, `${datei}: ${confirmKey} kommt nicht mehr vor`);
    // Vom Schluesssel aus rueckwaerts zur oeffnenden Klammer des Aufrufs, dann
    // balanciert lesen - der Confirm-Text interpoliert selbst (`{ name }`).
    const open = Math.max(source.lastIndexOf('confirmModal(', at), source.lastIndexOf('confirmOverModal(', at));
    const block = readCall(source, source.indexOf('(', open));
    assert.ok(block?.includes('danger: true'), `${datei}: ${confirmKey} braucht danger: true`);
    assert.ok(block.includes(detailKey), `${datei}: ${confirmKey} braucht den Folgen-Text ${detailKey}`);
  }
});

// --------------------------------------------------------
// Aufgaben-Tags (#586)
// Drei Entscheidungen, die im Quelltext unscheinbar aussehen und deren Verlust
// sich in der Oberflaeche erst spaet zeigt.
// --------------------------------------------------------

test('Tag-Chips auf Karten sind Filter-Buttons, keine Beschriftungen', () => {
  const source = read('../public/pages/tasks.js');
  const fn = source.slice(source.indexOf('function renderTagBadges'),
                          source.indexOf('function wireTagBadgeFilter'));

  assert.match(fn, /<button type="button" class="task-tag task-tag--filter"/,
    'Ein Tag anzuklicken und danach zu filtern ist die erwartete Geste - als <span> gibt es sie nicht');
  assert.match(fn, /data-tag-filter="\$\{esc\(tag\)\}"/, 'Der Wert muss escaped am Chip haengen');
  assert.match(fn, /aria-label="\$\{esc\(t\('tasks\.tagFilterBy'/,
    'Der Button braucht eine Beschriftung, die seine Wirkung nennt');

  // Die Zusammenfassung ab dem vierten Tag darf kein Button sein: sie benennt
  // keinen einzelnen Tag, auf den ein Klick filtern koennte.
  const more = fn.slice(fn.indexOf('task-tag--more') - 120, fn.indexOf('task-tag--more') + 200);
  assert.match(more, /<span/, '+N ist eine Anzeige, kein Ziel');
});

test('der Tag-Klick wird in der Capture-Phase abgefangen', () => {
  const source = read('../public/pages/tasks.js');
  const fn = source.slice(source.indexOf('function wireTagBadgeFilter'),
                          source.indexOf('function wireTagBadgeFilter') + 600);

  assert.match(fn, /e\.stopPropagation\(\)/,
    'Ohne stopPropagation oeffnet derselbe Klick zusaetzlich den Bearbeiten-Dialog');
  // Das `true` am Ende ist der ganze Punkt: der Kanban-Board-Handler sitzt
  // unterhalb des Containers und kaeme beim Bubbling zuerst dran.
  assert.match(fn, /\}, true\);/,
    'Der Listener muss in der Capture-Phase haengen, sonst hat das Board den Dialog schon geoeffnet');
});

test('der Tag-Filter ist ueberall eine Liste, nirgends mehr ein einzelner Wert', () => {
  const source = read('../public/pages/tasks.js');

  // `filters.tag` (Singular) war die Fassung vor der Mehrfachauswahl. Bleibt
  // irgendwo ein Zugriff darauf stehen, ist er still wirkungslos: er liest
  // undefined und filtert nie.
  const singular = [...source.matchAll(/filters\.tag\b(?!s)/g)];
  assert.equal(singular.length, 0,
    `filters.tag (Singular) darf nicht mehr vorkommen, gefunden: ${singular.length}`);

  // Mehrere Tags muessen als eigene Parameter reisen, sonst zerfaellt ein Tag
  // mit Komma im Namen (aus CATEGORIES) am Server in zwei.
  assert.match(source, /params\.append\('tag', tag\)/,
    'Jeder Tag gehoert als eigener Query-Parameter in die Anfrage');
});

/**
 * Speichern darf nicht nach dem Verwerfen fragen.
 *
 * Gemessen (Issue #625): der Einkaufs-Artikel-Dialog schloss nach dem PATCH mit
 * `closeModal()`. Der Dirty-Guard vergleicht die Felder gegen den Snapshot vom
 * Oeffnen, sah die soeben gespeicherten Werte als ungespeicherte Aenderungen und
 * legte „Aenderungen verwerfen?" ueber den fertigen Vorgang - der Klick auf
 * „Verwerfen" schloss dann den Dialog, waehrend die Daten laengst geschrieben
 * waren. Die Frage war also nicht nur ueberfluessig, sie log ueber den Ausgang.
 *
 * Die Regel gilt fuer jeden Schreibvorgang, nicht fuer eine Allowlist von
 * Dateien: ist eine Aenderung erst einmal beim Server, gibt es nichts mehr zu
 * verwerfen, und das Modal gehoert mit `force: true` zu.
 */
// Dieselbe Handlung traegt drei Namen: `closeModal`, den Import-Alias
// `closeSharedModal` (Kueche, Vorrat, Rezepte) und `closeDetailView`, das die
// Detailansicht ueber closeModal legt. Faehrt die Regel nur auf dem ersten,
// laeuft sie an zwei Dritteln der Aufrufer vorbei - und zwar still.
// Die Detailansicht reicht ihren Fusszeilen-Aktionen zusaetzlich ein blankes
// `close` herein; dafuer greift der Guard in test-detail-view.js, weil ein
// ungebundenes `close(` hier auf jeden Popover- und Stream-Aufruf ansprechen
// wuerde.
const CLOSE_MODAL_CALL = /\b(close(Shared)?Modal|closeDetailView)\s*\(/;

test('nach einem Schreibvorgang schliesst das Modal ohne Verwerfen-Frage', () => {
  const WINDOW = 20; // Zeilen zwischen Request und Schliessen, grosszuegig gefasst
  const violations = [];

  for (const file of walkJsFiles('../public/')) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!/await\s+api\.(post|patch|put|delete)\s*\(/.test(line)) return;
      lines.slice(index, index + WINDOW).forEach((candidate, offset) => {
        // Kueche/Vorrat importieren dieselbe Funktion unter `closeSharedModal`;
        // ohne den Alias liefe die Regel an diesen Modulen vorbei.
        if (!CLOSE_MODAL_CALL.test(candidate)) return;
        // Definition und Import tragen denselben Namen, sind aber kein Aufruf.
        if (/function closeModal|^\s*import|\bfrom\s+'/.test(candidate)) return;
        if (/force/.test(candidate)) return;
        violations.push(`${file}:${index + offset + 1}: ${candidate.trim()}`);
      });
    });
  }

  assert.deepEqual(violations, [],
    'closeModal() im Erfolgspfad eines Schreibvorgangs braucht { force: true }');
});

/**
 * Loeschen fragt nicht nach dem Verwerfen.
 *
 * Dieselbe Regel von der anderen Seite: nicht nur ein erledigter Schreibvorgang
 * macht die Verwerfen-Frage sinnlos, sondern auch eine Entscheidung, die die
 * Eingaben ohnehin mitnimmt.
 *
 * Gemessen (Geburtstage, Schwester von #625): der Loeschen-Knopf im
 * Bearbeiten-Dialog rief `closeModal()` ohne `force`. Hatte der Nutzer vorher
 * ein Feld angefasst, kam erst „Aenderungen verwerfen?" und danach der
 * Loeschvorgang - zwei Rueckfragen fuer eine Entscheidung, und die erste fragte
 * nach Feldern, die der geloeschte Datensatz mitnimmt. Weil der Aufruf zudem
 * nicht awaited war, lief das Loeschen bereits los, waehrend der Verwerfen-
 * Dialog noch im selben Overlay-Slot hing (das Shared-Modal kennt kein
 * Stacking): ein Klick auf „Abbrechen" stellte danach ein Bearbeiten-Modal zu
 * einem bereits entfernten Eintrag wieder her.
 *
 * Die Regel gilt fuer jeden Loeschen-Knopf, nicht fuer eine Allowlist von
 * Dateien: wer loescht, hat ueber die Eingaben schon entschieden.
 */
test('der Loeschen-Knopf im Modal schliesst ohne Verwerfen-Frage', () => {
  // Verdrahtung eines Loeschen-Knopfes: Selektor mit „delete" plus click-Handler.
  const DELETE_BUTTON = /querySelector(All)?\([^)]*delete[^)]*\)[^;]*addEventListener\(\s*'click'/i;
  const WINDOW = 16; // Handler sind kurz; die Grenze faengt unerkannte Enden ab
  const violations = [];

  for (const file of walkJsFiles('../public/')) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!DELETE_BUTTON.test(line)) return;
      // Nur mehrzeilige Handler haben einen Rumpf zum Pruefen; einzeilige
      // (`=> deleteMed(med));`) delegieren und schliessen selbst nichts.
      if (!/\{\s*$/.test(line)) return;
      const indent = line.search(/\S/);

      for (let offset = 1; offset <= WINDOW; offset += 1) {
        const candidate = lines[index + offset];
        if (candidate === undefined) break;
        // Handler-Ende: schliessende Klammer auf Hoehe der Verdrahtung.
        if (/^\s*\}\)/.test(candidate) && candidate.search(/\S/) <= indent) break;
        if (!CLOSE_MODAL_CALL.test(candidate) || /force/.test(candidate)) continue;
        violations.push(`${file}:${index + offset + 1}: ${candidate.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, [],
    'closeModal() im Loeschen-Pfad braucht { force: true }');
});

/**
 * Ein Dialog aus einem offenen Modal heraus verdraengt es nicht.
 *
 * `confirmModal` laeuft durch `openModal`, und das raeumt ein offenes Modal mit
 * `force: true` weg - das Shared-Modal stapelt bewusst nicht. Aus einem
 * Formular-Modal heraus gefragt heisst das: ausgerechnet der Abbrechen-Pfad -
 * der einzige Grund, aus dem man ueberhaupt fragt - vernichtet die Eingaben,
 * ohne den Dirty-Guard auch nur zu streifen.
 *
 * Gemessen an acht Stellen (Ausgaben-, Konto-, Belohnungs- und fuenf
 * Gesundheits-Formulare); zwei weitere Module hatten sich den Verlust mit
 * Behelfen erkauft (Modal danach neu oeffnen, Inline-Bestaetigung von Hand).
 * `confirmOverModal` parkt das Formular stattdessen und gibt es unveraendert
 * zurueck.
 *
 * Grenze der Regel: sie sieht nur den direkten Aufruf im Handler. Ruft der
 * Handler eine Funktion, die ihrerseits fragt (health.js: deleteMed), faellt
 * das hier nicht auf - eine transitive Aufloesung ueber Modulgrenzen waere
 * raterei und wuerde bei jeder Umbenennung falsch anschlagen.
 */
test('ein Dialog ueber einem offenen Modal nutzt confirmOverModal', () => {
  const violations = [];

  for (const file of walkJsFiles('../public/')) {
    if (file.endsWith('components/modal.js')) continue; // definiert beide
    const lines = read(file).split('\n');

    lines.forEach((line, index) => {
      if (!/\bconfirmModal\s*\(/.test(line)) return;
      if (/^\s*(import|\/\/|\*)/.test(line)) return;

      // Vorfahren-Kette rein ueber Einrueckung: die jeweils naechste Zeile
      // oberhalb mit kleinerer Einrueckung. Steht ein `onSave` darin, laeuft der
      // Aufruf im Rumpf eines offenen Modals.
      let level = lines[index].search(/\S/);
      for (let i = index - 1; i >= 0 && level > 0; i -= 1) {
        const indent = lines[i].search(/\S/);
        if (indent === -1 || indent >= level) continue;
        level = indent;
        if (!/\bonSave\s*[:({]/.test(lines[i])) continue;
        violations.push(`${file}:${index + 1}: ${line.trim().slice(0, 80)}`);
        break;
      }
    });
  }

  assert.deepEqual(violations, [],
    'confirmModal() aus einem offenen Modal heraus gehoert auf confirmOverModal() umgestellt');
});

/**
 * Wer Lucide-Platzhalter einfuegt, materialisiert sie selbst.
 *
 * Ausgangsbefund (#668): in der Hauswirtschaft blieben die Bearbeiten- und
 * Loeschen-Knoepfe einer Aufgabe leer, sobald sie ueber einen Vorschlag angelegt
 * wurde - erst ein Reload brachte die Icons. `renderTasks()` fuegte
 * `<i data-lucide>` ein, ohne `createIcons` zu rufen; das tat nur
 * `renderCurrentTab()`. Beim Tabwechsel ging das gut, bei den fuenf anderen
 * Aufrufern (Anlegen, Abhaken, Zurueckholen, Loeschen, Bearbeiten-Modal) nicht.
 * `renderReports()` hatte dieselbe Luecke.
 *
 * Die Regel ist deshalb nicht "jede Render-Funktion ruft createIcons", sondern:
 * hat eine Funktion mehr als einen Aufrufer, darf sie das Materialisieren nicht
 * an ihn delegieren - der naechste Aufrufer erbt die Annahme nicht.
 *
 * Zwei Formen zaehlen als erfuellt: der direkte `createIcons`-Aufruf und ein
 * datei-lokaler Helfer, der ihn kapselt (rewards.js: `icons(el)`).
 *
 * Grenzen der Regel: Element-Fabriken sind ausgenommen - sie befuellen ein
 * losgeloestes Element und geben es zurueck, materialisieren laesst sich das
 * erst am eingehaengten Baum (pantry.js: `rowEl`, `cartEl`, `bulkBarEl`).
 * Funktionen mit genau einem Aufrufer ebenso: dort ist die Zustaendigkeit
 * eindeutig und nachlesbar (calendar.js: `renderAgendaView`). Beides faellt auf,
 * sobald ein zweiter Aufrufer dazukommt.
 *
 * Aufrufer werden am Namen erkannt, Kommentarzeilen zaehlen deshalb nicht mit -
 * sonst haette der Satz "pro render() genau einmal erzeugt" (shopping.js) einen
 * zweiten Aufrufer vorgetaeuscht.
 */
test('Render-Funktionen mit mehreren Aufrufern materialisieren ihre Icons selbst', () => {
  const violations = [];
  const withoutComments = (body) => body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');

  for (const file of [...walkJsFiles('../public/pages/'), ...walkJsFiles('../public/components/')]) {
    const fns = topLevelFunctions(read(file)).map(([name, body]) => [name, withoutComments(body)]);

    // Helfer, die nur `createIcons` kapseln, ohne selbst Markup einzufuegen.
    const helpers = fns
      .filter(([, body]) => /createIcons/.test(body) && !/data-lucide=/.test(body))
      .map(([name]) => name);
    const materialises = (body) => /createIcons/.test(body)
      || helpers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));

    for (const [name, body] of fns) {
      if (!/\.(insertAdjacentHTML|replaceChildren)\s*\(/.test(body)) continue;
      if (!/data-lucide=/.test(body)) continue;
      if (materialises(body)) continue;
      if (/document\.createElement\(/.test(body) && /\breturn\b/.test(body)) continue; // Element-Fabrik

      const callers = fns.filter(([other, otherBody]) =>
        other !== name && new RegExp(`\\b${name}\\s*\\(`).test(otherBody));
      if (callers.length <= 1) continue;

      violations.push(`${file}: ${name}() - ${callers.length} Aufrufer `
        + `(${callers.map(([caller]) => caller).join(', ')})`);
    }
  }

  assert.deepEqual(violations, [],
    'Diese Funktionen fügen <i data-lucide> ein, überlassen das Materialisieren aber '
    + `ihren Aufrufern. Ein lucide.createIcons({ el: ... }) gehört ans Ende:\n${violations.join('\n')}`);
});
