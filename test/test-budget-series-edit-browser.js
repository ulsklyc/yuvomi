/**
 * Modul: "Alle zukuenftigen" aus einem Vorkommen (#1546), Browser-Sonde
 * Zweck: Der Bearbeiten-Dialog eines erzeugten Vorkommens schickte bei "Alle
 *        zukuenftigen aendern" die Rhythmus-Felder DIESES Vorkommens mit -
 *        is_recurring 0, monatlich, alle 1, nicht virtuell - und beendete damit
 *        still die ganze Serie. Gemessen wird hier am AUFRUFER: welchen Body
 *        schickt der echte Dialog, und laeuft die Serie danach weiter?
 *        Seit #1035 hat die Serie eine eigene Definition (budget_series): die
 *        erste Buchung ist eine gewoehnliche, gebuchte Buchung und bleibt bei
 *        "alle kuenftigen" stehen. An ihr wird der Rhythmus geaendert und die
 *        Serie beendet - beides misst diese Sonde ebenfalls am Aufrufer.
 * Ausfuehren: npm run test:budget-series-edit-browser (haengt an test:document-guards)
 *
 * WARUM IM BROWSER: `test:budget-entries-routes` misst die Route mit einem Body,
 * den der Test selbst schreibt, und `test:budget-ui` die reine Funktion, die
 * den Body baut. Ob der Dialog sie auch AUFRUFT - und mit dem Formular eines
 * Vorkommens -, sieht keine der beiden. Der Fehler sass genau dort.
 *
 * AUFBAU OHNE ANMELDUNG: die echte Seite `public/pages/budget.js` in echtem
 * Chrome, dahinter der echte Budget-Router auf einer In-Memory-Datenbank. Die
 * Identitaet setzt eine Middleware, wie in test:budget-entries-routes; die
 * uebrige App-Shell (Router, Navigation) ist fuer diesen Dialog unbeteiligt.
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

const monthOf = (today, offset) => {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const seriesRow = (anchor) => db.prepare('SELECT * FROM budget_series WHERE anchor_id = ?').get(anchor);

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v1/budget${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => null);
}

/** Legt eine Serie an, materialisiert die Monate um heute, bearbeitet das Vorkommen dieses Monats. */
async function editOccurrenceForAllFuture(seriesFields) {
  const today = todayKey(db);
  const created = await api('POST', '', {
    title: 'Miete', category: 'housing', subcategory: 'rent_mortgage', is_recurring: 1,
    date: `${monthOf(today, -3)}-01`, ...seriesFields,
  });
  const anchor = created.data.id;
  for (let i = -3; i <= 2; i++) await api('GET', `?month=${monthOf(today, i)}`);
  const occurrence = db.prepare(
    'SELECT * FROM budget_entries WHERE recurrence_parent_id = ? AND date LIKE ? ORDER BY date LIMIT 1'
  ).get(anchor, `${today.slice(0, 7)}%`);
  assert.ok(occurrence, 'ein Vorkommen im laufenden Monat');

  writes.length = 0;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
    await page.waitForSelector(`.budget-entry[data-id="${occurrence.id}"]`, { timeout: 10000 });
    await page.click(`.budget-entry[data-id="${occurrence.id}"]`);
    await page.waitForSelector('#bm-title', { timeout: 5000 });
    const recurringVisible = await page.$eval('#bm-recurring', (el) => el.closest('.form-group').hidden === false);
    await page.$eval('#bm-title', (el) => { el.value = 'Miete neu'; });
    await page.click('#bm-save');
    await page.waitForSelector('#rcs-series', { timeout: 5000 });
    await page.click('#rcs-series');
    await page.waitForFunction(() => !document.querySelector('#rcs-series'), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(errors, [], 'keine Fehler in der Seite');
    return { anchor, occurrence, today, recurringVisible, sent: writes.filter((w) => w.path.endsWith('/series')) };
  } finally {
    await page.close();
  }
}

