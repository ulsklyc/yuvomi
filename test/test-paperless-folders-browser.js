/** Full app + real adapter against loopback Paperless; desktop and mobile. */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from '../server/utils/http-router.ts';
import { startHarness, openPage, gotoRoute, clickPastDeadTime } from './document-guards-harness.js';

// Child servers must never contact an integration outside the local fixtures.
const loopbackPreload = new URL('./helpers/loopback-fetch-only.js', import.meta.url).href;
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --import=${loopbackPreload}`.trim();


test('a saved view becomes a live folder; pagination, sharing, mobile and removal work', { timeout: 180000 }, async () => {
  const source = express();
  const filterTag = 7;
  let hasMatches = true;
  /** @type {any[]} */
const requests = [];
  source.use((req, res, next) => {
    requests.push({ path: req.path, query: req.query, authorization: req.get('Authorization') });
    if (req.get('Authorization') !== 'Token browser-test-token') return res.sendStatus(401);
    next();
  });
  const view = () => ({ id: 5, name: 'Hausunterlagen', sort_field: 'created', sort_reverse: true,
    filter_rules: [{ rule_type: 6, value: String(filterTag) }] });
  source.get('/api/saved_views/', (_req, res) => res.json({ results: [view()], count: 1, next: null }));
  source.get('/api/saved_views/5/', (_req, res) => res.json(view()));
  source.get('/api/documents/', (req, res) => {
    const id = req.query.id;
    const page = Number(req.query.page || 1);
    const all = hasMatches ? Array.from({ length: 51 }, (_, i) => ({ id: i + 1, title: `Hausbeleg ${i + 1}`, original_file_name: `${i + 1}.pdf`,
      created: '2026-11-01', added: '2026-11-02T10:00:00Z', modified: '2026-11-03T12:00:00Z',
      correspondent: 3, document_type: 4, tags: [7], archive_serial_number: i === 0 ? 0 : null })) : [];
    assert.equal(req.query.tags__id__all, String(filterTag));
    const docs = id ? all.filter((doc) => String(doc.id) === id) : all.slice((page - 1) * 50, page * 50);
    res.json({ results: docs, count: id ? docs.length : all.length, next: !id && page === 1 && all.length ? 'https://invalid.example/never-follow' : null });
  });
  source.get('/api/documents/:id/download/', (_req, res) => res.type('application/pdf').send('%PDF-test'));
  source.get('/api/tags/', (_req, res) => res.json({ count: 1, next: null, results: [{ id: 7, name: '<Haus & Beleg>' }] }));
  source.get('/api/correspondents/', (_req, res) => res.json({ count: 1, next: null, results: [{ id: 3, name: '<Bank & Partner>' }] }));
  source.get('/api/document_types/', (_req, res) => res.json({ count: 1, next: null, results: [{ id: 4, name: 'Rechnung' }] }));
  const sourceServer = source.listen(0, '127.0.0.1');
  await new Promise((resolve) => sourceServer.once('listening', resolve));
  /** @type {Awaited<ReturnType<typeof startHarness>> | undefined} */
let harness;
  try {
    harness = await startHarness();
    const page = await openPage(harness, { device: 'desktop', requestInterceptor: (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/weather')) {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null, reason: 'not_configured' }) });
        return true;
      }
      return false;
    } });
    /** @type {string[]} */
const errors = [];
    page.on('pageerror', (/** @type {Error} */ err) => errors.push(err.message));
    await page.evaluate(async (/** @type {string} */ baseUrl) => {
      const apiPath = '/api.js';
      const { api } = await import(apiPath);
      await api.post('/documents/dms/accounts', { provider: 'paperless', name: 'Paperless test',
        base_url: baseUrl, api_token: 'browser-test-token' });
    }, `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (sourceServer.address()).port}`);
    await gotoRoute(page, '/documents');
    await page.waitForSelector('[data-pl-add]');
    await page.click('[data-pl-add]');
    await page.waitForFunction(() => document.querySelector('select#pl-view:not([disabled])') !== null);
    await page.type('#pl-name', 'Hausakte');
    assert.equal(await page.$eval('#pl-consent', (/** @type {HTMLInputElement} */ el) => el.hidden), true);
    await page.select('#pl-visibility', 'family');
    assert.equal(await page.$eval('#pl-consent', (/** @type {HTMLInputElement} */ el) => el.hidden), false);
    await page.click('#pl-confirm');
    await clickPastDeadTime(page, '.modal-panel [type="submit"]');
    await page.waitForSelector('.paperless-folder__document');
    assert.equal(await page.$$eval('.paperless-folder__document', (/** @type {HTMLInputElement[]} */ els) => els.length), 50);
    assert.equal(await page.$eval('.paperless-folder__title', (/** @type {HTMLInputElement} */ el) => el.textContent), 'Hausakte');
    assert.equal(await page.$eval('#fab-new-document', (/** @type {HTMLInputElement} */ el) => el.hidden), true);
    assert.equal(await page.$('.paperless-folder__metadata'), null, 'default stays title only');
    await gotoRoute(page, '/settings/modules/documents');
    await page.waitForSelector('[data-display-fields] input[value="created"]');
    for (const field of ['created', 'added', 'modified', 'correspondent', 'document_type', 'tags', 'archive_serial_number', 'filename']) {
      const saved = page.waitForResponse((/** @type {import('puppeteer').HTTPResponse} */ response) => response.request().method() === 'PUT' && /\/live-settings\/\d+$/.test(response.url()));
      await page.click(`[data-display-fields] input[value="${field}"]`);
      assert.equal((await saved).status(), 200);
      await page.waitForSelector(`[data-display-fields] input[value="${field}"]:not([disabled])`);
    }
    await gotoRoute(page, '/documents');
    await page.waitForSelector('[data-pl-folder]');
    await page.click('[data-pl-folder]');
    await page.waitForSelector('[data-pl-field="tags"]');
    assert.equal(await page.$eval('[data-pl-field="tags"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '<Haus & Beleg>');
    assert.equal(await page.$eval('[data-pl-field="correspondent"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '<Bank & Partner>');
    assert.equal(await page.$eval('[data-pl-field="archive_serial_number"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '0');
    assert.equal(await page.$eval('[data-pl-field="filename"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '1.pdf');
    assert.equal(await page.$eval('[data-pl-field="created"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '01.11.2026');
    await page.click('[data-pl-next]');
    await page.waitForFunction(() => document.querySelector('.paperless-folder__document')?.textContent.includes('Hausbeleg 51'));
    assert.equal(await page.$$eval('.paperless-folder__document', (/** @type {HTMLInputElement[]} */ els) => els.length), 1);
    assert.equal(await page.$eval('[data-pl-field="archive_serial_number"] dd', (/** @type {HTMLElement} */ el) => el.textContent), '-');
    const media = await page.$eval('.paperless-folder__document [data-pl-download]', (/** @type {HTMLInputElement} */ el) => el.dataset.plDownload);
    assert.equal(await page.evaluate(async (/** @type {string} */ url) => (await fetch(url)).status, media), 200);
    hasMatches = false;
    await page.click('[data-pl-refresh]');
    // Source changes can make page two invalid on a real Paperless instance;
    // choose the folder again to request the first current page.
    await page.click('[data-pl-folder]');
    await page.waitForFunction(() => document.querySelector('#paperless-folder-content')?.textContent.includes('keine Dokumente'));
    assert.equal(await page.evaluate(async (/** @type {string} */ url) => (await fetch(url)).status, media), 404);
    hasMatches = true;
    await page.click('#documents-folder-browser [data-folder-select=""]');
    assert.equal(await page.$eval('#paperless-folder-content', (/** @type {HTMLInputElement} */ el) => el.hidden), true);
    assert.equal(await page.$eval('#fab-new-document', (/** @type {HTMLInputElement} */ el) => el.hidden), false);

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/documents');
    await page.click('#documents-folder-toggle');
    await page.waitForSelector('[data-pl-folder]', { visible: true });
    await page.click('[data-pl-folder]');
    await page.waitForSelector('.paperless-folder__document');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'mobile page must not overflow horizontally');
    // The source picker must remain reachable after opening a remote folder.
    await page.click('#documents-folder-toggle');
    await page.click('[data-pl-edit]');
    await page.waitForSelector('[data-pl-remove]');
    assert.equal(await page.$eval('#pl-consent', (/** @type {HTMLInputElement} */ el) => el.hidden), true, 'existing family sharing does not ask again');
    await page.select('#pl-visibility', 'restricted');
    assert.equal(await page.$eval('#pl-members', (/** @type {HTMLInputElement} */ el) => el.hidden), false);
    assert.equal(await page.$eval('#pl-consent', (/** @type {HTMLInputElement} */ el) => el.hidden), true, 'narrowing the audience needs no new consent');
    await clickPastDeadTime(page, '[data-pl-remove]');
    await page.waitForSelector('#confirm-modal-ok');
    await clickPastDeadTime(page, '#confirm-modal-ok');
    await page.waitForFunction(() => !document.querySelector('[data-pl-folder]'));
    assert.equal(await page.$eval('#paperless-folder-content', (/** @type {HTMLInputElement} */ el) => el.hidden), true);
    assert.ok(requests.some((r) => r.query.page === '2'));
    assert.ok(requests.some((r) => r.query.id === '51'));
    assert.ok(requests.every((r) => r.authorization === 'Token browser-test-token'));
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    if (harness) await harness.close();
    await new Promise((resolve) => sourceServer.close(resolve));
  }
});

test('local tag folders can be created without saved views, using AND or OR with paginated tags', { timeout: 180000 }, async () => {
  const source = express();
  source.use(express.json());
  const tags = [{ id: 7, name: '<Haus & Beleg>' }, { id: 12, name: 'Rechnung' }];
  const docs = [{ id: 1, title: 'Hausrechnung', tags: [7, 12] }, { id: 2, title: 'Hausbeleg', tags: [7] }];
  let catalogueReads = 0;
  source.use((req, res, next) => req.get('Authorization') === 'Token local-filter-token' ? next() : res.sendStatus(401));
  source.get('/api/saved_views/', (_req, res) => res.json({ results: [], count: 0, next: null }));
  source.get('/api/tags/', (req, res) => {
    catalogueReads++;
    const wanted = String(req.query.id__in || '').split(',').map(Number);
    const filtered = req.query.id__in ? tags.filter((tag) => wanted.includes(tag.id)) : [tags[Number(req.query.page || 1) - 1]].filter(Boolean);
    res.json({ results: filtered, count: 2, next: !req.query.id__in && String(req.query.page || 1) === '1' ? 'https://invalid.example/ignored' : null });
  });
  source.get('/api/documents/', (req, res) => {
    assert.ok(req.query.tags__id__all || req.query.tags__id__in, 'every request must constrain tags');
    const ids = String(req.query.tags__id__all || req.query.tags__id__in).split(',').map(Number);
    const matches = docs.filter((doc) => (req.query.tags__id__all ? ids.every((id) => doc.tags.includes(id)) : ids.some((id) => doc.tags.includes(id)))
      && (!req.query.id || String(doc.id) === req.query.id));
    res.json({ results: matches, count: matches.length, next: null });
  });
  source.get('/api/documents/:id/', (req, res) => res.json(docs.find((doc) => String(doc.id) === req.params.id)));
  source.patch('/api/documents/:id/', (req, res) => {
    const doc = docs.find((doc) => String(doc.id) === req.params.id);
    if (!doc) return res.sendStatus(404);
    doc.tags = req.body.tags;
    res.json(doc);
  });
  source.get('/api/documents/:id/download/', (_req, res) => res.type('application/pdf').send('%PDF-test'));
  const sourceServer = source.listen(0, '127.0.0.1');
  await new Promise((resolve) => sourceServer.once('listening', resolve));
  /** @type {Awaited<ReturnType<typeof startHarness>> | undefined} */
  let harness;
  try {
    harness = await startHarness();
    let failPolicySave = false;
    const page = await openPage(harness, { device: 'desktop', requestInterceptor: (request) => {
      if (failPolicySave && request.method() === 'PUT' && /\/live-settings\/\d+$/.test(new URL(request.url()).pathname)) {
        failPolicySave = false;
        void request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test failure' }) });
        return true;
      }
      if (new URL(request.url()).pathname.startsWith('/api/v1/weather')) {
        void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null, reason: 'not_configured' }) });
        return true;
      }
      return false;
    } });
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (/** @type {Error} */ err) => errors.push(err.message));
    await page.evaluate(async (/** @type {string} */ baseUrl) => {
      const path = '/api.js'; const { api } = await import(path);
      await api.post('/documents/dms/accounts', { provider: 'paperless', name: 'Tag archive', base_url: baseUrl, api_token: 'local-filter-token' });
    }, `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (sourceServer.address()).port}`);
    await gotoRoute(page, '/documents');
    for (const match of ['all', 'any']) {
      await page.waitForSelector('#paperless-folder-form', { hidden: true });
      await page.click('[data-pl-add]');
      await page.select('#pl-source', 'tags');
      await page.waitForSelector('[data-pl-filter-tags] input[value="7"]', { timeout: 10000 }).catch(async (/** @type {Error} */ err) => {
        await page.screenshot({ path: '/tmp/paperless-tag-failure.png', fullPage: true });
        console.error('Tag mode:', match, await page.$eval('#pl-error', (/** @type {HTMLElement} */ el) => el.textContent), errors);
        throw err;
      });
      assert.equal(await page.$eval('.modal-panel [type="submit"]', (/** @type {HTMLButtonElement} */ el) => el.disabled), false, 'the primary action validates on submit');
      await page.type('#pl-name', `Tag ${match}`);
      const foldersBefore = await page.$$eval('[data-pl-folder]', (/** @type {HTMLElement[]} */ els) => els.length);
      await clickPastDeadTime(page, '.modal-panel [type="submit"]');
      await page.waitForSelector('[data-pl-filter-tags][aria-invalid="true"]');
      assert.equal(await page.$$eval('[data-pl-folder]', (/** @type {HTMLElement[]} */ els) => els.length), foldersBefore, 'an empty tag filter must never create a folder');
      await page.select('#pl-tag-match', match);
      await page.click('[data-pl-filter-tags] input[value="7"]');
      await page.click('[data-pl-more-tags]');
      await page.waitForSelector('[data-pl-filter-tags] input[value="12"]');
      assert.equal(await page.$eval('[data-pl-filter-tags] input[value="7"]', (/** @type {HTMLInputElement} */ el) => el.checked), true);
      await page.click('[data-pl-filter-tags] input[value="12"]');
      await page.screenshot({ path: `/tmp/paperless-filter-${match}.png`, fullPage: true });
      await clickPastDeadTime(page, '.modal-panel [type="submit"]');
      await page.waitForSelector('#paperless-folder-form', { hidden: true });
      await page.waitForFunction((/** @type {string} */ expected) => document.querySelector('.paperless-folder__title')?.textContent === expected, {}, `Tag ${match}`);
      await page.waitForSelector('.paperless-folder__document', { timeout: 15000 }).catch(async (/** @type {Error} */ err) => {
        await page.screenshot({ path: '/tmp/paperless-tag-failure.png', fullPage: true });
        console.error(await page.$eval('#pl-error', (/** @type {HTMLElement} */ el) => el.textContent).catch(() => 'no dialog error'));
        console.error(errors);
        throw err;
      });
      assert.equal(await page.$$eval('.paperless-folder__document', (/** @type {HTMLElement[]} */ els) => els.length), match === 'all' ? 1 : 2);
    }
    const folder = await page.evaluate(async () => {
      const path = '/api.js'; const { api } = await import(path);
      const folders = (await api.get('/documents/dms/paperless/folders')).data;
      return folders.find((/** @type {{name: string, id: number}} */ row) => row.name === 'Tag all');
    });
    const outside = await page.evaluate(async (/** @type {number} */ id) => (await fetch(`/api/v1/documents/dms/paperless/folders/${id}/documents/2/download`)).status, folder.id);
    assert.equal(outside, 404);
    const changed = await page.evaluate(async (/** @type {number} */ id) => {
      const path = '/api.js'; const { api } = await import(path);
      return api.put(`/documents/dms/paperless/folders/${id}/documents/1/tags`, { tags: [7], expected_tags: [7, 12] });
    }, folder.id);
    assert.deepEqual(changed.data.tag_ids, [7]);
    await page.click(`[data-pl-folder="${folder.id}"]`);
    await page.waitForFunction(() => !document.querySelector('.paperless-folder__document'));
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await gotoRoute(page, '/settings/modules/documents');
    await page.waitForSelector('[data-display-fields] .settings-setting-row--switch');
    assert.equal(await page.$('fieldset[data-display-fields]'), null);
    assert.equal(await page.$eval('[data-display-fields]', (/** @type {HTMLElement} */ el) => el.classList.contains('row-carrier')), true);
    failPolicySave = true;
    await page.click('[data-display-fields] input[value="created"]');
    await page.waitForFunction(() => {
      const input = /** @type {HTMLInputElement | null} */ (document.querySelector('[data-display-fields] input[value="created"]'));
      return input && !input.checked && !input.disabled;
    });
    const saved = page.waitForResponse((/** @type {import("puppeteer").HTTPResponse} */ response) => response.request().method() === 'PUT' && /\/live-settings\/\d+$/.test(response.url()));
    await page.click('[data-display-fields] input[value="created"]');
    assert.equal((await saved).status(), 200);
    await page.waitForSelector('[data-display-fields] input[value="created"]:not([disabled])');
    await page.screenshot({ path: '/tmp/paperless-settings-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.ok(catalogueReads >= 4);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    if (harness) await harness.close();
    await new Promise((resolve) => sourceServer.close(resolve));
  }
});
