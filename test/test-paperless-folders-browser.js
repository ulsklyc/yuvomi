/** Full app + real adapter against loopback Paperless; desktop and mobile. */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { startHarness, openPage, gotoRoute, clickPastDeadTime } from './document-guards-harness.js';

test('a saved view becomes a live folder; pagination, sharing, mobile and removal work', { timeout: 180000 }, async () => {
  const source = express();
  let filterTag = 7;
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
    const all = filterTag === 7 ? Array.from({ length: 51 }, (_, i) => ({ id: i + 1, title: `Hausbeleg ${i + 1}`, original_file_name: `${i + 1}.pdf` })) : [];
    assert.equal(req.query.tags__id__all, String(filterTag));
    const docs = id ? all.filter((doc) => String(doc.id) === id) : all.slice((page - 1) * 50, page * 50);
    res.json({ results: docs, count: id ? docs.length : all.length, next: !id && page === 1 && all.length ? 'https://invalid.example/never-follow' : null });
  });
  source.get('/api/documents/:id/download/', (_req, res) => res.type('application/pdf').send('%PDF-test'));
  const sourceServer = source.listen(0, '127.0.0.1');
  await new Promise((resolve) => sourceServer.once('listening', resolve));
  let harness;
  try {
    harness = await startHarness();
    const page = await openPage(harness, { device: 'desktop' });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.evaluate(async (baseUrl) => {
      const { api } = await import('/api.js');
      await api.post('/documents/dms/accounts', { provider: 'paperless', name: 'Paperless test',
        base_url: baseUrl, api_token: 'browser-test-token' });
    }, `http://127.0.0.1:${sourceServer.address().port}`);
    await gotoRoute(page, '/documents');
    await page.waitForSelector('[data-pl-add]');
    await page.click('[data-pl-add]');
    await page.waitForFunction(() => document.querySelector('#pl-view')?.disabled === false);
    await page.type('#pl-name', 'Hausakte');
    await page.select('#pl-visibility', 'family');
    await page.click('#pl-confirm');
    await clickPastDeadTime(page, '.modal-panel [type="submit"]');
    await page.waitForSelector('.paperless-folder__document');
    assert.equal(await page.$$eval('.paperless-folder__document', (els) => els.length), 50);
    assert.equal(await page.$eval('.paperless-folder__title', (el) => el.textContent), 'Hausakte');
    assert.equal(await page.$eval('#fab-new-document', (el) => el.hidden), true);
    await page.click('[data-pl-next]');
    await page.waitForFunction(() => document.querySelector('.paperless-folder__document')?.textContent.includes('Hausbeleg 51'));
    assert.equal(await page.$$eval('.paperless-folder__document', (els) => els.length), 1);
    const media = await page.$eval('.paperless-folder__document a[href$="/download"]', (el) => el.getAttribute('href'));
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, media), 200);
    filterTag = 12;
    await page.click('[data-pl-refresh]');
    // Source changes can make page two invalid on a real Paperless instance;
    // choose the folder again to request the first current page.
    await page.click('[data-pl-folder]');
    await page.waitForFunction(() => document.querySelector('#paperless-folder-content')?.textContent.includes('keine Dokumente'));
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, media), 404);
    filterTag = 7;
    await page.click('#documents-folder-browser [data-folder-select=""]');
    assert.equal(await page.$eval('#paperless-folder-content', (el) => el.hidden), true);
    assert.equal(await page.$eval('#fab-new-document', (el) => el.hidden), false);

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
    await clickPastDeadTime(page, '[data-pl-remove]');
    await page.waitForSelector('#confirm-modal-ok');
    await clickPastDeadTime(page, '#confirm-modal-ok');
    await page.waitForFunction(() => !document.querySelector('[data-pl-folder]'));
    assert.equal(await page.$eval('#paperless-folder-content', (el) => el.hidden), true);
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

test('the optional own module renders against the core API without storing credentials in module files', { timeout: 120000 }, async () => {
  const { cpSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('./tmp-dir.js');
  const moduleRoot = tempDir('yuvomi-paperless-module-');
  cpSync(new URL('../examples/modules/paperless-views/', import.meta.url), join(moduleRoot, 'paperless-views'), { recursive: true });
  const oldModuleRoot = process.env.MODULES_DIR;
  process.env.MODULES_DIR = moduleRoot;
  const source = express();
  const definition = { id: 5, name: 'Test view', filter_rules: [], sort_field: 'created', sort_reverse: true };
  source.get('/api/saved_views/5/', (_req, res) => res.json(definition));
  source.get('/api/documents/', (_req, res) => res.json({ count: 1, next: null,
    results: [{ id: 1, title: 'Module document', original_file_name: 'module.pdf' }] }));
  const sourceServer = source.listen(0, '127.0.0.1');
  await new Promise((resolve) => sourceServer.once('listening', resolve));
  let harness;
  try {
    harness = await startHarness();
    const page = await openPage(harness, { device: 'desktop' });
    const route = await page.evaluate(async (baseUrl) => {
      const { api } = await import('/api.js');
      const account = await api.post('/documents/dms/accounts', { provider: 'paperless', name: 'Module test', base_url: baseUrl, api_token: 'module-test-token' });
      await api.post('/documents/dms/paperless/folders', { name: 'Module folder', account_id: account.data.id, view_id: 5 });
      const modules = await api.get('/modules');
      const entry = modules.data.find((m) => m.id === 'paperless-views');
      if (entry?.status !== 'enabled') throw new Error('Example module was not enabled');
      return entry.route.path;
    }, `http://127.0.0.1:${sourceServer.address().port}`);
    await gotoRoute(page, route);
    await page.waitForSelector('[data-pl-folder]');
    await page.click('[data-pl-folder]');
    await page.waitForSelector('.paperless-folder__document');
    assert.equal(await page.$eval('.paperless-folder__document .list-row__name', (el) => el.textContent), 'Module document');
    assert.ok(await page.$('[data-pl-edit]'));
    await page.close();
  } finally {
    if (harness) await harness.close();
    await new Promise((resolve) => sourceServer.close(resolve));
    if (oldModuleRoot === undefined) delete process.env.MODULES_DIR;
    else process.env.MODULES_DIR = oldModuleRoot;
    rmSync(moduleRoot, { recursive: true, force: true });
  }
});
