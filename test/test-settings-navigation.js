import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_DOMAINS,
  SETTINGS_LEAVES,
  SETTINGS_STORAGE_KEY,
  filterSettingsDomains,
  currentSettingsPath,
  RENAMED_SETTINGS_SOURCE_PATHS,
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
  countrySchoolHolidaysAvailable,
  createSchoolAvailabilityUpdater,
  ensureHolidayLayerSelection,
  isHolidayCountryResolved,
  resolveHolidayLocation,
  runHolidayDiscovery,
  shouldApplySubdivisionResponse,
} from '../public/settings/pages/modules-calendar.js';
import {
  persistCurrencySelection,
} from '../public/settings/currency.js';
import { CURRENCY_CODES } from '../public/utils/currency-codes.js';
import {
  hasValidWeatherCoords,
  isConnectedWeatherControl,
} from '../public/settings/weather-location.js';
import {
  persistMealTypeSelection,
} from '../public/settings/pages/modules-kitchen.js';
import {
  buildMobileNavigationPayload,
  buildOrderPayload,
  kitchenGroupHidden,
} from '../public/settings/pages/modules-navigation.js';
import {
  buildActiveModulesPayload,
  persistHouseholdToggle,
} from '../public/settings/pages/modules-active.js';
import {
  parseGraceDaysInput,
} from '../public/settings/pages/modules-countdowns.js';

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
  'settings.enabledReminderListCount',
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
  'nav.sectionHousehold',
  'nav.sectionPeople',
  'nav.sectionFinance',
  'nav.sectionCustomModules',
  'shopping.manageCategories',
];
const settingsTranslationKeys = [...new Set([...registryTranslationKeys, ...sharedTranslationKeys])];

function getTranslation(locale, key) {
  return key.split('.').reduce((value, segment) => value?.[segment], locale);
}

test('settings leaves have unique IDs and paths', () => {
  assert.equal(new Set(SETTINGS_LEAVES.map((leaf) => leaf.id)).size, SETTINGS_LEAVES.length);
  assert.equal(new Set(SETTINGS_LEAVES.map((leaf) => leaf.path)).size, SETTINGS_LEAVES.length);
});

