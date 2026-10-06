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
  // Dazwischen steht nur der Faelligkeitstag (#1631), der zum Monat gehoert.
  const start = overview.indexOf('lm-start:input/month');
  assert.deepEqual(overview.slice(start + 1, start + 3), ['lm-due-day:input/number', 'lm-paid:input/number'],
    'das Feld steht unter dem ersten Faelligkeitsmonat und seinem Tag');
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

// ─── #1656: Pruefung am Feld, Absagen in der Sprache der Oberflaeche ─────────
// "Bereits gezahlte Raten" pruefte erst der Server, und seine Absage kam als
// englischer Satz in einem Toast - an keinem Feld, in jeder Sprache gleich.

/** Der Satz der Oberflaeche zu einem Schluessel, aus der Seite selbst gelesen. */
const sentence = (page, key, values) => page.evaluate(async (k, v) => (await import('/i18n.js')).t(k, v), key, values);

/** Faengt die Toasts der Seite ab; die Sonde hat keinen Router, der sie zeigte. */
const captureToasts = (page) => page.evaluate(() => {
  window.__toasts = [];
  window.yuvomi = { ...(window.yuvomi ?? {}), showToast: (message, kind) => window.__toasts.push({ message, kind }) };
});

/** Zustand eines Feldes, wie ihn der Nutzer sieht: markiert, mit welchem Satz, Dialog noch offen. */
const fieldState = (page, selector) => page.evaluate((sel) => {
  const input = document.querySelector(sel);
  return {
    open: Boolean(document.querySelector('#lm-borrower')),
    invalid: input?.getAttribute('aria-invalid') ?? null,
    message: input?.parentElement?.querySelector('.form-field__error')?.textContent ?? null,
    focused: document.activeElement === input,
    toasts: window.__toasts ?? [],
  };
}, selector);

const waitInvalid = (page, selector) => page.waitForFunction(
  (sel) => document.querySelector(sel)?.getAttribute('aria-invalid') === 'true', { timeout: 5000 }, selector,
);

const loanPosts = () => writes.filter((w) => w.method === 'POST' && w.path === '/budget/loans');

/** Beantwortet das Speichern des Darlehens selbst; alles andere laeuft zum echten Router. */
async function answerSaveWith(page, status, body) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/budget/loans') {
      req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } else {
      req.continue();
    }
  });
}

