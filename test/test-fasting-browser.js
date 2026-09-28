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
// Die Fasten-Einstellungen (Ziel, Uhr, Erinnerungen) stehen seit R14 (Re-Critique
// 2026-09-28, A6 P2-1) in einem Blatt hinter dem Zahnrad im Hero, nicht mehr
// mitten im Inhalt; das Ziel ist die Kanon-Segmentleiste (role=radio,
// aria-checked, "Ohne Ziel" = `none`). Die Proben oeffnen das Blatt, pruefen
// dort dieselbe Regel wie vorher und schliessen es wieder.
async function openFastingSettings(page) {
  if (await page.$('.modal-panel [data-fasting-preferences]')) return;
  await clickFasting(page, '[data-fasting-settings]');
  await page.waitForSelector('.modal-panel [data-fasting-preferences] [data-fasting-preset]');
  await settle(page);
}
async function closeFastingSettings(page) {
  await page.click('.modal-panel [data-action="close-modal"]');
  await page.waitForFunction(() => !document.querySelector('.modal-panel'));
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
      await page.waitForSelector('[data-fasting-settings]');
      assert.equal(await page.$('[data-fasting-body] [data-fasting-preferences]'), null, 'die Einstellungen stehen nicht im Inhalt');
      await openFastingSettings(page);
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), true);
      await clickFasting(page, '[data-fasting-preset="15"]');
      await page.waitForFunction(() => (() => { const el = document.querySelector('[data-fasting-preset="15"]'); return el?.getAttribute('aria-checked') === 'true' && !el.disabled; })());
      assert.equal((await call('get', '/health/fasting/state')).data.settings.default_goal_minutes, 900);
      assert.equal(await page.$eval('[data-fasting-preset="15"]', (el) => el === document.activeElement), true);
      assert.equal(await page.$eval('[data-fasting-preferences-status]', (el) => el.textContent), 'Uloženo');
      await clickFasting(page, '[data-fasting-preset="custom"]');
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), false);
      assert.equal(await page.$eval('[data-fasting-preset="custom"]', (el) => el.getAttribute('aria-checked')), 'true');
      await page.type('[data-fasting-goal]', '36');
      await page.$eval('[data-fasting-goal]', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForFunction(() => !document.querySelector('[data-fasting-goal]').disabled);
      assert.equal((await call('get', '/health/fasting/state')).data.settings.default_goal_minutes, 2160);
      await clickFasting(page, '[data-fasting-preset="none"]');
      await page.waitForFunction(() => (() => { const el = document.querySelector('[data-fasting-preset="none"]'); return el?.getAttribute('aria-checked') === 'true' && !el.disabled; })());
      await clickFasting(page, '[data-fasting-preset="16"]');
      await page.waitForFunction(() => (() => { const el = document.querySelector('[data-fasting-preset="16"]'); return el?.getAttribute('aria-checked') === 'true' && !el.disabled; })());
      assert.equal(await page.$eval('[data-fasting-custom]', (el) => el.hidden), true);
      await closeFastingSettings(page);
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
      await openFastingSettings(page);
      await clickFasting(page, '[data-fasting-preset="20"]');
      await page.waitForFunction(() => (() => { const el = document.querySelector('[data-fasting-preset="20"]'); return el?.getAttribute('aria-checked') === 'true' && !el.disabled; })());
      assert.equal((await call('get', '/health/fasting/state')).data.active.goal_minutes, 1200);
      await closeFastingSettings(page);
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

// R10 G1 (Re-Critique 2026-09-27, A6 P1-1): die neun Tabs sind weg, die
// Uebersicht ist die Navigation. Echter Browser, echte API: jeder Bereich hat
// seine Adresse, alte `?tab=`-Links landen dort, mobil schiebt ein Bereich die
// Uebersicht weg (Titel = Bereich, Rueckweg im Kopf), am Desktop stehen Liste
// und Bereich nebeneinander - und Fasten starten/beenden bleibt erreichbar.
test('health areas: every area has its address, old ?tab= links redirect, fasting stays reachable', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'mobile', locale: 'de' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
      const { api } = await import('/api.js');
      return api[method](path, body);
    }, { method, path, body });
    const shown = () => page.evaluate(() => ({
      path: location.pathname + location.search,
      panels: [...document.querySelectorAll('[data-health-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.healthPanel),
      title: document.querySelector('.health-toolbar .page-toolbar__title')?.textContent,
      back: document.querySelector('.health-toolbar__back')?.hidden === false,
      tabBars: document.querySelectorAll('.sub-tabs-bar, .health-tabs-bar').length,
    }));

    // Mobil: die alte Adresse landet im Bereich, der Kopf nennt ihn und fuehrt zurueck.
    await gotoRoute(page, '/health?tab=fasting');
    await page.waitForSelector('[data-fasting-action]');
    assert.deepEqual(await shown(), { path: '/health/fasting', panels: ['/health/fasting'], title: 'Fasten', back: true, tabBars: 0 });

    // Zurueck zur Uebersicht: dort steht die Liste aller Bereiche.
    await page.click('.health-toolbar__back');
    await page.waitForFunction(() => location.pathname === '/health');
    assert.deepEqual(await shown(), { path: '/health', panels: ['/health'], title: 'Gesundheit', back: false, tabBars: 0 });
    const ids = await page.$$eval('.health-areas__list [data-md-id]', (rows) => rows.map((row) => row.dataset.mdId));
    for (const id of ['vitals', 'fasting', 'meds', 'prevention', 'labs', 'activity', 'nutrition']) {
      assert.ok(ids.includes(id), `Bereich ${id} fehlt in "Alle Bereiche": ${ids.join(', ')}`);
    }

    // Fasten ueber die Liste erreichen, starten und beenden.
    await clickFasting(page, '.health-areas__list [data-md-id="fasting"]');
    await page.waitForFunction(() => location.pathname === '/health/fasting');
    await page.waitForSelector('[data-fasting-action]');
    // Das Fasten-Panel zeichnet nach dem ersten Bild noch einmal (Statistik):
    // erst nach der Ruhe steht der Knopf, der geklickt wird.
    await settle(page);
    await clickFasting(page, '[data-fasting-action]');
    await page.waitForSelector('.modal-panel');
    await settle(page);
    await page.click('.modal-panel .btn--primary');
    await page.waitForFunction(() => !document.querySelector('.modal-panel'));
    assert.ok((await call('get', '/health/fasting/state')).data.active, 'Fasten laeuft');
    await clickFasting(page, '[data-fasting-action]');
    await page.waitForSelector('[data-fasting-edit-form]');
    assert.equal((await call('get', '/health/fasting/state')).data.active, null, 'Fasten beendet');
    await page.$eval('[data-fasting-edit-form]', (form) => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector('[data-fasting-edit-form]'));

    // Jeder Bereich hat seine Adresse - auch nach einem harten Neuladen.
    for (const id of ids) {
      await gotoRoute(page, `/health/${id}`);
      const state = await shown();
      assert.deepEqual([state.path, state.panels, state.back], [`/health/${id}`, [`/health/${id}`], true], id);
    }
    await page.close();

    // Desktop: Liste links, Bereich rechts; die Auswahl ist die Adresse.
    const desk = await openPage(harness, { device: 'desktop', locale: 'de' });
    desk.on('pageerror', (error) => errors.push(error.message));
    const split = () => desk.evaluate(() => ({
      path: location.pathname,
      detail: (() => { const d = document.querySelector('.health-split > .split-view__detail'); return d ? getComputedStyle(d).display !== 'none' : `missing: ${document.querySelector('#main-content')?.innerText.slice(0, 120)}`; })(),
      inDetail: Boolean(document.querySelector('.split-view__detail [data-md-body] .health-panels')),
      selected: [...document.querySelectorAll('.health-areas [data-md-id].is-selected')].map((row) => row.dataset.mdId),
      panels: [...document.querySelectorAll('[data-health-panel]')].filter((p) => !p.hidden).map((p) => p.dataset.healthPanel),
      back: document.querySelector('.health-toolbar__back')?.hidden === false,
    }));
    await gotoRoute(desk, '/health');
    assert.deepEqual(errors, []);
    assert.deepEqual(await split(), { path: '/health', detail: true, inDetail: true, selected: ['overview'], panels: ['/health'], back: false });
    await desk.click('.health-areas [data-md-id="meds"]');
    await desk.waitForFunction(() => location.pathname === '/health/meds');
    assert.deepEqual(await split(), { path: '/health/meds', detail: true, inDetail: true, selected: ['meds'], panels: ['/health/meds'], back: false });
    await desk.goBack();
    await desk.waitForFunction(() => location.pathname === '/health');
    assert.deepEqual((await split()).selected, ['overview']);
    await gotoRoute(desk, '/health?tab=labs');
    assert.deepEqual(await split(), { path: '/health/labs', detail: true, inDetail: true, selected: ['labs'], panels: ['/health/labs'], back: false });
    assert.deepEqual(errors, []);
    await desk.close();
  } finally { await harness.close(); }
});

