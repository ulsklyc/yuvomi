/**
 * Frontend audit regression tests.
 * Guards the accessibility and hard-constraint fixes from the UX audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SETTINGS_DOMAINS, SETTINGS_LEAVES } from '../public/settings/registry.js';
import { eachRule } from './css-rules.js';
import { withoutHtmlComments, withoutBlockComments, withoutCommentsKeepingLines } from './source-text.js';

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

/**
 * Die beiden Dark-Bloecke von tokens.css - ueber `eachRule()`, nicht ueber ein
 * eigenes Muster.
 *
 * Zehn Guards suchten sie mit `/\n\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/`,
 * also ueber die SPALTE der Klammern: Selektor auf Spalte 0, schliessende
 * Klammer auf Spalte 0. Das haelt genau so lange, wie niemand die Einrueckung
 * anfasst - und am 2026-08-09 wanderten beide Bloecke unter `@media screen`
 * (Papier druckt keine Bildschirmfarben, Begruendung in tokens.css). Zehn
 * Zusicherungen ueber Dark-Kontraste wurden in derselben Sekunde rot, ohne dass
 * sich ein einziger Farbwert geaendert haette.
 *
 * Das Muster war zehnmal kopiert - zehn Gelegenheiten fuer denselben Fehler,
 * genau die Falle, die `test/css-rules.js` fuer CSS schon einmal geloest hat.
 * Der Scanner kennt die At-Kette einer Regel und findet die Bloecke deshalb
 * unabhaengig davon, wie tief sie liegen und wie sie eingerueckt sind.
 *
 * Beide geben den Rumpf als String zurueck, in der Form
 * `{ 1: body }` - das ist die Signatur eines `String.match()`, damit die
 * Aufrufer unveraendert `block[1]` lesen koennen.
 */
function darkSchemeBlock(tokensCss) {
  for (const rule of eachRule(tokensCss)) {
    const chain = rule.at.join(' ');
    if (/prefers-color-scheme:\s*dark/.test(chain) && /:root/.test(rule.selector)) {
      return { 1: rule.body };
    }
  }
  return null;
}

function darkAttrBlock(tokensCss) {
  for (const rule of eachRule(tokensCss)) {
    if (/^\[data-theme="dark"\]$/.test(rule.selector.trim())) return { 1: rule.body };
  }
  return null;
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

// Schneidet das Objektliteral heraus, in dem eine Fundstelle steht - rueckwaerts
// bis zur oeffnenden Klammer der eigenen Ebene, dann vorwaerts bis zu ihrem
// Partner. Dieselbe Klammerzaehlung wie in settledCalls; ein Regex kann eine
// Richtung mit verschachteltem Rumpf nicht abgrenzen.
function enclosingObject(source, at) {
  let start = at;
  let depth = 0;
  while (start >= 0) {
    const char = source[start];
    if (char === '}') depth += 1;
    else if (char === '{') { if (depth === 0) break; depth -= 1; }
    start -= 1;
  }
  if (start < 0) return null;

  let end = start;
  depth = 0;
  while (end < source.length) {
    const char = source[end];
    if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth === 0) break; }
    end += 1;
  }
  return source.slice(start, end + 1);
}

// Rumpf einer im Modul definierten Funktion, damit ein Guard der Kante von einem
// Aufruf zu seiner Definition folgen kann statt nur den Aufrufer zu lesen.
function functionBody(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=`).exec(source);
  if (!match) return null;
  const open = source.indexOf('{', match.index + match[0].length);
  if (open === -1) return null;

  let depth = 0;
  let end = open;
  while (end < source.length) {
    const char = source[end];
    if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth === 0) break; }
    end += 1;
  }
  return source.slice(open, end + 1);
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

// Der EINE Regelscanner liegt seit 2026-08-08 in test/css-rules.js - er wird
// inzwischen von zwei Suiten gebraucht, und eine Kopie waere die fuenfte
// Gelegenheit gewesen, dieselbe Falle wieder einzubauen. Seine Geschichte
// (drei bezahlte Blindstellen) steht dort im Kopfkommentar.

function cssRuleBody(css, selector) {
  const match = css.match(new RegExp(`${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] ?? '';
}

function assertRuleUsesToken(css, selector, property, token, file) {
  const body = cssRuleBody(css, selector);
  assert.match(body, new RegExp(`${property}:\\s*var\\(${token}\\)`), `${file} ${selector} ${property} should use ${token}`);
}

// `innerHTML` ist eine der harten Invarianten, und der Guard dafuer war eine
// Liste von sieben Dateien: jede NEUE Seite kam ungeprueft durch, und genau die
// neue ist die, in der es passiert. Der Bestand haelt die Regel ohnehin schon
// ueberall - die Liste war also nie eine Ausnahmegenehmigung, nur ein zu enger
// Suchbereich. Vendor-Code ist ausgenommen: der wird von Hand kopiert und nicht
// nach unseren Regeln geschrieben.
const VENDOR_PREFIX = '../public/vendor/';

test('kein innerHTML-Schreibzugriff irgendwo unter public/ (ausser vendor/)', () => {
  const files = walkJsFiles('../public/').filter((f) => !f.startsWith(VENDOR_PREFIX));
  const offenders = files.filter((file) => /\.innerHTML\s*=[^=]/.test(read(file)));
  assert.deepEqual(offenders, [],
    'anhaengen mit insertAdjacentHTML oder ueber die DOM-API, User-Daten durch esc()');

  // Ohne diese Schranke waere der Guard auch dann gruen, wenn walkJsFiles nach
  // einem Umbau eine leere Liste liefert - gruen ueber nichts.
  assert.ok(files.length >= 100, `nur ${files.length} Frontend-Dateien gefunden - der Scan greift nicht mehr`);
});

test('der innerHTML-Guard erkennt das Muster, das er verbietet', () => {
  const pattern = /\.innerHTML\s*=[^=]/;
  assert.ok(pattern.test('root.innerHTML = `<div>`;'), 'Zuweisung wird nicht erkannt');
  assert.ok(pattern.test('el.innerHTML=""'), 'Zuweisung ohne Leerzeichen wird nicht erkannt');
  assert.ok(!pattern.test('if (el.innerHTML === x)'), 'ein Vergleich wird faelschlich beanstandet');
});

/**
 * Ein Backtick in einem HTML-Kommentar sprengt das Template-Literal, in dem er
 * steht.
 *
 * GEMESSENER ANLASS (2026-08-11): ein erklaerender Kommentar im Markup der
 * Einkaufsseite nannte eine CSS-Klasse in Backticks - so, wie es in JS-Kommentaren
 * ueberall im Repo ueblich ist. Nur stand dieser INNERHALB von
 * insertAdjacentHTML(`...`): das erste Backtick schloss das Literal, der Rest
 * wurde ein Tagged Template, und die Seite starb mit "TypeError: toolbar is not
 * a function". Sie renderte gar nichts mehr.
 *
 * WARUM ALS GUARD: die volle Suite war dabei gruen - 145 Suiten, kein einziger
 * Fehlschlag. Kein Test laedt eine Seite wirklich, und ein Tagged Template ist
 * syntaktisch voellig legal, also faellt auch kein Parser darueber. Der Defekt
 * war nur im Browser sichtbar. Die Falle trifft jeden, der einen Kommentar ins
 * Markup schreibt, und kostet jedes Mal eine ganze Seite.
 */
test('kein HTML-Kommentar im Markup enthält ein Backtick', () => {
  const offenders = [];
  let scanned = 0;

  for (const file of walkJsFiles('../public/')) {
    if (file.includes('/vendor/')) continue;
    const source = read(file);
    const comments = [...source.matchAll(/<!--[\s\S]*?-->/g)];
    if (!comments.length) continue;
    scanned += comments.length;
    for (const [comment] of comments) {
      if (!comment.includes('`')) continue;
      offenders.push(`${file}: ${comment.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }

  assert.ok(
    scanned >= 10,
    `Nur ${scanned} HTML-Kommentare gefunden - der Scan ist blind geworden. `
    + 'Werden Seiten noch über Template-Literale gerendert?',
  );
  assert.deepEqual(
    offenders,
    [],
    'Ein Backtick in einem HTML-Kommentar schließt das umgebende Template-Literal '
    + 'und macht aus dem Rest ein Tagged Template - die Seite rendert dann gar nicht '
    + 'mehr. Klassennamen dort ohne Backticks schreiben.',
  );
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

test('service worker release caches track package and deployment revisions and include the early locale bootstrap', () => {
  const pkg = JSON.parse(read('../package.json'));
  const sw = read('../public/sw.js');
  const release = sw.match(/const APP_RELEASE\s*=\s*['"]([^'"]+)['"]/)?.[1];

  assert.equal(release, pkg.version, 'Service worker APP_RELEASE must match package.json');
  assert.match(sw, /const APP_BUILD_REVISION\s*=\s*['"]__YUVOMI_BUILD_REVISION__['"]/);
  assert.match(sw, /const CACHE_RELEASE\s*=\s*`\$\{APP_RELEASE\}-\$\{APP_BUILD_REVISION\}`/);
  for (const cache of ['shell', 'pages', 'locales', 'assets', 'api']) {
    assert.match(sw, new RegExp(`yuvomi-${cache}-\\$\\{CACHE_RELEASE\\}`));
  }
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

/**
 * Die geteilte Leiste trägt ZWEI Semantiken, und der Aufrufer muss sagen welche.
 *
 * Gemessener Anlass: sie schrieb unbesehen `role="tab"` samt `aria-controls` auf
 * eine Panel-ID, die nur `syncTabPanels` vergeben hätte - und die suchte
 * `[data-panel]`, ein Attribut, das der Guard weiter unten in dieser Datei
 * verbietet. Zehn Tabs zeigten damit auf nichts (Audit 2026-08-08, P1-1). Vier
 * davon waren gar keine Tabs, sondern Modulwechsel.
 *
 * Der Guard prüft die Bauform, nicht die Aufrufer: ein Default für `semantics`
 * wäre der Weg, auf dem sich die falsche Variante wieder still verbreitet.
 */
test('die geteilte Sub-Tab-Leiste verlangt eine erklärte Semantik und verspricht kein Panel ohne Panel', () => {
  const source = read('../public/utils/sub-tabs.js');

  assert.match(source, /semantics !== 'nav' && semantics !== 'tabs'/,
    'renderSubTabs muss eine unbekannte Semantik ablehnen');
  assert.doesNotMatch(source, /semantics\s*=\s*['"]/,
    'semantics darf keinen Default haben - ein Default verbreitet die falsche Variante still');
  assert.match(source, /semantics === 'tabs' && typeof panelFor !== 'function'/,
    "eine Tablist ohne Panels ist eine Navigation - 'tabs' muss panelFor verlangen");

  // Navigation: echte Links mit aria-current, kein Tab-Vokabular.
  assert.match(source, /createElement\(isNav \? 'a' : 'button'\)/,
    'Zielorte sind Links, Sichten sind Buttons');
  assert.match(source, /setAttribute\('aria-current', 'page'\)/,
    'der aktive Zielort braucht aria-current="page"');

  // Tablist: aria-controls entsteht NUR mit aufgelöstem Panel.
  assert.match(source, /const panel = panelFor\(btn\.dataset\.tabId\);/,
    'die Panels kommen vom Aufrufer, nicht aus einer Attributsuche im Baum');
  assert.match(source, /if \(!panel\) \{\s*\n\s*btn\.removeAttribute\('aria-controls'\);/,
    'ohne Panel muss aria-controls WEG statt ins Leere zu zeigen');
  assert.match(source, /btn\.setAttribute\('aria-controls', panel\.id\)/,
    'aria-controls muss auf die ID des gefundenen Panels zeigen');
  assert.match(source, /panel\.setAttribute\('aria-labelledby', btn\.id\)/);
  // Auf die SUCHE prüfen, nicht auf die Zeichenfolge: der Kopf der Datei nennt
  // `[data-panel]` als abgelöstes Muster, und das soll er auch dürfen.
  assert.doesNotMatch(source, /querySelectorAll\(\s*'\[data-panel\]'\s*\)/,
    'die Suche nach dem gesperrten data-panel darf nicht zurückkommen');
});

/**
 * `will-change` ist ein Hinweis auf eine BEVORSTEHENDE Aenderung, keine
 * Grundausstattung: jedes Element damit haelt eine eigene Compositor-Ebene
 * samt Speicher, dauerhaft.
 *
 * Gemessener Anlass: die Regel stand fest auf `.swipe-row .shopping-item` und
 * `.swipe-row .task-card`. Im Demo-Seed trugen sie 26 Einkaufszeilen und 11
 * Aufgabenkarten gleichzeitig, im Ruhezustand - 54 Ebenen und ~15,2 MB auf
 * /tasks (Audit 2026-08-08, P2-1).
 *
 * HIER STEHT NUR DIE BAUFORM. Die eigentliche Groesse - waechst die Zahl der
 * Ebenen mit der Zeilenzahl? - kann ein Stylesheet-Scanner nicht sehen:
 * `.nav-sidebar__indicator` und `.lg-blob--1` tragen dasselbe `will-change`
 * und sind einmalig, `.task-card` ist es nicht, und dem Selektor sieht man das
 * nicht an. Diese Frage misst Sonde 9 der Dokument-Guards am gerenderten
 * Dokument, ueber die Wiederholung der Klassensignatur.
 */

/**
 * Eine endlose Animation und ein `filter` gehoeren nicht auf DENSELBEN Kasten.
 *
 * Ein Filter wird fuer seinen Inhalt gerastert. Bewegt sich dieser Inhalt, faellt
 * die Rasterung in jedem Frame an - und eine endlose Animation laeuft, solange
 * die Seite offen ist, auch wenn niemand sie bedient. Gemessener Anlass:
 * `.lg-blob` trug `filter: blur(90px)` neben `animation: lg-drift ... infinite`
 * ueber vier Flaechen von 30-46vw; im Leerlauf fielen 60 auf ~20 fps, ein Melder
 * sah 100 % GPU (Issue #716). Die Reparatur trennt beides auf zwei Knoten.
 *
 * DIESER GUARD SIEHT NUR DEN FALL, IN DEM BEIDES IN EINER REGEL STEHT - und das
 * ist genau der Bestandsfall, aber nicht die ganze Regel: Filter und Animation
 * koennen ueber zwei Regeln zusammenkommen (`.lg-blob` und `.lg-blob--2`), und
 * welche Werte am Ende auf einem Kasten liegen, weiss nur das gerenderte
 * Dokument. Die vollstaendige Fassung ist Sonde 16 der Dokument-Guards; sie ist
 * genauer und laeuft nicht in dieser Kette mit. Was hier steht, ist die
 * schnelle Rueckmeldung, nicht der Nachweis.
 */
test('kein endlos animiertes Element traegt in derselben Regel einen filter', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];
  let seenEndless = 0;

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!/\banimation(-iteration-count)?\s*:[^;]*\binfinite\b/.test(body)) continue;
      seenEndless += 1;
      // `backdrop-filter` filtert, was HINTER dem Kasten liegt, nicht seinen
      // Inhalt - es haengt nicht an der Bewegung dieses Elements. Gemessen
      // (Issue #716): Glasflaechen abzuschalten brachte 20 → 24 fps, der
      // Blur auf dem bewegten Element allein 20 → 60.
      const own = body.replace(/-webkit-backdrop-filter\s*:[^;]*;?/g, '')
        .replace(/\bbackdrop-filter\s*:[^;]*;?/g, '');
      const m = own.match(/(?:^|[;{\s])filter\s*:\s*([^;]+)/);
      if (!m || m[1].trim() === 'none') continue;
      offenders.push(`${file}${at.length ? ` [${at.join(' ')}]` : ''}: ${selector} -> filter: ${m[1].trim()}`);
    }
  }

  // Ohne diese Zusicherung waere der Guard gruen, sobald der Scanner das
  // Verzeichnis nicht mehr faende - eine leere Liste ist keine Zusicherung.
  assert.ok(seenEndless >= 5,
    `Nur ${seenEndless} endlose Animationen gefunden - der Scanner findet public/styles/ `
    + 'nicht mehr, statt nichts zu beanstanden.');

  assert.deepEqual(offenders.sort(), [],
    'Bewegung und Filter liegen auf demselben Element: der Browser rastert den Filter '
    + 'damit pro Frame neu, im Leerlauf und solange die Seite offen ist (Issue #716). '
    + 'Beides gehoert auf zwei Knoten - die aeussere Huelle bewegt sich, das Kind traegt '
    + `den Filter und steht still (Vorbild: .lg-blob / .lg-blob__ink in glass.css).\n${offenders.join('\n')}`);
});

/**
 * Eine Bewegung nennt ihre Kurve aus einem Token.
 *
 * DIE REGEL, NICHT DIE LISTE: geprueft wird die BAUART - eine `cubic-bezier(`-
 * Klammer in einem Stylesheet ausserhalb von tokens.css. Eine Allowlist der
 * bekannten Suender waere hier der falsche Bau gewesen: sie sagt zu jeder
 * NEUEN Datei ja, und genau so sind die drei Treffer entstanden, die diesen
 * Guard ausgeloest haben (Critique 2026-08-28).
 *
 * DER ANLASS: `rewards.css:250` fuehrte `cubic-bezier(0.22, 1, 0.36, 1)` - eine
 * VIERTE Kurve, die tokens.css nicht kennt und die niemand entschieden hat.
 * `layout.css:4909` und `settings.css:2985` schrieben dagegen `--ease-glass`
 * bzw. `--ease-out` woertlich aus: derselbe Wert, am Token vorbei. Der
 * Unterschied ist unsichtbar, solange niemand die Kurve aendert - und genau
 * dann faellt er auf, weil zwei Elemente der Aenderung nicht folgen.
 *
 * `tokens.css` ist ausgenommen, weil dort die Kurven DEFINIERT werden. Die drei
 * Namen (`--ease-out`, `--ease-glass`, `--ease-sidebar-glide`) sind die
 * vollstaendige Liste; wer eine vierte braucht, gibt ihr dort einen Namen und
 * einen Grund, statt sie in ein Bauteil zu schreiben.
 */
test('keine Bewegungskurve steht ausserhalb von tokens.css als Literal', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];
  let seenCurveTokens = 0;

  for (const { selector, body, at } of eachRule(read('../public/styles/tokens.css'))) {
    seenCurveTokens += (body.match(/--ease-[a-z-]+\s*:/g) || []).length;
  }

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!/cubic-bezier\s*\(/.test(body)) continue;
      const m = body.match(/[^;{]*cubic-bezier\s*\([^)]*\)[^;}]*/);
      offenders.push(`${file}${at.length ? ` [${at.join(' ')}]` : ''}: ${selector} -> ${(m ? m[0] : '').trim()}`);
    }
  }

  // Eine leere Liste ist keine Zusicherung: faende der Scanner tokens.css nicht
  // mehr, waere dieser Guard gruen, waehrend er nichts mehr liest.
  assert.ok(seenCurveTokens >= 3,
    `Nur ${seenCurveTokens} --ease-*-Definitionen in tokens.css gefunden - der Scanner `
    + 'liest die Token-Datei nicht mehr, statt nichts zu beanstanden.');

  assert.deepEqual(offenders.sort(), [],
    'Eine Bewegungskurve steht als Literal in einem Bauteil statt als Token. Wer '
    + '`--ease-out` oder `--ease-glass` woertlich ausschreibt, folgt einer spaeteren '
    + 'Aenderung des Tokens nicht mehr; wer eine unbekannte Kurve schreibt, fuehrt eine '
    + 'vierte Bewegungssprache ohne Entscheidung ein. Kurven werden in tokens.css '
    + `benannt und hier nur benutzt.\n${offenders.join('\n')}`);
});



/**
 * Das Wetter-Vokabular haelt an vier Enden zusammen.
 *
 * DIE LAGEN UND BAENDER STEHEN NICHT ALS LISTE HIER, sondern werden aus
 * dashboard.js gelesen - `weatherToneKey()` erzeugt sie, also ist sie die
 * Quelle. Eine Liste im Test waere die zweite Wahrheit, und genau die ist in
 * diesem Repo schon dreimal auseinandergelaufen (Modulzahl, Waehrungen,
 * Familientoene). Kommt eine siebte Lage dazu, faellt dieser Guard von selbst
 * um, statt sie durchzulassen.
 *
 * VIER ENDEN, WEIL EIN TON AN VIER STELLEN GLEICHZEITIG STEHEN MUSS:
 *   1. der Light-Wert in `:root`,
 *   2. der Dark-Wert - in BEIDEN Dark-Bloecken. Das ist die eigentliche
 *      Drift-Gefahr: tokens.css fuehrt @media(prefers-color-scheme) UND
 *      [data-theme="dark"], und wer nur einen bedient, baut einen Fehler, den
 *      genau die Haelfte der Nutzer sieht.
 *   3. die Aufloesungsregel in dashboard.css, die `[data-weather-tone="x"]`
 *      auf das Token abbildet - ohne sie steht das Attribut im DOM und faerbt
 *      nichts,
 *   4. und fuer jede Gangart eine Animation samt reduced-motion-Ausschalter.
 *
 * Guard-Ebene: Struktur (aus der JS-Abbildung abgeleitet) + Wert.
 */
test('jede Wetterlage traegt ihren Ton in beiden Themes und loest ihn auch auf', () => {
  const page = read('../public/pages/dashboard.js');
  const tokens = read('../public/styles/tokens.css');
  const css = read('../public/styles/dashboard.css');

  const toneFn = page.match(/function weatherToneKey\([\s\S]*?\n}/);
  assert.ok(toneFn, 'weatherToneKey() nicht gefunden - die Quelle der Lagen ist weg.');
  const tones = [...new Set([...toneFn[0].matchAll(/return '([a-z]+)'/g)].map((m) => m[1]))];
  assert.ok(tones.length >= 6, `Nur ${tones.length} Wetterlagen gelesen - die Signatur greift nicht mehr.`);

  const bandsDecl = page.match(/const WEATHER_BANDS = \[([^\]]+)\]/);
  assert.ok(bandsDecl, 'WEATHER_BANDS nicht gefunden.');
  const bands = [...bandsDecl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(bands.length >= 5, `Nur ${bands.length} Temperaturbaender gelesen.`);

  const darkScheme = darkSchemeBlock(tokens);
  const darkAttr = darkAttrBlock(tokens);
  assert.ok(darkScheme && darkAttr, 'Ein Dark-Block von tokens.css ist nicht auffindbar.');

  const missing = [];
  const check = (name, attr) => {
    if (!new RegExp(`\\n\\s*--_${name}:\\s*#`).test(tokens)) missing.push(`tokens.css :root --_${name}`);
    if (!new RegExp(`--_${name}:\\s*#`).test(darkScheme[1])) missing.push(`tokens.css prefers-color-scheme --_${name}`);
    if (!new RegExp(`--_${name}:\\s*#`).test(darkAttr[1])) missing.push(`tokens.css [data-theme=dark] --_${name}`);
    if (!new RegExp(`--${name}:\\s*var\\(--_${name}\\)`).test(tokens)) missing.push(`tokens.css oeffentliches --${name}`);
    if (!css.includes(attr)) missing.push(`dashboard.css ${attr}`);
  };

  for (const tone of tones) check(`weather-${tone}`, `[data-weather-tone="${tone}"]`);
  for (const band of bands) check(`weather-band-${band}`, `[data-weather-band="${band}"]`);

  assert.deepEqual(missing, [], `Wetter-Vokabular unvollstaendig:\n${missing.join('\n')}`);
});

test('jede Bewegung des Wetter-Widgets steht unter einer Bewegungs-Bedingung', () => {
  const page = read('../public/pages/dashboard.js');
  const css = read('../public/styles/dashboard.css');

  const motionFn = page.match(/function weatherMotionAttr\([\s\S]*?\n}/);
  assert.ok(motionFn, 'weatherMotionAttr() nicht gefunden.');
  const motions = [...new Set([...motionFn[0].matchAll(/data-weather-motion="([a-z]+)"/g)].map((m) => m[1]))];
  assert.ok(motions.length >= 4, `Nur ${motions.length} Gangarten gelesen - die Signatur greift nicht mehr.`);

  // DIE SIGNATUR IST „Wetter-Selektor + animation", NICHT EINE LISTE VON
  // GANGARTEN. Ein Guard ueber die vier bekannten Namen waere beim fuenften
  // gruen geblieben - genau der Fehler, den die Umstellung auf
  // `no-preference` gerade behoben hat. Er faellt hier ueber die BAUART:
  // jede Regel, die eine Wetter-Flaeche animiert, muss unter einer
  // prefers-reduced-motion-Bedingung stehen.
  const stray = [];
  let seen = 0;
  for (const rule of eachRule(css)) {
    if (!/weather-widget|weather-forecast|wall-weather|data-weather-motion/.test(rule.selector)) continue;
    if (!/\banimation(-name|-delay|-duration)?\s*:\s*(?!none)/.test(rule.body)) continue;
    seen += 1;
    const gated = rule.at.some((at) => /prefers-reduced-motion/.test(at));
    // ZWEI BAUARTEN BRAUCHEN DIE BEDINGUNG NICHT, und beide sind das Gegenteil
    // von Umgebungsbewegung:
    //   - der Wand-Nachtmodus HAELT Bewegung an, statt sie zu starten;
    //   - der Ladekringel des Aktualisieren-Knopfs ist Rueckmeldung auf eine
    //     angestossene Aktion und laeuft nur, solange die Anfrage laeuft. Auch
    //     unter reduzierter Bewegung muss erkennbar bleiben, dass etwas
    //     passiert - Apple laesst seine Aktivitaetsanzeigen aus demselben Grund
    //     drehen. Die Zusicherung darunter belegt, dass er wirklich fluechtig
    //     ist; ohne sie waere das hier eine Ausnahme auf Zuruf.
    const transient = /--spinning/.test(rule.selector);
    if (!gated && !/data-wall-night/.test(rule.selector) && !transient) {
      stray.push(`${rule.selector} -> ${rule.body.trim().slice(0, 60)}`);
    }
  }
  assert.ok(seen >= 6, `Nur ${seen} animierte Wetter-Regeln gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(stray, [],
    'Bewegung am Wetter-Widget ohne Bewegungs-Bedingung. Sie gehoert in den\n'
    + '`@media (prefers-reduced-motion: no-preference)`-Block in dashboard.css -\n'
    + 'eine nachgeschobene `animation: none`-Gegenregel verliert gegen jeden\n'
    + `Selektor mit einem Zusatz mehr (gemessen am fallenden Regen).\n${stray.join('\n')}`);

  // Und die Gegenrichtung: der Block muss jede Gangart auch wirklich fuehren.
  const inBlock = [...eachRule(css)]
    .filter((rule) => rule.at.some((at) => /prefers-reduced-motion:\s*no-preference/.test(at)))
    .map((rule) => rule.selector).join('\n');
  const missing = motions.filter((m) => !inBlock.includes(`[data-weather-motion="${m}"]`));
  assert.deepEqual(missing, [], `Gangart ohne Animation: ${missing.join(', ')}`);
  assert.match(inBlock, /weather-widget__glyph::before/, 'der Lichthauch muss im Bewegungsblock atmen');

  // Die Ausnahme oben gilt nur, solange sie fluechtig IST: die Klasse wird um
  // die Anfrage herum gesetzt und wieder entfernt. Bliebe sie stehen, waere
  // aus der Rueckmeldung eine Dauerbewegung ohne Ausschalter geworden.
  assert.match(page, /classList\.add\('weather-widget__refresh--spinning'\)/,
    'der Ladekringel muss beim Anstossen gesetzt werden');
  assert.match(page, /classList\.remove\('weather-widget__refresh--spinning'\)/,
    'der Ladekringel muss wieder entfernt werden - sonst ist er keine Rueckmeldung, sondern Dauerbewegung');
});

/**
 * Jedes benutzte Token muss auch existieren.
 *
 * DIE GEGENRICHTUNG WAR ABGEDECKT, DIESE NICHT. Alle Token-Guards des Repos
 * pruefen „kein Literal im Stylesheet". Dass ein *benutztes* Token auch
 * *definiert* ist, prueft keiner - und ein `var(--x)` ohne Fallback auf ein
 * undefiniertes Token ist ungueltig: die ganze Deklaration faellt weg, der
 * Wert wird geerbt. Das sieht man nicht im Diff, sondern nur im Browser, und
 * auch dort nur, wenn man weiss, wie es aussehen sollte.
 *
 * Vier Faelle standen so in der App (Audit 2026-08-08); der Scanner fand einen
 * fuenften, den der Audit nicht hatte:
 *   --color-warning-text  ein Warnhinweis, der wie normaler Text aussah
 *   --color-primary       Endglied einer var()-Kette, damit die ganze Kette
 *   --text-tertiary       heisst --color-text-tertiary
 *   --space-1h/-2h        Namen, die die Skala nicht kannte
 *
 * MIT FALLBACK ZAEHLT AUCH. `var(--space-1h, 6px)` funktioniert und ist
 * trotzdem der Fehler: der Fallback verdeckt, dass die Stufe fehlt, und der
 * Wert steht dann ausserhalb der Skala statt in ihr.
 * Guard-Ebene 3 (statisch ueber public/).
 */
test('jedes benutzte Design-Token ist auch definiert', () => {
  // walkFrontendFiles kennt nur html/js - die Tokens leben aber in CSS.
  const walkCss = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walkCss(`${path}/`);
      return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
    });
  const files = [...walkFrontendFiles('../public/'), ...walkCss('../public/')];
  assert.ok(files.length > 100, `Nur ${files.length} Dateien gescannt - der Scanner findet public/ nicht mehr.`);
  assert.ok(files.some((f) => f.endsWith('tokens.css')), 'tokens.css muss im Scan liegen');

  // Kommentare raus: der Kopf von tokens.css erklaert die Konvention anhand von
  // `--_name` und `--neutral-*`, und ein Scanner, der das fuer Nutzung haelt,
  // meldet die Doku als Verstoss.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const defined = new Set();
  const setFromJs = new Set();
  const used = new Map();

  for (const file of files) {
    const src = strip(read(file));
    for (const m of src.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
    // Zur Laufzeit gesetzte Properties (--active-module-accent u.a.) sind
    // definiert, nur eben nicht im Stylesheet.
    for (const m of src.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9_-]+)/g)) setFromJs.add(m[1]);
    for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)(\$\{)?\s*(,)?/g)) {
      // `var(--chart-series-${i})` ist ein zusammengesetzter Name; welches
      // Glied dabei herauskommt, weiss erst die Laufzeit.
      if (m[2]) continue;
      const entry = used.get(m[1]) ?? { withFallback: false, bare: false, files: new Set() };
      if (m[3]) entry.withFallback = true; else entry.bare = true;
      entry.files.add(file.replace('../public/', ''));
      used.set(m[1], entry);
    }
  }

  assert.ok(defined.size > 300, `Nur ${defined.size} Tokens gefunden - der Scanner liest tokens.css nicht mehr.`);
  assert.ok(used.size > 300, `Nur ${used.size} Token-Nutzungen gefunden - der Scanner misst nichts.`);

  const offenders = [...used]
    .filter(([name]) => !defined.has(name) && !setFromJs.has(name))
    .map(([name, entry]) => `${name} (${entry.bare ? 'ohne Fallback' : 'mit Fallback'}) in ${[...entry.files].join(', ')}`);

  assert.deepEqual(offenders, [],
    'Benutzte Tokens ohne Definition:\n  ' + offenders.join('\n  ')
    + '\nOhne Fallback faellt die ganze Deklaration weg. Mit Fallback funktioniert sie und der Wert '
    + 'steht trotzdem ausserhalb der Skala - dann fehlt die Stufe, nicht der Fallback.');
});

/**
 * Wer einen Shadow Root aufmacht, bringt den Motion-Schutz selbst mit.
 *
 * Der globale `*, *::before, *::after`-Block in reset.css endet an der
 * Schattengrenze - ein Selektor steigt nicht in einen Shadow Tree hinab.
 * Gemessen: unter emuliertem `prefers-reduced-motion: reduce` lieferte
 * dieselbe Deklaration im Light DOM 0s und im Shadow Tree 0.35s (Audit
 * 2026-08-08, P2-2). Betroffen war der PWA-Installationsbanner, also die erste
 * Begegnung mit der App auf dem Telefon.
 *
 * Der Guard prueft eine REGEL ueber alle Komponenten, keine Datei: heute gibt
 * es genau einen Shadow-DOM-Bewohner, und die naechste Komponente mit
 * `attachShadow` faende die Zusage sonst wieder offen.
 */
test('jede Shadow-DOM-Komponente bringt ihren eigenen reduced-motion-Block mit', () => {
  const offenders = [];

  for (const file of walkFrontendFiles('../public/components/')) {
    const source = read(file);
    if (!/attachShadow\(/.test(source)) continue;
    // Nur Bewegung zaehlt: eine Komponente ohne Transition/Animation braucht
    // keinen Schutz und soll auch keinen leeren Block tragen muessen.
    if (!/transition:\s*(?!none)|animation:\s*(?!none)/.test(source)) continue;

    if (!/@media \(prefers-reduced-motion: reduce\)/.test(source)) {
      offenders.push(file.replace('../public/', ''));
    }
  }

  assert.deepEqual(offenders, [],
    'Shadow-DOM-Komponenten mit Bewegung, aber ohne eigenen reduced-motion-Block:\n  '
    + offenders.join('\n  ')
    + '\nDer globale Block in reset.css erreicht keinen Shadow Tree. PRODUCT.md sagt zu, dass jede '
    + 'Animation prefers-reduced-motion respektiert - diese Zusage muss die Komponente selbst halten.');
});

test('das Install-Banner faellt nicht in die abgeloeste Welt zurueck', () => {
  const source = read('../public/components/yuvomi-install-prompt.js');

  // Acht Token-Fallbacks stammten aus der Vor-Redesign-Palette (#5b2fd4 Violett,
  // #e8e7e2 warmes Beige, ...). Alle acht Token existieren heute, die Fallbacks
  // waren also tot - und haetten die Komponente beim Wegfall eines Tokens in die
  // abgeloeste Welt zurueckgefaerbt (Audit 2026-08-08, P3-2). Ein var() ohne
  // Fallback ist hier das ehrlichere Verhalten: der Token-Existenz-Guard
  // oben deckt den Wegfall ab, ein Fallback wuerde ihn nur verstecken.
  assert.doesNotMatch(source, /var\(\s*--[a-zA-Z0-9_-]+\s*,/,
    'Token-Fallbacks in der Komponente - der Token-Existenz-Guard deckt den Wegfall ab, '
    + 'ein Fallback konserviert nur eine alte Palette.');

  // Der Rueckweg darf nicht an einem Ereignis haengen, das ohne Transition
  // ausbleibt - sonst bleibt das Host-Element samt Listenern im Dokument.
  assert.match(source, /setTimeout\(finish/,
    '_remove() braucht eine Frist als zweiten Weg hinaus (transitionend feuert ohne Transition nie)');
});

/**
 * DER NACHLAUF HAENGT AM ZUSTAND, NICHT AN DER ANWESENHEIT.
 *
 * `:root:has(yuvomi-install-prompt)` war immer wahr: das Element steht statisch
 * in index.html, rendert 0x0 solange keine Anzeigebedingung erfuellt ist, und
 * auf iOS feuert `beforeinstallprompt` nie. Der 89px-Fallback sprang damit
 * dauerhaft an - JEDER Scrollport der App reservierte 105px fuer ein Banner,
 * das keiner je gesehen hat (gemessen: 21,2% der Kalender-Rasterhoehe bei
 * 390px, 23,9% bei 320px, dieselben 105px in den Notizen).
 *
 * Zwei Enden, zwei Zusicherungen: das CSS muss den Zustand ABFRAGEN, und das
 * Bauteil muss ihn SETZEN. Nur eines von beiden zu pruefen laesst die Regel
 * still zerfallen, sobald die andere Seite umgebaut wird.
 */
test('der Install-Nachlauf haengt am gerenderten Banner, nicht an seiner Existenz', () => {
  const layout = read('../public/styles/layout.css');
  const source = read('../public/components/yuvomi-install-prompt.js');

  const setzer = layout.match(/:root:has\(yuvomi-install-prompt([^)]*)\)\s*\{[^}]*--install-prompt-tail/);
  assert.ok(setzer, 'die Regel, die --install-prompt-tail setzt, muss ueber :root:has(yuvomi-install-prompt...) laufen');
  assert.match(setzer[1], /\[[a-z-]+\]/,
    'das :has()-Argument braucht ein Zustands-Attribut. Ohne eines fragt der Selektor nur, ob das '
    + 'Element im DOM steht - und das ist es immer (index.html). Gemessen: 105px Nachlauf unter '
    + 'jedem Scrollport der App, dauerhaft, ohne je ein Banner zu zeigen.');

  const attr = setzer[1].match(/\[([a-z-]+)\]/)[1];
  assert.match(source, new RegExp(`setAttribute\\(\\s*SHOWN_ATTR|setAttribute\\(\\s*['"\`]${attr}['"\`]`),
    `das Bauteil muss ${attr} setzen, wenn das Banner steht - sonst fragt das CSS einen Zustand ab, den niemand meldet`);
  assert.match(source, new RegExp(`removeAttribute\\(\\s*SHOWN_ATTR|removeAttribute\\(\\s*['"\`]${attr}['"\`]`),
    `das Bauteil muss ${attr} beim Abbau wieder entfernen`);
});

/**
 * EINE LIFECYCLE-METHODE JE KLASSE - und das ist keine Stilfrage.
 *
 * `yuvomi-install-prompt` hatte ZWEI `disconnectedCallback`. In einer
 * JS-Klasse gewinnt die spaetere Definition kommentarlos: der Listener-Abbau
 * der ersten lief nie. Nach jedem Entfernen blieben `beforeinstallprompt`,
 * `locale-changed` und ein Click-Zaehler auf `document` haengen - letzterer
 * schrieb bei JEDEM Klick der Sitzung weiter in localStorage, obwohl das
 * Banner weg war. Beide Fassungen sahen fuer sich richtig aus; nur ihre
 * Koexistenz war der Fehler.
 *
 * Als REGEL ueber alle Komponenten, nicht als Einzelfall: eine Namensliste
 * haette den naechsten Fall in der naechsten Datei nicht gesehen.
 */
/**
 * JS UND CSS SCHALTEN AN DERSELBEN SCHWELLE.
 *
 * Der Kalender fragte viermal `(max-width: 639px)` ab, waehrend
 * `calendar.css` bei `max-width: 640px` schaltete. Bei GENAU 640px war die
 * Seite in zwei Zustaenden zugleich: das CSS hatte die Termin-Chips schon auf
 * Punkte reduziert, das JS hielt noch die Desktop-Klicklogik - ein Tap musste
 * einen 10px-Punkt treffen statt die ganze Zelle.
 *
 * Als REGEL ueber alle Seiten: jede `matchMedia`-Grenze muss eine Grenze
 * sein, die im CSS derselben Seite (oder in layout.css) auch vorkommt. Eine
 * Zahl, die nur eine der beiden Seiten kennt, ist per Konstruktion eine
 * Schwelle, an der sie auseinanderlaufen.
 */
test('jede matchMedia-Grenze einer Seite kennt ihr CSS auch', () => {
  // SEITENWEISE, NICHT UEBER ALLE STYLESHEETS - die erste Lehre aus diesem
  // Guard. Die Urfassung sammelte die Grenzen aller Dateien in EINEN Satz;
  // damit war `639px` „gedeckt", weil schedule.css und split-expenses.css es
  // fuehren, und der Guard blieb gruen, als ich den Fehler zur Gegenprobe
  // wieder einbaute. Ein Breakpoint ist nur dort eine Deckung, wo er auf
  // DIESELBEN Elemente wirkt - deshalb baut `own` je Seite auf.
  //
  // GEZAEHLT WIRD DIE SCHWELLE, NICHT DIE ZAHL - die zweite Lehre.
  // `max-width: 639px` und `min-width: 640px` sind DIESELBE Schwelle (die
  // Grenze gehoert der grossen Seite, siehe test:typography);
  // `max-width: 640px` ist dagegen die Schwelle 641, die kein Stylesheet
  // fuehrt. Die Vorfassung sammelte nackte Zahlen: als der Breakpoint-Sweep
  // das CSS auf die Paarung 639 zog und die matchMedia-Aufrufe von Kalender,
  // Essensplan und Dokumenten bei 640 stehen blieben, deckte ausgerechnet das
  // `min-width: 640px` aus layout.css die falsche Zahl ab. Der Guard blieb
  // gruen an genau dem Fehler, gegen den er geschrieben wurde.
  const threshold = (kind, px) => (kind === 'max' ? Number(px) + 1 : Number(px));
  const BOUNDARY = /\(\s*(min|max)-width:\s*(\d+)px\s*\)/g;

  const shared = new Set();
  for (const file of ['layout.css', 'tokens.css', 'list-row.css', 'panel.css', 'sub-tabs.css']) {
    for (const m of read(`../public/styles/${file}`).matchAll(BOUNDARY)) {
      shared.add(threshold(m[1], m[2]));
    }
  }

  const offenders = [];
  for (const path of walkJsFiles('../public/pages/')) {
    const page = path.split('/').pop().replace(/\.js$/, '');
    const cssPath = `../public/styles/${page}.css`;
    const own = new Set(shared);
    if (existsSync(new URL(cssPath, import.meta.url))) {
      for (const m of read(cssPath).matchAll(BOUNDARY)) own.add(threshold(m[1], m[2]));
    }

    // JEDES Media-Query-LITERAL der Datei, nicht nur die direkt an
    // `matchMedia()` uebergebenen. Die erste Fassung suchte
    // `matchMedia('(max-width: …` - und wurde in dem Moment blind, in dem der
    // Kalender seine vier Literale zu EINER Konstante zusammenzog, also genau
    // durch die Aufraeumarbeit, die dieser Guard absichern soll. Beide
    // Gegenproben (639px, 641px) blieben gruen. Ein Guard, der die gute Form
    // nicht mehr prueft, prueft nichts.
    for (const m of withoutBlockComments(read(path)).matchAll(/['"`]\(\s*(min|max)-width:\s*(\d+)px\s*\)['"`]/g)) {
      if (!own.has(threshold(m[1], m[2]))) {
        offenders.push(`${path}: schaltet an der Schwelle ${threshold(m[1], m[2])}px (${m[1]}-width: ${m[2]}px), aber weder ${page}.css noch die geteilten Stylesheets kennen diese Schwelle`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'matchMedia-Grenze ohne Entsprechung im eigenen CSS - an genau dieser Zahl laufen Layout und '
    + 'Verhalten auseinander:\n  ' + offenders.join('\n  '));
});

test('keine Komponente definiert dieselbe Lifecycle-Methode zweimal', () => {
  const LIFECYCLE = ['connectedCallback', 'disconnectedCallback', 'adoptedCallback', 'attributeChangedCallback'];
  const offenders = [];

  for (const file of walkJsFiles('../public/components/')) {
    const src = read(file);
    for (const name of LIFECYCLE) {
      const treffer = [...src.matchAll(new RegExp(`^\\s{2}(?:async\\s+)?${name}\\s*\\(`, 'gm'))];
      if (treffer.length > 1) {
        offenders.push(`${file}: ${name} ist ${treffer.length}x definiert`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'doppelte Lifecycle-Methode - die spaetere ueberschreibt die fruehere lautlos:\n  '
    + offenders.join('\n  '));
});

test('der Hinweis am Formularlabel ist eine Klasse, kein Inline-Design-Wert', () => {
  assert.match(read('../public/styles/layout.css'), /\.form-label__hint \{[\s\S]{0,200}?color: var\(--color-text-tertiary\)/,
    'die abgestufte Label-Ergaenzung gehoert ins Stylesheet');
  assert.match(read('../public/pages/notes.js'), /<span class="form-label__hint">/,
    'notes.js muss die Klasse nutzen statt drei Werte inline zu schreiben');
});

test('die Wischgeste setzt und loest das Compositor-Versprechen selbst', () => {
  const swipe = read('../public/utils/swipe-row.js');
  const layout = read('../public/styles/layout.css');

  // `:not(.swipe-reveal)` und nicht `:first-child`: die Reveal-Panels stehen im
  // Markup VOR der Karte, der alte Selektor promotete also das falsche Element
  // (und faerbte im Geschwister-Guard darunter das fuehrende Panel um).
  assert.match(layout, /\.swipe-row--armed > :not\(\.swipe-reveal\) \{\s*\n\s*will-change: transform;/,
    'die geteilte Buehne traegt das Versprechen, nicht die einzelnen Module');
  assert.match(layout, /\.swipe-row--swiping > :not\(\.swipe-reveal\) \{/,
    'die Traegerflaeche gehoert auf die bewegte Karte, nicht auf ein Reveal-Panel');
  assert.doesNotMatch(layout, /\.swipe-row--(?:armed|swiping) > :first-child/,
    ':first-child trifft in einer Wischzeile immer das Panel, nie die Karte');
  assert.match(swipe, /addEventListener\('touchstart'[\s\S]{0,900}?arm\(\);/,
    'gesetzt wird bei touchstart - bei der ersten Bewegung waere es einen Frame zu spaet');
  assert.match(swipe, /addEventListener\('touchcancel'/,
    'ein abgebrochener Kontakt muss die Ebene ebenfalls freigeben');
  assert.match(swipe, /disarm\(animate \? SWIPE_RESET_MS : 0\)/,
    'die Ebene faellt erst nach der Rueckfeder-Animation weg');

  for (const [file, selector] of [['shopping.css', '.shopping-item'], ['tasks.css', '.task-card']]) {
    const css = read(`../public/styles/${file}`);
    const body = [...eachRule(css)].find((rule) => rule.selector === `.swipe-row ${selector}`)?.body ?? '';
    assert.doesNotMatch(body, /will-change/,
      `${file}: die Dauerregel auf ${selector} darf nicht zurueckkommen`);
  }
});

/**
 * Der Wischhinweis kostet hoechstens eine Einblendung je Seitenbesuch.
 *
 * Sein Budget ist app-weit und drei Einblendungen gross. Alle vier rufenden
 * Module rufen ihn aus einem NEU-RENDER-Pfad heraus - `updateItemsList`,
 * `bindContent`, `renderList`, `renderTaskList` haengen an Sortier-, Filter-
 * und Loeschvorgaengen. Ohne Sperre verbrauchten drei Filterklicks das ganze
 * Budget, bevor der Nutzer je eine Zeile gesehen hatte, und die Nudge-Animation
 * spielte nach jedem Loeschen erneut.
 *
 * Die Sperre gehoert ins geteilte Modul und nicht an die vier Aufrufstellen:
 * vier richtig gesetzte Aufrufe waeren vier Annahmen, die beim naechsten Umbau
 * wieder wandern - genau so ist der Aufruf aus `renderListContent` in die
 * Render-Pfade gerutscht.
 */
test('der Wischhinweis feuert hoechstens einmal je Seitenbesuch', () => {
  const swipe = read('../public/utils/swipe-row.js');
  const fn = swipe.match(/export function maybeShowSwipeHint\([\s\S]*?\n\}/);
  assert.ok(fn, 'expected maybeShowSwipeHint to exist');

  assert.match(fn[0], /if \(hintShownForPath === location\.pathname\) return;/,
    'die Sperre muss VOR der Arbeit stehen, sonst zaehlt jeder Re-Render mit');
  assert.match(swipe, /^let hintShownForPath = null;$/m,
    'die Sperre gehoert auf Modulebene - der Pfad als Schluessel laesst den Hinweis bei einem spaeteren Besuch wieder zu');
  assert.ok(
    fn[0].indexOf('hintShownForPath = location.pathname') > fn[0].indexOf("querySelector('.swipe-row')"),
    'gesetzt wird die Sperre erst, wenn eine Zeile da war - eine leere Liste darf den Besuch nicht verbrauchen',
  );

  // localStorage kann werfen (Safari privat, blockierter Storage), und dieser
  // Aufruf steht mitten im Render-Pfad - in shopping.js sogar VOR
  // updateCheckedActions(). noticeSwappedSides im selben Modul bringt dafuer
  // seit jeher ein try/catch mit.
  for (const access of fn[0].matchAll(/localStorage\.\w+\(/g)) {
    const before = fn[0].slice(0, access.index);
    assert.ok(
      before.lastIndexOf('try {') > before.lastIndexOf('} catch'),
      `ungeschuetzter localStorage-Zugriff in maybeShowSwipeHint: ${access[0]}`,
    );
  }
  assert.ok([...fn[0].matchAll(/localStorage\.\w+\(/g)].length >= 2,
    'Reichweiten-Nachweis: kein localStorage-Zugriff gefunden - der Guard prueft nichts mehr');
});

/**
 * Jede Frontend-Datei parst.
 *
 * KLINGT TRIVIAL, IST ES NICHT: eine Datei unter `public/` wird nur dann
 * geparst, wenn irgendein Test sie importiert. Wer keinen hat, faellt erst im
 * Browser auf - und ein Modul, das beim Laden wirft, laesst die Seite leer,
 * waehrend die Dokument-Sonden dort brav „keine Verstoesse" melden.
 *
 * Gemessener Anlass: ein HTML-Kommentar IN einem Template-Literal enthielt
 * Backticks (`<!-- KEIN \`aria-controls\` ... -->`) - die schliessen das
 * Literal, und calendar.js parste nicht mehr. Aufgefallen ist es erst in
 * `test:calendar`, mitten in einem Suite-Lauf, und in einer parallel laufenden
 * Browser-Suite fuehrte es zu gruenen Sonden auf einer kaputten Seite.
 *
 * Der Preis ist ein Bruchteil einer Sekunde je Datei; der Nutzen ist, dass der
 * Fehler dort gemeldet wird, wo er entstanden ist.
 */
test('jede JS-Datei unter public/ ist syntaktisch gueltiges ESM', () => {
  const files = walkFrontendFiles('../public/').filter((f) => f.endsWith('.js') && !f.includes('/vendor/'));
  assert.ok(files.length > 100, `Nur ${files.length} JS-Dateien gefunden - der Scanner findet public/ nicht mehr.`);

  const offenders = [];
  for (const file of files) {
    try {
      // `node --check` liest den Modultyp aus package.json ("type": "module"),
      // parst also als ESM - `import`/`export` auf oberster Ebene sind erlaubt.
      execFileSync(process.execPath, ['--check', new URL(file, import.meta.url).pathname], { stdio: 'pipe' });
    } catch (err) {
      const detail = String(err.stderr || err.message).split('\n').find((l) => /SyntaxError/.test(l)) || String(err.message).slice(0, 120);
      offenders.push(`${file.replace('../public/', '')}: ${detail.trim()}`);
    }
  }

  assert.deepEqual(offenders, [],
    'Dateien, die nicht parsen:\n  ' + offenders.join('\n  ')
    + '\nHaeufigste Ursache: ein Backtick in einem Kommentar INNERHALB eines Template-Literals.');
});

/**
 * ZU DIESER REGEL GIBT ES HIER BEWUSST KEINEN GUARD.
 *
 * „Loest dieses `aria-controls` auf, wenn das Element sichtbar ist?" ist eine
 * Frage an das DOKUMENT, und jede statische Naeherung ist entweder blind oder
 * falsch - beides gemessen, nicht vermutet:
 *
 *   Massstab DATEI    gruen mit wieder eingebautem Verstoss. `#cal-search-bar`
 *                     steht sehr wohl in calendar.js, nur in einem Template,
 *                     das erst beim Oeffnen der Suche eingefuegt wird.
 *   Massstab TEMPLATE rot beim Verstoss, aber zusaetzlich drei Fehltreffer
 *                     (budget-body, housekeeping-content, rewards-content) -
 *                     dort liegt das Ziel in einem anderen Template, das
 *                     IMMER mitgerendert wird. Der Verweis loest auf.
 *
 * Die Regel gehoert deshalb auf Guard-Ebene 4: Sonde 10 der Dokument-Guards
 * loest jedes `aria-controls`/`aria-labelledby`/`aria-describedby` im
 * gerenderten Dokument auf - ueber 16 Routen und 6 anonyme Seiten, beide
 * Groessenklassen. Sie hat den Fall auch gefunden (Audit-Nachmessung
 * 2026-08-08); der Audit selbst hatte ihn uebersehen.
 *
 * Ein Guard, der nicht rot werden kann, ist eine Hoffnung - und einer, der bei
 * korrektem Code rot wird, wird abgeschaltet. Beide waeren schlechter als der
 * ehrliche Verweis auf die Ebene, die es messen kann.
 */

test('jede Sub-Tab-Leiste erklärt ihre Semantik, und zwar die, die ihre Routen hergeben', () => {
  // Küche: vier eigenständige Module (eigener `module:`-Wert je Route) -> Navigation.
  const kitchen = read('../public/utils/kitchen-tabs.js');
  assert.match(kitchen, /semantics:\s*'nav'/,
    'die Küchen-Leiste wechselt das Modul; das ist Navigation, keine Tabs');
  assert.doesNotMatch(kitchen, /panelFor/,
    'ein Modulwechsel hat kein Panel im selben Dokument');

  // Gesundheit: ein Modul, alle Panels gleichzeitig im DOM -> echte Tabs.
  const health = read('../public/utils/health-tabs.js');
  assert.match(health, /semantics:\s*'tabs'/,
    'die Gesundheits-Leiste tauscht ein Panel im selben Dokument; das sind Tabs');
  assert.match(health, /panelFor:\s*\(route\) =>[\s\S]*?data-health-panel/,
    'die Tabs müssen ihre echten Panels benennen');

  // Und die Panels müssen existieren, sonst zeigt panelFor ins Leere.
  const healthPage = read('../public/pages/health.js');
  assert.match(healthPage, /data-health-panel="\$\{esc\(panel\.route\)\}"/,
    'health.js muss die Panels mit genau dem Attribut rendern, das panelFor sucht');
  assert.doesNotMatch(healthPage, /function showPanel\(/,
    'Auswahl und Panel-Sichtbarkeit sind eine Operation - zwei Besitzer laufen auseinander');
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

test('#936: ein verknuepftes Rezept hat von der Essenskarte aus einen Ausgang', () => {
  // Ein Essen liess sich mit einem Rezept aus dem eigenen Haus verknuepfen
  // (`recipe_id`), aber der Aktionsknopf auf der Karte gab es nur fuer eine
  // EXTERNE Adresse (`recipe_url`). Die Verknuepfung hatte also keinen Ausgang -
  // man konnte sie anlegen und nie benutzen.
  const meals = read('../public/pages/meals.js');
  const recipes = read('../public/pages/recipes.js');

  // Der Knopf existiert und zeigt auf die Deep-Link-Schreibweise, die Kontakte
  // und Startseite schon benutzen - kein dritter eigener Parameter.
  assert.match(meals, /data-action="open-linked-recipe"/);
  assert.match(meals, /href="\/recipes\?open=\$\{encodeURIComponent\(meal\.recipe_id\)\}"/);

  // Und die Gegenseite liest ihn. Ohne das waere der Link eine Adresse, die
  // niemand auswertet: /recipes oeffnete sich, das Rezept bliebe zugeklappt.
  assert.match(recipes, /new URLSearchParams\(window\.location\.search\)\.get\('open'\)/);
  // Der AUFRUF, nicht der Name: `/openRecipeFromQuery\(\)/` trifft auch die
  // Funktionsdefinition und bleibt gruen, wenn niemand sie mehr ruft. Genau das
  // ist der ersten Fassung passiert. Geprueft wird deshalb der Aufruf innerhalb
  // von render(), nach dem Laden der Liste - vorher gaebe es keine Zeile zum
  // Aufklappen.
  const renderAt = recipes.indexOf('export async function render(container)');
  assert.ok(renderAt > 0, 'render() existiert');
  const renderBody = recipes.slice(renderAt);
  assert.match(renderBody, /renderRecipeList\(\);\s*(?:\n\s*\/\/[^\n]*)*\n\s*openRecipeFromQuery\(\);/,
    'der Deep-Link wird nicht gelesen - /recipes?open=N oeffnet dann nichts');

  // Der Klick geht ueber `<a href>` und darf dem Browser seine Modifier lassen -
  // sonst nimmt der Handler dem Nutzer Cmd-Klick und "Link kopieren" wieder weg,
  // wofuer der Link ueberhaupt ein Link ist.
  const handlerAt = meals.indexOf("action === 'open-linked-recipe'");
  assert.ok(handlerAt > 0, 'der Klick wird behandelt');
  const handler = meals.slice(handlerAt, handlerAt + 400);
  assert.match(handler, /metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/);
  assert.match(handler, /navigate\(/, 'ein roher href waere ein Vollreload der PWA');

  // Der Knopf darf keine Ziehgeste ausloesen. Hier standen drei Aktionen
  // namentlich, und die vierte fehlte prompt: auf Touch startete ihr
  // `pointerdown` ein Ziehen, das Loslassen verschob das Essen in einen anderen
  // Slot und verschluckte den Klick. Geprueft wird deshalb die REGEL - der
  // Aktionscontainer -, nicht eine Aufzaehlung, die den naechsten Knopf wieder
  // vergisst.
  assert.match(meals, /closest\('\.meal-card__actions'\)\) return;/,
    'die Aktionsleiste muss als Ganzes vom Ziehen ausgenommen sein');
  assert.doesNotMatch(meals, /data-action="delete-meal"\], \[data-action=/,
    'die alte Aufzaehlung im Drag-Guard ist wieder da');

  // Ein Admin kann Rezepte abschalten und Mahlzeiten anlassen. Bestehende Essen
  // behalten ihre `recipe_id`, aber `/recipes` leitet dann auf die Startseite -
  // und weil der interne Knopf dem externen vorgeht, naehme er den noch mit.
  assert.match(meals, /meal\.recipe_id && recipesReachable\(\)/,
    'der interne Knopf haengt nicht an der Erreichbarkeit des Rezeptmoduls');
  assert.match(meals, /isModuleDisabled\?\.\('recipes'\)/);

  // Und der Deep-Link muss an einem stehengebliebenen Filter vorbeikommen:
  // `state` ueberlebt den Seitenwechsel, und ein Rezept, das die letzte Suche
  // ausfiltert, waere per `?open=` unerreichbar - wortlos.
  assert.match(recipes, /has\('open'\)\)\s*\{\s*\n\s*state\.query = '';\s*\n\s*state\.sourceFilter = 'all';/,
    'ein alter Filter kann das verlangte Rezept verstecken');
});

test('#934: die Waehrung steht ausserhalb der ausblendbaren Formatkarte', () => {
  // DIE FALLE. Die Formatkarte traegt `${customHidden ? ' hidden' : ''}`, und
  // customHidden ist wahr, solange eine Region-Voreinstellung EXAKT auf die
  // gespeicherten Werte passt. Solange die Waehrung dort drin lag, hiess das:
  // sichtbar wurde sie erst, WENN man sie schon einmal geaendert hatte - denn
  // dann passt kein Preset mehr und die Karte klappt auf. Wer sie suchte, fand
  // sie nie; der Wegweiser aus den Modul-Optionen fuehrte auf eine leere Stelle.
  //
  // Geprueft wird die Reihenfolge im Quelltext, weil die Sichtbarkeit an der
  // Kartenzugehoerigkeit haengt: das Select muss VOR dem oeffnenden Tag der
  // Formatkarte stehen, also ausserhalb von ihr.
  const source = read('../public/settings/pages/personal-appearance.js');

  const currencyAt = source.indexOf('id="currency-select"');
  const customAt   = source.indexOf('id="custom-formats"');
  assert.ok(currencyAt > 0, 'das Waehrungsfeld existiert');
  assert.ok(customAt > 0, 'die ausblendbare Formatkarte existiert');
  assert.ok(currencyAt < customAt,
    'das Waehrungsfeld liegt in der ausblendbaren Formatkarte - genau der Zustand aus #934');

  // Und die Karte blendet weiterhin aus, was zu ihr gehoert: Datum und Uhrzeit
  // sagen, WIE ein Wert dasteht, und folgen dem Preset. Ohne diese Zusicherung
  // liesse sich #934 auch dadurch "loesen", dass gar nichts mehr ausblendet.
  assert.match(source, /id="custom-formats"\$\{customHidden \? ' hidden' : ''\}/);
  assert.ok(source.indexOf('id="date-format-select"') > customAt,
    'das Datumsformat gehoert weiterhin in die ausblendbare Karte');
  assert.ok(source.indexOf('id="time-format-select"') > customAt,
    'das Zeitformat gehoert weiterhin in die ausblendbare Karte');

  // Und die Folge daraus: eine Waehrungsaenderung kann die Region auf
  // "Benutzerdefiniert" schieben, ohne dass der Nutzer die Formatkarte je
  // gesehen hat. Stuende sie dann weiter auf `hidden`, behauptete der
  // Region-Select etwas, das die Seite nicht zeigt - deshalb zieht
  // syncRegionSelect die Sichtbarkeit mit.
  // Der Rumpf wird ausgeschnitten, nicht ueberspannt: ein `[\s\S]*?` ab
  // `function syncRegionSelect(` findet den naechsten Aufruf irgendwo in der
  // Datei und bleibt gruen, wenn der IN der Funktion fehlt. Genau das ist der
  // ersten Fassung dieser Zusicherung passiert.
  const syncStart = source.indexOf('function syncRegionSelect(');
  assert.ok(syncStart > 0, 'syncRegionSelect existiert');
  const syncBody = source.slice(syncStart, source.indexOf('\n}', syncStart));
  assert.match(syncBody, /applyCustomVisibility\(container, regionSelect\.value\)/,
    'syncRegionSelect zieht die Sichtbarkeit der Formatkarte nicht mit');
  // Die Sichtbarkeit haengt an EINER Regel, nicht an drei Handlern: ausser der
  // Helferfunktion setzt niemand mehr `hidden` an dieser Karte.
  assert.equal([...source.matchAll(/customBlock\.hidden/g)].length, 1);

  // ...aber sie darf nicht zuschlagen, waehrend jemand IN der Karte arbeitet.
  // Wer ein eigenes Format zusammenstellt, laeuft durch Zwischenstaende, und
  // einer davon trifft leicht ein Preset: `EUR/mdy/24h` auf `EUR/dmy/12h` geht
  // ueber `EUR/dmy/24h`, also durch `de-DE`. Die Karte waere nach dem ersten
  // Schritt verschwunden, mitsamt dem Feld, in dem der Fokus stand.
  assert.equal([...source.matchAll(/syncRegionSelect\(container, \{ mayHide: false \}\)/g)].length, 2,
    'Datum und Uhrzeit muessen ihre eigene Karte offenhalten');

  // Und eine Waehrungsaenderung darf die Region nicht WECHSELN. `detectRegion`
  // liest die Waehrung mit, also traf ein de-DE-Haushalt mit CHF formal `de-CH` -
  // und die Betraege sprangen von deutscher auf Schweizer Gruppierung. Das ist
  // das Gegenteil dessen, was das Feld verspricht.
  assert.match(source, /derived === regionBefore \? regionBefore : CUSTOM_REGION/,
    'die Herleitung darf die Region bestaetigen, nicht wechseln');

  // Zwei unabhaengige PUTs auf dasselbe Feld: waehrend der Regionswechsel
  // laeuft, ist die Waehrung gesperrt.
  assert.match(source, /currencyDuringRegion\.disabled = true/);
  assert.match(source, /currencyDuringRegion\?\.isConnected\) currencyDuringRegion\.disabled = false/);
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
      preferences: ['meal_type_names', 'visible_meal_types'],
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
      preferences: ['budget_mode', 'health_cycle_enabled', 'housekeeping_payment_tasks', 'tasks_subtasks_expanded', 'schedule_hidden_templates'],
    },
  };

  for (const [file, approved] of Object.entries(ownership)) {
    /* OHNE KOMMENTARE ZAEHLEN. Der Schluessel-Regex unten ist
     * `preferences\.<wort>`, und genau so liest sich auch ein DATEINAME im
     * Fliesstext: ein Kommentar, der auf `routes/preferences.js` verweist,
     * wurde als Praeferenz-Schluessel `js` gezaehlt und der Guard rot, obwohl
     * die Datei nichts Neues anfasste. Gemessen, bevor das hier stand: von den
     * drei Blaettern verliert keines einen echten Schluessel durch das
     * Strippen - alle stehen im Code, nicht nur in der Beschreibung. */
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
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
  // Die drei Schichtplan-Vorlagen-Kontrollkaestchen teilen sich EINE
  // `.map(...)`-Aufrufstelle statt vier einzelner TOGGLES-Eintraege (ein
  // Array-Praeferenzwert, nicht ein Schluessel je Schalter) - deshalb kein
  // literales `id: 'schedule-template-work'` im Quelltext, das
  // `controlIdPattern` finden koennte. Die erzeugende Vorlage selbst pruefen.
  assert.match(options, /const SCHEDULE_TEMPLATES = \[/);
  assert.match(options, /id: `schedule-template-\$\{key\}`/, 'the three schedule template checkboxes must use the reviewed id pattern');
  // Genau diese Schalter, sonst nichts: sie kommen aus dem geteilten Primitiv,
  // deshalb zählt das Blatt keine `<input>`-Literale mehr. Fuenf statt vier
  // Fundstellen im QUELLTEXT, nicht Aufrufe zur Laufzeit: die drei
  // Schichtplan-Vorlagen teilen sich die eine `.map(...)`-Aufrufstelle oben.
  assert.equal([...options.matchAll(/toggleRowHtml\(\{/g)].length, 5);
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

test('die Widget-Optionen sind auch am ausgeblendeten Widget erreichbar (#814)', () => {
  const source = read('../public/pages/dashboard.js');
  const widgets = read('../public/utils/dashboard-widgets.js');

  // DIE VORAUSSETZUNG, DIE DIESE REGEL NOETIG MACHT: Aufgaben und Kalender sind
  // ab Werk ausgeblendet, weil das Cockpit ihre Domaenen abdeckt. Genau sie
  // tragen die Optionen. Waeren die Optionen nur an der sichtbaren Kachel,
  // muesste man die Kachel erst einblenden, um einzustellen, was sie gar nicht
  // zeigt - und ihre Filter wirken auf Cockpit und Kopfband weiter.
  const covered = widgets.match(/COCKPIT_COVERED_WIDGETS = new Set\(\[([^\]]*)\]/);
  assert.ok(covered, 'COCKPIT_COVERED_WIDGETS nicht gefunden - das Muster greift nicht mehr');
  const withOptions = source.match(/WIDGETS_WITH_OPTIONS = new Set\(\[([^\]]*)\]/);
  assert.ok(withOptions, 'WIDGETS_WITH_OPTIONS nicht gefunden');
  const optionIds = [...withOptions[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const coveredIds = [...covered[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(optionIds.some((id) => coveredIds.includes(id)),
    'kein Options-Widget ist ab Werk ausgeblendet - dann ist diese Regel gegenstandslos geworden');

  // Die Ablage der ausgeblendeten Widgets traegt den Knopf.
  const tray = source.match(/function renderHiddenWidgetsTray[\s\S]*?\n}/);
  assert.ok(tray, 'renderHiddenWidgetsTray nicht gefunden');
  assert.match(tray[0], /data-widget-options=/,
    'die Ablage bietet keine Optionen an - am ausgeblendeten Widget waeren sie unerreichbar');

  // Und sie werden auch verdrahtet: die Ablage liegt AUSSERHALB des Grids, ein
  // `grid.querySelectorAll` faende sie nicht.
  assert.match(source, /container\.querySelectorAll\('\[data-widget-options\]'\)/,
    'die Optionen-Knoepfe der Ablage bekommen keinen Listener');
});

test('das Kopfband faehrt im selben Anpassen-Zyklus wie die Kacheln (#740)', () => {
  const source = read('../public/pages/dashboard.js');

  // Der eigentliche Fehler waere nicht ein fehlender Schalter, sondern einer,
  // der neben dem Zyklus steht: Abbrechen holt die Kacheln zurueck und laesst
  // das Kopfband verschwunden, oder Rueckgaengig kennt es nicht. Geprueft wird
  // deshalb die KOPPLUNG, nicht die Existenz des Knopfes.
  // JEDER dieser PUTs, nicht irgendeiner: es gibt zwei (Speichern und
  // Ruecknahme), und ein Guard, dem einer genuegt, ist blind fuer den anderen.
  const widgetPuts = [...source.matchAll(/api\.put\('\/preferences',\s*\{[^}]*dashboard_widgets[^}]*\}/g)]
    .map((m) => m[0]);
  assert.ok(widgetPuts.length >= 2,
    `Nur ${widgetPuts.length} dashboard_widgets-PUTs gefunden - das Muster greift nicht mehr`);
  const withoutGlance = widgetPuts.filter((call) => !call.includes('dashboard_today_glance'));
  assert.deepEqual(withoutGlance, [],
    'Kacheln und Kopfband muessen in EINEM PUT gehen - sonst schreibt ein Fehlschlag die Haelfte:\n  '
    + withoutGlance.join('\n  '));
  assert.match(source, /function cancelDashboardConfig\(\)[\s\S]{0,200}?glanceVisible = savedGlanceVisible/,
    'Abbrechen stellt das Kopfband nicht zurueck');
  // SEIT #827 IST "STANDARD" DIE VORGABE DES HAUSHALTS, nicht mehr der
  // Auslieferungszustand: Zuruecksetzen loescht den eigenen Stand und uebernimmt,
  // was der Server daraufhin zurueckmeldet. Das Kopfband muss diesen Weg
  // mitgehen - eine feste `true` waere hier wieder die halbe Ruecknahme.
  assert.match(source, /function resetDashboardConfig[\s\S]{0,1400}?glanceVisible = res\.data\?\.dashboard_today_glance !== false/,
    'Zuruecksetzen holt das Kopfband nicht aus der Vorgabe zurueck');
  assert.match(source, /dashboard_widgets: null, dashboard_today_glance: null/,
    'Zuruecksetzen muss BEIDE eigenen Werte loeschen - sonst folgt die Haelfte weiter dem alten Stand');
  assert.match(source, /glanceVisible = previousGlance/,
    'Rueckgaengig nimmt das Kopfband nicht mit zurueck');
  assert.match(source, /previousGlance !== glanceVisible/,
    'wurde NUR das Kopfband umgeschaltet, muss der Toast trotzdem Rueckgaengig anbieten');

  // Im Bearbeiten-Modus bleibt das Kopfband stehen, auch ausgeblendet und auch
  // ohne Inhalt - sonst waere der Schalter, der es zurueckholt, nur sichtbar
  // solange es ohnehin da ist.
  assert.match(source, /\(glanceVisible \|\| isCustomizing\)/,
    'ausgeblendet verschwindet das Kopfband auch im Bearbeiten-Modus');
  assert.match(source, /!parts\.length && !editing/,
    'ohne Inhalt faellt das Kopfband auch im Bearbeiten-Modus weg');
  assert.match(source, /data-glance-show/,
    'ausgeblendet fehlt der Weg zurueck ueber die Chip-Leiste');
});

test('sync-calendar leaf loads CalDAV, Google, and Apple with independent status', () => {
  const source = read('../public/settings/pages/sync-calendar.js');

  // CalDAV calendar account management + status before forms.
  assert.match(source, /api\.get\('\/calendar\/caldav\/accounts'\)/);
  assert.match(source, /api\.post\('\/calendar\/caldav\/accounts'/);
  // Ohne schliessendes Backtick: geprueft ist, dass die Seite diesen Endpunkt
  // loeschend anspricht, nicht die exakte Zeichenfolge. Seit #732 haengt ein
  // `?deleteEvents=` daran, und ein Guard, der daran zerbricht, prueft die
  // Schreibweise statt der Absicht.
  assert.match(source, /api\.delete\(\s*`\/calendar\/caldav\/accounts\/\$\{[^}]+\}/);
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
  // Ohne schliessendes Anfuehrungszeichen, aus demselben Grund wie beim
  // CalDAV-Konto darueber: seit #820 haengt ein `?deleteEvents=` daran.
  assert.match(source, /api\.delete\(`\/calendar\/google\/disconnect\?deleteEvents=/);
  assert.match(source, /api\.delete\(endpoint\)/);
  assert.match(source, /'\/calendar\/google\/mirrored-events'/);
  // Der letzte Sync-Fehler steht an der Statuszeile, die er erklaert (#820) -
  // vorher stand er nur im Serverlog, und ein stumm gescheiterter Sync sah aus
  // wie ein Kalender, der einfach aufhoert sich zu aktualisieren.
  assert.match(source, /appendSyncError\(status, googleStatus\?\.lastError\)/);
  assert.match(source, /appendSyncError\(status, appleStatus\?\.lastError\)/);
  assert.match(source, /t\('settings\.syncErrorDetail', \{ error: lastError \}\)/);

  // Apple: legacy badge + hint steering new users to CalDAV, endpoints preserved.
  assert.match(source, /settings\.legacy/);
  assert.match(source, /settings\.appleLegacyHint/);
  assert.match(source, /api\.get\('\/calendar\/apple\/status'\)/);
  assert.match(source, /api\.post\('\/calendar\/apple\/connect'/);
  assert.match(source, /api\.post\('\/calendar\/apple\/sync'/);
  assert.match(source, /api\.delete\(`\/calendar\/apple\/disconnect\?deleteEvents=/);
  assert.match(source, /'\/calendar\/apple\/mirrored-events'/);

  // OAuth callback handling: localized banner, expand disclosure, scrub only callback params.
  assert.match(source, /sync_ok/);
  assert.match(source, /sync_error/);
  assert.match(source, /history\.replaceState/);
});

test('die Kalender-Abos liegen im persoenlichen Blatt, nicht hinter dem Admin-Gate', () => {
  const source = read('../public/settings/pages/personal-calendar-subscriptions.js');
  const registry = read('../public/settings/registry.js');

  // Die vier Endpunkte, die der Server eigentuemerbasiert schuetzt: lesen liefert
  // `shared = 1 OR created_by = ich`, schreiben antwortet 403 fuer fremde Abos.
  assert.match(source, /api\.get\('\/calendar\/subscriptions'\)/);
  assert.match(source, /api\.post\('\/calendar\/subscriptions'/);
  assert.match(source, /api\.patch\(`\/calendar\/subscriptions\/\$\{[^}]+\}`/);
  assert.match(source, /api\.delete\(`\/calendar\/subscriptions\/\$\{[^}]+\}`\)/);
  // Der einmalige Import gehoert dazu: auch er traegt kein Admin-Gate.
  assert.match(source, /api\.post\('\/calendar\/import'/);

  // Die eigentliche Zusicherung: das Blatt ist fuer jedes Mitglied erreichbar.
  // Ein per-Nutzer-Blatt hinter adminOnly ist der Fehler, den dieses Repo
  // viermal gemacht hat (calendar-defaults, task-defaults #695, navigation,
  // feeds) - deshalb steht er hier als Regel und nicht als Kommentar.
  const leaf = registry.match(/\{[^{}]*id: 'personal-calendar-subscriptions'[\s\S]*?\n  \}/);
  assert.ok(leaf, 'personal-calendar-subscriptions fehlt in der Registry');
  assert.match(leaf[0], /adminOnly: false/,
    'das Blatt der Kalender-Abos darf nicht adminOnly sein - der Server gatet sie nicht');
  assert.match(leaf[0], /domainId: 'personal'/);

  // Und die Gegenrichtung: was an Zugangsdaten des Haushalts haengt, bleibt
  // drueben. Taucht hier ein CalDAV- oder OAuth-Endpunkt auf, ist die Trennung
  // aufgeweicht, die dieses Blatt begruendet.
  assert.doesNotMatch(source, /\/calendar\/caldav\//);
  assert.doesNotMatch(source, /\/calendar\/google\//);
  assert.doesNotMatch(source, /\/calendar\/apple\//);
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

  // Apple hat die Erinnerungen-App aus CalDAV genommen (#677): ein iCloud-Konto
  // liefert hier höchstens Altlisten, deshalb steht der Hinweis am Konto - aber
  // nur dort, sonst läse ihn auch, wer Nextcloud oder Radicale nutzt.
  assert.match(source, /isICloudAccount\(account\.caldavUrl\)/);
  assert.match(source, /settings\.caldavRemindersAppleNote/);
  assert.match(source, /icloud\.com/);

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
  // Die Auffrischung steht im Ereignis-Handler, nicht in onClose - warum, sagt
  // die Schwesterregel weiter unten („kein Nutzer ... meldet sich ab").
  const openMgr = shopping.match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(openMgr, /const onCategoriesChanged = async \(\) => \{[\s\S]*?loadCategories\(\)/);

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

test('wer an der Frische haengt UND offline gecacht wird, liest ueber getWithSource', () => {
  // DIE KOPPLUNG, DIE SONST STILL IST. Eine Seite, deren Entscheidung von der
  // FRISCHE einer Antwort abhaengt, darf eine aus dem Offline-Cache nicht wie
  // eine frische behandeln: `networkFirstApi` gibt sie mit Status 200 zurueck,
  // sie kann beliebig alt sein, und eine Mutation leert diesen Cache nicht (nur
  // Logout tut das). Der Merker faellt dann, oder es wird gegen veraltete
  // Referenzlisten gefiltert.
  //
  // DIE BETROFFENEN SEITEN WERDEN ABGELEITET, NICHT GEPFLEGT. Die erste Fassung
  // fuehrte eine Liste von drei Dateinamen - und liess damit genau die Sorte
  // Geschwister durch, fuer die sie gedacht war: `pantry.js` fehlte eine Runde
  // lang, `tasks.js` eine weitere. Erkannt wird die Abhaengigkeit stattdessen an
  // zwei Strukturmerkmalen, die eine Seite nicht zufaellig traegt:
  //   - eine `pending…`-Map: ausstehende Schreibvorgaenge, die ein Laden raeumt
  //   - ein `…Stale`-Feld: „diese Referenzlisten sind nicht nachweislich frisch"
  // Woran eine Seite erkannt wird, die an der Frische einer Antwort haengt.
  // Die Liste darf wachsen; dass sie nicht VERALTET, sichert die Selbstprobe
  // ganz unten.
  const MARKER = [
    /const intents\s*=\s*new Map\(/,        // Absichten neben dem Serverstand
    /const pending[A-Z]\w*\s*=\s*new Map\(/, // aeltere Schreibweise desselben
    /const settledAt\s*=\s*new Map\(/,       // Bestaetigungszeit je Eintrag
    /^\s*\w*[sS]tale:\s/m,                   // Referenzlisten mit Frische-Flag
  ];

  const sw = read('../public/sw.js');
  const whitelist = sw.match(/const API_CACHE_WHITELIST\s*=\s*\[([^\]]*)\]/)?.[1];
  assert.ok(whitelist, 'API_CACHE_WHITELIST in sw.js nicht gefunden - der Guard liest ins Leere');
  const cached = [...whitelist.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const seiten = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((f) => f.endsWith('.js'));

  const verletzt = [];
  const ungeprueft = [];
  let geprueft = 0;
  for (const datei of seiten) {
    const src = read(`../public/pages/${datei}`);
    const haengtAnFrische = MARKER.some((re) => re.test(src));
    if (!haengtAnFrische) { ungeprueft.push({ datei, src }); continue; }
    // Der Modulpfad einer Seite traegt ihren Dateinamen - und der Guard glaubt
    // das nicht, sondern verlangt, dass die Seite ihn auch wirklich liest.
    const pfad = `/${datei.replace(/\.js$/, '')}`;
    if (!cached.includes(pfad)) continue;
    if (!new RegExp(`api\\.get(WithSource)?\\([\`'"]${pfad}`).test(src)) continue;
    geprueft += 1;
    if (!/getWithSource\(/.test(src)) verletzt.push(`${datei} (Pfad ${pfad})`);
  }

  // REICHWEITE VOR DEM URTEIL: faende der Guard gar keine Seite, waere er
  // gruen, ohne je etwas geprueft zu haben - dieselbe Falle wie beim
  // Browser-Ketten-Guard weiter oben.
  assert.ok(geprueft > 0,
    'keine einzige Seite geprueft - Merkmale oder Whitelist-Format haben sich geaendert');

  // UND DIE MERKMALE PRUEFEN SICH SELBST. Eine Seite, die `getWithSource`
  // benutzt, haengt nachweislich an der Frische - wird sie von keinem Merkmal
  // erkannt, ist die Merkmalsliste veraltet und der Guard blind.
  //
  // Genau das ist am 09.09. passiert: die Merker-Karten hiessen `pendingChecks`
  // und `pendingQuantity`, der Umbau nannte sie `intents`, und damit sah der
  // Guard nur noch `tasks.js`. Die Reichweiten-Zusicherung darueber blieb
  // gruen, weil EINE Seite ja noch erkannt wurde - ein Rueckbau von
  // `shopping.js` auf `api.get()` waere unbemerkt durchgegangen.
  const blind = ungeprueft
    .filter(({ src }) => /getWithSource\(/.test(src))
    .map(({ datei }) => datei);
  assert.deepEqual(blind, [],
    `benutzt getWithSource(), wird aber von keinem Merkmal erkannt: ${blind.join(', ')} - `
    + 'die Merkmalsliste MARKER ist veraltet, und der Guard prueft diese Seite nicht mehr');
  assert.deepEqual(verletzt, [],
    `haengt an der Frische und steht in API_CACHE_WHITELIST, liest aber nicht ueber `
    + `api.getWithSource(): ${verletzt.join(', ')} - eine gecachte Antwort raeumt dort `
    + 'den Merker fuer ausstehende Bearbeitungen oder wird als frische Referenz gelesen');
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
  // Gesucht ist die REGEL, die das aktive Tab-Bar-Label faerbt, nicht ihre
  // Selektorliste: die Erweiterung um die Sidebar (Runde 6, Phase 3) haette
  // eine wortwoertliche Suche gebrochen, ohne dass sich an der Zusage etwas
  // aendert. Ein Guard auf eine Schreibweise ist ein Guard auf die Formatierung.
  //
  // Die alte Fassung suchte `\{[\s\S]*?color:\s*var\(` und lief dabei ueber die
  // Regelgrenze hinaus - sie matchte irgendwo spaeter in layout.css und war
  // damit grün, ohne die Regel zu lesen. `[\s\S]*?` kennt kein `}`.
  const activeNavLabelRule = [...eachRule(layout)].find(({ selector }) =>
    selector.includes('.nav-bottom .nav-item--active .nav-item__label'))?.body ?? '';
  // Der Ink-Mix aus Phase 0b: 70 % Akzent auf der Primaertinte. Roher Akzent
  // auf akzent-getoenter Flaeche riss AA in zwei von vier Modulen.
  //
  // DIE FARBE IST SEIT 2026-08-10 DIE STIMME, NICHT DER MODULTON. Die Leiste
  // ist Shell: sie sieht in jedem Modul gleich aus, sonst wechselt der Rahmen
  // der App mit dem Zimmer (Eine-Stimme-Regel, DESIGN.md). Der Ink-Mix bleibt,
  // seine Begruendung haengt an der getoenten Flaeche darunter, nicht daran,
  // WELCHE Farbe sie toent.
  assert.match(
    activeNavLabelRule,
    /color:\s*color-mix\(\s*in srgb,\s*var\(--color-accent\)\s*70%,\s*var\(--color-text-primary\)\s*\)/,
  );
  assert.match(
    activeNavLabelRule,
    /font-weight:\s*var\(--font-weight-semibold\)/,
  );
  // Fokusring liegt AUSSEN um die Icon-Well (nicht innen ins Item) — so ist er
  // für Tastatur-/Sehbeeinträchtigte klar zu orten statt hinter Icon+Label zu
  // verschwinden.
  assert.match(focusRule, /outline:\s*none/);
  const focusWellRule = cssRuleBody(layout, '.nav-bottom .nav-item:focus-visible .nav-item__icon-well');
  // Breite und Offset kommen aus den geteilten Fokus-Tokens (tokens.css §7b),
  // vorher aus --space-0h. Die FARBE wich frueher ab (--item-module-accent: ein
  // Nav-Item zeigt auf SEIN Modul); mit der Eine-Stimme-Regel ist die Ausnahme
  // entfallen - ein Fokusring, der pro Tab die Farbe wechselt, macht aus einer
  // Tastatur-Affordanz fuenf.
  assert.match(focusWellRule, /outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--focus-ring-color\)/);
  assert.match(focusWellRule, /outline-offset:\s*var\(--focus-ring-offset\)/);
  assert.match(focusWellRule, /--focus-ring-color:\s*var\(--color-accent\)/);
  assert.match(pressedWellRule, /transform:\s*translateY\(var\(--space-px\)\) scale\(0\.96\)/);
  assert.doesNotMatch(layout, /(^|\n)\.nav-item:active\s*\{[\s\S]*?transform:/);
  assert.doesNotMatch(layout, /\.nav-bottom \.nav-item:active\s*\{[\s\S]*?transform:/);
  // EINE Tint-Schicht: der Akzent-Fill sitzt am Indikator selbst; das ::before
  // trägt nur noch den Specular-Highlight (kein zweiter Tint → keine matschige
  // Kante der gleitenden Pille).
  assert.match(
    glass,
    /\.nav-bottom__indicator\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--color-accent\)/,
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
 * KEINE Seite baut Leerzustände von Hand - app-weit, nicht nur die Küche.
 *
 * `utils/empty-state.js` erzwingt Reihenfolge (Icon, Titel, Beschreibung,
 * Hinweis, CTA), die Überschriften-Semantik des Titels und die ARIA-Rolle je
 * Variante. Solange Seiten das Markup daneben von Hand zusammensetzen, driften
 * die Zustände wieder auseinander - genau das war der Ausgangsbefund (drei
 * Grammatiken, drei vertikale Achsen).
 *
 * Vorgeschichte dieses Guards: Er stand von 2026-07-30 bis 2026-08-24 auf einer
 * Allowlist der vier Küchen-Seiten, mit dem Vermerk „die übrigen 15 Seiten
 * bauen ihre Leerzustände noch von Hand (152 Fundstellen)". Eine Allowlist
 * deckt die Dateien ab, die schon in Ordnung sind, und schweigt über die
 * anderen - der Rückstand war grün. Beim Ausrollen fand sich in diesen 15
 * Seiten: 52 handgebaute Zustände, davon **keiner einzige** mit `role`, 48 mit
 * einem `<div>` statt einer Überschrift als Titel, und vier Ladefehler ohne
 * jeden Ausweg. Deshalb ist die Regel jetzt die Regel und nicht die Liste.
 *
 * Geprüft wird der CONTAINER (`class="empty-state"`), nicht die Teilklassen.
 * `empty-state__icon` allein ist erlaubt: die Dashboard-Kacheln führen mit
 * `.widget__empty` bewusst eine eigene, kleinere Grammatik und teilen sich nur
 * das Icon-Format.
 */
test('keine Seite baut .empty-state-Markup von Hand', () => {
  // Der Renderer selbst ist die eine Stelle, an der das Markup entstehen darf.
  const RENDERER = '../public/utils/empty-state.js';
  const offenders = [];
  for (const file of walkFrontendFiles('../public/')) {
    if (file === RENDERER || file.startsWith('../public/vendor/')) continue;
    const src = read(file);
    const hits = [
      ...src.matchAll(/class="empty-state(?:["\s])/g),
      ...src.matchAll(/className\s*=\s*['"]empty-state(?:['"\s])/g),
    ];
    if (hits.length) offenders.push(`${file} (${hits.length}x)`);
  }
  assert.deepEqual(offenders, [],
    'Leerzustands-Markup von Hand statt emptyStateEl()/emptyStateHTML()/mountEmptyState():\n'
    + offenders.join('\n'));
});

/**
 * Der Renderer ist die einzige Quelle der Grammatik - auch für die String-Form.
 *
 * `emptyStateHTML()` ist bewusst `emptyStateEl(...).outerHTML` und keine zweite
 * Komposition. Eine parallele String-Fassung wäre exakt der Mechanismus, der
 * die Zustände überhaupt auseinanderlaufen liess: zwei Stellen, die dasselbe
 * bauen, halten nie lange dasselbe.
 */
test('die String-Ausgabe des Leerzustands leitet sich aus der Element-Fassung ab', () => {
  const src = read('../public/utils/empty-state.js');
  assert.match(src, /export function emptyStateHTML[\s\S]{0,600}?return emptyStateEl\(opts\)\.outerHTML;/,
    'emptyStateHTML() baut eigenes Markup statt emptyStateEl() zu serialisieren');
  assert.match(src, /export function emptyHintHTML[\s\S]{0,300}?return emptyHintEl\(text, opts\)\.outerHTML;/,
    'emptyHintHTML() baut eigenes Markup statt emptyHintEl() zu serialisieren');
  // Ein onClick überlebt die Serialisierung nicht. Ohne diese Schranke wäre der
  // CTA still tot - sichtbar, klickbar, ohne Wirkung.
  assert.match(src, /emptyStateHTML[\s\S]{0,400}?action\?\.onClick[\s\S]{0,300}?throw new TypeError/,
    'emptyStateHTML() nimmt ein onClick entgegen, das die String-Ausgabe nicht überlebt');
});

/**
 * Kein Fehlerzustand ohne Ausweg.
 *
 * Die Variante `error` ist die einzige, bei der die Sackgasse teuer ist: die
 * Seite ist leer, die Ursache liegt am Server, und ohne CTA bleibt nur der
 * Neuladeknopf des Browsers - den auf einem Telefon in einer installierten PWA
 * nicht jeder findet. `mountLoadError()` erzwingt den Ausweg ueber seine
 * Signatur; wer die Variante direkt setzt, umgeht diese Zusicherung.
 *
 * Belegt an vier Stellen, die vor dem Ausrollen der Grammatik genau so
 * dastanden: Abonnements, Haushaltshilfe, Belohnungen und die geteilten
 * Ausgaben im Budget zeigten bei HTTP 500 eine Meldung ohne jede Handlung.
 * Die Haushaltshilfe setzte als Erklaerung obendrein `err.message` - bei allen
 * Routen das unlokalisierte englische „Internal server error.".
 *
 * Geprueft wird die REGEL (jede error-Variante fuehrt eine Aktion), nicht eine
 * Liste erlaubter Dateien: der globale Fehlerbildschirm im Router setzt die
 * Variante zu Recht selbst und besteht den Guard, weil er einen Ausweg hat.
 */
test('jeder Fehler-Leerzustand fuehrt eine Aktion', () => {
  const offenders = [];
  for (const file of walkFrontendFiles('../public/')) {
    if (file.startsWith('../public/vendor/')) continue;
    // Ohne Blockkommentare: die Doku des Renderers nennt `variant: 'error'`
    // selbst, um vor genau diesem Aufruf zu warnen. Ein Guard, der seine eigene
    // Begruendung als Verstoss liest, zwingt zum Umschreiben der Erklaerung.
    const src = withoutBlockComments(read(file));
    for (const match of src.matchAll(/variant:\s*'error'/g)) {
      // Der Aufruf-Rumpf ab der Variante bis zur schliessenden Klammer der
      // Optionen - grosszuegig gefenstert, die Aufrufe sind kurz.
      const window_ = src.slice(match.index, match.index + 700);
      const end = window_.search(/\n\s*\}\);/);
      const call = end === -1 ? window_ : window_.slice(0, end);
      if (!/\baction\b|\bactions\b|\bonRetry\b/.test(call)) {
        offenders.push(`${file} -> ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'Fehler-Leerzustand ohne Aktion - eine Sackgasse. mountLoadError() nutzen '
    + 'oder eine action mitgeben:\n' + offenders.join('\n'));
});

/**
 * Ein Leerzustand ohne Titel ist ausschliesslich die kompakte Form.
 *
 * Die Flächenform ist auf einer leeren Seite der einzige Inhalt; ohne Titel
 * hätte der erste Bildschirm eines Moduls keine Überschrift. Umgekehrt darf die
 * kompakte Form (`emptyHintEl`) keinen führen - sie steht in einem Abschnitt,
 * dessen Kopf den Kontext schon nennt.
 */
test('der Leerzustands-Titel ist eine Überschrift, und die kompakte Form hat keine', () => {
  const src = read('../public/utils/empty-state.js');
  assert.match(src, /if \(title\) parts\.push\(`<h2 class="empty-state__title">/,
    'der Titel ist keine <h2> mehr oder wird auch ohne Text gesetzt');
  assert.doesNotMatch(src, /<div class="empty-state__title"/,
    'der Renderer setzt den Titel als <div> - damit ist der Leerzustand strukturlos');
  assert.match(src, /export function emptyHintEl[\s\S]{0,400}?emptyStateEl\(\{ compact: true/,
    'emptyHintEl() baut wieder eigenes Markup statt den Renderer zu rufen');
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
/**
 * Kein Ladefehler lebt nur in einem Toast.
 *
 * Das ist die Schwester des Kuechen-Guards darueber, app-weit statt auf vier
 * Seiten. Sie musste kommen, weil die Live-Probe (2026-08-24, HTTP 500 auf die
 * Modul-API) genau zwei Seiten fand, die den Defekt der Kueche vom 2026-07-30
 * nie mitbekommen hatten:
 *
 *   /tasks   "Keine Aufgaben - alles erledigt?"  [Aufgabe erstellen]
 *   /budget  "Keine Eintraege diesen Monat"      [Eintrag erstellen]
 *
 * Bei /tasks ist es die schlimmere Formulierung: der Serverfehler wurde als
 * ERLEDIGUNG gemeldet. Beide Loader taten dasselbe wie Einkauf und Essensplan
 * damals - Sammlung leeren, Meldung in einen Toast, fertig. Von den zwei
 * Aussagen ueberlebte die falsche, denn der Toast verging und der Leerzustand
 * blieb.
 *
 * Geprueft wird die Kombination, nicht der Toast an sich: ein Toast NEBEN einem
 * gesetzten Fehlerfeld oder einem `throw` ist in Ordnung. Verboten ist nur,
 * eine Sammlung zu leeren und den Fehler danach ausschliesslich verklingen zu
 * lassen.
 */
test('kein Ladefehler wird nur in einen Toast gelegt', () => {
  const offenders = [];
  for (const file of walkFrontendFiles('../public/')) {
    if (!file.endsWith('.js') || file.startsWith('../public/vendor/')) continue;
    const src = withoutBlockComments(read(file));
    for (const [name, body] of topLevelFunctions(src)) {
      const block = body.slice(body.search(/\bcatch\s*[({]/));
      if (!/\bcatch\s*[({]/.test(body)) continue;
      const toastsLoadError = /showToast\s*\(\s*t\(\s*['"][\w.]*[lL]oadError/.test(block);
      if (!toastsLoadError) continue;
      // Leert der Rumpf eine Sammlung? Dann steht danach ein Leerzustand.
      const clearsCollection = /\.\w+\s*=\s*\[\]/.test(block);
      if (!clearsCollection) continue;
      // Ein Ausweg ist da, wenn der Fehler festgehalten oder weitergereicht wird.
      const keepsError = /\.\w*[eE]rror\s*=\s*(?!null|false)/.test(block)
        || /\bthrow\b/.test(block)
        || /\bmountLoadError\s*\(/.test(block);
      if (!keepsError) offenders.push(`${file}: ${name}()`);
    }
  }
  assert.deepEqual(offenders, [],
    'Ladefehler nur als Toast, waehrend die geleerte Sammlung darunter einen '
    + 'Leerzustand zeigt - der Toast vergeht, die falsche Aussage bleibt:\n'
    + offenders.join('\n'));
});

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
  const shared = read('../public/styles/list-row.css');
  const indexHtml = read('../public/index.html');

  assert.match(indexHtml, /<link rel="stylesheet" href="\/styles\/list-row\.css" \/>/,
    'list-row.css muss in index.html eingehängt sein (Router lädt nur EIN Page-CSS pro Seite)');

  // Die Gruppe trägt die Fläche, die Zeile nur Inhalt.
  const rowsBlock = shared.match(/\.list-rows\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rowsBlock, /background-color:\s*var\(--color-surface-work\)/,
    '.list-rows muss die opake Arbeitsfläche tragen (DESIGN.md: kein Glas unter Fließtext)');
  assert.match(rowsBlock, /border-radius:\s*var\(--radius-md\)/,
    '.list-rows muss den Inhaltsflächen-Radius aus DESIGN.md §5 tragen');

  // Keine Zeilenaktion an der rechten Zeilenkante: das ist die Ecke, die der
  // fixierte FAB besetzt (87% Überdeckung auf dem Vorrats-Warenkorb im
  // Ruhezustand, Critique 2026-07-30). Kontextuelle Aktionen sitzen in einem
  // festen Slot am Anfang der Bedienzone.
  assert.doesNotMatch(shared.replace(/\/\*[\s\S]*?\*\//g, ''), /\.list-row__end-action/,
    'an der Zeilenkante verankerte Aktionen liegen in der FAB-Ecke - fester Slot am Anfang der Bedienzone stattdessen');

  /* WER MITTEN IM WORT BRICHT, SETZT EINEN TRENNSTRICH (Etappe 7, 2026-08-13).
   *
   * `overflow-wrap: anywhere` heisst genau das: brich INNERHALB eines Wortes,
   * statt überzulaufen. Ohne `hyphens: auto` geschieht das ohne jedes Zeichen -
   * gemessen bei 320x568 standen 11 von 26 Einkaufszeilen als „Kirschtoma /
   * ten". Die Begründung der Regel („umbrechen, nicht abschneiden") stimmte
   * die ganze Zeit; geprüft hat nie jemand, WIE sie umbricht.
   *
   * DIE ZUSICHERUNG IST DIE PAARUNG, KEIN KLASSENNAME: jede Regel dieser Datei,
   * die einen Umbruch im Wort erlaubt, trägt in DERSELBEN Regel ihre
   * Trennhilfe. Ein Guard auf `.list-row__name` allein wäre eine Allowlist von
   * einem und liesse den nächsten geteilten Textknoten ungedeckt.
   *
   * `break-word` ist ausdrücklich NICHT gemeint und steht deshalb nicht in der
   * Bedingung: es bricht ein Wort nur, wenn es allein auf keiner Zeile
   * unterkommt, und `hyphens: auto` würde dort auch dann trennen, wenn ein
   * Umbruch an einer Leerstelle möglich ist. Die Metazeile behält es. */
  const bruchOhneStrich = [...eachRule(shared)]
    .filter((r) => /overflow-wrap:\s*anywhere/.test(r.body) && !/hyphens:\s*auto/.test(r.body));
  assert.deepEqual(bruchOhneStrich.map((r) => r.selector.trim()), [],
    'in der geteilten Zeilengrammatik braucht jeder Umbruch im Wort seinen Trennstrich - '
    + 'sonst steht dort bei 320px „Kirschtoma / ten"');

  /* Und kein Modul nimmt die Entscheidung still zurück. Die Grammatik ist
   * geteilt, ihre Stylesheets laden nach list-row.css, und eine Zeile
   * `hyphens: manual` in einem der neun Module wäre bei gleicher Spezifität die
   * spätere und damit die geltende - ohne dass hier etwas rot würde. */
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css') && f !== 'list-row.css')) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/\.list-row__(?:name|meta)\b/.test(rule.selector)) continue;
      assert.doesNotMatch(rule.body, /hyphens:/,
        `${file} (${rule.selector.trim()}) darf die Trennung der geteilten Grammatik nicht überschreiben`);
    }
  }

  const pantryCss = read('../public/styles/pantry.css');
  const slot = pantryCss.match(/\.pantry-row__cart-slot\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(slot, /width:\s*var\(--target-lg\)/,
    'wo ein Warenkorb liegt, muss der Slot die volle .row-action-Breite tragen');
  assert.match(slot, /flex-shrink:\s*0/, 'der Slot darf nicht schrumpfen');
  /* HIER STAND „pantry.js muss den Slot IMMER rendern, auch ohne Warenkorb -
   * sonst springt der Stepper je Zeile". Am gerenderten Dokument nachgemessen
   * (390x844, 12 Zeilen, 5 mit Warenkorb): die linke Kante des Minus-Knopfs
   * liegt mit und ohne leeren Slot bei x=261. Seit die Bedienung im DOM HINTER
   * dem Namen steht (2026-07-29), klebt sie an der Zeilenkante und der Stepper
   * ist ihr letztes Kind - er kann gar nicht springen. Der leere Slot kostete
   * nur 52px Textspalte. Zugesichert wird deshalb sein Wegfall. */
  assert.match(pantryCss, /\.pantry-row__cart-slot:empty\s*\{\s*display:\s*none/,
    'ein Warenkorb-Slot ohne Warenkorb reserviert 52px Textspalte fuer nichts');

  // Umbrechen statt abschneiden. Ein gekürzter Artikelname ("Broc…") war bei
  // 320px der Verlust des einzigen Zwecks der Einkaufsliste.
  const nameBlock = shared.match(/\.list-row__name\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(nameBlock, /text-overflow|white-space:\s*nowrap/,
    '.list-row__name darf nicht ellipsieren: bei 320px blieben vier lesbare Zeichen');
  assert.match(nameBlock, /overflow-wrap:\s*anywhere/,
    '.list-row__name muss umbrechen dürfen');

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
        `${tab}: ${selector} darf kein eigenes ${prop} setzen - das trägt .list-row bzw. .list-rows`);
    }
  }

  // Alle drei Listen-Tabs benutzen die geteilten Klassen im Markup.
  for (const page of ['shopping', 'pantry', 'recipes']) {
    const src = read(`../public/pages/${page}.js`);
    for (const cls of ['list-scroller', 'list-rows', 'list-row', 'list-row__main', 'list-row__name', 'list-row__actions']) {
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
  assert.doesNotMatch(shared.match(/\.list-scroller\s*\{([^}]*)\}/)?.[1] ?? '', /padding-inline:/,
    '.list-scroller darf kein padding-inline setzen: wo der Spalten-Träger sitzt, ist pro Tab verschieden');

  // Die Kappung aufs Lesemaß sitzt an den KINDERN des Scrollers, nicht am
  // Scroller selbst (PR #614). Die Begründung dafür stand bisher nur als
  // Kommentar im CSS.
  //
  // Gescannt wird JEDE Regel JEDER Stylesheet-Datei, nicht der erste Textblock
  // je Selektor. Zwei Wege führen sonst am Guard vorbei: ein zweiter Block
  // hinter einem Breakpoint, und das Modul-CSS, das später lädt und auf
  // demselben Element sitzt (`class="list-scroller items-list"`).
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
  // Seit das Lesemass an der SEITE haengt (`--page-measure`, layout.css), steht
  // an den Traegern die Variablenform mit der Konstante als Rueckfall. Sie ist
  // dieselbe Zusicherung: faellt die Rolle weg, greift der Rueckfall, und die
  // Kappung ist damit genauso unbedingt wie vorher.
  const NARROW_VAR = `var(--page-measure, ${NARROW})`;
  const istLesemass = (wert) => wert === NARROW || wert === NARROW_VAR;
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
  // Geprüft wird der LETZTE Compound, damit auch `.list-scroller#items-list`,
  // `.list-scroller:hover` und `:is(.list-scroller)` als Treffer gelten -
  // `.list-scroller .row` dagegen nicht.
  //
  // `:not(…)` und `:has(…)` fallen vorher weg, und zwar VOR dem Zerlegen:
  // beide nennen die Klasse, ohne dass die Regel sie stylt. `.page:has(
  // .list-scroller)` gestaltet den Vorfahren, nicht den Scroller - dort rot zu
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
  const scrollerTokens = new Set(['.list-scroller']);
  for (const page of ['shopping', 'pantry', 'recipes']) {
    const src = read(`../public/pages/${page}.js`);
    const combos = [...src.matchAll(/class(?:Name)?\s*=\s*(['"`])([^'"`]*\blist-scroller\b[^'"`]*)\1/g)];
    assert.ok(combos.length > 0,
      `${page}.js hängt seine Klasse nicht mehr literal an .list-scroller - dieser Scan findet sie dann nicht und prüft den Scroller des Tabs ungewollt gar nicht`);
    combos.forEach(([, , combo]) => combo.trim().split(/\s+/).forEach((cls) => scrollerTokens.add(`.${cls}`)));

    // Und über die ID, die alle drei Scroller tragen: `#recipes-list` trifft
    // dasselbe Element, ohne eine seiner Klassen zu nennen. Keine ID im
    // Markup heißt umgekehrt, dass kein ID-Selektor es treffen kann - deshalb
    // ist hier nichts zu fordern, nur einzusammeln.
    const inTag = (src.match(/<[^>]*\blist-scroller\b[^>]*>/g) ?? [])
      .map((tag) => tag.match(/\bid="([^"]+)"/)?.[1]);
    const nextToClassName = [...src.matchAll(
      /(\w+)\.className\s*=\s*['"`][^'"`]*\blist-scroller\b[^'"`]*['"`];\s*\1\.id\s*=\s*['"`]([^'"`]+)/g)]
      .map(([, , id]) => id);
    [...inTag, ...nextToClassName].filter(Boolean).forEach((id) => scrollerTokens.add(`#${id}`));

    // Inline-Styles stehen in keiner der gescannten Dateien und schlagen
    // trotzdem jede Regel darin. Der Scroller wird im JS gebaut, also muss
    // der Scan dort nachsehen - an derselben Variablen, die die Klasse bekommt,
    // und im Tag, das sie im Markup trägt.
    for (const [, variable] of src.matchAll(/(\w+)\.className\s*=\s*['"`][^'"`]*\blist-scroller\b/g)) {
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
    (src.match(/<[^>]*\blist-scroller\b[^>]*>/g) ?? []).forEach((tag) => {
      assert.doesNotMatch(tag, /\sstyle\s*=/,
        `${page}.js gibt dem Scroller ein style-Attribut - Inline-Stile schlagen jede Regel im Stylesheet`);
    });
  }
  assert.ok(rulesFor('.list-scroller').length > 0,
    '.list-scroller ist nirgends definiert: ein leerer Treffer darf hier nicht still grün bleiben');
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
  //    Scrollers sein kann: .list-group bei gruppierten Tabs (Einkauf,
  //    Vorrat), .list-rows ungruppiert (Rezepte). Fehlt sie an einem der
  //    beiden, läuft der betroffene Tab bildschirmbreit - und ein zweiter
  //    Block darf sie auch nicht auf einen abweichenden Wert ziehen.
  for (const cls of ['.list-group', '.list-rows']) {
    const rules = rulesFor(cls);
    // Unbedingt heißt dreierlei: nicht hinter einem Breakpoint, nicht an einen
    // Zustand gebunden, und nicht an einen Vorfahren geknüpft.
    // `.list-rows:hover` kappt nur unter dem Mauszeiger;
    // `.shopping-page .list-rows` kappt die Rezeptliste gar nicht, obwohl
    // der Selektor die Klasse nennt und dieser Scan ihn findet.
    // Anders als in targets() bleiben :not() und :has() hier STEHEN. Dort
    // sagen sie nur, dass die genannte Klasse nicht das Subjekt ist; hier
    // sagen sie, dass die Kappung an eine Bedingung geknüpft ist -
    // `.list-rows:not(.uncapped)` lässt jede Zeile mit dieser Klasse
    // ungekappt. `:is()`/`:where()` gehören zum Subjekt: Inhalt behalten.
    const plain = (sel) => {
      const bare = sel.replace(/:(?:is|where)\(([^)]*)\)/g, '$1');
      return !/:/.test(bare) && !/[\s>+~,]/.test(bare);
    };
    assert.ok(rules.some(({ body, conditional, selectors }) =>
      !conditional && selectors.some(plain) && istLesemass(declaredValue(body, MAX_WIDTH))),
    `${cls} muss das Lesemaß UNBEDINGT tragen: eine Kappung hinter einem Breakpoint, an einem Zustand (:hover) oder unter einem Vorfahren (.foo ${cls}) greift nicht in jedem Kontext, in dem das Element gerendert wird`);
    for (const { file, body } of rules) {
      // Eine feste Breite schlägt die Kappung, ohne sie anzufassen: mit
      // `width: 20rem` bleibt das max-width korrekt stehen und die Liste steht
      // trotzdem schmal. Prozentwerte und `auto` sind unschädlich - sie messen
      // den (ungekappten) Scroller, und das max-width begrenzt weiter.
      const definite = declaredValue(body, ['width', 'inline-size']);
      assert.ok(definite === null || definite === 'auto' || definite === '100%',
        `${file}: ${cls} bekommt hier eine feste Breite (${definite}) - gekappt wird über max-width, sonst steht die Liste unabhängig vom Lesemaß schmal`);

      // Dasselbe ohne Breitenangabe: als Grid-Item von .list-scroller füllt das
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
      assert.ok(istLesemass(width),
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
  //    bevor .list-scroller den Überlauf je sieht. Gemessen an einer Rezeptliste
  //    mit 50 gespiegelten Einträgen: scrollHeight 3249px gegen clientHeight
  //    657px, kein Scrollbalken, kein Weg an die übrigen Zeilen. Harmlos ist
  //    das nur, solange mehrere kurze Gruppen dieselbe Spur teilen.
  //
  //    Der Scan bleibt auf list-row.css, wo die geteilten Bausteine
  //    definiert werden. Andere Module kappen mit demselben Token Elemente, die
  //    nie Grid-Item dieses Scrollers werden (shopping.css die Eingabezeile,
  //    layout.css den Leerzustand) - für die wäre `align-self: start` falsch.
  //    Innerhalb dieser Datei gilt dieselbe Einschränkung für .list-bulkbar:
  //    sie steht ÜBER dem Scroller (siehe dort) und trägt das Lesemaß, clippt
  //    aber nicht. Käme dort ein `overflow: hidden` dazu, meldet dieser Guard
  //    einen Fall, den ein Mensch entscheiden muss.
  //    Kombiniert wird über REGELGRENZEN hinweg: der Browser sammelt die
  //    Deklarationen aller passenden Regeln, bevor er den Wert bestimmt.
  //    Stünden Kappung und `overflow` in zwei getrennten Blöcken, sähe eine
  //    Prüfung pro Block in keinem von beiden ein gekapptes, clippendes
  //    Element - und genau das ist es.
  //    Gruppiert wird nach dem ELEMENT, nicht nach dem Selektortext: `.list-rows`
  //    und `ul.list-rows` treffen dasselbe `ul`, stünden als zwei Einträge
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
  //    `.context-a .list-rows { overflow: hidden }` und
  //    `.context-b .list-rows { align-self: start }` im selben Topf,
  //    obwohl kein Element je beide Regeln sieht - der Guard hielte das
  //    Clipping für ausgeglichen, das es in Kontext A nicht ist.
  const contextOf = (selector) => {
    const parts = selector.replace(/:(?:is|where)\(([^)]*)\)/g, '$1').trim().split(/[\s>+~]+/);
    return parts.slice(0, -1).join(' ');
  };
  // Der Zustand des Subjekts gehört ebenfalls zum Schlüssel: sonst gliche
  // `.list-rows:hover { align-self: start }` eine Lücke aus, die im
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
    if (!istLesemass(declaredValue(body, MAX_WIDTH))) continue;
    // `clip` kappt wie `hidden`, nur ohne Scrollport - und die Block-Achse
    // lässt sich auch als Langform setzen. Der Grund für die Zusicherung ist
    // das Abschneiden, nicht die eine Schreibweise dafür.
    const overflow = declaredValue(body, ['overflow', 'overflow-y', 'overflow-block']);
    if (overflow === null || !/\b(?:hidden|clip)\b/.test(overflow)) continue;
    assert.equal(declaredValue(body, ALIGN_SELF), 'start',
      `${selectors.join(', ')} kappt aufs Lesemaß und clippt zugleich, ist also ein gekapptes Kind des Scroller-Grids: ohne align-self: start schneidet es den Überlauf ab, bevor .list-scroller ihn sieht`);
  }

  // Und kein später geladenes Modul-Stylesheet biegt den Wert wieder um -
  // auch nicht über die Kurzschreibweise place-self.
  for (const { file, body } of rulesFor('.list-rows')) {
    const align = declaredValue(body, ALIGN_SELF);
    if (align === null) continue;
    assert.equal(align, 'start',
      `${file}: .list-rows bekommt hier ein anderes align-self - genau der Rückfall, den die Regel darüber verhindert`);
  }

  // 4. Die BEIDEN Träger tragen DASSELBE Lesemaß.
  //
  //    `.list-rows` trug es, `.row-carrier` nicht - mit der ausgeschriebenen
  //    Begründung, die Listen ausserhalb der Küche seien nun einmal breiter.
  //    Das war eine Beschreibung des Bestands: gemessen bei 1440px stand die
  //    Aufgabenliste auf 720px und die Kontaktliste auf 1156px, also sprang die
  //    Inhaltsspalte beim Modulwechsel um 436px (Critique 2026-08-13).
  //    Welche der beiden Klassen eine Zeilenfolge trägt, ist eine Frage ihrer
  //    Verschachtelung; ihre Breite ist es nicht.
  for (const carrier of ['.list-rows', '.row-carrier']) {
    const body = scopedRules(shared)
      .filter(({ selectors }) => selectors.some((s) => s.trim() === carrier))
      .map(({ body: part }) => part).join(';');
    assert.ok(istLesemass(declaredValue(body, MAX_WIDTH)),
      `${carrier} muss auf dasselbe Lesemaß kappen wie der andere Träger - zwei Zahlen sind ein sichtbarer Sprung beim Modulwechsel, keine zwei Grammatiken`);
  }
});

/**
 * Der Kopf fluchtet mit dem Körper, den er überschreibt - AUCH wenn der Körper
 * die Ansicht wechselt.
 *
 * `.page-toolbar--narrow` zieht das Zeilenende des Kopfes auf das Lesemaß
 * (layout.css). Steht der Modifier fest im Markup einer Seite, die zwischen
 * einer gekappten und einer breiten Ansicht umschaltet, dann stimmt er in genau
 * einer der beiden: gemessen auf /tasks bei 1440px endete der Kopf im Kanban
 * bei x=972, das Board aber bei x=1408 - derselbe Versatz wie vorher, nur
 * andersherum.
 *
 * Die Kopplung ist deshalb: wer den Modifier setzt UND einen Ansichtsumschalter
 * hat, muss ihn beim Wechsel pflegen. Eine Regel, keine Allowlist - die nächste
 * Seite mit zwei Ansichten fällt genauso hinein.
 */
/**
 * Wer eine Sammelaktions-Pille zeigt, gibt seinem Scrollport den Nachlauf.
 *
 * Die Pille ist eine fixierte Shell-Flaeche ueber der Liste und verdeckt am
 * Scroll-Ende sonst genau die Zeilen, auf die sie sich bezieht. Der Nachlauf
 * dafuer stand an `.app-content` - und dort scrollt bei keinem der drei Module
 * mit Pille etwas: Einkauf und Vorrat scrollen in `.list-scroller`, die
 * Kontakte in `.contacts-list`. Gemessen blieben 16.334px² verdeckte
 * Zeilenflaeche auf /contacts und 16.732px² auf /shopping, waehrend die Regel
 * im Quelltext aussah, als taete sie ihre Sache (Critique 2026-08-13).
 *
 * Geprueft wird die KOPPLUNG, nicht eine Liste von Modulen: jede Seite, die
 * `setBulkPill` aufruft, muss die Rolle `has-bulk-safe-zone` vergeben. Damit
 * waechst die Zusicherung mit dem naechsten Modul mit, statt es zu vergessen.
 */
/**
 * Das Lesemass ist eine Eigenschaft der SEITE, nicht des Traegers.
 *
 * Es hing an `.list-rows` und `.row-carrier`, also an der untersten Schicht,
 * und galt damit fuer den Koerper und fuer nichts sonst. Gemessen bei 1440px
 * lag die Filterreihe der Kontakte 489px, der Gruppierungsschalter der Aufgaben
 * 434px und die Monatsnavigation des Budgets 436px rechts neben der Liste, auf
 * die sie wirken - sieben von zehn Routen ohne gemeinsame rechte Kante
 * (Critique 2026-08-13, zweite Runde). Der Fix davor hatte genau eine Schicht
 * erreicht, die angedockte Primaeraktion.
 *
 * Geprueft wird die Kopplung an beiden Enden: die Rolle setzt die Variable, die
 * Traeger lesen sie, und wer eine Zeilenliste UND einen eigenen Modul-Root hat,
 * traegt die Rolle auch.
 */
test('das Lesemass haengt an der Seite, nicht am Traeger', () => {
  const layout = read('../public/styles/layout.css');
  const shared = read('../public/styles/list-row.css');

  assert.match(layout, /\.(?:page-measure--narrow|app-page--reading)\s*\{[\s\S]*?--page-measure:\s*var\(--layout-reading\)/,
    'die Rolle muss die Variable setzen - sonst liest der Rest hier nichts');

  // Die Traeger lesen die Variable, mit der alten Konstante als Rueckfall.
  for (const carrier of ['.list-group', '.list-rows', '.row-carrier']) {
    const at = shared.indexOf(`\n${carrier} {`);
    assert.ok(at !== -1, `${carrier} muss es geben`);
    const body = shared.slice(at, shared.indexOf('\n}', at));
    assert.match(body, /max-width:\s*var\(--page-measure,\s*var\(--content-max-width-narrow\)\)/,
      `${carrier} muss das Lesemass der SEITE lesen, mit der Konstante als Rueckfall`);
  }

  // Und jede Seite, die eine Zeilenliste zeigt, traegt die Rolle - oder hat
  // einen ausgeschriebenen Grund, es nicht zu tun. Der Scan geht ueber die
  // Seiten, die `.list-row` rendern; Dokumente ist die benannte Ausnahme
  // (zweispaltig, Begruendung im Quelltext).
  const ZWEISPALTIG = /ZWEISPALTIG/;
  for (const page of walkJsFiles('../public/pages/')) {
    const src = read(page);
    if (!/class="[^"]*\blist-row\b/.test(src)) continue;
    if (ZWEISPALTIG.test(src)) continue;
    // Calendar agenda toggles reading measure per view (is-reading-measure).
    if (/is-reading-measure/.test(src) && /app-page--full|data-composition="full"/.test(src)) continue;
    assert.match(src, /page-measure--narrow|app-page--(?:reading|data|dashboard|form)|data-composition="(?:reading|data|dashboard|form)"|mode:\s*'(?:reading|data|dashboard|form)'|renderAppPage\s*\(/,
      `${page}: zeigt eine Zeilenliste, traegt das Lesemass der Seite aber nicht - `
      + 'Kopf und Bedienzeilen enden dann neben ihrem eigenen Koerper');
  }
});

test('wer eine Pille zeigt, markiert seinen Scrollport', () => {
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.page-scrollport[^{]*\{[^}]*padding-block-end:[^;]*--shell-tail/,
    'die Rolle muss den Nachlauf auch wirklich setzen - sonst prueft der Rest hier eine Klasse ohne Wirkung');

  for (const page of walkJsFiles('../public/pages/')) {
    const src = read(page);
    if (!/\bsetBulkPill\s*\(/.test(src)) continue;
    assert.match(src, /page-scrollport/,
      `${page}: zeigt eine Sammelaktions-Pille, markiert aber seinen Scrollport nicht - `
      + 'sie verdeckt dann am Listenende die Zeilen, auf die sie sich bezieht');
  }
});

/**
 * Und sie steht NUR dort - der Ersatz raeumt seinen Vorgaenger weg.
 *
 * Die Regel darueber kam 2026-08-13, weil die Pillenzone an `.app-content`
 * bei keinem der drei Module etwas ausrichtete. Entfernt wurde die alte dabei
 * nicht, und weil beide fuer sich richtig aussehen, fiel sieben Tage lang
 * niemandem auf, dass jedes Modul mit Pille sie zweimal zahlt: einmal als
 * Nachlauf IM Scrollport (wirksam) und einmal als toter Streifen darunter
 * (76px bei 1440x900 und 1680x1050, 80px bei 390x844, in allen drei Modulen
 * gleich, gemessen 2026-08-20).
 *
 * Geprueft wird die Abwesenheit an der Box, die NICHT scrollt. Das ist die
 * Gegenrichtung zum Guard darueber: der sagt „die Zone muss am Scrollport
 * stehen", dieser sagt „und sonst nirgends". Ein Guard, der nur das
 * Vorhandensein prueft, ist gegen doppelt gemoppelt blind - genau das ist hier
 * passiert.
 */
/**
 * Wer seinen eigenen Scrollport mitbringt, markiert ihn - app-weit.
 *
 * Die App hat zwei Scrollport-Architekturen, und die Nachlauf-Regel in
 * layout.css unterscheidet sie ueber `.page-scrollport`. Faellt die Rolle bei
 * einer Seite aus, greift die Regel dort an `.app-content` - also an der Box,
 * die den Scrollport ENTHAELT statt an ihm. Das Padding verkuerzt dann den
 * Scrollport, statt am Inhaltsende zu reiten: Sichtflaeche weg, und der
 * Streifen darunter scrollt nicht mit. Genau dieser Defekt lief von 2026-08-12
 * bis 2026-08-20, erst nur beim Install-Banner, dann doppelt bei der Pille.
 *
 * DAS KRITERIUM IST DER MODUL-ROOT, nicht eine Liste von Modulnamen: wer
 * `height: 100%` UND `overflow: hidden` an seiner `*-page`-Regel traegt, kann
 * nicht selbst scrollen und hat folglich ein Kind, das es tut. Damit waechst
 * die Zusicherung mit dem naechsten Modul mit, statt es zu vergessen.
 */
test('wer seinen eigenen Scrollport mitbringt, markiert ihn', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);

  // 1. Alle Seiten mit eigenem Scrollport, aus den Stylesheets gelesen.
  const eigenerPort = [];
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      const selector = rule.selector.trim();
      // Nur der Modul-Root selbst: `.notes-page`, nicht `.notes-page .foo` und
      // nicht `.document-viewer__pdf-page` (eine PDF-Seite, kein Modul).
      if (!/^\.[a-z-]+-page$/.test(selector)) continue;
      if (!/height:\s*100%/.test(rule.body)) continue;
      if (!/overflow:\s*hidden/.test(rule.body)) continue;
      eigenerPort.push(selector.slice(1));
    }
  }
  assert.ok(eigenerPort.length >= 8,
    `es muessen mindestens die acht bekannten Seiten mit eigenem Scrollport gefunden werden, `
    + `gefunden: ${eigenerPort.join(', ')}`);

  // 2. Und jede von ihnen vergibt die Rolle in der Datei, die sie rendert.
  const seiten = walkJsFiles('../public/pages/').map((f) => ({ f, src: read(f) }));
  for (const root of new Set(eigenerPort)) {
    const traeger = seiten.filter(({ src }) => src.includes(root));
    assert.ok(traeger.length > 0, `kein public/pages/*.js rendert ${root}`);
    for (const { f, src } of traeger) {
      assert.match(src, /page-scrollport/,
        `${f}: rendert ${root} (height:100% + overflow:hidden, scrollt also nicht selbst), `
        + 'vergibt die Rolle page-scrollport aber nicht - der Nachlauf der fixierten '
        + 'Shell-Flaechen landet dann an .app-content und verkuerzt den Scrollport, '
        + 'statt am Inhaltsende zu reiten');
    }
  }
});

/**
 * Und die Rolle sitzt an etwas, das wirklich scrollt.
 *
 * Die Gegenrichtung zum Guard darueber: eine Klasse, die an einer Box klebt,
 * die gar keinen Ueberlauf hat, legt den Nachlauf ins Leere und sieht dabei
 * genauso richtig aus wie eine, die ihre Sache tut.
 */
/**
 * Und ein Scrollport nennt sein Bodenpolster nicht selbst.
 *
 * DIE ACHTE KOPIE. 2026-08-12 wurden sieben `padding-bottom: *-fab-clearance`
 * in vier Dateien abgeschafft und ein Guard dagegen gesetzt - er sucht nach
 * Eigenbau-TOKENS. Eine achte ueberlebte trotzdem, in calendar.css:
 *
 *   padding: var(--space-2) var(--space-4) calc(var(--space-16) + var(--space-4));
 *
 * Kein Token beim Namen, nur der dritte Wert eines Shorthands - 80px Reserve
 * fuer einen FAB, der in der Agenda am Zeiger ausgeblendet ist. Der alte Guard
 * konnte sie nicht sehen, weil er die falsche Sache suchte: nicht das Token ist
 * das Problem, sondern dass ein Scrollport seinen Bodenfreiraum ueberhaupt
 * selbst festlegt.
 *
 * Geprueft wird deshalb die BAUART: an einem Scrollport ist der dritte Wert
 * eines `padding`-Shorthands verboten, ebenso ein eigenes `padding-bottom`.
 * Sein Bodenpolster gehoert in `--scrollport-pad`, damit `.page-scrollport`
 * den Shell-Nachlauf DARAUF legen kann statt ihn zu ersetzen. Die Zwei-Wert-
 * Form (`padding: a b`) bleibt erlaubt: sie meint die Achsen, und die Rolle
 * ueberschreibt ihren Boden ohnehin.
 */
test('ein Scrollport nennt seinen Bodenfreiraum nicht selbst', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);

  const markiert = new Set();
  for (const file of walkJsFiles('../public/pages/')) {
    for (const m of read(file).matchAll(/["'`]([^"'`]*\bpage-scrollport\b[^"'`]*)["'`]/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls && cls !== 'page-scrollport' && /^[a-z][\w-]*$/.test(cls)) markiert.add(cls);
      }
    }
  }

  const verstoesse = [];
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      // Nur Regeln, deren LETZTES Glied ein markierter Scrollport ist - eine
      // Regel auf ein Kind darin (`.agenda-view .agenda-day`) polstert das Kind.
      const letztes = rule.selector.trim().split(/\s+/).pop() || '';
      const klassen = [...letztes.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]);
      if (!klassen.some((c) => markiert.has(c))) continue;

      for (const decl of rule.body.matchAll(/(^|[;{])\s*(padding(?:-bottom|-block-end)?)\s*:([^;]*)/g)) {
        const [, , prop, wert] = decl;
        if (prop !== 'padding') {
          verstoesse.push(`${file}: ${rule.selector.trim()} → ${prop}:${wert.trim()}`);
          continue;
        }
        // Werte zaehlen, ohne calc(...)/var(...) mit ihren Leerzeichen zu zerlegen.
        const teile = wert.trim().replace(/\b(?:calc|var|min|max|clamp)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, 'X').split(/\s+/).filter(Boolean);
        if (teile.length >= 3) {
          verstoesse.push(`${file}: ${rule.selector.trim()} → padding mit ${teile.length} Werten (${wert.trim()})`);
        }
      }
    }
  }

  assert.deepStrictEqual(verstoesse, [],
    'diese Scrollports legen ihren Bodenfreiraum selbst fest, statt ihn als '
    + '--scrollport-pad anzumelden. Genau so ueberlebte die achte FAB-Reserve den '
    + `Umbau von 2026-08-12: ${verstoesse.join(' | ')}`);
});

test('die Scrollport-Rolle sitzt an einer Box mit Ueberlauf', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);

  // Jede KLASSENGRUPPE, in der `page-scrollport` steht - nicht jede Klasse
  // einzeln. Die Scroll-Achse liegt am geteilten Baustein (`.list-scroller`,
  // `.budget-tab-panel`), waehrend `items-list` oder `--loans` nur benennen,
  // welche Liste es ist. Eine Pruefung je Klasse verlangte von jedem Namen
  // seine eigene Achse und waere an genau diesen Namen zerbrochen.
  const gruppen = [];
  for (const file of walkJsFiles('../public/pages/')) {
    for (const m of read(file).matchAll(/["'`]([^"'`]*\bpage-scrollport\b[^"'`]*)["'`]/g)) {
      const klassen = m[1].split(/\s+/).filter((c) => /^[a-z][\w-]*$/.test(c) && c !== 'page-scrollport');
      if (klassen.length) gruppen.push({ file, klassen });
    }
  }
  assert.ok(gruppen.length >= 10, `zu wenige markierte Scrollports gefunden: ${gruppen.length}`);

  const scrollend = new Set();
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/overflow(-y)?:\s*(auto|scroll)/.test(rule.body)) continue;
      for (const cls of rule.selector.matchAll(/\.([a-z][\w-]*)/g)) scrollend.add(cls[1]);
    }
  }
  const blind = gruppen
    .filter(({ klassen }) => !klassen.some((c) => scrollend.has(c)))
    .map(({ file, klassen }) => `${file}: ${klassen.join('.')}`);
  assert.deepStrictEqual(blind, [],
    'diese Markierungen tragen page-scrollport, aber keine ihrer Klassen hat eine '
    + `Scroll-Achse - die Rolle legt dort einen Nachlauf ins Leere: ${blind.join(' | ')}`);
});

test('die Pillenzone steht nur am markierten Scrollport', () => {
  const layout = read('../public/styles/layout.css').replace(/\/\*[\s\S]*?\*\//g, '');

  // Jede Regel, deren Selektor auf `.app-content` endet und ein Padding aus
  // einer der drei Zonen setzt. Geprueft werden alle drei und nicht nur die
  // Pille: der Defekt ist die BAUART, nicht die Flaeche - der Install-Banner
  // machte 2026-08-19 exakt denselben Fehler auf demselben Selektor.
  //
  // `.app-content:not(:has(.page-scrollport))` ist ausgenommen und ist das
  // Gegenteil des Defekts: dieser Selektor sagt ausdruecklich „nur, wenn die
  // Seite KEINEN eigenen Scrollport mitbringt" - dann ist .app-content der
  // Scrollport und der Nachlauf gehoert ihm.
  const ZONEN = /--(?:fab-safe-zone|bulk-pill-safe-zone|install-prompt-tail|shell-tail)/;
  const treffer = [];
  for (const m of layout.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!/\.app-content\s*$/.test(selector)) continue;
    if (/:not\(:has\([^)]*\.page-scrollport[^)]*\)\)\s*$/.test(selector)) continue;
    if (!/padding/.test(m[2]) || !ZONEN.test(m[2])) continue;
    treffer.push(selector);
  }

  assert.deepStrictEqual(treffer, [],
    'diese Regeln polstern .app-content mit einer Shell-Zone, ohne den Fall '
    + 'auszuschliessen, in dem die Seite ihren eigenen Scrollport mitbringt. Dort '
    + 'scrollt .app-content nicht, das Padding verkuerzt den echten Scrollport und '
    + `wird zum toten Band darunter: ${treffer.join(', ')}`);
});

test('ein Kopf mit --narrow pflegt ihn beim Ansichtswechsel', () => {
  for (const page of walkJsFiles('../public/pages/')) {
    const src = read(page);
    if (!src.includes('page-toolbar--narrow')) continue;
    // Ein Umschalter im Sinne dieser Regel wechselt den KÖRPER, nicht einen
    // Filter: er trägt `data-view` und schreibt seinen Wert in den Zustand.
    if (!/data-view/.test(src) || !/viewMode|state\.view\b/.test(src)) continue;
    assert.match(src, /classList\.toggle\(\s*'page-toolbar--narrow'/,
      `${page}: setzt --narrow und wechselt die Ansicht, pflegt den Modifier aber nicht mit - in einer der beiden Ansichten endet der Kopf dann neben seinem eigenen Körper`);
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
  //
  // WO SIE UEBERHAUPT NOCH GILT, IST SEIT 2026-08-10 EINE FRAGE DER LEISTE.
  // Solange der FAB ueber dem Scrollport schwebte, war die Zone der einzige
  // Weg, die #634-Zusicherung zu halten - und sie kostete auf dem Telefon 92px
  // ueber die volle Breite (11 % des Geraets). Sitzt er dagegen IN der
  // Nav-Kapsel, steht unter ihm Chrome statt Inhalt, und dieselbe Zusicherung
  // haelt ohne reservierten Streifen. Beides wird hier geprueft, weil beides
  // gleichzeitig gilt: Desktop schwebend MIT Zone, mobil eingesetzt OHNE.
  assert.match(tokens, /--fab-safe-zone:\s*calc\([^;]*--fab-gap[^;]*--fab-size[^;]*;/,
    'der SCHWEBENDE Fall braucht seine Zone weiter, abgeleitet aus --fab-gap und --fab-size');
  assert.match(
    tokens,
    /@media\s*\(max-width:\s*1023px\)\s*\{\s*:root\s*\{[^}]*--fab-safe-zone:\s*0px/,
    'wo die Bottom-Nav steht, faellt --fab-safe-zone auf 0 - der FAB sitzt dort in der Kapsel'
  );
  // Der eingesetzte FAB rechnet aus der Kapselgeometrie, nicht aus --fab-gap:
  // er soll in der Bar-Zeile ZENTRIERT sitzen, und das haengt an der Barhoehe
  // und an seiner eigenen Groesse.
  assert.match(
    tokens,
    /--fab-offset-bottom:\s*calc\([^;]*--nav-height-mobile[^;]*--fab-size[^;]*\)/s,
    'der eingesetzte FAB zentriert sich aus --nav-height-mobile und --fab-size'
  );
  // Und die Kapsel macht ihm denselben Platz frei, aus derselben Groesse -
  // sonst stuende der Knopf halb auf dem letzten Tab.
  assert.match(
    layout,
    /\.nav-bottom__items\s*\{[^}]*padding-inline-end:\s*calc\(var\(--fab-size\)/,
    'die Nav-Kapsel muss ihr hinteres Ende aus --fab-size freihalten'
  );
  // PADDING, NICHT MARGE - seit 2026-08-12, und der Wechsel ist eine Korrektur
  // der Invariante, nicht des Mechanismus. Die Marge verkuerzte den Scrollport um
  // 96px ueber die volle Breite und sicherte damit „bei KEINEM Scrollstand liegt
  // etwas Bedienbares unter dem Knopf" zu. Notwendig ist „nichts ist
  // UNERREICHBAR", und der gemessene Schaden lag beide Male am SCROLL-ENDE. Dort
  // legt der Nachlauf leeren Raum unter den Knopf; mitten im Scrollen laesst sich
  // Inhalt unter ihm wegschieben. Der Preis der Strenge war das
  // Dashboard-Raster, das 96px ueber der Fensterkante abbrach.
  //
  // Die Marge darf nicht zurueckkommen: sie ist das eine, was die Sichtflaeche
  // kostet.
  // SEIT 2026-08-20 IST DIE FAB-ZONE EIN SUMMAND, KEIN FERTIGES PADDING.
  // Hier stand die Forderung, sie als `padding-block-end` an `.app-content` zu
  // finden - und genau diese Bauart war der Defekt: bei den acht Seiten mit
  // eigenem Scrollport verkuerzt ein Padding dort die Bezugshoehe des
  // Modul-Roots, statt am Inhaltsende zu reiten. Der Nachlauf haengt jetzt an
  // `.page-scrollport`; die FAB-Zone erreicht ihn als `--fab-tail`.
  //
  // Geprueft wird die KETTE, weil jedes Glied fuer sich harmlos aussieht: die
  // Bedingung setzt den Summanden, die Summe zaehlt ihn, die Regel legt sie an.
  assert.match(layout, /:has\([^)]*\.page-fab[^{]*\{[^}]*--fab-tail:\s*var\(--fab-safe-zone\)/,
    'die FAB-Zone muss unter der FAB-Bedingung zum Summanden --fab-tail werden');
  assert.match(layout, /--shell-tail:\s*calc\([^;]*--fab-tail[^;]*\)/,
    'und --fab-tail muss in der Summe --shell-tail auftauchen, sonst zaehlt ihn niemand');
  assert.match(layout, /\.page-scrollport[^{]*\{[^}]*padding-block-end:[^;]*--shell-tail/,
    'und --shell-tail muss als padding-block-end am Scrollport landen - am Scroll-Ende '
    + 'liegt damit leerer Raum unter dem Knopf, und der Scrollport bleibt porthoch');
  assert.doesNotMatch(layout.replace(/\/\*[\s\S]*?\*\//g, ''), /margin-block-end:\s*var\(--fab-safe-zone\)/,
    'die FAB-Zone darf den Scrollport nicht wieder verkuerzen (Marge statt Nachlauf): '
    + 'das schnitt das Dashboard-Raster 96px ueber der Fensterkante ab');

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
 * WER DEN FAB VERSTECKT, NIMMT IHM SEINEN NACHLAUF (Etappe 6, 2026-08-13).
 *
 * `--fab-safe-zone` haengt an `:has(.fab-layer .page-fab:not([hidden])) `. Das
 * ist ein STELLVERTRETER fuer „hier schwebt ein Knopf ueber dem Scrollport",
 * und er wird falsch, sobald CSS statt der Seite versteckt: der Knoten bleibt
 * ohne `hidden` stehen, der Selektor trifft, und der Nachlauf reserviert Platz
 * fuer eine Flaeche von 0x0. Gemessen bei 1440x900 auf sechs Routen (/tasks,
 * /calendar, /shopping, /contacts, /budget, /notes): 96px, auf /shopping 156
 * statt 60.
 *
 * DER GUARD PRUEFT DIE PAARUNG, NICHT DIE VIER STELLEN. Vier Regeln in drei
 * Dateien verstecken heute einen FAB, aus vier verschiedenen Gruenden - eine
 * Allowlist waere in dem Moment veraltet, in dem eine fuenfte dazukommt, und
 * genau so ist dieser Befund entstanden. Verlangt wird deshalb: zu jeder Regel,
 * die einen `.page-fab` per `display: none` versteckt, steht im selben
 * Stylesheet eine Regel derselben Bedingung, die `--fab-safe-zone` nullt.
 *
 * AUSGENOMMEN ist `.page-fab[hidden]` - dort deckt das `:not([hidden])` der
 * Nachlauf-Regel den Fall bereits ab. Das ist keine Ausnahme von der Regel,
 * sondern ihre andere Haelfte. Die Bedingung muss am FAB SELBST haengen: eine
 * erste Fassung schloss jeden Selektor aus, in dem `[hidden]` irgendwo vorkam,
 * und uebersah damit ausgerechnet die Dock-Regel
 * `body:has(.toolbar-new-btn:not([hidden])) …` - den Anlassfall.
 */
test('jede CSS-Ausblendung des FAB nullt seinen Nachlauf', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const versteckt = [];
  const nullt = [];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      const trifftFab = /\.page-fab\b|#fab-new-item\b/.test(selector);
      const nurHidden = /\.page-fab\[hidden\]|#fab-new-item\[hidden\]/.test(selector);
      if (trifftFab && /display:\s*none/.test(body) && !nurHidden) {
        versteckt.push({ file, selector: norm(selector) });
      }
      if (/--fab-safe-zone:\s*0/.test(body)) nullt.push({ file, selector: norm(selector) });
    }
  }

  // Reichweite zuerst: ein Guard ueber eine leere Liste ist keine Zusicherung.
  assert.ok(versteckt.length >= 4,
    `Reichweite: nur ${versteckt.length} Ausblende-Regeln gefunden - der Scanner greift nicht mehr`);

  // Die Bedingung ist der Selektor OHNE sein FAB-Ziel. Statt ihn zu zerlegen
  // (`:has()` haelt beliebige Klammern), wird die Verwandtschaft ueber die
  // Teilzeichenkette gepruefet: `body:has(.toolbar-new-btn:not([hidden]))` steckt in
  // `body:has(.toolbar-new-btn:not([hidden])) #fab-layer .page-fab`, und
  // `#fab-layer #fab-new-item` steckt in `body:has(#fab-layer #fab-new-item)`.
  const ohnePaar = versteckt.filter(({ file, selector }) => !nullt.some((z) =>
    z.file === file && (selector.includes(z.selector) || z.selector.includes(selector))));

  assert.deepEqual(ohnePaar.map((x) => `${x.file}: ${x.selector}`), [],
    'diese Regeln verstecken den FAB, ohne --fab-safe-zone zu nullen - dort reserviert '
    + 'der Nachlauf am Scroll-Ende Platz fuer einen Knopf ohne Flaeche');
});

/**
 * #634, dritte Runde: der FAB gehört nicht in den Scrollport.
 *
 * Nach Retract und Tastatur-Erkennung meldete derselbe Nutzer den Defekt ein
 * drittes Mal - in der PWA, ohne Adressleiste, ohne Tastatur. Was blieb, war der
 * Ort: der FAB ist `position: fixed`, hing aber im Modul-Root und damit INNERHALB
 * von `.app-content`, dem Container, der auf den meisten Routen scrollt. Ein
 * fixiertes Kind eines Scrollers ist auf iOS nicht verlässlich viewport-fest; es
 * wird gegen den gescrollten Inhalt aufgelöst und wandert mit der wachsenden
 * Liste aus dem Bild. Genau die Falle, die die Bottom-Nav schon aus
 * `position: fixed` geholt hatte - der FAB war das letzte fixierte Element, das
 * noch im Scrollport stand.
 *
 * Die Zusicherung ist der ORT, nicht der Weg dorthin: der FAB hängt in einer
 * Shell-Layer neben `.app-content`, und kein Stylesheet darf ihn wieder über
 * einen Modul-Kontext adressieren - eine solche Kette existiert nach dem Umzug
 * nicht mehr und wäre still wirkungslos.
 */
test('der Page-FAB hängt in der Shell, nicht im Scrollport', () => {
  const router = read('../public/router.js');
  const layout = read('../public/styles/layout.css');
  const styleDir = new URL('../public/styles/', import.meta.url);

  // 1. Die Layer ist ein Geschwister von .app-content, kein Kind.
  //
  // Auf die REIHENFOLGE geprüft, nicht auf die unmittelbare Nachbarschaft: die
  // Zusicherung ist „hinter dem Scrollport, vor der Nav", und das war sie schon
  // immer. Als wörtliches `main, fabLayer, bottomNav` schlug sie fehl, sobald
  // ein weiteres Shell-Kind dazwischen einsortiert wurde (der Pillen-Stapel,
  // Critique 2026-08-13) - eine Zusicherung, die eine Nachbarschaft festnagelt,
  // prüft die Nachbarschaft, nicht die Sache.
  assert.match(router, /shellNodes\s*=\s*\[[^\]]*\bmain\b\s*,[^\]]*\bfabLayer\b\s*,[^\]]*\bbottomNav\b/,
    'die FAB-Layer muss als Shell-Kind hinter dem Scrollport und vor der Bottom-Nav hängen (#634)');
  assert.match(layout, /\.fab-layer\s*\{[^}]*position:\s*absolute/,
    '.fab-layer braucht einen eigenen Kasten an der Shell-Ecke (#634)');

  // 2. Jede Seite zieht ihren FAB dorthin um - auch die, die ihn erst nach den
  //    Daten anlegt, und auch die Soft-Navigation zwischen Tabs.
  assert.ok((router.match(/adoptPageFab\(\)/g) ?? []).length >= 4,
    'adoptPageFab() muss definiert und an allen Renderpfaden aufgerufen werden (#634)');
  assert.match(router, /clearPageFab\(\)/,
    'der FAB der alten Seite muss mit ihrem Inhalt verschwinden, nicht später (#634)');

  // 3. Und niemand adressiert ihn wieder über einen Modul-Vorfahren. Das ist eine
  //    Regel über alle Stylesheets, keine Allowlist: erlaubt sind nur Wurzeln,
  //    die den Umzug überleben (Dokument, Shell, Layer).
  const ALLOWED_ROOT = /^(html|body|:root|\.app-shell|\.fab-layer|\.keyboard-visible)/;
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const live = read(`../public/styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of live.match(/[^{}]*\{[^}]*\}/g) ?? []) {
      const selectors = block.slice(0, block.indexOf('{')).split(',');
      for (const selector of selectors) {
        if (!selector.includes('.page-fab')) continue;
        const prefix = selector.slice(0, selector.indexOf('.page-fab')).trim();
        assert.ok(prefix === '' || ALLOWED_ROOT.test(prefix),
          `${file}: "${selector.trim()}" adressiert den FAB über einen Modul-Kontext - `
          + 'seit #634 hängt er in der Shell, die Kette greift nicht mehr');
      }
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
 *   2. Die zwei Abschluss-Aktionen wandern in die geteilte .list-bulkbar -
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
  const menuStart = page.indexOf("id: 'list-actions-menu'");
  assert.ok(menuStart > 0, 'das Überlaufmenü der Einkaufsliste ist nicht auffindbar - der Guard misst dann nichts');
  const items = page.slice(menuStart, page.indexOf('})}', menuStart));
  // Umbenennen kam 2026-08-11 dazu: es hing bis dahin als einzige Affordanz am
  // Listen-Titel im Kopf, und der Kopf ist entfallen (Titelwiederholung).
  for (const key of ['shopping.renameListLabel', 'shopping.importMeals', 'shopping.manageCategories', 'shopping.deleteListLabel']) {
    assert.ok(items.includes(`t('${key}')`), `das Überlaufmenü muss ${key} als Label führen`);
  }
  assert.match(items, /danger:\s*true/, '„Liste löschen" muss im Menü als destruktiv gekennzeichnet sein');

  // Der Trigger muss die Liste NENNEN. Er stand früher neben einer Überschrift,
  // die den Bezug herstellte; in der Chip-Leiste steht er allein, und ein bloßes
  // „Weitere Aktionen" ließe offen, worauf sich „Löschen" bezieht - das löscht
  // die Liste des ganzen Haushalts.
  assert.match(page, /label:\s*t\('shopping\.listActionsLabel',\s*\{\s*name:/,
    'der Menü-Trigger muss die gewählte Liste im zugänglichen Namen nennen');

  // EINE Fassung, nicht zwei. Hier standen zwei Assertions über
  // `.list-header__more` und `.list-header__inline-actions`: die drei Aktionen
  // lagen doppelt im DOM (Buttonleiste ab 768px, Menü darunter) und CSS blendete
  // je eine aus. Seit dem Wegfall des Kopfes gibt es nur noch das Menü, auf
  // allen Breiten - das Risiko doppelter Tabstops entsteht gar nicht erst.
  // Geprüft wird deshalb, dass die Doppelfassung nicht zurückkommt.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(cssNoComments, /\.list-header__(more|inline-actions)\s*\{/,
    'die responsive Doppelfassung der Listen-Aktionen ist entfallen - eine Darstellung auf allen Breiten');
  assert.doesNotMatch(page, /list-header__(more|inline-actions)/,
    'die responsive Doppelfassung der Listen-Aktionen ist entfallen - eine Darstellung auf allen Breiten');

  // Der Trigger klebt am Rand, während die Chips durchscrollen: ohne opaken
  // Grund liefe ein Chip sichtbar durch das Icon.
  assert.match(cssNoComments, /\.list-tabs-bar__actions\s*\{[^}]*position:\s*sticky/,
    'die Aktionszone muss am Rand der scrollenden Chip-Leiste stehenbleiben');
  assert.match(cssNoComments, /\.list-tabs-bar__actions\s*\{[^}]*background-color:/,
    'die sticky Aktionszone braucht einen opaken Grund, sonst scrollen Chips sichtbar darunter durch');

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

  // `common.moreActions` stand hier, solange der Einkauf ihn nutzte; sein
  // Trigger führt jetzt shopping.listActionsLabel (er muss die Liste nennen).
  // Den geteilten Key prüft weiterhin, wer ihn benutzt - aktuell recipes.js.
  assertKeysExistInEveryLocale([
    'shopping.listActionsLabel', 'shopping.checkedHint', 'shopping.checkedHint_one',
    // Der Vorrat trägt seit Etappe 5 dieselbe Rolle in der Pille: was „Alles"
    // umfasst. Sein früherer Satz („Diese Artikel sind aufgebraucht oder unter
    // dem Mindestbestand.") sagte, was der aktive Filterchip daneben schon
    // sagt, und ließ auf einer einzeiligen Fläche nur eine Ellipse übrig.
    'pantry.bulkPillLabel', 'pantry.bulkPillLabel_one',
  ]);
});

/**
 * Eine Sammelaktions-Leiste, zwei Tabs - und sie kostet die Liste nichts mehr.
 *
 * Der Vorrat hatte `.pantry-bulkbar`, der Einkauf zwei Buttons im Kopf; seit der
 * Küchen-Zusammenführung war es EIN Baustein über dem Scroller. Sein eigener
 * Preis stand nie in der Rechnung: gemessen 358x103px bei y=113 auf /shopping,
 * also 103 von 552px Listenfläche, ausgelöst von einem einzigen abgehakten
 * Artikel. Seit Etappe 5 ist die Leiste eine Pille in der unteren Shell-Zone.
 *
 * DREI ZUSAGEN, und jede hat ihren eigenen Anlass:
 *   1. EINE Schreibweise - der Baustein wohnt in der Shell, kein Modul baut ihn nach.
 *   2. EINZEILIG - ohne das war sie der Block von vorher in dunkel.
 *   3. Sie verdeckt am Scroll-Ende nichts - derselbe Defekt, den Sonde 18 für
 *      den FAB misst, und der FAB löst ihn seit #634 über einen Nachlauf.
 */
test('die Sammelaktions-Pille wohnt in der Shell und kostet die Liste keine Zeile', () => {
  const layout    = read('../public/styles/layout.css');
  const listRow   = read('../public/styles/list-row.css');
  const tokens    = read('../public/styles/tokens.css');
  const router    = read('../public/router.js');

  // --- 1. EINE Schreibweise -------------------------------------------------
  const bulkbarRules = [...eachRule(layout)].filter((r) => /^\.list-bulkbar\b/.test(r.selector.trim()));
  assert.ok(bulkbarRules.length,
    '.list-bulkbar gehört in die Shell-Schicht (layout.css), wo auch der Toast steht');

  // Über eachRule, nicht über die Datei: die Begründung des Umzugs nennt den
  // alten Wohnort beim Namen, und ein `doesNotMatch` über den Quelltext läse
  // den Kommentar als Regel (diese Falle hat in Etappe 4 einen Guard rot
  // gemacht, der recht hatte).
  for (const [file, css] of [
    ['list-row.css', listRow],
    ['pantry.css',   read('../public/styles/pantry.css')],
    ['shopping.css', read('../public/styles/shopping.css')],
  ]) {
    for (const rule of eachRule(css)) {
      assert.doesNotMatch(rule.selector, /\.list-bulkbar|\.pantry-bulkbar/,
        `${file} darf die Sammelaktions-Leiste nicht nachbauen - sie steht in layout.css`);
    }
  }

  for (const page of ['shopping', 'pantry']) {
    const src = read(`../public/pages/${page}.js`);
    assert.match(src, /from '\/utils\/bulk-pill\.js'/,
      `${page}.js muss die geteilte Shell-Oberfläche verwenden, nicht selbst rendern`);
    assert.match(src, /setBulkPill\(/, `${page}.js muss die Pille über setBulkPill setzen`);
    assert.match(src, /clearBulkPill\(/,
      `${page}.js muss die Pille wegnehmen, sobald es keine Teilmenge mehr gibt`);
    // Der Schnitt kommt aus `source-text.js` und laeuft dort bis zum Fixpunkt:
    // die Kette `.replace().replace()` liess bei verschachtelten Klammern ein
    // `<!--` stehen (CodeQL js/incomplete-multi-character-sanitization, high).
    // `test-budget-ui.js` hatte die Schleife samt Begruendung schon, diese
    // Datei die Kette ohne sie - dieselbe Kopie, andere Blindstelle.
    assert.doesNotMatch(withoutHtmlComments(withoutBlockComments(src)),
      /class="[^"]*\blist-bulkbar\b/,
      `${page}.js darf die Leiste nicht wieder in den Seitenfluss schreiben`);
  }

  // --- 1b. WO DAS SUBJEKT WEGFÄLLT, TRÄGT DIE AKTION DIE ZAHL --------------
  //
  // Anlass (Etappe 6, 2026-08-13, am Gerät gesehen): unter 21rem Pillenbreite
  // fällt `.list-bulkbar__subject` weg, und übrig blieben zwei Kapseln ohne
  // genanntes Objekt - über einer Liste mit 23 Artikeln, bei „Löschen" ohne
  // Rückfrage. Für einen Screenreader stimmte die alte Begründung („die Zahl
  // steht im aria-label"), für das Auge nicht.
  //
  // DIE ZUSICHERUNG IST EINE PAARUNG, KEIN KLASSENNAME: dieselbe Container-
  // Bedingung, die das Subjekt wegnimmt, muss die Marke einsetzen. Zwei
  // getrennte Grenzen wären genau die zweite Zahl daneben, die die Pille sich
  // schon einmal verboten hat.
  // Nicht über `bulkbarRules`: dessen `\b` nach `.list-bulkbar` trifft den
  // Unterstrich nicht, die BEM-Kinder fallen dort heraus.
  const subjektWeg = [...eachRule(layout)].filter((r) => /\.list-bulkbar__subject\b/.test(r.selector)
    && /display:\s*none/.test(r.body) && r.at.some((a) => /bulk-pill/.test(a)));
  assert.equal(subjektWeg.length, 1,
    'erwartet genau eine Container-Regel, die das Subjekt der Pille wegnimmt');
  const markeDa = [...eachRule(layout)].find((r) => /__action-count\b/.test(r.selector)
    && /display:\s*(inline|flex|inline-flex|inline-block)/.test(r.body));
  assert.ok(markeDa, 'ohne Subjekt muss die Zahl an der Aktion sichtbar werden');
  assert.deepEqual(markeDa.at, subjektWeg[0].at,
    'die Marke tritt unter GENAU der Bedingung ein, unter der das Subjekt geht - '
    + 'sonst stünde die Zahl irgendwo zweimal oder nirgends');

  // Und sie steht nur dort. Ausserhalb der Bedingung wäre sie das Echo der
  // Zahl, die das Subjekt zwei Zentimeter weiter links schon trägt.
  const markeBasis = [...eachRule(layout)].find((r) => r.selector.trim() === '.list-bulkbar__action-count' && !r.at.length);
  assert.ok(markeBasis && /display:\s*none/.test(markeBasis.body),
    'die Marke ist standardmässig weg - neben dem Subjekt wäre sie dessen Echo');

  // Die Seite muss sie an der Aktion setzen, bei der ein fehlendes Objekt teuer
  // ist. Geprüft an der Sache, nicht am Wort: die Kapsel mit dem `aria-label`
  // der Sammellöschung trägt sie.
  const shoppingSrc = read('../public/pages/shopping.js');
  const loeschAktion = shoppingSrc.match(/actions\.push\(\{[\s\S]*?clearChecked[\s\S]*?\n {2}\}\);/);
  assert.ok(loeschAktion, 'die Löschen-Aktion der Einkaufs-Pille nicht gefunden');
  // AUF EINER EIGENEN ZEILE, und das ist keine Formfrage. Eine erste Fassung
  // suchte `count:\s*checkedCount` irgendwo im Block - und fand es in der
  // t()-Interpolation des aria-labels (`{ count: checkedCount }`), die
  // ohnehin dasteht. Der Guard blieb bei entfernter Eigenschaft grün.
  assert.match(loeschAktion[0], /^\s*count:\s*checkedCount,\s*$/m,
    'die Löschen-Kapsel muss ihre Zahl als eigene Eigenschaft mitgeben - ohne Subjekt '
    + 'liest sich ein blosses „Löschen" über einer vollen Liste wie „die Liste löschen"');

  // --- 2. EINZEILIG per Konstruktion ---------------------------------------
  const pillBase = bulkbarRules.find((r) => r.selector.trim() === '.list-bulkbar' && !r.at.length);
  assert.ok(pillBase, '.list-bulkbar braucht eine Basisregel ohne At-Block');
  assert.doesNotMatch(pillBase.body, /flex-wrap:\s*wrap/,
    'ein Umbruch macht aus der Pille wieder den 103px-Block, den sie ersetzt');
  assert.match(pillBase.body, /min-height:\s*var\(--bulk-pill-height\)/,
    'die Pille muss die Höhe halten, mit der --bulk-pill-safe-zone rechnet');
  assert.match(tokens, /--bulk-pill-safe-zone:\s*calc\([^;]*--bulk-pill-height[^;]*\)/,
    'der Nachlauf leitet sich aus der Pillenhöhe ab und darf nicht davon wegdriften');

  // --- 3. Nachlauf am Scroll-Ende ------------------------------------------
  // HIER STAND EINE FORDERUNG NACH ZWEI REGELN an `.app-content` - eine mit
  // FAB, eine ohne, beide mit der Pillenzone als Summand. Sie stammte aus der
  // Zeit, als der Nachlauf dort stand, und ueberlebte den Umzug an
  // `.has-bulk-safe-zone` (2026-08-13) unveraendert: der Guard verlangte
  // seitdem genau die Regel, die der Umzug ersetzt hatte, und zementierte
  // damit den doppelten Abzug (Messung an der Regel in layout.css).
  //
  // Geprueft wird jetzt die Sache statt der alten Bauart: die Zone haengt an
  // der Rolle, und die Rolle haengt an einer Bedingung - ohne Pille kein
  // Nachlauf, sonst reservierte jede der drei Listen ihn dauerhaft.
  const pillenSummand = [...eachRule(layout)].filter((r) =>
    /--bulk-pill-tail:\s*var\(--bulk-pill-safe-zone\)/.test(r.body));
  assert.strictEqual(pillenSummand.length, 1,
    'die Pillenzone wird an GENAU EINER Stelle zum Summanden --bulk-pill-tail');
  assert.match(pillenSummand[0].selector, /:has\([^)]*\.list-bulkbar[^)]*\)/,
    'und nur, solange eine Pille da ist - sonst reserviert jeder Scrollport den '
    + 'Streifen auch dann, wenn nichts ausgewaehlt ist');
  assert.match(layout, /--shell-tail:\s*calc\([^;]*--bulk-pill-tail[^;]*\)/,
    'und der Summand muss in der Summe --shell-tail auftauchen, sonst zaehlt ihn niemand');

  // --- Der Stapel: Reihenfolge IST die Zusage ------------------------------
  // Die Spalte ist unten verankert, also steht oben, wer zuerst im DOM steht.
  // Stünde die Pille hinten, wanderte der TOAST - und der ist der mit der
  // Fünf-Sekunden-Frist. Gegengeprüft: mit `order: 9` auf der Pillen-Schicht
  // sprang der Toast von y=698 auf y=642.
  const stackAppend = router.match(/bottomStack\.append\(([^)]*)\)/);
  assert.ok(stackAppend, 'die Shell muss einen .shell-bottom-stack füllen');
  const order = stackAppend[1].split(',').map((s) => s.trim());
  assert.equal(order[0], 'bulkPillLayerEl',
    'die Pille steht ZUERST im Stapel, damit sie dem Toast ausweicht und nicht umgekehrt');
  assert.ok(order.length === 3 && order.every((n) => /toastContainer|bulkPillLayer/.test(n)),
    'in den Stapel gehören genau die Pillen-Schicht und die beiden Toast-Container');

  // Eine leere Zelle zieht trotzdem ihre `gap`-Lücke. Gegengeprüft: ohne diese
  // Regel stand ein einzelner Toast 8px zu hoch.
  const emptyRule = [...eachRule(layout)].find((r) => /\.shell-bottom-stack\s*>\s*:empty/.test(r.selector));
  assert.ok(emptyRule && /display:\s*none/.test(emptyRule.body),
    'leere Zellen des Stapels müssen aus dem Fluss - sonst verschiebt ihre Lücke den Toast');
});

/**
 * JEDE Pille, deren Subjekt wegfallen kann, gibt die Zahl an eine Kapsel weiter.
 *
 * Der Guard darüber prüfte den Einkauf beim Namen (`clearChecked`) - und das war
 * richtig für die Kapsel, die ohne Objekt gefährlich ist. Als der Vorrat
 * dieselbe Lücke bekam, deckte er sie nicht: seine Kapsel heisst „Alles auf die
 * Einkaufsliste", ein Quantor ohne Bezugswort, und keine Zeichenkette des alten
 * Guards kam darin vor. Zwei benannte Stellen wären eine Allowlist gewesen, und
 * die dritte Pille käme wieder ungedeckt.
 *
 * DIE REGEL HÄNGT AN DER PILLE, NICHT AN DER SEITE: wer `setBulkPill` aufruft,
 * baut eine Fläche, deren Subjekt unter 21rem verschwindet (layout.css) - also
 * muss in dieser Datei mindestens eine Aktion ihre Zahl mitgeben. Gefunden wird
 * das Aktions-Literal über sein `onClick`, per Klammerzählung statt per Regex:
 * `[^{}]*` scheitert an der `t()`-Interpolation im aria-label, die selbst
 * geschweifte Klammern trägt.
 */
test('jede Sammelaktions-Pille gibt ihre Zahl an eine Kapsel weiter', () => {
  /** Die Aktions-Literale einer Quelle: von jedem `onClick:` zur umschliessenden Klammer. */
  const actionLiterals = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bonClick:/g)) {
      let depth = 0;
      let start = -1;
      for (let i = m.index; i >= 0; i--) {
        if (src[i] === '}') depth += 1;
        else if (src[i] === '{') {
          if (depth === 0) { start = i; break; }
          depth -= 1;
        }
      }
      if (start === -1) continue;
      let end = -1;
      depth = 0;
      for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) out.push(src.slice(start, end + 1));
    }
    return out;
  };

  const pages = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, read(`../public/pages/${f}`)])
    .filter(([, src]) => /from '\/utils\/bulk-pill\.js'/.test(src) && /setBulkPill\(/.test(src));

  assert.ok(pages.length >= 2,
    'erwartet mindestens Einkauf und Vorrat als Pillen-Aufrufer - findet der Scan keine, prüft er nichts');

  for (const [name, src] of pages) {
    const literals = actionLiterals(src);
    assert.ok(literals.length, `${name}: keine Aktion mit onClick gefunden`);
    // AUF EIGENER ZEILE, siehe den Guard darüber: `count:` steht auch in jeder
    // t()-Interpolation mit Pluralform, und die steht in diesen Dateien ohnehin.
    const mitZahl = literals.filter((lit) => /^\s*count:\s*[^,\s][^\n]*,\s*$/m.test(lit));
    assert.ok(mitZahl.length >= 1,
      `${name}: mindestens eine Kapsel muss ihre Zahl als eigene Eigenschaft mitgeben - `
      + 'unter 21rem fällt das Subjekt der Pille weg, und was dann ohne Objekt dasteht, '
      + 'ist entweder gefährlich („Löschen") oder mehrdeutig („Alles")');
  }
});

/**
 * Die Marke ist für das Auge, nicht für das Ohr.
 *
 * Sie steht NUR dort, wo das Subjekt weggefallen ist - und für einen
 * Screenreader ist es nie weg: `aria-labelledby` zieht den per `display: none`
 * versteckten Knoten weiterhin in den Namen der Gruppe. Ohne `aria-hidden`
 * ginge die Zahl zusätzlich in den Namen jeder Kapsel ein, die keinen eigenen
 * `aria-label` trägt. Der Vorrat ist genau dieser Fall: „Alles auf die
 * Einkaufsliste 10" neben einer Gruppe, die schon „10 Artikel fast leer" heisst.
 */
test('die Zählmarke der Pille geht nicht in den Namen der Kapsel ein', () => {
  const pill = read('../public/utils/bulk-pill.js');

  // ÜBER DIE KLASSE, NICHT ÜBER DIE EINRÜCKUNG. Die erste Fassung suchte
  // `if (action.count != null) {` samt seiner vier Spalten Einzug und starb an
  // dem Tag, an dem der Zweig aus der Schleife in eine Kapsel-Fabrik zog - der
  // Zweig war unverändert da, der Guard fand ihn nicht mehr. Ein Guard, der
  // eine Position prüft statt einer Sache, meldet einen Umzug als Defekt.
  const at = pill.indexOf('list-bulkbar__action-count');
  assert.notEqual(at, -1, 'die Marke der Kapsel wird nirgends gesetzt');

  // Der umschliessende Block, per Klammerzählung rückwärts und vorwärts.
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (pill[i] === '}') depth += 1;
    else if (pill[i] === '{') { if (depth === 0) { start = i; break; } depth -= 1; }
  }
  assert.notEqual(start, -1, 'kein umschliessender Block um die Marke gefunden');
  let end = -1;
  depth = 0;
  for (let i = start; i < pill.length; i++) {
    if (pill[i] === '{') depth += 1;
    else if (pill[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const block = pill.slice(start, end + 1);

  assert.match(block, /setAttribute\('aria-hidden', 'true'\)/,
    'die Marke muss aus dem Namen der Kapsel heraus - die Zahl steht bereits im Namen der '
    + 'Gruppe (aria-labelledby überlebt display:none) und, wo es eine gibt, im aria-label');
});

/**
 * WER LÖSCHT, FRAGT - und die Frage kappt nicht.
 *
 * Anlass (Critique 2026-08-13, P0): die Löschen-Kapsel nahm die abgehakten
 * Artikel ohne Zwischenstufe, und sie sah dabei aus wie die harmlose Kapsel
 * daneben („In den Vorrat") und wie das „Verwerfen" des Toasts 8px darunter -
 * dieselbe Form, dieselbe Grösse, dieselbe Tinte. Die Rücknahme war als Grund
 * geführt, es dabei zu lassen; sie ist der Weg für einen Irrtum, den man
 * BEMERKT.
 *
 * DIE ZUSICHERUNG IST EINE PAARUNG, KEINE LISTE VON ZWEI SEITEN. Geprüft wird
 * jede Datei, die `setBulkPill` aufruft, und in ihr jedes Aktions-Literal:
 *   - was sich als gefährlich MARKIERT (`danger`), muss fragen (`confirm`);
 *   - was ein destruktives VERB trägt, muss beides tragen.
 * Die zweite Richtung ist die wichtigere: sie fängt die Aktion, die gefährlich
 * IST und sich nicht markiert. Sie hängt am i18n-Vokabular, nicht an
 * Dateinamen - eine dritte Pille mit einem `common.delete` ist damit gedeckt,
 * bevor es sie gibt.
 */
test('eine destruktive Sammelaktion fragt zurück, bevor sie ausführt', () => {
  /** Die Aktions-Literale einer Quelle: von jedem `onClick:` zur umschliessenden Klammer. */
  const actionLiterals = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bonClick:/g)) {
      let depth = 0;
      let start = -1;
      for (let i = m.index; i >= 0; i--) {
        if (src[i] === '}') depth += 1;
        else if (src[i] === '{') { if (depth === 0) { start = i; break; } depth -= 1; }
      }
      if (start === -1) continue;
      let end = -1;
      depth = 0;
      for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) out.push(src.slice(start, end + 1));
    }
    return out;
  };

  // Das Vokabular der Zerstörung, an den i18n-Keys statt an deutschen Wörtern:
  // die Oberfläche spricht 24 Sprachen, der Quelltext genau eine.
  const DESTRUKTIV = /\bt\(\s*['"][^'"]*\.(delete|remove|clear|destroy)[^'"]*['"]|\bt\(\s*['"]common\.delete['"]/i;

  const pages = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, read(`../public/pages/${f}`)])
    .filter(([, src]) => /from '\/utils\/bulk-pill\.js'/.test(src) && /setBulkPill\(/.test(src));

  assert.ok(pages.length >= 2,
    'erwartet mindestens Einkauf und Vorrat als Pillen-Aufrufer - findet der Scan keine, prüft er nichts');

  // NUR die Aktionen DER PILLE, nicht jedes Objekt mit `onClick` in der Datei.
  // Der Scan las bisher alle Literale einer Pillen-Datei - bei Einkauf und
  // Vorrat war das zufaellig deckungsgleich, weil dort sonst keine stehen. Mit
  // den Kontakten kam die erste Datei dazu, die daneben eine Detail-Aktion
  // fuehrt (`variant: 'danger-ghost'`, `icon`, `id`), und die wurde als
  // Pillen-Kapsel ohne Rueckfrage gemeldet, obwohl sie in einem Blatt sitzt,
  // das seine eigene Bestaetigung mitbringt.
  //
  // Erkannt wird die Pillen-Kapsel an ihrer FORM: die Pille kennt genau
  // `label`, `ariaLabel`, `count`, `danger`, `confirm` und `onClick`
  // (utils/bulk-pill.js). Ein Literal mit einem fremden Schluessel gehoert
  // einer anderen Grammatik und wird hier nicht beurteilt.
  const PILLEN_SCHLUESSEL = new Set(['label', 'ariaLabel', 'count', 'danger', 'confirm', 'onClick']);
  const istPillenKapsel = (lit) => {
    const keys = [...lit.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
    return keys.length > 0 && keys.every((k) => PILLEN_SCHLUESSEL.has(k));
  };

  let destruktiveGefunden = 0;
  for (const [name, src] of pages) {
    for (const lit of actionLiterals(src).filter(istPillenKapsel)) {
      const markiert = /^\s*danger:\s*true,\s*$/m.test(lit);
      const fragt    = /^\s*confirm:\s*\{/m.test(lit);
      const verb     = DESTRUKTIV.test(lit);

      if (markiert) {
        assert.ok(fragt, `${name}: eine als gefährlich markierte Kapsel muss zurückfragen - `
          + 'die Tinte allein unterscheidet sie vom Nachbarn, nicht von einem Fehltipp');
      }
      if (verb) {
        destruktiveGefunden += 1;
        assert.ok(markiert && fragt,
          `${name}: eine Kapsel mit destruktivem Verb braucht BEIDES - die Tinte, damit sie `
          + 'sich von der harmlosen Kapsel daneben unterscheidet, und die Rückfrage, damit '
          + 'ein Fehltipp folgenlos bleibt');
      }
    }
  }
  // Eine Zusicherung über eine leere Menge ist keine. Findet der Scan gar keine
  // destruktive Aktion mehr, hat sich das Vokabular geändert - nicht die Regel.
  assert.ok(destruktiveGefunden >= 1,
    'keine destruktive Sammelaktion gefunden - entweder ist der Einkauf umgebaut oder das '
    + 'Muster DESTRUKTIV trifft die Keys nicht mehr');

  // UND DIE FRAGE MUSS EINEN DOPPELTIPP ÜBERLEBEN.
  //
  // Gemessen: die Bestätigungs-Kapsel liegt bei 390 und 414px auf EXAKT der
  // Stelle der auslösenden (dx=0, dy=0) - beide heissen „Löschen", sind gleich
  // breit und stehen am rechten Ende der Pille. Ohne Frist wäre die Rückfrage
  // für den hektischen Doppeltipp wirkungslos, also für genau den Fall, für den
  // sie gebaut ist. Der Ort liess sich nicht verlässlich verschieben (bei 360px
  // ergab die Zählmarke zufällig 76px Versatz, bei den anderen Breiten keinen).
  const pill = read('../public/utils/bulk-pill.js');
  assert.match(pill, /confirmBtn\.disabled = true;\s*\n\s*setTimeout\(\(\) => \{ confirmBtn\.disabled = false; \}, CONFIRM_GRACE_MS\);/,
    'die Bestätigung muss nach dem Aufmachen der Frage kurz gesperrt sein - sie liegt auf '
    + 'der Kapsel, die sie ausgelöst hat');
  const grace = pill.match(/const CONFIRM_GRACE_MS = (\d+);/);
  assert.ok(grace, 'die Schutzfrist braucht einen benannten Wert, keine Zahl im Aufruf');
  const ms = Number(grace[1]);
  assert.ok(ms >= 250 && ms <= 500,
    `die Frist liegt zwischen einem Doppeltipp und einer gelesenen Antwort (250-500ms), ist aber ${ms}ms`);

  // Der Rückweg ist frei. Eine gesperrte Abbrechen-Kapsel wäre eine Falle mit
  // Wartezeit, kein Schutz.
  assert.doesNotMatch(pill, /cancel\.disabled = true/,
    'wer abbricht, darf das sofort - nur die Bestätigung wartet');
});

/**
 * DIE FRAGE BRICHT UM, SIE KAPPT NICHT - und zwar ohne eine Zahl über Sprachen.
 *
 * Der Ruhezustand der Pille kürzt sein Subjekt (es benennt nur, worauf die
 * Kapseln wirken, und dasselbe steht in der Liste darüber). Die Frage steht
 * nirgendwo sonst: „9 Artikel lösch…" verlangt eine Antwort, die sie nicht mehr
 * nennt.
 *
 * KEINE CONTAINER-SCHWELLE FÜR DIE FRAGE. Die 21rem des Subjekts sind an dessen
 * Bedarf gemessen. Gemessen bei 390px: Deutsch passt mit 115 von 149px, aber
 * Niederländisch verlangt „9 artikelen verwijderen?" neben „Annuleren" und
 * „Verwijderen" und reisst mit 153 von 149px. Eine Schwelle, die für eine
 * Sprache stimmt, ist eine Annahme über 23 andere - die drei Deklarationen
 * unten fragen stattdessen den echten Bedarf. Gemessen über 5 Locales x 4
 * Breiten x 2 Themen: 0 gekappte Fälle.
 *
 * Die drei sind EINE Zusicherung: ohne `flex-wrap` bleibt die Frage in der
 * Zeile und kappt, ohne `flex-shrink: 0` schrumpft sie, statt umzubrechen, und
 * ohne `overflow: visible` erbt sie die Ellipse des Ruhezustands und kappt
 * lautlos in einer Zeile, die Platz hätte.
 */
test('die Rückfrage der Pille bricht um, statt zu kappen', () => {
  const layout = read('../public/styles/layout.css');
  const rules  = [...eachRule(layout)];

  const wrap = rules.find((r) => r.selector.trim() === '.list-bulkbar--confirming' && !r.at.length);
  assert.ok(wrap && /flex-wrap:\s*wrap/.test(wrap.body),
    'der Bestätigungszustand muss umbrechen dürfen - sonst kappt die Frage bei der ersten '
    + 'Sprache, die länger ist als Deutsch');

  const frage = rules.find((r) => /\.list-bulkbar--confirming\s+\.list-bulkbar__subject/.test(r.selector)
    && !r.at.length);
  assert.ok(frage, 'die Frage braucht eine eigene Regel gegen die Kürzung des Ruhezustands');
  assert.match(frage.body, /flex:\s*1\s+0\s+auto/,
    'die Frage darf nicht schrumpfen - sie soll die Kapseln in die nächste Zeile schieben');
  assert.match(frage.body, /overflow:\s*visible/,
    'ohne das erbt die Frage die Ellipse des Subjekts und kappt in einer Zeile, die Platz hätte');

  // Die Wahl ist ein Paar. Ohne diesen Knoten entscheidet die Restbreite, WELCHE
  // Kapsel umbricht - gemessen stand die Frage mit „Annuleren" in Zeile eins und
  // „Verwijderen" allein darunter.
  const choices = rules.find((r) => r.selector.trim() === '.list-bulkbar__choices' && !r.at.length);
  assert.ok(choices, 'Abbrechen und Bestätigen brauchen einen gemeinsamen Träger');
  assert.match(choices.body, /flex-shrink:\s*0/,
    'das Paar wandert als Ganzes, es schrumpft nicht');
  assert.match(read('../public/utils/bulk-pill.js'), /class(?:Name)?\s*=\s*'list-bulkbar__choices'/,
    'die Fabrik muss das Paar auch bauen - eine CSS-Regel ohne Knoten ist keine Zusicherung');

  // UND KEINE SCHWELLE DANEBEN. Stünde der Bestätigungszustand zusätzlich in
  // einem @container-Block, wäre die Locale-Annahme wieder da, nur leiser.
  //
  // `:not()` ZUERST WEG, sonst prüft der Guard eine Zeichenkette statt einer
  // Sache: `.list-bulkbar:not(.list-bulkbar--confirming)` trägt den Namen und
  // meint das Gegenteil. Die Regel, die dort legitim steht (der Ruhezustand
  // zentriert bei 320px), machte den Guard beim ersten Lauf rot.
  const ohneNot = (sel) => sel.replace(/:not\([^)]*\)/g, '');
  for (const rule of rules) {
    if (!/\.list-bulkbar--confirming/.test(ohneNot(rule.selector))) continue;
    assert.equal(rule.at.filter((a) => /bulk-pill/.test(a)).length, 0,
      'der Bestätigungszustand darf an keiner Container-Schwelle hängen - sein Bedarf hängt '
      + 'an der Sprache, nicht an einer Zahl');
  }
});

/**
 * Ein Etikett sagt nicht dasselbe wie der Chip daneben.
 *
 * Anlass (Critique 2026-08-13): auf /tasks stand „• Dringend" direkt neben dem
 * gespiegelten CalDAV-Etikett „dringend" - zwei Formen, dasselbe Wort, in einer
 * Metazeile, die seit dem Zeilenschnitt einzeilig ist und jedes Element
 * bezahlt. Eine VTODO traegt ihre Dringlichkeit als PRIORITY und noch einmal
 * als CATEGORIES.
 *
 * Geprueft wird die PAARUNG, nicht der Wortlaut: die Etiketten-Funktion muss die
 * Prioritaet kennen und gegen deren Label filtern, und beide Aufrufstellen
 * muessen sie mitgeben. Eine davon zu vergessen ist der stille Fall - die
 * Zeile sieht dann genauso aus wie vorher.
 */
test('ein Etikett verschwindet, wenn es heisst wie die eigene Prioritaet', () => {
  const src = read('../public/pages/tasks.js');

  const fn = src.match(/function renderTagBadges\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'renderTagBadges nicht gefunden');
  assert.match(fn[0], /priority\s*=\s*null/,
    'die Etiketten-Funktion muss die Prioritaet kennen, sonst kann sie sie nicht vergleichen');
  // DER RUMPF, NICHT DIE SIGNATUR. Eine erste Fassung prueft nur, dass die
  // Bestandteile irgendwo im Rumpf vorkommen - und blieb gruen, als die
  // Filterzeile entfernt wurde: `PRIORITY_LABELS()[priority]` und die
  // Kleinschreibung standen weiter da, sie taten nur nichts mehr. Also wird der
  // Name der Label-Variablen gelesen und verlangt, dass GENAU DER in einem
  // Filter ueber die Etiketten vorkommt.
  const labelVar = fn[0].match(/const\s+(\w+)\s*=[^;]*PRIORITY_LABELS\(\)\[priority\]/);
  assert.ok(labelVar,
    'verglichen wird gegen das ANGEZEIGTE Label, nicht gegen den Schluessel - das Etikett kommt '
    + 'aus einer fremden Liste und ist in der Sprache geschrieben, in der es dort steht');
  const filterMitLabel = new RegExp(`tags\\s*=\\s*tags\\.filter\\([\\s\\S]{0,160}?\\b${labelVar[1]}\\b`);
  assert.match(fn[0], filterMitLabel,
    `das Label (\`${labelVar[1]}\`) muss die Etiketten wirklich filtern - eine Variable, die nur `
    + 'berechnet und nie benutzt wird, ist ein Guard ohne Gegenstand');
  assert.match(fn[0], /toLocaleLowerCase|toLowerCase/,
    'gross/klein darf den Vergleich nicht entscheiden - „Dringend" und „dringend" sind dasselbe Wort');

  // BEIDE Aufrufstellen, sonst greift der Fix nur in einer Ansicht.
  const aufrufe = [...src.matchAll(/renderTagBadges\(([^)]*)\)/g)]
    .map((m) => m[1]).filter((args) => !args.includes('limit ='));
  assert.ok(aufrufe.length >= 2, `erwartet mindestens zwei Aufrufstellen, gefunden ${aufrufe.length}`);
  for (const args of aufrufe) {
    assert.match(args, /task\.priority/,
      `eine Aufrufstelle gibt die Prioritaet nicht mit (\`${args}\`) - dort steht das Etikett `
      + 'weiter neben seinem Zwilling');
  }
});

/**
 * EINE ZEILE DARF ABWEICHEN, ABER NICHT WIEDERHOLEN.
 *
 * Anlass (Critique 2026-08-13, P2): `.list-row` stand im gerenderten Dokument
 * auf /shopping 26x, /pantry 21x, /budget 23x, /birthdays 8x, /housekeeping 5x
 * und /recipes 6x - und auf /tasks, /calendar und /contacts null Mal. Die drei
 * bauten die Grammatik nach: `.agenda-event` und `.contact-item` mit sieben
 * bzw. fuenf zeichengleichen Deklarationen, `.contact-group__list` als
 * Wert-fuer-Wert-Kopie von `.row-carrier`. Gemessen sah man davon nichts - die
 * Zeilen standen richtig da. Was fehlte, war die Reichweite: die naechste
 * Korrektur an der geteilten Zeile haette drei von neun Modulen nicht erreicht,
 * und zwar lautlos. Genau die Form, in der `.filter-toggle-btn` dreimal
 * unentdeckt neben `.filter-chip` stand.
 *
 * DER GUARD VERBIETET NICHT DIE ABWEICHUNG, SONDERN DIE DOPPELUNG. Die drei
 * Zeilen haben begruendete Eigenheiten - die Agenda richtet gestreckt aus, weil
 * ihr Farbstreifen die Hoehe nimmt; die Aufgabe polstert ueber `--task-row-pad`,
 * weil die Trefferflaeche des Titels damit rechnet. Wer eine Eigenschaft mit
 * einem ANDEREN Wert setzt, trifft eine Entscheidung. Wer sie mit DEMSELBEN
 * Wert setzt, hat abgeschrieben.
 *
 * Und er haengt nicht an einer Liste von drei Klassen: geprueft wird, was im
 * Markup neben `list-row` steht - eine vierte Zeile ist gedeckt, bevor es sie
 * gibt.
 */
test('eine Zeile wiederholt die geteilte Grammatik nicht', () => {
  const listRowCss = read('../public/styles/list-row.css');
  const basis = [...eachRule(listRowCss)]
    .find((r) => r.selector.trim() === '.list-row' && !r.at.length);
  assert.ok(basis, '.list-row braucht eine Basisregel - ohne sie prueft der Guard nichts');

  // Die Deklarationen der geteilten Zeile, normalisiert auf `eigenschaft:wert`.
  const geteilt = new Map();
  for (const decl of basis.body.split(';')) {
    const [prop, ...rest] = decl.split(':');
    if (!rest.length) continue;
    const p = prop.trim().replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!p || p.startsWith('--')) continue;
    geteilt.set(p, rest.join(':').trim().replace(/\s+/g, ' '));
  }
  assert.ok(geteilt.size >= 5,
    `erwartet mindestens fuenf geteilte Deklarationen, gefunden ${geteilt.size}`);

  // Was steht im Markup neben `list-row`? Genau das sind die Zeilen-Klassen.
  const begleiter = new Set();
  for (const file of readdirSync(new URL('../public/pages/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const src = read(`../public/pages/${file}`);
    for (const m of src.matchAll(/class="([^"]*\blist-row\b[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        // Template-Ausdruecke und die Basisklasse selbst sind keine Begleiter.
        if (!cls || cls === 'list-row' || cls.includes('$') || cls.includes('{')) continue;
        begleiter.add(cls);
      }
    }
  }
  assert.ok(begleiter.size >= 3,
    'erwartet mindestens die drei nachgezogenen Zeilen als Begleitklassen - findet der Scan '
    + 'keine, prueft er nichts');

  const alleCss = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((f) => f.endsWith('.css') && f !== 'list-row.css')
    .map((f) => [f, read(`../public/styles/${f}`)]);

  const verstoesse = [];
  for (const [file, css] of alleCss) {
    for (const rule of eachRule(css)) {
      // Nur die Regel der Zeile selbst, keine Kinder, keine Zustaende: eine
      // `.contact-item__meta` teilt den Namen, nicht die Rolle.
      const sel = rule.selector.trim();
      if (!begleiter.has(sel.replace(/^\./, ''))) continue;
      for (const [prop, wert] of geteilt) {
        const treffer = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*${wert.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(;|$)`);
        if (treffer.test(rule.body)) verstoesse.push(`${file} ${sel} { ${prop}: ${wert} }`);
      }
    }
  }
  assert.deepEqual(verstoesse, [],
    'diese Zeilen setzen eine Eigenschaft auf DENSELBEN Wert, den `.list-row` schon setzt - '
    + 'das ist ein Nachbau, kein Unterschied. Abweichen ist erlaubt, wiederholen nicht');
});

/**
 * Wer eine Zeilenliste baut, legt geteilte Zeilen hinein.
 *
 * Die Gegenrichtung zum Guard darueber: dort ging es um Zeilen, die die Klasse
 * TRAGEN und trotzdem abschreiben. Hier um die, die sie gar nicht erst tragen -
 * der Fall, mit dem /tasks, /calendar und /contacts durchkamen.
 *
 * NUR `.list-rows`, NICHT JEDER TRAEGER. Die erste Fassung prueft auch
 * `.row-carrier` und `.row-divided` und wurde sofort rot - zu Recht gemeldet und
 * falsch geurteilt: `budget-plans.js` legt `.budget-plan-row` in einen
 * `.row-carrier`, und die ist `flex-direction: column`, also ein gestapelter
 * Block mit Fortschrittsbalken, keine Zeile. Der Traeger ist die allgemeinere
 * Grammatik („eine Folge gleichartiger Elemente, getrennt durch Haarlinien"),
 * `.list-rows` die spezielle. Ein Guard, der beide gleichsetzt, verlangt eine
 * Zeilenklasse fuer etwas, das keine Zeile ist.
 */
test('eine Seite mit Zeilenliste hat auch geteilte Zeilen', () => {
  for (const file of readdirSync(new URL('../public/pages/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const src = read(`../public/pages/${file}`);
    if (!/class="[^"]*\blist-rows\b/.test(src)) continue;
    assert.match(src, /class="[^"]*\blist-row\b/,
      `${file} baut eine Zeilenliste, aber keine geteilte Zeile - genau so standen Agenda, `
      + 'Kontakte und Aufgaben mit ihrem eigenen Nachbau darin');
  }
});

/**
 * Der Toast stand im Reduced-Transparency-Fallback des Filter-Chips.
 *
 * Beide verlieren dort ihr Glas, aber sie haben nicht denselben Grund darunter:
 * der Chip ist hell mit dunkler Schrift, der Toast ist die dunkle Fläche der
 * Shell und trägt `color: var(--neutral-50)`. Auf `--color-accent-light`
 * (#F3EFFE) stand damit Weiss auf Fast-Weiss - GEMESSEN 1.08:1 gegen 13.69:1
 * jetzt, mit emulierter Medienabfrage im gerenderten Dokument. Ein Fallback,
 * der die Lesbarkeit sichern soll und sie abschafft.
 *
 * Über eachRule, weil die Begründung des Fixes den alten Wert beim Namen nennt.
 */
test('das Shell-Material behält im Reduced-Transparency-Fallback seinen dunklen Grund', () => {
  const glass = read('../public/styles/glass.css');
  let seen = 0;

  for (const rule of eachRule(glass)) {
    if (!rule.at.some((a) => /prefers-reduced-transparency/.test(a))) continue;
    if (!/\.toast\b|\.list-bulkbar\b/.test(rule.selector)) continue;
    seen += 1;
    const bg = rule.body.match(/background-color:\s*([^;]+)/)?.[1]?.trim();
    assert.ok(bg, `${rule.selector} muss im Fallback einen opaken Grund setzen`);
    assert.match(bg, /--neutral-800/,
      `${rule.selector} braucht seinen EIGENEN dunklen Grund - der helle Akzent gehört dem Chip, `
      + 'und die Schrift auf diesem Material ist --neutral-50');
  }

  assert.ok(seen >= 1,
    'Toast und Pille tragen Glas und brauchen deshalb einen Reduced-Transparency-Fallback');
});

/**
 * Die Bedienzone der Vorratszeile ist so breit wie ihre KNOEPFE, nie wie ihr
 * Inhalt.
 *
 * Anlass (Critique-Nachlauf 2026-07-30): der Stepper belegte bei 320px 167px der
 * 262px Zeilenbreite, davon 71px allein das Mengenfeld (`min-width: 7ch`). Fuer
 * den Namen blieben 31px - „Olivenoel extra vergine" auf 8 Zeilen, Zeilenhoehen
 * 89 bis 369px.
 *
 * DIE ANTWORT DARAUF WAR BIS ZUM 12.08.2026 EIN UMBRUCH: unter 30rem
 * Traegerbreite rueckte der Wert ueber die Knoepfe. Das rettete die Namensbreite
 * und kostete rund 25px Hoehe in JEDER Zeile (gemessen 89,4px bei 390x844). Die
 * Menge steht jetzt in der Metazeile, wo der Einkauf sie immer schon hat - die
 * Bedienzone kann damit gar nicht mehr mit dem Text wachsen, und die
 * Namensbreite haengt an keinem Breakpoint mehr.
 *
 * Geprueft wird deshalb die Zusage in ihrer neuen, staerkeren Form: in der
 * Bedienzone steht KEIN Text. Der alte Mechanismus ist ausdruecklich
 * ausgeschlossen - kaeme das Wertfeld zurueck, waere die Zusage still wieder
 * gebrochen.
 */
test('die Bedienzone der Vorratszeile traegt keinen Text', () => {
  const shared = read('../public/styles/list-row.css');
  const pantryCss = read('../public/styles/pantry.css');
  const pantryJs = read('../public/pages/pantry.js');

  // Der geteilte Container bleibt: die Aufgabenzeile haengt ihr Etikett daran.
  const rows = shared.match(/\.list-rows\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rows, /container-type:\s*inline-size/,
    '.list-rows muss abfragbarer Container sein - ein Container kann sich selbst nicht abfragen');
  assert.match(rows, /container-name:\s*list-rows/, 'der Container braucht einen Namen');

  // Der Stepper hat genau zwei Kinder, und beide sind Knoepfe.
  assert.match(pantryJs, /stepper\.append\(minus,\s*plus\)/,
    'in den Stepper gehoeren nur die beiden Knoepfe - ein Wert dazwischen macht seine Breite vom Text abhaengig');
  /* UEBER DEN REGELSCANNER, NICHT UEBER EIN REGEX AUF DER DATEI: die Begruendung
   * fuer den Umzug steht als KOMMENTAR in pantry.css und nennt den alten
   * Selektor beim Namen. Ein `doesNotMatch` auf dem Dateitext las diesen
   * Kommentar als Regel und meldete den Verstoss, den er beschreibt. */
  const pantryRules = [...eachRule(pantryCss)];
  const valueRule = pantryRules.find((r) => /\.pantry-stepper__value/.test(r.selector));
  assert.equal(valueRule, undefined,
    'das Wertfeld ist in die Metazeile gezogen; kaeme es zurueck, waere die Zusage still gebrochen');
  const wrapping = pantryRules.filter((r) => /\.pantry-stepper\b/.test(r.selector) && /flex-wrap:\s*wrap/.test(r.body));
  assert.deepEqual(wrapping.map((r) => r.selector), [],
    'der Stepper darf nicht mehr umbrechen - der Umbruch war der Hoehentreiber der Zeile');

  // Und die Menge steht wirklich in der Metazeile, nicht nur nicht mehr im
  // Stepper: ohne diese Zeile waere sie ersatzlos verschwunden und der Guard
  // trotzdem gruen.
  assert.match(pantryJs, /quantity\.className = 'pantry-row__quantity'/,
    'die Menge braucht einen eigenen Knoten in der Metazeile - der Stepper aktualisiert ihn');
  assert.match(pantryJs, /meta\.appendChild\(quantity\)/,
    'die Menge haengt in der Metazeile');
  assert.match(pantryJs, /row\.querySelector\('\.pantry-row__quantity'\)/,
    'refreshRowQuantity muss den neuen Knoten treffen, sonst friert die Anzeige beim Steppen ein');

  /* WEGLASSEN STATT ABSCHNEIDEN. Auf einer Zeile mit Warenkorb bleiben 168px
   * statt 220px, und „1 Flasche · MHD 23.12.2027" braucht 182px - mit Ellipse
   * stand da „MHD 23.12….". Das MHD braucht dafuer einen EIGENEN Knoten; als
   * Teil einer zusammengefuegten Zeichenkette kann CSS es nicht weglassen. */
  assert.match(pantryJs, /expiry\.className = 'pantry-row__expiry'/,
    'das MHD braucht einen eigenen Knoten, sonst kann es nur abgeschnitten statt weggelassen werden');
  assert.match(pantryJs, /expiry\.textContent = ` · \$\{t\('pantry\.bestBefore'/,
    'das Trennzeichen gehoert IN den Knoten - sonst bleibt beim Weglassen ein einsames Mittelpunkt-Zeichen stehen');
  assert.match(
    pantryCss,
    /@container list-rows \(max-width:[^)]+\)\s*\{\s*\.pantry-row:has\(\.pantry-row__cart\) \.pantry-row__expiry\s*\{\s*display:\s*none/,
    'das MHD faellt auf der schmalen Zeile MIT Warenkorb weg - an der Traegerbreite, nicht am Viewport',
  );

  // Eine Variable, zwei Zeigerklassen: die Knopfgroesse wechselt mit der
  // Zeigerfaehigkeit und wird nicht doppelt gepflegt.
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
  // Seit #829 Teil 3 heisst die Frage nach dem heutigen Tag `todayKey()` und
  // folgt der Haushaltszone; die Zusicherung ist dieselbe geblieben.
  assert.match(tabs, /kitchen\/summary\?today=\$\{encodeURIComponent\(todayKey\(\)\)\}/,
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

  // EIN Transfer-Label und EIN „auf welche Liste?" für alle vier Tabs. Die
  // BENANNTE Fassung („{{title}} auf die Einkaufsliste setzen", seit 2026-08-27
  // fuer aria-labels der Mahlzeitkarten) gehoert zur selben Familie und lebt
  // deshalb ebenfalls unter common - ein meals-eigener Named-Key waere der
  // Anfang genau der Drift, die dieser Test beendet hat.
  assertKeysExistInEveryLocale(['common.toShoppingList', 'common.toShoppingListWhich', 'common.toShoppingListNamed']);
  for (const dead of ['meals.transferToShoppingList', 'meals.toShoppingListNamed', 'recipes.toShoppingList', 'recipes.toShoppingListTitle', 'pantry.toShopping', 'pantry.chooseList']) {
    const [block, key] = dead.split('.');
    assert.equal(de[block]?.[key], undefined,
      `${dead} ist durch common.toShoppingList(Named) ersetzt - zwei Keys für ein Label laufen auseinander (auf Englisch war das schon passiert)`);
  }
  for (const page of ['meals', 'recipes', 'pantry']) {
    assert.ok(
      pages[page].includes("t('common.toShoppingList')")
        || pages[page].includes("t('common.toShoppingListNamed'"),
      `${page}.js muss das geteilte Transfer-Label nutzen (common.toShoppingList oder die benannte Fassung)`,
    );
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
  // DIE CHECKBOX TRAEGT DIE STIMME, NICHT DEN MODULTON (Eine-Stimme-Regel,
  // 2026-08-10). Hier stand eine dreistufige Kette
  // (--module-accent → --active-module-accent → --color-accent), und sie hatte
  // ihren Grund: das Modal haengt im Top-Layer ausserhalb der Modul-Wurzel, mit
  // --module-accent allein blieb die Box violett, waehrend der Dialog um sie
  // herum #C2410C trug. Seit ein Zustandsschalter app-weit dieselbe Farbe hat,
  // ist violett die richtige Antwort - und die Kette ueberfluessig. Bekleidet
  // sein muss sie weiterhin: nackte System-Checkboxen waren der Anlass.
  assert.match(layout, /\.form-check input\[type="checkbox"\]\s*\{[\s\S]*?accent-color:\s*var\(--color-accent\)/,
    'die Checkbox muss eingekleidet sein und die Stimme tragen, auch im Modal');
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
 * DESIGN.md (damals englisch, vor der Nachziehung `fab73ac0`): „size touch targets
 * at 48px (mobile) or 40px (desktop) minimum. The --target-lg and --target-md
 * tokens encode this - never go below them."
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

  // Die Quelle der Untergrenze ist DESIGN.md - und sie wird GELESEN, nicht zitiert.
  //
  // Der Guard hat beide Begründungen fürs Zitieren überlebt. Die erste war
  // sachlich: DESIGN.md stand in .gitignore, lag nur lokal und fehlte der CI - ein
  // Guard, der eine ignorierte Datei liest, ist lokal grün und im Build rot (so ist
  // dieser Test beim Release v1.59.0 aufgefallen). Seit c0df06ec (2026-08-08) ist
  // die Datei committed, das Argument war damit erledigt.
  //
  // Die zweite hielt sich länger: die Zahl gehöre in die ASSERTION, damit ein Edit
  // an DESIGN.md den Guard nicht stillschweigend mitverschiebt. Genau das ist
  // schiefgegangen, nur andersherum. Der zitierte englische Satz existiert in
  // DESIGN.md seit der deutschen Nachziehung `fab73ac0` (2026-08-15) nicht mehr;
  // die Zitat-Fassung wurde am 2026-08-18 mit `455c00c2` noch einmal bekräftigt,
  // drei Tage nach dem Tod des Satzes, und kein Test hat es gemerkt. Ein Zitat
  // verschiebt sich nicht mit - es VERWAIST, und zwar grün.
  //
  // Gelesen fällt ein Drift auf BEIDEN Seiten auf. Gegen ein Mitverschieben sichert
  // nicht mehr das Zitat, sondern --target-md: die Desktop-Untergrenze steht als
  // Token und wird unten gegen die Zahl aus DESIGN.md geprüft.
  const design = read('../DESIGN.md');
  const bulletStart = design.indexOf('- **Touch-Targets:**');
  assert.notStrictEqual(bulletStart, -1,
    'DESIGN.md muss den Touch-Targets-Absatz führen - er ist die Quelle der Untergrenze');
  const bulletEnd = design.indexOf('\n- ', bulletStart + 1);
  const bullet = design
    .slice(bulletStart, bulletEnd === -1 ? undefined : bulletEnd)
    .replace(/\s+/g, ' ');

  // Beide Zahlen kommen aus EINEM Match, damit die Zuordnung mitgeprüft wird: welche
  // gilt am Zeiger, welche am Finger. Zwei getrennte Muster wären gegen ein
  // Vertauschen blind. Die Umschrift ist tolerant, weil DESIGN.md in diesem Absatz
  // ohne Umlaute schreibt - eine Rückumstellung auf „Zeigergeräten" ist kein Drift
  // der Zusage.
  const stated = bullet.match(
    /`--target-base` (\d+)px auf Zeigerger[äa]e?ten.*?`@media \(hover: none\)` auf (\d+)px/);
  assert.ok(stated,
    `DESIGN.md muss beide Zielgrößen mit ihrem Kriterium nennen, gefunden: „${bullet}"`);
  const pointerPx = Number(stated[1]);
  const touchPx = Number(stated[2]);

  // Die 40er-Grenze steht als Token, nicht als Prosa-Zahl: --target-md IST die
  // Desktop-Untergrenze, und die Zeigergröße darf nicht darunter fallen. Das ist die
  // Bremse gegen ein stilles Absenken über einen DESIGN.md-Edit.
  const floor = tokens.match(/--target-md:\s*(\d+)px/);
  assert.ok(floor, '--target-md ist die Desktop-Untergrenze und muss in tokens.css stehen');
  assert.ok(pointerPx >= Number(floor[1]),
    `die Zeigergröße aus DESIGN.md (${pointerPx}px) darf die Untergrenze --target-md `
    + `(${floor[1]}px) nicht unterschreiten`);

  // Zahl gegen Zahl, nicht Muster gegen Datei: ein Mismatch ist hier der erwartete
  // Rot-Fall, und `assert.match` würde dafür die ganze tokens.css in die Meldung legen.
  const base = tokens.match(/--target-base:\s*(\d+)px/);
  assert.ok(base, '--target-base muss in tokens.css eine Zahl tragen');
  assert.strictEqual(Number(base[1]), pointerPx,
    `auf Zeigergeräten gilt die Zahl aus DESIGN.md (${pointerPx}px)`);
  const lg = tokens.match(/--target-lg:\s*(\d+)px/);
  assert.ok(lg, '--target-lg muss in tokens.css eine Zahl tragen');
  assert.strictEqual(Number(lg[1]), touchPx,
    `--target-lg muss die Fingergröße aus DESIGN.md tragen (${touchPx}px)`);
  assert.match(tokens, /@media \(hover: none\)\s*\{\s*:root\s*\{\s*--target-base:\s*var\(--target-lg\)/,
    `auf Fingergeräten muss --target-base die ${touchPx}px aus DESIGN.md erreichen`);

  // Das Kriterium ist die Zeigerfähigkeit, nicht die Breite: ein schmales
  // Desktop-Fenster wird mit der Maus bedient, ein 1180px-Tablet mit dem Finger.
  const anchor = tokens.indexOf('Touch-Ziele auf Fingergeräten');
  assert.notStrictEqual(anchor, -1,
    'der Abschnitt der Touch-Ziele muss in tokens.css auffindbar bleiben - ohne Anker '
    + 'prüft die nächste Zusicherung das Dateiende');
  assert.doesNotMatch(tokens.slice(anchor, anchor + 1400), /--target-base[\s\S]{0,80}@media \(max-width/,
    'die Touch-Größe darf nicht an einer Viewport-Breite hängen');
});

/**
 * Nicht-Text-Kontrast: gemessen, dokumentiert, bewusst offen.
 *
 * Die Kanten der Bedienelemente erreichen die 3:1 aus WCAG 1.4.11 nicht. Der
 * Betreiber hat am 2026-07-30 entschieden, das vorerst nur zu dokumentieren
 * statt --color-border anzuheben - die Änderung ginge durch jedes Modul.
 *
 * Der Guard hält die MESSUNG fest, nicht den Fix: verschwindet der Kommentar,
 * verschwindet auch das Wissen, warum die Zahl so steht. Messwerte und Zielwert
 * sind mit dem HIG-Rollout (2026-08) neu erhoben worden - die alte Zahlenreihe
 * galt gegen die warme Prä-Redesign-Palette und wäre gegen die kühle
 * iOS-27-Rampe schlicht falsch.
 */
test('der offene Nicht-Text-Kontrast bleibt an den Tokens dokumentiert', () => {
  const tokens = read('../public/styles/tokens.css');
  const block = tokens.slice(0, tokens.indexOf('--color-border:'));
  assert.match(block, /WCAG 1\.4\.11/, 'der Befund muss an --color-border dokumentiert bleiben');
  assert.match(block, /1\.13:1/, 'der gemessene Ist-Wert auf dem Grouped-Grund gehört dazu');
  assert.match(block, /1\.26:1/, 'der Wert auf --color-surface gehört dazu (Eingabefeld auf Weiß)');
  assert.match(block, /1\.60:1/, 'der Dark-Wert gehört dazu');
  assert.match(block, /#949494/, 'der Zielwert für 3:1 gegen die kühle Rampe gehört dazu, sonst muss ihn jeder neu ausrechnen');
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
  for (const file of ['shopping.css', 'meals.css', 'recipes.css', 'pantry.css', 'list-row.css', 'kitchen-tabs.css', 'filter-chip.css', 'sub-tabs.css']) {
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
 * `.list-row__name` = **8px breit, 432px hoch**. „Chicken Tikka Masala" stand ein
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
  const shared = read('../public/styles/list-row.css');
  const recipes = read('../public/styles/recipes.css');
  const recipesJs = read('../public/pages/recipes.js');

  const nameBlock = shared.match(/\.list-row__name\s*\{([^}]*)\}/)?.[1] ?? '';
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

  assert.match(recipes, /@container list-rows \(max-width: 30rem\)/,
    'die Umschaltung hängt an der ZEILENbreite, wie beim Vorrats-Stepper');
  // Die Quellreihenfolge entscheidet: `@container` erhöht die Spezifität nicht.
  const inlineBase = recipes.indexOf('.recipe-row__inline-actions {');
  const query = recipes.indexOf('@container list-rows');
  assert.ok(inlineBase !== -1 && inlineBase < query,
    'der Basiszustand muss VOR der Container-Query stehen, sonst gewinnt er gegen sie');
  const compact = recipes.slice(query);
  assert.match(compact, /\.recipe-row__inline-actions\s*\{\s*display:\s*none/,
    'die drei Inline-Aktionen müssen in der schmalen Zeile weichen');
  assert.match(compact, /\.recipe-row__toggle \.list-row__meta\s*\{[\s\S]*?flex:\s*1 0 100%/,
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
  // list-row.css und ist dort mit --target-lg (48px) strenger als die alte
  // --target-base-Untergrenze (44px) auf .shopping-item. Ein Tab-lokales
  // min-height gibt es nicht mehr - es wäre genau die Divergenz, die der Guard
  // „die Küchen-Listen teilen eine Zeilen-Grammatik" verbietet.
  assert.match(read('../public/styles/list-row.css'),
    /\.list-row\s*\{[\s\S]*?min-height:\s*var\(--target-lg\)/);
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
  // Auf die ABSICHT prüfen, nicht auf die wörtliche Klassenkette: die stand
  // hier als ein String und schlug fehl, sobald der Kopf einen weiteren
  // Modifier bekam (`--narrow`, Critique 2026-08-13) - eine Zusicherung, die
  // eine Reihenfolge festnagelt, prüft die Reihenfolge, nicht die Sache.
  assert.match(tasksPage, /class="page-toolbar[^"]*\bpage-toolbar--wrap\b[^"]*\btasks-toolbar\b/);

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
    /@media \(max-width:\s*639px\)[\s\S]*\.kitchen-tabs-bar \.sub-tabs-bar__title\s*\{[\s\S]*display:\s*none/
  );
  assert.doesNotMatch(
    kitchenTabs,
    /@media \(max-width:\s*639px\)[\s\S]*\.kitchen-tabs-bar\s*\{[^}]*padding-inline/,
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
  // Die Settings-Uebersicht war auf Tablets zweispaltig. Mit der
  // Zeilenlisten-Regel (HIG-Rollout Runde 3, tokens.css) ist sie EINE
  // gruppierte Liste in EINEM Traeger: nebeneinander gestellt braeuchte jede
  // Zeile wieder ihren eigenen Rand und waere damit wieder eine Karte pro
  // Zeile. Der Guard haelt jetzt die Zusage „ein Traeger, keine Spalten"
  // statt der abgeloesten Zweispaltigkeit.
  assert.match(
    settings,
    /\.settings-mobile-overview__links\s*\{[^}]*background:\s*var\(--color-surface-work\)[^}]*overflow:\s*hidden/
  );
  assert.doesNotMatch(
    settings,
    /\.settings-mobile-overview__links\s*\{[^}]*grid-template-columns/
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
    /@media \(max-width:\s*639px\)[\s\S]*?\.dashboard-icon-btn\s*\{[^{}]*width:\s*var\(--target-base\)[^{}]*height:\s*var\(--target-base\)/,
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
  const housekeepingCard = housekeeping.match(/\.housekeeping-card\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.doesNotMatch(overview, /border-top:\s*(?:3px|var\(--space-1\))/);
  assert.doesNotMatch(cockpit, /border-top:\s*(?:3px|var\(--space-1\))/);
  // Die Widget-Oberkante trug bis a326283c ein ::before mit `height: 1px` -
  // eine Glanzkante, die hier als BELEG dafür stand, dass dort keine dicke
  // Akzentkappe sitzt. Das Pseudoelement ist entfallen (1.00:1 im Light, Glas-
  // Vokabular auf einer Inhaltskarte), womit die Zusage strenger gilt als
  // vorher. Geprüft wird deshalb die Zusage selbst: keine Kappe an der Kante.
  const widgetBase = dashboard.match(/\n\.widget\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(widgetBase, '.widget muss eine Basisregel haben');
  assert.doesNotMatch(widgetBase, /border-top:\s*(?:[2-9]px|var\(--space-[1-9])/);
  assert.doesNotMatch(dashboard, /\.widget::before/);
  assert.doesNotMatch(housekeepingCard, /border-top:\s*3px/);
});

/**
 * Die Zusage ist dieselbe geblieben, der Mechanismus nicht.
 *
 * Bis zum Zeilenschnitt hielt die Geburtstagszeile extreme Inhalte aus, indem
 * sie UMBRACH: `overflow-wrap: anywhere` am Namen und an der Notiz, dazu eine
 * 640px-Regel, die die Namenszeile umbrechen liess. Genau das machte die Zeile
 * dreizeilig und 121,6px hoch. Sie kappt jetzt, wie `.contact-item__name` im
 * Nachbarmodul derselben Familie es immer getan hat.
 *
 * Geprueft wird deshalb die ZUSAGE - kein Inhalt sprengt die Zeile - und nicht
 * mehr das alte Mittel. Der alte Mechanismus ist zusaetzlich AUSGESCHLOSSEN:
 * kaeme `overflow-wrap: anywhere` zurueck, waere die Kappung wirkungslos und
 * die Zeile stuende wieder zweizeilig da, ohne dass eine Zusicherung bricht.
 */
test('hardening keeps Birthday rows on one line with extreme localized content', () => {
  const birthdays = read('../public/styles/birthdays.css');

  for (const part of ['__name', '__meta', '__notes']) {
    const body = cssRuleBody(birthdays, `.birthday-item${part}`);
    assert.ok(body, `.birthday-item${part} muss eine Regel haben`);
    assert.match(body, /overflow:\s*hidden/,
      `.birthday-item${part} muss ueberlaufenden Inhalt kappen statt die Zeile zu dehnen`);
    assert.doesNotMatch(body, /overflow-wrap:\s*anywhere/,
      `.birthday-item${part} darf nicht wieder umbrechen - das war der Hoehentreiber`);
  }
  // Die Leserichtung bleibt pro Feld erhalten: ein arabischer Name in einer
  // lateinischen Liste ist der Anlass, und der ist von der Kappung unberuehrt.
  for (const part of ['__name', '__meta', '__notes']) {
    assert.match(cssRuleBody(birthdays, `.birthday-item${part}`), /unicode-bidi:\s*plaintext/);
  }
  // Der Name darf nicht umbrechen, sonst ist die Zeile wieder zweizeilig.
  assert.match(cssRuleBody(birthdays, '.birthday-item__name'), /white-space:\s*nowrap/);
  // Und die Notiz haengt an der BREITE, nicht am Geraet.
  assert.match(birthdays, /@container birthdays-list \(min-width:[^)]+\)\s*\{\s*\.birthday-item__notes/,
    'die Notiz erscheint ueber einen Container-Query am Traeger, nicht ueber einen Viewport-Breakpoint');
  // Der `container-type` kommt seit dem Umzug auf `.row-carrier` aus dem
  // geteilten Traeger (list-row.css) - hier stand er ein zweites Mal und war
  // Teil des Nachbaus, der dieser Liste das Lesemass gekostet hat. Geprueft
  // wird deshalb die UEBERNAHME plus die Zusicherung an ihrem einen Ort, und
  // dass der eigene Container-Name daneben ausdruecklich stehen bleibt.
  assert.match(read('../public/pages/birthdays.js'), /class="row-carrier birthdays-list"/,
    'die Liste traegt den geteilten Traeger, statt ihn nachzubauen');
  assert.match(cssRuleBody(read('../public/styles/list-row.css'), '.row-carrier'), /container-type:\s*inline-size/,
    'ohne Container am Traeger fragt der Query ins Leere und die Notiz bliebe fuer immer aus');
  assert.match(cssRuleBody(birthdays, '.birthdays-list'), /container-name:\s*birthdays-list list-rows/,
    'beide Namen ausdruecklich - sonst gewinnt der spaeter geladene und der andere ist lautlos tot');
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

  // Die Rolle kommt seit der Vereinheitlichung aus der Variante des geteilten
  // Renderers (`error` -> `role="alert"`, utils/empty-state.js) statt aus einem
  // setAttribute hier. Geprueft wird deshalb die Variante - die Rolle selbst
  // haelt der Renderer-Guard weiter oben fest.
  assert.match(router, /function renderError\(container,\s*err\)[\s\S]*emptyStateEl\(\{[\s\S]{0,200}?variant:\s*'error'/);
  assert.match(router, /function renderError\(container,\s*err\)[\s\S]*description:\s*friendlyError\(err\)/);
  assert.match(router, /state\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(router, /Failed to fetch\|NetworkError\|Load failed/i);
  assert.match(router, /return t\(['"]common\.errorServer['"]\)/);
  assert.match(router, /err\?\.name === ['"]TypeError['"][\s\S]*return t\(['"]common\.unexpectedError['"]\)/);
  assert.match(notesPage, /catch \(err\)\s*\{[\s\S]*console\.error\([\s\S]*throw err;/);
});

test('Notes keeps user colours off the reading surface', () => {
  const notesPage = read('../public/pages/notes.js');
  const notesCss = read('../public/styles/notes.css');

  // Der Guard hielt bis Runde 3 die Zusage „die Textfarbe wird zur Laufzeit
  // aus der Zettelfarbe gerechnet" (getReadableTextColor). Die neue Welt gibt
  // eine staerkere: die Zettelfarbe traegt die Flaeche gar nicht mehr allein,
  // sie wird auf der Objekt-Stufe der Toenungsskala auf die Kartenflaeche
  // gemischt (--tint-surface, tokens.css 6b) - damit
  // haengt die Lesbarkeit an keiner Nutzerfarbe mehr, auch nicht an
  // Alt-Hex-Werten ausserhalb der Palette (DESIGN.md, User-Farben-Regel).
  assert.doesNotMatch(notesPage, /function isLightColor/);
  assert.doesNotMatch(notesPage, /getReadableTextColor/,
    'Eine zur Laufzeit gerechnete Textfarbe waere wieder eine ungemessene Paarung.');
  assert.match(notesPage, /style="--note-color:\$\{esc\(note\.color\)\};"/,
    'Die Zettelfarbe reist als CSS-Variable, nicht als background-color.');
  assert.match(notesPage, /style="--avatar-color:\$\{esc\(avatarColor\)\};"/);

  const cardRule = notesCss.match(/\n\.note-card\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(cardRule, /background:\s*color-mix\(in srgb, var\(--note-color[^)]*\) var\(--tint-surface\), var\(--color-surface\)\)/);
  assert.match(cardRule, /color:\s*var\(--color-text-primary\)/);
  assert.match(cardRule, /border:\s*none/, 'Karten sind randlos auf dem Grouped-Grund.');

  assert.doesNotMatch(
    notesCss.match(/\.note-card__content\s*\{[\s\S]*?\n\}/)?.[0] ?? '',
    /opacity:/,
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
  // Der Aufbau laeuft seit 2026-08-17 ueber `moduleIconEl` statt ueber einen
  // eigenen NAV_ICONS-Zugriff je Bau-Stelle; geprueft wird weiter der NAME.
  const navIcons = read('../public/nav-icons.js');
  assert.match(navIcons, /'more-horizontal':\s*\[/);
  assert.match(routerSource, /moduleIconEl\('more-horizontal',\s*'nav-item__icon'\)/);
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

/**
 * Jede Route erklärt ihren Dokumenttitel - in der Routentabelle, nicht daneben.
 *
 * Gemessener Anlass: die Titel standen in einer Map in `routeTitle()`. ROUTES
 * wuchs auf 20 Einträge, die Map kannte 13, und /forgot-password,
 * /reset-password und /join lieferten „Yuvomi · Yuvomi" - WCAG 2.4.2 ist Level
 * A, und es traf die drei Wege, über die ein neues Familienmitglied hereinkommt
 * (Audit 2026-08-08, P1-2). Dieselbe Bauform - Liste neben der Wahrheit - hat
 * das Repo bei den Modulregistern schon einmal eingeholt.
 *
 * `titleKey: null` zählt als erklärt: auf /login und /setup IST der App-Name der
 * Titel. Ein FEHLENDES titleKey ist der Fehler, nicht ein leeres.
 * Guard-Ebene 2 (Struktur, aus deklarativer Quelle).
 */
test('jede Route erklärt ihren Dokumenttitel, und jeder erklärte Key existiert in de.json', () => {
  const router = read('../public/router.js');

  // Nur die Einträge mit ausgeschriebenem Pfad; die programmatisch erzeugten
  // Sektionsrouten prüft der zweite Block, weil ihre Pfade woanders stehen.
  const entries = [...router.matchAll(/\{\s*path:\s*'([^']+)'\s*,\s*page:\s*'[^']+'\s*,\s*requiresAuth:\s*\w+\s*,\s*module:\s*(?:null|'[^']*')\s*,?([^}]*)\}/g)]
    .map((m) => ({ path: m[1], rest: m[2] }));

  assert.ok(entries.length >= 19,
    `Aus ROUTES kamen nur ${entries.length} Einträge - der Guard misst dann nichts. `
    + 'Hat sich die Schreibweise der Routen-Einträge geändert?');

  const untitled = entries.filter(({ rest }) => !/titleKey:/.test(rest)).map(({ path }) => path);
  assert.deepEqual(untitled, [],
    `Routen ohne titleKey: ${untitled.join(', ')}. Eine Route ohne Titel muss auffallen, `
    + 'nicht still auf den App-Namen fallen (WCAG 2.4.2, Level A). `titleKey: null` ist die '
    + 'erklärte Ausnahme für Anmelden/Ersteinrichtung.');

  // Die drei Auth-Routen namentlich: sie waren der gemessene Verstoß und sind
  // die einzigen anonymen Seiten, die einen eigenen Titel brauchen.
  for (const path of ['/forgot-password', '/reset-password', '/join']) {
    const entry = entries.find((e) => e.path === path);
    assert.ok(entry && /titleKey:\s*'[^']+'/.test(entry.rest),
      `${path} braucht einen eigenen Titel - es ist ein Weg in die App, kein Zwischenschritt`);
  }

  // Die Sektionsrouten führen ihren Titel in der jeweiligen map().
  assert.match(router, /SETTINGS_LEAVES\.map\([\s\S]{0,200}?titleKey:\s*'nav\.settings'/,
    'jedes Settings-Blatt braucht den Sektionstitel');
  assert.match(router, /HEALTH_ROUTES\.map\([\s\S]*?titleKey:\s*'nav\.health'/,
    'jede Health-Route braucht den Sektionstitel');

  // Kein toter Key: routeTitle() ruft t() darauf auf, und ein fehlender Key
  // liefert den Key selbst als Titel - sichtbar erst im Browser-Tab.
  const de = JSON.parse(read('../public/locales/de.json'));
  const lookup = (key) => key.split('.').reduce((node, part) => (node == null ? node : node[part]), de);
  const missing = [...router.matchAll(/titleKey:\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((key) => typeof lookup(key) !== 'string');
  assert.deepEqual([...new Set(missing)], [],
    `titleKey ohne Eintrag in de.json: ${missing.join(', ')}`);

  // Und der Titel wird AUS der Tabelle gelesen, nicht aus einer zweiten Liste.
  assert.match(router, /ROUTES\.find\(\(route\) => route\.path === path\)\?\.titleKey/,
    'routeTitle muss ROUTES lesen');
  assert.doesNotMatch(router, /const map = \{\s*\n\s*'\/':\s*t\(/,
    'die abgelöste Titel-Map darf nicht zurückkommen');
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
  // Anker auf Zeilenanfang: `.month-day--outside .month-day__event` steht früher
  // in der Datei und würde den ungebundenen Selektor-Match abfangen.
  const eventBody = cssRuleBody(calendar, '\n.month-day__event');
  const outsideEventBody = cssRuleBody(calendar, '.month-day--outside .month-day__event');
  const outsideDayBody = cssRuleBody(calendar, '\n.month-day--outside');

  assert.match(gridBody, /background-color:\s*var\(--color-border-subtle\)/, 'month grid should expose clear cell boundaries');
  assert.match(gridBody, /gap:\s*var\(--space-px\)/, 'month grid boundaries should use tokenized one-pixel gaps');
  assert.match(dayBody, /background-color:\s*var\(--color-surface-work\)/, 'month cells should use a stable work surface');
  // Getönte „Ton"-Fläche statt vollgesättigter Füllung: Tönung und lesbare Tinte
  // werden per color-mix aus --ev-color abgeleitet — theme-korrekt, weil
  // --color-surface-work und --color-text-primary im Dark Mode kippen.
  assert.match(eventBody, /background:\s*color-mix\(in srgb,\s*var\(--ev-color\)\s*var\(--tint-surface\),\s*var\(--color-surface-work\)\)/, 'event chips should sit on a tinted work surface, not a saturated fill');
  // Die TINTE bleibt eine Zahl, und das ist die User-Farben-Regel: die
  // Ink-Stufe gilt fuer kuratierte Modultoene, nicht fuer eine frei gewaehlte
  // Layer-Farbe (weiss auf light 1.92:1). Hier steht deshalb absichtlich keine
  // Stufe - wer sie einsetzt, hebelt die Ausnahme aus, die tokens.css 6b
  // benennt.
  assert.match(eventBody, /color:\s*color-mix\(in srgb,\s*var\(--ev-color\)\s*\d+%,\s*var\(--color-text-primary\)\)/, 'event chip text should be a readable ink derived from the event colour');
  // HIG-Rollout 2026-08: die Bar ist FLACH. Die frühere Kante aus --ev-color war
  // der dritte Farbträger derselben Information (Fläche, Tinte, Kante) und ließ
  // ein Monatsraster aus 30 umrandeten Kästchen entstehen. Apple Calendar zeigt
  // ebenfalls randlose Tint-Bars; die Zellgrenze trägt das 1px-Gap des Grids.
  assert.doesNotMatch(eventBody, /border:/, 'month bars read flat: the cell gap carries the boundary, not a per-bar border');
  assert.doesNotMatch(eventBody, /box-shadow/, 'tinted event chips should read flat, without a drop shadow');
  // Nachbarmonatstage dimmen über FLÄCHE und ZIFFER, nie über eine Opacity auf
  // dem Text: gemessen fiel die frühere `opacity: 0.5` auf 2.3-3.4:1 (unter AA).
  // Die Bars behalten dort ihr volles Ink-Rezept auf schwächerer Tönung.
  assert.match(outsideDayBody, /background-color:\s*var\(--color-bg\)/, 'previous/next month cells dim via their surface, not via text opacity');
  assert.doesNotMatch(outsideDayBody, /opacity:/, 'a blanket opacity on the cell would drag its text below AA');
  // „Nur schwaecher" ist jetzt pruefbar statt behauptet: die Nachbarmonats-Bar
  // steht eine Sprosse UNTER der Bar im laufenden Monat (wash statt surface).
  // Vorher stand hier `\d+%` gegen `\d+%` - der Guard war gruen, egal welche
  // der beiden Zahlen groesser war.
  assert.match(outsideEventBody, /background:\s*color-mix\(in srgb,\s*var\(--ev-color\)\s*var\(--tint-wash\),\s*var\(--color-surface-work\)\)/, 'outside-month bars keep the tint recipe, only weaker');
});

test('calendar agenda events and task chips keep readable contrast in mobile agenda', () => {
  const calendar = read('../public/styles/calendar.css');
  const eventBody = cssRuleBody(calendar, '.agenda-event');
  const colorBody = cssRuleBody(calendar, '.agenda-event__color');
  const taskBody = cssRuleBody(calendar, '.cal-task-chip');
  const metaBody = cssRuleBody(calendar, '.agenda-event__meta');

  // Die Flaeche, die den Kontrast traegt, gehoert seit der Zeilenlisten-Regel
  // (Runde 6, Phase 5) dem TRAEGER, nicht der Zeile: `.list-rows` steht auf
  // --color-surface-work und klippt die Gruppe, die Trennung ist seine
  // Haarlinie. Die Zusage bleibt dieselbe - eine Agenda-Zeile liegt auf einer
  // opaken Flaeche und hat eine sichtbare Grenze zur naechsten -, sie wird nur
  // eine Ebene hoeher eingeloest.
  assert.doesNotMatch(eventBody, /background(-color)?:/, 'the agenda row is a row: its surface belongs to the carrier');
  assert.doesNotMatch(eventBody, /border:|box-shadow:/, 'the agenda row is a row: no own edge, no own shadow');
  assert.match(read('../public/pages/calendar.js'), /<div class="list-rows">\$\{events/,
    'agenda events must sit in exactly one carrier (.list-rows), which carries surface and hairlines');
  // Kalenderfarbe ist ein zentrierter Dot (kein vollhoher Seitenstreifen) —
  // tokenisiert und sichtbar, konsistent mit den Status-Dots der Aufgabenliste.
  assert.match(colorBody, /width:\s*var\(--space-2\)/, 'agenda color dot should use a spacing token for its width');
  assert.match(colorBody, /height:\s*var\(--space-2\)/, 'agenda color dot should be a fixed-size dot, not a full-height rail');
  assert.match(colorBody, /border-radius:\s*var\(--radius-full\)/, 'agenda color dot should be round');
  // Die Toenung IST der zweite Kanal neben der Textfarbe. Kante und Schatten
  // waren ein dritter und vierter Traeger derselben Information - dieselbe
  // Zusage, die `.month-day__event` seit dem HIG-Rollout flach haelt, und der
  // Grund, aus dem im Monatsraster flache Event-Bars neben umrandeten
  // Aufgaben-Bars standen.
  // DIE TOENUNG IST WEG, UND DAS IST DER PUNKT (2026-08-19, Skalen-Regel).
  //
  // Hier stand `background: color-mix(in srgb, currentColor ...)` als Zusage -
  // der Chip toente aus seiner Prioritaetsfarbe und trug dieselbe Farbe als
  // Schrift darauf. Das ist die Bauart, die v2.23.0 fuer die Aufgabenliste
  // abgeschafft hat, und sie ueberlebte hier, weil dieser Test sie festhielt.
  // Gemessen lagen die vier getoenten Felder 6,61 (medium/high) und 6,77
  // (high/urgent) auseinander, bei 11,3 fuer die Diagrammserien des Projekts.
  //
  // Die Zusage ist jetzt die der Rangmarke: neutrale Flaeche, neutrale Schrift,
  // die Stufe im 8px-Vollton-Punkt daneben - dieselbe, die `.priority-dot` in
  // list-row.css fuer die Aufgabenliste traegt.
  assert.match(taskBody, /background:\s*var\(--color-fill-well\)/, 'task chips carry a neutral surface: the step is the dot, not the fill');
  assert.doesNotMatch(taskBody, /color-mix\(in srgb,\s*currentColor/, 'task chips must not tint from their priority colour: that is the retracted fassung of the scale rule');
  assert.match(read('../public/pages/calendar.js'), /class="priority-dot priority-dot--\$\{priority\}"/,
    'a task chip must render the shared priority dot (list-row.css), not a second fassung of the scale');
  assert.doesNotMatch(taskBody, /border(-color)?:|box-shadow:/, 'task chips read flat: the dot is the second channel, not an edge on top of it');
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

  // BEIDE tragen die Stimme, und das ist die Aufloesung eines Widerspruchs, den
  // dieser Guard selbst dokumentiert hat: Mahlzeiten folgte der frueheren
  // Module-Accent-Leads-Rule, der Kalender „bewusst noch nicht" - zwei
  // Datums-Navigationen desselben Bauteils in zwei Farbgrammatiken, seit einem
  // Durchgang, der nie kam. Die Eine-Stimme-Regel (DESIGN.md, 2026-08-10)
  // beantwortet das an der Wurzel: `.btn--icon` ist eine geteilte Variante und
  // tut in jedem Modul dasselbe. Der Modulton steht im Kopf am Siegel.
  assert.match(cssRuleBody(meals, '.week-nav .btn--icon'), /color:\s*var\(--color-accent\)/);
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
  assert.match(source, /calendarRepeatIconHtml\(ev\)/, 'recurrence markers should share the tokenized repeat icon helper');
  assert.match(source, /class="calendar-all-day-label"/, 'all-day gutter labels should use the shared label class');
  assert.match(allDayLabel, /font-size:\s*var\(--text-xs\)/, 'all-day labels should use a text token');
  assert.match(allDayLabel, /color:\s*var\(--color-text-secondary\)/, 'all-day labels should use readable secondary text');
  // DIESE ZEILE STAND AUF --space-12 UND HAT DEN FEHLER FESTGEHALTEN, NICHT GEFUNDEN.
  //
  // Gemeint war "die Breite kommt aus einem Token statt aus einer Zahl". Geprueft
  // wurde ein BESTIMMTES Token - und das falsche: --space-12 sind 48px, die
  // Zeitspalte daneben ist --cal-gutter-width (64px). Die rechtsbuendige
  // Beschriftung endete dadurch 16px links von den Stundenzahlen darunter, und
  // der Guard war nicht nur blind dafuer, er wurde beim Richtigstellen rot.
  //
  // Jetzt prueft er die Absicht: ein Token, und zwar der, den die Zeitspalte
  // selbst fuehrt. Welche Zahl dahintersteht, entscheidet tokens.css.
  assert.match(allDayLabel, /width:\s*var\(--cal-gutter-width\)/,
    'all-day gutter width should come from the same token as the hour column, not a second spacing value');
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

  const mediaBlock = darkSchemeBlock(tokens);
  const attrBlock = darkAttrBlock(tokens);

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
  const mediaBlock = darkSchemeBlock(tokens);
  const attrBlock = darkAttrBlock(tokens);

  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(mediaBlock, 'expected a prefers-color-scheme dark block');
  assert.ok(attrBlock, 'expected a [data-theme="dark"] block');

  const root = parseTokenMap(rootBlock[1]);
  const media = parseTokenMap(mediaBlock[1]);
  const attr = parseTokenMap(attrBlock[1]);
  const publicSurfaceTokens = [
    '--color-surface-work',
    '--color-surface-raised',
    '--app-backdrop-accent-strength',
    '--app-backdrop-secondary-strength',
  ];
  // --_color-surface-glass hat KEINE oeffentliche Fassade mehr: die trug niemand
  // im Stylesheet, waehrend der private Wert weiter --_glass-bg-card speist. Ein
  // oeffentliches Token ohne Nutzer ist eine API-Zusage ohne Deckung.
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

/**
 * „Heute wichtig" ist seit dem HIG-Rollout (2026-08) EINE Inset-Grouped-Liste,
 * kein 2×2-Kachelraster mehr.
 *
 * Der abgelöste Guard hielt das 2×2-Glance-Raster fest: vier pastellgefüllte
 * Stat-Kacheln mit fester Mindesthöhe. Genau diese Bauart hat das Finish-Review
 * der Fundament-Phase abgeräumt - vier gerahmte Kacheln in einem gerahmten
 * Masthead waren genestete Karten, und der Hero-Metrik-Look ist der
 * Kategorie-Default, den der Kanon verweigert. Die neue Form ist Apples
 * Grouped-Liste: eine Fläche, Zeilen mit Haarlinien, getönte Icon-Kachel pro
 * Zeile, trailing Count.
 *
 * Der Guard hält jetzt die FORM fest, nicht die alte Geometrie.
 */
test('dashboard „Heute wichtig" is one inset-grouped list, not a tile grid', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const gridBody = cssRuleBody(dashboard, '.today-cockpit__grid');
  const cardBody = cssRuleBody(dashboard, '\n.today-cockpit-card');
  const iconBody = cssRuleBody(dashboard, '.today-cockpit-card__icon');

  // Die GRUPPE trägt Fläche, Rundung und Schatten - genau einmal.
  //
  // DIE RUNDUNG IST EINE ROLLE, KEIN WERT. Hier stand `--radius-lg` fest
  // verdrahtet, und damit hielt der Guard eine Zahl statt seiner eigenen
  // Aussage („die Gruppe ist der gerundete Behälter, nicht die Zeile"). Als das
  // Tagesprogramm seinen Rang bekam - eine Stufe über den Widget-Karten, weil es
  // der Hauptgegenstand der Seite ist -, schlug er auf einen Wechsel an, den er
  // gar nicht bewacht. Gebunden bleibt: die Gruppe rundet über einen TOKEN, und
  // die Zeile rundet gar nicht.
  assert.match(gridBody, /grid-template-columns:\s*1fr/, 'the group is a single column of rows, not a tile grid');
  assert.match(gridBody, /background:\s*var\(--color-surface\)/, 'the group carries one opaque surface');
  assert.match(gridBody, /border-radius:\s*var\(--radius-[a-z0-9]+\)/, 'the group is the rounded container, and it rounds via a token');
  assert.match(gridBody, /overflow:\s*hidden/, 'rows must clip to the group radius');
  assert.doesNotMatch(gridBody, /repeat\(2,/, 'the 2×2 glance grid belongs to the superseded world');

  // Die ZEILE trägt keine eigene Karte.
  assert.match(cardBody, /background:\s*transparent/, 'rows sit on the group surface, not on their own');
  assert.match(cardBody, /border:\s*none/, 'rows are separated by hairlines, never framed');
  assert.doesNotMatch(cardBody, /border-radius/, 'the row never rounds - only the group does');
  assert.match(cardBody, /min-height:\s*var\(--target-base\)/, 'row height stays tokenized against the touch target');
  assert.match(
    dashboard,
    /\.today-cockpit-card \+ \.today-cockpit-card\s*\{[^}]*border-top:\s*1px solid var\(--color-border-subtle\)/,
    'consecutive rows are divided by a hairline',
  );

  // Modul-Identität lebt im Markensiegel (Block 2): die Kachel leitet ihren
  // Tone-Akzent an den geteilten .module-seal-Baustein weiter, der Baustein
  // trägt das Tönungsrezept, und das Markup bindet beide Klassen aneinander.
  // Reißt eines der drei Glieder, ist die Kachel wieder ein Eigenbau.
  assert.match(iconBody, /--seal-accent:\s*var\(--today-card-accent\)/, 'the icon well forwards its tone accent to the seal');
  const layout = read('../public/styles/layout.css');
  // JEDE REGEL, DIE DAS SIEGEL ANSPRICHT, nicht die eine, die so heisst: seit
  // 2026-08-18 teilt es seine HAUT mit `.vivid-mark` (die Marken der
  // Modulseiten borgen sie, ohne ihre Geometrie aufzugeben), und damit steht
  // das Rezept in einer Regel mit zwei Selektoren. Ein Guard, der nur
  // `.module-seal {` sucht, faellt genau ueber diese Zusammenlegung - und
  // haette sie als Rueckbau des Volltons gemeldet, obwohl sie ihn ausweitet.
  const sealBody = [...eachRule(layout)]
    .filter((r) => r.selector.split(',').some((s) => s.trim() === '.module-seal'))
    .map((r) => r.body)
    .join('\n');
  assert.ok(sealBody, 'keine .module-seal-Regel gefunden - die Signatur greift nicht mehr');
  // DAS SIEGEL HAT EIN GESICHT, UND ES IST DER VOLLTON (2026-08-17).
  //
  // Hier stand das Toenungsrezept (16 % gegen einen parametrischen Grund
  // --seal-base) - der Guard hielt fest, was dark-chroma.mjs am selben Tag
  // widerlegt hat: eine Beimischung hellt im Dark fast nur auf, statt Farbe zu
  // tragen. Im Light war es noch schaerfer: Notizen, Dokumente und Inventar
  // teilen die Familie „records", und ihr Scheibengrund war bei 16 % bitweise
  // derselbe. Der Ton IST jetzt die Flaeche, die Tinte ist --color-ink-on-vivid.
  assert.match(sealBody, /background:[\s\S]*var\(--seal-accent\);/, 'the seal carries its module tone as the disc itself');
  assert.match(sealBody, /color:\s*var\(--color-ink-on-vivid\)/, 'the glyph is the measured ink on a vivid ground');
  // Und die Toenung kommt nicht durch die Hintertuer zurueck: --seal-base war
  // der Parameter, den NUR sie brauchte. Steht er wieder da, steht auch wieder
  // eine Mischung dahinter.
  //
  // UEBER `eachRule`, NICHT UEBER DIE QUELLE: die Begruendung des Rueckbaus
  // nennt den Namen mehrfach im Kommentar, und ein Guard, der die Datei als
  // Text liest, findet seine eigene Erklaerung und faellt darueber. Es ist
  // dieselbe Falle, die test/css-rules.js oben beschreibt.
  const sealGrounds = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      if (/--seal-base\s*:/.test(body)) sealGrounds.push(`${file}: ${selector}`);
      if (selector.includes('.module-seal--vivid')) sealGrounds.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(sealGrounds, [],
    'Das Siegel hat ein Gesicht: kein --seal-base (den brauchte nur die Toenung) und '
    + 'kein --vivid (das waehlte zwischen zweien aus).\n' + sealGrounds.join('\n'));
  const dashboardJs = read('../public/pages/dashboard.js');
  assert.match(dashboardJs, /class="module-seal today-cockpit-card__icon"/, 'the cockpit icon well takes its form from the seal');

  // Sehr schmale Container bleiben einspaltig (Container-Query, kein Viewport-BP)
  assert.match(
    dashboard,
    /@container today-cockpit \(max-width:\s*270px\)[\s\S]*grid-template-columns:\s*1fr/,
    'very narrow cockpit container should fall back to a single column'
  );
});

/**
 * Der Speed-Dial des Dashboards ist ein Page-FAB, kein Nachbau.
 *
 * Er war der einzige FAB der App mit eigener Geometrie: `.fab-main` schrieb
 * 52px (48px am Desktop) von Hand und kannte die Touch-Stufe von `--fab-size`
 * dadurch nicht, und `.dashboard` trug seinen eigenen `padding-bottom` als
 * FAB-Freiraum. Beides ist mit dem Folgevorgang zu #634 entfallen: der Knopf
 * ist ein `.page-fab`, `adoptPageFab()` hebt ihn samt Liste aus dem Scrollport,
 * und `--fab-safe-zone` traegt den Freiraum an `.app-content` fuer alle Module
 * aus einer Quelle.
 *
 * Geprueft wird die REGEL, nicht der Klassenname: dashboard.css darf ueberhaupt
 * keine FAB-Geometrie mehr schreiben. Eine Allowlist der drei bekannten
 * Selektoren haette den vierten nicht gesehen.
 */
test('the dashboard speed dial owns no FAB geometry of its own', () => {
  const dashboard = read('../public/styles/dashboard.css');
  const live = dashboard.replace(/\/\*[\s\S]*?\*\//g, '');

  assert.doesNotMatch(live, /\.fab-container|\.fab-main/,
    'der eigene Kasten des Dashboards ist entfallen - der Dial ist eine '
    + '.page-fab-group mit einem .page-fab darin (#634)');
  for (const rule of live.match(/[^{}]*\bfab\b[^{]*\{[^}]*\}/g) ?? []) {
    assert.doesNotMatch(rule, /\b(?:width|height):\s*\d/,
      `dashboard.css schreibt wieder eine FAB-Groesse von Hand statt --fab-size:\n${rule}`);
  }
  assert.doesNotMatch(cssRuleBody(dashboard, '.dashboard'), /padding-bottom/,
    'die FAB-Reserve kommt aus --fab-safe-zone an .app-content; eine zweite '
    + 'Reserve am Modul stapelt sich zu totem Raum (Audit A1-16)');
  assert.doesNotMatch(
    dashboard,
    /@media \(max-width:\s*639px\)[\s\S]*\.dashboard-shell\s*\{[^}]*padding-bottom/,
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

// Bis Block 2 (2026-08-10) verglich dieser Guard genau zwei Namen
// (--_module-dashboard gegen --_module-calendar) - das Kollisionspaar von
// damals. Seit den Familientoenen ist die Regel allgemein: die Modul-Akzente
// leben in --_family-*-Werten, und KEIN Familienpaar darf denselben Wert
// tragen, sonst kehrt die Kollision (zwei Violetts, zwei Teals) still zurueck.
// Dazu bezieht jedes --module-* seinen Wert aus einer Familie: ein Solo-Hex an
// einem Modul wuerde die Familienregel unterlaufen, ohne dass es ein Paar gibt.
test('module accent families stay pairwise distinct and every module draws from one', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = darkAttrBlock(tokens);

  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  for (const [theme, block] of [['light', rootBlock[1]], ['dark', darkBlock[1]]]) {
    const values = parseTokenMap(block);
    const families = [...values.entries()].filter(([name]) => name.startsWith('--_family-'));
    assert.ok(
      families.length >= 9,
      `${theme}: expected the module accent families in this block, found ${families.length}`,
    );
    const seen = new Map();
    for (const [name, value] of families) {
      const v = value.toLowerCase();
      assert.ok(
        !seen.has(v),
        `${theme}: ${name} shares its value ${v} with ${seen.get(v)} - family accents must stay pairwise distinct`,
      );
      seen.set(v, name);
    }
  }

  const rootValues = parseTokenMap(rootBlock[1]);
  for (const [name, value] of rootValues) {
    if (!name.startsWith('--module-')) continue;
    assert.match(
      value,
      /^var\(--_family-[\w-]+\)$/,
      `${name} must draw its value from a --_family-* token, got: ${value}`,
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
  // Kommentare zuerst entfernen: eine Prosa-Zeile wie "…gemessen gegen --color-bg:
  // 1.16:1" sieht fuer die Deklarations-Regex wie eine Zuweisung aus und
  // ueberschreibt dann den echten Token-Wert (2026-08-06 genau so passiert).
  for (const [, name, value] of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
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
  const darkBlock = darkAttrBlock(tokens);
  assert.ok(rootBlock, 'expected a :root token block');
  assert.ok(darkBlock, 'expected a [data-theme="dark"] block');

  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);

  // Normaltext-Paare, die laut Design AA erfüllen müssen.
  //
  // DIESE SECHS SIND EINE ZUSAGE, KEINE ABDECKUNG. Sie halten die Grundpaarung
  // der Leseflächen fest, auch wenn heute keine Regel sie zusammen deklariert -
  // ein Vertrag, gegen den jemand ein Token verschieben könnte. Was der Bestand
  // TATSÄCHLICH baut, prüft `jede Regel, die Farbe UND Untergrund setzt, haelt
  // ihr eigenes Paar` (unten, 198 Paare aus dem Stylesheet abgeleitet). Wer hier
  // ein Paar ergänzt, ergänzt einen Vertrag; wer eine Regel absichern will,
  // braucht hier nichts zu tun.
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

/* ────────────────────────────────────────────────────────────────────────────
 * Jedes Paar, das eine Regel SELBST baut - nicht sechs, die jemand aufschrieb
 *
 * Der Guard darueber prueft eine Liste von sechs Token-Paaren. Am 2026-08-08
 * lagen VIER Kontrastbefunde in der App, und keiner stand darunter:
 *
 *   .btn--danger:hover                dark  2,87:1   (--color-danger-hover)
 *   .settings-module-status--enabled  dark  1,97:1   (--color-success-hover)
 *   .settings-banner--error u. a.     light 4,45:1   (Semantik auf eigener Fuellung)
 *   .meal-type-badge--dinner          dark  4,46:1   (dieselbe Bauart, andere Familie)
 *
 * Das ist die Allowlist-Signatur, die dieses Repo bei der Kueche und beim Budget
 * schon zweimal eingeholt hat: ein Guard ueber eine Aufzaehlung deckt keine
 * Regel ab, sondern N Eintraege. Hier kommt das Paar deshalb aus dem
 * STYLESHEET - jede Regel, die Textfarbe UND Untergrund im selben Block setzt,
 * hat sich ihr Paar selbst gebaut und muss es halten. Gemessen: 198 solche
 * Regeln, und der Bestand haelt sie (die Regel meint also den Bestand - Falle 4).
 *
 * WAS ER NICHT SIEHT, UND WER ES SIEHT: eine Regel, die nur `color` setzt und
 * ihren Untergrund vom Vorfahren erbt. Das ist keine Luecke dieses Guards,
 * sondern die Frage einer anderen Ebene - Sonde 2 komponiert die Vorfahrenkette
 * im gerenderten Dokument und hat genau so die drei Settings-Befunde gefunden.
 * Uebersprungen werden ausserdem `color-mix()`-Untergruende (152 Stueck): was
 * eine Toenung ergibt, haengt an der Flaeche darunter, und die kennt nur das
 * Dokument.
 *
 * DIE ZWEI AUSNAHMEN SIND KATEGORIEN AUS DEM STANDARD, keine Einzelfaelle:
 * ein deaktiviertes Bedienelement nimmt WCAG 1.4.3 ausdruecklich aus, und ein
 * Ziel, das ein ICON traegt statt Text, faellt unter 1.4.11 mit 3:1. Wer hier
 * etwas eintraegt, nennt die Kategorie - nicht den Grund „gewachsen".
 * ──────────────────────────────────────────────────────────────────────────── */

// Selektor-Teilstring -> Kategorie. Geprueft wird gegen den Standard, nicht
// gegen eine Meinung; die Stale-Pruefung darunter haelt sie ehrlich.
const COPAIR_CATEGORY = new Map([
  ['[disabled] .ydp__input', { min: 0, why: 'WCAG 1.4.3 nimmt deaktivierte Bedienelemente aus; Sonde 2 tut dasselbe' }],
  ['.ydp__trigger:hover', { min: 3, why: 'Ziel traegt ein 18px-Icon, keinen Text - WCAG 1.4.11 (3:1), gemessen 3,30:1 dark' }],
]);

test('jede Regel, die Farbe UND Untergrund setzt, haelt ihr eigenes Paar', () => {
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = darkAttrBlock(tokens);
  assert.ok(rootBlock && darkBlock, 'expected :root and [data-theme="dark"] token blocks');
  const light = parseTokenMap(rootBlock[1]);
  const dark = new Map(light);
  for (const [k, v] of parseTokenMap(darkBlock[1])) dark.set(k, v);

  // `var(--x, fallback)` mitnehmen: `.settings-backup-card__icon` schreibt so,
  // und ein Parser, der nur `var(--x)` kennt, uebersieht die Regel still.
  const resolveValue = (value, map, depth = 0) => {
    if (!value || depth > 12) return null;
    const v = value.trim();
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
    if (ref) return resolveValue(map.get(ref[1]) ?? ref[2], map, depth + 1);
    return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
  };
  const lastDecl = (body, prop) => {
    let found = null;
    for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))) found = m[1].trim();
    return found;
  };

  // Nur die Stufen, die als Textgroesse vorkommen. Ein unbekanntes Token faellt
  // auf 4.5 zurueck - strenger urteilen als noetig ist hier richtig herum.
  const SIZE_PX = {
    '--text-xs': 12, '--text-sm': 14, '--text-base': 16, '--text-lg': 18, '--text-xl': 20, '--text-2xl': 24, '--text-3xl': 30,
  };

  const styles = new URL('../public/styles/', import.meta.url);
  const files = readdirSync(styles).filter((entry) => entry.endsWith('.css') && entry !== 'tokens.css');
  const findings = [];
  const usedCategories = new Set();
  let pairs = 0;

  for (const file of files) {
    for (const rule of eachRule(readFileSync(new URL(file, styles), 'utf8'))) {
      const fgRaw = lastDecl(rule.body, 'color');
      const bgRaw = lastDecl(rule.body, 'background-color') ?? lastDecl(rule.body, 'background');
      if (!fgRaw || !bgRaw) continue;
      // Ein Verlauf hat keinen EINEN Untergrund, eine Toenung keinen ohne die
      // Flaeche darunter, und `currentColor` ist gar keine Farbe an dieser
      // Stelle. Alle drei gehoeren dem Dokument, nicht dem Stylesheet.
      if (/gradient|color-mix|transparent|currentColor|inherit|none/i.test(bgRaw)) continue;
      if (/color-mix|currentColor|inherit/i.test(fgRaw)) continue;
      pairs += 1;

      const category = [...COPAIR_CATEGORY.entries()].find(([needle]) => rule.selector.includes(needle));
      if (category) usedCategories.add(category[0]);
      const sizeToken = lastDecl(rule.body, 'font-size')?.match(/--[\w-]+/)?.[0];
      const px = sizeToken ? SIZE_PX[sizeToken] : null;
      const bold = /bold|[6-9]00/.test(lastDecl(rule.body, 'font-weight') ?? '');
      const large = px !== null && px !== undefined && (px >= 24 || (px >= 18.66 && bold));
      const min = category ? category[1].min : (large ? 3 : 4.5);
      if (min === 0) continue;

      for (const [theme, map] of [['light', light], ['dark', dark]]) {
        const fg = resolveValue(fgRaw, map);
        const bg = resolveValue(bgRaw, map);
        if (!fg || !bg) continue;
        const ratio = contrastRatio(fg, bg);
        if (ratio + 0.005 < min) {
          findings.push(
            `${theme}: ${ratio.toFixed(2)}:1 (soll ${min})  ${fg} auf ${bg}  ${file}  ${rule.selector}`
            + `${rule.at.length ? `  [${rule.at.join(' ')}]` : ''}`,
          );
        }
      }
    }
  }

  // Ein Guard, der nichts gemessen hat, darf nicht urteilen - dieselbe
  // Zusicherung wie bei den Sonden. Ohne sie waere ein kaputter Parser von
  // „alles in Ordnung" nicht zu unterscheiden.
  assert.ok(pairs >= 150,
    `Nur ${pairs} ko-deklarierte Farbpaare gefunden (gemessen: 198). Der Regelscanner `
    + 'oder die Deklarations-Suche greift nicht mehr - der Guard misst nichts, statt nichts zu finden.');

  assert.deepEqual(findings.sort(), [],
    'Regeln, die ihr eigenes Farbpaar nicht halten. Die Antwort ist fast nie ein neuer '
    + 'Sonderwert: eine Semantikfarbe auf ihrer EIGENEN blassen Fuellung nimmt die lesbare '
    + 'Stufe (`--color-<n>-ink` / `--meal-<n>-ink`, tokens.css). Wer die Fuellung stattdessen '
    + 'aufhellt, tauscht den Textkontrast gegen die Sichtbarkeit der Flaeche.');

  // Eine Kategorie fuer eine Regel, die es nicht mehr gibt, ist eine Allowlist,
  // die niemand mehr liest (dieselbe Pruefung wie bei SHAPE_EXEMPT).
  const stale = [...COPAIR_CATEGORY.keys()].filter((needle) => !usedCategories.has(needle));
  assert.deepEqual(stale, [],
    'COPAIR_CATEGORY nennt Selektoren, die in keinem Stylesheet mehr ein Farbpaar bauen.');
});

test('module accents stay readable as text on the page background in both themes', () => {
  // `.btn--secondary` faerbt seine Beschriftung mit --active-module-accent
  // (layout.css). Steht so ein Button auf dem Seitenhintergrund statt in einer
  // Karte, entscheidet allein die Modulfarbe ueber die Lesbarkeit - im Light-
  // Theme lagen sechs Farben darunter (Settings-Audit 2026-07-27: 4.13:1 bei
  // "Kanal hinzufuegen", 4.20:1 bei "Aus Kontakten importieren").
  const tokens = read('../public/styles/tokens.css');
  const rootBlock = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkBlock = darkAttrBlock(tokens);
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
  const darkBlock = darkAttrBlock(tokens);
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
 * Die Schwesterregel - und die Luecke, die der Guard darueber bauartbedingt
 * NICHT sieht.
 *
 * Jene Regel misst eine Fuellung gegen die Textfarbe DESSELBEN Blocks. Die
 * getoenten Flaechen (`--color-*-light`) werden aber fast immer im Zustand
 * gesetzt und die Textfarbe in der Basis:
 *
 *     .contact-menu-item--danger        { color: var(--color-danger); }
 *     .contact-menu-item--danger:hover  { background: var(--color-danger-light); }
 *
 * Zwei Bloecke, ein Bauteil - der Blockguard sah nie beide zusammen. Genau so
 * sind in Runde 8 zwei Stellen davongedriftet: `--color-danger` wanderte von
 * #B91C1C auf #D70015 und stand damit mit 4,45:1 auf der Toenung, waehrend acht
 * andere Stellen laengst `--color-danger-ink` (5,69:1) trugen. Beide Suiten
 * blieben gruen, und im Dark faellt es nicht auf (5,84:1) - eine Pruefung, die
 * nur ein Theme ansieht, haette hier nichts gefunden.
 *
 * Deshalb schluesselt dieser Guard ueber das BAUTEIL: Selektor ohne
 * Zustandsteil, im selben At-Kontext. Trifft dort eine Toenung auf eine
 * Textfarbe, wird gerechnet - in beiden Themes, ohne Allowlist. Eine Toenung
 * ohne eigene Textfarbe (`.settings-retry-state`) erbt Fliesstext und ist kein
 * Paar; sie bleibt zu Recht ungeprueft.
 */
test('Text auf getoenter Flaeche haelt WCAG AA in beiden Themes', () => {
  const { light, dark } = themeTokenMaps();
  const dir = new URL('../public/styles/', import.meta.url);
  const TINT = /^--color-[\w-]+-light$/;
  const PURE_VAR = /^var\(\s*(--[\w-]+)\s*\)$/;

  // Der Zustand gehoert nicht zum Bauteil: `.x`, `.x:hover` und `.x:focus-visible`
  // sind dieselbe Flaeche, und die Kaskade legt ihre Deklarationen uebereinander.
  const componentKeys = (selector, at) => selector
    .split(',')
    .map((part) => part.trim().replace(/::?[\w-]+(?:\([^)]*\))?/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => `${at.join(' | ')}||${part}`);

  const declaration = (body, prop) => {
    const m = body.match(new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+)`));
    return m ? m[1].trim() : null;
  };

  // Bauteil -> { tints, base } - `base` sind die Textfarben, die das Bauteil
  // ausserhalb seiner Toenungsregeln traegt.
  const components = new Map();
  const entryFor = (key) => {
    if (!components.has(key)) components.set(key, { tints: [], base: [] });
    return components.get(key);
  };

  for (const file of readdirSync(dir).filter((n) => n.endsWith('.css') && n !== 'tokens.css')) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      const fill = declaration(body, 'background(?:-color)?')?.match(PURE_VAR)?.[1];
      const text = declaration(body, 'color')?.match(PURE_VAR)?.[1];
      if (!fill && !text) continue;
      const where = `${file} {${selector}}`;

      for (const key of componentKeys(selector, at)) {
        const entry = entryFor(key);
        // Setzt die Toenungsregel ihre Textfarbe selbst, gilt SIE - sie ist
        // durch den Zustandsteil mindestens so spezifisch wie die Basis. Sonst
        // erbt die Flaeche, was das Bauteil sonst traegt.
        if (fill && TINT.test(fill)) entry.tints.push({ token: fill, own: text, where });
        else if (text) entry.base.push({ token: text, where });
      }
    }
  }

  const violations = [];
  for (const { tints, base } of components.values()) {
    for (const tint of tints) {
      const inks = tint.own
        ? [{ token: tint.own, where: tint.where }]
        : base;
      for (const ink of inks) {
        for (const [theme, map] of [['light', light], ['dark', dark]]) {
          const surface = resolveColor(tint.token, map);
          const color = resolveColor(ink.token, map);
          if (!/^#[0-9a-f]{6}$/i.test(surface ?? '') || !/^#[0-9a-f]{6}$/i.test(color ?? '')) continue;
          const ratio = contrastRatio(color, surface);
          if (ratio >= 4.5) continue;
          violations.push(
            `${theme}: ${ink.token} (${color}, ${ink.where}) auf ${tint.token} `
            + `(${surface}, ${tint.where}) = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }

  assert.deepEqual([...new Set(violations)].sort(), [],
    'Text auf einer -light-Toenung gehoert auf den zugehoerigen -ink-Ton');
});

/**
 * Ein Verlauf kennt keine Schreibrichtung.
 *
 * Die Rand-Fades der Scroll-Leisten heissen logisch (`has-fade-start` /
 * `has-fade-end`), ihre Masken sind aber physisch: `linear-gradient(to right,
 * …)`. In `ar` und `fa` setzt die App `dir=rtl` - dort liegt der Anfang rechts,
 * und dieselbe Maske daempfte die sichtbaren Chips, waehrend die verborgenen
 * hart abgeschnitten blieben. Genau verkehrt herum.
 *
 * Der Guard formuliert die Regel: JEDE horizontale Maskenregel braucht ihr
 * RTL-Gegenstueck. `to bottom` bleibt aussen vor - die Blockrichtung dreht mit
 * `dir` nicht.
 */
test('jede horizontale Fade-Maske hat ihr RTL-Gegenstueck', () => {
  const dir = new URL('../public/styles/', import.meta.url);
  const HORIZONTAL = /mask-image\s*:\s*linear-gradient\(\s*to (?:right|left)/;
  const missing = [];
  let physical = 0;

  for (const file of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    const rules = [...eachRule(read(`../public/styles/${file}`))];
    const rtl = new Set(
      rules
        .filter(({ selector }) => selector.includes('[dir="rtl"]'))
        .map(({ selector, at }) => `${at.join(' | ')}||${selector.replace(/\[dir="rtl"\]\s*/g, '').trim()}`),
    );

    for (const { selector, body, at } of rules) {
      if (selector.includes('[dir="rtl"]')) continue;
      if (!HORIZONTAL.test(body)) continue;
      physical += 1;
      if (!rtl.has(`${at.join(' | ')}||${selector.trim()}`)) {
        missing.push(`${file} {${selector}}: physische Maskenachse ohne [dir="rtl"]-Spiegelung`);
      }
    }
  }

  // Reichweite vor dem Urteil - ohne Fundstellen prueft die Zusicherung nichts.
  assert.ok(physical >= 4, `erwartet: horizontale Maskenregeln, gefunden: ${physical}`);
  assert.deepEqual(missing, [],
    'eine physische Verlaufsachse muss in RTL gespiegelt werden, sonst fadet die falsche Kante');
});

/**
 * Wer die Zeilenknoepfe auf Touch versteckt, darf sie nicht ENTFERNEN.
 *
 * Geburtstage und Abos blendeten ihre `__actions` unter `(hover: none)` per
 * `display: none` aus - optisch richtig (die Geste traegt dort dieselben zwei
 * Aktionen), fuer die Bedienung aber fatal: `display: none` nimmt die Knoepfe
 * auch aus dem Fokus- und Screenreader-Baum. Die Gesten haengen ausschliesslich
 * an `touchstart`/`touchmove`, die Reveal-Panels sind `aria-hidden`, und die
 * Zeilen selbst tragen keine Aktion. Wer sein Telefon per Tastatur,
 * Schaltersteuerung oder VoiceOver bedient, kam an keinen Eintrag mehr heran.
 *
 * Die Regel, nicht die zwei Fundstellen: JEDE Zeilenaktionsgruppe, die sich auf
 * Touch zurueckzieht, muss fokussierbar bleiben. Das naechste Modul, das die
 * Gesten uebernimmt, faellt sonst in dieselbe Grube.
 */
test('Zeilenaktionen ziehen sich auf Touch zurueck, ohne unerreichbar zu werden', () => {
  const dir = new URL('../public/styles/', import.meta.url);
  const ACTIONS = /(?:^|[\s,>+~])\.[\w-]*(?:row-actions|__actions)\b/;
  const violations = [];
  let seen = 0;

  for (const file of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!at.some((preamble) => /hover:\s*none/.test(preamble))) continue;
      if (!ACTIONS.test(selector)) continue;
      seen += 1;
      if (/(?:^|[\s;])display\s*:\s*none/.test(body)) {
        violations.push(`${file} {${selector}}: display: none nimmt die Knoepfe aus dem Fokusbaum`);
      }
    }
  }

  // Reichweite VOR dem Urteil: ohne Fundstellen prueft die Zusicherung nichts.
  assert.ok(seen >= 2, `erwartet: Zeilenaktionsregeln unter (hover: none), gefunden: ${seen}`);
  assert.deepEqual(violations, [],
    'auf Touch versteckt heisst aus dem Fluss nehmen (clip-path), nicht display: none');
});

/**
 * Die Gegenprobe: der Guard darueber taugt nur, wenn es die Paare, die er
 * pruefen soll, ueberhaupt gibt. Eine Zusicherung ueber eine leere Liste ist
 * keine - die Suite haette den Fall auch gruen gemeldet, wenn der Scanner
 * keine einzige Toenung gefunden haette.
 */
test('der Toenungs-Guard sieht die Toenungsflaechen der App', () => {
  const dir = new URL('../public/styles/', import.meta.url);
  const pairs = [];

  for (const file of readdirSync(dir).filter((n) => n.endsWith('.css') && n !== 'tokens.css')) {
    const src = read(`../public/styles/${file}`);
    if (/background(?:-color)?\s*:\s*var\(\s*--color-[\w-]+-light\s*\)/.test(src)) pairs.push(file);
  }

  assert.ok(pairs.length >= 4,
    `erwartet: mehrere Dateien mit -light-Toenungen, gefunden: ${pairs.join(', ') || 'keine'}`);
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
 * `updateThemeColorForRoute` schreibt in beide `<meta name="theme-color">`.
 * Ein Attribut nimmt an keiner Kaskade teil, also behielt die Statusbar nach
 * hell/dunkel den Wert des alten Themes, waehrend die Shell darunter laengst
 * umgeschaltet hatte. (Seit dem HIG-Rollout ist der Wert der Seitengrund und
 * nicht mehr der Modul-Tint - die Nachzieh-Pflicht bleibt.) Sichtbar nur in der
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

/**
 * Nachziehen allein genuegt nicht, wenn die Auswahl beim System liegt.
 *
 * Die beiden `<meta name="theme-color">` tragen ein `media="(prefers-color-
 * scheme: …)"` - WELCHE gilt, entscheidet damit das Betriebssystem, waehrend die
 * App es ueber `data-theme` entscheidet. Der Guard darueber belegt nur, dass
 * beide Umschaltwege `setThemeColor` erneut aufrufen; genau das half hier nicht,
 * weil derselbe Aufruf dasselbe Paar noch einmal schrieb. Wer auf einem hellen
 * System ausdruecklich Dunkel waehlte, behielt die helle Statusbar ueber der
 * dunklen Seite.
 *
 * Deshalb muss die Funktion die AUSDRUECKLICHE Wahl kennen und bei ihr beide
 * Metas auf die aktive Farbe setzen. Nur ohne `data-theme` bleibt das Paar ein
 * Paar - dort ist das System die richtige Quelle.
 */
test('die Statusbar folgt der ausdruecklichen Theme-Wahl, nicht nur dem System', () => {
  const router = read('../public/router.js');
  const fn = router.match(/function setThemeColor\([\s\S]*?\n\}/);
  assert.ok(fn, 'expected setThemeColor to own the meta writes');

  assert.match(fn[0], /getAttribute\('data-theme'\)/,
    'setThemeColor muss die ausdrueckliche Wahl lesen - die Metas folgen sonst dem System');

  // Der Anfangszustand gehoert dorthin, wo die Theme-Entscheidung faellt: der
  // Router korrigiert die Bewegung, aber die Offline-Huelle hat keinen Router.
  const init = read('../public/theme-init.js');
  assert.match(init, /meta\[name="theme-color"\]/,
    'theme-init.js muss die Statusbar auf die gewaehlte Farbe stellen - sonst haengt die Offline-Huelle');

  // DIE REGEL, NICHT DIE ZWEI DATEIEN: jedes Dokument mit system-gebundenen
  // theme-color-Metas braucht das Skript, das die Wahl darauf anwendet. Ohne
  // diesen Teil deckte der Guard genau die Seiten ab, die heute existieren -
  // und offline.html war genau die, die beim ersten Anlauf fehlte.
  const docs = ['index.html', 'offline.html'];
  const scopedDocs = [];
  const unfixed = [];
  for (const name of docs) {
    const src = read(`../public/${name}`);
    const scoped = [...src.matchAll(/<meta name="theme-color"[^>]*media="\(prefers-color-scheme/g)];
    if (!scoped.length) continue;
    scopedDocs.push(name);
    assert.equal(scoped.length, 2, `${name}: erwartet zwei system-gebundene Metas, gefunden ${scoped.length}`);
    if (!/<script[^>]+src="\/theme-init\.js"/.test(src)) unfixed.push(name);
  }

  // Reichweite vor dem Urteil.
  assert.deepEqual(scopedDocs, docs,
    `erwartet: beide Dokumente tragen die system-gebundenen Metas, gefunden: ${scopedDocs.join(', ')}`);
  assert.deepEqual(unfixed, [],
    'ein Dokument mit system-gebundenen theme-color-Metas muss theme-init.js laden');
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
    /@media \(hover:\s*none\),\s*\(max-width:\s*639px\)[\s\S]*?\.meal-card__actions\s*\{[\s\S]*?opacity:\s*1/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*639px\)[\s\S]*?\.meal-card__action-btn\s*\{[\s\S]*?width:\s*var\(--target-lg\)[\s\S]*?height:\s*var\(--target-lg\)/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*639px\)[\s\S]*?\.week-nav__today,[\s\S]*?\.meal-slot__add-more-btn\s*\{[\s\S]*?min-height:\s*var\(--target-lg\)/,
  );
  assert.match(
    meals,
    /@media \(hover:\s*none\),\s*\(max-width:\s*639px\)[\s\S]*?\.meal-card__action-btn\s*\{[\s\S]*?color:\s*var\(--color-text-secondary\)/,
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
    /@media \(max-width:\s*639px\)[\s\S]*\.settings-avatar-action\s*\{[\s\S]*width:\s*var\(--target-lg\)[\s\S]*height:\s*var\(--target-lg\)/,
  );
  assert.match(settings, /\.settings-module-move\s*\{[\s\S]*width:\s*var\(--target-base\)[\s\S]*height:\s*var\(--target-base\)/);
  // Zeilen-Aktionen (Bearbeiten/Löschen in Geburtstags-/Budget-/Kontakt-Karten)
  // teilen jetzt .row-action mit 48px-Touch-Fläche (Audit F1).
  assert.match(layout, /\.row-action\s*\{[\s\S]*width:\s*var\(--target-lg\)[\s\S]*height:\s*var\(--target-lg\)/);
  // Budget-Tabs nutzen jetzt das geteilte .sub-tab (sub-tabs.css) statt eigener
  // .budget-tab-Buttons — Touch-Target dort prüfen (44px, iOS-Minimum, wie alle
  // Sub-Tab-Module: Belohnungen/Haushaltshilfe/Küche/Gesundheit).
  assert.match(subTabs, /\.sub-tab\s*\{[\s\S]*height:\s*var\(--target-base\)/);
  // „Aktuell" (Budget) bezieht seine 48px seit dem Buttonform-Fix aus .btn -
  // der Knopf war eine handkopierte .btn--secondary mit --radius-sm und trug
  // deshalb auch seine Zielgroesse selbst. Geprueft wird die ZUSAGE (48px), und
  // die steht jetzt an ihrem einen Ort; das Modul-CSS darf sie nicht kleiner
  // ueberschreiben.
  assert.match(layout, /\n\.btn\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/);
  assert.doesNotMatch(budget, /\.budget-nav__today\s*\{[^}]*min-height/);
  /* Der Kategorie-Chip der Kontakte holt seine 48px seit dem Umzug aus
   * `.filter-chip` (filter-chip.css) - und zwar auf JEDER Breite, nicht nur
   * unter 768px. Vorher war er ein Nachbau mit hartkodiertem `min-height: 30px`
   * und stand am Desktop auf 31px, während jeder andere Filterchip der App 48px
   * hoch war (Critique 2026-08-13). Geprüft wird deshalb die ÜBERNAHME der
   * geteilten Klasse plus deren Zusage, nicht mehr die alte Schreibweise im
   * Modul-Stylesheet - und dass das Modul die Zahl nicht wieder unterbietet. */
  assert.match(read('../public/pages/contacts.js'), /class="filter-chip contact-filter-chip/);
  assert.match(read('../public/styles/filter-chip.css'), /\.filter-chip\s*\{[\s\S]*min-height:\s*var\(--target-lg\)/);
  assert.doesNotMatch(contacts, /\.contact-filter-chip\s*\{[^}]*min-height/);
  /* Die Besuchszeilen der Haushaltshilfe trugen ihre Zielgroesse selbst
   * (`.housekeeping-log-action { min-height: var(--target-lg) }`) und dazu ein
   * hartkodiertes 17px-Icon. Sie nehmen jetzt `.row-action`, dessen 48px drei
   * Zeilen weiter oben zugesichert sind - geprueft wird deshalb die UEBERNAHME,
   * nicht noch einmal die Zahl.
   *
   * Beide Listen, denn es sind zwei: die letzten Besuche auf der Uebersicht und
   * das Protokoll im Personal-Tab. Die erste umzustellen und die zweite zu
   * vergessen war genau der Fehler, den dieser Guard verhindern soll. */
  const housekeepingPage = read('../public/pages/housekeeping.js');
  assert.doesNotMatch(housekeeping, /\.housekeeping-log-action/,
    'die Besuchszeile darf keine eigene Aktions-Klasse mit eigener Zielgroesse wieder einfuehren');

  /* JEDER Besuchsknopf, nicht IRGENDEINER. Der erste Entwurf suchte
   * `class="row-action"[^>]*data-edit-visit=` und war damit blind: er wurde
   * schon vom Knopf der zweiten Liste gruen gemacht, waehrend der erste noch
   * der alte war - also genau in dem Zustand, in dem diese Aenderung eine
   * Stunde lang war. Gezaehlt wird deshalb ueber alle Fundstellen. */
  const visitButtons = [...housekeepingPage.matchAll(/<button\b([^>]*\bdata-(?:pay|edit|delete)-visit=[^>]*)>/g)]
    .map((m) => m[1]);
  assert.ok(visitButtons.length >= 4,
    `erwartet: Besuchs-Knoepfe in beiden Listen, gefunden: ${visitButtons.length}`);
  const eigenbau = visitButtons.filter((attrs) => !/class="row-action(?: row-action--danger)?"/.test(attrs));
  assert.deepEqual(eigenbau, [],
    'jeder Besuchs-Knopf traegt die geteilte .row-action-Grammatik, nicht nur der zuletzt angefasste');
});

test('remaining audited mobile controls use 48px touch targets', () => {
  const tasks = read('../public/styles/tasks.css');
  const calendar = read('../public/styles/calendar.css');
  const budget = read('../public/styles/budget.css');
  const settings = read('../public/styles/settings.css');

  // Der Filter-Toggle trägt seine 48px seit der Chip-Zusammenführung nicht mehr
  // selbst: er war eine zeichengleiche Kopie von .filter-chip (vierzehn
  // Deklarationen, inklusive des `transition: all`, das am Chip längst ausgebaut
  // war) und ist jetzt einer. Geprüft wird deshalb die ZUSAGE an ihrem einen
  // Ort - und die Kette dorthin, denn ohne die Klasse im Markup erreicht die
  // Regel diesen Knopf nicht und der Guard bliebe grün, während das Ziel
  // schrumpft.
  assertRuleUsesToken(read('../public/styles/filter-chip.css'), '.filter-chip', 'min-height', '--target-lg', '../public/styles/filter-chip.css');
  assert.match(read('../public/pages/tasks.js'), /toggleBtn\.className\s*=\s*`filter-chip filter-toggle-btn/);
  assert.doesNotMatch(tasks, /\.filter-toggle-btn\s*\{[^}]*min-height/);
  // „Heute" (Kalender) holt seine 48px aus .btn - siehe die Begruendung beim
  // Budget-Zwilling im Guard darueber.
  assert.doesNotMatch(calendar, /\.cal-toolbar__today\s*\{[^}]*min-height/);
  // Der Darlehens-Statusfilter ist in .segmented aufgegangen. Der Baustein
  // nimmt --target-base (44px Zeiger / 48px Finger) statt --target-lg fest: das
  // Kriterium ist die Zeigerfähigkeit, nicht die Viewport-Breite (tokens.css).
  assertRuleUsesToken(read('../public/styles/panel.css'), '.segmented__item', 'min-height', '--target-base', '../public/styles/panel.css');
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

  // Toggle in der Toolbar; der Auswahlmodus startet aus.
  assert.match(contactsPage, /id="contacts-select-btn"/);
  assert.match(contactsPage, /selectMode:\s*false/);

  /* DIE AUSWAHL-LEISTE IST DIE GETEILTE PILLE (Critique 2026-08-13).
   *
   * Hier stand `id="contacts-selectbar"[\s\S]*?hidden>` plus die zwei
   * CSS-Zusicherungen dazu. Sie hielten eine Leiste im Fluss der Seite fest,
   * die im Auswahlmodus rund 120px Chrome ueber die Liste schob - genau der
   * Defekt, wegen dessen die Pille gebaut wurde. Die Zusicherung war richtig
   * und ihr Gegenstand falsch; geprueft wird jetzt dieselbe Sache am neuen
   * Bauteil: es gibt keine eigene Leiste mehr, die Aktion kommt aus der Pille,
   * und sie steht nur im Auswahlmodus. */
  assert.doesNotMatch(contactsPage, /contacts-selectbar/,
    'die eigene Auswahlleiste ist entfallen - die Sammelaktion ist die geteilte Pille');
  assert.doesNotMatch(contactsCss, /\.contacts-selectbar/,
    'und ihre Regeln stehen nicht mehr im Modul-Stylesheet');
  assert.match(contactsPage, /from '\/utils\/bulk-pill\.js'/);
  assert.match(contactsPage, /if \(!state\.selectMode\) \{ clearBulkPill\(\); return; \}/,
    'ohne Auswahlmodus steht keine Pille');

  // Sammel-Löschen mit Undo-Toast
  assert.match(contactsPage, /async function deleteSelected/);
  assert.match(contactsPage, /bulkDeletedToast/);
  // Familien-Kontakte bleiben nicht wählbar (deaktivierte Checkbox)
  assert.match(contactsPage, /c\.family_user_id \? ' disabled' : ''/);
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
    /@media \(max-width:\s*639px\)[\s\S]*\.settings-module-drag\s*\{[\s\S]*display:\s*none/,
  );
});

test('birthday and navigation headings keep a sequential hierarchy', () => {
  const birthdays = read('../public/pages/birthdays.js');
  const navigation = read('../public/settings/pages/modules-navigation.js');

  assert.match(birthdays, /<h1 class="page-toolbar__title">|renderPageTitle\s*\(/);
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
        // Deklarationen dem Elternselektor: `.list-scroller { @media … {
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
//
// Der kitchen-tabs-Eintrag („.kitchen-tabs-bar .sub-tab: Button-Innenabstand
// des Tabs, keine Rail-Einrückung") ist 2026-08-27 entfallen - nicht weil die
// Begründung falsch war, sondern weil sie zur REGEL geworden ist: der Scan
// prüft seither das Selektor-SUBJEKT (siehe hitsRail unten). Ein Selektor,
// dessen letztes Compound nicht die Rail ist, polstert ein KIND der Rail, und
// Kind-Innenabstände waren nie Gegenstand von #577. Der zweite Fall derselben
// Bauart (.page-toolbar__bar .sub-tab, Werkzeugzeilen-Regel) hätte sonst den
// zweiten Listeneintrag verlangt - ein Guard über eine Namensliste deckt keine
// Regel ab, sondern N Einträge.
const RAIL_PAD_EXCEPTIONS = [
  {
    file: 'layout.css',
    selector: '.page-toolbar--narrow:has(> .page-toolbar__bar)',
    // Dieses Padding IST die Fluchtlinie, nicht ihre Verletzung: ein
    // gedeckelter Kopf MIT Bar-Zeile deckelt beide Zeilen ueber
    // padding-inline-end auf das Lesemass, weil der ::after-Rest-Slot nur
    // EINE Flex-Zeile fuellen kann - im Wrap-Kopf schwamm er in die Bar-Zeile
    // und schob die Tab-Leiste rechtsbuendig an die Kopf-Kante (Sonde 19,
    // Kopfende 996 statt 720). Gemessen wird die Zusage von #577 (Kopf endet
    // auf der Koerperkante) dort weiter, am gerenderten Dokument.
    reason: 'Lesemass-Deckelung beider Kopfzeilen; der ::after-Slot deckt nur eine',
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
// NACHFAHRE eines Spaltenträgers noch einmal horizontal (z. B. .metric-grid
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
  //
  // WAS EIN KLASSENNAME IST, WIRD GEPRÜFT, NICHT ANGENOMMEN. Der Scan las bis
  // zum nächsten `"` und nahm jedes Whitespace-Stück als Klasse. Eine
  // Interpolation im Attribut (`class="... ${x ? 'a' : ''}"`) lieferte ihm
  // damit `?`, `===` und `'list'` als Rail-Aliasse - und `.?` traf als Regex
  // anschliessend jeden Selektor jeder Datei. Beide Zusicherungen dieses Tests
  // schlugen daraufhin an Stellen fehl, die niemand angefasst hatte
  // (auth.css `.auth-page`, und im Nachbartest jedes Glas-Element „über .?").
  // Ein Scanner, der Müll aufnimmt, meldet Befunde am falschen Ort - teurer
  // als einer, der gar nichts findet.
  const CLASS_NAME = /^-?[A-Za-z_][\w-]*$/;
  const rails = new Set(['.page-toolbar', '.sub-tabs-bar']);
  const addRails = (classList, file) => {
    const parts = classList.split(/\s+/).filter(Boolean);
    // Eine Interpolation ist kein unbekannter Klassenname, sondern ein
    // Attribut, das dieser Scan nicht lesen kann. Das ist ein Fehler im
    // Markup-Stil, nicht im Scan: die Klassenliste eines Rails gehört
    // statisch ins Attribut, ihr Wechsel in ein `classList.toggle`.
    assert.ok(!classList.includes('${'),
      `${file}: die Klassenliste eines page-toolbar-Rails enthält eine Interpolation `
      + `("${classList.slice(0, 60)}…") - dieser Scan liest sie statisch, und die `
      + 'Bruchstücke landen sonst als Rail-Aliasse in jeder Zusicherung darunter');
    parts.forEach((c) => {
      assert.match(c, CLASS_NAME, `${file}: "${c}" ist kein Klassenname`);
      rails.add(`.${c}`);
    });
  };
  for (const file of walkJsFiles('../public/pages/')) {
    const src = stripCssComments(read(file));
    for (const [, classList] of src.matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g)) {
      addRails(classList, file);
    }
    for (const [, classList] of src.matchAll(/className\s*=\s*'([^']*\bpage-toolbar\b[^']*)'/g)) {
      addRails(classList, file);
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
  //     welcher Breakpoint, welche Spezifität. Geprüft wird das SUBJEKT des
  //     Selektors (sein letztes Compound): nur wer die Rail SELBST stylt, kann
  //     ihre Einrückung verschieben. Ein Nachfahren-Selektor mit der Rail als
  //     Kontext (.page-toolbar__bar .sub-tab) polstert einen Button IN der
  //     Rail - das ist Innenabstand, keine Rail-Einrückung, und war vorher ein
  //     dokumentierter Ausnahme-Eintrag je Fundstelle.
  for (const file of styleFiles) {
    for (const rule of cssRules(read(`../public/styles/${file}`))) {
      const hitsRail = rule.selectors.some((sel) => {
        const subject = sel.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
        return [...rails].some(
          (rail) => new RegExp(`${rail.replace('.', '\\.')}(?![\\w-])`).test(subject),
        );
      });
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
  //
  // Composition pages may move the gutter to `.app-page__body` in layout.css
  // (PAGE-COMPOSITION.md). That counts as the carrier when the page root uses
  // `.app-page` / `renderAppPage` and the module CSS no longer repeats the pad.
  const layoutCss = read('../public/styles/layout.css');
  const compositionBodyOwnsPad = /\.app-page--(?:reading|form|data|dashboard)\s*>\s*\.app-page__body[\s\S]{0,200}?padding-inline:\s*var\(--page-inline-pad\)/.test(layoutCss);

  for (const mod of bleedModules) {
    const css = read(`../public/styles/${mod}.css`);
    const rules = cssRules(css);
    const carriers = new Set(
      rules.filter((r) => /padding-inline:\s*var\(--page-inline-pad\)|margin-inline:\s*var\(--page-inline-pad\)/.test(r.body))
        .flatMap((r) => r.selectors),
    );
    const pageFile = `../public/pages/${mod}.js`;
    const pageSrc = existsSync(new URL(pageFile, import.meta.url)) ? read(pageFile) : '';
    const usesCompositionBody = /app-page|renderAppPage/.test(pageSrc) && compositionBodyOwnsPad;
    assert.ok(carriers.size > 0 || usesCompositionBody,
      `${mod}: kein Träger der Content-Spalte (--page-inline-pad) gefunden (#577)`);

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
  // REGEL, KEINE LISTE: geprüft wird jede Seite, die .list-scroller rendert -
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
  const narrowBody = /class(?:Name)?\s*=\s*['"`][^'"`]*\blist-scroller\b/;
  const pages = walkJsFiles('../public/pages/')
    .filter((file) => narrowBody.test(read(file)));
  assert.ok(pages.length >= 3, 'keine Seite mit .list-scroller gefunden - Scan ist blind geworden');

  // KOPFLOS IST KEIN VERSTOSS. Die Regel lautet „wenn ein Kopf da ist, hält er
  // die Kante des Körpers" - eine Seite ohne Kopf hat nichts auszurichten. Der
  // Einkauf ist seit 2026-08-11 genau dieser Fall: sein `.page-toolbar` zeigte
  // den Namen der gewählten Liste ein zweites Mal (der aktive Chip trägt ihn
  // schon) und ist ersatzlos entfallen; Name und Aktionen stehen jetzt in der
  // Chip-Leiste.
  //
  // Was dabei NICHT passieren darf: dass der Guard leise verhungert. Verlören
  // alle Seiten ihren Kopf, liefe die Schleife über nichts und wäre grün, ohne
  // je etwas zugesichert zu haben - eine Assertion über eine leere Liste ist
  // keine. Deshalb wird gezählt, was wirklich gemessen wurde.
  let headsChecked = 0;
  const headless = [];

  for (const file of pages) {
    const src = read(file);
    // EIN KOPF, EINE BREITE - die bewusste Gegenform (2026-08-27): wer sein
    // Lesemass je SICHT am Koerper toggelt (page-measure--narrow / is-reading-measure), den Kopf
    // aber konstant laesst, hat gemischte Koerperbreiten und haelt die Kante
    // seines BREITESTEN Koerpers. Heute ist das der Kalender: drei Flaechen,
    // eine Lesebahn - und seit die Ansichts-Umschalter in der Bar-Zeile
    // wohnen, kann seine volle Titelzeile im 720er-Deckel nicht einzeilig
    // wohnen (Sonde 19). Der Verzicht ist an der BAUART ablesbar, nicht an
    // einem Dateinamen; wer BEIDE toggelt (tasks: Liste gegen Kanban), wird
    // weiter geprueft.
    if (/classList\.toggle\(\s*'(?:page-measure--narrow|is-reading-measure)'/.test(src)
      && !/classList\.toggle\(\s*'page-toolbar--narrow'/.test(src)) continue;
    // Jeder Kopf dieser Seite, egal ob als Template-Literal oder über className.
    const heads = [
      ...src.matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g),
      ...src.matchAll(/className\s*=\s*'([^']*\bpage-toolbar\b[^']*)'/g),
    ].map(([, classList]) => classList);
    if (!heads.length) { headless.push(file); continue; }
    for (const classList of heads) {
      headsChecked++;
      assert.ok(
        /\bpage-toolbar--narrow\b/.test(classList),
        `${file}: "${classList}" - der Körper endet bei --content-max-width-narrow, `
        + 'der Kopf muss dieselbe Kante halten (page-toolbar--narrow)',
      );
    }
  }

  assert.ok(
    headsChecked >= 2,
    `Nur ${headsChecked} Kopf/Köpfe geprüft (kopflos: ${headless.join(', ') || 'keine'}). `
    + 'Unter zwei misst dieser Guard nichts mehr - hat sich die Schreibweise von '
    + '.page-toolbar geändert, oder haben die Küchen-Listen ihre Köpfe alle verloren?',
  );

  // Und die Variante muss das auch tun: das ENDE der Zeile aufs Lesemaß
  // zurückholen, gegen dasselbe Token, das .list-scroller kappt.
  //
  // GEPRÜFT WIRD DIE ZUSICHERUNG, NICHT DIE SCHREIBWEISE. Bis #882 stand hier
  // die Regel wörtlich - `margin-inline-end` am `:last-child`, Zeichen für
  // Zeichen. Genau diese Marge war der Fehler: sie zählte in die
  // Zeilenbelegung des Flex-Containers und machte den Umbruch rechnerisch
  // unvermeidlich (gemessen 560px von 1280px, für Titel und Suche blieben
  // 315px bei 441px Bedarf). Der Abstand ist jetzt ein schrumpfbarer Slot -
  // dieselbe Zusage, anderes Mittel. Ein Guard, der die Implementierung
  // festschreibt, hätte hier den Fix blockiert statt den Fehler zu finden.
  const layout = stripCssComments(read('../public/styles/layout.css'));
  const narrowRules = cssRules(read('../public/styles/layout.css'))
    .filter((r) => r.selectors.some((sel) => /\.page-toolbar--narrow(?![\w-])/.test(sel)));

  // Der Abstand ist ein eigener Slot am Ende der Zeile - nicht irgendeine
  // Deklaration, die das Token nur ERWÄHNT. Auf blosse Token-Präsenz geprüft
  // ginge auch `.page-toolbar--narrow { max-width: var(--content-max-width-narrow) }`
  // durch, und genau das schliesst der Kommentarblock in layout.css als
  // rail-brechend aus.
  const spacer = narrowRules.filter((r) =>
    r.selectors.some((sel) => /\.page-toolbar--narrow::after\b/.test(sel))
    && /flex(?:-basis)?:[^;]*var\(--page-measure,\s*var\(--layout-reading\)\)|flex(?:-basis)?:[^;]*var\(--layout-reading\)/.test(r.body));
  assert.equal(
    spacer.length, 1,
    'layout.css: .page-toolbar--narrow::after muss das Ende seiner Zeile als Flex-Slot auf '
    + '--page-measure/--layout-reading zurückholen (genau eine Regel, gefunden: ' + spacer.length + ')',
  );

  // Und KEINE der Regeln darf den Rückhalt wieder als Marge setzen. Über ALLE
  // statt über die erste: die Prüfung nahm zuerst nur `find()`, und damit wäre
  // sie grün geblieben, sobald die alte, fehlerhafte Regel NACH der neuen
  // wieder aufgetaucht wäre - also genau im Wiedereinführungsfall, für den sie
  // gedacht ist. Eine Marge gibt nie nach und zählt trotzdem in die
  // Flex-Zeilenbelegung; das war #882.
  for (const rule of narrowRules) {
    assert.doesNotMatch(
      rule.body,
      /margin-(?:inline-end|right):\s*max\(/,
      `layout.css: "${rule.selectors.join(', ')}" setzt den Lesemaß-Abstand wieder als Marge - `
      + 'eine Marge gibt nie nach und zählt trotzdem in die Flex-Zeilenbelegung (#882)',
    );
  }
  // Ohne Breakpoint: .list-scroller kappt unbedingt, der Kopf muss das auch.
  // Der Vorgänger stand in `@media (min-width: 1024px)` und ließ den Versatz
  // zwischen 720px und 1024px stehen (gemessen 148px bei 900px Fensterbreite).
  for (const file of ['shopping.css', 'pantry.css', 'recipes.css', 'list-row.css']) {
    assert.doesNotMatch(
      stripCssComments(read(`../public/styles/${file}`)),
      /page-toolbar[^{]*>\s*\*\s*\{[^}]*max-width/,
      `${file}: Slot-Breiten kappen holt den Kopf nicht zurück - das macht .page-toolbar--narrow`,
    );
  }
});

// Hier stand `module-head families stay split: in-page tabs vs route clusters`.
// Er schrieb die IMPLEMENTIERUNGSWAHL fest - `wireTablist` gegen
// `renderSubTabs`, je Modul namentlich - und leitete daraus ab, wer einen
// sichtbaren Titel traegt. Genau das war das Kriterium, das Session 8 als
// „aus Layout-Gruenden" entlarvt hat: eine Beobachtung, keine Regel. Er hielt
// deshalb die Gesundheit als Sonderfall fest, statt sie in ein bestehendes
// Muster einzureihen. Die Zusage prueft jetzt
// `ob ein Seitentitel ueber einer Leiste steht, entscheidet der module:-Wert
// der Zielroute` (Redesign Runde 6, Phase 2) - ueber die deklarative
// Routenliste statt ueber drei Modulnamen. Zwei Guards fuer dieselbe Zusage
// waeren zwei Wahrheiten.

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
  const darkBlock = darkAttrBlock(tokens);
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
 * hardcoding 'mealie'/'tandoor' here - a future third provider's badge falls
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
  // Die Laenge kommt aus --bar-scale, nicht aus einer eingesetzten Breite.
  // Frueher stand hier die woertliche Schreibweise `${pct / 100}` - ein Guard
  // ueber einen Ausdruck statt ueber seine Absicht, der beim ersten Umbau des
  // Ausdrucks feuerte, obwohl die Zusicherung unberuehrt war.
  assert.match(budgetPage, /class="budget-bar-row__fill [^"]*" style="--bar-scale:\$\{/);
  assert.match(budgetPage, /style="--bar-scale:\$\{paidPct\s*\/\s*100\}"/);
  assert.doesNotMatch(budgetPage, /style="width:\$\{(?:pct|paidPct)\}%/);
});

/* Ein Balken TRAEGT einen Wert, er zeigt nicht nur, dass es ihn gibt.
 *
 * Der Anlass: `Math.max(6, Math.round(rawPct))` gab jeder Kategorie unter rund
 * 6 % des Maximums denselben Balken - gemessen rendern -234,98 €, -157,50 €,
 * -153,49 € und -25,00 € alle vier exakt 25,9px, obwohl zwischen erstem und
 * letztem das 9,4-Fache liegt (Critique 2026-08-13). Der Boden war selbst
 * einmal ein Audit-Fix gegen "wirkt leer" und hat ein Kosmetikproblem gegen
 * eine Falschaussage getauscht.
 *
 * Der Guard prueft den SCHADEN, nicht den Fix: kein Prozentboden im Anteil,
 * egal wie er geschrieben ist. Sichtbar bleiben darf der Zwerg - aber als
 * LAENGE im CSS, wo er nichts an der Proportion aendert. Und er deckt BEIDE
 * Dateien, die diese Zeile bauen: budget-stats.js trug denselben Boden und
 * stand unter keinem Guard. */
test('ein Kategoriebalken bleibt proportional - kein Prozentboden im Anteil', () => {
  const budgetCss = read('../public/styles/budget.css');
  const builders = ['../public/pages/budget.js', '../public/pages/budget-stats.js'];

  for (const file of builders) {
    const src = read(file);
    assert.ok(
      src.includes('budget-bar-row__fill'),
      `${file} baut keine Kategoriezeile mehr - Guard-Korpus pruefen, nicht die Zusicherung streichen`,
    );
    const scaleExprs = [...src.matchAll(/--bar-scale:\$\{([^}]+)\}/g)].map((m) => m[1]);
    assert.ok(scaleExprs.length > 0, `${file}: kein --bar-scale gefunden`);
    for (const expr of scaleExprs) {
      /* DER BODEN STEHT NICHT IN DER INTERPOLATION, SONDERN IN DER ZUWEISUNG.
       * Die erste Fassung dieses Guards prueffte `${…}` selbst und war gegen
       * den Anlassfall gruen: dort stand `${pct / 100}`, und `Math.max(6, …)`
       * lag eine Zeile darueber an `const pct`. Genau die Blindheit, die dieses
       * Repo fuenfmal in Folge produziert hat. Also der Variablen folgen. */
      const ident = expr.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      assert.ok(ident, `${file}: "${expr}" ist kein Bezeichner - Guard anpassen, nicht umgehen`);
      /* ALLE Zuweisungen des Bezeichners, nicht die erste. Die zweite Fassung
       * dieses Guards nahm `src.match(…)` und fand in budget.js das `const pct`
       * aus `chartSummary()`, das sauber ist - waehrend das mit dem Boden 18
       * Zeilen tiefer in `renderCategoryBars()` stand. Sie war gruen und haette
       * genau die Haelfte des Anlassfalls durchgelassen. */
      const decls = [...src.matchAll(new RegExp(`\\bconst\\s+${ident}\\s*=\\s*([^;]+);`, 'g'))];
      assert.ok(decls.length > 0, `${file}: keine Zuweisung fuer "${ident}" gefunden`);
      /* DER BODEN WIRD GERECHNET, NICHT GELESEN.
       *
       * Die erste Fassung prueffte `/Math\.max\(\s*[1-9]/` - eine Regel ueber
       * die SCHREIBWEISE der alten Einheit. Derselbe Commit hat den Anteil aber
       * von Prozent (0..100) auf einen Bruch (0..1) umgestellt: ein
       * wiedereingefuehrter Boden hiesse jetzt `Math.max(0.06, …)`, faengt mit
       * einer Null an und waere durchgelaufen. Der Guard war blind fuer genau
       * die Einheit, die sein eigener Commit eingefuehrt hat - zum dritten Mal
       * dieselbe Blindstelle an einem Tag (PR-Review #754).
       *
       * Also: jedes numerische erste Argument von `Math.max` in dieser
       * Zuweisung muss NULL sein. Das ist einheitenfrei und laesst
       * `Math.max(0, …)` durch, das gegen negativ klemmt und nichts behauptet. */
      for (const decl of decls) {
        for (const m of decl[1].matchAll(/Math\.max\(\s*(-?\d+(?:\.\d+)?)/g)) {
          assert.equal(
            Number(m[1]), 0,
            `${file}: "const ${ident} = ${decl[1].trim()}" klemmt den Anteil bei ${m[1]} `
            + 'nach oben von null weg. Ein Mindestbalken ist eine Laenge (min-inline-size im '
            + 'CSS), kein Anteil - sonst zeichnet er ungleiche Betraege gleich. '
            + 'Math.max(0, …) bleibt erlaubt.',
          );
        }
      }
    }
  }

  // Die Gegenprobe: der Mindestbalken existiert, steht im CSS und ist
  // abschaltbar (eine Kategorie mit Saldo null bekommt keinen Stummel).
  assert.match(
    budgetCss,
    /min-inline-size:\s*calc\(var\(--bar-visible,\s*0\)\s*\*\s*var\(--space-0h\)\)/,
    'der sichtbare Mindestbalken muss als Laenge im CSS stehen',
  );
  for (const file of builders) {
    assert.match(
      read(file),
      /--bar-visible:\$\{[^}]*!==\s*0[^}]*\}/,
      `${file}: --bar-visible muss aus dem Saldo kommen, damit eine Nullkategorie keinen Stummel bekommt`,
    );
  }
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

/**
 * EIN REGISTER FUER DIE PRIMAERAKTION (12.08.2026).
 *
 * Nachdem Punkt 7b die Knoepfe am Zeigergeraet in den Modulkopf geholt hatte,
 * standen an derselben Stelle DREI Schreibweisen fuer dieselbe Handlung -
 * gemessen bei 1440px: die handgeschriebenen Knoepfe sagten „Neue Aufgabe"
 * (150px), die angedockten FABs erbten ihr `aria-label` als Satz
 * („Geburtstag hinzufuegen", 216px), und Kalender und Budget sagten gar nichts.
 *
 * Die Regel: der sichtbare Text ist das NOMEN der Sache aus `newLabel.*`, das
 * Verb traegt das Plus-Zeichen; das ausfuehrliche `aria-label` bleibt am Knopf.
 * Gemessen passt das Nomen bei 1024-1920px in jeden Kopf, auch in die beiden
 * randvollen - die Saetze taten das nicht („Neuer Eintrag" brach den
 * Budget-Kopf bei 1440 auf zwei Zeilen).
 *
 * Der Guard prueft die REGEL ueber alle Seiten, nicht eine Liste von Dateien:
 * eine neue Seite mit einem FAB faellt hier auf, ohne dass jemand ihn
 * eintraegt. Kommentare werden vorher entfernt - ein Guard, der Kommentare
 * liest, findet die Beschreibung eines Fehlers als den Fehler.
 */
test('every primary "new" control names its noun from newLabel.* (one register)', () => {
  const stripJs = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const deLocale = JSON.parse(read('../public/locales/de.json'));
  const pages = walkJsFiles('../public/pages/').filter((p) => p.endsWith('.js'));

  const fabs = [];
  const toolbarButtons = [];
  for (const path of pages) {
    const src = stripJs(read(path));
    for (const tag of src.match(/<button[^>]*class="[^"]*\bpage-fab\b[^"]*"[^>]*>/g) ?? []) {
      fabs.push({ path, tag });
    }
    // Die zweite Schreibweise: per DOM-API gebaute FABs (Rezepte, Vorrat).
    for (const block of src.match(/className\s*=\s*'page-fab'[\s\S]{0,400}/g) ?? []) {
      fabs.push({ path, tag: block, built: true });
    }
    for (const tag of src.match(/<button[^>]*class="[^"]*\btoolbar-new-btn\b[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? []) {
      toolbarButtons.push({ path, tag });
    }
  }

  // Reichweite ZUERST festnageln: eine Zusicherung ueber eine leere Liste ist
  // keine. Die Zahlen sind die am 12.08. gezaehlten Vorkommen.
  assert.ok(fabs.length >= 12, `expected at least 12 .page-fab declarations, found ${fabs.length}`);
  assert.ok(toolbarButtons.length >= 5, `expected at least 5 .toolbar-new-btn, found ${toolbarButtons.length}`);

  const keyOf = (text) => text.match(/newLabel\.([A-Za-z]+)/)?.[1];

  for (const { path, tag, built } of fabs) {
    // Das Speed-Dial der Uebersicht ist ein Menue, kein Knopf: es dockt
    // bewusst nicht an (siehe dockFabIntoToolbar) und braucht kein Nomen.
    if (/id="fab-main"/.test(tag)) continue;
    const attr = built ? /dataset\.dockLabel\s*=\s*t\('newLabel\.[A-Za-z]+'\)/ : /data-dock-label="\$\{t\('newLabel\.[A-Za-z]+'\)\}"/;
    assert.match(tag, attr,
      `${path}: jeder .page-fab braucht data-dock-label aus newLabel.* - ohne dockt er am Zeigergeraet still nicht an`);
    const key = keyOf(tag);
    assert.ok(deLocale.newLabel?.[key], `${path}: newLabel.${key} fehlt in de.json`);
  }

  for (const { path, tag } of toolbarButtons) {
    assert.match(tag, /<span class="toolbar-new-btn__label">\$\{t\('newLabel\.[A-Za-z]+'\)\}<\/span>/,
      `${path}: der sichtbare Text eines .toolbar-new-btn kommt aus newLabel.*, nicht aus einem aria-label-Satz`);
    assert.match(tag, /aria-label="/, `${path}: das ausfuehrliche aria-label bleibt am Knopf`);
    assert.doesNotMatch(tag, /\bbtn--icon\b/,
      `${path}: ein beschrifteter Primaerknopf ist keine Icon-Kapsel mehr (Kalender und Budget waren die letzten zwei)`);
    const key = keyOf(tag);
    assert.ok(deLocale.newLabel?.[key], `${path}: newLabel.${key} fehlt in de.json`);
  }

  // Die geteilte FAB-Fabrik muss das Nomen DURCHREICHEN. Sie baut den Knopf
  // fuer die drei Kontext-FABs (Gesundheit, Haushaltshilfe, Belohnungen) und
  // ist der eine Ort, an dem ein kuenftiger FAB entsteht, ohne durch die
  // Seiten-Pruefung oben zu laufen. Ohne diesen Parameter waere Andocken fuer
  // jeden Fabrik-Knopf per Konstruktion ausgeschlossen - still.
  // Geprueft wird die SIGNATUR, nicht der Rumpf: ein `dockLabel` irgendwo im
  // Funktionskoerper stand auch noch da, nachdem der Parameter aus der
  // Destrukturierung entfernt war - der erste Entwurf dieses Guards blieb
  // deshalb gruen, obwohl der Aufrufer nichts mehr uebergeben konnte.
  const fabFactory = stripJs(read('../public/utils/fab.js'));
  for (const fn of ['pageFabHtml', 'createPageFab', 'setPageFabAction']) {
    const signature = fabFactory.match(new RegExp(`export function ${fn}\\s*\\([^)]*\\)`));
    assert.ok(signature, `${fn} not found in utils/fab.js`);
    assert.match(signature[0], /dockLabel/, `utils/fab.js ${fn} muss dockLabel als Parameter annehmen`);
  }
  // Und ein Nomen, das zum vorigen Tab gehoerte, muss weichen statt zu bleiben.
  assert.match(fabFactory, /else delete fab\.dataset\.dockLabel/,
    'setPageFabAction muss ein leeres dockLabel als Entfernen behandeln, nicht als "unveraendert"');

  // Und die Shell-Seite der Regel: der angedockte Knopf nimmt data-dock-label,
  // nicht das aria-label - sonst kaeme der lange Satz zurueck.
  const router = stripJs(read('../public/router.js'));
  const dock = router.match(/function dockFabIntoToolbar[\s\S]*?\n}/);
  assert.ok(dock, 'dockFabIntoToolbar not found');
  assert.match(dock[0], /fab\.dataset\.dockLabel/, 'dockFabIntoToolbar muss data-dock-label lesen');
  assert.doesNotMatch(dock[0], /getAttribute\('aria-label'\)/,
    'dockFabIntoToolbar darf den sichtbaren Text nicht mehr aus aria-label nehmen');
  assert.match(dock[0], /if\s*\(!label\)\s*return false/,
    'ohne data-dock-label dockt der Knopf gar nicht an, statt auf den langen Satz zurueckzufallen');
});

/**
 * Der Einkauf ist das einzige Modul ohne Kopf und damit ohne Andock-Ziel. Sein
 * FAB weicht am Zeigergeraet der Quick-Add-Zeile - und zwar unter DERSELBEN
 * Bedingung, die die Zeile aufklappt, nicht unter einer zweiten Zahl.
 */
test('shopping hides its FAB exactly where the quick-add row opens', () => {
  const css = read('../public/styles/shopping.css');
  // JEDE Regel, die diesen Knopf ueberhaupt erwaehnt, steht unter derselben
  // Bedingung - das ist die eigentliche Zusicherung, und sie gilt seit
  // Etappe 6 fuer zwei Regeln: die Ausblendung und die Nullung ihres
  // Nachlaufs. Eine Paarung, die unter verschiedenen Bedingungen stuende,
  // waere genau der Widerspruch, den sie aufloest.
  const regeln = [...eachRule(css)].filter((r) => /#fab-new-item/.test(r.selector));
  for (const rule of regeln) {
    assert.match(rule.at.join(' '), /\(hover:\s*hover\)/,
      'der FAB weicht unter (hover: hover) - derselben Bedingung, die .quick-add aufklappt');
  }
  const versteckt = regeln.filter((r) => /display:\s*none/.test(r.body));
  assert.equal(versteckt.length, 1,
    'erwartet genau eine Regel, die #fab-new-item am Zeigergeraet ausblendet');
  assert.ok(regeln.some((r) => /--fab-safe-zone:\s*0/.test(r.body)),
    'und daneben die, die ihm seinen Nachlauf nimmt - sonst reserviert der '
    + 'Scrollport 96px fuer einen Knopf ohne Flaeche (Etappe 6)');

  // Der Knoten bleibt: zwei Aufrufer druecken die Primaeraktion ueber
  // `.page-fab`.click(), und ein JS-Klick feuert auch auf display:none.
  const page = read('../public/pages/shopping.js');
  assert.match(page, /class="page-fab" id="fab-new-item"/,
    'der FAB wird versteckt, nicht entfernt - sonst stirbt der click()-Aufruf still');
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

test('die Höhen-Achse der Größenklasse hält denselben Kontrakt', () => {
  // DIE ZWEITE ACHSE BRAUCHT DENSELBEN GUARD, und dass sie ihn bis 2026-08-10
  // nicht hatte, ist der Beleg: der Guard darüber liest ausschließlich
  // `min|max-width`, und so stand seit dem HIG-Rollout ein `max-height: 500px`
  // in layout.css, das §11c gar nicht kannte — genau die private Schwelle, die
  // die Breiten-Achse seit jeher verbietet. Eine Achse ohne Guard driftet, und
  // zwar unbemerkt, weil niemand nach ihr sucht.
  //
  // EINE Grenze (--bp-short) plus ihr Komplement. Wer eine zweite braucht,
  // trägt sie in §11c ein und begründet sie dort — nicht hier.
  //
  // DIE RICHTUNG GEHÖRT ZUR ZAHL, und ohne sie war dieser Guard blind für den
  // einen Verstoß, den es beim Schreiben schon gab: `typography.css` stand auf
  // `max-height: 500px`, alle sieben anderen Blöcke auf 499. Bei exakt 500px
  // Viewporthöhe fiel der Titel damit auf den Inline-Schnitt, während
  // layout.css noch die Large-Title-Zeile baute. Eine Menge aus {499, 500}
  // erlaubt beide Zahlen in beide Richtungen und kann genau das nicht sehen.
  //
  // `max-height` ist das Komplement (< 500, also 499), `min-height` die Grenze
  // selbst (>= 500).
  const allowed = { max: 499, min: 500 };
  const offenders = [];

  for (const { file, css } of stylesheetFiles()) {
    for (const match of css.matchAll(/@media[^{]*?\((min|max)-height:\s*(\d+)px\)/g)) {
      const px = Number(match[2]);
      if (px !== allowed[match[1]]) {
        const line = css.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} → ${match[1]}-height: ${px}px`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'nicht-kanonische Höhen-Schwelle — erlaubt sind nur `max-height: 499px` und '
    + '`min-height: 500px`, siehe tokens.css §11c und DESIGN.md „Die Chrome-Regel"',
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

/**
 * DIE KONZENTRIK-REGEL HAT KEINEN GUARD, UND DAS IST DIE ENTSCHEIDUNG.
 *
 * Sie sagt: der innere Radius ist der aeussere minus Abstand
 * (`calc(var(--radius-*) - Npx)`). Statisch ist ablesbar, ob eine
 * Verschachtelung GERECHNET wurde - fuenf Fundstellen tun es -, aber nicht, ob
 * sie RICHTIG gerechnet wurde, und schon gar nicht, wo sie FEHLT.
 *
 * Auf Ebene 4 ist die erste Haelfte messbar, und sie wurde gemessen
 * (`.impeccable/redesign-tools/tree-probe.mjs`, 78 Zustaende): 56 Eltern-Kind-
 * Paare mit zwei Radien, 14 verschiedene, davon 8 anwendbar - alle acht mit
 * einer Abweichung von 0 oder 1px. Die Toleranz waere sogar begruendbar
 * gewesen: der engste Abstand der Radius-Skala betraegt 2px (--radius-sm 10 auf
 * --radius-md 12), also muss sie <= 1px sein, und genau dort endet die
 * gemessene Verteilung.
 *
 * GEBAUT WURDE SIE TROTZDEM NICHT, weil sie die Frage nicht beantwortet. Ein
 * Kind OHNE Radius bildet kein Paar; die Sonde kann deshalb nur bestaetigen,
 * was die Regel bereits anerkennt - dieselbe Signatur wie eine Allowlist, nur
 * in Sondenform. Und sie kostet dafuer einen vollen Baumlauf.
 *
 * ZWEI ANWENDBARKEITSBEDINGUNGEN sind beim Messen aufgefallen und gehoeren
 * hierher, weil ohne sie jede kuenftige Fassung dieselben Fehltreffer meldet:
 *   1. Eine KAPSEL ist keine verschachtelte Rundung. `--radius-full` ist 9999px
 *      und heisst „so rund wie moeglich" - es gibt dort keinen aeusseren
 *      Radius, von dem ein innerer abgeleitet werden koennte. Kapseln machten
 *      22 der ersten 32 Paare aus.
 *   2. Ist der Abstand GROESSER als der aeussere Radius, beruehrt die Ecke des
 *      Kindes die aeussere Kruemmung nicht mehr, und sein Radius ist frei. Die
 *      erste Fassung rechnete dort `max(0, aussen - abstand)` = 0 und meldete
 *      vier Fehltreffer in Folge, alle mit Abstand 20 gegen aussen 16.
 */
test('border-radius wird ausschließlich über Radius-Tokens gesetzt', () => {
  const offenders = [];
  for (const { file, css } of stylesheetFiles()) {
    if (file === 'tokens.css') continue;
    for (const match of css.matchAll(/border-radius(?:-[a-z-]+)?:\s*([^;}]+)/g)) {
      const value = match[1].trim();
      if (/^(0|none|inherit|initial|unset)$/.test(value)) continue;
      if (/%|var\(--radius/.test(value)) continue;
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

// Schwesterregel zur Delegation oben: derselbe Kreis von Aufrufern, dieselbe
// Bauart des Guards (Bestand suchen, nicht Namen kennen) - nur geht es hier
// nicht um den Text, sondern um den Zeitpunkt.
//
// Gemessen am 08.09.2026 im laufenden Browser: beim Loeschen fragt die
// Komponente ueber `confirmOverModal`, und das schliesst nach einem Ja das Modal
// darunter gleich mit ab (`closeModal({ force: true })`), BEVOR es zurueckkehrt.
// `api.delete` laeuft erst danach, das `category-manager-changed` kommt also,
// wenn das Element schon aus dem Dokument ist (`document.contains(el)` false).
//
// Wer sich in onClose abmeldet, verpasst damit ausgerechnet die Loeschung - die
// einzige Mutation, nach der ein veralteter lokaler Stand dem Nutzer etwas
// anbietet, das der Server nicht mehr kennt. Sieben Aufrufer taten das, bis auf
// den Laden-Manager im Einkauf. Ein Leck droht durch das Weglassen nicht: das
// Element entsteht je Oeffnen neu und wird mit dem Overlay verworfen.
test('kein Nutzer des Category-Managers meldet sich vom Aenderungs-Ereignis ab', () => {
  const nutzer = walkJsFiles('../public/').filter((file) => (
    file !== '../public/components/category-manager.js' && read(file).includes('yuvomi-category-manager')
  ));

  // Faellt die Erkennung aus, soll der Test das sagen und nicht still bestehen.
  assert.ok(nutzer.length >= 5, `nur ${nutzer.length} Nutzer des Category-Managers gefunden`);

  for (const file of nutzer) {
    const src = withoutBlockComments(read(file)).replace(/^\s*\/\/.*$/gm, '');
    const label = file.slice('../public/'.length);
    // Erst der Gegen-Nachweis, dass ueberhaupt noch jemand zuhoert: ein Aufrufer,
    // der An- UND Abmeldung streicht, kaeme sonst gruen durch.
    assert.match(src, /addEventListener\(\s*'category-manager-changed'/,
      `${label}: bindet den Category-Manager ein, hoert aber nicht auf seine Aenderungen`);
    assert.doesNotMatch(src, /removeEventListener\(\s*'category-manager-changed'/,
      `${label}: meldet sich vom Aenderungs-Ereignis ab und verpasst damit das Loeschen - `
      + 'die Auffrischung gehoert in den Ereignis-Handler, siehe `_notifyChanged` in der Komponente');
  }
});

// Zwei Folgen davon, dass die Auffrischung jetzt WAEHREND des offenen Managers
// laeuft statt nach dem Schliessen. Beide traf der Review zu #1066, beide sind
// je Seite verschieden zu loesen - darum zwei benannte Sonden statt einer Regel.

// Loeschbar ist genau die UNBENUTZTE Kategorie, also gerade die, nach der jemand
// gefiltert haben kann. Bleibt `activeCategory` danach auf ihrem Key stehen,
// findet die Chipleiste keinen Chip zum Hervorheben - auch „Alle" nicht - und
// die Liste filtert weiter jeden Kontakt weg: eine leere Seite ohne sichtbaren
// Grund.
test('der Kontakte-Filter loest sich von einer Kategorie, die geloescht wurde', () => {
  const fn = read('../public/pages/contacts.js').match(/function openContactCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'openContactCategoryManager nicht gefunden');
  assert.match(fn, /state\.activeCategory[\s\S]*?state\.categories\.some\([\s\S]*?state\.activeCategory\s*=\s*null/,
    'der Handler muss den aktiven Filter loesen, wenn seine Kategorie nicht mehr in der frischen Liste steht');
});

// Loeschbar ist die UNBENUTZTE Kategorie - dieselbe Falle wie bei den Kontakten,
// nur haelt Aufgaben ihre Auswahl als Liste von Keys, die in die Server-Abfrage
// wandert. Bleibt ein geloeschter Key darin, fragt die Seite dauerhaft nach
// einer Kategorie, die es nicht mehr gibt.
test('der Aufgaben-Filter loest sich von einer Kategorie, die geloescht wurde', () => {
  const fn = read('../public/pages/tasks.js').match(/function openTaskCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'openTaskCategoryManager nicht gefunden');
  assert.match(fn, /state\.filters\.category\.filter\([\s\S]*?state\.filters\.category = /,
    'der Handler muss geloeschte Keys aus state.filters.category werfen');
  // Die Leiste UNBEDINGT, das Nachladen nur bei geaenderter Abfrage: ein hinter
  // dem Manager offenes Panel boete sonst die geloeschte Kategorie weiter an.
  assert.match(fn, /renderFilters\(container\);\n\s*if \(filterBereinigt\) \{/,
    'renderFilters gehoert VOR die Bedingung - das offene Panel veraltet sonst');
  assert.match(fn, /if \(filterBereinigt\) \{[\s\S]*?loadTasks\(container\)/,
    'nur die geaenderte Abfrage rechtfertigt ein Nachladen');
});

// Zwei Fallen des Einkaufs-Handlers, beide erst dadurch erreichbar, dass er
// jetzt NACH dem Schliessen des Modals laeuft.
test('der Einkaufs-Handler schreibt nicht in einen abgehaengten Container', () => {
  const fn = read('../public/pages/shopping.js').match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'openCategoryManager nicht gefunden');
  // Der Deep-Link `?manage=categories` navigiert in onClose sofort weg, und der
  // Router baut die Seite neu auf - beim Loeschen laeuft dieser Handler danach.
  assert.match(fn, /if \(!container\.isConnected\) return;/,
    'der Handler muss aufgeben, wenn der Router die Seite schon ausgetauscht hat');
  // `_notifyChanged()` dispatcht synchron und sieht die Promise dieses Listeners
  // nie: ein Fehler beim Nachladen waere eine unbeobachtete Rejection.
  assert.match(fn, /loadItems\(listId\)[\s\S]*?catch[\s\S]*?state\.itemsError = err/,
    'ein Fehler beim Nachladen der Artikel gehoert in state.itemsError, nicht in eine stille Rejection');
});

// Ein Rundlauf kann von einem Listenwechsel ueberholt werden, und die Antworten
// kommen in beliebiger Reihenfolge. Die Wache gehoert in `loadItems` selbst -
// alle Aufrufer laden die GERADE aktive Liste, also deckt eine Stelle sie alle
// ab (auch `switchList` und den Laden-Manager, die aelter sind als #1066).
test('shopping: eine ueberholte Artikel-Antwort fasst den Stand nicht mehr an', () => {
  const src = read('../public/pages/shopping.js');
  const fn  = src.match(/async function loadItems\(listId\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, 'loadItems nicht gefunden');
  // Vor JEDER Zuweisung an den geteilten Stand, nicht irgendwo in der Funktion.
  const wache = fn.indexOf('if (state.activeListId !== listId) return;');
  assert.notEqual(wache, -1, 'loadItems braucht die Wache gegen eine ueberholte Antwort');
  assert.ok(wache < fn.indexOf('state.items'),
    'die Wache muss VOR dem Schreiben stehen - danach ist der Stand schon zerstoert');

  // Und der Handler des Kategorie-Managers darf den Fehlerfall nicht der
  // falschen Liste anhaengen.
  const mgr = src.match(/async function openCategoryManager[\s\S]*?\n\}/)?.[0] ?? '';
  assert.equal((mgr.match(/state\.activeListId !== listId/g) ?? []).length, 2,
    'Erfolg UND Fehler muessen pruefen, ob die Liste noch dieselbe ist');
});

// Der Manager quittiert nur seine EIGENE Mutation: `_notifyChanged()` kommt erst
// nach deren Erfolg. Was im Handler eines Aufrufers ankommt, ist deshalb immer
// ein Fehler der AUFFRISCHUNG - und der erklaert als einziger, warum die Seite
// den alten Stand behaelt, obwohl der Server schon umgeschrieben hat.
//
// Als allgemeine Regel und nicht je Seite: die erste Fassung nannte nur
// inventory, und genau daneben blieben pantry, tasks und contacts mit demselben
// leeren catch stehen (Review-Runde 6). Ein `catch {` ohne Bindung wirft das
// Fehlerobjekt weg und kann per Konstruktion nichts melden; `catch (err)` mit
// Toast besteht, ebenso ein Handler ganz ohne catch, dessen Lader selbst melden
// (so macht es budget).
test('kein Nutzer des Category-Managers verschluckt den Fehler seiner Auffrischung', () => {
  const nutzer = walkJsFiles('../public/').filter((file) => (
    file !== '../public/components/category-manager.js' && read(file).includes('yuvomi-category-manager')
  ));
  assert.ok(nutzer.length >= 5, `nur ${nutzer.length} Nutzer des Category-Managers gefunden`);

  let geprueft = 0;
  for (const file of nutzer) {
    const src = read(file);
    const label = file.slice('../public/'.length);
    // Jede Stelle, nicht die erste: inventory mountet zwei Manager.
    const re = /addEventListener\(\s*'category-manager-changed'/g;
    let treffer;
    while ((treffer = re.exec(src)) !== null) {
      // Die umschliessende Funktion: rueckwaerts bis zur naechsten Deklaration
      // auf Spaltenposition 0, vorwaerts bis zu ihrer schliessenden Klammer.
      const kopf = src.lastIndexOf('\nfunction ', treffer.index);
      const akopf = src.lastIndexOf('\nasync function ', treffer.index);
      const von = Math.max(kopf, akopf);
      assert.notEqual(von, -1, `${label}: umschliessende Funktion nicht gefunden`);
      const bis = src.indexOf('\n}', treffer.index);
      const fn = src.slice(von, bis);
      geprueft += 1;
      assert.doesNotMatch(fn, /catch\s*\{/,
        `${label}: ein bindungsloses \`catch {\` wirft das Fehlerobjekt weg und kann den `
        + 'Fehler der Auffrischung nicht melden - `catch (err)` mit Toast oder Fehlerzustand');
    }
  }
  // Faellt die Erkennung der Funktionen aus, soll der Test das sagen.
  assert.ok(geprueft >= 7, `nur ${geprueft} Handler gefunden`);
});

// Die frueher hier stehende Sonde `der Budget-Manager haelt den Fokus auf dem
// Knopf, den er austauscht` ist mit ihrem Gegenstand entfallen: der
// seitenlokale `hadFocus`-Griff in `budget.js` wurde durch
// `refocusAfterRender()` aus der geteilten Modal-Schicht ersetzt. Die Sache
// selbst haelt jetzt der Ratchet weiter unten - und zwar fuer ALLE Seiten,
// nicht nur fuer das Budget.


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
 * erst am eingehaengten Baum (pantry.js: `rowEl`, `cartEl`).
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

test('Jeder Sortable-Nutzer hat einen tastaturbedienbaren Reorder-Pfad', () => {
  // Die Regel steht im Kopf von public/utils/sortable.js: "Drag ist NIE der
  // einzige Weg". Sie gilt für JEDEN Aufrufer, nicht für eine Liste bekannter
  // Dateien - deshalb sucht der Guard die Aufrufer selbst. Ohne ihn wäre die
  // Zusage eine wandernde Annahme: der nächste makeSortable()-Aufruf erbt sie
  // aus einem Kommentar, den niemand liest.
  //
  // Als Pfad zählt eine Tastenbehandlung, die die Reihenfolge ändert: entweder
  // Auf/Ab-Bedienelemente (Kategorie-Manager) oder Pfeiltasten an einem
  // fokussierbaren Griff (Einkaufsliste, #678).
  //
  const violations = [];

  // DRITTER FALL SEIT #808: eine Liste, die gar nicht sortiert (`sort: false`),
  // hat keine Reihenfolge, die eine Pfeiltaste ändern könnte. Das Aufgabenboard
  // schiebt Karten zwischen Spalten, und sein Tastaturweg ist der
  // Weiterschalt-Knopf auf jeder Karte. Der Guard hätte ihn nicht erkannt und
  // wäre beim Richtigstellen rot geworden - dann liegt der Guard falsch, nicht
  // der Code.
  //
  // Geprüft wird die Sache statt der Schreibweise, und zwar genau die, die der
  // Kopf von sortable.js verlangt: ein Pfad, "der DENSELBEN Persistenz-Handler
  // aufruft". Zwei getrennte Wege, die dasselbe zu tun behaupten, laufen
  // auseinander, sobald einer einen Sonderfall bekommt.
  //
  // DIE ERSTE FASSUNG WAR EINE FREIKARTE MIT UMWEG (Review zu #808). Sie schnitt
  // alle namensähnlichen Tokens des ersten onEnd-Blocks mit denen aller
  // Klick-Handler der Datei: `api.patch()` an zwei unabhängigen Stellen ergab
  // den geteilten Namen `patch`, `String()` war nicht ausgeschlossen, und EIN
  // `sort: false` irgendwo in der Datei befreite jeden anderen Sortable darin.
  // Deshalb jetzt: je makeSortable-Aufruf einzeln, nur im Datei-eigenen
  // Funktionsnamen, und keine Methodenaufrufe.

  /** Der Argument-Block eines Aufrufs ab `(`, über Klammerbalance abgegrenzt. */
  function callBlock(source, openParen) {
    let depth = 0;
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') { depth--; if (depth === 0) return source.slice(openParen, i + 1); }
    }
    return source.slice(openParen);
  }

  /**
   * Namen, die in DIESEM Block aufgerufen werden und in der Datei auch als
   * Funktion stehen. Ein `x.foo()` zählt nicht: der Name gehört dann einem
   * fremden Objekt, und zwei Aufrufe von `api.patch()` sind kein geteilter Pfad.
   */
  function localCallsIn(block, source) {
    const defined = new Set([
      ...[...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      ...[...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g)].map((m) => m[1]),
    ]);
    return new Set(
      [...block.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)]
        .map((m) => m[2])
        .filter((name) => defined.has(name))
    );
  }

  for (const file of [...walkJsFiles('../public/pages/'), ...walkJsFiles('../public/components/')]) {
    const source = read(file);
    if (!/\bmakeSortable\s*\(/.test(source)) continue;

    const hasArrowKeys   = /['"]ArrowUp['"]/.test(source) && /['"]ArrowDown['"]/.test(source);
    const hasMoveButtons = /data-action="(up|down)"/.test(source)
      || /'(up|down)'/.test(source) && /addEventListener\(\s*['"]click['"]/.test(source);
    if (hasArrowKeys || hasMoveButtons) continue;

    // Was aus den Klick-Handlern der Datei heraus läuft - einmal gesammelt.
    const clickNames = new Set();
    for (const m of source.matchAll(/addEventListener\(\s*['"]click['"]/g)) {
      const block = source.slice(m.index, m.index + 2500);
      for (const name of localCallsIn(block, source)) clickNames.add(name);
    }

    // Jeder makeSortable-Aufruf muss FÜR SICH bestehen.
    const offen = [];
    for (const m of source.matchAll(/\bmakeSortable\s*\(/g)) {
      const block = callBlock(source, m.index + m[0].length - 1);
      if (!/sort:\s*false/.test(block)) { offen.push(m.index); continue; }
      const geteilt = [...localCallsIn(block, source)].filter((n) => clickNames.has(n));
      if (!geteilt.length) offen.push(m.index);
    }
    if (!offen.length) continue;

    violations.push(file);
  }

  assert.deepEqual(violations, [],
    'Diese Dateien machen Listen per Drag sortierbar, ohne einen Tastaturpfad daneben. '
    + 'Drag allein ist für Tastatur- und Screenreader-Bedienung kein Weg (siehe den Kopf '
    + `von public/utils/sortable.js):\n${violations.join('\n')}`);
});

test('Die Handsortierung der Einkaufsliste sichert über einen gemeinsamen Pfad', () => {
  // Zwei Bedienwege (Ziehen, Pfeiltasten) auf EINEN Persistenz-Handler: liefe
  // die Tastatur über eine eigene Schreibweise, driftete sie beim nächsten Fix
  // still am Drag-Pfad vorbei - der Fehlerfall (Rollback-Render) ist der Teil,
  // der dabei zuerst verloren geht.
  const source = read('../public/pages/shopping.js');
  const persistCalls = source.match(/persistItemOrder\s*\(/g) ?? [];

  assert.ok(persistCalls.length >= 3,
    `Erwartet: Definition + Drag-Ende + Tastaturpfad rufen persistItemOrder. Gefunden: ${persistCalls.length}`);
  assert.match(source, /onEnd:\s*\([^)]*\)\s*=>\s*persistItemOrder\(/,
    'Das Drag-Ende muss über persistItemOrder sichern.');
  assert.match(source, /moveItemRow\([^)]*\)/,
    'Der Tastaturpfad braucht moveItemRow, das seinerseits persistItemOrder aufruft.');
  assert.match(source, /catch[\s\S]{0,400}updateItemsList\(container\)/,
    'Der Fehlerfall muss die Liste aus dem unveränderten State neu aufbauen (Rollback).');
});

test('Der Sortiergriff nimmt sich die Geste aus der Wischbedienung', () => {
  // Griff und Wischgeste teilen sich dieselbe Zeile. Ohne die Ausnahme im
  // touchstart liefe das seitliche Wackeln beim Hochziehen als Wischweg mit und
  // die Karte rutschte unter dem Finger auf "erledigt".
  //
  // Die Zusage liegt seit dem Herausziehen des Wisch-Helfers (Runde 4, C-2) auf
  // ZWEI Ebenen, und beide werden hier geprueft: das Modul benennt den Griff,
  // der geteilte Helfer nimmt ihn im touchstart aus. Vorher stand beides in
  // shopping.js - der Guard prueft die Zusage, nicht ihren Ort.
  assert.match(read('../public/pages/shopping.js'), /ignore:\s*'\.list-row__drag'/,
    'Die Einkaufsliste muss ihren Sortiergriff als Ausnahme benennen.');
  assert.match(read('../public/utils/swipe-row.js'), /touchstart[\s\S]{0,600}ignore[\s\S]{0,120}closest/,
    'Der geteilte Wisch-Helfer muss die Ausnahme im touchstart auswerten.');
});

test('Der Modulkopf trägt kein Glas, und das bleibt so', () => {
  // Eine BEGRÜNDETE Abweichung vom Kanon, und deshalb braucht sie einen Guard:
  // die belegte Liquid-Glass-Linie führt Navigationsleisten transparent. Yuvomi
  // stellt den Kopf nahtlos und opak auf den Seitengrund, weil die
  // kollabierende Large-Title-Leiste davon lebt - Glas zeigte am Scroll-Anfang
  // eine Fläche, wo gerade keine sein soll. Dazu kommt der WebKit-Grund, der an
  // der Regel selbst steht: sticky plus backdrop-filter in einem
  // overflow:auto-Container leert auf iOS den ganzen Scrollport.
  //
  // Ohne diesen Guard liest sich die Abweichung als Auslassung, und jemand baut
  // sie „zurück zum Kanon".
  //
  // Die Klassen, die MIT dem Kopf auf einem Element sitzen, kommen aus dem
  // Markup, nicht aus einer Liste: ein Modul, das seiner eigenen Kopfklasse Glas
  // gäbe, wäre sonst unsichtbar (dieselbe Lehre wie beim Umzug eines geteilten
  // Bausteins - der Konflikt sitzt im ELEMENT, nicht im Selektortext).
  const headClasses = new Set(['page-toolbar']);
  for (const file of walkFrontendFiles('../public/')) {
    for (const [, value] of read(file).matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g)) {
      for (const cls of value.split(/\s+/)) {
        if (cls && !cls.startsWith('${') && !cls.includes('--')) headClasses.add(cls);
      }
    }
  }

  const offenders = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!/backdrop-filter\s*:\s*(?!none)/.test(body)) continue;
      const hit = [...headClasses].find((cls) => new RegExp(`\\.${cls}(?![\\w-])`).test(selector));
      if (hit) offenders.push(`${file}: ${at.join(' ')} ${selector} (über .${hit})`);
    }
  }

  assert.deepEqual(offenders, [],
    'Der Modulkopf ist opak - eine begründete Abweichung vom Kanon, siehe DESIGN.md '
    + '„Die Glas-ist-Chrome-Regel".\n  ' + offenders.join('\n  '));

  // Eine Sonde, die nichts gesehen hat, darf nicht urteilen: fände sie den Kopf
  // im Markup nicht mehr, bliebe sie mit jedem Verstoß grün.
  assert.ok(headClasses.size >= 4,
    `Nur ${headClasses.size} Kopf-Klassen im Markup gefunden - erwartet ist .page-toolbar `
    + 'plus die Modul-Klassen, die sich ein Element mit ihr teilen.');
});

test('Eine Wischgeste, die löscht, hat einen Rückgängig-Weg', () => {
  // Der Rechtswisch im Einkauf rief `api.delete` direkt: sofort und endgültig,
  // ohne Undo-Toast, mit flyOut. Es war die einzige Stelle der App, an der eine
  // Geste unwiderruflich Daten entfernt - und wer sie in Aufgaben und
  // Geburtstagen als harmlos gelernt hatte, verlor hier ohne Rückweg.
  //
  // Geprüft wird die ROLLE, nicht der Ort: die Rollenklasse des Reveal-Panels
  // trägt die Bedeutung der Geste (§2, Runde 6: Seite und Rolle sind zwei
  // Achsen). Von der Richtung aus folgt der Guard der Kante zu der Funktion,
  // die sie ruft - `run: (row) => deleteBirthday(...)` liegt eine Definition
  // weiter, und nur dort steht der Rückweg.
  //
  // ES GIBT ZWEI RÜCKWEGE, UND WELCHER RICHTIG IST, ENTSCHEIDET DIE REICHWEITE
  // DER TAT (Ulas, 2026-08-07). Lässt sie sich in einem Satz zurücknehmen,
  // gehört ihr der Undo-Toast: er unterbricht nicht und hält den Weg fünf
  // Sekunden offen. Wirkt sie ÜBER IHR MODUL HINAUS, gehört ihr die
  // Bestätigung - denn dann muss der Rückweg die Nebenwirkung BENENNEN, und
  // das kann nur ein Dialog vor der Tat. Ein Abo zu löschen nimmt seine
  // Erinnerungen und die Budget-Buchung der nächsten Zahlung mit; ein
  // Undo-Toast hätte diese Information stillschweigend verschluckt, um eine
  // Guard-Zeile zu erfüllen.
  //
  // Beides ist ein Rückweg, keines ist die Ausnahme des anderen - dieselbe
  // Trennung, die der Kanon zwischen Undo und Action Sheet zieht.
  //
  // GRENZE: eine Löschgeste ohne `--delete` in ihrer Rollenklasse sieht er
  // nicht. Das ist derselbe Anker, den die Wisch-Semantik-Tabelle benutzt -
  // wer eine Rolle ohne ihre Rollenklasse baut, bricht schon die Achsen-Regel.
  const pagesDir = new URL('../public/pages/', import.meta.url);
  const seen = [];

  // Eine Bestätigung zählt nur als Rückweg, wenn sie als destruktiv AUFTRITT.
  // `confirmModal(...)` ohne `danger` ist ein beliebiger Dialog; die rote
  // Bestätigungstaste ist das, was den Rückweg für den Nutzer erkennbar macht.
  const guardsDestructively = (body) => /confirmModal\s*\(/.test(body) && /danger:\s*true/.test(body);

  for (const file of readdirSync(pagesDir).filter((name) => name.endsWith('.js'))) {
    const source = read(`../public/pages/${file}`);

    const actions = [];
    for (const match of source.matchAll(/reveal:\s*'([^']+)'/g)) {
      if (!match[1].includes('--delete')) continue;
      const body = enclosingObject(source, match.index);
      if (body) actions.push(body);
    }

    // Vollständigkeit: nennt das Markup ein Lösch-Reveal, muss auch eine
    // Richtung dazu geparst sein. Sonst ist der Guard still blind geworden.
    assert.equal(source.includes('swipe-reveal--delete') && actions.length === 0, false,
      `${file} rendert ein Lösch-Reveal, aber keine Wischrichtung verweist darauf.`);

    for (const body of actions) {
      seen.push(file);
      const hasWayBack = (text) => /scheduleUndoableDelete/.test(text) || guardsDestructively(text);
      const direct = hasWayBack(body);
      const viaCall = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
        .some(([, name]) => hasWayBack(functionBody(source, name) ?? ''));

      assert.ok(direct || viaCall,
        `${file}: der Löschwisch braucht einen Rückweg - scheduleUndoableDelete, wenn die Tat `
        + 'in einem Satz zurückzunehmen ist, sonst eine confirmModal-Bestätigung mit danger: true, '
        + 'die die Nebenwirkung benennt. Direkt löschen ist keines von beidem.');
    }
  }

  assert.ok(seen.length >= 2,
    `Erwartet: Einkauf und Geburtstage tragen einen Löschwisch. Gefunden: ${seen.join(', ') || 'keinen'}`);
});

test('Die Einkaufsliste sagt Umsortierungen über eine Live-Region an', () => {
  // Wie im Kategorie-Manager: das aria-label des Griffs allein ist keine
  // verlässliche Rückmeldung - ob ein Screenreader die Label-Änderung am
  // fokussierten Element vorliest, unterscheidet sich von Programm zu Programm.
  const source = read('../public/pages/shopping.js');
  assert.match(source, /role="status" aria-live="polite" id="items-reorder-announce"/,
    'Die Live-Region muss im Listen-Markup stehen.');
  assert.match(source, /announceItemMove\(container, movedRow\)/,
    'Der geteilte Persistenz-Pfad muss ansagen - dann gilt es für Drag UND Tastatur.');
  assert.match(source, /t\('category\.reorderAnnounce'/,
    'Wiederverwendeter Ansage-Text statt einer zweiten Fassung in 24 Sprachen.');
});

test('Die Handsortierung schickt je Kategorie nur eine Anfrage gleichzeitig', () => {
  // Zwei schnell gedrückte Pfeiltasten schickten sonst zwei PATCHes parallel,
  // und es entschied die Ankunftsreihenfolge beim Server statt die
  // Bedienreihenfolge: traf der erste zuletzt ein, schrieb er den Zwischenstand
  // fest, während das DOM den zweiten Zug zeigte. Der Nutzer sah seine
  // Reihenfolge und bekam beim nächsten Laden eine andere.
  const source = read('../public/pages/shopping.js');

  assert.match(source, /orderRuns\s*=\s*new Map\(\)/,
    'Es braucht eine Buchführung über laufende Sicherungen je Kategorie.');
  assert.match(source, /const running = orderRuns\.get\(category\);\s*\n\s*if \(running\) \{ running\.again = true; return; \}/,
    'Ein Zug während eines Laufs darf nur eine Nachfolge vormerken, keine zweite Anfrage starten.');
  assert.match(source, /while \(run\.again/,
    'Nach dem Lauf muss eine vorgemerkte Nachfolge abgearbeitet werden.');
  assert.match(source, /orderRuns\.delete\(category\)/,
    'Der Eintrag muss auch im Fehlerfall verschwinden (finally), sonst blockiert die Kategorie dauerhaft.');

  // Die Reihenfolge wird IM Lauf aus dem DOM gelesen, nicht beim Einreihen
  // eingefroren - nur so trägt eine Nachfolge den Endstand statt eines
  // Zwischenstands, und N Züge kommen mit zwei Anfragen aus.
  assert.match(source, /async function sendItemOrder\(groupEl, container, listId\)[\s\S]{0,600}querySelectorAll\(':scope > \.swipe-row'\)/,
    'sendItemOrder muss die Reihenfolge beim Senden frisch aus dem DOM lesen.');
});

test('Die Handsortierung bindet ihre Anfrage an die Liste, in der gezogen wurde', () => {
  // Wechselt der Nutzer die Liste, während eine Nachfolge aussteht, hält das
  // Gruppen-Element noch die abgehängten Zeilen der alten Liste. Deren IDs
  // gegen die inzwischen aktive Liste zu schicken, quittiert die Route zu Recht
  // mit 400 - und die Antwort dürfte den State der neuen Liste nie überschreiben.
  const source = read('../public/pages/shopping.js');

  assert.match(source, /const listId = state\.activeListId;/,
    'Die Listen-ID muss beim Einreihen feststehen, nicht beim Senden gelesen werden.');
  assert.match(source, /api\.patch\(`\/shopping\/\$\{listId\}\/items\/reorder`/,
    'Die Anfrage muss an die festgehaltene Liste gehen, nicht an state.activeListId.');
  assert.match(source, /if \(listId === state\.activeListId\) state\.items =/,
    'Der State darf nur nachziehen, solange dieselbe Liste offen ist.');
  assert.match(source, /if \(listId !== state\.activeListId\) return false;/,
    'Ein Fehler einer nicht mehr offenen Liste darf weder tosten noch die sichtbare Liste neu bauen.');
});

// --------------------------------------------------------------------------
// Zeilenlisten-Regel (HIG-Rollout Runde 3, dokumentiert in tokens.css)
//
// Eine Folge gleichartiger Zeilen liegt in GENAU EINEM Traeger; die Zeilen
// darin sind flaechen- und kantenlos und trennen sich ueber den +-Kombinator.
// Der Guard prueft die REGEL, nicht eine Liste von Dateien: er liest ALLE
// Stylesheets, sucht jede Haarlinien-Trennung `X + X { border-top: … }` und
// haelt die zugehoerige Basisregel `X { … }` frei von Karten-Merkmalen.
// Damit greift er auch fuer Zeilenlisten, die es heute noch nicht gibt.
// (Lehre aus der Kuechen-Zusammenfuehrung: ein Guard ueber eine Allowlist
// deckt keine Regel ab, sondern N Dateien.)
// --------------------------------------------------------------------------
test('row lists sit in exactly one carrier', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  // Eine Zeile, die sich per +-Kombinator von der naechsten trennt, ist Teil
  // einer Liste in einem Traeger. Sie darf deshalb selbst keine Karte sein.
  // Werte werden ausgelesen und geprueft, nicht per Lookahead ausgeschlossen:
  // `border-radius:\s*(?!0)` ist wahr, sobald `\s*` leer matchen darf - der
  // Lookahead sieht dann das Leerzeichen statt der Null.
  const declared = (body, prop) => {
    const hits = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:([^;]*)`, 'g'))];
    return hits.map((m) => m[1].trim());
  };
  const CARD_MARKERS = [
    { prop: 'box-shadow', isCard: (v) => v !== 'none' },
    { prop: 'border-radius', isCard: (v) => !/^0(px|rem)?$/.test(v) },
    { prop: 'background', isCard: (v) => /^var\(--color-surface(-work|-raised|-elevated)?\)$/.test(v) },
    { prop: 'background-color', isCard: (v) => /^var\(--color-surface(-work|-raised|-elevated)?\)$/.test(v) },
  ];

  const offenders = [];
  for (const name of files) {
    const css = read(`../public/styles/${name}`);
    // `X + X { … border-top … }` — derselbe Selektor auf beiden Seiten ist die
    // Signatur der Haarlinien-Trennung (im Unterschied zu `.a + .b`, das ein
    // Geschwister-Abstand sein kann).
    const seen = new Set();
    for (const m of css.matchAll(/(?:^|[},])\s*(\.[\w-]+)\s*\+\s*\1\s*\{([^}]*)\}/g)) {
      const [, selector, body] = m;
      if (!/border-top:/.test(body)) continue;
      if (seen.has(selector)) continue;
      seen.add(selector);

      // Basisregel des Selektors: exakt `X {`, nicht `.foo X {` und nicht
      // `X--modifier {` (cssRuleBody matcht ungebunden, siehe Handoff-Falle).
      const base = css.match(new RegExp(`(?:^|[},])\\s*\\${selector}\\s*\\{([^}]*)\\}`, 'm'));
      if (!base) continue;
      for (const marker of CARD_MARKERS) {
        for (const value of declared(base[1], marker.prop)) {
          if (marker.isCard(value)) {
            offenders.push(`${name} ${selector} traegt ${marker.prop}: ${value} — eine Zeile in einer Liste ist keine Karte`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------------------
// Zeilenlisten-Regel, ZWEITE HAELFTE (Runde 6, Phase 5a) - Ebene 3, Signatur.
//
// Die erste Haelfte oben sucht `X + X { border-top }` und findet damit NUR,
// wer die Regel schon befolgt. Eine Liste, die sie nie angewandt hat, hat
// keine solche Deklaration und wird nie besucht - genau deshalb blieben
// `.task-card` und `.agenda-event` bis zum Finish-Review unentdeckt.
//
// DIE SIGNATUR EINER KARTE PRO ZEILE, in zwei Teilen:
//   (1) Die Klasse wird in einer Render-Schleife WIEDERHOLT ausgegeben - sie
//       steht also fuer eine Folge gleichartiger Elemente, nicht fuer ein
//       Einzelstueck. Abgeleitet aus `.map(`-Rueckgaben in public/pages/,
//       nicht aus einer Dateiliste.
//   (2) Sie traegt eine eigene KARTENFLAECHE (`--color-surface*`) UND ihren
//       Stapelabstand SELBST (`margin-bottom` / `margin-block-end`). Das ist
//       der Kern: eine Karte pro Zeile ist die Flaeche UND der Abstand zur
//       naechsten. In einer Zeilenliste gehoert beides dem Traeger - die
//       Flaeche der Gruppe, die Trennung `.list-rows > * + *`.
//
// WARUM DER SCHATTEN NICHT DAS MERKMAL IST: er hebt, was schon eine Flaeche
// hat. `.cal-task-chip` traegt einen Schatten auf einer color-mix-Toenung und
// ist eine Tint-Bar im Monatsraster, keine Karte in einer Zeilenliste.
//
// AUSNAHME, MECHANISCH STATT NAMENTLICH: wer `break-inside: avoid` traegt,
// fliesst in einer Multicolumn-Masonry (`.health-overview__grid`), und dort
// IST der eigene Aussenabstand der einzige Weg, Kacheln zu trennen - `gap`
// wirkt zwischen Spalten, nicht zwischen Elementen einer Spalte. Das ist die
// Raster-Ausnahme der Regel, an der Kachel selbst ablesbar.
//
// GRENZE, BEWUSST BENANNT: eine Kartenspalte, die ihre Trennung dem `gap`
// ihres Traegers ueberlaesst (`.documents-list--list > .document-row`), sieht
// diese Haelfte NICHT - der Traeger einer Liste ist in dieser Codebasis
// statisch nicht aufloesbar (`list.insertAdjacentHTML(..., docs.map(...))`).
// Vollstaendig ist das nur im gerenderten Dokument (Ebene 4).
// --------------------------------------------------------------------------

// Wurzelklassen, die in einer Render-Schleife wiederholt ausgegeben werden.
// Quelle ist das Markup, nicht eine Namensliste: jede `.map(`-Rueckgabe, die
// ein Element oeffnet, und jede render*-Funktion, die aus einer solchen
// Rueckgabe heraus aufgerufen wird (`renderSwipeRow(t, renderTaskCard(t))`
// liefert BEIDE - der Wrapper und die Karte darin).
function repeatedRootClasses() {
  const firstClass = (text) => {
    const value = text.match(/class="([^"$]*)/)?.[1]?.trim().split(/\s+/)[0];
    return value && /^[a-z][\w-]*$/.test(value) ? value : null;
  };
  // Klammerweise statt per Regex: ein Callback enthaelt selbst Klammern.
  const callArgs = (source, parenIndex) => {
    let depth = 0;
    for (let i = parenIndex; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(parenIndex + 1, i);
      }
    }
    return '';
  };

  const roots = new Map();
  for (const path of walkJsFiles('../public/pages/')) {
    const source = read(path);

    // Wurzelklasse je Funktion: die erste Klasse NACH ihrem `return \``, nicht
    // die erste der Funktion - sonst gewinnt eine innere Schleife (in
    // renderTaskCard steht die Subtask-Zeile vor dem return).
    const returned = new Map();
    for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const slice = source.slice(match.index, match.index + 6000);
      const start = slice.indexOf('return `');
      const value = start >= 0 ? firstClass(slice.slice(start, start + 900)) : null;
      if (value) returned.set(match[1], value);
    }

    for (const match of source.matchAll(/\.map\s*\(/g)) {
      const body = callArgs(source, match.index + match[0].length - 1);
      if (!body) continue;
      const found = new Set();
      const inline = firstClass(body.slice(0, 600));
      if (inline) found.add(inline);
      for (const call of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (returned.has(call[1])) found.add(returned.get(call[1]));
      }
      if (returned.has(body.trim())) found.add(returned.get(body.trim()));
      for (const value of found) {
        if (!roots.has(value)) roots.set(value, new Set());
        roots.get(value).add(path.replace('../public/pages/', ''));
      }
    }
  }
  return roots;
}

test('row lists: a repeated sheet that stacks itself is a card per row', () => {
  const roots = repeatedRootClasses();
  assert.ok(roots.size > 50,
    `Nur ${roots.size} wiederholte Wurzelklassen gefunden - die Ableitung aus den `
    + 'Render-Schleifen greift nicht mehr, und ein Guard, der nichts gesehen hat, '
    + 'darf nicht urteilen.');

  const rules = new Map(); // Klasse -> [{ file, body }]
  for (const name of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      for (const part of selector.split(',')) {
        const single = part.trim().match(/^\.([\w-]+)$/);
        if (!single) continue;
        if (!rules.has(single[1])) rules.set(single[1], []);
        rules.get(single[1]).push({ file: name, body });
      }
    }
  }

  const values = (body, prop) =>
    [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}:([^;]*)`, 'g'))].map((m) => m[1].trim());
  const CARD_SURFACE = /^var\(--color-surface(-work|-raised|-elevated)?\)$/;
  const isZero = (value) => /^0(px|rem|em)?$/.test(value);

  const offenders = [];
  for (const [cls, files] of [...roots].sort()) {
    const own = rules.get(cls) ?? [];
    const sheet = own.find((rule) =>
      [...values(rule.body, 'background'), ...values(rule.body, 'background-color')]
        .some((value) => CARD_SURFACE.test(value)));
    if (!sheet) continue;
    const spacing = own.find((rule) =>
      [...values(rule.body, 'margin-bottom'), ...values(rule.body, 'margin-block-end')]
        .some((value) => !isZero(value)));
    if (!spacing) continue;
    // Multicolumn-Masonry: der eigene Rand ist dort der einzige Trennweg.
    if (own.some((rule) => values(rule.body, 'break-inside').includes('avoid'))) continue;

    offenders.push(
      `.${cls} (${[...files].join(', ')}) traegt in ${sheet.file} eine eigene Kartenflaeche `
      + 'UND ihren Stapelabstand selbst - das ist eine Karte pro Zeile. '
      + 'Flaeche und Trennung gehoeren dem Traeger (Muster: .list-rows > * + *).');
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------------------
// Buttonform (HIG-Rollout Runde 3): die Kapsel, app-weit EINE.
//
// Der Befund, den dieser Guard fernhaelt, war nie eine falsche Zahl, sondern
// eine zweite Regel: `.btn` stand auf --radius-md, glass.css zog
// `.btn--primary`/`.btn--secondary` auf --radius-full, und `.btn--icon` blieb
// bei --radius-sm - welche Form ein Button bekam, entschied die
// Ladereihenfolge. Der Guard prueft deshalb nicht den Wert der Basisregel,
// sondern dass ueberhaupt KEINE andere Regel den Buttonradius neu setzt.
// --------------------------------------------------------------------------
test('one button shape app-wide', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  const base = cssRuleBody(read('../public/styles/layout.css'), '\n.btn');
  assert.match(base, /border-radius:\s*var\(--radius-full\)/,
    'Die Kapsel steht in der .btn-Basisregel (Direction Contract: „Kapsel-Controls").');

  const offenders = [];
  for (const name of files) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      // Jede Regel, deren Selektorliste eine .btn-Variante enthaelt.
      if (!/\.btn[\w-]*/.test(selector)) continue;
      if (name === 'layout.css' && selector === '.btn') continue;
      const radius = body.match(/(?:^|;)\s*border-radius:\s*([^;]+)/)?.[1]?.trim();
      if (!radius) continue;
      // Die Regel verbietet eine ZWEITE Form, nicht das Wiederholen der einen.
      // Der Lade-Spinner `.btn--loading::after` ist ein Kreis aus --radius-full
      // und stand nur deshalb nicht in dieser Liste, weil der alte Scanner
      // jede zweite Regel uebersprang (siehe eachRule).
      if (/--radius-full/.test(radius)) continue;
      offenders.push(`${name}: ${selector} setzt eine zweite Buttonform (${radius})`);
    }
  }
  assert.deepEqual(offenders, []);

  // ZWEITE HAELFTE, nachgeruestet in Runde 5: der Guard oben prueft nur
  // Selektoren, die `.btn` ENTHALTEN - und lief damit an drei Knoepfen vorbei,
  // die die Kapsel gar nicht erst beanspruchten. „Aktuell" (Budget), „Heute"
  // (Kalender) und „Heute" (Wochenplan) waren dieselbe Funktion in drei Formen
  // und zwei Farbgrammatiken; der Budget-Knopf war Deklaration fuer Deklaration
  // eine .btn--secondary, nur mit --radius-sm statt der Kapsel. Eine Allowlist
  // dieser drei haette den vierten nicht gefangen (Handoff §6).
  //
  // Geprueft wird deshalb die SIGNATUR der geteilten Variante: wer ihre Kante
  // (--color-border) mit ihrer Tinte (Modul-/App-Akzent) kombiniert, baut sie
  // nach und gehoert auf die Klasse. Bewusst nicht geprueft wird „jedes
  // klickbare Element traegt die Kapsel" - Toggles, Checkboxen, Wochentags-
  // waehler und Drop-Ziele sind Griffe mit eigener Form, und eine Regel, die
  // sie einzeln ausnehmen muesste, waere wieder eine Allowlist. Fuer die
  // Gegenprobe am gerenderten Dokument gibt es
  // .impeccable/redesign-tools/button-shapes.mjs.
  const handCopied = [];
  for (const name of files) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      if (/\.btn(?![\w-])|\.btn--/.test(selector)) continue;
      if (!/border:\s*[\d.]+px\s+solid\s+var\(--color-border\)/.test(body)) continue;
      if (!/color:\s*var\(--(?:module-accent|active-module-accent|color-accent)/.test(body)) continue;
      // AUSNAHME als Kategorie, nicht als Name: ein MEDIENRAHMEN traegt
      // dieselbe Kante und dieselbe Tinte wie .btn--secondary, hat aber feste
      // Bildmasse in Pixeln und clippt seinen Inhalt - er zeigt etwas, statt
      // etwas zu beschriften (`.dms-result__media`, die 72x96-Dokumentvorschau
      // im Papierverhaeltnis). Ein beschrifteter Knopf hat keine feste
      // Pixelhoehe mit overflow: hidden.
      if (/width:\s*\d+px/.test(body) && /height:\s*\d+px/.test(body)
        && /overflow:\s*hidden/.test(body)) continue;
      handCopied.push(
        `${name}: ${selector} baut .btn--secondary nach `
        + '- die Klasse nehmen statt die Grammatik kopieren',
      );
    }
  }
  assert.deepEqual(handCopied, []);
});

/**
 * REGEL (Redesign Runde 6, Phase 3): Ein quadratischer Icon-Knopf traegt die
 * Kapsel, und bei gleicher Breite und Hoehe ist die Kapsel ein Kreis. Apples
 * eigene Icon-Buttons sind rund.
 *
 * WARUM GENAU DIESER AUSSCHNITT. Die Buttonform-Regel gilt fuer „jedes
 * Element, das eine Aktion ausloest und eine eigene Flaeche oder Kante
 * traegt" - im Stylesheet ist das nicht scharf, weil dort weder `role` noch
 * Tag steht. Was DORT scharf ist, ist die Form eines umgrenzten Ziels:
 * gleiche Breite und Hoehe. Der Rest der Regel gehoert auf Ebene 4, wo das
 * gerenderte Dokument Tag, Rolle und Kategorie kennt (test-document-guards).
 * Zwei Ebenen fuer eine Regel, jede prueft, was auf ihr pruefbar IST.
 *
 * Die vier Ausnahme-KATEGORIEN stehen im Sektionskommentar von tokens.css.
 * Hier unten stehen ihre quadratischen Vertreter - jeder mit seiner
 * Kategorie, keiner mit „historisch gewachsen". Das ist die Umkehrung einer
 * Allowlist: geprueft werden ALLE quadratischen Formen, benannt sind nur die
 * begruendeten Ausnahmen, und alles Neue faellt durch.
 */
test('ein quadratischer Icon-Knopf ist ein Kreis', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  // Ausnahmen mit KATEGORIE. Die Kategorie ist der Pruefstein: wer hier einen
  // Eintrag ergaenzt, muss ihn einer der vier Kategorien zuordnen koennen.
  const EXEMPT = new Map([
    // 1. Zustandsschalter
    ['.item-check', 'Zustandsschalter: Checkbox der Einkaufsliste'],
    ['.subtask-item__checkbox', 'Zustandsschalter: Checkbox einer Teilaufgabe'],
    ['.rrule-day', 'Zustandsschalter: Wochentagswaehler der Wiederholung'],
    ['.health-weekday', 'Zustandsschalter: Wochentagswaehler der Gesundheit'],
    ['.document-select', 'Zustandsschalter: Traeger der Auswahl-Checkbox'],
    // 3. Zellen eines Rasters
    ['.ydp-cal__day', 'Rasterzelle: Tag im Datepicker-Monat'],
    ['.cycle-cal__day', 'Rasterzelle: Tag im Zyklus-Monat'],
    // Griffe mit eigener Form (Kasten-in-Kasten: Bedienelemente behalten ihre
    // Kante). Ein FELD ist kein Knopf, auch wenn es sich anklicken laesst.
    ['.ydp__trigger', 'Feld: Oeffner des Datepickers, traegt Feldkante'],
  ]);

  const decl = (body, prop) =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();

  const offenders = [];
  for (const name of files) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      const radius = decl(body, 'border-radius');
      if (!radius || /--radius-full|9999px|50%/.test(radius)) continue;

      // Quadratisch heisst: gleiche Breite und Hoehe, als fester Wert. Eine
      // prozentuale oder auf 100% gesetzte Breite ist eine Zeile, keine Form.
      const width = decl(body, 'width') ?? decl(body, 'min-width');
      const height = decl(body, 'height') ?? decl(body, 'min-height');
      if (!width || !height || width !== height) continue;
      if (/%|auto/.test(width)) continue;

      // Klickbar: eigener `cursor: pointer`/`grab`, oder der Selektor nennt
      // sich Knopf. Icon-KACHELN (`__icon`, `__avatar`, `__swatch`) sind
      // Traeger eines Bildes und loesen nichts aus.
      const clickable = /cursor:\s*(?:pointer|grab)/.test(body)
        || /(?:__|-)(?:btn|button)(?![\w-])/.test(selector);
      if (!clickable) continue;

      const exemptKey = [...EXEMPT.keys()].find(
        (key) => new RegExp(`${escapeForRegExp(key)}(?![\\w-])`).test(selector),
      );
      if (exemptKey) continue;

      offenders.push(`${name}: ${selector} (${width}) traegt ${radius} statt der Kapsel`);
    }
  }

  assert.deepEqual(offenders, [],
    'Ein quadratischer, klickbarer Icon-Knopf ist ein Kreis. Wer hier steht, '
    + 'traegt entweder die Kapsel oder gehoert in EXEMPT - mit seiner Kategorie.');

  // Die Ausnahmeliste ist nur so ehrlich wie ihre Eintraege: jeder muss noch
  // existieren. Eine Ausnahme fuer einen Selektor, den es nicht mehr gibt,
  // ist eine Allowlist, die niemand mehr liest.
  const allCss = files.map((name) => read(`../public/styles/${name}`)).join('\n');
  for (const key of EXEMPT.keys()) {
    assert.ok(allCss.includes(key), `EXEMPT nennt ${key}, das es nicht mehr gibt.`);
  }
});

/**
 * REGEL (Redesign Runde 6, Phase 3b): Verliert ein beschriftetes Bedienelement
 * sein Label, wechselt es in die Icon-Form seiner Familie, BEHAELT die
 * Zielgroesse `--target-base` und traegt seinen Zustand ueber getoente Flaeche
 * plus gefuelltes Icon. Wortlaut und Herleitung: Sektion 11b in tokens.css.
 *
 * WAS DIESER GUARD PRUEFT UND WARUM GENAU DAS. Pruefbar im Stylesheet ist die
 * Zielgroesse - und sie ist der Kern der Regel: ein Label zu verlieren darf ein
 * Ziel nie verkleinern. Genau das war viermal passiert, jedes Mal in einer
 * eigenen Antwort: 28x28 im Kalender, ein 50x48-Oval in den Geburtstagen,
 * 34x30 in den Einstellungen, und nur die Dokumente hatten es richtig.
 *
 * ER SUCHT DIE SIGNATUR, NICHT DIE VIER NAMEN. Gesucht wird die Regel, die ein
 * Label AUSBLENDET (`display: none` auf einem `span` oder einem `__label`/
 * `__text`/`__name`-Element). Wer diese Regel schreibt, hat den Label-Verlust
 * gebaut - und muss im selben At-Block seinem Traeger die Zielgroesse geben.
 * Damit faellt auch das fuenfte Modul durch, das die Regel noch nie kannte;
 * eine Liste der vier haette genau das nicht getan (Handoff §6).
 *
 * DAFUER BRAUCHT ER DEN AT-KONTEXT. „Im selben Block" ist die eigentliche
 * Zusage: eine Zielgroesse, die in einer ANDEREN Media-Query steht, gilt bei
 * der Breite, bei der das Label faellt, nicht. Genau diese Angabe hat der
 * Regelscanner bis Phase 3b weggeworfen (siehe eachRule).
 */
test('wer sein Label verliert, bleibt ein volles Ziel', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  // Ein LABEL ist ein `span` als letzter Teil eines Nachfahren-Selektors oder
  // ein BEM-Element, das sich Label/Text/Name/Titel nennt.
  const LABEL_PART = /^(?:span|[a-z]*\.[\w-]+__(?:label|text|name|title))$/;
  // `--target-md` (40px) zaehlt bewusst NICHT: die Regel nennt --target-base,
  // und ein Zielmass, das sie unterschreitet, waere ein Guard, der laxer ist als
  // sein Regeltext. Braucht ein kuenftiger Fall am Zeiger die 40px, ist das eine
  // Aenderung der Regel und keine stille Ausnahme im Guard.
  const targetOf = (value) => {
    if (/var\(--target-(?:base|lg)\)/.test(value)) return true;
    const px = Number.parseFloat(value);
    return Number.isFinite(px) && px >= 44;
  };
  const decl = (body, prop) =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();

  // Klickbar aus dem MARKUP, nicht aus dem Klassennamen. Die erste Fassung
  // dieses Guards fragte nur nach `cursor: pointer` und nach Namen auf `-btn`
  // - und war damit blind fuer jeden Knopf, der seine Klickbarkeit von `.btn`
  // erbt und sich nach seiner Funktion nennt. `.birthdays-toolbar__import` ist
  // genau das: der wiedereingebaute Verstoss blieb gruen. Dieselbe Signatur wie
  // die .btn-Guard-Luecke aus Session 8 - ein Guard ueber „wer sich Knopf
  // nennt" ist eine Allowlist mit extra Schritten.
  const markupControls = new Set();
  for (const file of walkFrontendFiles('../public/')) {
    for (const tag of read(file).matchAll(/<(button|a)\b([^>]*)>/g)) {
      const attrs = tag[2];
      const classAttr = attrs.match(/class=["']([^"']*)["']/)?.[1] ?? '';
      const isControl = tag[1] === 'button'
        || /role=["']button["']/.test(attrs)
        || /\bbtn\b/.test(classAttr);
      if (!isControl) continue;
      for (const token of classAttr.split(/\s+/)) {
        if (/^[\w-]+$/.test(token)) markupControls.add(`.${token}`);
      }
    }
  }
  assert.ok(markupControls.size > 50,
    'Die Knopfklassen kommen aus dem Markup - findet der Scanner keine, prueft der Guard nichts.');

  const offenders = [];

  for (const name of files) {
    const rules = [...eachRule(read(`../public/styles/${name}`))];
    // Klickbar heisst hier: das Markup baut daraus einen Knopf, irgendeine Regel
    // gibt dem Selektor einen Zeiger, oder er nennt sich Knopf. Eine Leiste,
    // deren TITEL ausgeblendet wird (`.kitchen-tabs-bar .sub-tabs-bar__title`),
    // ist damit draussen - sie loest nichts aus.
    const pointers = new Set();
    for (const rule of rules) {
      if (!/cursor:\s*(?:pointer|grab)/.test(rule.body)) continue;
      for (const sel of rule.selector.split(',')) pointers.add(sel.trim());
    }
    const isControl = (sel) => markupControls.has(sel)
      || pointers.has(sel)
      || [...pointers].some((p) => p.startsWith(`${sel}.`) || p.startsWith(`${sel}:`))
      || /(?:__|-)(?:btn|button|opt)(?![\w-])/.test(sel);

    for (const rule of rules) {
      if (!/(?:^|;)\s*display:\s*none/.test(rule.body)) continue;

      for (const raw of rule.selector.split(',').map((s) => s.trim())) {
        const parts = raw.split(/\s+/);
        const last = parts.at(-1).replace(/:not\([^)]*\)/g, '');
        if (!LABEL_PART.test(last)) continue;

        // Der Traeger: bei `X span` das X, bei `.X__label` das `.X` - und
        // zusaetzlich dessen klickbare Kinder, denn nicht jeder BEM-Block ist
        // selbst das Bedienelement (`.perm-seg` traegt, `.perm-seg__opt` klickt).
        const owners = parts.length > 1
          ? [parts.slice(0, -1).join(' ')]
          : (() => {
            const block = last.match(/^\.([\w-]+)__/)?.[1];
            if (!block) return [];
            const kin = [...pointers].filter((p) => p.startsWith(`.${block}__`)
              && !LABEL_PART.test(p));
            return kin.length ? kin : [`.${block}`];
          })();

        for (const owner of owners) {
          if (!isControl(owner)) continue;

          // Im SELBEN At-Kontext muss der Traeger beide Achsen als Zielmass
          // bekommen. Die Basisregel zaehlt nur, wenn auch das Label dort faellt.
          const sized = rules.filter((r) => r.at.join('|') === rule.at.join('|')
            && r.selector.split(',').some((s) => s.trim() === owner));
          const width = sized.map((r) => decl(r.body, 'width') ?? decl(r.body, 'min-width'))
            .find(Boolean);
          const height = sized.map((r) => decl(r.body, 'height') ?? decl(r.body, 'min-height'))
            .find(Boolean);

          if (width && height && targetOf(width) && targetOf(height)) continue;
          const at = rule.at.join(' | ') || 'Basisebene';
          offenders.push(
            `${name} [${at}]: ${owner} verliert sein Label (${last}), `
            + `bleibt aber ohne Zielgroesse (${width ?? 'keine Breite'} x ${height ?? 'keine Hoehe'})`,
          );
        }
      }
    }
  }

  assert.deepEqual(offenders, [],
    'Ein Label zu verlieren darf ein Ziel nie verkleinern: wer ein Label '
    + 'ausblendet, gibt seinem Traeger im selben At-Block --target-base.');
});

/**
 * DIE ANDERE HAELFTE DER LABEL-VERLUST-REGEL: WER SEIN LABEL VERLIEREN KANN,
 * TRAEGT SEINEN NAMEN AM KNOPF (#1068).
 *
 * Der Guard darueber prueft, was ein Element beim Label-Verlust an GROESSE
 * behaelt. Was es an NAMEN behaelt, stand nirgends - und genau das ging
 * verloren: die Personenauswahl im Aufgaben-Verlauf bestand nur aus
 * `<span class="group-toggle__label">Name</span>`, und unter 640px nimmt die
 * Regel dieses Kind weg. Auf dem Telefon stand dort eine Reihe leerer Flaechen.
 *
 * `display: none` nimmt den Text auch aus dem Accessibility-Tree. Der Knopf war
 * also nicht nur fuers Auge namenlos, sondern ebenso fuer eine Vorlesehilfe -
 * der Verlust sah nach einem reinen Anzeigefehler aus und war keiner.
 *
 * Deshalb die Zusage: der Name gehoert an den TRAEGER, nicht in ein Kind, das
 * eine Media-Query entfernen darf. Geprueft wird `.group-toggle__btn`, weil
 * genau dessen Label die beiden Regeln in tasks.css ausblenden. Der Guard bleibt
 * bewusst bei dieser einen Familie statt jedes `__label` im Haus zu verfolgen:
 * dafuer muesste er CSS und Markup verbinden und raet, sobald eine Klasse
 * dynamisch zusammengesetzt wird. Eine enge Zusage, die haelt, ist mehr wert als
 * eine weite, die auf Vermutungen steht.
 */
test('ein Umschalt-Knopf traegt seinen Namen selbst, nicht in einem Kind', () => {
  const dateien = [];
  const sammle = (verzeichnis) => {
    for (const eintrag of readdirSync(verzeichnis, { withFileTypes: true })) {
      const pfad = new URL(`${eintrag.name}${eintrag.isDirectory() ? '/' : ''}`, verzeichnis);
      if (eintrag.isDirectory()) {
        if (eintrag.name === 'vendor') continue;
        sammle(pfad);
      } else if (/\.(?:js|html)$/.test(eintrag.name)) {
        dateien.push(pfad);
      }
    }
  };
  sammle(new URL('../public/', import.meta.url));

  const namenlos = [];
  for (const datei of dateien) {
    const quelle = readFileSync(datei, 'utf8');
    for (const treffer of quelle.matchAll(/<button\b[^>]*group-toggle__btn[^>]*>/g)) {
      const tag = treffer[0];
      if (/aria-label(?:ledby)?[=\s]/.test(tag)) continue;
      const zeile = quelle.slice(0, treffer.index).split('\n').length;
      namenlos.push(`${datei.pathname.split('/public/')[1]}:${zeile}`);
    }
  }

  assert.deepEqual(namenlos, [],
    `Umschalt-Knopf ohne eigenen Namen - unter 640px faellt sein Label und mit ihm die Beschriftung: ${namenlos.join(', ')}`);
});

/**
 * REGEL (Redesign Runde 6, Phase 3c): Die Groesse des Icon-Knopfs gehoert der
 * SHELL, und sie schaltet nach der ZEIGERFAEHIGKEIT.
 *
 * Warum ein eigener Guard und warum auf dieser Ebene. Die Zielgroessen-Regel
 * selbst haengt an Nachbarschaft und Trefferflaeche und ist damit nur im
 * Dokument pruefbar (Sonde 4, test-document-guards.js). Dieser Fall ist etwas
 * anderes: `.btn--icon` mass 40px in Kalender und Kontakten und 44px in Aufgaben
 * und Dokumenten - ZWEI ANTWORTEN AUF EINE FRAGE, und beide hielten die
 * Zielgroessen-Regel. Ein Dokument-Guard sieht ihn deshalb prinzipiell nicht;
 * im Stylesheet steht er offen da.
 *
 * Die Ursache war ein Kriterium, das keines war: die Shell-Regel schaltete ueber
 * `@media (min-width: 1024px)`, also nach der BREITE, waehrend tokens.css als
 * Kanon fuehrt „das Kriterium ist die Zeigerfaehigkeit, nicht die Breite". Ein
 * Tablet ab 1024px bekam damit 40px. Zwei Module hatten den Shell-Fehler je fuer
 * sich lokal repariert - und genau das ist die Signatur einer Shell-Frage, die
 * ein Modul neu beantwortet.
 */
test('die Groesse des Icon-Knopfs gehoert der Shell', () => {
  const SIZE = /^(?:width|height|min-width|min-height)$/;
  const shell = [...eachRule(read('../public/styles/layout.css'))]
    .filter((rule) => rule.selector.split(',').some((s) => s.trim() === '.btn--icon'));

  const base = shell.find((rule) => rule.at.length === 0);
  assert.ok(base, '.btn--icon braucht eine Basisregel in layout.css.');
  assert.match(base.body, /min-height:\s*var\(--target-base\)/,
    '.btn--icon nimmt --target-base - es schaltet ueber (hover: none) von 44px auf 48px '
    + 'und ist damit das einzige Mass, das dem tokens.css-Kanon folgt.');
  assert.match(base.body, /min-width:\s*var\(--target-base\)/);

  // Keine zweite Antwort in einem At-Block: ein Breakpoint, der die Groesse
  // umschaltet, ist genau das Kriterium, das hier verworfen wurde.
  const inAt = shell.filter((rule) => rule.at.length > 0
    && rule.body.split(';').some((d) => SIZE.test(d.split(':')[0]?.trim() ?? '')));
  assert.deepEqual(inAt.map((r) => r.at.join(' | ')), [],
    'Die Groesse von .btn--icon steht in genau einer Regel. Ein @media-Block, der '
    + 'sie umschaltet, macht die Viewport-Breite wieder zum Kriterium.');

  // Und kein Modul beantwortet sie neu.
  const offenders = [];
  for (const name of readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((file) => file.endsWith('.css') && file !== 'layout.css')) {
    for (const rule of eachRule(read(`../public/styles/${name}`))) {
      for (const raw of rule.selector.split(',').map((s) => s.trim())) {
        // Nur zusammengesetzte Selektoren: `.btn--icon-sm` ist eine eigene
        // Variante mit eigenem Namen, kein Override.
        if (!/(?:^|[\s>+~.])\.btn--icon(?![\w-])/.test(raw)) continue;
        if (raw === '.btn--icon') continue;
        const sized = rule.body.split(';')
          .map((d) => d.split(':')[0]?.trim())
          .filter((prop) => SIZE.test(prop ?? ''));
        if (!sized.length) continue;
        offenders.push(`${name}: ${raw} setzt ${sized.join(', ')}`);
      }
    }
  }
  assert.deepEqual(offenders.sort(), [],
    'Ein Modul, das die Groesse von .btn--icon neu setzt, gibt eine zweite Antwort '
    + 'auf eine Shell-Frage. Genau so entstanden die 40px in Kalender/Kontakten '
    + 'neben den 44px in Aufgaben/Dokumenten. Farbe und Abstand darf ein Modul '
    + 'setzen, die Zielgroesse nicht.');
});

/**
 * REGEL (Redesign Runde 6, Phase 0): Der Modulkopf ist genau EINE
 * `.page-toolbar`, verdrahtet von der Shell. Kein Modul setzt eine eigene
 * Flex-Richtung, keine zweite Titelgroesse und kein `--page-toolbar-lead`. Eine
 * Tab-Leiste im Kopf ist eine eigene, horizontal scrollende Zeile.
 *
 * WARUM ER ANDERS SUCHT ALS DIE ALTE FASSUNG DIESER IDEE: eine Suche nach
 * Regeln, deren Selektor `.page-toolbar` ENTHAELT, findet die Verstoesse nicht.
 * Die Module schreiben ihre Kopf-Klasse allein - `.housekeeping-toolbar`,
 * `.rewards-toolbar`, `.cal-toolbar` -, und `page-toolbar` steht nur im
 * Markup daneben. Der Guard leitet die Menge deshalb aus dem MARKUP ab: jede
 * Klasse, die in einem class-Attribut neben `page-toolbar` steht, ist eine
 * Kopf-Klasse. Das ist Guard-Ebene 2 (Struktur, aus deklarativer Quelle) plus
 * Ebene 3 (Signatur im CSS) - und es findet auch das achtzehnte Modul.
 *
 * Gemessener Anlass: `.housekeeping-toolbar` und `.rewards-toolbar` kippten
 * unter 768px auf `flex-direction: column`, waehrend die Shell-Regel der
 * Large-Title-Zone `flex-wrap: wrap` und `flex-basis: 100%` setzt. In
 * Spaltenrichtung ist `flex-basis` die HOEHE und `wrap` erzeugt eine zweite
 * SPALTE: der Kopf der Haushaltshilfe ragte bei 375px 79px ueber die rechte
 * Viewport-Kante (uk 129px, vi 117px), verdeckt vom `overflow-x: hidden` des
 * Scrollports. Die Gegenprobe am gerenderten Dokument ist Sonde 1 in
 * `npm run test:document-guards`.
 */
/**
 * REGEL (Redesign Runde 6, Phase 1): Eine Zeile mit eigenen Aktionen verspricht
 * keine Navigation. Ein Chevron entfaellt, WO die Zeile Aktionen traegt - eine
 * Zeile ohne Aktionen darf ihn behalten, dort ist Oeffnen das Einzige, was sie
 * tut.
 *
 * Gemessener Anlass: in den Kontaktzeilen stand der Chevron als letztes Kind des
 * Oeffnen-Knopfes, waehrend `.row-actions` als GESCHWISTER folgen - er landete
 * damit optisch in der Zeilenmitte und versprach Navigation, wo die Knoepfe
 * daneben etwas anderes liefern. Der Auftrag nannte diesen einen Fall; die
 * Suche nach Geschwistern fand einen zweiten, in derselben Bauart: die
 * Budget-Konten (Chevron im Oeffnen-Knopf, Bearbeiten-Knopf daneben).
 *
 * WAS DIE SIGNATUR TRENNT: eine Zeilen-Affordanz traegt eine eigene
 * `*__chevron`-Klasse, weil sie gestylt werden muss. Ein Zeitraum-Stepper
 * (Kalender, Budget, Wochenplan) rendert den Chevron dagegen als blossen Inhalt
 * eines `.btn--icon` - dort IST der Chevron der Knopf, und die Regel meint ihn
 * nicht.
 *
 * DIE DRITTE ROLLE (2026-08-13): ein AUFKLAPP-Zeiger. Er sitzt im Knopf, der
 * `aria-expanded` traegt, dreht sich mit dem Zustand und verspricht kein
 * Anderswo, sondern Mehr-davon-hier. Der Ordner-Auslöser in den Dokumenten ist
 * der erste Fall; er hat diese Zusicherung gerissen, weil sie ihn nicht kannte.
 * Er traegt eine eigene Klasse aus demselben Grund wie die Zeilen-Affordanz
 * (er muss gestylt werden), also trennt die Klasse hier nicht - `aria-expanded`
 * am besitzenden Knopf tut es. Ein Chevron ohne diesen Zustand bleibt ein
 * Navigationsversprechen und faellt weiter unter die Regel.
 */
test('eine Zeile mit eigenen Aktionen verspricht keine Navigation', () => {
  const offenders = [];
  for (const file of walkJsFiles('../public/pages/')) {
    const src = read(file);
    // Template-Literale einzeln betrachten: ein Zeilen-Markup steht in genau
    // einem, und „danach noch ein <button" ist damit eine Aussage ueber DIESE
    // Zeile statt ueber die Datei.
    for (const literal of src.match(/`[^`]*`/g) || []) {
      const chevron = literal.search(/class="[^"]*__chevron/);
      if (chevron === -1) continue;
      if (!/<button/.test(literal.slice(chevron))) continue;
      // Der Knopf, IN dem der Chevron steht: das letzte <button vor ihm. Traegt
      // er aria-expanded, ist der Chevron ein Aufklapp-Zeiger, kein Wegweiser.
      const owner = literal.slice(0, chevron).lastIndexOf('<button');
      if (owner !== -1) {
        const ownerTag = literal.slice(owner, chevron);
        if (/aria-expanded/.test(ownerTag) && !/<\/button>/.test(ownerTag)) continue;
      }
      const name = literal.slice(chevron).match(/class="([^"]*__chevron[^"]*)"/)?.[1] ?? '?';
      offenders.push(`${file.replace(/^\.\.\//, '')}: ${name} steht in einer Zeile, die danach noch einen Knopf traegt`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('der Modulkopf gehoert der Shell - kein Modul setzt seine Richtung oder seinen Lead', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const cssFiles = readdirSync(styleDir).filter((name) => name.endsWith('.css'));

  // 1. Kopf-Klassen aus dem Markup ableiten, nicht aus einer Liste im Test.
  const headClasses = new Set(['page-toolbar']);
  for (const file of walkFrontendFiles('../public/')) {
    for (const m of read(file).matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (cls && !cls.startsWith('${') && !cls.startsWith('page-toolbar__')) headClasses.add(cls);
      }
    }
  }
  assert.ok(
    headClasses.size >= 4,
    `Aus dem Markup kamen nur ${headClasses.size} Kopf-Klassen - der Guard misst dann nichts. `
    + 'Hat sich die Schreibweise des class-Attributs geaendert?',
  );

  const selectorMatchesHead = (selector) =>
    [...headClasses].some((cls) => new RegExp(`\\.${escapeForRegExp(cls)}(?![\\w-])`).test(selector));

  const offenders = [];
  for (const name of cssFiles) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      if (selector.startsWith('@')) continue;

      // (a) Die Richtung des Kopfes gehoert der Shell.
      if (selectorMatchesHead(selector) && /flex-direction:/.test(body)) {
        offenders.push(`${name}: ${selector} setzt flex-direction auf einer Kopf-Klasse`);
      }
      // (b) Die Lead-Hoehe misst `wireCollapsingHeader` (utils/ux.js). Ein
      //     geschriebener Wert waere eine zweite Wahrheit ueber dieselbe Zahl.
      //     `the collapsing header is wired once, by the shell` prueft dasselbe
      //     im JS; das CSS war dort nicht abgedeckt.
      if (name !== 'layout.css' && /--page-toolbar-lead:/.test(body)) {
        offenders.push(`${name}: ${selector} setzt --page-toolbar-lead - das misst die Shell`);
      }
      // Die dritte Haelfte der Regel - keine zweite Titelgroesse - haelt bereits
      // `one page-head title scale, owned by the shell`. Sie hier zu wiederholen
      // waere eine zweite Wahrheit ueber dieselbe Zusage.
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * REGEL (Redesign Runde 6, Phase 2): Ob ein Seitentitel ueber einer Leiste
 * steht, entscheidet der `module:`-Wert der Zielroute.
 *
 *   Wechselt die Leiste ihn, ist SIE die Kopf-Navigation und traegt keinen
 *   Titel ueber sich - der Tab-Name IST der Modulname (Kueche: vier
 *   eigenstaendige Module unter einer Leiste).
 *   Wechselt sie ihn nicht, oder wechselt sie gar keine Route, gehoert sie
 *   unter den Large Title in den kanonischen `page-toolbar`-Kopf (Gesundheit,
 *   Budget, Belohnungen, Haushaltshilfe).
 *   Sektionen mit eigener Shell (Einstellungen) fuehren ihren Titel in ihrem
 *   eigenen Kopf.
 *
 * DER DRITTE FALL IST EINE REGEL, KEINE AUSNAHME. Die Einstellungen tragen
 * `module: 'settings'` auf allen Blaettern und fielen nach Fall 2 unter „Titel
 * ueber der Leiste" - sie haben aber eine eigene Shell mit eigenem Kopf. Waere
 * das hier eine Ausnahme, stuende sie beim achtzehnten Modul wieder offen.
 * Erkennbar ist der Fall an seiner deklarativen Quelle: eine Sektion mit
 * eigener Shell speist ihre Routen aus einer BLATT-REGISTRY (`*_LEAVES`), die
 * neben dem Pfad auch Label und Loader fuehrt - genau die Angaben, aus denen
 * die Shell ihre eigene Navigation und ihren eigenen Kopf baut. Eine blosse
 * Pfadliste (`HEALTH_ROUTES`) tut das nicht. Der Fall wird deshalb nicht
 * uebersprungen, sondern anders geprueft: die Sektion MUSS einen eigenen
 * sichtbaren Titel fuehren und darf keinen `page-toolbar__title` tragen.
 *
 * WARUM DIE ROUTE UND NICHT DER HELFERNAME: `renderSubTabs` gegen
 * `wireTablist` ist eine Implementierungswahl, keine Regel. Sie faellt bei der
 * Gesundheit auseinander, deren Tabs echte Routen sind und trotzdem alle
 * `module: 'health'` tragen. Ein Guard auf den Helfernamen waere nach Phase 2
 * entweder verletzt oder falsch. `ROUTES` (router.js) ist deklarativ und damit
 * die einzige Groesse, die mechanisch pruefbar UND semantisch gemeint ist.
 * Guard-Ebene 2 (Struktur, aus deklarativer Quelle).
 *
 * KEIN DATEINAME UND KEIN HELFERNAME IM TEST: Modulliste, Seitendateien und
 * Sektions-Erkennung kommen alle aus router.js; die Quellen eines Moduls sind
 * seine Seitendatei plus deren eigene Importe.
 *
 * Gemessener Anlass: die Gesundheit war das einzige Modul mit Sichtwechsel ohne
 * Seitentitel - ihr h1 stand `.sr-only` und der Modulname lief als dekorative
 * Beschriftung in der Leiste mit. Der Titelwiederholungs-Guard in
 * test-typography.js prueft die zweite Haelfte derselben Frage: dass unter der
 * Leiste kein Panel ihren Namen wiederholt.
 */
test('ob ein Seitentitel ueber einer Leiste steht, entscheidet der module:-Wert der Zielroute', () => {
  const router = read('../public/router.js');

  // 1. Routentabelle aus der deklarativen Liste.
  const routes = [];
  for (const m of router.matchAll(/path:\s*'([^']+)'\s*,\s*page:\s*'([^']+)'\s*,\s*requiresAuth:\s*\w+\s*,\s*module:\s*(null|'[^']*')/g)) {
    routes.push({ path: m[1], page: m[2], module: m[3] === 'null' ? null : m[3].slice(1, -1) });
  }

  // 1b. UND die programmatisch erzeugten Unterrouten. Genau hier war die erste
  //     Fassung dieses Guards blind: `HEALTH_PAGE_ROUTES` und `SETTINGS_ROUTES`
  //     schreiben ihren Pfad als Shorthand (`{ path, page: …, module: … }`),
  //     also stand `module: 'health'` in KEINEM Eintrag mit ausgeschriebenem
  //     Pfad - die Gesundheit fehlte in der Tabelle und wurde nie geprueft. Der
  //     Guard war gruen mit wieder eingebautem Verstoss. Die Pfade stehen in der
  //     importierten Konstante; von dort kommen sie jetzt.
  const importedFrom = new Map();
  for (const m of router.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    for (const symbol of m[1].split(',')) {
      const name = symbol.split(/\s+as\s+/).pop().trim();
      if (name) importedFrom.set(name, m[2]);
    }
  }
  for (const m of router.matchAll(/(\w+)\.map\(([\s\S]{0,300}?)module:\s*'([^']+)'/g)) {
    const [, symbol, block, mod] = m;
    const page = block.match(/page:\s*'([^']+)'/)?.[1];
    const file = importedFrom.get(symbol);
    if (!page || !file) continue;
    let source;
    try { source = read(`../public${file}`); } catch { continue; }
    const declaration = source.slice(source.indexOf(`export const ${symbol}`));
    const body = declaration.slice(0, declaration.indexOf('\n]'));
    const paths = [...body.matchAll(/path:\s*'([^']+)'/g)].map((p) => p[1]);
    const literals = paths.length ? paths : [...body.matchAll(/'(\/[^']*)'/g)].map((p) => p[1]);
    for (const path of literals) routes.push({ path, page, module: mod });
  }

  assert.ok(
    routes.length >= 15,
    `Aus router.js kamen nur ${routes.length} Routen - der Guard misst dann nichts. `
    + 'Hat sich die Schreibweise der ROUTES-Eintraege geaendert?',
  );
  for (const mod of ['health', 'settings', 'shopping']) {
    assert.ok(
      routes.some((r) => r.module === mod),
      `Modul "${mod}" fehlt in der abgeleiteten Routentabelle - der Guard ist genau dort blind, `
      + 'wo die Routen programmatisch entstehen.',
    );
  }

  // 2. Sektionen mit eigener Shell: aus router.js abgeleitet (siehe oben).
  const sectionModules = new Set(
    [...router.matchAll(/\w*LEAVES\.map\([\s\S]{0,300}?module:\s*'([^']+)'/g)].map((m) => m[1]),
  );

  const moduleOf = (path) => {
    const exact = routes.find((r) => r.path === path);
    if (exact) return exact.module;
    let best = null;
    for (const r of routes) {
      if (r.path.length <= 1) continue;
      if (path === r.path || path.startsWith(`${r.path}/`)) {
        if (!best || r.path.length > best.path.length) best = r;
      }
    }
    return best?.module ?? null;
  };

  // 3. Quellen je Modul: die Seitendatei aus der Route plus ihre eigenen
  //    Importe aus /utils/ und /settings/. Dort liegen die geteilten
  //    Leisten-Bauteile (Sub-Tabs, Tablist, Sektions-Shell); /components/
  //    bleibt aussen vor, weil dort keine Modul-Navigation entsteht.
  const pageOf = new Map();
  for (const r of routes) if (r.module && !pageOf.has(r.module)) pageOf.set(r.module, r.page);

  const sourcesOf = (pagePath) => {
    let pageSrc;
    try { pageSrc = read(`../public${pagePath}`); } catch { return []; }
    const out = [pageSrc];
    for (const m of pageSrc.matchAll(/from\s+'(\/(?:utils|settings)\/[\w./-]+\.js)'/g)) {
      try { out.push(read(`../public${m[1]}`)); } catch { /* nicht aufloesbar - ueberspringen */ }
    }
    return out;
  };

  const TABLIST = /role="tablist"|setAttribute\(\s*'role'\s*,\s*'tablist'\s*\)|\bwireTablist\(|\brenderSubTabs\(/;

  // KOMMENTARE SIND KEIN MARKUP. `TABLIST` sucht nach einer gebauten Leiste,
  // trifft aber genauso den blossen Erwaehnungstext in einem Kommentar - und
  // `utils/popover-menu.js` erwaehnt in seiner Begruendung woertlich
  // `role="tablist"` (der Personen-Umschalter der Gesundheit, der bis
  // 2026-08-31 einer war). Jede Seite, die dieses geteilte Ueberlaufmenue
  // importiert, galt dadurch als Seite MIT Leiste und wurde gegen eine Regel
  // geprueft, die fuer sie gar nicht gilt: die Entsorgung hat keine Tab-Leiste
  // und fiel trotzdem durch, sobald sie das Menue benutzte. Der Guard misst
  // jetzt den Code, nicht die Prosa darueber.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const classAttrs = (src, needle) =>
    [...src.matchAll(/(?:class="|className\s*=\s*')([^"']*)/g)]
      .map((m) => m[1])
      .filter((value) => new RegExp(`\\b${needle}\\b`).test(value));

  const offenders = [];
  for (const [mod, page] of pageOf) {
    const sources = sourcesOf(page);
    if (!sources.length) continue;

    // Die Regel spricht ueber Module MIT Leiste. Eine Sektion mit eigener Shell
    // hat immer eine (ihre Blatt-Navigation), auch ohne role="tablist".
    const isSection = sectionModules.has(mod);
    if (!isSection && !sources.some((src) => TABLIST.test(stripComments(src)))) continue;

    // Ein sichtbarer Seitentitel ist ein `page-toolbar__title` OHNE `sr-only`
    // in einem KANONISCHEN Kopf. Die Gruppen-Variante zaehlt nicht: ihr Titel
    // ist kein Seitentitel, sondern der Name der gerade offenen Liste
    // (Einkauf), und ueber ihr steht bereits die Leiste des Moduls.
    const hasCanonicalHead = sources.some((src) =>
      classAttrs(src, 'page-toolbar').some((value) => !/\bpage-toolbar--in-group\b/.test(value)));
    const hasTitle = sources.some((src) =>
      classAttrs(src, 'page-toolbar__title').some((value) => !/\bsr-only\b/.test(value)));
    const visibleTitle = hasCanonicalHead && hasTitle;

    if (isSection) {
      const ownTitle = sources.some((src) =>
        /<h1\b(?![^>]*\bsr-only\b)/.test(src) || /createElement\(\s*'h1'\s*\)/.test(src));
      if (!ownTitle) {
        offenders.push(`${mod}: Sektion mit eigener Shell, fuehrt aber keinen eigenen sichtbaren Titel`);
      }
      if (hasTitle) {
        offenders.push(`${mod}: Sektion mit eigener Shell traegt zusaetzlich einen page-toolbar__title - zwei Koepfe fuer einen Titel`);
      }
      continue;
    }

    const targeted = new Set(
      [...new Set(sources.flatMap((src) => [...src.matchAll(/\broute:\s*'([^']+)'/g)].map((m) => m[1])))]
        .map(moduleOf)
        .filter(Boolean),
    );

    if (targeted.size > 1 && visibleTitle) {
      offenders.push(
        `${mod}: die Leiste wechselt den module:-Wert (${[...targeted].sort().join(', ')}) und ist damit `
        + 'selbst die Kopf-Navigation - ueber ihr steht kein Seitentitel',
      );
    }
    if (targeted.size <= 1 && !visibleTitle) {
      offenders.push(
        `${mod}: die Leiste wechselt keinen module:-Wert - der Modulname gehoert als sichtbarer `
        + '.page-toolbar__title in den kanonischen Kopf darueber',
      );
    }
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------------------
// KOLLABIERENDE LARGE-TITLE-LEISTE (Redesign Runde 4, C-1)
//
// Der Modulkopf traegt in der kompakten Groessenklasse zwei Titel-Schnitte:
// den Large Title am Scroll-Anfang und den Inline-Titel, sobald die Leiste
// angedockt ist. Welcher gilt, entscheidet die SHELL - eine zweite font-size
// aus einem Modul-CSS haette genau die Uneindeutigkeit zurueckgeholt, die die
// Canonical-Page-Head-Rolle einmal aufgeloest hat (18/22/28px gestreut).
//
// Wie beim Buttonform-Guard prueft dieser Test deshalb nicht den Wert, sondern
// dass ausser der Shell NIEMAND ihn setzt - eine Regel, keine Dateiliste.
// --------------------------------------------------------------------------
test('one page-head title scale, owned by the shell', () => {
  const SHELL = new Set(['layout.css', 'typography.css']);
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  const typography = read('../public/styles/typography.css');
  assert.match(
    typography,
    /\.page-toolbar:not\(\.page-toolbar--in-group\)\s*>\s*\.page-toolbar__title\s*\{[^}]*font-size:\s*var\(--type-page-title-mobile\)/,
    'Die Large-Title-Zone traegt --type-page-title-mobile - die Rolle steht in typography.css.',
  );
  assert.match(
    typography,
    /\.page-toolbar--capped\.is-collapsed\s*>\s*\.page-toolbar__title\s*\{[^}]*font-size:\s*var\(--type-toolbar-title\)/,
    'Der eingeklappte Kopf faellt auf den Inline-Schnitt zurueck.',
  );
  // Der UMBRUCH gehoert dagegen in layout.css: die Zone ist eine Layout-
  // Bedingung, ihre Stufe eine Typo-Rolle. Beides an einem Ort haette eine
  // der beiden Dateien zur Ausnahme gemacht.
  // Die Zeile ist die volle Breite MINUS dem, was das Absender-Siegel davor
  // belegt (--seal-head-lead, ohne Siegel 0px) - sonst schoebe der Titel sich
  // unter sein eigenes Siegel und die Lead-Zone waeche um eine Zeile.
  assert.match(
    read('../public/styles/layout.css'),
    /\.page-toolbar:not\(\.page-toolbar--in-group\)\s*>\s*\.page-toolbar__title\s*\{[^}]*flex-basis:\s*calc\(100% - var\(--seal-head-lead\)\)/,
    'Die eigene Zeile des Large Title steht in layout.css.',
  );

  const offenders = [];
  for (const name of files) {
    if (SHELL.has(name)) continue;
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      if (!selector.includes('.page-toolbar__title')) continue;
      if (!/font-size:/.test(body)) continue;
      offenders.push(`${name}: ${selector} setzt eine eigene Titelgroesse`);
    }
  }
  assert.deepEqual(offenders, []);
});

// --------------------------------------------------------------------------
// Das Andocken ist Shell-Mechanik, kein Modul-Opt-in: `--page-toolbar-lead`
// wird von genau einem Helfer gemessen und von genau einer Regel gelesen.
// Setzte ein Modul den Wert selbst, klebte sein Kopf an einer anderen Stelle
// als der aller anderen - und der Kopf ist die eine Komponente, die alle
// siebzehn teilen.
// --------------------------------------------------------------------------
test('the collapsing header is wired once, by the shell', () => {
  const pageFiles = readdirSync(new URL('../public/pages/', import.meta.url))
    .filter((name) => name.endsWith('.js'));
  const offenders = [];
  for (const name of pageFiles) {
    const js = read(`../public/pages/${name}`);
    if (/wireCollapsingHeader|--page-toolbar-lead/.test(js)) {
      offenders.push(`${name}: verdrahtet den Modulkopf selbst`);
    }
  }
  assert.deepEqual(offenders, [], 'Nur der Router verdrahtet die Modulkoepfe.');

  assert.match(
    read('../public/router.js'),
    /wireCollapsingHeader/,
    'Der Router verdrahtet die Koepfe der frisch gerenderten Seite.',
  );

  const styles = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css') && name !== 'layout.css');
  for (const name of styles) {
    assert.doesNotMatch(
      read(`../public/styles/${name}`),
      /--page-toolbar-lead/,
      `${name} liest den Andock-Versatz - der gehoert in layout.css.`,
    );
  }
});

// --------------------------------------------------------------------------
// GUARD-ABDECKUNG (2026-08-08): fuenf Regeln, die bis hierher NUR an ihrer
// Einzelfundstelle abgesichert waren oder gar nicht. Jede von ihnen stand als
// gemessener Positivbefund im Implementierungs-Audit - und ein Positivbefund
// ohne Guard ist eine Momentaufnahme, keine Zusage.
// --------------------------------------------------------------------------

/**
 * DIE FALLBACK-REGEL HAT AUF DIESER EBENE KEINEN GUARD, SONDERN EINEN PUNKT -
 * und der ist der Guard direkt darunter. Zwei Fassungen gebaut, beide gemessen,
 * beide verworfen:
 *
 * (a) „Der Blur steht in einem `@supports`-Block." Klingt nach dem Wortlaut der
 *     Regel und ist die falsche Frage. Sechs Flaechen setzen ihn ausserhalb
 *     (`.onboarding-overlay`, `.document-viewer__pdf-indicator`,
 *     `.more-backdrop`, `.search-overlay`, `.modal-overlay`, `body::after` in
 *     pwa.css) und KEINE davon ist ein Verstoss: der
 *     Zugaenglichkeits-Fallback dieser App haengt nicht am Block, sondern am
 *     TOKEN. `--blur-2xs..lg` kippen unter `prefers-reduced-transparency` und
 *     `prefers-contrast: more` selbst auf `blur(0px)` - beide Bloecke stehen in
 *     tokens.css unter „Accessibility: prefers-…". Der Kommentar an
 *     `.modal-overlay` in layout.css sagt das seit Runde 1 ausdruecklich.
 *     (KEINE ZEILENNUMMERN mehr: die hier standen, waren still veraltet, und
 *     eine Angabe, die niemand nachprueft, ist schlechter als eine Suche.)
 * (b) „Nicht-Blur-Stile stehen ausserhalb des Blocks." Neun Treffer, davon
 *     sieben genau das Muster, das die Regel MEINT - opaker Grund draussen,
 *     getoenter Glas-Grund drinnen - und zwei legitime Sonderformen
 *     (`.page-fab::before` ist ein Specular, das es ohne Glas gar nicht gibt;
 *     `.fab-backdrop--visible` ist ein Modifier, dessen Basisregel den Grund
 *     traegt).
 *
 * WAS BLEIBT, IST DER TOKEN - und den prueft der naechste Guard. Er ist damit
 * nicht die Kosmetik-Haelfte der Regel, sondern ihre Zugaenglichkeits-Haelfte:
 * ein roher `blur(8px)` staende unter reduzierter Transparenz weiter da.
 * Ob eine Glasflaeche OHNE Blur noch traegt, sieht erst das Dokument in genau
 * diesem Medienzustand - und dass der nie im laufenden Dokument gemessen wurde,
 * fuehrt der Handoff selbst als bekannte Prueflücke (§8, „Kandidat fuer die
 * zweite Ausbaustufe der Dokument-Suite").
 */

/**
 * Die Blur-Skala ist kanonisch (2/6/10/20/32px als `--blur-2xs..lg`) - und sie
 * ist zugleich der Schalter, mit dem `prefers-reduced-transparency` und
 * `prefers-contrast: more` alles Glas der App abraeumen. Ein Blur, der nicht
 * aus ihr kommt, ist deshalb nicht nur eine siebte Stufe neben sechsen (die
 * Bauart des zweiten Buttonradius), sondern eine Flaeche, die sich der
 * Zugaenglichkeitsschaltung entzieht.
 */
test('jeder Blur kommt aus der --blur-Skala', () => {
  const offenders = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      for (const declared of rule.body.matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)/g)) {
        for (const blur of declared[1].matchAll(/blur\(\s*([^)]+?)\s*\)/g)) {
          if (blur[1].startsWith('var(--blur-') || blur[1] === '0') continue;
          offenders.push(`${file}: ${rule.selector} -> blur(${blur[1]})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `Blur ausserhalb der Skala:\n${offenders.join('\n')}`);
});

/**
 * DIE ZWEIZWEIG-REGEL - sie steht seit Runde 1 im Kopf von glass.css (Zeile
 * 11-14) und war bis 2026-08-09 eine Disziplin statt einer Zusicherung:
 *
 *   „Blur-Filter sind INNERHALB von @supports mit webkit-Fallback.
 *    @supports-Check: (backdrop-filter) OR (-webkit-backdrop-filter) -
 *    deckt Safari < 18 (nur webkit-Prefix) und moderne Browser ab."
 *
 * Alle acht eigenen Bloecke in glass.css halten sie. Geprueft wurde sie nie, und
 * beim ersten Lauf fielen prompt ZWEI Flaechen durch, die keiner der bisherigen
 * Guards sehen konnte - `.ydp-popover` (`@supports` ohne den webkit-Zweig, also
 * blurlos in Safari < 18) und `.document-viewer__pdf-indicator` (ganz ohne
 * `@supports` UND ohne den webkit-Zwilling).
 *
 * DAS IST EINE REGEL UND KEINE LISTE, und zwar in beiden Richtungen: jede Regel,
 * die `backdrop-filter` schreibt, schreibt beide Schreibweisen; jede
 * `@supports`-Praeambel, die danach fragt, fragt nach beiden. Yuvomi ist eine
 * PWA fuer den Homescreen - iOS ist ihr Hauptgeraet, und ein Glas, das dort
 * einzweigig ausfaellt, faellt auf der wichtigsten Plattform aus.
 */
test('backdrop-filter steht immer zweizweigig - Standard und -webkit-', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'));
  const offenders = [];
  let seenRules = 0;
  let seenSupports = 0;

  for (const file of files) {
    const css = read(`../public/styles/${file}`);
    for (const rule of eachRule(css)) {
      // `(?<!-webkit-)` trennt die beiden Schreibweisen: ohne den Blick nach
      // links faende `backdrop-filter\s*:` auch das Praefix-Wort mit und
      // erklaerte jede webkit-only-Regel fuer vollstaendig.
      const std = /(?<!-webkit-)backdrop-filter\s*:/.test(rule.body);
      const webkit = /-webkit-backdrop-filter\s*:/.test(rule.body);
      if (!std && !webkit) continue;
      seenRules += 1;
      if (std !== webkit) {
        offenders.push(`${file}: ${rule.selector} schreibt nur `
          + `${std ? 'backdrop-filter' : '-webkit-backdrop-filter'}`);
      }
    }
    // Die Praeambeln kommen NICHT aus eachRule: der Scanner liefert die
    // At-Kette, aber die Fragestellung ist hier der Text der Bedingung selbst.
    // Kommentare sind vorher weg, sonst zaehlte der Kopf von glass.css mit -
    // er zitiert die Regel woertlich.
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@supports([^{]*)\{/g)) {
      if (!/backdrop-filter/.test(m[1])) continue;
      seenSupports += 1;
      if (!/-webkit-backdrop-filter/.test(m[1]) || !/(?<!-webkit-)backdrop-filter/.test(m[1])) {
        offenders.push(`${file}: @supports${m[1].trim()} fragt nur nach einer Schreibweise`);
      }
    }
  }

  // Ein Guard, der nichts gelesen hat, darf nicht urteilen.
  assert.ok(seenRules >= 10 && seenSupports >= 5,
    `Nur ${seenRules} Blur-Regeln und ${seenSupports} @supports-Bloecke gefunden - der `
    + 'Guard hat nichts gemessen, statt nichts zu finden.');

  assert.deepEqual(offenders, [],
    'Die Zweizweig-Regel aus dem Kopf von glass.css: jede Regel schreibt beide '
    + 'Schreibweisen, jede @supports-Praeambel fragt nach beiden. Safari < 18 kennt '
    + `nur das Praefix - und iOS ist das Hauptgeraet dieser PWA.\n${offenders.join('\n')}`);
});

/**
 * DER MASKENSTOPP IST KEIN FARBWERT.
 *
 * 18 Zeilen in vier Dateien schrieben `#000` als vollen Stopp einer
 * `mask-image`-Rampe, `tasks.css` dieselbe Maske als `black` - derselbe Wert,
 * nur am Farbdetektor vorbei. Beide sind keine Farbe: eine Maske liest allein
 * den Alpha-Kanal, `#000` heisst dort „voll deckend" und nie „schwarz".
 *
 * Der Ausweg war ausdruecklich NICHT ein Ignore-Eintrag: der haette 18 Zeilen
 * stummgeschaltet und dabei jedes kuenftige ECHTE `#000` in diesen vier Dateien
 * mitverschluckt. `--mask-opaque` loest beides und bringt `tasks.css` in die
 * Reihe - eine Schreibweise, ein Token, ein Guard.
 */
test('ein Maskenstopp kommt aus --mask-opaque, nie als roher Farbwert', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'));
  const offenders = [];
  let seen = 0;

  for (const file of files) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      for (const decl of rule.body.matchAll(/(?:-webkit-)?mask-image\s*:\s*([^;]+)/g)) {
        seen += 1;
        // Nur der volle Stopp ist gemeint. Eine Maske, die mit `transparent`
        // arbeitet, sagt dasselbe von der anderen Seite und braucht kein Token.
        for (const raw of decl[1].matchAll(/(?:^|[\s,(])(#000{1,3}(?:[0-9a-f]{2})?|black)(?=[\s,)])/gi)) {
          offenders.push(`${file}: ${rule.selector} -> ${raw[1]}`);
        }
      }
    }
  }

  assert.ok(seen >= 10,
    `Nur ${seen} Masken-Deklarationen gefunden - der Guard hat nichts gemessen.`);

  assert.deepEqual(offenders, [],
    'Ein Maskenstopp ist kein Farbwert - er nimmt `var(--mask-opaque)`. Ein rohes '
    + '`#000` oder `black` an dieser Stelle sieht wie eine Farbentscheidung aus, ist '
    + `aber „voll deckend" und hat mit der Farbwelt nichts zu tun.\n${offenders.join('\n')}`);
});

/**
 * EIN SPECULAR HAENGT AM A11Y-SCHALTER, IMMER.
 *
 * glass.css sagt seit Runde 1 zu, dass Opazitaet und Specular unter
 * prefers-reduced-transparency und prefers-contrast ueber die Tokens auf 0
 * fallen. Dafuer gibt es ZWEI Schreibweisen, und tokens.css:1667 fuehrt sie
 * ausdruecklich als dasselbe Konzept: `--lg-specular` ist die Staerke des einen
 * freien Highlights, `--glass-inset-strength` der Faktor der abgestuften
 * Inset-Tokens. Erlaubt sind beide. Verboten ist die dritte Schreibweise, die an
 * beiden vorbeilaeuft: ein rohes rgba in einem `inset`-Segment.
 *
 * Session 27 hat 17 Leser von `--glass-inset-*` in die Reihe gebracht; drei
 * Stellen standen NICHT darunter, weil sie den Token nie lasen und deshalb in
 * keiner Suche auftauchten - `.page-fab` (layout.css, der opake Fallback der
 * Signature Component) sowie `.nav-bottom__items` und `.nav-sidebar`, die
 * ihren OBEREN Specular korrekt ueber `--lg-specular` fuehren und den unteren
 * eine Zeile darunter roh schrieben. Der letzte Fall brauchte einen Token, den
 * es noch nicht gab (`--glass-inset-bottom-lift`): die bestehenden
 * Bottom-Tokens sind schwarze Unterrand-SCHATTEN, gebraucht wurde ein helles
 * Gegenlicht fuer die schwebenden Flaechen.
 *
 * WARUM ueber die Signatur und nicht ueber eine Dateiliste: die drei lagen in
 * zwei Dateien, und `.page-fab` ausgerechnet in layout.css - wer glass.css
 * durchsucht, findet ihn nie. Die Signatur ist das `inset`-Segment selbst.
 *
 * NICHT gemeint sind Schatten ohne `inset` (`0 8px 24px rgba(0,0,0,.14)` steht
 * legitim direkt daneben) und die Token-DEFINITIONEN in tokens.css: dort IST
 * der rohe Wert die Aussage. Der Guard liest deshalb nur `box-shadow`, also die
 * Verwendung, nie eine `--name:`-Deklaration.
 */
test('ein Inset-Specular kommt aus dem Token, nie als rohes rgba', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'));
  const offenders = [];
  let seenShadows = 0;
  let seenInsets = 0;

  for (const file of files) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      for (const decl of rule.body.matchAll(/box-shadow\s*:\s*([^;]+)/g)) {
        seenShadows += 1;
        // Die Segmente eines box-shadow trennt das Komma auf oberster Ebene.
        // `color-mix(in srgb, ...)` traegt selbst Kommas, deshalb wird die
        // Klammertiefe mitgezaehlt statt naiv gesplittet.
        const segments = [];
        let depth = 0;
        let current = '';
        for (const ch of decl[1]) {
          if (ch === '(') depth += 1;
          if (ch === ')') depth -= 1;
          if (ch === ',' && depth === 0) { segments.push(current); current = ''; continue; }
          current += ch;
        }
        segments.push(current);

        for (const seg of segments) {
          if (!/\binset\b/.test(seg)) continue;
          seenInsets += 1;
          const rawRgba = seg.match(/rgba?\([^)]*\)/);
          if (rawRgba) offenders.push(`${file}: ${rule.selector} -> ${rawRgba[0]}`);
        }
      }
    }
  }

  assert.ok(seenShadows >= 100 && seenInsets >= 20,
    `Nur ${seenShadows} box-shadow-Deklarationen und ${seenInsets} inset-Segmente gelesen - `
    + 'der Guard hat nichts gemessen, statt nichts zu finden.');

  assert.deepEqual(offenders, [],
    'Ein Inset-Specular nimmt ein `--glass-inset-*`-Token oder die color-mix-Formel '
    + 'ueber `--lg-specular`. Ein rohes rgba traegt den a11y-Schalter nicht: unter '
    + 'prefers-reduced-transparency und prefers-contrast muss die Lichtkante '
    + `verschwinden, und ein fester Wert tut das nie.\n${offenders.join('\n')}`);
});

/**
 * GEDRUCKT WIRD HELL - und die Regel steht an der QUELLE, nicht im Druckblock.
 *
 * Papier leuchtet nicht. Eine Farbwelt fuer dunkle Displays wird auf ihm
 * unlesbar, und zwar in zwei Schichten nacheinander:
 *
 *   1. Bis 2026-08-09 faerbte `@media print` nur den `body` (`background:#fff;
 *      color:#000`). Die Textfarbe griff app-weit, der Grund aber nur auf dem
 *      `body` selbst - jede Flaeche darunter behielt ihren Dark-Token. Gemessen
 *      im gerenderten Dokument mit emulierter Druckausgabe: 1.06:1 am Modultitel
 *      (#000 auf --color-bg #0A0A0C) und 1.23:1 auf Karteninhalten (#000 auf
 *      --color-surface #1C1C1E), auf 11 von 16 Modulen.
 *   2. Nach dem Neutralisieren der FLAECHEN kam die zweite Schicht zum Vorschein:
 *      die vividen Dark-Varianten der Akzente und der Semantik standen nun auf
 *      weissem Papier - 78 Paarungen unter AA auf 37 Routenzustaenden, von
 *      #30D158-Gruen bei 2.02:1 bis #FCD34D-Gelb bei 1.44:1.
 *
 * DESHALB DIE BEDINGUNG STATT DER WERTE. Der Druckblock koennte die Light-Werte
 * wiederholen, aber das waeren ueber fuenfzig - Neutrale, Semantik, 17
 * Modul-Tints, sieben Chart-Serien, die Prioritaeten - und der Token von morgen
 * liefe still daneben. `@media screen` um die Theme-Bloecke sagt dasselbe
 * einmal: was das Display umfaerbt, gilt fuers Display.
 *
 * Der Guard prueft die Regel, nicht die Liste: JEDE Regel, die private
 * Theme-Tokens setzt und dabei ein bestimmtes Theme meint - erkennbar an
 * `prefers-color-scheme` in ihrer At-Kette oder an `[data-theme=` in ihrem
 * Selektor -, steht unter `@media screen`. Ein dritter Theme-Block waere damit
 * von selbst mitgemeint. Die a11y-Bloecke (`prefers-reduced-transparency`,
 * `prefers-contrast`) sind ausdruecklich NICHT gemeint: sie schalten keine
 * Farbwelt um, sie haerten - und beides soll auf Papier gelten.
 */
test('was das Display umfaerbt, gilt nur fuers Display', () => {
  const css = read('../public/styles/tokens.css');
  const offenders = [];
  let themeRules = 0;
  let themedTokens = 0;

  for (const rule of eachRule(css)) {
    const declared = [...rule.body.matchAll(/(--_[a-z0-9-]+)\s*:/gi)];
    if (!declared.length) continue;

    const chain = rule.at.join(' ');
    const meansOneTheme = /prefers-color-scheme/.test(chain) || /\[data-theme=/.test(rule.selector);
    if (!meansOneTheme) continue;

    // Der Zaehler geht an derselben Stelle hoch, an der auch ein Finding
    // entstehen koennte - nicht davor.
    themeRules += 1;
    themedTokens += declared.length;

    if (!/\bscreen\b/.test(chain)) {
      offenders.push(`${rule.selector} (At-Kette: ${chain || 'keine'}) setzt `
        + `${declared.length} Theme-Tokens ohne @media screen`);
    }
  }

  assert.ok(themeRules >= 2 && themedTokens >= 100,
    `Nur ${themeRules} Theme-Regeln mit ${themedTokens} Tokens gelesen - der Guard hat `
    + 'nichts gemessen, statt nichts zu finden. tokens.css fuehrt zwei Dark-Bloecke '
    + '(System-Praeferenz und expliziter Nutzer-Override) mit je ueber siebzig Tokens.');

  assert.deepEqual(offenders, [],
    'Ein Block, der die Farbwelt umschaltet, gehoert unter `@media screen`. Ohne ihn '
    + 'druckt die App ihre Bildschirmfarben auf Papier: erst schwarze Tinte auf '
    + 'schwarzem Grund, nach dem Neutralisieren der Flaechen vivide Dark-Akzente auf '
    + `Weiss.\n${offenders.join('\n')}`);
});

/**
 * Die Kasten-in-Kasten-Regel, die im Stylesheet scharfe Haelfte: ein Well ist
 * die Antwort fuer eine KACHEL in einer Karte, und seine Definition lautet
 * „Flaeche, KEINE Kante, Radius bleibt". Ein Well mit eigener Kante waere
 * genau der umrandete Kasten in der kantenlosen Karte, den die Regel abschafft.
 *
 * Warum der Guard ueber `--color-fill-well` geht und nicht ueber Klassennamen:
 * der Token IST die Signatur. Wer eine Kachel eintieft, nimmt ihn - und wer
 * ihn nimmt, hat sich fuer die Well-Antwort entschieden. Ein Guard ueber
 * `.*-well`-Namen waere blind fuer jede Kachel, die sich nach ihrer Funktion
 * nennt (dieselbe Lehre wie bei `.birthdays-toolbar__import`).
 *
 * `border: none` zaehlt nicht als Kante - neun der elf Well-Regeln schreiben
 * genau das, weil sie eine geerbte Kante abraeumen.
 */
/**
 * DIE ZWEITE HAELFTE DER TRAEGER-REGEL BLEIBT UNGEPRUEFT, UND ZWAR GEMESSEN.
 *
 * Sie lautet: der Well gilt nur INNERHALB einer Karte, steht also im
 * Kontextselektor oder in einem Modifier, den der Erzeuger nur im
 * Kartenkontext setzt (`.metric-card--inset`), und nie in der Basisregel. Das
 * ist eine Aussage ueber den gerenderten BAUM - im Stylesheet ist „hat einen
 * Kartenkontext" nur als Heuristik ablesbar.
 *
 * Auf Ebene 4 waere sie stellbar, und die Sonde ist gebaut worden
 * (`.impeccable/redesign-tools/tree-probe.mjs`). Sie ist NICHT in die Suite
 * gewandert, weil die Messung ihre Reichweite zeigt: von den zehn Regeln, die
 * `--color-fill-well` setzen, sind ueber acht Routen genau ZWEI mit einem
 * sichtbaren Element vertreten (`.weather-widget__refresh` und
 * `.health-metric-card`, heute `.metric-card--inset`), und beide stehen
 * korrekt in einer Karte. Die anderen
 * acht liegen hinter Zustaenden, die kein Routenbesuch zeigt - Formulare,
 * Bestaetigungsbereiche, `[hidden]`-Bloecke.
 *
 * EIN GUARD, DER 20 % SEINER REGEL MISST UND DAFUER EINEN VOLLEN BAUMLAUF
 * KOSTET, IST KEINE ABSICHERUNG, SONDERN EINE BERUHIGUNG. Die Kantenhaelfte
 * unten deckt dagegen alle zehn Regeln, statisch und vollstaendig.
 *
 * (Beim Bau der Sonde steckten DREI Werkzeugfehler hintereinander, und der
 * dritte gehoert hierher, weil ihn der naechste genauso baut: `rule.cssRules`
 * ist seit CSS Nesting KEIN Verzweigungskriterium mehr - jede `CSSStyleRule`
 * traegt eine leere `CSSRuleList`, und die ist truthy. Wer die CSSOM
 * durchlaeuft, fragt `rule.cssRules?.length`.)
 */
test('ein Well traegt keine eigene Kante', () => {
  const offenders = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue; // die Definition des Tokens selbst
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/background(?:-color)?\s*:[^;]*var\(--color-fill-well\)/.test(rule.body)) continue;
      for (const declared of rule.body.matchAll(/(?:^|[;{}\s])(border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?)\s*:\s*([^;]+)/g)) {
        const value = declared[2].trim();
        if (/^(none|0|unset|initial)\b/.test(value)) continue;
        offenders.push(`${file}: ${rule.selector} -> ${declared[1]}: ${value}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Ein Well ist eine Vertiefung, kein umrandeter Kasten:\n${offenders.join('\n')}`,
  );
});

/**
 * Die Label-Farben-Regel: Large Titles tragen `--color-text-primary`, und es
 * gibt keinen Gradient-Text. Beides gehoerte zur abgeloesten Welt.
 *
 * Gradient-Text hat im CSS eine eindeutige Signatur - `background-clip: text`
 * zusammen mit einem transparenten Fuellwert. Sie steht heute nirgends
 * (gemessen 2026-08-08: 0 Fundstellen); das war der Positivbefund, den bisher
 * nichts gehalten hat.
 */
test('kein Titel wird zu Gradient-Text, und der Large Title bleibt in der Textfarbe', () => {
  const gradientText = [];
  const tintedTitle = [];
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (/(?:-webkit-)?background-clip\s*:\s*text/.test(rule.body)
        || /-webkit-text-fill-color\s*:\s*transparent/.test(rule.body)) {
        gradientText.push(`${file}: ${rule.selector}`);
      }
      // Die kanonische Seitentitel-Rolle - wer sie faerbt, faerbt den Large Title.
      if (!/(^|[\s,>])\.page-toolbar__title\b/.test(rule.selector)) continue;
      const colour = rule.body.match(/(?:^|[;{}\s])color\s*:\s*([^;]+)/);
      if (colour && !/var\(--color-text-primary\)|inherit/.test(colour[1])) {
        tintedTitle.push(`${file}: ${rule.selector} -> color: ${colour[1].trim()}`);
      }
    }
  }
  assert.deepEqual(gradientText, [], `Gradient-Text gehoert der abgeloesten Welt:\n${gradientText.join('\n')}`);
  assert.deepEqual(tintedTitle, [], `Der Large Title traegt --color-text-primary:\n${tintedTitle.join('\n')}`);
});

/**
 * Design-Werte kommen aus tokens.css - auch in einem JS-Template-String.
 *
 * Der Typo-Guard (`test:typography`) scannt Stylesheets; ein `style="…"` in
 * einem Template-Literal sieht er nicht. Session 20 fand dort genau eine
 * Fundstelle (drei Werte am Notiz-Formularlabel, aufgeloest zu
 * `.form-label__hint`) und sicherte GENAU DIESE STELLE ab - die Klasse blieb
 * offen. Das ist der Unterschied zwischen einem Guard ueber eine Regel und
 * einem ueber N Dateien, nur in der kleinstmoeglichen Form: N = 1.
 *
 * Geprueft wird das LITERAL. Ein `var(--token)` ist die richtige Antwort, und
 * ein berechneter Wert (`${…}`) ist eine andere Frage - dort steht eine
 * Nutzerfarbe oder eine Geometrie, und ob die stimmt, entscheiden die
 * Kontrast-Guards und Sonde 4, nicht dieser hier. GEMESSEN 2026-08-08: 185
 * Inline-Deklarationen in public/, davon 0 als Design-Literal.
 */
test('kein Inline-Style in public/ schreibt einen Design-Wert als Literal', () => {
  const DESIGN_PROPS = /^(font-size|font-weight|letter-spacing|line-height|border-radius|box-shadow|color|background|background-color|border-color)$/;
  const offenders = [];
  for (const path of walkJsFiles('../public/')) {
    if (path.includes('/vendor/')) continue;
    for (const attr of read(path).matchAll(/style\s*=\s*(["'])([^"']*?)\1/g)) {
      for (const declared of attr[2].matchAll(/(?:^|[;\s])([a-z-]+)\s*:\s*([^;"'`]+)/g)) {
        const [, prop, raw] = declared;
        if (!DESIGN_PROPS.test(prop)) continue;
        const value = raw.trim();
        if (/var\(--|\$\{/.test(value)) continue;
        offenders.push(`${path}: ${prop}: ${value}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Design-Wert inline statt aus tokens.css - eine Klasse dafuer anlegen:\n${offenders.join('\n')}`,
  );
});

/**
 * Die Toenungsskala: jede Toenung nimmt eine Stufe, keine schreibt eine Zahl.
 *
 * WARUM ES DIESEN GUARD BRAUCHT: die App toente vor dieser Runde an 214
 * Stellen in 37 Prozentstufen, und die Regel davor („16 %, EIN Rezept,
 * app-weit") beschrieb 23 davon. Der Grund stand in tokens.css: der Satz
 * „BEWUSST KEIN Token" galt fuer die FORMEL des Ink-Mix und wurde zwoelf
 * Sessions lang fuer die ZAHL gelesen. Ohne einen Guard ueber die Skala
 * entsteht die Streuung exakt so wieder - jede neue Flaeche haette wieder
 * keinen Wert zu greifen und schriebe ihren eigenen hin.
 *
 * DREI DINGE SIND KEINE TOENUNG, und alle drei haengen an einer SIGNATUR
 * statt an einer Selektorliste - eine Allowlist ueber 197 Fundstellen waere
 * genau die Bauart, die dieses Repo bei der Kueche und beim Budget schon
 * zweimal eingeholt hat:
 *
 *   1. DECKWERTE ab 45 %. Die Farbe IST dort die Flaeche und wird verdunkelt
 *      (`.btn--primary` 88 %, `.page-fab:hover` 85 %, `.month-day__holiday`
 *      90 %). Die Grenze ist gemessen und nicht gewaehlt: zwischen der
 *      hoechsten Stufe (24 %) und dem niedrigsten Deckwert (72 %) liegt im
 *      Bestand nichts.
 *   2. NUTZERFARBEN ALS TEXT. Die Ink-Stufe gilt fuer kuratierte Modultoene;
 *      auf einer frei gewaehlten Layer-Farbe bricht die Formel an den Enden
 *      der Helligkeitsachse (weiss auf light 1.92:1). Signatur: die Quelle ist
 *      eine `--*-color`-Nutzerfarbe UND die Eigenschaft ist `color`.
 *   3. ANIMATIONSSTUFEN. Ein Puls-Ring laeuft von 45 % auf 0 %; eine Stufe hat
 *      dort keine Bedeutung. Sie stehen nicht als Ausnahme hier, sondern
 *      fallen aus der REICHWEITE: `eachRule()` steigt nicht in `@keyframes`.
 *
 * Die Gegenrichtung steht darunter: eine Stufe ohne Nutzer waere eine
 * Einladung, sie beim naechsten Mal falsch zu belegen.
 */
const TINT_SOURCE = /--(module-[\w-]+|meal-[\w-]+|weather-[\w-]+|cycle-[\w-]+|layer-color|note-color|holi-color|ev-color|c-accent|active-module-accent|item-module-accent|color-accent|color-warning|color-danger|color-success|today-card-accent|widget-accent|subscription-color|rw-[\w-]+)/;
/* `countdown-accent` (#647) steht hier, weil die Kachel als EINZIGE Variable
 * beides fuehrt: bei einer Aufgabenzeile den kuratierten Modulton, bei einer
 * Terminzeile die vom Nutzer gewaehlte Farbe des Termins. Wer beide Faelle in
 * einer Deklaration bedient, faellt unter die strengere Regel. */
const TINT_USER_COLOUR = /--(layer-color|note-color|holi-color|ev-color|subscription-color|c-accent|countdown-accent)/;
/** Ab hier ist die Farbe die Flaeche und wird verdunkelt, statt beigemischt. */
const TINT_OPAQUE_FLOOR = 45;

test('jede Toenung nimmt eine Stufe der Toenungsskala', () => {
  const offenders = [];
  let seen = 0;
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue; // dort stehen die Stufen selbst
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      for (const mix of rule.body.matchAll(/([a-z-]+)\s*:[^;]*?color-mix\(\s*in srgb\s*,\s*([^;{}]+?)\s+(?:(\d+)%|var\(--tint-[a-z]+\)|calc\([^)]*--tint-[a-z]+[^)]*\))\s*,/g)) {
        const [, prop, source, pct] = mix;
        if (!TINT_SOURCE.test(source)) continue;
        seen += 1;
        if (pct === undefined) continue;                       // eine Stufe, direkt oder in calc()
        if (Number(pct) >= TINT_OPAQUE_FLOOR) continue;
        if (prop === 'color' && TINT_USER_COLOUR.test(source)) continue;
        offenders.push(`${file}: ${rule.selector} -> ${prop}: ${pct}% (${source.trim()})`);
      }
    }
  }
  // Ein Guard, der nichts gesehen hat, darf nicht urteilen - dieselbe
  // Zusicherung wie bei den Dokument-Sonden. Ein Tippfehler in TINT_SOURCE
  // machte ihn sonst gruen und blind zugleich. Keine feste Zahl: eine neue
  // Toenung soll die Suite nicht rot faerben, nur weil sie dazukommt.
  assert.ok(seen >= 150, `Nur ${seen} Toenungen gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Toenung mit einer eigenen Zahl statt einer Stufe aus tokens.css (6b).\n'
    + 'Waehle die Stufe nach der ROLLE: wash (untergreift fremden Inhalt), state\n'
    + '(Zustand), surface (die Toenung IST das Element), raised (Zustand darauf),\n'
    + `hint (Andeutung), ink (Text), shadow.\n${offenders.join('\n')}`,
  );
});

/**
 * REGEL: eine NUTZERFARBE als Textfarbe traegt ein gemessenes Rezept, nie eine
 * Stufe der Toenungsskala.
 *
 * DIE LUECKE, DIE DIESE SONDE SCHLIESST, IST DIE HAELFTE DES GUARDS DARUEBER,
 * DIE NIE URTEILT. Er springt bei `pct === undefined` heraus - eine benannte
 * Stufe ist per Definition erlaubt, das ist ja seine ganze Aussage. Damit war
 * ausgerechnet der Fall unsichtbar, den DESIGN.md ausdruecklich verbietet: die
 * Ink-Stufe auf einer frei gewaehlten Farbe. Der Kommentar ueber TINT_SOURCE
 * nennt „Nutzerfarben als Text" als eines von drei Dingen, die keine Toenung
 * sind - er verweist damit auf eine Regel, die kein Test hielt.
 *
 * Aufgefallen ist es an `.countdown-item__days` (#647), das `--tint-ink` auf
 * die Farbe des Termins legte, abgeschaut bei den Geburtstagen, die einen
 * KURATIERTEN Modulton fuehren. Der Guard darueber war dabei gruen - und zwar
 * doppelt: die Stufe war benannt (also ausgenommen) und `--countdown-accent`
 * stand in keiner Signatur. Erst die Korrektur auf das gemessene 35-%-Rezept
 * hat ihn rot gefaerbt, weil eine ROHE Zahl ihn ueberhaupt erst urteilen laesst.
 * Ein Guard, den nur die richtige Antwort weckt, ist keiner.
 *
 * Warum nicht in die Schleife darueber: die beantwortet „welche Stufe", diese
 * „ueberhaupt eine Stufe". Zwei Fragen an dieselbe Deklaration, und die zweite
 * verlangt genau die Zeilen, die die erste durchwinkt.
 */
test('eine Nutzerfarbe als Textfarbe nimmt ein gemessenes Rezept, keine Toenungsstufe', () => {
  const offenders = [];
  let seen = 0;
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      // Beide Schreibweisen einsammeln - die rohe Zahl zaehlt fuer die
      // Reichweite, die Stufe ist der Befund.
      for (const mix of rule.body.matchAll(/([a-z-]+)\s*:[^;]*?color-mix\(\s*in srgb\s*,\s*([^;{}]+?)\s+(?:(\d+)%|var\((--tint-[a-z]+)\))\s*,/g)) {
        const [, prop, source, pct, step] = mix;
        if (prop !== 'color' || !TINT_USER_COLOUR.test(source)) continue;
        seen += 1;
        if (pct !== undefined) continue;                       // gemessenes Rezept - erlaubt
        offenders.push(`${file}: ${rule.selector} -> color: ${step} auf ${source.trim()}`);
      }
    }
  }
  // Reichweiten-Nachweis NACH der Messung: ohne ihn haelt die Zusicherung auch
  // dann, wenn TINT_USER_COLOUR ins Leere greift. Der Bestand fuehrt fuenf
  // solche Deklarationen (vier im Kalender, eine auf dem Dashboard).
  assert.ok(seen >= 4, `Nur ${seen} Nutzerfarben-Textfarben gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Eine Toenungsstufe als Textfarbe auf einer frei waehlbaren Nutzerfarbe (DESIGN.md,\n'
    + 'Grenze der Akzent-auf-Toenung-Regel). Die Stufen sind an KURATIERTEN Modultoenen\n'
    + 'gemessen und brechen an den Enden der Helligkeitsachse - weiss auf light 1.92:1.\n'
    + 'Nimm das gemessene Rezept (35 % wie im Kalender) oder ein Token\n'
    + `(--color-text-primary).\n${offenders.join('\n')}`,
  );
});

test('jede Stufe der Toenungsskala hat mindestens einen Nutzer', () => {
  const tokens = read('../public/styles/tokens.css');
  const declared = [...tokens.matchAll(/^\s*(--tint-[a-z]+):/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 7, `Nur ${declared.length} Stufen gefunden - die Skala ist weg.`);

  const used = new Set();
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const hit of read(`../public/styles/${file}`).matchAll(/var\((--tint-[a-z]+)\)/g)) used.add(hit[1]);
  }
  assert.deepEqual(
    declared.filter((t) => !used.has(t)),
    [],
    'Eine Stufe ohne Nutzer ist eine Einladung, sie beim naechsten Mal falsch zu belegen.',
  );
});

/**
 * DIE VOLLTON-REGEL: was eine IDENTITAET NENNT, traegt seine Farbe im Vollton.
 *
 * WARUM ES DIESEN GUARD BRAUCHT, und die Antwort ist eine Wiederholung. Die
 * Messung von 2026-08-17 (dark-chroma.mjs) hat zwei Dinge gezeigt: im Dark
 * HELLT eine 16-%-Beimischung nur auf, statt zu faerben (Buntheit 4-8 von
 * 24-73 des Volltons), und im Light kollabieren benachbarte Familientoene auf
 * denselben Wert - Notizen, Dokumente und Inventar teilen die Familie
 * „records" und hatten bei 16 % BITWEISE denselben Scheibengrund. Daraus
 * folgte die Streichung von `module-seal--vivid` und `--seal-base`, und ein
 * Guard darueber. DER GUARD NANNTE DIE KLASSE, NICHT DIE REGEL. Also hat er
 * genau eine Bauart geschuetzt, waehrend elf Geschwister derselben Bauart
 * unter anderen Namen weiterlebten: die Kategoriescheibe der Kontakte, das
 * Absenderzeichen der Dokumentenkarte, das Modulzeichen der
 * Einstellungs-Modulliste, die Marke der geteilten Ausgaben, das
 * Schwangerschaftszeichen. Dieselbe Lehre wie bei der Kueche und beim Budget:
 * ein Guard ueber eine Namensliste deckt keine Regel ab, sondern N Dateien.
 *
 * DIE SIGNATUR IST DIE BAUART, NICHT DER NAME. Gesucht wird ein BEHAELTER
 * (`width` UND `height` gesetzt - eine Marke ist bemessen, ein Chip waechst mit
 * seinem Text), dessen Hintergrund eine Identitaetsfarbe als WASCHUNG fuehrt
 * (`--tint-wash`/`--tint-surface`) und der DIESELBE Farbe noch einmal im
 * Vordergrund nennt. Zweimal blass ueber dieselbe Aussage - das ist die
 * zurueckgenommene Fassung, und sie ist an ihrer Doppelung erkennbar.
 *
 * ZWEI WEGE FUEHREN HERAUS, und beide sind eine Antwort, kein Schlupfloch:
 *
 *   1. VOLLTON. Ein KURATIERTER Ton (Modul-/Familienton) traegt die Flaeche,
 *      der Glyph nimmt `--color-ink-on-vivid`. Gemessen fuer jede Marke dieser
 *      Runde in beiden Themes, mit und ohne Sheen: schlechtester Fall light
 *      3.65:1, dark 6.17:1 (`.impeccable/redesign-tools/vollton-marken.mjs`) -
 *      dasselbe Feld, das schon am `.module-seal` steht.
 *   2. KANTE, RING ODER PUNKT. Eine FREI GEWAEHLTE Nutzerfarbe kann keine
 *      Flaeche tragen, weil ihre Helligkeit unbestimmt ist (ein schwarzer
 *      Termin lag bei 1.22:1). Sie steht deshalb NEBEN dem Inhalt statt
 *      darunter: `border-inline-start: 3px solid` am Kalenderblock, der
 *      Inset-Ring an der Countdown-Scheibe, der 8px-Punkt an der Agendazeile.
 *      Dort braucht sie keine Tinte, also auch keine Zusicherung ueber sie.
 *
 * WER NICHTS NENNT, FAELLT NICHT UNTER DIE REGEL. Ein Platzhalter - die
 * Dropzone, das Vorschaufeld ohne Bild, der Avatar eines Kontakts ohne
 * Haushalts-Verknuepfung - sagt mit einer Modultoenung „Dokumente" auf einer
 * Seite, die das schon beantwortet hat. Solche Flaechen sind in dieser Runde
 * NEUTRAL geworden statt bunt; sie fuehren danach gar keine Identitaetsfarbe
 * mehr und liegen damit ausserhalb der Signatur, ohne eine Ausnahme zu
 * brauchen.
 */
/* `--color-accent` GEHOERT DAZU - aber nur ueber die Doppelnennung.
 *
 * Die Stimme fehlte in dieser Liste, und `.changelog-release__badge` kam
 * dadurch durch: 16-%-Flaeche plus dieselbe Farbe als Schrift darauf, also
 * genau die Bauart, die die Regel abgeschafft hat. Sie pauschal zu verbieten
 * waere falsch - gemessen tragen 19 Stellen eine Stimm-Waschung, und 15 davon
 * sind die Shell an genau dem Ort, an dem sie hingehoert (`.page-fab`,
 * `.btn--primary`, die Nav-Indikatoren, die Overlays). Der Unterschied ist
 * nicht die Farbe, sondern ob sie ZWEIMAL steht: die Shell fuellt voll und
 * setzt `--color-ink-on-vivid` darauf, ein Etikett nennt sie blass und noch
 * einmal blass. Die Guards unten pruefen genau das. */
const MARK_SOURCE = /--(module-[\w-]+|meal-[\w-]+|weather-[\w-]+|cycle-[\w-]+|layer-color|note-color|holi-color|ev-color|c-accent|cat|active-module-accent|item-module-accent|today-card-accent|widget-accent|subscription-color|countdown-accent|module-row-accent|seal-accent|rw-[\w-]+|color-accent)\b/;
const MARK_WASH = /var\(--tint-(wash|surface)\)/;
/** Traeger eines Volltons: die Farbe ohne `color-mix()` drumherum. */
const MARK_VIVID_PROP = /^(background(-color|-image)?|border(-[\w-]+)?|box-shadow|outline|fill)$/;

/** Deklarationen eines Regelrumpfs, an Semikolons AUSSERHALB von Klammern. */
function declarations(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
    .filter(([prop]) => prop);
}

/** Derselbe Wert ohne seine `color-mix()`-Aufrufe - was bleibt, ist Vollton. */
function withoutColorMix(value) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (depth === 0 && value.startsWith('color-mix(', i)) { depth = 1; i += 9; continue; }
    if (depth > 0) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      continue;
    }
    out += value[i];
  }
  return out;
}

test('eine Marke nennt ihre Identitaet im Vollton, nicht zweimal als Waschung', () => {
  const offenders = [];
  let seen = 0;
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      const decls = declarations(rule.body);
      // Ein BEHAELTER: bemessen statt vom Text getragen.
      if (!decls.some(([p]) => p === 'width') || !decls.some(([p]) => p === 'height')) continue;
      if (!MARK_SOURCE.test(rule.body)) continue;
      seen += 1;

      const washed = decls.find(([p, v]) => /^background(-color)?$/.test(p) && MARK_WASH.test(v) && MARK_SOURCE.test(v));
      if (!washed) continue;
      const source = washed[1].match(MARK_SOURCE)[0];
      // Nennt der Vordergrund DIESELBE Farbe noch einmal? Dann ist die Aussage
      // doppelt und beide Male blass - die zurueckgenommene Fassung.
      if (!decls.some(([p, v]) => p === 'color' && v.includes(`var(${source}`))) continue;
      // Traegt irgendeine Eigenschaft desselben Rumpfs die Farbe im Vollton?
      const vivid = decls.some(([p, v]) => MARK_VIVID_PROP.test(p) && withoutColorMix(v).includes(`var(${source}`));
      if (vivid) continue;
      offenders.push(`${file}: ${rule.selector} -> ${source}`);
    }
  }
  // Reichweiten-Nachweis: ohne ihn haelt die Zusicherung auch dann, wenn
  // MARK_SOURCE ins Leere greift - dieselbe Vorsichtsmassnahme wie bei der
  // Toenungsskala darueber. Der Bestand fuehrt 52 bemessene Behaelter mit einer
  // Identitaetsfarbe; keine feste Zahl, damit eine neue Marke die Suite nicht
  // rot faerbt, nur weil sie dazukommt.
  assert.ok(seen >= 35, `Nur ${seen} bemessene Marken gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Eine Marke nennt ihre Identitaet zweimal als Waschung (DESIGN.md, Colors: die\n'
    + 'Vollton-Regel). Eine 16-%-Toenung hellt im Dark nur auf und laesst im Light\n'
    + 'benachbarte Familientoene auf denselben Wert fallen - sie kann die Aussage\n'
    + 'nicht tragen. Zwei Antworten:\n'
    + '  kuratierter Ton  -> Vollton-Flaeche, Glyph in var(--color-ink-on-vivid)\n'
    + '                      (Klasse `vivid-mark`, layout.css)\n'
    + '  freie Nutzerfarbe -> Vollton als Kante, Ring oder Punkt NEBEN dem Inhalt\n'
    + `                      (3px border-inline-start, inset box-shadow)\n${offenders.join('\n')}`,
  );
});

/**
 * SIGNATUR: was KEINE Marke ist, nennt seinen Ton auch nicht zweimal blass.
 *
 * Der Guard darueber sucht dieselbe Bauart an einer MARKE - einem bemessenen
 * Behaelter mit `width` UND `height`. Genau diese Bedingung liess die zweite
 * Haelfte des Bestands stehen: ein Etikett ist NICHT bemessen, es waechst mit
 * seinem Text. Uebrig blieben acht Stellen, und sie sagten alle den Modulton in
 * einem Raum, der ihn schon beantwortet hat - das Haushalt-Badge im Budget, das
 * Bedarfs-Badge und die Schwangerschaftsmarke in der Gesundheit, die Zaehlmarke
 * im Mehr-Blatt, der Widget-Zaehler, das Alters-Badge neben einem Avatar in der
 * MITGLIEDSfarbe, die Uhrzeit im Gesundheits-Widget, der offene Betrag im
 * Haushaltshilfe-Widget. Dieselbe Lehre wie am Siegel, zum vierten Mal: **wer
 * eine Regel setzt, sucht ihre Geschwister ueber die BAUART, nicht ueber den
 * Namen.** Deshalb steht hier auch kein Namensmuster: dieser Guard ist die
 * KOMPLEMENTMENGE des Marken-Guards, alles was uebrig bleibt.
 *
 * Die drei Antworten stehen in DESIGN.md (Colors, Skalen-Regel):
 *   Meldung   -> Ton in der SCHRIFT, keine Flaeche (Vorrat, Inventar-Status)
 *   Rangmarke -> Vollton-PUNKT, Schrift neutral (Aufgaben-Prioritaet)
 *   Zuordnung -> Vollton-FLAECHE mit --color-ink-on-vivid, und nur dort, wo die
 *                genannte Identitaet nicht die des Raums ist (Herkunfts-Regel)
 *
 * DREI AUSNAHMEN, jede mit einem Grund, der KEINE Namensliste ist:
 *  - Traegt der Rumpf die Farbe irgendwo VOLL (Kante, Ring, Punkt), ist die
 *    Aussage gesetzt und die Flaeche darunter ist ihr Beiwerk - so gebaut sind
 *    die vier Kalender-Ereignisansichten seit v2.22.0.
 *  - Steht die Schrift im VOLLEN Ton, ist das ein Callout und keine
 *    zurueckgenommene Marke (.changelog-status--error).
 *  - `cursor: pointer` heisst BEDIENELEMENT. Fuer die gilt die Eine-Stimme-Regel
 *    und ihr eigener Guard („kein geteiltes Bedienelement wird unter seinem
 *    eigenen Namen umgefaerbt"); ein aktiver Filter-Chip beantwortet „wo bin
 *    ich", und dafuer ist der Modulton zustaendig.
 */
const LABEL_STATE = /(:hover|:focus|:active|:checked|\.is-|--active|--selected|--current|--dragging|--loading|--open|\[aria-|\[data-)/;

test('was keine Marke ist, nennt seinen Ton auch nicht zweimal blass', () => {
  const offenders = [];
  let seen = 0;
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      const decls = declarations(rule.body);
      // Eine MARKE ist bemessen - die gehoert dem Guard darueber.
      if (decls.some(([p]) => p === 'width') && decls.some(([p]) => p === 'height')) continue;
      // Ein BEDIENELEMENT gehoert der Eine-Stimme-Regel und ihrem Guard.
      if (decls.some(([p, v]) => p === 'cursor' && v.trim() === 'pointer')) continue;

      const washed = decls.find(([p, v]) => /^background(-color)?$/.test(p) && v.includes('color-mix') && MARK_SOURCE.test(v));
      if (!washed) continue;
      seen += 1;
      const source = washed[1].match(MARK_SOURCE)[0];
      // ROHE Tinte zaehlt mit. Der Guard verlangte, dass die Schrift SELBST ein
      // `color-mix` ist - `color: var(--color-accent)` auf einer 16-%-Flaeche
      // derselben Farbe galt damit als Callout und kam durch. Die Regel fragt,
      // wie oft die Farbe genannt wird, nicht in welcher Schreibweise.
      const pale = decls.find(([p, v]) => p === 'color' && v.includes(`var(${source}`));
      if (!pale) continue;
      // Traegt der Rumpf die Farbe irgendwo VOLL? Dann ist die Aussage gesetzt.
      if (decls.some(([p, v]) => MARK_VIVID_PROP.test(p) && withoutColorMix(v).includes(`var(${source}`))) continue;

      const selectors = rule.selector.split(',').map((sel) => sel.trim()).filter((sel) => !LABEL_STATE.test(sel));
      if (!selectors.length) continue;
      offenders.push(`${file}: ${selectors.join(', ')} -> ${source}`);
    }
  }
  // Reichweiten-Nachweis wie beim Marken-Guard: `seen` zaehlt die
  // NICHT-Marken, die eine Identitaetsfarbe als Waschung fuehren - der Bestand
  // hat davon rund 30 (die vier Kalender-Ansichten, Dropzones, Zustandsfelder).
  // Ohne die Zahl haelt die Zusicherung auch dann, wenn MARK_SOURCE ins Leere
  // greift.
  assert.ok(seen >= 15, `Nur ${seen} nicht-bemessene Waschungen gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Etwas, das keine Marke ist, nennt seinen Ton zweimal blass (DESIGN.md,\n'
    + 'Colors: die Skalen-Regel). Getoente Flaeche UND gemischte Schrift derselben\n'
    + 'Farbe ist die zurueckgenommene Fassung - eine Beimischung hellt im Dark\n'
    + 'fast nur auf. Drei Antworten, je nachdem was das Element SAGT:\n'
    + '  Meldung   -> Ton in der Schrift, keine Flaeche\n'
    + '  Rangmarke -> Vollton-Punkt daneben, Schrift neutral\n'
    + '  Zuordnung -> Vollton-Flaeche mit var(--color-ink-on-vivid); nennt sie den\n'
    + '               Raum, in dem sie steht, bleibt sie neutral (--color-fill-well)\n'
    + `${offenders.join('\n')}`,
  );
});

/**
 * REGEL: eine Farbe zaehlt auch dann zweimal, wenn sie in ZWEI Regeln steht.
 *
 * Die beiden Guards darueber lesen EINEN Regelkoerper. Genau daran sind sie
 * vorbeigelaufen, und zwar an der haeufigsten Bauart ueberhaupt: der Behaelter
 * traegt die getoente Flaeche, sein Kind den Glyph in derselben Farbe.
 *
 *     .rw-reward-card__icon   { background: color-mix(... --module-accent ...) }
 *     .rw-reward-card__icon i { color: var(--module-accent) }
 *
 * Gemessen war das keine Theorie: sechs Praemienkacheln, sieben Kartenkoepfe der
 * Gesundheit und der Beleg-Chip standen so im Baum, waehrend beide Guards gruen
 * meldeten. Der Marken-Guard sah eine bemessene Flaeche ohne Tinte, der
 * Etiketten-Guard eine Tinte ohne Flaeche - jeder fuer sich korrekt.
 *
 * WAS DIESER GUARD NICHT MELDET, ist ebenso wichtig wie was er meldet:
 *   - Wo die Farbe irgendwo VOLL steht, ist die Aussage gesetzt (Vollton-Regel).
 *     Die Terminbloecke des Kalenders tragen ihre `--ev-color` als 3px-Kante und
 *     duerfen sie im Icon wiederholen.
 *   - Zustaende (`:hover`, `--dragging`, `.is-`) gehoeren der Eine-Stimme-Regel.
 *   - Bedienelemente ebenso, erkannt an `cursor: pointer` an einem der beiden.
 *
 * Der Nachfahre wird ueber die SELEKTOR-FORM gesucht, nicht ueber Namen: ein
 * Guard, der `__icon` listet, findet beim naechsten Bauteil nichts (dieselbe
 * Lehre wie beim Siegel-Guard, dessen Namensliste `.birthday-widget-item__age`
 * uebersah).
 */
test('eine Waschung und ihre Tinte zaehlen zusammen, auch ueber zwei Regeln', () => {
  const offenders = [];
  let seen = 0;
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    const rules = [...eachRule(read(`../public/styles/${file}`))];

    for (const rule of rules) {
      const decls = declarations(rule.body);
      const bedienEltern = decls.some(([p, v]) => p === 'cursor' && v.trim() === 'pointer');
      const wash = decls.find(([p, v]) => /^background(-color)?$/.test(p) && v.includes('color-mix') && MARK_SOURCE.test(v));
      if (!wash) continue;
      const source = wash[1].match(MARK_SOURCE)[0];
      // Traegt die Regel die Farbe irgendwo VOLL? Dann ist die Aussage gesetzt.
      if (decls.some(([p, v]) => MARK_VIVID_PROP.test(p) && withoutColorMix(v).includes(`var(${source}`))) continue;

      const eltern = rule.selector.split(',').map((x) => x.trim()).filter((x) => !LABEL_STATE.test(x));
      if (!eltern.length) continue;
      seen += 1;

      for (const kind of rules) {
        if (kind === rule) continue;
        const kdecls = declarations(kind.body);
        if (kdecls.some(([p, v]) => p === 'cursor' && v.trim() === 'pointer')) continue;
        // Traegt das KIND die Farbe voll? Dann ist auch dort die Aussage gesetzt.
        if (kdecls.some(([p, v]) => MARK_VIVID_PROP.test(p) && withoutColorMix(v).includes(`var(${source}`))) continue;
        const tinte = kdecls.find(([p, v]) => p === 'color' && v.includes(`var(${source}`));
        if (!tinte) continue;

        for (const ksel of kind.selector.split(',').map((x) => x.trim())) {
          if (LABEL_STATE.test(ksel)) continue;
          const vorfahr = eltern.find((esel) => ksel.startsWith(`${esel} `) || ksel.startsWith(`${esel}>`));
          if (!vorfahr) continue;
          if (bedienEltern) continue;
          offenders.push(`${file}: ${vorfahr} traegt die Waschung, ${ksel} die Tinte -> ${source}`);
        }
      }
    }
  }
  // Reichweiten-Nachweis: ohne ihn haelt die Zusicherung auch dann, wenn
  // MARK_SOURCE oder der Waschungs-Filter ins Leere greifen.
  assert.ok(seen >= 15, `Nur ${seen} Waschungen gesehen - die Signatur greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Eine Identitaetsfarbe steht als Flaeche im Behaelter UND als Tinte im Kind -\n'
    + 'zusammen ist das die Doppelnennung, die die Vollton-Regel abgeschafft hat,\n'
    + 'sie steht nur in zwei Regeln statt in einer. Entweder die Farbe steht\n'
    + 'irgendwo VOLL (Kante, Punkt, gefuellte Scheibe), oder beide bleiben neutral.\n'
    + `${offenders.join('\n')}`,
  );
});

/**
 * REGEL: zwei Stufen einer Reihe sehen nie unabsichtlich gleich aus.
 *
 * `countdownChip()` in birthdays.js kennt drei Stufen und sagt das im Kommentar
 * ("`mod` steuert die visuelle Stufe"). Die Regeln fuer `--default` und
 * `--soon` waren BITWEISE identisch - eine Skala mit einer Stufe, die es nicht
 * gab, und niemandem aufgefallen, weil beide getoent waren und eine Toenung
 * ohnehin kaum etwas sagt. Ein Geburtstag morgen und einer in vierzig Tagen
 * sahen gleich aus.
 *
 * Gesucht werden Geschwister-Modifier EINER Basisklasse, die in GETRENNTEN
 * Regeln stehen und dieselbe gerenderte Farbe setzen. Die Trennung ist der
 * Kern: `.inventory-status-badge--disposed, .inventory-status-badge--lost`
 * teilen ihre Regel ausdruecklich - der Autor hat gesagt, dass beide "nicht
 * mehr da" heissen und das Wort den Rest erledigt. Zwei Regeln, die zufaellig
 * dasselbe tun, hat niemand gesagt.
 *
 * Nur gerenderte Farbe zaehlt, keine Custom-Property-Zuweisung: dass das
 * Familien-Widget und das Kontakte-Widget beide `--widget-accent:
 * var(--module-contacts)` setzen, ist eine ZUORDNUNG (dasselbe Modul), keine
 * Stufe. Und keine Reset-Werte (`none`, `transparent`, `inherit`), sonst zaehlt
 * `background: none` dreier Navigations-Knoepfe als Farbaussage.
 */
const SCALE_PAINT = /^(color|background|background-color|border-color|fill|stroke)$/;
const SCALE_RESET = /^(none|transparent|inherit|initial|unset|currentcolor)$/i;
/** Nicht-Farb-Eigenschaften zaehlen mit: sie unterscheiden zwei Stufen genauso. */
const SCALE_IGNORE = /^(content|transition|animation|will-change|cursor|font-family|--)/;

test('zwei Stufen einer Reihe sehen nie unabsichtlich gleich aus', () => {
  const families = new Map();
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((n) => n.endsWith('.css'))) {
    if (file === 'tokens.css') continue;
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      const mods = rule.selector.split(',').map((sel) => sel.trim())
        .map((sel) => sel.match(/^\.([a-z0-9-]+?)--([a-z0-9-]+)$/i))
        .filter(Boolean);
      if (!mods.length) continue;
      const decls = declarations(rule.body);
      // Die Reihe muss ueberhaupt FARBE fuehren - sonst zaehlen die zwoelf
      // Rastergroessen des Dashboards als Skala.
      if (!decls.some(([p, v]) => SCALE_PAINT.test(p) && !SCALE_RESET.test(v.trim()))) continue;
      // Verglichen wird der ganze sichtbare Rumpf, nicht nur die Farbe: eine
      // Kante (`border: 1.5px solid ...`) oder eine Polsterung unterscheidet
      // zwei Stufen genauso, und `border` ist eine Kurzform, die kein
      // Farb-Filter sieht (gemessen an .btn--danger-outline gegen -ghost).
      const paint = decls
        .filter(([p]) => !SCALE_IGNORE.test(p))
        .map(([p, v]) => `${p}:${v.replace(/\s+/g, ' ').trim()}`)
        .sort()
        .join(';');
      if (!paint) continue;
      // Modifier, die sich EINE Regel teilen, sind erklaert gleich.
      const declared = mods.map((m) => m[2]).join('+');
      for (const m of mods) {
        const key = `${file}|${m[1]}|${rule.at.join('>')}`;
        if (!families.has(key)) families.set(key, []);
        families.get(key).push({ mod: m[2], paint, declared });
      }
    }
  }

  const offenders = [];
  let compared = 0;
  for (const [key, entries] of families) {
    if (entries.length < 2) continue;
    compared += 1;
    const byPaint = new Map();
    for (const entry of entries) {
      if (!byPaint.has(entry.paint)) byPaint.set(entry.paint, []);
      byPaint.get(entry.paint).push(entry);
    }
    for (const [, group] of byPaint) {
      const declarations_ = new Set(group.map((g) => g.declared));
      // Alle aus derselben Regel? Dann ist die Gleichheit ausgesprochen.
      if (declarations_.size < 2 && group.length === group[0].declared.split('+').length) continue;
      const mods = [...new Set(group.map((g) => g.mod))];
      if (mods.length < 2) continue;
      if (declarations_.size === 1) continue;
      offenders.push(`${key} -> ${mods.join(' == ')}`);
    }
  }
  assert.ok(compared >= 20, `Nur ${compared} Modifier-Reihen verglichen - der Scanner greift nicht mehr.`);
  assert.deepEqual(
    offenders,
    [],
    'Zwei Modifier derselben Basisklasse malen dasselbe, ohne sich eine Regel zu\n'
    + 'teilen (DESIGN.md, Colors: die Skalen-Regel). Entweder ist eine Stufe zu\n'
    + 'viel benannt, oder sie ist gemeint und gehoert in DIESELBE Regel wie ihre\n'
    + `Schwester - dort steht sie als Absicht statt als Zufall.\n${offenders.join('\n')}`,
  );
});

/**
 * REGEL: `var(--x)` ohne Fallback verlangt, dass --x auch irgendwo entsteht.
 *
 * Ein Verweis auf ein Token, das es nicht gibt, ist zur Laufzeit KEIN Fehler:
 * die Deklaration wird ungueltig und die Eigenschaft faellt auf ihren geerbten
 * Wert zurueck. Genau deshalb ueberlebt so etwas Jahre - es sieht meistens
 * richtig aus. `color: var(--color-text)` stand an vier Stellen (auth.css,
 * dashboard.css, subscriptions.css x2); das Vokabular der App kennt nur
 * --color-text-primary. Drei der vier fielen auf eine Vererbung zurueck, die
 * zufaellig dasselbe lieferte, und der vierte war ein Hover, der nichts tat.
 *
 * Der Guard muss die Laufzeit mitzaehlen, sonst meldet er 29 Fehlalarme: die
 * App setzt Tokens per style.setProperty() und ueber inline-style-Attribute in
 * Templates (--point-x, --module-accent, --cal-color ...). Beide Quellen
 * werden aus dem JS gelesen, nicht aus einer gepflegten Liste - eine Liste
 * waere beim naechsten neuen Token still veraltet.
 */
test('kein var() auf ein Token, das nirgends entsteht', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const defined = new Set();
  const used = new Map();

  for (const name of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    const css = read(`../public/styles/${name}`).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    // Nur ohne Fallback: `var(--x, ...)` ist ein gueltiges Muster fuer Tokens,
    // die erst zur Laufzeit gesetzt werden.
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(name);
    }
  }

  const runtime = new Set();
  const collectJs = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') collectJs(`${dir}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const src = read(`${dir}${entry.name}`);
      for (const m of src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) runtime.add(m[1]);
      // Ein style-Attribut kann MEHRERE Properties tragen
      // (`style="--point-x:..;--point-slots:.."`): erst das Attribut greifen,
      // dann alle Namen darin. Ein Muster, das direkt auf das erste --x zielt,
      // uebersieht jedes weitere - und meldet es als Waise.
      for (const attr of src.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
        for (const m of (attr[1] ?? attr[2] ?? attr[3] ?? '').matchAll(/(--[\w-]+)\s*:/g)) runtime.add(m[1]);
      }
    }
  };
  collectJs('../public/');

  assert.ok(defined.size >= 400, `Nur ${defined.size} Token-Definitionen gefunden - der Scanner misst nichts.`);
  assert.ok(used.size >= 100, `Nur ${used.size} fallback-freie var()-Verwendungen gefunden - dito.`);

  const orphans = [...used.keys()]
    .filter((token) => !defined.has(token) && !runtime.has(token))
    .map((token) => `${token} (in ${[...used.get(token)].join(', ')})`);

  assert.deepEqual(
    orphans,
    [],
    'var() auf ein Token, das weder in einem Stylesheet noch zur Laufzeit entsteht.\n'
    + 'Die Deklaration ist ungueltig und die Eigenschaft erbt still weiter - das faellt\n'
    + `im Betrieb nicht auf, aber sie tut nicht, was dasteht.\n${orphans.join('\n')}`,
  );
});

/**
 * REGEL: --color-text-disabled ist die Farbe DEAKTIVIERTER Bedienelemente und
 * sonst nichts. Sie traegt auf keiner Flaeche der App 3:1 (1,36 bis 2,17), und
 * das ist richtig so: WCAG 1.4.3 nimmt Deaktiviertes ausdruecklich aus. Genau
 * deshalb ist sie an einem ERREICHBAREN Element immer ein Fehler - dort gilt
 * die Ausnahme nicht, und die Ruhefarbe faellt unter jede Schwelle.
 *
 * Der Guard steht hier, weil die Regel dreimal als Fundstelle behandelt wurde
 * statt als Regel:
 *   Runde: vier Icon-Knoepfe (ccd61d33), danach faende sich der fuenfte
 *   (.ingredient-row__remove), der sechste und siebte (.meal-slot__* im
 *   Dashboard, waehrend der Kuechen-Zwilling laengst gefixt war) und ein
 *   Zustand, der kein Knopf ist (.shopping-item--checked .item-meta).
 * Acht Fundstellen, eine Regel. Eine Allowlist haette hier N Dateien gedeckt
 * und keine Zusage; deshalb entscheidet der SELEKTOR, nicht eine Liste.
 *
 * Absichtlich nur die direkte Zuweisung `color: var(--color-text-disabled)`:
 * ein `color-mix()` mit dem Token ist eine abgeleitete Farbe mit eigenem
 * Kontrast (.empty-state__icon mischt es mit dem Modul-Akzent), keine
 * uebernommene Zusage. Hintergruende sind ebenfalls draussen - ein Punkt ist
 * Grafik und wird an 3:1 fuer nicht-textuelle Inhalte gemessen, nicht an 4,5.
 */
test('die Deaktiviert-Farbe steht an keinem erreichbaren Bedienelement', () => {
  const DISABLED_SELECTOR = /:disabled\b|\[disabled\]|\[aria-disabled(?:="true")?\]|(?:^|[\s.>+~])[\w-]*(?:--disabled|\.is-disabled)\b/;
  const DIRECT_COLOR = /(?:^|[;{\s])color:\s*var\(--color-text-disabled\s*\)/;

  const styleDir = new URL('../public/styles/', import.meta.url);
  let rulesSeen = 0;
  let usesSeen = 0;
  const offenders = [];

  for (const name of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    if (name === 'tokens.css') continue;
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      rulesSeen += 1;
      if (!DIRECT_COLOR.test(body)) continue;
      usesSeen += 1;
      if (!DISABLED_SELECTOR.test(selector)) offenders.push(`${name}: ${selector}`);
    }
  }

  // Eine Sonde, die nichts gemessen hat, darf nicht urteilen: ohne diese zwei
  // Zeilen waere ein umbenanntes Token oder ein kaputter Scanner als gruenes
  // "keine Verstoesse" durchgegangen.
  assert.ok(rulesSeen >= 2000, `Nur ${rulesSeen} Regeln gelesen - der Scanner hat nichts gesehen.`);
  assert.ok(usesSeen > 0, 'Keine einzige Verwendung von --color-text-disabled gefunden. '
    + 'Wurde das Token umbenannt? Dann prueft dieser Guard seit dem Umbenennen nichts mehr.');

  assert.deepEqual(
    offenders,
    [],
    '--color-text-disabled als Ruhefarbe eines erreichbaren Elements. Die Farbe traegt\n'
    + 'nirgends 3:1 - erlaubt ist sie nur, wo der Selektor den deaktivierten Zustand\n'
    + 'auch benennt (:disabled, [disabled], [aria-disabled]). Ein Element, das nur\n'
    + `zuruecktreten soll, nimmt --color-text-tertiary (4,86 bis 6,90).\n${offenders.join('\n')}`,
  );
});

/**
 * Die Statusleiste der installierten PWA IST der Seitengrund.
 *
 * `<meta name="theme-color">` nimmt an keiner Kaskade teil - der Wert muss als
 * Literal danebenstehen, und zwar dreimal: in `index.html`, in `offline.html`
 * und in `router.js`, das ihn zur Laufzeit fuer den modullosen Fall neu setzt.
 * Drei Kopien ohne Guard sind drei Gelegenheiten zum Auseinanderlaufen, und
 * genau das war passiert: alle drei trugen dunkel `#0C0C0E`, waehrend
 * `--color-bg` bei `#0A0A0C` stand. Sichtbar nur im Dark Mode der installierten
 * PWA - also im einzigen Theme, in dem man die Naht auch sieht - und der
 * Kommentar in `router.js` behauptete dabei, es seien "dieselben Werte".
 *
 * Geprueft wird gegen das TOKEN, nicht gegen einen vierten hartkodierten Wert:
 * die Erwartung wird aus `tokens.css` aufgeloest, indem die `var()`-Kette von
 * `--color-bg` verfolgt wird - hell aus `:root`, dunkel aus `[data-theme=dark]`.
 */
test('the status bar colour is the page background, in both themes', () => {
  const tokens = read('../public/styles/tokens.css');

  /**
   * Custom Properties eines Selektors der Grundebene.
   *
   * „Grundebene" heisst: keine At-Kette, oder eine, die nur aus `@media screen`
   * besteht. Der Dark-Block liegt seit dem 2026-08-09 darin (Papier druckt keine
   * Bildschirmfarben), und `screen` schraenkt die Farbwelt nicht bedingt ein -
   * es nennt nur das Medium, fuer das sie ohnehin gilt. Ein
   * `prefers-contrast`-Block bliebe weiter draussen, und das ist der Sinn der
   * Einschraenkung.
   */
  const propsOf = (wanted) => {
    const map = new Map();
    for (const { selector, body, at } of eachRule(tokens)) {
      const conditional = at.some((a) => !/^@media\s+screen$/.test(a.trim()));
      if (conditional || selector !== wanted) continue;
      for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        map.set(name, value.trim());
      }
    }
    return map;
  };

  const light = propsOf(':root');
  const dark = new Map([...light, ...propsOf('[data-theme="dark"]')]);

  /** Folgt `var(--a)` -> `var(--b)` -> `#hex`, hoechstens zehn Stufen tief. */
  const resolve = (scope, name) => {
    let value = scope.get(name);
    for (let step = 0; step < 10 && value; step += 1) {
      const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
      if (!ref) break;
      value = scope.get(ref[1]);
    }
    return value?.toUpperCase();
  };

  const expected = {
    light: resolve(light, '--color-bg'),
    dark: resolve(dark, '--color-bg'),
  };

  // Reichweiten-Nachweis: loest die Kette ins Leere, prueft der Guard nichts.
  assert.match(expected.light ?? '', /^#[0-9A-F]{6}$/, '--color-bg (hell) liess sich nicht bis auf einen Hexwert aufloesen');
  assert.match(expected.dark ?? '', /^#[0-9A-F]{6}$/, '--color-bg (dunkel) liess sich nicht bis auf einen Hexwert aufloesen');
  assert.notEqual(expected.light, expected.dark, 'Hell und Dunkel loesen auf denselben Wert auf - die Dark-Quelle wurde nicht gelesen');

  const offenders = [];

  for (const file of ['../public/index.html', '../public/offline.html']) {
    const html = read(file);
    const metas = [...html.matchAll(/<meta\b[^>]*\bname=["']theme-color["'][^>]*>/g)].map((m) => m[0]);
    assert.equal(metas.length, 2, `${file}: erwartet je ein theme-color-Meta fuer hell und dunkel, gefunden ${metas.length}`);
    for (const meta of metas) {
      const value = meta.match(/\bcontent=["']([^"']+)["']/)?.[1]?.toUpperCase();
      const scheme = /prefers-color-scheme:\s*dark/.test(meta) ? 'dark' : 'light';
      if (value !== expected[scheme]) offenders.push(`${file} (${scheme}): ${value} statt ${expected[scheme]}`);
    }
  }

  const call = read('../public/router.js').match(/setThemeColor\(\s*'(#[0-9A-Fa-f]{6})'\s*,\s*'(#[0-9A-Fa-f]{6})'\s*\)/);
  assert.ok(call, 'expected router.js to set the route-independent status bar colour from two literals');
  if (call[1].toUpperCase() !== expected.light) offenders.push(`router.js (light): ${call[1]} statt ${expected.light}`);
  if (call[2].toUpperCase() !== expected.dark) offenders.push(`router.js (dark): ${call[2]} statt ${expected.dark}`);

  assert.deepEqual(
    offenders,
    [],
    'theme-color weicht von --color-bg ab. Die Statusleiste der installierten PWA sitzt\n'
    + `dann neben der Seite, die sie rahmt:\n${offenders.join('\n')}`,
  );
});

/**
 * Ein Zeilenkoerper, der den ganzen Zeileninhalt umschliesst, traegt kein
 * aria-label.
 *
 * `role=button` ist per ARIA "children presentational": ein aria-label ERSETZT
 * den Inhalt, es ergaenzt ihn nicht. An `.list-row__main--interactive` haengt
 * aber genau der Inhalt, den sehende Nutzer auf einen Blick bekommen - Name,
 * Status, Faelligkeit, Betrag. Mit Label hoert ein Screenreader davon nichts
 * mehr, sondern nur "Bearbeiten, Schaltflaeche" (Critique P1, WCAG 1.3.1/4.1.2).
 * Was der Knopf TUT, kommt als sr-only Zusatz ans Ende - so machen es
 * `pantry.js` und `contacts.js`.
 *
 * Der Beschluss war einmal gefasst und `subscriptions.js` hatte ihn nicht
 * mitbekommen. Ein Guard ueber die KLASSE beendet das; eine Notiz im Kommentar
 * der einen reparierten Datei haette es nicht getan. Geprueft werden beide
 * Schreibweisen, die es im Bestand gibt: das Template-Markup und der DOM-Weg.
 *
 * Dieselbe Regel deckt die zweite Haelfte desselben Befunds ab: der Inhalt eines
 * `<button>` ist Phrasing Content, also keine `<h1>`-`<h6>`, kein `<p>`, kein
 * `<div>`. Im Abo-Modul waren im selben Umbau alle `div` zu `span` geworden -
 * `<h3>` und `<p>` blieben stehen.
 */
test('a row body that wraps the whole row carries no aria-label and no block elements', () => {
  const ROW_BODY = 'list-row__main--interactive';
  const BLOCK_IN_BUTTON = /<(h[1-6]|p|div)[\s>]/;
  const pages = readdirSync(new URL('../public/pages/', import.meta.url)).filter((f) => f.endsWith('.js'));
  const offenders = [];
  let markupSeen = 0;
  let domSeen = 0;

  for (const file of pages) {
    const src = read(`../public/pages/${file}`).replace(/^\s*\/\/.*$/gm, '');

    // (a) Template-Markup: `<button ... class="... ROW_BODY ...">` bis zum
    // passenden `</button>`. Die Zaehlung der offenen `<button` haelt
    // verschachtelte Knoepfe auseinander - im Abo-Modul steht die Aktionszeile
    // direkt hinter dem Zeilenkoerper.
    for (const open of src.matchAll(/<button\b[^>]*>/g)) {
      if (!open[0].includes(ROW_BODY)) continue;
      markupSeen += 1;
      if (/\baria-label\s*=/.test(open[0])) offenders.push(`${file}: aria-label am Zeilenkoerper (Markup)`);

      let depth = 1;
      let cursor = open.index + open[0].length;
      const tags = /<button\b[^>]*>|<\/button>/g;
      tags.lastIndex = cursor;
      let tag;
      while (depth > 0 && (tag = tags.exec(src))) {
        depth += tag[0] === '</button>' ? -1 : 1;
        if (depth === 0) cursor = tag.index;
      }
      const inner = src.slice(open.index + open[0].length, cursor);
      const block = inner.match(BLOCK_IN_BUTTON);
      if (block) offenders.push(`${file}: <${block[1]}> im Zeilenkoerper (Markup) - Content-Model ist Phrasing Content`);
    }

    // (b) DOM-Weg: `x.className = '... ROW_BODY ...'`, danach dieselbe Variable
    // mit einem aria-label. Das Fenster endet an der naechsten Leerzeile mit
    // schliessender Klammer - weiter reicht keine Zeilenfabrik.
    for (const assign of src.matchAll(/(\w+)\.className\s*=\s*(['"`])([^'"`]*)\2/g)) {
      if (!assign[3].includes(ROW_BODY)) continue;
      domSeen += 1;
      const rest = src.slice(assign.index, assign.index + 3000);
      const label = new RegExp(`\\b${assign[1]}\\.(?:setAttribute\\(\\s*['"]aria-label|ariaLabel\\s*=)`);
      if (label.test(rest)) offenders.push(`${file}: aria-label am Zeilenkoerper (DOM)`);
    }
  }

  // Reichweiten-Nachweis: findet der Scanner keinen Zeilenkoerper, prueft er
  // nichts - und beide Schreibweisen muessen einzeln nachgewiesen sein, sonst
  // deckt die eine die Blindheit der anderen zu.
  assert.ok(markupSeen >= 1, `Kein Zeilenkoerper im Template-Markup gefunden (${ROW_BODY}) - der Scanner greift nicht mehr.`);
  assert.ok(domSeen >= 2, `Nur ${domSeen} Zeilenkoerper ueber den DOM-Weg gefunden - der Scanner greift nicht mehr.`);

  assert.deepEqual(
    offenders,
    [],
    'Ein Zeilenkoerper umschliesst den ganzen Zeileninhalt. Ein aria-label ersetzt ihn\n'
    + 'fuer Hilfsmittel vollstaendig, und Blockelemente stehen ausserhalb des\n'
    + `Content-Models eines <button>:\n${offenders.join('\n')}`,
  );
});

// --------------------------------------------------------------------------
// Kennzahlkarte (Block 2): EINE Bauart fuer den beschrifteten Zahlenblock.
//
// Der Befund, den dieser Guard fernhaelt: vier Familien fuer dieselbe Signatur
// (.metric-card, .health-metric-card, .housekeeping-metric, .dashboard-metric)
// hiessen viermal neu lernen, wo die Zahl steht. Wie beim Buttonform-Guard
// prueft er nicht Klassennamen, sondern die SIGNATUR im Stylesheet - eine
// Allowlist der vier Namen waere ab dem fuenften Nachbau blind gewesen
// (dieselbe Lehre wie bei Kueche und Budget: ein Guard ueber eine Namensliste
// deckt keine Regel ab, sondern N Dateien).
//
// Die Signatur eines Kennzahlkarten-Nachbaus, alle drei Merkmale im selben
// BEM-Block:
//   WERT   eine Regel mit font-size xl/2xl/3xl UND Gewicht semibold/bold
//          (oder einem <strong> im Selektor - die housekeeping-Bauart),
//   LABEL  eine Regel mit color: --color-text-secondary,
//   KARTE  die Block-Wurzel traegt eine eigene Kartenflaeche
//          (--color-surface oder --color-fill-well).
//
// Das dritte Merkmal zieht die Grenze zu den legitimen ANDEREN Formen des
// Zahl+Label-Paars: Dashboard-Widgets (die Flaeche gehoert dem geteilten
// .widget, nicht dem Block), Stat-Zeilen IN einer Karte
// (.health-overview__stat) und Rasterzellen (Kalender-Datum). Beim Bau dieses
// Guards fand die Signatur sofort zwei uebersehene Nachbauten
// (.health-adherence, .health-activity-stat) - beide sind migriert.
// --------------------------------------------------------------------------
test('wer einen beschrifteten Zahlenblock als Karte baut, nimmt .metric-card', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  // Ausnahmen mit KATEGORIE (Umkehrung einer Allowlist: geprueft werden ALLE
  // Blocks, benannt sind nur die begruendeten Ausnahmen, Neues faellt durch).
  const EXEMPT = new Map([
    ['cycle-preg', 'Ereigniskarte: die grosse Zeile ist eine Aussage ueber ein '
      + 'Ereignis („SSW 24"), kein Kennzahlensatz - Label und Wert stehen '
      + 'nicht als Paar, die Karte traegt Icon-Well und Terminzeilen'],
  ]);

  const decl = (body, prop) =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();
  const blockOf = (sel) => {
    const last = sel.split(/[\s>+~]+/).filter(Boolean).pop() || '';
    const cls = last.match(/\.([a-z][\w-]*)/)?.[1];
    return cls ? cls.split('__')[0].split('--')[0] : null;
  };

  const value = new Map(); // block -> fundstelle
  const label = new Set();
  const cardRoot = new Map();

  for (const name of files) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      for (const sel of selector.split(',').map((s) => s.trim())) {
        const block = blockOf(sel);
        if (!block || block === 'metric-card') continue;

        const fs = decl(body, 'font-size');
        const fw = decl(body, 'font-weight');
        const big = fs && /--text-(xl|2xl|3xl)/.test(fs);
        const heavy = (fw && /--font-weight-(semibold|bold)|\b[67]00\b/.test(fw))
          || /\bstrong\b/.test(sel);
        if (big && heavy && !value.has(block)) value.set(block, `${name}: ${sel}`);

        const col = decl(body, 'color');
        if (col && /--color-text-secondary/.test(col)) label.add(block);

        // Kartenflaeche an der Block-WURZEL: der Selektor endet auf die
        // Block-Klasse selbst (ggf. mit Modifier), nicht auf ein __Element.
        const rootLike = new RegExp(`\\.${block}(--[\\w-]+)?$`).test(sel);
        const bg = decl(body, 'background') ?? decl(body, 'background-color');
        if (rootLike && bg && /--color-(surface|fill-well)\b/.test(bg)) {
          if (!cardRoot.has(block)) cardRoot.set(block, `${name}: ${sel}`);
        }
      }
    }
  }

  const offenders = [];
  for (const [block, where] of value) {
    if (!label.has(block) || !cardRoot.has(block)) continue;
    if (EXEMPT.has(block)) continue;
    offenders.push(
      `.${block} (${where}; Flaeche: ${cardRoot.get(block)}) baut die Kennzahlkarte nach `
      + '- Zahl + Sekundaer-Label auf eigener Kartenflaeche ist .metric-card (panel.css)');
  }
  assert.deepEqual(offenders, []);

  // Der Scanner muss die Signatur der EINEN Karte selbst noch sehen, sonst ist
  // ein leerer Befund von einem blinden Scanner nicht zu unterscheiden.
  const panel = read('../public/styles/panel.css');
  assert.match(panel, /\.metric-card__value\s*\{[^}]*--text-xl/,
    'Die Wert-Signatur von .metric-card ist verschwunden - der Guard misst ins Leere.');
});

// --------------------------------------------------------------------------
// Leerzustand (Block 2): EIN Flaechen-Leerzustand, die geteilte .empty-state.
//
// Achtzehn modul-eigene Leerzustandsklassen neben der geteilten Grammatik
// waren achtzehn Gelegenheiten, ihn anders zu bauen (Karte mit Schatten,
// getoente Flaeche, horizontale Achse). Auch hier prueft der Guard die
// SIGNATUR, nicht die Namen.
//
// Die Signatur eines Flaechen-Leerzustands im Stylesheet:
//   text-align: center + Sekundaer-/Tertiaertext + spuerbarer Eigenraum
//   (padding-block ab --space-6).
//
// Ausschluesse ueber die BAUART, nicht ueber Namen:
//   - gestrichelte Kante: ein Drop-Ziel LAEDT EIN, es meldet kein Fehlen,
//   - position: absolute: ein schwebender Hinweis (Now-Linie) zentriert
//     nicht ueber einer Flaeche,
//   - Transienz-Rollenwort im Selektor (loading/status/skeleton): ein
//     Ladezustand wird gleich von Inhalt ersetzt; sein Muster ist der
//     Skeleton, nicht der Leerzustand (Rollenwort-Ansatz wie beim
//     Glass-Guard in test-budget-ui.js).
// --------------------------------------------------------------------------
test('ein Flaechen-Leerzustand ist die geteilte .empty-state', () => {
  const files = readdirSync(new URL('../public/styles/', import.meta.url))
    .filter((name) => name.endsWith('.css'));

  const EXEMPT = new Map([
    ['.document-viewer__pdf-page-error', 'Viewer-Zustand: beschreibt EINE Seite '
      + 'des angezeigten Mediums im Overlay, nicht die Flaeche der App'],
    ['.document-viewer__unsupported', 'Viewer-Zustand: das Medienformat hat '
      + 'keine Vorschau - Aussage ueber das Medium, nicht ueber fehlende Daten'],
  ]);
  const TRANSIENT = /loading|status|skeleton/;

  const decl = (body, prop) =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim();
  // Erster Wert eines padding-Shorthands ist der Block-Anteil.
  const paddingBlock = (body) => {
    const raw = decl(body, 'padding-block') ?? decl(body, 'padding-top')
      ?? decl(body, 'padding');
    const step = raw?.match(/--space-(\d+)/)?.[1];
    return step ? Number(step) : 0;
  };

  const offenders = [];
  let seen = 0;
  for (const name of files) {
    for (const { selector, body } of eachRule(read(`../public/styles/${name}`))) {
      if (!/text-align:\s*center/.test(body)) continue;
      const col = decl(body, 'color');
      if (!col || !/--color-text-(secondary|tertiary)/.test(col)) continue;
      if (paddingBlock(body) < 6) continue;
      seen += 1;
      if (/\.empty-state/.test(selector)) continue;
      if (/border[^;]*dashed/.test(body)) continue;
      if (/position:\s*absolute/.test(decl(body, 'position') ?? '')) continue;
      if (TRANSIENT.test(selector)) continue;
      const key = selector.split(',')[0].trim();
      if (EXEMPT.has(key)) continue;
      offenders.push(
        `${name}: ${selector} baut den Flaechen-Leerzustand nach `
        + '- zentrierter Sekundaertext mit Eigenraum ist .empty-state (layout.css)');
    }
  }
  assert.deepEqual(offenders, []);

  // Reichweiten-Nachweis NACH der Messung: die Signatur muss die geteilte
  // Grammatik selbst und mindestens einen kategorisierten Nachbarn gesehen
  // haben, sonst misst der Scanner nichts mehr.
  assert.ok(seen >= 2,
    `Nur ${seen} Treffer der Leerzustands-Signatur im ganzen Stylesheet - der Scanner greift nicht mehr.`);
});

// --------------------------------------------------------------------------
// DAS MARKENSIEGEL: WER ES BAUT, SAGT WOZU (Block 2, Schritt 3)
//
// Die Herkunfts-Regel des Briefs hat zwei Haelften, und beide sind hier
// pruefbar:
//
//   MISCHSTELLE - eine Liste, deren Zeilen aus verschiedenen Modulen stammen
//   (Suche, „Heute wichtig", Widget-Koepfe, Mehr-Sheet, Erinnerungen). Dort
//   traegt JEDES Objekt sein Siegel, und weil das Objekt aus einem FREMDEN
//   Modul kommt, muss die Bau-Stelle die Herkunft BENENNEN - inline im
//   Quelltext oder ueber eine eigene Klasse im Stylesheet.
//
//   KOPF - der Absender des eigenen Moduls, genau einmal. Er benennt nichts:
//   er ERBT den Ton des Raumes, in dem er steht. Genau daran ist er zu
//   erkennen, und genau deshalb darf ihn nur die Shell bauen.
//
// DER VERSTOSS, DEN DAS FINDET, ist ein Siegel ohne Rolle: eines, das weder
// eine fremde Herkunft benennt noch die Kopfrolle traegt - also Dekor mitten
// in den Listen des eigenen Moduls. Das war der Bestand vor Block 2
// (Gesundheit 14 Vorkommen, Dokumente null), und es ist das Anti-Ziel
// „keine Siegel-Inflation".
//
// UEBER DIE BAUART, NICHT UEBER EINE DATEILISTE: gesucht wird jede Stelle, die
// die Klasse zusammensetzt - gleich ob per `className`, per Template-Literal
// oder per `classList`. Ein neues Modul mit einem Siegel steht damit
// automatisch mit im Ergebnis.
// --------------------------------------------------------------------------
test('wer ein Markensiegel baut, benennt eine Herkunft oder ist der Kopf', () => {
  const jsFiles = walkJsFiles('../public/');
  const styleDir = new URL('../public/styles/', import.meta.url);

  // Welche KLASSEN bekommen im Stylesheet eine Herkunft zugewiesen? Das ist der
  // zweite legitime Weg: die Kachel leitet ihren Ton an das Siegel weiter
  // (`.more-item__icon-well`, `.today-cockpit-card__icon`, die Kuechen-Leiste).
  const classesWithOrigin = new Set();
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      if (!/--seal-accent\s*:/.test(body)) continue;
      for (const cls of selector.match(/\.[A-Za-z0-9_-]+/g) ?? []) classesWithOrigin.add(cls.slice(1));
    }
  }

  const offenders = [];
  let heads = 0;
  let mixers = 0;
  let sites = 0;

  // Die Herkunft steht selten in DERSELBEN Zeile wie die Klasse: dazwischen
  // liegen `aria-hidden`, das Icon und im Dashboard die vorbereitete
  // style-Zeichenkette. Ein Fenster um die Bau-Stelle ist die ehrliche
  // Naeherung - eng genug, dass es kein fremdes Siegel einsammelt.
  const WINDOW = 8;

  for (const rel of jsFiles) {
    const src = read(rel);
    if (!src.includes('module-seal')) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // Nur BAU-Stellen, keine Kommentare und keine Selektoren: gesucht ist die
      // Zeile, die die Klasse zusammensetzt.
      if (!/module-seal/.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/className|class=|classList|classNames/.test(line)) return;
      sites += 1;

      const isHead = line.includes('module-seal--head');
      const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
      // Die MITGEFUEHRTEN Klassen der Bau-Stelle, aus der Zeichenkette selbst.
      // Die Siegel-Klassen sind ausgenommen: `.module-seal` setzt in seiner
      // Basisregel selbst ein `--seal-accent` (den geerbten Modulton als
      // Voreinstellung), und wer die mitzaehlt, erklaert jede Bau-Stelle fuer
      // benannt - der Guard waere gruen und blind. Was zaehlt, ist die Klasse
      // des TRAEGERS, die den fremden Ton weiterreicht.
      const ownClasses = (line.match(/['"`][^'"`]*module-seal[^'"`]*['"`]/g) ?? [])
        .flatMap((quoted) => quoted.slice(1, -1).split(/\s+/))
        .filter((cls) => cls && !cls.startsWith('module-seal'));
      const namedInCss = ownClasses.some((cls) => classesWithOrigin.has(cls));
      const namedInline = /--seal-accent|--item-module-accent/.test(near);

      if (isHead) {
        heads += 1;
        // DIE KOPFROLLE GEHOERT DER SHELL. Sie erbt den Ton ihres Raumes, also
        // kann kein Modul sie „richtig" selbst setzen - und genau eines pro Kopf
        // haelt nur, wer das Siegel selbst anlegt. `public/utils/` ist die
        // Shell-Ebene (der kollabierende Kopf, die Gruppenleiste); eine Seite
        // oder Komponente, die hier auftaucht, hat sich einen zweiten Absender
        // gebaut.
        if (!rel.startsWith('../public/utils/')) {
          offenders.push(`${rel}:${i + 1} baut die Kopfrolle des Siegels - die gehoert der Shell (public/utils/)`);
        }
        return;
      }

      if (!namedInline && !namedInCss) {
        offenders.push(
          `${rel}:${i + 1} baut ein Siegel ohne Herkunft - an einer Mischstelle benennt `
          + 'jedes Siegel sein Modul (--seal-accent inline oder ueber die eigene Klasse im Stylesheet); '
          + 'im eigenen Modul gibt es nur den Absender im Kopf',
        );
        return;
      }
      mixers += 1;
    });
  }

  assert.deepEqual(offenders, []);

  // Reichweiten-Nachweis NACH der Messung: der Scanner muss BEIDE Rollen
  // gesehen haben. Eine Zusicherung ueber eine leere Liste ist keine - und ein
  // Muster, das nur noch die Kopfrolle findet, haette die Haelfte der Regel
  // still aufgegeben.
  assert.ok(heads >= 2,
    `Nur ${heads} Kopf-Bau-Stellen gefunden (erwartet: kollabierender Kopf + Gruppenleiste).`);
  assert.ok(mixers >= 4,
    `Nur ${mixers} Mischstellen-Siegel gefunden - die Signatur greift nicht mehr.`);
  assert.ok(sites >= heads + mixers,
    `Zaehlung inkonsistent: ${sites} Bau-Stellen, aber ${heads} + ${mixers} Rollen.`);
});

// --------------------------------------------------------------------------
// EIN TOAST-CONTAINER HAT GENAU EINEN NAMENSGEBER
//
// ANLASS, und er ist gemessen: `reminders.js` suchte `#toast-container`. Den gab
// es bis v0.52.15; dann teilte die Shell ihn in eine hoefliche und eine
// bestimmte Live-Region und benannte beide um. Der Sucher blieb stehen, fand
// nichts und brach still ab - fast drei Monate lang erschien keine einzige
// In-App-Erinnerung, waehrend im Quelltext alles richtig dastand.
//
// Die Antwort ist nicht „die richtige ID eintragen", sondern EIN Ort fuer den
// Namen: wer den Container anlegt und wer ihn sucht, lesen dieselbe Konstante
// (public/utils/toast-surface.js). Dieser Guard haelt genau das - ein zweiter
// Schreiber des Namens ist der Rueckweg in denselben Bruch.
//
// Die KLASSE `.toast-container` bleibt frei: sie ist Styling und Zaehlung
// ("hoechstens drei Toasts"), kein Nachschlagen einer bestimmten Region.
// --------------------------------------------------------------------------
test('ein Toast-Container hat genau einen Namensgeber', () => {
  const OWNER = '../public/utils/toast-surface.js';
  // Zwei Muster, weil der Bruch zwei Gestalten hat:
  //   (1) der zweite NAME - eine Region-ID, ausgeschrieben ausserhalb des
  //       Besitzers. Sie kann von seiner umbenannt weglaufen.
  //   (2) das eigene NACHSCHLAGEN - genau die Form des Bruchs von damals
  //       (`getElementById('toast-container')`). Sein Name war mit der Klasse
  //       identisch, ueber die Zeichenkette allein ist er nicht zu erkennen;
  //       erkennbar ist er an der Suche.
  const idLiteral = /['"`]toast-container-[a-z]+['"`]/;
  const ownLookup = /(?:getElementById|querySelector(?:All)?)\(\s*['"`]#?toast-container/;

  const offenders = [];
  let ownerHits = 0;
  for (const rel of walkJsFiles('../public/')) {
    const src = read(rel);
    if (rel === OWNER) { ownerHits = (src.match(new RegExp(idLiteral, 'g')) ?? []).length; continue; }
    src.split('\n').forEach((line, i) => {
      if (idLiteral.test(line)) offenders.push(`${rel}:${i + 1} schreibt den Namen einer Toast-Region selbst - er steht in ${OWNER}`);
      else if (ownLookup.test(line)) offenders.push(`${rel}:${i + 1} sucht seine Toast-Region selbst - dafuer gibt es toastSurface() in ${OWNER}`);
    });
  }

  assert.deepEqual(offenders, []);
  // Reichweiten-Nachweis: der Besitzer muss die Namen wirklich fuehren, sonst
  // prueft der Guard die Abwesenheit eines Musters, das es nirgends mehr gibt.
  assert.ok(ownerHits >= 2,
    `Nur ${ownerHits} Toast-Region-Namen in ${OWNER} - beide Dringlichkeiten gehoeren dorthin.`);
});

// --------------------------------------------------------------------------
// DIE HERKUENFTE DER ERINNERUNGEN SIND DIE DES SERVERS
//
// Der Erinnerungs-Toast weist seit Block 2 aus, WORAUS eine Meldung stammt
// (Herkunfts-Regel: eine Benachrichtigung ist eine Mischstelle). Die Zuordnung
// `entity_type` → Modul steht im Client; geschrieben werden die Werte aber im
// Server, und dort stehen sie an EINER Stelle: `VALID_ENTITY_TYPES`.
//
// Laufen beide auseinander, verschwindet nichts und nichts bricht - die neue
// Herkunft faellt still auf die Glocke und den Erinnerungs-Ton zurueck und
// sieht aus wie alle anderen. Genau die Sorte Drift, die niemand meldet.
// --------------------------------------------------------------------------
test('die Herkuenfte des Erinnerungs-Toasts sind die entity_type des Servers', () => {
  const server = read('../server/routes/reminders.js');
  const listed = server.match(/const VALID_ENTITY_TYPES\s*=\s*\[([^\]]*)\]/);
  assert.ok(listed, 'VALID_ENTITY_TYPES steht nicht mehr in server/routes/reminders.js.');
  const serverTypes = [...listed[1].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]).sort();

  const client = read('../public/reminders.js');
  const map = client.match(/const REMINDER_ORIGINS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(map, 'REMINDER_ORIGINS steht nicht mehr in public/reminders.js.');
  const clientTypes = [...map[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]).sort();

  // Dieselbe Zuordnung noch einmal serverseitig: der Push-Titel nennt die
  // Herkunft, und der Server kann die Karte des Clients nicht lesen (Schicht-
  // grenze). Zwei Karten, EINE Liste von Herkuenften - laufen sie auseinander,
  // zeigt der Toast ein Siegel und die Systembenachrichtigung „Yuvomi".
  const notifications = read('../server/services/notifications.js');
  const titleMap = notifications.match(/const REMINDER_ORIGINS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(titleMap, 'REMINDER_ORIGINS steht nicht mehr in server/services/notifications.js.');
  const titleTypes = [...titleMap[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]).sort();

  assert.ok(serverTypes.length >= 3, `Nur ${serverTypes.length} entity_type im Server gefunden - das Muster greift nicht mehr.`);
  assert.deepEqual(clientTypes, serverTypes,
    'Der Toast kennt andere Herkuenfte als der Server schreibt - die unbekannten fallen still auf die Glocke zurueck.');
  assert.deepEqual(titleTypes, serverTypes,
    'Der Push-Titel kennt andere Herkuenfte als der Server schreibt - die unbekannten heissen wieder „Yuvomi".');

  // UND JEDE HERKUNFT TRAEGT AUCH IHR ZIEL (Critique 2026-08-10). Titel und
  // Ziel stehen bewusst in EINEM Eintrag, damit die zweite Antwort nicht von
  // der ersten wegdriften kann: vorher nannte der Titel das Modul und die URL
  // stand fest auf `/reminders`, einer Route, die es nie gab.
  const withoutTarget = [...titleMap[1].matchAll(/^\s{2}([a-z_]+):\s*\{([^}]*)\}/gm)]
    .filter(([, , body]) => !/\burl:\s*'/.test(body))
    .map(([, type]) => type);
  assert.deepEqual(withoutTarget, [],
    'Herkunft ohne Ziel - der Titel nennt das Modul und der Tipp landet woanders.');
});

// --------------------------------------------------------------------------
// EINE SCHWELLE, ZWEI DATEIEN - UND EINE ZAHL
//
// Zwei Module kuendigen eine Frist an, und in beiden steht die Zahl zweimal:
// einmal im Client, wo sie die Zeile faerbt ("laeuft bald ab"), und einmal im
// Server, wo sie den Erinnerungstermin bestimmt. Sie MUESSEN gleich sein - der
// Nutzer sieht sonst eine gelbe Zeile an einem Tag und bekommt die Meldung an
// einem anderen, und keiner der beiden Tage ist erklaerbar.
//
// Geteilt werden koennen sie nicht: public/utils/pantry-status.js und
// public/utils/inventory-warranty.js importieren `/utils/date.js` als
// Browser-Wurzelpfad und laufen in Node nicht. Beide Kommentarkoepfe behaupten
// die Gleichheit ("identisch zum server-seitigen Erinnerungs-Vorlauf") - bis zu
// diesem Guard hat sie niemand geprueft.
// --------------------------------------------------------------------------
test('der Vorlauf einer Fristmeldung ist die Schwelle, die die Zeile faerbt', () => {
  const PAIRS = [
    {
      what: 'Vorrat: Mindesthaltbarkeit',
      client: ['../public/utils/pantry-status.js', /EXPIRY_SOON_DAYS\s*=\s*(\d+)/],
      server: ['../server/services/pantry-reminders.js', /EXPIRY_REMINDER_OFFSET_DAYS\s*=\s*(\d+)/],
    },
    {
      what: 'Inventar: Garantieende',
      client: ['../public/utils/inventory-warranty.js', /WARRANTY_ALERT_DAYS\s*=\s*(\d+)/],
      server: ['../server/routes/inventory/items.js', /WARRANTY_REMINDER_OFFSET_DAYS\s*=\s*(\d+)/],
    },
  ];

  for (const pair of PAIRS) {
    const read2 = ([file, re], side) => {
      const match = read(file).match(re);
      // LAUT SCHEITERN, NICHT STILL DURCHWINKEN: eine umbenannte Konstante
      // wuerde den Vergleich sonst auf "beide undefined" reduzieren, und der
      // Guard waere gruen und blind.
      assert.ok(match, `${pair.what}: die ${side}-Konstante steht nicht mehr in ${file.replace(/^\.\.\//, '')}.`);
      return Number(match[1]);
    };
    const client = read2(pair.client, 'Client');
    const server = read2(pair.server, 'Server');
    assert.equal(server, client,
      `${pair.what}: der Server meldet ${server} Tage vorher, die Liste faerbt ab ${client} Tagen - `
      + 'der Nutzer bekommt die Nachricht an einem Tag, an dem nichts markiert ist.');
  }
});

test('jedes Push-Ziel zeigt auf eine Route, die es gibt', () => {
  // DER BEFUND, DEN DIESER GUARD SCHLIESST (Critique 2026-08-10): `url` stand
  // im Reminder-Payload fest auf `/reminders`, und diese Route hat es nie
  // gegeben. Der Router fiel still auf `/` zurück - ein Fallback, der wie ein
  // Ziel aussah, und niemand bemerkte es, weil beide Enden für sich stimmten:
  // der Server schrieb einen Pfad, der Client kannte ihn nicht, und keiner der
  // beiden Tests las den anderen.
  //
  // Push ist der zeitkritischste Pfad der App. Ein Ziel, das ins Leere zeigt,
  // entwertet die Benachrichtigung und lehrt, sie zu ignorieren.
  const routerSrc = read('../public/router.js');
  const known = new Set([...routerSrc.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]));
  // Sub-Tab-Sektionen (Gesundheit, Schedule S-10) registrieren ihre Routen
  // ueber ein `.map(path => ({ path, ... }))` aus einem importierten Array,
  // nicht als literales `path: '...'` in router.js selbst - das obige Regex
  // sieht sie deshalb nicht. Reiner Text-Read statt eines echten Imports:
  // beide Util-Dateien importieren selbst wieder `/i18n.js` (ein
  // Browser-Pfadalias), das unter Node nicht aufloest.
  for (const file of ['../public/utils/health-tabs.js', '../public/utils/schedule-tabs.js']) {
    const src = read(file);
    const arrayBody = src.slice(src.indexOf('Object.freeze(['), src.indexOf('])', src.indexOf('Object.freeze([')));
    for (const match of arrayBody.matchAll(/'([^']+)'/g)) known.add(match[1]);
  }
  // Die Settings-Blätter kommen aus der Registry, nicht aus einem `path:`.
  const settingsLeaf = /^\/settings(\/|$)/;
  assert.ok(known.size >= 15, `nur ${known.size} Routen aus router.js gelesen - Regex tot?`);

  const offenders = [];
  for (const file of ['../server/services/notifications.js', '../public/sw.js']) {
    const src = read(file);
    for (const match of src.matchAll(/\burl:\s*'(\/[^']*)'/g)) {
      const url = match[1].split(/[?#]/)[0];
      if (known.has(url) || settingsLeaf.test(url)) continue;
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${file.replace(/^\.\.\//, '')}:${line} → ${url}`);
    }
  }

  assert.deepEqual(offenders, [],
    'Push-Ziel zeigt auf einen Pfad, den ROUTES nicht kennt - der Router fällt dort '
    + 'still auf das Dashboard zurück');
});

test('das Überlappungszeichen kommt aus einer Hand', () => {
  // DIE REGEL (Block-2-Brief, DESIGN.md „Das Überlappungszeichen"): es erscheint
  // nur, wo ohnehin ein Siegel steht, das Objekt eine Person trägt UND es mehr
  // als einen möglichen Beteiligten gibt — im Solo-Haushalt entfällt es still.
  //
  // Alle drei Bedingungen stehen in `utils/seal-pair.js`. Wer das Markup
  // anderswo von Hand baut, hat sie nicht: er hat einen Avatar neben einem
  // Siegel, und das ist die Siegel-Inflation, die der Brief als Anti-Ziel
  // führt. Dieselbe Bauart wie die Signatur-Guards aus Block 2 — die Regel
  // hängt am Bauteil, nicht an einer Liste von Aufrufern.
  const offenders = [];
  for (const rel of walkFrontendFiles('../public/')) {
    if (rel.endsWith('utils/seal-pair.js')) continue;
    const src = read(rel);
    for (const match of src.matchAll(/seal-pair__who/g)) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${rel.replace(/^\.\.\//, '')}:${line}`);
    }
  }

  assert.deepEqual(offenders, [],
    'Überlappungszeichen von Hand gebaut — `whoMark()`/`withWho()` aus utils/seal-pair.js '
    + 'nehmen, sonst fehlen die Bedingungen (Person vorhanden, Haushalt > 1)');

  // Und die Gegenrichtung: der Baustein muss die Solo-Bedingung tatsächlich
  // führen. Ohne sie wäre der Guard oben eine Zusicherung über einen Ort, an
  // dem nichts geprüft wird.
  const pair = read('../public/utils/seal-pair.js');
  assert.match(pair, /isSoloHousehold\(\)/,
    'seal-pair.js prüft den Solo-Haushalt nicht mehr — das Zeichen erschiene dort, wo es '
    + 'laut Brief still entfallen soll');
});

// ---------------------------------------------------------------------------
// DIE EINE-STIMME-REGEL (DESIGN.md, 2026-08-10)
//
// Die App hat genau eine Akzentfarbe. Die SHELL traegt sie immer; der Modulton
// traegt, was sagt, wo man ist - Siegel, modul-eigene Leisten und Segmente,
// Chips, Zeilen-Hover, Widgets.
//
// DER GUARD LEITET DAS CHROME AUS SELEKTOR-FORMEN AB, NICHT AUS EINER
// DATEILISTE. Eine Liste von Dateien deckt keine Regel ab, sondern N Dateien
// (die Lehre aus Runde 6), und sie waere beim achtzehnten Modul wieder
// unvollstaendig. Gesucht sind stattdessen zwei Bauarten, die beide
// unabhaengig vom Modul gelten:
//
//   1. SHELL-WURZELN - Elemente, die es genau einmal gibt und die auf jeder
//      Route dieselben sind (Leisten, FAB, Sheets, Overlays, Backdrop).
//   2. GETEILTE BEDIENELEMENTE - Bauteile, die in jedem Modul dasselbe tun
//      (Buttonvarianten, Umschalter, Checkbox, Fokusring).
//
// Die Ausnahme ist eine KATEGORIE, keine Selektorliste: ein Element, das die
// Herkunft eines fremden Objekts benennt, traegt dessen Ton auch in der Shell -
// das Markensiegel (--seal-accent) und das Modul-Zeichen der Sidebar-Legende
// (--item-module-accent). Beide sind namentlich Herkunftszeichen, keine
// Zustaende.
// ---------------------------------------------------------------------------
const SHELL_ROOTS = [
  '.nav-bottom', '.nav-sidebar', '.nav-item', '.page-fab', '.fab-layer',
  '.more-sheet', '.more-item', '.more-action', '.more-backdrop',
  '.search-overlay', '.modal-overlay', '.app-shell', '.lg-blob', '.lg-backdrop',
  '.changelog-release',
];
const SHARED_CONTROLS = ['.btn--', '.toggle', '.form-check', '.page-search', '.input:focus', '.form-input:focus'];
// Ein Modulton kann auch unter seinem EIGENEN Token stehen (`--module-budget`)
// statt unter dem generischen `--module-accent` - dieselbe Farbe, anderer Name.
const MODULE_TONE = /var\(\s*--(?:active-)?module-(?!accent\b)[a-z-]+|var\(\s*--(?:active-)?module-accent|var\(\s*--_?family-/;
// Herkunftszeichen: sie benennen ein fremdes Modul und duerfen dessen Ton
// tragen, auch wenn sie in der Shell haengen.
const ORIGIN_MARKS = ['--seal-accent', '--item-module-accent'];

test('die Shell traegt die Stimme, nicht den Modulton', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!MODULE_TONE.test(body)) continue;
      if (ORIGIN_MARKS.some((mark) => body.includes(mark))) continue;
      // `:root`/`html` sind die TOKEN-Ebene, keine Elemente: dort werden die
      // Modultoene definiert, und eine Definition ist keine Verwendung.
      if (/^(?::root|html)\b/.test(selector.trim())) continue;

      const isShell = SHELL_ROOTS.some((root) => selector.includes(root));
      const isSharedControl = SHARED_CONTROLS.some((ctrl) => selector.includes(ctrl))
        || /--focus-ring-color/.test(body);
      if (!isShell && !isSharedControl) continue;

      // AN DER SHELL IST DER VERSTOSS DAS MITWANDERN, nicht die Farbe. Ein
      // FESTER Modulton dort ist eine Palettenwahl - die Backdrop-Blobs 2-4
      // tragen vier feste Toene und sehen in jedem Modul gleich aus, was die
      // Regel gerade verlangt. Verboten sind die routen- bzw.
      // seitenabhaengigen Namen: --active-module-accent (Router, je Route) und
      // --module-accent (Modul-Root, je Seite). An einem GETEILTEN
      // BEDIENELEMENT ist dagegen jeder Modulton falsch, auch ein fester:
      // derselbe Knopf traegt sonst in jedem Modul eine andere Farbe.
      const followsRoute = /var\(\s*--(?:active-)?module-accent\b/.test(body);
      if (isShell && !isSharedControl && !followsRoute) continue;

      const why = isShell ? 'Shell-Wurzel' : 'geteiltes Bedienelement';
      offenders.push(`${file}${at.length ? ` [${at.join(' ')}]` : ''}: ${selector} (${why})`);
    }
  }

  assert.deepEqual(offenders, [],
    'Die Shell und geteilte Bedienelemente tragen --color-accent, nicht den Modulton '
    + '(Eine-Stimme-Regel, DESIGN.md). Der Modulton gehoert in den INHALT: Siegel, '
    + 'modul-eigene Leisten und Segmente, Chips, Zeilen-Hover, Widgets. Wer eine Herkunft '
    + 'benennt statt einen Zustand, nimmt --seal-accent bzw. --item-module-accent.\n'
    + offenders.join('\n'));
});

test('die Sidebar zeigt die Modultoene als Legende', () => {
  // Die Kehrseite der Regel oben: wenn die Stimme das Chrome traegt, muss der
  // Modulton EINEN sichtbaren Ort behalten, sonst verschwindet die
  // Modul-Identitaet ganz. Ohne diesen Guard waere die Legende der erste
  // Kandidat fuer ein stilles Aufraeumen - sie ist die Stelle, an der
  // --item-module-accent Flaeche traegt.
  const layout = read('../public/styles/layout.css');
  // Der Selektor wird GANZ verglichen, nicht per includes(): `.nav-item__icon`
  // ist ein Praefix von `.nav-item__icon-well`, und der erste Treffer war
  // deshalb die Well-Regel (26x26, keine Farbe) statt der gesuchten.
  const iconRule = [...eachRule(layout)].find(({ selector }) =>
    selector.trim() === '.nav-sidebar .nav-item__icon');
  assert.ok(iconRule, '.nav-sidebar .nav-item__icon fehlt - die Legende hat keinen Traeger mehr');
  assert.match(iconRule.body, /color:\s*var\(--item-module-accent/,
    'das Sidebar-Zeichen traegt den Ton SEINES Moduls (Legende, DESIGN.md „Colors")');
  // Und der aktive Eintrag gewinnt die Stimme zurueck: eine Zeile, die als
  // Ganzes violett ist, deren Icon aber allein seine Familienfarbe behielte,
  // liest sich als „nicht mitgemeint".
  const activeIcon = [...eachRule(layout)].find(({ selector }) =>
    selector.trim() === '.nav-sidebar .nav-item[aria-current="page"] .nav-item__icon');
  assert.ok(activeIcon, 'dem aktiven Sidebar-Eintrag fehlt die Icon-Regel');
  assert.match(activeIcon.body, /color:\s*var\(--color-accent\)/);
});

// ---------------------------------------------------------------------------
// DIE TAGESMARKE (Etappe E, 2026-08-19)
//
// „Heute" ist keine Modul-Aussage. Wo eine TAGESZELLE den aktuellen Tag
// markiert, traegt sie die Stimme - genau wie der Kalender es seit jeher tut
// (`.month-day--today .month-day__number`, `.week-view__day-num--today`) und
// der Datepicker (`.ydp-cal__day.is-today`).
//
// DER GUARD LIEST DIE BAUART, NICHT DEN MODULNAMEN. Gesucht ist eine Regel, die
// (a) den heutigen Tag markiert (`--today` bzw. `.is-today`) und (b) an einem
// Element haengt, dessen Klasse eine TAGESZELLE benennt - also einen exakten
// Namensabschnitt `day` fuehrt. Der Abschnittsvergleich ist der Kern: ein
// `includes('day')` faengt `birthday` mit, und die Geburtstagszeile ist der
// dokumentierte Gegenfall.
//
// ZWEI KATEGORIEN BLEIBEN AUSSEN VOR, und beide ohne Ausnahmeliste:
//
//   1. FRISTMELDUNGEN („heute faellig") - `.due-date--today`,
//      `.housekeeping-task--today`. Sie sagen nicht „das ist der heutige Tag",
//      sondern „das ist jetzt dran", und tragen deshalb die Warnfarbe. Kein
//      Namensabschnitt `day`, also nie im Trefferraum.
//   2. DIE GEBURTSTAGSZEILE - `.birthday-item--today`, `.birthday-chip--today`.
//      Dort ist der Modulton ausdruecklich richtig und im Quelltext begruendet
//      („die Zeile beantwortet wann, und der eine Tag, an dem die Antwort HEUTE
//      lautet, ist der Anlass des ganzen Moduls"), samt gemessenem Kontrast.
//      Sie sind Zeile und Chip, keine Tageszelle - die Bauart schliesst sie
//      aus, nicht eine Liste, die beim naechsten Modul wieder unvollstaendig
//      waere.
//
// Gegenprobe gefahren: mit `--module-accent` in `.cycle-cal__day.is-today`
// (dem Stand vor dieser Etappe) wird der Guard rot und benennt die Fundstelle.
// ---------------------------------------------------------------------------
const TODAY_MARKER = /(?:--today\b|\.is-today\b)/;

/** Fuehrt der Selektor irgendwo einen EXAKTEN Namensabschnitt `day`? */
function namesADayCell(selector) {
  return selector
    .split(/[\s>+~,()]+/)
    .filter((token) => token.startsWith('.'))
    .some((token) => token
      .replace(/^\./, '')
      .split(/__|--|-|\./)
      .includes('day'));
}

test('eine Tagesmarke traegt die Stimme, nicht den Modulton', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      if (!TODAY_MARKER.test(selector)) continue;
      if (!namesADayCell(selector)) continue;
      if (!MODULE_TONE.test(body)) continue;
      offenders.push(`${file}${at.length ? ` [${at.join(' ')}]` : ''}: ${selector}`);
    }
  }

  assert.deepEqual(offenders, [],
    'Die Marke des heutigen Tages traegt --color-accent, nicht den Modulton. '
    + '„Heute" ist dieselbe Aussage in jedem Modul, und der Kalender beantwortet sie '
    + 'seit jeher mit der Stimme (.month-day--today, .week-view__day-num--today, '
    + '.ydp-cal__day.is-today). Wer eine Fristmeldung meint („heute faellig"), baut '
    + 'keine Tageszelle - und wer den Modulton wirklich braucht, begruendet ihn im '
    + 'Quelltext wie die Geburtstagszeile.\n'
    + offenders.join('\n'));
});

test('ein Modul fuehrt EIN Zeichen, und die Zuordnung steht an einer Stelle', () => {
  // DER FEHLER WAR NICHT DIE STECKNADEL, SONDERN DIE DRITTE TABELLE.
  //
  // Welches Zeichen ein Modul fuehrt, stand bis 2026-08-17 in `navItems()`
  // (Router), in `widgetIcon()` (Dashboard) und noch einmal in der
  // Kennzahl-Kachelreihe. Drei Tabellen fuer eine Zuordnung laufen auseinander,
  // und das hatten sie: Notizen war in der Leiste ein Zettel und im Widget-Kopf
  // eine Stecknadel, Haushaltshilfe hier ein Pinsel und dort Funkeln. Ein Guard
  // auf diese beiden Namen haette die Symptome festgehalten; gesucht ist die
  // Bauart.
  const navIcons = read('../public/nav-icons.js');
  assert.match(navIcons, /export const MODULE_ICON = \{/, 'die eine Zuordnung Modul → Zeichen fehlt');
  // Die Schluessel aus der Quelle, nicht aus einer Abschrift im Test - sonst
  // haette der Guard genau die Dublette, die er verbietet.
  const moduleIconBlock = navIcons.slice(navIcons.indexOf('export const MODULE_ICON = {'));
  const MODULE_ICON_KEYS = Object.fromEntries(
    [...moduleIconBlock.slice(0, moduleIconBlock.indexOf('\n};')).matchAll(/^\s+'?([\w-]+)'?:\s+'/gm)]
      .map((m) => [m[1], true]),
  );
  assert.ok(Object.keys(MODULE_ICON_KEYS).length >= 20,
    `Nur ${Object.keys(MODULE_ICON_KEYS).length} Eintraege in MODULE_ICON gelesen - das Muster greift nicht mehr.`);

  // (a) Kein Siegel baut sich sein Zeichen selbst aus Lucide: `module-seal` und
  //     `data-lucide` duerfen nicht in derselben Bau-Stelle stehen. Das ist der
  //     Weg, auf dem die zweite Hand zurueckkaeme - sichtbar als anderer
  //     Glyph fuer dasselbe Modul.
  const WINDOW = 3;
  const offenders = [];
  let sealSites = 0;
  for (const rel of walkJsFiles('../public/')) {
    const src = read(rel);
    if (!src.includes('module-seal')) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/module-seal/.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/className|class=|classList/.test(line)) return;
      sealSites += 1;
      const near = lines.slice(i, i + WINDOW + 1).join('\n');
      if (/data-lucide|dataset\.lucide/.test(near)) {
        offenders.push(`${rel.replace(/^\.\.\//, '')}:${i + 1} baut ein Siegel mit einem rohen Lucide-Zeichen`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'Ein Siegel holt sein Zeichen ueber moduleIconEl/moduleIconHTML (nav-icons.js) - '
    + 'so bekommt dasselbe Modul ueberall denselben Glyph in derselben Hand.\n'
    + offenders.join('\n'));
  // Reichweiten-Nachweis NACH der Messung (die leere Liste ist sonst keine
  // Zusicherung): der Scanner muss die Bau-Stellen ueberhaupt gesehen haben.
  assert.ok(sealSites >= 6, `Nur ${sealSites} Siegel-Bau-Stellen gefunden - die Signatur greift nicht mehr.`);

  // (b) Und keine der Abschriften kommt zurueck. Es waren FUENF: navItems()
  //     (Router), widgetIcon() und jede widgetHeader()-Aufrufstelle
  //     (Dashboard), BUILT_IN_MODULES und KITCHEN_CHILD_ICONS
  //     (settings/module-order.js). Jede einzelne ist hier benannt, weil jede
  //     einzeln zurueckkommen kann.
  const dashboard = read('../public/pages/dashboard.js');
  // Core-Widgets: eine Quelle (MODULE_ICON). Extension-Widgets: Icon aus dem
  // Manifest (capabilities.widgets[].icon) - keine zweite Kern-Tabelle.
  assert.match(dashboard, /function widgetIcon\(id\)\s*\{[\s\S]*?getExtensionWidgetMeta\(id\)[\s\S]*?MODULE_ICON\[id\]/,
    'widgetIcon leitet Core-Widgets aus MODULE_ICON ab und Extension-Widgets aus dem Manifest');
  assert.doesNotMatch(dashboard, /const map = \{ tasks:/,
    'die zweite Modul→Zeichen-Tabelle ist wieder da');
  // Die Widget-Koepfe bekommen ihre WIDGET-ID, nicht einen Icon-Namen - sonst
  // steht die Zuordnung wieder an jeder Aufrufstelle. Geprueft ueber die
  // Signatur der Aufrufe: ein Icon-Name enthaelt einen Bindestrich oder heisst
  // wie ein Lucide-Glyph, eine Id ist ein Modulschluessel.
  const headerArgs = [...dashboard.matchAll(/widgetHeader\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(headerArgs.length >= 10, `Nur ${headerArgs.length} widgetHeader-Aufrufe gefunden - die Signatur greift nicht mehr.`);
  const fremdeArgs = headerArgs.filter((id) => !(id in MODULE_ICON_KEYS));
  assert.deepEqual(fremdeArgs, [],
    'widgetHeader nimmt die Widget-Id (ein Schluessel von MODULE_ICON), nicht einen Icon-Namen.\n'
    + fremdeArgs.join('\n'));

  const moduleOrder = read('../public/settings/module-order.js');
  assert.doesNotMatch(moduleOrder, /icon:/,
    'BUILT_IN_MODULES/KITCHEN_CHILD_ICONS fuehren wieder eigene Zeichen - das war die vierte Abschrift');
  for (const leaf of ['modules-active', 'modules-navigation']) {
    assert.match(read(`../public/settings/pages/${leaf}.js`), /MODULE_ICON/,
      `${leaf} holt die Modulzeichen aus MODULE_ICON`);
  }
});

test('die Tab-Bar zeigt dieselbe Legende wie die Sidebar', () => {
  // UND SIE IST DIE MOBILE FASSUNG DERSELBEN REGEL, kein zweites Feature.
  //
  // Die Legende hing bis 2026-08-17 an einem Breakpoint: ueber 1024px trug
  // jedes Nav-Zeichen seinen Modulton, darunter waren alle grau - dieselbe
  // Komponente sprach je nach Fenstergroesse eine andere Sprache, und auf
  // Telefonen (der Hauptbuehne, PRODUCT.md) war gar kein Modulton in der
  // Navigation zu sehen. Der Betreiber hat genau das gemeldet.
  //
  // Der Guard steht getrennt von dem der Sidebar, weil die beiden Faelle
  // getrennt kaputtgehen koennen - ein Aufraeumen an der Bottom-Nav laesst die
  // Sidebar gruen und umgekehrt. Zwei Zusicherungen, zwei Namen.
  const layout = read('../public/styles/layout.css');
  const wellRule = [...eachRule(layout)].find(({ selector }) =>
    selector.trim() === '.nav-bottom .nav-item__icon-well');
  assert.ok(wellRule, '.nav-bottom .nav-item__icon-well fehlt - die mobile Legende hat keinen Traeger');
  assert.match(wellRule.body, /color:\s*var\(--item-module-accent,\s*var\(--color-text-tertiary\)\)/,
    'das Tab-Zeichen traegt den Ton SEINES Moduls; wer keines hat („Mehr"), bleibt tertiaer');
  // Aktiv gewinnt die Stimme, genau wie in der Sidebar - und zwar ueber die
  // gemeinsame Regel fuer beide Leisten.
  const activeWell = [...eachRule(layout)].find(({ selector }) =>
    selector.includes('.nav-item[aria-current="page"] .nav-item__icon-well'));
  assert.ok(activeWell, 'dem aktiven Tab fehlt die Icon-Well-Regel');
  assert.match(activeWell.body, /color:\s*var\(--color-accent\)/);
  // Und die Leiste selbst bleibt Shell: der Ton sitzt auf dem ZEICHEN, nicht
  // auf der Kapsel, dem Indikator oder dem Label (Eine-Stimme-Regel). Das
  // Label ist zugleich der Kontrast-Grund - Text braucht 4.5:1, und sieben der
  // neun Familientoene reissen das gegen die Kapsel.
  const labelRule = [...eachRule(layout)].find(({ selector }) =>
    selector.trim() === '.nav-bottom .nav-item__label');
  assert.ok(labelRule, '.nav-bottom .nav-item__label fehlt');
  assert.doesNotMatch(labelRule.body, /--item-module-accent/,
    'das Tab-Label bleibt Text in Textfarbe - der Modulton gehoert dem Zeichen');
});

test('kein geteiltes Bedienelement wird unter seinem eigenen Namen umgefaerbt', () => {
  // DIE LUECKE, DIE DIE REGEL DARUEBER OFFEN LAESST, und sie ist dieselbe, an
  // der die Eine-Buttonform-Regel schon einmal blind war: ein Guard, der eine
  // KLASSE im Selektor sucht, findet nur, wer sie schon traegt. Der Knopf
  // „Aktuell" im Budget trug `.btn.btn--secondary` UND `.budget-nav__today`,
  // und die zweite Klasse faerbte ihn teal - eine geteilte Variante, umgefaerbt
  // unter einem Namen, den der Selektor-Guard nie ansieht.
  //
  // Die Antwort ist dieselbe wie dort: ueber die SIGNATUR gehen. Welche Klassen
  // ein geteiltes Bedienelement begleiten, steht im MARKUP - also wird es dort
  // gelesen und dann gegen die Stylesheets gehalten.
  const SHARED = /\b(btn--primary|btn--secondary|btn--ghost|btn--danger|btn--icon|toggle__track|form-check)\b/;
  const companions = new Map();   // Begleitklasse -> Fundstelle im Markup
  for (const rel of walkFrontendFiles('../public/')) {
    if (!rel.endsWith('.js') && !rel.endsWith('.html')) continue;
    const src = read(rel);
    for (const m of src.matchAll(/class="([^"${}]+)"/g)) {
      const classes = m[1].trim().split(/\s+/);
      if (!classes.some((c) => SHARED.test(c))) continue;
      for (const c of classes) {
        if (SHARED.test(c) || c === 'btn' || c.startsWith('u-')) continue;
        if (!companions.has(c)) companions.set(c, rel.replace(/^\.\.\//, ''));
      }
    }
  }
  assert.ok(companions.size > 5,
    'keine Begleitklassen gefunden - der Guard liest das Markup nicht mehr richtig');

  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      if (!MODULE_TONE.test(body)) continue;
      if (ORIGIN_MARKS.some((mark) => body.includes(mark))) continue;
      // Nur die FARBE des Elements selbst zaehlt, nicht was es an Kindern oder
      // an lokalen Variablen setzt: ein Bauteil darf einem Kind-Siegel weiter
      // seinen Ton durchreichen.
      if (!/(^|[;{\s])(?:color|background|background-color|border-color)\s*:/.test(body)) continue;
      // EIN AUSGEWAEHLTES SEGMENT IST KEINE UMFAERBUNG, sondern die eine
      // Segment-Sprache der Shell (DESIGN.md „Segmented Controls"): der aktive
      // Zustand einer modul-eigenen Leiste traegt den Modulton, und zwar in
      // Aufgaben, Dokumenten, Budget und Kalender gleich. Der Verstoss ist die
      // BASIS-Farbe eines geteilten Knopfes, nicht sein Auswahl-Zustand.
      if (/--active\b|--selected\b|\[aria-pressed="true"\]|\.is-active\b/.test(selector)) continue;
      for (const [cls, where] of companions) {
        if (!selector.includes(`.${cls}`)) continue;
        offenders.push(`${file}: ${selector} faerbt ein geteiltes Bedienelement (Markup: ${where})`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'Ein Element, das eine geteilte Bedienvariante traegt, darf sie nicht unter seinem '
    + 'eigenen Klassennamen umfaerben - es traegt die Stimme (Eine-Stimme-Regel, DESIGN.md). '
    + 'Wer eine andere Farbe braucht, braucht eine andere VARIANTE, keine zweite Regel.\n'
    + offenders.join('\n'));
});

/**
 * Ein Hover gehoert zu SEINER Flaeche, nicht zur Grundflaeche.
 *
 * `--color-surface-hover` ist der Schritt von `--color-surface` aus. Ein
 * Element, das im Ruhezustand schon `--color-surface-elevated` (oder -3 /
 * -raised) traegt, landet damit im Dark auf seiner EIGENEN Farbe: beide loesen
 * dort auf `#322F2B` auf, der Hover ist unsichtbar. Gemessen an
 * `.more-sheet__search`: 1:1.
 *
 * DASS ES VORHER GING, WAR ZUFALL, und das ist der Grund fuer diesen Guard.
 * Der alte Dark-Hover sprang zwei Rampenstufen (`#403C37`) und traf so gerade
 * noch ueber die erhoehte Flaeche - waehrend er auf der Grundflaeche mit
 * 1.414:1 gegen 1.201:1 im Light deutlich zu laut war. Die Korrektur der einen
 * Zahl legte die drei Stellen frei, die vom Ueberschuss gelebt hatten. Ohne
 * diesen Guard ist die naechste solche Stelle wieder eine, die niemand sieht,
 * weil ein unsichtbarer Hover nichts kaputt macht - er tut nur nichts.
 *
 * Geprueft wird ueber `eachRule()` (nie ueber `includes()` auf zusammengehaengtem
 * CSS - ein Kommentar zaehlt sonst als Regel) und mit einem Reichweiten-Nachweis:
 * ohne ihn meldet ein Scanner, dessen Muster nicht mehr greift, fehlerfrei
 * „keine Verstoesse" ueber null gelesene Regeln. Genau das ist beim Bau dieser
 * Pruefung zweimal passiert - einmal las das CSSOM `background: var(…)` als
 * leere Kurzform, einmal lieferte `document.styleSheets` gar nichts.
 */
test('ein Hover auf erhoehter Flaeche nimmt die Stufe ueber DIESER Flaeche', () => {
  const ELEVATED_REST = /--color-surface-(?:3|elevated|raised)\b/;
  const restBg = new Map();
  const hoverOnSurface = new Map();
  let rulesRead = 0;

  const dirs = [
    new URL('../public/styles/', import.meta.url),
    new URL('../public/settings/styles/', import.meta.url),
  ];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.css')); } catch { continue; }
    for (const file of files) {
      for (const { selector, body } of eachRule(readFileSync(new URL(file, dir), 'utf8'))) {
        rulesRead++;
        const bg = body.match(/background(?:-color)?\s*:([^;]*)/);
        if (!bg) continue;
        for (const raw of selector.split(',')) {
          const s = raw.trim();
          if (/:hover/.test(s)) {
            if (/--color-surface-hover\b/.test(bg[1])) {
              hoverOnSurface.set(`${file}::${s.replace(/:hover\b/g, '').trim()}`, s);
            }
          } else {
            restBg.set(`${file}::${s}`, bg[1].trim());
          }
        }
      }
    }
  }

  assert.ok(rulesRead >= 2000,
    `Reichweiten-Nachweis: nur ${rulesRead} Regeln gelesen - greift eachRule() hier noch?`);
  assert.ok(hoverOnSurface.size >= 20,
    `Reichweiten-Nachweis: nur ${hoverOnSurface.size} Hover-Regeln mit --color-surface-hover gefunden`);

  const offenders = [];
  for (const [key, selector] of hoverOnSurface) {
    const rest = restBg.get(key);
    if (rest === undefined || !ELEVATED_REST.test(rest)) continue;
    offenders.push(`${key.split('::')[0]}: "${selector}" liegt im Ruhezustand auf ${rest}, `
      + 'nimmt im Hover aber --color-surface-hover');
  }

  assert.deepEqual(offenders, [],
    'Ein Element, dessen Ruheflaeche schon erhoeht ist, braucht '
    + '--color-surface-elevated-hover. --color-surface-hover ist der Schritt von '
    + '--color-surface aus und faellt im Dark mit der erhoehten Flaeche zusammen:\n'
    + offenders.join('\n'));
});

/* ──────────────────────────────────────────────────────────────────────────
 * Wand-Modus (Block D)
 * ────────────────────────────────────────────────────────────────────────── */

test('die Distanzskala der Wand haengt an der KNAPPEN Seite, nicht an der Hoehe', () => {
  // GEMESSEN, NICHT GERATEN. Mit `vh` in der Mitte des clamp() wurden die
  // Zeilen auf einem Tablet im HOCHFORMAT (768x1024) groesser - dort ist Hoehe
  // reichlich - und schoben Datenstand und Ausstieg um 59px aus dem Bild. Eine
  // Wand kann nicht scrollen. `vmin` bindet die Groesse an die knappe Seite und
  // haelt beide Lagen im Schirm; `vw` bleibt erlaubt, wo die BREITE wirklich
  // die Grenze ist (die Uhr ist eine einzelne lange Ziffernfolge).
  //
  // `dvh` ist ausdruecklich in Ordnung: `min-height: 100dvh` ist die
  // Bildschirmhoehe selbst, keine Groessenskala.
  const css = read('../public/styles/dashboard.css');
  const offenders = [];
  let wallRules = 0;
  let declarationsRead = 0;

  for (const { selector, body } of eachRule(css)) {
    if (!/\bwall\b|--wall-|clock-widget--wall/.test(selector) && !/--wall-/.test(body)) continue;
    wallRules += 1;
    for (const declaration of body.split(';')) {
      if (!declaration.trim()) continue;
      declarationsRead += 1;
      // Nur ECHTE vh-Einheiten: `dvh`/`svh`/`lvh` tragen ihren eigenen Praefix.
      if (/(^|[^dsl\w.])\d+(\.\d+)?vh\b/.test(declaration)) {
        offenders.push(`${selector} { ${declaration.trim()} }`);
      }
    }
  }

  assert.ok(wallRules >= 15,
    `Reichweiten-Nachweis: nur ${wallRules} Wand-Regeln gelesen - greift der Selektor noch?`);
  assert.ok(declarationsRead >= 60,
    `Reichweiten-Nachweis: nur ${declarationsRead} Deklarationen gelesen`);
  assert.deepEqual(offenders, [],
    'Wand-Groessen nehmen vmin (oder vw, wo die Breite die Grenze ist):\n' + offenders.join('\n'));
});

test('der Wand-Modus laesst die Shell abtreten - und versteckt den FAB NICHT per CSS', () => {
  const css = read('../public/styles/dashboard.css');
  const hidden = new Set();
  let wallModeRules = 0;

  for (const { selector, body } of eachRule(css)) {
    if (!/\[data-wall-mode\]/.test(selector)) continue;
    wallModeRules += 1;
    if (/display:\s*none/.test(body)) {
      for (const part of selector.split(',')) hidden.add(part.trim().replace(/\[data-wall-mode\]\s*/, ''));
    }
  }

  assert.ok(wallModeRules >= 3,
    `Reichweiten-Nachweis: nur ${wallModeRules} [data-wall-mode]-Regeln gelesen`);
  for (const chrome of ['.nav-sidebar', '.nav-bottom']) {
    assert.ok(hidden.has(chrome),
      `${chrome} muss im Wand-Modus abtreten - auf zwei Metern sind das siebzehn unleserliche Ziele`);
  }

  // Der FAB verschwindet im Wand-Modus, aber NICHT per CSS: eine Regel, die
  // `.page-fab` auf display/opacity/pointer-events setzt, ist seit #634 die
  // Mechanik, die den Knopf schon einmal unerreichbar gemacht hat. Die Seite
  // rendert ihn dort gar nicht erst (public/pages/dashboard.js).
  const viaCss = [...hidden].filter((s) => /page-fab/.test(s));
  assert.deepEqual(viaCss, [], 'der FAB wird nicht gerendert, nicht weggeblendet');
  assert.match(read('../public/pages/dashboard.js'), /wallMode \|\| loadFailed/,
    'der Wand-Modus raeumt den FAB im JS ab, wie es der Fehlerzustand tut');
});

test('der Vorab-Wand-Modus in theme-init.js driftet nicht von utils/wall-mode.js', () => {
  // theme-init.js laeuft als klassisches <script> im <head>, vor jedem Modul -
  // es KANN nicht importieren und traegt die Werte deshalb als Literale. Die
  // Quelle der Wahrheit bleibt utils/wall-mode.js; hier steht die Naht.
  const init = read('../public/theme-init.js');
  const mod = read('../public/utils/wall-mode.js');

  const modKey = mod.match(/const WALL_KEY = '([^']+)'/)?.[1];
  assert.equal(modKey, 'yuvomi-wall-mode', 'der Schluessel steht in wall-mode.js');
  assert.ok(init.includes(`'${modKey}'`), `theme-init.js liest denselben Schluessel (${modKey})`);

  const from = Number(mod.match(/export const WALL_NIGHT_FROM = (\d+)/)?.[1]);
  const to = Number(mod.match(/export const WALL_NIGHT_TO = (\d+)/)?.[1]);
  assert.equal(from, 22);
  assert.equal(to, 6);

  const initWindow = init.match(/hour >= (\d+) \|\| hour < (\d+)/);
  assert.ok(initWindow, 'theme-init.js traegt ein Nachtfenster');
  assert.equal(Number(initWindow[1]), from, 'dieselbe Nachtgrenze wie wall-mode.js');
  assert.equal(Number(initWindow[2]), to, 'dieselbe Morgengrenze wie wall-mode.js');

  // Und die Route: der Modus ist ein Zustand des Dashboards, kein zweiter Ort.
  assert.match(mod, /export function isWallRoute\(path\) \{\s*return path === '\/';/);
  assert.ok(init.includes("location.pathname !== '/'"), 'theme-init.js kennt dieselbe Route');
});

/**
 * EIN FELD TRAEGT EINE KLASSE, DIE ES GIBT.
 *
 * `settings/admin-api.js` und `settings/personal-calendar.js` bauten ihr
 * `<select>` mit `class="form-select"` - einem Namen, den kein Stylesheet je
 * definiert hat. Die Felder daneben (`class="form-input"`) trugen das
 * Feldmaterial, die Selects fielen auf die Browservorgabe zurueck und standen
 * 23px hoch in einem Formular, dessen Kanon `--target-lg` sagt. Gefunden hat es
 * Sonde 4 der Dokument-Guards („nimmt die Spacing-Ausnahme, obwohl sein Traeger
 * Platz laesst") - also die Ebene, die 55 Minuten braucht und vor dem Release
 * einmal laeuft. Eine erfundene Klasse ist aber statisch pruefbar.
 *
 * GEPRUEFT WIRD DIE BAUART, NICHT EINE LISTE VON NAMEN: jedes Bedienelement im
 * Markup, dessen Klassenliste ein `form-*` enthaelt, muss diese Klasse in einem
 * Stylesheet wiederfinden. Damit faellt jeder kuenftige `form-dropdown`,
 * `form-textbox` oder `form-picker` beim ersten Lauf auf, ohne dass jemand ihn
 * vorher aufzaehlt. Die Klassen kommen aus `eachRule()` (test/css-rules.js), nie
 * aus einem eigenen Muster - das Repo-Regelmuster war dreimal blind.
 */
test('ein Formularfeld traegt nur form-Klassen, die ein Stylesheet kennt', () => {
  const defined = new Set();
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css'))) {
    for (const { selector } of eachRule(read(`../public/styles/${file}`))) {
      for (const cls of selector.match(/\.[A-Za-z_][\w-]*/g) ?? []) defined.add(cls.slice(1));
    }
  }
  // Eine Pruefung, die nichts gelesen hat, darf nicht urteilen: ohne Klassen
  // waere JEDE Fundstelle ein Verstoss, und der Guard meldete seinen eigenen
  // Defekt als Befund der App.
  assert.ok(defined.size >= 500, `Nur ${defined.size} Klassen aus den Stylesheets gelesen - liest eachRule() noch?`);

  const offenders = [];
  for (const path of walkFrontendFiles('../public/')) {
    if (path.includes('/vendor/')) continue;
    const src = read(path);
    for (const [, tag, attrs] of src.matchAll(/<(select|input|textarea)\b([^>]*)>/g)) {
      const cls = attrs.match(/class="([^"${}]*)"/)?.[1];
      if (!cls) continue;
      for (const name of cls.split(/\s+/).filter((c) => c.startsWith('form-'))) {
        if (!defined.has(name)) offenders.push(`${path.startsWith('../') ? path.slice(3) : path}: <${tag} class="${name}">`);
      }
    }
  }

  assert.deepEqual(offenders.sort(), [],
    'Diese Felder tragen eine form-Klasse, die kein Stylesheet definiert - sie fallen '
    + 'damit auf die Browservorgabe zurueck und reissen die Zielgroesse. Der Kanon '
    + 'heisst `input` bzw. `form-input` (layout.css, Abschnitt Form-Elemente); '
    + '`select.form-input` bringt dort auch das Chevron-Polster mit.');
});

/* --------------------------------------------------------------------------
 * DAS AKTIVE SEGMENT IST UEBERALL DIESELBE PILLE.
 *
 * Ein segmentierter Umschalter zeigt seinen aktiven Zustand als erhabene
 * Surface-Pille und traegt den Modulton NUR in der Tinte. Das Rezept steht in
 * tokens.css (Abschnitt 6c) und heisst an jeder Fundstelle gleich:
 *
 *   background(-color): var(--seg-active-bg);
 *   box-shadow:         var(--seg-active-shadow);
 *   color:              color-mix(in srgb, <Akzent> var(--tint-ink), var(--color-text-primary));
 *
 * WARUM DIE TINTE NICHT AUCH EIN TOKEN IST: ein Custom Property, das
 * `var(--module-accent)` enthaelt, wird dort aufgeloest, wo es DEKLARIERT ist.
 * An `:root` gibt es keinen Modulton, also war ein `--seg-active-ink` in jedem
 * Modul violett - gemessen, nicht vermutet. Die Zeile steht deshalb
 * ausgeschrieben, und dieser Guard haelt sie zusammen: eine geteilte Regel ohne
 * Guard ist eine wandernde Annahme.
 *
 * ZWEI RICHTUNGEN, weil eine allein nicht reicht:
 *   (1) Vollstaendigkeit - wer die Pille nimmt, nimmt alle drei Zeilen. Sonst
 *       steht irgendwo eine Pille ohne Schatten oder mit grauer Tinte.
 *   (2) Rueckfall - kein aktiver Umschalter darf wieder deckend im Modulton
 *       fuellen. Das ist die Richtung, die den Anlassfall trifft: auf /aufgaben
 *       standen vier Grün-Behandlungen gleichzeitig im Bild.
 * -------------------------------------------------------------------------- */

// Ein Selektor, der den AKTIVEN Zustand eines segmentierten Umschalters meint.
// Signatur statt Namensliste: Zustandsmarke (--active / .is-active / --selected)
// UND ein Bauteilname aus der Umschalter-Familie im selben Selektor.
const SEGMENT_ACTIVE_RE = /(?:^|[\s,>])\.[a-z][\w-]*(?:tab|seg|toggle|view-btn|switch)[\w-]*(?:--active|--selected|\.is-active|\.is-selected)/i;

test('das aktive Segment ist ueberall dieselbe Pille', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const incomplete = [];
  const refilled = [];
  let seen = 0;

  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css') && f !== 'tokens.css')) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      const usesPill = /background(-color)?\s*:\s*var\(--seg-active-bg\)/.test(body);
      const isSegment = SEGMENT_ACTIVE_RE.test(selector);

      if (usesPill) {
        seen += 1;
        const missing = [];
        if (!/box-shadow\s*:\s*var\(--seg-active-shadow\)/.test(body)) missing.push('box-shadow: var(--seg-active-shadow)');
        // AUSNAHME, MECHANISCH STATT NAMENTLICH: eine Pille mit
        // `pointer-events: none` traegt keinen Text - sie ist eine reine
        // Flaeche, wie der gleitende Daumen des Rechte-Umschalters, und ihre
        // Tinte sitzt zwangslaeufig am Geschwister darueber. Am Element
        // ablesbar, nicht an seinem Namen.
        const carriesText = !/pointer-events\s*:\s*none/.test(body);
        if (carriesText && !/color\s*:\s*color-mix\([^;]*var\(--tint-ink\)[^;]*var\(--color-text-primary\)/.test(body)) {
          missing.push('color: color-mix(… var(--tint-ink), var(--color-text-primary))');
        }
        if (missing.length) incomplete.push(`${file}: ${selector.trim()} - es fehlt ${missing.join(' und ')}`);
      }

      // Der Rueckfall: deckend im Modulton gefuellt plus Vivid-Tinte. Genau die
      // Kombination, die bis 2026-08-12 in sechs Stylesheets stand.
      if (isSegment
        && /background(-color)?\s*:\s*var\(--(?:active-)?module-accent/.test(body)
        && /color\s*:\s*var\(--color-ink-on-vivid\)/.test(body)) {
        refilled.push(`${file}: ${selector.trim()}`);
      }
    }
  }

  // Eine Zusicherung ueber eine leere Liste ist keine: findet der Scanner die
  // Pille nirgends, ist der Guard blind und nicht die App sauber.
  assert.ok(seen >= 6, `Nur ${seen} Pillen-Regeln gefunden - liest der Scanner die Segment-Zustaende noch?`);

  assert.deepEqual(incomplete.sort(), [],
    'Diese Segment-Zustaende nehmen die Pille nur halb. Alle drei Zeilen gehoeren '
    + 'zusammen (tokens.css, Abschnitt 6c) - eine Pille ohne Schatten ist auf dem '
    + 'Well nicht als Zustand zu erkennen (gemessen 1.20:1 hell, 1.16:1 dunkel).');

  assert.deepEqual(refilled.sort(), [],
    'Diese Umschalter fuellen ihren aktiven Zustand wieder deckend im Modulton. '
    + 'Der Ton gehoert genau einmal als FLAECHE (dem Filter-Chip) und einmal als '
    + 'TINTE (dem Segment) - eine Behandlung pro Kontrolltyp.');
});

// --------------------------------------------------------------------------
// #758: Die Lesemass-Liste in layout.css setzt `max-width` bei `border-box`.
// Polstert dasselbe Element anderswo horizontal, ZIEHT dieses Polster von der
// Kappung ab, statt sie zu verlaengern - die sichtbare Flaeche schrumpft dann um
// die doppelte Polsterbreite. Gemessen an `.list-tabs-bar` bei 1907px: von
// 720px blieben 313px fuer die Chips, waehrend der Koerper darunter die vollen
// 720px fuehrte, und die Listenreiter brachen mitten im Namen ab.
//
// ALS REGEL, NICHT ALS LISTE: Der Guard liest beide Seiten aus dem Stylesheet
// (die :is()-Liste und jede Regel, die `--page-inline-pad` als Inline-Polster
// setzt) und meldet jede Ueberschneidung. Eine kuenftige Eintragung in die
// Lesemass-Liste faellt damit auf, ohne dass jemand diesen Test anfasst.
// --------------------------------------------------------------------------
test('die Lesemass-Liste kappt kein selbstpolsterndes Element (#758)', () => {
  const layoutCss = read('../public/styles/layout.css');

  // Die Selektoren der Kappungsliste - aus der Quelle gelesen, nicht gedoppelt.
  const listBlock = layoutCss.match(/\.page-measure--narrow :is\(([\s\S]*?)\)\s*\{/);
  assert.ok(listBlock, 'die Lesemass-Liste muss auffindbar bleiben (Selektor umbenannt?)');
  const capped = listBlock[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')          // Kommentare tragen Beispiel-Selektoren
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'));
  assert.ok(capped.length >= 5, `die Liste sollte mehrere Selektoren fuehren, gefunden: ${capped.length}`);

  // Jede Regel, die ein Element horizontal mit dem Seitenpolster versieht.
  const selfPadding = new Set();
  for (const file of readdirSync(new URL('../public/styles/', import.meta.url)).filter((f) => f.endsWith('.css'))) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/padding-inline\s*:\s*var\(--page-inline-pad|padding(-inline)?-(left|right|start|end)\s*:\s*var\(--page-inline-pad/.test(rule.body)) continue;
      for (const sel of rule.selector.split(',')) {
        const cls = sel.trim().match(/\.[a-z0-9-]+(?=[^a-z0-9-]|$)/gi);
        if (cls) selfPadding.add(cls[cls.length - 1]);   // das ANGESPROCHENE Element, nicht sein Vorfahre
      }
    }
  }
  assert.ok(selfPadding.size > 0, 'ohne Fundstellen prueft der Guard eine leere Menge und sagt nichts aus');

  const clash = capped.filter((sel) => selfPadding.has(sel));
  assert.deepEqual(clash, [],
    `diese Selektoren stehen in der Lesemass-Liste UND polstern sich selbst mit --page-inline-pad: ${clash.join(', ')}. `
    + 'Bei box-sizing: border-box frisst das Polster die Kappung auf. Die Kappung gehoert dorthin, wo auch das '
    + 'Polster steht, und muss es einrechnen (siehe .list-tabs-bar in shopping.css).');
});

test('ein Teilschritt lässt sich korrigieren und entfernen, nicht nur abhaken (#748)', () => {
  // Ein Teilschritt IST eine Aufgabe mit parent_task_id, PUT und DELETE gab es
  // also längst - die Zeile bot nur das Häkchen an. Einen Tippfehler zu
  // korrigieren hieß: abhaken und neu tippen (#748).
  const tasksPage = read('../public/pages/tasks.js');

  const row = /class="subtask-item [\s\S]*?<\/div>`\)\.join\(''\)/.exec(tasksPage);
  assert.ok(row, 'die Teilschritt-Zeile ist nicht mehr auffindbar');
  for (const action of ['toggle-subtask', 'rename-subtask', 'delete-subtask']) {
    assert.match(row[0], new RegExp(`data-action="${action}"`),
      `die Teilschritt-Zeile bietet "${action}" nicht an`);
  }

  // Beide Aktionen sind auch verdrahtet - ein Knopf ohne Handler ist schlimmer
  // als keiner.
  assert.match(tasksPage, /action === 'rename-subtask'[\s\S]{0,120}handleRenameSubtask/);
  assert.match(tasksPage, /action === 'delete-subtask'[\s\S]{0,120}handleDeleteSubtask/);

  // Löschen ist der einzige Weg ohne Rückweg und fragt deshalb zurück.
  assert.match(tasksPage, /handleDeleteSubtask[\s\S]{0,400}confirmModal/);

  // Und die Zielgröße stimmt mit der Aufgabenzeile darüber überein, statt eine
  // zweite Größe für dieselbe Rolle einzuführen.
  const css = read('../public/styles/tasks.css');
  const block = /\.subtask-item__action \{([\s\S]*?)\}/.exec(css);
  assert.ok(block, '.subtask-item__action fehlt');
  assert.match(block[1], /min-height:\s*var\(--target-base\)/);
});

/**
 * EINE KNOPFZEILE SAGT, OB SIE UMBRICHT (#872).
 *
 * Der gemeldete Fehler war nicht kosmetisch, und er entsteht nicht durch
 * Quetschen: ein Flex-Item traegt `min-width: auto` und schrumpft nicht unter
 * seine Inhaltsbreite. Stattdessen waechst die ZEILE ueber den Container
 * hinaus - rechtsbuendig also nach LINKS -, und das Panel schneidet mit
 * `overflow: clip` ab, was heraussteht. Gemessen an der Aufgaben-Detailansicht
 * auf 390px: der Löschen-Knopf sass bei x = -11, das Panel beginnt bei x = 12,
 * aus „Löschen" wurde sichtbar „öschen". Ohne Ellipse, ohne Scrollbalken -
 * nur ein Wort, das falsch anfaengt. Getroffen haette es jede Fusszeile mit
 * drei Knoepfen in einer laengeren Locale.
 *
 * DIE REGEL VERLANGT EINE ENTSCHEIDUNG, KEINEN BESTIMMTEN WERT. Wo ein
 * Umbruch falsch waere (zwei Icon-Knoepfe in einer Rasterspalte), steht
 * `flex-wrap: nowrap` ausdruecklich da. Das unterscheidet eine getroffene
 * Entscheidung von einem Versaeumnis - und nur Letzteres ist der Bug.
 *
 * ALS REGEL UND NICHT ALS ALLOWLIST: er sucht die FORM (rechtsbuendige
 * Flex-Zeile, deren Name sie als Fuss- oder Aktionszeile ausweist), nicht die
 * neun Selektoren, die es heute gibt. Beim ersten Lauf fand er in genau
 * dieser Form acht weitere Zeilen mit demselben Mangel; eine Liste haette nur
 * die eine gemeldete Stelle gedeckt.
 *
 * Guard-Ebene: Form (aus dem Stylesheet gelesen).
 */
test('jede rechtsbuendige Knopfzeile sagt, ob sie umbricht (#872)', () => {
  const styleDir = new URL('../public/styles/', import.meta.url);
  const offenders = [];
  let seenRows = 0;

  /* JE SELEKTOR GESAMMELT, NICHT JE REGEL - so, wie die Kaskade es sieht.
   *
   * Die erste Fassung urteilte ueber die EINZELNE Regel und war damit blind
   * fuer jede Zeile, deren Deklarationen verteilt stehen: `display: flex` aus
   * einer geteilten Kopf-/Fusszeilen-Regel, `justify-content` dreissig Zeilen
   * spaeter aus einer eigenen. Genau so gebaut sind
   * `.budget-inline-modal__footer` und `.doc-attach-picker__footer` - zwei
   * echte Verstoesse, die der Guard nicht sah. Gefunden hat sie die Review,
   * nicht er. */
  const declarations = new Map();
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body, at } of eachRule(read(`../public/styles/${file}`))) {
      // Gruppenselektoren aufspalten: `.a, .b { display: flex }` gibt beiden
      // dieselbe Deklaration, und nur einzeln laesst sich das zusammenlegen.
      for (const one of selector.split(',').map((x) => x.trim()).filter(Boolean)) {
        const key = `${file}${at.length ? ` [${at.join(' ')}]` : ''}: ${one}`;
        declarations.set(key, (declarations.get(key) ?? '') + body);
      }
    }
  }

  for (const [key, body] of declarations) {
    if (!/(footer|actions)\b/.test(key)) continue;
    if (!/display\s*:\s*(inline-)?flex/.test(body)) continue;
    if (!/justify-content\s*:\s*(flex-)?end/.test(body)) continue;
    seenRows += 1;
    if (/flex-wrap\s*:/.test(body) || /\bflex-flow\s*:/.test(body)) continue;
    offenders.push(key);
  }

  // Ohne diese Zusicherung waere der Guard gruen, sobald der Scanner die
  // Stylesheets nicht mehr faende - eine leere Liste ist keine Zusicherung.
  assert.ok(seenRows >= 9,
    `Nur ${seenRows} rechtsbuendige Knopfzeilen gefunden - der Scanner findet `
    + 'public/styles/ nicht mehr, statt nichts zu beanstanden.');

  assert.deepEqual(offenders.sort(), [],
    'Diese Knopfzeile sagt nicht, was bei Platzmangel passieren soll. Ohne '
    + '`flex-wrap` waechst sie ueber ihren Container hinaus - rechtsbuendig also '
    + 'nach links -, und was heraussteht, schneidet der Rahmen ab (#872). '
    + 'Setze `flex-wrap: wrap` - oder `nowrap` mit einer '
    + `Begruendung, wenn der Umbruch hier falsch waere.\n${offenders.join('\n')}`);
});

/**
 * Der Umbruch der ZEILE reicht nicht, wenn EIN Knopf allein zu breit ist.
 *
 * Genau dann kann die Zeile nicht mehr umbrechen, und der abgeschnittene Text
 * aus #872 stuende wieder da - seltener, aber unveraendert falsch. Deshalb
 * geben die beiden kanonischen Modal-Knopfzeilen ihren Knoepfen das Recht,
 * INNEN umzubrechen, und nehmen damit das `white-space: nowrap` von `.btn`
 * fuer diesen einen Ort zurueck.
 */
test('in den Modal-Knopfzeilen darf der Knopftext umbrechen (#872)', () => {
  const css = read('../public/styles/layout.css');

  /* Und die verschachtelte Aktionsgruppe bricht selbst um. Fuer die Fusszeile
   * ist sie EIN Flex-Item; ohne eigenen Umbruch laeuft sie als Ganzes ueber
   * den Rand, und der Umbruch der Fusszeile hilft nichts mehr. Gebaut ist das
   * so im Kalender, in den Budget-Plaenen und in den Kontakten. */
  const gruppe = [...eachRule(css)].find((r) => r.selector.trim() === '.modal-panel__footer > div');
  assert.ok(gruppe, '.modal-panel__footer > div fehlt - eine Aktionsgruppe laeuft wieder als Ganzes ueber');
  assert.match(gruppe.body, /flex-wrap\s*:\s*wrap/);
  for (const selector of ['.modal-panel__footer .btn', '.modal-actions .btn']) {
    const rule = [...eachRule(css)].find((r) => r.selector.trim() === selector);
    assert.ok(rule, `${selector} fehlt - ein einzelner zu breiter Knopf wird wieder abgeschnitten.`);
    assert.match(rule.body, /white-space\s*:\s*normal/,
      `${selector} nimmt das nowrap von .btn nicht zurueck.`);
  }
});

/**
 * JEDES OVERLAY MELDET SICH AN DER ZURUECK-GESTE AN (#871).
 *
 * Der gemeldete Fehler war, dass die Zurueck-Geste ueber einem offenen Dialog
 * die SEITE wechselte und den Dialog stehen liess - im Hintergrund landete man
 * auf der Uebersicht, davor hing weiter der Termin. Auf dem Telefon ist die
 * Wischgeste von links der Zurueck-Knopf, also war das die einzige Geste, die
 * den Zustand kaputt statt kleiner machte.
 *
 * DIESE APP HAT NICHT EINEN DIALOG. Neben dem geteilten Modal-System stehen
 * neun eigene Overlays (Mehr-Blatt, Suche, Hilfe, Icon-Picker, Belegpicker,
 * Belegvorschau, Buchungspicker, Logopicker, Onboarding, Budget-Inline). Ein
 * Fix nur im Modal-System haette den gemeldeten Fall geschlossen und die
 * anderen offen gelassen - und die zehnte Stelle waere wieder eine neue.
 *
 * DIE REGEL IST DIE VOLLSTAENDIGKEIT, NICHT DIE LISTE: wer ein Overlay
 * aufmacht (`aria-modal="true"`), meldet es an. Geprueft wird je Datei, dass
 * mindestens so viele Anmeldungen wie modale Overlays darin stehen.
 *
 * WAS ER NICHT SIEHT, ausgesprochen: er zaehlt je DATEI. Ein zweites Overlay
 * in einer Datei, die schon eine Anmeldung hat, faellt ihm auf; ein Overlay,
 * das seinen `aria-modal`-Wert aus einer Variablen setzt, nicht.
 *
 * Guard-Ebene: Vollstaendigkeit (aus dem Quelltext gezaehlt).
 */
test('jedes modale Overlay meldet sich an der Zurueck-Geste an (#871)', () => {
  /* Ein Overlay AUFMACHEN heisst hier zweierlei, und die zweite Form hat der
   * Guard zuerst uebersehen:
   *   1. `aria-modal="true"` an einem selbstgebauten Kasten,
   *   2. `showModal()` an einem nativen `<dialog>`. Es traegt kein Attribut -
   *      das setzt der Browser implizit -, ist aber genauso modal und liegt in
   *      der Top-Layer sogar DARUEBER. Der Bildzuschnitt (utils/avatar-crop.js)
   *      ist so gebaut und oeffnet ueber geteilten Modals; ohne Anmeldung nahm
   *      die Zurueck-Geste den Eintrag des Modals darunter. */
  const OPENS_OVERLAY = /aria-modal["']?\s*[,:=]\s*["']?true|\.showModal\s*\(/g;
  const REGISTERS = /\b(attachOverlay|pushOverlay)\s*\(/g;

  const offenders = [];
  let seenOverlays = 0;

  for (const file of walkJsFiles('../public/')) {
    if (file.includes('/vendor/')) continue;
    const src = withoutBlockComments(read(file));
    const opens = (src.match(OPENS_OVERLAY) ?? []).length;
    if (!opens) continue;
    seenOverlays += opens;
    const registers = (src.match(REGISTERS) ?? []).length;
    if (registers < opens) {
      offenders.push(`${file}: ${opens} modale Overlays, nur ${registers} Anmeldungen`);
    }
  }

  // Ohne diese Zusicherung waere der Guard gruen, sobald die Muster nicht mehr
  // greifen - eine leere Liste ist keine Zusicherung.
  assert.ok(seenOverlays >= 11,
    `Nur ${seenOverlays} modale Overlays gefunden - das Muster greift nicht mehr, `
    + 'statt nichts zu beanstanden.');

  assert.deepEqual(offenders.sort(), [],
    'Dieses Overlay faengt die Zurueck-Geste nicht ab. Sie wechselt dann die Seite '
    + 'darunter und laesst das Overlay stehen (#871) - auf dem Telefon ist das die '
    + 'Wischgeste von links, also der haeufigste Weg hinaus. Melde es mit '
    + '`attachOverlay(el, close)` aus /utils/overlay-history.js an; `pushOverlay` '
    + `nur, wenn das Overlay einen eigenen Lebenszyklus fuehrt.\n${offenders.join('\n')}`);
});

/**
 * Und der Router fragt auch wirklich, bevor er navigiert.
 *
 * Die Registrierung allein reicht nicht: ohne diesen Handler stuende das
 * ganze Register da und die Geste liefe weiter an ihm vorbei. Der Test haelt
 * die EINE Zeile fest, an der die Frage haengt.
 */
test('der popstate-Handler fragt zuerst die offenen Overlays (#871)', () => {
  const router = read('../public/router.js');
  const handler = /window\.addEventListener\('popstate'[\s\S]*?\n\}\);/.exec(router);
  assert.ok(handler, 'der popstate-Handler ist nicht mehr auffindbar');
  assert.match(handler[0], /handleBackNavigation\(\)/,
    'der Handler fragt die offenen Overlays nicht - die Geste wechselt wieder die Seite');
  assert.match(handler[0], /if \(!handled\) navigate\(/,
    'der Handler navigiert unabhaengig von der Antwort - dann bleibt der Dialog '
    + 'stehen UND die Seite wechselt, also genau der gemeldete Zustand');
});

/**
 * EIN ERZWUNGENES SCHLIESSEN RAEUMT AUCH DIE GEPARKTEN KAESTEN WEG (#871).
 *
 * Das Modal-System fuehrt EINEN Registereintrag fuer beliebig viele
 * gestapelte Zustaende: ein Bestaetigungsdialog PARKT das Formular darunter,
 * statt es zu schliessen (`_suspendActiveModal`). Ein `closeModal({force})`
 * erwischt deshalb nur den obersten Kasten - und der laufende
 * Bestaetigungs-Ablauf holt danach das geparkte Formular zurueck, bei
 * Sitzungsende also ueber die Anmeldeseite und ohne Registrierung. Wieder der
 * Zustand aus #871, nur mit abgelaufener Sitzung davor.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('erzwungenes Schliessen raeumt auch geparkte Modals weg (#871)', () => {
  const modal = read('../public/components/modal.js');
  const fn = /async function _closeFromBackNavigation\([\s\S]*?\n\}/.exec(modal);
  assert.ok(fn, '_closeFromBackNavigation ist nicht mehr auffindbar');
  assert.match(fn[0], /if \(force\)/,
    'der Zwangspfad ist nicht vom normalen unterschieden - dann bleibt ein '
    + 'geparktes Formular ueber der Anmeldeseite stehen');
  assert.match(fn[0], /querySelectorAll\('\.modal-overlay'\)[\s\S]{0,80}remove\(\)/,
    'der Zwangspfad entfernt die geparkten Kaesten nicht');

  /* UND DAS ZURUECKHOLEN ERKENNT DEN ENTFERNTEN KNOTEN. Der
   * Bestaetigungs-Ablauf laeuft in einer eigenen Kette weiter und kam nach dem
   * Zwangsraeumen hier an: er setzte `activeOverlay` auf ein Phantom,
   * `modalState` auf 'open' und die Scroll-Sperre auf die naechste Seite. Die
   * Anmeldeseite blieb unscrollbar, bis irgendwo das naechste Modal aufging. */
  const resume = /function _resumeSuspendedModal\([\s\S]*?\n\}/.exec(modal);
  assert.ok(resume, '_resumeSuspendedModal ist nicht mehr auffindbar');
  assert.match(resume[0], /if \(!overlay\.isConnected\)[\s\S]{0,120}return;/,
    'ein zwangsweise entfernter Kasten wird wieder „zurueckgeholt" - Scroll-Sperre '
    + 'und Escape-Handler bleiben dann auf einem Phantom haengen');
});

/**
 * DER REGISTEREINTRAG FOLGT DEM ZUSTAND, NICHT DEM EREIGNIS (#871).
 *
 * Drei Anlaeufe scheiterten daran, den Eintrag an Oeffnen und Schliessen zu
 * haengen: beide Stellen mussten wissen, ob unter dem Kasten, der gerade
 * zugeht, noch einer liegt, und konnten es nicht. Ein Bestaetigungsdialog ist
 * fuer `_doClose` das aktive Overlay, obwohl er das Formular darunter nur
 * PARKT - der Zweig gab also dessen Eintrag zurueck, und das gleich folgende
 * `_resumeSuspendedModal` holte es ohne Registrierung hervor. Wer direkt nach
 * `closeModal()` fragt, fragt ausserdem zu frueh: der Bestaetigungs-Ablauf
 * laeuft in einer eigenen, nicht abgewarteten Kette.
 *
 * Eine Zustandsfrage kennt diese Reihenfolgen nicht.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('die Registrierung des Modal-Systems folgt dem Zustand (#871)', () => {
  const modal = read('../public/components/modal.js');
  const fn = /function _syncOverlayRegistration\(\)[\s\S]*?\n\}/.exec(modal);
  assert.ok(fn, '_syncOverlayRegistration ist nicht mehr auffindbar');
  assert.match(fn[0], /querySelector\('\.modal-overlay'\)/,
    'die Registrierung fragt nicht mehr den Zustand ab');
  /* UND SIE FRAGT DAS REGISTER, nicht nur den eigenen Token.
   * `handleBackNavigation()` nimmt den Eintrag heraus, BEVOR es schliessen
   * laesst - wer danach nur prueft, ob er einen Token HAT, haelt sich fuer
   * angemeldet und ist es nicht. Genau so verlor ein wieder hervorgeholtes
   * Formular seinen Anspruch auf die naechste Geste. */
  assert.match(fn[0], /isOverlayOpen\(_overlayToken\)/,
    'die Registrierung prueft nicht, ob ihr Token ueberhaupt noch im Register '
    + 'steht - ein wieder hervorgeholtes Formular meldet sich dann nie neu an');

  /* Jeder Uebergang zieht sie nach - Oeffnen, endgueltiges Schliessen und das
   * Zurueckholen eines geparkten Formulars.
   *
   * Der Ausschnitt laeuft vom Funktionskopf bis zum naechsten auf Spaltenrand
   * beginnenden Kopf, NICHT ueber eine Klammerbilanz per Regex: `openModal`
   * enthaelt mehrere innere Bloecke, und ein `[\s\S]*?\n\}` endete am
   * ersten von ihnen - der Guard war damit rot, obwohl die Zeile dastand. */
  const abschnitt = (name) => {
    const start = modal.indexOf(`function ${name}(`);
    if (start === -1) return null;
    const rest = modal.slice(start);
    const ende = rest.slice(1).search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
    return ende === -1 ? rest : rest.slice(0, ende + 1);
  };

  for (const name of ['openModal', '_doClose', '_resumeSuspendedModal']) {
    const block = abschnitt(name);
    assert.ok(block, `${name} ist nicht mehr auffindbar`);
    assert.match(block, /_syncOverlayRegistration\(\)/,
      `${name} zieht die Registrierung nicht nach - nach diesem Uebergang `
      + 'stimmt der Eintrag nicht mehr mit dem ueberein, was zu sehen ist');
  }
});

/**
 * DIE ZAHL AM NAV-ZIEL WIRD AN EINER STELLE GEZEICHNET (#868).
 *
 * Gemeldet war, dass das Badge mit den ueberfaelligen Aufgaben nach dem
 * Anmelden fehlt. Der Grund war die Bauart: drei Module (Aufgaben,
 * Geburtstage, Inventar) bauten dasselbe Badge-DOM je einzeln nach - zwanzig
 * Zeilen, die den Icon-Wrapper nachruesten und die Zahl anhaengen - und sie
 * taten es aus IHREM Zustand heraus. Ein Modul, das nie gerendert wurde, hat
 * keinen Zustand; also gab es kein Badge. Dieselbe Bauart liess das Badge
 * auch bei jedem `rebuildNavigation()` verschwinden.
 *
 * DER GUARD SCHUETZT DIE EINE STELLE, nicht die drei Aufrufer: wer eine
 * `.nav-badge` ausserhalb von `utils/nav-badges.js` baut, baut die Bauart
 * wieder auf, aus der der Fehler kam - und erbt weder den Icon-Wrapper noch
 * die Deckelung noch den Zugaenglichkeitsnamen.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('nur EINE Stelle baut die Zahl am Nav-Ziel (#868)', () => {
  const OWNER = '../public/utils/nav-badges.js';
  const offenders = [];

  for (const file of walkJsFiles('../public/')) {
    if (file === OWNER || file.includes('/vendor/')) continue;
    const src = withoutBlockComments(read(file));
    // Ein Badge BAUEN heisst: die Klasse einem erzeugten Knoten geben.
    if (/className\s*=\s*['"]nav-badge['"]|classList\.add\(\s*['"]nav-badge['"]/.test(src)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders.sort(), [],
    'Diese Datei baut ihr Nav-Badge selbst. Genau daraus entstand #868: das '
    + 'Badge haengt dann am Zustand eines Moduls, das beim Anmelden noch gar '
    + 'nicht gerendert wurde, und faellt bei jedem Neuaufbau der Navigation '
    + `weg. Benutze setNavBadge() aus /utils/nav-badges.js.\n${offenders.join('\n')}`);
});

/**
 * Und der Router zeichnet sie nach jedem Neuaufbau der Navigation nach.
 *
 * Ohne diesen Aufruf traegt der Speicher die Zahlen zwar, aber niemand malt
 * sie hin - der zweite Teil von #868 waere zurueck, und zwar still.
 */
test('rebuildNavigation zeichnet die Nav-Zahlen nach (#868)', () => {
  const router = read('../public/router.js');
  const fn = /function rebuildNavigation\([\s\S]*?\n\}/.exec(router);
  assert.ok(fn, 'rebuildNavigation() ist nicht mehr auffindbar');
  assert.match(fn[0], /applyNavBadges\(\)/,
    'nach dem Neuaufbau der Navigation fehlen die Zahlen an den Nav-Zielen');

  // Und die Startwerte kommen aus der Antwort, die ohnehin geholt wird.
  assert.match(router, /function primeNavBadges\(/,
    'die Startwerte aus /dashboard fehlen - das Badge erschiene wieder erst '
    + 'nach dem ersten Besuch des Moduls');
  assert.match(router, /_moduleCountsAt = Date\.now\(\);\s*\n\s*primeNavBadges\(res\)/,
    'primeNavBadges haengt nicht an der /dashboard-Antwort');
});

/**
 * DAS MEHR-BLATT ZEICHNET ZUERST AUS DEM SPEICHER (#868).
 *
 * Ein Folgefehler des Fixes selbst, den erst eine Review fand: seit der
 * Shell-Aufbau die Zaehlstaende holt (fuer die Nav-Badges), stempelt er auch
 * deren TTL. Beim ersten Oeffnen des Mehr-Blattes innerhalb der naechsten 60
 * Sekunden gab `refreshModuleCounts()` deshalb `false` zurueck („nichts
 * Neues"), und die Wache darunter uebersprang das Zeichnen - die Kacheln
 * blieben leer, obwohl die Zahlen im Speicher lagen.
 *
 * Also derselbe Fehler wie der gemeldete, nur eine Ebene versetzt: eine Zahl,
 * die da ist, aber nicht gezeigt wird.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('das Mehr-Blatt zeichnet erst aus dem Speicher, dann nach (#868)', () => {
  const router = read('../public/router.js');
  const fn = /function openSheet\(\)[\s\S]*?\n  \}/.exec(router);
  assert.ok(fn, 'openSheet() ist nicht mehr auffindbar');

  const bare = fn[0].indexOf('paintMoreSheetBadges(sheet);');
  const guarded = fn[0].indexOf('if (fresh');
  assert.ok(bare !== -1,
    'das Blatt zeichnet die schon bekannten Zahlen nicht - innerhalb der TTL '
    + 'bleiben die Kacheln leer, obwohl die Zahlen im Speicher liegen');
  assert.ok(guarded !== -1 && bare < guarded,
    'das Zeichnen aus dem Speicher muss VOR dem Nachziehen stehen');
});

/**
 * DIE DREI-TAGE-GRENZE STEHT AN ZWEI ENDEN UND MUSS DIESELBE SEIN (#868).
 *
 * Der Server zaehlt sie fuer den Startwert (`birthdaySoonCount` in
 * routes/dashboard.js), der Browser fuer die laufende Aktualisierung
 * (`BIRTHDAY_BADGE_DAYS` in utils/nav-badges.js). Laufen sie auseinander,
 * springt die Zahl beim ersten Besuch der Geburtstagsseite - dieselbe Frage,
 * zwei Antworten, und keine davon sichtbar falsch.
 *
 * Guard-Ebene: Wert (aus beiden Quellen gelesen).
 */
test('Server und Browser ziehen den Geburtstags-Schnitt beim selben Tag (#868)', () => {
  const client = read('../public/utils/nav-badges.js');
  const server = read('../server/routes/dashboard.js');

  const c = /BIRTHDAY_BADGE_DAYS\s*=\s*(\d+)/.exec(client);
  assert.ok(c, 'BIRTHDAY_BADGE_DAYS ist nicht mehr auffindbar');

  const s = /birthdaySoonCount\s*=\s*hydrated\.filter\(\(b\) => \(b\.days_until \?\? \d+\) <= (\d+)\)/.exec(server);
  assert.ok(s, 'der Server-Zaehler fuer nahe Geburtstage ist nicht mehr auffindbar');

  assert.equal(s[1], c[1],
    `Der Server schneidet bei ${s[1]} Tagen, der Browser bei ${c[1]}. Die Zahl `
    + 'springt dann beim ersten Besuch der Geburtstagsseite.');
});

/**
 * DAS AUFGABEN-BADGE HAT GENAU EINE QUELLE (#868).
 *
 * `state.tasks` ist die GEFILTERTE Liste der Ansicht - der Standardfilter
 * zeigt nur `open`, das Kanban laesst den Statusfilter ganz weg, und
 * Prioritaet, Zuweisung und Tags engen weiter ein. Daraus gezaehlt sprang die
 * Zahl beim blossen Wechsel zwischen Liste und Kanban, ohne dass sich an den
 * Daten etwas geaendert haette: die zweite Wahrheit, die dieser Fix
 * eigentlich abschafft, eine Ebene tiefer.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('das Aufgabenmodul zaehlt sein Badge nicht selbst (#868)', () => {
  const tasks = read('../public/pages/tasks.js');
  assert.doesNotMatch(tasks, /setNavBadge\s*\(/,
    'das Aufgabenmodul schreibt wieder direkt in den Badge-Slot - seine '
    + 'Liste ist gefiltert und kann die Frage nicht beantworten');
});

/**
 * UND DIE MELDUNG HAENGT AM SCHREIBEN, NICHT AM ZEICHNEN (#868).
 *
 * Eine erste Fassung meldete aus `updateOverdueBadge()`, und das ruft jedes
 * `renderTaskList()` - also auch jeder Tastenanschlag in der Suche, jeder
 * Filter- und jeder Ansichtswechsel. Jede Tipppause laenger als der
 * Entprellzeitraum stiess damit eine vollstaendige Dashboard-Aggregation an,
 * ohne dass sich an den gezaehlten Daten irgendetwas geaendert haette.
 *
 * Sie steht deshalb in der API-Schicht, die ohnehin jeder Schreibvorgang
 * durchlaeuft - eine Stelle statt siebzehn Schreibpfaden allein im
 * Aufgabenmodul, von denen der achtzehnte vergessen wuerde.
 *
 * Guard-Ebene: Struktur (aus dem Quelltext gelesen).
 */
test('die Zaehler-Meldung haengt am Schreiben, nicht am Rendern (#868)', () => {
  const api = read('../public/api.js');
  const fn = /function notifyCountedMutation\(path\)[\s\S]*?\n\}/.exec(api);
  assert.ok(fn, 'notifyCountedMutation ist nicht mehr auffindbar');
  assert.match(fn[0], /invalidateModuleCounts/,
    'die Meldung erreicht den Zaehlstand nicht');
  assert.match(api, /if \(stateChanging\) notifyCountedMutation\(path\);/,
    'sie haengt nicht mehr am schreibenden Request');

  // Und die Render-Pfade melden NICHT mehr.
  const tasks = read('../public/pages/tasks.js');
  assert.doesNotMatch(tasks, /invalidateModuleCounts/,
    'das Aufgabenmodul meldet wieder selbst - dann haengt die Meldung am '
    + 'Rendern und feuert bei jedem Tastenanschlag in der Suche');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Der schmale Zustand der Kueche steht HINTER seinem Bauteil
 *
 * Zweimal dieselbe Falle in derselben Datei: `display: none` fuer die leeren
 * Slots stand im fruehen 640px-Block, die `.meal-slot`-Basisregel
 * (display: flex) kam spaeter - bei gleicher Spezifitaet gewinnt die spaetere
 * Regel, und der gestrichelte Slot stand mobil wieder neben dem .day-add.
 * Etappe E (v2.24.1) hat den Fall fuer flex-direction/add-more-btn behoben
 * und als Don't in DESIGN.md dokumentiert; die empty-Slot-Ausblendung kehrte
 * trotzdem in den fruehen Block zurueck (Critique 2026-08-27, gemessen:
 * 1 leerer Slot sichtbar bei 375px). Ein Fehler, der zweimal kam, kommt
 * dreimal - deshalb hier die REIHENFOLGE als Zusicherung, ueber eachRule()
 * statt Zeilennummern: die letzte display-Regel, die einen leeren Slot
 * treffen kann, muss die Ausblendung sein.
 * ──────────────────────────────────────────────────────────────────────────── */
test('der schmale Zustand der Kueche steht hinter seinem Bauteil', () => {
  const css = read('../public/styles/meals.css');
  let lastEmptyNone = -1;
  let lastSlotDisplay = -1;
  let i = 0;
  for (const rule of eachRule(css)) {
    i += 1;
    if (!/display\s*:/.test(rule.body ?? rule.declarations ?? '')) continue;
    const sels = String(rule.selector).split(',').map((s) => s.trim());
    if (sels.some((s) => /\.meal-slot--empty(?![\w-])/.test(s))
      && /display\s*:\s*none/.test(rule.body ?? rule.declarations ?? '')) {
      lastEmptyNone = i;
    } else if (sels.some((s) => /\.meal-slot(?![\w-])/.test(s))) {
      lastSlotDisplay = i;
    }
  }
  assert.ok(lastEmptyNone > -1, 'meals.css blendet die leeren Slots nicht mehr aus '
    + '(.meal-slot--empty { display: none } fehlt) - mobil stapeln sich dann wieder '
    + 'bis zu 28 gestrichelte Anlege-Boxen neben dem .day-add');
  assert.ok(lastSlotDisplay === -1 || lastEmptyNone > lastSlotDisplay,
    'die Ausblendung der leeren Slots steht VOR einer spaeteren .meal-slot-display-Regel '
    + `(Regel ${lastEmptyNone} vs. ${lastSlotDisplay}) - bei gleicher Spezifitaet gewinnt `
    + 'die spaetere Regel, und der leere Slot ist mobil wieder sichtbar (DESIGN.md, Don\'t '
    + '"eine Regel in einen Media-Block schreiben, der VOR den Bauteilen steht")');
});

/* ────────────────────────────────────────────────────────────────────────────
 * WER EINEN WEG SCHLIESST, MUSS DEN ERSATZWEG NACHWEISEN (#925)
 *
 * tasks.css blendet `.task-card__inline-action` unter 640px aus - mit guter
 * Begruendung (HIG-Dichte: drei 44px-Knoepfe quetschten den Titel zweizeilig).
 * Der gedachte Ersatz stand im Kommentar daneben: "Tippen oeffnet die
 * Lese-Ansicht (mit allen Aktionen)". Nur stimmte das nicht fuer alle: die
 * Leseansicht rendert ihren Unteraufgaben-Abschnitt bis v2.52.0 nur, wenn es
 * schon Unteraufgaben GAB. Der Knopf fuer die ERSTE hing damit ausschliesslich
 * an der Karte - und die blendet ihn auf dem Telefon aus. Auf dem iPad ging es,
 * auf dem iPhone nicht, und jede weitere Unteraufgabe ging wieder (#925).
 *
 * Der Guard prueft die Kopplung, nicht die Schreibweise: er liest die Aktionen
 * aus dem KARTEN-Markup, nicht aus einer Liste hier, und verlangt fuer jede
 * einen Aufruf im Detail-Pfad. Eine vierte Inline-Aktion faellt hier auf,
 * solange sie keinen Touch-Weg mitbringt - und die Zuordnung darunter muss sie
 * benennen, sonst ist der Test rot, statt sie stillschweigend durchzulassen.
 *
 * Guard-Ebene: Struktur (aus Quelltext und Stylesheet gelesen).
 * ──────────────────────────────────────────────────────────────────────────── */
test('jede auf Touch ausgeblendete Karten-Aktion hat einen Weg in der Leseansicht (#925)', () => {
  const page   = read('../public/pages/tasks.js');
  const detail = read('../public/components/task-detail.js');
  const css    = read('../public/styles/tasks.css');

  // 1. Blendet das Stylesheet die Inline-Aktionen ueberhaupt aus? Nur dann
  //    entsteht die Luecke - faellt die Regel weg, ist der Guard gegenstandslos
  //    und sagt das, statt eine Zusicherung ueber nichts zu geben.
  const hidesOnNarrow = [...eachRule(css)].some(({ selector, body, at }) =>
    /\.task-card__inline-action(?![\w-])/.test(selector)
    && /display\s*:\s*none/.test(body)
    && at.some((pre) => /max-width\s*:\s*639px/.test(pre)));
  assert.ok(hidesOnNarrow,
    'tasks.css blendet .task-card__inline-action nicht mehr unter 640px aus - '
    + 'entweder ist die Regel umgezogen (dann muss dieser Guard mit) oder die '
    + 'Karte zeigt ihre Aktionen jetzt auch auf dem Telefon');

  // 2. Welche Aktionen bietet die Karte inline an? Aus dem Markup gelesen.
  //    Der Ablage-Knopf traegt seine beiden Namen in einem Template-Ausdruck
  //    (`${archived ? 'unarchive-task' : 'archive-task'}`), deshalb wird der
  //    Attributwert nach Literalen abgesucht statt als eines genommen - ein
  //    Muster, das nur nackte Werte kennt, uebersaehe genau die zwei.
  const actions = new Set(
    [...page.matchAll(/task-card__inline-action[^>]*?data-action="([^"]+)"/g)]
      .flatMap((m) => (m[1].includes('${')
        ? [...m[1].matchAll(/'([a-z][a-z-]*)'/g)].map((lit) => lit[1])
        : [m[1]])),
  );
  assert.ok(actions.size >= 3,
    `nur ${actions.size} Inline-Aktionen gefunden - das Muster im Guard passt nicht mehr `
    + 'auf das Karten-Markup und wuerde jede Luecke uebersehen');

  // 3. Und wo faengt die Leseansicht sie auf? Der Wert ist der Aufruf, der die
  //    Handlung im Detail-Pfad ausloest.
  const TOUCH_PATH = {
    'add-subtask':     'addSubtask(',
    'edit-task':       'wireTaskForm(',
    'archive-task':    'toggleTaskArchive(',
    'unarchive-task':  'toggleTaskArchive(',
  };

  // Der Detail-Pfad: die Ansicht selbst und die Knoten, die sie baut. Ab
  // `function subtaskListNode` bis zum Ende von `openTaskDetail` liegen beide.
  // Sie wohnen seit #918 in der geteilten Komponente - genau darum greift der
  // Ersatzweg jetzt auch dort, wo die Aufgabe aus der Uebersicht geoeffnet wird.
  const detailStart = detail.indexOf('function subtaskListNode(');
  const detailEnd   = detail.indexOf('async function advanceTaskStatus(');
  assert.ok(detailStart > -1 && detailEnd > detailStart,
    'der Detail-Pfad (subtaskListNode ... openTaskDetail) ist nicht mehr auffindbar - '
    + 'der Guard misst sonst die falsche Datei-Haelfte');
  // Das Bearbeiten-Formular gehoert dem Modul und wird der Ansicht gereicht
  // (#918); der Mount-Block ist deshalb Teil desselben Wegs.
  const mountStart = page.indexOf('function openTaskView(');
  const mountEnd   = page.indexOf('export async function openTaskById(');
  assert.ok(mountStart > -1 && mountEnd > mountStart,
    'der Mount-Block des Bearbeiten-Formulars ist nicht mehr auffindbar');
  const detailPath = detail.slice(detailStart, detailEnd) + page.slice(mountStart, mountEnd);

  for (const action of actions) {
    const call = TOUCH_PATH[action];
    assert.ok(call,
      `die Karte bietet "${action}" inline an, und dieser Guard kennt den Ersatzweg nicht. `
      + 'Unter 640px ist der Knopf weg: entweder traegt die Leseansicht die Handlung mit '
      + '(dann gehoert sie in TOUCH_PATH) oder es gibt sie auf dem Telefon nicht');
    assert.ok(detailPath.includes(call),
      `"${action}" verschwindet unter 640px, und der Detail-Pfad ruft ${call} nicht - `
      + 'auf dem Telefon gibt es dann keinen Weg zu dieser Handlung (genau #925)');
  }

  // 4. Und der Aufruf muss ERREICHBAR sein, nicht bloss dastehen. Die erste
  //    Fassung dieses Guards endete bei Schritt 3 und blieb gruen, als die
  //    Gegenprobe den Abschnitt wieder auf `if (!task.subtasks?.length) return
  //    null` zurueckdrehte: der Add-Block stand noch im Quelltext, nur lief er
  //    nie. Genau der Zustand von #925 - der Weg existiert und ist zu.
  //
  //    Messbar ist die Regel dahinter: ein Abschnitt darf nur wegfallen, wenn
  //    er auch nichts ANZUBIETEN hat. Die Bedingung, die den Add-Knopf gattert,
  //    muss deshalb im Frueh-Ausstieg mitgelesen werden.
  const nodeFn = /function subtaskListNode\([\s\S]*?\n\}/.exec(detail);
  assert.ok(nodeFn, 'subtaskListNode ist nicht mehr auffindbar');
  const gate = /^\s*const (\w+) = [^\n]*canEditTaskDefinition\(task[,)]/m.exec(nodeFn[0]);
  assert.ok(gate,
    'subtaskListNode gattert den Anlege-Weg nicht mehr an canEditTaskDefinition - '
    + 'entweder darf jetzt jeder anlegen, oder der Knopf ist weg (#925)');
  const bail = /if \([^)]*\)\s*return null;/.exec(nodeFn[0]);
  assert.ok(bail, 'der Frueh-Ausstieg von subtaskListNode ist nicht mehr auffindbar');
  assert.ok(bail[0].includes(gate[1]),
    `der Abschnitt steigt bei leerer Liste aus, ohne "${gate[1]}" zu lesen - dann faellt er `
    + 'auch dann weg, wenn er den Anlege-Knopf zu zeigen haette, und auf dem Telefon '
    + 'gibt es keinen Weg zur ERSTEN Unteraufgabe (#925)');
  assert.ok(new RegExp(`if \\(${gate[1]}\\)`).test(nodeFn[0]),
    `der Anlege-Knopf haengt nicht mehr an "${gate[1]}" - der Guard misst dann eine `
    + 'Bedingung, die den Knopf gar nicht mehr gattert');
});

/**
 * DER AUSSCHNITT VON `createIcons({ el })` IST GELIEHEN, NICHT EINGEBAUT.
 *
 * Über zweihundert Aufrufstellen übergeben `{ el }` und nehmen an, nur unter
 * diesem Knoten werde gezeichnet. Die gebündelte Lucide-Fassung kennt den
 * Parameter nicht - sie sucht `[data-lucide]` im ganzen Dokument, egal was man
 * ihr übergibt. Erst `public/lucide-scope.js` biegt die Funktion um (Audit
 * 2026-08-31, P2); ohne diese Datei ist der Parameter genau die Lüge, für die
 * ihn beim Lesen jeder hält.
 *
 * Der Patch hängt an einer Reihenfolge, die man ihm nicht ansieht: er steigt
 * still aus, wenn `window.lucide` bei seinem Lauf noch fehlt. Rutscht er vor
 * das Bundle, verliert er sein `defer` oder fällt er ganz weg, dann fallen alle
 * Aufrufstellen gleichzeitig auf den Volldokument-Scan zurück - ohne Fehler,
 * ohne sichtbaren Unterschied, nur langsamer. Ein Kommentar kann das nicht
 * halten, weil ihn die Datei, die ihn bricht, gar nicht enthält.
 */
test('der Lucide-Ausschnitt läuft nach dem Bundle und vor jedem Modul, das ihn braucht', () => {
  const scope = read('../public/lucide-scope.js');

  // Reichweiten-Nachweis: ohne Aufrufer prüft dieser Guard nichts.
  const callers = walkJsFiles('../public/')
    .filter((file) => !/lucide(\.min)?\.js$/.test(file) && !file.includes('/vendor/'))
    .filter((file) => /createIcons\(\{\s*el/.test(read(file)));
  assert.ok(callers.length >= 30,
    `Nur ${callers.length} Dateien rufen createIcons({ el }) - das Muster greift nicht mehr`);

  // Der Patch muss tun, was die Aufrufstellen annehmen: unter `el` bleiben.
  assert.match(scope, /lucide\.createIcons\s*=/,
    'lucide-scope.js biegt createIcons nicht mehr um - der el-Parameter ist dann wieder wirkungslos');
  assert.match(scope, /\bel\.querySelectorAll\(/,
    'lucide-scope.js sucht nicht mehr unter `el` - dann ist der Ausschnitt keiner');

  // Durchgehend `i`: Tagnamen und Attribute sind in HTML gross-/kleinschreibungs-
  // egal, `<SCRIPT SRC=... DEFER>` ist gueltig. Ohne das Flag faende dieser Guard
  // eine grossgeschriebene Fassung nicht und waere gruen, ohne etwas geprueft zu
  // haben - genau der blinde Zustand, den er verhindern soll (CodeQL js/bad-tag-filter).
  //
  // Und ohne Kommentare: ein auskommentiertes `<script src="/lucide-scope.js">`
  // steht weiter im Rohtext und laedt nichts. Jede Zusicherung hier unten waere
  // erfuellt, waehrend der Patch in Wahrheit fehlt.
  const scripts = [...withoutHtmlComments(read('../public/index.html')).matchAll(/<script\b[^>]*>/gi)]
    .map((m) => ({ tag: m[0], src: m[0].match(/\bsrc=["']([^"']+)["']/i)?.[1] }))
    .filter((s) => s.src);
  const isModule = (s) => /\btype=["']module["']/i.test(s.tag);
  // `async` schlaegt `defer`: das Skript laeuft, sobald es da ist, in keiner
  // festen Reihenfolge. Nur ein rein deferred Skript haelt seinen Platz.
  const isDeferred = (s) => /\bdefer\b/i.test(s.tag) && !/\basync\b/i.test(s.tag);

  const positionsOf = (src) => scripts.flatMap((s, i) => (s.src === src ? [i] : []));
  const bundleAt = positionsOf('/lucide.min.js');
  const patchAt = positionsOf('/lucide-scope.js');
  assert.ok(bundleAt.length > 0, 'index.html lädt /lucide.min.js nicht mehr');
  assert.ok(patchAt.length > 0,
    'index.html lädt /lucide-scope.js nicht mehr - createIcons({ el }) durchsucht dann wieder '
    + 'das ganze Dokument, und zwar an allen Aufrufstellen auf einmal');
  // Genau einmal, und das ist keine Formalie: ein zweites Bundle-Tag NACH dem
  // Patch laedt das UMD erneut und ersetzt `window.lucide` samt gepatchtem
  // createIcons. Reihenfolge und defer stimmten weiter, der Ausschnitt waere weg.
  assert.deepEqual([bundleAt.length, patchAt.length], [1, 1],
    'lucide.min.js und lucide-scope.js stehen nicht mehr genau einmal in index.html. '
    + 'Ein zweites Bundle-Tag hinter dem Patch ueberschreibt window.lucide und damit den Patch');
  const [bundle] = bundleAt;
  const [patch] = patchAt;
  assert.ok(patch > bundle,
    'lucide-scope.js steht vor lucide.min.js. Es findet `window.lucide` dann noch nicht und '
    + 'steigt still aus - der Ausschnitt ist wirkungslos, ohne dass irgendwo etwas bricht');

  // Beide rein deferred: ohne `defer` liefe der Patch sofort beim Parsen, mit
  // `async` in unbestimmter Reihenfolge. Beides endet im selben stillen
  // Ausstieg, weil `window.lucide` dann noch nicht da ist.
  for (const i of [bundle, patch]) {
    assert.ok(isDeferred(scripts[i]),
      `${scripts[i].src} ist nicht mehr rein deferred (defer, kein async) - die Reihenfolge `
      + 'zwischen Bundle und Patch ist damit nicht mehr garantiert');
  }

  // Nicht-async-Module und defer-Skripte teilen sich EINE Warteschlange und
  // laufen in Dokumentreihenfolge - Module sind keine spaetere Phase. Ein Modul
  // vor dem Patch bekaeme beim ersten createIcons noch das ungepatchte Original.
  assert.deepEqual(
    scripts.filter((s, i) => i < patch && isModule(s)).map((s) => s.src), [],
    'Diese Module stehen in index.html vor lucide-scope.js und laufen damit vor dem Patch');

  // WER LAEUFT VOR DEM PATCH? Zwei Wege, und die Tag-Position beantwortet nur
  // den einen. Ein klassisches Skript ohne `defer` blockiert den Parser und
  // laeuft SOFORT an seiner Stelle, also vor jedem deferred Skript - auch wenn
  // sein Tag hinter dem Patch steht. Ein deferred Skript oder Modul haelt
  // dagegen seinen Platz in der Warteschlange und ist nur dann zu frueh, wenn
  // es vor dem Patch steht. Die erste Fassung filterte nur nach Position und
  // war fuer den ersten Fall blind.
  const runsBeforePatch = (s, i) => (!isDeferred(s) && !isModule(s)) || i < patch;
  const early = scripts
    // Bundle und Patch selbst rufen nicht auf, sie definieren bzw. ersetzen.
    .filter((s, i) => runsBeforePatch(s, i) && i !== bundle && i !== patch)
    .filter((s) => existsSync(new URL(`../public${s.src}`, import.meta.url)))
    .filter((s) => /createIcons/.test(read(`../public${s.src}`)));
  assert.deepEqual(early.map((s) => s.src), [],
    'Diese Skripte laufen vor dem Patch und rufen createIcons - der Aufruf ist dort ungescopt');
});

/* ============================================================
 * PAGE COMPOSITION SYSTEM - PAGE-001 ... PAGE-011
 * (docs/PAGE-COMPOSITION.md)
 * ============================================================ */

const COMPOSITION_MODES = ['reading', 'data', 'dashboard', 'form', 'split', 'full'];

/**
 * WER GEPRUEFT WIRD, STEHT IN KEINER LISTE.
 *
 * Die erste Fassung dieses Blocks fuehrte eine Allowlist migrierter Seiten: nur
 * wer darin stand, wurde geprueft. Eine neue Seite waere still durchgefallen -
 * sie stand in keiner der beiden Listen, und jede Schleife begann mit
 * `if (!MIGRATED.has(name)) continue;`. Genau dieselbe Bauart hat die Codebasis
 * schon zweimal bezahlt (Kuechen-Zusammenfuehrung, Budget-Guards): eine
 * Allowlist deckt die Dateien ab, an die jemand gedacht hat, eine Regel deckt
 * das Problem ab.
 *
 * Der Geltungsbereich kommt deshalb aus `router.js`. Eine Route mit
 * `requiresAuth: false` zeichnet ohne App-Shell (Login, Setup, Einladung,
 * Passwort-Reset) und kann den Vertrag nicht erfuellen; alles andere steht
 * dahinter und muss ihn erfuellen. Eine morgen angelegte Seite ist an dem Tag
 * erfasst, an dem sie eine Route bekommt.
 */
function routerPageRows() {
  const router = read('../public/router.js');
  const rows = [...router.matchAll(
    /page:\s*'\/pages\/([\w-]+)\.js'[^}]*?requiresAuth:\s*(true|false)/g)]
    .map((r) => ({ name: `${r[1]}.js`, auth: r[2] === 'true' }));
  // DER AUSDRUCK MUSS SELBST ETWAS GELESEN HABEN, bevor das Dateisystem dazu
  // kommt. Sonst kippt der Geltungsbereich beim Tod des Ausdrucks nicht auf
  // null, sondern auf ALLES: `standalone` ist leer, die Schleife unten nimmt
  // jede Datei, Login und Setup eingeschlossen, und jede `>=`-Untergrenze in
  // PAGE-000 bleibt gruen - der Nachweis haette den Fall, fuer den er
  // geschrieben wurde, nie gesehen (claude-review, zweite Runde an #995).
  if (!rows.some((r) => !r.auth)) {
    throw new Error('Der Router-Ausdruck liest keine Route mit requiresAuth: false mehr - '
      + 'hat sich die Routentabelle in public/router.js umformatiert?');
  }
  return rows;
}

function pagesBehindAppShell() {
  const rows = routerPageRows();
  const shell = new Set(rows.filter((r) => r.auth).map((r) => r.name));
  const standalone = new Set(rows.filter((r) => !r.auth).map((r) => r.name));
  // Unterseiten ohne eigene Route (budget-stats, split-expenses ...) werden von
  // einer App-Route nachgeladen und gehoeren damit ebenfalls hinter die Shell.
  for (const file of walkJsFiles('../public/pages/')) {
    const name = file.split('/').pop();
    if (!standalone.has(name)) shell.add(name);
  }
  return [...shell].sort();
}

/**
 * NOCH NICHT MIGRIERT - DIESE LISTE DARF NUR SCHRUMPFEN.
 *
 * Jeder Eintrag ist eine Seite, die es vor den Vertrag geschafft hat. Migrieren
 * heisst: Zeile loeschen. PAGE-011 wird rot, wenn die Liste waechst, und ebenso,
 * wenn ein Eintrag auf eine Seite zeigt, die es nicht mehr gibt - sonst haelt
 * eine tote Zeile eine Ausnahme offen, die niemand mehr braucht.
 */
const COMPOSITION_PENDING = new Set([
  'shopping.js',
  'meals.js',
  'settings.js',
]);

/** Stand bei Einfuehrung der Regel. Nach unten anpassen, nie nach oben. */
const COMPOSITION_PENDING_MAX = 3;

function compositionScope() {
  return pagesBehindAppShell().filter((name) => !COMPOSITION_PENDING.has(name));
}

/** Seiten-CSS im Geltungsbereich; Unterseiten ohne eigene Datei fallen raus. */
function compositionScopeCss() {
  return compositionScope()
    .map((name) => name.replace(/\.js$/, '.css'))
    .filter((css) => existsSync(new URL(`../public/styles/${css}`, import.meta.url)));
}

const COMPOSITION_BLACKLIST_WIDTH = /max-width\s*:\s*(?!none|100%|var\(--(?:page-measure|layout-|content-max-width))[0-9.]+(?:px|rem|em|vw)/i;
// Auch `calc(-1 * var(--x))` und `-.5rem` sind negative Margen - die erste
// Fassung verlangte `-` plus Ziffer direkt nach dem Doppelpunkt und sah damit
// genau das Idiom nicht, das dieses Repo benutzt (auch .page-section--bleed
// selbst). Ein Guard, der sein eigenes Beispiel nicht faengt, prueft nichts.
const COMPOSITION_NEGATIVE_MARGIN = /margin(?:-inline|-left|-right|-inline-start|-inline-end)?\s*:\s*(?:-[0-9.]|calc\(\s*-)/i;

test('PAGE-000: der Geltungsbereich ist nicht leer und deckt fast alle Seiten', () => {
  // REICHWEITEN-NACHWEIS. Ohne ihn koennte jede Regel darunter gruen sein, weil
  // sie ueber null Dateien laeuft - ein Tippfehler im Router-Regex genuegt.
  const rows = routerPageRows();
  const standalone = rows.filter((r) => !r.auth).length;
  assert.ok(rows.length >= 20,
    `Der Router-Ausdruck liest nur ${rows.length} Routen - ohne ihn kommt der Bereich aus dem Dateisystem und ist zu GROSS, nicht leer`);
  assert.ok(standalone >= 4,
    `Nur ${standalone} Routen ohne App-Shell erkannt (Login, Setup, Einladung, Reset) - der Ausdruck liest requiresAuth nicht mehr`);
  const shell = pagesBehindAppShell();
  const scope = compositionScope();
  const all = walkJsFiles('../public/pages/').length;
  assert.ok(shell.length >= 20,
    `Nur ${shell.length} Seiten hinter der App-Shell erkannt - liest der Router-Ausdruck noch?`);
  assert.ok(!shell.includes('login.js') && !shell.includes('setup.js'),
    'Login und Setup zeichnen ohne App-Shell und gehoeren nicht in den Geltungsbereich');
  assert.ok(scope.length >= 15,
    `Nur ${scope.length} Seiten im Geltungsbereich - die Regeln pruefen fast nichts`);
  assert.ok(scope.length >= all - 8,
    `${all - scope.length} von ${all} Seiten sind ausgenommen - das ist wieder eine Allowlist`);
  assert.ok(compositionScopeCss().length >= 12,
    'Zu wenige Seiten-CSS im Geltungsbereich - die CSS-Regeln laufen ins Leere');
});

test('PAGE-011: die Ausnahmeliste waechst nicht und enthaelt nur echte Seiten', () => {
  assert.ok(COMPOSITION_PENDING.size <= COMPOSITION_PENDING_MAX,
    `Die Ausnahmeliste ist auf ${COMPOSITION_PENDING.size} gewachsen (erlaubt: `
    + `${COMPOSITION_PENDING_MAX}). Eine neue Seite gehoert nicht auf diese Liste, `
    + 'sie erfuellt den Vertrag von Anfang an.');
  assert.equal(COMPOSITION_PENDING.size, COMPOSITION_PENDING_MAX,
    `Es sind nur noch ${COMPOSITION_PENDING.size} Ausnahmen - setze `
    + `COMPOSITION_PENDING_MAX auf ${COMPOSITION_PENDING.size} herunter, sonst haelt `
    + 'der Guard Platz frei, den niemand mehr braucht.');
  const shell = new Set(pagesBehindAppShell());
  for (const name of COMPOSITION_PENDING) {
    assert.ok(existsSync(new URL(`../public/pages/${name}`, import.meta.url)),
      `PAGE-011: ${name} steht auf der Ausnahmeliste, die Datei gibt es nicht mehr`);
    assert.ok(shell.has(name),
      `PAGE-011: ${name} liegt nicht hinter der App-Shell und braucht keine Ausnahme`);
  }
});

test('PAGE-001: every page behind the app shell declares exactly one composition mode', () => {
  for (const name of compositionScope()) {
    const src = withoutHtmlComments(read(`../public/pages/${name}`));
    const found = COMPOSITION_MODES.filter((mode) =>
      new RegExp(`app-page--${mode}|data-composition="${mode}"|mode:\\s*'${mode}'`).test(src));
    // Compat: page-measure--narrow alone counts as reading until aliases retire.
    if (/page-measure--narrow/.test(src) && !found.includes('reading')) found.push('reading');
    assert.ok(found.length >= 1, `PAGE-001 ${name}: must declare a composition mode`);
    assert.equal(found.length, 1,
      `PAGE-001 ${name}: exactly one mode expected, found ${found.join(',')}`);
  }
});

test('PAGE-002: PageHeader and PageBody share composition context', () => {
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.app-page--reading[\s\S]*?--page-measure:\s*var\(--layout-reading\)/,
    'PAGE-002: reading mode must set --page-measure');
  assert.match(layout, /\.page-measure--narrow[\s\S]*?--page-measure:\s*var\(--layout-reading\)|\.app-page--reading,\s*\n\.app-page--form,\s*\n\.page-measure--narrow/,
    'PAGE-002: compat alias and reading mode share --page-measure');
  // Budget KPI band must read the page measure (Header/Body axis).
  assert.match(layout, /\.page-measure--narrow :is\([\s\S]*?\.metric-grid/,
    'PAGE-002: .metric-grid must share the reading measure with header/list');
  // Und der Abstand ZWISCHEN Kopf und Koerper ist Teil desselben Kontexts:
  // birthdays.css gab sein `gap` an die Seite ab, die Seite hatte keines.
  assert.match(layout, /\.app-page:has\(> \.app-page__body\)\s*\{[^}]*gap:\s*var\(--space-3\)/,
    'PAGE-002: .app-page must space toolbar and .app-page__body - the module CSS no longer does');
});

test('PAGE-003: primary content must not define arbitrary width', () => {
  for (const name of compositionScope()) {
    const src = withoutBlockComments(read(`../public/pages/${name}`));
    // Geprueft wird der WERT von max-width, nicht das ganze style-Attribut:
    // mit `style="width:100%;max-width:843px"` liess der Treffer auf `100%`
    // weiter vorn die 843px durch.
    const hits = [...src.matchAll(/style\s*=\s*["'][^"']*?max-width\s*:\s*([^;"']+)/gi)];
    for (const hit of hits) {
      assert.ok(/var\(--(?:page-measure|layout-|content-max-width)/.test(hit[1]) || /^\s*(?:100%|none)\s*$/.test(hit[1]),
        `PAGE-003 ${name}: arbitrary inline max-width - ${hit[1]}`);
    }
  }
  for (const file of compositionScopeCss()) {
    const css = withoutBlockComments(read(`../public/styles/${file}`));
    for (const rule of eachRule(css)) {
      if (!COMPOSITION_BLACKLIST_WIDTH.test(rule.body)) continue;
      if (/--layout-|--page-measure|--content-max-width/.test(rule.body)) continue;
      // Component-internal widths (chips, avatars, icons) are fine; page roots are not.
      if (/\.(?:app-page|[\w-]+-page)\b/.test(rule.selector)) {
        assert.fail(`PAGE-003 ${file}: page-level arbitrary width in ${rule.selector}`);
      }
    }
  }
});

test('PAGE-004: layout width tokens exist and are wired', () => {
  const tokens = read('../public/styles/tokens.css');
  assert.match(tokens, /--layout-reading:\s*var\(--content-max-width-narrow\)/,
    'PAGE-004: --layout-reading');
  assert.match(tokens, /--layout-content:\s*60rem/,
    'PAGE-004: --layout-content');
  assert.match(tokens, /--layout-wide:\s*75rem/,
    'PAGE-004: --layout-wide');
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.app-page\s*\{/, 'PAGE-004: .app-page primitive');
  assert.match(layout, /\.page-measure\s*\{/, 'PAGE-004: .page-measure primitive');
  assert.match(layout, /\.page-section--bleed\s*\{/, 'PAGE-004: bleed primitive');
  assert.ok(existsSync(new URL('../public/utils/page-layout.js', import.meta.url)),
    'PAGE-004: page-layout.js must exist');
});

// Die geteilte Breakpoint-Skala, wie sie im Repo tatsaechlich steht: jede
// Stufe als max-width (639) und als min-width (640) - gemessen ueber alle
// public/styles/*.css, 121 Media-Queries, keine einzige daneben. Die erste
// Fassung dieses Guards fuehrte 640/768/900/1024/1440 als Skala und liess
// zusaetzlich alles unter 600 durch; damit war `@media (max-width: 637px)`,
// das eigene Beispiel der Spec, gerade NICHT gefangen.
const COMPOSITION_BREAKPOINT_SCALE = new Set([639, 640, 767, 768, 1023, 1024, 1439, 1440]);

test('PAGE-005: pages in scope avoid local page-geometry breakpoints', () => {
  let seen = 0;
  for (const file of compositionScopeCss()) {
    const css = withoutBlockComments(read(`../public/styles/${file}`));
    const widths = [...css.matchAll(/@media[^{]*?\(\s*(?:min|max)-width\s*:\s*([0-9.]+)(px|rem|em)\s*\)/g)];
    seen += widths.length;
    const odd = widths
      .filter(([, value, unit]) => unit !== 'px' || !COMPOSITION_BREAKPOINT_SCALE.has(Number(value)))
      .map(([, value, unit]) => `${value}${unit}`);
    assert.deepEqual(odd, [],
      `PAGE-005 ${file}: breakpoints off the shared scale: ${odd.join(', ')} - a page does not own its own breakpoints`);
  }
  assert.ok(seen >= 40, `PAGE-005: only ${seen} media queries seen in scope - the scan is blind`);
});

test('PAGE-006: page-level negative margins are prohibited in scope', () => {
  // Negative Margen an Bauteilen INNERHALB einer Seite sind erlaubt (ein Chip,
  // der seinen Rand ausgleicht); an der Seitenwurzel oder einem `*-page`-Traeger
  // kompensieren sie Geometrie, die dem Kern gehoert. Gezaehlt wird, was die
  // Regex ueberhaupt sieht: sieht sie nichts, prueft die Schleife nichts.
  let seen = 0;
  for (const file of compositionScopeCss()) {
    const css = withoutBlockComments(read(`../public/styles/${file}`));
    for (const rule of eachRule(css)) {
      if (!COMPOSITION_NEGATIVE_MARGIN.test(rule.body)) continue;
      seen++;
      if (/\.page-section--bleed/.test(rule.selector)) continue;
      if (/\.(?:app-page|[\w-]+-page)\b/.test(rule.selector)) {
        assert.fail(`PAGE-006 ${file}: page-level negative margin in ${rule.selector}`);
      }
    }
  }
  assert.ok(seen >= 3,
    `PAGE-006: the regex matched only ${seen} negative margins in scope - it no longer sees the calc(-1 * ...) idiom`);
});

test('PAGE-007: page-layout helpers export the contract surface', () => {
  const src = read('../public/utils/page-layout.js');
  for (const name of [
    'COMPOSITION_MODES',
    'compositionModeClass',
    'renderAppPage',
    'renderPageHeader',
    'renderPageTitle',
    'renderPageActions',
    'renderPageBody',
    'renderPageSection',
    'renderListSection',
    'renderMetricBand',
  ]) {
    assert.match(src, new RegExp(`export (?:const|function) ${name}`),
      `PAGE-007: missing export ${name}`);
  }
  assert.match(src, /COMPOSITION_MODES = Object\.freeze\(\[\s*'reading'/,
    'PAGE-007: modes must include reading');
});

test('PAGE-006b: a page without a measure does not narrow its header', () => {
  // `.page-toolbar--narrow` zieht das Zeilenende des Kopfes auf --page-measure.
  // In `full` und `split` gibt es dieses Mass nicht (`--page-measure: 100%`),
  // der Koerper laeuft ueber die Nutzbreite. Ein statisch gesetzter Modifier
  // faellt dort auf den Rueckfall (720px) zurueck und der Kopf endet neben
  // seinem Koerper - so kam #929 bei den Notizen an: Kopf bei 720px, das
  // Masonry-Raster daneben bis fuenf Spalten breit. Wer je Ansicht toggelt
  // (Kalender), wird oben unter der Kopplungsregel geprueft, nicht hier.
  let checked = 0;
  for (const file of compositionScope()) {
    const src = read(`../public/pages/${file}`);
    if (!/app-page--(?:full|split)\b|data-composition="(?:full|split)"|mode:\s*'(?:full|split)'/.test(src)) continue;
    checked++;
    const heads = [...src.matchAll(/class="([^"]*\bpage-toolbar\b[^"]*)"/g)].map((m) => m[1]);
    for (const classList of heads) {
      assert.ok(!/\bpage-toolbar--narrow\b/.test(classList),
        `PAGE-006b ${file}: "${classList}" narrows the header on a page whose body has no measure`);
    }
  }
  assert.ok(checked >= 2, `PAGE-006b: only ${checked} full/split pages found - calendar and notes should be two`);
});

test('PAGE-007b: a header keeps its slots as direct children, whatever the options', async () => {
  // Das Absender-Siegel und der Dock-Titel suchen `:scope > .page-toolbar__title`
  // (ux.js), die Large-Title-Regeln `.page-toolbar > .page-toolbar__title`
  // (typography.css). Ein Wrapper um die Slots macht beides blind - auf
  // /birthdays fehlten Siegel und Dock-Titel, weil `measured` den Titel eine
  // Ebene tiefer legte. Runde eins an #995 nahm den Rail fuer `narrow` heraus
  // und liess ihn ohne `narrow` als "echte Box" stehen; Runde sechs (Codex)
  // fand, dass die Box den Titel genauso versteckt - und die Kombination war
  // dokumentiert. Der Helper darf in KEINER Kombination einen Wrapper bauen:
  // zwischen der Leiste und ihrem Titel steht nichts.
  const { renderPageHeader } = await import('../public/utils/page-layout.js');
  const slots = {
    title: '<h1 class="page-toolbar__title">T</h1>',
    center: '<div class="page-search"></div>',
    actions: '<div class="page-toolbar__actions"></div>',
  };
  const direct = [slots.title, slots.center, slots.actions].join('\n');
  for (const opts of [{}, { narrow: true }, { narrow: false }, { measured: true, narrow: false }, { measured: true }]) {
    const html = renderPageHeader({ ...slots, ...opts });
    const inner = html.match(/^<div class="page-toolbar[^"]*">\n([\s\S]*)\n<\/div>$/);
    assert.ok(inner, `PAGE-007b: ${JSON.stringify(opts)} did not render a single toolbar element`);
    assert.equal(inner[1], direct,
      `PAGE-007b: ${JSON.stringify(opts)} must emit the slots as direct children of the toolbar, nothing between`);
  }
  // Und die Referenzseite traegt keine Option, die es nicht mehr gibt.
  assert.doesNotMatch(read('../public/pages/birthdays.js'), /measured:/,
    'PAGE-007b: birthdays passes no `measured` option - the helper has none');
  // Das Beispiel in der Spec zeigt denselben Baum. Nach dem Fix oben stand
  // dort noch `.page-toolbar__rail -> title . search . actions` - eine
  // Anleitung, den Wrapper von Hand nachzubauen, den der Helper gerade
  // verloren hat (Codex, dritte Runde an #995).
  const example = read('../docs/PAGE-COMPOSITION.md').match(/### Worked example[\s\S]*?```text\n([\s\S]*?)```/);
  assert.ok(example, 'PAGE-007b: the worked example in docs/PAGE-COMPOSITION.md is missing');
  assert.match(example[1], /page-toolbar--narrow/, 'PAGE-007b: the worked example shows a narrow toolbar');
  assert.doesNotMatch(example[1], /page-toolbar__rail/,
    'PAGE-007b: the worked example must not show a rail element under a narrow toolbar');
});

test('PAGE-008: DESIGN.md points at the composition system', () => {
  const design = read('../DESIGN.md');
  assert.match(design, /docs\/PAGE-COMPOSITION\.md/,
    'PAGE-008: DESIGN.md must link docs/PAGE-COMPOSITION.md');
  assert.ok(existsSync(new URL('../docs/PAGE-COMPOSITION.md', import.meta.url)),
    'PAGE-008: docs/PAGE-COMPOSITION.md must exist');
  assert.ok(!existsSync(new URL('../PAGE-COMPOSITION.md', import.meta.url)),
    'PAGE-008: the spec lives under docs/, not in the repository root');

  // Die Datei ist aus der Wurzel nach docs/ gezogen; jeder Link auf eine
  // Repo-Datei braucht seitdem ein `../`. Beim Umzug blieben sechs davon
  // stehen und zeigten auf docs/DESIGN.md, docs/public/... - Ziele, die es
  // nicht gibt. Aufgeloest wird von docs/ aus, so wie GitHub es tut.
  const spec = read('../docs/PAGE-COMPOSITION.md');
  const links = [...spec.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z]+:/.test(target));
  assert.ok(links.length >= 6, `PAGE-008: only ${links.length} relative links found - the scan is blind`);
  const dead = links.filter((target) => !existsSync(new URL(`../docs/${target}`, import.meta.url)));
  assert.deepEqual(dead, [],
    `PAGE-008: links in docs/PAGE-COMPOSITION.md that do not resolve from docs/: ${dead.join(', ')}`);
});

test('PAGE-009: composition mode owns responsive split/full behaviour', () => {
  const layout = read('../public/styles/layout.css');
  // Das Split-Raster liegt am KOERPER. renderAppPage() legt Kopf und Koerper
  // als Geschwister unter die Wurzel; ein Raster an der Wurzel setzte den Kopf
  // in die linke Spalte und den ganzen Koerper in die rechte (Codex, zweite
  // Runde an #995). Die Regel muss in der 1024px-Query stehen und auf
  // `> .app-page__body` zielen; die Wurzel selbst darf kein Raster werden.
  // Und es misst die SEITE, nicht den Viewport: neben der Sidebar hat die
  // Seite bei 1024px Viewport ~804px, und ein Master bis 720px liess dem
  // Detail ein paar Pixel (Codex, fuenfte Runde). Container-Query an der
  // Wurzel, Master hoechstens die Haelfte. Eine namenlose @container-Query
  // ohne Container-Vorfahren matcht NIE - der Fehler waere still (immer
  // gestapelt), also gehoert die container-type-Deklaration mit zum Guard.
  const splitGrid = layout.match(/@container \(min-width: 768px\) \{\s*\.app-page--split > \.app-page__body \{([^}]*)\}/);
  assert.ok(splitGrid, 'PAGE-009: split mode must put its two-column grid on > .app-page__body inside a 768px container query');
  assert.match(splitGrid[1], /display:\s*grid/, 'PAGE-009: the split body is a grid');
  assert.match(splitGrid[1], /grid-template-columns:\s*minmax\(0, min\(var\(--layout-reading\), 50%\)\) minmax\(0, 1fr\)/,
    'PAGE-009: master rail up to the reading measure but never more than half, detail takes the rest');
  assert.doesNotMatch(layout, /@media \(min-width: \d+px\) \{\s*\.app-page--split > \.app-page__body/,
    'PAGE-009: the split grid must not be gated by a viewport query - the page is narrower than the viewport beside the sidebar');
  const splitRoot = [...layout.matchAll(/\.app-page--split\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(splitRoot.some((body) => /container-type:\s*inline-size/.test(body)),
    'PAGE-009: .app-page--split must be an inline-size container, or the @container query never matches');
  for (const rule of layout.matchAll(/\.app-page--split\s*(?:,[^{]*)?\{([^}]*)\}/g)) {
    assert.doesNotMatch(rule[1], /display:\s*grid|grid-template-columns/,
      'PAGE-009: .app-page--split itself must not be a grid - header and body would become its two cells');
  }
  // Und der Koerper traegt das Polster: der Kopf polstert sich ueber
  // .page-toolbar selbst, der Split-Koerper bekam nur Raster und gap - die
  // Rails begannen bei x=0, links vom Titel (Codex, dritte Runde an #995).
  // Die Regel steht AUSSERHALB der Query, damit auch der Stapel sie hat.
  const splitBodies = [...layout.matchAll(/\.app-page--split > \.app-page__body \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(splitBodies.some((body) => /padding-inline:\s*var\(--page-inline-pad\)/.test(body)),
    'PAGE-009: the split body must carry the page gutter (padding-inline: var(--page-inline-pad))');
  // Ohne Mass heisst `100%`, nicht `none`: die Kopf-Formeln rechnen mit der
  // Variable, und `none` ist in calc() kein Wert (siehe layout.css).
  assert.match(layout, /\.app-page--split,\s*\n\.app-page--full \{\s*--page-measure:\s*100%;/,
    'PAGE-009: full/split set --page-measure: 100% (a length the header formulas can subtract)');
  assert.doesNotMatch(layout, /--page-measure:\s*none/,
    'PAGE-009: --page-measure: none makes every calc() that reads it invalid');
});

test('PAGE-013: a narrow header follows the measure of ITS page, and full/split roots take the shell height', () => {
  const layout = read('../public/styles/layout.css');
  // Der Bar-Kopf deckelt ueber sein Padding. Die erste Fassung rechnete mit
  // `--content-max-width-narrow` und deckelte den Kopf der Hauswirtschaft
  // (`data`, 960px) auf 720px - Titel und Reiter endeten 240px vor den Karten
  // (Codex an housekeeping.js:170). Die Formel liest das Mass der Seite.
  const bar = layout.match(/\.page-toolbar--narrow:has\(> \.page-toolbar__bar\) \{([^}]*)\}/);
  assert.ok(bar, 'PAGE-013: the bar-header rule is missing');
  assert.match(bar[1], /calc\(100% - var\(--page-measure, var\(--content-max-width-narrow\)\) - var\(--page-inline-pad\)\)/,
    'PAGE-013: the bar header must subtract --page-measure, not the reading width');
  // Und jede Kopf-Formel, die ein Mass abzieht, zieht --page-measure ab:
  // ein weiterer Literalwert waere derselbe Fehler an der naechsten Stelle.
  const headFormulas = [...layout.matchAll(/\.page-toolbar--narrow[^{]*\{([^}]*)\}/g)]
    .map((m) => m[1]).filter((body) => /calc\(100% -/.test(body));
  assert.ok(headFormulas.length >= 2, `PAGE-013: only ${headFormulas.length} header formulas found - the scan is blind`);
  for (const body of headFormulas) {
    assert.doesNotMatch(body, /calc\(100% - var\(--(?:content-max-width-narrow|layout-reading)\)/,
      'PAGE-013: a header formula subtracts a literal width instead of --page-measure');
  }
  // `flex: 1` an .app-page wirkt nicht - .page-transition ist ein Block. Damit
  // ein `flex: 1`-Koerper in `full`/`split` etwas zu fuellen hat, stellt die
  // Shell die Hoehe an Helper-Wurzeln bereit; Kernseiten mit eigenem
  // `height: 100%` (Kalender, Notizen) bleiben unberuehrt.
  assert.match(layout, /\.app-page--full:has\(> \.app-page__body\),\s*\n\.app-page--split:has\(> \.app-page__body\) \{\s*height:\s*100%;/,
    'PAGE-013: full/split roots built by renderAppPage() must take the shell height');
});

test('PAGE-014: page-layout helpers escape every attribute they emit', async () => {
  // Die Helfer sind die zugesagte Oberflaeche fuer Erweiterungen (MODULES.md);
  // eine id aus einem Datensatz ist der erwartete Gebrauch der Option. Die
  // erste Fassung ersetzte nur `"` in Attribut-WERTEN - id, className und
  // Attribut-SCHLUESSEL gingen roh in den String (claude-review, dritte Runde
  // an #995). Geprueft wird die AUSGABE, nicht die Schreibweise: ein Angriff
  // in jedem der drei Pfade muss als Text ankommen, nicht als Attribut.
  const h = await import('../public/utils/page-layout.js');
  const hostile = 'x" onclick="alert(1)';
  const cases = [
    ['renderAppPage id', h.renderAppPage({ id: hostile })],
    ['renderAppPage className', h.renderAppPage({ className: hostile })],
    ['renderAppPage attrs value', h.renderAppPage({ attrs: { 'data-x': hostile } })],
    ['renderPageHeader className', h.renderPageHeader({ className: hostile })],
    ['renderPageTitle className', h.renderPageTitle('T', { className: hostile })],
    ['renderPageActions className', h.renderPageActions('', { className: hostile })],
    ['renderPageBody id', h.renderPageBody({ id: hostile })],
    ['renderPageBody className', h.renderPageBody({ className: hostile })],
    ['renderPageSection id', h.renderPageSection({ id: hostile })],
    ['renderPageSection className', h.renderPageSection({ className: hostile })],
    ['renderListSection id', h.renderListSection({ id: hostile })],
    ['renderMetricBand className', h.renderMetricBand({ content: '', className: hostile })],
  ];
  for (const [name, html] of cases) {
    assert.doesNotMatch(html, /onclick="/, `PAGE-014: ${name} lets a quote close the attribute`);
    assert.match(html, /&quot; onclick=&quot;/, `PAGE-014: ${name} must escape the quote, not drop it`);
  }
  // Der Schluessel steht AUSSERHALB der Anfuehrungszeichen. Dort beenden
  // Leerzeichen und `=` den Namen, und esc() kennt beide nicht: der Payload
  // oben kam durch esc() als Schluessel unveraendert und wurde zu drei
  // Attributen, eines davon lebendig - waehrend dieser Test mit seinem
  // `"`-Payload gruen blieb (Codex + claude-review, vierte Runde an #995).
  // Ein Schluessel, der kein Attributname ist, wirft; die Ausgabe wird
  // zusaetzlich GEPARST, nicht nur als String gelesen.
  for (const key of [hostile, 'data-x onmouseover=alert(1) z', 'x=y', 'a\tb', '', '1x', 'data-"']) {
    assert.throws(() => h.renderAppPage({ attrs: { [key]: 'v' } }), /Invalid attribute name/,
      `PAGE-014: attrs key ${JSON.stringify(key)} must be rejected, not serialized`);
  }
  // Kein DOM-Parser in den Dev-Dependencies, also der Tokenizer-Schritt des
  // Browsers fuer den oeffnenden Tag von Hand: ein Attributname ist ein Lauf
  // ohne Whitespace und ohne `"'>/=`, ein Wert der Inhalt der Anfuehrungs-
  // zeichen. Das ist genau die Trennung, die den Schluessel-Payload zu drei
  // Attributen macht - und die ein String-Vergleich nicht sieht.
  const openingTagAttrs = (html) => {
    const tag = html.match(/^<div\s([^>]*)>/);
    assert.ok(tag, 'PAGE-014: the page root must open with <div ...>');
    const attrs = new Map();
    const re = /([^\s"'>/=]+)(?:="([^"]*)")?/g;
    for (const m of tag[1].matchAll(re)) attrs.set(m[1], m[2] ?? '');
    return attrs;
  };
  const decode = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const parsed = openingTagAttrs(h.renderAppPage({
    id: hostile,
    className: hostile,
    attrs: { 'data-x': hostile, 'aria-label': '<b>', 'data-ok': 'v' },
  }));
  assert.deepEqual([...parsed.keys()].sort(), ['aria-label', 'class', 'data-composition', 'data-ok', 'data-x', 'id'],
    'PAGE-014: the parsed root must carry exactly the six declared attributes - nothing split off, nothing live');
  assert.equal(decode(parsed.get('id')), hostile, 'PAGE-014: the hostile id round-trips as text');
  assert.equal(decode(parsed.get('data-x')), hostile, 'PAGE-014: the hostile value round-trips as text');
  assert.equal(decode(parsed.get('aria-label')), '<b>', 'PAGE-014: a value with markup round-trips as text');
  // Und die Probe auf den Tokenizer selbst: ein roher Schluessel-Payload
  // MUSS bei ihm in drei Attribute zerfallen, sonst prueft er nichts.
  const rawSplit = openingTagAttrs('<div class="app-page" data-x onmouseover="alert(1)" z="">');
  assert.deepEqual([...rawSplit.keys()], ['class', 'data-x', 'onmouseover', 'z'],
    'PAGE-014: the tokenizer must split an unquoted key the way a browser does');
  // Slot-Inhalte bleiben roh - sie sind Markup, das der Aufrufer escaped hat.
  assert.match(h.renderPageBody({ content: '<p>x</p>' }), /<p>x<\/p>/,
    'PAGE-014: content slots are markup and must pass through');
  // Und die eine Escape-Funktion, nicht eine zweite von Hand.
  const src = read('../public/utils/page-layout.js');
  assert.match(src, /import \{ esc \} from '\.\/html-escape\.js'/,
    'PAGE-014: the helpers use the shared esc(), not a local replace');
  assert.doesNotMatch(src, /replace\(\/"\/g/, 'PAGE-014: no hand-rolled quote replacement next to esc()');
  assert.doesNotMatch(src, /esc\(key\)/, 'PAGE-014: an attribute key is validated, not escaped - esc() does not know space or =');
  assert.match(src, /const ATTR_NAME = \/\^\[A-Za-z\]\[A-Za-z0-9:_\.-\]\*\$\//,
    'PAGE-014: attribute keys are checked against a name pattern');
});

test('PAGE-015: a tab panel inside a page declares the mode of that page', () => {
  // budget-stats und budget-plans sind keine Seiten, sondern Reiter im
  // Budget: sie werden in `.budget-page.app-page--reading` gerendert. Ein
  // eigener Modus dort setzt --page-measure fuer den Unterbaum um - das
  // Kennzahlenband der Berichte lief auf --layout-wide (1200px), waehrend der
  // gemeinsame Kopf und jeder andere Reiter bei 720px enden (Codex, dritte
  // Runde an #995; auf main waren es 720). Bis Welle C den Kopf je Reiter
  // umschaltet, erben die Panels den Modus der Seite.
  const modeOf = (file) => {
    const m = read(file).match(/class="[^"]*\bapp-page app-page--([a-z]+)/);
    assert.ok(m, `PAGE-015: ${file} declares no composition mode`);
    return m[1];
  };
  const page = modeOf('../public/pages/budget.js');
  for (const panel of ['../public/pages/budget-stats.js', '../public/pages/budget-plans.js']) {
    assert.equal(modeOf(panel), page,
      `PAGE-015: ${panel} is a tab panel of budget.js and must declare its mode (${page}), not its own`);
  }
});

test('PAGE-016: a page whose header runs full width puts nothing on the measure', () => {
  // Codex, siebte Runde an #995: schedule stand auf `data` (960px), sein Kopf
  // laeuft aber ohne --narrow voll durch, und vom Inhalt nahm nur das
  // Kennzahlenband der Statistik das Mass - es endete bei 960, Filterkarte und
  // Ergebniskarten daneben bei voller Breite (auf main war nichts gekappt).
  // Ein Mass, das der Kopf nicht zeigt, sieht man an genau den Elementen, die
  // es zufaellig konsumieren. Notes (Runde eins) und Subscriptions (Runde
  // zwei) waren derselbe Fall; beim dritten Mal wird es eine Regel: entweder
  // der Kopf traegt das Mass (--narrow, oder der Helfer mit seinem Default),
  // oder die Seite ist full/split - dann ist das Mass 100% und nichts kappt.
  //
  // WER DAS MASS KONSUMIERT, STEHT IN DEN STYLESHEETS, nicht hier: jede Regel
  // mit `max-width: ... --page-measure` nennt ihre Klassen selbst. Der Guard
  // liest sie, damit ein neuer Konsument automatisch mitzaehlt.
  const styleDir = new URL('../public/styles/', import.meta.url);
  const consumers = new Map();
  for (const file of readdirSync(styleDir).filter((f) => f.endsWith('.css'))) {
    for (const { selector, body } of eachRule(read(`../public/styles/${file}`))) {
      if (!/max-width\s*:[^;]*--page-measure/.test(body)) continue;
      for (const fragment of selector.split(',')) {
        // Nur das letzte Compound zaehlt: `.app-page :is(.a, .b)` kappt .a und
        // .b, nicht jede Seite. Das :is() zerfaellt am Komma in seine Glieder.
        const subject = fragment.trim().split(/\s*[>+~]\s*|\s+/).pop();
        for (const cls of subject.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
          consumers.set(cls[1], `${file}: ${selector.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
        }
      }
    }
  }
  for (const known of ['page-measure', 'list-rows', 'metric-grid']) {
    assert.ok(consumers.has(known), `PAGE-016: ${known} is not read as a consumer - the stylesheet scan is blind`);
  }
  assert.ok(consumers.size >= 10, `PAGE-016: only ${consumers.size} consumers found - the stylesheet scan is blind`);

  let measuredWithFullHeader = 0;
  for (const name of compositionScope()) {
    const src = withoutBlockComments(withoutHtmlComments(read(`../public/pages/${name}`)));
    const mode = COMPOSITION_MODES.find((m) =>
      new RegExp(`app-page--${m}|data-composition="${m}"|mode:\\s*'${m}'`).test(src));
    if (!mode || mode === 'full' || mode === 'split') continue;
    const ownHeader = /page-toolbar/.test(src) || /renderPageHeader\(/.test(src);
    // Ohne eigenen Kopf ist die Datei ein Panel; PAGE-015 bindet es an den Kopf
    // seiner Seite.
    if (!ownHeader) continue;
    const narrow = /page-toolbar--narrow/.test(src)
      || (/renderPageHeader\(/.test(src) && !/narrow:\s*false/.test(src));
    if (narrow) continue;
    measuredWithFullHeader += 1;
    for (const [cls, rule] of consumers) {
      const hit = new RegExp(`class="[^"]*(?<![\\w-])${cls}(?![\\w-])`).test(src);
      assert.ok(!hit,
        `PAGE-016 ${name}: mode ${mode} caps .${cls} (${rule}) at the measure while the header runs `
        + 'full width - either narrow the header (page-toolbar--narrow) so the measure is visible '
        + 'from the top, or declare full/split so nothing on this page is capped');
    }
  }
  // Der Zweig existiert nur, solange es Seiten mit Mass und durchlaufendem Kopf
  // gibt (health, dashboard); verschwinden sie, ist der Guard leer und sagt es.
  assert.ok(measuredWithFullHeader >= 1,
    'PAGE-016: no measured page with a full-width header left - drop this guard or its scope changed');
});

test('PAGE-010: full-bleed is an explicit --bleed declaration', () => {
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.page-section--bleed\s*\{[\s\S]*?padding-inline:\s*var\(--page-inline-pad\)/,
    'PAGE-010: bleed primitive must use --page-inline-pad');
  const helpers = read('../public/utils/page-layout.js');
  assert.match(helpers, /page-section--bleed/,
    'PAGE-010: helpers must emit bleed class');
});

/**
 * KEINE SEITE IST DIE REFERENZ.
 *
 * Die erste Fassung markierte `/birthdays` im Produktionsmarkup als
 * `data-composition-reference="true"` und pruefte genau diese eine Seite streng.
 * Das war ein Testhaken, der im ausgelieferten HTML stand: er kostete jeden
 * Besucher ein Attribut und sagte ueber die anderen dreissig Seiten nichts. Die
 * Strenge steckt jetzt in PAGE-001 bis PAGE-006 ueber den ganzen
 * Geltungsbereich; dieser Test haelt nur den Weg zurueck zu.
 */
test('PAGE-012: the router applies what an extension manifest declares', () => {
  // `page.composition` und `page.width` werden serverseitig geprueft
  // (test-modules.js) und in MODULES.md als Vertrag versprochen. Ein Vertrag,
  // den der Router nicht anwendet, ist ein Feld ohne Wirkung: `data` saehe aus
  // wie `reading`, `wide` wie gar nichts. Codex fand genau das an #995 - die
  // Erklaerung kam bis zur Admin-Liste und nicht bis zur Seite.
  const router = withoutBlockComments(read('../public/router.js'));
  const mount = router.slice(router.indexOf('function mountExtensionPage('));
  assert.ok(mount.length > 0, 'PAGE-012: router.js must mount an extension page root');
  const body = mount.slice(0, mount.indexOf('\n}\n'));
  assert.match(body, /page\.composition/, 'PAGE-012: the mount reads page.composition');
  assert.match(body, /COMPOSITION_MODES\.includes\(/, 'PAGE-012: an unknown mode falls back instead of leaking into a class');
  assert.match(body, /app-page app-page--\$\{mode\}/, 'PAGE-012: the root carries the mode class');
  assert.match(body, /dataset\.composition = mode/, 'PAGE-012: the root carries data-composition');
  assert.match(body, /dataset\.pageWidth/, 'PAGE-012: page.width lands on the root');
  // ... und der Renderpfad benutzt die Wurzel, nicht den nackten Wrapper.
  assert.match(router, /mountExtensionPage\(pageWrapper, route\.thirdPartyModule\)/,
    'PAGE-012: the extension render path must mount through the composition root');
  assert.match(router, /page: \{ \.\.\.route\.thirdPartyModule\.page \}/,
    'PAGE-012: the module learns its declared page via context.page');

  // `page.width` hat ein Gegenstueck im CSS, sonst ist die Breite die naechste
  // Erklaerung ohne Wirkung; und sie greift NUR in gemessenen Modi.
  const layout = read('../public/styles/layout.css');
  for (const [width, token] of [['reading', 'reading'], ['content', 'content'], ['wide', 'wide']]) {
    const rule = new RegExp(`\\[data-page-width="${width}"\\]\\s*\\{[^}]*--page-measure:\\s*var\\(--layout-${token}\\)`);
    assert.match(layout, rule, `PAGE-012: layout.css maps page.width=${width} to --layout-${token}`);
  }
  const widthRules = [...layout.matchAll(/^[^{]*\[data-page-width=[^{]*\{/gm)].map((m) => m[0]);
  assert.ok(widthRules.length >= 3, 'PAGE-012: three width rules expected');
  for (const sel of widthRules) {
    assert.doesNotMatch(sel, /app-page--(?:full|split)/,
      `PAGE-012: a width must not cap a page that owns its width: ${sel.trim()}`);
    assert.match(sel, /app-page--reading/, `PAGE-012: width rules are scoped to measured modes: ${sel.trim()}`);
  }
});

test('PAGE composition: no page marks itself as the reference implementation', () => {
  const offenders = walkJsFiles('../public/')
    .filter((file) => /data-composition-reference/.test(read(file)));
  assert.deepEqual(offenders, [],
    'Ein Kompositions-Marker ist zurueck im Produktionsmarkup. Die Zusicherung '
    + 'gehoert in den Guard, nicht ins ausgelieferte HTML.');
});

test('PAGE composition: birthdays stays free of page geometry in module CSS', () => {
  const src = read('../public/pages/birthdays.js');
  const css = withoutBlockComments(read('../public/styles/birthdays.css'));
  assert.match(src, /from ['"]\/utils\/page-layout\.js['"]/,
    'birthdays.js must import page-layout helpers');
  for (const name of [
    'renderAppPage',
    'renderPageHeader',
    'renderPageTitle',
    'renderPageActions',
    'renderPageBody',
    'renderPageSection',
    'renderListSection',
  ]) {
    assert.match(src, new RegExp(name), `birthdays.js must call ${name}`);
  }
  assert.match(src, /mode:\s*'reading'/, 'birthdays.js must declare reading mode');
  assert.match(src, /legacyAlias:\s*false/,
    'birthdays.js must omit the .page-measure--narrow compat alias');
  assert.doesNotMatch(src, /measured:|page-toolbar__rail/,
    'birthdays.js header has no rail element and no measured option (sixth round of #995)');
  assert.doesNotMatch(src, /page-measure--narrow/,
    'birthdays.js must not reintroduce page-measure--narrow');
  // Module CSS owns accent/list chrome only - no page geometry.
  for (const rule of eachRule(css)) {
    if (!/\.birthdays-page\b/.test(rule.selector)) continue;
    assert.doesNotMatch(rule.body, /max-width\s*:/,
      `birthdays.css must not set page max-width on ${rule.selector}`);
    assert.doesNotMatch(rule.body, /margin-inline\s*:\s*var\(--page-inline-pad\)/,
      `birthdays.css must not own page gutters on ${rule.selector}`);
  }
  assert.doesNotMatch(css, /\.birthdays-hint\s*\{[^}]*margin-inline\s*:\s*var\(--page-inline-pad\)/,
    'hint gutter must come from .app-page__body, not birthdays.css');
  assert.doesNotMatch(css, /\.birthdays-list\s*\{[^}]*margin-inline\s*:\s*var\(--page-inline-pad\)/,
    'list gutter must come from composition body, not birthdays.css');
});

test('PAGE composition: there is no toolbar rail element anywhere under public/', () => {
  // Bis zur sechsten Runde an #995 stand hier das Gegenteil: "measured toolbar
  // rail exists in layout.css". Der Helper baute fuer `measured` ohne `narrow`
  // einen `.page-toolbar__rail` um die Slots, layout.css hatte die Regeln dazu,
  // die Doku nannte die Kombination - und jeder, der sie nahm, verlor Siegel
  // und Dock-Titel (PAGE-007b). Rail und Modifier sind weg. Taucht einer der
  // beiden Namen wieder auf, ist das der Wrapper auf dem Rueckweg, und dann
  // muessen ZUERST ux.js und typography.css den Titel auch als Enkel finden.
  const styleDir = new URL('../public/styles/', import.meta.url);
  const files = [
    ...readdirSync(styleDir).filter((f) => f.endsWith('.css')).map((f) => `../public/styles/${f}`),
    ...walkFrontendFiles('../public/').filter((f) => !f.includes('/vendor/')),
  ];
  let seen = 0;
  for (const file of files) {
    seen++;
    const src = read(file);
    const hit = src.match(/page-toolbar__rail|page-toolbar--measured/);
    const line = hit ? src.slice(0, hit.index).split('\n').length : 0;
    assert.ok(!hit,
      `${file}:${line}: "${hit?.[0]}" - the toolbar rail element is gone; the header slots are direct children (sixth round of #995)`);
  }
  assert.ok(seen > 100, `PAGE composition: only ${seen} files scanned for the rail - the walk is broken`);
  const layout = read('../public/styles/layout.css');
  assert.match(layout, /\.app-page--reading\s*>\s*\.app-page__body/,
    'reading body must own page-inline-pad gutters');
});

// --------------------------------------------------------------------------
// SYMBOLAUSWAHL: die Scroll-Klasse der CSS trifft den Wrapper des Dialogs
//
// Gefunden auf einem echten Mobilgeraet (Schichtplan v3, Symbol-Feld): die CSS
// setzte `display:flex; flex-direction:column; max-height:inherit;
// min-height:0` auf `.icon-picker__form`, das erzeugte Markup in
// buildDialog() (public/components/icon-picker.js) baut aber einen Wrapper
// mit der Klasse `.icon-picker__body`. Ohne Treffer griff die Flex/Scroll-
// Kette nie: das Ergebnis-Raster wuchs auf seine natuerliche Hoehe statt zu
// scrollen, und die Fusszeile (Loeschen/Abbrechen) landete unterhalb des
// `max-height`+`overflow:hidden` des Dialogs - auf kurzen Viewports komplett
// abgeschnitten und unerreichbar. Betraf alle drei Verwendungsstellen
// (Schnellzugriffe, Kalender, Schichtplan) gleichermassen, seit #873 - auf
// dem Desktop blieb genug Raum, dass es nie auffiel.
// --------------------------------------------------------------------------
test('die Scroll-Klasse der Symbolauswahl-CSS trifft einen wirklich erzeugten Wrapper', () => {
  const js = read('../public/components/icon-picker.js');
  const css = read('../public/styles/icon-picker.css');

  const wrapperMatch = /<div class="(icon-picker__\w+)">/.exec(js);
  assert.ok(wrapperMatch, 'buildDialog() baut keinen icon-picker__*-Wrapper mehr - Guard veraltet');
  const wrapperClass = wrapperMatch[1];

  assert.ok(css.includes(`.${wrapperClass} {`),
    `Die CSS setzt keine Regel fuer ".${wrapperClass}" - genau der Wrapper, den `
    + 'buildDialog() tatsaechlich erzeugt. Ohne eine Regel hier bekommt der Dialog keinen '
    + 'Flex-Kontext, das Ergebnis-Raster scrollt nicht und die Fusszeile (Loeschen/'
    + 'Abbrechen) kann vom `overflow: hidden` des <dialog> abgeschnitten werden - auf '
    + 'kurzen Viewports unerreichbar.');

  const rule = new RegExp(`\\.${wrapperClass}\\s*\\{[^}]*\\}`).exec(css)[0];
  for (const prop of ['display: flex', 'flex-direction: column', 'min-height: 0']) {
    assert.ok(rule.includes(prop),
      `.${wrapperClass} traegt kein "${prop}" - ohne das gibt der Wrapper seine Hoehe `
      + 'nicht an .icon-picker__results weiter, das Raster scrollt dann nicht.');
  }
});

/**
 * Das Seitenmenue am Desktop hat einen greifbaren Scrollbalken (#970).
 *
 * Die Regel ist nicht "irgendwo steht scrollbar-width": sie haengt an der
 * BREITE. Bis v2.64.1 stand `scrollbar-width: none` samt verstecktem
 * `::-webkit-scrollbar` ausgerechnet in `@media (min-width: 1024px)` - also
 * genau dort, wo mit der Maus gezogen wird und keine Wischgeste einspringt.
 * Der Fade darunter beantwortet eine andere Frage ("ist da noch mehr?") und
 * ersetzt keinen Griff.
 *
 * Geprueft wird deshalb der Zustand IN der Desktop-Query, nicht das Vorkommen
 * einer Zeichenfolge in der Datei - `scrollbar-width: none` am Telefon bliebe
 * richtig und darf diesen Guard nicht ausloesen.
 */
test('Seitenmenue: der Scrollbalken ist am Desktop sichtbar (#970)', () => {
  const layout = read('../public/styles/layout.css');
  const desktop = (rule) => rule.at.some((a) => /min-width:\s*1024px/.test(a));

  let itemsRule = null;
  const versteckt = [];
  for (const rule of eachRule(layout)) {
    if (!desktop(rule)) continue;
    const sel = rule.selector.trim();
    if (sel === '.nav-sidebar__items') itemsRule = rule;
    if (!/\.nav-sidebar__items/.test(sel)) continue;
    if (/scrollbar-width:\s*none/.test(rule.body)) versteckt.push(`${sel} { scrollbar-width: none }`);
    if (/::-webkit-scrollbar\b/.test(sel) && /display:\s*none/.test(rule.body)) {
      versteckt.push(`${sel} { display: none }`);
    }
  }

  assert.ok(itemsRule,
    '.nav-sidebar__items nicht in @media (min-width: 1024px) gefunden - Guard misst nichts');
  assert.deepEqual(versteckt, [],
    `Der Balken ist am Desktop wieder versteckt: ${versteckt.join(', ')} - `
    + 'mit Maus ist er das Bedienelement, der Fade ist nur eine Andeutung (#970)');
  assert.match(itemsRule.body, /scrollbar-width:\s*thin/,
    '.nav-sidebar__items braucht am Desktop einen schmalen, sichtbaren Balken');
  assert.match(itemsRule.body, /scrollbar-color:/,
    'ohne scrollbar-color nimmt der Balken die Systemfarbe statt der Token-Farbe');
  assert.doesNotMatch(itemsRule.body, /#[0-9a-fA-F]{3,8}\b|\brgba?\(/,
    'Farbwerte kommen aus tokens.css, nicht als Literal');
});

// ---------------------------------------------------------------------------
// Seiten-Lebenszyklus (#976, #977): der Router vergibt je Seitenaufbau ein
// Signal und bricht es beim Routenwechsel ab; das Dashboard haengt ALLES an
// das Signal des eigenen Aufbaus. Browser-gekoppelt, deshalb Textguards -
// die Bruecke selbst ist in test-page-lifecycle.js nach Verhalten geprueft.
// ---------------------------------------------------------------------------

test('router: ein AbortController je Seitenaufbau, abgebrochen vor dem naechsten render(), Signal im Kontext (#976)', () => {
  const router = withoutBlockComments(read('../public/router.js'));
  const renderPage = router.slice(router.indexOf('async function renderPage('));
  assert.ok(renderPage.length > 100, 'renderPage() nicht gefunden');
  const abortAt = renderPage.indexOf('_pageController?.abort();');
  const createAt = renderPage.indexOf('_pageController = new AbortController();');
  const renderAt = renderPage.indexOf('module.render(target, context)');
  assert.ok(abortAt > 0 && createAt > abortAt && renderAt > createAt,
    'renderPage() muss den vorigen Controller abbrechen und einen neuen anlegen, BEVOR es render() ruft');
  // Beide Kontext-Fassungen tragen das Signal - Kernseiten und Erweiterungen.
  assert.match(renderPage, /\{ user: currentUser, signal: _pageController\.signal \}/,
    'Kern-Kontext ohne Router-Signal');
  assert.match(renderPage, /\{ user: currentUser, page: \{ \.\.\.route\.thirdPartyModule\.page \}, signal: _pageController\.signal \}/,
    'Erweiterungs-Kontext ohne Router-Signal');
});

test('dashboard: Timer und Listener haengen am Signal des eigenen Aufbaus, nicht am Modul-Feld (#976/#977)', () => {
  const dashboard = withoutBlockComments(read('../public/pages/dashboard.js'));
  assert.match(dashboard, /import \{ createPageController \} from '\/utils\/page-lifecycle\.js'/);
  const render = dashboard.slice(dashboard.indexOf('export async function render('));
  assert.match(render, /signal: routeSignal = null/, 'render() nimmt das Router-Signal aus dem Kontext');
  assert.match(render, /const controller = createPageController\(routeSignal\);/);
  assert.match(render, /const \{ signal \} = controller;/);
  // Kein Listener und kein Timer-Abbau darf auf das Modul-Feld zeigen: ein
  // ueberholter Aufbau registrierte sich sonst am Controller des neueren.
  assert.doesNotMatch(render, /_fabController\.signal/,
    'render() verdrahtet ueber `signal` (lokal), nicht ueber `_fabController.signal`');
  assert.match(render, /const rerender = \(\) => render\(container, \{ user, signal: routeSignal \}\);/,
    'ein Neuaufbau reicht das Router-Signal weiter, sonst ueberlebt er das Verlassen der Seite');
  // Der Engpass fuer verspaetete Antworten (#977) und die Pruefungen hinter den
  // awaits, die selbst zeichnen.
  const rebuild = render.slice(render.indexOf('function rebuildDashboard(cfg) {'), render.indexOf('function rebuildDashboard(cfg) {') + 400);
  // Zwischen Kopf und Pruefung duerfen nur Zeilenkommentare stehen.
  assert.match(rebuild, /function rebuildDashboard\(cfg\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(signal\.aborted\) return;/,
    'rebuildDashboard() prueft als Erstes, ob dieser Aufbau noch gilt');
  for (const fn of ['async function refreshDashboardData()', 'const doAutoRefresh = async () =>', 'const doWeatherRefresh = async () =>']) {
    const at = render.indexOf(fn);
    assert.ok(at > 0, `${fn} nicht gefunden`);
    const body = render.slice(at, at + 1200);
    assert.match(body, /await [\s\S]*?if \(signal\.aborted\) return;/, `${fn}: nach dem await fehlt die Pruefung`);
  }
  // Sieben Stellen: nach der ersten Antwortrunde, nach der gefilterten
  // Nachfrage, nach den Slice-Nachladungen, im Engpass rebuildDashboard() und
  // in den drei Pfaden, die von sich aus neu zeichnen (stiller Refresh,
  // Wetter-Auto-Refresh, Wetter-Knopf).
  assert.ok((render.match(/if \(signal\.aborted\) return;/g) ?? []).length >= 7,
    'die Pruefung steht hinter jedem await des Hauptflusses und in jedem Pfad, der selbst zeichnet');
});

/**
 * Wie diese Datei das Schliessen des Dialogs NENNT.
 *
 * Vier Seiten importieren `closeModal as closeSharedModal` - ein Guard, der auf
 * den Originalnamen prueft, sieht ihren gesamten Schliess-und-Rendern-Weg nicht
 * (Review zu #1070). Der Alias steht im Import und ist von dort ablesbar.
 */
/**
 * Fassaden, die den Dialog schliessen, ohne aus `modal.js` zu kommen.
 *
 * `closeDetailView()` in `components/detail-view.js` delegiert an `closeModal()`
 * (dort am Ende von `closeDetailView`), und `task-detail.js` importiert es -
 * fuer den Guard sah dieser Weg nach gar keinem Schliessen aus (Review zu
 * #1070).
 *
 * NAMENTLICH und nicht per Heuristik: "jede exportierte Funktion, die
 * `closeModal(` ruft" liefert gemessen 11 Namen, davon 9 falsche - darunter
 * `openModal` und `openDetailView`, weil ein Oeffner das vorige Modal schliesst.
 * Ein Guard, der Oeffnen fuer Schliessen haelt, urteilt ueber die falsche
 * Stelle. Die Liste haelt der Ratchet weiter unten vollstaendig.
 */
const SCHLIESS_FASSADEN = ['closeDetailView'];

function schliessNamen(lines) {
  const namen = new Set(['closeModal', ...SCHLIESS_FASSADEN]);
  const quelle = lines.join('\n');
  const block = quelle.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\/components\/modal\.js'/);
  if (block) {
    for (const m of block[1].matchAll(/closeModal\s+as\s+([A-Za-z_]\w*)/g)) namen.add(m[1]);
  }
  return namen;
}

/** Schliesst diese Zeile den Dialog - unter welchem Namen auch immer? */
function istSchliessen(zeile, namen) {
  for (const n of namen) if (new RegExp(`\\b${n}\\s*\\(`).test(zeile)) return true;
  return false;
}

/**
 * Die modul-lokalen Funktionen, die die Seite neu aufbauen.
 *
 * Ein Guard, der nur `render…()` und `update…List()` als Neuaufbau zaehlt,
 * uebersieht den WRAPPER: `saveSubscription()` schliesst den Dialog und
 * `await reload()`, und `reload()` laedt und ruft dann `renderFilters()` und
 * `renderContent()`. Der Name verraet nichts davon (Review zu #1070).
 *
 * Gesammelt wird eine Ebene tief: Funktionen, die selbst eine render-Funktion
 * aufrufen. Ein reiner HTML-Baustein faellt heraus - er gibt ein Template
 * zurueck (`return \``) und schreibt nirgends ins Dokument. Kein transitiver
 * Abschluss: der zog im Versuch 539 Namen ein, darunter jeden String-Bauer,
 * und ein Guard, der alles fuer einen Renderer haelt, sagt nichts mehr aus.
 */
function rendererIn(lines) {
  const defs = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(?:export )?(?:async )?function ([A-Za-z_]\w*)/);
    if (m) defs.push({ i, name: m[1] });
  });
  const koerper = defs.map((d, k) => ({
    name: d.name,
    text: lines.slice(d.i, k + 1 < defs.length ? defs[k + 1].i : lines.length).join('\n'),
  }));
  const namen = new Set();
  // Bis zum Fixpunkt: `reloadMedViews()` ruft `reloadMeds()`, und ERST das
  // ruft `renderMedsShell()`. Eine Ebene sah nur die mittlere Schicht.
  for (let runde = 0; runde < 5; runde++) {
    let gewachsen = false;
    for (const { name, text } of koerper) {
      if (namen.has(name)) continue;
      // Ein reiner HTML-Baustein gibt ein Template zurueck und schreibt
      // nirgends ins Dokument - ohne diesen Ausschluss zieht der Abschluss
      // jeden String-Bauer mit (gemessen 539 statt 402 Namen), und ein Guard,
      // der alles fuer einen Renderer haelt, sagt nichts mehr aus.
      if (/\breturn\s+`/.test(text)) continue;
      if (RENDER_DIREKT.test(text)
        || [...namen].some((r) => new RegExp(`\\b${r}\\s*\\(`).test(text))) {
        namen.add(name);
        gewachsen = true;
      }
    }
    if (!gewachsen) break;
  }
  return namen;
}

/**
 * Ein abgewarteter Rueckruf baut per Definition Unbekanntes um.
 *
 * `await onChanged()` in tasks.js hat als Vorgabe `loadTasks(container)` und
 * ersetzt damit die ganze Liste; `await onDone()` im Quick-Links-Manager ist
 * dasselbe Muster. Wer nur nach Namen sucht, die er kennt, sieht davon nichts
 * (Review zu #1070).
 */
const AWAIT_RUECKRUF = /\bawait\s+(\w+\.)*(on[A-Z]\w*|opts\.\w+)\s*\??\.?\(/;

/** Rendert diese Zeile - direkt, ueber einen Wrapper oder ueber einen Rueckruf? */
function istNeuaufbau(zeile, wrapper) {
  if (RENDER_DIREKT.test(zeile)) return true;
  if (AWAIT_RUECKRUF.test(zeile)) return true;
  for (const w of wrapper) if (new RegExp(`\\b${w}\\s*\\(`).test(zeile)) return true;
  return false;
}

const RENDER_DIREKT = /\b(render[A-Z]\w*|update[A-Z]\w*List)\s*\(/;

/**
 * Die Zeilen vom Anker bis zum Ende seines Blocks.
 *
 * Ein festes Fenster von n Zeilen reicht nicht: der Gast-Anlegen-Pfad in
 * `split-expenses.js` schliesst den Dialog, holt dann zwei Abfragen per
 * `Promise.all`, setzt State und rendert erst neun Zeilen spaeter. Mit einem
 * Sechs-Zeilen-Fenster sah der Guard das Rendern nie und hielt den Handler
 * fuer irrelevant - ein geloeschter `refocusAfterRender()` waere gruen
 * durchgelaufen (Review zu #1070).
 *
 * Gelesen wird bis zur ersten Zeile, die WENIGER eingerueckt ist als der Anker:
 * das ist das Ende des Blocks, in dem er steht. `} catch (err) {` bricht damit
 * ab, und das ist richtig - der Fehlerzweig rendert nichts.
 */
function blockAb(lines, i, grenze = 40) {
  const tiefe = lines[i].match(/^\s*/)[0].length;
  const out = [];
  for (let j = i + 1; j < lines.length && out.length < grenze; j++) {
    if (lines[j].trim() === '') { out.push(lines[j]); continue; }
    if (lines[j].match(/^\s*/)[0].length < tiefe) break;
    out.push(lines[j]);
  }
  return out;
}

/* WER NACH DEM SCHLIESSEN RENDERT, MUSS DEN FOKUS NACHZIEHEN.
 *
 * `closeModal()` gibt den Fokus an den Ausloeser zurueck. Rendert der Handler
 * danach den Bereich neu, in dem der Ausloeser liegt, ist dieser Fokus sofort
 * wieder weg - gemessen faellt er auf `document.body`, und Tastatur- wie
 * Screenreader-Bedienung landen am Seitenanfang.
 *
 * Die geteilte Schicht faengt das selbst, solange die Seite SYNCHRON rendert:
 * `_refocusIfDropped` fasst einen Frame spaeter nach. Liegt dazwischen ein
 * `await`, ist dieser Frame vorbei, und nur die Seite weiss, wann sie fertig
 * ist - sie muss `refocusAfterRender()` rufen.
 *
 * DAS IST EIN RATCHET: der Scanner findet das Muster, nicht eine Liste von
 * Dateien. Eine neue Stelle, die kuenftig nach einem `await` rendert, faellt
 * hier auf, ohne dass jemand diesen Test anfasst. Der Aufruf ist immer sicher -
 * `_tryRefocus` prueft selbst, ob ueberhaupt etwas kaputtging -, es gibt also
 * keinen Grund, ihn wegzulassen.
 *
 * ZWEI GEGENPROBEN, und die erste hat den Guard selbst repariert: einen der elf
 * Aufrufe AUSKOMMENTIERT - der Guard blieb gruen, weil sein Regex den toten
 * Aufruf im Kommentartext weiterfand. Seitdem laeuft die Quelle erst durch
 * `withoutCommentsKeepingLines`. Danach faellt er in beiden Faellen: bei einem
 * auskommentierten und bei einem geloeschten Aufruf, gemessen je 1 von 364.
 */
test('jede Seite, die nach einem await neu rendert, zieht den Fokus nach', () => {
  const dirs = ['../public/pages', '../public/components', '../public/settings/pages'];
  const fehlend = [];
  for (const dir of dirs) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      // Neutralisieren, sonst zaehlt ein auskommentierter Aufruf als vorhanden.
      const lines = withoutCommentsKeepingLines(read(`${dir}/${datei}`)).split('\n');
      const wrapper = rendererIn(lines);
      const schliesst = schliessNamen(lines);
      lines.forEach((zeile, i) => {
        if (!istSchliessen(zeile, schliesst)) return;
        // EIN VERZOEGERTES SCHLIESSEN IST HIER KEINES. `setTimeout(() =>
        // closeModal(...), 700)` in tasks.js laeuft erst, wenn der Block
        // laengst durch ist - der Merker, auf den `refocusAfterRender()`
        // zurueckgreift, entsteht aber erst IN `_doClose`. Ein Aufruf im Block
        // koennte dort also nichts bewirken, und ihn zu verlangen hiesse, toten
        // Code zu fordern (Review zu #1070).
        if (/\bsetTimeout\s*\(/.test(zeile)) return;
        // NUR DIE EIGENE EBENE. Alles Tiefere steht in einem Callback, der auf
        // diesem Weg gar nicht laeuft - der Undo-Zweig eines Toasts etwa. Wer
        // ihn mitzaehlt, haelt `deletePlan()` in budget-plans.js fuer gedeckt,
        // weil im Undo-Callback ein Aufruf steht, waehrend der Hauptpfad ohne
        // blieb (Review zu #1070).
        const ankerTiefe = zeile.match(/^\s*/)[0].length;
        const fenster = blockAb(lines, i)
          .filter((x) => x.trim() === '' || x.match(/^\s*/)[0].length <= ankerTiefe);
        let letzte = -1;
        fenster.forEach((x, k) => { if (istNeuaufbau(x, wrapper)) letzte = k; });
        if (letzte === -1) return;
        // Ohne `await` davor rendert die Seite synchron - das deckt der Frame ab.
        if (!fenster.slice(0, letzte + 1).some((x) => /\bawait\b/.test(x))) return;
        // Der Aufruf muss auf der EBENE des Neuaufbaus liegen. Ein
        // `refocusAfterRender()` tief in einem Undo-Callback deckt den Weg
        // darueber nicht ab - genau so sah `deletePlan()` in budget-plans.js
        // gedeckt aus, waehrend der Hauptpfad ohne Aufruf blieb (Review zu #1070).
        if (fenster.some((x) => /refocusAfterRender\s*\(/.test(x))) return;
        fehlend.push(`${datei}:${i + 1} (${fenster[letzte].trim().slice(0, 48)})`);
      });
    }
  }
  assert.deepEqual(fehlend, [],
    'Diese Stellen rendern nach einem await erneut, ohne den Fokus nachzuziehen - '
    + 'der Focus-Restore aus closeModal() wird dort weggerendert und landet auf document.body. '
    + `Nach dem Rendern refocusAfterRender() rufen:\n  ${fehlend.join('\n  ')}`);
});

/**
 * Steht `zeile` in einem Funktionsausdruck INNERHALB der Funktion ab `start`?
 *
 * Gesucht wird rueckwaerts nach einer Zeile, die einen Rueckruf oeffnet
 * (`=> {`, `async () => {`, ein `function` mitten im Rumpf) und flacher liegt
 * als die fragliche Zeile - dann liegt diese in seinem Koerper. Ein `try {` auf
 * Funktionsebene zaehlt dabei nicht als Rueckruf, sonst waere jeder
 * `try`-Block eine Verschachtelung.
 */
function inVerschachtelterFunktion(lines, start, zeile) {
  const tiefe = lines[zeile].match(/^\s*/)[0].length;
  for (let j = zeile - 1; j > start; j--) {
    const l = lines[j];
    if (l.trim() === '') continue;
    const t = l.match(/^\s*/)[0].length;
    if (t >= tiefe) continue;
    // Eine flachere Zeile: oeffnet sie einen Rueckruf?
    if (/=>\s*\{\s*$|\bfunction\s*\w*\s*\([^)]*\)\s*\{\s*$/.test(l)) return true;
    // Eine flachere Zeile, die keinen Rueckruf oeffnet (`try {`, `if (…) {`):
    // weitersuchen, aber ab jetzt auf ihrer Ebene.
  }
  return false;
}

/* DIE ZWEITE BAUART: ASYNCHRON RENDERN, WAEHREND DER DIALOG NOCH OFFEN IST.
 *
 * Der Guard darueber deckt den Handler ab, der nach `closeModal()` rendert.
 * Dieser hier deckt den Fall, den der Codex-Review zu #1069 gefunden hat und den
 * beide Guards davor durchliessen, weil in diesem Handler gar kein
 * `closeModal()` vorkommt:
 *
 *   const onChanged = async () => { await loadBudgetMeta(); renderBody(); };
 *
 * Schliesst der Nutzer den Dialog, waehrend die Abfrage noch laeuft, ist der
 * Ausloeser beim Schliessen NOCH VERBUNDEN. Der Restore trifft ihn also
 * korrekt - und das `renderBody()` danach haengt ihn ab. Im Browser gemessen
 * (Chrome 152) landet der Fokus dann auf BODY. Das automatische Nachfassen
 * kommt einen Frame nach dem Schliessen und ist zu diesem Zeitpunkt laengst
 * vorbei; nur die Seite weiss, wann ihre Abfrage zurueck ist.
 *
 * Steht zwischen dem `await` und dem Rendern ein `closeModal()`, ist das der
 * synchrone Fall aus dem Guard darueber - der Frame deckt ihn, und ein Aufruf
 * hier waere toter Code. Deshalb sind genau diese Stellen ausgenommen.
 *
 * GEGENPROBE: den Aufruf in `openCategoryManager` in `budget.js` entfernen -
 * genau die Stelle, die der Review nannte. Der Guard faellt dann mit ihr in der
 * Liste.
 */
test('ein Handler, der bei offenem Dialog asynchron rendert, zieht den Fokus nach', () => {
  const fehlend = [];
  for (const dir of ['../public/pages', '../public/components', '../public/settings/pages']) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      const lines = withoutCommentsKeepingLines(read(`${dir}/${datei}`)).split('\n');
      const wrapper = rendererIn(lines);
      const starts = [];
      lines.forEach((l, i) => { if (/^(?:export )?(?:async )?function [A-Za-z_]/.test(l)) starts.push(i); });
      starts.forEach((s, k) => {
        const e = k + 1 < starts.length ? starts[k + 1] : lines.length;
        // Nur Funktionen, die selbst einen Dialog oeffnen.
        if (!lines.slice(s, e).some((l) => /open(Shared)?Modal\s*\(\s*\{/.test(l))) return;
        for (let j = s; j < e; j++) {
          if (!/\bawait\s+(load|refresh)[A-Z]\w*\s*\(/.test(lines[j])) continue;
          // VERSCHACHTELUNG ENTSCHEIDET, NICHT DIE REIHENFOLGE.
          //
          // Eine fruehere Fassung verlangte, dass das `openModal({` TEXTLICH vor
          // dem `await` steht. Das stellte zwar den Fehlalarm an
          // `openEditMemberModal` in admin-family.js ab - dort bereitet das
          // `await` den Dialog wirklich nur vor -, schloss aber die haeufigste
          // Bauart mit aus: den Rueckruf zuerst deklarieren, dann uebergeben.
          //
          //   const onChanged = async () => { await loadX(); renderY(); };
          //   openSharedModal({ … onChanged … });
          //
          // Fuenf Stellen haben diese Form (budget, inventory 2x, pantry,
          // shopping), und der Guard sah keine davon: das Loeschen ihres
          // `refocusAfterRender()` liess beide Suiten gruen. Ein Guard, der
          // Schutz behauptet und keinen gibt, ist schlimmer als keiner.
          //
          // Der Unterschied liegt in der Verschachtelung: ein `await` INNERHALB
          // eines verschachtelten Funktionsausdrucks ist eine Auffrischung, eines
          // auf der Ebene der oeffnenden Funktion ist Vorbereitung.
          if (!inVerschachtelterFunktion(lines, s, j)) continue;
          const fenster = blockAb(lines, j);
          if (!fenster.some((x) => istNeuaufbau(x, wrapper))) continue;
          // closeModal dazwischen: der synchrone Fall, den der Frame abdeckt.
          if (fenster.some((x) => istSchliessen(x, schliessNamen(lines)))) continue;
          if (fenster.some((x) => /refocusAfterRender\s*\(/.test(x))) continue;
          fehlend.push(`${datei}:${j + 1} (${lines[j].trim().slice(0, 44)})`);
        }
      });
    }
  }
  assert.deepEqual(fehlend, [],
    'Diese Handler rendern asynchron, waehrend ihr Dialog noch offen sein kann. Schliesst der '
    + 'Nutzer waehrenddessen, trifft der Focus-Restore den noch verbundenen Ausloeser und das '
    + 'Rendern danach haengt ihn ab - der Fokus faellt auf document.body. '
    + `Nach dem Rendern refocusAfterRender() rufen:\n  ${fehlend.join('\n  ')}`);
});


/* DER AUFRUF MUSS DER LETZTE NEUAUFBAU SEIN, NICHT IRGENDEINER.
 *
 * `refocusAfterRender()` setzt den Fokus sofort. Folgt danach im selben Block
 * noch ein `await`, das die Seite erneut umbaut - ein `await opts.onSaved?.()`,
 * dessen Callback den Bereich ersetzt -, ist der Fokus gleich wieder weg. Genau
 * so stand er zweimal in `health.js` (Review zu #1070): hinter
 * `reloadAfterSave()`, aber VOR dem Callback, der `overview.root` austauscht.
 *
 * Die Regel ist nicht "hoechstens ein await danach", sondern "kein await, das
 * neu aufbaut" - ein `await api.post(...)` danach ist harmlos.
 *
 * GEGENPROBE: den Aufruf in `saveVitals` wieder vor `await opts.onSaved?.()`
 * schieben, dann faellt diese Sonde mit dieser Zeile.
 */
test('refocusAfterRender steht nach dem LETZTEN Neuaufbau im Block', () => {
  const zuFrueh = [];
  for (const dir of ['../public/pages', '../public/components', '../public/settings/pages']) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      const lines = withoutCommentsKeepingLines(read(`${dir}/${datei}`)).split('\n');
      const wrapper = rendererIn(lines);
      lines.forEach((zeile, i) => {
        if (!/^\s*refocusAfterRender\(\);\s*$/.test(zeile)) return;
        // Was im selben Block noch folgt: ein await, das neu aufbaut?
        const tiefe = zeile.match(/^\s*/)[0].length;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (lines[j].match(/^\s*/)[0].length < tiefe) break;
          // Tiefer eingerueckt heisst: in einem Callback, der hier nicht laeuft.
          // Ein `await load()` im Undo-Zweig eines Toasts ist kein Neuaufbau
          // dieses Weges (Fehlalarm an budget-plans.js gemessen).
          if (lines[j].match(/^\s*/)[0].length > tiefe) continue;
          if (!/\bawait\b/.test(lines[j])) continue;
          // Ein Callback baut per Definition Unbekanntes um; sonst zaehlt nur
          // ein erkannter Neuaufbau.
          if (/\bawait\s+\w*(opts|options)\.\w+\?\.\(/.test(lines[j]) || istNeuaufbau(lines[j], wrapper)) {
            zuFrueh.push(`${datei}:${i + 1} (danach: ${lines[j].trim().slice(0, 40)})`);
            break;
          }
        }
      });
    }
  }
  assert.deepEqual(zuFrueh, [],
    'Diese Aufrufe stehen VOR einem await, das die Seite noch einmal umbaut - der Fokus, den sie '
    + 'setzen, ist danach wieder weg. Den Aufruf ans Ende des Blocks ziehen:\n  '
    + zuFrueh.join('\n  '));
});


/* DIE FASSADEN-LISTE MUSS VOLLSTAENDIG BLEIBEN.
 *
 * `SCHLIESS_FASSADEN` steht namentlich da, weil die Heuristik zu breit war -
 * und eine handgefuehrte Liste altert. Dieser Ratchet faengt den Zuwachs: jede
 * EXPORTIERTE Funktion, deren Name mit `close` beginnt und die `closeModal(`
 * ruft, ist eine solche Fassade und gehoert in die Liste.
 *
 * `closeModal` selbst ist die Quelle, nicht die Fassade.
 */
test('jede exportierte close-Fassade steht in SCHLIESS_FASSADEN', () => {
  const fehlend = [];
  for (const dir of ['../public/components', '../public/utils']) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      const lines = withoutCommentsKeepingLines(read(`${dir}/${datei}`)).split('\n');
      const grenzen = [];
      lines.forEach((l, i) => { if (/^(?:export )?(?:async )?function [A-Za-z_]/.test(l)) grenzen.push(i); });
      lines.forEach((l, i) => {
        const m = l.match(/^export (?:async )?function (close[A-Za-z_]\w*)/);
        if (!m || m[1] === 'closeModal') return;
        const ende = grenzen.find((x) => x > i) ?? lines.length;
        if (!/\bcloseModal\s*\(/.test(lines.slice(i, ende).join('\n'))) return;
        if (SCHLIESS_FASSADEN.includes(m[1])) return;
        fehlend.push(`${datei}: ${m[1]}`);
      });
    }
  }
  assert.deepEqual(fehlend, [],
    'Diese exportierten Funktionen schliessen den Dialog, stehen aber nicht in SCHLIESS_FASSADEN - '
    + 'die Focus-Guards sehen ihren Schliess-und-Rendern-Weg deshalb nicht:\n  ' + fehlend.join('\n  '));
});


/* KEIN AUFRUF INS LEERE.
 *
 * `refocusAfterRender()` wirkt nur, wenn vorher ein Dialog GESCHLOSSEN wurde:
 * es greift auf den Merker zurueck, den `_doClose()` setzt, und bricht ab,
 * solange noch ein Overlay offen ist. Zwei Formen von totem Aufruf sind daran
 * schon entstanden, beide durch automatisches Einfuegen (Review zu #1070):
 *
 *   1. VOR dem Schliessen: `refocusAfterRender(); closeModal(...)` ist ein
 *      garantierter No-op - der Merker ist noch leer, das Overlay noch offen.
 *   2. In einer Funktion, die mit Dialogen gar nichts zu tun hat: ein
 *      fehlerhafter Grenz-Regex hatte den Seiten-`render()` von housekeeping.js
 *      in den Block eines Modal-Oeffners gefaltet, und der Aufruf landete dort.
 *
 * Ein Handler, der WAEHREND des offenen Dialogs rendert, faellt hier bewusst
 * nicht auf: er steht in einer Funktion, die einen Dialog oeffnet, und greift
 * genau dann, wenn der Nutzer waehrenddessen schliesst.
 */
test('kein refocusAfterRender ohne ein Schliessen, auf das es sich beziehen kann', () => {
  const tot = [];
  for (const dir of ['../public/pages', '../public/components', '../public/settings/pages']) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      const lines = withoutCommentsKeepingLines(read(`${dir}/${datei}`)).split('\n');
      const schliesst = schliessNamen(lines);
      const grenzen = [];
      lines.forEach((l, i) => { if (/^(?:export )?(?:async )?function [A-Za-z_]/.test(l)) grenzen.push(i); });
      lines.forEach((zeile, i) => {
        if (!/^\s*refocusAfterRender\(\);\s*$/.test(zeile)) return;
        const start = [...grenzen].reverse().find((g) => g <= i) ?? 0;
        const ende = grenzen.find((g) => g > i) ?? lines.length;
        const funktion = lines.slice(start, ende);

        // (1) Steht im selben Block NACH dem Aufruf ein Schliessen?
        const tiefe = zeile.match(/^\s*/)[0].length;
        for (let j = i + 1; j < ende; j++) {
          if (lines[j].trim() === '') continue;
          if (lines[j].match(/^\s*/)[0].length < tiefe) break;
          if (lines[j].match(/^\s*/)[0].length > tiefe) continue;
          if (istSchliessen(lines[j], schliesst)) {
            tot.push(`${datei}:${i + 1} - steht VOR dem Schliessen in Zeile ${j + 1}`);
            return;
          }
        }
        // (1b) Liegt zwischen dem Schliessen davor und dem Aufruf ueberhaupt
        // ein Neuaufbau? Ohne einen ist nichts nachzuziehen: `_doClose` hat den
        // Fokus gerade selbst gesetzt, und zwar auf den frisch gerenderten
        // Knopf, wenn die Seite VOR dem Schliessen gerendert hat. Genau so
        // standen zwei Aufrufe in birthdays.js (Review zu #1070).
        let schliessZeile = -1;
        for (let j = i - 1; j >= start; j--) {
          if (!istSchliessen(lines[j], schliesst)) continue;
          // Ein VERZOEGERTES Schliessen traegt keinen Aufruf: `setTimeout(() =>
          // closeModal(...), 700)` laeuft erst, wenn der Block durch ist, und
          // der Merker entsteht erst in `_doClose`. So stand ein toter Aufruf
          // in tasks.js (Review zu #1070).
          if (/\bsetTimeout\s*\(/.test(lines[j])) {
            tot.push(`${datei}:${i + 1} - das Schliessen in Zeile ${j + 1} ist verzoegert, der Merker existiert hier noch nicht`);
            return;
          }
          schliessZeile = j;
          break;
        }
        if (schliessZeile !== -1) {
          const dazwischen = lines.slice(schliessZeile + 1, i);
          if (!dazwischen.some((x) => istNeuaufbau(x, rendererIn(lines)))) {
            tot.push(`${datei}:${i + 1} - zwischen dem Schliessen und dem Aufruf wird nichts neu gebaut`);
            return;
          }
        }
        // (2) Hat die Funktion ueberhaupt mit Dialogen zu tun?
        const beteiligt = funktion.some((x) => istSchliessen(x, schliesst) || /open(Shared)?Modal\s*\(/.test(x));
        if (!beteiligt) tot.push(`${datei}:${i + 1} - die Funktion oeffnet und schliesst keinen Dialog`);
      });
    }
  }
  assert.deepEqual(tot, [],
    'Diese Aufrufe koennen nichts bewirken - refocusAfterRender() braucht ein vorangegangenes '
    + `Schliessen, sonst ist der Merker leer und das Overlay noch offen:\n  ${tot.join('\n  ')}`);
});


/* FUNKTIONSGRENZEN MUESSEN `export` MITLESEN.
 *
 * 36 Dateien unter `public/pages` und `public/components` haben top-level
 * `export function`/`export async function`. Ein Grenz-Regex ohne dieses
 * Praefix sieht sie nicht - und faltet damit alles bis zur naechsten
 * nicht-exportierten Deklaration in den vorigen Block. Genau so geriet der
 * Seiten-`render()` von housekeeping.js in den Block eines Modal-Oeffners, und
 * ein Werkzeug setzte dort einen Aufruf ins Leere (Review zu #1070).
 *
 * Geprueft wird an einer kuenstlichen Quelle, nicht am Repo: so faellt die
 * Sonde auch dann, wenn gerade keine echte Datei den Fehler zeigt.
 */
test('rendererIn erkennt exportierte Funktionen als Grenze', () => {
  // Die erste Funktion rendert NICHT; die exportierte danach schon. Wird das
  // `export` als Grenze uebersehen, faellt deren Rumpf in den Block davor - und
  // die harmlose Funktion gilt faelschlich als Renderer.
  const quelle = [
    'function harmlos() {',
    '  const x = 1;',
    '}',
    'export async function render(container) {',
    '  renderListe();',
    '}',
  ];
  const namen = rendererIn(quelle);
  assert.ok(namen.has('render'), '`export async function render` muss als eigene Funktion erkannt werden');
  assert.ok(!namen.has('harmlos'),
    'ohne das export-Praefix in der Grenze faellt der Rumpf von `render` in den Block davor, '
    + 'und `harmlos` gilt als Renderer, obwohl sie nichts rendert');
});


/* DER KOMMENTAR-SCHNITT DARF KEIN REGEX-LITERAL ZERSCHNEIDEN.
 *
 * `/^https?:\/\//i` enthaelt ein `//` - der escapte Schraegstrich und der
 * schliessende bilden eines -, und ein Schnitt dort verschluckt den Rest der
 * Zeile. Steht darauf ein `refocusAfterRender()` oder ein Rendern, wird es fuer
 * jeden Scanner unsichtbar. Im Repo kommt das Muster mehrfach vor
 * (documents.js, shopping.js, personal-feeds.js).
 */
test('withoutCommentsKeepingLines laesst Regex-Literale und URLs heil', () => {
  const mitRegex = String.raw`if (/^https?:\/\//i.test(u)) refocusAfterRender();`;
  assert.equal(withoutCommentsKeepingLines(mitRegex), mitRegex,
    'ein Regex-Literal mit Schraegstrichen darf die Zeile nicht abschneiden - sonst wird alles '
    + 'dahinter fuer die Ratchets unsichtbar');

  const mitUrl = "const u = 'http://x'; renderAll();";
  assert.equal(withoutCommentsKeepingLines(mitUrl), mitUrl, 'eine URL ist kein Kommentar');

  assert.equal(withoutCommentsKeepingLines('renderAll(); // weg').trim(), 'renderAll();',
    'ein echter Zeilenkommentar muss weiter fallen');
});

/* EIN IMPORT OHNE AUFRUF IST TOTER CODE.
 *
 * Beim Entfernen der toten Aufrufe blieb in birthdays.js der Import stehen
 * (Review zu #1070). Er schadet nicht, aber er behauptet eine Beteiligung, die
 * es nicht gibt - und beim naechsten Lesen sucht jemand den Aufruf.
 */
test('wer refocusAfterRender importiert, ruft es auch', () => {
  const tot = [];
  for (const dir of ['../public/pages', '../public/components', '../public/settings/pages']) {
    const basis = new URL(`${dir}/`, import.meta.url);
    for (const datei of readdirSync(basis).filter((f) => f.endsWith('.js'))) {
      const src = withoutCommentsKeepingLines(read(`${dir}/${datei}`));
      const importiert = /import\s*\{[^}]*\brefocusAfterRender\b[^}]*\}\s*from\s*'\/components\/modal\.js'/.test(src);
      if (!importiert) continue;
      if (/refocusAfterRender\s*\(/.test(src)) continue;
      tot.push(datei);
    }
  }
  assert.deepEqual(tot, [],
    `Diese Dateien importieren refocusAfterRender, ohne es zu rufen:\n  ${tot.join('\n  ')}`);
});


/* VERSCHACHTELUNG, NICHT REIHENFOLGE - direkt geprueft.
 *
 * Die Unterscheidung traegt den Ratchet fuer die haeufigste Bauart, und sie ist
 * an echten Dateien nur zu sehen, solange dort jemand die Form benutzt. Deshalb
 * hier an einer kuenstlichen Quelle: ein `await` im Rueckruf zaehlt, eines auf
 * der Ebene der oeffnenden Funktion nicht.
 */
test('inVerschachtelterFunktion trennt Rueckruf von Dialogvorbereitung', () => {
  const imRueckruf = [
    'function openManager() {',
    '  const onChanged = async () => {',
    '    await loadMeta();',
    '  };',
    '  openSharedModal({ onChanged });',
    '}',
  ];
  assert.equal(inVerschachtelterFunktion(imRueckruf, 0, 2), true,
    'ein `await` im Rueckruf ist eine Auffrischung - genau die Bauart, die der Ratchet halten muss');

  const vorbereitung = [
    'async function openEditor(member) {',
    '  const ids = await loadIds(member.id);',
    '  openModal({ content: ids });',
    '}',
  ];
  assert.equal(inVerschachtelterFunktion(vorbereitung, 0, 1), false,
    'ein `await` auf der Ebene der oeffnenden Funktion bestueckt den Dialog und baut nichts neu auf');

  // Ein `try {` ist kein Rueckruf - sonst waere jeder try-Block eine Verschachtelung.
  const imTry = [
    'async function speichern() {',
    '  try {',
    '    await loadMeta();',
    '  } catch (err) {}',
    '  openModal({});',
    '}',
  ];
  assert.equal(inVerschachtelterFunktion(imTry, 0, 2), false,
    'ein try-Block oeffnet keinen Rueckruf');
});
