import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { eachRule } from './css-rules.js';

import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_DOMAINS,
  SETTINGS_LEAVES,
  SETTINGS_SCOPES,
  SETTINGS_SECTIONS,
  SETTINGS_STORAGE_KEY,
  filterSettingsDomains,
  currentSettingsPath,
  RENAMED_SETTINGS_SOURCE_PATHS,
  findSettingsLeaf,
  firstSettingsSheet,
  movedSettingsUrl,
  settingsSectionUrl,
  settingsSheetSections,
  migrateLegacySettingsTab,
  readStoredSettingsDestination,
  resolveSettingsDestination,
  searchSettings,
  settingsOptionUrl,
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
  groupLookupAfterSubdivisions,
  resolveHolidayGroup,
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
  ...SETTINGS_SECTIONS.flatMap((section) => [section.labelKey, section.descriptionKey]),
];
const sharedTranslationKeys = [
  'settings.navigationLabel',
  'settings.breadcrumbLabel',
  'settings.scopeMine',
  'settings.scopeHousehold',
  'settings.moduleStatusOn',
  'settings.moduleStatusOff',
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

test('die Blaetter verteilen sich wie beschlossen auf drei Bereiche, je Modul ein Blatt (R10)', () => {
  // Re-Critique 2026-09-27 (A7 P1-3): vier Bereiche mit 32 Blaettern, ein Modul
  // an bis zu fuenf Orten. Jetzt Konto / Haushalt / Module, und je Modul EIN
  // Blatt - die Verteilung ist die IA-Aussage, keine nackte Gesamtzahl.
  const perDomain = {};
  for (const leaf of SETTINGS_LEAVES) perDomain[leaf.domainId] = (perDomain[leaf.domainId] ?? 0) + 1;
  // R14 (A7 P2-3): Inventar und Entsorgung bekommen ein Blatt fuer ihren Feed.
  assert.deepEqual(perDomain, { personal: 5, admin: 8, modules: 15 });
  assert.deepEqual(SETTINGS_DOMAINS.map((domain) => domain.id), ['personal', 'admin', 'modules']);
  // Jedes Blatt haengt an einem existierenden Bereich, jeder Abschnitt an
  // einem existierenden Blatt, und kein Blatt ist leer.
  const domainIds = new Set(SETTINGS_DOMAINS.map((domain) => domain.id));
  const sheetIds = new Set(SETTINGS_LEAVES.map((leaf) => leaf.id));
  for (const leaf of SETTINGS_LEAVES) {
    assert.ok(domainIds.has(leaf.domainId), `${leaf.id}: unbekannter Bereich "${leaf.domainId}"`);
    assert.ok(settingsSheetSections(leaf, admin).length > 0, `${leaf.id}: Blatt ohne Abschnitt`);
  }
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(sheetIds.has(section.sheetId), `${section.id}: unbekanntes Blatt "${section.sheetId}"`);
    assert.ok(SETTINGS_SCOPES.includes(section.scope), `${section.id}: unbekannte Reichweite "${section.scope}"`);
  }
  assert.equal(new Set(SETTINGS_SECTIONS.map((section) => section.id)).size, SETTINGS_SECTIONS.length);
  // Je Modul hoechstens EIN Blatt.
  const modules = SETTINGS_LEAVES.filter((leaf) => leaf.module).map((leaf) => leaf.module);
  assert.equal(new Set(modules).size, modules.length, 'ein Modul hat zwei Blaetter');
  // Die Sammelschublade ist aufgeloest: kein Blatt heisst mehr Modul-Optionen.
  assert.equal(SETTINGS_LEAVES.some((leaf) => leaf.labelKey === 'settings.pageModuleOptions'), false);
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

test('sign out other devices names the rate limit instead of a generic failure (#1354)', async () => {
  // Review zu #1423: ein 429 las sich wie "fehlgeschlagen", obwohl nur zu
  // schnell geklickt wurde - die Seite muss sagen, dass Warten hilft.
  const { logoutOthersErrorText } = await import('/settings/pages/personal-account.js');
  assert.equal(typeof logoutOthersErrorText, 'function');
  assert.equal(logoutOthersErrorText({ status: 429 }), 'settings.otherSessionsTooManyAttempts');
  assert.equal(logoutOthersErrorText({ status: 500 }), 'settings.otherSessionsError');
  assert.equal(logoutOthersErrorText(new Error('offline')), 'settings.otherSessionsError');

  // Der Klick-Handler nimmt genau diese Funktion - sonst misst der Fall oben
  // eine Funktion, die niemand aufruft.
  const source = await readFile(new URL('../public/settings/pages/personal-account.js', import.meta.url), 'utf8');
  assert.match(source, /catch \(error\) \{\s*showError\(errorBox, logoutOthersErrorText\(error\)\);/);
});

test('sign out other devices: hint, status and buttons keep a token gap, an empty status none (#1423)', async () => {
  // a11y-Audit zu #1423: zwischen Hinweis, Statuszeile und Knopfreihe standen
  // 0 px. Der Status las sich als vierte Zeile des Hinweises, und der Fokusring
  // des Knopfes lag auf dem Statustext.
  const { otherSessionsCardHtml } = await import('/settings/pages/personal-account.js');
  assert.equal(typeof otherSessionsCardHtml, 'function', 'die Karte hat einen eigenen Baustein');
  const html = otherSessionsCardHtml();
  const classesOf = (id) => html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0]?.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
  assert.ok(classesOf('logout-others-status').includes('settings-sessions__status'), 'Statuszeile traegt ihre Klasse');
  // Leer im Markup, damit `:not(:empty)` greift - schon ein Zeilenumbruch darin
  // gaebe der leeren Zeile ihren Abstand.
  assert.match(html, /id="logout-others-status"[^>]*><\/p>/);
  const actions = html.match(/<div class="([^"]*)">\s*<button[^>]*id="logout-others-btn"/)?.[1]?.split(/\s+/) ?? [];
  assert.ok(actions.includes('settings-sessions__actions'), 'Knopfreihe traegt ihre Klasse');

  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const marginTopOf = (selector) => {
    const rule = rules.find((r) => r.selector.split(',').map((s) => s.trim()).includes(selector));
    return rule?.body.match(/(?:^|;)\s*margin-top\s*:\s*([^;]+)/)?.[1]?.trim() ?? null;
  };
  assert.match(marginTopOf('.settings-sessions__status:not(:empty)') ?? '', /^var\(--space-\d+\)$/, 'Status: Abstand aus tokens.css');
  assert.match(marginTopOf('.settings-sessions__actions') ?? '', /^var\(--space-\d+\)$/, 'Knopfreihe: Abstand aus tokens.css');
  // Die LEERE Statuszeile bekommt keinen: keine Regel auf die blosse Klasse,
  // die Hoehe oder Abstand setzt.
  const bare = rules.filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.settings-sessions__status'));
  for (const rule of bare) assert.doesNotMatch(rule.body, /margin|padding|min-height|height/, rule.body);
});

test('two-factor card: every line and the button row keep a token gap, in every state (a11y leftovers)', async () => {
  // a11y-Runde: in der 2FA-Karte standen Hinweis und Knopf mit 0 px
  // untereinander, der Fokusring des Knopfes lag auf dem Hinweis. Dieselbe
  // Loesung wie "Andere Geraete" (#1427): jede Zeile nach der ersten und die
  // Knopfreihe tragen eine Klasse, deren Abstand aus tokens.css kommt.
  const { twoFactorCardHtml } = await import('/settings/pages/personal-account.js');
  const states = [
    { enabled: false, pending: false, recovery_remaining: 0, required: false },
    { enabled: false, pending: false, recovery_remaining: 0, required: true },
    { enabled: true, pending: false, recovery_remaining: 8, required: false },
    { enabled: true, pending: false, recovery_remaining: 0, required: true },
  ];
  for (const state of states) {
    const html = twoFactorCardHtml(state);
    // Die Karte selbst, dann ihre Zeilen in Dokumentreihenfolge (p und div).
    const [, ...lines] = [...html.matchAll(/<(p|div)\b[^>]*>/g)]
      .map(([tag]) => ({ tag, classes: tag.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [] }));
    assert.ok(lines.length >= 3, `zu wenige Zeilen gelesen (${JSON.stringify(state)})`);
    const [lead, ...rest] = lines;
    assert.ok(lead.classes.includes('form-hint'), `die erste Zeile ist der Hinweis: ${lead.tag}`);
    for (const { tag, classes } of rest) {
      const expected = classes.includes('settings-form-actions') ? 'settings-2fa__actions' : 'settings-2fa__note';
      assert.ok(classes.includes(expected), `${tag} ohne ${expected} (${JSON.stringify(state)})`);
    }
  }

  // Die Codes-Ansicht: die Statuszeile steht NACH der Knopfreihe und ist leer,
  // bis kopiert wurde; die Rueckfrage: Hinweis und Formular.
  const source = await readFile(new URL('../public/settings/pages/personal-account.js', import.meta.url), 'utf8');
  const recovery = source.slice(source.indexOf('function renderRecoveryCodes'), source.indexOf('function askForCode'));
  assert.match(recovery, /class="settings-form-actions settings-2fa__actions"/);
  assert.match(recovery, /class="form-hint settings-2fa__note" id="two-factor-copy-status" role="status"><\/p>/,
    'Statuszeile traegt ihre Klasse und bleibt leer im Markup');
  const ask = source.slice(source.indexOf('function askForCode'));
  assert.match(ask, /<form id="two-factor-confirm-form" class="settings-form settings-2fa__form">/);

  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const marginTopOf = (selector) => {
    const rule = rules.find((r) => !r.at?.length && r.selector.split(',').map((s) => s.trim()).includes(selector));
    return rule?.body.match(/(?:^|;)\s*margin-top\s*:\s*([^;]+)/)?.[1]?.trim() ?? null;
  };
  for (const selector of ['.settings-2fa__note:not(:empty)', '.settings-2fa__actions', '.settings-2fa__form']) {
    assert.match(marginTopOf(selector) ?? '', /^var\(--space-\d+\)$/, `${selector}: Abstand aus tokens.css`);
  }
  const bare = rules.filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.settings-2fa__note'));
  for (const rule of bare) assert.doesNotMatch(rule.body, /margin|padding|min-height|height/, rule.body);
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
  // (Critique 2026-07-27). Seit R10 steht es bei den Modulen, fuer alle.
  assert.equal(findSettingsLeaf('/settings/modules/navigation', member)?.id, 'modules-navigation');
  assert.equal(findSettingsLeaf('/settings/modules/navigation', admin)?.id, 'modules-navigation');
  // Der Pfad von vor R10 bleibt erreichbar und landet am neuen Ort.
  assert.equal(findSettingsLeaf('/settings/personal/navigation', member)?.path, '/settings/modules/navigation');
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'modules-navigation');
  assert.equal(section.adminOnly, false);
  assert.equal(section.scope, 'mine');
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
  assert.deepEqual(settingsSheetSections(leaf, admin).map((section) => section.adminOnly), [true]);
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

test('members only see the account and module settings domains', () => {
  // Haushalt bleibt Admin-Sache; bei den Modulen sieht ein Mitglied nur die
  // Blaetter mit einem "Fuer mich"-Abschnitt.
  assert.deepEqual(filterSettingsDomains(member).map((domain) => domain.id), ['personal', 'modules']);
});

test('admins see all settings domains', () => {
  assert.deepEqual(
    filterSettingsDomains(admin).map((domain) => domain.id),
    ['personal', 'admin', 'modules'],
  );
});

test('verschobene Blatt-Pfade landen am neuen Ort statt beim Fallback', () => {
  // Alte Bookmarks und gespeicherte Ziele duerfen nicht stumm auf
  // `personal/account` fallen - auch die aus aelteren Umbauten nicht.
  assert.equal(findSettingsLeaf('/settings/documents/storage', admin)?.path, '/settings/modules/documents');
  assert.equal(findSettingsLeaf('/settings/sync/dms', admin)?.path, '/settings/modules/documents');
  assert.equal(currentSettingsPath('/settings/sync/storage'), '/settings/modules/documents');
  assert.equal(currentSettingsPath('/settings/modules/documents'), '/settings/modules/documents');
  assert.equal(currentSettingsPath('/settings/unbekannt'), '/settings/unbekannt');
  assert.equal(movedSettingsUrl('/settings/documents/dms'), '/settings/modules/documents?section=documents-dms');
  // Rollen-Gate greift auch ueber den alten Pfad.
  assert.equal(findSettingsLeaf('/settings/documents/storage', member), null);
});

test('das aufgelöste Übersicht-Blatt landet beim Haushalts-Wetter', () => {
  // "Übersicht" trug Haushalts-Wetter und App-Name (Critique 2026-07-27); der
  // Alt-Pfad zeigt seit R10 auf die Wetter-Quelle unter Haushalt > Integrationen.
  assert.equal(currentSettingsPath('/settings/modules/dashboard'), '/settings/admin/integrations');
  assert.equal(movedSettingsUrl('/settings/modules/dashboard'), '/settings/admin/integrations?section=admin-weather');
  assert.equal(findSettingsLeaf('/settings/modules/dashboard', member), null);
  assert.equal(SETTINGS_LEAVES.some((leaf) => leaf.id === 'modules-dashboard'), false);
});

test('Mitglieder erreichen ihre eigenen Termin-Vorgaben', () => {
  // calendar_default_reminders und calendar_default_assign_me schreiben per
  // cfgUserSet pro Nutzer (Critique 2026-07-27). Seit R10 "Fuer mich" im Blatt
  // Kalender - das Mitglied sieht das Blatt, aber nur seine Abschnitte.
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'personal-calendar');
  assert.equal(section.adminOnly, false);
  assert.equal(section.scope, 'mine');
  const sheet = findSettingsLeaf('/settings/personal/calendar', member);
  assert.equal(sheet?.id, 'module-calendar');
  assert.deepEqual(settingsSheetSections(sheet, member).map((entry) => entry.id),
    ['personal-calendar', 'personal-calendar-subscriptions', 'personal-feeds']);
  // Der haushaltweite Teil bleibt adminOnly.
  assert.deepEqual(settingsSheetSections(sheet, admin).filter((entry) => entry.adminOnly).map((entry) => entry.id),
    ['modules-calendar', 'sync-calendar']);
});

test('Mitglieder erreichen ihr eigenes Zyklus-Opt-out (#760)', () => {
  // health_cycle_enabled_user schreibt per cfgUserSet pro Nutzer - derselbe
  // Schnitt wie bei personal-calendar.
  const sheet = findSettingsLeaf('/settings/personal/health', member);
  assert.equal(sheet?.id, 'module-health');
  // R14: dazu der eigene Zyklus-Export, der vorher im Kalender-Blatt stand.
  assert.deepEqual(settingsSheetSections(sheet, member).map((entry) => entry.id), ['personal-health', 'feed-cycle']);
  // Der haushaltweite Schalter bleibt daneben adminOnly.
  assert.deepEqual(settingsSheetSections(sheet, admin).map((entry) => entry.id),
    ['personal-health', 'feed-cycle', 'options-health', 'modules-health']);
});

test('die Modul-Optionen sind aufgeloest: jeder Teil steht im Blatt seines Moduls', async () => {
  // Re-Critique 2026-09-27 (A7 P1-3): "Modul-Optionen" war eine Sammelschublade
  // fuer Budget, Gesundheit, Haushaltshilfe, Aufgaben und Schichtplan.
  const parts = SETTINGS_SECTIONS.filter((section) => String(section.loader).includes('modules-options.js'));
  assert.deepEqual(
    Object.fromEntries(parts.map((section) => [section.props?.part, section.sheetId])),
    {
      budget: 'module-budget',
      health: 'module-health',
      housekeeping: 'module-housekeeping',
      tasks: 'module-tasks',
      schedule: 'module-schedule',
    },
  );
  for (const section of parts) assert.equal(section.adminOnly, true, `${section.id} ist haushaltweit`);
  // Das Blatt rendert nur den Teil, den sein Traeger nennt - sonst stuende auf
  // jedem Modulblatt die ganze Schublade.
  const source = await readFile(new URL('../public/settings/pages/modules-options.js', import.meta.url), 'utf8');
  assert.match(source, /renderPage\(container, preferences, container\.dataset\.part\)/);
  assert.match(source, /PARTS\.includes\(part\) \? \[part\] : PARTS/);
  const shell = await settingsShellSource();
  assert.match(shell, /if \(section\.props\?\.part\) host\.dataset\.part = section\.props\.part;/);
  // Die frueheren Alias-Pfade sind wieder eigene Blaetter.
  for (const path of ['/settings/modules/budget', '/settings/modules/housekeeping']) {
    assert.equal(currentSettingsPath(path), path);
    assert.equal(findSettingsLeaf(path, member), null);
  }
  // Ein Suchtreffer von gestern (`/settings/modules/options?option=...`) landet
  // am Abschnitt, der die Option heute fuehrt.
  assert.equal(movedSettingsUrl('/settings/modules/options', 'option=settings.healthCycleEnableLabel'),
    '/settings/modules/health?section=options-health&option=settings.healthCycleEnableLabel');
  assert.equal(movedSettingsUrl('/settings/modules/options'), '/settings/modules/budget?section=options-budget');
});

test('/settings/modules/health ist das Blatt Gesundheit samt Vorsorge-Typregister', () => {
  assert.equal(currentSettingsPath('/settings/modules/health'), '/settings/modules/health');
  const leaf = findSettingsLeaf('/settings/modules/health', admin);
  assert.equal(leaf?.id, 'module-health');
  assert.equal(leaf?.module, 'health');
  assert.ok(settingsSheetSections(leaf, admin).some((section) => section.id === 'modules-health'));
  assert.equal(settingsSheetSections(leaf, member).some((section) => section.id === 'modules-health'), false,
    'das Typregister bleibt adminOnly');
});

test('legacy settings tabs migrate to their new destinations', () => {
  assert.equal(migrateLegacySettingsTab('general'), '/settings/personal/appearance');
  assert.equal(migrateLegacySettingsTab('shopping'), '/shopping?manage=categories');
  assert.equal(migrateLegacySettingsTab('sync'), '/settings/modules/calendar');
  assert.equal(migrateLegacySettingsTab('backup'), '/settings/admin/backup');
  // Ein Alt-Tab muss am heutigen Blatt ankommen, nicht an einem Zwischenstand.
  assert.equal(migrateLegacySettingsTab('budget'), '/settings/modules/budget');
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
      sync: '/settings/modules/calendar',
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
    '/settings/modules/documents',
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
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/modules/documents' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/modules/documents');
});

test('readStoredSettingsDestination hebt ein vor dem IA-Umbau gespeichertes Ziel an', () => {
  const storage = createMemoryStorage({ [SETTINGS_STORAGE_KEY]: '/settings/documents/dms' });
  assert.equal(readStoredSettingsDestination(admin, storage), '/settings/modules/documents');
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

  // Seit R15 A7 P1-1 fragt nicht mehr jeder Link selbst, sondern der Router
  // fuer JEDEN Weg: der Guard meldet sich beim Verlassen-Schutz an (Programm-
  // Test unten). Ein zweites Fragen im Link waere eine zweite Buchfuehrung.
  assert.match(guard, /import \{ setLeaveGuard \} from '\/utils\/leave-guard\.js';/);
  assert.doesNotMatch(shell, /confirmLeafExit/, 'der Link fragt nicht selbst - navigate() fragt fuer alle Wege');
  assert.match(shell, /watchLeafForms\(leafContainer\)/, 'das Tracking haengt am fertig gerenderten Blatt');
});

/* EINSTELLUNGEN VERLIEREN NICHTS STILL (Re-Critique 2026-09-28 R15, A7 P1-1).
 * Der Blatt-Guard fragte nur in den Links der Shell; Browser-Zurueck, die
 * Befehlspalette, Tab-Leiste und Mehr-Blatt liefen an ihm vorbei in
 * navigate() und warfen den offenen Stand weg. Die Rechte-Matrix (kein
 * <form>) sah er gar nicht. Gemessen als Programm: Formular-Stubs, echte
 * Listener des Guards, der echte Verlassen-Schutz, den der Router fragt. */
function guardFakes() {
  const container = {
    isConnected: true,
    on: {},
    addEventListener(type, fn) { (this.on[type] ??= []).push(fn); },
  };
  const form = {
    isConnected: true,
    querySelector: (sel) => (/type="submit"/.test(sel) ? {} : null),
  };
  const field = (instant = false) => ({
    closest: (sel) => (sel === 'form' ? form : (sel === '[data-instant-save]' && instant ? {} : null)),
  });
  const fire = (type, target, isTrusted = true) => {
    for (const fn of container.on[type] ?? []) fn({ type, target, isTrusted });
  };
  return { container, form, field, fire };
}

async function withGuardEnv(fn) {
  const prev = { window: globalThis.window, confirm: globalThis.__confirmModal };
  globalThis.window = { ...(prev.window ?? {}), addEventListener() {}, removeEventListener() {} };
  const gefragt = [];
  let antwort = false;
  globalThis.__confirmModal = async (title, options) => { gefragt.push({ title, options }); return antwort; };
  const guard = await import('/settings/dirty-guard.js');
  const leave = await import('/utils/leave-guard.js');
  try {
    await fn({ guard, leave, gefragt, antworte: (a) => { antwort = a; } });
  } finally {
    guard.clearLeafEdits?.();
    globalThis.window = prev.window;
    globalThis.__confirmModal = prev.confirm;
  }
}

