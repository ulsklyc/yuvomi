import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openPage, gotoRoute, settle } from './document-guards-harness.js';
import { measureFasting } from './fasting-visual-harness.js';

const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/api.js');
  return api[method](path, body);
}, { method, path, body });
const fill = (page, selector, value) => page.$eval(selector, (el, next) => {
  el.value = next; el.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

test('retired clock writes cannot repaint another subject or a refreshed same-root clock', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fasting-clock-mode]');
    const results = await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const { startFastingClock, fastingClockSwitchHtml } = await import('/components/fasting-controls.js');
      const root = document.createElement('section'); document.body.append(root);
      const markup = () => `${fastingClockSwitchHtml()}<span data-fasting-timer></span><span data-fasting-segments></span><select data-fasting-clock-default><option>elapsed</option><option>remaining</option></select>`;
      const put = api.put, toast = window.yuvomi.showToast;
      let toasts = 0;
      window.yuvomi.showToast = () => { toasts++; };
      const checks = [];
      try {
        for (const replacement of ['subject', 'refresh']) for (const reject of [false, true]) {
          root.innerHTML = markup();
          let settle;
          api.put = () => new Promise((resolve, fail) => { settle = () => reject ? fail(new Error('late failure')) : resolve({ data: { clock_mode: 'remaining' } }); });
          const stopOld = startFastingClock(root, { start_at: new Date(Date.now() - 48 * 3600000).toISOString(), goal_minutes: 60 }, null);
          root.querySelector('[data-fasting-clock-mode="remaining"]').click();
          stopOld();
          root.innerHTML = markup();
          const stopNew = startFastingClock(root, { start_at: new Date(Date.now() - 3600000).toISOString(), goal_minutes: null }, null, { clock_mode: 'elapsed' }, { writable: replacement !== 'subject' });
          const before = root.innerHTML;
          settle(); await new Promise((resolve) => setTimeout(resolve, 0));
          checks.push({ replacement, reject, unchanged: before === root.innerHTML, toasts });
          stopNew();
        }
      } finally { api.put = put; window.yuvomi.showToast = toast; root.remove(); }
      return checks;
    });
    assert.deepEqual(results.map(({ unchanged, toasts }) => ({ unchanged, toasts })), Array.from({ length: 4 }, () => ({ unchanged: true, toasts: 0 })));
  } finally { await harness.close(); }
});

test('year zero and BCE records display faithfully and date edits are explicitly read-only', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    for (const year of ['0000', '-000001', '-200000']) {
      const row = (await call(page, 'post', '/health/fasting', { start_at: `${year}-06-01T12:00:00.123Z`, end_at: `${year}-06-01T13:00:00.123Z`, start_tzid: 'UTC', acknowledge_safety: true })).data;
      await gotoRoute(page, '/health/fasting'); await page.waitForSelector('[data-fast-edit]');
      await page.evaluate(async (row) => {
        const { openFastingEditor, fastingStamp } = await import('/components/fasting-controls.js');
        window.fastingYearStamp = fastingStamp(row.start_at, 'UTC');
        openFastingEditor(row, async () => {});
      }, row);
      await page.waitForSelector('#fast-start'); await settle(page);
      assert.match(await page.evaluate(() => window.fastingYearStamp), new RegExp(`^${year}`));
      assert.deepEqual(await page.$eval('#fast-start', (el) => ({ type: el.type, readOnly: el.readOnly, value: el.value })), { type: 'text', readOnly: true, value: row.start_at });
      assert.ok(await page.$eval('[data-fasting-date-readonly]', (el) => el.textContent.trim()));
      await fill(page, '#fast-start', '0001-06-01T12:05:00');
      await page.click('.modal-panel [type="submit"]');
      assert.ok(await page.$eval('[data-fasting-edit-error]', (el) => el.textContent.trim()));
      await fill(page, '#fast-start', row.start_at);
      await fill(page, '#fast-note', 'Unchanged ancient date');
      await page.click('.modal-panel [type="submit"]');
      await page.waitForFunction(() => !document.querySelector('.modal-panel'));
      const saved = (await call(page, 'get', '/health/fasting/history')).data.find((item) => item.id === row.id);
      assert.equal(saved.start_at, row.start_at); assert.equal(saved.end_at, row.end_at);
      assert.equal(saved.note, 'Unchanged ancient date');
    }
  } finally { await harness.close(); }
});

