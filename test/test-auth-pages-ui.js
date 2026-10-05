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
  assert.match(ui, /<span class="auth-hero__mark" aria-hidden="true">/, 'der Baustein fuehrt die Marke');
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
