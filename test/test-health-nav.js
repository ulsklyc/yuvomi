/**
 * Tests: Gesundheits-Modul — Navigation & Registrierung (Phase 0)
 * Läuft mit: node --loader ./test/test-browser-loader.mjs test/test-health-nav.js
 *
 * Deckt ab:
 *  - health-tabs.js: HEALTH_ROUTES, HEALTH_AREAS(), getLastHealthRoute-Fallback,
 *    isHealthRoute, die Pfad-Adresse je Bereich und die Umleitung alter
 *    `?tab=`-Adressen (R10 G1)
 *  - Router-Registrierung (Routen, topLevelSection, Shortcut, Nav)
 *  - Modul abschaltbar (Server-Allowlist + Settings-Toggle-Definition)
 *  - i18n-Parität der neuen Keys über ALLE Locales
 *  - Zyklus-Tagebuch-Modal (health.js): Quelltext-Guards ohne DOM/Browser fuer
 *    die Quick-Links-Verhaltenskorrekturen und die neuen Tages-Log-Felder
 *    (Zervixschleim, LH-/Schwangerschaftstest, Intimitaet, Gefuehle) -
 *    siehe Abschnitt am Dateiende.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const {
  HEALTH_ROUTES, HEALTH_STORAGE_KEY, HEALTH_AREAS, getLastHealthRoute, isHealthRoute,
  healthAddress, healthAreaId, healthAreaRoute, legacyHealthTabPath, rememberHealthRoute,
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
test('HEALTH_ROUTES enthält die neun Sub-Routen in kanonischer Reihenfolge', () => {
  assert.deepEqual(HEALTH_ROUTES, [
    '/health', '/health/vitals', '/health/cycle', '/health/fasting', '/health/meds', '/health/prevention', '/health/labs', '/health/activity', '/health/nutrition',
  ]);
});

test('HEALTH_ROUTES ist eingefroren', () => {
  assert.equal(Object.isFrozen(HEALTH_ROUTES), true);
});

test('HEALTH_STORAGE_KEY ist korrekt', () => {
  assert.equal(HEALTH_STORAGE_KEY, 'yuvomi-health-tab');
});

test('HEALTH_AREAS(): Uebersicht plus sieben Bereiche mit Kennung, Route, Label-Key und Icon', () => {
  const areas = HEALTH_AREAS();
  assert.equal(areas.length, 8);
  assert.deepEqual(areas.map((a) => a.route), HEALTH_ROUTES.filter((route) => route !== '/health/fasting'));
  assert.deepEqual(areas.map((a) => a.id), [
    'overview', 'vitals', 'cycle', 'meds', 'prevention', 'labs', 'activity', 'nutrition',
  ]);
  assert.deepEqual(areas.map((a) => a.labelKey), [
    'health.tabs.overview', 'health.tabs.vitals', 'health.tabs.cycle',
    'health.tabs.meds', 'health.tabs.prevention', 'health.tabs.labs', 'health.tabs.activity',
    'health.tabs.nutrition',
  ]);
  assert.deepEqual(areas.map((a) => a.icon), [
    'heart-pulse', 'activity', 'droplet', 'pill', 'syringe', 'flask-conical', 'dumbbell', 'salad',
  ]);
});

test('HEALTH_AREAS({ cycleEnabled: false }): blendet den Zyklus aus', () => {
  const areas = HEALTH_AREAS({ cycleEnabled: false });
  assert.equal(areas.length, 7);
  assert.ok(!areas.some((a) => a.route === '/health/cycle'), 'kein Zyklus-Bereich');
  assert.deepEqual(areas.map((a) => a.route), [
    '/health', '/health/vitals', '/health/meds', '/health/prevention', '/health/labs', '/health/activity', '/health/nutrition',
  ]);
});

// --------------------------------------------------------
// R10 G1: jeder Bereich hat seine Adresse, alte `?tab=`-Adressen leiten um
// --------------------------------------------------------
test('jeder Bereich hat eine eigene, registrierte Adresse - und die Adresse nennt genau ihn', () => {
  const all = HEALTH_AREAS({ cycleEnabled: true, fastingEnabled: true });
  assert.equal(all.length, HEALTH_ROUTES.length, 'jede Health-Route ist ein Bereich und umgekehrt');
  for (const area of all) {
    assert.ok(HEALTH_ROUTES.includes(area.route), `${area.id}: Route ${area.route} ist nicht registriert`);
    assert.equal(healthAreaRoute(area.id), area.route, `${area.id}: Adresse`);
    assert.equal(healthAreaId(area.route), area.id, `${area.route}: Kennung`);
    // Der Liste-+-Detail-Baustein liest und schreibt die Auswahl ueber diese Adresse.
    assert.equal(healthAddress.read({ pathname: area.route, search: '', hash: '' }), area.id);
    assert.equal(healthAddress.href(area.id), area.route);
  }
  // Die Uebersicht ist `/health` - eine Seite ohne Auswahl gibt es nicht.
  assert.equal(healthAddress.href(null), '/health');
  // Fremde Adressen gehoeren nicht zu dieser Seite: der Router zeichnet neu.
  assert.equal(healthAddress.read({ pathname: '/tasks', search: '', hash: '' }), undefined);
  assert.equal(healthAddress.read({ pathname: '/health/unknown', search: '', hash: '' }), undefined);
  assert.equal(healthAreaRoute('unknown'), '/health');
});

test('alte /health?tab=<bereich>-Adressen landen auf der Adresse des Bereichs', () => {
  const loc = (search, hash = '') => ({ pathname: '/health', search, hash });
  for (const area of HEALTH_AREAS({ cycleEnabled: true, fastingEnabled: true })) {
    assert.equal(legacyHealthTabPath(loc(`?tab=${area.id}`)), area.route, `?tab=${area.id}`);
  }
  // Die Tab-Route als Wert, Grossschreibung, uebrige Parameter und Anker bleiben.
  assert.equal(legacyHealthTabPath(loc('?tab=/health/meds')), '/health/meds');
  assert.equal(legacyHealthTabPath(loc('?tab=Labs')), '/health/labs');
  assert.equal(legacyHealthTabPath(loc('?tab=fasting&x=1', '#history')), '/health/fasting?x=1#history');
  // Ein Tab, den es nicht gibt, faellt auf die Uebersicht - der Parameter geht.
  assert.equal(legacyHealthTabPath(loc('?tab=nope')), '/health');
  // Nichts umzuleiten: keine alte Adresse oder gar keine Gesundheit.
  assert.equal(legacyHealthTabPath(loc('')), null);
  assert.equal(legacyHealthTabPath(loc('?x=1')), null);
  assert.equal(legacyHealthTabPath({ pathname: '/tasks', search: '?tab=meds', hash: '' }), null);
  assert.equal(legacyHealthTabPath({ pathname: '/health/meds', search: '?tab=labs', hash: '' }), null);
});

test('health.js leitet die alte Adresse um, BEVOR die Seite die Auswahl liest', () => {
  // Der Baustein liest die Auswahl beim Einhaengen aus der Adresse
  // (healthAddress.read). Stuende die Umleitung danach, zeigte die Seite fuer
  // `/health?tab=meds` die Uebersicht und schriebe erst dann die neue Adresse.
  const src = read('public/pages/health.js');
  const redirect = src.search(/const legacy = legacyHealthTabPath\(location\);\s*if \(legacy\) history\.replaceState\(/);
  const mount = src.search(/mountMasterDetail\(\{[\s\S]{0,200}address: healthAddress/);
  assert.ok(redirect > 0, 'render() muss legacyHealthTabPath per replaceState einloesen');
  assert.ok(mount > redirect, 'der Baustein wird mit healthAddress und NACH der Umleitung eingehaengt');
});

test('auch die Soft-Navigation (update) loest eine alte ?tab=-Adresse ein, bevor sie auswaehlt', () => {
  // Ein Zurueck auf einen Verlaufseintrag `/health?tab=labs`, waehrend die
  // Seite steht, laeuft ueber update() statt render() - gemessen 2026-09-27:
  // Adresse blieb `/health?tab=labs`, gezeigt wurde die Uebersicht.
  const src = read('public/pages/health.js');
  const start = src.indexOf('export async function update(');
  assert.ok(start > 0, 'update() fehlt');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const redirect = body.search(/const legacy = legacyHealthTabPath\(location\);\s*if \(legacy\) history\.replaceState\(/);
  const select = body.search(/md\.select\(/);
  assert.ok(redirect > 0, 'update() muss legacyHealthTabPath per replaceState einloesen');
  assert.ok(select > redirect, 'erst umleiten, dann auswaehlen');
  assert.match(body, /normalizeHealthPath\(legacy \? window\.location\.pathname/,
    'nach der Umleitung zaehlt die neue Adresse, nicht der alte Pfad /health');
});

test('rememberHealthRoute merkt nur Health-Routen (Kurzbefehl g h)', () => {
  global.sessionStorage._d = {};
  rememberHealthRoute('/health/labs');
  assert.equal(getLastHealthRoute(), '/health/labs');
  rememberHealthRoute('/tasks');
  assert.equal(getLastHealthRoute(), '/health/labs');
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
  assert.match(src, /allRoutes\(\)\.find\(\(route\) => route\.path === path\)\?\.titleKey/,
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

  const tabKeys = ['overview', 'vitals', 'cycle', 'fasting', 'meds', 'prevention', 'labs', 'activity', 'nutrition'];
  const panels = ['overview', 'vitals', 'cycle', 'fasting', 'meds', 'prevention', 'labs', 'activity', 'nutrition'];

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

// --------------------------------------------------------
// Zyklus-Tagebuch-Modal (health.js): Quelltext-Guards, kein DOM/Browser
// --------------------------------------------------------
// Dieselbe Technik wie oben (Regex gegen den rohen Quelltext), diesmal gegen
// public/pages/health.js. Das eigentliche Verhalten wurde manuell im Browser
// verifiziert - diese Guards verhindern nur, dass eine
// spaetere, unbeabsichtigte Aenderung den jeweiligen Fix wieder einreisst,
// ohne dass eine gruene Suite das meldet.

const HEALTH_JS = read('public/pages/health.js');

/** Text einer Top-Level-Funktion (`function name(...) { ... }\n`), ausgehend vom Namen. */
function functionSource(name) {
  return HEALTH_JS.match(new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`))?.[0];
}

test('A-2: Tages-Log-Modal fokussiert beim Oeffnen nicht automatisch das erste Feld', () => {
  const fn = functionSource('openDayLogModal');
  assert.ok(fn, 'openDayLogModal() nicht gefunden');
  // 'none' unterdrueckt modal.js' eigenen Default (erstes <input>/<select>,
  // hier die Basaltemperatur weiter unten im Formular) - dessen Fokus liess
  // den Browser sonst zu ihr scrollen und die Blutungsstaerke-Gruppe (das
  // meistgenutzte Feld, ganz oben) aus dem sichtbaren Bereich rutschen.
  assert.match(fn, /initialFocus:\s*'none'/, "initialFocus muss auf 'none' stehen");
  assert.match(fn, /\[data-group="flow"\]\s*\.health-choice/,
    'onSave() muss den Fokus stattdessen manuell auf den ersten Flow-Chip setzen');
});

test('A-3: Perioden-Modal warnt weich bei Zukunftsdatum/Ueberschneidung, ohne das Speichern zu blockieren', () => {
  assert.match(HEALTH_JS, /health\.cycle\.period\.warningFuture/, 'Zukunfts-Warnung fehlt');
  assert.match(HEALTH_JS, /health\.cycle\.period\.warningOverlap/, 'Ueberschneidungs-Warnung fehlt');
  assert.match(HEALTH_JS, /function periodOverlapsExisting/, 'Ueberschneidungs-Pruefung fehlt');
  const fn = functionSource('openPeriodModal');
  assert.ok(fn, 'openPeriodModal() nicht gefunden');
  assert.match(fn, /periodOverlapsExisting\(/, 'openPeriodModal() muss die Ueberschneidungs-Pruefung nutzen');
});

test('A-4: health.cycle.unit.days/history.cycleLength werden immer mit `count` aufgerufen', () => {
  // t() waehlt die `_one`-Variante ausschliesslich ueber einen numerischen
  // `count`-Parameter (siehe public/i18n.js) - `value` allein (der fertig
  // formatierte Anzeigetext) reicht nicht, das war genau A-4s "1 Tage"-Fehler.
  const callsites = [...HEALTH_JS.matchAll(/t\('health\.cycle\.unit\.days',\s*\{([^}]*)\}\)/g)];
  assert.ok(callsites.length >= 6, `erwartet mindestens 6 Aufrufstellen, gefunden ${callsites.length}`);
  for (const [, args] of callsites) {
    assert.match(args, /count:/, `Aufruf ohne count: t('health.cycle.unit.days', { ${args.trim()} })`);
  }
  const cycleLengthCall = HEALTH_JS.match(/t\('health\.cycle\.history\.cycleLength',\s*\{([^}]*)\}\)/);
  assert.ok(cycleLengthCall, 'health.cycle.history.cycleLength-Aufruf nicht gefunden');
  assert.match(cycleLengthCall[1], /count:/, 'history.cycleLength-Aufruf ohne count');
});

test('A-5: cycleStatsSourceText() unterscheidet Eigen- und Fremdansicht fuer die Historie-Quelle', () => {
  const fn = functionSource('cycleStatsSourceText');
  assert.ok(fn, 'cycleStatsSourceText() nicht gefunden');
  assert.match(fn, /isOwnCycleView\(\)/, 'muss zwischen eigener und fremder Ansicht unterscheiden');
  assert.match(fn, /health\.cycle\.stats\.source\.historyOther/, 'Person-neutrale Variante fehlt');
});

test('Tages-Log-Submit sendet cervix_mucus, lh_test, pregnancy_test, feelings, intimacy - nicht mehr mood', () => {
  const fn = functionSource('openDayLogModal');
  assert.ok(fn, 'openDayLogModal() nicht gefunden');
  for (const field of ['cervix_mucus', 'lh_test', 'pregnancy_test', 'feelings', 'intimacy']) {
    assert.match(fn, new RegExp(`${field}[,:]`), `Feld ${field} fehlt im Submit-Body`);
  }
  // `mood` ist seit Migration 211 nur noch ein Lesewert - der neue Body darf
  // ihn nicht mehr schreiben, `feelings` ersetzt ihn vollstaendig.
  assert.ok(!/body\s*=\s*\{[\s\S]*?mood:/.test(fn), 'mood darf im Submit-Body nicht mehr geschrieben werden');
});

test('A-9/B-1: der Kalender traegt eine 4-stufige Flow-Skala + einen Log-Punkt-Legendeneintrag', () => {
  const fn = functionSource('cycleLegendMarkup');
  assert.ok(fn, 'cycleLegendMarkup() nicht gefunden');
  assert.match(fn, /health\.cycle\.legend\.logged/, 'Legendeneintrag fuer den einfachen Log-Punkt fehlt');
  assert.match(fn, /cycle-legend__flow-row/, 'kompakte Flow-Skalen-Zeile fehlt');
  // Eine einzige Zeile fuer alle vier Stufen - "Keep the legend from exploding".
  assert.match(fn, /FLOW_LEVELS\.filter/, 'die Stufen muessen aus FLOW_LEVELS kommen, nicht hartkodiert sein');
});

// R23 S10 (distill, Critique G5 P3 "Zyklus drei Legenden"): die Kalender-
// Legende erklaert nur, was der gerenderte Monat zeigt - wie bisher schon
// "Eisprung bestaetigt" und PMS.
test('R23: die Zyklus-Legende nennt nur, was der Monat zeigt', () => {
  const cal = functionSource('cycleCalendarMarkup');
  assert.match(cal, /const seen = new Set\(\);/);
  for (const what of ['today', 'logged', 'fertile', 'ovulation', 'intimacy']) {
    assert.match(cal, new RegExp(`seen\\.add\\('${what}'\\)`), `${what} wird gezaehlt`);
  }
  assert.match(cal, /seen\.add\(c\.predicted \? 'predicted' : 'period'\)/);
  assert.match(cal, /if \(c\.inMonth\) \{/, 'nur Tage des Monats zaehlen');
  assert.match(cal, /cycleLegendMarkup\(\{ hasConfirmedOvulation, showPms: pmsVisibleInMonth, own, seen \}\)/);
  const legend = functionSource('cycleLegendMarkup');
  assert.match(legend, /\]\.filter\(\(item\) => shows\(item\.what\)\);/);
  assert.match(legend, /FLOW_LEVELS\.filter\(\(f\) => shows\(`flow:\$\{f\.value\}`\)\)/, 'nur die Staerken, die im Monat stehen');
  assert.match(legend, /if \(!rows && !heartRow && !pmsRow && !flowScale\) return '';/, 'ein leerer Monat traegt keine Legende');
});

test('T2: bestätigtes Fenster (BBT) traegt eine eigene Klasse, getrennt von "predicted"', () => {
  const fn = functionSource('cycleCalendarMarkup');
  assert.ok(fn, 'cycleCalendarMarkup() nicht gefunden');
  assert.match(fn, /c\.confirmed[\s\S]{0,40}is-confirmed/, 'confirmed-Zellen muessen is-confirmed tragen');
  // Die Legende zeigt "Eisprung bestätigt" NUR, wenn der gerenderte Monat
  // tatsächlich eine bestätigte Zelle enthält (kein Erklären eines nicht
  // sichtbaren Zustands).
  assert.match(fn, /hasConfirmedOvulation/, 'hasConfirmedOvulation-Sichtbarkeitspruefung fehlt');
  const legendFn = functionSource('cycleLegendMarkup');
  assert.match(legendFn, /health\.cycle\.status\.ovulationConfirmed/, 'Legendeneintrag "Eisprung bestätigt" fehlt');
});

test('Intimitäts-Marker nur in der eigenen Ansicht, eigene Kalender-Ecke', () => {
  const fn = functionSource('cycleCalendarMarkup');
  assert.ok(fn, 'cycleCalendarMarkup() nicht gefunden');
  assert.match(fn, /own\s*\?\s*\n?\s*new Set/, 'intimacyDates darf nur in der eigenen Ansicht befuellt werden');
  assert.match(fn, /l\.intimacy/, 'Intimitäts-Filter auf cycle.logs fehlt');
  assert.match(fn, /cycle-cal__intimacy-icon/, 'Herz-Marker-Klasse fehlt');
  const legendFn = functionSource('cycleLegendMarkup');
  assert.match(legendFn, /own && shows\('intimacy'\)\s*\n?\s*\?\s*`<span class="cycle-legend__item">.*heart/, 'Legendeneintrag muss own-gated sein');
});