test('"Alle zukuenftigen" aus einem Vorkommen schickt keinen Rhythmus und die Serie laeuft weiter', async () => {
  const { anchor, occurrence, today, recurringVisible, sent } = await editOccurrenceForAllFuture({
    amount: -900, recurrence_interval: 'weekly', recurrence_interval_count: 2,
  });
  assert.equal(recurringVisible, false, 'am Vorkommen steht kein Schalter "wiederkehrend"');
  assert.equal(sent.length, 1, 'genau ein Serien-Aufruf');
  assert.equal(sent[0].path, `/budget/${occurrence.id}/series`);
  assert.deepEqual(sent[0].body, { title: 'Miete neu' }, 'nur der geaenderte Titel, kein Rhythmus, kein Datum');

  const a = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor);
  assert.equal(a.is_recurring, 1, 'die Serie laeuft weiter');
  assert.equal(a.recurrence_interval, 'weekly', 'alle zwei Wochen bleibt alle zwei Wochen');
  assert.equal(a.recurrence_interval_count, 2);
  const future = db.prepare(
    'SELECT title FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?'
  ).all(anchor, today);
  assert.ok(future.length > 0, 'kuenftige Vorkommen bleiben stehen');
  assert.ok(future.every((r) => r.title === 'Miete neu'), 'und tragen den neuen Titel');
  // #1035: die erste Buchung liegt drei Monate zurueck, ist gebucht und
  // behaelt ihren Titel; die Vorlage fuer kuenftige Monate ist die Definition.
  assert.equal(a.title, 'Miete', 'die gebuchte erste Buchung bleibt unveraendert');
  assert.equal(seriesRow(anchor).title, 'Miete neu', 'die Definition traegt den neuen Titel');
});

test('eine virtuelle Serie behaelt ihr virtual-Flag und ihren Periodenbetrag', async () => {
  const { anchor, sent } = await editOccurrenceForAllFuture({
    amount: -1200, recurrence_interval: 'yearly', recurrence_virtual: 1,
  });
  assert.deepEqual(sent[0].body, { title: 'Miete neu' });
  const a = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor);
  assert.equal(a.is_recurring, 1);
  assert.equal(a.recurrence_virtual, 1, 'virtuell bleibt virtuell');
  assert.equal(a.recurrence_interval, 'yearly');
  assert.equal(a.recurrence_full_amount, -1200);
  assert.equal(a.title, 'Miete', 'die gebuchte erste Buchung bleibt unveraendert');
  const def = seriesRow(anchor);
  assert.equal(def.title, 'Miete neu');
  assert.equal(def.full_amount, -1200, 'die Definition behaelt den Periodenbetrag');
});

// ── Die erste Buchung (#1035 nach #1546) ──────────────────────────────────────
//
// Seit #1546 weist PUT /:id/series `is_recurring: false` ab, und der Dialog
// eines Vorkommens schickt keinen Rhythmus mehr. An der ERSTEN Buchung ist das
// anders: dort steht der Schalter "wiederkehrend", dort wird der Rhythmus
// geaendert und die Serie beendet. Beenden laeuft deshalb ohne Rueckfrage ueber
// PUT /:id (eine Rueckfrage "nur diese / alle kuenftigen" ergibt fuer ein Ende
// keinen Sinn), und "alle kuenftigen" schickt von hier den Rhythmus mit.