test('die Blätter verteilen sich wie beschlossen auf die vier Domänen', () => {
  // Statt einer nackten Gesamtzahl: die Verteilung ist die IA-Aussage. Der
  // Critique 2026-07-27 fand sie unbalanciert (personal 5 / modules 8 / sync 3 /
  // documents 2 / admin 6) - `documents` ist aufgelöst, `modules` von acht auf
  // vier geschrumpft, und was per-user schreibt, liegt bei `personal`.
  // Immich (#693) liegt bei `admin` wie das Wetter: eine serverweite
  // Dienstanbindung, deren Zugangsdaten der Browser nie sieht.
  // Die Aufgaben-Vorgaben (#695) liegen bei `personal` und NICHT bei
  // `sync-reminders`: welche Erinnerungslisten der Haushalt abgleicht, ist eine
  // Admin-Entscheidung, in welche davon meine neuen Aufgaben laufen, ist meine.
  // Nach demselben Schnitt liegt das Zyklus-Opt-out (#760) bei `personal`: ob der
  // Haushalt den Zyklus führt, steht im adminOnly-`modules-options`, ob ich ihn
  // sehen will, entscheide ich.
  // Und ebenso `personal-feeds`: beide Feed-Tokens hängen an der eigenen
  // users-Zeile und beide Routen tragen keinen Admin-Check, das Blatt lag
  // trotzdem im adminOnly-`sync-calendar`.
  // `personal-calendar-subscriptions` ist die Gegenrichtung und derselbe Fall:
  // `GET /calendar/subscriptions` liefert `shared = 1 OR created_by = ich`, und
  // PATCH/DELETE/sync antworten 403 für fremde Abos - `isAdmin` ist dort ein
  // ZUSATZrecht, keine Voraussetzung. Bei `sync` bleiben nur die Blätter, deren
  // Routen wirklich `requireAdmin` tragen: CalDAV und Google/Apple hängen an
  // Zugangsdaten des Haushalts.
  // `modules-countdowns` (#969) liegt bei `modules`, nicht bei `personal`: die
  // Nachfrist ist haushaltweit und admin-only, kein persoenlicher Wert wie das
  // Zyklus-Opt-out oben - deshalb ein eigenes Blatt statt eines Platzes in
  // `modules-options`, dessen eigener Guard (test:frontend-audit) nur Schalter
  // aus dem geteilten Toggle-Primitiv zulaesst, kein Zahlenfeld.
  const perDomain = {};
  for (const leaf of SETTINGS_LEAVES) perDomain[leaf.domainId] = (perDomain[leaf.domainId] ?? 0) + 1;
  assert.deepEqual(perDomain, { personal: 11, modules: 6, sync: 5, admin: 8 });
  // Jedes Blatt hängt an einer existierenden Domäne.
  const domainIds = new Set(SETTINGS_DOMAINS.map((domain) => domain.id));
  for (const leaf of SETTINGS_LEAVES) {
    assert.ok(domainIds.has(leaf.domainId), `${leaf.id}: unbekannte Domäne "${leaf.domainId}"`);
  }
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
    import('/settings/pages/personal-weather.js'),
    import('/settings/pages/personal-calendar.js'),
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

test('Mitglieder können ihre eigene Navigation erreichen', () => {
  // module_order und mobile_nav_order sind per-user (cfgUserSet, kein Admin-Check),
  // das Blatt lag aber hinter adminOnly - 5 von 6 Mitgliedern kamen nie hin
  // (Critique 2026-07-27).
  assert.equal(findSettingsLeaf('/settings/personal/navigation', member)?.id, 'modules-navigation');
  assert.equal(findSettingsLeaf('/settings/personal/navigation', admin)?.id, 'modules-navigation');
  // Alter Pfad bleibt erreichbar und landet am neuen Ort.
  assert.equal(findSettingsLeaf('/settings/modules/navigation', member)?.path, '/settings/personal/navigation');
  // Und es liegt in der einzigen Domäne, die ein Mitglied sieht.
  const leaf = SETTINGS_LEAVES.find((entry) => entry.id === 'modules-navigation');
  assert.equal(leaf.domainId, 'personal');
  assert.equal(leaf.adminOnly, false);
});

test('das persoenliche Blatt traegt keinen haushaltweiten Schalter mehr', async () => {
  // Die Regel, nicht der Einzelfall: auf `modules-navigation` darf KEIN
  // Bedienelement stehen, das den Haushalt aendert - egal ob hinter `isAdmin`
  // versteckt oder nicht. Vorher war genau das der Fall, und zwei unbeschriftete
  // Bedienelemente mit zwoelf Pixel Abstand trugen sehr verschiedene Reichweiten
  // (Critique 2026-08-16, P0).
  // Kommentare raus, BEVOR gesucht wird: beide Blaetter erklaeren im Fliesstext
  // genau diese Schluessel, und ein Guard, der Prosa fuer Code haelt, meldet die
  // Begruendung als Verstoss. Genau daran war die erste Fassung rot.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const personal = stripComments(await readFile(
    new URL('../public/settings/pages/modules-navigation.js', import.meta.url),
    'utf8',
  ));
  for (const marker of ['data-built-in-module-toggle', 'data-kitchen-child-toggle',
    'data-third-party-module-toggle']) {
    assert.equal(personal.includes(marker), false,
      `das persoenliche Blatt rendert noch '${marker}' - der Haushalts-Schalter ist zurueck`);
  }
  // LESEN bleibt richtig: das Blatt muss wissen, was der Haushalt abgeschaltet
  // hat, sonst kann es den Ausblenden-Knopf nicht sperren und den Grund nicht
  // nennen. Verboten ist das SCHREIBEN - der Schluessel als Payload-Feld.
  // Der Kontext gehoert ins Muster: `preferences.disabled_modules : []` ist ein
  // Ternaer und kein Objektschluessel - die erste Fassung dieses Guards war
  // daran rot, obwohl das Blatt nur LAS.
  assert.equal(/(^|[{,])\s*disabled_modules\s*:/m.test(personal), false,
    'das persoenliche Blatt schreibt disabled_modules - das ist haushaltweit und admin-only');
  assert.match(personal, /preferences\.disabled_modules/,
    'das Blatt liest den Haushaltsstand nicht mehr - dann kann es den gesperrten Knopf nicht begruenden');
  // Und der Save-Pfad muss die Rolle NICHT mehr kennen: eine Payload, die nicht
  // weiss, wer sie absendet, kann auch nicht die falsche sein.
  // Die Regel ist "der Save-Pfad kennt die Rolle nicht", nicht "die Signatur
  // hat genau ein Argument": sie nahm spaeter die im Blatt nie gerenderten
  // Order-Ids dazu, und daran war dieser Guard rot, ohne dass sich die
  // Zusicherung geaendert haette.
  assert.match(personal, /async function saveNavigationState\(list[,)]/);
  assert.equal(/saveNavigationState\([^)]*isAdmin/.test(personal), false,
    'der Save-Pfad kennt wieder die Rolle - dann kann er wieder die falsche Payload schicken');

  // Gegenprobe auf der anderen Seite: das adminOnly-Blatt schreibt keine
  // per-user-Schluessel.
  const household = stripComments(await readFile(
    new URL('../public/settings/pages/modules-active.js', import.meta.url),
    'utf8',
  ));
  for (const marker of ['hidden_modules', 'module_order', 'mobile_nav_order', 'data-module-hide']) {
    assert.equal(household.includes(marker), false,
      `das Haushalts-Blatt fasst '${marker}' an - das ist per-user`);
  }
});

test('das Blatt der aktiven Module liegt adminOnly in der Modul-Domaene', () => {
  const leaf = SETTINGS_LEAVES.find((entry) => entry.id === 'modules-active');
  assert.ok(leaf, 'Blatt modules-active fehlt in der Registry');
  assert.equal(leaf.domainId, 'modules');
  assert.equal(leaf.adminOnly, true);
  assert.equal(findSettingsLeaf('/settings/modules/active', admin)?.id, 'modules-active');
  assert.equal(findSettingsLeaf('/settings/modules/active', member), null);
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
  assert.match(source, /window\.yuvomi\?\.setMobileNavOrder/);
});

test('members only see the personal settings domain', () => {
  assert.deepEqual(filterSettingsDomains(member).map((domain) => domain.id), ['personal']);
});

test('admins see all settings domains', () => {
  assert.deepEqual(
    filterSettingsDomains(admin).map((domain) => domain.id),
    ['personal', 'modules', 'sync', 'admin'],
  );
});

test('verschobene Blatt-Pfade landen am neuen Ort statt beim Fallback', () => {
  // Die Domäne `documents` trug zwei Admin-Blätter, während `calendar` mit 729
  // Zeilen Konfiguration keine eigene hatte (Critique 2026-07-27). Beide binden
  // externe Dienste an und liegen jetzt unter `sync`. Alte Bookmarks und
  // gespeicherte Ziele dürfen dabei nicht stumm auf `personal/account` fallen.
  assert.equal(findSettingsLeaf('/settings/documents/storage', admin)?.path, '/settings/sync/storage');
  assert.equal(findSettingsLeaf('/settings/documents/dms', admin)?.path, '/settings/sync/dms');
  assert.equal(currentSettingsPath('/settings/documents/storage'), '/settings/sync/storage');
  assert.equal(currentSettingsPath('/settings/sync/storage'), '/settings/sync/storage');
  assert.equal(currentSettingsPath('/settings/unbekannt'), '/settings/unbekannt');
  // Rollen-Gate greift auch über den alten Pfad.
  assert.equal(findSettingsLeaf('/settings/documents/storage', member), null);
});

test('das aufgelöste Übersicht-Blatt landet beim Haushalts-Wetter', () => {
  // "Übersicht" trug Haushalts-Wetter und App-Name, aber keinen einzigen
  // Widget-Schalter (Critique 2026-07-27). Der App-Name sitzt jetzt bei den
  // Systemangaben, das Wetter in einem eigenen Blatt; der Alt-Pfad zeigt dorthin.
  assert.equal(currentSettingsPath('/settings/modules/dashboard'), '/settings/admin/weather');
  assert.equal(findSettingsLeaf('/settings/modules/dashboard', admin)?.id, 'admin-weather');
  assert.equal(findSettingsLeaf('/settings/modules/dashboard', member), null);
  assert.equal(SETTINGS_LEAVES.some((leaf) => leaf.id === 'modules-dashboard'), false);
});

test('Mitglieder erreichen ihre eigenen Termin-Vorgaben', () => {
  // calendar_default_reminders und calendar_default_assign_me schreiben per
  // cfgUserSet pro Nutzer, lagen aber hinter dem adminOnly-Kalenderblatt
  // (Critique 2026-07-27).
  const leaf = SETTINGS_LEAVES.find((entry) => entry.id === 'personal-calendar');
  assert.equal(leaf.domainId, 'personal');
  assert.equal(leaf.adminOnly, false);
  assert.equal(findSettingsLeaf('/settings/personal/calendar', member)?.id, 'personal-calendar');
  // Das haushaltweite Kalenderblatt bleibt adminOnly.
  assert.equal(findSettingsLeaf('/settings/modules/calendar', member), null);
});

test('Mitglieder erreichen ihr eigenes Zyklus-Opt-out (#760)', () => {
  // health_cycle_enabled_user schreibt per cfgUserSet pro Nutzer. Läge der
  // Schalter im adminOnly-`modules-options`, könnte ihn genau die Mehrheit nicht
  // bedienen, für die er gedacht ist - derselbe Schnitt wie bei personal-calendar.
  const leaf = SETTINGS_LEAVES.find((entry) => entry.id === 'personal-health');
  assert.equal(leaf.domainId, 'personal');
  assert.equal(leaf.adminOnly, false);
  assert.equal(findSettingsLeaf('/settings/personal/health', member)?.id, 'personal-health');
  // Der haushaltweite Schalter bleibt daneben adminOnly.
  assert.equal(findSettingsLeaf('/settings/modules/options', member), null);
});

test('drei Ein-Schalter-Blätter teilen sich jetzt eines', () => {
  // Budget, Gesundheit und Haushaltshilfe trugen zusammen drei Checkboxen und
  // kosteten drei Sidebar-Einträge und drei Requests (Critique 2026-07-27).
  for (const legacyPath of [
    '/settings/modules/budget',
    '/settings/modules/health',
    '/settings/modules/housekeeping',
  ]) {
    assert.equal(currentSettingsPath(legacyPath), '/settings/modules/options');
    assert.equal(findSettingsLeaf(legacyPath, admin)?.id, 'modules-options');
    assert.equal(findSettingsLeaf(legacyPath, member), null);
  }
});

test('legacy settings tabs migrate to their new destinations', () => {
  assert.equal(migrateLegacySettingsTab('general'), '/settings/personal/appearance');
  assert.equal(migrateLegacySettingsTab('shopping'), '/shopping?manage=categories');
  assert.equal(migrateLegacySettingsTab('sync'), '/settings/sync/calendar');
  assert.equal(migrateLegacySettingsTab('backup'), '/settings/admin/backup');
  // Ein Alt-Tab muss am heutigen Blatt ankommen, nicht am Zwischenstand von
  // 2026-06: der Budget-Tab zeigte auf ein Blatt, das seither aufgegangen ist.
  assert.equal(migrateLegacySettingsTab('budget'), '/settings/modules/options');
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
      budget: '/settings/modules/options',
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
    resolveSettingsDestination('/settings', admin, '/settings/sync/storage'),
    '/settings/sync/storage',
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
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/sync/storage' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/sync/storage');
});

