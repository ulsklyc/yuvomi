/**
 * Modul: Material-Guards (Critique R18, "Das Material ist am Desktop nicht zu sehen")
 * Zweck: Die Regeln, die das Glas ehrlich halten - es bricht in der App nur
 *        Inhalt, schwebende Flaechen teilen eine Radiusstufe, das helle Glas
 *        traegt den Ton seiner Buehne, und das Lichtfeld lebt nur dort, wo
 *        nichts Opakes es verdeckt.
 * Ausfuehren: node --test test/test-material.js
 *
 * Textguards fuehren kein Stylesheet aus: was hier steht, ist die schnelle
 * Rueckmeldung. Die Sichtpruefung in beiden Themes und die Dokument-Sonden
 * (test:document-guards, Sonde 9 und 16) bleiben der Nachweis am gerenderten
 * Dokument.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { eachRule } from './css-rules.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');
const STYLE_DIR = new URL('../public/styles/', import.meta.url);
const styleFiles = () => readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'));

/** Alle Regeln eines Stylesheets, deren Selektorliste `selector` als ganzes Glied fuehrt. */
function rulesFor(css, selector) {
  return [...eachRule(css)].filter((rule) => rule.selector.split(',').map((s) => s.trim()).includes(selector));
}

// ---------------------------------------------------------------------------
// 1. Die App traegt keinen Backdrop hinter opakem Inhalt
// ---------------------------------------------------------------------------

/**
 * Gemessener Anlass (R18, drei Laeufe): vier `.lg-blob` drifteten endlos unter
 * der opaken `.app-content`, und `.app-shell` trug einen Verlauf, den dieselbe
 * Flaeche verdeckte. Ein Material, das niemand sieht, kostet Ebenen und
 * behauptet in DESIGN.md eine Farbdramatik, die es nicht gibt. Entscheidung
 * Ulas 07.10.2026: gestrichen, Glas bricht in der App nur Inhalt.
 *
 * Der Guard prueft die BAUART und nicht nur die alten Namen: eine Shell-Flaeche
 * mit Verlauf kaeme unter jedem Klassennamen als derselbe Befund zurueck.
 */
test('R18: die Shell traegt keinen Backdrop und keinen Verlauf hinter dem opaken Inhalt', () => {
  const namedLeftovers = [];
  for (const file of styleFiles()) {
    const css = read(`../public/styles/${file}`);
    for (const { selector, body } of eachRule(css)) {
      if (/\.lg-(?:blob|backdrop)\b/.test(selector) || /\blg-drift\b/.test(body)
        || /--lg-blob-opacity|--_?app-backdrop-/.test(body)) {
        namedLeftovers.push(`${file}: ${selector}`);
      }
    }
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /@keyframes\s+lg-drift\b/,
      `${file}: die Drift-Keyframes haben keinen Traeger mehr`);
  }
  assert.deepEqual(namedLeftovers, [], 'Reste des gestrichenen Backdrops');

  const router = read('../public/router.js');
  assert.doesNotMatch(router, /lg-blob|lg-backdrop|lgBackdrop/, 'router.js baut den Backdrop nicht mehr');

  let shellRules = 0;
  for (const file of ['layout.css', 'glass.css']) {
    for (const rule of rulesFor(read(`../public/styles/${file}`), '.app-shell')) {
      shellRules += 1;
      assert.doesNotMatch(rule.body, /gradient\(/,
        `${file}: .app-shell traegt einen Verlauf, den .app-content vollstaendig verdeckt`);
    }
  }
  assert.ok(shellRules >= 1, 'der Scanner findet .app-shell');
});

/**
 * `.app-content` wurde unter prefers-reduced-transparency DURCHSICHTIG - ein
 * Zweig, der nur Sinn hatte, solange die Shell darunter einen eigenen Grund
 * malte. Der Scrollport traegt seine Flaeche in jedem Zustand selbst: opak,
 * `--color-bg`, damit jeder Textkontrast darauf derselbe ist wie ohne die
 * Praeferenz.
 */
