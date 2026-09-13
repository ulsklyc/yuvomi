import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';
import { captureFastingViewport } from './fasting-visual-harness.js';

test('weekly chart distinguishes absent records and captured goals', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('.fasting-week');
    assert.match(await page.$eval('.fasting-week', (el) => el.textContent), /Bez záznamu/);
    assert.ok(await page.$('[data-fasting-goal-legend]'));
    await page.focus('yuvomi-fasting-help:has([data-fasting-goal-legend]) button');
    await page.waitForSelector('[data-fasting-goal-legend]:popover-open');
    assert.match(await page.$eval('[data-fasting-goal-legend]', (el) => el.textContent), /vlevo.*vpravo/);
    assert.equal(await page.$eval('[data-fasting-goal-legend]', (el) => {
      const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('[data-fasting-goal-legend]:popover-open'), null);
    assert.ok(await page.$eval('.fasting-stat strong', (el) => parseFloat(getComputedStyle(el).fontSize) >= 20), 'metric values use Title 3 or larger');
    const data = await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const end = new Date(), start = new Date(end.getTime() - 18 * 3600000);
      await api.post('/health/fasting', { start_at: start.toISOString(), end_at: end.toISOString(), start_tzid: 'UTC', goal_minutes: 960, acknowledge_safety: true });
      await api.put('/health/fasting/settings', { default_goal_minutes: 1200 });
      return (await api.get('/health/fasting/stats')).data;
    });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('.fasting-week__goal');
    assert.equal(data.weekly.find((day) => day.hasRecord).goalMinutes, 960);
    assert.match(await page.$eval('.fasting-week', (el) => el.textContent), /18 h/);
    assert.match(await page.$eval('.fasting-week', (el) => el.textContent), /Zaznamenaný cíl: 16 h/);
    const baselines = await page.$$eval('.fasting-week__track', (els) => els.map((el) => el.getBoundingClientRect().bottom));
    assert.ok(Math.max(...baselines) - Math.min(...baselines) <= 1, 'Wrapped labels must not move the chart baseline');
    await captureFastingViewport(page, '.fasting-stats', 'mobile-cs-stats');
    await captureFastingViewport(page, '.fasting-week__title', 'mobile-cs-week');
  } finally { await harness.close(); }
});

test('weekly dates and values remain visible for every bucket', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      await api.post('/health/fasting', { start_at: '2025-01-01T06:00:00Z', end_at: '2025-01-01T08:00:00Z', start_tzid: 'UTC', acknowledge_safety: true });
    });
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('.fasting-week__day');
    assert.equal(await page.$$eval('.fasting-week__day time', (els) => els.filter((el) => el.textContent.trim()).length), 7);
    assert.equal(await page.$$eval('.fasting-week__day > span:first-child', (els) => els.filter((el) => el.textContent.trim()).length), 7);
  } finally { await harness.close(); }
});

test('Arabic weekly series retain the left-right legend order', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'ar' });
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('.fasting-week__track');
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
    assert.equal(await page.$eval('.fasting-week__track', (el) => getComputedStyle(el).direction), 'ltr', 'Series order matches the left/right legend in RTL');
  } finally { await harness.close(); }
});