test('readStoredSettingsDestination hebt ein vor dem IA-Umbau gespeichertes Ziel an', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/documents/dms' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/sync/dms');
});

// Ohne gueltiges gespeichertes Ziel gibt es kein "zuletzt besuchtes Blatt".
// Frueher stand hier `/settings/personal/account`, und der erste Besuch der
// Einstellungen landete wortlos in einem Formular; die Uebersicht war ueber die
// App-Navigation gar nicht erreichbar (Critique 2026-07-27). `null` heisst
// jetzt: der Aufrufer rendert die Uebersicht.
test('readStoredSettingsDestination liefert null fuer ein ungueltiges gespeichertes Blatt', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/not-a-page' });
  assert.equal(readStoredSettingsDestination(admin, storage), null);
});

test('readStoredSettingsDestination ignoriert ein gespeichertes Admin-Blatt fuer ein Mitglied', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/admin/system' });
  assert.equal(readStoredSettingsDestination(member, storage), null);
});

test('readStoredSettingsDestination removes the legacy key only after a successful migration', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'backup' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/admin/backup');
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), false);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), '/settings/admin/backup');
});

test('readStoredSettingsDestination keeps an unmigratable legacy key in place', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'totally-unknown' });
  assert.equal(readStoredSettingsDestination(admin, storage), null);
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), true);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
});