test('R18: der Scrollport bleibt in jedem Zustand opak', () => {
  let seen = 0;
  for (const file of ['layout.css', 'glass.css']) {
    for (const rule of rulesFor(read(`../public/styles/${file}`), '.app-content')) {
      const bg = rule.body.match(/background(?:-color)?\s*:\s*([^;]+)/);
      if (!bg) continue;
      seen += 1;
      assert.equal(bg[1].trim(), 'var(--color-bg)',
        `${file}${rule.at.length ? ` [${rule.at.join(' ')}]` : ''}: .app-content traegt ${bg[1].trim()}`);
    }
  }
  assert.ok(seen >= 2, `der Scanner findet die Flaeche des Scrollports (${seen})`);
});

// ---------------------------------------------------------------------------
// Rechenwerk: Tokens aufloesen, Farben mischen, Kontrast messen
// ---------------------------------------------------------------------------

const TOKENS = read('../public/styles/tokens.css');

function tokenMap(body) {
  const map = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  return map;
}

const LIGHT = tokenMap([...eachRule(TOKENS)].find((r) => r.selector.trim() === ':root' && !r.at.length).body);
const DARK_ATTR = tokenMap([...eachRule(TOKENS)].find((r) => r.selector.trim() === '[data-theme="dark"]').body);
const DARK_MEDIA = tokenMap([...eachRule(TOKENS)]
  .find((r) => /prefers-color-scheme:\s*dark/.test(r.at.join(' ')) && /:root/.test(r.selector)).body);
const A11Y = ['prefers-reduced-transparency', 'prefers-contrast'].map((q) => tokenMap([...eachRule(TOKENS)]
  .find((r) => r.at.join(' ').includes(q) && r.selector.trim() === ':root').body));

/** Der Wert eines Tokens in einem Theme, `var()` bis zum Literal aufgeloest. */
function resolve(name, theme) {
  const scope = theme === 'dark' ? DARK_ATTR : LIGHT;
  let value = scope.get(name) ?? LIGHT.get(name);
  assert.ok(value !== undefined, `tokens.css: ${name} fehlt`);
  for (let i = 0; i < 12 && /var\(/.test(value); i += 1) {
    value = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, inner) => {
      const next = scope.get(inner) ?? LIGHT.get(inner);
      assert.ok(next !== undefined, `tokens.css: ${inner} fehlt (aus ${name})`);
      return next;
    });
  }
  return value;
}

/** `#RRGGBB` oder `rgb(a)(r, g, b[, a])` als `{ rgb: [r, g, b], a }`. */
function color(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), a: 1 };
  const fn = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/);
  assert.ok(fn, `kein Farbwert: ${value}`);
  return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], a: fn[4] === undefined ? 1 : Number(fn[4]) };
}

const tone = (name, theme) => color(resolve(name, theme));
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const linear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const percent = (name) => Number(resolve(name, 'light').replace('%', '')) / 100;

// ---------------------------------------------------------------------------
// 2. Schwebende Flaechen teilen eine Radiusstufe
// ---------------------------------------------------------------------------

const LAYOUT = read('../public/styles/layout.css');
const GLASS = read('../public/styles/glass.css');
const radiusOf = (rule) => rule.body.match(/border-radius\s*:\s*([^;]+)/)?.[1].trim();

/**
 * Gemessener Anlass (R18): Dialog, Mehr-Blatt und Such-Palette trugen 16px,
 * Termin-Popover, Heute-Blatt und Toast 26px, und DESIGN.md sagte "Sheets und
 * Glas-Chrome 26px+". Geprueft wird JEDE Regel der drei Flaechen, die einen
 * Radius setzt - eine zweite Regel in einem Media-Block, die auf 16px
 * zuruecksetzt, waere sonst der stille Rueckfall (so stand es an
 * `.modal-panel` ab 768px).
 */
test('R18: Dialog, Mehr-Blatt und Such-Palette tragen die Stufe der schwebenden Flaechen', () => {
  for (const selector of ['.modal-panel', '.more-sheet', '.search-overlay__panel']) {
    const radii = [LAYOUT, GLASS].flatMap((css) => rulesFor(css, selector)).map(radiusOf).filter(Boolean);
    assert.ok(radii.length >= 1, `${selector}: keine Regel mit border-radius gefunden`);
    assert.deepEqual([...new Set(radii)], ['var(--radius-xl)'], `${selector} traegt ${radii.join(', ')}`);
  }
  // Die kleine Stufe: Menues.
  for (const [css, selector] of [[LAYOUT, '.popover-menu'], [LAYOUT, '.filter-popover'],
    [read('../public/styles/documents.css'), '.documents-context-menu'],
    [read('../public/styles/calendar.css'), '.cal-filters-popover']]) {
    const radii = rulesFor(css, selector).map(radiusOf).filter(Boolean);
    assert.deepEqual([...new Set(radii)], ['var(--radius-glass-inner)'], `${selector} traegt ${radii.join(', ')}`);
  }
});

