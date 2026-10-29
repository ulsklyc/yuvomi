/** Transfer creation through the real entry dialog and budget API. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
// The probe page runs in English and reads its expectations from en.json (#2147):
// without a stored locale, i18n.js falls back to navigator.languages, and headless
// Chrome takes those from the host (["de-DE"] on a German macOS).
const LOCALE = 'en';
const MESSAGES = JSON.parse(readFileSync(new URL(`../public/locales/${LOCALE}.json`, import.meta.url), 'utf8'));
const tr = key => key.split('.').reduce((node, part) => node?.[part], MESSAGES) ?? assert.fail(`missing ${LOCALE} key ${key}`);
const dbmod = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');
const { todayKey } = await import('../server/utils/timezone.js');
const db = dbmod.get();
const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;

const accounts = ['Checking', 'Savings'].map(name => Number(db.prepare("INSERT INTO budget_accounts (name, type, created_by) VALUES (?, 'checking', ?)").run(name, A).lastInsertRowid));
const yenAccount = Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Yen', 'checking', 'JPY', ?)").run(A).lastInsertRowid);
const dinarAccount = Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Dinar', 'checking', 'KWD', ?)").run(A).lastInsertRowid);
const archivedAccount = Number(db.prepare("INSERT INTO budget_accounts (name, type, archived, created_by) VALUES ('Archived', 'checking', 1, ?)").run(A).lastInsertRowid);
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
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/tokens.css">
${['layout', 'typography', 'list-row', 'panel', 'budget'].map(name => `<link rel="stylesheet" href="/styles/${name}.css">`).join('')}</head>
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
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

/** A page whose locale is fixed before any script of the app runs. */
async function newPage() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(locale => localStorage.setItem('yuvomi-locale', locale), LOCALE);
  return page;
}

after(async () => {
  await browser?.close();
  server?.close();
});