test('journal earlier start, active edit, recorded target, end undo and manual history', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'desktop', locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fasting-action]');
    assert.ok(await page.$('[data-fasting-earlier]'), 'earlier start is available');
    await call(page, 'post', '/health/fasting/acknowledge-safety', {});
    await call(page, 'put', '/health/visibility-defaults', { defaults: { fasting: 'family' } });
    await page.click('[data-fasting-earlier]');
    await page.waitForSelector('[data-fasting-edit-form]');
    assert.equal(await page.$eval('#fast-visibility', (el) => el.value), 'family');
    await fill(page, '#fast-start', '2025-10-26T02:30:00');
    await page.click('.modal-panel [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    let active = (await call(page, 'get', '/health/fasting/state')).data.active;
    assert.ok(active && !active.end_at);
    await page.click('[data-fasting-edit-start]');
    await page.waitForSelector('#fast-start');
    await fill(page, '#fast-start', '2025-10-26T02:35:00');
    await page.click('.modal-panel [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    const edited = (await call(page, 'get', '/health/fasting/state')).data.active;
    assert.equal(Date.parse(edited.start_at) - Date.parse(active.start_at), 300000);
    assert.equal(edited.end_at, null);
    await page.click('[data-fasting-preset="16"]');
    await page.waitForFunction(() => document.querySelector('[data-fasting-preset="16"]')?.getAttribute('aria-pressed') === 'true');
    assert.ok(await page.$('[data-fasting-target]'));
    const target16 = await page.$eval('[data-fasting-target]', (el) => el.textContent);
    await page.click('[data-fasting-preset="20"]');
    await page.waitForFunction((value) => document.querySelector('[data-fasting-target]')?.textContent !== value, {}, target16);
    assert.equal((await call(page, 'get', '/health/fasting/state')).data.active.start_at, edited.start_at);
    await page.click('[data-fasting-preset=""]');
    await page.waitForFunction(() => !document.querySelector('[data-fasting-target]'));
    await page.click('[data-fasting-action]');
    await page.waitForSelector('[data-fasting-edit-form]');
    await page.click('.modal-panel [data-action="close-modal"]');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    assert.equal((await call(page, 'get', '/health/fasting/state')).data.active, null);
    await page.click('.toast__undo');
    await page.waitForFunction(() => document.querySelector('[data-fasting-edit-start]'));
    active = (await call(page, 'get', '/health/fasting/state')).data.active;
    assert.equal(active.id, edited.id);
    assert.ok(await page.$('[data-fasting-backfill]'));
    assert.ok(await page.$('[data-fasting-from]'));
    await page.click('[data-fasting-backfill]');
    await page.waitForSelector('#fast-start'); await settle(page);
    await fill(page, '#fast-start', '2025-01-01T06:00:00');
    await fill(page, '#fast-end', '2025-01-01T08:00:00');
    await page.click('.modal-panel [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    assert.equal((await call(page, 'get', '/health/fasting/state')).data.active.id, active.id, 'Backfill does not replace active record');
    await fill(page, '[data-fasting-from]', '2025-01-02');
    await fill(page, '[data-fasting-to]', '2025-01-01');
    await page.click('[data-fasting-filters] [type="submit"]');
    assert.ok(await page.$eval('[data-fasting-filter-error]', (el) => el.textContent));
    await fill(page, '[data-fasting-from]', '2025-01-01');
    await page.click('[data-fasting-filters] [type="submit"]');
    await page.waitForFunction(() => document.querySelector('a[download]')?.href.includes('from=2025-01-01'));
    assert.equal(await page.$$eval('[data-fast-edit]', (els) => els.length), 1);
    assert.match(await page.$eval('a[download]', (el) => el.href), /from=2025-01-01&to=2025-01-01/);
  } finally { await harness.close(); }
});

