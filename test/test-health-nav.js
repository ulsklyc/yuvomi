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
  assert.match(fn, /FLOW_LEVELS\.map/, 'die vier Stufen muessen aus FLOW_LEVELS kommen, nicht hartkodiert sein');
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
  assert.match(legendFn, /own\s*\n?\s*\?\s*`<span class="cycle-legend__item">.*heart/, 'Legendeneintrag muss own-gated sein');
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
  const actions = update.match(/setPageFabAction\(_fab, \{[^\n]*\}\)/g) ?? [];
  assert.ok(actions.length >= 8, `erwartet: ein Aufruf je Tab plus der Ausblend-Zweig, gefunden ${actions.length}`);
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

test('R14 P3/P6: der Umzugsplan - Desktop Detailkopf, Bereich schmal Kopfzeile, Telefon-Uebersicht vor die Liste', async () => {
  const { hoistPlan } = await import('../public/utils/health-hoist.js');
  assert.deepEqual(hoistPlan({ split: true, overview: false, phone: false }), [{ part: 'person', slot: 'detail' }]);
  assert.deepEqual(hoistPlan({ split: true, overview: true, phone: false }), [{ part: 'person', slot: 'detail' }]);
  assert.deepEqual(hoistPlan({ split: false, overview: false, phone: true }), [{ part: 'person', slot: 'toolbar' }],
    'Bereichsseite: die Pille teilt die Zeile mit „‹ Gesundheit" statt eine eigene zu kosten');
  assert.deepEqual(hoistPlan({ split: false, overview: true, phone: true }).map((p) => `${p.part}>${p.slot}`),
    ['person>priority', 'banner>priority', 'due>priority', 'quick>priority'],
    'Telefon-Uebersicht: Person, Hinweis, Heute faellig, Schnell erfassen stehen VOR der Bereichsliste');
  assert.deepEqual(hoistPlan({ split: false, overview: true, phone: false }), [], 'Tablet: das Raster bleibt, wie es ist');
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
  const quick = mk('health-overview__card--quick', grid);
  const slots = { toolbar, detail, priority };

  applyHoistPlan(hoistPlan({ split: false, overview: true, phone: true }), { panel, slots });
  assert.deepEqual(priority.children, [person, due, quick], 'in Planreihenfolge vor der Liste');
  applyHoistPlan(hoistPlan({ split: true, overview: true, phone: false }), { panel, slots });
  assert.deepEqual(detail.children, [person], 'Desktop: die Pille steht im Detailkopf');
  assert.equal(priority.children.length, 0);
  assert.deepEqual(grid.children.map((c) => c.cls), ['health-overview__card--due', 'health-overview__card--other', 'health-overview__card--quick'],
    'die Karten stehen wieder an ihrem Platz im Raster');
  // Das Panel baut neu (Personenwechsel): die umgezogene alte Pille ist veraltet.
  root.children.splice(0, 1, new El('health-person-switcher'));
  root.children[0].parentElement = root;
  const frisch = root.children[0];
  applyHoistPlan(hoistPlan({ split: false, overview: false, phone: true }), { panel, slots });
  assert.deepEqual(toolbar.children, [frisch], 'die FRISCHE Pille zieht um');
  assert.equal(detail.children.length, 0, 'die alte ist weg, nicht doppelt zurueck im Panel');
  assert.equal(root.children.filter((c) => c.cls === 'health-person-switcher').length, 0);
});

test('R14 P3/P6: Kopf, Streifen und Detailkopf stehen im Markup, die Karten sind benannt', async () => {
  assert.match(HEALTH_JS, /class="health-toolbar__person" data-health-person-slot/, 'Slot in der Zeile „‹ Gesundheit"');
  assert.match(HEALTH_JS, /class="health-priority" data-health-priority><\/div>\s*<\/section>\s*\$\{areasNavMarkup\(\)\}/, 'Streifen VOR der Bereichsliste');
  assert.match(HEALTH_JS, /overviewCard\('calendar-check', 'health\.overview\.dueToday\.title', overviewDueMarkup\(\), 'due'\)/);
  assert.match(HEALTH_JS, /overviewCard\('plus-circle', 'health\.overview\.quick\.title', quickCaptureMarkup\(\), 'quick'\)/);
  assert.match(HEALTH_JS, /class="split-view__detail-head health-detail-head"/, 'Detailkopf wie die anderen Split-Views (A8 P2-2)');
  const { eachRule } = await import('./css-rules.js');
  const css = read('public/styles/health.css');
  const rules = [...eachRule(css)];
  assert.ok(rules.some((r) => /\.health-page\[data-health-pushed\] \.health-priority-region/.test(r.selector) && /display:\s*none/.test(r.body)),
    'in einem Bereich gibt es den Streifen nicht');
  assert.ok(rules.some((r) => /\.health-priority-region:not\(:has\(> \.health-priority > \*\)\)/.test(r.selector) && /display:\s*none/.test(r.body)), 'leer kostet er nichts');
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
  assert.ok(hides(/\.health-priority-region:not\(:has\(> \.health-priority > \*\)\)/), 'leere Region mit Ueberschrift bliebe stehen');
  assert.ok(hides(/\.health-page\[data-health-pushed\] \.health-priority-region/), 'in einem Bereich bliebe die Region stehen');
});

// R14 P4 (A6 P2-7): „Noch keine Eintraege." zentriert oben, ohne Weg - in der
// 676px-Detailspalte 21 % genutzt. Jetzt der geteilte Leerzustand mit Titel,
// Satz und dem Anlege-Weg (nur mit Schreibrecht).
test('R14 P4: Vorsorge und Naehrwerte leer = EIN Leerzustand mit Aktion statt einer Hinweiszeile', () => {
  const fnBody = (name) => {
    const start = HEALTH_JS.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} fehlt`);
    return HEALTH_JS.slice(start, HEALTH_JS.indexOf('\n}\n', start));
  };
  const prev = fnBody('renderPreventionShell');
  assert.doesNotMatch(prev, /emptyHintHTML\(t\('health\.prevention\.noRecords'\)\)/, 'Vorsorge: keine nackte Hinweiszeile mehr');
  assert.match(prev, /emptyStateHTML\(\{[\s\S]*?title: t\('health\.prevention\.emptyTitle'\)[\s\S]*?id: 'health-prevention-empty-add'/,
    'Vorsorge: Leerzustand mit Titel und Anlege-Knopf');
  assert.match(fnBody('wirePrevention'), /#health-prevention-empty-add'\)\?\.addEventListener\('click', \(\) => openPreventionModal\(null\)\)/);
  const nut = fnBody('renderNutritionShell');
  assert.doesNotMatch(nut, /emptyHintHTML\(t\('health\.nutrition\.noEntries'\)\)/, 'Naehrwerte: keine nackte Hinweiszeile mehr');
  assert.match(nut, /emptyStateHTML\(\{[\s\S]*?title: t\('health\.nutrition\.emptyTitle'\)[\s\S]*?id: 'health-nutrition-empty-add'/);
  assert.match(fnBody('wireNutrition'), /#health-nutrition-empty-add'\)\?\.addEventListener\('click', \(\) => openNutritionModal\(null\)\)/);
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
  assert.match(body, /if \(previous && previous !== id\) markAreaEntering\(route\);/, 'nicht mehr nur schmal');
  const fn = HEALTH_JS.slice(HEALTH_JS.indexOf('function markAreaEntering('), HEALTH_JS.indexOf('function markAreaEntering(') + 400);
  assert.match(fn, /swapContent\(panel, null\)/, 'Blende ohne Versatz am Panel');
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
});
