/**
 * Test: Wall tablets name the pairing address before a code exists (#2294)
 * Purpose: A tablet pairs at <origin>/pair, a public route, not through the
 *          sign-in page. That address used to appear only in the hint next to
 *          a freshly issued pairing code, so an admin who opened the page
 *          first - or whose instance signs in through OIDC only - had no way
 *          to learn it. Measured here on the real page markup: with no tablet
 *          and no code, the page shows the two steps and the address with
 *          this instance's own origin, visible (not folded behind "More"),
 *          ahead of the tablet list; the path is the router's public pair
 *          route; and every locale carries both steps.
 * Run: npm run test:display-pairing-address (needs
 *      test/test-browser-loader.mjs for /api.js and /i18n.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

globalThis.window = { location: { origin: 'https://family.example' } };
globalThis.__apiStub = { get: async () => ({ data: [] }) };

const page = await import('../public/settings/pages/admin-displays.js');

async function pageHtml() {
  let html = '';
  const container = {
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_where, chunk) { html += chunk; },
    querySelector: () => null,
  };
  await page.render(container);
  return html;
}

test('with no tablet and no code, the page names the address and both steps', async () => {
  const html = await pageHtml();
  const steps = html.match(/<ol[^>]*id="display-pair-steps"[^>]*>([\s\S]*?)<\/ol>/);
  assert.ok(steps, 'an ordered list of pairing steps is on the page');
  const items = [...steps[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(items.length, 2, 'two steps');
  assert.match(items[0], /settings\.displayPairStepCode/, 'step 1: create a tablet and a code here');
  assert.match(items[1], /settings\.displayPairStepOpen/, 'step 2: open the address on the tablet');
  assert.match(items[1], /<code id="display-pair-address" dir="ltr">https:\/\/family\.example\/pair<\/code>/,
    'the address carries this instance\'s own origin');

  const at = html.indexOf('id="display-pair-steps"');
  assert.ok(html.indexOf('</details>') < at, 'visible, not folded behind "More"');
  assert.ok(at < html.indexOf('id="display-list"'), 'ahead of the tablet list');
});

test('the address is the router\'s public pairing route', async () => {
  const router = await readFile(new URL('../public/router.js', import.meta.url), 'utf8');
  assert.match(router, /\{ path: '\/pair',\s+page: '\/pages\/pair-display\.js', requiresAuth: false/);
});

test('every locale carries both steps', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const settings = JSON.parse(await readFile(new URL(file, dir), 'utf8')).settings ?? {};
    for (const key of ['displayPairStepCode', 'displayPairStepOpen']) {
      assert.ok(typeof settings[key] === 'string' && settings[key].trim(), `${file}: settings.${key}`);
    }
  }
});