test('delete expiry and failed pagehide flush settle pending identity; stale Undo end conflicts visibly', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await call(page, 'post', '/health/fasting', { start_at: '2025-01-01T00:00Z', end_at: '2025-01-01T01:00Z', start_tzid: 'UTC', acknowledge_safety: true });
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('[data-fast-delete]');
    await page.evaluate(async () => {
      const { api } = await import('/api.js'); const remove = api.delete;
      window.fastingRestoreDelete = () => { api.delete = remove; };
      api.delete = async (path, options) => { window.fastingKeepalive = options.keepalive; throw new Error('Unavailable'); };
    });
    await page.click('[data-fast-delete]');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForSelector('[data-fast-delete]');
    assert.equal(await page.evaluate(() => window.fastingKeepalive), true);
    await page.evaluate(() => { window.fastingRestoreDelete(); window.dispatchEvent(new Event('pageshow')); });
    await page.waitForSelector('[data-fast-delete]'); await settle(page);
    // The failure toast temporarily covers the mobile history button.
    await page.waitForFunction(() => !document.querySelector('.toast'));
    const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().includes('/health/fasting/')).catch(() => null);
    await page.click('[data-fast-delete]');
    assert.equal(await page.$('[data-fast-delete]'), null, 'Expiry deletion was actually scheduled by the rendered control');
    assert.equal((await deleted).status(), 204);
    assert.equal((await call(page, 'get', '/health/fasting/history')).data.length, 0, await page.$$eval('.toast', (els) => els.map((el) => el.textContent).join(' | ')));
    await settle(page);
    await page.click('[data-fasting-action]'); await page.waitForSelector('[data-fasting-edit-start]');
    await page.click('[data-fasting-action]'); await page.waitForSelector('[data-fasting-edit-form]');
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const row = (await api.get('/health/fasting/history')).data[0];
      await api.patch(`/health/fasting/${row.id}`, { expected_revision: row.revision, note: 'Newer revision' });
      document.querySelector('.toast__undo').click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('změnil')));
    assert.equal((await call(page, 'get', '/health/fasting/state')).data.active, null);
  } finally { await harness.close(); }
});

