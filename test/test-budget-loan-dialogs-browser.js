/**
 * Modul: Die zwei Einstiege zum Anlegen eines Darlehens (#1648), Browser-Sonde
 * Zweck: Ein Darlehen laesst sich an zwei Stellen anlegen - in der Uebersicht
 *        ueber "Neuer Eintrag" mit dem Typ "Kredit" und im Darlehen-Tab ueber
 *        "Neuer Kredit". Die Feldliste stand zweimal im Quelltext; "Bereits
 *        gezahlte Raten" (#813) kam nur in den zweiten Dialog, der Vorschlag
 *        dazu wurde nur am ersten verdrahtet. Dem einen Weg fehlte das Feld,
 *        dem anderen der Vorschlag. Gemessen wird am gerenderten Dialog: welche
 *        Felder stehen dort, was schickt der Speichern-Knopf, und rechnet der
 *        Vorschlag.
 * Ausfuehren: npm run test:budget-loan-dialogs-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: ein Textguard auf "lm-paid" in budget.js war die ganze Zeit
 * gruen - die Zeichenkette stand ja da, nur im anderen Dialog. Und die
 * Verdrahtung warf erst beim AUFRUF (ReferenceError auf eine Variable, die es
 * im Geltungsbereich nie gab); das sieht nur, wer den Dialog wirklich oeffnet.
 *
 * AUFBAU OHNE ANMELDUNG: wie test-budget-series-edit-browser.js - die echte
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
const db = dbmod.get();
const A = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('a','A','x','member')").run().lastInsertRowid;

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

/** Die zwei Einstiege. Jeder oeffnet seinen Dialog so, wie ein Nutzer es tut. */
const ENTRIES = {
  // Uebersicht -> "Neuer Eintrag" -> Typ "Kredit"
  overview: async (page) => {
    await page.$eval('#fab-new-budget', (el) => el.click());
    await page.waitForSelector('#type-loan', { timeout: 5000 });
    await page.$eval('#type-loan', (el) => el.click());
    await page.waitForFunction(() => document.querySelector('#bm-loan-fields')?.hidden === false, { timeout: 5000 });
    return '#bm-save';
  },
  // Darlehen-Tab -> "Neuer Kredit"
  loansTab: async (page) => {
    await page.$eval('#budget-tab-loans', (el) => el.click());
    await page.waitForFunction(
      () => document.querySelector('#budget-tab-loans')?.getAttribute('aria-selected') === 'true',
      { timeout: 5000 },
    );
    await page.$eval('#fab-new-budget', (el) => el.click());
    await page.waitForSelector('#lm-save', { timeout: 5000 });
    return '#lm-save';
  },
};

/** Oeffnet einen der beiden Dialoge auf einer frischen Seite und reicht ihn an `probe`. */
async function withLoanDialog(entry, probe) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
    const saveSelector = await ENTRIES[entry](page);
    const result = await probe(page, saveSelector);
    assert.deepEqual(errors, [], `keine Fehler in der Seite (${entry})`);
    return result;
  } finally {
    await page.close();
  }
}

/** Die Darlehensfelder des offenen Dialogs, in Dokumentreihenfolge: id und Typ. */
const loanFields = (page) => page.$$eval(
  'input[id^="lm-"], select[id^="lm-"], textarea[id^="lm-"]',
  (els) => els.map((el) => `${el.id}:${el.tagName.toLowerCase()}${el.type ? `/${el.type}` : ''}`),
);

/** "YYYY-MM" um `n` Monate zurueck - auf dem String gerechnet, wie die Seite selbst. */
const monthsBack = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const setValue = (page, selector, value, event = 'input') => page.$eval(selector, (el, v, ev) => {
  el.value = v;
  el.dispatchEvent(new Event(ev, { bubbles: true }));
}, value, event);

