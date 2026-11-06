/** Real browser, full application and loopback Paperless tag API. */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { startHarness, openPage, gotoRoute, clickPastDeadTime } from './document-guards-harness.js';

test('tags can be viewed and edited in folders and linked documents on desktop and mobile', { timeout: 180000 }, async () => {
  let assigned = [7, 150];
  const writes = [];
  const source = express();
  source.use(express.json());
  source.use((req, res, next) => req.get('Authorization') === 'Token tag-test' ? next() : res.sendStatus(401));
  const view = { id: 5, name: 'House', filter_rules: [{ rule_type: 6, value: '7' }] };
  const document = () => ({ id: 99, title: 'Tag test receipt', tags: [...assigned], original_file_name: 'receipt.txt' });
  source.get('/api/saved_views/5/', (_req, res) => res.json(view));
  source.get('/api/documents/', (_req, res) => res.json({ results: assigned.includes(7) ? [document()] : [], count: assigned.includes(7) ? 1 : 0, next: null }));
  source.get('/api/documents/99/', (_req, res) => res.json(document()));
  source.patch('/api/documents/99/', (req, res) => {
    writes.push(req.body); assigned = req.body.tags; res.json(document());
  });
  source.get('/api/documents/99/download/', (_req, res) => res.type('text/plain').send('Receipt'));
  source.get('/api/tags/', (req, res) => res.json({ results: Number(req.query.page) === 2
    ? [{ id: 150, name: 'Second page tag' }, { id: 151, name: 'Another tag' }]
    : [{ id: 7, name: 'House' }, { id: 8, name: '<img src=x onerror=alert(1)>' }],
  count: 4, next: Number(req.query.page) === 2 ? null : 'https://evil.example/ignored' }));
  source.get('/api/tags/:id/', (req, res) => res.json({ id: Number(req.params.id), name: req.params.id === '7' ? 'House' : 'Second page tag' }));
  const sourceServer = source.listen(0, '127.0.0.1');
  await new Promise((resolve) => sourceServer.once('listening', resolve));
  let harness;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  try {
    const preload = new URL('./helpers/loopback-fetch-only.js', import.meta.url).href;
    process.env.NODE_OPTIONS = `${previousNodeOptions || ''} --import=${preload}`.trim();
    harness = await startHarness();
    const page = await openPage(harness, { device: 'desktop', requestInterceptor: (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/v1/weather')) {
        request.respond({ status: 200, contentType: 'application/json', body: '{"data":null}' });
        return true;
      }
      if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        request.abort();
        return true;
      }
      return false;
    } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const linkId = await page.evaluate(async (base_url) => {
      const { api } = await import('/api.js');
      const account = (await api.post('/documents/dms/accounts', { provider: 'paperless', name: 'Tag test', base_url, api_token: 'tag-test' })).data;
      await api.post('/documents/dms/paperless/folders', { name: 'Tag folder', account_id: account.id, view_id: 5 });
      return (await api.post('/documents/dms/link', { account_id: account.id, dms_document_id: '99' })).data.id;
    }, `http://127.0.0.1:${sourceServer.address().port}`);
    await gotoRoute(page, '/documents');
    await page.waitForSelector('[data-pl-folder]');
    await page.click('[data-pl-folder]');
    await page.waitForSelector('[data-pl-tags]');
    await page.click('[data-pl-tags]');
    await page.waitForFunction(() => document.querySelector('.modal-panel [type="submit"]')?.disabled === false).catch(async (err) => { console.error('tag-test modal:', await page.$eval('.modal-panel', (el) => el.textContent).catch(() => 'missing')); throw err; });
    assert.equal(await page.$eval('[data-pl-tag-list] input[value="150"]', (el) => el.checked), true);
    assert.equal(await page.$$eval('[data-pl-tag-list] img', (els) => els.length), 0, 'tag labels must be escaped');
    await page.click('[data-pl-tag-list] input[value="7"]');
    await page.click('[data-pl-tag-list] input[value="8"]');
    await clickPastDeadTime(page, '.modal-panel [type="submit"]');
    await page.waitForFunction(() => document.querySelector('#paperless-folder-content')?.textContent.includes('keine Dokumente'));
    assert.deepEqual(assigned, [8, 150], 'off-page assigned tag survives selection');
    assert.deepEqual(Object.keys(writes[0]), ['tags']);

    // The same live source tags are reachable through the individually linked document.
    await page.click('#documents-folder-browser [data-folder-select=""]');
    const linkedTitle = await page.waitForSelector(`article[data-id="${linkId}"] h2`, { visible: true });
    await linkedTitle.click();
    await page.waitForSelector('[data-action="paperless-tags"]');
    await clickPastDeadTime(page, '[data-action="paperless-tags"]');
    await page.waitForFunction(() => document.querySelector('.modal-panel [type="submit"]')?.disabled === false).catch(async (err) => { console.error('tag-test modal:', await page.$eval('.modal-panel', (el) => el.textContent).catch(() => 'missing')); throw err; });
    await page.click('[data-pl-tag-more]');
    await page.waitForSelector('[data-pl-tag-list] input[value="151"]');
    await page.click('[data-pl-tag-list] input[value="151"]');
    // A concurrent source change produces a conflict; no silent overwrite.
    assigned = [7, 8, 150];
    await clickPastDeadTime(page, '.modal-panel [type="submit"]');
    await page.waitForSelector('[data-pl-tag-error]:not([hidden])');
    assert.equal(writes.length, 1);
    await page.click('[data-pl-tag-reload]');
    await page.waitForFunction(() => document.querySelector('.modal-panel [type="submit"]')?.disabled === false).catch(async (err) => { console.error('tag-test modal:', await page.$eval('.modal-panel', (el) => el.textContent).catch(() => 'missing')); throw err; });
    assert.equal(await page.$eval('[data-pl-tag-list] input[value="7"]', (el) => el.checked), true);

    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    if (process.env.PAPERLESS_TAGS_SCREENSHOT) await page.screenshot({ path: process.env.PAPERLESS_TAGS_SCREENSHOT });
    // Clearing is deliberate, including tags that originated on another catalogue page.
    await page.$$eval('[data-pl-tag-list] input:checked', (els) => els.forEach((el) => el.click()));
    await clickPastDeadTime(page, '.modal-panel [type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#paperless-tags-form'));
    assert.deepEqual(assigned, []);
    assert.deepEqual(errors, []);
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    if (harness) await harness.close();
    await new Promise((resolve) => sourceServer.close(resolve));
  }
});
