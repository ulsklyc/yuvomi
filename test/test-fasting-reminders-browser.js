import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle } from './document-guards-harness.js';
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

test('reminder availability and help retain preferences across goal changes', async () => {
  const harness = await startHarness();
  try {
    for (const [device, theme] of [['desktop', 'light'], ['mobile', 'dark']]) {
      await harness.reset();
      const page = await openPage(harness, { device, theme, locale: 'cs' });
      const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
        const { api } = await import('/api.js');
        return api[method](path, body);
      }, { method, path, body });
      await call('post', '/health/fasting', { start_at: new Date(Date.now() - 3600000).toISOString(), start_tzid: 'UTC', goal_minutes: 960, acknowledge_safety: true });
      await call('put', '/health/fasting/settings', { remind_goal: true, remind_next_start: true });
      await gotoRoute(page, '/health/fasting'); await page.waitForSelector('[data-fasting-preset="custom"]');
      await clickFasting(page, '[data-fasting-preset="custom"]');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), false);
      assert.equal(await page.$eval('[data-fasting-preset="custom"]', (el) => el.getAttribute('aria-pressed')), 'true');
      await page.type('[data-fasting-goal]', '36');
      await page.$eval('[data-fasting-goal]', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForFunction(() => !document.querySelector('[data-fasting-goal]').disabled);
      assert.equal((await call('get', '/health/fasting/state')).data.settings.default_goal_minutes, 2160);
      assert.equal(await page.$eval('[data-fasting-remind-next]', (el) => el.disabled), true);
      assert.equal(await page.$eval('[data-fasting-remind-goal]', (el) => el.disabled), false);
      await page.focus('.fasting-notifications yuvomi-fasting-help button');
      await page.waitForSelector('.fasting-notifications [role="tooltip"]:popover-open');
      assert.match(await page.$eval('.fasting-notifications [role="tooltip"]', (el) => el.textContent), /24/);
      assert.equal(await page.$eval('.fasting-notifications [role="tooltip"]', (el) => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.$('.fasting-notifications [role="tooltip"]:popover-open'), null);
      await clickFasting(page, '[data-fasting-preset=""]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset=""]').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.$eval('[data-fasting-remind-goal]', (el) => el.disabled), true);
      await clickFasting(page, '[data-fasting-preset="16"]');
      await page.waitForFunction(() => document.querySelector('[data-fasting-preset="16"]').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), true);
      assert.equal((await call('get', '/health/fasting/state')).data.settings.remind_goal, 1);
      assert.equal((await call('get', '/health/fasting/state')).data.settings.remind_next_start, 1);
      await page.close();
    }
  } finally { await harness.close(); }
});