async function withTransfer(probe) {
  const page = await newPage();
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

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v1/budget${path}`, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function openTransferEditor(page, entry) {
  await page.evaluate(async entry => {
    const { closeModal } = await import('/components/modal.js');
    const { openTransferDialog } = await import('/components/budget-transfer-dialog.js');
    await closeModal({ force: true });
    const accounts = (await (await fetch('/api/v1/budget/accounts')).json()).data.accounts;
    const meta = (await (await fetch('/api/v1/budget/meta')).json()).data;
    await openTransferDialog({ entry, accounts, categories: meta.expenseCategories, subcategories: meta.subcategories,
      month: '2045-01', currency: 'EUR', budgetMode: 'shared', readOnly: () => false,
      onSaved() { window.__transferSaved = (window.__transferSaved ?? 0) + 1; }, onDelete() {}, onError(err) { throw err; } });
  }, entry);
  await page.waitForSelector('#bt-save');
  await page.waitForFunction(() => document.querySelectorAll('#bt-title').length === 1 && document.querySelector('#bt-save'));
}

test('a transfer save finishing after another dialog opens leaves that dialog open', async () => {
  const created = await request('POST', '/transfers', { title: 'Delayed save', amount: 10, date: '2045-01-10',
    from_account_id: accounts[0], to_account_id: accounts[1] });
  assert.equal(created.status, 201);
  const page = await newPage();
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true);
    await openTransferEditor(page, created.body.data);
    await page.evaluate(async () => {
      const { api } = await import('/api.js');
      const put = api.put.bind(api);
      api.put = async (...args) => {
        const result = await put(...args);
        await new Promise(resolve => { window.__releaseTransferSave = resolve; });
        return result;
      };
    });
    await page.$eval('#bt-title', el => { el.value = 'Saved while replaced'; });
    await page.$eval('#bt-save', el => el.click());
    await page.waitForFunction(() => Boolean(window.__releaseTransferSave));
    await page.evaluate(async () => {
      const { openModal, closeModal } = await import('/components/modal.js');
      await closeModal({ force: true });
      openModal({ title: 'Another dialog', content: '<p id="replacement-dialog">Keep open</p>' });
      window.__releaseTransferSave();
    });
    await page.waitForFunction(() => window.__transferSaved === 1);
    assert.ok(await page.$('#replacement-dialog'), 'the completed save cannot close the replacement dialog');
    assert.equal(await page.$eval('#replacement-dialog', el => el.closest('dialog').open), true,
      'the replacement stays open rather than beginning its closing animation');
    assert.equal(db.prepare('SELECT title FROM budget_entries WHERE id = ?').get(created.body.data.id).title, 'Saved while replaced');
  } finally {
    await page.close();
    await request('DELETE', `/${created.body.data.id}`);
  }
});

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
    await page.type('#bt-amount', '42,50');
    assert.equal(await page.$eval('#bt-amount', el => el.value), '42,50');
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

test('budget entries preserve cents typed with either decimal key and reject invalid input (#2170)', async () => {
  for (const [type, input, expected, locale] of [
    ['expense', '12,50', -12.5, 'en-US'], ['income', '12.50', 12.5, 'en-US'],
    ['expense', '12.50', -12.5, 'de-DE'], ['income', '12,50', 12.5, 'de-DE'],
  ]) {
    const page = await newPage();
    try {
      await page.evaluateOnNewDocument(locale => localStorage.setItem('yuvomi-number-locale', locale), locale);
      await page.goto(`${baseUrl}/__budget-probe.html`);
      await page.waitForFunction(() => window.__ready === true);
      await page.$eval('#fab-new-budget', el => el.click());
      await page.waitForSelector('#bm-amount');
      await page.$eval(`#type-${type}`, el => el.click());
      assert.deepEqual(await page.$eval('#bm-amount', el => [el.type, el.inputMode]), ['text', 'decimal']);
      const title = `Decimal keyboard ${type} ${locale}`;
      await page.type('#bm-title', title);
      const category = await page.$eval('#bm-category option[value]:not([value=""])', el => el.value);
      await page.select('#bm-category', category);
      if (await page.$eval('#bm-subcategory', el => el.required)) {
        const subcategory = await page.$eval('#bm-subcategory option[value]:not([value=""])', el => el.value);
        await page.select('#bm-subcategory', subcategory);
      }
      // The same save handler must reject partial parses and off-grid amounts.
      for (const invalid of ['12,50oops', locale === 'de-DE' ? '1.234' : '1,234', '12.505']) {
        await page.$eval('#bm-amount', (el, value) => { el.value = value; }, invalid);
        const before = writes.length;
        await page.$eval('#bm-save', el => el.click());
        await page.waitForFunction(() => document.querySelector('#bm-amount')?.getAttribute('aria-invalid') === 'true');
        assert.equal(writes.length, before);
      }
      await page.$eval('#bm-amount', el => { el.value = ''; });
      await page.type('#bm-amount', input);
      assert.equal(await page.$eval('#bm-amount', el => el.value), input);
      const response = page.waitForResponse(res => res.request().method() === 'POST' && /\/budget\/?$/.test(res.url()));
      await page.$eval('#bm-save', el => el.click());
      const result = await response;
      assert.equal(result.status(), 201, await result.text());
      assert.equal(db.prepare('SELECT amount FROM budget_entries WHERE title = ?').get(title).amount, expected);
    } finally {
      await page.evaluate(() => localStorage.removeItem('yuvomi-number-locale'));
      await page.close();
    }
  }
});

test('editing an existing entry in de-DE saves its comma-formatted amount unchanged (#2170)', async () => {
  for (const amount of [-1014.5, 1014.5]) {
    const category = db.prepare('SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order LIMIT 1')
      .get(amount < 0 ? 'expense' : 'income').key;
    const subcategory = db.prepare('SELECT key FROM budget_subcategories WHERE category_key = ? ORDER BY sort_order LIMIT 1')
      .get(category)?.key ?? '';
    const created = await request('POST', '/', { title: `Unchanged comma edit ${amount}`, amount,
      category, subcategory, date: todayKey(db) });
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    const page = await newPage();
    try {
      await page.evaluateOnNewDocument(() => localStorage.setItem('yuvomi-number-locale', 'de-DE'));
      await page.goto(`${baseUrl}/__budget-probe.html`);
      await page.waitForFunction(() => window.__ready === true);
      await page.$eval(`.budget-entry[data-id="${id}"] .budget-entry__title`, el => el.click());
      await page.waitForSelector('#bm-amount');
      assert.deepEqual(await page.$eval('#bm-amount', el => ({ value: el.value, type: el.type,
        inputMode: el.inputMode, step: el.hasAttribute('step'), min: el.hasAttribute('min') })),
      { value: '1014,50', type: 'text', inputMode: 'decimal', step: false, min: false });
      const response = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith(`/budget/${id}`));
      await page.$eval('#bm-save', el => el.click());
      assert.equal((await response).status(), 200);
      assert.equal(db.prepare('SELECT amount FROM budget_entries WHERE id = ?').get(id).amount, amount);
      await page.waitForFunction(() => !document.querySelector('#bm-amount'));
    } finally {
      await page.evaluate(() => localStorage.removeItem('yuvomi-number-locale'));
      await page.close();
    }
  }
});

