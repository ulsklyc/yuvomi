import { test } from 'node:test';
import assert from 'node:assert/strict';
async function clickFasting(page, selector) {
  const exposed = await page.$eval(selector, async (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  assert.equal(exposed, true, `${selector} is not covered by the sticky toolbar`);
  await page.click(selector);
}
import { mkdirSync } from 'node:fs';
import { startHarness, openPage, gotoRoute, settle } from './document-guards-harness.js';
import { measureFasting } from './fasting-visual-harness.js';

test('overlapping fasting renders discard stale responses and keep one timer', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'desktop', locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    const count = await page.evaluate(async () => {
      const { mountFasting } = await import('/pages/health-fasting.js');
      const { api } = await import('/api.js');
      const get = api.get, set = window.setInterval, clear = window.clearInterval;
      const live = new Set();
      let release, ready, intercepted = false;
      const readyPromise = new Promise((resolve) => { ready = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      const root = document.createElement('div'); document.body.append(root);
      window.setInterval = (...args) => { const id = set(...args); live.add(id); return id; };
      window.clearInterval = (id) => { live.delete(id); clear(id); };
      api.get = async (...args) => {
        const result = await get(...args);
        if (args[0] === '/health/fasting/state' && !intercepted) { intercepted = true; ready(); await held; }
        return result;
      };
      try {
        const first = mountFasting(root);
        await readyPromise;
        await mountFasting(root);
        release(); await first;
        return live.size;
      } finally { release(); root.remove(); for (const id of live) clear(id); api.get = get; window.setInterval = set; window.clearInterval = clear; }
    });
    assert.equal(count, 1);
    await page.close();
  } finally { await harness.close(); }
});

// Real browser, API, database, styles and modal. Catches the original unstyled
// controls, repeated acknowledgement, frozen timer and incomplete finish flow.
test('fasting acceptance: desktop and mobile journal controls preserve data and render accessibly', async () => {
  const harness = await startHarness();
  let currentPage;
  try {
    for (const [device, theme] of [['desktop', 'light'], ['mobile', 'dark']]) {
      await harness.reset();
      const page = await openPage(harness, { device, theme, locale: 'cs' });
      currentPage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
        const { api } = await import('/api.js');
        return api[method](path, body);
      }, { method, path, body });
      await gotoRoute(page, '/health/fasting');
      await page.waitForSelector('[data-fasting-preset="16"]');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), true);
      await clickFasting(page, '[data-fasting-preset="15"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset="15"]').getAttribute('aria-pressed') === 'true');
      assert.equal((await call('get', '/health/fasting/state')).data.settings.default_goal_minutes, 900);
      assert.equal(await page.$eval('[data-fasting-preset="15"]', (el) => el === document.activeElement), true);
      assert.equal(await page.$eval('[data-fasting-preferences-status]', (el) => el.textContent), 'Uloženo');
      await clickFasting(page, '[data-fasting-preset="custom"]');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), false);
      assert.equal(await page.$eval('[data-fasting-preset="custom"]', (el) => el.getAttribute('aria-pressed')), 'true');
      await page.type('[data-fasting-goal]', '36');
      await page.$eval('[data-fasting-goal]', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForFunction(() => !document.querySelector('[data-fasting-goal]').disabled);
      assert.equal((await call('get', '/health/fasting/state')).data.settings.default_goal_minutes, 2160);
      await clickFasting(page, '[data-fasting-preset=""]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset=""]').getAttribute('aria-pressed') === 'true');
      await clickFasting(page, '[data-fasting-preset="16"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset="16"]').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), true);
      assert.equal(await page.$eval('.fasting-panel', (el) => el.lastElementChild.id), 'history');
      assert.equal(await page.$eval('.fasting-hero', (el) => el.querySelectorAll('a').length), 0);
      const button = await page.$eval('[data-fasting-action]', (el) => {
        const css = getComputedStyle(el); return { radius: css.borderRadius, background: css.backgroundColor, height: el.getBoundingClientRect().height };
      });
      assert.notEqual(button.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(button.radius, '0px');
      assert.ok(button.height >= 32);
      // Preferences disclosure shortens the page; keep the click below its sticky toolbar.
      await page.$eval('[data-fasting-action]', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await settle(page);
      await clickFasting(page, '[data-fasting-action]');
      await page.waitForSelector('.modal-panel');
      await settle(page);
      assert.match(await page.$eval('.modal-panel', (el) => el.textContent), /Než začnete/);
      await page.click('.modal-panel .btn--primary');
      await page.waitForFunction(() => !document.querySelector('.modal-panel'));
      await page.waitForFunction(() => document.querySelector('[data-fasting-action]')?.textContent === 'Ukončit půst');
      assert.equal((await call('get', '/health/fasting/state')).data.active.goal_minutes, 960, 'selected default becomes the running goal');
      await clickFasting(page, '[data-fasting-preset="20"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset="20"]').getAttribute('aria-pressed') === 'true');
      assert.equal((await call('get', '/health/fasting/state')).data.active.goal_minutes, 1200);
      await clickFasting(page, '[data-fasting-clock-mode="elapsed"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-clock-mode="elapsed"]').getAttribute('aria-pressed') === 'true');
      assert.equal((await call('get', '/health/fasting/state')).data.settings.clock_mode, 'elapsed');
      const before = await page.$eval('[data-fasting-timer]', (el) => el.textContent);
      await page.waitForFunction((value) => document.querySelector('[data-fasting-timer]').textContent !== value, {}, before);
      assert.match(await page.$eval('[data-fasting-timer]', (el) => el.textContent), /^\d{2,}:\d{2}:\d{2}$/);
      await clickFasting(page, '[data-fasting-action]');
      await page.waitForSelector('[data-fasting-edit-form]');
      await settle(page);
      const finished = (await call('get', '/health/fasting/state')).data;
      assert.equal(finished.active, null);
      assert.equal(finished.acknowledged, true);
      assert.equal(await page.$$eval('[data-fasting-edit-form] input[type="datetime-local"]', (els) => els.length), 2);
      await page.click('[name="rating"][value="4"]');
      await page.type('#fast-note', 'Testovací poznámka <bez HTML>');
      await page.click('.modal-panel [type="submit"]');
      await page.waitForFunction(() => !document.querySelector('.modal-panel'));
      const saved = (await call('get', '/health/fasting/state')).data.history[0];
      assert.equal(saved.rating, 4);
      assert.equal(saved.note, 'Testovací poznámka <bez HTML>');
      assert.equal(saved.start_at, finished.history[0].start_at);
      assert.equal(saved.end_at, finished.history[0].end_at);
      await page.click('[data-fast-edit]');
      await page.waitForSelector('[data-fasting-edit-form]');
      await settle(page);
      assert.equal(await page.$eval('#fast-note', (el) => el.value), saved.note);
      await page.click('[data-rating-clear]');
      await page.click('.modal-panel [type="submit"]');
      await page.waitForFunction(() => !document.querySelector('.modal-panel'));
      assert.equal((await call('get', '/health/fasting/state')).data.history[0].rating, null);
      await clickFasting(page, '[data-fasting-action]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-action]')?.textContent === 'Ukončit půst');
      assert.equal(await page.$('.modal-panel'), null, 'acknowledgement is not repeated');
      assert.equal(await page.$eval('#search-overlay', (el) => el.classList.contains('search-overlay--visible')), false, 'fasting actions must not open search');
      if (process.env.FASTING_SCREENSHOT_DIR) {
        await settle(page);
        await page.$eval('.fasting-hero', (el) => el.scrollIntoView({ block: 'center' }));
        mkdirSync(process.env.FASTING_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: process.env.FASTING_SCREENSHOT_DIR + '/' + device + '-fasting.png', captureBeyondViewport: false });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await gotoRoute(page, '/settings/personal/health');
      await page.waitForSelector('[data-scope="fasting"]');
      await page.select('[data-scope="fasting"]', 'family');
      await page.waitForFunction(() => !document.querySelector('[data-scope="fasting"]').disabled);
      assert.equal((await call('get', '/health/visibility-defaults')).data.defaults.fasting, 'family');
      if (device === 'desktop') {
        const journalState = (await call('get', '/health/fasting/state')).data;
        assert.ok(journalState.active, 'Late journal checks own an active record');
        assert.ok(journalState.history.length > 0, 'Late journal checks own completed history');
        await gotoRoute(page, '/health/fasting');
        await page.waitForSelector('[data-fast-edit]');
        let held;
        page.__yuvomiRequestInterceptor = (request) => {
          if (request.method() === 'POST' && request.url().endsWith('/finish')) { held = request; return true; }
          return false;
        };
        await clickFasting(page, '[data-fasting-action]');
        await page.waitForFunction(() => document.querySelector('[data-fasting-action]').disabled);
        while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
        await page.click('[data-fast-edit]');
        await settle(page);
        await page.type('#fast-note', ' Rozpracováno');
        const dirtyNote = await page.$eval('#fast-note', (el) => el.value);
        const response = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/finish'));
        page.__yuvomiRequestInterceptor = null;
        await held.continue();
        await response;
        await settle(page);
        assert.equal(await page.$eval('#fast-note', (el) => el.value), dirtyNote, 'delayed finish must not replace a dirty history editor');
        assert.equal(await page.$eval('[data-fasting-action]', (el) => el.textContent), 'Začít půst', 'persisted finish refreshes the page even when another dialog stays open');
        let heldSave;
        page.__yuvomiRequestInterceptor = (request) => {
          if (request.method() === 'PATCH' && request.url().includes('/health/fasting/')) { heldSave = request; return true; }
          return false;
        };
        await page.click('.modal-panel [type="submit"]');
        while (!heldSave) await new Promise((resolve) => setTimeout(resolve, 10));
        await page.evaluate(async () => {
          const { closeModal, openModal } = await import('/components/modal.js');
          await closeModal({ force: true });
          openModal({ title: 'Jiný dialog', content: '<p data-replacement-dialog>Rozpracovaná změna</p>' });
        });
        page.__yuvomiRequestInterceptor = null;
        const savedResponse = page.waitForResponse((res) => res.request().method() === 'PATCH' && res.url().includes('/health/fasting/'));
        await heldSave.continue();
        await savedResponse;
        await settle(page);
        assert.ok(await page.$('[data-replacement-dialog]'), 'delayed save must not close a replacement modal');
        await page.evaluate(async () => { const { closeModal } = await import('/components/modal.js'); await closeModal({ force: true }); });
        await settle(page);
        await gotoRoute(page, '/health/fasting');
        for (let day = 1; day <= 12; day++) {
          const date = `2024-01-${String(day).padStart(2, '0')}`;
          await call('post', '/health/fasting', { start_at: `${date}T06:00:00Z`, end_at: `${date}T07:00:00Z`, start_tzid: 'UTC' });
        }
        await gotoRoute(page, '/health/fasting');
        await page.waitForSelector('[data-fasting-more]:not([hidden])');
        assert.equal(await page.$$eval('[data-fast-edit]', (els) => els.length), 10);
        await clickFasting(page, '[data-fasting-more]');
        await page.waitForFunction(() => document.querySelectorAll('[data-fast-edit]').length > 10);
        assert.equal(await page.$eval('[data-fasting-more]', (el) => el.hidden), true);
        // Track real scheduled handles: repeated mounts and detached roots must
        // release both their ticker and button subscriptions, not accumulate work.
        const handles = await page.evaluate(async () => {
          const { startFastingClock } = await import('/components/fasting-controls.js');
          const originalSet = window.setInterval, originalClear = window.clearInterval;
          const live = new Set();
          window.setInterval = (...args) => { const id = originalSet(...args); live.add(id); return id; };
          window.clearInterval = (id) => { live.delete(id); originalClear(id); };
          try {
            for (let i = 0; i < 30; i++) {
              const root = document.createElement('div'); document.body.append(root);
              const stop = startFastingClock(root, null, null); stop(); root.remove();
            }
            const afterStop = live.size;
            const root = document.createElement('div'); document.body.append(root);
            startFastingClock(root, null, null); root.remove();
            await new Promise((resolve) => setTimeout(resolve, 1100));
            return { afterStop, afterDetach: live.size };
          } finally { for (const id of live) originalClear(id); window.setInterval = originalSet; window.clearInterval = originalClear; }
        });
        assert.deepEqual(handles, { afterStop: 0, afterDetach: 0 });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } catch (error) {
    if (process.env.FASTING_SCREENSHOT_DIR && currentPage && !currentPage.isClosed()) {
      try {
        mkdirSync(process.env.FASTING_SCREENSHOT_DIR, { recursive: true });
        await currentPage.screenshot({ path: process.env.FASTING_SCREENSHOT_DIR + '/failure.png' });
      } catch (screenshotError) { console.error('Diagnostic screenshot failed:', screenshotError.message); }
    }
    throw error;
  } finally { await harness.close(); }
});