test('Einstellungen: ein offenes Formular fragt vor JEDEM Wechsel ueber den Router - nur solange etwas offen ist (R15 A7 P1-1)', async () => {
  await withGuardEnv(async ({ guard, leave, gefragt, antworte }) => {
    const { container, form, field, fire } = guardFakes();
    guard.watchLeafForms(container);
    assert.equal(leave.hasLeaveGuard(), false, 'sauberes Blatt: kein Waechter, die Navigation bleibt ohne await');

    fire('change', field(), false);
    assert.equal(leave.hasLeaveGuard(), false, 'programmatische Werte sind keine Nutzerarbeit');

    fire('input', field());
    assert.equal(leave.hasLeaveGuard(), true, 'eine echte Eingabe meldet den Schutz beim Router an');
    antworte(false);
    assert.equal(await leave.mayLeave('/tasks'), false, 'Palette, Zurueck, Tab-Leiste: ein Nein haelt das Blatt');
    assert.equal(gefragt.length, 1);
    assert.equal(gefragt[0].title, 'modal.unsavedChanges', 'dieselbe Rueckfrage wie Dialog und Anpassen-Modus');
    assert.equal(gefragt[0].options.danger, true, 'Verwerfen ist rot wie im Dialog-Schutz');
    assert.equal(gefragt[0].options.confirmLabel, 'modal.discardChanges');
    assert.equal(gefragt[0].options.detail, 'settings.leaveDiscardDetail', 'der rote Dialog nennt seine Folgen');

    antworte(true);
    assert.equal(await leave.mayLeave('/tasks'), true, 'Verwerfen laesst gehen');
    assert.equal(leave.hasLeaveGuard(), false, 'danach ist nichts mehr offen');

    fire('change', field());
    assert.equal(leave.hasLeaveGuard(), true);
    fire('submit', field());
    assert.equal(leave.hasLeaveGuard(), false, 'gespeichert = sauber, der Waechter geht');

    fire('change', field());
    form.isConnected = false;
    const vorher = gefragt.length;
    assert.equal(await leave.mayLeave('/tasks'), true, 'ein abgehaengtes Formular haelt niemanden');
    assert.equal(gefragt.length, vorher, 'und fragt auch nicht');
  });
});

test('Einstellungen: ein Sofort-Schalter im Formular hinterlaesst keinen offenen Stand (R15 A7 P1-1)', async () => {
  await withGuardEnv(async ({ guard, leave }) => {
    const { container, field, fire } = guardFakes();
    guard.watchLeafForms(container);
    fire('change', field(true));
    assert.equal(leave.hasLeaveGuard(), false, 'data-instant-save: gespeichert beim Umlegen, nichts zu verlieren');
    fire('change', field(false));
    assert.equal(leave.hasLeaveGuard(), true, 'Gegenprobe: ein Feld ohne die Marke zaehlt');
  });
});

test('Einstellungen: ein Blatt ohne Formular (Rechte-Matrix) meldet seinen Entwurf selbst an (R15 A7 P1-1)', async () => {
  await withGuardEnv(async ({ guard, leave, gefragt }) => {
    const { container } = guardFakes();
    guard.watchLeafForms(container);
    let dirty = false;
    const knoten = { isConnected: true };
    const abmelden = guard.trackLeafEdits(knoten, () => dirty);
    assert.equal(leave.hasLeaveGuard(), false, 'sauberer Entwurf: kein Waechter');
    dirty = true;
    guard.syncLeafEdits();
    assert.equal(leave.hasLeaveGuard(), true, 'offener Entwurf: angemeldet');
    assert.equal(await leave.mayLeave('/calendar'), false, 'und gefragt');
    assert.equal(gefragt.length, 1);
    guard.watchLeafForms(container);
    assert.equal(leave.hasLeaveGuard(), true, 'ein Neuaufbau der Formularwache wirft die Quelle des Blatts nicht weg');
    dirty = false;
    guard.syncLeafEdits();
    assert.equal(leave.hasLeaveGuard(), false, 'gespeichert: abgemeldet');
    abmelden();
  });
  const src = await readFile(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  assert.match(src, /trackLeafEdits\(container, \(\) => state\.dirty\)/, 'die Matrix meldet ihren Entwurf an');
  const update = src.slice(src.indexOf('function updateSaveState('), src.indexOf('\n}\n', src.indexOf('function updateSaveState(')));
  assert.match(update, /syncLeafEdits\(\)/, 'jede Aenderung des Entwurfs gleicht die Anmeldung ab');
});

test('Feiertage: die Ebenen-Schalter speichern sofort, ein Fehler legt zurueck (R15 A7 P1-1)', async () => {
  const cal = await import('../public/settings/pages/modules-calendar.js');
  assert.equal(typeof cal.bindHolidayLayerSwitches, 'function');
  const prevWindow = globalThis.window;
  const toasts = [];
  globalThis.window = { ...(prevWindow ?? {}), yuvomi: { showToast: (...a) => toasts.push(a) } };
  const schalter = (checked) => ({
    checked, disabled: false, isConnected: true, on: {},
    addEventListener(type, fn) { (this.on[type] ??= []).push(fn); },
    async fire() { for (const fn of this.on.change ?? []) await fn(); },
  });
  try {
    const showPublic = schalter(false);
    const showSchool = schalter(true);
    const publicColorGroup = { hidden: true };
    const schoolColorGroup = { hidden: false };
    const gespeichert = [];
    let fehler = null;
    cal.bindHolidayLayerSwitches({
      showPublic, showSchool, publicColorGroup, schoolColorGroup,
      save: async (patch) => { if (fehler) throw fehler; gespeichert.push(patch); },
    });
    showPublic.checked = true;
    await showPublic.fire();
    assert.deepEqual(gespeichert, [{ holiday_show_public: true }], 'nur der eigene Wert, ohne Land und Farben');
    assert.equal(toasts.at(-1)?.[1], 'success');
    assert.equal(showPublic.disabled, false, 'nach dem Speichern wieder bedienbar');

    fehler = new Error('offline');
    showSchool.checked = false;
    schoolColorGroup.hidden = true;
    await showSchool.fire();
    assert.equal(showSchool.checked, true, 'Fehler: der Schalter legt sich zurueck');
    assert.equal(schoolColorGroup.hidden, false, 'und die Farbe folgt ihm');
    assert.equal(toasts.at(-1)?.[1], 'danger');
  } finally {
    globalThis.window = prevWindow;
  }
});

/* KEIN SCHALTER IM FORMULAR OHNE ANTWORT (R15 A7 P1-1). Ein `role=switch` in
 * einem Formular mit Speichern-Knopf ist entweder ein Sofort-Schalter
 * (`data-instant-save`, eigener Speicherweg) oder steht in einem Formular,
 * dessen Felder aneinander haengen - dann haelt ihn der Blatt-Guard (oben
 * als Programm gemessen), und das Formular steht hier mit Grund. Ein neues
 * Formular mit Schalter muss sich fuer eine der beiden Antworten entscheiden. */
const GUARDED_SWITCH_FORMS = new Map([
  ['admin-api.js#api-token-form', 'Anlegen: der Schalter ist ein Merkmal des neuen Tokens'],
  ['admin-backup.js#backup-webdav-form', 'Aktivieren ohne Adresse und Zugang waere ein Sicherungsauftrag ins Leere'],
  ['admin-family.js#add-member-form', 'Anlegen eines Mitglieds'],
  ['admin-family.js#edit-member-form', 'Dialog mit eigenem Dirty-Schutz (components/modal.js)'],
  ['admin-weather.js#weather-form', 'Automatisch orten fuellt die Koordinaten desselben Formulars'],
  ['personal-weather.js#pweather-form', 'Automatisch orten fuellt die Koordinaten desselben Formulars'],
  ['notifications.js#${esc(channel.id ?? \'\')}', 'Kanal: Aktiv haengt an Adresse und Zugang des Kanals'],
  ['personal-calendar-subscriptions.js#ics-add-form', 'Anlegen eines Abos'],
  ['personal-calendar-subscriptions.js#ics-edit-form', 'Dialog mit eigenem Dirty-Schutz (components/modal.js)'],
]);

test('Einstellungen: jeder Schalter in einem Formular mit Speichern speichert sofort oder steht im Guard mit Grund (R15 A7 P1-1)', async () => {
  const dir = new URL('../public/settings/', import.meta.url);
  const files = [
    ...(await readdir(new URL('pages/', dir))).map((f) => `pages/${f}`),
    'weather-location.js',
  ];
  const sources = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(new URL(f, dir), 'utf8')])));
  const gefunden = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
      const body = m[0];
      if (!/type="submit"/.test(body)) continue;
      const id = body.match(/id="([^"]+)"/)?.[1] ?? '?';
      const key = `${file.replace(/^pages\//, '')}#${id}`;
      // Der Standort-Baustein bringt seinen Schalter von aussen mit.
      const calls = [...body.matchAll(/toggleRowHtml\(\{[\s\S]*?\}\)\}/g)].map((c) => c[0])
        .concat(/weatherLocationFieldsHtml\(/.test(body) ? [sources['weather-location.js']] : []);
      for (const call of calls) {
        if (!/control: 'switch'/.test(call)) continue;
        gefunden.push(key);
        if (/'data-instant-save': true/.test(call)) continue;
        assert.ok(GUARDED_SWITCH_FORMS.has(key),
          `${key}: Schalter ohne data-instant-save in einem Formular mit Speichern - sofort speichern oder mit Grund in GUARDED_SWITCH_FORMS`);
      }
    }
  }
  assert.ok(gefunden.includes('modules-calendar.js#holidays-form'), 'der Leser findet die Feiertags-Schalter');
  for (const key of GUARDED_SWITCH_FORMS.keys()) {
    assert.ok(gefunden.includes(key), `${key}: steht in der Ausnahmeliste, hat aber keinen Schalter (mehr) - Eintrag streichen`);
  }
  const cal = sources['pages/modules-calendar.js'];
  for (const id of ['holiday-show-public', 'holiday-show-school']) {
    assert.match(cal, new RegExp(`attrs: \\{ id: '${id}', 'data-instant-save': true \\}`), `${id} ist ein Sofort-Schalter`);
  }
  assert.match(cal, /bindHolidayLayerSwitches\(\{ showPublic, showSchool, publicColorGroup, schoolColorGroup \}\);/,
    'die Seite verdrahtet die Sofort-Speicherung wirklich');
});

