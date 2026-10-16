/**
 * Modul: Befehlspalette (Re-Critique 2026-09-28, A1 P2-1/P2-2)
 * Zweck: Die Zusagen der Palette hinter ⌘K, die man nur mit Tippen sieht:
 *   1. SIE FUEHRT ZU ORTEN. "Schichtplan" ergab "Keine Ergebnisse", obwohl der
 *      Hinweis "alle Bereiche" versprach, und die Kacheln kannten vier Module
 *      nicht (Schichtplan, Haushaltshilfe, Belohnungen, Mahlzeiten). Jetzt:
 *      "Gehe zu" aus den sichtbaren Navigationszielen und Einstellungsblaettern,
 *      "Neu anlegen" aus den Anlege-Aktionen, beide VOR den Datentreffern; die
 *      Kacheln sind alle sichtbaren Module.
 *   2. SIE ZEIGT DEN GRUND. "sch" lieferte "Klavier ueben" ohne jede Markierung.
 *      Jetzt steht der getroffene Wortteil in <mark>, ueber dieselbe Faltung wie
 *      der Server (Akzente, ß/ss), und ein Treffer ausserhalb des Titels zeigt
 *      seinen Ausschnitt (`excerpt`, services/search.js).
 * Ausfuehren: node --test test/test-search-palette.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  NEW_ACTIONS, markSegments, paletteCommands, paletteMatches,
} from '../public/utils/search-sections.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const router = read('../public/router.js');
const de = JSON.parse(read('../public/locales/de.json'));

test('ein Termin-Treffer oeffnet den Kalender an SEINEM Tag (#1607)', async () => {
  // Der Link trug nur die ID. Der Kalender fiel damit auf den Start der
  // Stammzeile zurueck (deepLinkTargetDate), und ein Geburtstag von 1990
  // oeffnete das Jahr 1990. Der Tag kommt aus dem Treffer, in der ANZEIGEZONE:
  // ein synchronisierter Termin liegt als Instant in der Zeile.
  const { SEARCH_SECTIONS } = await import('../public/utils/search-sections.js');
  const events = SEARCH_SECTIONS.find((s) => s.bucket === 'events');
  const fmt = { dateKey: (value) => `key(${value})` };
  assert.equal(events.route({ id: 7, start_datetime: '2026-10-14' }, fmt), '/calendar?open=7&date=key(2026-10-14)');
  assert.equal(events.route({ id: 7 }, fmt), '/calendar?open=7', 'ohne Start bleibt der Link, wie er war');
  assert.equal(events.route({ id: 7, start_datetime: '2026-10-14' }), '/calendar?open=7',
    'ohne Helfer wird kein Tag geraten');

  // Der AUFRUFER muss den Helfer auch hereinreichen - sonst ist der Zweig oben
  // tot, und der Test bliebe gruen.
  assert.ok(/import \{[^}]*\bzonedDateKey\b[^}]*\} from '\/utils\/timezone\.js'/.test(router),
    'router.js holt den Tagesschluessel der Anzeigezone nicht');
  assert.ok(/const fmt = \{[^}]*\bdateKey: zonedDateKey\b[^}]*\}/.test(router), 'fmt traegt keinen dateKey');
  assert.ok(router.includes('route: (item) => section.route(item, fmt)'),
    'die Sektion bekommt die Helfer nicht, wenn ihr Ziel gebaut wird');
});

const marked = (segments) => segments.filter((s) => s.mark).map((s) => s.text);

test('markSegments markiert den Wortteil im Original, gefaltet wie der Server', () => {
  assert.deepEqual(marked(markSegments('Klavier üben', 'üb')), ['üb']);
  assert.deepEqual(marked(markSegments('Frau Müller', 'muller')), ['Müller'], 'Akzente gefaltet, Original markiert');
  assert.deepEqual(marked(markSegments('Große Tüte', 'grosse')), ['Große'], 'ß ist ss');
  assert.deepEqual(marked(markSegments('Kinderzimmer aufräumen', 'zim auf')), ['zim', 'auf'], 'jedes Wort der Eingabe');
  assert.deepEqual(marked(markSegments('Schuhe waschen', 'sch')), ['Sch', 'sch'], 'jede Fundstelle');
  assert.deepEqual(markSegments('Abc', 'x'), [{ text: 'Abc', mark: false }]);
  assert.equal(markSegments('Kinderzimmer', 'nderz').map((s) => s.text).join(''), 'Kinderzimmer', 'der Text bleibt vollstaendig');
});

test('paletteCommands: "Schichtplan" fuehrt zum Schichtplan, "neu" zu den Anlege-Aktionen', () => {
  const places = [
    { label: 'Kalender', route: '/calendar', module: 'calendar' },
    { label: 'Schichtplan', route: '/schedule', module: 'schedule' },
    { label: 'Haushaltshilfe', route: '/housekeeping', module: 'housekeeping' },
    { label: 'Belohnungen', route: '/rewards', module: 'rewards' },
    { label: 'Mahlzeiten', route: '/meals', module: 'meals' },
  ];
  const actions = [
    { label: 'Aufgabe', route: '/tasks', module: 'tasks', context: 'Aufgaben', verb: 'Neu anlegen' },
    { label: 'Termin', route: '/calendar', module: 'calendar', context: 'Kalender', verb: 'Neu anlegen' },
  ];
  const settings = [{ label: 'Schichtplan', route: '/settings/schedule', context: 'Einstellungen' }];
  const r = paletteCommands('Schichtplan', { places, actions, settings });
  assert.deepEqual(r.places.map((p) => p.route), ['/schedule', '/settings/schedule'], 'Ort zuerst, dann das Einstellungsblatt');
  assert.deepEqual(paletteCommands('sch', { places }).places.map((p) => p.route), ['/schedule']);
  assert.deepEqual(paletteCommands('sch', { places: [], settings: [{ label: 'Budget', route: '/settings/budget' }] }).places, [],
    'ein Einstellungstreffer nur ueber die Beschreibung haette keinen sichtbaren Grund');
  assert.deepEqual(paletteCommands('mahl', { places }).places.map((p) => p.route), ['/meals']);
  assert.deepEqual(paletteCommands('neu', { places, actions }).actions.map((a) => a.route), ['/tasks', '/calendar']);
  assert.deepEqual(paletteCommands('kalender', { places, actions }).actions.map((a) => a.route), ['/calendar'],
    'das Modul nennt seine Aktion: "Kalender" findet "Neu anlegen: Termin"');
  assert.deepEqual(paletteCommands('', { places, actions }), { places: [], actions: [] });
  assert.equal(paletteMatches('bel', 'Belohnungen'), true);
});

test('jede Anlege-Aktion zeigt auf ein Navigationsziel des Routers und hat ihr Nomen', () => {
  for (const action of NEW_ACTIONS) {
    assert.match(router, new RegExp(`path: '${action.route}',\\s+label: t\\('nav\\.${action.module}'\\)`),
      `${action.module}: kein Navigationsziel ${action.route}`);
    const [block, key] = action.labelKey.split('.');
    assert.equal(typeof de[block]?.[key], 'string', `${action.labelKey} fehlt in de.json`);
  }
});

/** Der Rumpf einer Funktion in router.js - bis zur naechsten Funktion gleicher Tiefe. */
function body(name, until) {
  const start = router.indexOf(name);
  assert.ok(start >= 0, `${name} nicht gefunden`);
  const end = router.indexOf(until, start + name.length);
  return router.slice(start, end > start ? end : undefined);
}

