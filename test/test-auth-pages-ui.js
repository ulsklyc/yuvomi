/**
 * Test: Die Seiten vor der App-Shell (/login, /setup, /join, /forgot-password,
 *       /reset-password, /pair) stylen jedes Textelement, das sie rendern.
 * Zweck: `.auth-card__title` stand im Markup von vier Seiten und hatte KEINE
 *        Regel (Critique 2026-09-26, Minor Observations) - das <h1> fiel auf
 *        die Reset-Basis zurueck (17px halbfett, so gross wie der Text
 *        darunter). Geprueft wird die Regel, nicht der eine Fund: jedes
 *        Element der Karte oder des Heros (`auth-card__*`, `auth-hero__*`),
 *        das eine Seite rendert, hat eine Regel in auth.css.
 * Ausfuehren: node --test test/test-auth-pages-ui.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { eachRule } from './css-rules.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PAGES = ['login', 'setup', 'join', 'forgot-password', 'reset-password', 'pair-display'];
const css = read('../public/styles/auth.css');
const selectors = [...eachRule(css)].map((r) => r.selector).join('\n');

test('jedes Karten- und Hero-Element der Auth-Seiten hat eine Regel in auth.css', () => {
  const rendered = new Set();
  for (const page of PAGES) {
    for (const [cls] of read(`../public/pages/${page}.js`).matchAll(/\bauth-(?:card|hero)__[\w-]+/g)) rendered.add(cls);
  }
  assert.ok(rendered.has('auth-card__title'), 'die Seiten rendern keinen Kartentitel mehr - Test veraltet');
  assert.ok(rendered.size >= 3, `nur ${rendered.size} Elemente gefunden - der Leser ist kaputt`);
  const missing = [...rendered].filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(selectors));
  assert.deepEqual(missing, [], `ohne Regel (faellt auf die Reset-Basis zurueck): ${missing.join(', ')}`);
});

test('der Kartentitel ist ein Titel: Title-2-Stufe, fett, Label-Farbe', () => {
  const rule = [...eachRule(css)].find((r) => r.selector === '.auth-card__title' && !r.at.length);
  assert.ok(rule, '.auth-card__title fehlt');
  assert.match(rule.body, /font-size:\s*var\(--type-toolbar-title\)/);
  assert.match(rule.body, /font-weight:\s*var\(--font-weight-bold\)/);
  assert.match(rule.body, /color:\s*var\(--color-text-primary\)/);
});

/* R16 Schritt 2b (Critique 2026-10-05, "Einstellungen/Auth: Marke nur auf Login,
 * drei Fehlerfeld-Varianten", "Auth: Passwort-Auge nur auf Login/Setup"): ein
 * Kopf, ein Passwortfeld, ein Fehlerfeld - aus utils/auth-ui.js. Gegen den
 * Stand davor rot gelaufen. */
const AUTH_FORMS = ['login', 'setup', 'join', 'forgot-password', 'reset-password'];
const ui = read('../public/utils/auth-ui.js');

