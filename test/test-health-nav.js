/**
 * Tests: Gesundheits-Modul — Navigation & Registrierung (Phase 0)
 * Läuft mit: node --loader ./test/test-browser-loader.mjs test/test-health-nav.js
 *
 * Deckt ab:
 *  - health-tabs.js: HEALTH_ROUTES, HEALTH_TABS(), getLastHealthRoute-Fallback,
 *    isHealthRoute
 *  - Router-Registrierung (Routen, ROUTE_ORDER, topLevelSection, Shortcut, Nav)
 *  - Modul abschaltbar (Server-Allowlist + Settings-Toggle-Definition)
 *  - i18n-Parität der neuen Keys über ALLE Locales
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const {
  HEALTH_ROUTES, HEALTH_STORAGE_KEY, HEALTH_TABS, getLastHealthRoute, isHealthRoute,
} = await (async () => {
  global.window = { yuvomi: null };
  global.document = {
    createElement: () => ({
      className: '', dataset: {}, style: {},
      setAttribute() {}, appendChild() {},
      classList: { add() {}, toggle() {} },
      insertAdjacentElement() {},
      addEventListener() {},
    }),
  };
  global.sessionStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = v; },
  };
  return import('../public/utils/health-tabs.js');
})();

// --------------------------------------------------------
// health-tabs.js: Konstanten & Tab-Definitionen
// --------------------------------------------------------
test('HEALTH_ROUTES enthält die sechs Sub-Routen in kanonischer Reihenfolge', () => {
  assert.deepEqual(HEALTH_ROUTES, [
    '/health', '/health/vitals', '/health/cycle', '/health/fasting', '/health/meds', '/health/labs', '/health/activity',
  ]);
});

test('HEALTH_ROUTES ist eingefroren', () => {
  assert.equal(Object.isFrozen(HEALTH_ROUTES), true);
});

test('HEALTH_STORAGE_KEY ist korrekt', () => {
  assert.equal(HEALTH_STORAGE_KEY, 'yuvomi-health-tab');
});

test('HEALTH_TABS(): sechs Legacy-Tabs mit passenden Routen, Label-Keys und Icons', () => {
  const tabs = HEALTH_TABS();
  assert.equal(tabs.length, 6);
  assert.deepEqual(tabs.map((tab) => tab.route), HEALTH_ROUTES.filter((route) => route !== '/health/fasting'));
  assert.deepEqual(tabs.map((tab) => tab.labelKey), [
    'health.tabs.overview', 'health.tabs.vitals', 'health.tabs.cycle',
    'health.tabs.meds', 'health.tabs.labs', 'health.tabs.activity',
  ]);
  assert.deepEqual(tabs.map((tab) => tab.icon), [
    'heart-pulse', 'activity', 'droplet', 'pill', 'flask-conical', 'dumbbell',
  ]);
});

test('HEALTH_TABS({ cycleEnabled: false }): blendet den Zyklus-Tab aus', () => {
  const tabs = HEALTH_TABS({ cycleEnabled: false });
  assert.equal(tabs.length, 5);
  assert.ok(!tabs.some((tab) => tab.route === '/health/cycle'), 'kein Zyklus-Tab');
  assert.deepEqual(tabs.map((tab) => tab.route), [
    '/health', '/health/vitals', '/health/meds', '/health/labs', '/health/activity',
  ]);
});

// --------------------------------------------------------
// isHealthRoute / getLastHealthRoute
// --------------------------------------------------------
test('isHealthRoute erkennt Health-Routen und lehnt andere ab', () => {
  for (const route of HEALTH_ROUTES) assert.equal(isHealthRoute(route), true);
  assert.equal(isHealthRoute('/tasks'), false);
  assert.equal(isHealthRoute('/'), false);
  assert.equal(isHealthRoute('/health/unknown'), false);
});

test('getLastHealthRoute: Fallback /health wenn kein Storage-Eintrag', () => {
  global.sessionStorage._d = {};
  assert.equal(getLastHealthRoute(), '/health');
});

test('getLastHealthRoute: gibt gespeicherte Route zurück', () => {
  global.sessionStorage._d = { 'yuvomi-health-tab': '/health/meds' };
  assert.equal(getLastHealthRoute(), '/health/meds');
});

test('getLastHealthRoute: ignoriert ungültige gespeicherte Route', () => {
  global.sessionStorage._d = { 'yuvomi-health-tab': '/admin' };
  assert.equal(getLastHealthRoute(), '/health');
});

// --------------------------------------------------------
// Router-Registrierung (Struktur-Assertions gegen router.js)
// --------------------------------------------------------
test('router.js registriert alle Health-Routen auf das Health-Seitenmodul', () => {
  const src = read('public/router.js');
  assert.match(src, /HEALTH_ROUTES\.map\(\(path\) => \(\{[\s\S]*page: '\/pages\/health\.js'[\s\S]*module: 'health'/);
  assert.match(src, /ROUTES\.push\(\.\.\.HEALTH_PAGE_ROUTES\)/);
});

test('router.js: /health in ROUTE_ORDER (vor /settings)', () => {
  const src = read('public/router.js');
  const order = src.match(/const ROUTE_ORDER = \[([\s\S]*?)\];/)[1];
  assert.ok(order.includes("'/health'"), '/health fehlt in ROUTE_ORDER');
  assert.ok(order.indexOf("'/health'") < order.indexOf("'/settings'"), '/health muss vor /settings stehen');
});

test('router.js: topLevelSection faltet /health/* auf /health', () => {
  const src = read('public/router.js');
  assert.match(src, /path\.startsWith\('\/health'\)\) return '\/health'/);
});

// Der Titel kam bis 2026-08-08 aus einer Praefixregel in routeTitle(). Er steht
// jetzt an der Route selbst - dieselbe Wahrheit, nur nicht mehr in einer
// zweiten Liste daneben (Audit P1-2; drei Auth-Routen waren dort durchgefallen).
// Geprueft wird deshalb die Quelle, nicht mehr die Regel.
test('router.js: jede /health-Route traegt nav.health als Titel', () => {
  const src = read('public/router.js');
  assert.match(src, /HEALTH_ROUTES\.map\([\s\S]{0,200}?titleKey:\s*'nav\.health'/,
    'die Health-Routen muessen ihren Titel selbst fuehren');
  assert.match(src, /ROUTES\.find\(\(route\) => route\.path === path\)\?\.titleKey/,
    'routeTitle muss den Titel aus ROUTES lesen');
});

test('router.js: Keyboard-Shortcut g h navigiert ins Gesundheitsmodul', () => {
  const src = read('public/router.js');
  assert.match(src, /key: 'g h'[\s\S]*getLastHealthRoute\(\)/);
});

test('router.js: Nav-Eintrag Gesundheit (Sektion home, Icon heart-pulse)', () => {
  // Der Eintrag steht in der Navigation, sein ZEICHEN in MODULE_ICON: seit
  // 2026-08-17 schreibt `navItems()` keinen Icon-Namen mehr auf, sondern holt
  // ihn aus der einen Zuordnung (nav-icons.js). Beides bleibt geprueft, nur
  // eben dort, wo es jeweils steht.
  const src = read('public/router.js');
  assert.match(src, /path: '\/health',[\s\S]*module: 'health',[\s\S]*section: NAV_SECTION\.people/);
  assert.match(read('public/nav-icons.js'), /health:\s+'heart-pulse'/);
});

// --------------------------------------------------------
// Modul abschaltbar (sensible Daten → muss deaktivierbar sein)
// --------------------------------------------------------
test('Server-Allowlist: health ist ein toggelbares Modul', () => {
  const src = read('server/routes/preferences.js');
  assert.match(src, /TOGGLEABLE_MODULES = \[[\s\S]*'health'[\s\S]*\]/);
  assert.match(src, /MODULE_ORDER_RE =[^\n]*\|health\|/);
});

test('Settings-Toggle: health in BUILT_IN_MODULES', () => {
  // Die Liste wohnt seit dem Umzug des Haushalts-Schalters (Critique 2026-08-16)
  // im geteilten module-order.js - zwei Blaetter lesen sie. Ein `icon` fuehrt
  // sie seit 2026-08-17 nicht mehr: das war die vierte Abschrift der Zuordnung
  // Modul -> Zeichen, und die Blaetter holen sie sich aus MODULE_ICON.
  const src = read('public/settings/module-order.js');
  assert.match(src, /\{ id: 'health', labelKey: 'nav\.health' \}/);
});

test('Server-Allowlist: rewards ist toggelbar/sortierbar (Backend-Parität zur Nav)', () => {
  const src = read('server/routes/preferences.js');
  assert.match(src, /TOGGLEABLE_MODULES = \[[\s\S]*'rewards'[\s\S]*\]/);
  assert.match(src, /MODULE_ORDER_RE =[^\n]*\|rewards\|/);
  assert.match(src, /MOBILE_NAV_ORDER_RE =[^\n]*\|rewards\|/);
});

// --------------------------------------------------------
// i18n-Parität: neue Keys in ALLEN Locales vorhanden
// --------------------------------------------------------
test('i18n: nav.health, shortcuts.goHealth und health.* in allen Locales', () => {
  const files = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 20, 'erwartet mindestens 20 Locales');

  const tabKeys = ['overview', 'vitals', 'cycle', 'fasting', 'meds', 'labs', 'activity'];
  const panels = ['overview', 'vitals', 'cycle', 'fasting', 'meds', 'labs', 'activity'];

  for (const file of files) {
    const data = JSON.parse(read(join('public/locales', file)));
    assert.ok(data.nav?.health, `${file}: nav.health fehlt`);
    assert.ok(data.shortcuts?.goHealth, `${file}: shortcuts.goHealth fehlt`);
    for (const key of tabKeys) {
      assert.ok(data.health?.tabs?.[key], `${file}: health.tabs.${key} fehlt`);
    }
    for (const panel of panels) {
      assert.ok(data.health?.[panel]?.title, `${file}: health.${panel}.title fehlt`);
      assert.ok(data.health?.[panel]?.emptyTitle, `${file}: health.${panel}.emptyTitle fehlt`);
      assert.ok(data.health?.[panel]?.emptyDesc, `${file}: health.${panel}.emptyDesc fehlt`);
    }
  }
});