test('Palette: Kacheln aus allen sichtbaren Zielen, Orte und Aktionen vor den Daten', () => {
  const hint = body('function renderSearchHint(', '// Der Marker der Zurueck-Geste');
  assert.match(hint, /navItems\(\)/, 'die Kacheln kommen aus den sichtbaren Navigationszielen');
  assert.doesNotMatch(hint, /searchScopeModules\(/,
    'die Kacheln waren die durchsuchten Module - vier sichtbare Ziele fehlten');

  const input = body("input.addEventListener('input'", 'return openSearch;');
  assert.match(input, /q\.length < 1/, 'Orte erscheinen ab dem ersten Zeichen');
  assert.match(input, /paletteLocal\(q\)/, 'die Eingabe fragt Orte und Aktionen ohne Server');
  assert.ok(input.indexOf('paletteLocal(q)') < input.indexOf("api.get(`/search"),
    'Orte und Aktionen stehen, bevor der Server gefragt wird');

  const render = body('function renderSearchResults(', '\n}\n');
  assert.match(render, /local\.places[\s\S]*local\.actions[\s\S]*SEARCH_SECTIONS\.forEach/,
    'Reihenfolge: Gehe zu, Neu anlegen, dann die Datentreffer');
  assert.match(render, /appendMarked\(titleEl, title\(item\), query\)/, 'der getroffene Wortteil wird im Titel markiert');
  assert.match(render, /appendMarked\(metaEl,/, '... und in Zweitzeile und Ausschnitt');
  const mark = body('function appendMarked(', '\n}\n');
  assert.match(mark, /markSegments\(text, query\)/);
  assert.match(mark, /createElement\('mark'\)/);
  assert.doesNotMatch(mark, /innerHTML/);
  assert.match(render, /item\.excerpt/, 'ein Treffer ausserhalb des Titels zeigt seinen Ausschnitt');
  assert.match(render, /await navigate\([^)]*\);\s*triggerPageFab\(\)/,
    'eine Anlege-Aktion oeffnet die Seite und loest ihren FAB aus - wie der Kurzbefehl n');
});

/**
 * EIN ZEICHEN OHNE ORT LAESST DIE PALETTE NICHT LEER (claude-review an #1492).
 * Unter zwei Zeichen fragt die Palette den Server nicht; findet `paletteLocal`
 * nichts (`?`, `5`, ein Buchstabe ohne Ort), leerte `renderSearchResults` die
 * Flaeche und schrieb nichts hinein - `data` ist dort null, das "Keine
 * Ergebnisse" gehoert der Serverantwort. Dann bleibt der Hinweis mit den
 * Kacheln stehen, bis ein zweites Zeichen die Daten fragt.
 */
test('ein Zeichen ohne lokalen Treffer zeigt weiter den Hinweis statt einer leeren Flaeche', () => {
  const input = body("input.addEventListener('input'", 'return openSearch;');
  const short = input.slice(input.indexOf('if (q.length < 2)'), input.indexOf('searchTimer = setTimeout'));
  assert.ok(short.length > 0, 'Zweig unter zwei Zeichen nicht gefunden');
  assert.match(short, /if \(localCount === 0\) \{\s*renderSearchHint\(\);\s*return;/,
    'ohne Ort und ohne Aktion bleibt der Hinweis stehen');
  assert.ok(short.indexOf('renderSearchHint()') < short.indexOf('announceCount(localCount)'),
    'der Hinweis kommt vor der Ansage - sonst hoert Sam "Keine Ergebnisse" ueber einem Hinweis');
});

test('der Hinweis verspricht, was die Palette haelt', () => {
  const hint = de.search.emptyHint;
  assert.doesNotMatch(hint, /alle Bereiche/, 'die Palette durchsucht Eintraege, sie findet Bereiche - "alle Bereiche durchsuchen" war falsch');
  assert.equal(typeof de.search.goTo, 'string');
  assert.equal(typeof de.search.newSection, 'string');
});

// R14 P12 (Re-Critique 2026-09-28, A1 P3-3/P3-6): Hilfe stand am Desktop nur
// hinter dem Avatar, und im Palettenfeld standen zwei X nebeneinander.
test('R14: Hilfe, Tastenkombinationen und Neuigkeiten sind Befehle der Palette', () => {
  const run = () => 'ran';
  const hit = paletteCommands('hilf', {
    places: [], commands: [{ label: 'Hilfe', run }, { label: 'Tastenkombinationen', run }, { label: 'Neuigkeiten', run }],
  });
  assert.deepEqual(hit.places.map((p) => p.label), ['Hilfe'], 'ein Befehl steht unter "Gehe zu", wenn sein Name passt');
  assert.deepEqual(paletteCommands('tasten', { commands: [{ label: 'Tastenkombinationen', run }] }).places.map((p) => p.label),
    ['Tastenkombinationen']);
  const local = body('function paletteLocal(', '\n}\n');
  assert.match(local, /label: t\('nav\.help'\), run: \(\) => showHelpModal\(\)/, 'Hilfe oeffnet das Hilfeblatt');
  assert.match(local, /label: t\('shortcuts\.help'\), run: \(\) => showHelpModal\(\)/, 'die Tastenkombinationen stehen darin');
  assert.match(local, /label: t\('nav\.changelog'\), run: \(\) => showChangelogModal\(\)/);
  assert.match(local, /paletteCommands\(q, \{ places, settings, actions, commands \}\)/);
  const render = body('function renderSearchResults(', '\n}\n');
  assert.match(render, /go: \(item\) => \(item\.run \? item\.run\(\) : navigate\(item\.route\)\)/,
    'ein Befehl laeuft, ein Ort wird angesteuert');
  assert.equal(de.nav.changelog, 'Neuigkeiten', '"Aenderungen" versprach Aenderungen an den eigenen Daten');
});

test('R14: im Palettenfeld steht EIN X - das native Leeren ist aus', async () => {
  const { eachRule } = await import('./css-rules.js');
  const css = read('../public/styles/layout.css');
  const rule = [...eachRule(css)].find((r) => r.selector.split(',').some((s) => s.trim() === '.search-overlay__input::-webkit-search-cancel-button'));
  assert.ok(rule, 'die Regel fuer das native Leeren fehlt');
  assert.match(rule.body, /display:\s*none/);
});

/*
 * ENTER OEFFNET DEN ERSTEN TREFFER (Re-Critique 2026-09-28, A1 P1-1).
 * ⌘K, "kal", Enter: der Pfad blieb `/`, die Palette offen - der Tastenhandler
 * kannte nur Pfeiltasten, und die schoben den Fokus aus dem Feld. Gefahren
 * wird der echte Handler aus utils/palette-combobox.js gegen einen kleinsten
 * Stub (`querySelectorAll`, `setAttribute`, `click`, mehr fasst er nicht an);
 * der Textteil haelt die Verdrahtung in router.js, denn ein Handler, den
 * niemand aufruft, waere sonst gruen.
 */
class Stub {
  constructor(classes = '', { id = '' } = {}) {
    this.classes = new Set(classes.split(' ').filter(Boolean));
    this.attrs = new Map();
    this.id = id;
    this.children = [];
    this.listeners = {};
    this.clicks = 0;
    this.tabIndex = 0;
  }

  append(...kids) { this.children.push(...kids); return this; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { this.clicks += 1; }
  matches(sel) { return sel.split(',').some((s) => this.classes.has(s.trim().replace(/^\./, ''))); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) { return this.matches(sel) ? this : null; }
  key(key) {
    let prevented = false;
    const e = { key, isComposing: false, preventDefault: () => { prevented = true; } };
    (this.listeners.keydown ?? []).forEach((fn) => fn(e));
    return prevented;
  }
}

function palette() {
  const input = new Stub('search-overlay__input', { id: 'search-input' });
  const results = new Stub('search-overlay__results', { id: 'search-results' });
  const goTo = new Stub('search-section').append(
    new Stub('search-section__heading'),
    new Stub('search-section__rows').append(new Stub('search-result'), new Stub('search-result')),
  );
  const data = new Stub('search-section').append(
    new Stub('search-section__heading'),
    new Stub('search-section__rows').append(new Stub('search-result')),
  );
  results.append(goTo, data);
  const hits = results.querySelectorAll('.search-result');
  return { input, results, hits };
}

test('A1 P1-1: Enter im Feld oeffnet den ersten Treffer, Pfeile bewegen nur die Markierung', async () => {
  const { wirePaletteCombobox } = await import('../public/utils/palette-combobox.js');
  const { input, results, hits } = palette();
  const combo = wirePaletteCombobox({ input, listbox: results });
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), 'search-results');

  combo.refresh();
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(results.getAttribute('role'), 'listbox');
  assert.ok(hits.every((h) => h.getAttribute('role') === 'option' && h.tabIndex === -1),
    'die Zeilen sind Optionen und stehen nicht in der Tab-Folge');
  assert.equal(input.getAttribute('aria-activedescendant'), hits[0].id, 'der erste Treffer ist vorgewaehlt');
  assert.equal(hits[0].getAttribute('aria-selected'), 'true');
  assert.ok(results.querySelectorAll('.search-section').every((g) => g.getAttribute('role') === 'group'
    && g.getAttribute('aria-labelledby')), 'jede Gruppe ist nach ihrer Ueberschrift benannt');

  assert.equal(input.key('Enter'), true, 'Enter wird vom Feld genommen');
  assert.deepEqual(hits.map((h) => h.clicks), [1, 0, 0], 'Enter oeffnet den ersten Treffer - ueber seinen Klick');

  assert.equal(input.key('ArrowDown'), true);
  assert.equal(input.key('ArrowDown'), true);
  assert.equal(input.getAttribute('aria-activedescendant'), hits[2].id, 'der Pfeil erreicht auch die Datentreffer');
  input.key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), hits[2].id, 'am Ende bleibt die Markierung stehen');
  input.key('Enter');
  assert.deepEqual(hits.map((h) => h.clicks), [1, 0, 1]);
  input.key('ArrowUp');
  assert.equal(input.getAttribute('aria-activedescendant'), hits[1].id);
  combo.refresh({ keep: true });
  assert.equal(input.getAttribute('aria-activedescendant'), hits[1].id, 'nachkommende Daten verschieben die Markierung nicht');

  combo.clear();
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  assert.equal(input.key('Enter'), false, 'ohne Zeile bleibt Enter beim Feld');
});

