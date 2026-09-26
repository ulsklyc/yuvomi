/**
 * Modul: Kopfregel mobil - statische Guards (DESIGN.md „Kopfregel mobil")
 * Zweck: Haelt die Shell-Seite der Regel vom 2026-09-26 fest:
 *        (1) die Tab-Kapsel liegt UEBER dem Inhalt, nicht im Flex-Fluss, und
 *            ihre Zone ist ein Summand des Nachlaufs - sonst klebt die letzte
 *            Zeile unter dem Glas;
 *        (2) keine Chipreihe/Filterzeile klebt (sticky/fixed) - fest ueber dem
 *            Port kostete sie dauerhaft 60-65px, die kein Kollaps zurueckholt;
 *        (3) nichts im Inhalt klebt mit `bottom: 0` an der Unterkante - dort
 *            liegt jetzt die Kapsel;
 *        (4) die Suche nimmt mobil ihre Icon-Form auch in einem Wrapper-Slot;
 *        (5) die geteilten Bausteine (Werkzeugmenue, Filterknopf, Chipreihe)
 *            existieren an EINER Stelle und die Rezeptkarte darf auf sie zeigen.
 *        Was je Modul gemessen werden muss (Kopfhoehe, erste Zeile), ist
 *        Browserarbeit und steht in der Rezeptkarte der Umsetzung, nicht hier.
 * Ausfuehren: node --test test/test-mobile-chrome.js
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { eachRule } from './css-rules.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const layoutCss = read('../public/styles/layout.css');
const STYLES = new URL('../public/styles/', import.meta.url);
const sheets = readdirSync(STYLES)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: f, css: readFileSync(new URL(f, STYLES), 'utf8') }));

const rules = (css) => [...eachRule(css)].map((r) => ({ ...r, selector: r.selector.trim() }));
const decl = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};
const topLevel = (css, selector) => rules(css).filter((r) => r.at.length === 0 && r.selector === selector);

test('(1) die Tab-Kapsel liegt ueber dem Inhalt, nicht im Flex-Fluss', () => {
  const nav = topLevel(layoutCss, '.nav-bottom');
  assert.equal(nav.length, 1, 'genau eine Basisregel .nav-bottom in layout.css');
  const body = nav[0].body;
  const position = decl(body, 'position');
  assert.ok(position === 'absolute' || position === 'fixed',
    `.nav-bottom muss aus dem Fluss (absolute an der Shell), ist aber "${position}" - `
    + 'als Flex-Kind nimmt sie dem Scrollport ihre Zone, und unter dem Glas laeuft nie Inhalt');
  assert.equal(decl(body, 'flex-shrink'), null, 'flex-shrink an .nav-bottom verraet ein Flex-Kind');
  assert.equal(decl(body, 'bottom'), '0', 'die Zone sitzt an der Unterkante der Shell');
  assert.equal(decl(body, 'pointer-events'), 'none',
    'die transparente Zone darf Tipps auf den Inhalt darunter nicht schlucken');
  const items = topLevel(layoutCss, '.nav-bottom__items');
  assert.ok(items.some((r) => decl(r.body, 'pointer-events') === 'auto'), 'die Kapsel selbst nimmt Treffer an');
});

test('(1) die Zone der Kapsel ist ein Summand des Nachlaufs, und nur dort, wo sie steht', () => {
  const all = rules(layoutCss);
  const base = all.find((r) => r.at.length === 0 && r.selector === ':root' && decl(r.body, '--nav-tail'));
  assert.equal(base && decl(base.body, '--nav-tail'), '0px', '--nav-tail ist ohne Leiste 0');
  const set = all.filter((r) => decl(r.body, '--nav-tail') === 'var(--nav-bottom-height)');
  assert.equal(set.length, 1, 'genau eine Regel setzt --nav-tail auf die Leistenzone');
  assert.equal(set[0].selector, '.app-shell');
  assert.ok(set[0].at.some((a) => /max-width:\s*1023px/.test(a)),
    '--nav-tail gilt nur, wo die Leiste steht (< 1024px); am Desktop regiert die Sidebar');
  assert.ok(all.some((r) => /\[data-wall-mode\]/.test(r.selector) && decl(r.body, '--nav-tail') === '0px'),
    'im Wand-Modus ist die Leiste ausgeblendet, ihr Nachlauf muss mit');
  const sum = all.find((r) => r.at.length === 0 && r.selector === '.app-content' && decl(r.body, '--shell-tail'));
  assert.ok(sum, '--shell-tail an .app-content');
  assert.match(decl(sum.body, '--shell-tail'), /var\(--nav-tail\)/,
    'ohne --nav-tail im Nachlauf endet jede Seite UNTER der Kapsel');
});

test('(1) Fokus und scrollIntoView landen nicht unter der Kapsel', () => {
  const tail = rules(layoutCss).find((r) => /\.page-scrollport:not\(:has\(\.page-scrollport\)\)/.test(r.selector)
    && decl(r.body, 'padding-block-end'));
  assert.ok(tail, 'die Nachlauf-Regel am Scrollport fehlt');
  assert.equal(decl(tail.body, 'scroll-padding-block-end'), 'var(--nav-tail)');
});

const CHIP_ROW = /\.(?:[\w-]*[-_])?(?:chips?|filters?)(?:[-_](?:row|bar|strip|track|rail|list|group|scroll))?(?![\w-])/;
const MODALISH = /modal|sheet|popover|dialog|datepicker|ydp-/;

/** Das letzte Compound eines Selektors - das Element, das die Regel stylt. */
function subjects(selector) {
  return selector.split(',').map((s) => s.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '');
}

