/** Transfer creation through the real entry dialog and budget API. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const db = dbmod.get();
const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;

const accounts = ['Checking', 'Savings'].map(name => Number(db.prepare("INSERT INTO budget_accounts (name, type, created_by) VALUES (?, 'checking', ?)").run(name, A).lastInsertRowid));
const writes = [];
let server;
let baseUrl;
let browser;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', (req, _res, next) => {
    if (req.method !== 'GET') writes.push({ method: req.method, path: req.path, body: req.body });
    req.authUserId = A; req.authRole = 'member'; req.session = { userId: A };
    next();
  });
  app.get('/api/v1/preferences', (_req, res) => res.json({ data: { currency: 'EUR', budget_mode: 'shared' } }));
  app.get('/api/v1/family/members', (_req, res) => res.json({ data: [] }));
  app.use('/api/v1/budget', budgetRouter);
  app.use('/api/v1', (_req, res) => res.json({ data: [] }));
  app.get('/__budget-probe.html', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/tokens.css"></head>
<body><main id="c"></main><script type="module">
  import { initI18n } from '/i18n.js';
  import { setPermissions } from '/permissions.js';
  import '/components/datepicker.js';
  await initI18n();
  setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  const { render } = await import('/pages/budget.js');
  await render(document.getElementById('c'), { user: { id: ${A}, role: 'member' } });
  window.__ready = true;
</script></body></html>`));
  app.use(express.static(PUBLIC));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
  server?.close();
});


async function withTransfer(probe) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true);
    await page.$eval('#fab-new-budget', el => el.click());
    await page.waitForSelector('#type-transfer');
    await page.evaluate(() => { window.originalPanel = document.querySelector('.modal-panel'); });
    await page.$eval('#type-transfer', el => el.click());
    await page.waitForFunction(() => document.querySelector('#bm-transfer-fields')?.hidden === false);
    await probe(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

test('transfer stays in the entry dialog, loads categories, and switches back', async () => {
  await withTransfer(async page => {
    assert.equal(await page.evaluate(() => window.originalPanel === document.querySelector('.modal-panel')), true);
    const categories = await page.$$eval('#bt-category option', els => els.map(el => el.value).filter(Boolean));
    assert.deepEqual(categories, db.prepare("SELECT key FROM budget_categories WHERE type = 'expense' ORDER BY sort_order ASC, name COLLATE NOCASE ASC").all().map(c => c.key));
    assert.ok(!categories.includes('saving'));
    assert.equal(await page.$eval('#bt-category', el => el.value), 'financial_other');
    assert.equal(await page.$eval('#bt-subcategory', el => el.value), 'saving');
    await page.$eval('#bt-title', el => { el.value = 'Keep this transfer'; });
    for (const type of ['expense', 'income', 'loan', 'transfer']) {
      await page.$eval(`#type-${type}`, el => el.click());
      assert.equal(await page.evaluate(() => window.originalPanel === document.querySelector('.modal-panel')), true);
    }
    assert.equal(await page.$eval('#bt-title', el => el.value), 'Keep this transfer');
  });
});

test('saving a transfer posts a valid category and books matching account entries', async () => {
  await withTransfer(async page => {
    await page.$eval('#bt-title', el => { el.value = 'Transfer regression'; });
    await page.$eval('#bt-amount', el => { el.value = '42.50'; });
    await page.select('#bt-from', String(accounts[0]));
    await page.select('#bt-to', String(accounts[1]));
    // Pick a category with multiple subcategories to exercise the dependent selector.
    const category = db.prepare("SELECT category_key FROM budget_subcategories GROUP BY category_key HAVING COUNT(*) > 1 LIMIT 1").get().category_key;
    await page.select('#bt-category', category);
    const subcategory = await page.$eval('#bt-subcategory option[value]:not([value=""])', el => el.value);
    await page.select('#bt-subcategory', subcategory);
    const response = page.waitForResponse(res => res.url().endsWith('/budget/transfers') && res.request().method() === 'POST');
    await page.$eval('#bm-save', el => el.click());
    const result = await response;
    assert.equal(result.status(), 201, await result.text());
    await page.waitForFunction(() => !document.querySelector('#bt-title'));
    const entries = db.prepare("SELECT * FROM budget_entries WHERE title = 'Transfer regression' ORDER BY amount").all();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.amount), [-42.5, 42.5]);
    assert.deepEqual(entries.map(e => e.account_id), accounts);
    assert.equal(entries[0].category, category);
    assert.equal(entries[0].subcategory, subcategory);
    assert.equal(entries[0].transfer_entry_id, entries[1].id);
    assert.equal(entries[1].transfer_entry_id, entries[0].id);
  });
});