// pmsWindow() wird nicht mehr INNERHALB von cycleCalendarMarkup() aufgerufen -
// renderCycleShell() berechnet `pms` EINMAL pro Render (own-gated) und reicht
// es als Parameter an Bubble UND Kalender weiter (vorher zweimal berechnet,
// u.a. ohne Own-Gate im Kalender).
test('PMS-Fenster wird EINMAL (own-gated) in renderCycleShell berechnet und an Bubble+Kalender weitergereicht', () => {
  const shellFn = functionSource('renderCycleShell');
  assert.ok(shellFn, 'renderCycleShell() nicht gefunden');
  assert.match(shellFn, /const pms = own\s*\?\s*pmsWindow\(cycle\.logs,\s*cycle\.periods,\s*cycleSettings\(\),\s*todayKey\(\)\)\s*:\s*null;/,
    'pms muss genau einmal, own-gated berechnet werden');
  assert.match(shellFn, /cycleBubbleMarkup\(prediction,\s*pms[,)]/, 'die Bubble muss das vorberechnete pms erhalten');
  assert.match(shellFn, /cycleCalendarMarkup\(own,\s*pms[,)]/, 'der Kalender muss das vorberechnete pms erhalten');

  const fn = functionSource('cycleCalendarMarkup');
  assert.ok(fn, 'cycleCalendarMarkup() nicht gefunden');
  // Nur der tatsächliche Funktionsaufruf ist verboten - der Dokblock darf
  // "pmsWindow()" weiterhin als Prosa-Verweis erwähnen.
  assert.ok(!/pmsWindow\(cycle\.logs/.test(fn), 'cycleCalendarMarkup() darf pmsWindow() nicht mehr selbst aufrufen');
  assert.match(fn, /function cycleCalendarMarkup\(own,\s*pms[,)]/, 'pms muss Parameter sein');
  assert.match(fn, /!c\.phase[\s\S]{0,20}inPmsWindow/, 'PMS-Shading darf nur auf Zellen ohne eigene Phase greifen');
  assert.match(fn, /pmsVisibleInMonth/, 'Sichtbarkeits-Flag fuer die Legende fehlt');
  const legendFn = functionSource('cycleLegendMarkup');
  assert.match(legendFn, /health\.cycle\.legend\.pms/, 'PMS-Legendeneintrag fehlt');
});

test('Schnellzugriffs-Links schliessen ueber den regulaeren (Dirty-Check-)Pfad, bevor sie navigieren', () => {
  const fn = functionSource('openDayLogModal');
  assert.ok(fn, 'openDayLogModal() nicht gefunden');
  // Ein erzwungenes closeModal({ force: true }) vor der Navigation wuerde den
  // eingebauten Dirty-Check umgehen (ungespeicherte Eingaben giengen
  // stillschweigend verloren) - deshalb explizit das NICHT erzwungene
  // closeModal(), das bei ungespeicherten Aenderungen selbst nachfragt.
  assert.match(fn, /cycle-log-painkiller[\s\S]{0,200}await closeModal\(\)[\s\S]{0,80}navigate\('\/health\/meds'\)/,
    'painkiller-Link muss vor der Navigation ein nicht erzwungenes closeModal() abwarten');
  assert.match(fn, /cycle-log-weight[\s\S]{0,200}await closeModal\(\)[\s\S]{0,80}navigate\('\/health\/vitals'\)/,
    'weight-Link muss vor der Navigation ein nicht erzwungenes closeModal() abwarten');
});

// --------------------------------------------------------
// Today-Bubble: offene Periode + fällige Vorhersage, Partner-Erinnerung im
// Client, cycleBubbleShell()s icon-Parameter
// --------------------------------------------------------

test('Bubble bietet "Periode starten" NICHT an, solange eine Periode noch offen ist', () => {
  const fn = functionSource('cycleBubbleMarkup');
  assert.ok(fn, 'cycleBubbleMarkup() nicht gefunden');
  assert.match(fn, /const openPeriod = cycleOpenPeriod\(\);/, 'muss cycleOpenPeriod() bei faelliger/ueberfaelliger Vorhersage abfragen');
  assert.match(fn, /if \(openPeriod\)[\s\S]{0,500}cycle-bubble-end-period/,
    'bei offener Periode muss die Bubble den Beenden-Knopf (eigener data-action) zeigen');
  assert.match(fn, /health\.cycle\.bubble\.periodStillOpen/, 'die "laeuft die noch?"-Zeile fehlt');
  // Die "Periode starten"-CTA darf danach (else-Zweig) weiterhin stehen -
  // beide Knoepfe rufen dieselben Funktionen wie die Aktionsleiste auf, kein
  // zweiter Speicherpfad.
  assert.match(fn, /data-action="cycle-bubble-start-period"/, 'Start-CTA (fuer den Fall ohne offene Periode) fehlt');

  const wireFn = functionSource('wireCycle');
  assert.ok(wireFn, 'wireCycle() nicht gefunden');
  assert.match(wireFn, /cycle-bubble-end-period[\s\S]{0,80}cycleEndPeriodToday\(\)/,
    'der Bubble-Beenden-Knopf muss cycleEndPeriodToday() aufrufen (kein zweiter Codepfad)');
});

test('cycleReminderBody() erkennt eine Partner-Periodenerinnerung ueber cycle_anchor_kind/cycle_owner_name', () => {
  const remindersJs = read('public/reminders.js');
  const fn = remindersJs.match(/function cycleReminderBody[\s\S]*?\n}\n/)?.[0];
  assert.ok(fn, 'cycleReminderBody() nicht gefunden');
  assert.match(fn, /cycle_anchor_kind === 'partner_period'/, 'muss den Partner-Anker erkennen');
  assert.match(fn, /health\.cycle\.status\.partnerNextPeriod\b/, 'muss die partnerNextPeriod-Übersetzung nutzen, wenn der Name bekannt ist');
  assert.match(fn, /cycle_owner_name/, 'muss den Namen des Zyklus-Eigentümers verwenden');
  assert.match(fn, /health\.cycle\.status\.partnerNextPeriodNeutral/, 'muss einen neutralen Fallback nennen, wenn der Name fehlt - nie faelschlich die eigene "Naechste Periode"');
});