test('A1 P1-1: im Leerzustand ist nichts vorgewaehlt, die Kacheln erreicht der Pfeil', async () => {
  const { wirePaletteCombobox } = await import('../public/utils/palette-combobox.js');
  const input = new Stub('', { id: 'search-input' });
  const results = new Stub('', { id: 'search-results' });
  const hint = new Stub('empty-state');
  const tiles = [new Stub('search-scope'), new Stub('search-scope')];
  results.append(hint, new Stub('search-scopes').append(new Stub('search-section__heading'), new Stub('search-scopes__list').append(...tiles)));
  const combo = wirePaletteCombobox({ input, listbox: results });
  combo.refresh({ preselect: false });
  assert.equal(input.getAttribute('aria-activedescendant'), null, 'Enter auf ein leeres Feld oeffnet keine Kachel');
  assert.equal(input.key('Enter'), false);
  assert.equal(hint.getAttribute('role'), 'none', 'eine Listbox besitzt nur Gruppen und Optionen');
  input.key('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), tiles[0].id, '"Direkt oeffnen" ist per Pfeil erreichbar');
  input.key('Enter');
  assert.equal(tiles[0].clicks, 1);
});

test('A1 P1-1: router.js verdrahtet die Combobox nach jedem Rendern der Palette', () => {
  const init = body('function initSearch(', 'return openSearch;');
  assert.match(init, /wirePaletteCombobox\(\{ input, listbox: results \}\)/, 'das Suchfeld wird zur Combobox');
  const hint = body('function renderSearchHint(', '// Der Marker der Zurueck-Geste');
  assert.match(hint, /combo\.refresh\(\{ preselect: false \}\)/, 'die Kacheln zaehlen als Zeilen, ohne Vorwahl');
  const input = body("input.addEventListener('input'", 'return openSearch;');
  const renders = input.match(/renderSearchResults\(/g).length;
  const refreshes = input.match(/combo\.refresh\(/g)?.length ?? 0;
  assert.equal(refreshes, renders, 'jedes Rendern liest die Zeilen neu ein - sonst zeigt die Markierung ins Leere');
  const close = body('function closeSearch(', "if (searchClose)");
  assert.match(close, /combo\.clear\(\)/);
  assert.doesNotMatch(init, /hits\[[^\]]*\]\.focus\(\)|\.focus\(\);\s*\} else if \(idx/,
    'die Pfeile schieben den Fokus nicht mehr aus dem Feld');
});

// R19 (Critique 2026-10-16, Alex): ⌘K mit leerem Feld zeigte kein „zuletzt
// geoeffnet". Gemerkt werden ORTE aus der Palette - je Konto, hoechstens
// fuenf, der neueste zuerst, je Ziel einmal.
// Sicherheits-Review R19: im Speicher stehen nur Ziel und Modul, nie ein Name
// oder Kontext (Datentreffer aus Gesundheit, Dokumenten, privaten Notizen
// ueberlebten das Abmelden), und beim Abmelden gehen alle Listen.
test('R19: zuletzt geoeffnet - nur Ziel und Modul im Speicher, je Konto, neueste zuerst', async () => {
  const { pushRecent, readRecent, rememberRecent, visibleRecent, recentStorageKey, RECENT_MAX } = await import('../public/utils/search-sections.js');
  let list = [];
  for (let i = 1; i <= 7; i++) list = pushRecent(list, { route: `/m${i}`, module: `m${i}` });
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(list.map((e) => e.route), ['/m7', '/m6', '/m5', '/m4', '/m3']);
  list = pushRecent(list, { route: '/m5', module: 'm5' });
  assert.deepEqual(list.map((e) => e.route), ['/m5', '/m7', '/m6', '/m4', '/m3'], 'dasselbe Ziel rueckt nach vorn statt doppelt');
  assert.equal(pushRecent([], { route: 'https://evil.example/', module: 'x' }).length, 0, 'nur Ziele in der App');
  assert.equal(pushRecent([], { route: '//evil.example/', module: 'x' }).length, 0);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  rememberRecent(storage, 1, { route: '/health?open=3', module: 'health', label: 'Blutdruck 180/110', context: 'Befund' });
  const raw = store.get(recentStorageKey(1));
  assert.doesNotMatch(raw, /Blutdruck|Befund|label|context/, `ein Name liegt im Speicher: ${raw}`);
  assert.deepEqual(JSON.parse(raw), [{ route: '/health?open=3', module: 'health' }]);
  rememberRecent(storage, 2, { route: '/budget', module: 'budget' });
  assert.deepEqual(readRecent(storage, 1).map((e) => e.module), ['health'], 'ein Konto sieht nicht die Liste eines anderen');
  store.set(recentStorageKey(3), '{kaputt');
  assert.deepEqual(readRecent(storage, 3), [], 'Unlesbares ist eine leere Liste');
  store.set(recentStorageKey(4), JSON.stringify([{ route: '/notes', module: 'notes', label: 'alt gespeichert' }]));
  assert.deepEqual(readRecent(storage, 4), [{ route: '/notes', module: 'notes' }], 'ein alter Name wird nicht wieder hervorgeholt');
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readRecent(throwing, 1), []);
  assert.doesNotThrow(() => rememberRecent(throwing, 1, { route: '/a', module: 'a' }));
  const resolve = ({ module }) => (module === 'calendar' ? { label: 'Kalender' } : null);
  assert.deepEqual(visibleRecent([{ route: '/budget', module: 'budget' }, { route: '/calendar', module: 'calendar' }], resolve),
    [{ route: '/calendar', module: 'calendar', label: 'Kalender', context: '' }], 'der Name kommt beim Anzeigen, Unaufloesbares faellt heraus');
});

test('R19: beim Abmelden gehen alle Listen, nur diese', async () => {
  const { forgetAllRecent, recentStorageKey } = await import('../public/utils/search-sections.js');
  const store = new Map([[recentStorageKey(1), '[]'], [recentStorageKey(2), '[]'], ['yuvomi-theme', 'dark']]);
  const storage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => store.delete(k),
  };
  forgetAllRecent(storage);
  assert.deepEqual([...store.keys()], ['yuvomi-theme']);
  assert.doesNotThrow(() => forgetAllRecent(null));
  const forget = router.slice(router.indexOf('function forgetSessionState()'), router.indexOf('// Session abgelaufen'));
  assert.match(forget, /forgetAllRecent\(safeLocalStorage\(\)\)/, 'forgetSessionState (Abmelden, abgelaufene Sitzung) leert sie');
});