// Since Critique R23 (D1) a money field is a text field: the source currency
// shows in its placeholder ("0,00", "0", "0,000"), and saving checks the digits.
test('transfer amount placeholder follows the source account currency and its household fallback', async () => {
  await withTransfer(async page => {
    const zero = currency => page.evaluate(async c => (await import('/utils/money.js')).amountPlaceholder(c), currency);
    assert.equal(await page.$eval('#bt-amount', el => el.hasAttribute('step') || el.hasAttribute('min')), false);
    const shown = () => page.$eval('#bt-amount', el => ({ type: el.type, inputMode: el.inputMode, placeholder: el.placeholder }));
    const field = async currency => ({ type: 'text', inputMode: 'decimal', placeholder: await zero(currency) });
    assert.deepEqual(await shown(), await field('EUR'));
    await page.select('#bt-from', String(yenAccount));
    assert.deepEqual(await shown(), await field('JPY'));
    await page.select('#bt-to', String(dinarAccount));
    assert.deepEqual(await shown(), await field('JPY'), 'the target currency does not set the format');
    await page.select('#bt-from', String(dinarAccount));
    assert.deepEqual(await shown(), await field('KWD'));
    await page.select('#bt-from', String(accounts[0]));
    assert.deepEqual(await shown(), await field('EUR'));
  });
});

test('archived accounts cannot be selected for either leg of a new transfer', async () => {
  await withTransfer(async page => {
    for (const selector of ['#bt-from', '#bt-to']) {
      assert.equal(await page.$eval(`${selector} option[value="${archivedAccount}"]`, option => option.disabled), true);
      assert.equal(await page.$eval(`${selector} option[value="${accounts[0]}"]`, option => option.disabled), false);
    }
  });
});

