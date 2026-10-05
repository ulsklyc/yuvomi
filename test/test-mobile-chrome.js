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
  'pages/birthdays.js', 'pages/contacts.js', 'pages/documents.js', 'pages/health.js', 'pages/notes.js', 'pages/waste.js', 'settings/shell.js',
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
    assert.ok(r.at.some((a) => /max-width:\s*767px/.test(a)),
      `${r.selector}: nur unter 768px - ab dort hat die Titelzeile Feld und angedockte Pille`);
  }
  const title = own.find((r) => r.selector.endsWith(':not(.page-toolbar--in-group) > .page-toolbar__title')
    && /flex:\s*1 1 0/.test(r.body));
  assert.ok(title, 'der Titel gibt nach (Basis 0) - die Knoepfe haben kein Label zum Anschneiden');
  assert.match(title.body, /white-space:\s*nowrap/, 'ein langer Titel kuerzt, er bricht nicht um (Kopfhoehe je Sprache gleich)');
  assert.match(title.body, /text-overflow:\s*ellipsis/);

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
