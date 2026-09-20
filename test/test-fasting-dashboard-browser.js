import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle } from './document-guards-harness.js';

test('dashboard fasting follows Health read-only access and pageshow refresh', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      await api.put('/preferences', { dashboard_widgets: [{ id: 'fasting', visible: true, size: '1x1', order: 0 }] });
    });
    await gotoRoute(page, '/');
    await page.waitForSelector('[data-fasting-widget-action]');
    assert.ok(await page.$('.fasting-widget [data-fasting-segments]'), 'Widget shares the segmented page dial');
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      await api.post('/health/fasting', { start_at: new Date(Date.now() - 60000).toISOString(), start_tzid: 'UTC', acknowledge_safety: true });
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction(() => document.querySelector('[data-fasting-widget-action]')?.textContent === 'Ukončit půst', { timeout: 5000 });
    await page.evaluate(async () => {
      const { setPermissions } = await import('/permissions.js');
      setPermissions({ modules: { health: 'read' }, capabilities: { health_use_fasting: 'allow' } });
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForFunction(() => !document.querySelector('[data-fasting-widget-action]'), { timeout: 5000 });
    assert.ok(await page.$('.fasting-widget'), 'read-only Health access keeps the timer visible');
    assert.equal(await page.$eval('.fasting-widget .form-hint', (el) => el.textContent.trim()), 'Deník půstu pouze pro čtení');
    assert.ok(await page.$('.fasting-widget [data-fasting-announcement]'), 'the ticking timer has a live announcement');
  } finally { await harness.close(); }
});

import { measureFasting } from './fasting-visual-harness.js';
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

test('dashboard controls preserve finish, saved mode and all four responsive sizes', async () => {
  const harness = await startHarness();
  try {
    for (const [device, theme] of [['desktop', 'light'], ['mobile', 'dark']]) {
      await harness.reset();
      const page = await openPage(harness, { device, theme, locale: 'cs' });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
        const { api } = await import('/api.js');
        return api[method](path, body);
      }, { method, path, body });
      await call('post', '/health/fasting', { start_at: '2025-01-01T06:00:00Z', end_at: '2025-01-01T08:00:00Z', start_tzid: 'UTC', acknowledge_safety: true });
      await call('post', '/health/fasting', { start_at: new Date(Date.now() - 3600000).toISOString(), start_tzid: 'UTC', goal_minutes: 1200 });
      await call('put', '/health/fasting/settings', { default_goal_minutes: 1200, clock_mode: 'elapsed', zone_mode: 'educational' });
      await gotoRoute(page, '/');
      // Add the widget through the same persisted preference contract as customization.
      await call('put', '/preferences', { dashboard_widgets: [{ id: 'fasting', visible: true, size: '1x1', order: 0 }] });
      await gotoRoute(page, '/');
      await page.waitForSelector('[data-fasting-widget-action]');
      assert.ok(await page.$('.fasting-widget .fasting-dial'));
      assert.ok(await page.$('.fasting-widget .fasting-dial__zone'), 'widget mirrors the Health educational dial');
      await clickFasting(page, '[data-fasting-clock-mode="remaining"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-clock-mode="remaining"]').getAttribute('aria-pressed') === 'true');
      assert.equal((await call('get', '/health/fasting/state')).data.settings.clock_mode, 'remaining');
      await clickFasting(page, '[data-fasting-widget-action]');
      await page.waitForSelector('[data-fasting-edit-form]');
      await settle(page);
      if (process.env.FASTING_SCREENSHOT_DIR) await page.screenshot({ path: process.env.FASTING_SCREENSHOT_DIR + '/' + device + '-dialog.png' });
      await page.click('.modal-panel [data-action="close-modal"]');
      await page.waitForFunction(() => !document.querySelector('.modal-panel'));
      assert.equal((await call('get', '/health/fasting/state')).data.active, null, 'closing review keeps the fast finished');
      await clickFasting(page, '[data-fasting-widget-action]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-widget-action]')?.textContent === 'Ukončit půst');
      assert.equal(await page.$('.modal-panel'), null);
      await settle(page);
      if (process.env.FASTING_SCREENSHOT_DIR) await page.screenshot({ path: process.env.FASTING_SCREENSHOT_DIR + '/' + device + '-widget.png', captureBeyondViewport: false });
      for (const size of ['1x1', '2x1', '1x2', '2x2']) {
        await page.$eval('.widget--fasting', (widget, size) => {
          const wrapper = widget.closest('.widget-wrapper');
          for (const name of [...wrapper.classList]) if (name.startsWith('widget-size--')) wrapper.classList.remove(name);
          wrapper.classList.add(`widget-size--${size}`);
        }, size);
        await settle(page);
        assert.equal(await page.$eval('.widget--fasting', (el) => el.scrollWidth > el.clientWidth + 1), false, `${device} ${size} must not overflow`);
        await measureFasting(page, '.widget--fasting', `${device}-widget-${size}`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await harness.close(); }
});