// R10 G2 (A6 P2-4): der Zyklus am Desktop fuellt seine Spalte. Gemessen an der
// Detailspalte des 1280er-Laptops (684px): keine leere Kachelzelle im
// Statistikraster, der Monatspfeil steht am Titel, die Legende daneben reicht
// bis an die Kante, "Fruchtbares Fenster" steht hoechstens zweimal da (Ring
// und Kachel) und der Hinweis nur einmal.
test('cycle on desktop fills its column without holes and says each thing once', async () => {
  const harness = await startHarness();
  try {
    await harness.reset();
    const page = await openPage(harness, { device: 'desktop', locale: 'de' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Drei Perioden im 28-Tage-Takt, die letzte vor zehn Tagen: die Vorhersage
    // hat Daten, und die Fruchtbarkeit wird verfolgt (Voreinstellung).
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const key = (days) => {
        const d = new Date(Date.now() - days * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      for (const start of [66, 38, 10]) {
        await api.post('/health/cycle/periods', { start_date: key(start), end_date: key(start - 4) });
      }
    });
    await gotoRoute(page, '/health/cycle');
    await page.waitForSelector('.cycle-stats');
    const m = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const stats = document.querySelector('.cycle-stats');
      const gap = parseFloat(getComputedStyle(stats).columnGap) || 0;
      const rows = new Map();
      for (const tile of stats.children) {
        const r = box(tile);
        const top = Math.round(r.top);
        rows.set(top, (rows.get(top) ?? -gap) + r.width + gap);
      }
      const root = document.querySelector('[data-cycle-root]');
      const title = box(document.querySelector('.cycle-cal__head .cycle-section__title'));
      const nav = box(document.querySelector('.cycle-cal__nav'));
      const cal = box(document.querySelector('.cycle-cal'));
      const main = box(document.querySelector('.cycle-cal__main'));
      const rail = box(document.querySelector('.cycle-cal__rail'));
      return {
        statsWidth: Math.round(box(stats).width),
        rowWidths: [...rows.values()].map(Math.round),
        navGap: Math.round(nav.left - title.right),
        railBeside: rail.left > main.right && Math.abs(rail.right - cal.right) <= 1,
        fertile: (root.innerText.match(/Fruchtbares Fenster/g) || []).length,
        notes: root.querySelectorAll('.health-disclaimer').length,
      };
    });
    for (const width of m.rowWidths) {
      assert.ok(Math.abs(width - m.statsWidth) <= 2, `Statistikzeile ${width}px in ${m.statsWidth}px - eine Zelle bleibt leer`);
    }
    assert.ok(m.navGap >= 0 && m.navGap <= 24, `Monatspfeil ${m.navGap}px neben dem Titel`);
    assert.equal(m.railBeside, true, 'die Legende steht neben dem Gitter und reicht bis an die Kante');
    assert.ok(m.fertile <= 2, `"Fruchtbares Fenster" ${m.fertile}x`);
    assert.equal(m.notes, 1, 'genau ein Hinweis');
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await harness.close(); }
});