test('R16: jede Seite vor der Anmeldung traegt denselben Kopf mit der Marke', () => {
  assert.match(ui, /export function authHeroHtml\(/);
  assert.match(ui, /<span class="auth-hero__mark" aria-hidden="true">\$\{brandMarkSvg\(\)\}<\/span>/, 'der Baustein fuehrt die Marke');
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    const mains = (src.match(/<main class="auth-page" id="main-content">/g) ?? []).length;
    const heroes = (src.match(/<main class="auth-page" id="main-content">\s*\$\{authHeroHtml\(/g) ?? []).length;
    assert.ok(mains >= 1, `${page}.js rendert keine Auth-Seite mehr - Test veraltet`);
    assert.equal(heroes, mains, `${page}.js: jede gerenderte Seite beginnt mit dem Kopf (${heroes} von ${mains})`);
    assert.doesNotMatch(src, /class="auth-hero"/, `${page}.js baut keinen eigenen Kopf`);
  }
  // Eine Seite, eine <h1>: ueber einer Karte mit eigenem Titel ist der Name ein Absatz.
  for (const page of ['join', 'forgot-password', 'reset-password']) {
    assert.doesNotMatch(read(`../public/pages/${page}.js`), /authHeroHtml\(\{(?![^}]*heading: false)/, `${page}.js: Kopf ohne zweite h1`);
  }
  assert.match(selectors, /\.auth-hero--compact \.auth-hero__title/, 'die leise Fassung hat ihre Regel');
});

test('R16: jedes Passwortfeld vor der Anmeldung traegt das Auge aus dem einen Baustein', () => {
  assert.match(ui, /export function wirePasswordToggle\(/);
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    const felder = (src.match(/type="password"/g) ?? []).length;
    const augen = (src.match(/wirePasswordToggle\(/g) ?? []).length;
    assert.equal(augen, felder, `${page}.js: ${felder} Passwortfelder, ${augen} Umschalter`);
    assert.doesNotMatch(src, /className = 'password-toggle'|input-password-wrapper/, `${page}.js baut das Auge nicht selbst`);
  }
});

test('R16: das Fehlerfeld der Auth-Seiten steht in EINER Fassung', () => {
  assert.match(ui, /<div class="form-error" id="\$\{esc\(id\)\}" role="alert" tabindex="-1" hidden><\/div>/);
  for (const page of AUTH_FORMS) {
    const src = read(`../public/pages/${page}.js`);
    assert.doesNotMatch(src, /class="form-error"/, `${page}.js nimmt authErrorHtml()`);
    assert.doesNotMatch(src, /role="alert"[^>]*aria-live|aria-live[^>]*role="alert"/, `${page}.js: alert ist schon assertiv`);
  }
});

/* R18: DIE BILDMARKE KOMMT AUS EINER QUELLE UND KIPPT NICHT MIT DEM THEME.
 * Sie stand zweimal im Code: in der Seitenleiste (router.js, Verlauf an
 * --color-accent - im Dark Weiss auf Flieder) und auf den Zugangsseiten
 * (auth-ui.js, Kreise in currentColor auf einer Akzentkachel - im Dark dunkle
 * Punkte auf Flieder, die Kreise rund 30 % der Kachel). Gemessen wird das
 * ERZEUGTE Markup gegen docs/logo.svg, nicht ein Wortlaut im Quelltext. */
test('R18: die Bildmarke ist docs/logo.svg - eine Quelle, feste Farben, beide Stellen', async () => {
  const { brandMarkSvg, BRAND_MARK_CIRCLES } = await import('../public/utils/brand-mark.js');
  const logo = read('../docs/logo.svg');
  const svg = brandMarkSvg();

  // Form: dieselbe Kachel, dieselben drei Kreise.
  const circlesOf = (markup) => [...markup.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"\s*\/>/g)].map((m) => m.slice(1).map(Number));
  assert.equal(circlesOf(logo).length, 3, 'Reichweite: docs/logo.svg traegt drei Kreise');
  assert.deepEqual(circlesOf(svg), circlesOf(logo), 'die Kreise der Marke sind die von docs/logo.svg');
  assert.deepEqual(BRAND_MARK_CIRCLES.map((c) => [...c]), circlesOf(logo));
  assert.match(svg, /viewBox="0 0 160 160"/);
  assert.match(svg, /<rect width="160" height="160" rx="36" fill="url\(#(yuvomi-brand-mark-\d+)\)"\/>/, 'die Kachel traegt den Verlauf');
  assert.match(svg, /<linearGradient id="yuvomi-brand-mark-\d+" x1="0" y1="0" x2="160" y2="160"/, 'von oben links nach unten rechts');
  // Zwei Marken im selben Dokument teilen sich keine Verlaufs-ID.
  assert.notEqual(svg.match(/id="([^"]+)"/)[1], brandMarkSvg().match(/id="([^"]+)"/)[1]);

  // Farben: nicht im Markup, nicht am Theme. Die Tokens tragen die Werte des
  // Logos und stehen genau einmal - ein Dark-Zwilling waere die alte Lage.
  assert.doesNotMatch(svg, /currentColor|#[0-9a-f]{3,8}\b|stop-color|fill="white"|style=/i, 'das Markup traegt keine Farbe');
  const tokens = read('../public/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const stops = [...logo.matchAll(/<linearGradient id="bg"[\s\S]*?<\/linearGradient>/g)][0][0];
  const [from, to] = [...stops.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toUpperCase());
  for (const [name, value] of [['--brand-mark-from', from], ['--brand-mark-to', to], ['--brand-mark-ink', '#FFFFFF']]) {
    const found = [...tokens.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim().toUpperCase());
    assert.deepEqual(found, [value], `${name} steht genau einmal und traegt den Wert der Marke`);
  }
  const layout = [...eachRule(read('../public/styles/layout.css'))];
  const body = (sel) => layout.filter((r) => r.selector.trim() === sel).map((r) => r.body).join(';');
  assert.match(body('.brand-mark__from'), /stop-color:\s*var\(--brand-mark-from\)/);
  assert.match(body('.brand-mark__to'), /stop-color:\s*var\(--brand-mark-to\)/);
  assert.match(body('.brand-mark__circles'), /fill:\s*var\(--brand-mark-ink\)/);
  assert.match(body('.brand-mark__circles'), /fill-opacity:\s*0\.82/);

  // Beide Stellen nehmen die eine Quelle, und keine baut die Marke daneben.
  const router = read('../public/router.js');
  assert.match(router, /logomark\.insertAdjacentHTML\('beforeend', brandMarkSvg\(\)\);/, 'die Seitenleiste nimmt die eine Marke');
  assert.match(ui, /import \{ brandMarkSvg \} from '\/utils\/brand-mark\.js';/);
  for (const [name, src] of [['router.js', router], ['auth-ui.js', ui]]) {
    assert.doesNotMatch(src, /<circle|createElementNS\([^)]*\), 'circle'\)|linearGradient/, `${name} baut keine eigene Marke`);
  }

  // Der Traeger auf den Zugangsseiten faerbt nichts mehr: keine Akzentkachel
  // unter dem Zeichen, keine Tinte, kein verkleinertes SVG.
  const mark = [...eachRule(css)].filter((r) => /\.auth-hero__mark\b/.test(r.selector));
  assert.ok(mark.length >= 2, 'Reichweite: Grund- und Kompaktregel der Marke');
  for (const r of mark) {
    assert.doesNotMatch(r.body, /background|(?:^|;)\s*color\s*:/, `${r.selector} faerbt die Marke`);
    assert.doesNotMatch(r.selector, /\bsvg\b/, `${r.selector} skaliert das Zeichen in seiner Kachel`);
  }
});