test('denied family views clear private data, retain filters, and discard late subject responses', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await call(page, 'post', '/health/fasting', { start_at: '2025-01-01T00:00Z', end_at: '2025-01-01T01:00Z', start_tzid: 'UTC', note: 'SELF PRIVATE', acknowledge_safety: true });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fast-edit]');
    const self = await page.$eval('[data-fasting-person]', (el) => el.value);
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const get = api.get;
      window.fastingRestoreGet = () => { api.get = get; };
      api.get = async (path, ...args) => {
        if (path.includes('user_id=9999')) throw new Error('Forbidden');
        if (path.includes('user_id=9998')) {
          const response = await get(path.replace('?user_id=9998', ''), ...args);
          if (path.includes('/state')) await new Promise((resolve) => { window.fastingReleaseA = resolve; });
          return response;
        }
        return get(path, ...args);
      };
      const select = document.querySelector('[data-fasting-person]');
      select.add(new Option('Denied', '9999')); select.add(new Option('Delayed', '9998'));
    });
    await page.select('[data-fasting-person]', '9999');
    await page.waitForSelector('[data-fasting-retry]');
    assert.equal(await page.$('[data-fast-edit]'), null);
    assert.equal(await page.$('[data-fasting-action]'), null);
    assert.equal(await page.$('a[download]'), null);
    assert.ok(await page.$('[data-fasting-filters]'));
    assert.equal(await page.$eval('[data-fasting-body]', (el) => el.textContent.includes('SELF PRIVATE')), false);
    await page.select('[data-fasting-person]', self);
    await page.waitForSelector('[data-fast-edit]');
    await page.evaluate(() => document.querySelector('[data-fasting-person]').add(new Option('Delayed', '9998')));
    await page.select('[data-fasting-person]', '9998');
    await page.waitForFunction(() => typeof window.fastingReleaseA === 'function');
    await page.select('[data-fasting-person]', self);
    await page.waitForSelector('[data-fast-edit]');
    await page.evaluate(() => { window.fastingReleaseA(); window.fastingRestoreGet(); });
    await settle(page);
    assert.equal(await page.$eval('[data-fasting-person]', (el) => el.value), self);
    assert.ok(await page.$('[data-fasting-action]'));
    await page.evaluate(async () => {
      const { setPermissions } = await import('/permissions.js');
      const { mountFasting } = await import('/pages/health-fasting.js');
      setPermissions({ modules: { health: 'read' } });
      await mountFasting(document.querySelector('[data-fasting-root]'));
    });
    assert.equal(await page.$('[data-fasting-action]'), null);
    assert.equal(await page.$('[data-fast-edit]'), null);
    assert.equal(await page.$('[data-fasting-preferences]'), null);
  } finally { await harness.close(); }
});

test('family reading renders API-redacted state and remains read-only even with a caregiver grant', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' });
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('[data-fasting-action]');
    const self = Number(await page.$eval('[data-fasting-person]', (el) => el.value));
    const members = (await call(page, 'get', '/family/members')).data;
    const member = members.find((entry) => entry.id !== self);
    await call(page, 'put', `/health/caregivers/${member.id}`, { caregiver_ids: [self] });
    await call(page, 'post', '/health/fasting', { user_id: member.id, start_at: '2025-01-01T00:00Z', end_at: '2025-01-01T01:00Z', start_tzid: 'UTC', visibility: 'family', note: 'FAMILY SHARED', acknowledge_safety: true });
    await page.select('[data-fasting-person]', String(member.id));
    await page.waitForFunction(() => document.querySelector('[data-fasting-history]')?.textContent.includes('FAMILY SHARED'));
    assert.equal((await call(page, 'get', `/health/fasting/state?user_id=${member.id}`)).data.canWrite, true);
    assert.equal(await page.$('[data-fasting-action]'), null);
    assert.equal(await page.$('[data-fast-edit]'), null);
    assert.equal(await page.$('[data-fasting-preferences]'), null);
    await call(page, 'put', `/health/caregivers/${member.id}`, { caregiver_ids: [] });
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(() => document.querySelector('[data-fasting-history]')?.textContent.includes('FAMILY SHARED'));
    assert.equal((await call(page, 'get', `/health/fasting/state?user_id=${member.id}`)).data.settings, null);
    assert.match(await page.$eval('a[download]', (el) => el.href), new RegExp(`user_id=${member.id}`));
    await page.select('[data-fasting-person]', String(self)); await page.waitForSelector('[data-fasting-action]');
  } finally { await harness.close(); }
});

test('a failed own-person write cannot update a switched or detached subject panel', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'cs' }), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await call(page, 'post', '/health/fasting/acknowledge-safety', {});
    await gotoRoute(page, '/health/fasting'); await page.waitForSelector('[data-fasting-action]');
    await page.evaluate(async () => {
      const { api } = await import('/api.js'); const post = api.post;
      api.post = async (path, ...args) => {
        if (path !== '/health/fasting') return post(path, ...args);
        await new Promise((resolve) => { window.fastingRejectWrite = resolve; });
        api.post = post; throw new Error('Unavailable');
      };
    });
    await page.click('[data-fasting-action]');
    await page.waitForFunction(() => typeof window.fastingRejectWrite === 'function');
    await page.evaluate(() => {
      const root = document.querySelector('[data-fasting-root]');
      window.fastingDetachedRoot = root; root.remove(); window.fastingRejectWrite();
    });
    await settle(page);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.fastingDetachedRoot.querySelector('[data-fasting-error]').textContent), '');
  } finally { await harness.close(); }
});

