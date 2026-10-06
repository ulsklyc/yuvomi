/**
 * Modul: Absagen der Budget-Seite und der Filter beim Betreten (#1668, #1593), Browser-Sonde
 * Zweck: 13 Stellen der Budget-Seite schrieben den Satz des Servers in einen
 *        Toast - englisch oder, fuer das Konto, deutsch ("Konto nicht
 *        gefunden."), in jeder Sprache gleich und an keinem Feld. Gemessen wird
 *        an der gerenderten Seite: steht der Satz der Oberflaeche am richtigen
 *        Feld, und kommt der des Servers nirgends an. Dazu der
 *        Zustaendigen-Filter, der den Seitenwechsel ueberlebte (#1593).
 * Ausfuehren: npm run test:budget-refusals-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: ob eine Absage am Feld landet, entscheidet sich am Dialog,
 * der gerade offen ist - `panel` muss beim Aufrufer wirklich der Dialog sein,
 * das Feld wirklich darin stehen. test:budget-ui prueft Zuordnung und Saetze,
 * den Klick sieht nur, wer ihn ausfuehrt.
 *
 * AUFBAU OHNE ANMELDUNG: wie test-budget-loan-dialogs-browser.js - die echte
 * Seite in echtem Chrome, dahinter der echte Budget-Router auf einer
 * In-Memory-Datenbank, die Identitaet setzt eine Middleware.
 */

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
const { todayKey } = await import('../server/utils/timezone.js');
const db = dbmod.get();
const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','Anna','x','admin')").run().lastInsertRowid;
const TODAY = todayKey(db);