/**
 * Die Konzentrik-Regel (DESIGN.md, "Shapes"): innen = aussen minus Abstand.
 * Gerechnet wird aus den Tokens, nicht aus der Schreibweise - ein
 * `calc(var(--radius-xl) - var(--space-3))` und ein gleich grosses Token sind
 * beide richtig, ein blind kopierter Aussenradius ist es nicht.
 */
test('R18: die Innenradien der schwebenden Flaechen sind konzentrisch', () => {
  const px = (expr) => {
    const resolved = expr.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, n) => resolve(n, 'light'));
    const calc = resolved.match(/^calc\(\s*([\d.]+)px\s*-\s*([\d.]+)px\s*\)$/);
    if (calc) return Number(calc[1]) - Number(calc[2]);
    const plain = resolved.match(/^([\d.]+)px$/);
    assert.ok(plain, `kein Pixelwert: ${expr} -> ${resolved}`);
    return Number(plain[1]);
  };
  const first = (css, selector, at = () => true) => {
    const rule = rulesFor(css, selector).find((r) => radiusOf(r) && at(r.at.join(' ')));
    assert.ok(rule, `${selector}: Regel mit border-radius fehlt`);
    return px(radiusOf(rule));
  };
  const outer = px('var(--radius-xl)');
  const menu = px('var(--radius-glass-inner)');
  // [innen, aussen, Abstand zur Kante der Flaeche, Name]
  const pairs = [
    [first(LAYOUT, '.more-item'), outer, px('var(--space-3)'), 'Kachel im Mehr-Blatt (12px Seitenpolster)'],
    [first(LAYOUT, '.more-action'), outer, px('var(--space-4)'), 'Systemzeile im Mehr-Blatt (16px Polster unten)'],
    [first(LAYOUT, '.search-section__rows', (at) => /min-width:\s*768px/.test(at)), outer, px('var(--space-4)'),
      'Treffertraeger der Palette (16px Polster)'],
    [px('var(--radius-sm)'), outer, px('var(--space-4)'), 'Feld im Dialog und auf der Zugangstafel (16px Polster)'],
    [first(LAYOUT, '.popover-menu__item'), menu, px('var(--space-1)'), 'Menuezeile (4px Polster)'],
  ];
  for (const [inner, out, gap, name] of pairs) {
    assert.equal(inner, out - gap, `${name}: innen ${inner}px, konzentrisch waeren ${out}px - ${gap}px`);
  }
});

/**
 * Die Lichtkante und der Kopf. Ein Inset-Schatten an der Tafel selbst laege
 * unter Kopf und Fuss; deshalb ein Pseudo-Element darueber, aus dem
 * Inset-Token (das den a11y-Schalter traegt). Und der Kopf ist keine eigene
 * Flaeche mehr: hell stand er als kuehler Graustreifen ueber der weissen Tafel.
 */