test('(2) keine Chipreihe und keine Filterzeile klebt ueber dem Port', () => {
  const offenders = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css)) {
      const pos = decl(r.body, 'position');
      if (pos !== 'sticky' && pos !== 'fixed') continue;
      for (const subject of subjects(r.selector)) {
        if (CHIP_ROW.test(subject) && !MODALISH.test(r.selector)) offenders.push(`${file}: ${r.selector} { position: ${pos} }`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'Filter-Chips gehoeren IN den Scrollport (`.page-chip-row`, scrollt weg) oder hinter „Filter (n)" '
    + '(utils/filter-sheet.js) - nie als feste Zeile ueber dem Inhalt');
});

test('(2) der Chipreihen-Baustein selbst ist kein fester Streifen', () => {
  const row = topLevel(layoutCss, '.page-chip-row');
  assert.equal(row.length, 1, '.page-chip-row steht einmal in layout.css (global), nicht im Modul');
  assert.equal(decl(row[0].body, 'position'), null);
  assert.equal(decl(row[0].body, 'overflow-x'), 'auto', 'die Reihe scrollt waagerecht selbst');
  // Im Grid-Port (`.list-scroller`) ist der Mindestbeitrag eines waagerechten
  // Scroll-Containers NULL: ohne feste Hoehe stand die Reihe 16px hoch, die
  // Chips ragten in die erste Gruppe (Vorrat). Die Hoehe gehoert dem Baustein,
  // nicht jedem Modul einzeln.
  assert.match(decl(row[0].body, 'min-height') || '', /var\(--target-lg\)/,
    '.page-chip-row braucht eine Mindesthoehe aus der Chiphoehe - sonst kollabiert sie im Grid-Port');
  assert.equal(decl(row[0].body, 'flex-shrink'), '0', 'in einem Flex-Port darf die Reihe nicht schrumpfen');
  const moduleCopies = sheets.filter((s) => s.file !== 'layout.css').flatMap(({ file, css }) => rules(css)
    .filter((r) => /pantry-filters|notes-filters|contacts-filters/.test(r.selector) && decl(r.body, 'min-height'))
    .map((r) => `${file}: ${r.selector}`));
  assert.deepEqual(moduleCopies, [], 'die Chipreihen der Module tragen keine eigene Kopie der Mindesthoehe');
});