test('R19: die leere Palette zeigt "Zuletzt geoeffnet", gemerkt werden nur Orte, ohne Namen', () => {
  const hint = router.slice(router.indexOf('function renderSearchHint()'), router.indexOf("const scopes = document.createElement('div');", router.indexOf('function renderSearchHint()')));
  assert.match(hint, /visibleRecent\(readRecent\(safeLocalStorage\(\), routerState\.currentUser\?\.id\), recentPlace\(navItems\(\)\)\)/,
    'gelesen je Konto, Namen frisch aus Navigation und Einstellungen');
  assert.match(hint, /paletteRowsSection\(t\('search\.recentLabel'\)/, 'eine benannte Gruppe in der Bauart der Treffer');
  assert.equal(de.search.recentLabel, 'Zuletzt geöffnet');
  for (const call of router.match(/rememberRecent\([^;]*\);/g) ?? []) {
    assert.match(call, /\{ route: item\.route, module: item\.module \}/, `nur Ziel und Modul: ${call}`);
  }
  const make = router.slice(router.indexOf('function makeSection('), router.indexOf('// 1. GEHE ZU'));
  assert.match(make, /remember = false/, 'Datentreffer merken sich nicht (Standard aus)');
  const goTo = router.slice(router.indexOf("makeSection(t('search.goTo')"), router.indexOf("makeSection(t('search.newSection')"));
  assert.match(goTo, /remember: true/, 'nur die Orte');
  const place = router.slice(router.indexOf('function recentPlace('), router.indexOf('function paletteRowsSection('));
  assert.match(place, /findSettingsLeaf\(/, 'ein Einstellungsblatt nur, wenn der Betrachter es sehen darf');
  const rows = router.slice(router.indexOf('function paletteRowsSection('), router.indexOf('/** Text mit markierten Fundstellen'));
  assert.match(rows, /btn\.className = 'search-result'/, 'dieselbe Zeile wie ein Treffer - die Combobox zaehlt .search-result');
});

// R19: der Dialog hinter `?` und „Tastenkombinationen" hiess „Hilfe" und
// zeigte am Desktop nur Kuerzel. Er heisst jetzt, was er zeigt - am Finger
// (Klartext-Hilfe ohne Kuerzel) bleibt es „Hilfe".
test('R19: der Kuerzel-Dialog heisst "Tastenkombinationen", die Klartext-Hilfe "Hilfe"', () => {
  const help = router.slice(router.indexOf('function showHelpModal('), router.indexOf('// Update-Hinweis (#490)'));
  assert.match(help, /const helpTitle = coarsePointer \? t\('help\.title'\) : t\('shortcuts\.help'\);/);
  assert.match(help, /setAttribute\('aria-label', helpTitle\)/, 'der Name des Dialogs');
  assert.match(help, /modal-panel__title">\$\{esc\(helpTitle\)\}/, 'die sichtbare Ueberschrift');
  assert.doesNotMatch(help, /t\('help\.title'\)\)/, 'kein fester Titel "Hilfe" mehr im Kopf');
  assert.equal(de.shortcuts.help, 'Tastenkombinationen');
});