test('R18: die Tafel faengt oben Licht, ihr Kopf ist keine Fremdflaeche, und sie traegt keinen Blur', () => {
  for (const selector of ['.modal-panel::after', '.more-sheet::after', '.search-overlay__panel::after']) {
    const rule = rulesFor(GLASS, selector)[0];
    assert.ok(rule, `${selector} fehlt`);
    assert.match(rule.body, /box-shadow:\s*var\(--glass-inset-elevated\)/, `${selector}: Lichtkante aus dem Inset-Token`);
    assert.match(rule.body, /pointer-events:\s*none/, `${selector} nimmt keinen Zeiger`);
    assert.match(rule.body, /position:\s*absolute/, `${selector} nimmt kein Layout`);
    assert.doesNotMatch(rule.body, /backdrop-filter/, `${selector}: Kante ohne Blur`);
  }
  for (const css of [LAYOUT, GLASS]) {
    for (const rule of rulesFor(css, '.modal-panel__header')) {
      assert.doesNotMatch(rule.body, /background(?:-color)?\s*:/, 'der Dialogkopf traegt keine eigene Flaeche');
    }
    // Der Rumpf der Tafel scrollt: ein backdrop-filter an ihr bricht dort das
    // asynchrone Scrollen. Der Blur lebt am Overlay.
    for (const rule of [...eachRule(css)].filter((r) => /(^|,)\s*\.modal-panel(?::not\([^)]*\))?\s*(,|$)/.test(r.selector))) {
      assert.doesNotMatch(rule.body, /backdrop-filter/, '.modal-panel traegt keinen backdrop-filter');
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Das helle Glas traegt den Ton seiner Buehne
// ---------------------------------------------------------------------------

const LIGHT_GLASS = ['--_glass-bg-elevated', '--_glass-bg-capsule', '--_glass-bg-card-hover',
  '--_color-surface-glass', '--_color-surface-raised'];

/**
 * Gemessener Anlass (R18, vier Laeufe): `rgba(250, 250, 252, ...)` und
 * `#FBFBFD` - Apples kuehles Systemweiss - auf der warmen Buehne
 * rgb(245,243,237). WARM heisst hier messbar: Rot >= Gruen > Blau, wie die
 * Buehne selbst. Der Ton ist die hellste Stufe der eigenen Rampe.
 */
test('R18: das helle Glas ist warm wie die Buehne, nicht kuehl', () => {
  const stage = tone('--_neutral-100', 'light').rgb;
  assert.ok(stage[0] >= stage[1] && stage[1] > stage[2], 'die Buehne selbst ist warm - sonst misst der Guard nichts');
  const warmest = tone('--_neutral-50', 'light').rgb;
  for (const name of LIGHT_GLASS) {
    const { rgb } = tone(name, 'light');
    assert.ok(rgb[0] >= rgb[1] && rgb[1] > rgb[2], `${name} = rgb(${rgb.join(', ')}) ist nicht warm (R >= G > B)`);
    assert.deepEqual(rgb, warmest, `${name} traegt den Ton von --neutral-50`);
  }
});

/**
 * DIE RECHNUNG ZUM KOMMENTAR IN tokens.css (16 a). Deckend gemischt, ohne den
 * Blur - die untere Grenze. Wer einen Glaswert oder eine Tinte anfasst, sieht
 * hier, was unter AA faellt.
 */
test('R18: Text auf dem hellen und dunklen Chrome-Glas haelt AA', () => {
  const rows = [];
  for (const theme of ['light', 'dark']) {
    const stage = tone('--_neutral-100', theme).rgb;
    const card = tone('--_color-surface', theme).rgb;
    const glass = tone('--_glass-bg-elevated', theme);
    const ink = tone('--_neutral-900', theme).rgb;
    const secondary = tone('--_neutral-600', theme).rgb;
    const tertiary = tone('--_color-text-tertiary', theme).rgb;
    const accent = tone('--_color-accent', theme).rgb;
    for (const [groundName, ground] of [['Buehne', stage], ['Karte', card]]) {
      const surface = over(glass.rgb, glass.a, ground);
      rows.push([`${theme}: Zeilenlabel auf Glas ueber ${groundName}`, contrast(secondary, surface), 4.5]);
      rows.push([`${theme}: Gruppenlabel auf Glas ueber ${groundName}`, contrast(tertiary, surface), 4.5]);
      rows.push([`${theme}: Kontoname auf Glas ueber ${groundName}`, contrast(ink, surface), 4.5]);
      // Aktive Zeile: Pille = Akzent (--tint-surface minus 4 %) in --glass-bg-card
      // ueber dem Glas; Label = 70 % Akzent in Tinte (layout.css).
      const cardGlass = tone('--_color-surface-glass', theme);
      const pill = over(accent, percent('--tint-surface') - 0.04, over(cardGlass.rgb, cardGlass.a, surface));
      rows.push([`${theme}: aktives Label auf der Pille ueber ${groundName}`, contrast(over(accent, 0.7, ink), pill), 4.5]);
    }
    // Tab-Kapsel: Label in Tinte, ueber Buehne und ueber einer Tintenzeile.
    const capsule = tone('--_glass-bg-capsule', theme);
    rows.push([`${theme}: Kapsel-Label ueber der Buehne`, contrast(ink, over(capsule.rgb, capsule.a, stage)), 4.5]);
  }
  rows.push(['light: Kapsel-Label ueber einer Tintenzeile',
    contrast(tone('--_neutral-900', 'light').rgb,
      over(tone('--_glass-bg-capsule', 'light').rgb, tone('--_glass-bg-capsule', 'light').a, tone('--_neutral-900', 'light').rgb)), 4.5]);
  const failing = rows.filter(([, ratio, min]) => ratio < min).map(([name, ratio, min]) => `${name}: ${ratio.toFixed(2)}:1 < ${min}`);
  assert.deepEqual(failing, [], 'Text auf Glas unter AA');
  assert.ok(rows.length >= 18, `Reichweite: ${rows.length} Paare gerechnet`);
});

/**
 * Die Icon-Mulde der Seitenleiste. Gemessen (R18): hell stand
 * rgb(251,250,247) auf Glas rgb(250,249,246) - 1,007:1, also keine Mulde.
 * Verlangt ist in BEIDEN Themes eine lesbare Stufe gegen das Glas, und das
 * Modulzeichen darauf haelt die Grafikschwelle (WCAG 1.4.11, 3:1).
 */
test('R18: die Icon-Mulde der Seitenleiste ist in beiden Themes eine Mulde', () => {
  const well = rulesFor(LAYOUT, '.nav-sidebar .nav-item__icon-well').find((r) => /background\s*:/.test(r.body));
  assert.ok(well, 'die Seitenleiste setzt ihre Mulde nicht mehr selbst');
  const mix = well.body.match(/background\s*:\s*color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*var\((--[\w-]+)\),\s*transparent\)/);
  assert.ok(mix, `unbekannte Bauart der Mulde: ${well.body}`);
  assert.equal(mix[1], '--color-text-primary', 'die Mulde mischt die Tinte ein - sie kippt mit dem Theme');
  const strength = percent(mix[2]);

  for (const theme of ['light', 'dark']) {
    const glass = tone('--_glass-bg-elevated', theme);
    const surface = over(glass.rgb, glass.a, tone('--_neutral-100', theme).rgb);
    const wellColor = over(tone('--_neutral-900', theme).rgb, strength, surface);
    const step = contrast(wellColor, surface);
    assert.ok(step >= 1.12, `${theme}: Mulde gegen Glas ${step.toFixed(3)}:1 - unter 1,12 ist sie keine Stufe`);
    const families = [...(theme === 'dark' ? DARK_ATTR : LIGHT).keys()].filter((k) => /^--_family-/.test(k));
    assert.ok(families.length >= 9, `${theme}: Familientoene gefunden (${families.length})`);
    for (const family of families) {
      const ratio = contrast(tone(family, theme).rgb, wellColor);
      assert.ok(ratio >= 3, `${theme}: ${family} auf der Mulde ${ratio.toFixed(2)}:1 < 3`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Die Seitenleiste schwebt, ohne dem Inhalt Breite zu nehmen
// ---------------------------------------------------------------------------

const isDesktop = (rule) => rule.at.some((a) => /min-width:\s*1024px/.test(a));

test('R18: die Seitenleiste ist am Desktop eine schwebende Glastafel', () => {
  const geometry = rulesFor(LAYOUT, '.nav-sidebar').find((r) => isDesktop(r) && /position:\s*fixed/.test(r.body));
  assert.ok(geometry, 'die Desktop-Regel der Seitenleiste fehlt');
  for (const side of ['top', 'left', 'bottom']) {
    assert.match(geometry.body, new RegExp(`(?:^|;)\\s*${side}:\\s*var\\(--sidebar-float-gap\\)`), `${side}: Abstand zur Fensterkante`);
  }
  assert.match(geometry.body, /border-radius:\s*var\(--radius-glass-card\)/, 'der Radius des Glas-Chromes');
  assert.match(geometry.body, /(?:^|;)\s*width:\s*var\(--sidebar-width\)/, 'die Breite bleibt die der Spalte');
  assert.doesNotMatch(geometry.body, /border-right/, 'eine Tafel hat rundum eine Kante, keine rechte');

  const gap = Number(resolve('--sidebar-float-gap', 'light').replace('px', ''));
  assert.ok(gap >= 6 && gap <= 12, `Abstand ${gap}px - Groessenordnung der Luft um die mobile Kapsel (8px)`);

  const shadows = rulesFor(GLASS, '.nav-sidebar').filter((r) => isDesktop(r) && /box-shadow/.test(r.body));
  assert.equal(shadows.length, 1, 'genau EINE Regel setzt den Schatten der Tafel (vorher zwei, eine tot)');
  assert.match(shadows[0].body, /var\(--glass-inset-elevated\)/, 'Lichtkante');
  assert.match(shadows[0].body, /var\(--glass-shadow-md\)/, 'Schatten der schwebenden Stufe');

  // Der Flyout der eingeklappten Schiene liegt UEBER Inhalt: er ersetzt den
  // Schatten und muss die Lichtkante dabei behalten.
  const flyout = [...eachRule(LAYOUT)].find((r) => /\.nav-sidebar:focus-within$/.test(r.selector.trim())
    && /width:\s*var\(--sidebar-width-expanded\)/.test(r.body));
  assert.ok(flyout, 'die Flyout-Regel fehlt');
  assert.match(flyout.body, /box-shadow:[^;]*var\(--glass-inset-elevated\)/, 'der Flyout behaelt die Lichtkante');
});

/**
 * DIE INHALTSBREITE BLEIBT. Jede Schwelle der App ist gegen "Fenster minus
 * Seitenleiste" gerechnet (1280 - 220 = 1060px; `--layout-split-threshold`
 * 1040px laesst 20px fuer eine klassische Bildlaufleiste). Ein Rand von
 * `--sidebar-width + Abstand` naehme dem 1280er-Laptop mit Bildlaufleiste
 * Liste + Detail wieder weg (R10, A3 P2-2).
 */
test('R18: die schwebende Tafel nimmt dem Inhalt keine Breite', () => {
  const content = rulesFor(LAYOUT, '.app-content').find((r) => isDesktop(r) && /margin-left/.test(r.body));
  assert.ok(content, 'die Desktop-Regel von .app-content fehlt');
  assert.match(content.body, /margin-left:\s*var\(--sidebar-width\)\s*;/, 'der Rand ist die Spaltenbreite, ohne Zuschlag');
  assert.equal(resolve('--sidebar-width-expanded', 'light'), '220px');

  // Die Tafel ragt um ihren Abstand in den Seitenrand des Inhalts; der muss
  // groesser sein, sonst laege sie auf Inhalt.
  const gap = Number(resolve('--sidebar-float-gap', 'light').replace('px', ''));
  const desktopRoot = [...eachRule(TOKENS)].find((r) => r.selector.trim() === ':root' && r.at.some((a) => /min-width:\s*1024px/.test(a)));
  const gutterExpr = desktopRoot && tokenMap(desktopRoot.body).get('--page-gutter');
  assert.ok(gutterExpr, 'tokens.css: --page-gutter fehlt im Desktop-Block');
  const gutter = Number(gutterExpr.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, n) => resolve(n, 'light')).replace('px', ''));
  assert.ok(Number.isFinite(gutter), `Seitenrand nicht lesbar: ${gutterExpr}`);
  assert.ok(gutter - gap >= 16, `Seitenrand ${gutter}px minus Abstand ${gap}px laesst weniger als 16px Luft neben der Tafel`);
});

/**
 * Die zwei Zeilen ausserhalb der Liste (Einstellungen, Konto) faerbten sich
 * ueber die volle Breite. In der runden Tafel schneidet die untere Ecke eine
 * randbuendige Flaeche an; mit dem Einzug der Pille liegt sie in der Kurve.
 */
test('R18: Einstellungen und Kontozeile tragen den Einzug der gleitenden Pille', () => {
  const pill = rulesFor(LAYOUT, '.nav-sidebar__indicator').find((r) => /left\s*:/.test(r.body));
  const inset = pill.body.match(/left:\s*(var\(--[\w-]+\))/)[1];
  const rows = [...eachRule(LAYOUT)].find((r) => isDesktop(r)
    && r.selector.includes('.nav-sidebar > .nav-item--pinned-end')
    && r.selector.includes('.nav-sidebar__account-trigger') && /margin-inline/.test(r.body));
  assert.ok(rows, 'die gemeinsame Regel der beiden Zeilen fehlt');
  assert.ok(rows.body.includes(`margin-inline: ${inset}`), `Einzug ${inset} wie die Pille`);
});

// ---------------------------------------------------------------------------
// 5. Zugangsseiten: Lichtfeld und Glastafel
// ---------------------------------------------------------------------------

const AUTH = read('../public/styles/auth.css');

/**
 * Das Lichtfeld steht still und traegt keinen Filter - die Lehre aus #443 und
 * #716 (ein animierter blur(90px) kostete 40 fps im Leerlauf), hier als
 * Bauart statt als Reparatur. Und es haengt am a11y-Schalter seiner Gattung.
 */
test('R18: das Marken-Lichtfeld steht still, ohne Filter, und faellt unter den a11y-Praeferenzen weg', () => {
  const field = LIGHT.get('--brand-field');
  assert.ok(field, 'tokens.css: --brand-field fehlt');
  assert.equal((field.match(/radial-gradient\(/g) ?? []).length, 3, 'drei Kreise, wie die Bildmarke');
  assert.doesNotMatch(field, /blur\(|url\(/, 'kein Filter, kein Bild');
  assert.doesNotMatch(field, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'die Farben kommen aus den Marken-Tokens');
  assert.match(field, /var\(--brand-mark-from\)/);
  assert.match(field, /var\(--brand-mark-to\)/);
  // JEDER farbige Stopp haengt an der Staerke: mit 0 ist das ganze Feld weg.
  const stops = (field.match(/color-mix\(/g) ?? []).length;
  const switched = (field.match(/color-mix\(in srgb, var\(--brand-mark-(?:from|to)\) calc\(var\(--brand-field-opacity\) \* \d+%\), transparent\)/g) ?? []).length;
  assert.ok(stops >= 9, `Stopps gelesen (${stops})`);
  assert.equal(switched, stops, 'ein farbiger Stopp haengt nicht an der Staerke');

  for (const block of A11Y) assert.equal(block.get('--brand-field-opacity'), '0', 'a11y-Block schaltet das Feld ab');
  assert.equal(DARK_ATTR.get('--_brand-field-opacity'), DARK_MEDIA.get('--_brand-field-opacity'), 'beide Dark-Bloecke gleich');
  assert.ok(DARK_ATTR.get('--_brand-field-opacity'), 'das Feld hat einen Dark-Wert');

  // Traeger: die Shell der Zugangsseiten und das Ladebild - und nichts, was
  // sich bewegt.
  const carriers = [];
  for (const file of styleFiles()) {
    for (const rule of eachRule(read(`../public/styles/${file}`))) {
      if (!/var\(--brand-field\)/.test(rule.body)) continue;
      carriers.push(rule.selector.trim());
      assert.doesNotMatch(rule.body, /animation|(?:^|;)\s*filter\s*:|transform\s*:/, `${rule.selector}: das Feld steht still`);
    }
  }
  assert.deepEqual(carriers.sort(), ['.app-loading', '.app-shell:has(.auth-page)'], 'das Feld lebt nur vor der App');
});

/**
 * Die Tafel: opaker Rueckfall AUSSERHALB von @supports, Glas und Blur nur
 * darin (Fallback-Regel in DESIGN.md), die Stufe der schwebenden Flaechen.
 */
test('R18: die Zugangstafel ist Glas mit opakem Rueckfall', () => {
  const base = rulesFor(AUTH, '.auth-page').find((r) => !r.at.length);
  assert.ok(base, '.auth-page fehlt');
  assert.match(base.body, /background-color:\s*var\(--color-surface\)/, 'opaker Rueckfall ohne backdrop-filter');
  assert.doesNotMatch(base.body, /backdrop-filter/, 'der Blur steht nur in @supports');
  assert.match(base.body, /border-radius:\s*var\(--radius-xl\)/);
  assert.match(base.body, /box-shadow:[^;]*var\(--glass-inset-elevated\)/, 'Lichtkante');
  const glass = rulesFor(AUTH, '.auth-page').find((r) => r.at.some((a) => /@supports[^{]*backdrop-filter/.test(a)));
  assert.ok(glass, 'die Glas-Regel in @supports fehlt');
  assert.match(glass.body, /background-color:\s*var\(--glass-bg-elevated\)/);
  assert.match(glass.body, /(?:^|;)\s*backdrop-filter:\s*var\(--blur-lg\)/, 'der Blur kommt aus dem Token (a11y-Schalter)');
  assert.match(glass.body, /-webkit-backdrop-filter:\s*var\(--blur-lg\)/, 'webkit-Zwilling');
  // Eine Karte IN der Tafel waere Flaeche auf Flaeche.
  const card = rulesFor(AUTH, '.auth-page .auth-card')[0];
  assert.ok(card, 'die Huelle des Formulars gibt ihre Flaeche nicht ab');
  assert.match(card.body, /background:\s*none/);
  assert.match(card.body, /box-shadow:\s*none/);
});

/**
 * KEIN TEXT DIREKT AUF DEM FELD, und auf der Tafel haelt jede Tinte. Gerechnet
 * gegen den schlechtesten denkbaren Grund: alle drei Kreise mit vollem Kern
 * uebereinander, ohne den Blur der Tafel.
 */
test('R18: auf der Zugangstafel halten Text und Feldkante ihre Schwelle, direkt auf dem Feld stuende Text unter AA', () => {
  const from = tone('--brand-mark-from', 'light').rgb;
  const to = tone('--brand-mark-to', 'light').rgb;
  // Die Kernstaerke je Kreis: der Stopp bei 0 %.
  const peaks = [...LIGHT.get('--brand-field').matchAll(/var\(--brand-mark-(from|to)\) calc\(var\(--brand-field-opacity\) \* (\d+)%\), transparent\) 0%/g)]
    .map((m) => ({ ink: m[1] === 'from' ? from : to, share: Number(m[2]) / 100 }));
  assert.equal(peaks.length, 3, 'drei Kerne gelesen');
  const report = [];
  for (const theme of ['light', 'dark']) {
    const strength = Number(resolve('--_brand-field-opacity', theme));
    assert.ok(strength > 0 && strength <= 0.3, `${theme}: Staerke ${strength}`);
    const stage = tone('--_neutral-100', theme).rgb;
    const worst = peaks.reduce((ground, peak) => over(peak.ink, strength * peak.share, ground), stage);
    const glass = tone('--_glass-bg-elevated', theme);
    const panel = over(glass.rgb, glass.a, worst);
    const pairs = [
      ['Label und Satz (Sekundaertext)', tone('--_neutral-600', theme).rgb, 4.5],
      ['Versionszeile (Tertiaertext)', tone('--_color-text-tertiary', theme).rgb, 4.5],
      ['Name (Tinte)', tone('--_neutral-900', theme).rgb, 4.5],
      ['Link (Akzent)', tone('--_color-accent', theme).rgb, 4.5],
      ['Feldkante', tone('--_neutral-500', theme).rgb, 3],
    ];
    for (const [name, ink, min] of pairs) {
      const ratio = contrast(ink, panel);
      report.push(`${theme} ${name} ${ratio.toFixed(2)}`);
      assert.ok(ratio >= min, `${theme}: ${name} auf der Tafel ${ratio.toFixed(2)}:1 < ${min}`);
    }
    // Der Schriftzug des Ladebilds steht direkt auf dem Feld - in Tinte.
    const logo = contrast(tone('--_neutral-900', theme).rgb, worst);
    report.push(`${theme} Ladebild-Schriftzug ${logo.toFixed(2)}`);
    assert.ok(logo >= 4.5, `${theme}: Schriftzug des Ladebilds ${logo.toFixed(2)}:1`);
    if (theme === 'light') {
      const bare = contrast(tone('--_neutral-600', theme).rgb, worst);
      report.push(`light Sekundaertext direkt auf dem Feld ${bare.toFixed(2)}`);
      assert.ok(bare < 4.5, 'direkt auf dem Feld hielte Sekundaertext AA - dann braeuchte es die Regel nicht');
    }
  }
  if (process.env.MATERIAL_REPORT) console.log(report.join('\n'));

  assert.match(rulesFor(LAYOUT, '.app-loading__logo')[0].body, /(?:^|;)\s*color:\s*var\(--color-text-primary\)/,
    'der Schriftzug des Ladebilds steht in Tinte, nicht im Akzent');
  // Auf den Seiten steht alles in der Tafel: der Kopf ist ein Kind von
  // `main.auth-page` (test:auth-pages-ui haelt, dass jede Seite so beginnt),
  // und die Versionszeile steht vor dem schliessenden </main>.
  for (const page of ['login', 'setup']) {
    assert.match(read(`../public/pages/${page}.js`), /<p class="auth-version"[^>]*><\/p>\s*<\/main>/, `${page}.js: Versionszeile in der Tafel`);
  }
});
