/**
 * Modul: Test-Infrastruktur - Playwright-Aufloesung der Bild-Skripte (#2637)
 * Zweck: take-screenshots, build-screenshot-crops und build-screenshot-webp holen
 *        `chromium` ueber scripts/lib/playwright-module.js statt ueber einen festen
 *        Homebrew-Pfad im Import. Geprueft: der Pfad kommt aus YUVOMI_PLAYWRIGHT_PATH,
 *        ohne Variable gilt der Homebrew-Default, ein fehlendes Modul scheitert mit einer
 *        Meldung, die Pfad und Variable nennt, und kein Skript importiert Playwright
 *        mehr statisch.
 * Ausfuehren: npm run test:playwright-module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PLAYWRIGHT_PATH, loadChromium, playwrightModulePath } from '../scripts/lib/playwright-module.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = ['take-screenshots.mjs', 'build-screenshot-crops.mjs', 'build-screenshot-webp.mjs'];

test('Pfad aus YUVOMI_PLAYWRIGHT_PATH, sonst der Homebrew-Default', () => {
  assert.equal(playwrightModulePath({ YUVOMI_PLAYWRIGHT_PATH: '/x/playwright/index.mjs' }), '/x/playwright/index.mjs');
  assert.equal(playwrightModulePath({}), DEFAULT_PLAYWRIGHT_PATH);
  assert.equal(playwrightModulePath({ YUVOMI_PLAYWRIGHT_PATH: '' }), DEFAULT_PLAYWRIGHT_PATH);
  assert.match(DEFAULT_PLAYWRIGHT_PATH, /^\/opt\/homebrew\/lib\/node_modules\/playwright\//);
});

test('loadChromium importiert den aufgeloesten Pfad und gibt chromium zurueck', async () => {
  /** @type {string[]} */
  const seen = [];
  const chromium = await loadChromium({
    env: { YUVOMI_PLAYWRIGHT_PATH: '/x/playwright/index.mjs' },
    exists: () => true,
    importer: async (p) => { seen.push(p); return { chromium: { launch: 1 } }; },
  });
  assert.deepEqual(seen, ['/x/playwright/index.mjs']);
  assert.deepEqual(chromium, { launch: 1 });
});

test('fehlendes Modul: Fehler nennt den Pfad und die Variable, importiert nichts', async () => {
  let imported = false;
  await assert.rejects(
    loadChromium({
      env: { YUVOMI_PLAYWRIGHT_PATH: '/nope/index.mjs' },
      exists: () => false,
      importer: async () => { imported = true; return {}; },
    }),
    (e) => e instanceof Error && e.message.includes('/nope/index.mjs') && e.message.includes('YUVOMI_PLAYWRIGHT_PATH'),
  );
  assert.equal(imported, false);
});

test('Modul ohne chromium-Export: klare Meldung statt undefined', async () => {
  await assert.rejects(
    loadChromium({ env: {}, exists: () => true, importer: async () => ({}) }),
    /chromium/,
  );
});

test('kein Bild-Skript importiert Playwright statisch oder ueber einen festen Pfad', () => {
  for (const name of SCRIPTS) {
    const src = readFileSync(`${REPO}scripts/${name}`, 'utf8');
    assert.doesNotMatch(src, /\/opt\/homebrew/, `${name}: fester Homebrew-Pfad`);
    assert.doesNotMatch(src, /^import .*from '(?!\.\/lib\/)[^']*playwright/m, `${name}: statischer Playwright-Import`);
    assert.match(src, /loadChromium\(/, `${name}: holt chromium nicht ueber den Helfer`);
  }
});