/** Oeffnet die erste Buchung (letzter Monat, also gebucht), wendet `edit` an und speichert. */
async function editAnchor(seriesFields, edit, { choice = 'series', prepare } = {}) {
  const today = todayKey(db);
  const created = await api('POST', '', {
    title: 'Strom', category: 'housing', subcategory: 'rent_mortgage', amount: -80, is_recurring: 1,
    date: `${monthOf(today, -1)}-05`, ...seriesFields,
  });
  const anchor = created.data.id;
  for (let i = -1; i <= 2; i++) await api('GET', `?month=${monthOf(today, i)}`);
  if (prepare) await prepare(anchor, today);

  writes.length = 0;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/__budget-probe.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
    await page.click('#budget-prev');
    await page.waitForSelector(`.budget-entry[data-id="${anchor}"]`, { timeout: 10000 });
    await page.click(`.budget-entry[data-id="${anchor}"]`);
    await page.waitForSelector('#bm-title', { timeout: 5000 });
    await page.evaluate(edit);
    await page.click('#bm-save');
    // Entweder kommt die Umfang-Frage, oder das Formular schliesst ohne sie.
    await page.waitForFunction(() => document.querySelector('#rcs-series') || !document.querySelector('#bm-title'),
      { timeout: 5000 });
    const asked = Boolean(await page.$('#rcs-series'));
    if (asked) {
      await page.click(choice === 'series' ? '#rcs-series' : '#rcs-this');
      await page.waitForFunction(() => !document.querySelector('#rcs-series'), { timeout: 5000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(errors, [], 'keine Fehler in der Seite');
    return { anchor, today, asked, sent: writes.slice() };
  } finally {
    await page.close();
  }
}

test('"wiederkehrend" an der ersten Buchung abwaehlen beendet die Serie ueber PUT /:id, ohne Rueckfrage', async () => {
  const { anchor, asked, sent } = await editAnchor({}, () => {
    const box = document.querySelector('#bm-recurring');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(asked, false, 'ein Ende hat keinen Umfang - keine Frage "nur diese / alle kuenftigen"');
  assert.deepEqual(sent.map((w) => `${w.method} ${w.path}`), [`PUT /budget/${anchor}`],
    'genau ein Aufruf, an die Buchung selbst, nicht an /series (dort seit #1546 400)');
  assert.equal(sent[0].body.is_recurring, 0);
  const a = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor);
  assert.equal(a.is_recurring, 0, 'die Serie ist beendet');
  assert.equal(seriesRow(anchor), undefined, 'ihre Definition ist abgeraeumt');
});

test('"alle kuenftigen" an der ersten Buchung schickt den Rhythmus mit; die gebuchte Buchung bleibt', async () => {
  const { anchor, today, asked, sent } = await editAnchor({}, () => {
    document.querySelector('#bm-title').value = 'Strom neu';
    const sel = document.querySelector('#bm-interval');
    sel.value = 'yearly';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(asked, true, 'die erste Buchung fragt nach dem Umfang (#1035)');
  const series = sent.filter((w) => w.path.endsWith('/series'));
  assert.equal(series.length, 1, 'genau ein Serien-Aufruf');
  assert.equal(series[0].path, `/budget/${anchor}/series`);
  assert.equal(series[0].body.recurrence_interval, 'yearly', 'der Rhythmus geht an die Serie');
  assert.equal(series[0].body.is_recurring, 1);

  const a = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor);
  assert.equal(a.is_recurring, 1, 'die Serie laeuft weiter');
  assert.equal(a.recurrence_interval, 'yearly', 'mit dem neuen Rhythmus');
  assert.equal(a.title, 'Strom', 'die gebuchte erste Buchung behaelt ihren Titel');
  assert.equal(seriesRow(anchor).title, 'Strom neu', 'die Definition traegt den neuen');
  const future = db.prepare(
    'SELECT date FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?'
  ).all(anchor, today);
  assert.ok(future.every((r) => r.date.slice(5, 7) === a.date.slice(5, 7)),
    'kuenftige Monatsvorkommen sind weg, es bleibt nur der Jahrestermin');
});

test('"alle kuenftigen" an der ersten Buchung dreht eine fruehere Serien-Aenderung nicht zurueck', async () => {
  // Nach "alle kuenftigen" an einem Vorkommen traegt die Definition 95 auf
  // "Strom neu", die gebuchte erste Buchung weiter 80 auf "Strom" - so will es
  // #1035. Ihr Formular ist mit IHREN Werten vorbelegt. Wer dort nur den
  // Rhythmus aendert und "alle kuenftigen" waehlt, darf die alten Werte nicht
  // zurueck in die Serie schreiben (claude-review auf #1541).
  const { anchor, asked, sent } = await editAnchor({}, () => {
    const sel = document.querySelector('#bm-interval');
    sel.value = 'yearly';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, {
    prepare: async (id, day) => {
      const occurrence = db.prepare(
        'SELECT id FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ? ORDER BY date LIMIT 1'
      ).get(id, day);
      const r = await api('PUT', `/${occurrence.id}/series`, { title: 'Strom neu', amount: -95 });
      assert.equal(r.data.series.title, 'Strom neu', 'Vorbedingung: die Serie wurde geaendert');
    },
  });
  assert.equal(asked, true);
  const series = sent.filter((w) => w.path.endsWith('/series'));
  assert.equal(series.length, 1);
  assert.equal(series[0].body.recurrence_interval, 'yearly', 'der geaenderte Rhythmus geht mit');
  for (const key of ['title', 'amount', 'category', 'subcategory', 'date']) {
    assert.ok(!(key in series[0].body), `${key} blieb unveraendert und geht nicht mit`);
  }
  const def = seriesRow(anchor);
  assert.equal(def.title, 'Strom neu', 'die fruehere Serien-Aenderung bleibt');
  assert.equal(def.amount, -95);
  const a = db.prepare('SELECT * FROM budget_entries WHERE id = ?').get(anchor);
  assert.equal(a.recurrence_interval, 'yearly');
  assert.equal(a.title, 'Strom', 'die gebuchte erste Buchung bleibt');
});
