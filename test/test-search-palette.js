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

test('der Hinweis verspricht, was die Palette haelt', () => {
  const hint = de.search.emptyHint;
  assert.doesNotMatch(hint, /alle Bereiche/, 'die Palette durchsucht Eintraege, sie findet Bereiche - "alle Bereiche durchsuchen" war falsch');
  assert.equal(typeof de.search.goTo, 'string');
  assert.equal(typeof de.search.newSection, 'string');
});