for (const entry of Object.keys(ENTRIES)) {
  test(`${entry}: mehr gezahlte Raten als das Darlehen hat - das Feld sagt es, nichts geht an den Server`, async () => {
    writes.length = 0;
    const borrower = `Zuviel ${entry}`;
    const seen = await withLoanDialog(entry, async (page, saveSelector) => {
      await captureToasts(page);
      await setValue(page, '#lm-borrower', borrower);
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      await setValue(page, '#lm-paid', '13');
      await page.click(saveSelector);
      // Der alte Stand schickte ab und bekam eine 400 - die Zeit dafuer bekommt er.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const refused = await fieldState(page, '#lm-paid');
      const posts = loanPosts().length;
      // #1668: der Satz nennt, wie viele Raten das Darlehen hat.
      const expected = await sentence(page, 'budget.loanPaidInstallmentsMax', { max: 12 });

      // Eine korrigierte Zahl nimmt die Markierung weg, und das Speichern geht durch.
      await setValue(page, '#lm-paid', '12');
      const corrected = await fieldState(page, '#lm-paid');
      await page.click(saveSelector);
      await page.waitForFunction(() => !document.querySelector('#lm-borrower'), { timeout: 5000 });
      return { refused, posts, expected, corrected };
    });
    assert.equal(seen.posts, 0, 'vor dem Speichern geprueft: kein POST');
    assert.equal(seen.refused.open, true, 'der Dialog bleibt offen');
    assert.equal(seen.refused.invalid, 'true', 'das Feld ist markiert');
    assert.equal(seen.refused.focused, true, 'und hat den Fokus');
    assert.equal(seen.refused.message, seen.expected, 'mit dem Satz der Oberflaeche');
    assert.notEqual(seen.expected, 'budget.loanPaidInstallmentsMax', 'Vorbedingung: der Schluessel ist uebersetzt');
    assert.match(seen.expected, /\b12\b/, 'der Satz nennt das Maximum (#1668)');
    assert.deepEqual(seen.refused.toasts, [], 'kein Toast neben dem Feld');
    assert.equal(seen.corrected.invalid, 'false', 'die Korrektur nimmt die Markierung weg');
    assert.equal(loanPosts().length, 1, 'danach genau ein Darlehen');
    assert.equal(loanPosts()[0].body.paid_installments, 12);
  });

  test(`${entry}: eine negative oder gebrochene Zahl gezahlter Raten bleibt am Feld`, async () => {
    writes.length = 0;
    const seen = await withLoanDialog(entry, async (page, saveSelector) => {
      await setValue(page, '#lm-borrower', `Minus ${entry}`);
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      const states = [];
      for (const bad of ['-1', '1.5']) {
        await setValue(page, '#lm-paid', bad);
        await page.click(saveSelector);
        await new Promise((resolve) => setTimeout(resolve, 600));
        states.push(await fieldState(page, '#lm-paid'));
      }
      return { states, expected: await sentence(page, 'budget.loanPaidInstallmentsInvalid') };
    });
    assert.equal(loanPosts().length, 0, 'kein POST');
    for (const state of seen.states) {
      assert.deepEqual(
        { open: state.open, invalid: state.invalid, message: state.message },
        { open: true, invalid: 'true', message: seen.expected },
      );
    }
  });

  test(`${entry}: mit Zins zaehlt die Laufzeit, die der Server ableitet`, async () => {
    writes.length = 0;
    const seen = await withLoanDialog(entry, async (page, saveSelector) => {
      await setValue(page, '#lm-borrower', `Zins ${entry}`);
      await setValue(page, '#lm-interest-mode', 'fixed', 'change');
      await setValue(page, '#lm-principal', '10000');
      await setValue(page, '#lm-fixed-rate', '2');
      // 50 % Anfangstilgung: nach rund zwei Jahren ist das Darlehen getilgt.
      await setValue(page, '#lm-initial-repayment', '50');
      await setValue(page, '#lm-paid', '300');
      // Sofort speichern - die Vorschau des Formulars (300 ms verzoegert) ist
      // noch nicht da; die Pruefung darf sich nicht auf sie verlassen.
      await page.click(saveSelector);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const state = await fieldState(page, '#lm-paid');
      const button = await page.$eval(saveSelector, (el) => ({ disabled: el.disabled, text: el.textContent.trim() }));
      // #1668: der Satz nennt die Laufzeit, die der Server fuer diese Werte ableitet.
      const months = await page.evaluate(async () => {
        const res = await fetch('/api/v1/budget/loans/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interest_mode: 'fixed', principal: 10000, fixed_rate: 2, initial_repayment_rate: 50 }),
        });
        return (await res.json()).data.total_months;
      });
      return { state, button, months, expected: await sentence(page, 'budget.loanPaidInstallmentsMax', { max: months }) };
    });
    assert.ok(Number.isInteger(seen.months) && seen.months > 1 && seen.months < 300, `Vorbedingung: die Laufzeit (${seen.months})`);
    assert.ok(seen.expected.includes(String(seen.months)), 'der Satz nennt die Laufzeit (#1668)');
    const term = writes.filter((w) => w.path === '/budget/loans/preview').length;
    assert.ok(term >= 1, 'die Laufzeit kommt vom Server (Vorschau), nicht aus einer zweiten Formel');
    assert.equal(loanPosts().length, 0, 'kein POST auf /budget/loans');
    assert.deepEqual(
      { open: seen.state.open, invalid: seen.state.invalid, message: seen.state.message },
      { open: true, invalid: 'true', message: seen.expected },
    );
    assert.equal(seen.button.disabled, false, 'der Speichern-Knopf ist wieder frei');
    assert.notEqual(seen.button.text, '…', 'und traegt wieder seine Beschriftung');
  });

  test(`${entry}: eine Absage des Servers landet am Feld, in der Sprache der Oberflaeche`, async () => {
    writes.length = 0;
    const seen = await withLoanDialog(entry, async (page, saveSelector) => {
      await captureToasts(page);
      await setValue(page, '#lm-borrower', `Server ${entry}`);
      await setValue(page, '#lm-amount', '1200');
      // Der Client prueft nur ">= 1"; die Obergrenze 360 kennt der Server.
      await setValue(page, '#lm-installments', '361');
      await page.click(saveSelector);
      await waitInvalid(page, '#lm-installments');
      return {
        state: await fieldState(page, '#lm-installments'),
        // #1668: der Satz nennt die Grenze, die der Server mitschickt.
        expected: await sentence(page, 'budget.loanInstallmentsRange', { max: 360 }),
      };
    });
    assert.equal(loanPosts().length, 1, 'Vorbedingung: die Anfrage ging an den echten Router');
    assert.equal(seen.state.open, true, 'der Dialog bleibt offen');
    assert.equal(seen.state.message, seen.expected);
    assert.match(seen.state.message, /\b360\b/, 'der Satz nennt die Grenze (#1668)');
    assert.doesNotMatch(seen.state.message, /Installment count must be/, 'nicht der Satz der API');
    assert.deepEqual(seen.state.toasts, [], 'kein Toast mit dem Servertext');
  });

  test(`${entry}: der Grund des Servers entscheidet ueber Feld und Satz, nie sein Text`, async () => {
    const raw = 'A sentence this client has never seen.';
    const run = (status, body, wait) => withLoanDialog(entry, async (page, saveSelector) => {
      await captureToasts(page);
      await answerSaveWith(page, status, body);
      await setValue(page, '#lm-borrower', `Grund ${entry}`);
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      await page.click(saveSelector);
      await wait(page);
      return {
        state: await fieldState(page, '#lm-paid'),
        button: await page.$eval(saveSelector, (el) => el.disabled),
        tooMany: await sentence(page, 'budget.loanPaidInstallmentsTooMany'),
        failed: await sentence(page, 'budget.loanSaveFailed'),
        server: await sentence(page, 'common.errorServer'),
      };
    });
    const toast = (page) => page.waitForFunction(() => window.__toasts?.length > 0, { timeout: 5000 });

    const atField = await run(400, { error: raw, code: 400, reason: 'loan_paid_installments_exceed' }, (page) => waitInvalid(page, '#lm-paid'));
    assert.equal(atField.state.message, atField.tooMany, 'bekannter Grund: am Feld, mit seinem Satz');
    assert.deepEqual(atField.state.toasts, []);
    assert.equal(atField.state.open, true);
    assert.equal(atField.button, false, 'der Speichern-Knopf ist wieder frei');

    const unknown = await run(400, { error: raw, code: 400 }, toast);
    assert.deepEqual(unknown.state.toasts, [{ message: unknown.failed, kind: 'danger' }], '400 ohne Grund: der Satz des Dialogs');
    assert.equal(unknown.state.open, true);

    const broken = await run(500, { error: 'Internal error', code: 500 }, toast);
    assert.deepEqual(broken.state.toasts, [{ message: broken.server, kind: 'danger' }], '500: der Satz der App');
    assert.equal(broken.state.open, true);
  });
}

