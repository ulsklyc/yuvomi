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

test('(1) die Kapselzone rechnet mit der GEMESSENEN Kapselhoehe (Review zu #1475)', () => {
  // `.nav-bottom__items` hat `min-height`, keine feste Hoehe: umbrechende Labels
  // (lange Sprachen, 320px) lassen sie ueber --nav-height-mobile wachsen. Rechnet
  // die Zone fest mit dem Token, ist die Kapsel hoeher als ihr Nachlauf, und die
  // letzte Zeile liegt teilweise unter dem Glas.
  const tokens = read('../public/styles/tokens.css');
  const zone = tokens.match(/--nav-bottom-height:\s*([^;]+);/);
  assert.ok(zone, '--nav-bottom-height fehlt in tokens.css');
  assert.match(zone[1], /var\(--nav-capsule-height,\s*var\(--nav-height-mobile\)\)/,
    'die Zone liest die gemessene Kapselhoehe, mit der Token-Hoehe als Rueckfall');
  const router = read('../public/router.js');
  const body = router.slice(router.indexOf('function observeNavCapsule('));
  assert.match(body.slice(0, body.indexOf('\n}\n')), /watchNavCapsuleHeight\(items\)/,
    'die Shell misst die Kapsel dort, wo sie sie schon fuer den Indikator beobachtet');
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

test('(3) unter der Kapsel liegt keine feste Flaeche im Home-Indicator-Bereich', () => {
  // Die Zone unter der Kapsel gehoert dem Inhalt, bis zum Displayrand. In pwa.css
  // stand fuer installierte Apps ein `body::after` (fixed, bottom: 0, Hoehe der
  // unteren Safe-Area, Surface-Grund), gebaut als Fortsetzung einer deckenden
  // Tab-Leiste. Seit der Inhalt unter der Kapsel laeuft (#1475), schnitt es ihn
  // 34px ueber dem Rand ab: auf dem iPhone ein dunkler Streifen unter der
  // Navigation, und Tipps in dem Streifen gingen an body statt an die Zeile.
  const offenders = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css)) {
      if (decl(r.body, 'position') !== 'fixed') continue;
      const bottom = decl(r.body, 'bottom');
      if (bottom === null || !/^0(px)?$/.test(bottom)) continue;
      const height = decl(r.body, 'height') ?? '';
      if (/safe-area-inset-bottom/.test(height)) offenders.push(`${file}: ${r.selector}`);
    }
  }
  assert.deepEqual(offenders, [],
    'die untere Safe-Area traegt die Kapselzone als padding (.nav-bottom), keine eigene Flaeche am Rand');
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
  // D1 (Critique 2026-10-16): die Lupe traegt die EINE Haut der Kopf-Icon-
  // Knoepfe - den Ring von `.btn--secondary` (1.5px --color-border), rund -,
  // statt nackt neben beringtem Filter und „..." zu stehen.
  assert.match(decl(rule.body, 'border') ?? '', /^1\.5px solid var\(--color-border\)$/, 'Ring der Kopf-Icon-Haut an der Huelle');
  assert.equal(decl(rule.body, 'border-radius'), 'var(--radius-full)', 'rund wie die Icon-Knoepfe daneben');
  const glyph = rules(layoutCss).find((r) => /\.page-toolbar\s+\.page-search(?::not\(\.page-search--field\))?:not\(:focus-within\)[^,]*\.page-search__icon/.test(r.selector));
  assert.equal(glyph && decl(glyph.body, 'color'), 'var(--color-accent)', 'das Zeichen in der Tinte von btn--secondary');
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

// E13 (Critique R17): am Desktop haengen die Filter als Popover am Knopf. Die
// Form steht global (layout.css) wie das Blatt - und sie hat weder Overlay
// noch Unschaerfe: das ist ihr Sinn, die Liste dahinter filtert live.
test('E13: das Filter-Popover hat kein Overlay und keine Unschaerfe, aber Ein- und Ausgang', () => {
  const pop = rules(layoutCss).filter((r) => /^\.filter-popover\b/.test(r.selector));
  assert.ok(topLevel(layoutCss, '.filter-popover').length >= 1, '.filter-popover gehoert in layout.css (global geladen)');
  const backdrop = pop.find((r) => r.selector === '.filter-popover::backdrop');
  assert.ok(backdrop && /background:\s*transparent/.test(backdrop.body), 'kein Abdunkeln hinter dem Popover');
  for (const r of pop) assert.doesNotMatch(r.body, /backdrop-filter/, `${r.selector}: keine Unschaerfe`);
  const base = topLevel(layoutCss, '.filter-popover')[0];
  assert.match(base.body, /position:\s*fixed/);
  assert.match(base.body, /inline-size:\s*min\(var\(--layout-rail-min\)/, 'Breite aus tokens.css');
  assert.match(base.body, /overlay var\(--duration-xs\) allow-discrete/, 'der Ausgang laeuft, bevor es den Top-Layer verlaesst');
  const open = topLevel(layoutCss, '.filter-popover:popover-open').find((r) => /transition/.test(r.body));
  assert.ok(open && /var\(--duration-md\)/.test(open.body), 'Eingang in --duration-md wie das Popover-Menue');
  assert.match(layoutCss, /@starting-style\s*\{\s*\.filter-popover:popover-open\s*\{[^}]*transform:\s*scale\(0\.96\)/,
    'Eingang aus dem verkleinerten Zustand');
  const sheet = read('../public/utils/filter-sheet.js');
  assert.match(sheet, /export function filtersAsPopover\(/);
  assert.match(sheet, /setAttribute\('popover', 'auto'\)/, 'Esc und Tipp daneben schliessen (Browser)');
  // Das Popover haengt an document.body und ueberlebt den Seitentausch: ein
  // Wechsel ohne Zeigerereignis (Zurueck des Browsers) liess es ueber der
  // Zielseite stehen. Der Router raeumt es im synchronen Teil des Wechsels ab.
  assert.match(sheet, /export function dismissFilterPopovers\(\)\s*\{[\s\S]*?getElementById\(id\)\?\.remove\(\)/);
  const router = read('../public/router.js').replace(/\/\/.*$/gm, '');
  const swap = router.slice(router.indexOf('const swap = () => {'), router.indexOf('style.cleanup();'));
  assert.match(swap, /dismissFilterPopovers\(\);/, 'der Seitenwechsel raeumt offene Filter-Popover ab');
});

// R14 P12 (Re-Critique 2026-09-28, A1 P3-2): im Desktop-Kopf standen zwei
// Hoehen - Suche und "..." 44px, Segment, Filter und angedockte Pille 40px,
// gemessen in 12 Modulen bei 1440. Am Zeiger ist 40px die Regel (ignore.md,
// Hit-Test); die zwei Ausreisser folgen ihr jetzt im Kopf.
test('R14: der Desktop-Kopf hat EINE Steuerhoehe', () => {
  const desk = [...eachRule(layoutCss)].filter((r) => r.at.some((a) => /\(min-width:\s*1024px\)/.test(a)));
  const body = (sel) => desk.filter((r) => r.selector.split(',').some((s) => s.trim() === sel)).map((r) => r.body).join(';');
  for (const sel of ['.page-toolbar .btn--icon', '.page-toolbar .page-search__input']) {
    assert.match(body(sel), /min-height:\s*var\(--target-md\)/, `${sel}: dieselbe Hoehe wie .btn am Desktop`);
  }
  assert.match(body('.page-toolbar .btn--icon'), /min-width:\s*var\(--target-md\)/, 'das Werkzeugmenue bleibt quadratisch');
});

// R17 Z1 (Re-Critique 2026-09-28, A1 P2-3): die benannte Variante „Zeitraum-Kopf"
// (DESIGN.md, Kopfregel mobil). Ein Modul, dessen Titel ein navigierbarer
// Zeitraum ist, darf seine Werkzeuge in Zeile 1 neben den Titel stellen - der
// Kalender tut das, indem er seine Bar-Zeile mobil aufloest (`display:
// contents`), und die Werkzeuge ruecken ans Ende der Titelzeile. Das ist die
// EINE Stelle, an der die Regel „Zeile 1 traegt allein den Titel" bricht; sie
// gilt nur, wo der Kopf die Variante im Markup traegt, und das Markup nur dort,
// wo DESIGN.md sie nennt. Regel statt Schreibweise: gesucht wird jede Regel,
// die eine Bar- oder Werkzeugzeile eines Kopfs aufloest, egal wie sie heisst.
const PERIOD_TITLE = 'page-toolbar--period-title';
const PERIOD_TITLE_MODULES = ['pages/calendar.js'];

test('R17 Z1: nur der markierte Zeitraum-Kopf loest seine Bar-Zeile in die Titelzeile auf', () => {
  const dissolving = [];
  for (const { file, css } of sheets) {
    for (const r of rules(css)) {
      if (decl(r.body, 'display') !== 'contents') continue;
      for (const part of r.selector.split(',').map((s) => s.trim())) {
        // Die Bar-Zeile (`*__bar`) oder ihre Werkzeuggruppe (`*__tools`) eines Kopfs.
        if (!/(?:toolbar|head|header)[\w-]*__(?:bar|tools)\b/.test(part)) continue;
        dissolving.push({ file, part });
      }
    }
  }
  assert.ok(dissolving.length >= 1, 'der Kalender loest seine Bar-Zeile mobil auf - findet der Guard ihn nicht, ist er blind');
  const unmarked = dissolving.filter((d) => !d.part.includes(`.${PERIOD_TITLE}`));
  assert.deepEqual(unmarked, [],
    `Werkzeuge in Zeile 1 nur im markierten Zeitraum-Kopf (.${PERIOD_TITLE}, DESIGN.md „Variante: Zeitraum-Kopf")`);
});

// R17 Schritt 5 (Critique 2026-10-07, A1 P1): der Kalenderkopf mass mobil
// eingeklappt dieselben 117px wie ausgeklappt - Titel und Siegel gingen, die
// Zeile blieb. Eingeklappt steht der Stepper jetzt in Zeile 1 vor dem Menue;
// Suche, Filter und "Heute" falten ins Menue (gemessen 390x844: 117 -> 65px).
test('R17: der Kalenderkopf ist eingeklappt EINE Zeile, und was weicht, kommt im Menue wieder', () => {
  const calendarCss = read('../public/styles/calendar.css');
  const collapsed = rules(calendarCss).filter((r) => /\.cal-toolbar\.page-toolbar--capped\.is-collapsed/.test(r.selector));
  assert.ok(collapsed.length >= 2, 'calendar.css traegt die Regeln fuer den eingeklappten Kopf');
  for (const r of collapsed) {
    assert.ok(r.at.some((a) => /max-width:\s*639px/.test(a)),
      `"${r.selector}" gilt nur, wo das Ansichtsmenue steht (unter 640px) - darueber gibt es kein Menue, in das gefaltet wird`);
    assert.match(r.selector, /\.page-toolbar--period-title/, 'nur im markierten Zeitraum-Kopf');
  }
  const center = collapsed.find((r) => /> \.page-toolbar__center$/.test(r.selector));
  assert.equal(center && decl(center.body, 'order'), '0', 'der Zeitraum rueckt in Zeile 1, vor die Werkzeuge');
  assert.match(center.body, /flex:\s*1 1 0/, 'und nimmt den Rest der Zeile statt einer eigenen');
  const hidden = collapsed.find((r) => decl(r.body, 'display') === 'none');
  assert.ok(hidden, 'die gefalteten Werkzeuge blenden eingeklappt aus');
  for (const part of hidden.selector.split(',')) {
    assert.match(part, /\[data-collapse-fold\]/, `"${part.trim()}" blendet nur aus, was als faltbar markiert ist`);
  }
  assert.match(hidden.selector, /\.cal-toolbar__filter-btn\[data-collapse-fold\]:not\(\.page-filter-btn--active\)/,
    'ein aktiver Filter bleibt mit seiner Zahl stehen (Kopfregel 3)');

  const calendarJs = read('../public/pages/calendar.js');
  assert.match(calendarJs, /id="cal-views-menu"[^>]*data-collapse-fold-menu/, 'das Ansichtsmenue nimmt die gefalteten Werkzeuge auf');
  // D1: die Suche ist ein Feld, kein Knopf - ein Stellvertreter im Menue koennte es nicht
  // oeffnen. Sie faltet deshalb nicht, sie bleibt als Lupe stehen.
  assert.doesNotMatch(calendarJs, /id="cal-search"/, 'kein Suchknopf mehr, der falten koennte');
  assert.match(calendarJs, /id: 'cal-search-input'/, 'die Suche ist das Feld der Shell');
  assert.match(calendarJs, /'#cal-filters'\)\.setAttribute\('data-collapse-fold'/, 'der Filter ist markiert');
  assert.match(calendarJs, /id: 'cal-today'[\s\S]{0,200}'data-collapse-fold': true/, '"Heute" ist markiert');

  const ux = read('../public/utils/ux.js');
  const branch = ux.match(/const foldMenu = capped \?[\s\S]*?\n    \}\n/)?.[0] ?? '';
  assert.match(branch, /\[data-collapse-fold-menu\]\[popovertarget\]/, 'der Kopf findet das markierte Menue');
  assert.match(branch, /classList\.contains\('is-collapsed'\)/, 'Stellvertreter nur eingeklappt');
  assert.match(branch, /getClientRects\(\)\.length === 0/,
    'und nur fuer das, was gerade nicht zu sehen ist - sonst stuende dieselbe Handlung zweimal da');
  assert.match(ux, /btn\.disabled \|\| btn\.inert/, 'ein inerter Reset ("Heute" im laufenden Zeitraum) ist kein Eintrag');
  assert.match(ux, /reserve \+ shorter/, 'die Reserve-Regel rechnet mit der AUSGEKLAPPTEN Hoehe, sonst pendelt eine knappe Liste');
});

test('R17 Z1: die Variante steht nur im Markup der Module, die DESIGN.md nennt', () => {
  const pub = new URL('../public/', import.meta.url);
  const carriers = [];
  for (const dir of ['pages', 'utils', 'components']) {
    for (const f of readdirSync(new URL(`${dir}/`, pub)).filter((n) => n.endsWith('.js'))) {
      if (readFileSync(new URL(`${dir}/${f}`, pub), 'utf8').includes(PERIOD_TITLE)) carriers.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(carriers.sort(), [...PERIOD_TITLE_MODULES].sort(),
    'wer den Zeitraum-Kopf traegt, steht in DESIGN.md und in PERIOD_TITLE_MODULES');
  const design = read('../DESIGN.md');
  assert.match(design, /\*\*Variante: Zeitraum-Kopf \(Kalender\)\.\*\*/, 'DESIGN.md benennt die Variante');
  assert.ok(design.includes(PERIOD_TITLE), 'und nennt ihre Kennklasse');
});

// R16 (Critique 2026-10-05, P1 mobil): „Werkzeuge in der Titelzeile" (DESIGN.md,
// Kopfregel mobil 1a). Traegt die Werkzeugzeile eines Kopfs hoechstens zwei
// Icon-Knoepfe und weder Segment noch Stepper noch Tab-Leiste, stehen sie am
// Ende der Titelzeile; die zweite Zeile entfaellt (114 -> 65px). Wie beim
// Zeitraum-Kopf ist die Variante MARKIERT: die Klasse steht nur in den Modulen,
// die DESIGN.md nennt, sie wirkt nur unter 768px, und kein Traeger fuehrt eine
// Bar-Zeile - mit Tab-Leiste daneben waere es wieder die R9-Verdichtung, die
// R14 zurueckgenommen hat. Wie viele Knoepfe ein Kopf zur Laufzeit zeigt, ist
// Messarbeit (Handoff/Messmatrix), nicht dieser Guard.
const TITLE_TOOLS = 'page-toolbar--title-tools';
const TITLE_TOOLS_MODULES = [
  'pages/birthdays.js', 'pages/contacts.js', 'pages/documents.js', 'pages/health.js', 'pages/inventory.js', 'pages/notes.js', 'pages/tasks.js', 'pages/waste.js', 'settings/shell.js',
];

test('R16: Werkzeuge in der Titelzeile - nur markiert, nur mobil, nie neben einer Bar-Zeile', () => {
  const pub = new URL('../public/', import.meta.url);
  const carriers = [];
  for (const dir of ['pages', 'utils', 'components', 'settings']) {
    for (const f of readdirSync(new URL(`${dir}/`, pub)).filter((n) => n.endsWith('.js'))) {
      if (`${dir}/${f}` === 'utils/page-layout.js') continue;
      const src = readFileSync(new URL(`${dir}/${f}`, pub), 'utf8');
      if (!src.includes(TITLE_TOOLS) && !/\btitleTools:\s*true\b/.test(src)) continue;
      carriers.push(`${dir}/${f}`);
      assert.doesNotMatch(src, /page-toolbar__bar|\bbar:\s/,
        `${dir}/${f}: ein Kopf mit Bar-Zeile (Tab-Leiste, Segment) traegt seine Werkzeuge dort, nicht in der Titelzeile`);
    }
  }
  assert.deepEqual(carriers.sort(), [...TITLE_TOOLS_MODULES].sort(),
    'wer die Werkzeuge in die Titelzeile stellt, steht in DESIGN.md und in TITLE_TOOLS_MODULES');
  assert.match(read('../public/utils/page-layout.js'), /titleTools && 'page-toolbar--title-tools'/,
    'renderPageHeader reicht die Variante als Option durch');

  const own = sheets.flatMap(({ file, css }) => rules(css).filter((r) => r.selector.includes(`.${TITLE_TOOLS}`))
    .map((r) => ({ file, ...r })));
  assert.ok(own.length >= 1, 'die Regel fehlt in layout.css');
  for (const r of own) {
    assert.equal(r.file, 'layout.css', `${r.file}: die Variante gehoert der Shell (${r.selector})`);
    // Bis 1023px (R19): auch das Tablet (834px) traegt die Werkzeuge in der
    // Titelzeile - vorher 118px Kopf in zwei Zeilen, jetzt 69px. Ab 1024px hat
    // die Titelzeile Feld und angedockte Pille.
    assert.ok(r.at.some((a) => /max-width:\s*1023px/.test(a)),
      `${r.selector}: nur unter 1024px - ab dort hat die Titelzeile Feld und angedockte Pille`);
  }
  const title = own.find((r) => r.selector.endsWith(':not(.page-toolbar--in-group) > .page-toolbar__title')
    && /flex:\s*1 1 0/.test(r.body));
  assert.ok(title, 'der Titel gibt nach (Basis 0) - die Knoepfe haben kein Label zum Anschneiden');
  assert.match(title.body, /white-space:\s*nowrap/, 'ein langer Titel kuerzt, er bricht nicht um (Kopfhoehe je Sprache gleich)');
  assert.match(title.body, /text-overflow:\s*ellipsis/);
  // Re-Kritik 2026-10-17: auf dem Tablet stand "Aufgab..." (150 > 141px)
  // neben einem 386px-Suchfeld. Ab 768px nimmt der Titel seine Breite (bis zur
  // halben Zeile), die Suche gibt nach.
  const tablet = own.find((r) => r.selector.endsWith(':not(.page-toolbar--in-group) > .page-toolbar__title')
    && r.at.some((a) => /min-width:\s*768px/.test(a) && /max-width:\s*1023px/.test(a)));
  assert.match(tablet?.body ?? '', /flex:\s*0 0 auto/, 'Tablet: der Titel gibt nicht nach');
  assert.match(tablet?.body ?? '', /max-inline-size:\s*50%/, 'Tablet: ein sehr langer Titel kuerzt weiter, ab der halben Zeile');
  assert.ok(!tablet?.at.some((a) => /max-width:\s*767px/.test(a)), 'das Telefon behaelt Basis 0');

  const design = read('../DESIGN.md');
  assert.match(design, /\*\*1a\. Werkzeuge in der Titelzeile\.\*\*/, 'DESIGN.md benennt die Regel');
  assert.ok(design.includes(TITLE_TOOLS), 'und nennt ihre Kennklasse');
});

// R16 (Critique 2026-10-05, P1 mobil): KENNZAHLEN ALS KURZZEILE. Inventar trug
// 136px Kacheln vor der Liste (eine fuer „0"), die Haushaltshilfe ein 2x2-
// Raster vor den Besuchen. Beide nutzen mobil die Kurzzeile des Budgets
// (utils/metric-glance.js). Die steht dafuer in panel.css: budget.css laedt
// nur im Budget, und die Zeile waere in jedem anderen Modul unsichtbar
// (`display: none` als Basis) oder ungestylt gewesen.
test('R16: die Kennzahl-Kurzzeile ist ein geteilter Baustein, und Inventar und Haushaltshilfe nutzen ihn', () => {
  const panel = rules(read('../public/styles/panel.css'));
  const phone = (r) => r.at.some((a) => /max-width:\s*639px/.test(a));
  assert.ok(panel.some((r) => r.at.length === 0 && r.selector === '.budget-glance' && decl(r.body, 'display') === 'none'),
    'ab 640px gibt es den Traeger nicht');
  assert.ok(panel.some((r) => phone(r) && r.selector === '.budget-glance' && decl(r.body, 'display') === 'block'));
  assert.ok(panel.some((r) => phone(r) && r.selector === '.budget-glance-details:not(.is-expanded)' && decl(r.body, 'display') === 'none'),
    'eingeklappt stehen die Karten nicht');
  assert.ok(panel.some((r) => phone(r) && r.selector === '.budget-glance-details > .metric-card--empty' && decl(r.body, 'display') === 'none'),
    'eine leere Kennzahl entfaellt mobil');
  assert.ok(panel.some((r) => r.selector === '.budget-glance__row'), 'die Zeile selbst steht in panel.css');
  for (const [file, id, controls] of [
    ['../public/pages/inventory.js', 'inventory-glance-more', 'inventory-metrics'],
    ['../public/pages/housekeeping.js', 'housekeeping-glance-more', 'housekeeping-metrics'],
  ]) {
    const src = read(file);
    assert.match(src, /import \{ metricGlanceHtml, wireMetricGlance \} from '\/utils\/metric-glance\.js';/, file);
    assert.match(src, new RegExp(`id: '${id}',\\s*controls: '${controls}'`), `${file}: Zeile und Bereich gehoeren zusammen`);
    assert.match(src, new RegExp(`class="metric-grid[^"]*budget-glance-details[^"]*" id="${controls}"`), `${file}: die Karten sind der aufklappbare Bereich`);
    assert.match(src, new RegExp(`wireMetricGlance\\(\\w+, '${id}'`), `${file}: der Aufklapper ist verdrahtet`);
  }
});

// #1917: DIE SCROLL-KANTE AM KLEBENDEN FUSS DER WAND. Der Fuss klebt seit #1559
// mit deckendem Grund und schnitt "Wer heute dran ist" an einer unsichtbaren
// harten Kante ab (390x844: ein Gesicht ganz, eines halb verdeckt). Der Verlauf
// darueber ist ein Pseudo-Element, statisch und in jedem Browser derselbe; hier
// steht, was an ihm nicht verhandelbar ist. Dass er im gerenderten Dokument
// steht und am Scrollende nichts verdeckt, ist Browserarbeit (gemessen im PR
// zu #1917: am Telefon 48px in Ruhe, 0px verdeckt am Ende; 1280x800 unveraendert).
test('#1917: der Fuss der Wand hat eine Scroll-Kante - kein Tipp, und sein Endabstand ist genau ihre Hoehe', () => {
  const css = read('../public/styles/dashboard.css');
  const all = rules(css);
  const EDGE = '.wall__foot::before';
  const HEIGHT = '--wall-foot-edge';

  const wall = topLevel(css, '.wall');
  assert.equal(wall.length, 1, 'Reichweite: genau eine Basisregel .wall');
  assert.ok(decl(wall[0].body, '--wall-gap'), 'der Abstand der Flaeche ist eine Variable');
  assert.equal(decl(wall[0].body, 'gap'), 'var(--wall-gap)', 'und die Flaeche nimmt ihn als ihren Abstand');

  const foot = topLevel(css, '.wall__foot');
  assert.equal(foot.length, 1, 'Reichweite: genau eine Basisregel .wall__foot');
  assert.equal(decl(foot[0].body, 'position'), 'sticky');
  // Ein deckendes Polster ueber den Knoepfen waere wieder die harte Kante, nur
  // einen Streifen hoeher: der Verlauf endete an ihm statt an den Knoepfen.
  assert.match(decl(foot[0].body, 'padding-block') ?? '', /^0\s/, 'der Fuss hat oben kein deckendes Polster');

  const edges = all.filter((r) => r.selector === EDGE);
  assert.equal(edges.length, 1, `genau eine Regel ${EDGE} - keine zweite Fassung in einem At-Block`);
  assert.deepEqual(edges[0].at, [], 'sie gilt in jedem Browser, nicht hinter @supports');
  const body = edges[0].body;
  assert.equal(decl(body, 'content'), '""', 'ohne `content` gibt es das Pseudo-Element nicht');
  assert.equal(decl(body, 'position'), 'absolute');
  assert.equal(decl(body, 'inset-block-end'), '100%', 'sie liegt UEBER dem Fuss, nicht in ihm');
  assert.equal(decl(body, 'pointer-events'), 'none', 'ein Verlauf ueber dem Inhalt nimmt keinen Tipp');
  for (const prop of ['display', 'visibility', 'opacity', 'animation', 'animation-timeline']) {
    assert.equal(decl(body, prop), null, `${EDGE} setzt ${prop} - die Kante ist da und steht still`);
  }
  const background = decl(body, 'background') ?? '';
  assert.match(background, /^linear-gradient\(to bottom, transparent, var\(--color-bg\)\)$/,
    'vom Inhalt zum Grund der Flaeche, aus dem Token - in beiden Themen und nachts dieselbe Variable');
  assert.equal(decl(foot[0].body, 'background'), 'var(--color-bg)', 'derselbe Grund wie der Fuss, in den sie muendet');

  // HOEHE UND ENDABSTAND LESEN DIESELBE ZAHL. Der Abstand der Flaeche (`gap`)
  // plus der Rand des Fusses ergeben die Hoehe der Kante: am Scrollende steht
  // der letzte Eintrag frei ueber ihr. Ein kleinerer Rand, und sie laege dort
  // auf der letzten Zeile.
  assert.equal(decl(body, 'block-size'), `var(${HEIGHT})`, 'die Hoehe der Kante ist die eine Variable');
  assert.match(decl(foot[0].body, 'margin-block') ?? '', /^calc\(var\(--wall-foot-edge\) - var\(--wall-gap\)\)\s/,
    'der Endabstand vor dem Fuss fuellt den Abstand der Flaeche auf die Hoehe der Kante auf');

  // Gesetzt wird die Zahl nur am Fuss selbst (Kante und Rand lesen sie dort),
  // und nirgends ueberschreibt jemand Rand oder Hoehe an ihr vorbei.
  const setters = all.filter((r) => decl(r.body, HEIGHT) !== null);
  assert.deepEqual([...new Set(setters.map((r) => r.selector))], ['.wall__foot'], `${HEIGHT} wohnt am Fuss`);
  assert.equal(decl(foot[0].body, HEIGHT), 'var(--wall-gap)',
    'auf der Wand ist die Kante der Abstand selbst: Rand 0, die Flaeche wird nicht hoeher (eine Wand scrollt nicht)');
  const raised = setters.filter((r) => r.at.length > 0);
  assert.equal(raised.length, 1, 'genau eine Stelle hebt die Kante');
  assert.deepEqual(raised[0].at, ['@container wall (max-width: 519px)'],
    'nur am Telefon, an derselben Grenze wie Zeilentitel und Zeitspanne - dort scrollt die Flaeche ohnehin');
  assert.match(decl(raised[0].body, HEIGHT), /^var\(--space-\d+\)$/, 'die Hoehe am Telefon ist ein Abstands-Token');
  const token = decl(raised[0].body, HEIGHT).match(/--space-\d+/)[0];
  const px = (name) => parseFloat(read('../public/styles/tokens.css').match(new RegExp(`${name}:\\s*(\\d+)px`))?.[1] ?? 'NaN');
  assert.ok(px(token) >= px('--space-12'),
    `am Telefon traegt die Kante erst ab der Hoehe eines Gesichts (48px), ${token} sind ${px(token)}px`);
  for (const r of all.filter((x) => x.selector === '.wall__foot' && x.at.length > 0)) {
    assert.equal(decl(r.body, 'margin-block'), null, `${r.at.join(' ')} .wall__foot ueberschreibt den Endabstand`);
    assert.equal(decl(r.body, 'margin-block-start'), null, `${r.at.join(' ')} .wall__foot ueberschreibt den Endabstand`);
    assert.equal(decl(r.body, 'margin'), null, `${r.at.join(' ')} .wall__foot ueberschreibt den Endabstand`);
  }
});

// D8 (Critique 2026-10-16): der Large Title sprang beim Modulwechsel 2-3px
// (mobil y 8 gegen 11, je nachdem ob 48px-Knoepfe neben ihm standen). Die
// Titelzeile ist jetzt mindestens ein Ziel hoch und zentriert den Titel - in
// jedem Kopf derselbe Ort. Am Desktop tragen die Einstellungen ihren Modulkopf
// wie jedes Modul (vorher keinen), und "Mein Konto" wiederholt "Konto" nicht.
test('D8: die Titelzeile hat eine feste Mindesthoehe, die Einstellungen tragen am Desktop den Modulkopf', () => {
  const title = rules(layoutCss).find((r) => r.selector === '.page-toolbar:not(.page-toolbar--in-group) > .page-toolbar__title'
    && r.at.some((a) => /max-width:\s*767px/.test(a)) && decl(r.body, 'min-block-size'));
  assert.ok(title, 'die Titelzeile traegt unter 768px eine Mindesthoehe');
  assert.equal(decl(title.body, 'min-block-size'), 'var(--target-base)', 'ein Ziel hoch, wie die Knoepfe daneben');
  assert.equal(decl(title.body, 'align-content'), 'center', 'der Titel steht in der Zeile mittig');

  const shell = read('../public/settings/shell.js');
  const leaf = shell.match(/if \(activeLeaf && domain\) \{[\s\S]*?\n    return;\n  \}/)?.[0] ?? '';
  assert.match(leaf, /className = 'page-toolbar__title settings-toolbar__module-title'/, 'der Blattkopf traegt den Modultitel der Shell');
  assert.match(leaf, /replaceChildren\(back, moduleTitle\)/);
  assert.doesNotMatch(leaf, /createElement\('h1'\)/, 'kein zweites h1 neben dem Blatt-Titel');
  const settingsCss = read('../public/styles/settings.css');
  const hidden = rules(settingsCss).filter((r) => r.selector === '.settings-page--leaf .settings-shell-header' && decl(r.body, 'display') === 'none');
  assert.ok(hidden.length && hidden.every((r) => r.at.some((a) => /max-width:\s*1023px/.test(a))),
    'der Blattkopf verschwindet nur zwischen 768 und 1023px (dort traegt der Breadcrumb den Rueckweg), nicht am Desktop');
  assert.match(read('../public/settings/pages/personal-account.js'), /<h2 class="settings-section__title sr-only">\$\{t\('settings\.sectionAccount'\)\}/,
    '"Mein Konto" bleibt in der Gliederung, aber unsichtbar');
});

// Critique R19: auf /settings/personal/notifications stand "Mehr" nach einem
// Kaltstart ohne Aktivzustand - der Router markierte das Ziel erst nach dem
// Rendern der Seite (gemessen 3,3 s), und ein Neuaufbau der Leiste reichte
// den rohen Pfad herein, zu dem es kein Ziel gibt. Ein Text-Guard; der Lauf im
// Browser steht im Handoff der Runde (vorher false, nachher aria-current=page).
test('"Mehr" ist auf einem Einstellungsblatt sofort aktiv, auch nach dem Kaltstart (Critique R19)', () => {
  const router = read('../public/router.js');
  const nav = router.slice(router.indexOf('function updateNav('), router.indexOf('const kitchenDestination = currentKitchenDestination();', router.indexOf('function updateNav(')));
  assert.match(nav, /const path = topLevelSection\(rawPath\);/, 'updateNav kuerzt den Pfad nicht auf seine Sektion');
  const render = router.slice(router.indexOf('async function renderPage('));
  const shell = render.slice(0, render.indexOf('checkForUpdate();'));
  assert.match(shell, /renderAppShell\(app\);[\s\S]*updateNav\(routerState\.currentPath\);/,
    'beim Kaltstart wird das Ziel erst nach dem Rendern der Seite markiert');
});

// R19 (Critique 2026-10-16, Persona Casey): DIE TABS STEHEN STILL. Ohne FAB
// verteilten sich die fuenf Tabs auf die volle Kapsel (62 gegen 73px bei
// 390px) - jeder Wechsel auf einen Budget-Reiter ohne Neu-Aktion, nach
// Belohnungen oder in die Einstellungen schob die Ziele unter dem Daumen.
// Re-Kritik 2026-10-17: R19 kuerzte dafuer die Kapsel ohne Knopf (8-334
// statt 8-382px) - linksbuendig vor einem Loch, und ihr Ende sprang je Reiter.
// Jetzt steht die Reserve immer: Kapsel, Tabs und Knopfplatz bleiben stehen.
test('Re-Kritik: die FAB-Reserve der Kapsel steht immer - Kapselbreite und Tabs springen nicht je Seite oder Reiter', () => {
  const all = rules(layoutCss);
  const conditional = all.filter((r) => r.selector.endsWith('.nav-bottom__items') && /page-fab|fab-holding/.test(r.selector));
  assert.deepEqual(conditional.map((r) => r.selector), [], 'keine Kapselregel fragt, ob die Seite einen FAB hat');
  const reserve = all.find((r) => !r.at.length && r.selector.trim() === '.nav-bottom__items' && decl(r.body, 'padding-inline-end'));
  assert.match(decl(reserve?.body ?? '', 'padding-inline-end') ?? '', /^calc\(var\(--fab-size\) \+ var\(--nav-fab-inset\)\)$/,
    'die Reserve ist der Knopf plus sein Abstand zur Kante');
  assert.ok(!all.some((r) => r.selector.endsWith('.nav-bottom__items') && decl(r.body, 'inline-size')),
    'keine eigene Breite der Kapsel ohne Knopf');
});

// R19 (Entscheidung Ulas 2026-10-16): DIE KAPSEL MINIMIERT BEIM LESEN.
test('R19: die Kapsel minimiert beim Abwaertsscrollen - flacher, ohne Labels, Ziele und Zone bleiben', () => {
  const all = rules(layoutCss);
  const tokens = read('../public/styles/tokens.css');
  assert.match(tokens, /--nav-height-minimized:\s*calc\(var\(--target-base\) \+ var\(--space-2\)\);/,
    'minimiert ist die Kapsel ein Ziel hoch plus Luft - die Tabs behalten ihre Trefferflaeche');
  const compact = (r) => r.at.some((a) => /max-width:\s*1023px/.test(a));
  const capsule = all.find((r) => compact(r) && r.selector === '.nav-bottom--minimized:not(:focus-within) .nav-bottom__items');
  assert.equal(capsule && decl(capsule.body, 'min-height'), 'var(--nav-height-minimized)');
  const label = all.find((r) => compact(r) && r.selector === '.nav-bottom--minimized:not(:focus-within) .nav-item__label');
  assert.ok(label, 'die Labels blenden minimiert aus');
  assert.equal(decl(label.body, 'opacity'), '0');
  assert.equal(decl(label.body, 'display'), null, 'unsichtbar, nicht entfernt - der Name des Tabs bleibt im Baum');
  assert.equal(decl(label.body, 'visibility'), null);
  const fab = all.find((r) => compact(r) && r.selector.startsWith('html.nav-minimized') && r.selector.includes('.page-fab-group')
    && !r.selector.includes('rtl'));
  assert.match(decl(fab?.body ?? '', 'translate') ?? '', /var\(--nav-fab-shift\) var\(--nav-fab-shift\)/,
    'der FAB rueckt konzentrisch nach - per translate, ohne Layout');
  assert.ok(all.some((r) => r.selector.includes('rtl') && r.selector.includes('nav-minimized')), 'auch unter dir=rtl');
  const calm = all.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a))
    && r.selector.includes('.nav-bottom__items') && r.selector.includes('.nav-item__label'));
  assert.ok(calm.some((r) => decl(r.body, 'transition') === 'none'), 'reduzierte Bewegung: Zustandswechsel ohne Gleiten');
  const router = read('../public/router.js');
  // Review #2049: an der JEWEILS aktuellen Kapsel - renderAppShell() baut sie neu.
  assert.match(router, /navMinimizer = bindNavMinimize\(navMinimizer, nav\)/, 'der Router verdrahtet die Minimierung an der aktuellen Kapsel');
  assert.doesNotMatch(router, /!navMinimizer\)/, 'ein vorhandener Minimierer darf eine neue Kapsel nicht ausschliessen');
  assert.match(router, /function updateNav\(rawPath\) \{\n[^\n]*\n\s*navMinimizer\?\.expand\(\);/,
    'jeder Seitenwechsel beginnt mit ausgefahrener Kapsel');
});

// R19 (Critique 2026-10-16 P2 mobil): DIE TAB-LEISTE IST DIE TITELZEILE.
// Schichtplan, Belohnungen und Haushaltshilfe massen 121/121/129px bei 390px
// (Large Title ueber den Reitern), jetzt 65px; bei 834px 118-130 -> 69px.
const TABS_TITLE_MODULES = ['pages/housekeeping.js', 'pages/rewards.js', 'pages/schedule.js'];
test('R19: Schichtplan, Belohnungen und Haushaltshilfe fuehren ihre Reiter in der Titelzeile', () => {
  for (const f of TABS_TITLE_MODULES) {
    assert.match(read(`../public/${f}`), /<header class="page-toolbar [^"]*\bpage-toolbar--tabs-title\b/, `${f}: der Kopf traegt die Variante`);
  }
  const own = rules(layoutCss).filter((r) => r.selector.includes('.page-toolbar--tabs-title'));
  const at = (r, px) => r.at.some((a) => new RegExp(`max-width:\\s*${px}px`).test(a));
  const bar = own.find((r) => at(r, 1023) && r.selector.endsWith('> .page-toolbar__bar'));
  assert.equal(bar && decl(bar.body, 'flex'), '1 1 0', 'die Leiste nimmt den Rest der Titelzeile und scrollt dort');
  assert.equal(decl(bar.body, 'block-size'), 'auto', 'so hoch wie ihre Reiter, nicht wie eine eigene Leistenzeile');
  assert.ok(own.every((r) => at(r, 1023) || at(r, 767)), 'nur unter 1024px - am Desktop bleibt die Bar-Zeile eine eigene Zeile');
  const title = own.find((r) => at(r, 767) && r.selector.endsWith('> .page-toolbar__title'));
  assert.equal(title && decl(title.body, 'clip-path'), 'inset(50%)', 'unter 768px weicht der Titel aus dem Bild ...');
  assert.equal(decl(title.body, 'display'), null, '... nicht aus dem Baum: das <h1> bleibt die Seitenueberschrift');
  assert.ok(own.some((r) => at(r, 767) && r.selector.endsWith('> .module-seal--head') && decl(r.body, 'display') === 'none'),
    'das Siegel geht mit (die vier Reiter der Haushaltshilfe brauchen 351 von 358px)');
  assert.ok(read('../DESIGN.md').includes('page-toolbar--tabs-title'), 'DESIGN.md nennt die Variante');
});