test('recorded-zone completed editor preserves the second DST occurrence and rejects gap', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { locale: 'de' });
    const { data: row } = await call(page, 'post', '/health/fasting', {
      start_at: '2025-10-26T01:30:00.123Z', end_at: '2025-10-26T03:00:00.456Z',
      start_tzid: 'Europe/Prague', acknowledge_safety: true,
    });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fast-edit]');
    await page.click(`[data-fast-edit="${row.id}"]`);
    await page.waitForSelector('#fast-start');
    assert.equal(await page.$eval('#fast-start', (el) => el.value), '2025-10-26T02:30');
    await settle(page);
    await fill(page, '#fast-start', '2025-10-26T02:35:00');
    await page.click('.modal-panel [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    const saved = (await call(page, 'get', '/health/fasting/history')).data[0];
    assert.equal(saved.start_at, '2025-10-26T01:35:00.000Z');
    assert.equal(saved.end_at, row.end_at);
    assert.equal(saved.start_tzid, 'Europe/Prague');
    await page.click(`[data-fast-edit="${row.id}"]`);
    await page.waitForSelector('#fast-start');
    await fill(page, '#fast-start', '2025-03-30T02:30:00');
    await settle(page);
    await page.click('.modal-panel [type="submit"]');
    await settle(page);
    assert.ok(await page.$eval('[data-fasting-edit-error]', (el) => el.textContent));
  } finally { await harness.close(); }
});

test('family selector, offline resume and undo deletion survive route remount', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', theme: 'dark', locale: 'cs' });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fasting-action]');
    assert.ok(await page.$('[data-fasting-person]'), 'family selector remains available');
    await call(page, 'post', '/health/fasting', { start_at: '2025-01-01T00:00Z', end_at: '2025-01-01T01:00Z', start_tzid: 'UTC', acknowledge_safety: true });
    await gotoRoute(page, '/health/fasting');
    await page.waitForSelector('[data-fast-delete]');
    await page.click('[data-fast-delete]');
    await page.evaluate(async () => {
      const { mountFasting } = await import('/pages/health-fasting.js');
      const old = document.querySelector('[data-fasting-root]');
      const root = document.createElement('div'); root.dataset.fastingRoot = '';
      old.replaceWith(root); await mountFasting(root);
    });
    await page.waitForSelector('[data-fasting-action]');
    assert.equal(await page.$('[data-fast-delete]'), null, 'pending delete stays hidden after remount');
    await page.click('.toast__undo');
    await page.waitForSelector('[data-fast-delete]');
    await page.click('[data-fasting-action]');
    await page.waitForSelector('[data-fasting-edit-start]');
    await page.click('[data-fasting-clock-mode="elapsed"]');
    const before = await page.$eval('[data-fasting-timer]', (el) => el.textContent);
    await page.setOfflineMode(true);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction((value) => document.querySelector('[data-fasting-timer]')?.textContent !== value, {}, before);
    assert.ok(await page.$('[data-fasting-edit-start]'));
    await page.setOfflineMode(false);
    const active = (await call(page, 'get', '/health/fasting/state')).data.active;
    await call(page, 'post', `/health/fasting/${active.id}/finish`, { expected_revision: active.revision });
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(() => !document.querySelector('[data-fasting-edit-start]'));
    assert.ok(await page.$('[data-fasting-earlier]'), 'Successful resume replaces stale active state');
  } finally { await harness.close(); }
});