test('beide Einstiege zeigen dieselben Darlehensfelder, "Bereits gezahlte Raten" eingeschlossen', async () => {
  const overview = await withLoanDialog('overview', (page) => loanFields(page));
  const loansTab = await withLoanDialog('loansTab', (page) => loanFields(page));

  assert.ok(loansTab.includes('lm-paid:input/number'), 'Vorbedingung: der Darlehens-Dialog hat das Feld');
  assert.ok(overview.includes('lm-paid:input/number'),
    'der Typ "Kredit" im Eintrags-Dialog hat "Bereits gezahlte Raten" (#1648)');
  assert.deepEqual(overview, loansTab, 'dieselben Felder in derselben Reihenfolge, egal von wo');
  assert.equal(overview.indexOf('lm-paid:input/number'), overview.indexOf('lm-start:input/month') + 1,
    'das Feld steht direkt unter dem ersten Faelligkeitsmonat');
});

for (const entry of Object.keys(ENTRIES)) {
  test(`${entry}: die eingetragenen gezahlten Raten gehen an den Server und werden nachgetragen`, async () => {
    writes.length = 0;
    const borrower = `Probe ${entry}`;
    await withLoanDialog(entry, async (page, saveSelector) => {
      await setValue(page, '#lm-borrower', borrower);
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      await setValue(page, '#lm-paid', '3');
      await page.click(saveSelector);
      await page.waitForFunction(() => !document.querySelector('#lm-borrower'), { timeout: 5000 });
    });

    const posts = writes.filter((w) => w.method === 'POST' && w.path === '/budget/loans');
    assert.equal(posts.length, 1, 'genau ein Darlehen angelegt');
    assert.equal(posts[0].body.paid_installments, 3, 'die Zahl geht im Body mit');
    const loan = db.prepare('SELECT id FROM budget_loans WHERE borrower = ?').get(borrower);
    assert.ok(loan, 'das Darlehen steht in der Datenbank');
    const payments = db.prepare(
      'SELECT installment_number, budget_entry_id FROM budget_loan_payments WHERE loan_id = ? ORDER BY installment_number'
    ).all(loan.id);
    assert.deepEqual(payments.map((p) => p.installment_number), [1, 2, 3], 'drei Raten nachgetragen');
    assert.ok(payments.every((p) => p.budget_entry_id === null), 'und keine davon ins Budget gebucht (#813)');
  });

  test(`${entry}: der Vorschlag folgt dem ersten Faelligkeitsmonat und haelt still, sobald das Feld angefasst ist`, async () => {
    const seen = await withLoanDialog(entry, async (page) => {
      // Beide Dialoge belegen den Startmonat hier mit dem laufenden Monat vor
      // (die Uebersicht zeigt ihn); von dort aus wird gerechnet, damit der
      // Test keine eigene Uhr braucht.
      const start = await page.$eval('#lm-start', (el) => el.value);
      const initial = await page.$eval('#lm-paid', (el) => el.value);
      await setValue(page, '#lm-start', monthsBack(start, 5), 'change');
      const suggested = await page.$eval('#lm-paid', (el) => el.value);
      // Ohne Zins kennt das Formular die Ratenanzahl und schlaegt nicht mehr vor.
      await setValue(page, '#lm-installments', '2');
      const capped = await page.$eval('#lm-paid', (el) => el.value);
      await setValue(page, '#lm-paid', '1');
      await setValue(page, '#lm-start', monthsBack(start, 9), 'change');
      const afterTouch = await page.$eval('#lm-paid', (el) => el.value);
      return { start, initial, suggested, capped, afterTouch };
    });
    assert.match(seen.start, /^\d{4}-\d{2}$/);
    assert.equal(seen.initial, '0', 'ein Darlehen, das diesen Monat beginnt, hat nichts hinter sich');
    assert.equal(seen.suggested, '5', 'fuenf Monate zurueck schlaegt fuenf Raten vor');
    assert.equal(seen.capped, '2', 'nie mehr als die Ratenanzahl - der Server lehnte das ab');
    assert.equal(seen.afterTouch, '1', 'eine selbst gesetzte Zahl bleibt stehen');
  });
}
