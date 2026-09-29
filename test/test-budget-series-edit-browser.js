/**
 * Modul: "Alle zukuenftigen" aus einem Vorkommen (#1546), Browser-Sonde
 * Zweck: Der Bearbeiten-Dialog eines erzeugten Vorkommens schickte bei "Alle
 *        zukuenftigen aendern" die Rhythmus-Felder DIESES Vorkommens mit -
 *        is_recurring 0, monatlich, alle 1, nicht virtuell - und beendete damit
 *        still die ganze Serie. Gemessen wird hier am AUFRUFER: welchen Body
 *        schickt der echte Dialog, und laeuft die Serie danach weiter?
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
});
