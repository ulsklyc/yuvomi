/**
 * Tests: EIN Leerzustand fuer „Suche ohne Treffer" (Critique R19, 2026-10-16)
 *
 * Die Critique fand ihn in drei Dialekten: „Keine Treffer" ohne Ausweg
 * (Aufgaben-Liste), „Nichts gefunden" mit dem Begriff in Anfuehrungszeichen
 * und „zuruecksetzen" (Vorrat, Inventar, Rezepte), „Suche leeren" mit dem
 * Begriff im Satz (Aufgaben-Brett, Dokumente). Jetzt baut ihn
 * `searchEmptyOptions` (utils/empty-state.js): Titel „Keine Treffer", ein
 * Satz, Begriff und Filter als Chips, EIN Knopf „Suche zuruecksetzen".
 *
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-search-empty.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniDom, MiniElement } from './mini-dom.js';

installMiniDom();
const { searchEmptyOptions, searchEmptyHTML, mountSearchEmpty } = await import('../public/utils/empty-state.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('der Baustein: Titel, Satz, Begriff als Chip, EINE Aktion "Suche zuruecksetzen"', () => {
  const opts = searchEmptyOptions({ query: '  Milch ', onReset: () => {} });
  assert.equal(opts.variant, 'no-results', 'angesagt als Status (role="status")');
  assert.equal(opts.title, 'common.searchNoResultsTitle');
  assert.equal(opts.description, 'common.searchNoResultsDescription');
  assert.deepEqual(opts.terms, [{ text: 'Milch', icon: 'search' }], 'der Begriff getrimmt, als Chip');
  assert.equal(opts.actions.length, 1);
  assert.equal(opts.actions[0].label, 'common.searchReset');
  const filtered = searchEmptyOptions({ query: 'x', filters: ['Abgelaufen', '', null] });
  assert.equal(filtered.description, 'common.searchNoResultsFilteredDescription', 'mit Filter nennt der Satz die Filter mit');
  assert.deepEqual(filtered.terms.map((term) => term.text), ['x', 'Abgelaufen'], 'leere Filter fallen weg');
  const extra = searchEmptyOptions({ query: 'x', actions: [{ label: 'Im Archiv suchen' }] });
  assert.deepEqual(extra.actions.map((a) => a.label), ['common.searchReset', 'Im Archiv suchen'], 'Zusatzwege stehen hinter dem Zuruecksetzen');
});

test('gerendert: Chip mit escaptem Begriff, kein Begriff im Satz, ein Knopf', () => {
  const html = searchEmptyHTML({ query: '<b>a&b</b>', resetAttrs: { id: 'reset' } });
  assert.match(html, /role="status"/);
  assert.match(html, /<h2 class="empty-state__title">common\.searchNoResultsTitle<\/h2>/);
  assert.match(html, /<p class="empty-state__terms"><span class="empty-state__term"><i data-lucide="search"[^>]*><\/i><span class="empty-state__term-text">&lt;b&gt;a&amp;b&lt;\/b&gt;<\/span><\/span><\/p>/);
  assert.doesNotMatch(html, /„|&quot;&lt;b/, 'keine Anfuehrungszeichen um den Begriff');
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<button[^>]*id="reset"[^>]*>[\s\S]*common\.searchReset<\/button>/);
  const onReset = () => {};
  assert.equal(searchEmptyOptions({ query: 'q', onReset }).actions[0].onClick, onReset, 'der Knopf ruft onReset');
  const target = new MiniElement('div');
  mountSearchEmpty(target, { query: 'q', onReset });
  assert.match(target.innerHTML, /empty-state__term-text">q</, 'eingehaengt wie gerendert');
});

// Die Module mit Suchfeld bauen ihren Leerzustand ueber den Baustein - keiner
// fuehrt mehr einen eigenen Titel, Satz oder Knopf fuer die leere Suche.
const MODULES = ['tasks', 'pantry', 'recipes', 'documents', 'inventory', 'contacts', 'notes', 'birthdays'];
test('jede Seite mit Suche nimmt den Baustein, kein eigener Dialekt', () => {
  for (const name of MODULES) {
    const page = read(`../public/pages/${name}.js`);
    assert.match(page, /\b(?:searchEmptyHTML|searchEmptyEl|searchEmptyOptions|mountSearchEmpty)\(/, `${name}: baut die leere Suche nicht ueber den Baustein`);
    assert.doesNotMatch(page, /t\('[a-z]+\.(?:noResultsDescription|searchNoResults|emptySearchTitle|emptySearchDescription|resetSearch|noResultsCreatorDescription)'/,
      `${name}: eigener Text fuer die leere Suche`);
    assert.doesNotMatch(page, /variant: 'no-results',\s*(?:icon: '[^']+',\s*)?title: t\('(?:tasks|pantry|recipes|inventory|notes|search)\.no?Results?/,
      `${name}: eigener Titel fuer die leere Suche`);
  }
  const tasks = read('../public/pages/tasks.js');
  assert.equal((tasks.match(/searchEmptyHTML\(/g) || []).length, 2, 'Aufgaben: Liste UND Brett');
  assert.doesNotMatch(tasks, /kanban-reset-search/, 'das Brett hat keinen eigenen Knopf mehr');
});

test('die Chips stehen im globalen Blatt, aus Tokens', () => {
  const css = read('../public/styles/layout.css');
  const term = css.slice(css.indexOf('.empty-state__term {'), css.indexOf('}', css.indexOf('.empty-state__term {')));
  assert.match(term, /background-color:\s*var\(--color-fill-well\)/);
  assert.match(term, /border-radius:\s*var\(--radius-full\)/);
  assert.match(css, /\.empty-state__term-text \{[^}]*text-overflow:\s*ellipsis/, 'ein langer Begriff endet in einer Ellipse');
});