test('journal educational dial and controls meet rendered AA, RTL and reduced-motion boundaries', async () => {
  const harness = await startHarness();
  try {
    for (const [device, theme, locale] of [['desktop', 'light', 'de'], ['mobile', 'dark', 'cs'], ['mobile', 'light', 'ar']]) {
      await harness.reset();
      const page = await openPage(harness, { device, theme, locale });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await call(page, 'post', '/health/fasting', { start_at: new Date(Date.now() - 18 * 3600000).toISOString(), start_tzid: 'Europe/Prague', goal_minutes: 960, acknowledge_safety: true });
      await call(page, 'put', '/health/fasting/settings', { zone_mode: 'educational' });
      await gotoRoute(page, '/health/fasting');
      await page.waitForSelector('[data-fasting-education]');
      assert.equal(await page.$$eval('.fasting-dial__zone', (els) => els.length), 3);
      const announcement = await page.$eval('[data-fasting-announcement]', (el) => el.textContent);
      const help = 'yuvomi-fasting-help button';
      await page.waitForSelector(help);
      assert.equal(await page.$$eval('yuvomi-fasting-help [role="tooltip"]', (els) => els.every((el) => !el.matches(':popover-open'))), true);
      await page.$eval(help, (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.focus(help);
      await page.waitForSelector('yuvomi-fasting-help [role="tooltip"]:popover-open');
      const firstHelp = await page.$eval('yuvomi-fasting-help [role="tooltip"]:popover-open', (el) => el.textContent);
      assert.ok(firstHelp.length > 30, 'Full goal explanation remains available');
      await page.keyboard.press('Escape');
      assert.equal(await page.$('yuvomi-fasting-help [role="tooltip"]:popover-open'), null);
      await page.click(help);
      await page.waitForSelector('yuvomi-fasting-help [role="tooltip"]:popover-open');
      await measureFasting(page, 'yuvomi-fasting-help:has([role="tooltip"]:popover-open)', `${device}-${locale}-help`, { viewport: true });
      const bounds = await page.$eval('yuvomi-fasting-help [role="tooltip"]:popover-open', (el) => {
        const r = el.getBoundingClientRect();
        return { contained: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, linked: el.id === el.previousElementSibling.getAttribute('aria-describedby') };
      });
      assert.deepEqual(bounds, { contained: true, linked: true });
      await page.click(help);
      assert.equal(await page.$('yuvomi-fasting-help [role="tooltip"]:popover-open'), null, 'Second tap closes pinned help');
      await page.keyboard.press('Enter');
      await page.waitForSelector('yuvomi-fasting-help [role="tooltip"]:popover-open');
      await page.keyboard.press('Escape');
      assert.equal(await page.$$eval('yuvomi-fasting-help [role="tooltip"]', (els) => new Set(els.map((el) => el.id)).size === els.length), true);
      assert.equal(await page.evaluate(async () => {
        const { fastingHelpHtml } = await import('/components/fasting-help.js');
        const container = document.createElement('div');
        container.innerHTML = fastingHelpHtml('Cleanup', ['Original explanation']);
        document.body.append(container); container.querySelector('button').focus();
        container.remove();
        let propagated = false;
        const listener = () => { propagated = true; };
        window.addEventListener('keydown', listener, { once: true });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        window.removeEventListener('keydown', listener);
        return propagated && !document.querySelector('yuvomi-fasting-help [role="tooltip"]:popover-open');
      }), true, 'Disconnected help removes global Escape handlers and its top-layer content');
      await measureFasting(page, '.fasting-container', `${device}-${locale}-page`);
      await page.focus('[data-fasting-education]'); await page.keyboard.press('Enter');
      await page.waitForSelector('.modal-panel'); await settle(page);
      await measureFasting(page, '.modal-panel', `${device}-${locale}-education`);
      assert.equal(await page.$eval('[data-fasting-announcement]', (el) => el.textContent), announcement, 'Seconds do not chatter in live region');
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
      if (locale === 'ar') {
        assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
      }
      await page.close();
    }
  } finally { await harness.close(); }
});