let server;
let baseUrl;
let browser;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', (req, _res, next) => {
    req.authUserId = A; req.authRole = 'admin'; req.session = { userId: A };
    next();
  });
  app.get('/api/v1/preferences', (_req, res) => res.json({ data: { currency: 'EUR', budget_mode: 'shared' } }));
  app.get('/api/v1/family/members', (_req, res) => res.json({ data: [{ id: A, display_name: 'Anna' }] }));
  app.use('/api/v1/budget', budgetRouter);
  app.use('/api/v1', (_req, res) => res.json({ data: [] }));
  app.get('/__budget-probe.html', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/tokens.css"></head>
<body><main id="c"></main><script type="module">
  import { initI18n } from '/i18n.js';
  import { setPermissions } from '/permissions.js';
  import '/components/datepicker.js';
  await initI18n();
  setPermissions({ admin: true, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  const { render } = await import('/pages/budget.js');
  // Die Seite betreten - und, fuer #1593, noch einmal: das Modul bleibt geladen,
  // sein Zustand auch, genau wie beim Wechsel zu einer anderen Seite und zurueck.
  window.__enter = () => render(document.getElementById('c'), { user: { id: ${A}, role: 'admin' } });
  window.__toasts = [];
  window.yuvomi = { ...(window.yuvomi ?? {}), showToast: (message, kind) => window.__toasts.push({ message, kind }) };
  await window.__enter();
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

async function withPage(probe) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
    const result = await probe(page);
    assert.deepEqual(errors, [], 'keine Fehler in der Seite');
    return result;
  } finally {
    await page.close();
  }
}

const sentence = (page, key, values) => page.evaluate(async (k, v) => (await import('/i18n.js')).t(k, v), key, values);
const toasts = (page) => page.evaluate(() => window.__toasts);
const waitToast = (page) => page.waitForFunction(() => window.__toasts.length > 0, { timeout: 5000 });
const setValue = (page, selector, value, event = 'input') => page.$eval(selector, (el, v, ev) => {
  el.value = v;
  el.dispatchEvent(new Event(ev, { bubbles: true }));
}, value, event);
const waitInvalid = (page, selector) => page.waitForFunction(
  (sel) => document.querySelector(sel)?.getAttribute('aria-invalid') === 'true', { timeout: 5000 }, selector,
);
const fieldMessage = (page, selector) => page.evaluate((sel) => {
  const input = document.querySelector(sel);
  return input?.closest('.form-group, .form-field')?.querySelector('.form-field__error')?.textContent
    ?? input?.parentElement?.querySelector('.form-field__error')?.textContent ?? null;
}, selector);
const api = (page, method, path, body) => page.evaluate(async (m, p, b) => {
  const res = await fetch(`/api/v1/budget${p}`, {
    method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}, method, path, body);

/** Oeffnet "Neuer Eintrag" und fuellt, was die Pruefung am Feld verlangt. */
async function openNewEntry(page, { title = 'Probe', amount = '5' } = {}) {
  await page.$eval('#fab-new-budget', (el) => el.click());
  await page.waitForSelector('#bm-save', { timeout: 5000 });
  await setValue(page, '#bm-title', title);
  await setValue(page, '#bm-amount', amount);
  await page.$eval('#bm-category', (el) => {
    el.value = [...el.options].find((o) => o.value)?.value ?? '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.$eval('#bm-subcategory', (el) => {
    const first = [...el.options].find((o) => o.value);
    if (first) { el.value = first.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
}

/** Beantwortet das Anlegen einer Buchung selbst; alles andere laeuft zum echten Router. */
async function answerEntrySaveWith(page, status, body) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/budget') {
      req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } else {
      req.continue();
    }
  });
}

// ─── #1593: der Zustaendigen-Filter faellt beim Betreten der Seite zurueck ───

test('#1593: wer das Budget verlaesst und zurueckkommt, sieht die ganze Liste', async () => {
  const ids = [];
  for (const title of ['Miete', 'Strom', 'Brot']) {
    ids.push(db.prepare(`INSERT INTO budget_entries (title, amount, category, subcategory, date, created_by, owner_id, visibility)
      VALUES (?, -10, 'housing', '', ?, ?, ?, 'shared')`).run(title, TODAY, A, A).lastInsertRowid);
  }
  try {
    const seen = await withPage(async (page) => {
      const put = await api(page, 'PUT', `/${ids[0]}`, { responsible_user_ids: [A] });
      const snap = () => page.evaluate(() => ({
        rows: document.querySelectorAll('.budget-entry').length,
        chip: document.querySelector('#budget-clear-responsible-filter')?.textContent.trim() ?? null,
      }));
      await page.evaluate(() => window.__enter());
      const start = await snap();
      await page.$eval('[data-responsible]', (el) => el.click());
      await page.waitForSelector('#budget-clear-responsible-filter', { timeout: 5000 });
      const filtered = await snap();
      // Seite verlassen und zurueck: der Router ruft render() erneut.
      await page.evaluate(() => window.__enter());
      const back = await snap();
      return { put: put.status, start, filtered, back };
    });
    assert.equal(seen.put, 200, 'Vorbedingung: eine Buchung hat eine Zustaendige');
    assert.deepEqual(seen.start, { rows: 3, chip: null }, 'Vorbedingung: drei Buchungen, kein Filter');
    assert.deepEqual(seen.filtered, { rows: 1, chip: 'Anna' }, 'Vorbedingung: der Filter kuerzt die Liste und zeigt seinen Chip');
    assert.deepEqual(seen.back, { rows: 3, chip: null }, 'nach dem Zurueckkommen: die ganze Liste, kein Filter');
  } finally {
    for (const id of ids) db.prepare('DELETE FROM budget_entries WHERE id = ?').run(id);
  }
});

// ─── #1668: der Satz der Oberflaeche am Feld, nie der des Servers ────────────

test('#1668: das Konto einer Buchung gibt es nicht mehr - der Satz steht am Konto-Feld', async () => {
  // Echte Absage des echten Routers. Bis dahin: Toast "Konto nicht gefunden.".
  const account = db.prepare("INSERT INTO budget_accounts (name, type, starting_balance, created_by) VALUES ('Weg1668', 'checking', 0, ?)").run(A).lastInsertRowid;
  try {
    const seen = await withPage(async (page) => {
      await openNewEntry(page);
      await setValue(page, '#bm-account', String(account), 'change');
      const gone = await api(page, 'DELETE', `/accounts/${account}`);
      await page.click('#bm-save');
      await Promise.race([waitInvalid(page, '#bm-account'), waitToast(page)]);
      return {
        gone: gone.status,
        invalid: await page.$eval('#bm-account', (el) => el.getAttribute('aria-invalid')),
        message: await fieldMessage(page, '#bm-account'),
        toasts: await toasts(page),
        open: await page.$('#bm-save') !== null,
        expected: await sentence(page, 'budget.accountNotFound'),
      };
    });
    assert.equal(seen.gone, 204, 'Vorbedingung: das Konto ist geloescht');
    assert.notEqual(seen.expected, 'budget.accountNotFound', 'Vorbedingung: der Schluessel ist uebersetzt');
    assert.deepEqual(seen.toasts, [], 'kein Toast - schon gar nicht mit dem Satz des Servers');
    assert.equal(seen.invalid, 'true', 'das Konto-Feld ist markiert');
    assert.equal(seen.message, seen.expected, 'mit dem Satz der Oberflaeche');
    assert.equal(seen.open, true, 'der Dialog bleibt offen');
  } finally {
    db.prepare('DELETE FROM budget_accounts WHERE id = ?').run(account);
  }
});

test('#1668: der Grund entscheidet ueber Feld und Satz der Buchung, nie der Text des Servers', async () => {
  const raw = 'A sentence this client has never seen.';
  const run = (status, body, selector) => withPage(async (page) => {
    await answerEntrySaveWith(page, status, body);
    await openNewEntry(page);
    await page.click('#bm-save');
    await (selector ? waitInvalid(page, selector) : waitToast(page));
    return {
      message: selector ? await fieldMessage(page, selector) : null,
      toasts: await toasts(page),
      open: await page.$('#bm-save') !== null,
      button: await page.$eval('#bm-save', (el) => el.disabled),
    };
  });
  const text = (key) => withPage((page) => sentence(page, key));

  for (const [reason, selector, key] of [
    ['entry_amount_exceeds_loan', '#bm-amount', 'budget.amountExceedsLoanRemaining'],
    ['entry_title_invalid', '#bm-title', 'common.titleRequired'],
    ['entry_subcategory_invalid', '#bm-subcategory', 'budget.subcategoryRequired'],
  ]) {
    const seen = await run(400, { error: raw, code: 400, reason }, selector);
    assert.equal(seen.message, await text(key), `${reason}: der Satz der Oberflaeche an ${selector}`);
    assert.deepEqual(seen.toasts, [], `${reason}: kein Toast neben dem Feld`);
    assert.equal(seen.open, true);
    assert.equal(seen.button, false, 'der Speichern-Knopf ist wieder frei');
  }
  // Ein Grund ohne Feld, ein unbekannter und gar keiner: Toast mit dem Satz der App.
  for (const [status, body, key] of [
    [400, { error: raw, code: 400, reason: 'entry_responsible_invalid' }, 'budget.responsibleNotMember'],
    [400, { error: raw, code: 400, reason: 'some_future_reason' }, 'budget.saveFailed'],
    [400, { error: raw, code: 400 }, 'budget.saveFailed'],
    [409, { error: raw, code: 409 }, 'budget.saveFailed'],
    [500, { error: 'Internal error', code: 500 }, 'common.errorServer'],
  ]) {
    const seen = await run(status, body, null);
    const expected = await text(key);
    assert.notEqual(expected, key, `Vorbedingung: ${key} ist uebersetzt`);
    assert.deepEqual(seen.toasts, [{ message: expected, kind: 'danger' }], `${status} ${body.reason ?? 'ohne Grund'}`);
    assert.equal(seen.open, true);
  }
});

test('#1668: eine Rate, die schon bezahlt ist - der Toast sagt es in der Sprache der Oberflaeche', async () => {
  const seen = await withPage(async (page) => {
    const loan = await api(page, 'POST', '/loans', { borrower: 'R', title: 'R', total_amount: 1200, installment_count: 12, start_month: TODAY.slice(0, 7) });
    await page.evaluate(() => window.__enter());
    await page.$eval('#budget-tab-loans', (el) => el.click());
    await page.waitForSelector('[data-action="loan-pay"]', { timeout: 5000 });
    // Die Rate wird bezahlt, waehrend die Seite noch den Knopf dafuer zeigt
    // (zweites Geraet, zweiter Reiter).
    const behind = await api(page, 'POST', `/loans/${loan.body.data.id}/payments`, { installment_number: 1, amount: 100, paid_date: TODAY });
    await page.evaluate(() => { window.__toasts.length = 0; });
    await page.$eval('[data-action="loan-pay"]', (el) => el.click());
    await waitToast(page);
    return { behind: behind.status, toasts: await toasts(page), expected: await sentence(page, 'budget.loanInstallmentAlreadyPaid') };
  });
  assert.equal(seen.behind, 201, 'Vorbedingung: die Rate ist bezahlt');
  assert.notEqual(seen.expected, 'budget.loanInstallmentAlreadyPaid');
  assert.deepEqual(seen.toasts, [{ message: seen.expected, kind: 'danger' }]);
  assert.doesNotMatch(seen.toasts[0].message, /Installment already paid/, 'nicht der Satz der API');
});

test('#1668: eine Kategorie, die es schon gibt - der Toast traegt den Satz der Kategorien-Verwaltung', async () => {
  const seen = await withPage(async (page) => {
    const made = await api(page, 'POST', '/categories', { name: 'Doppelt1668', type: 'expense' });
    await page.evaluate(() => window.__enter());
    await page.$eval('#fab-new-budget', (el) => el.click());
    await page.waitForSelector('#bm-add-category', { timeout: 5000 });
    await page.$eval('#bm-add-category', (el) => el.click());
    await page.waitForSelector('#budget-inline-name', { timeout: 5000 });
    await setValue(page, '#budget-inline-name', 'doppelt1668');
    await page.evaluate(() => { window.__toasts.length = 0; });
    await page.$eval('[data-action="inline-save"]', (el) => el.click());
    await waitToast(page);
    return { made: made.status, toasts: await toasts(page), expected: await sentence(page, 'category.errorExists') };
  });
  assert.equal(seen.made, 201, 'Vorbedingung: die Kategorie gibt es');
  assert.deepEqual(seen.toasts, [{ message: seen.expected, kind: 'danger' }]);
  assert.doesNotMatch(seen.toasts[0].message, /Category already exists/, 'nicht der Satz der API');
});