// ─── #1668: genauere Saetze im Darlehens-Dialog ─────────────────────────────
// Vier Saetze waren ungenau: "tilgt nicht" fuer ein Darlehen, das zu lange
// laeuft, "Anzahl eingeben" fuer 361 Raten (oben), "zu viele" ohne Zahl (oben),
// und der allgemeine Satz des Dialogs an Titel, Notizen, Waehrung und Konto.

for (const entry of Object.keys(ENTRIES)) {
  test(`${entry}: ein Darlehen, das zu lange liefe, sagt das - in der Vorschau und beim Speichern`, async () => {
    writes.length = 0;
    const seen = await withLoanDialog(entry, async (page, saveSelector) => {
      await captureToasts(page);
      await setValue(page, '#lm-borrower', `Lang ${entry}`);
      await setValue(page, '#lm-interest-mode', 'fixed', 'change');
      await setValue(page, '#lm-principal', '100000');
      await setValue(page, '#lm-fixed-rate', '5');
      // 0,01 % Anfangstilgung: die Rate deckt die Zinsen, aber das Darlehen
      // liefe laenger, als gerechnet wird.
      await setValue(page, '#lm-initial-repayment', '0.01');
      await page.waitForFunction(() => document.querySelector('#lm-interest-preview')?.textContent.trim().length > 0, { timeout: 5000 });
      const preview = await page.$eval('#lm-interest-preview', (el) => el.textContent.trim());
      await page.click(saveSelector);
      await waitInvalid(page, '#lm-initial-repayment');
      return {
        preview,
        state: await fieldState(page, '#lm-initial-repayment'),
        expected: await sentence(page, 'budget.loanTermTooLong', { max: 600 }),
        notAmortizing: await sentence(page, 'budget.loanPreviewInvalid'),
      };
    });
    assert.equal(loanPosts().length, 1, 'Vorbedingung: die Anfrage ging an den echten Router');
    assert.match(seen.expected, /\b600\b/, 'Vorbedingung: der Satz nennt die Grenze');
    assert.notEqual(seen.expected, seen.notAmortizing, 'Vorbedingung: zwei Saetze fuer zwei Faelle');
    assert.equal(seen.state.message, seen.expected, 'beim Speichern: der eigene Satz, am Feld der Tilgung');
    assert.equal(seen.preview, seen.expected, 'die Vorschau sagt denselben Satz');
    assert.equal(seen.state.open, true);
    assert.deepEqual(seen.state.toasts, []);
  });

  test(`${entry}: Titel, Notizen, Waehrung und Konto haben je einen eigenen Satz an ihrem Feld`, async () => {
    const raw = 'A sentence this client has never seen.';
    const run = (reason, selector, prepare = async () => {}) => withLoanDialog(entry, async (page, saveSelector) => {
      await captureToasts(page);
      await answerSaveWith(page, 400, { error: raw, code: 400, reason });
      await setValue(page, '#lm-borrower', `Satz ${entry}`);
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      await prepare(page);
      await page.click(saveSelector);
      await waitInvalid(page, selector);
      return {
        state: await fieldState(page, selector),
        general: await sentence(page, 'budget.loanSaveFailed'),
      };
    });
    const sentences = new Set();
    for (const [reason, selector, key] of [
      ['loan_title_invalid', '#lm-title', 'budget.loanTitleInvalid'],
      ['loan_notes_invalid', '#lm-notes', 'budget.loanNotesInvalid'],
      ['loan_currency_invalid', '#lm-currency', 'budget.loanCurrencyInvalid'],
    ]) {
      const seen = await run(reason, selector);
      const expected = await withLoanDialog(entry, (page) => sentence(page, key));
      assert.notEqual(expected, key, `Vorbedingung: ${key} ist uebersetzt`);
      assert.equal(seen.state.message, expected, `${reason}: der eigene Satz an ${selector}`);
      assert.notEqual(seen.state.message, seen.general, `${reason}: nicht mehr der allgemeine Satz`);
      assert.notEqual(seen.state.message, raw, `${reason}: nicht der Satz des Servers`);
      assert.deepEqual(seen.state.toasts, [], `${reason}: kein Toast neben dem Feld`);
      sentences.add(seen.state.message);
    }
    assert.equal(sentences.size, 3, 'drei Felder, drei Saetze');
  });
}