test('die Navigation laesst sich ueber alle Blaetter durchsuchen', async () => {
  const source = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const registry = await readFile(new URL('../public/settings/registry.js', import.meta.url), 'utf8');
  // Bei 23 Blaettern in vier Domaenen war die Taxonomie der einzige Weg zu
  // einer Einstellung, deren Domaene man nicht kennt (Critique 2026-07-27).
  // Seit 2026-09-26 ist es das geteilte Suchfeld der Shell (gefuellte Kapsel)
  // und dieselbe Suche wie in der Wurzel - searchSettings() aus der Registry,
  // die Label, Beschreibung, Bereich UND die einzelnen Optionen durchsucht
  // (Verhalten: der Test "die Suche findet einzelne Optionen" weiter unten).
  const navSearch = source.slice(source.indexOf('function createNavigationSearch'), source.indexOf('function createNavigation('));
  assert.match(navSearch, /renderPageSearch\(\{\s*id: 'settings-navigation-search'/, 'die Seitenleiste nimmt das geteilte Suchfeld');
  assert.doesNotMatch(navSearch, /form-input/, 'kein eigenes Suchfeld neben der Kapsel');
  assert.match(navSearch, /searchSettings\(query, \{ user, translate: t \}\)/);
  assert.match(registry, /descriptionKey/, 'gefiltert wird ueber Label UND Beschreibung');
  assert.match(registry, /normalize\('NFD'\)/, 'die Suche muss Gross-/Kleinschreibung und Diakritika ignorieren');
  assert.match(navSearch, /setAttribute\('role',\s*'status'\)/, 'die Trefferzahl gehoert in eine Live-Region');
  // Ohne Treffer greift der bestehende Leerzustand, statt stumm zu bleiben.
  assert.match(navSearch, /t\('search\.noResults'\)/);
});

/**
 * DIE SUCHE FINDET EINZELNE OPTIONEN (Critique 2026-09-26, A7 P1). Gemessen
 * lieferten "Zeitzone", "Dunkel", "Einladung", "Mealie" und "Zwei-Faktor"
 * null Treffer, "Wand" nur die Wandtabletts statt des Wand-Modus: die Suche
 * kannte nur Blatt-Titel und -Beschreibung. Gefahren wird die echte Suche mit
 * dem deutschen Locale - dieselbe Funktion, die Wurzel und Seitenleiste rufen.
 */
test('die Suche findet einzelne Optionen, nicht nur Blaetter', async () => {
  const de = JSON.parse(await readFile(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de) ?? key;
  const admin = { role: 'admin' };
  // Seit R10 steht eine Option in einem Abschnitt eines Blatts: gefragt wird
  // der Abschnitt (das fruehere Blatt), das Sprungziel ist das Blatt.
  const optionOn = (query, sectionId, user = admin) => searchSettings(query, { user, translate })
    .options.some((hit) => hit.section.id === sectionId);

  assert.ok(optionOn('Zeitzone', 'personal-appearance'), 'Zeitzone -> Darstellung');
  assert.ok(optionOn('dunkel', 'personal-appearance'), 'ein Theme-Wert findet das Design-Segment');
  assert.ok(optionOn('Einladung', 'admin-family'));
  assert.ok(optionOn('mealie', 'modules-kitchen'), 'Produktnamen stehen als terms im Index');
  assert.ok(optionOn('Zwei-Faktor', 'personal-account'));
  assert.ok(optionOn('Wand', 'personal-appearance'), 'Wand findet den Wand-Modus, nicht nur die Wandtabletts');
  // #1665-Review: ein Mitglied, das "Bildschirmschoner" sucht, landet bei der
  // Wartezeit unter Darstellung - nicht im Immich-Blatt, wo sie nicht steht.
  assert.ok(optionOn('Bildschirmschoner', 'personal-appearance', { role: 'member' }), 'Bildschirmschoner findet die Wartezeit');
  // Diakritika und Gross-/Kleinschreibung zaehlen nicht.
  assert.ok(optionOn('wahrung', 'personal-appearance'), 'waehrung ohne Umlaut findet Waehrung');

  // Die Rechte gelten auch fuer Treffer: ein Mitglied findet keine Option
  // eines adminOnly-Abschnitts, wohl aber seine eigenen.
  const member = { role: 'member' };
  assert.equal(optionOn('Einladung', 'admin-family', member), false);
  assert.ok(optionOn('Wand', 'personal-appearance', member));

  // Blatt-Treffer bleiben, und eine leere Eingabe findet nichts.
  assert.ok(searchSettings('Wetter', { user: admin, translate }).leaves.some((leaf) => leaf.id === 'personal-weather'));
  assert.deepEqual(searchSettings('  ', { user: admin, translate }), { leaves: [], sections: [], options: [] });

  // Der Sprung traegt die Option als Anker, die Shell zeigt sie im Blatt.
  const [hit] = searchSettings('Zeitzone', { user: admin, translate }).options;
  assert.equal(settingsOptionUrl(hit.leaf, hit.key), '/settings/personal/appearance?option=settings.timezoneLabel');
  const shell = await settingsShellSource();
  assert.match(shell, /revealSettingsOption\(leafContainer, query\?\.get\?\.\('option'\)\)/);
});

/**
 * FAST JEDER BLATTAUFRUF KOMMT OHNE `?option=`. Die erste Fassung von
 * revealSettingsOption() rief `t(key)` vor der Pruefung, und das echte t()
 * wirft bei `null` (i18n.js, resolveExtensionTranslation) - gemessen fiel
 * dadurch JEDES Blatt ohne Suchtreffer in den Fehlerzustand "Einstellungen
 * konnten nicht geladen werden". Der Stub des Test-Loaders wirft nicht, ein
 * Aufruf hier waere also gruen gegen den Fehler; deshalb die Reihenfolge im
 * Quelltext: die Schluesselpruefung steht vor dem ersten t().
 */
test('ein Blatt ohne Suchtreffer ruft t() nicht mit einem leeren Schluessel', async () => {
  const shell = await settingsShellSource();
  const body = shell.slice(shell.indexOf('function revealSettingsOption('), shell.indexOf('async function renderLeafContent'));
  const guard = body.search(/if \(typeof key !== 'string' \|\| !key\) return false;/);
  const firstT = body.search(/\bt\(key\)/);
  assert.ok(guard > 0, 'revealSettingsOption() prueft den Schluessel nicht');
  assert.ok(firstT > guard, 't(key) laeuft vor der Schluesselpruefung');
});

test('der Blattwechsel zeigt einen Ladezustand statt eines leeren Kastens', async () => {
  const source = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  // Zwischen dem leeren Blatt und dem fertigen lagen der dynamische Import und
  // der erste Datenabruf (Critique 2026-07-27).
  assert.match(source, /import\s*\{\s*renderSkeletonList\s*\}\s*from\s*'\/utils\/skeleton\.js'/);
  assert.match(source, /setAttribute\('aria-busy',\s*'true'\)/, 'aria-busy muss den Ladezustand ansagen');
  assert.match(source, /renderSkeletonList\(/, 'das Skelett muss aus dem geteilten Helfer kommen');
  // Seit R10 rendert ein Blatt mehrere Abschnitte, und ein Fehler bleibt im
  // Abschnitt (renderSheetSection faengt ihn). aria-busy faellt deshalb genau
  // einmal - NACH allen Abschnitten, egal ob einer scheiterte.
  const body = source.slice(source.indexOf('async function renderLeafContent'), source.indexOf('function isSplit('));
  // Seit 2026-09-28 wartet die Shell hoechstens SECTION_WAIT_MS (A7 P1-2); das
  // Fertig-Stueck `finishLeaf` laeuft trotzdem genau einmal nach ALLEN.
  assert.match(body, /await awaitSections\(\s*hosts\.map\(\(\[host, section\]\) => renderSheetSection\([^)]*\)\),\s*finishLeaf,\s*\)/,
    'die Abschnitte laufen durch awaitSections, das Fertig-Stueck haengt daran');
  assert.match(body, /const finishLeaf = \(\) => \{\s*clearTimeout\(skeletonTimer\);[\s\S]*?leafContainer\.removeAttribute\('aria-busy'\);/,
    'aria-busy muss nach allen Abschnitten entfernt werden, auch wenn einer scheitert');
  assert.match(source, /Promise\.allSettled\(pending\)\.then\(\(\) => onSettled\(\)\)/,
    'auch ein scheiternder Abschnitt zaehlt als fertig');
  const section = source.slice(source.indexOf('async function renderSheetSection'), source.indexOf('async function renderLeafContent'));
  assert.match(section, /catch \(error\)[\s\S]*createRetryState\(/, 'ein scheiternder Abschnitt zeigt seinen eigenen Wiederholen-Zustand');
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

// #1723: die Laenderliste stand in jeder UI-Sprache auf Englisch, weil die
// Seite den Namen des Servers druckte. Die Tests importieren dynamisch, damit
// ein fehlender Export EINEN Fall rot macht und nicht die ganze Datei.
test('#1723: holiday countries are named and sorted in the UI language', async () => {
  const { localizeHolidayCountries } = await import('../public/settings/pages/modules-calendar.js');
  assert.equal(typeof localizeHolidayCountries, 'function', 'localizeHolidayCountries fehlt');
  // So kommt die Liste vom Server: englische Namen, englisch sortiert.
  const vomServer = [
    { isoCode: 'AT', name: 'Austria' },
    { isoCode: 'DE', name: 'Germany' },
    { isoCode: 'ES', name: 'Spain' },
    { isoCode: 'US', name: 'United States', schoolHolidays: false },
  ];
  const kopie = structuredClone(vomServer);

  const de = localizeHolidayCountries(vomServer, 'de');
  assert.deepEqual(de.map((c) => c.name), ['Deutschland', 'Österreich', 'Spanien', 'Vereinigte Staaten'],
    'deutsche Namen, deutsch sortiert (Ö bei O, nicht hinter Z)');
  assert.deepEqual(de.map((c) => c.isoCode), ['DE', 'AT', 'ES', 'US']);
  assert.equal(de.find((c) => c.isoCode === 'US').schoolHolidays, false, 'das Schulferien-Flag reist mit');
  assert.deepEqual(vomServer, kopie, 'die Eingabe bleibt, wie sie war');

  assert.deepEqual(localizeHolidayCountries(vomServer, 'fr').map((c) => c.name),
    ['Allemagne', 'Autriche', 'Espagne', 'États-Unis']);
  assert.deepEqual(localizeHolidayCountries(vomServer, 'en').map((c) => c.isoCode), ['AT', 'DE', 'ES', 'US']);

  // Ohne Angabe gilt die UI-Sprache (getLocale), nicht die Region des Haushalts.
  const before = globalThis.__locale;
  try {
    globalThis.__locale = 'sv';
    assert.equal(localizeHolidayCountries(vomServer).find((c) => c.isoCode === 'DE').name, 'Tyskland');
  } finally {
    globalThis.__locale = before;
  }
});

test('#1723: a country Intl cannot name keeps the name the server sent', async () => {
  const { localizeHolidayCountries } = await import('../public/settings/pages/modules-calendar.js');
  assert.equal(typeof localizeHolidayCountries, 'function', 'localizeHolidayCountries fehlt');
  const liste = [
    { isoCode: 'ZZZZ', name: 'Zzyzx' },           // kein gueltiger Regionscode: Intl wirft
    { isoCode: 'QQ', name: 'Nowhere' },           // gueltige Form, unbekanntes Land
    { isoCode: '', name: 'Blank' },
    { isoCode: 'DE', name: 'Germany' },
  ];
  assert.deepEqual(localizeHolidayCountries(liste, 'de').map((c) => c.name),
    ['Blank', 'Deutschland', 'Nowhere', 'Zzyzx'], 'der Servername bleibt, statt des Codes oder einer Luecke');
  // Eine Sprache, die Intl nicht annimmt, kostet die Uebersetzung, nicht die Liste.
  assert.deepEqual(localizeHolidayCountries(liste, 'not a locale').map((c) => c.name).sort(),
    ['Blank', 'Germany', 'Nowhere', 'Zzyzx']);
  assert.deepEqual(localizeHolidayCountries(null, 'de'), []);
});

// Gefahren wird der echte Abruf der Seite (loadSubdivisions) gegen den
// API-Stub des Loaders: welche Adresse er fragt und in welcher Reihenfolge die
// Optionen im Auswahlfeld landen.
test('#1723: holiday regions are asked for in the UI language and sorted in it', async () => {
  const { loadSubdivisions, sortHolidayEntries } = await import('../public/settings/pages/modules-calendar.js');
  assert.equal(typeof loadSubdivisions, 'function', 'loadSubdivisions ist nicht exportiert');
  assert.equal(typeof sortHolidayEntries, 'function', 'sortHolidayEntries fehlt');

  // Schwedisch stellt Ö ans Ende des Alphabets, Deutsch zu O.
  const regionen = [{ isoCode: 'A', name: 'Örebro' }, { isoCode: 'B', name: 'Uppsala' }, { isoCode: 'C', name: 'Skåne' }];
  assert.deepEqual(sortHolidayEntries(regionen, 'sv').map((r) => r.name), ['Skåne', 'Uppsala', 'Örebro']);
  assert.deepEqual(sortHolidayEntries(regionen, 'de').map((r) => r.name), ['Örebro', 'Skåne', 'Uppsala']);
  assert.deepEqual(sortHolidayEntries(regionen, 'not a locale').length, 3, 'eine unbrauchbare Sprache kostet nicht die Liste');

  const saved = { document: globalThis.document, api: globalThis.__apiStub, locale: globalThis.__locale };
  const fakeSelect = () => ({
    options: [],
    disabled: false,
    replaceChildren(...nodes) { this.options = [...nodes]; },
    appendChild(node) { this.options.push(node); },
  });
  const gefragt = [];
  globalThis.document = { createElement: () => ({}) };
  globalThis.__apiStub = { get: async (url) => { gefragt.push(url); return { data: regionen }; } };
  try {
    for (const [locale, country, erwartet] of [
      ['sv', 'SE', ['Skåne', 'Uppsala', 'Örebro']],
      ['de', 'SE', ['Örebro', 'Skåne', 'Uppsala']],
      ['pt-BR', 'PT', ['Örebro', 'Skåne', 'Uppsala']],
    ]) {
      globalThis.__locale = locale;
      const select = fakeSelect();
      const result = await loadSubdivisions(select, { value: country }, country, 'B', { latestRequestId: 0 });
      assert.equal(gefragt.at(-1), `/preferences/holidays/subdivisions/${country}?lang=${locale}`);
      assert.deepEqual(select.options.slice(1).map((o) => o.textContent), erwartet, `${locale}: Reihenfolge im Auswahlfeld`);
      assert.equal(select.options.find((o) => o.value === 'B').selected, true, 'die gespeicherte Region bleibt gewaehlt');
      assert.deepEqual(result, { selectedResolved: true });
    }
  } finally {
    globalThis.document = saved.document;
    globalThis.__apiStub = saved.api;
    globalThis.__locale = saved.locale;
  }
});

// Die Funktionen oben helfen nur, wenn die Seite sie auch ruft - ein Export
// ohne Aufrufer besteht jeden Test darueber.
test('#1723: the holiday form builds the country dropdown through localizeHolidayCountries', async () => {
  const source = await readFile(new URL('../public/settings/pages/modules-calendar.js', import.meta.url), 'utf8');
  const initial = source.slice(source.indexOf('const countriesResult = await runHolidayDiscovery('));
  assert.match(initial, /const countries = localizeHolidayCountries\(/, 'die Laenderliste laeuft durch localizeHolidayCountries');
  assert.match(initial, /countriesData = countries;\s*appendOptions\(\s*countrySelect,\s*countries,/,
    'und genau diese Liste fuellt das Auswahlfeld und die Schulferien-Pruefung');
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

test('holiday group survives a failed or pending group lookup (PR #1186)', () => {
  const belgium = {
    location: { country: 'BE', subdivision: null },
    persistedCountry: 'BE',
    persistedSubdivision: null,
    persistedGroup: 'BE-FR',
  };
  // Die Suche nach den Gruppen am Land ist gescheitert oder laeuft noch: der Picker
  // ist versteckt und leer, die gespeicherte Gemeinschaft darf trotzdem nicht fallen.
  assert.equal(resolveHolidayGroup({ ...belgium, groupReady: false, pickerShown: false, selectedGroup: '' }), 'BE-FR');
  // Bestaetigt und sichtbar: die Auswahl zaehlt, auch "Alle anzeigen".
  assert.equal(resolveHolidayGroup({ ...belgium, groupReady: true, pickerShown: true, selectedGroup: 'BE-NL' }), 'BE-NL');
  assert.equal(resolveHolidayGroup({ ...belgium, groupReady: true, pickerShown: true, selectedGroup: '' }), null);
  // Bestaetigt ohne Gruppe (Land ohne Gruppen): nichts zu speichern.
  assert.equal(resolveHolidayGroup({ ...belgium, groupReady: true, pickerShown: false, selectedGroup: '' }), null);
});

test('holiday group keeps a persisted group only for the place it was saved for (PR #1186)', () => {
  const saved = { persistedCountry: 'CH', persistedSubdivision: 'CH-BE', persistedGroup: 'CH-BE-VS' };
  assert.equal(resolveHolidayGroup({
    ...saved, groupReady: false, pickerShown: false, selectedGroup: '',
    location: { country: 'CH', subdivision: 'CH-BE' },
  }), 'CH-BE-VS');
  // Anderes Land gewaehlt, dessen Gruppensuche scheitert: die alte Schweizer Gruppe
  // gehoert nicht zu Belgien.
  assert.equal(resolveHolidayGroup({
    ...saved, groupReady: false, pickerShown: false, selectedGroup: '',
    location: { country: 'BE', subdivision: null },
  }), null);
  // Unter einer gewaehlten Subdivision zaehlt die Auswahl auch bei verstecktem Picker.
  assert.equal(resolveHolidayGroup({
    ...saved, groupReady: true, pickerShown: false, selectedGroup: 'CH-BE-EO',
    location: { country: 'CH', subdivision: 'CH-BE' },
  }), 'CH-BE-EO');
});

test('holiday settings pass the group lookup state to resolveHolidayGroup and report a failed lookup (PR #1186)', async () => {
  const source = await readFile(new URL('../public/settings/pages/modules-calendar.js', import.meta.url), 'utf8');
  const data = source.slice(source.indexOf('function holidayPreferenceData('), source.indexOf('function bindWeekStart('));
  assert.match(data, /holiday_group: resolveHolidayGroup\(\{\s*groupReady: discoveryState\.groupReady,/,
    'der Speicherweg muss den Bereit-Merker durchreichen, sonst hilft der Helfer nichts');
  const loader = source.slice(source.indexOf('async function loadGroups('), source.indexOf('function holidayPreferenceData('));
  assert.match(loader, /catch \{[^}]*return requestId === requestState\.latestRequestId \? false : null;/,
    'eine gescheiterte Gruppensuche meldet false, nicht "keine Gruppe"');
});

test('a country change starts a group lookup only for a current, successful subdivision answer (PR #1186)', () => {
  const ok = { ok: true, value: { selectedResolved: true } };
  assert.deepEqual(groupLookupAfterSubdivisions({ discovery: ok, requestedCountry: 'BE', currentCountry: 'BE', subdivisionCount: 0 }), { countryLevel: true });
  assert.deepEqual(groupLookupAfterSubdivisions({ discovery: ok, requestedCountry: 'CH', currentCountry: 'CH', subdivisionCount: 26 }), { countryLevel: false });
  // DE -> BE schnell hintereinander: die aeltere Antwort darf die Suche fuer Belgien nicht ueberholen.
  assert.equal(groupLookupAfterSubdivisions({ discovery: ok, requestedCountry: 'DE', currentCountry: 'BE', subdivisionCount: 16 }), null);
  assert.equal(groupLookupAfterSubdivisions({ discovery: { ok: true, value: null }, requestedCountry: 'DE', currentCountry: 'DE', subdivisionCount: 16 }), null);
  // Lokal berechnetes Land ohne Schulferien-Quelle (US): keine Anfrage am Land, "keine Gruppe" ist die Auskunft.
  assert.deepEqual(groupLookupAfterSubdivisions({ discovery: ok, requestedCountry: 'US', currentCountry: 'US', subdivisionCount: 0, schoolHolidaysAvailable: false }), { countryLevel: false });
  // Regionssuche gescheitert: nichts bestaetigen, die gespeicherte Gruppe bleibt.
  assert.equal(groupLookupAfterSubdivisions({ discovery: { ok: false, value: null }, requestedCountry: 'CH', currentCountry: 'CH', subdivisionCount: 0 }), null);
});

test('a country change invalidates the old group picker before it awaits the subdivisions (PR #1186)', async () => {
  const source = await readFile(new URL('../public/settings/pages/modules-calendar.js', import.meta.url), 'utf8');
  const start = source.indexOf("countrySelect.addEventListener('change'");
  const handler = source.slice(start, source.indexOf("subdivisionSelect.addEventListener('change'", start));
  const cleared = handler.indexOf('clearGroupPicker(groupSelect, groupGroup, groupRequests);');
  const notReady = handler.indexOf('discoveryState.groupReady = false;');
  const awaited = handler.indexOf('await runHolidayDiscovery(');
  assert.ok(cleared > 0 && notReady > 0 && awaited > 0, 'Handler-Bausteine gefunden');
  assert.ok(cleared < awaited && notReady < awaited, 'der alte Picker muss vor dem Warten auf die Regionen fallen');
  assert.match(handler, /const lookup = groupLookupAfterSubdivisions\(\{/);
  assert.match(handler, /if \(lookup\) \{\s*applyGroupResult\(await loadGroups\(/);
  assert.match(handler, /schoolHolidaysAvailable: countrySchoolHolidaysAvailable\(countriesData, countryCode\),/,
    'der Landwechsel fragt ein Land ohne Schulferien-Quelle nicht nach Gruppen');
  const initial = source.slice(source.indexOf('const countriesResult = await runHolidayDiscovery('));
  assert.match(initial, /subdivisionSelect\.options\.length <= 1\s*&& countrySchoolHolidaysAvailable\(countriesData, preferences\.holiday_country\)\) \{/,
    'auch der erste Aufbau fragt ein Land ohne Schulferien-Quelle nicht am Land');
  assert.match(initial, /const stillSavedCountry = countrySelect\.value === preferences\.holiday_country;\s*if \(stillSavedCountry && preferences\.holiday_subdivision\) \{/,
    'der erste Aufbau startet keine Gruppensuche fuer das gespeicherte Land, wenn schon ein anderes gewaehlt ist');
  assert.match(initial, /\} else if \(stillSavedCountry && subdivisionsResult\.ok && subdivisionsResult\.value && subdivisionSelect\.options\.length <= 1/);
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

// Die Admin-Seite las nur die Datenbank: Wetter aus der `.env` (Web-Installer)
// lief auf dem Dashboard, die Seite sagte "Nicht konfiguriert" und bot nichts
// an. Die Quelle meldet jetzt der Server (`weather_source`), die Seite zeigt sie.
test('admin weather page shows weather configured by the server', async () => {
  const { weatherSourceOf, weatherSourceHtml, canRemoveStoredWeather } = await import('/settings/pages/admin-weather.js');

  const env = weatherSourceOf({
    weather_provider: null,
    weather_source: { source: 'env', provider: 'open-meteo', lat: '52.52', lon: '13.4', city: 'Berlin', units: 'metric' },
  });
  const envHtml = weatherSourceHtml(env);
  assert.match(envHtml, /settings\.weatherProviderOpenMeteoEnv/);
  assert.doesNotMatch(envHtml, /settings\.weatherProviderNone/);
  assert.match(envHtml, /Berlin \(52\.52, 13\.4\)/, 'Stadt und Koordinaten stehen schreibgeschuetzt da');
  assert.match(envHtml, /settings\.weatherEnvHint\{"vars":"WEATHER_\*"\}/, 'der Weg zum Abschalten steht dabei');
  assert.equal(canRemoveStoredWeather(env), false, 'die .env laesst sich hier nicht entfernen');

  const owm = weatherSourceOf({
    weather_source: { source: 'env', provider: 'openweathermap', lat: null, lon: null, city: 'Hamburg', units: 'metric' },
  });
  const owmHtml = weatherSourceHtml(owm);
  assert.match(owmHtml, /settings\.weatherProviderOwm/);
  assert.match(owmHtml, /settings\.weatherEnvHint\{"vars":"OPENWEATHER_\*"\}/);

  // Koordinaten ohne Anbieter nimmt der Proxy auch - die Seite darf sie nicht
  // "Nicht konfiguriert" nennen und muss sie entfernen lassen.
  const stored = weatherSourceOf({
    weather_provider: null,
    weather_source: { source: 'db', provider: 'open-meteo', lat: '48.14', lon: '11.58', city: '', units: 'metric' },
  });
  assert.match(weatherSourceHtml(stored), /settings\.weatherProviderOpenMeteo\b(?!Env)/);
  assert.doesNotMatch(weatherSourceHtml(stored), /weatherEnvHint/);
  assert.equal(canRemoveStoredWeather(stored), true);

  const none = weatherSourceOf({ weather_source: { source: 'none', provider: null } });
  assert.match(weatherSourceHtml(none), /settings\.weatherProviderNone/);
  assert.equal(canRemoveStoredWeather(none), false);

  // Die Seite entscheidet den Vorrang nicht selbst: sie liest `weather_source`
  // und nicht `weather_provider`, und das Entfernen loescht die Koordinaten
  // mit - sonst kaeme die `.env` danach nie wieder zum Zug.
  const source = await readFile(new URL('../public/settings/pages/admin-weather.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /preferences\.weather_provider\s*===/);
  assert.match(source, /savePreferences\(\{ weather_provider: null, weather_lat: null, weather_lon: null, weather_city: '' \}\)/);
  assert.match(source, /next\.source === 'env' \? t\('settings\.weatherRemovedEnv'\)/);
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

/*
 * KOPFREGEL MOBIL (2026-09-26, Critique A7 P1 + A8). Die Einstellungen hatten
 * mobil drei Ebenen (vier Bereichszeilen, eine Bereichsseite mit 88px-Zeilen,
 * das Blatt), keinen geteilten Kopf, keine Suche und einen Rueckweg, der als
 * Textlink im Inhalt mit wegscrollte. Die drei Tests halten die drei Zusagen.
 */
const settingsShellSource = () => readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
const settingsCssRules = async () => [...eachRule(await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8'))];
const ruleBody = (rules, selector, atPattern = null) => rules
  .filter((r) => r.selector.split(',').map((s) => s.trim()).includes(selector))
  .filter((r) => (atPattern ? r.at.some((a) => atPattern.test(a)) : r.at.length === 0))
  .map((r) => r.body)
  .join(';');

test('die Wurzel ist in jeder Breite EINE gruppierte Liste, die Bereichsebene gibt es nicht mehr', async () => {
  const shell = await settingsShellSource();
  // Keine zweite, mobile Uebersicht und keine Bereichsseite mehr.
  assert.doesNotMatch(shell, /function renderDomainOverview\b|settings-mobile-overview/,
    'mobil darf es keine eigene Bereichsebene geben - die Wurzel ist die Liste aller Blaetter');
  assert.match(shell, /function renderOverview\(content, domains, user\)/);
  // Jeder Bereich ist ein Abschnitt mit Sprungziel; der Deep-Link landet dort.
  assert.match(shell, /section\.id = overviewSectionId\(domain\.id\)/);
  assert.match(shell, /revealOverviewSection\(content, focusDomain\?\.id\)/,
    '?view=domain&domain=x muss auf den Abschnitt springen, statt eine Zwischenseite zu rendern');
  // Der Sprung wartet auf den Router, der den Port nach update() zuruecksetzt.
  assert.match(shell, /function revealOverviewSection[\s\S]*?setTimeout\(/);

  // Mobil: Zeile 44/48px, 32px-Marke, keine Beschreibung.
  const rules = await settingsCssRules();
  const mobile = /max-width:\s*767px/;
  assert.match(ruleBody(rules, '.settings-overview__row', mobile), /min-height:\s*var\(--target-base\)/);
  assert.match(ruleBody(rules, '.settings-overview__row-mark', mobile), /width:\s*var\(--target-sm\)/);
  assert.match(ruleBody(rules, '.settings-overview__row-description', mobile), /display:\s*none/);
  // Der Abschnitt landet unter dem klebenden Kopf, nicht dahinter.
  assert.match(ruleBody(rules, '.settings-overview__section'), /scroll-margin-block-start:/);
});

test('der Rueckweg im Blatt steht im klebenden Kopf, nicht im Inhalt', async () => {
  const shell = await settingsShellSource();
  assert.doesNotMatch(shell, /settings-leaf-back-link/,
    'der Textlink im Inhalt scrollte auf langen Blaettern mit weg (A7, Casey)');
  // Der Kopf ist der geteilte Modulkopf - klebend, verdrahtet vom Router.
  assert.match(shell, /toolbar\.className = 'page-toolbar settings-shell-header'/);
  assert.match(shell, /createLink\(settingsOverviewUrl\(domain\.id\), 'settings-toolbar__back'\)/);
  assert.match(shell, /back\.setAttribute\('aria-label', t\('settings\.backToSettings'\)\)/);
  // Der Kopf zeigt den Rueckweg, BEVOR das Blatt geladen ist.
  assert.match(shell, /renderToolbar\(toolbar, content, \{ activeLeaf, domain: leafDomain \}\);\s*await renderLeafContent/);

  // Ausgeblendet wird der Kopf auf Blaettern nur dort, wo der Breadcrumb
  // zurueckfuehrt (ab 768px) - nie bedingungslos, sonst fehlt mobil jeder Weg.
  const rules = await settingsCssRules();
  assert.equal(ruleBody(rules, '.settings-page--leaf .settings-shell-header'), '',
    'ein bedingungsloses display:none nimmt mobil den einzigen Rueckweg');
  assert.match(ruleBody(rules, '.settings-page--leaf .settings-shell-header', /min-width:\s*768px/), /display:\s*none/);
});

test('die Wurzel sucht ueber das Such-Icon im geteilten Kopf, in jeder Breite', async () => {
  const shell = await settingsShellSource();
  assert.match(shell, /import \{ renderPageSearch, wirePageSearch \} from '\/utils\/page-search\.js'/);
  // Als Slot des Kopfes, damit die Shell sie mobil zum Icon macht (Regel 4).
  assert.match(shell, /className: 'settings-toolbar__search page-toolbar__center'/);
  // Die Suche filtert die Liste der Wurzel, nicht nur die Desktop-Seitenleiste.
  assert.match(shell, /onQuery: \(value\) => filterOverview\(content, value\)/);
  // Dieselbe Suche wie in der Seitenleiste (searchSettings); ein Abschnitt ohne
  // Treffer faellt weg, und fruehere Blaetter und Optionen bekommen einen
  // eigenen Abschnitt.
  assert.match(shell, /function filterOverview[\s\S]*?searchSettings\(query[\s\S]*?section\.hidden = visible === 0[\s\S]*?hits\.sections\.map[\s\S]*?hits\.options\.map[\s\S]*?extra\.map\(createOptionRow\)/);
});

/**
 * KEIN GRUENES „AKTIVIERT" NEBEN EINEM SCHALTER (Critique 2026-09-26, A7 P2).
 * Auf `Aktive Module` standen vierzehn gruene Badges neben vierzehn gehakten
 * Kaestchen - dieselbe Aussage zweimal, und die eine abweichende Zeile ging
 * darin unter. Das Statuswort steht nur noch fuer die Abweichung (aus,
 * Fehler, nicht im Menue). Geprueft an beiden Blaettern, die das Wort bauen,
 * und am Stylesheet: eine Regel fuer den Normalzustand waere die Einladung,
 * ihn wieder zu beschriften.
 */
test('Modulzeilen beschriften nur die Abweichung, nicht den Normalzustand', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  for (const path of ['../public/settings/pages/modules-active.js', '../public/settings/pages/modules-navigation.js']) {
    assert.doesNotMatch(await read(path), /settings-module-status--enabled/, `${path} baut wieder ein Aktiviert-Badge`);
  }
  const rules = await settingsCssRules();
  assert.deepEqual(rules.filter((rule) => rule.selector.includes('settings-module-status--enabled')).map((rule) => rule.selector), []);
  // Die Abweichung behaelt ihr Wort.
  assert.match(await read('../public/settings/pages/modules-active.js'), /settings-module-status--disabled[\s\S]*thirdPartyModulesStatusDisabled/);
});

/**
 * EIN WERT AUS DREI IST DAS SEGMENT DER SHELL (Komponenten-Kanon 2026-09-26,
 * DESIGN.md "Segmented Controls"). Theme und Wochenstart waren drei getrennte
 * Rahmenknoepfe (`.theme-toggle`) ohne Well, mit aria-pressed statt einer
 * Auswahl - die Pille war kein Zustand in einer Leiste. Beide nehmen jetzt
 * `.segmented` (panel.css) als radiogroup mit der geteilten Verhaltensschicht
 * (Pfeiltasten, Roving-Tabindex, aria-checked), und die eigene Optik ist weg.
 */
test('Theme und Wochenstart sind das Segment der Shell, kein eigener Umschalter', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  for (const [path, id] of [
    ['../public/settings/pages/personal-appearance.js', 'theme-toggle'],
    ['../public/settings/pages/modules-calendar.js', 'week-start-toggle'],
  ]) {
    const source = await read(path);
    assert.match(source, new RegExp(`class="segmented settings-segmented" id="${id}" role="radiogroup"`), `${path}: #${id} ist kein .segmented`);
    assert.match(source, /wireTablist\([\s\S]{0,120}?\{\s*activeId:[\s\S]{0,80}?activeClass: 'is-active',\s*mode: 'select'/, `${path}: ohne geteilte Verhaltensschicht`);
    assert.doesNotMatch(source, /theme-toggle__btn/, `${path}: die alte Knopfreihe ist zurueck`);
  }
  const rules = await settingsCssRules();
  assert.deepEqual(rules.filter((rule) => /\.theme-toggle/.test(rule.selector)).map((rule) => rule.selector), []);
});

// ── Re-Critique 2026-09-27 (R8, H12): ein Speichermodell auf der Belohnungs-Seite ──

/** Das Blatt mit Fake-Flaechen: jedes per Id gefragte Element merkt sich seine Listener. */
function rewardsSheet() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const listeners = {};
      const attrs = new Map();
      els.set(id, {
        id, value: '', checked: false, disabled: false, readOnly: false, hidden: true, textContent: '', isConnected: true,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        setAttribute(name, value) { attrs.set(name, String(value)); },
        removeAttribute(name) { attrs.delete(name); },
        getAttribute(name) { return attrs.get(name) ?? null; },
        querySelector: () => null,
        async fire(type, extra = {}) {
          for (const fn of listeners[type] ?? []) await fn({ type, preventDefault() {}, ...extra });
        },
      });
    }
    return els.get(id);
  };
  let html = '';
  return {
    el,
    get html() { return html; },
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_pos, markup) { html += markup; },
    querySelector: (sel) => (sel.startsWith('#') ? el(sel.slice(1)) : null),
  };
}

test('Belohnungen: das Punktefeld speichert wie die Schalter - ohne eigenen Knopf, beim Verlassen (H12)', async () => {
  const { render } = await import('/settings/pages/modules-rewards.js');
  const { resetPreferencesCache } = await import('/settings/preferences-cache.js');
  const puts = [];
  const toasts = [];
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { showToast: (...args) => toasts.push(args) } };
  globalThis.__apiStub = {
    get: async (url) => (url === '/preferences' ? { data: { tasks_default_points: 0, disabled_modules: [] } } : { data: { count: 0 } }),
    put: async (url, body) => { puts.push([url, body]); return { data: body }; },
  };
  resetPreferencesCache();
  try {
    const sheet = rewardsSheet();
    await render(sheet, { user: { role: 'admin' } });
    const form = sheet.html.match(/<form\b[^>]*id="rewards-default-points-form"[\s\S]*?<\/form>/)?.[0] ?? '';
    assert.match(form, /id="rewards-default-points"/, 'Reichweite: das Punktefeld steht im Formular');
    assert.doesNotMatch(form, /type="submit"/, 'kein Speichern-Knopf nur fuer dieses Feld');

    const input = sheet.el('rewards-default-points');
    const error = sheet.el('rewards-default-points-error');
    input.value = '-3';
    await input.fire('blur');
    assert.deepEqual(puts, [], 'ein ungueltiger Wert wird nicht geschrieben');
    assert.equal(error.hidden, false, 'sondern benannt');
    assert.equal(input.getAttribute('aria-invalid'), 'true');

    input.value = '5';
    await input.fire('blur');
    assert.deepEqual(puts, [['/preferences', { tasks_default_points: 5 }]], 'beim Verlassen gespeichert');
    assert.equal(error.hidden, true, 'und der Fehler ist weg');
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.ok(toasts.some(([key]) => key === 'settings.rewardsDefaultPointsSaved'), `mit Rueckmeldung: ${JSON.stringify(toasts)}`);

    await input.fire('blur');
    assert.equal(puts.length, 1, 'derselbe Wert ein zweites Mal ist kein neuer Schreibzugriff');

    input.value = '7';
    await sheet.el('rewards-default-points-form').fire('submit');
    assert.deepEqual(puts.at(-1), ['/preferences', { tasks_default_points: 7 }], 'Enter speichert ebenso');

    input.value = '9';
    await input.fire('keydown', { key: 'Escape' });
    assert.equal(input.value, '7', 'Escape nimmt die ungespeicherte Eingabe zurueck');
  } finally {
    delete globalThis.__apiStub;
    globalThis.window = prevWindow;
    resetPreferencesCache();
  }
});

// R17 Schritt 5: dieselbe Regel auf dem Blatt "Uebersicht". Das eine Zahlfeld
// (Nachfrist fuer Countdowns) hatte einen eigenen Speichern-Knopf - ein
// einzelnes Kurzfeld speichert beim Verlassen und mit Enter, mit derselben
// Quittung wie das Punktefeld der Belohnungen.
test('Uebersicht: die Nachfrist speichert beim Verlassen und mit Enter - ohne eigenen Knopf', async () => {
  const { render } = await import('/settings/pages/modules-countdowns.js');
  const { resetPreferencesCache } = await import('/settings/preferences-cache.js');
  const puts = [];
  const toasts = [];
  const prevWindow = globalThis.window;
  globalThis.window = { yuvomi: { showToast: (...args) => toasts.push(args) } };
  globalThis.__apiStub = {
    get: async () => ({ data: { countdown_grace_days: 7, disabled_modules: [] } }),
    put: async (url, body) => { puts.push([url, body]); return { data: body }; },
  };
  resetPreferencesCache();
  try {
    const sheet = rewardsSheet();
    await render(sheet, { user: { role: 'admin' } });
    const form = sheet.html.match(/<form\b[^>]*id="countdown-grace-days-form"[\s\S]*?<\/form>/)?.[0] ?? '';
    assert.match(form, /id="countdown-grace-days"/, 'Reichweite: das Feld steht im Formular');
    assert.doesNotMatch(form, /type="submit"|settings-form-actions/, 'kein Speichern-Knopf nur fuer dieses Feld');

    const input = sheet.el('countdown-grace-days');
    const error = sheet.el('countdown-grace-days-error');
    input.value = '';
    await input.fire('blur');
    assert.deepEqual(puts, [], 'ein geleertes Feld wird nicht als 0 geschrieben (#1027)');
    assert.equal(error.hidden, false, 'sondern benannt');
    assert.equal(input.getAttribute('aria-invalid'), 'true');

    input.value = '14';
    await input.fire('blur');
    assert.deepEqual(puts, [['/preferences', { countdown_grace_days: 14 }]], 'beim Verlassen gespeichert');
    assert.equal(error.hidden, true);
    assert.equal(input.getAttribute('aria-invalid'), null);
    assert.equal(input.readOnly, false, 'das Feld ist nach dem Speichern wieder frei');
    assert.ok(toasts.some(([key]) => key === 'settings.countdownGraceDaysSaved'), `mit Rueckmeldung: ${JSON.stringify(toasts)}`);

    await input.fire('blur');
    assert.equal(puts.length, 1, 'derselbe Wert ein zweites Mal ist kein neuer Schreibzugriff');

    input.value = '3';
    await sheet.el('countdown-grace-days-form').fire('submit');
    assert.deepEqual(puts.at(-1), ['/preferences', { countdown_grace_days: 3 }], 'Enter speichert ebenso');

    input.value = '30';
    await input.fire('keydown', { key: 'Escape' });
    assert.equal(input.value, '3', 'Escape nimmt die ungespeicherte Eingabe zurueck');
  } finally {
    delete globalThis.__apiStub;
    globalThis.window = prevWindow;
    resetPreferencesCache();
  }
});

// ── #1516: Die Standard-Erinnerungsliste ohne freigegebene Liste und bei gescheiterter Abfrage ──

/**
 * Der Abschnitt `personal-tasks` mit Fake-Flaechen: das Markup kommt als Text
 * an, was `createRetryState` als Knoten in die Karte haengt, landet in
 * `appended`, und jedes per Id gefragte Element merkt sich seine Listener.
 */
function tasksDefaultsSheet() {
  let html = '';
  const appended = [];
  const els = new Map();
  const card = { appendChild(node) { appended.push(node); return node; } };
  const el = (id) => {
    if (!els.has(id)) {
      const listeners = {};
      els.set(id, {
        id,
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        async fire(type) {
          const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
          for (const fn of listeners[type] ?? []) await fn(event);
          return event;
        },
      });
    }
    return els.get(id);
  };
  return {
    appended,
    get html() { return html; },
    replaceChildren() { html = ''; appended.length = 0; els.clear(); },
    insertAdjacentHTML(_pos, markup) { html += markup; },
    querySelector(sel) {
      if (sel === '.settings-card') return html.includes('class="settings-card"') ? card : null;
      const id = sel.match(/^#([\w-]+)$/)?.[1];
      return id && html.includes(`id="${id}"`) ? el(id) : null;
    },
  };
}

/** Gerade genug `document` fuer createRetryState (settings/components.js). */
function fakeDocument() {
  const createElement = (tag) => {
    const listeners = {};
    const attrs = new Map();
    return {
      tagName: tag.toUpperCase(), className: '', textContent: '', type: '', disabled: false, children: [],
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      async click() { for (const fn of listeners.click ?? []) await fn({ type: 'click' }); },
      focus() {},
    };
  };
  return { createElement };
}

const walkNodes = (nodes) => nodes.flatMap((node) => [node, ...walkNodes(node.children ?? [])]);

async function withTasksDefaults({ preferences = {}, syncTargets }, run) {
  const { render } = await import('/settings/pages/personal-tasks.js');
  const { resetPreferencesCache } = await import('/settings/preferences-cache.js');
  const prev = { window: globalThis.window, document: globalThis.document, error: console.error };
  const navigations = [];
  globalThis.window = { yuvomi: { showToast() {}, navigate: (href) => navigations.push(href) } };
  globalThis.document = fakeDocument();
  console.error = () => {};
  const state = { syncTargets };
  globalThis.__apiStub = {
    get: async (url) => {
      if (url === '/preferences') return { data: preferences };
      if (url === '/tasks/sync-targets') {
        if (state.syncTargets instanceof Error) throw state.syncTargets;
        return { data: { caldav: state.syncTargets } };
      }
      return { data: null };
    },
  };
  resetPreferencesCache();
  try {
    await run({ render, state, navigations });
  } finally {
    delete globalThis.__apiStub;
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    console.error = prev.error;
    resetPreferencesCache();
  }
}

const LIST = { accountId: 1, accountName: 'Nextcloud', listUrl: 'https://dav.example/tasks/', listName: 'Familie' };

test('Standard-Erinnerungsliste: ohne freigegebene Liste sagt der Abschnitt, warum - und der Admin bekommt den Weg zur Freigabe (#1516)', async () => {
  const admin = { role: 'admin' };
  const member = { role: 'member' };
  const sheet = findSettingsLeaf('/settings/modules/tasks', admin);
  const releaseHref = settingsSectionUrl(sheet, 'sync-reminders');
  assert.ok(settingsSheetSections(sheet, admin).some((section) => section.id === 'sync-reminders'),
    'die Freigabestelle ist ein sichtbarer Abschnitt im Aufgabenblatt des Admins');
  assert.ok(!settingsSheetSections(sheet, member).some((section) => section.id === 'sync-reminders'),
    'fuer Mitglieder gibt es sie nicht - ein Link dorthin liefe ins Leere');

  await withTasksDefaults({ syncTargets: [] }, async ({ render, navigations }) => {
    const asAdmin = tasksDefaultsSheet();
    await render(asAdmin, { user: admin });
    assert.doesNotMatch(asAdmin.html, /id="tasks-default-target"/, 'kein Dropdown mit der einzigen Option "nur lokal"');
    assert.match(asAdmin.html, /settings\.tasksDefaultTargetEmpty\b/, 'der Leerzustand steht da');
    assert.ok(asAdmin.html.includes(`href="${releaseHref}"`), `der Admin bekommt den Weg zur Freigabe: ${asAdmin.html}`);
    const event = await asAdmin.querySelector('#tasks-sync-reminders-link').fire('click');
    assert.equal(event.defaultPrevented, true, 'der Link bleibt in der App');
    assert.deepEqual(navigations, [releaseHref]);

    const asMember = tasksDefaultsSheet();
    await render(asMember, { user: member });
    assert.match(asMember.html, /settings\.tasksDefaultTargetEmpty\b/);
    assert.ok(!asMember.html.includes('section=sync-reminders'), 'kein Link auf einen Abschnitt, den das Mitglied nicht sieht');
  });

  // Der Leerzustand erklaert sich selbst: was eine Erinnerungsliste ist
  // (CalDAV) und wer sie freigibt (ein Admin). Gemessen am Wortlaut der
  // Referenz und der englischen Fassung - der Rest folgt ihnen per Uebersetzung.
  for (const code of ['de', 'en']) {
    const locale = JSON.parse(await readFile(new URL(`../public/locales/${code}.json`, import.meta.url), 'utf8'));
    const rendered = `${locale.settings.tasksDefaultsDescription} ${locale.settings.tasksDefaultTargetEmpty}`;
    assert.match(rendered, /CalDAV/, `${code}: sagt nicht, was eine Erinnerungsliste ist: ${rendered}`);
    assert.match(rendered, /\badmin/i, `${code}: sagt nicht, wer sie freigibt: ${rendered}`);
  }
});

test('Standard-Erinnerungsliste: eine gescheiterte Abfrage ist ein Fehler mit Ausweg, kein Leerzustand (#1516)', async () => {
  const failure = Object.assign(new Error('Internal server error.'), { status: 500 });
  // Mit gespeichertem Ziel: gerade dann waere "nichts freigegeben" eine falsche Behauptung.
  await withTasksDefaults({
    preferences: { tasks_default_target: 'caldav:1|https://dav.example/tasks/' },
    syncTargets: failure,
  }, async ({ render, state }) => {
    const host = tasksDefaultsSheet();
    await render(host, { user: { role: 'member' } });
    assert.doesNotMatch(host.html, /settings\.tasksDefaultTargetEmpty\b/, 'der Leerzustand behauptet, es sei nichts freigegeben');
    assert.doesNotMatch(host.html, /id="tasks-default-target"/, 'ohne Liste ist unbekannt, was zur Wahl stuende');
    const nodes = walkNodes(host.appended);
    const alert = nodes.find((node) => node.getAttribute?.('role') === 'alert');
    assert.ok(alert, `kein Fehler zu sehen: ${host.html}`);
    assert.equal(alert.textContent, 'settings.tasksDefaultTargetLoadError');
    const retry = nodes.find((node) => node.tagName === 'BUTTON');
    assert.ok(retry, 'und kein Ausweg');

    state.syncTargets = [LIST];
    await retry.click();
    assert.match(host.html, /id="tasks-default-target"/, 'Erneut versuchen laedt die Listen und zeigt das Feld');
    assert.equal(walkNodes(host.appended).some((node) => node.getAttribute?.('role') === 'alert'), false, 'der Fehler ist weg');
  });
});

/* ==========================================================================
 * R10 (Re-Critique 2026-09-27): JE MODUL EIN BLATT, ALTE ADRESSEN LEBEN WEITER,
 * LISTE + DETAIL AM DESKTOP.
 *
 * Der Stand VOR dem Umbau steht hier als Ledger, nicht als Import: die alte
 * Registry gibt es nicht mehr, und ihre Pfade und Optionen sind genau das, was
 * Lesezeichen, gespeicherte Ziele, App-Links und die Suche von gestern kennen.
 * Das Ledger schrumpft nie - eine Adresse, die einmal galt, gilt weiter.
 * ======================================================================== */

const PRE_R10_LEAVES = Object.freeze({
  '/settings/personal/account': { id: 'personal-account', adminOnly: false, labelKey: 'settings.pageAccount', options: ['settings.displayNameLabel', 'settings.colorLabel', 'settings.contactDetailsLegend', 'settings.changePassword', 'settings.twoFactorTitle', 'settings.otherSessionsTitle', 'settings.oidcLinkTitle'] },
  '/settings/personal/appearance': { id: 'personal-appearance', adminOnly: false, labelKey: 'settings.pageAppearance', options: ['settings.sectionDesign', 'settings.wallModeLabel', 'settings.screensaverIdleLabel', 'settings.localeLabel', 'settings.dataLanguageLabel', 'settings.regionLabel', 'settings.currencyLabel', 'settings.timezoneLabel', 'settings.dateFormatLabel', 'settings.timeFormatLabel'] },
  '/settings/personal/device': { id: 'personal-device', adminOnly: false, labelKey: 'settings.pageDevice', options: ['settings.pwaInstallTitle'] },
  '/settings/personal/notifications': { id: 'personal-notifications', adminOnly: false, labelKey: 'settings.pageNotifications', options: ['settings.pushToggleTitle', 'settings.notificationChannelsTitle'] },
  '/settings/personal/calendar': { id: 'personal-calendar', adminOnly: false, labelKey: 'settings.pageCalendarDefaults', options: ['settings.calendarAssignMeLabel', 'settings.calendarDefaultTargetLabel', 'settings.calendarDefaultRemindersLabel'] },
  '/settings/personal/tasks': { id: 'personal-tasks', adminOnly: false, labelKey: 'settings.pageTaskDefaults', options: ['settings.tasksDefaultTargetLabel'] },
  '/settings/personal/health': { id: 'personal-health', adminOnly: false, labelKey: 'settings.pageHealthPersonal', options: ['settings.healthCyclePersonalLabel', 'settings.healthPreventionNotifyCaregiversLabel', 'settings.healthVisibilityTitle'] },
  '/settings/personal/weather': { id: 'personal-weather', adminOnly: false, labelKey: 'settings.pageWeather', options: ['settings.personalWeatherTitle', 'settings.weatherAutoLocateLabel'] },
  '/settings/personal/navigation': { id: 'modules-navigation', adminOnly: false, labelKey: 'settings.pageNavigation', options: ['settings.desktopNavigationTitle', 'settings.mobileNavigationTitle'] },
  '/settings/personal/feeds': { id: 'personal-feeds', adminOnly: false, labelKey: 'settings.pageFeeds', options: ['settings.feedExportTitle', 'settings.feedExportShowAssignees', 'settings.inventoryFeedTitle', 'settings.cycleFeedTitle', 'settings.scheduleFeedTitle', 'settings.wasteFeedTitle'] },
  '/settings/personal/calendar-subscriptions': { id: 'personal-calendar-subscriptions', adminOnly: false, labelKey: 'settings.pageCalendarSubscriptions', options: ['settings.ics.title', 'settings.calendarImport.title'] },
  '/settings/modules/active': { id: 'modules-active', adminOnly: true, labelKey: 'settings.pageActiveModules', options: ['settings.activeModulesTitle'] },
  '/settings/modules/kitchen': { id: 'modules-kitchen', adminOnly: true, labelKey: 'settings.pageKitchen', options: ['settings.mealTypesLabel', 'settings.mealTypeNamesLabel', 'settings.recipeProvidersTitle'] },
  '/settings/modules/calendar': { id: 'modules-calendar', adminOnly: true, labelKey: 'settings.pageCalendarModule', options: ['settings.calendarDurationTitle', 'settings.weekStartTitle', 'settings.holidayPublicLabel', 'settings.holidaySchoolLabel'] },
  '/settings/modules/options': { id: 'modules-options', adminOnly: true, labelKey: 'settings.pageModuleOptions', options: ['settings.budgetModePersonalLabel', 'settings.healthCycleEnableLabel', 'settings.housekeepingPaymentTasksLabel', 'settings.tasksSubtasksExpandedLabel', 'settings.scheduleTemplatesTitle'] },
  '/settings/modules/rewards': { id: 'modules-rewards', adminOnly: true, labelKey: 'settings.pageRewardsModule', options: ['settings.rewardsEnableLabel', 'settings.rewardsApprovalLabel', 'settings.rewardsDefaultPointsLabel'] },
  '/settings/modules/health': { id: 'modules-health', adminOnly: true, labelKey: 'settings.pageHealthModule', options: ['settings.healthPreventionTypesTitle'] },
  '/settings/modules/countdowns': { id: 'modules-countdowns', adminOnly: true, labelKey: 'settings.pageCountdownsModule', options: ['settings.countdownGraceDaysTitle'] },
  '/settings/sync/calendar': { id: 'sync-calendar', adminOnly: true, labelKey: 'settings.pageSyncCalendar', options: ['settings.caldavTitle', 'settings.moreProviders', 'settings.sync.backfillTitle'] },
  '/settings/sync/contacts': { id: 'sync-contacts', adminOnly: true, labelKey: 'settings.pageSyncContacts', options: ['settings.cardavTitle'] },
  '/settings/sync/reminders': { id: 'sync-reminders', adminOnly: true, labelKey: 'settings.pageSyncReminders', options: ['settings.caldavSyncReminders'] },
  '/settings/sync/storage': { id: 'documents-storage', adminOnly: true, labelKey: 'settings.pageDocumentStorage', options: ['settings.documentStorageWebdavTitle', 'settings.documentStorageGoogleDriveTitle'] },
  '/settings/sync/dms': { id: 'documents-dms', adminOnly: true, labelKey: 'settings.pageDocumentDms', options: ['settings.dmsTitle'] },
  '/settings/admin/family': { id: 'admin-family', adminOnly: true, labelKey: 'settings.pageFamilyRoles', options: ['settings.sectionFamily', 'settings.invites.title', 'settings.twoFactorTitle'] },
  '/settings/admin/permissions': { id: 'admin-permissions', adminOnly: true, labelKey: 'settings.pagePermissions', options: ['settings.permCapabilitiesHeading'] },
  '/settings/admin/weather': { id: 'admin-weather', adminOnly: true, labelKey: 'settings.pageHouseholdWeather', options: ['settings.weatherTitle'] },
  '/settings/admin/displays': { id: 'admin-displays', adminOnly: true, labelKey: 'settings.pageDisplays', options: ['settings.displayPairingCodeLabel'] },
  '/settings/admin/api': { id: 'admin-api', adminOnly: true, labelKey: 'settings.pageApiAccess', options: ['settings.apiTokensTitle'] },
  '/settings/admin/backup': { id: 'admin-backup', adminOnly: true, labelKey: 'settings.pageBackupRestore', options: ['settings.backupDownloadTitle', 'settings.backupRestoreTitle', 'settings.backupSchedulerTitle', 'settings.backupWebdavEnabled'] },
  '/settings/admin/email': { id: 'admin-email', adminOnly: true, labelKey: 'settings.pageEmail', options: ['email.host'] },
  '/settings/admin/immich': { id: 'admin-immich', adminOnly: true, labelKey: 'settings.pageImmich', options: ['settings.immichServerUrl'] },
  '/settings/admin/system': { id: 'admin-system', adminOnly: true, labelKey: 'settings.pageSystem', options: ['settings.appNameLabel', 'settings.systemVersionLabel'] },
});

/** Alias-Pfade aelterer Umbauten, die vor R10 schon umleiteten -> Abschnitt heute. */
const PRE_R10_ALIASES = Object.freeze({
  '/settings/documents/storage': 'documents-storage',
  '/settings/documents/dms': 'documents-dms',
  '/settings/modules/navigation': 'modules-navigation',
  '/settings/modules/dashboard': 'admin-weather',
  '/settings/modules/budget': 'options-budget',
  '/settings/modules/housekeeping': 'options-housekeeping',
});

/**
 * Optionen, die es bewusst nicht mehr gibt - mit dem Ort, der sie heute
 * traegt. Nur ein Eintrag: der zweite An/Aus-Schalter fuer Belohnungen (A7
 * P1-3). An und aus geht ein Modul nur in Aktive Module.
 */
const RETIRED_OPTIONS = Object.freeze({
  'settings.rewardsEnableLabel': 'modules-active',
});

/** Der Abschnitt, in dem ein altes Blatt heute steht (modules-options: einer je Teil). */
function sectionsOfOldLeaf(oldId) {
  if (oldId === 'modules-options') return SETTINGS_SECTIONS.filter((s) => String(s.loader).includes('modules-options.js'));
  // Feed-Abos: seit R14 ein Feed je Modulblatt, dieselbe Datei (A7 P2-3).
  if (oldId === 'personal-feeds') return SETTINGS_SECTIONS.filter((s) => String(s.loader).includes('personal-feeds.js'));
  return SETTINGS_SECTIONS.filter((s) => s.id === oldId);
}

/** Zerlegt die Umleitung eines Alt-Pfads in Blatt und Abschnitt. */
function landing(path, search = '') {
  const url = new URL(movedSettingsUrl(path, search) ?? path, 'http://x');
  const sheet = SETTINGS_LEAVES.find((leaf) => leaf.path === url.pathname) ?? null;
  return { sheet, section: url.searchParams.get('section'), params: url.searchParams };
}

test('S2: jede Adresse von vor R10 landet auf einem existierenden Blatt samt Abschnitt', () => {
  const paths = [...Object.keys(PRE_R10_LEAVES), ...Object.keys(PRE_R10_ALIASES)];
  assert.ok(paths.length >= 38, `nur ${paths.length} Alt-Adressen - liest der Test das Ledger noch?`);
  const routed = new Set([...SETTINGS_LEAVES.map((leaf) => leaf.path), ...RENAMED_SETTINGS_SOURCE_PATHS]);
  for (const path of paths) {
    // Der Router kennt die Adresse, sonst matcht ein Lesezeichen gar nichts.
    assert.ok(routed.has(path), `${path}: keine Route - ein Lesezeichen laeuft ins Leere`);
    const { sheet, section } = landing(path);
    assert.ok(sheet, `${path}: landet auf keinem Blatt`);
    assert.equal(findSettingsLeaf(path, admin)?.id, sheet.id, `${path}: findSettingsLeaf und Umleitung sind sich uneins`);
    const expected = PRE_R10_LEAVES[path]
      ? sectionsOfOldLeaf(PRE_R10_LEAVES[path].id).map((entry) => entry.id)
      : [PRE_R10_ALIASES[path]];
    const sheetSections = settingsSheetSections(sheet, admin).map((entry) => entry.id);
    if (section) {
      assert.ok(sheetSections.includes(section), `${path}: Abschnitt ${section} steht nicht im Blatt ${sheet.id}`);
      assert.ok(expected.includes(section), `${path}: springt an ${section}, erwartet ${expected.join('|')}`);
    } else {
      // Unverschoben: das Blatt traegt den Abschnitt des alten Blatts selbst.
      assert.ok(expected.some((id) => sheetSections.includes(id)), `${path}: ${sheet.id} traegt ${expected.join('|')} nicht`);
    }
  }
});

test('S2: Mitglieder landen an ihren Abschnitten, Admin-Adressen bleiben zu', () => {
  for (const [path, old] of Object.entries(PRE_R10_LEAVES)) {
    const sheet = findSettingsLeaf(path, member);
    if (old.adminOnly) {
      // Ein Blatt darf es fuer das Mitglied geben (Kalender), der alte
      // Admin-Abschnitt darin aber nicht.
      const visible = sheet ? settingsSheetSections(sheet, member).map((entry) => entry.id) : [];
      for (const section of sectionsOfOldLeaf(old.id)) {
        assert.equal(visible.includes(section.id), false, `${path}: ${section.id} ist fuer Mitglieder sichtbar`);
      }
    } else {
      assert.ok(sheet, `${path}: fuer Mitglieder verschwunden`);
      assert.ok(settingsSheetSections(sheet, member).some((entry) => entry.id === old.id), `${path}: ${old.id} fehlt im Blatt`);
    }
  }
});

test('S2: der Controller leitet Alt-Adressen samt Abschnitt und Parametern um', async () => {
  const source = await readFile(new URL('../public/pages/settings.js', import.meta.url), 'utf8');
  // Am Programm statt an der Schreibweise: der Controller fuehrt die Adresse
  // samt Parametern ueber movedSettingsUrl weiter.
  assert.deepEqual((await runSettingsController('/settings/sync/calendar', '?sync_ok=google')).replaced,
    ['/settings/modules/calendar?section=sync-calendar&sync_ok=google']);
  // Das OAuth-Ergebnis (?sync_ok) gehoert an den Abschnitt Kalender-Synchronisation.
  assert.match(source, /const SYNC_CALENDAR_LEAF = '\/settings\/modules\/calendar';/);
  assert.match(source, /`\$\{SYNC_CALENDAR_LEAF\}\?section=\$\{SYNC_CALENDAR_SECTION\}&\$\{query\.toString\(\)\}`/);
  // Parameter reisen mit, ein alter `?section=` nicht doppelt.
  const { sheet, section, params } = landing('/settings/sync/calendar', 'sync_ok=google&section=alt');
  assert.equal(sheet.id, 'module-calendar');
  assert.equal(section, 'sync-calendar');
  assert.equal(params.get('sync_ok'), 'google');
  assert.equal(params.getAll('section').length, 1);
  // Die Blaetter selbst verlinken intern auf die neuen Orte, nicht ueber die Umleitung.
  const pages = await readdir(new URL('../public/settings/pages/', import.meta.url));
  const stale = [];
  for (const file of pages.filter((name) => name.endsWith('.js'))) {
    const text = await readFile(new URL(`../public/settings/pages/${file}`, import.meta.url), 'utf8');
    for (const path of RENAMED_SETTINGS_SOURCE_PATHS) {
      if (text.includes(`'${path}'`) || text.includes(`"${path}"`)) stale.push(`${file}: ${path}`);
    }
  }
  assert.deepEqual(stale, []);
});

test('S2: kein Link in App, Server oder Uebersetzung zeigt auf eine Adresse von vor R10', async () => {
  // Die Umleitung ist das Netz fuer Lesezeichen - eigene Links (Dokumente ->
  // Speicher, Drive-OAuth-Ruecksprung, Hinweis im Zyklus) fuehren direkt ans
  // neue Blatt, sonst landet jeder Klick ueber einen replaceState-Umweg und
  // ein spaeteres Aufraeumen der Umleitung braeche sie still.
  const moved = new Set(RENAMED_SETTINGS_SOURCE_PATHS);
  const current = new Set(SETTINGS_LEAVES.map((leaf) => leaf.path));
  const roots = ['../public/', '../server/'];
  const skip = /\/(vendor|node_modules)\/|\/public\/settings\/registry\.js$|\/public\/sw\.js$/;
  const withoutComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const stale = [];
  const unknown = [];
  let scanned = 0;
  async function walk(url) {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url);
      if (skip.test(child.pathname)) continue;
      if (entry.isDirectory()) { await walk(child); continue; }
      if (!/\.(js|json|html)$/.test(entry.name)) continue;
      let text = await readFile(child, 'utf8');
      if (entry.name.endsWith('.js')) text = withoutComments(text);
      scanned += 1;
      for (const [path] of text.matchAll(/\/settings\/[a-z]+\/[a-z-]+/g)) {
        const where = child.pathname.replace(/^.*\/(public|server)\//, '$1/');
        if (moved.has(path)) stale.push(`${where}: ${path}`);
        else if (!current.has(path)) unknown.push(`${where}: ${path}`);
      }
    }
  }
  for (const root of roots) await walk(new URL(root, import.meta.url));
  assert.ok(scanned > 300, `nur ${scanned} Dateien gelesen - der Scan ist blind`);
  assert.deepEqual(stale, [], 'direkt auf das neue Blatt verlinken (movedSettingsUrl nennt das Ziel)');
  assert.deepEqual(unknown, [], 'Link auf ein Blatt, das es nicht gibt');
});

test('S2: die Suche findet jede Option und jedes Blatt von vor R10', async () => {
  const de = JSON.parse(await readFile(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de) ?? key;
  let seen = 0;
  for (const old of Object.values(PRE_R10_LEAVES)) {
    const homes = sectionsOfOldLeaf(old.id).map((entry) => entry.id);
    for (const key of old.options) {
      if (RETIRED_OPTIONS[key]) continue;
      seen += 1;
      const hits = searchSettings(translate(key), { user: admin, translate }).options;
      assert.ok(hits.some((hit) => hit.key === key && homes.includes(hit.section.id)),
        `"${translate(key)}" (${key}) findet ${old.id} nicht mehr`);
    }
    // Der NAME des frueheren Blatts findet seinen Ort: als Blatt oder als
    // Abschnitt ("Feed-Abos" -> Kalender, Abschnitt Feed-Abos).
    const name = translate(old.labelKey);
    const result = searchSettings(name, { user: admin, translate });
    const sheets = new Set(homes.map((id) => SETTINGS_SECTIONS.find((entry) => entry.id === id).sheetId));
    const found = result.leaves.some((leaf) => sheets.has(leaf.id))
      || result.sections.some((hit) => homes.includes(hit.section.id))
      || (old.id === 'modules-options' && result.options.length > 0);
    assert.ok(found || old.id === 'modules-options', `Blattname "${name}" (${old.id}) findet nichts mehr`);
  }
  assert.ok(seen >= 70, `nur ${seen} Optionen geprueft - liest der Test das Ledger noch?`);
  // Die ausgemusterte Option ist wirklich weg - und ihr Ort ist findbar.
  for (const [key, home] of Object.entries(RETIRED_OPTIONS)) {
    assert.equal(SETTINGS_SECTIONS.some((section) => (section.options ?? [])
      .some((entry) => (typeof entry === 'string' ? entry : entry.key) === key)), false, `${key} steht wieder im Index`);
    assert.ok(searchSettings(translate('settings.pageActiveModules'), { user: admin, translate })
      .leaves.some((leaf) => leaf.id === home));
  }
  // Ein Abschnitt-Treffer springt an seinen Abschnitt.
  const feeds = searchSettings(translate('settings.pageFeeds'), { user: admin, translate }).sections
    .find((hit) => hit.section.id === 'personal-feeds');
  assert.equal(settingsSectionUrl(feeds.leaf, feeds.section.id), '/settings/modules/calendar?section=personal-feeds');
});

// Codex P2 zu R10: ein Suchtreffer von vor R10
// (`/settings/modules/rewards?option=settings.rewardsEnableLabel`) landete auf
// dem Belohnungen-Blatt ohne die Option - das Blatt lebt weiter, nur der
// Schalter nicht. Die Adresse fuehrt an den Ort, der ihn heute traegt.
test('S2: eine ausgemusterte Option fuehrt von jedem alten Blatt an ihren heutigen Ort', () => {
  const oldHomes = Object.entries(PRE_R10_LEAVES).filter(([, old]) => old.options.some((key) => RETIRED_OPTIONS[key]));
  assert.ok(oldHomes.length > 0, 'das Ledger kennt das Blatt der ausgemusterten Option nicht mehr');
  for (const [key, home] of Object.entries(RETIRED_OPTIONS)) {
    for (const path of [...oldHomes.map(([oldPath]) => oldPath), '/settings/modules/options']) {
      const { sheet, section, params } = landing(path, `option=${key}`);
      assert.equal(sheet?.id, home, `${path}?option=${key}: landet auf ${sheet?.id}, erwartet ${home}`);
      assert.ok(settingsSheetSections(sheet, admin).some((entry) => entry.id === section), `${path}: Abschnitt ${section} fehlt im Blatt`);
      assert.equal(params.get('option'), null, 'die Option, die es nicht mehr gibt, faellt aus der Adresse');
    }
  }
  // Gegenprobe: eine lebende Option auf ihrem lebenden Blatt bleibt, wo sie ist.
  assert.equal(movedSettingsUrl('/settings/modules/rewards', 'option=settings.rewardsApprovalLabel'), null);
  assert.equal(movedSettingsUrl('/settings/modules/rewards'), null);
});

/**
 * Faehrt den Settings-Controller (pages/settings.js) als Programm fuer eine
 * Adresse, die umleitet: was landet per replaceState in der Adresse, was
 * bekommt der Router. Die Globals gehen danach zurueck; `update` misst die
 * Soft-Navigation auf dieselbe Adresse.
 */
async function runSettingsController(pathname, search, { soft = false } = {}) {
  const { render, update } = await import('/pages/settings.js');
  const prev = { window: globalThis.window, history: globalThis.history, sessionStorage: globalThis.sessionStorage };
  const replaced = [];
  const navigated = [];
  globalThis.window = {
    location: { pathname, search },
    yuvomi: { navigate: (...args) => navigated.push(args) },
  };
  globalThis.history = { replaceState: (_state, _title, url) => replaced.push(url) };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const container = { isConnected: true, replaceChildren() {}, insertAdjacentHTML() {}, querySelector: () => null };
  try {
    await render(container, { user: admin });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const softResult = soft ? await update({ user: admin, path: pathname, query: new URLSearchParams(search) }) : undefined;
    return { replaced, navigated, softResult };
  } finally {
    globalThis.window = prev.window;
    globalThis.history = prev.history;
    globalThis.sessionStorage = prev.sessionStorage;
  }
}

test('S2: der Controller leitet ein lebendes Blatt mit ausgemusterter Option per replaceState um', async () => {
  const { replaced, navigated, softResult } = await runSettingsController(
    '/settings/modules/rewards', '?option=settings.rewardsEnableLabel', { soft: true });
  assert.deepEqual(replaced, ['/settings/modules/active?section=modules-active'], 'die Adresse zeigt aufs heutige Blatt');
  assert.deepEqual(navigated, [['/settings/modules/active?section=modules-active', false]], 'und der Router zeichnet es');
  // Soft-Navigation auf dieselbe Adresse rendert nicht inkrementell, sondern
  // ueberlaesst sie dem regulaeren Pfad, der umleitet.
  assert.equal(softResult, false);
});

test('S1: Admin-Abschnitte bleiben fuer Nicht-Admins verborgen - im Blatt, in der Liste und in der Suche', async () => {
  const de = JSON.parse(await readFile(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
  const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de) ?? key;
  for (const sheet of SETTINGS_LEAVES) {
    const visible = settingsSheetSections(sheet, member);
    assert.deepEqual(visible.filter((section) => section.adminOnly).map((section) => section.id), [], sheet.id);
    // Ein Blatt ohne sichtbaren Abschnitt gibt es fuer das Mitglied nicht.
    assert.equal(Boolean(findSettingsLeaf(sheet.path, member)), visible.length > 0, sheet.id);
  }
  // Die Suche: kein Treffer eines Admin-Abschnitts, egal wonach gesucht wird.
  const queries = SETTINGS_SECTIONS.flatMap((section) => [section.labelKey, ...(section.options ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.key))]).map(translate);
  for (const query of queries) {
    const hits = searchSettings(query, { user: member, translate });
    const leaked = [...hits.sections, ...hits.options].filter((hit) => hit.section.adminOnly);
    assert.deepEqual(leaked.map((hit) => `${query} -> ${hit.section.id}`), []);
    assert.ok(hits.leaves.every((leaf) => findSettingsLeaf(leaf.path, member)), query);
  }
  // Die Shell rendert nur, was die Rolle sieht - Liste, Blatt und Vorwahl.
  const shell = await settingsShellSource();
  assert.match(shell, /const sections = settingsSheetSections\(leaf, user\);/);
  assert.match(shell, /for \(const entry of settingsSheetsForDomain\(domain\.id, user\)\)/);
  assert.match(shell, /const leaves = settingsSheetsForDomain\(domain\.id, user\);/);
  assert.equal(firstSettingsSheet(member, 'admin')?.domainId, 'personal', 'ein Mitglied bekommt kein Haushaltsblatt vorgewaehlt');
});

test('S1: ein Modul geht nur in Aktive Module an und aus - die Modulblaetter zeigen den Zustand', async () => {
  // Bis nichts mehr faellt: ein einmaliger Durchlauf laesst aus `<!<!---->--` wieder ein `<!--` entstehen.
  const strip = (src) => {
    let text = src;
    for (let prev = null; prev !== text;) {
      prev = text;
      text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    }
    return text;
  };
  const pages = (await readdir(new URL('../public/settings/pages/', import.meta.url))).filter((name) => name.endsWith('.js'));
  const writers = [];
  for (const file of pages) {
    const text = strip(await readFile(new URL(`../public/settings/pages/${file}`, import.meta.url), 'utf8'));
    // Schreiben heisst: der Schluessel als Payload-Feld (Lesen bleibt erlaubt).
    if (/(^|[{,])\s*disabled_modules\s*:/m.test(text)) writers.push(file);
  }
  assert.deepEqual(writers, ['modules-active.js'], 'ein zweites Blatt schaltet Module fuer den Haushalt');
  const rewards = await readFile(new URL('../public/settings/pages/modules-rewards.js', import.meta.url), 'utf8');
  assert.doesNotMatch(strip(rewards), /rewards-enabled|rewardsEnableLabel/, 'der Belohnungen-Schalter ist zurueck');

  // Die Statuszeile: Zustand fuer alle, der Weg zum Schalter nur fuer Admins.
  const shell = await settingsShellSource();
  const status = shell.slice(shell.indexOf('function createModuleStatus('), shell.indexOf('// Wie lange die angesprungene Option'));
  assert.match(status, /settings\.moduleStatusOn/);
  assert.match(status, /settings\.moduleStatusOff/);
  assert.match(status, /if \(user\?\.role === 'admin'\) \{\s*const link = createLink\(ACTIVE_MODULES_PATH/);
  assert.match(shell, /const ACTIVE_MODULES_PATH = '\/settings\/modules\/active';/);
  assert.equal(findSettingsLeaf('/settings/modules/active', admin)?.id, 'modules-active');
  // Reichweiten-Ueberschriften stehen auf Modulblaettern.
  assert.match(shell, /const scoped = Boolean\(leaf\.module\);/);
  assert.match(shell, /t\(scope === 'mine' \? 'settings\.scopeMine' : 'settings\.scopeHousehold'\)/);
});

test('S3: Liste + Detail ab der Split-Schwelle aus tokens.css, erstes Blatt per replaceState, mobil nie', async () => {
  const tokens = await readFile(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const threshold = Number(tokens.match(/--layout-split-threshold:\s*([0-9.]+)rem/)?.[1]);
  assert.ok(threshold > 0, 'tokens.css: --layout-split-threshold fehlt');
  const rules = await settingsCssRules();
  // Die Seite ist der Container, gemessen wird die Modulflaeche.
  assert.match(ruleBody(rules, '.settings-page'), /container:\s*settings-surface\s*\/\s*inline-size/);
  const inside = rules.filter((rule) => rule.at.some((at) => /@container\s+settings-surface/.test(at)));
  assert.ok(inside.length >= 2, 'keine Regel ab der Split-Schwelle');
  for (const rule of inside) {
    const at = rule.at.find((entry) => /@container\s+settings-surface/.test(entry));
    assert.equal(Number(at.match(/min-width:\s*([0-9.]+)rem/)?.[1]), threshold,
      `settings.css misst ${at}, tokens.css sagt ${threshold}rem - @container kann keine Variable lesen`);
  }
  const containerQuery = new RegExp(`@container\\s+settings-surface\\s*\\(min-width:\\s*${threshold}rem\\)`);
  // Darunter keine Seitenleiste; darueber steht sie, klebt und scrollt fuer sich.
  assert.match(ruleBody(rules, '.settings-shell__navigation'), /display:\s*none/);
  const nav = ruleBody(rules, '.settings-shell__navigation', containerQuery);
  assert.match(nav, /display:\s*block/);
  assert.match(nav, /position:\s*sticky/);
  assert.match(nav, /overflow-y:\s*auto/);
  // Die klebende Liste endet ueber dem Nachlauf der Shell (Installationsbanner):
  // bis an den Fensterrand gerechnet laegen ihre letzten Zeilen darunter und
  // waeren auch mit dem eigenen Bildlauf nicht zu erreichen.
  assert.match(nav, /max-height:\s*calc\([^;]*var\(--shell-tail/, 'die Liste zieht --shell-tail ab');
  assert.match(ruleBody(rules, '.settings-shell', containerQuery), /grid-template-columns:\s*var\(--settings-list-width\)\s+minmax\(0,\s*1fr\)/);
  // Das Blatt liest im Lesemass.
  assert.match(ruleBody(rules, '.settings-shell__content'), /max-inline-size:\s*var\(--layout-reading\)/);

  const shell = await settingsShellSource();
  // Ob die Spalte steht, sagt das CSS: keine zweite Schwelle im Skript.
  assert.doesNotMatch(shell, /matchMedia\([^)]*min-width/);
  assert.match(shell, /getComputedStyle\(navigation\)\.display !== 'none'/);
  // Vorwahl: replaceState, kein neuer History-Eintrag, kein Fokuswechsel - der
  // Fokus wandert nur, wenn er schon in den Einstellungen lag.
  const preselect = shell.slice(shell.indexOf('function preselectSheet('), shell.indexOf('function watchSplit('));
  assert.match(preselect, /history\.replaceState\(/);
  assert.doesNotMatch(preselect, /pushState|navigate\(|focus\(/);
  assert.match(shell, /const quiet = !page\?\.contains\(document\.activeElement\);[\s\S]*?if \(quiet\) return;\s*requestAnimationFrame\(\(\) => \{\s*if \(!leafContainer\.contains\(document\.activeElement\)\) heading\.focus/);
  // Nur im Split, und nur auf der Wurzel - ein Blatt in der Adresse hat Vorrang.
  assert.match(shell, /if \(!activeLeaf && page && isSplit\(shell\) && preselectSheet\(/);
  assert.match(shell, /if \(page\.classList\.contains\('settings-page--leaf'\)\) return;\s*if \(isSplit\(/);
  // Die Suche steht an der Listenkante (Seitenleiste), dieselbe wie in der Wurzel.
  assert.match(shell, /createNavigationSearch\(navigation, domains, user, activeLeaf\)/);
});

/*
 * OHNE SERVICE WORKER HAENGT NICHTS (Re-Critique 2026-09-28, A7 P1-2).
 * `navigator.serviceWorker.ready` loest nie auf, solange keine Registrierung
 * aktiv ist (No-SW-Proxy, blockierte Registrierung). pushStatus() wartete
 * darauf ohne Frist, das Blatt Benachrichtigungen damit auch, die Shell per
 * Promise.all auf alle Abschnitte - und der Router haelt waehrend eines
 * Soft-Updates seine Navigationssperre: danach wechselte KEIN Klick mehr das
 * Blatt. Zwei Riegel: push.js gibt nach einer Frist "nicht verfuegbar" zurueck,
 * und die Shell wartet hoechstens eine Frist auf ihre Abschnitte.
 */
function stubPushGlobals(ready) {
  const saved = {};
  for (const key of ['navigator', 'window', 'Notification']) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const Notification = { permission: 'default' };
  define('navigator', { serviceWorker: { ready } });
  define('window', { PushManager: function PushManager() {}, Notification });
  define('Notification', Notification);
  return () => {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  };
}

/** Loest das Versprechen auf, oder 'haengt', wenn es nach allen Mikro-Schritten noch offen ist. */
const settledOrHang = (promise) => Promise.race([promise, new Promise((r) => setImmediate(() => r('haengt')))]);

test('pushStatus: ein nie bereiter Service Worker meldet "nicht verfuegbar" statt zu haengen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const restore = stubPushGlobals(new Promise(() => {}));
  try {
    const { pushStatus, SW_READY_TIMEOUT_MS } = await import('/push.js');
    const pending = pushStatus();
    // 5s sind die Obergrenze, die sich noch nicht wie ein Haenger anfuehlt.
    t.mock.timers.tick(5000);
    const status = await settledOrHang(pending);
    assert.notEqual(status, 'haengt', 'pushStatus wartet ohne Frist auf serviceWorker.ready');
    assert.ok(SW_READY_TIMEOUT_MS > 0 && SW_READY_TIMEOUT_MS <= 5000);
    assert.deepEqual(
      { supported: status.supported, available: status.available, subscribed: status.subscribed },
      { supported: true, available: false, subscribed: false },
    );
  } finally {
    restore();
  }
});

test('pushStatus: ein bereiter Service Worker bleibt verfuegbar', async () => {
  const restore = stubPushGlobals(Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'x' }) } }));
  try {
    const { pushStatus } = await import('/push.js');
    const status = await pushStatus();
    assert.equal(status.available, true);
    assert.equal(status.subscribed, true);
  } finally {
    restore();
  }
});

test('das Blatt Benachrichtigungen nennt "nicht verfuegbar" und sperrt Schalter und Test', async () => {
  const source = await readFile(new URL('../public/settings/pages/notifications.js', import.meta.url), 'utf8');
  assert.match(source, /st\.available !== false[\s\S]{0,300}toggle\.disabled = true;\s*testBtn\.disabled = true;\s*status\.textContent = t\('settings\.pushUnavailable'\)/,
    'ohne Service Worker stuende "Status wird geprueft ..." fuer immer da');
});

test('die Shell wartet hoechstens eine Frist auf ihre Abschnitte', async (t) => {
  const { __test } = await import('/settings/shell.js');
  assert.equal(typeof __test?.awaitSections, 'function', 'settings/shell.js exportiert awaitSections nicht');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = false;
  const pending = __test.awaitSections([Promise.resolve(), new Promise(() => {})], () => { finished = true; });
  t.mock.timers.tick(__test.SECTION_WAIT_MS);
  assert.notEqual(await settledOrHang(pending), 'haengt', 'ein haengender Abschnitt haelt die Shell - und mit ihr die Navigationssperre des Routers');
  assert.equal(finished, false, 'das Blatt ist erst fertig, wenn alle Abschnitte stehen');

  // Alle da: das Fertig-Stueck laeuft, bevor die Shell zurueckkehrt.
  let done = false;
  await __test.awaitSections([Promise.resolve(), Promise.resolve()], () => { done = true; });
  assert.equal(done, true, 'ohne Haenger bleibt alles wie bisher: erst fertig, dann zurueck');

  // Die Shell nutzt genau diesen Weg, nicht mehr das nackte Promise.all.
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const leaf = shell.slice(shell.indexOf('async function renderLeafContent('), shell.indexOf('function isSplit('));
  assert.match(leaf, /await awaitSections\(/);
  assert.doesNotMatch(leaf, /await Promise\.all\(hosts/, 'renderLeafContent wartet wieder ohne Frist auf alle Abschnitte');
});

// R14 P12 (Re-Critique 2026-09-28, A1 P3-7): "v2.69.1" stand dauerhaft unter
// der Wortmarke - Chrome-Rauschen. Die Version steht, wo man sie sucht: im
// Blatt "Neuigkeiten" (aktuelle Version) und im Blatt "System".
test('R14: die Versionsnummer steht nicht mehr unter der Wortmarke', async () => {
  const router = await readFile(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /className = 'nav-sidebar__version'/, 'keine Versionszeile in der Seitenleiste');
  assert.match(router, /changelog\.currentVersion/, 'die Neuigkeiten nennen die installierte Version');
  const system = await readFile(new URL('../public/settings/pages/admin-system.js', import.meta.url), 'utf8');
  assert.match(system, /settings\.systemVersionValue/, 'das Blatt System nennt sie ebenfalls');
});

// R14 P10 (Re-Critique 2026-09-28, A7 P3): die Modulblaetter standen in einer
// anderen Reihenfolge als die Seitenleiste - Budget vor Gesundheit, Kontakte
// vor Dokumenten. Jetzt folgen sie ihr: Gruppen der Seitenleiste, darin die
// Reihenfolge, die der Haushalt gewaehlt hat.
test('R14: Modulblaetter stehen in der Reihenfolge der Seitenleiste', async () => {
  const { settingsSheetsForDomain } = await import('../public/settings/registry.js');
  const admin = { role: 'admin' };
  const ids = (order) => settingsSheetsForDomain('modules', admin, { moduleOrder: order }).map((s) => s.module ?? s.id);
  const plain = ids([]);
  assert.deepEqual(plain.slice(0, 2), ['modules-active', 'modules-navigation'], 'die zwei allgemeinen Blaetter zuerst');
  const mods = plain.slice(2);
  assert.deepEqual(mods, ['dashboard', 'calendar', 'schedule', 'tasks', 'kitchen', 'housekeeping', 'waste', 'documents',
    'inventory', 'rewards', 'contacts', 'health', 'budget'], 'ohne eigene Anordnung genau wie die Seitenleiste (gemessen 1440)');
  const pos = (id) => mods.indexOf(id);
  assert.equal(mods[0], 'dashboard', 'die Uebersicht fuehrt wie in der Seitenleiste');
  assert.ok(pos('tasks') < pos('kitchen') && pos('kitchen') < pos('contacts') && pos('contacts') < pos('budget'),
    `Planen, Haushalt, Menschen, Finanzen: ${mods}`);
  assert.ok(pos('health') < pos('budget'), 'Gesundheit (Menschen) vor Budget (Finanzen)');
  const custom = ids(['tasks', 'schedule', 'calendar', 'rewards', 'kitchen']).slice(2);
  assert.ok(custom.indexOf('tasks') < custom.indexOf('calendar'), 'die eigene Reihenfolge des Haushalts zaehlt');
  assert.ok(custom.indexOf('rewards') < custom.indexOf('kitchen'));
  const router = await readFile(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /moduleOrder: \(\) => _moduleOrder\.slice\(\)/, 'die Einstellungen lesen dieselbe Reihenfolge wie die Seitenleiste');
});

// R14 P10 (Re-Critique 2026-09-28, A8 P2-4): zwei mobile Unterseiten-
// Grammatiken - Gesundheit-Bereich mit Large Title (34px), Einstellungs-Blatt
// mit 22px-Titel direkt ueber einem 20px-Abschnitt. EINE Regel: eine Ebene
// tiefer heisst mobil Zurueck-Leiste plus Large Title.
test('R14: mobil traegt das Einstellungs-Blatt den Large Title wie jede Unterseite', async () => {
  const css = await readFile(new URL('../public/styles/typography.css', import.meta.url), 'utf8');
  const phone = [...eachRule(css)].filter((r) => r.at.some((a) => /\(max-width:\s*767px\)/.test(a))
    && r.selector.split(',').some((s) => s.trim() === '.settings-leaf-header__title'));
  assert.equal(phone.length, 1, 'eine Regel fuer den mobilen Blatt-Titel');
  assert.match(phone[0].body, /font-size:\s*var\(--type-page-title-mobile\)/, 'Large Title (34px), dieselbe Stufe wie der Modulkopf');
});

// R14 P10 (Re-Critique 2026-09-28, A7 P2-3): das Kalender-Blatt war die
// Sammelschublade - 4703px, fuenfmal "Feed aktivieren" als Primaerknopf, die
// Exporte von Inventar, Gesundheit, Schichtplan und Entsorgung darin.
test('R14: jeder Export steht im Blatt seines Moduls', async () => {
  const { settingsSheetsForDomain } = await import('../public/settings/registry.js');
  const member = { role: 'member' };
  const home = (id) => SETTINGS_SECTIONS.find((section) => section.id === id);
  assert.equal(home('personal-feeds').sheetId, 'module-calendar', 'der Kalender-Feed bleibt im Kalender');
  assert.equal(home('personal-feeds').props?.part, 'calendar');
  for (const [id, sheet, part] of [
    ['feed-schedule', 'module-schedule', 'schedule'],
    ['feed-cycle', 'module-health', 'cycle'],
    ['feed-inventory', 'module-inventory', 'inventory'],
    ['feed-waste', 'module-waste', 'waste'],
  ]) {
    const section = home(id);
    assert.equal(section?.sheetId, sheet, `${id} steht im Blatt ${sheet}`);
    assert.equal(section.props?.part, part);
    assert.equal(section.scope, 'mine', 'der Token haengt an der eigenen Zeile');
    assert.equal(section.adminOnly, false, 'jedes Mitglied richtet sein eigenes Abo ein (#770)');
    assert.ok(SETTINGS_LEAVES.some((leaf) => leaf.id === sheet), `${sheet} ist ein Blatt`);
  }
  const calendarOptions = home('personal-feeds').options.map((o) => (typeof o === 'string' ? o : o.key));
  assert.ok(!calendarOptions.some((key) => /inventoryFeed|cycleFeed|scheduleFeed|wasteFeed/.test(key)),
    'die Suche fuehrt fremde Exporte nicht mehr ins Kalender-Blatt');
  assert.ok(settingsSheetsForDomain('modules', member).some((leaf) => leaf.id === 'module-inventory'),
    'Mitglieder sehen das Inventar-Blatt (ihr eigener Feed)');
});

test('R14: ein Feed ist ein Schalter, kein Primaerknopf', async () => {
  const src = await readFile(new URL('../public/settings/pages/personal-feeds.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /btn--primary/, 'kein "Feed aktivieren" als Primaerknopf');
  // Seit R17 (E9) die Schalterzeile der Gruppe; `settingSwitchRowHtml` setzt
  // `control: 'switch'` selbst (test:control-dialect prueft das Ergebnis).
  assert.match(src, /settingSwitchRowHtml\(\{\s*label: feed\.text\.title\(\)/, 'An/Aus ist ein Schalter mit dem Namen des Feeds');
  assert.match(src, /container\.dataset\?\.part/, 'der Abschnitt sagt, welcher Feed');
  assert.match(src, /!next && !await feed\.confirmDisable\(\)/, 'Ausschalten fragt nach wie der fruehere Knopf');
});

// R14 P11 (Re-Critique 2026-09-28, A7 P3/A1): der Blattwechsel schnitt hart,
// waehrend der Rest der App mit Blenden wechselt. Das neue Blatt blendet ein -
// nur beim WECHSEL (nicht beim ersten Aufbau), nur Deckkraft, Dauer und
// Kurve aus den Tokens.
test('R14: ein Blattwechsel blendet das neue Blatt ein', async () => {
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const leaf = shell.slice(shell.indexOf('async function renderLeafContent('), shell.indexOf('function isSplit('));
  assert.match(leaf, /const swapping = Boolean\(content\.querySelector\(':scope > \.settings-leaf'\)\);[\s\S]*content\.replaceChildren\(breadcrumb, header, leafContainer\);/,
    'gefragt wird VOR dem Tausch, ob schon ein Blatt stand');
  assert.match(leaf, /if \(swapping\) \{[^}]*classList\.add\('settings-sheet-enter'\)/, 'nur ein Wechsel blendet');
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const enter = rules.find((r) => r.selector.trim() === '.settings-sheet-enter');
  assert.ok(enter, 'die Regel fuer das einblendende Blatt fehlt');
  assert.match(enter.body, /animation:\s*settings-sheet-enter var\(--duration-md\) var\(--ease-out\)/);
  assert.match(css, /@keyframes settings-sheet-enter\s*\{\s*from\s*\{\s*opacity:\s*0;?\s*\}\s*\}/, 'nur Deckkraft - nichts bewegt sich');
});

// R14 P8 (Re-Critique 2026-09-28, A7 P2-4): Familie brach den Kanon - violetter
// Balken "+ Mitglied hinzufuegen" ueber 720px, 850px Inline-Formular mit
// [Erstellen][Abbrechen], Zeilen ohne Haarlinien, Namen per Verkettung
// ("Alex Johnson Loeschen"). Jetzt: Blatt-Dialog mit Kanon-Fuss, geteilte Liste,
// Objektnamen aus common.*Named.
test('R14: Familie legt im Blatt-Dialog an, Fuss [Abbrechen][Primaer], Zeilen mit Haarlinien', async () => {
  const src = await readFile(new URL('../public/settings/pages/admin-family.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /settings-card--hidden/, 'kein Inline-Formular, das auf- und zugeklappt wird');
  for (const [fn, cancel, submit] of [
    ['addMemberFormHtml', 'cancel-add-member', "t('settings.createMember')"],
    ['addInviteFormHtml', 'cancel-add-invite', "t('settings.invites.submit')"],
  ]) {
    const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf('\n}\n', src.indexOf(`function ${fn}(`)));
    const foot = body.slice(body.indexOf('modal-panel__footer'));
    assert.ok(body.includes('modal-panel__footer'), `${fn}: der Fuss ist .modal-panel__footer`);
    assert.ok(foot.indexOf(cancel) >= 0 && foot.indexOf(cancel) < foot.indexOf(submit), `${fn}: [Abbrechen] vor [Primaer]`);
  }
  assert.match(src, /addMemberBtn\.addEventListener\('click', \(\) => openAddMemberModal\(/, 'der Knopf oeffnet den Dialog');
  assert.match(src, /addBtn\.addEventListener\('click', \(\) => openInviteModal\(\)\)/);
  assert.match(src, /content: addMemberFormHtml\(\)/);
  assert.match(src, /content: addInviteFormHtml\(\)/);
  assert.match(src, /<ul class="settings-members row-divided" id="members-list">/, 'Haarlinien zwischen den Mitgliedern');
  assert.doesNotMatch(src, /btn--primary settings-add-btn/, 'kein violetter Balken ueber die volle Breite');
  // Seit #1381 heisst der Knopf "entfernen", nicht "loeschen": ein Konto mit
  // Spuren in geteilten Daten wird deaktiviert. Sein Objekt nennt er weiter.
  assert.match(src, /t\('settings\.removeMemberNamed', \{ name: u\.display_name \}\)/, 'der Entfernen-Knopf nennt sein Objekt');
  assert.match(src, /t\('common\.editNamed', \{ name: u\.display_name \}\)/);
  const editFoot = src.slice(src.indexOf('id="edit-member-error"'), src.indexOf("settings.saveMember')}</button>"));
  assert.match(editFoot, /modal-panel__footer/, 'auch Bearbeiten traegt den Kanon-Fuss');
});

// R14 P8 (Re-Critique 2026-09-28, A7 Konsistenz): die Rechte trugen einen
// eigenen Modus-Umschalter (.perm-modeswitch) neben dem Kanon-Umschalter, den
// Design und Wochenstart zeigen.
test('R14: der Modus der Rechte ist der Kanon-Umschalter .segmented', async () => {
  const src = await readFile(new URL('../public/settings/pages/admin-permissions.js', import.meta.url), 'utf8');
  assert.match(src, /<div class="segmented settings-segmented perm-mode" role="tablist"/);
  assert.match(src, /class="segmented__item is-active" role="tab" aria-selected="true" data-mode="role"/);
  assert.match(src, /attachSegmentIndicator\(modeSwitch\)/, 'die gleitende Kapsel bleibt');
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /perm-modeswitch/, 'kein zweiter Dialekt im Stylesheet');
});

// R14 P12 (Re-Critique 2026-09-28, A2 P2-3): die eigenen Schichtplan-
// Einstellungen (Vorlauf, Ueberstunden, Wochenstunden) standen als Karte im
// Tab "Auswertung". Sie gehoeren ins Modulblatt - und ein Mitglied muss sie
// dort finden: die Route traegt keinen Admin-Check, das Blatt darf keinen
// erfinden. Ohne den Registry-Eintrag war personal-schedule.js unerreichbar.
test('R14: "Meine Einstellungen" des Schichtplans stehen im Modulblatt, auch fuer Mitglieder', async () => {
  const member = { role: 'member' };
  const sheet = SETTINGS_LEAVES.find((leaf) => leaf.id === 'module-schedule');
  assert.ok(sheet, 'das Modulblatt Schichtplan existiert');
  const sections = settingsSheetSections(sheet, member);
  const mine = sections.find((section) => section.id === 'personal-schedule');
  assert.ok(mine, 'der Abschnitt steht im Blatt und ist fuer ein Mitglied sichtbar');
  assert.equal(mine.scope, 'mine');
  assert.equal(mine.adminOnly, false);
  assert.match(String(mine.loader), /import\('\/settings\/pages\/personal-schedule\.js'\)/,
    'der Abschnitt laedt die Seite, die z14 aus der Auswertung geholt hat');
  const src = await readFile(new URL('../public/settings/pages/personal-schedule.js', import.meta.url), 'utf8');
  assert.match(src, /export async function render\(container, \{ user \}\)/, 'die Shell ruft render() des Moduls');
});

// #1607: ein Mitglied mit `health: none` sah das Gesundheitsblatt in den
// Einstellungen offen und bedienbar, daneben "Kein Zugriff" - der Server wies
// jeden Aufruf ab, die Seitenleiste zeigte das Modul laengst nicht mehr. Die
// Einstellungen fragten nur nach der Rolle (adminOnly), nie nach dem
// Modulrecht. Alle Wege in ein Blatt (Liste, Adresse, Suche) laufen durch
// sheetVisible(), also wird dort gemessen - an den drei Ausgaengen, nicht am
// Quelltext.
test('#1607: ein Modulblatt folgt dem Modulrecht - none blendet aus, read bleibt', async () => {
  const { settingsSheetsForDomain } = await import('../public/settings/registry.js');
  const { setPermissions, clearPermissions } = await import('../public/permissions.js');
  const member = { role: 'member' };
  const translate = (key) => key;
  const sheetIds = () => settingsSheetsForDomain('modules', member).map((leaf) => leaf.id);
  const healthPath = SETTINGS_LEAVES.find((leaf) => leaf.id === 'module-health').path;
  const searchHits = () => {
    const found = searchSettings('nav.health', { user: member, translate });
    return [...found.leaves, ...found.sections.map((hit) => hit.leaf), ...found.options.map((hit) => hit.leaf)]
      .filter((leaf) => leaf.id === 'module-health').length;
  };

  try {
    // Gegenprobe zuerst: ohne Einschraenkung ist alles da. Faellt das schon
    // hier, misst der Rest das Fehlen von etwas, das es nie gab.
    clearPermissions();
    assert.ok(sheetIds().includes('module-health'));
    assert.equal(findSettingsLeaf(healthPath, member)?.id, 'module-health');
    assert.ok(searchHits() > 0, 'die Suche findet das Gesundheitsblatt gar nicht - die Sonde ist blind');

    setPermissions({ admin: false, modules: { health: 'none' } });
    assert.ok(!sheetIds().includes('module-health'), 'die Blattliste fuehrt Gesundheit trotz none');
    assert.equal(findSettingsLeaf(healthPath, member), null, 'die Adresse oeffnet das Blatt trotz none');
    assert.equal(searchHits(), 0, 'die Suche fuehrt trotz none ins Gesundheitsblatt');
    assert.ok(sheetIds().includes('module-tasks'), 'none fuer EIN Modul nimmt die anderen Blaetter nicht mit');

    // Nur lesen: das Blatt bleibt (Zustand bleibt als Zeichen).
    setPermissions({ admin: false, modules: { health: 'read' } });
    assert.ok(sheetIds().includes('module-health'), 'read blendet das Blatt aus');

    // Nicht nur Gesundheit: jedes Modulblatt, das ein Mitglied sieht, folgt
    // seinem Recht. Die Liste kommt aus der Registry und nicht aus diesem Test,
    // damit ein neues Blatt mitgeprueft wird.
    clearPermissions();
    const gated = settingsSheetsForDomain('modules', member)
      .filter((leaf) => leaf.module && leaf.module !== 'dashboard');
    assert.ok(gated.length >= 6, `nur ${gated.length} Modulblaetter fuer Mitglieder - die Schleife misst zu wenig`);
    for (const leaf of gated) {
      setPermissions({ admin: false, modules: { [leaf.module]: 'none' } });
      assert.ok(!sheetIds().includes(leaf.id), `${leaf.id} bleibt trotz ${leaf.module}: none`);
      assert.equal(findSettingsLeaf(leaf.path, member), null, `${leaf.path} oeffnet trotz none`);
    }

    // Ein Blatt ohne Modul (Navigation) haengt an keinem Recht.
    setPermissions({ admin: false, modules: Object.fromEntries(gated.map((leaf) => [leaf.module, 'none'])) });
    assert.deepEqual(sheetIds(), ['modules-navigation'], 'ohne jedes Modulrecht bleibt genau das modulfreie Blatt');

    // Ein Admin ist nie eingeschraenkt, was auch immer in der Tabelle steht.
    setPermissions({ admin: true, modules: { health: 'none' } });
    assert.ok(settingsSheetsForDomain('modules', { role: 'admin' }).some((leaf) => leaf.id === 'module-health'));
  } finally {
    clearPermissions();
  }
});

// Critique 2026-10-05 (R16): das Kalender-Blatt mass mobil 4319px, fuenf
// Abschnitte untereinander, der erste Schalter bei y=517. Das Sprungziel gab
// es laengst (`?section=`, Ziel der Umleitungen) - nur keinen Weg dorthin, der
// im Blatt selbst steht. Blaetter mit mehr als drei Abschnitten fuehren jetzt
// Sprungmarken am Blattanfang; kurze Blaetter bleiben ohne.
test('R16: ein Blatt mit mehr als drei Abschnitten fuehrt Sprungmarken auf seine Abschnitte', async () => {
  const { SETTINGS_LEAVES, settingsSheetJumpTargets, settingsSheetSections } = await import('../public/settings/registry.js');
  const admin = { id: 1, role: 'admin', is_admin: true };
  const sheet = (id) => SETTINGS_LEAVES.find((entry) => entry.id === id);

  const calendar = settingsSheetJumpTargets(sheet('module-calendar'), admin);
  assert.deepEqual(calendar.map((target) => target.id),
    ['personal-calendar', 'personal-calendar-subscriptions', 'personal-feeds', 'modules-calendar', 'sync-calendar'],
    'in der Reihenfolge des Blatts: erst "Fuer mich", dann der Haushalt');
  assert.equal(calendar[4].url, '/settings/modules/calendar?section=sync-calendar', 'dasselbe Ziel wie die Umleitungen');
  assert.equal(calendar[0].labelKey, 'settings.pageCalendarDefaults', 'die Marke heisst wie der Abschnitt in der Registry');

  // Drei Abschnitte sind ein Blick, keine Navigation.
  const tasks = sheet('module-tasks');
  assert.equal(settingsSheetSections(tasks, admin).length, 3);
  assert.deepEqual(settingsSheetJumpTargets(tasks, admin), []);
  // Was ein Mitglied nicht sieht, zaehlt nicht mit und steht nicht in den Marken.
  const member = { id: 2, role: 'member', is_admin: false };
  const memberTargets = settingsSheetJumpTargets(sheet('module-calendar'), member);
  assert.ok(memberTargets.every((target) => settingsSheetSections(sheet('module-calendar'), member).some((s) => s.id === target.id)));
});

test('R16: die Sprungmarken sind Links im Blatt, eine scrollende Zeile, und springen ohne Neuaufbau', async () => {
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /settingsSheetJumpTargets\(leaf, user\)/, 'die Shell fragt die Registry, sie zaehlt nicht selbst');
  // Zurueck liest `state.path` VOR der Adresse (router.js, popstate): zieht nur
  // die Adresse um, landet die Rueckkehr am alten Abschnitt (Review #1673).
  const jump = shell.slice(shell.indexOf('function createSheetJump('), shell.indexOf('function createSheetJump(') + 1600);
  assert.match(jump, /replaceState\?\.\(\{ \.\.\.window\.history\.state, path: target\.url \}, '', target\.url\)/,
    'der History-Eintrag traegt den Abschnitt, nicht nur die Adresszeile');
  assert.match(shell, /link\.href = target\.url/, 'ein echter Link: Mittelklick und "Adresse kopieren" fuehren an den Abschnitt');
  assert.match(shell, /event\.preventDefault\(\);\s*\n\s*revealSheetSection\(leafContainer, target\.id\)/,
    'der Klick springt im stehenden Blatt (Fokus auf die Abschnittsueberschrift), statt es neu zu laden');
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const row = rules.find((r) => r.selector.trim() === '.settings-sheet-jump__list' && !r.at.length);
  assert.match(row?.body ?? '', /overflow-x:\s*auto/);
  assert.match(row?.body ?? '', /flex-wrap:\s*nowrap/, 'eine Zeile: umgebrochen kosteten fuenf Marken mobil drei Reihen vor dem ersten Schalter');
});

test('R16: mobil ist die Blattbeschreibung zwei Zeilen lang', async () => {
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const phone = [...eachRule(css)].find((r) => r.at.some((a) => /\(max-width:\s*767px\)/.test(a))
    && r.selector.split(',').some((s) => s.trim() === '.settings-leaf-header__description'));
  assert.match(phone?.body ?? '', /-webkit-line-clamp:\s*2/, 'vier Zeilen Vorspann standen vor dem ersten Schalter');
});

test('R16: im Blatt mit Sprungmarken steht die Beschreibung mobil nur im Baum', async () => {
  // Marken und Beschreibung zaehlen beide auf, was im Blatt steht; zusammen
  // schoben sie den ersten Schalter des Kalender-Blatts von y=517 auf 580.
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /if \(jump\) \{[^}]*header\.classList\.add\('settings-leaf-header--jump'\)/,
    'der Kopf weiss, dass Marken folgen - nur dann weicht die Beschreibung');
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const phone = [...eachRule(css)].find((r) => r.at.some((a) => /\(max-width:\s*767px\)/.test(a))
    && r.selector.trim() === '.settings-leaf-header--jump .settings-leaf-header__description');
  assert.match(phone?.body ?? '', /clip:\s*rect\(0, 0, 0, 0\)/, 'geclippt, nicht entfernt: der Text bleibt fuer Screenreader');
  assert.doesNotMatch(phone?.body ?? '', /display:\s*none/);
});


// #1509: das aktive Blatt steht in der Seitenleiste SICHTBAR, nicht unter der
// klebenden Suche. Gemessen im Browser (1280x700, Leiste 32-700, Suche klebt
// bei 32-100): nach einem Sprung zu einem Blatt OBERHALB des sichtbaren
// Ausschnitts (Zurueck, Palette, Deep-Link) stand der aktive Link bei 32-72,
// alle 40px unter der Suche. Die Vorfassung rechnete mit der Oberkante der
// Leiste, als laege dort nichts.
//
// Der Stub ist die Leiste als Geometrie: ein Scrollport mit einer Suche, die
// an seiner Oberkante klebt, und einem Link an fester Stelle im Inhalt. Die
// Rechtecke folgen scrollTop, wie im Browser.
function settingsNavigationStub({ linkTop, scrollTop = 0, sticky = true }) {
  const VIEW_TOP = 32;
  const CLIENT = 668;
  const SCROLL = 1408;
  const SEARCH = 68;
  const LINK = 40;
  const state = { top: scrollTop };
  const search = {
    offsetHeight: SEARCH,
    getBoundingClientRect: () => (sticky
      ? { top: VIEW_TOP, bottom: VIEW_TOP + SEARCH }
      : { top: VIEW_TOP - state.top, bottom: VIEW_TOP - state.top + SEARCH }),
  };
  const link = {
    offsetTop: linkTop,
    offsetHeight: LINK,
    getBoundingClientRect: () => ({ top: VIEW_TOP + linkTop - state.top, bottom: VIEW_TOP + linkTop - state.top + LINK }),
  };
  const navigation = {
    offsetTop: 0,
    offsetHeight: CLIENT,
    clientHeight: CLIENT,
    scrollHeight: SCROLL,
    get scrollTop() { return state.top; },
    set scrollTop(value) { state.top = Math.min(SCROLL - CLIENT, Math.max(0, value)); },
    getBoundingClientRect: () => ({ top: VIEW_TOP, bottom: VIEW_TOP + CLIENT, height: CLIENT }),
    querySelector: (sel) => (sel.includes('navigation-link--active') ? link : sel.includes('navigation-search') ? search : null),
  };
  link.offsetParent = navigation;
  globalThis.getComputedStyle = (node) => ({ position: node === search && sticky ? 'sticky' : 'static' });
  /** Wie viele Pixel des Links unter der Suche oder ausserhalb der Leiste liegen. */
  const hidden = () => {
    const l = link.getBoundingClientRect();
    const s = search.getBoundingClientRect();
    const under = Math.max(0, Math.min(l.bottom, s.bottom) - Math.max(l.top, s.top));
    return under + Math.max(0, VIEW_TOP - l.top) + Math.max(0, l.bottom - (VIEW_TOP + CLIENT));
  };
  return { navigation, hidden };
}

test('settings sidebar: the active link is revealed below the sticky search, not under it', async () => {
  const { __test } = await import('/settings/shell.js');
  assert.equal(typeof __test?.revealActiveNavigationLink, 'function');
  const previous = globalThis.getComputedStyle;
  try {
    // Der gemessene Fall: Leiste weit unten, das aktive Blatt weiter oben.
    const above = settingsNavigationStub({ linkTop: 485, scrollTop: 728 });
    __test.revealActiveNavigationLink(above.navigation);
    assert.equal(above.hidden(), 0, 'ein Link oberhalb des Ausschnitts landet unter der Suche');
    assert.equal(above.navigation.scrollTop, 485 - 68, 'er steht direkt unter der Suche, nicht weiter');

    // Halb verdeckt: die Oberkante liegt im Ausschnitt, aber hinter der Suche.
    const half = settingsNavigationStub({ linkTop: 300, scrollTop: 270 });
    __test.revealActiveNavigationLink(half.navigation);
    assert.equal(half.hidden(), 0, 'ein von der Suche angeschnittener Link bleibt angeschnitten');

    // Unterhalb: wie bisher bis an die Unterkante.
    const below = settingsNavigationStub({ linkTop: 1300, scrollTop: 0 });
    __test.revealActiveNavigationLink(below.navigation);
    assert.equal(below.hidden(), 0);
    assert.equal(below.navigation.scrollTop, 1300 + 40 - 668, 'ein Link darunter rueckt nur bis an die Unterkante');

    // Schon sichtbar: die Leiste bleibt stehen.
    const visible = settingsNavigationStub({ linkTop: 400, scrollTop: 275 });
    __test.revealActiveNavigationLink(visible.navigation);
    assert.equal(visible.navigation.scrollTop, 275, 'ein sichtbarer Link bewegt die Leiste nicht');

    // Ohne klebende Suche gibt es nichts abzuziehen.
    const plain = settingsNavigationStub({ linkTop: 485, scrollTop: 728, sticky: false });
    __test.revealActiveNavigationLink(plain.navigation);
    assert.equal(plain.navigation.scrollTop, 485, 'eine mitscrollende Suche verdeckt nichts');
  } finally {
    globalThis.getComputedStyle = previous;
  }
});

// R17 (Critique 2026-10-07, E9): EINE KARTE JE OPTION GIBT ES NICHT MEHR.
//
// Das Blatt Darstellung trug zehn Einstellungen in acht Karten (1650px bei
// 1280, 2014px mobil, drei im ersten Bild), waehrend "Aktive Module" daneben
// schon gruppierte Zeilen fuehrte. Jetzt steht eine Option als Zeile in einem
// Traeger (`.row-carrier.settings-group`, settings/components.js
// `settingRowHtml` / `settingSwitchRowHtml`); eine Karte bleibt, wo ein echtes
// Formular steht (mehrere Felder, ein Knopf).
//
// AM GERENDERTEN MARKUP, nicht am Dateitext: jeder Abschnitt der Registry wird
// als Programm gerendert (Admin, leere Antworten), und beurteilt wird, was er
// in seinen Traeger schreibt. Ein Regex ueber die Quelldatei saehe weder, was
// ein Helfer zusammensetzt (`partHtml`, `scopeRowHtml`), noch welcher Zweig
// einer Vorlage laeuft. Nicht gesehen wird, was ein Abschnitt erst per DOM-API
// baut (documents-storage, die Konten der Synchronisation) - dort stehen
// Formulare, keine Ein-Element-Karten.
function sheetProbeContainer(part) {
  let html = '';
  let longest = '';
  return {
    dataset: part ? { part } : {},
    isConnected: true,
    // Ein Abschnitt, der NACH dem Zeichnen an einer Attrappe scheitert, ersetzt
    // sein Markup durch den Fehlerzustand - beurteilt wird der laengste Stand.
    get html() { return longest; },
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_pos, markup) { html += markup; if (html.length > longest.length) longest = html; },
    appendChild() {}, append() {}, addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

/**
 * Entfernt HTML-Kommentare, bis keiner mehr faellt. Ein einzelner Durchlauf
 * genuegt nicht: aus `<!<!-- a -->-- b -->` macht er `<!-- b -->`, und der
 * Scanner dahinter liest wieder Markup, das auskommentiert ist (CodeQL
 * `js/incomplete-multi-character-sanitization`).
 */
function stripHtmlComments(markup) {
  let text = String(markup);
  for (let prev = null; prev !== text;) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  }
  return text;
}

/** Jede `.settings-card` des Markups samt Inhalt (Kommentare vorher entfernt). */
function settingsCardsIn(markup) {
  const html = stripHtmlComments(markup);
  const cards = [];
  const open = /<div class="(?:[^"]*\s)?settings-card(?:\s[^"]*)?"[^>]*>/g;
  let m;
  while ((m = open.exec(html))) {
    const tag = /<(\/?)div\b[^>]*>/g;
    tag.lastIndex = open.lastIndex;
    let depth = 1;
    let end = html.length;
    let t;
    while (depth > 0 && (t = tag.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) end = tag.lastIndex;
    }
    cards.push(html.slice(m.index, end));
  }
  return cards;
}

const cardControls = (card) => [...card.matchAll(
  /<select\b|<textarea\b|role="radiogroup"|<input\b(?![^>]*\btype="(?:hidden|file|radio)")[^>]*>/g,
)].length;
const cardHasAction = (card) => /<button\b|class="(?:[^"]*\s)?btn(?:\s[^"]*)?"/.test(card);

test('R17: der Karten-Scanner sieht eine Karte mit genau einem Bedienelement - und laesst ein Formular stehen', () => {
  const lone = '<div class="settings-card"><h3>Titel</h3><label class="toggle-row"><input type="checkbox" role="switch"></label><p>Hinweis</p></div>';
  const form = '<div class="settings-card"><div><input type="text"></div><input type="password"><button class="btn btn--primary">x</button></div>';
  const withButton = '<div class="settings-card settings-card--x"><input type="text"><div><button type="submit">x</button></div></div>';
  const commented = '<!-- <div class="settings-card"><select></select></div> --><div class="row-carrier settings-group"><select></select></div>';
  const cards = settingsCardsIn(lone + form + withButton + commented);
  assert.equal(cards.length, 3, 'drei Karten, die auskommentierte zaehlt nicht');
  assert.deepEqual(cards.map(cardControls), [1, 2, 1]);
  assert.deepEqual(cards.map(cardHasAction), [false, true, true]);
  assert.match(cards[1], /btn--primary/, 'die Karte reicht bis zu IHREM schliessenden div, nicht bis zum ersten');
});

test('R17: der Karten-Scanner liest kein Markup, das erst nach dem Entfernen eines Kommentars zum Kommentar wird', () => {
  // Ein Durchlauf laesst hier `<!-- <div class="settings-card">...</div> -->`
  // stehen, und der Scanner zaehlte die auskommentierte Karte mit.
  const nested = '<!<!-- a -->-- <div class="settings-card"><select></select></div> -->';
  assert.equal(stripHtmlComments(nested), '');
  assert.equal(settingsCardsIn(nested).length, 0, 'die Karte ist auskommentiert');
  assert.equal(stripHtmlComments('<!<!<!-- a -->-- b -->-- c --><p>bleibt</p>'), '<p>bleibt</p>', 'auch drei Ebenen tief');
  // Gegenproben: ohne Kommentar bleibt alles, und eine echte Karte daneben zaehlt weiter.
  assert.equal(stripHtmlComments('<p>a</p>'), '<p>a</p>');
  assert.equal(settingsCardsIn(nested + '<div class="settings-card"><select></select></div>').length, 1);
});

/** Jeder Abschnitt der Registry, als Programm gerendert: id -> Markup. Einmal je Lauf. */
let sheetProbe = null;
function probeSheets() {
  sheetProbe ??= (async () => {
    const { SETTINGS_SECTIONS } = await import('../public/settings/registry.js');
    const { resetPreferencesCache } = await import('/settings/preferences-cache.js');
    const prev = { window: globalThis.window, document: globalThis.document, api: globalThis.__apiStub };
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.window = {
      yuvomi: { showToast() {}, isModuleDisabled: () => false },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
      location: { origin: 'http://localhost', protocol: 'https:', pathname: '/settings' },
      localStorage: storage,
    };
    globalThis.document = fakeDocument();
    globalThis.__apiStub = {
      // Ein Feed ist ohne Adresse AUS (ein Schalter); Listen sind leer.
      get: async (url) => {
        if (/feed/.test(url)) return { data: null };
        if (/^\/modules/.test(url)) return { data: [] };
        return { data: {} };
      },
      put: async (_url, body) => ({ data: body }),
      post: async () => ({ data: {} }),
      patch: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    };
    resetPreferencesCache();
    const rendered = new Map();
    try {
      for (const section of SETTINGS_SECTIONS) {
        const host = sheetProbeContainer(section.props?.part);
        try {
          const module = await section.loader();
          await module.render(host, { user: { id: 1, role: 'admin', is_admin: true }, query: new URLSearchParams() });
        } catch {
          // Nach dem Zeichnen an einer Attrappe gescheitert: das Markup steht.
        }
        rendered.set(section.id, stripHtmlComments(host.html));
      }
    } finally {
      globalThis.window = prev.window;
      globalThis.document = prev.document;
      globalThis.__apiStub = prev.api;
      resetPreferencesCache();
    }
    return rendered;
  })();
  return sheetProbe;
}

test('R17: kein Einstellungsblatt rendert eine Karte mit genau einem Bedienelement', async () => {
  const rendered = await probeSheets();

  const offenders = [];
  let cardsSeen = 0;
  for (const [id, html] of rendered) {
    for (const card of settingsCardsIn(html)) {
      cardsSeen += 1;
      if (cardControls(card) === 1 && !cardHasAction(card)) {
        offenders.push(`${id}: ${card.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'eine Option ist eine Zeile in einem Traeger (.settings-group), keine eigene Karte');

  // EINE ZUSICHERUNG UEBER NICHTS IST KEINE. Die umgestellten Abschnitte
  // muessen wirklich gezeichnet haben, und zwar gruppierte Zeilen; faellt
  // einer unter der Attrappe um, bevor er zeichnet, sieht der Guard ihn nicht.
  const GROUPED = [
    'personal-appearance', 'personal-notifications', 'admin-family', 'modules-countdowns',
    'personal-calendar', 'personal-feeds', 'modules-calendar', 'options-schedule', 'options-tasks',
    'options-budget', 'options-housekeeping', 'options-health', 'modules-rewards', 'personal-health',
    'feed-schedule', 'feed-cycle', 'feed-inventory', 'feed-waste',
  ];
  for (const id of GROUPED) {
    const html = rendered.get(id) ?? '';
    assert.match(html, /class="row-carrier settings-group"/, `${id}: keine gruppierten Zeilen im gerenderten Markup`);
    assert.match(html, /class="settings-setting-row[ "]/, `${id}: der Traeger ist leer`);
  }
  const drawn = [...rendered.values()].filter((html) => html.length > 0).length;
  assert.ok(drawn >= 30, `nur ${drawn} von ${rendered.size} Abschnitten haben gezeichnet - liest der Guard die Blaetter noch?`);
  assert.ok(cardsSeen >= 15, `nur ${cardsSeen} Karten gesehen - der Scanner findet die Formular-Karten nicht mehr`);
});

test('R17: die gruppierte Zeile - Label links, Bedienelement rechts, der Hinweis ausserhalb des Labels', async () => {
  const { settingRowHtml, settingSwitchRowHtml } = await import('../public/settings/components.js');
  const row = settingRowHtml({
    label: 'Zeit <zone>', labelFor: 'tz', description: 'Gilt & wirkt', descriptionId: 'tz-hint',
    control: '<select id="tz"></select>', extra: '<div id="tz-error" hidden></div>',
  });
  // Seit R18 (2026-10-07) IST die Einstellungszeile eine Formularzeile
  // (utils/form-row.js): jede Klasse `settings-setting-row*` traegt ihr
  // `form-row*` daneben. Reihenfolge, Verknuepfung und Escaping sind die alten.
  assert.match(row, /^<div class="settings-setting-row form-row"><div class="settings-setting-row__copy form-row__copy"><label class="settings-setting-row__label form-row__label" for="tz">Zeit &lt;zone&gt;<\/label>/);
  assert.match(row, /<p class="settings-setting-row__description form-row__description" id="tz-hint">Gilt &amp; wirkt<\/p><div id="tz-error" hidden><\/div><\/div><div class="settings-setting-row__control form-row__control"><select id="tz"><\/select><\/div><\/div>$/);
  assert.match(settingRowHtml({ label: 'x', labelId: 'l', stacked: true }), /^<div class="settings-setting-row settings-setting-row--stacked form-row form-row--stacked"><div class="settings-setting-row__copy form-row__copy"><span class="settings-setting-row__label form-row__label" id="l">x<\/span>/,
    'ohne `labelFor` kein <label>: eine Gruppe (Segment, Chips) wird ueber aria-labelledby benannt');

  const sw = settingSwitchRowHtml({ label: 'Push', checked: true, description: 'Nur hier', descriptionId: 'p-hint', attrs: { id: 'p' } });
  assert.match(sw, /^<div class="settings-setting-row settings-setting-row--switch"><label class="toggle-row toggle-row--switch">/);
  assert.match(sw, /<input type="checkbox" role="switch" id="p" aria-describedby="p-hint" checked>/, 'der Hinweis ist dem Schalter zugeordnet');
  assert.match(sw, /<\/label><p class="settings-setting-row__description" id="p-hint">Nur hier<\/p><\/div>$/,
    'der Hinweis steht NACH dem Label - im Label laese ein Screenreader ihn als Teil des Namens');

  // Zweispaltig in jeder Breite, mindestens ein Fingerziel hoch.
  const css = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)];
  const base = rules.find((r) => r.selector.trim() === '.settings-group > .settings-setting-row' && !r.at.length);
  assert.match(base?.body ?? '', /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(base?.body ?? '', /min-height:\s*var\(--target-lg\)/, 'die Zeile ist mobil ein Fingerziel hoch');
  const narrowed = rules.filter((r) => r.at.length && /\.settings-group\b[^,{]*\.settings-setting-row\b/.test(r.selector)
    && /grid-template-columns/.test(r.body));
  assert.deepEqual(narrowed.map((r) => r.selector), [],
    'keine Breitenabfrage stapelt die Zeile wieder: gestapelt war ein Auswahlfeld mit "5 Minuten" mobil vollbreit');
  const control = rules.find((r) => r.selector.trim() === '.settings-group .settings-setting-row__control' && !r.at.length);
  assert.match(control?.body ?? '', /max-inline-size:\s*50cqi/, 'das Bedienelement nimmt hoechstens die halbe Zeile, das Label bricht um');
});

// --------------------------------------------------------
// R18 (2026-10-07): die Formularzeile - EIN Baustein fuer Einstellungen und
// Erfassungsdialoge (utils/form-row.js, layout.css "Formularzeile")
// --------------------------------------------------------
test('R18: formRowHtml baut Etikett links / Wert rechts mit verknuepftem Etikett, die Einstellungszeile baut darauf', async () => {
  const { formRowHtml, formRowsHtml } = await import('../public/utils/form-row.js');
  const row = formRowHtml({
    label: 'Art <b>', labelFor: 'kind', description: 'Nur & hier', descriptionId: 'kind-hint',
    control: '<select class="form-input" id="kind"></select>', field: true,
  });
  assert.match(row, /^<div class="form-row form-field"><div class="form-row__copy"><label class="form-row__label" for="kind">Art &lt;b&gt;<\/label>/,
    'das Etikett ist ein <label for> - und die Zeile die Fehlergruppe ihres Feldes');
  assert.match(row, /<p class="form-row__description" id="kind-hint">Nur &amp; hier<\/p><\/div><div class="form-row__control"><select class="form-input" id="kind"><\/select><\/div><\/div>$/);
  assert.match(formRowHtml({ label: 'x', labelId: 'l', stacked: true, wide: true }),
    /^<div class="form-row form-row--stacked form-row--wide"><div class="form-row__copy"><span class="form-row__label" id="l">x<\/span>/,
    'ohne labelFor ein benennbares <span> fuer aria-labelledby');
  assert.equal(formRowsHtml(['<i>a</i>', '', null, '<i>b</i>'], { attrs: { id: 'g' } }), '<div class="form-rows" id="g"><i>a</i><i>b</i></div>');
  // Die Einstellungszeile ist dieselbe Funktion mit einer Variante - nicht ein zweiter Bau.
  const components = await readFile(new URL('../public/settings/components.js', import.meta.url), 'utf8');
  const fn = components.slice(components.indexOf('export function settingRowHtml('), components.indexOf('export function settingSwitchRowHtml('));
  assert.match(fn, /return formRowHtml\(\{[\s\S]*variant: 'settings-setting-row'/, 'settingRowHtml delegiert an formRowHtml');
  assert.doesNotMatch(fn, /<div class=/, 'settingRowHtml baut kein eigenes Markup mehr');
  const dom = components.slice(components.indexOf('export function createSettingRow('), components.indexOf('export function createStatusSummary('));
  for (const cls of ['settings-setting-row form-row', 'settings-setting-row__copy form-row__copy', 'settings-setting-row__label form-row__label',
    'settings-setting-row__description form-row__description', 'settings-setting-row__control form-row__control']) {
    assert.ok(dom.includes(`'${cls}'`), `createSettingRow traegt "${cls}"`);
  }
});

test('R18: ein zusammengesetztes Feld ist eine benannte Gruppe, jedes Teilfeld hat einen eigenen Namen', async () => {
  const { formCompositeHtml } = await import('../public/utils/form-row.js');
  const pair = formCompositeHtml({
    labelledBy: 'bp-label',
    unit: 'mmHg',
    parts: [
      { id: 'sys', label: 'Systolisch', value: 120, placeholder: 120, attrs: { type: 'number', required: true } },
      { separator: '/' },
      { id: 'dia', label: 'Dia "stolisch"', attrs: { type: 'number' } },
    ],
  });
  assert.match(pair, /^<span class="form-composite" role="group" aria-labelledby="bp-label">/);
  assert.match(pair, /<input class="form-input form-composite__part" type="number" required id="sys" aria-label="Systolisch" placeholder="120" value="120">/);
  assert.match(pair, /<span class="form-composite__sep" aria-hidden="true">\/<\/span>/, 'der Trenner ist Dekor');
  assert.match(pair, /<input class="form-input form-composite__part" type="number" id="dia" aria-label="Dia &quot;stolisch&quot;" aria-describedby="dia-unit">/,
    'die Einheit beschreibt das letzte Teilfeld');
  assert.match(pair, /<span class="form-composite__unit" id="dia-unit">mmHg<\/span><\/span>$/);
  // Ein Wort als Suffix IST das Etikett seines Teilfelds; ein einzelnes Feld ohne Gruppe bleibt ohne Rolle.
  const dur = formCompositeHtml({ labelledBy: 'd', parts: [{ id: 'h', label: 'Stunden', suffix: 'Stunden', suffixIsLabel: true }] });
  assert.match(dur, /<input class="form-input form-composite__part" type="text" id="h"><label class="form-composite__unit" for="h">Stunden<\/label>/);
  const single = formCompositeHtml({ parts: [{ id: 'p', suffix: '/min' }] });
  assert.match(single, /^<span class="form-composite"><input class="form-input form-composite__part" type="text" id="p" aria-describedby="p-suffix"><span class="form-composite__unit" id="p-suffix">\/min<\/span><\/span>$/);
});

test('R18: die Formularzeile steht im globalen Blatt - randlose Auswahl mit Zeichen, Etikett bricht, Wert bleibt, schmal stapelt sie', async () => {
  const layout = await readFile(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(layout)];
  const parts = (r) => r.selector.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
  const one = (sel, at = null) => rules.find((r) => parts(r).includes(sel) && (at ? r.at.some((a) => at.test(a)) : !r.at.length));
  const rows = one('.form-rows');
  assert.match(rows?.body ?? '', /container:\s*form-rows \/ inline-size/, 'die Zeile misst ihren Traeger');
  assert.match(one('.form-rows > * + *')?.body ?? '', /border-top:\s*var\(--space-px\) solid var\(--color-border-subtle\)/, 'Haarlinie zwischen den Zeilen');
  assert.doesNotMatch(rows.body, /background|border-radius|box-shadow/, 'im Dialog kein Kasten im Kasten: der Traeger hat keine eigene Flaeche');
  const row = one('.form-rows > .form-row');
  assert.match(row?.body ?? '', /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(row.body, /min-height:\s*var\(--target-lg\)/);
  const label = one('.form-rows .form-row__label');
  assert.match(label?.body ?? '', /overflow-wrap:\s*anywhere/);
  assert.match(label.body, /hyphens:\s*auto/, 'das Etikett bricht an der Silbe');
  const control = one('.form-rows > .form-row > .form-row__control');
  assert.match(control?.body ?? '', /white-space:\s*nowrap/, 'der Wert bleibt einzeilig');
  assert.match(control.body, /max-inline-size:\s*62cqi/);
  // Stapeln per Container Query: alle unter 20rem, breite Bedienelemente unter 26rem.
  assert.match(one('.form-rows > .form-row:not(.form-row--stacked)', /@container form-rows \(max-width: 20rem\)/)?.body ?? '', /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(one('.form-rows > .form-row--wide:not(.form-row--stacked)', /@container form-rows \(max-width: 26rem\)/)?.body ?? '', /grid-template-columns:\s*minmax\(0, 1fr\)/);
  // Die randlose Auswahl: EINE Regel fuer Dialog und Einstellungen.
  const select = one('.form-row__control > select.form-input');
  assert.ok(select, 'die Regel haengt an .form-row__control, nicht an einem Traeger');
  assert.match(select.body, /border-color:\s*transparent/);
  assert.match(select.body, /background-color:\s*transparent/);
  assert.match(select.body, /color:\s*var\(--color-text-secondary\)/, 'der Wert in Sekundaerfarbe');
  assert.doesNotMatch(select.body, /background-image:\s*none|appearance/, 'das Zeichen des Feldkanons bleibt - es traegt die 3:1 als Erkennungsmerkmal');
  assert.match(one('.form-row__control > select.form-input:focus')?.body ?? '', /border-color:\s*var\(--color-accent\)/, 'der Fokus zeichnet die Akzentkante');
  assert.match(one('.form-row__control > select.form-input:not([multiple]):not([size])')?.body ?? '', /background-position:\s*right 0 center/);
  assert.match(one('[dir="rtl"] .form-row__control > select.form-input:not([multiple]):not([size])')?.body ?? '', /background-position:\s*left 0 center/);
  assert.match(one('.form-row__control > select.form-input', /hover: none/)?.body ?? '', /min-height:\s*var\(--target-lg\)/,
    'am Finger 48px - in Dialog UND Einstellungen');
  // Das Zeichen haelt 3:1 auf den Flaechen, auf denen eine Zeile steht.
  const tokens = await readFile(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');
  const strokes = [...tokens.matchAll(/--_field-chevron:[^;]*stroke='%23([0-9A-Fa-f]{6})'/g)].map((m) => `#${m[1]}`);
  assert.deepEqual([...new Set(strokes)], ['#63615B', '#B4AEA5']);
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const [chevron, grounds] of [['#63615B', ['#FFFFFF', '#FBFAF7', '#F5F3ED']], ['#B4AEA5', ['#2B2825', '#37332E', '#191816']]]) {
    for (const ground of grounds) assert.ok(ratio(chevron, ground) >= 3, `${chevron} auf ${ground}: ${ratio(chevron, ground).toFixed(2)}:1`);
  }
  // Und in den Einstellungen gibt es keine zweite Auswahl-Regel mehr daneben.
  const settings = await readFile(new URL('../public/styles/settings.css', import.meta.url), 'utf8');
  assert.equal([...eachRule(settings)].filter((r) => /settings-setting-row__control > select/.test(r.selector)).length, 0,
    'die Auswahl der Einstellungszeile kommt aus der Formularzeile (layout.css)');
});

test('R17: keine Abschnittsueberschrift steht in einem Blatt zweimal ("Termine", "Zyklus")', async () => {
  const { SETTINGS_SECTIONS } = await import('../public/settings/registry.js');
  const rendered = await probeSheets();
  const bySheet = new Map();
  for (const section of SETTINGS_SECTIONS) {
    const titles = [...(rendered.get(section.id) ?? '').matchAll(/class="settings-section__title"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    bySheet.set(section.sheetId, [...(bySheet.get(section.sheetId) ?? []), ...titles]);
  }
  const doubled = [];
  let seen = 0;
  for (const [sheetId, titles] of bySheet) {
    seen += titles.length;
    for (const title of new Set(titles)) {
      if (titles.filter((entry) => entry === title).length > 1) doubled.push(`${sheetId}: "${title}"`);
    }
  }
  assert.ok(seen >= 20, `nur ${seen} Abschnittsueberschriften gesehen`);
  assert.deepEqual(doubled, [], 'zwei gleiche Ueberschriften auf einer Ebene: die Sprungmarke und der Screenreader koennen sie nicht unterscheiden');
});

test('R17: die Sprungmarken heissen wie die Ueberschriften der Abschnitte, nicht wie die Registry', async () => {
  const shell = await readFile(new URL('../public/settings/shell.js', import.meta.url), 'utf8');
  const fn = shell.slice(shell.indexOf('function syncJumpLabels('), shell.indexOf('async function renderSheetSection('));
  assert.match(fn, /host\?\.querySelector\('\.settings-section__title, \.settings-navigation-panel__title'\)/,
    'gelesen wird die erste sichtbare Abschnittsueberschrift im Traeger');
  assert.match(fn, /link\.textContent = text/);
  assert.match(shell, /link\.dataset\.jumpSection = target\.id/, 'die Marke weiss, zu welchem Traeger sie gehoert');
  const section = shell.slice(shell.indexOf('async function renderSheetSection('), shell.indexOf('async function renderLeafContent('));
  assert.match(section, /await module\.render\(host, \{ user, query \}\);[\s\S]*?syncJumpLabels\(host\.closest\?\.\('\.settings-leaf'\)\)/,
    'jeder fertige Abschnitt zieht seine Marke nach, auch nach der Wartefrist');
  const leaf = shell.slice(shell.indexOf('async function renderLeafContent('), shell.indexOf('function levelScopedHeadings('));
  assert.match(leaf, /await awaitSections\([\s\S]*?\);[\s\S]*?jump\?\.classList\.remove\('settings-sheet-jump--pending'\)/,
    'nach der Frist stehen die Marken in jedem Fall');
});

test('R17: die Standard-Erinnerungen sind Chips des Kanons mit aria-pressed, keine Checkbox in einer Pille', async () => {
  const rendered = await probeSheets();
  const html = rendered.get('personal-calendar') ?? '';
  const chips = [...html.matchAll(/<button type="button" class="filter-chip js-default-reminder[^"]*"\s+data-value="(\d+)" aria-pressed="(true|false)">/g)];
  assert.ok(chips.length >= 5, `nur ${chips.length} Erinnerungs-Chips im gerenderten Abschnitt`);
  assert.doesNotMatch(html, /reminder-preset/);
  assert.equal([...html.matchAll(/<input\b[^>]*type="checkbox"/g)].length, 1, 'die einzige Checkbox ist der Schalter "mir zuweisen"');
  const src = await readFile(new URL('../public/settings/pages/personal-calendar.js', import.meta.url), 'utf8');
  assert.match(src, /chip\.setAttribute\('aria-pressed', String\(on\)\);\s*chip\.classList\.toggle\('filter-chip--active', on\)/,
    'Zustand und Aktiv-Form wechseln zusammen');
  assert.match(src, /querySelectorAll\('\.js-default-reminder\[aria-pressed="true"\]'\)/, 'gelesen wird der Zustand, den der Chip ansagt');
});