test('a currency mismatch keeps the dialog open and shows the translated account error', async () => {
  await withTransfer(async page => {
    await page.$eval('#bt-title', el => { el.value = 'Unsupported exchange'; });
    await page.$eval('#bt-amount', el => { el.value = '100'; });
    await page.select('#bt-from', String(yenAccount));
    await page.select('#bt-to', String(accounts[0]));
    const response = page.waitForResponse(res => res.url().endsWith('/budget/transfers') && res.request().method() === 'POST');
    await page.$eval('#bm-save', el => el.click());
    const res = await response;
    assert.equal(res.status(), 400);
    assert.equal((await res.json()).reason, 'transfer_currency_mismatch');
    await page.waitForFunction(() => document.querySelector('#bt-to')?.getAttribute('aria-invalid') === 'true');
    assert.equal(await page.$eval('#bm-save', el => el.disabled), false);
    assert.ok(await page.$('#bt-title'), 'the transfer remains editable');
    const message = await page.$eval('#bt-to', el => document.getElementById(el.getAttribute('aria-errormessage'))?.textContent
      ?? document.getElementById(el.getAttribute('aria-describedby'))?.textContent);
    assert.equal(message, tr('budget.transferCurrencyMismatch'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM budget_entries WHERE title = 'Unsupported exchange'").get().n, 0);
  });
});

test('editing a transfer opens with the source currency amount step', async () => {
  const res = await fetch(`${baseUrl}/api/v1/budget/transfers`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Yen transfer', amount: 100, date: '2045-01-10', from_account_id: yenAccount,
      to_account_id: Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Yen savings', 'savings', 'JPY', ?)").run(A).lastInsertRowid) }) });
  assert.equal(res.status, 201);
  const entry = (await res.json()).data;
  await withTransfer(async page => {
    await page.evaluate(async entry => {
      const { closeModal } = await import('/components/modal.js');
      const { openTransferDialog } = await import('/components/budget-transfer-dialog.js');
      await closeModal({ force: true });
      const accounts = (await (await fetch('/api/v1/budget/accounts')).json()).data.accounts;
      const meta = (await (await fetch('/api/v1/budget/meta')).json()).data;
      await openTransferDialog({ entry, accounts, categories: meta.expenseCategories, subcategories: meta.subcategories,
        month: '2045-01', currency: 'EUR', budgetMode: 'shared', readOnly: () => false,
        onSaved() {}, onDelete() {}, onError(err) { throw err; } });
    }, entry);
    await page.waitForSelector('#bt-save');
    await page.waitForFunction(() => document.querySelector('#bt-amount')?.value === '100');
    assert.deepEqual(await page.$eval('#bt-amount', el => ({ value: el.value, type: el.type, placeholder: el.placeholder })),
      { value: '100', type: 'text', placeholder: await page.evaluate(async () => (await import('/utils/money.js')).amountPlaceholder('JPY')) });
  });
});

test('transfer recurrence uses the entry toggles, interval controls and shared maximum', async () => {
  await withTransfer(async page => {
    // R23: die Schalter sind die eine Switch-Zeile der Dialoge (formSwitchRowHtml).
    assert.deepEqual(await page.$eval('#bt-recurring', el => ({ role: el.getAttribute('role'), row: el.closest('label')?.classList.contains('toggle-row--switch') })),
      { role: 'switch', row: true });
    for (const selector of ['#bt-from', '#bt-to']) {
      assert.deepEqual(await page.$eval(selector, (el, none) => ({ required: el.required,
        none: [...el.options].some(option => option.textContent === none), emptyEnabled: [...el.options].some(option => !option.value && !option.disabled) }), tr('budget.noAccount')),
      { required: true, none: false, emptyEnabled: false });
    }
    await page.$eval('#bt-recurring', el => el.click());
    assert.equal(await page.$eval('#bt-recurrence', el => el.hidden), false);
    assert.equal(await page.$eval('#bt-interval-count', el => el.max), '99');
    assert.equal(await page.$eval('#bt-interval-count', el => el.closest('.rrule-interval-wrap') !== null), true);
    await page.select('#bt-interval', 'weekly');
    await page.$eval('#bt-interval-count', el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.$eval('#bt-interval-unit', el => el.textContent), tr('rrule.unitWeeks'));
    assert.deepEqual(await page.$eval('#bt-confirm', el => ({ role: el.getAttribute('role'), row: el.closest('label')?.classList.contains('toggle-row--switch') })),
      { role: 'switch', row: true });
    // The ordinary entry uses the same rendered controls.
    assert.equal(await page.$eval('#bm-interval-count', el => el.max), '99');
  });
});

test('the balance keeps its mobile slot, the transfer card is conditional, and transfer rows read neutrally', async () => {
  db.exec('DELETE FROM budget_entries');
  const date = todayKey(db);
  db.prepare("INSERT INTO budget_entries (title, amount, category, subcategory, date, account_id, created_by) VALUES ('Ordinary purchase', -20, 'food', '', ?, ?, ?)").run(date, accounts[0], A);
  const page = await newPage();
  try {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true);
    assert.equal(await page.$('.budget-transfer-summary'), null);
    const res = await fetch(`${baseUrl}/api/v1/budget/transfers`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Visible transfer', amount: 100, date, from_account_id: accounts[0], to_account_id: accounts[1], is_recurring: true }) });
    assert.equal(res.status, 201);
    const entry = (await res.json()).data;
    await page.reload();
    await page.waitForFunction(() => window.__ready === true);
    const transferRow = `.budget-entry[data-id="${entry.id}"]`;
    assert.equal(await page.$eval(`${transferRow} .budget-badge--transfer`, el => el.textContent), tr('budget.typeTransfer'));
    assert.equal(await page.$eval(`${transferRow} .budget-transfer-route`, el => el.textContent), 'Checking → Savings');
    assert.match(await page.$eval(`${transferRow} .budget-entry__title`, el => el.getAttribute('aria-label')), new RegExp(tr('budget.typeTransfer')));
    const badge = await page.$eval(`${transferRow} .budget-badge--transfer`, el => {
      const style = getComputedStyle(el);
      return { display: style.display, gap: parseFloat(style.columnGap), radius: parseFloat(style.borderRadius) };
    });
    assert.equal(badge.display, 'inline-flex');
    assert.ok(badge.gap > 0);
    assert.ok(badge.radius > 0);
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    assert.equal(await page.$eval(`${transferRow} .budget-transfer-route__arrow`, el => getComputedStyle(el).transform), 'matrix(-1, 0, 0, 1, 0, 0)');
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'ltr'));
    assert.equal(await page.$(`${transferRow} .budget-entry__amount--expenses`), null);
    await page.$eval('.budget-bar-row[data-category-filter="__saving__"]', el => el.click());
    assert.ok(await page.$(transferRow), 'the Savings chart keeps its actual transfer visible');
    assert.equal(await page.$$eval('.budget-entry[data-id]', rows => rows.length), 1);
    await page.$eval('.budget-bar-row[data-category-filter="__saving__"]', el => el.click());
    await page.$eval('#budget-balance-more', el => el.click());
    await page.waitForFunction(() => document.querySelector('#budget-balance-details').classList.contains('is-expanded'));
    for (const expensesOnly of [false, true]) {
      if (expensesOnly) await page.$eval('#budget-expenses-only', el => el.click());
      assert.equal(await page.$$eval('.budget-overview .metric-grid > .metric-card', els => els.length), expensesOnly ? 1 : 3);
      assert.equal(await page.$eval('.budget-transfer-summary', el => el.parentElement.classList.contains('metric-grid')), false);
      if (!expensesOnly) {
        const layout = await page.$eval('.budget-balance-card', el => ({ order: getComputedStyle(el).order, width: el.getBoundingClientRect().width,
          gridWidth: el.parentElement.getBoundingClientRect().width }));
        assert.equal(layout.order, '-1');
        assert.ok(Math.abs(layout.width - layout.gridWidth) < 2, JSON.stringify(layout));
      }
    }
    await page.$eval('#budget-expenses-only', el => el.click());
    await page.$eval(`${transferRow} .budget-entry__title`, el => el.click());
    // R24 E1: der Tipp zeigt die Buchung zuerst; Bearbeiten fuehrt in den Editor.
    await page.waitForSelector('#budget-read-edit');
    await page.$eval('#budget-read-edit', el => el.click());
    await page.waitForSelector('#bt-delete');
    await page.$eval('#bt-delete', el => el.click());
    await page.waitForFunction(text => document.body.textContent.includes(text), {}, tr('budget.transferDeleteSeriesConfirm'));
    // Cancel keeps the linked series intact.
    await page.$eval('#confirm-modal-cancel', el => el.click());
    await page.waitForSelector('#bt-delete');
    assert.equal(db.prepare('SELECT transfer_entry_id FROM budget_entries WHERE id = ?').get(entry.id).transfer_entry_id, entry.transfer_entry_id);
    await fetch(`${baseUrl}/api/v1/budget/${entry.id}`, { method: 'DELETE' });
    await page.reload();
    await page.waitForFunction(() => window.__ready === true);
    assert.equal(await page.$('.budget-transfer-summary'), null);
  } finally { await page.close(); }
});

test('series edits from an anchor or occurrence keep the current accounts, amount and recurrence', async () => {
  const target = Number(db.prepare("INSERT INTO budget_accounts (name, type, created_by) VALUES ('Current series destination', 'savings', ?)").run(A).lastInsertRowid);
  const created = await request('POST', '/transfers', { title: 'Historical booking', amount: 100, date: '2020-01-06',
    from_account_id: accounts[0], to_account_id: accounts[1], is_recurring: true, recurrence_interval: 'weekly', recurrence_interval_count: 2, recurrence_confirm: true });
  assert.equal(created.status, 201);
  const anchor = created.body.data;
  assert.equal((await request('PUT', `/transfers/${anchor.id}/series`, { to_account_id: target, amount: 175, title: 'Current definition' })).status, 200);
  const currentMonth = todayKey(db).slice(0, 7);
  const month = await request('GET', `/?month=${currentMonth}`);
  const occurrence = month.body.data.find(e => e.recurrence_parent_id === anchor.id);
  assert.ok(occurrence);
  for (const entry of [anchor, occurrence]) {
    await withTransfer(async page => {
      await openTransferEditor(page, entry);
      assert.equal(await page.$eval('#bt-interval', el => el.value), 'weekly');
      assert.equal(await page.$eval('#bt-interval-count', el => el.value), '2');
      assert.equal(await page.$eval('#bt-confirm', el => el.checked), true);
      const title = `Rename through ${entry.id}`;
      await page.$eval('#bt-title', (el, value) => { el.value = value; }, title);
      await page.select('#bt-scope', 'series');
      assert.equal(await page.$eval('#bt-title', el => el.value), title, 'the edit made before choosing a scope is retained');
      // R23: das Geldfeld ist Text in Regionsschreibweise mit zwei Nachkommastellen.
      assert.equal(await page.$eval('#bt-amount', el => el.value), '175.00');
      assert.equal(await page.$eval('#bt-to', el => el.value), String(target));
      const response = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith(`/transfers/${entry.id}/series`));
      await page.$eval('#bt-save', el => el.click());
      assert.equal((await response).status(), 200);
      const definitions = db.prepare('SELECT * FROM budget_series WHERE anchor_id IN (?, ?) ORDER BY amount').all(anchor.id, anchor.transfer_entry_id);
      assert.deepEqual(definitions.map(e => e.amount), [-175, 175]);
      assert.equal(definitions[1].account_id, target);
      assert.ok(definitions.every(e => e.title === title));
      const stored = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor.id);
      assert.equal(stored.recurrence_interval, 'weekly');
      assert.equal(stored.recurrence_interval_count, 2);
      assert.equal(stored.recurrence_confirm, 1);
    });
  }
});