test('(1) kein Modul rechnet die Kapselzone ein zweites Mal in sein Bodenpolster', () => {
  // Die Zone traegt der Shell-Nachlauf (`--nav-tail` in `--shell-tail`). Ein Modul, das
  // `--nav-bottom-height` zusaetzlich in padding/margin unten rechnet, laesst am Listenende
  // eine zweite, leere Kapselhoehe stehen (Schichtplan, Geburtstage, Gesundheit, Dokumente).
  const SHELL = new Set(['layout.css', 'glass.css', 'tokens.css']);
  const offenders = [];
  for (const { file, css } of sheets) {
    if (SHELL.has(file)) continue;
    for (const r of rules(css)) {
      for (const prop of ['padding-bottom', 'padding-block-end', 'margin-bottom', 'margin-block-end']) {
        const v = decl(r.body, prop);
        if (v && v.includes('--nav-bottom-height')) offenders.push(`${file}: ${r.selector} { ${prop}: ${v} }`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'die Kapselzone steht schon im Shell-Nachlauf - ein Modul polstert nur sein eigenes Ende (z.B. var(--space-6))');
});

test('(3) nichts im Inhalt klebt mit bottom: 0 an der Unterkante - dort liegt die Kapsel', () => {
  const offenders = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css)) {
      if (decl(r.body, 'position') !== 'sticky') continue;
      if (MODALISH.test(r.selector)) continue;
      const bottom = decl(r.body, 'bottom');
      if (bottom !== null && /^0(px)?$/.test(bottom)) offenders.push(`${file}: ${r.selector}`);
    }
  }
  assert.deepEqual(offenders, [],
    'eine klebende Fusszeile im Inhalt nimmt `bottom: var(--nav-tail)` - mit 0 klebt sie hinter dem Glas');
});

test('(4) die Suche nimmt mobil ihre Icon-Form auch in einem Wrapper-Slot', () => {
  const iconForm = rules(layoutCss).filter((r) => /\.page-search:not\(:focus-within\):not\(:has\(input:not\(:placeholder-shown\)\)\)$/.test(r.selector)
    && decl(r.body, 'width') === 'var(--target-base)');
  assert.equal(iconForm.length, 1, 'genau eine Icon-Form-Regel');
  const [rule] = iconForm;
  assert.doesNotMatch(rule.selector, /\.page-toolbar\s*>\s*\.page-search/,
    'mit `>` griff die Icon-Form nur fuer direkte Kinder - im Inventar-Wrapper blieb ein 248px-Feld (A6 P1-1)');
  assert.match(rule.selector, /\.page-toolbar\s+\.page-search/);
  assert.ok(rule.at.some((a) => /max-width:\s*767px/.test(a)),
    'die Kopfregel gilt unter --bp-tablet (768), nicht erst unter 640');
  const wrapper = rules(layoutCss).filter((r) => r.selector.includes(':has(> .page-search:only-child')
    && decl(r.body, 'flex') === '0 0 auto');
  assert.equal(wrapper.length, 1, 'ein Slot, der nur die Suche traegt, schrumpft mit ihr');
  // `:has()` in `:has()` ist ungueltig und verwirft die GANZE Regel lautlos -
  // die erste Fassung dieser Regel stand so da und wirkte nie.
  const inner = wrapper[0].selector.slice(wrapper[0].selector.indexOf(':has(') + 5);
  assert.doesNotMatch(inner, /:has\(/, 'kein :has() innerhalb von :has()');
});

test('(5) die geteilten Bausteine existieren an einer Stelle', async () => {
  const menu = read('../public/utils/popover-menu.js');
  assert.match(menu, /export function pageToolsMenuHtml\(/);
  assert.match(menu, /btn btn--secondary btn--icon page-tools-btn/,
    'der Werkzeugknopf traegt die Form des Dokumente-Vorbilds und seine Kennklasse');
  const sheet = read('../public/utils/filter-sheet.js');
  for (const name of ['filterButtonHtml', 'syncFilterButton', 'openFilterSheet', 'defaultFilterLabels']) {
    assert.match(sheet, new RegExp(`export function ${name}\\(`), `${name} fehlt in utils/filter-sheet.js`);
  }
  for (const cls of ['.page-filter-btn', '.page-filter-btn__count', '.filter-sheet__heading', '.page-chip-row']) {
    assert.equal(topLevel(layoutCss, cls).length >= 1, true, `${cls} gehoert in layout.css (global geladen)`);
  }
});
