import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute } from './document-guards-harness.js';
import { captureFastingViewport } from './fasting-visual-harness.js';

// Die Statistik erscheint seit R14 (Re-Critique 2026-09-28, A6 P2-1) erst ab
// dem ersten abgeschlossenen Fasten - vorher standen neun Nullen und sieben
// leere Wochenkaesten da. Die Proben legen deshalb ein Fasten AUSSERHALB der
// gezeigten Woche an: die Statistik steht, und jeder Tag der Woche ist ohne
// Eintrag - genau der Zustand, den "Bez zaznamu" beschreibt.
const seedFastOutsideWeek = (page) => page.evaluate(async () => {
  const { api } = await import('/api.js');
  const start = new Date(Date.now() - 40 * 86400000);
  await api.post('/health/fasting', {
    start_at: start.toISOString(), end_at: new Date(start.getTime() + 3600000).toISOString(),
    start_tzid: 'UTC', acknowledge_safety: true,
  });
});

test('weekly chart distinguishes absent records and captured goals', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fasting-action]');
    assert.equal(await page.$('.fasting-stats'), null, 'ohne ein Fasten keine Statistik aus Nullen');
    await seedFastOutsideWeek(page);
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
      const stats = (await api.get('/health/fasting/stats')).data;
      const { zonedFields, wallTimeInstant } = await import('/utils/timezone.js');
      const now = zonedFields(new Date(), stats.display_tzid);
      const previous = new Date(Date.UTC(now.year, now.month - 1, now.day) - 86400000);
      const date = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`;
      await api.post('/health/fasting', {
        start_at: wallTimeInstant(`${date}T10:00:00`, stats.display_tzid),
        end_at: wallTimeInstant(`${date}T11:00:00`, stats.display_tzid),
        start_tzid: stats.display_tzid, goal_minutes: 60, acknowledge_safety: true,
      });
      await api.post('/health/fasting', {
        start_at: wallTimeInstant(`${date}T12:00:00`, stats.display_tzid),
        end_at: wallTimeInstant(`${date}T13:00:00`, stats.display_tzid),
        start_tzid: stats.display_tzid, goal_minutes: null, acknowledge_safety: true,
      });
      await api.put('/health/fasting/settings', { default_goal_minutes: 1200 });
      return (await api.get('/health/fasting/stats')).data;
    });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('.fasting-week__goal');
    const mixedDay = data.weekly.find((day) => day.hasRecord);
    assert.equal(mixedDay.count, 2);
    assert.equal(mixedDay.goalMinutes, 60);
    assert.equal(mixedDay.goalCount, 1);
    const mixedDayValue = await page.$$eval('.fasting-week__day', (days, date) => days.find((day) => day.querySelector('time')?.dateTime === date)?.querySelector(':scope > span:first-child')?.textContent.trim() || '', mixedDay.date);
    const mixedDayText = await page.$$eval('.fasting-week__day', (days, date) => days.find((day) => day.querySelector('time')?.dateTime === date)?.textContent || '', mixedDay.date);
    assert.equal(mixedDayValue, '2 h');
    assert.match(mixedDayText, /Zaznamenaný cíl: 1 h/);
    assert.match(mixedDayText, /Cíl zaznamenán u 1 z 2 půstů/);
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
    const seededDate = await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const stats = (await api.get('/health/fasting/stats')).data;
      const { zonedFields, wallTimeInstant } = await import('/utils/timezone.js');
      const now = zonedFields(new Date(), stats.display_tzid);
      const previous = new Date(Date.UTC(now.year, now.month - 1, now.day) - 86400000);
      const date = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`;
      await api.post('/health/fasting', {
        start_at: wallTimeInstant(`${date}T06:00:00`, stats.display_tzid),
        end_at: wallTimeInstant(`${date}T08:00:00`, stats.display_tzid),
        start_tzid: stats.display_tzid,
        acknowledge_safety: true,
      });
      return date;
    });
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('.fasting-week__day');
    assert.equal(await page.$$eval('.fasting-week__day time', (els) => els.filter((el) => el.textContent.trim()).length), 7);
    assert.equal(await page.$$eval('.fasting-week__day > span:first-child', (els) => els.filter((el) => el.textContent.trim()).length), 7);
    const seededDayValue = await page.$$eval('.fasting-week__day', (days, date) => days.find((day) => day.querySelector('time')?.dateTime === date)?.querySelector(':scope > span:first-child')?.textContent.trim() || '', seededDate);
    assert.equal(seededDayValue, '2 h');
  } finally { await harness.close(); }
});

test('Arabic weekly series retain the left-right legend order', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', theme: 'light', locale: 'ar' });
    await seedFastOutsideWeek(page);
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('.fasting-week__track');
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
    assert.equal(await page.$eval('.fasting-week__track', (el) => getComputedStyle(el).direction), 'ltr', 'Series order matches the left/right legend in RTL');
  } finally { await harness.close(); }
});
