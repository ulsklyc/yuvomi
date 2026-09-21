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

test('HEALTH_TABS(): acht Tabs mit passenden Routen, Label-Keys und Icons', () => {
  const tabs = HEALTH_TABS();
  assert.equal(tabs.length, 8);
  assert.deepEqual(tabs.map((tab) => tab.route), HEALTH_ROUTES.filter((route) => route !== '/health/fasting'));
  assert.deepEqual(tabs.map((tab) => tab.labelKey), [
    'health.tabs.overview', 'health.tabs.vitals', 'health.tabs.cycle',
    'health.tabs.meds', 'health.tabs.prevention', 'health.tabs.labs', 'health.tabs.activity',
    'health.tabs.nutrition',
  ]);
  assert.deepEqual(tabs.map((tab) => tab.icon), [
    'heart-pulse', 'activity', 'droplet', 'pill', 'syringe', 'flask-conical', 'dumbbell', 'salad',
  ]);
});

test('HEALTH_TABS({ cycleEnabled: false }): blendet den Zyklus-Tab aus', () => {
  const tabs = HEALTH_TABS({ cycleEnabled: false });
  assert.equal(tabs.length, 7);
  assert.ok(!tabs.some((tab) => tab.route === '/health/cycle'), 'kein Zyklus-Tab');
  assert.deepEqual(tabs.map((tab) => tab.route), [
    '/health', '/health/vitals', '/health/meds', '/health/prevention', '/health/labs', '/health/activity', '/health/nutrition',
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
  assert.match(fn, /cycle-log-painkiller[\s\S]{0,200}await closeModal\(\)[\s\S]{0,80}navigate\('\/health\/medications'\)/,
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
