/**
 * Tests für public/lang-init.js — das synchrone <head>-Bootstrap, das
 * document.documentElement.lang vor dem Render auf die echte Nutzer-Locale setzt
 * (verhindert falsches „aus dem Deutschen übersetzen" in Chromium-Browsern).
 *
 * Die Resolve-Logik muss mit i18n.js (resolveLocale) übereinstimmen:
 *   manueller Override (localStorage) > navigator.languages Basis-Match > 'en'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SRC = readFileSync(new URL('../public/lang-init.js', import.meta.url), 'utf8');

/** Führt lang-init.js in einer Sandbox aus und liefert den gesetzten lang-Wert. */
function runLangInit({ stored = null, languages = undefined, language = undefined, throwOnStorage = false } = {}) {
  const html = { lang: '' };
  const sandbox = {
    document: { documentElement: html },
    navigator: { languages, language },
    localStorage: {
      getItem(key) {
        if (throwOnStorage) throw new Error('blocked');
        return key === 'oikos-locale' ? stored : null;
      },
    },
  };
  runInContext(SRC, createContext(sandbox));
  return html.lang;
}

test('gültiger localStorage-Override gewinnt', () => {
  assert.equal(runLangInit({ stored: 'fr', languages: ['de-DE'] }), 'fr');
});

test('ungültiger localStorage-Wert wird ignoriert, Fallback auf navigator', () => {
  assert.equal(runLangInit({ stored: 'xx', languages: ['en-US', 'de'] }), 'en');
});

test('navigator.languages: erstes unterstütztes Basis-Tag gewinnt', () => {
  assert.equal(runLangInit({ languages: ['en-US', 'de'] }), 'en');
});

test('Region-Tag wird auf Basis-Sprache reduziert (de-AT → de)', () => {
  assert.equal(runLangInit({ languages: ['de-AT'] }), 'de');
});

test('nicht unterstützte Sprache fällt auf en zurück (ko-KR → en)', () => {
  assert.equal(runLangInit({ languages: ['ko-KR'] }), 'en');
});

test('überspringt nicht unterstützte und nimmt das nächste unterstützte Tag', () => {
  assert.equal(runLangInit({ languages: ['ko-KR', 'nl-BE'] }), 'nl');
});

test('navigator.language (Singular) als Fallback wenn languages fehlt', () => {
  assert.equal(runLangInit({ language: 'pt-BR' }), 'pt');
});

test('blockierter localStorage (Privatmodus) wirft nicht, nutzt navigator', () => {
  assert.equal(runLangInit({ throwOnStorage: true, languages: ['it-IT'] }), 'it');
});

test('keine brauchbaren Signale → en', () => {
  assert.equal(runLangInit({ languages: [] }), 'en');
});
