/**
 * Tests: Help overlay row builder (public/utils/help.js)
 * Fokus: Desktop liefert Tastenkürzel-Zeilen, Touch/Mobile liefert
 *        Klartext-Zeilen mit Icons. Pure Funktion, kein DOM.
 * Ausführen: node test/test-help.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildHelpRows } = await import('../public/utils/help.js');

// Minimaler t-Stub: gibt den Key zurück (Vollständigkeit über Key-Präsenz prüfbar)
const t = (key) => key;
const shortcuts = [
  { key: '/', description: () => 'shortcuts.search' },
  { key: '?', description: () => 'shortcuts.help' },
];

test('Desktop (coarsePointer:false) liefert Tastenkürzel-Zeilen', () => {
  const rows = buildHelpRows({ coarsePointer: false, shortcuts, t });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { key: '/', desc: 'shortcuts.search' });
  assert.equal(rows[1].key, '?');
  assert.ok(rows.every((r) => 'key' in r && !('icon' in r)));
});

test('Touch (coarsePointer:true) liefert Klartext-Zeilen mit Icons', () => {
  const rows = buildHelpRows({ coarsePointer: true, shortcuts, t });
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((r) => 'icon' in r && 'desc' in r && !('key' in r)));
  // Die Mobile-Zeilen ziehen ihre Texte aus help.*-Keys
  assert.deepEqual(
    rows.map((r) => r.desc),
    ['help.mobileNavigate', 'help.mobileCreate', 'help.mobileSearch', 'nav.moreCatalogHint', 'help.mobileSettings']
  );
});

test('Touch-Zeilen verwenden vorhandene Lucide-Iconnamen', () => {
  const rows = buildHelpRows({ coarsePointer: true, shortcuts, t });
  assert.deepEqual(
    rows.map((r) => r.icon),
    ['navigation', 'plus-circle', 'search', 'layout-grid', 'settings']
  );
});

test('Desktop: eine Zweitbelegung erscheint im Label, ohne Label die Taste selbst', () => {
  const rows = buildHelpRows({
    coarsePointer: false,
    shortcuts: [
      { key: 'k', label: () => 'k / \u2190', description: () => 'shortcuts.calPrev' },
      { key: 't', description: () => 'shortcuts.calToday' },
    ],
    t,
  });
  assert.deepEqual(rows, [
    { key: 'k / \u2190', desc: 'shortcuts.calPrev' },
    { key: 't', desc: 'shortcuts.calToday' },
  ]);
});

// Critique R21 (Persona Alex): `g s` und `g k s` fuehrten beide in den Einkauf
// und standen als zwei Zeilen in der Hilfe. Ein Navigationsziel, eine Zeile -
// gelesen aus der echten Tabelle in router.js.
test('Hilfe: jedes Navigationsziel steht in genau einer Zeile', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const table = src.slice(src.indexOf('const SHORTCUTS = ['), src.indexOf('];', src.indexOf('const SHORTCUTS = [')));
  const seen = new Map();
  const doppelt = [];
  for (const line of table.split('\n')) {
    const m = line.match(/\{ key: '([^']+)'(.*)action: \(\) => navigate\('([^']+)'\)/);
    if (!m || /hidden: true/.test(m[2])) continue;
    if (seen.has(m[3])) doppelt.push(`${m[3]}: ${seen.get(m[3])} und ${m[1]}`);
    seen.set(m[3], m[1]);
  }
  assert.ok(seen.size >= 10, `nur ${seen.size} Ziele gelesen - der Leser ist blind`);
  assert.deepEqual(doppelt, []);
  // und das verborgene Kuerzel faellt wirklich aus der Hilfe
  const rows = buildHelpRows({ coarsePointer: false, t, shortcuts: [
    { key: 'g s', hidden: true, description: () => 'a' },
    { key: 'g k s', label: () => 'g s / g k s', description: () => 'b' },
  ] });
  assert.deepEqual(rows, [{ key: 'g s / g k s', desc: 'b' }]);
});

// Critique R21 (Persona Alex): die Palette ist eine Combobox, aber nichts nannte
// ihre Tasten. Eine Fusszeile mit Pfeilen, Enter und Esc - nur mit feinem Zeiger.
test('Palette: die Fusszeile nennt die Tasten, nur mit feinem Zeiger', async () => {
  const { readFileSync } = await import('node:fs');
  const { eachRule } = await import('./css-rules.js');
  const src = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(src, /searchHints\.className = 'search-overlay__hints';/);
  assert.match(src, /\[\['\\u2191', '\\u2193'\], t\('search\.hintMove'\)\], \[\['\\u21b5'\], t\('search\.hintOpen'\)\], \[\['Esc'\], t\('common\.close'\)\]/);
  assert.match(src, /searchPanel\.appendChild\(searchHints\);/);
  const css = readFileSync(new URL('../public/styles/layout.css', import.meta.url), 'utf8');
  const rules = [...eachRule(css)].filter((r) => r.selector.trim() === '.search-overlay__hints');
  assert.ok(rules.some((r) => !r.at.length && /display:\s*none/.test(r.body)), 'ohne Abfrage ausgeblendet');
  assert.ok(rules.some((r) => r.at.some((a) => /\(hover: hover\) and \(pointer: fine\)/.test(a)) && /display:\s*flex/.test(r.body)), 'mit feinem Zeiger sichtbar');
});
