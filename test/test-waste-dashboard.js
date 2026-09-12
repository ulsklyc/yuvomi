/**
 * Modul: Waste collection - Dashboard widget (#1063 Phase 4)
 * Zweck: die Registrierung des Waste-Widgets (Modul-Zuordnung, Dispatch-Eintrag,
 *        Refresh-Carry-over, Anpassen-Standardliste, Groessenklasse) und die
 *        reine Rendering-Logik von renderWasteWidget - ein Eintrag je aktivem
 *        Typ, Datum-zuerst-Sortierung, Zeilendeckel/"+N mehr", die
 *        "naechster Termin insgesamt"-Betonung, verschoben-/coalesced-Flags,
 *        der stabile Deep-Link und die drei Leer-/Fehler-/Warnzustaende
 *        (keine Typen, Ladefehler, Quelle braucht Auffrischung). Folgt
 *        demselben Muster wie das Schedule-Widget (test-dashboard.js, Abschnitt
 *        "Schedule-Widget"): Registrierung ueber Quelltext-Regex, Rendering
 *        ueber direkte __test-Aufrufe mit kleinen Fixtures. Der Loader-Stub
 *        von /i18n.js echoet t('key', values) als "key" + JSON.stringify(values)
 *        und formatDate(d) als String(d) - Assertions pruefen also gegen diese
 *        vorhersagbare Form, nicht gegen echten Uebersetzungstext.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-waste-dashboard.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

const { __test } = await import('../public/pages/dashboard.js');
const { renderWasteWidget, listRowCap } = __test;
const widgetsUtil = await import('../public/utils/dashboard-widgets.js');
const permissions = await import('../server/permissions.js');

const src = () => readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');

// -------------------------------------------------------------------------
// Registrierung (Quelltext-Verdrahtung, wie beim Schedule-Widget)
// -------------------------------------------------------------------------

test('das Waste-Widget ist im Modul/Dispatch verdrahtet und der Refresh-Carry-over steht an beiden Stellen', () => {
  const text = src();
  assert.match(text, /waste:\s*'waste'/, 'MODULE_FOR_WIDGET kennt das Modul hinter dem Widget nicht');
  assert.match(text, /waste:\s*\(size\)\s*=>\s*renderWasteWidget/, 'widgetById hat keinen Eintrag fuer waste, oder reicht die Groesse nicht durch');
  const carryOvers = [...text.matchAll(/fresh\.waste\s*=\s*data\.waste;/g)];
  assert.equal(carryOvers.length, 2,
    `fresh.waste = data.waste; muss an beiden Refresh-Stellen stehen (reloadIfQueryChanged UND `
    + `refreshDashboardData), sonst faellt die Kachel bei einem stillen Refresh auf ihren Leerzustand `
    + `zurueck - gefunden: ${carryOvers.length}`);
});

test('ensureWasteSlice() ist idempotent und respektiert die Modul-Abschaltung, wie ensureScheduleSlice()', () => {
  const text = src();
  const fn = text.slice(text.indexOf('async function ensureWasteSlice'), text.indexOf('async function ensureWasteSlice') + 1200);
  assert.match(fn, /if \(data\.waste !== undefined\) return;/, 'die Slice muss sich nur einmal laden, wie der Schedule-Slice');
  assert.match(fn, /isModuleDisabled\('waste'\)/, 'ein abgeschaltetes Modul darf keinen Request ausloesen');
  assert.match(fn, /data\.waste = null;/, 'ein Ladefehler muss den expliziten Fehler-Sentinel setzen, nicht das Widget verstecken');
});

// -------------------------------------------------------------------------
// Per-Typ-Widget-Option (#1063 Phase 10) - Quelltext-Verdrahtung, wie oben:
// ensureWasteSlice/openWidgetOptions sind private Closures innerhalb von
// render(), nicht ueber __test aufrufbar.
// -------------------------------------------------------------------------

test('WIDGETS_WITH_OPTIONS traegt waste ein, wie calendar/tasks', () => {
  const text = src();
  assert.match(text, /WIDGETS_WITH_OPTIONS\s*=\s*new Set\(\[[^\]]*'waste'[^\]]*\]\)/,
    'ohne diesen Eintrag zeigt widgetHasOptions() nie den Optionen-Knopf fuer die Waste-Kachel');
});

test('openWidgetOptions() traegt einen eigenen Zweig fuer waste mit einer Typ-Checkbox-Liste', () => {
  const text = src();
  const start = text.indexOf('async function openWidgetOptions');
  const end = text.indexOf('\nfunction renderWidgetCustomizeControls');
  const fn = text.slice(start, end);
  assert.match(fn, /id === 'waste'/, 'openWidgetOptions muss waste als eigenen Fall erkennen, nicht in den tasks/else-Zweig durchfallen');
  assert.match(fn, /name="waste-type"/, 'die Typ-Checkboxen brauchen den eigenen Feldnamen, ueber den das Submit-Handling sie ausliest');
  assert.match(fn, /if \(picked\.length\) next\.types = picked;/,
    'keine Auswahl muss "alle" bedeuten (leere Liste waere ein leeres Widget fuer wer nur den Dialog oeffnete), wie bei den Aufgaben-Kategorien');
});

test('ensureWasteSlice() filtert nach der Typ-Option, "alle" bleibt die Vorgabe ohne Auswahl', () => {
  const text = src();
  const start = text.indexOf('async function ensureWasteSlice');
  const fn = text.slice(start, start + 1200);
  assert.match(fn, /widgetConfig\.find\(\(w\) => w\.id === 'waste'\)\?\.options\?\.types/,
    'der Slice muss die eigene Widget-Option lesen, nicht nur die rohe API-Antwort durchreichen');
  assert.match(fn, /selectedTypes\?\.length \? items\.filter/,
    'eine LEERE Auswahl darf nicht filtern (das waere ein leeres Widget) - nur eine NICHT-leere Auswahl schraenkt ein');
});

test('ein geaenderter Typ-Filter verwirft den gecachten Waste-Slice, statt den alten Stand zu behalten (dashboardQuery traegt ihn nicht mit)', () => {
  const text = src();
  const occurrences = [...text.matchAll(/wasteOptionsChanged|wasteOptionsBeforeUndo/g)];
  assert.ok(occurrences.length >= 4,
    `alle vier Persist-/Reset-/Undo-Pfade muessen den Waste-Slice bei einer Optionsaenderung invalidieren, sonst zeigt die Kachel den alten Filterstand bis zum naechsten vollen Seitenaufbau (gefunden: ${occurrences.length})`);
});

test('das Waste-Widget ist in der Anpassen-Standardliste als Opt-in eingetragen, wie schedule/housekeeping', () => {
  assert(widgetsUtil.WIDGET_IDS.includes('waste'), 'WIDGET_IDS fehlt waste');
  assert(widgetsUtil.DEFAULT_HIDDEN_WIDGETS.has('waste'),
    'waste muss wie rewards/health/housekeeping/schedule erst im Anpassen-Tray auftauchen, nicht ab Werk sichtbar sein');
});

test('die Waste-Kachel defaultet auf 1x2 wie schedule/family, nicht auf 1x1', () => {
  assert.equal(widgetsUtil.defaultWidgetSize('waste'), '1x2',
    'eine Liste "naechste Abholung je Typ" braucht Hoehe, nicht Breite');
});

test('PERMISSION_WIDGETS kennt das Waste-Widget und bindet es an das waste-Modul', () => {
  const entry = permissions.PERMISSION_WIDGETS.find((w) => w.id === 'waste');
  assert(entry, 'PERMISSION_WIDGETS fehlt ein Eintrag fuer waste');
  assert.equal(entry.module, 'waste', 'ein gesperrtes waste-Modul muss auch das Widget sperren (#467)');
});

// -------------------------------------------------------------------------
// renderWasteWidget: Leer-/Fehlerzustaende
// -------------------------------------------------------------------------

test('renderWasteWidget: ohne Typen zeigt es den Erststart-Leerzustand mit CTA nach /waste', () => {
  const html = renderWasteWidget({ items: [], needsRefresh: false }, '1x2');
  assert.match(html, /waste\.emptyTypesTitle/, 'Leertitel fehlt');
  assert.match(html, /data-route="\/waste"/, 'die CTA muss ins Modul fuehren');
  assert.match(html, /waste\.addType/, 'die CTA-Beschriftung fehlt');
});

test('renderWasteWidget: undefined items (Slice noch nicht geladen) faellt auf denselben Leerzustand zurueck', () => {
  const html = renderWasteWidget({ needsRefresh: false }, '1x1');
  assert.match(html, /waste\.emptyTypesTitle/);
});

test('renderWasteWidget: ein Ladefehler (waste === null) wirft, statt still leer zu rendern', () => {
  assert.throws(() => renderWasteWidget(null, '1x2'),
    'ein Ladefehler muss die geteilte Fehlerkachel (renderWidgetError, ueber den try/catch in renderDashboardLayout) ausloesen');
});

// -------------------------------------------------------------------------
// renderWasteWidget: ein Eintrag je Typ, Zeilendeckel, "+N mehr"
// -------------------------------------------------------------------------

function type(id, overrides = {}) {
  return { id, name: `Typ ${id}`, icon: 'trash-2', color: '#6C3AED', sort_order: id, ...overrides };
}

function occurrence(typeId, dateKey, overrides = {}) {
  return {
    key: `${typeId}:${dateKey}`, date_key: dateKey, type_id: typeId,
    moved: false, coalesced: false, origins: [{ kind: 'schedule', schedule_id: typeId, moved: false }],
    deep_link: `?type=${typeId}&date=${dateKey}`, ...overrides,
  };
}

test('renderWasteWidget: ein Eintrag je aktivem Typ, Zeilendeckel aus der Kachelgroesse (wie listRowCap)', () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ type: type(id), next: occurrence(id, `2026-06-${10 + id}`) }));
  const zeilen = (html) => (html.match(/class="waste-widget-row"/g) || []).length;

  const wide = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.equal(zeilen(wide), listRowCap('1x2'), 'die hohe Kachel muss beim Zeilendeckel (5) stoppen, nicht alle 7 zeigen');

  const narrow = renderWasteWidget({ items, needsRefresh: false }, '1x1');
  assert.equal(zeilen(narrow), listRowCap('1x1'), 'die flache Kachel deckelt enger (3)');
});

test('renderWasteWidget: der Kopf zaehlt Typen MIT naechster Abholung, unabhaengig vom Zeilendeckel', () => {
  const items = [
    { type: type(1), next: occurrence(1, '2026-06-10') },
    { type: type(2), next: occurrence(2, '2026-06-11') },
    { type: type(3), next: null },
  ];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x1');
  assert.match(html, /widget__badge">2</, 'zwei Typen haben eine naechste Abholung, der dritte nicht - der Kopf zaehlt die echte Zahl');
});

test('renderWasteWidget: "+N mehr" erscheint, wenn mehr Typen bestehen als Zeilen passen', () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ type: type(id), next: occurrence(id, `2026-06-${10 + id}`) }));
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2'); // Deckel 5, 2 bleiben aussen vor
  assert.match(html, /dashboard\.wasteMore\{&quot;count&quot;:2\}/, 'die Ueberlauf-Zeile muss die uebrigen zwei Typen nennen');
});

test('renderWasteWidget: ohne Ueberlauf bleibt "+N mehr" weg', () => {
  const items = [1, 2].map((id) => ({ type: type(id), next: occurrence(id, `2026-06-${10 + id}`) }));
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.doesNotMatch(html, /wasteMore/, 'zwei Typen passen locker in den Deckel von 5 - keine Ueberlauf-Zeile');
});

// -------------------------------------------------------------------------
// renderWasteWidget: Sortierung Datum zuerst, dann Typ-Reihenfolge
// -------------------------------------------------------------------------

test('renderWasteWidget: die Zeilen sortieren nach Datum, nicht nach der API-Grundordnung (Typ-Reihenfolge)', () => {
  // Typ 2 (sort_order 2) hat die naechste Abholung, Typ 1 (sort_order 1, API-fuehrend) die spaetere -
  // die Kachel muss trotzdem Typ 2 zuerst zeigen.
  const items = [
    { type: type(1), next: occurrence(1, '2026-07-01') },
    { type: type(2), next: occurrence(2, '2026-06-10') },
  ];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  const posA = html.indexOf('Typ 2');
  const posB = html.indexOf('Typ 1');
  assert(posA >= 0 && posB >= 0 && posA < posB, 'Typ 2 hat das fruehere Datum und muss zuerst stehen');
});

test('renderWasteWidget: Typen ohne naechste Abholung stehen hinter allen mit Datum', () => {
  const items = [
    { type: type(1), next: null },
    { type: type(2), next: occurrence(2, '2026-06-10') },
  ];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  const posWithDate = html.indexOf('Typ 2');
  const posWithout = html.indexOf('Typ 1');
  assert(posWithDate < posWithout, 'ein Typ ohne Termin darf einen mit Termin nicht verdraengen');
  assert.match(html, /waste\.noUpcomingPickup/, 'der Typ ohne Termin muss das ehrliche "keine naechste Abholung" zeigen');
});

test('renderWasteWidget: genau der fruehste Termin insgesamt traegt die Betonungs-Klasse', () => {
  const items = [
    { type: type(1), next: occurrence(1, '2026-07-01') },
    { type: type(2), next: occurrence(2, '2026-06-10') },
    { type: type(3), next: occurrence(3, '2026-06-20') },
  ];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  const emphasized = (html.match(/waste-widget-row__date--next/g) || []).length;
  assert.equal(emphasized, 1, 'nur der eine global naechste Termin traegt die Betonung');
});

// -------------------------------------------------------------------------
// renderWasteWidget: verschoben/coalesced-Flags, Deep-Link, Quelle braucht Auffrischung
// -------------------------------------------------------------------------

test('renderWasteWidget: ein verschobener Termin zeigt das Verschoben-Flag mit dem urspruenglichen Datum', () => {
  const items = [{
    type: type(1),
    next: occurrence(1, '2026-06-15', {
      moved: true,
      origins: [{ kind: 'schedule', schedule_id: 1, original_date: '2026-06-10', moved: true }],
    }),
  }];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.match(html, /data-lucide="move"/, 'ein verschobener Termin braucht das Verschoben-Icon');
  assert.match(html, /waste\.movedFromBadge\{&quot;date&quot;:&quot;2026-06-10&quot;\}/, 'die aria-label muss das urspruengliche Datum nennen');
});

test('renderWasteWidget: ein coalesced Termin zeigt das Mehrfach-Herkunft-Flag', () => {
  const items = [{
    type: type(1),
    next: occurrence(1, '2026-06-15', { coalesced: true }),
  }];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.match(html, /data-lucide="layers"/, 'ein coalesced Termin braucht das Mehrfach-Herkunft-Icon');
  assert.match(html, /waste\.coalescedHint/, 'die aria-label muss den Hinweistext tragen');
});

test('renderWasteWidget: der Deep-Link fuehrt auf /waste mit dem vom Server gelieferten ?type=&date=-Fragment', () => {
  const items = [{ type: type(1), next: occurrence(1, '2026-06-15') }];
  const html = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.match(html, /data-route="\/waste\?type=1&amp;date=2026-06-15"/, 'der Deep-Link muss den Server-Fragment-Vertrag uebernehmen (?type=<id>&date=<date>)');
});

test('renderWasteWidget: needsRefresh zeigt den Auffrischungs-Hinweis, sonst bleibt er weg', () => {
  const items = [{ type: type(1), next: occurrence(1, '2026-06-15') }];
  const mit = renderWasteWidget({ items, needsRefresh: true }, '1x2');
  assert.match(mit, /waste\.sourceNeedsRefreshBadge/, 'needsRefresh muss den Hinweis zeigen (invariant #6)');

  const ohne = renderWasteWidget({ items, needsRefresh: false }, '1x2');
  assert.doesNotMatch(ohne, /sourceNeedsRefreshBadge/, 'ohne needsRefresh darf kein Hinweis erscheinen');
});