test('das Konto eines Darlehens, das es nicht mehr gibt: der Satz steht am Konto-Feld', async () => {
  // Echte Absage des echten Routers: das Konto wird geloescht, waehrend der
  // Dialog offen ist. Bis #1668 kam hier "Konto nicht gefunden." - deutsch, vom
  // Server, mit dem allgemeinen Satz des Dialogs am Feld.
  const account = db.prepare("INSERT INTO budget_accounts (name, type, starting_balance, created_by) VALUES ('Weg1668', 'checking', 0, ?)").run(A).lastInsertRowid;
  try {
    const seen = await withLoanDialog('loansTab', async (page, saveSelector) => {
      await captureToasts(page);
      await setValue(page, '#lm-borrower', 'Konto weg');
      await setValue(page, '#lm-amount', '1200');
      await setValue(page, '#lm-installments', '12');
      await setValue(page, '#lm-account', String(account), 'change');
      await page.evaluate((id) => fetch(`/api/v1/budget/accounts/${id}`, { method: 'DELETE' }), account);
      await page.click(saveSelector);
      await waitInvalid(page, '#lm-account');
      return {
        state: await fieldState(page, '#lm-account'),
        expected: await sentence(page, 'budget.accountNotFound'),
        general: await sentence(page, 'budget.loanSaveFailed'),
      };
    });
    assert.equal(seen.state.message, seen.expected);
    assert.notEqual(seen.state.message, seen.general);
    assert.doesNotMatch(seen.state.message, /Konto nicht gefunden|Account not found/, 'nicht der Satz des Servers');
    assert.deepEqual(seen.state.toasts, []);
    assert.equal(seen.state.open, true);
  } finally {
    db.prepare('DELETE FROM budget_accounts WHERE id = ?').run(account);
  }
});
