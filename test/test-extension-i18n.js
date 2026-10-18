/**
 * Test: Extension module i18n
 * Run: node --test test/test-extension-i18n.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearExtensionTranslations,
  registerExtensionTranslations,
  setExtensionLocaleBundles,
  resolveExtensionTranslation,
  extensionLocaleChain,
  nestFlatLocaleDict,
  t,
} from '../public/i18n.js';
import {
  extensionTranslationKey,
  resolveExtensionLabel,
  isValidExtensionLabelKey,
  moduleDisplayLabel,
  widgetDisplayLabel,
  optionFieldLabel,
  reloadExtensionLocales,
} from '../public/utils/extension-i18n.js';
import { readFileSync } from 'node:fs';

test.after(() => {
  clearExtensionTranslations();
});

test('registerExtensionTranslations merges flat keys under extensions.moduleId', () => {
  clearExtensionTranslations();
  registerExtensionTranslations('demo-mod', {
    menu: 'Demo Menu',
    'widgets.summary': 'Summary',
  });
  assert.equal(t('extensions.demo-mod.menu'), 'Demo Menu');
  assert.equal(t('extensions.demo-mod.widgets.summary'), 'Summary');
});

test('multi-locale bundles fall back UI locale -> defaultLocale -> en -> de', () => {
  clearExtensionTranslations();
  setExtensionLocaleBundles('demo-mod', {
    defaultLocale: 'en',
    trees: {
      en: { menu: 'English Menu' },
      de: { menu: 'Deutsch Menu' },
    },
  });
  assert.deepEqual(extensionLocaleChain('en', 'ru'), ['ru', 'en', 'de']);
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'ru'), 'English Menu');
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'de'), 'Deutsch Menu');
  assert.equal(resolveExtensionTranslation('extensions.demo-mod.menu', 'en'), 'English Menu');
});

test('extensionTranslationKey accepts short and full keys', () => {
  assert.equal(extensionTranslationKey('demo-mod', 'menu'), 'extensions.demo-mod.menu');
  assert.equal(extensionTranslationKey('demo-mod', 'extensions.demo-mod.menu'), 'extensions.demo-mod.menu');
});

test('resolveExtensionLabel prefers translation over static label', () => {
  clearExtensionTranslations();
  registerExtensionTranslations('demo-mod', { menu: 'Lokalisiert' });
  assert.equal(resolveExtensionLabel('demo-mod', { labelKey: 'menu', label: 'Static' }), 'Lokalisiert');
  assert.equal(resolveExtensionLabel('demo-mod', { label: 'Static' }), 'Static');
});

test('resolveExtensionLabel uses static label when no locale bundle matches', () => {
  clearExtensionTranslations();
  assert.equal(resolveExtensionLabel('demo-mod', {
    labelKey: 'menu',
    label: 'Static fallback',
  }), 'Static fallback');
});

test('moduleDisplayLabel and widgetDisplayLabel use manifest fallbacks', () => {
  clearExtensionTranslations();
  setExtensionLocaleBundles('demo-mod', {
    defaultLocale: 'en',
    trees: {
      en: {
        menu: 'Menu EN',
        module: 'Module EN',
        widgets: { summary: 'Widget EN' },
        options: { compact: 'Compact EN' },
      },
    },
  });
  const mod = {
    id: 'demo-mod',
    name: 'Demo',
    menu: { label: 'Menu static', labelKey: 'menu' },
    capabilities: { permissionModule: { label: 'Module static', labelKey: 'module' } },
  };
  assert.equal(moduleDisplayLabel(mod), 'Menu EN');
  assert.equal(widgetDisplayLabel({
    id: 'demo-mod:summary',
    moduleId: 'demo-mod',
    label: 'Widget static',
    labelKey: 'widgets.summary',
  }), 'Widget EN');
  assert.equal(optionFieldLabel('demo-mod', { title: 'Compact static', titleKey: 'options.compact' }, 'compact'), 'Compact EN');
});

test('isValidExtensionLabelKey rejects invalid keys', () => {
  assert.equal(isValidExtensionLabelKey('widgets.summary'), true);
  assert.equal(isValidExtensionLabelKey('Bad Key'), false);
  assert.equal(isValidExtensionLabelKey(''), false);
});

test('nestFlatLocaleDict does not poison Object.prototype', () => {
  delete Object.prototype.polluted;
  const tree = nestFlatLocaleDict({
    '__proto__.polluted': 'PWNED',
    'widget.title': 'harmless',
  });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(tree.widget.title, 'harmless');
  assert.equal(Object.getPrototypeOf(tree), null);

  nestFlatLocaleDict({ 'constructor.prototype.polluted': 'PWNED' });
  assert.equal(({}).polluted, undefined);
  delete Object.prototype.polluted;
});

test('registerExtensionTranslations still resolves a legitimate nested key', () => {
  clearExtensionTranslations();
  registerExtensionTranslations('demo-mod', { 'widget.title': 'harmless' });
  assert.equal(t('extensions.demo-mod.widget.title'), 'harmless');
  assert.equal(({}).polluted, undefined);
});

test('nestFlatLocaleDict drops DANGEROUS segments instead of creating own keys', () => {
  const tree = nestFlatLocaleDict({
    '__proto__.polluted': 'PWNED',
    'constructor.prototype.polluted': 'PWNED',
    'prototype.x': 'PWNED',
    'widget.title': 'ok',
  });
  assert.equal(tree.widget.title, 'ok');
  assert.deepEqual(Reflect.ownKeys(tree).sort(), ['widget']);
  assert.equal(Object.hasOwn(tree, '__proto__'), false);
  assert.equal(Object.hasOwn(tree, 'constructor'), false);
  assert.equal(Object.hasOwn(tree, 'prototype'), false);
});

test('t() does not throw for module ids that collide with Object.prototype', () => {
  clearExtensionTranslations();
  assert.equal(t('extensions.constructor.widget.title'), 'extensions.constructor.widget.title');
  assert.equal(t('extensions.toString.widget.title'), 'extensions.toString.widget.title');
  assert.equal(t('extensions.__proto__.widget.title'), 'extensions.__proto__.widget.title');

  registerExtensionTranslations('constructor', { 'widget.title': 'Weather' });
  assert.equal(t('extensions.constructor.widget.title'), 'Weather');
});

test('clearExtensionTranslations removes overlay', () => {
  registerExtensionTranslations('demo-mod', { menu: 'X' });
  clearExtensionTranslations();
  assert.equal(t('extensions.demo-mod.menu'), 'extensions.demo-mod.menu');
});

// Der Router fragt /modules alle 30 s ab und ruft danach reloadExtensionLocales.
// Vorher holte JEDER Takt jede Sprachdatei jedes aktiven Moduls mit no-store neu:
// zwei Module mit je 25 Sprachen waren rund 6000 Anfragen pro Stunde und Tab.
test('reloadExtensionLocales fetches locale files only when the module set changed', async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ menu: 'Demo' }) };
  };
  try {
    const mod = (version) => ({
      id: 'poll-mod', enabled: true, status: 'enabled', version,
      i18n: { defaultLocale: 'en', availableLocales: ['en', 'de'] },
    });
    await reloadExtensionLocales([mod('1.0.0')]);
    assert.equal(urls.length, 2, 'first load fetches every locale file');

    await reloadExtensionLocales([mod('1.0.0')]);
    assert.equal(urls.length, 2, 'an unchanged poll must not refetch');
    assert.equal(t('extensions.poll-mod.menu'), 'Demo', 'translations survive the skipped poll');

    await reloadExtensionLocales([mod('1.1.0')]);
    assert.equal(urls.length, 4, 'an updated module reloads its locales');

    await reloadExtensionLocales([mod('1.1.0')], { force: true });
    assert.equal(urls.length, 6, 'force reloads after an install or update in settings');
  } finally {
    globalThis.fetch = realFetch;
    clearExtensionTranslations();
  }
});

test('router: the module poll skips ticks while the tab is hidden', () => {
  const src = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = src.indexOf('function startThirdPartyModulePolling');
  assert.ok(start > 0, 'startThirdPartyModulePolling exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /setInterval\(/);
  assert.match(body, /document\.hidden/, 'a hidden tab must not poll /modules');
});

// Codex-Review zu #2055: scheiterte eine Sprachdatei, merkte sich die Funktion
// den Modulsatz trotzdem als geladen - jeder weitere Takt kehrte frueh zurueck,
// und die fehlende Uebersetzung kam bis zum Neuladen des Tabs nie wieder.
test('reloadExtensionLocales retries a module set whose locale file failed to load', async () => {
  const urls = [];
  let failDe = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (failDe && String(url).endsWith('/de.json')) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ menu: 'Demo' }) };
  };
  try {
    const mod = {
      id: 'retry-mod', enabled: true, status: 'enabled', version: '1.0.0',
      i18n: { defaultLocale: 'en', availableLocales: ['en', 'de'] },
    };
    await reloadExtensionLocales([mod]);
    assert.equal(urls.length, 2, 'first load asks for both files');

    failDe = false;
    await reloadExtensionLocales([mod]);
    assert.equal(urls.length, 4, 'the next poll retries after a failed file');

    await reloadExtensionLocales([mod]);
    assert.equal(urls.length, 4, 'once complete, an unchanged poll stays quiet');
  } finally {
    globalThis.fetch = realFetch;
    clearExtensionTranslations();
  }
});