test('the transfer dialog saves three-decimal currency amounts and blocks finer amounts', async () => {
  const target = Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Dinar savings', 'savings', 'KWD', ?)").run(A).lastInsertRowid);
  await withTransfer(async page => {
    await page.select('#bt-from', String(dinarAccount));
    await page.select('#bt-to', String(target));
    await page.$eval('#bt-title', el => { el.value = 'Precise transfer'; });
    await page.$eval('#bt-amount', el => { el.value = '1.0005'; });
    const before = writes.length;
    await page.$eval('#bm-save', el => el.click());
    await page.waitForFunction(() => document.querySelector('#bt-amount').getAttribute('aria-invalid') === 'true');
    assert.equal(writes.length, before, 'an off-grid amount does not reach the API');
    await page.$eval('#bt-amount', el => { el.value = '1.005'; });
    const response = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/budget/transfers'));
    await page.$eval('#bm-save', el => el.click());
    assert.equal((await response).status(), 201);
    assert.deepEqual(db.prepare("SELECT amount FROM budget_entries WHERE title = 'Precise transfer' ORDER BY amount").all().map(e => e.amount), [-1.005, 1.005]);
  });
});

test('confirming a pending transfer uses its account currency step and preserves the corrected amount', async () => {
  const target = Number(db.prepare("INSERT INTO budget_accounts (name, type, currency, created_by) VALUES ('Confirmation dinars', 'savings', 'KWD', ?)").run(A).lastInsertRowid);
  const created = await request('POST', '/transfers', { title: 'Precise confirmation', amount: 1.005, date: '2020-01-06',
    from_account_id: dinarAccount, to_account_id: target, is_recurring: true, recurrence_confirm: true });
  assert.equal(created.status, 201);
  const month = await request('GET', `/?month=${todayKey(db).slice(0, 7)}`);
  const occurrence = month.body.data.find(e => e.recurrence_parent_id === created.body.data.id);
  assert.ok(occurrence);
  const page = await newPage();
  try {
    await page.evaluateOnNewDocument(() => localStorage.setItem('yuvomi-number-locale', 'de-DE'));
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true);
    await page.$eval(`.budget-entry[data-id="${occurrence.id}"] [data-action="confirm"]`, el => el.click());
    await page.waitForSelector('#cb-amount');
    assert.equal(await page.$eval('#cb-amount', el => el.hasAttribute('step') || el.hasAttribute('min')), false);
    const money = (fn, ...args) => page.evaluate(async (name, rest) => (await import('/utils/money.js'))[name](...rest), fn, args);
    assert.equal(await page.$eval('#cb-amount', el => el.placeholder), await money('amountPlaceholder', 'KWD'));
    await page.$eval('#cb-amount', el => { el.value = ''; });
    await page.type('#cb-amount', '2,005');
    assert.equal(await page.$eval('#cb-amount', el => el.value), '2,005');
    const response = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().endsWith(`/${occurrence.id}/confirm`));
    await page.$eval('#cb-save', el => el.click());
    assert.equal((await response).status(), 200);
    const outgoing = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(occurrence.id);
    const incoming = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(outgoing.transfer_entry_id);
    assert.equal(outgoing.amount, -2.005);
    assert.equal(incoming.amount, 2.005);
    assert.equal(outgoing.is_pending, 0);
    assert.equal(incoming.is_pending, 0);
  } finally { await page.close(); }
});