test('cycleBubbleShell() nimmt einen icon-Parameter, der Schwangerschafts-Zweig nutzt ihn statt eigener Wrapper-HTML', () => {
  const shellSrc = HEALTH_JS.match(/function cycleBubbleShell[\s\S]*?\n}\n/)?.[0];
  assert.ok(shellSrc, 'cycleBubbleShell() nicht gefunden');
  assert.match(shellSrc, /icon\s*=\s*'sparkles'/, 'icon-Parameter mit Sparkles-Default fehlt');

  const fn = functionSource('cycleBubbleMarkup');
  assert.match(fn, /return cycleBubbleShell\(line1,\s*'',\s*'baby'\)/,
    'der Schwangerschafts-Zweig muss cycleBubbleShell() mit icon="baby" statt eigener Wrapper-HTML nutzen');
});

// --------------------------------------------------------
// Komponenten-Kanon (Runde 5, 2026-09-26): Kopf-Pille, Dialogfuss, Lesemass,
// Radius-Skala. Der Ratchet in test:control-dialect zaehlt die Abweichler
// app-weit; diese Guards halten, was er nicht sieht - die Verdrahtung.
// --------------------------------------------------------

test('Kanon: der Kontext-FAB dockt am Desktop an - Aktions-Slot im Kopf, Nomen je Tab, Nomen bleibt beim Ausblenden', () => {
  // Ohne `.page-toolbar__actions` im Kopf dockt der Router (dockFabIntoToolbar)
  // stumm nicht an, und das Nomen waere nur ein Attribut, das niemand zeigt.
  const render = HEALTH_JS.match(/export async function render\(container[\s\S]*?\n}\n/)?.[0];
  assert.ok(render, 'render() nicht gefunden');
  // Seit R16 traegt der Slot einen eigenen Traeger fuer das Werkzeug des Kopfs
  // (CSV-Export); der Router dockt die Pille daneben in denselben Slot.
  assert.match(render, /<header class="page-toolbar page-toolbar--title-tools health-toolbar">[\s\S]*?<div class="page-toolbar__actions"><span class="health-toolbar__tools" id="health-tools">[^\n]*<\/span><\/div>[\s\S]*?<\/header>/,
    'der Gesundheitskopf braucht den Aktions-Slot, in den der Router die Kopf-Pille legt');
  assert.match(render, /createPageFab\(\{[^}]*dockLabel: t\('newLabel\.\w+'\)/, 'createPageFab ohne Nomen dockt nie an');

  const update = functionSource('updateHealthFab');
  assert.ok(update, 'updateHealthFab() nicht gefunden');
  // Seit R24 (E9) traegt jede Ansicht ihren Aufruf, auch Uebersicht und
  // Zyklus - einige davon mehrzeilig.
  const actions = update.match(/setPageFabAction\(_fab, \{[\s\S]*?\}\);/g) ?? [];
  assert.ok(actions.length >= 10, `erwartet: ein Aufruf je Ansicht (9) plus der Ausblend-Zweig, gefunden ${actions.length}`);
  for (const call of actions) {
    // Auch der Ausblend-Zweig: der Router dockt nur beim Seitenaufbau an und
    // nur mit `data-dock-label` - wer auf der Uebersicht einsteigt und das
    // Nomen hier loeschte, behielte den schwebenden Knopf fuer den ganzen Besuch.
    assert.match(call, /dockLabel:/, `ohne Nomen: ${call}`);
  }
});

test('Kanon: Dialogknoepfe stehen im Fuss (.modal-panel__footer), und der Absende-Handler sucht seinen Knopf am Panel', () => {
  assert.doesNotMatch(HEALTH_JS, /class="modal-actions"/, 'Knopfzeile im Dialogkoerper statt im Fuss');
  // mountFooter() (modal.js) hebt den Fuss aus dem <form> ans Panel. Ein
  // `form.querySelector('[type="submit"]')` findet ihn danach nicht mehr und
  // liefert null - im Messwert-Dialog warf `submitBtn.disabled` dann beim
  // ersten Absenden einen TypeError.
  assert.doesNotMatch(HEALTH_JS, /form\.querySelector\(\s*['"]\[type="submit"\]/,
    'der Absende-Knopf liegt nach dem Heben nicht mehr im <form> - am Panel suchen');
  assert.doesNotMatch(HEALTH_JS, /class="btn btn--ghost"[^>]*>\$\{esc\(t\('common\.cancel'\)\)\}/, 'Abbrechen ist btn--secondary, nie ghost');
  assert.doesNotMatch(HEALTH_JS, /btn--danger btn--ghost/, 'Loeschen im Dialog ist btn--danger-outline mit Icon und Text');
});

test('Beifang: Karten der Uebersicht auf der Radius-Skala, Disclaimer im Lesemass', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = read('public/styles/health.css');
  for (const { selector, body } of eachRule(css)) {
    // calc(--radius-* + Npx) erfindet eine Stufe (14px), die die Skala nicht kennt.
    // Erlaubt bleibt die Konzentrik-Formel mit MINUS (tokens.css).
    assert.doesNotMatch(body, /border-radius:\s*calc\(var\(--radius-[a-z0-9]+\)\s*\+/, `${selector}: Radius ausserhalb der Skala`);
  }
  const disclaimer = [...eachRule(css)].find((r) => r.selector.trim() === '.health-disclaimer' && !r.at.length);
  assert.ok(disclaimer, '.health-disclaimer nicht gefunden');
  const measure = disclaimer.body.match(/max-inline-size:\s*(\d+)ch/);
  assert.ok(measure, 'der Disclaimer lief am Desktop ueber die volle Breite (~198 Zeichen je Zeile)');
  const ch = Number(measure[1]);
  assert.ok(ch >= 45 && ch <= 75, `Lesemass ${ch}ch ausserhalb 45-75ch`);
});

// --------------------------------------------------------
// R14 P3/P6: Personenwahl in den Kopf, Heute vor die Bereichsliste
// --------------------------------------------------------
//
// Gemessen 390x844: auf jeder Bereichsseite stand die Personenwahl als eigene
// Zeile (y122-170, erste Karte y186); auf der Uebersicht bei y=594 HINTER der
// Bereichsliste, „Heute faellig" bei y=658, „Schnell erfassen" bei y=1916. Am
// Desktop fehlte der Detailspalte ein Kopf mit dem Bereichsnamen (nur sr-only).

// R23 (Critique G5 P2 "Personenwahl an drei Orten"): die Pille stand im
// Detailkopf, in der Zeile „‹ Gesundheit" und im Streifen vor der Liste; der
// Tipp in einen Bereich hob den Kopf von 65 auf 113px. Jetzt EIN Ort: der
// Seitenkopf, in jeder Breite und jeder Ansicht.
test('R14 P3/P6 + R23: der Umzugsplan - die Person immer in den Kopf, Telefon-Uebersicht Heute vor die Liste', async () => {
  const { hoistPlan } = await import('../public/utils/health-hoist.js');
  const person = [{ part: 'person', slot: 'toolbar' }];
  assert.deepEqual(hoistPlan({ split: true, overview: false, phone: false }), person, 'Desktop: Kopf, nicht Detailkopf');
  assert.deepEqual(hoistPlan({ split: true, overview: true, phone: false }), person);
  assert.deepEqual(hoistPlan({ split: false, overview: false, phone: true }), person, 'Bereich: derselbe Ort');
  assert.deepEqual(hoistPlan({ split: false, overview: true, phone: false }), person, 'Tablet-Uebersicht: derselbe Ort');
  assert.deepEqual(hoistPlan({ split: false, overview: true, phone: true }).map((p) => `${p.part}>${p.slot}`),
    ['person>toolbar', 'banner>priority', 'brief>priority', 'due>priority', 'prn>priority'],
    'Telefon-Uebersicht: Hinweis, der Satz (R21 D6), Heute faellig und Bei Bedarf (R24 P2-7) stehen VOR der Bereichsliste; die Person im Kopf');
  for (const plan of [hoistPlan({ split: true, overview: true, phone: false }), hoistPlan({ split: false, overview: true, phone: true })]) {
    assert.ok(!plan.some((p) => p.slot === 'detail'), 'kein Detailkopf-Ziel mehr');
  }
});

test('R14 P3/P6: der Umzug haengt verdrahtete Knoten um und bringt sie zurueck oder verwirft sie', async () => {
  const { applyHoistPlan, hoistPlan } = await import('../public/utils/health-hoist.js');
  // Kleines DOM-Doppel: genug Baum fuer matches/querySelector/insertBefore.
  class El {
    constructor(cls) { this.cls = cls; this.children = []; this.parentElement = null; this.connected = true; }
    get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return n.connected; }
    get firstChild() { return this.children[0] ?? null; }
    get nextSibling() { const p = this.parentElement; return p ? p.children[p.children.indexOf(this) + 1] ?? null : null; }
    matches(sel) { return sel.split(',').some((s) => s.trim() === `.${this.cls}`); }
    contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
    querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
    remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
    appendChild(n) { n.remove(); this.children.push(n); n.parentElement = this; return n; }
    insertBefore(n, ref) { n.remove(); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); n.parentElement = this; return n; }
  }
  const page = new El('page');
  const mk = (cls, parent) => parent.appendChild(new El(cls));
  const toolbar = mk('slot-toolbar', page);
  const detail = mk('slot-detail', page);
  const priority = mk('slot-priority', page);
  const panel = mk('health-panel', page);
  const root = mk('root', panel);
  const person = mk('health-person-switcher', root);
  const grid = mk('health-overview__grid', root);
  const due = mk('health-overview__card--due', grid);
  mk('health-overview__card--other', grid);
  const quick = mk('health-overview__card--prn', grid);
  const slots = { toolbar, detail, priority };

  applyHoistPlan(hoistPlan({ split: false, overview: true, phone: true }), { panel, slots });
  assert.deepEqual(priority.children, [due, quick], 'in Planreihenfolge vor der Liste');
  assert.deepEqual(toolbar.children, [person], 'die Person im Kopf (R23)');
  applyHoistPlan(hoistPlan({ split: true, overview: true, phone: false }), { panel, slots });
  assert.deepEqual(toolbar.children, [person], 'Desktop: dieselbe Pille am selben Ort');
  assert.equal(detail.children.length, 0, 'kein Detailkopf-Ziel');
  assert.equal(priority.children.length, 0);
  assert.deepEqual(grid.children.map((c) => c.cls), ['health-overview__card--due', 'health-overview__card--other', 'health-overview__card--prn'],
    'die Karten stehen wieder an ihrem Platz im Raster');
  // Das Panel baut neu (Personenwechsel): die umgezogene alte Pille ist veraltet.
  root.children.splice(0, 1, new El('health-person-switcher'));
  root.children[0].parentElement = root;
  const frisch = root.children[0];
  applyHoistPlan(hoistPlan({ split: false, overview: false, phone: true }), { panel, slots });
  assert.deepEqual(toolbar.children, [frisch], 'die FRISCHE Pille zieht um');
  assert.ok(!toolbar.children.includes(person), 'die alte ist weg, nicht doppelt zurueck im Panel');
  assert.equal(root.children.filter((c) => c.cls === 'health-person-switcher').length, 0);
});

test('R14 P3/P6: Kopf, Streifen und Detailkopf stehen im Markup, die Karten sind benannt', async () => {
  assert.match(HEALTH_JS, /class="health-toolbar__person" data-health-person-slot/, 'Slot in der Zeile „‹ Gesundheit"');
  // Seit R18 folgt dem Umzugsziel sein Skelett (Geschwister, nicht Kind - siehe den R18-Test unten).
  assert.match(HEALTH_JS, /class="health-priority" data-health-priority><\/div>\s*\$\{prioritySkeletonMarkup\(\)\}\s*<\/section>\s*\$\{areasNavMarkup\(\)\}/, 'Streifen VOR der Bereichsliste');
  assert.match(HEALTH_JS, /overviewCard\('calendar-check', 'health\.overview\.dueToday\.title', overviewDueMarkup\(\), 'due'\)/);
  // R24 (E9): „Schnell erfassen" ist weg - der FAB traegt das Erfassen-Menue.
  assert.doesNotMatch(HEALTH_JS, /quickCaptureMarkup|health-overview__card--quick|'quick'\)/, 'keine zweite Erfassen-Karte');
  assert.match(HEALTH_JS, /overviewCard\('pill', 'health\.meds\.prn\.title', prnListMarkup\('overview'\), 'prn'\)/, 'Bei Bedarf ist benannt und zieht mit');
  assert.match(HEALTH_JS, /class="split-view__detail-head health-detail-head"/, 'Detailkopf wie die anderen Split-Views (A8 P2-2)');
  const { eachRule } = await import('./css-rules.js');
  const css = read('public/styles/health.css');
  const rules = [...eachRule(css)];
  assert.ok(rules.some((r) => /\.health-page\[data-health-pushed\] \.health-priority-region/.test(r.selector) && /display:\s*none/.test(r.body)),
    'in einem Bereich gibt es den Streifen nicht');
  assert.ok(rules.some((r) => /\.health-priority-region:not\(\[data-health-priority-pending\]\):not\(:has\(> \.health-priority > \*\)\)/.test(r.selector) && /display:\s*none/.test(r.body)), 'leer kostet er nichts');
});