test('readStoredSettingsDestination does not persist a migration that leaves Settings', () => {
  const storage = createMemoryStorage({ [LEGACY_SETTINGS_STORAGE_KEY]: 'shopping' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/shopping?manage=categories');
  assert.equal(storage.has(LEGACY_SETTINGS_STORAGE_KEY), false);
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
});

test('readStoredSettingsDestination liefert null bei leerem Speicher', () => {
  const storage = createMemoryStorage();
  assert.equal(readStoredSettingsDestination(admin, storage), null);
});

// Und der Controller muss daraus die Uebersicht machen, nicht einen Redirect:
// nur ein vorhandenes Ziel loest eine Umleitung aus, alles andere faellt in den
// Shell-Render mit 'domains'.
test('der Settings-Controller rendert ohne gespeichertes Ziel die Uebersicht', async () => {
  const source = await readFile(new URL('../public/pages/settings.js', import.meta.url), 'utf8');
  assert.match(source, /if \(destination\) \{ await redirectTo\(destination\); return; \}/);
  assert.match(source, /view: known \? 'domain' : 'domains'/);
  assert.doesNotMatch(source, /await redirectTo\(readStoredSettingsDestination/);
});

test('every approved settings leaf is registered as an exact SPA route', async () => {
  const source = await readFile(
    new URL('../public/router.js', import.meta.url),
    'utf8',
  );
  // Der Router muss seine Settings-Routen aus der Registry ableiten, nie aus
  // einer Handliste - sonst driften Registry und Routentabelle auseinander.
  assert.match(source, /import\s*\{[^}]*\bSETTINGS_LEAVES\b[^}]*\}\s*from\s*'\/settings\/registry\.js'/);
  // Die Pflichtfelder, nicht das ganze Objektliteral: der Eintrag hat seit dem
  // Titel-Umbau (Audit P1-2) ein `titleKey`, und ein Guard, der die exakte
  // Feldliste festnagelt, bricht bei jedem weiteren Feld ohne einen Verstoss
  // zu melden. Was hier zaehlt, ist Pfad + Seite + Auth + Modul.
  assert.match(
    source,
    /SETTINGS_LEAVES\.map\(\(\{\s*path\s*\}\)\s*=>\s*\(\{\s*path,\s*page:\s*'\/pages\/settings\.js',\s*requiresAuth:\s*true,\s*module:\s*'settings'\s*[,}]/,
  );
  // Und die vom IA-Umbau verschobenen Alt-Pfade ebenso: ohne eigene Route
  // matcht ein alter Bookmark gar nichts und die Umleitung käme nie zum Zug.
  assert.match(source, /import\s*\{[^}]*\bRENAMED_SETTINGS_SOURCE_PATHS\b[^}]*\}\s*from\s*'\/settings\/registry\.js'/);
  assert.match(
    source,
    /RENAMED_SETTINGS_SOURCE_PATHS\.map\(\(path\)\s*=>\s*\(\{\s*path,\s*page:\s*'\/pages\/settings\.js',\s*requiresAuth:\s*true,\s*module:\s*'settings'\s*[,}]/,
  );
  assert.ok(RENAMED_SETTINGS_SOURCE_PATHS.length > 0);
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

test('ungespeicherte Eingaben gehen beim Blattwechsel nicht still verloren', async () => {
  const guard = await readFile(new URL('../public/settings/dirty-guard.js', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');

  // Nur echte Nutzereingaben zaehlen: Daten aus der API und Re-Renders eines
  // Blatts setzen Werte programmatisch und duerfen nicht als Arbeit gelten.
  assert.match(guard, /event\.isTrusted/, 'programmatische Wertaenderungen duerfen nicht dirty machen');
  // Die vielen Sofort-Speicherer der Einstellungen haben nie einen offenen
  // Stand - eine Rueckfrage waere dort falsch.
  assert.match(guard, /button\[type="submit"\]/, 'nur Formulare mit eigenem Absenden koennen offen sein');
  assert.match(guard, /'submit'/, 'ein abgeschicktes Formular ist wieder sauber');
  // Verlaesst der Nutzer die Einstellungen, faellt die Shell aus dem Dokument:
  // ohne diese Pruefung blockierte beforeunload danach weiter.
  assert.match(guard, /isConnected/);
  assert.match(guard, /beforeunload/);
  // Wiederverwendete Texte statt eigener Keys - der Modal-Dirty-Schutz sagt dasselbe.
  assert.match(guard, /modal\.unsavedChanges/);

  assert.match(shell, /import\s*\{[^}]*confirmLeafExit[^}]*\}\s*from\s*'\.\/dirty-guard\.js'/);
  assert.match(shell, /await confirmLeafExit\(\)/, 'jede Navigation aus einem Blatt muss durch den Guard');
  assert.match(shell, /watchLeafForms\(leafContainer\)/, 'das Tracking haengt am fertig gerenderten Blatt');
});

test('die Navigation laesst sich ueber alle Blaetter durchsuchen', async () => {
  const source = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  // Bei 23 Blaettern in vier Domaenen war die Taxonomie der einzige Weg zu
  // einer Einstellung, deren Domaene man nicht kennt (Critique 2026-07-27).
  assert.match(source, /type\s*=\s*'search'/, 'die Suche braucht ein echtes Suchfeld');
  assert.match(source, /descriptionKey/, 'gefiltert wird ueber Label UND Beschreibung');
  assert.match(source, /searchNormalize/, 'die Suche muss Gross-/Kleinschreibung und Diakritika ignorieren');
  assert.match(source, /normalize\('NFD'\)/);
  assert.match(source, /setAttribute\('role',\s*'status'\)/, 'die Trefferzahl gehoert in eine Live-Region');
  // Ohne Treffer greift der bestehende Leerzustand, statt stumm zu bleiben.
  assert.match(source, /t\('search\.noResults'\)/);
});

test('der Blattwechsel zeigt einen Ladezustand statt eines leeren Kastens', async () => {
  const source = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  // Zwischen `leafContainer.replaceChildren()` und dem fertigen Blatt lagen der
  // dynamische Import und der erste Datenabruf (Critique 2026-07-27).
  assert.match(source, /import\s*\{\s*renderSkeletonList\s*\}\s*from\s*'\/utils\/skeleton\.js'/);
  assert.match(source, /setAttribute\('aria-busy',\s*'true'\)/, 'aria-busy muss den Ladezustand ansagen');
  assert.match(source, /renderSkeletonList\(/, 'das Skelett muss aus dem geteilten Helfer kommen');
  // Erfolg und Fehlschlag muessen aria-busy wieder abraeumen, sonst bleibt das
  // Blatt fuer Screenreader dauerhaft "beschaeftigt".
  assert.equal(
    source.match(/removeAttribute\('aria-busy'\)/g)?.length,
    2,
    'aria-busy muss im Erfolgs- UND im Fehlerpfad entfernt werden',
  );
  assert.match(source, /clearTimeout\(skeletonTimer\)/, 'der verzoegerte Einsatz muss abbrechbar sein');
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
  // Reihenfolge = Küchen-Kreislauf: planen → kochen → einkaufen → lagern (#596).
  assert.deepEqual(KITCHEN_CHILD_IDS, ['meals', 'recipes', 'shopping', 'pantry']);
  assert.equal(Object.isFrozen(KITCHEN_CHILD_IDS), true);
});

test('groupBuiltInModules enables Kitchen while any child is enabled', () => {
  const modules = groupBuiltInModules(['recipes']);
  const kitchen = modules.find((module) => module.id === 'kitchen');

  assert.deepEqual(kitchen.children, [
    { id: 'meals', enabled: true },
    { id: 'recipes', enabled: false },
    { id: 'shopping', enabled: true },
    { id: 'pantry', enabled: true },
  ]);
  assert.equal(kitchen.enabledChildren, 3);
  assert.equal(kitchen.enabled, true);
});

test('groupBuiltInModules disables Kitchen when every child is disabled', () => {
  const [kitchen] = groupBuiltInModules(['meals', 'recipes', 'shopping', 'pantry']);

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
    ['calendar', 'meals', 'recipes', 'shopping', 'pantry', 'tasks'],
  );
});

test('module order helpers handle empty orders', () => {
  assert.deepEqual(normalizeModuleOrder(), []);
  assert.deepEqual(expandModuleOrder([]), []);
});

test('module order helpers deduplicate repeated Kitchen children', () => {
  const order = ['meals', 'recipes', 'meals', 'shopping', 'recipes'];

  assert.deepEqual(normalizeModuleOrder(order), ['kitchen']);
  assert.deepEqual(expandModuleOrder(order), ['meals', 'recipes', 'shopping', 'pantry']);
});

test('explicit Kitchen and legacy children produce one Kitchen position', () => {
  const order = ['calendar', 'kitchen', 'recipes', 'tasks', 'shopping', 'meals'];

  assert.deepEqual(normalizeModuleOrder(order), ['calendar', 'kitchen', 'tasks']);
  assert.deepEqual(
    expandModuleOrder(order),
    ['calendar', 'meals', 'recipes', 'shopping', 'pantry', 'tasks'],
  );
});

test('module order helpers preserve stable unique non-Kitchen IDs', () => {
  const order = ['tasks', 'calendar', 'tasks', 'recipes', 'notes', 'calendar', 'shopping'];

  assert.deepEqual(normalizeModuleOrder(order), ['tasks', 'calendar', 'kitchen', 'notes']);
  assert.deepEqual(
    expandModuleOrder(order),
    ['tasks', 'calendar', 'meals', 'recipes', 'shopping', 'pantry', 'notes'],
  );
});

test('navigation sections match the grouped desktop information architecture', () => {
  assert.equal(moduleSection('dashboard'), NAV_SECTION.overview);
  assert.equal(moduleSection('calendar'), NAV_SECTION.plan);
  assert.equal(moduleSection('tasks'), NAV_SECTION.plan);
  assert.equal(moduleSection('notes'), NAV_SECTION.plan);
  assert.equal(moduleSection('kitchen'), NAV_SECTION.household);
  assert.equal(moduleSection('housekeeping'), NAV_SECTION.household);
  assert.equal(moduleSection('documents'), NAV_SECTION.household);
  assert.equal(moduleSection('inventory'), NAV_SECTION.household);
  assert.equal(moduleSection('rewards'), NAV_SECTION.household);
  assert.equal(moduleSection('contacts'), NAV_SECTION.people);
  assert.equal(moduleSection('birthdays'), NAV_SECTION.people);
  assert.equal(moduleSection('health'), NAV_SECTION.people);
  assert.equal(moduleSection('budget'), NAV_SECTION.finance);
  assert.equal(moduleSection('third-party-weather-station'), NAV_SECTION.customModules);
  assert.equal(moduleSection('settings'), NAV_SECTION.household);
});

test('desktop navigation order is applied only inside each section', () => {
  const items = [
    { module: 'contacts' },
    { module: 'calendar' },
    { module: 'dashboard' },
    { module: 'budget' },
    { module: 'notes' },
    { module: 'tasks' },
    { module: 'third-party-weather-station' },
    { module: 'settings' },
  ];

  assert.deepEqual(
    sortNavigationItems(items, ['budget', 'tasks', 'contacts', 'calendar', 'notes']),
    [
      { module: 'dashboard' },
      { module: 'tasks' },
      { module: 'calendar' },
      { module: 'notes' },
      // contacts (Menschen) steht vor budget (Finanzen) — Sektions-Reihenfolge
      // schlägt die gespeicherte Modul-Ordnung, die nur innerhalb einer Sektion gilt.
      { module: 'contacts' },
      { module: 'budget' },
      { module: 'third-party-weather-station' },
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

test('#965: school holidays are available unless the country entry says otherwise', () => {
  const countries = [
    { isoCode: 'DE', name: 'Germany' },
    { isoCode: 'US', name: 'United States', schoolHolidays: false },
  ];
  assert.equal(countrySchoolHolidaysAvailable(countries, ''), true, 'kein gewaehltes Land - kein Grund zu sperren');
  assert.equal(countrySchoolHolidaysAvailable(countries, 'DE'), true, 'ein gewoehnliches OpenHolidays-Land traegt kein Flag');
  assert.equal(countrySchoolHolidaysAvailable(countries, 'US'), false, 'das Flag ist eine Ausnahmemarkierung, keine Positivliste');
  assert.equal(countrySchoolHolidaysAvailable(countries, 'FR'), true, 'ein Land ausserhalb der Liste gilt nicht als gesperrt');
  assert.equal(countrySchoolHolidaysAvailable([], 'US'), true, 'ohne geladene Laenderliste noch keine Sperre - kein Fehlzustand vortaeuschen');
});

// #965 Review-Fund: die reine Verfuegbarkeitsfrage oben war getestet, ihr
// Aufrufer nicht - und der loeschte den Haken beim Sperren, ohne ihn je
// zurueckzugeben. Ein DE-Haushalt mit Schulferien-Ebene, der im Dropdown kurz
// zu den USA und wieder zu DE blaettert und speichert, verlor die Ebene still.
// Diese Tests fahren den echten Aufrufer-Pfad (Land-Wechsel-Handler) ueber
// dieselben drei Bedienelemente, die das Blatt haelt.
const HOLIDAY_TEST_COUNTRIES = [
  { isoCode: 'DE', name: 'Germany' },
  { isoCode: 'US', name: 'United States', schoolHolidays: false },
];

function schoolControls({ checked }) {
  return {
    showSchool: { checked, disabled: false },
    schoolColorGroup: { hidden: !checked },
    schoolUnavailableHint: { hidden: true },
  };
}

test('#965 Review: DE -> US -> DE gibt den Schulferien-Haken zurueck', () => {
  const c = schoolControls({ checked: true });
  const apply = createSchoolAvailabilityUpdater(c);

  apply(HOLIDAY_TEST_COUNTRIES, 'DE'); // initialer Zustand: verfuegbar, Haken an
  assert.equal(c.showSchool.checked, true);
  assert.equal(c.showSchool.disabled, false);

  apply(HOLIDAY_TEST_COUNTRIES, 'US'); // Land ohne Quelle: gesperrt UND Haken raus,
  // denn der Speichern-Pfad liest checked woertlich - stuende der Haken noch,
  // wuerde holiday_show_school=1 fuer ein Land ohne Datenquelle gespeichert.
  assert.equal(c.showSchool.disabled, true);
  assert.equal(c.showSchool.checked, false);
  assert.equal(c.schoolColorGroup.hidden, true);
  assert.equal(c.schoolUnavailableHint.hidden, false);

  apply(HOLIDAY_TEST_COUNTRIES, 'DE'); // zurueck: der gemerkte Haken kommt wieder
  assert.equal(c.showSchool.disabled, false);
  assert.equal(c.showSchool.checked, true, 'der Umweg ueber die USA darf die Ebene nicht kosten');
  assert.equal(c.schoolColorGroup.hidden, false);
  assert.equal(c.schoolUnavailableHint.hidden, true);
});

test('#965 Review: ein nie gesetzter Haken kommt nach dem Umweg auch nicht zurueck', () => {
  const c = schoolControls({ checked: false });
  const apply = createSchoolAvailabilityUpdater(c);

  apply(HOLIDAY_TEST_COUNTRIES, 'US');
  assert.equal(c.showSchool.checked, false);

  apply(HOLIDAY_TEST_COUNTRIES, 'DE');
  assert.equal(c.showSchool.checked, false, 'wiederhergestellt wird nur, was vorher da war');
  assert.equal(c.schoolColorGroup.hidden, true);
});

test('#965 Review: US -> DE -> US merkt sich den Stand nur einmal, nicht den gesperrten', () => {
  // Zwei Sperr-Aufrufe hintereinander (US -> GB) duerfen nicht den bereits
  // geloeschten Haken als "gemerkten Stand" ueberschreiben.
  const countries = [...HOLIDAY_TEST_COUNTRIES, { isoCode: 'GB', name: 'United Kingdom', schoolHolidays: false }];
  const c = schoolControls({ checked: true });
  const apply = createSchoolAvailabilityUpdater(c);

  apply(countries, 'US');
  apply(countries, 'GB'); // zweites gesperrtes Land direkt hinterher
  assert.equal(c.showSchool.checked, false);

  apply(countries, 'DE');
  assert.equal(c.showSchool.checked, true, 'auch ueber zwei gesperrte Laender hinweg bleibt der Stand erhalten');
});

test('#965 Review: ein bewusster Klick im entsperrten Zustand ueberlebt den naechsten Umweg', () => {
  const c = schoolControls({ checked: true });
  const apply = createSchoolAvailabilityUpdater(c);

  apply(HOLIDAY_TEST_COUNTRIES, 'US');
  apply(HOLIDAY_TEST_COUNTRIES, 'DE'); // Haken wiederhergestellt
  c.showSchool.checked = false;        // Nutzer schaltet die Ebene jetzt bewusst ab

  apply(HOLIDAY_TEST_COUNTRIES, 'US');
  apply(HOLIDAY_TEST_COUNTRIES, 'DE');
  assert.equal(c.showSchool.checked, false,
    'gemerkt wird der Stand VOR dem Sperren - nicht ein aelterer, laengst verworfener');
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

// Die Waehrungsliste lebte in vier woertlichen Kopien (Einstellungen, Abos,
// Preferences-Route, Geteilte Ausgaben); zwei Guards hielten sie per Regex
// ueber den Quelltext deckungsgleich. Seit #841 gibt es sie einmal, in
// public/utils/currency-codes.js. Der Guard prueft deshalb nicht mehr die
// Gleichheit von Kopien, sondern DASS ES KEINE ZWEITE LISTE GIBT - eine Regel
// ueber alle Dateien statt einer Aufzaehlung der drei, die man damals kannte.
test('the currency list exists exactly once in the repo', async () => {
  const ROOT = new URL('../', import.meta.url);
  const SHARED = 'public/utils/currency-codes.js';
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) await walk(`${rel}/`);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(rel);
    }
  };
  await walk('public/');
  await walk('server/');

  const offenders = [];
  for (const rel of files) {
    if (rel === SHARED) continue;
    const source = await readFile(new URL(rel, ROOT), 'utf8');
    // Ein Array-Literal, dessen Elemente wie ISO-4217-Codes aussehen. Drei
    // Treffer im echten Vorrat trennen eine Waehrungsliste von zufaelligen
    // Grossbuchstaben-Tripeln (Laendercodes, Kuerzel in Testdaten).
    for (const match of source.matchAll(/\[([^\][]*?)\]/gs)) {
      const codes = [...match[1].matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]);
      if (codes.length < 5) continue;
      const known = codes.filter((code) => CURRENCY_CODES.includes(code));
      if (known.length >= 3) offenders.push(`${rel}: ${codes.slice(0, 5).join(', ')} …`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Waehrungslisten gehoeren nach ${SHARED} - eine zweite Kopie driftet:\n${offenders.join('\n')}`,
  );
});

// Der Vorrat ist der, den die Preferences-Route validiert: die Auswahl im
// Browser und die Pruefung im Server lesen dieselbe Konstante.
test('the shared currency list is sorted, unique and ISO-4217 shaped', () => {
  assert.deepEqual([...CURRENCY_CODES].sort(), [...CURRENCY_CODES]);
  assert.equal(new Set(CURRENCY_CODES).size, CURRENCY_CODES.length);
  for (const code of CURRENCY_CODES) assert.match(code, /^[A-Z]{3}$/);
  // Frei gewaehlte Stichprobe aus drei Kontinenten: die Liste ist ein Vorrat,
  // kein Zufallsprodukt eines Refactorings.
  for (const code of ['EUR', 'USD', 'ILS', 'JPY', 'ZAR']) {
    assert.ok(CURRENCY_CODES.includes(code), `${code} fehlt im Vorrat`);
  }
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

// Die Koordinatenvalidierung lag doppelt in admin-weather und personal-weather
// (Critique 2026-07-27) und liegt jetzt einmal in weather-location.js.
test('hasValidWeatherCoords rejects empty, non-numeric and out-of-range input', () => {
  assert.equal(hasValidWeatherCoords('52.52', '13.405'), true);
  assert.equal(hasValidWeatherCoords('-90', '180'), true);
  assert.equal(hasValidWeatherCoords('', '13.405'), false);
  assert.equal(hasValidWeatherCoords('52.52', ''), false);
  assert.equal(hasValidWeatherCoords('abc', '13.405'), false);
  assert.equal(hasValidWeatherCoords('90.1', '13.405'), false);
  assert.equal(hasValidWeatherCoords('52.52', '180.1'), false);
});

// Review-Fund 2026-09-06 (#1027): `Number('')` ist `0`, also speicherte ein
// versehentlich geleertes Feld bislang eine Nachfrist von null Tagen - jeder
// überfällige Countdown wäre sofort verschwunden. Ein leeres/nur-Leerzeichen-
// Feld ist jetzt ausdrücklich ungültig; ein bewusst getipptes `0` bleibt
// gültig, denn "keine Nachfrist" muss weiterhin erreichbar sein.
test('parseGraceDaysInput rejects a blank field but still accepts a deliberate 0, and enforces the existing range', () => {
  assert.equal(parseGraceDaysInput(''), null, 'an empty field must not silently become 0');
  assert.equal(parseGraceDaysInput('   '), null, 'whitespace-only is the same as empty');
  assert.equal(parseGraceDaysInput('0'), 0, 'an explicit 0 stays the deliberate "no grace period" value');
  assert.equal(parseGraceDaysInput('3'), 3);
  assert.equal(parseGraceDaysInput('90'), 90, 'the upper bound is still accepted');
  assert.equal(parseGraceDaysInput('91'), null, 'one above the upper bound is still rejected');
  assert.equal(parseGraceDaysInput('-1'), null, 'still rejected below zero');
  assert.equal(parseGraceDaysInput('abc'), null, 'still rejected for non-numeric input');
});

test('die Reihenfolge expandiert die Kuechen-Sammelzeile auf ihre vier Kinder', () => {
  assert.deepEqual(
    buildOrderPayload(['calendar', 'tasks', 'kitchen', 'notes']).module_order,
    ['calendar', 'tasks', 'meals', 'recipes', 'shopping', 'pantry', 'notes'],
  );
  assert.deepEqual(buildOrderPayload([]).module_order, []);
  assert.deepEqual(buildOrderPayload(['kitchen']).module_order, ['meals', 'recipes', 'shopping', 'pantry']);
});

test('die Reihenfolge behaelt, was das Blatt nie gezeigt hat', () => {
  // Ein Mitglied bekommt `/modules?admin=1` nicht, also stehen seine
  // Drittanbieter-Module in keiner Zeile dieses Blatts. Sie deshalb aus seiner
  // gespeicherten Reihenfolge zu streichen, waere ein stiller Verlust bei einer
  // Handlung, die damit nichts zu tun hat (Codex-Review zu PR #790).
  const payload = buildOrderPayload(['calendar', 'kitchen'], ['third-party-akahu', 'third-party-solar']);
  assert.deepEqual(payload.module_order, [
    'calendar', 'meals', 'recipes', 'shopping', 'pantry',
    'third-party-akahu', 'third-party-solar',
  ]);

  // Was sichtbar war, gewinnt: eine Id, die das Blatt gerendert hat, kommt
  // nicht doppelt zurueck, auch wenn sie faelschlich mitgegeben wird.
  assert.deepEqual(
    buildOrderPayload(['calendar'], ['calendar', 'third-party-akahu']).module_order,
    ['calendar', 'third-party-akahu'],
  );
  assert.deepEqual(buildOrderPayload(['calendar']).module_order, ['calendar']);
});

test('die zwei Blaetter schreiben zwei disjunkte Schluesselmengen', () => {
  // Das ist die Zusicherung, die den Umzug traegt (Critique 2026-08-16): das
  // persoenliche Blatt kennt `disabled_modules` nicht mehr, und das
  // adminOnly-Blatt kennt weder Reihenfolge noch Ausblendungen. Fielen sie
  // wieder zusammen, waere die Verwechslungsfalle zurueck - und ein
  // adminOnly-Blatt, das per-user-Schluessel schreibt, ist genau der Fall, den
  // test:settings-admin-gate sucht.
  const personal = buildOrderPayload(['calendar', 'kitchen']);
  const household = buildActiveModulesPayload(['notes', 'rewards']);

  assert.deepEqual(Object.keys(personal), ['module_order']);
  assert.deepEqual(Object.keys(household), ['disabled_modules']);
  assert.equal('disabled_modules' in personal, false);
  assert.equal('module_order' in household, false);
  assert.equal('hidden_modules' in household, false);
});

test('der Haushalts-Schalter entdoppelt seine Slugs', () => {
  assert.deepEqual(buildActiveModulesPayload(['notes', 'notes', 'meals']), {
    disabled_modules: ['notes', 'meals'],
  });
  assert.deepEqual(buildActiveModulesPayload([]), { disabled_modules: [] });
});

test('buildMobileNavigationPayload normalizes aliases, duplicates, and slot count', () => {
  assert.deepEqual(
    buildMobileNavigationPayload(['recipes', 'tasks', 'meals', 'calendar', 'budget']),
    { mobile_nav_order: ['kitchen', 'tasks', 'calendar'] },
  );
});

test('die Kueche gilt als ausgeblendet, wenn kein SICHTBARES Kind mehr uebrig ist', () => {
  const child = (id, over) => ({ id, enabled: true, hidden: false, ...over });

  assert.equal(kitchenGroupHidden([child('meals'), child('recipes')]), false);
  assert.equal(kitchenGroupHidden([child('meals', { hidden: true }), child('recipes')]), false,
    'ein einzeln verstecktes Kind versteckt noch nicht die Gruppe');
  assert.equal(kitchenGroupHidden([child('meals', { hidden: true }), child('recipes', { hidden: true })]), true);

  // Ein haushaltweit abgeschaltetes Kind zaehlt nicht mit: es ist nicht
  // versteckt, es gibt es nicht. Sonst haette der Gruppenknopf einen Zustand
  // behauptet, den niemand gesetzt hat.
  assert.equal(kitchenGroupHidden([child('meals', { hidden: true }), child('recipes', { enabled: false })]), true);
  assert.equal(kitchenGroupHidden([child('meals'), child('recipes', { enabled: false })]), false);

  // Alle vier abgeschaltet: die Gruppe ist dann nicht "von mir versteckt",
  // sondern gar nicht da - der Knopf ist ohnehin gesperrt.
  assert.equal(kitchenGroupHidden([child('meals', { enabled: false }), child('recipes', { enabled: false })]), false);
  assert.equal(kitchenGroupHidden([]), false);
});

test('der Sitzungs-Teardown vergisst jeden per-Nutzer-Zustand, den die Navigation liest', async () => {
  // Zwei Abgaenge, kein geteilter Code: der bewusste Logout und der
  // Sitzungsablauf raeumten getrennt auf, und was nur in einem stand, vererbte
  // sich am geteilten Geraet an das naechste Mitglied. Geprueft wird die REGEL:
  // jeder per-Nutzer-Zustand, den `navItems()` liest, muss in der einen
  // Aufraeumfunktion vorkommen, und beide Wege muessen sie rufen.
  const source = await readFile(new URL('../public/router.js', import.meta.url), 'utf8');

  const teardown = source.slice(source.indexOf('function forgetSessionState()'));
  const body = teardown.slice(0, teardown.indexOf('\n}'));
  for (const state of ['_preferencesLoaded', '_hiddenModules', '_moduleOrder', '_mobileNavOrder', 'currentUser']) {
    assert.match(body, new RegExp(`${state}\\s*=`), `forgetSessionState() vergisst ${state} nicht`);
  }
  // `_disabledModules` gehoert ausdruecklich NICHT dazu: haushaltweit, fuer
  // jeden gleich, und der Modul-Guard laeuft vor dem Nachladen.
  assert.equal(/_disabledModules\s*=/.test(body), false,
    '_disabledModules ist haushaltweit - es zurueckzusetzen oeffnet die Route, die der Haushalt abgeschaltet hat');

  assert.match(source, /auth:expired[\s\S]{0,200}forgetSessionState\(\)/,
    'der Sitzungsablauf raeumt nicht auf');
  assert.match(source, /clearSession: \(\) => \{\s*forgetSessionState\(\)/,
    'der bewusste Logout raeumt nicht ueber dieselbe Funktion auf');
});

test('der Haushalts-Schalter nimmt sich zurueck, wenn das Speichern scheitert', async () => {
  // Die drei Faelle zogen mit dem Schalter von der Navigation auf das neue
  // Blatt und gingen beim Umzug verloren - der Fehlerpfad des einzigen Blatts,
  // das ein Modul fuer ALLE abschaltet, stand danach ungeprueft da.
  const input = { checked: true, disabled: true };
  let rerendered = false;

  await assert.rejects(
    persistHouseholdToggle(input, true, async () => { throw new Error('save failed'); }, async () => {
      rerendered = true;
    }),
    /save failed/,
  );

  assert.equal(input.checked, false, 'der Schalter blieb auf dem nicht gespeicherten Zustand stehen');
  assert.equal(input.disabled, false);
  assert.equal(rerendered, false, 'ein gescheitertes Speichern darf nicht neu rendern');
});

test('der Haushalts-Schalter rendert erst nach erfolgreichem Speichern neu', async () => {
  const input = { checked: false, disabled: true };
  const calls = [];

  await persistHouseholdToggle(input, false, async () => { calls.push('save'); }, async () => { calls.push('render'); });

  assert.deepEqual(calls, ['save', 'render']);
  assert.equal(input.checked, false);
});

test('ein gescheiterter Re-Render nimmt den gespeicherten Schalter NICHT zurueck', async () => {
  const input = { checked: true, disabled: true };

  await assert.rejects(
    persistHouseholdToggle(input, true, async () => {}, async () => { throw new Error('render failed'); }),
    /render failed/,
  );

  // Gespeichert ist gespeichert: den Schalter hier zurueckzudrehen wuerde einen
  // Zustand zeigen, den der Server nicht mehr hat.
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
