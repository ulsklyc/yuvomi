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