// Sonde 10 (document-guards) nach R14 P3: mobil stand „Heute faellig" (h3) als
// erste Ueberschrift nach dem Seitentitel (h1) - ein Sprung h1 -> h3 fuer jeden
// Screenreader, der die Seite nach Ueberschriften abgeht. Die Karten tragen im
// Raster ihre h3 unter der Panel-h2; im Streifen vor der Bereichsliste fehlte
// die Ebene dazwischen. Gemessen wird die Regel, nicht die Schreibweise: die
// letzte Ueberschrift VOR dem Umzugsziel liegt hoechstens eine Ebene ueber der
// Kartenueberschrift, und sie steht AUSSERHALB des Ziels (applyHoistPlan raeumt
// dort alles weg, was es nicht selbst umgehaengt hat).
test('R14 P3: vor den hochgezogenen Karten steht eine Ueberschrift eine Ebene darueber', async () => {
  const shellStart = HEALTH_JS.indexOf('<div class="health-page app-page');
  assert.ok(shellStart >= 0, 'Seitenrahmen nicht gefunden');
  const slotAt = HEALTH_JS.indexOf('data-health-priority>', shellStart);
  assert.ok(slotAt > shellStart, 'Umzugsziel data-health-priority nicht im Seitenrahmen');
  const before = [...HEALTH_JS.slice(shellStart, slotAt).matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.ok(before.length, 'keine Ueberschrift vor dem Streifen');
  const lead = before.at(-1);
  const cardStart = HEALTH_JS.indexOf('function overviewCard(');
  const card = HEALTH_JS.slice(cardStart, HEALTH_JS.indexOf('\n}\n', cardStart)).match(/<h([1-6]) class="health-overview__card-title/);
  assert.ok(card, 'Kartenueberschrift in overviewCard nicht gefunden');
  assert.ok(Number(card[1]) <= lead + 1,
    `hochgezogene Karte h${card[1]} folgt auf h${lead} - Ueberschriftensprung (Sonde 10, mobile/health)`);
  // Die Ueberschrift des Streifens gibt es nur, wenn er etwas traegt: leer
  // (Desktop, Tablet) oder in einem Bereich faellt die ganze Region weg.
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  const hides = (re) => rules.some((r) => re.test(r.selector) && /display:\s*none/.test(r.body));
  assert.ok(hides(/\.health-priority-region:not\(\[data-health-priority-pending\]\):not\(:has\(> \.health-priority > \*\)\)/), 'leere Region mit Ueberschrift bliebe stehen');
  assert.ok(hides(/\.health-page\[data-health-pushed\] \.health-priority-region/), 'in einem Bereich bliebe die Region stehen');
});

// R14 P4 (A6 P2-7): „Noch keine Eintraege." zentriert oben, ohne Weg - in der
// 676px-Detailspalte 21 % genutzt. Jetzt der geteilte Leerzustand mit Titel,
// Satz und dem Anlege-Weg (nur mit Schreibrecht).
test('R22 D12: ein Leerzustand je Ebene - der leere Bereich mit Aktion, die leere Karte als ruhige Zeile', () => {
  const fnBody = (name) => {
    const start = HEALTH_JS.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} fehlt`);
    return HEALTH_JS.slice(start, HEALTH_JS.indexOf('\n}\n', start));
  };
  // BEREICH: Glyphe, Titel, Satz, Aktion - eine Bauform fuer alle leeren Bereiche.
  const area = fnBody('areaEmptyHtml');
  assert.match(area, /icon: panel\.icon,\s*title: t\(panel\.emptyTitleKey\),\s*description: t\(panel\.emptyDescKey\)/);
  assert.match(area, /tone: 'secondary'/, 'neben dem FAB mit demselben Verb ruhig, nicht ein zweiter violetter Knopf (D5)');
  for (const [fn, route, id] of [
    ['vitalsEmptyRowMarkup', 'vitals', 'vitals-add-first'],
    ['renderMedsShell', 'meds', 'meds-add-first'],
    ['renderLabsShell', 'labs', 'labs-add-first'],
    ['renderActivityShell', 'activity', 'activity-add'],
    ['renderPreventionShell', 'prevention', 'prevention-add-first'],
    ['renderNutritionShell', 'nutrition', 'nutrition-add-first'],
  ]) {
    const body = fnBody(fn);
    assert.match(body, new RegExp(`areaEmptyHtml\\('/health/${route}'`), `${route}: der Leerzustand der Bereiche`);
    assert.match(body, new RegExp(`id: '${id}'`), `${route}: mit der Anlege-Aktion`);
  }
  assert.match(HEALTH_JS, /querySelector\('\[data-action="meds-add-first"\]'\)\?\.addEventListener\('click', \(\) => openMedModal\(null\)\)/);
  assert.match(HEALTH_JS, /querySelector\('\[data-action="labs-add-first"\]'\)\?\.addEventListener\('click', \(\) => openLabModal\(null\)\)/);
  assert.match(fnBody('renderLabsShell'), /if \(!labs\.reports\.length\) \{[\s\S]*?return;\s*\}/, 'Labor: ohne Befund keine Auswahl "Waehle einen Befund"');
  assert.match(fnBody('renderMedsShell'), /if \(!meds\.list\.length\) \{[\s\S]*?return;\s*\}/, 'Medikamente: ohne Medikament kein "Heute ist nichts faellig"');
  // KARTE: die ruhige Zeile, nie ein nackter grauer Satz.
  for (const fn of ['dueTodayMarkup', 'overviewDueMarkup', 'overviewUpcomingMarkup']) {
    const body = HEALTH_JS.slice(HEALTH_JS.indexOf(`function ${fn}(`), HEALTH_JS.indexOf('\n}\n', HEALTH_JS.indexOf(`function ${fn}(`)));
    assert.match(body, /cardEmptyRowHtml\(/, `${fn}: die ruhige Zeile`);
    assert.doesNotMatch(body, /emptyHintHTML\(|reminders-empty/, `${fn}: kein nackter Satz`);
  }
  assert.match(fnBody('renderActivityShell'), /cardEmptyRowHtml\(t\('health\.activity\.noData'\), \{ action: canAdd/, 'leere Woche: Zeile mit Erfassen');
  // EIN VERB JE AKTION: seit R24 (E9) traegt der Zyklus-FAB die ANDERE
  // Handlung als die Heute-Karte - „+ Tag" (Tag protokollieren) neben
  // „Periode gestartet"; die Karte fuehrt den Tag nicht mehr ein zweites Mal.
  // Das Fasten seit R23 D14: der FAB heisst "Fasten starten", der
  // Ring traegt keinen Startknopf mehr (nur noch "Beenden" bei laufendem Fasten).
  const fab = fnBody('updateHealthFab');
  {
    const at = fab.indexOf(`case '/health/cycle':`);
    const ccase = fab.slice(at, fab.indexOf('break;', at));
    assert.match(ccase, /hidden: !cycleCanEdit\(\)/, 'cycle: der FAB, wo der Tag protokolliert werden darf');
    assert.match(ccase, /onClick: \(\) => openDayLogModal\(todayKey\(\)\)/, 'cycle: der FAB protokolliert den Tag');
    assert.doesNotMatch(fnBody('cycleTodayActionsMarkup'), /cycle-log-today|btn--primary/, 'die Heute-Karte: kein zweiter Tag-Knopf, kein zweiter Primaer');
    const ft = fab.indexOf(`case '/health/fasting':`);
    const fcase = fab.slice(ft, fab.indexOf('break;', ft));
    assert.match(fcase, /hidden: !fastingIntent\.canStart/, 'fasting: der FAB nur, wenn ein Start moeglich ist');
    assert.match(fcase, /label: t\('health\.fasting\.start'\)/, 'fasting: der FAB heisst "Fasten starten"');
  }
  for (const [route, opener] of [['prevention', 'openPreventionModal'], ['nutrition', 'openNutritionModal']]) {
    const at = fab.indexOf(`case '/health/${route}':`);
    assert.ok(fab.slice(at, fab.indexOf('break;', at)).includes(`${opener}(null)`), `${route}: der FAB legt weiter an`);
  }
  const fasting = readFileSync(new URL('../public/pages/health-fasting.js', import.meta.url), 'utf8');
  assert.match(fasting, /action: writable \? \{ label: t\('health\.fasting\.backfill'\), icon: 'plus', tone: 'secondary', attrs: \{ 'data-fasting-backfill': '' \} \} : undefined/,
    'Fasten: der Nachtrag ist die Aktion des Leerzustands');
  // R23 D14: Nachtragen und Einstellungen im "..." des Rings, nicht als Knoepfe.
  assert.doesNotMatch(fasting, /btn btn--ghost btn--sm" data-fasting-backfill/, 'Fasten: kein Geisterknopf mehr am Verlauf');
  assert.match(fasting, /\{ action: 'fasting-backfill', label: t\('health\.fasting\.backfill'\)/, 'Fasten: der Nachtrag steht im Mehr-Menue');
  assert.match(fasting, /\{ action: 'fasting-settings', label: t\('nav\.settings'\)/, 'Fasten: die Einstellungen ebenso (kein Zahnrad in der Aktionszeile)');
  assert.doesNotMatch(fasting, /t\(active \? 'health\.fasting\.finish' : 'health\.fasting\.start'\)/, 'Fasten: kein Startknopf im Ring neben dem FAB');
  assert.match(fasting, /view\.onIntent\?\.\(\{ canStart: !active, start: \(\) => toggleFasting\(null\) \}\)/, 'Fasten: der FAB erfaehrt, ob er starten darf');
  assert.doesNotMatch(fasting, /onCreateAction/, 'Fasten: kein Nachtrag mehr ueber den FAB');
});

// R14 P8 (A6 P2-5): die Vorsorge trug zwei native Datumsfelder, direkt neben
// dem Export mit dem Kanon-Picker. Jedes Datumsfeld der Gesundheit ist jetzt
// `yuvomi-datepicker`.
test('R14 P8: kein natives Datumsfeld in der Gesundheit', () => {
  const nativ = [...HEALTH_JS.matchAll(/<input[^>]*type="date"[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(nativ, [], 'native Datumsfelder statt yuvomi-datepicker');
  assert.match(HEALTH_JS, /<yuvomi-datepicker id="prevention-given-on" type="date"/);
  assert.match(HEALTH_JS, /<yuvomi-datepicker id="prevention-next-due" type="date"/);
});

// R14 P8 (A6 P2-6): Zyklus-Verlauf und Trainings-Liste lagen nackt auf der
// Buehne, waehrend „Letzte Messungen" und Labor in Karten stehen. Jede
// Verlaufsliste traegt jetzt die Flaeche eines Zeilentraegers.
test('R14 P8: Verlaufslisten der Gesundheit stehen auf einem Traeger', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))].filter((r) => !r.at.length);
  for (const list of ['.cycle-history__list', '.health-activity-list']) {
    const own = rules.filter((r) => r.selector.split(',').map((x) => x.trim()).includes(list));
    assert.ok(own.some((r) => /background(?:-color)?:\s*var\(--color-surface\)/.test(r.body)), `${list}: keine Flaeche`);
    assert.ok(own.some((r) => /border-radius:\s*var\(--radius-lg\)/.test(r.body)), `${list}: kein Kartenradius`);
  }
});

// R14 P11 (A6 P2-9) / R16 (Bewegung): der Bereichswechsel schaltete `hidden`
// um - schmal blendete er seit R14, am Desktop schnitt die Detailspalte hart.
// Jetzt blendet der neue Bereich in JEDER Breite, ueber den geteilten Helfer
// (Regeln und reduzierte Bewegung: test:motion).
test('R16: der Bereichswechsel blendet in jeder Breite ueber swapContent', async () => {
  const start = HEALTH_JS.indexOf('function activateArea(');
  const body = HEALTH_JS.slice(start, HEALTH_JS.indexOf('\n}\n', start));
  // R18: schmal traegt der Wechsel Uebersicht <-> Bereich zusaetzlich eine Richtung (test:motion, Drill-down).
  assert.match(body, /if \(previous && previous !== id\) markAreaEntering\(route, drill\);/, 'nicht mehr nur schmal');
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function markAreaEntering('), HEALTH_JS.indexOf('function markAreaEntering(') + 400);
  assert.match(fn, /function markAreaEntering\(route, direction = 0\)/, 'ohne Angabe: Blende ohne Versatz');
  assert.match(fn, /swapContent\(panel, null, \{ direction \}\)/, 'ueber den geteilten Helfer am Panel');
  const { eachRule } = await import('./css-rules.js');
  assert.ok(![...eachRule(read('public/styles/health.css'))].some((r) => /health-panel--entering/.test(r.selector)), 'die eigene Klasse ist weg');
});

// R14 P6 (A8 P2-2, A6 §5): die angedockte Pille hiess in Vorsorge und
// Naehrwerte „Eintrag", in Aktivitaet „Einheit" - kein Nomen des Objekts
// (Kanon DESIGN.md: die Pille nennt, was entsteht). Jeder Bereich traegt sein
// eigenes Nomen, in jeder Sprache verschieden von den anderen.
test('R14 P6: die Kopf-Pille nennt je Bereich ihr Objekt', () => {
  const keys = ['healthVitals', 'healthCycle', 'healthMeds', 'healthPrevention', 'healthLabs', 'healthActivity', 'healthNutrition'];
  for (const file of readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'))) {
    const labels = JSON.parse(read(`public/locales/${file}`)).newLabel;
    const values = keys.map((k) => labels[k]);
    assert.equal(new Set(values).size, values.length, `${file}: zwei Bereiche teilen ein Nomen (${values.join(' / ')})`);
  }
  const de = JSON.parse(read('public/locales/de.json')).newLabel;
  for (const k of keys) assert.ok(!['Eintrag', 'Einheit'].includes(de[k]), `de ${k}: „${de[k]}" ist kein Objekt`);
  // R22 S10 (D12, „Bereichsname nicht dreifach"): am Desktop stand „Vorsorge"
  // in der Bereichsliste, im Detailkopf UND in der Kopf-Pille („+ Vorsorge").
  // Die Pille nennt das Objekt, nicht den Bereich - wie en „Checkup", sv
  // „Undersökning".
  // Sammel-Ticket R22-F, F4.6: in JEDER Sprache, nicht nur an der Referenz.
  // Zehn Sprachen wiederholten den Bereich: Medikamente in id/ja/ko/uk/vi/zh/
  // zh-Hant (ohne Numerus: Bereich und Objekt ein Wort - der Bereich heisst
  // dort jetzt nach der Einnahme, ja „服薬", zh „用药", ko „복약", vi „Dùng
  // thuốc", id „Obat-obatan"; uk nennt das Objekt „Препарат"), it Zyklus,
  // nb Aktivitaet, sv Laborwerte.
  const areaOf = { healthVitals: 'vitals', healthCycle: 'cycle', healthMeds: 'meds', healthPrevention: 'prevention', healthLabs: 'labs', healthActivity: 'activity', healthNutrition: 'nutrition' };
  const repeats = [];
  for (const file of readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'))) {
    const locale = JSON.parse(read(`public/locales/${file}`));
    for (const k of keys) {
      // R24 S5-F2 (Ulas 2026-10-28): die Vorsorge traegt EIN Nomen fuer
      // Untersuchung und Impfung - Pille und Dialog „Vorsorge" wie der
      // Kurzname. Verboten bleibt der Bereichstitel („Vorsorge & Impfungen").
      const area = k === 'healthPrevention' ? locale.health.prevention.title : locale.health.tabs[areaOf[k]];
      if (locale.newLabel[k].toLocaleLowerCase() === area.toLocaleLowerCase()) repeats.push(`${file} ${k}: „${area}"`);
    }
    assert.equal(locale.health.meds.title, locale.health.tabs.meds, `${file}: Medikamente heissen in Liste und Detailkopf verschieden`);
  }
  assert.deepEqual(repeats, [], 'die Pille wiederholt den Bereichsnamen');
  // R24 S5-F2: ein Nomen - Pille „Vorsorge", Dialog „Vorsorge hinzufuegen"/„… bearbeiten"
  // (vorher „Untersuchung" und „Eintrag hinzufuegen": zwei Nomen, Impfungen sind keine Untersuchung).
  const deAll = JSON.parse(read('public/locales/de.json'));
  assert.equal(deAll.newLabel.healthPrevention, 'Vorsorge');
  assert.equal(deAll.health.prevention.add, 'Vorsorge hinzufügen');
  assert.equal(deAll.health.prevention.edit, 'Vorsorge bearbeiten');
  const enAdd = JSON.parse(read('public/locales/en.json')).health.prevention.add;
  for (const file of readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    assert.notEqual(JSON.parse(read(`public/locales/${file}`)).health.prevention.add, enAdd, `${file}: der Dialogtitel ist uebersetzt`);
  }
});

/* R18 (Ursache zu #1770): DIE "HEUTE"-REGION SPRINGT NICHT INS BILD.
 *
 * Gemessen bei 390x844, drei Laeufe: die Region stand per `:has()` auf
 * `display: none`, bis die Uebersicht geladen war, und erschien dann mit 480px
 * auf einmal - `.health-areas` von y=81 auf y=577, Layout-Shift 0,58. Dazu
 * wuchs jede Bereichszeile von 49 auf 63px, wenn ihr Status eintraf.
 * Nachher: 0,003 (PerformanceObserver 'layout-shift', derselbe Weg).
 *
 * Der Browser misst das Ergebnis; hier steht, was es traegt - und die drei
 * Stellen, an denen es wieder kippen kann. */
test('R18: die Heute-Region steht auf dem Telefon vom ersten Bild an - mit Skelett, sonst nie leer', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  const body = (sel) => rules.filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');

  // 1. Solange Inhalt erwartet wird, faellt die Region NICHT weg - und nur dann.
  const hide = rules.filter((r) => /\.health-priority-region\b[^,]*:has\(/.test(r.selector) && /display:\s*none/.test(r.body));
  assert.equal(hide.length, 1, 'genau eine Leer-Regel');
  assert.match(hide[0].selector, /:not\(\[data-health-priority-pending\]\)/,
    'ohne die Ausnahme ist die Region bis zum Eintreffen der Daten weg und springt dann ins Bild');

  // 2. Das Skelett ist GESCHWISTER des Umzugsziels: applyHoistPlan raeumt im
  //    Ziel alles weg, was es nicht selbst umgehaengt hat - als Kind waere es
  //    beim ersten Abgleich fort, vor den Daten.
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function prioritySkeletonMarkup()'), HEALTH_JS.indexOf('function syncPriorityRegion()'));
  assert.match(fn, /class="health-priority-skeleton" data-health-priority-skeleton aria-hidden="true"/);
  assert.match(fn, /health-priority-skeleton__card--due/, 'die Form dessen, was kommt: Heute faellig');
  assert.doesNotMatch(fn, /--quick/, 'R24 E9: keine Schnell-erfassen-Karte mehr');
  assert.doesNotMatch(fn, /health-priority-skeleton__pill/, 'die Pille steht seit R23 im Kopf, nicht im Streifen');
  assert.match(body('.health-priority-skeleton'), /display:\s*none/, 'ohne die Marke steht kein Skelett');
  const show = rules.find((r) => /\[data-health-priority-pending\]\s*>\s*\.health-priority:empty\s*~\s*\.health-priority-skeleton/.test(r.selector));
  assert.ok(show && /display:\s*flex/.test(show.body), 'es steht nur, solange die Region wartet UND ihr Ziel leer ist');
  // Zielgeometrie: dieselben Abstaende wie der Streifen, den es vertritt.
  for (const prop of ['gap', 'padding-inline']) {
    const want = body('.health-priority').match(new RegExp(`${prop}:\\s*([^;]+)`))?.[1].trim();
    assert.ok(want, `Reichweite: .health-priority setzt ${prop}`);
    assert.equal(body('.health-priority-skeleton').match(new RegExp(`${prop}:\\s*([^;]+)`))?.[1].trim(), want, `das Skelett traegt ${prop} des Streifens`);
  }

  // 3. Die Marke gilt nur auf dem Telefon in der Uebersicht und faellt, sobald
  //    Inhalt da ist - oder keiner mehr kommt (Ladefehler).
  assert.match(HEALTH_JS, /_priorityPending = activeRoute === '\/health' && isPhone\(\);/, 'gesetzt beim Seitenaufbau, nur Telefon + Uebersicht');
  assert.match(HEALTH_JS, /\$\{priorityPending \? ' data-health-priority-pending' : ''\}/, 'und schon im ERSTEN Markup, nicht erst nach einem Abgleich');
  const sync = HEALTH_JS.slice(HEALTH_JS.indexOf('function syncPriorityRegion()'), HEALTH_JS.indexOf('function syncHoists()'));
  assert.match(sync, /if \(filled \|\| !overviewActive \|\| !isPhone\(\)\) _priorityPending = false;/);
  assert.match(sync, /toggleAttribute\('data-health-priority-pending', _priorityPending\)/);
  const hoists = HEALTH_JS.slice(HEALTH_JS.indexOf('function syncHoists()'), HEALTH_JS.indexOf('let _hoistObserver'));
  assert.match(hoists, /applyHoistPlan\([\s\S]*syncPriorityRegion\(\);/, 'nach jedem Umzug nachgefuehrt');
  const shell = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderOverviewShell()'), HEALTH_JS.indexOf('function overviewGridMarkup('));
  assert.match(shell, /if \(overview\.error\) \{[\s\S]*?_priorityPending = false;\s*syncPriorityRegion\(\);[\s\S]*?return;/,
    'nach einem Ladefehler bleibt kein Skelett stehen');
});

test('R18: eine Bereichszeile ist immer zwei Zeilen hoch - ihr Status schiebt nichts mehr', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  const main = rules.filter((r) => r.selector.trim() === '.health-area-row__main').map((r) => r.body).join(';');
  assert.match(main, /min-block-size:\s*calc\(1lh \+ var\(--space-0h\) \+ var\(--type-caption\) \* var\(--line-height-base\)\)/,
    'Name plus Statuszeile, ob der Status schon da ist oder nie kommt');
  assert.match(main, /justify-content:\s*center/, 'ein Name ohne Status steht mittig');
  // Der Name darf die reservierte Hoehe nicht selbst fuellen (.list-row__name waechst im Flex-Traeger).
  const name = rules.find((r) => r.selector.trim() === '.health-area-row__main > .health-area-row__name');
  assert.ok(name && /flex:\s*0 0 auto/.test(name.body), 'sonst steht der Name oben statt mittig');
  // Reichweite der Rechnung: der Status laeuft wirklich in der Metazeile
  // (--type-caption, seit R21 aus der Rolle in typography.css, nicht aus health.css).
  const status = rules.filter((r) => r.selector.trim() === '.health-area-row__status').map((r) => r.body).join(';');
  assert.doesNotMatch(status, /font-size:/, 'die Groesse kommt aus der Rolle, nicht aus dem Modulblatt');
  const typo = [...eachRule(read('public/styles/typography.css'))];
  const rolle = typo.find((r) => !r.at.length && r.selector.split(',').map((s) => s.trim()).includes('.health-area-row__status'));
  assert.ok(rolle, 'der Status steht in der Metazeilen-Rolle');
  assert.match(rolle.body, /font-size:\s*var\(--type-caption\)/);
  assert.match(status, /white-space:\s*nowrap/, 'und bleibt eine Zeile');
});

test('R18: kein Bereich laedt mehr mit dem Wort "Lade..." - jeder traegt ein Skelett', () => {
  const texts = [...HEALTH_JS.matchAll(/__loading">\$\{esc\(t\('common\.loading'\)\)\}<\/div>/g)];
  assert.equal(texts.length, 0, 'ein Ladezustand, der nur aus dem Wort besteht');
  const calls = [...HEALTH_JS.matchAll(/areaLoadingMarkup\('([a-z]+)', '(list|chart)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ['activity', 'labs', 'meds', 'nutrition', 'overview', 'prevention', 'vitals']);
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function areaLoadingMarkup('), HEALTH_JS.indexOf('function cycleSkeletonMarkup()'));
  assert.match(fn, /role="status"/, 'der Ladezustand bleibt eine Statusmeldung');
  assert.match(fn, /<span class="sr-only">\$\{esc\(t\('common\.loading'\)\)\}<\/span>/, 'und das Wort bleibt fuer Screenreader');
  assert.match(fn, /renderSkeletonChart\(\{ charts: 2 \}\)/);
  assert.match(fn, /renderSkeletonList\(\{ rows: 3, lines: 2 \}\)/);
  assert.match(HEALTH_JS, /import \{ renderSkeletonList, renderSkeletonChart \} from '\/utils\/skeleton\.js';/);
});

// Critique R22 (D4, a6): das Skelett der Heute-Region kennt die Hoehe des
// Inhalts erst ab dem zweiten Aufruf. Beim ersten fehlte ihm die Kurzzeile, und
// die Bereichsliste rutschte mit den Daten von y=577 auf y=639 (CLS 0,023 bei
// 390x844, 4x CPU); ein Konto mit weniger Faelligem zog sie hoch. Solange die
// Region wartet, haelt die Liste ihren Platz unsichtbar - und ein haengender
// Abruf verbirgt sie hoechstens PRIORITY_WAIT_MS lang.
test('R22 D4: die Bereichsliste erscheint erst, wenn ueber ihr nichts mehr waechst - nie dauerhaft verborgen', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))].filter((r) => !r.at.length);
  const wait = rules.find((r) => /\.health-priority-region\[data-health-priority-pending\]\s*~\s*\.health-areas/.test(r.selector));
  assert.ok(wait, 'die Liste steht waehrend des Wartens sichtbar - sie rutscht mit den Daten');
  assert.match(wait.body, /visibility:\s*hidden/, 'verborgen, aber an ihrem Platz (kein display: none - sonst springt sie beim Erscheinen)');
  assert.doesNotMatch(wait.body, /display:/);
  const render = HEALTH_JS.slice(HEALTH_JS.indexOf('export async function render('));
  assert.match(HEALTH_JS, /const PRIORITY_WAIT_MS = \d+;/);
  assert.match(render, /if \(_priorityPending\) \{\s*const giveUp = setTimeout\(\(\) => \{\s*if \(!_priorityPending\) return;\s*_priorityPending = false;\s*syncPriorityRegion\(\);\s*\}, PRIORITY_WAIT_MS\);\s*signal\?\.addEventListener\('abort', \(\) => clearTimeout\(giveUp\)/,
    'ohne Frist verbirgt ein haengender Abruf die Navigation');
});

// R24 S13 (S12-F3): der Status einer Bereichszeile kommt nach ihrem Namen an,
// und ein Name allein steht mittig (R18, #1770) - mit dem Status rueckte er um
// eine halbe Zeile hoch. Gemessen 1440x900, Eintritt ueber die Seitenleiste:
// Shift 0,0015-0,0024 an fuenf `.health-area-row__name` (y 584 -> 573 ...).
// Dieselbe Antwort wie R22 D4: die Liste haelt ihren Platz unsichtbar, bis
// die erste Runde der Status steht, und erscheint dann EINMAL an ihrem Ort -
// hoechstens STATUS_WAIT_MS lang, ein haengender Abruf verbirgt die
// Navigation nie.
test('R24 S13: die Bereichsliste erscheint mit ihren Status, nicht davor - nie dauerhaft verborgen', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))].filter((r) => !r.at.length);
  const wait = rules.find((r) => /^\.health-areas\[data-health-status-pending\]$/.test(r.selector.trim()));
  assert.ok(wait, 'die Liste steht sichtbar, waehrend ihre Status laden - die Namen ruecken dann hoch');
  assert.match(wait.body, /visibility:\s*hidden/, 'verborgen, aber an ihrem Platz');
  assert.doesNotMatch(wait.body, /display:/);
  assert.match(HEALTH_JS, /<nav class="health-areas" aria-label="\$\{esc\(t\('nav\.health'\)\)\}"\$\{_statusRevealPending \? ' data-health-status-pending' : ''\}>/,
    'schon im ERSTEN Markup, nicht erst nach einem Abgleich');
  assert.match(HEALTH_JS, /const STATUS_WAIT_MS = \d+;/);
  const all = HEALTH_JS.slice(HEALTH_JS.indexOf('function refreshAllAreaStatuses('), HEALTH_JS.indexOf('function wireAreasNav('));
  assert.match(all, /Promise\.allSettled\(loads\)/, 'die erste Runde wartet auf ALLE Abrufe, nicht auf den ersten');
  assert.match(all, /setTimeout\(revealAreaStatuses, STATUS_WAIT_MS\)/, 'ohne Frist verbirgt ein haengender Abruf die Navigation');
  // Codex an #2364 (P2): die Frist gilt, bis die Liste WIRKLICH erscheint. Endeten
  // die eigenen Abrufe vor der Uebersicht, loeschte ihr Ende die Frist, und eine
  // haengende Uebersicht hielt die Navigation verborgen.
  assert.doesNotMatch(all.slice(all.indexOf('Promise.allSettled(loads)')), /clearTimeout/,
    'das Ende der eigenen Abrufe loescht die Frist nicht - die Uebersicht kann noch fehlen');
  const reveal = HEALTH_JS.slice(HEALTH_JS.indexOf('function revealAreaStatuses('), HEALTH_JS.indexOf('function maybeRevealAreaStatuses('));
  assert.match(reveal, /clearTimeout\(_statusRevealTimer\)/, 'erst das Erscheinen raeumt die Frist ab');
  assert.match(all, /_statusRevealTimer = setTimeout\(revealAreaStatuses, STATUS_WAIT_MS\)/);
  assert.match(all, /if \(healthPersonIsOther\(healthUser\?\.id\)\) \{[\s\S]{0,200}?revealAreaStatuses\(\);\s*return;/, 'fremde Person: kein Status, also sofort sichtbar');
  const shell = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderOverviewShell('));
  assert.match(shell.slice(0, shell.indexOf('applyOverviewStatuses();') + 200), /maybeRevealAreaStatuses\(\)/, 'die Uebersicht liefert drei Status - danach darf die Liste erscheinen');
});

// ── R22 S8 (Critique a5, D12): Gesundheit ──────────────────────────────────

// R22 D12 liess den Detailkopf mit Grundstreifen kleben; R24 (Critique G5
// P2-2) nimmt ihm die eigene Flaeche. Gemessen 1440x900 vorher: weisse
// 64px-Karte y=85, erster Inhalt y=193 (Vitalwerte-Segment), auf der
// Uebersicht „Übersicht" doppelt neben der markierten Zeile.
test('R24 G5 P2-2: der Detailkopf steht ohne eigene Karte auf der Hoehe der Liste, die Uebersicht traegt keinen', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  const head = rules.find((r) => r.selector.trim() === '.health-split > .split-view__detail .split-view__detail-head');
  assert.ok(head, 'Regel fehlt');
  assert.match(head.body, /margin-block-start:\s*var\(--space-4\)/, 'in Ruhe auf der Hoehe der Liste');
  assert.match(head.body, /background-color:\s*transparent/, 'keine eigene Flaeche');
  assert.match(head.body, /position:\s*static/, 'klebt nicht - ohne Flaeche liefe der Inhalt durch die Schrift');
  assert.doesNotMatch(head.body, /box-shadow|border-radius/, 'kein Kartenschatten, keine Kartenecken');
  assert.match(head.body, /padding:\s*0/, 'fluchtet mit den Karten darunter');
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function syncDetailHead()'), HEALTH_JS.indexOf('function markAreaEntering('));
  assert.match(fn, /area\.id === HEALTH_OVERVIEW_ID/, 'die Uebersicht kennt ihren Fall');
  assert.match(fn, /_detailHead\.hidden = overviewHead/, 'und blendet den Kopf aus');
  // `hidden` setzt sich gegen das display:flex der Kopfregel durch: die globale
  // Regel in reset.css (`[hidden] { display: none !important }`, test:hidden-cascade).
  assert.match(read('public/styles/reset.css'), /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
});

test('R24 E10: auch die Bedarfsdosis nimmt man am Ring, mit dem Namen des Medikaments', async () => {
  // R22 D12 gab beiden Dosen dasselbe Verb auf einem Kapselknopf; seit R24
  // (E10) ist Einnehmen in beiden Zeilen der Abhak-Ring vor dem Namen.
  const { eachRule } = await import('./css-rules.js');
  const prn = HEALTH_JS.slice(HEALTH_JS.indexOf('function prnRowMarkup('), HEALTH_JS.indexOf('function prnListMarkup('));
  assert.match(prn, /<button type="button" class="health-dose__check check-ring"\s+data-prn-take/, 'derselbe Ring wie bei der geplanten Dosis');
  assert.match(prn, /aria-label="\$\{esc\(t\('health\.meds\.takeNamed', \{ name: med\.name \}\)\)\}"/, 'der Name nennt das Medikament');
  assert.doesNotMatch(prn, /btn--primary|btn--ghost|health-prn__take/, 'kein Kapselknopf mehr');
  assert.ok(prn.indexOf('${action}') < prn.indexOf('health-dose__name'), 'der Ring steht vor dem Namen');
  const rules = [...eachRule(read('public/styles/health.css'))];
  // Bei 1920 brach "Ibuprofen · 400 / mg" neben "Noch nicht geno...": bis 32rem steht der Name allein.
  const wrap = rules.find((r) => r.at.some((a) => /list-rows \(max-width:\s*32rem\)/.test(a)) && r.selector.trim() === '.health-prn > .health-dose__name');
  assert.match(wrap?.body ?? '', /flex:\s*1 0 100%/);
  assert.equal(read('public/locales/de.json').includes('"takeFor"'), false, 'der zweite Wortlaut ist weg');
});

test('R22 D12: das Erfassen-Formular steht in EINEM Traeger, der Tag-Titel bricht nicht vor dem Punkt', () => {
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function openVitalModal('), HEALTH_JS.indexOf('onSave(panel) {', HEALTH_JS.indexOf('function openVitalModal(')));
  const groups = fn.match(/formRowsHtml\(/g) ?? [];
  assert.equal(groups.length, 1, 'Art, Werte, Zeitpunkt und Sichtbarkeit in einem Traeger - durchgehende Haarlinien');
  assert.match(fn, /formRowsHtml\(\[\s*formRowHtml\(\{\s*label: t\('health\.vitals\.field\.type'\)[\s\S]*?`<div class="form-rows" id="vital-value-fields">/,
    'die Werte stehen als Glied in der Gruppe');
  assert.match(HEALTH_JS, /title: `\$\{t\('health\.cycle\.dayLog\.title'\)\}\\u00A0· \$\{dateText\(key\)\}`/, 'geschuetztes Leerzeichen vor dem Trenner');
});

// F4.5 (Tablette und Verb am Einnehmen-Knopf) ist mit R24 E10 gegenstandslos:
// Einnehmen ist der Abhak-Ring vor der Zeile (test:health-meds "R24 E10"), das
// sichtbare Wort "Einnehmen" und sein Key `health.meds.take` sind entfallen.

// R24 E9 (Ulas 2026-10-28; Critique G5 P1-1, G0 P2-2, G5 P2-3): jede Ansicht
// der Gesundheit hat ihren FAB. Uebersicht: „+ Erfassen" mit einem Menue am
// Knopf (popovertarget, die Popover-API oeffnet, schliesst und gibt den Fokus
// zurueck); Zyklus: „+ Tag". Der Platz des angedockten Knopfs steht, damit
// die Personenwahl daneben nicht springt (gemessen 1440: x 1008-1167 -> 1008).
// R24 S14: der Export stand mit `justify-content: flex-end` am rechten Rand des
// Platzes, solange der Knopf fehlte, und sprang um dessen Breite, sobald er
// erschien - beim Eintritt (0,0002 an #health-tools, x 1368 -> 1246; die
// Uebersicht kennt die Person erst nach dem Laden) und zweimal je
// Bereichswechsel (gemessen 1440: x 1209-1280 je Nomen). Jetzt steht das
// Werkzeug am Anfang des Platzes, der Knopf schliesst an dessen Ende ab.
test('R24 S14: im Kopf der Gesundheit haelt der Export seine Lage, der Knopf steht am Ende', async () => {
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  const wide = (sel) => rules.filter((r) => r.selector.trim() === sel && r.at.some((a) => /min-width:\s*1024px/.test(a))).map((r) => r.body).join('\n');
  const slot = wide('.health-toolbar > .page-toolbar__actions');
  assert.match(slot, /min-inline-size:\s*var\(--health-fab-slot, auto\)/, 'der Platz steht');
  assert.match(slot, /justify-content:\s*flex-start/, 'das Werkzeug beginnt den Platz');
  assert.doesNotMatch(slot, /flex-end/, 'kein Rechtsbuendig, das den Export mit dem Knopf wandern laesst');
  assert.match(wide('.health-toolbar__tools'), /margin-inline-end:\s*auto/, 'das Werkzeug schiebt den Knopf an die Kante');
});

test('R24 E9: FAB in jeder Ansicht - Uebersicht mit Erfassen-Menue, Zyklus „+ Tag", fester Platz', () => {
  const update = functionSource('updateHealthFab');
  const at = update.indexOf('case HEALTH_OVERVIEW_ROUTE:');
  assert.ok(at > 0, 'die Uebersicht hat einen eigenen Fall');
  const ov = update.slice(at, update.indexOf('break;', at));
  assert.match(ov, /dockLabel: t\('newLabel\.healthOverview'\)/);
  assert.match(ov, /hidden: !items\.length/, 'ohne Recht kein Knopf');
  assert.match(ov, /syncCaptureMenu\(items\)/);
  const sync = functionSource('syncCaptureMenu');
  assert.match(sync, /setAttribute\('popovertarget', CAPTURE_MENU_ID\)/, 'das Menue haengt per popovertarget am FAB');
  assert.match(sync, /removeAttribute\('popovertarget'\)/, 'ausserhalb der Uebersicht wieder ab');
  assert.match(sync, /installPopoverMenus\(panel\)/, 'das Menue ist seine eigene Wurzel');
  const items = functionSource('overviewCaptureItems');
  for (const action of ['ov-add-vital', 'ov-add-activity', 'ov-go-meds', 'ov-go-cycle']) assert.ok(items.includes(`'${action}'`), action);
  assert.match(update, /fitHealthFabSlot\(\)/);
  const css = read('public/styles/health.css');
  assert.match(css, /\.health-toolbar > \.page-toolbar__actions \{[^}]*min-inline-size: var\(--health-fab-slot, auto\)/, 'der Platz des Knopfs steht');
  const de = JSON.parse(read('public/locales/de.json'));
  assert.equal(de.newLabel.healthOverview, 'Erfassen');
  assert.equal(de.newLabel.healthCycle, 'Tag');
  // EIN NOMEN JE BEREICH: Pille, aria und Dialogtitel (Aktivitaet sagte
  // „Training" / „Einheit erfassen").
  for (const l of ['de', 'en']) {
    const loc = JSON.parse(read(`public/locales/${l}.json`));
    assert.ok(loc.health.activity.add.toLowerCase().includes(loc.newLabel.healthActivity.toLowerCase()), `${l}: ${loc.health.activity.add} / ${loc.newLabel.healthActivity}`);
  }
  for (const file of readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'))) {
    const loc = JSON.parse(read(`public/locales/${file}`));
    assert.ok(loc.newLabel.healthOverview, `${file}: newLabel.healthOverview`);
  }
});

// R24 (Critique G5 P2-7): mobil lag „Bei Bedarf" mit seinem Ring in der Falte
// unter der Bereichsliste, und „Letzte Vitalwerte" zeigte 2 von 9 Werten.
// Gemessen 390x844 vorher: Bei Bedarf nur nach Aufklappen (y > 1500), jetzt
// y=373 direkt unter „Heute faellig", vor „Alle Bereiche" (y=520).
test('R24 G5 P2-7: Telefon-Uebersicht - Bei Bedarf neben Heute faellig, die Vitalkarte nennt, was sie zeigt', () => {
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function overviewGridMarkup('), HEALTH_JS.indexOf('function overviewCard('));
  const phone = fn.slice(fn.indexOf('if (!phone)'));
  assert.match(phone, /const rest = \[adherence, cycleTile, reminders\]/, 'Bei Bedarf steht nicht mehr in der Falte');
  const tail = phone.slice(phone.indexOf('const open'));
  assert.ok(tail.indexOf('${due}') < tail.indexOf('${prnHtml}') && tail.indexOf('${prnHtml}') < tail.indexOf('${vitalsCard}'), 'Heute faellig, Bei Bedarf, dann die Werte');
  assert.match(fn, /phone \? 'health\.overview\.vitals\.recentTitle' : 'health\.overview\.vitals\.title'/, 'am Telefon „Zuletzt gemessen"');
  const de = JSON.parse(read('public/locales/de.json'));
  assert.equal(de.health.overview.vitals.recentTitle, 'Zuletzt gemessen');
  assert.doesNotMatch(HEALTH_JS.slice(HEALTH_JS.indexOf('function overviewVitalsEmptyMarkup('), HEALTH_JS.indexOf('function overviewBriefMarkup(')), /action/,
    'E9: kein zweiter Erfassen-Weg in der leeren Karte - der FAB traegt den Messwert');
});

// R24 (Critique G5 P3-1): das Personenmenue kam in Haushaltsreihenfolge, die
// eigene Ansicht („Ich") stand zuletzt.
test('R24 G5 P3-1: im Personenmenue steht „Ich" zuerst', async () => {
  const { personSwitcherMarkup } = await import('../public/utils/health-person-switcher.js');
  const members = [{ id: 3, display_name: 'Emma' }, { id: 2, display_name: 'Alex' }, { id: 1, display_name: 'Linda' }];
  const html = personSwitcherMarkup(members, 3, 1, { menuId: 'm', label: 'Person' });
  const order = [...html.matchAll(/data-person-id="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['1', '3', '2'], 'ich zuerst, die anderen in ihrer Reihenfolge');
  assert.match(html, /aria-label="Person: Emma"/, 'der Knopf nennt weiter die gewaehlte Person');
});

// R24 (Critique G5 P2-4, P3-6): Dialoge der Gesundheit nach D4. Gemessen
// vorher: Aktivitaet Fokus im Datum (Art * davor), Vorsorge-Name ohne Stern,
// Naehrwerte 850px mit neun Zahlfeldern; leere Naehrwerte mit zwei
// Leerzustaenden (Ziel-Hinweis + Bereichs-Leerzustand). Nachher (1440):
// Aktivitaet Fokus „Art *", Vorsorge „Name *" required, Naehrwerte 526px.
test('R24 G5 P2-4/P3-6: Pflichtfeld zuerst, Seltenes gefaltet und benannt, ein Leerzustand', () => {
  const prev = HEALTH_JS.slice(HEALTH_JS.indexOf('function openPreventionModal('), HEALTH_JS.indexOf('function collectPreventionBody('));
  assert.match(prev, /for="prevention-name">\$\{esc\(t\('health\.prevention\.field\.name'\)\)\}\$\{REQUIRED_MARK\}/, 'der Name traegt den Stern');
  assert.match(prev, /nameInput\.required = !typeSelect\.value/, 'Pflicht, solange keine Art gewaehlt ist');
  assert.match(prev, /advancedSection\(advancedFieldsHtml, \{[\s\S]{0,80}hint:/, 'Weitere Angaben nennt Intervall & Co.');
  const meds = HEALTH_JS.slice(HEALTH_JS.indexOf('function openMedModal('), HEALTH_JS.indexOf('function collectMedBody('));
  assert.match(meds, /hint: \[t\('health\.meds\.field\.stockQty'\)/, 'auch das Medikament nennt, was dahinter liegt');
  const nut = HEALTH_JS.slice(HEALTH_JS.indexOf('function openNutritionModal('), HEALTH_JS.indexOf('function collectNutritionBody('));
  assert.match(nut, /nutrientFieldsMarkup\('nutrition-entry', row, \{ keys: \[NUTRIENTS\[0\]\.key\] \}\)/, 'sichtbar nur die Energie');
  assert.match(nut, /advancedSection\(`\s*\$\{nutrientFieldsMarkup\('nutrition-entry', row, \{ keys: NUTRIENTS\.slice\(1\)/, 'die Makros hinter Weitere Angaben');
  for (const area of ['vitals', 'meds', 'labs', 'prevention', 'nutrition']) {
    const fn = HEALTH_JS.slice(HEALTH_JS.indexOf(`title: isEdit ? t('health.${area}.edit')`), HEALTH_JS.indexOf(`title: isEdit ? t('health.${area}.edit')`) + 300);
    assert.match(fn, /initialFocus: dialogInitialFocus\(isEdit\)/, `${area}: Anlegen erstes Pflichtfeld, Bearbeiten am Finger der Titel`);
  }
  const shell = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderNutritionShell('), HEALTH_JS.indexOf('function nutritionTodaySectionMarkup('));
  assert.match(shell, /\$\{entries\.length \|\| nutrition\.summary\?\.target \? nutritionTodaySectionMarkup\(own\) : ''\}/,
    'ohne Eintrag und ohne Ziel nur der Leerzustand des Bereichs');
});

// R24 (Critique G5 P2-5): das Fastenziel stand nur im Einstellungsblatt hinter
// „...", gestartet lief man „Ohne Ziel"; Nachtragen stand im „..." UND im
// Leerzustand. Gemessen nachher (1440): Ziel-Leiste in der Bereit-Karte,
// Wahl 16:8 gespeichert, Fokus bleibt auf „16:8"; ohne Verlauf nur der Leerzustand.
// Escape schliesst das „..." (gemessen, erledigt vorab 71b012bc8).
test('R24 G5 P2-5: das Fastenziel steht vor dem Start, Nachtragen an EINER Stelle', () => {
  const page = read('public/pages/health-fasting.js');
  const controls = read('public/components/fasting-controls.js');
  assert.match(page, /\$\{writable && !active \? `<div class="fasting-hero__goal" data-fasting-goal-host>\$\{fastingGoalHtml\(state\.settings \|\| \{\}, \{ compact: true \}\)\}/,
    'ohne laufendes Fasten traegt die Karte die Ziel-Leiste');
  assert.match(page, /wireFastingPreferences\(goalHost,/, 'dieselbe Verdrahtung wie im Blatt: speichert sofort');
  assert.match(controls, /export function fastingPreferencesHtml[\s\S]{0,200}\$\{fastingGoalHtml\(settings\)\}/, 'das Blatt baut dieselbe Leiste');
  // EIN Weg je Datenlage: leer der Leerzustand (R22 D12), mit Verlauf das „..." (R23 D14).
  assert.match(page, /\$\{fastingMoreMenuHtml\(\{ backfill: !sections\.empty \}\)\}/, 'ohne Verlauf kein Nachtragen im „..."');
  assert.match(page, /\.\.\.\(backfill \? \[\{ action: 'fasting-backfill'/, 'mit Verlauf steht es dort');
});

// R24 (Critique G5 P2-6, P3-2, P3-3): vorher 1440 - Zeitraum als eigene
// Kapsel mit Ring (36px) ueber den Kacheln, der Stepper im Diagrammkopf;
// Blutdruck + Puls 2 x 270px fuer drei Messungen, Puls in Amber; neun Kacheln
// in vier Spalten mit drei leeren Zellen, Aktivitaet 170px leer neben vier
// Kennzahlen; Uebersicht-Kacheln ohne Trendlinie. Nachher: Segment + EIN
// Stepper (utils/period-stepper.js) in einer Zeile, Diagramme 2 x 200px.
test('R24 G5 P2-6/P3-2/P3-3: eine Zeitraum-Zeile, eine Kachel, Diagramm mit fester Hoehe, kein Loch', async () => {
  const shell = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderVitalsShell('), HEALTH_JS.indexOf('function wirePersonSwitcher('));
  assert.match(shell, /<div class="health-vitals__toolbar health-period-row">\s*<div class="segmented health-vitals__ranges"/, 'das Kanon-Segment in der Zeitraum-Zeile');
  assert.match(shell, /\$\{vitalStepperMarkup\(\)\}\s*<\/div>/, 'der Stepper in derselben Zeile');
  assert.match(HEALTH_JS.slice(HEALTH_JS.indexOf('function vitalStepperMarkup('), HEALTH_JS.indexOf('function renderVitalsShell(')), /periodStepperHtml\(\{/, 'der eine Baustein');
  const detail = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderDetail()'), HEALTH_JS.indexOf('const pendingDeletes'));
  assert.doesNotMatch(detail, /data-step=/, 'kein zweiter Stepper im Diagrammkopf');
  assert.match(detail, /chartMarkup\(metric, series, geo\)/, 'das Diagramm nimmt die Geometrie der Spalte');
  const activityShell = HEALTH_JS.slice(HEALTH_JS.indexOf('function renderActivityShell('), HEALTH_JS.indexOf('function activityStatsMarkup('));
  assert.match(activityShell, /health-activity__toolbar health-period-row">\s*<div class="health-activity__stepper">\$\{periodStepperHtml\(/, 'die Aktivitaet traegt dieselbe Zeile');
  // Geometrie: ab der Grundbreite bleibt die Hoehe in Pixeln (CHART.H), die Breite in Einheiten.
  const geoFn = HEALTH_JS.slice(HEALTH_JS.indexOf('function vitalDetailGeometry('), HEALTH_JS.indexOf('const _vitalDetailObservers'));
  const { CHART } = await import('../public/utils/chart.js');
  // eslint-disable-next-line no-new-func
  const geometry = new Function('CHART', `${geoFn}; return vitalDetailGeometry;`)(CHART);
  const at = (width) => geometry({ getBoundingClientRect: () => ({ width }) });
  assert.equal(at(500), CHART, 'schmal wie bisher');
  const wide = at(842); // 1440: 810px Diagramm
  assert.equal(wide.W, CHART.W, 'die Breite in Einheiten bleibt - an ihr haengt der Schriftmassstab');
  assert.equal(Math.round((810 * wide.H) / wide.W), CHART.H, '810px breit, 200px hoch');
  // Der Puls auf eigener Achse traegt den Modulton, nicht Amber.
  assert.match(HEALTH_JS, /seriesSvg = channels\.map\(\(\{ key, idx \}, pos\) => \{[\s\S]{0,400}CHANNEL_COLORS\[pos % CHANNEL_COLORS\.length\]/);
  // Eine Kachel: auch die Uebersicht traegt die Trendlinie.
  const ov = HEALTH_JS.slice(HEALTH_JS.indexOf('function overviewVitalCardMarkup('), HEALTH_JS.indexOf('function overviewUpcomingMarkup('));
  assert.match(ov, /sparklineMarkup\(series\.points, 'value_num', metric\)/);
  const { eachRule } = await import('./css-rules.js');
  const rules = [...eachRule(read('public/styles/health.css'))];
  assert.ok(rules.some((r) => r.at.some((a) => /container metric-grid \(min-width: 676px\)/.test(a)) && /:last-child:nth-child\(4n\+1\)/.test(r.selector) && /span 4/.test(r.body)),
    'vier Spalten, eine Kachel allein: sie nimmt die Zeile');
  assert.ok(rules.some((r) => r.selector.trim() === '.health-activity__summary' && /repeat\(auto-fit,/.test(r.body)), 'vier Kennzahlen fuellen die Zeile');
  assert.ok(!rules.some((r) => /\.health-vitals__range\.is-active/.test(r.selector)), 'keine eigene Segment-Pille mehr');
});

// R24 (Critique G5 P3-4, P3-5). Zyklus vorher: Ring „Nächste Periode: in 22
// Tagen" + Kachel „Nächste Periode 19.11." nebeneinander. Labor vorher: Verlauf
// ueber ein natives <select>, Spalte „Bewertung" leer bis auf eine Zeile,
// „Bearbeiten" als Geisterknopf. Nachher (1440 + 390): Tipp auf „Ferritin" ->
// „Verlauf · Ferritin", Fokus bleibt am Namen, aria-pressed.
test('R24 G5 P3-4/P3-5: ein Wert fuer die naechste Periode, der Analyt waehlt seinen Verlauf', () => {
  const stats = HEALTH_JS.slice(HEALTH_JS.indexOf('function cycleStatsMarkup('), HEALTH_JS.indexOf('function cycleStatsSourceText('));
  assert.match(stats, /if \(perimenopauseRange\) \{\s*tiles\.push\(cycleStatCardMarkup\(\{\s*icon: 'calendar-heart'/, 'die Kachel nur noch fuer die Spanne');
  const detail = HEALTH_JS.slice(HEALTH_JS.indexOf('function labDetailMarkup('), HEALTH_JS.indexOf('function referenceLabel('));
  assert.doesNotMatch(detail, /health\.labs\.col\.flag|health-lab-table__flag/, 'keine Spalte Bewertung mehr');
  assert.match(detail, /<td class="health-lab-table__value">\$\{esc\(fmtNum\(r\.value_num\)\)\}\$\{unit\}\$\{flag \? ` \$\{flag\}` : ''\}<\/td>/, 'die Bewertung steht am Wert');
  assert.match(detail, /<th scope="row" class="health-lab-table__analyte">\$\{labTrendButtonMarkup\(r\)\}<\/th>/, 'der Analyt ist Zeilenkopf und Knopf');
  assert.match(detail, /<span class="health-lab-rows__analyte">\$\{labTrendButtonMarkup\(r\)\}<\/span>/, 'auch in den Zeilen am Telefon');
  assert.match(detail, /class="btn btn--secondary btn--sm" data-action="lab-edit"/, 'Bearbeiten als Abschnittsaktion, kein Geisterknopf');
  const trend = HEALTH_JS.slice(HEALTH_JS.indexOf('function labTrendMarkup('), HEALTH_JS.indexOf('function labTrendChart('));
  assert.doesNotMatch(trend, /<select/, 'kein natives Auswahlfeld mehr');
  assert.match(HEALTH_JS, /querySelectorAll\('\[data-lab-trend\]'\)\.forEach\(\(btn\) => btn\.addEventListener\('click'/);
});
