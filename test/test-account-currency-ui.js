/**
 * Tests: Betraege eines Kontos in dessen Waehrung - Buchungsdialog und
 * Kontoseite (#2302)
 * Module: public/pages/budget.js
 *
 * ENTSCHEIDUNG (Ulas, 27.10.2026): Ein Betrag auf einem Konto in Fremdwaehrung
 * steht in der Waehrung des Kontos. Der Buchungsdialog zeigt deshalb die
 * Einheit des gewaehlten Kontos und prueft die Stellen nach ihr; die Kontoseite
 * schreibt Saldo, Startsaldo und verfuegbaren Rahmen in der Kontowaehrung. Das
 * Nettovermoegen ueber mehrere Waehrungen ist eine Naeherung in der
 * Budget-Waehrung ("≈", Kursdatum darunter); fehlt ein Kurs, steht die Summe
 * je Waehrung da.
 *
 * Ausfuehren: npm run test:account-currency-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };
global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  getElementById: () => null,
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { __test: budgetUi } = await import('../public/pages/budget.js');
const { formatMoney, currencySymbol, amountPlaceholder } = await import('../public/utils/money.js');

const ACCOUNTS = [
  { id: 1, name: 'Giro', type: 'checking', currency: null, current_balance: 100, starting_balance: 10, archived: 0 },
  { id: 2, name: 'Tokio', type: 'checking', currency: 'JPY', current_balance: 5000, starting_balance: 1000, archived: 0 },
  { id: 3, name: 'Chase', type: 'credit', currency: 'USD', current_balance: -40, starting_balance: 0, archived: 0, credit_limit: 500, available_limit: 460 },
];

function withState(patch, fn) {
  const before = { ...budgetUi.state };
  Object.assign(budgetUi.state, { currency: 'EUR', accounts: ACCOUNTS, ...patch });
  try { return fn(); } finally { Object.assign(budgetUi.state, before); }
}

/** Der Buchungsdialog als Markup - openModal ist im Loader ein Griff (__openModal). */
function dialog(entry) {
  const prev = globalThis.__openModal;
  let last = null;
  globalThis.__openModal = (o) => { last = o; };
  try {
    withState({
      month: '2026-06', members: [], budgetMode: 'shared',
      meta: { expenseCategories: [{ key: 'food', name: 'Essen' }], incomeCategories: [], subcategories: {} },
    }, () => budgetUi.openBudgetModal(entry ? { mode: 'edit', entry } : { mode: 'create' }));
  } finally {
    if (prev === undefined) delete globalThis.__openModal; else globalThis.__openModal = prev;
  }
  return last.content;
}

/** Ein Panel aus Attrappen fuer genau die Felder, die der Dialog liest. */
function fakePanel(accountValue, amountValue = '') {
  const fields = {
    '#bm-account': { value: accountValue, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } },
    '#bm-amount': { value: amountValue, placeholder: '' },
    '#bm-amount-unit': { textContent: '' },
  };
  return { fields, querySelector: (sel) => fields[sel] ?? null };
}

test('Dialog: eine Buchung auf dem JPY-Konto zeigt Yen-Einheit und Yen-Platzhalter', () => {
  const html = dialog({ id: 7, title: 'Ramen', amount: -1200, category: 'food', subcategory: '', date: '2026-06-03', account_id: 2 });
  assert.ok(html.includes(`id="bm-amount-unit">${currencySymbol('JPY')}<`), 'die Einheit des Kontos, nicht €');
  assert.ok(html.includes(`placeholder="${amountPlaceholder('JPY')}"`));
});

test('Dialog: ohne Konto bleibt die Budget-Waehrung', () => {
  const html = dialog(null);
  assert.ok(html.includes(`id="bm-amount-unit">${currencySymbol('EUR')}<`));
});

test('Dialog: die Kontowahl stellt Einheit und Platzhalter um', () => {
  withState({}, () => {
    const panel = fakePanel('');
    budgetUi.bindEntryAccountCurrency(panel);
    panel.fields['#bm-account'].value = '3';
    panel.fields['#bm-account'].listeners.change();
    assert.equal(panel.fields['#bm-amount-unit'].textContent, currencySymbol('USD'));
    assert.equal(panel.fields['#bm-amount'].placeholder, amountPlaceholder('USD'));
    panel.fields['#bm-account'].value = '';
    panel.fields['#bm-account'].listeners.change();
    assert.equal(panel.fields['#bm-amount-unit'].textContent, currencySymbol('EUR'));
  });
});

test('Dialog: die Stellen werden nach der Waehrung des gewaehlten Kontos geprueft', () => {
  withState({}, () => {
    const values = { title: 'x', category: 'food', subcategory: '', date: '2026-06-03' };
    const amountError = (account) => budgetUi.entryFormErrors(fakePanel(account, '12,50'), values)
      .find((e) => e && e[0]?.value === '12,50');
    assert.ok(amountError('2'), '12,50 Yen gibt es nicht');
    assert.equal(amountError('1'), undefined, '12,50 € schon');
  });
});

test('Kontoseite: Saldo, Startsaldo und Rahmen stehen in der Kontowaehrung', () => {
  const html = withState({ netWorth: 0, netWorthInfo: { approx: false, ratesAt: null, byCurrency: [] } },
    () => budgetUi.renderAccountsPage());
  assert.ok(html.includes(formatMoney(5000, 'JPY')), 'Saldo des Yen-Kontos in Yen');
  assert.ok(html.includes(formatMoney(1000, 'JPY')), 'Startsaldo in Yen');
  assert.ok(html.includes(formatMoney(460, 'USD')), 'verfuegbarer Rahmen in Dollar');
  assert.ok(html.includes(formatMoney(100, 'EUR')), 'das Konto ohne eigene Waehrung in der Budget-Waehrung');
  assert.ok(!html.includes(formatMoney(5000, 'EUR')), 'kein Yen-Betrag mit Euro-Zeichen');
});

test('Kontoseite: das Nettovermoegen ueber Kurse ist als Naeherung gekennzeichnet', () => {
  const html = withState({
    netWorth: 145.5, netWorthInfo: { approx: true, ratesAt: '2026-10-27T08:00:00Z', byCurrency: [] },
  }, () => budgetUi.renderAccountsPage());
  assert.match(html, /<div class="metric-card__value">≈ /, 'die Karte traegt das ≈');
  assert.match(html, /class="metric-card__note">[^<]+</, 'darunter der Hinweis mit dem Kursdatum');
  assert.match(html, /budget\.netWorthApproxNote|27\.10\.2026/);
});

test('Kontoseite: ohne Kurs steht die Summe je Waehrung, keine Gesamtzahl', () => {
  const html = withState({
    netWorth: null,
    netWorthInfo: { approx: false, ratesAt: null, byCurrency: [{ currency: 'EUR', amount: 100 }, { currency: 'USD', amount: -40 }] },
  }, () => budgetUi.renderAccountsPage());
  assert.match(html, /<dl class="[^"]*budget-net-worth__parts/);
  assert.ok(html.includes(`<dt class="budget-transfer-summary__flow-label">USD</dt>`));
  assert.ok(html.includes(formatMoney(-40, 'USD')));
  assert.doesNotMatch(html, /<div class="metric-card__value">/, 'keine erfundene Gesamtzahl');
  assert.match(html, /class="metric-card__note">/);
});

// --------------------------------------------------------------------------
// Die gefilterte Uebersicht (#2302, Stufe c)
// --------------------------------------------------------------------------

const SUMMARY = { income: 1000, expenses: -400, balance: 600, transfers: 50, transfers_in: 20, byCategory: [] };

test('Filter: ohne Kontofilter bleibt die Budget-Waehrung, mit Filter gilt die des Kontos', () => {
  withState({ accountFilterId: null }, () => assert.equal(budgetUi.viewCurrency(), 'EUR'));
  withState({ accountFilterId: 2 }, () => assert.equal(budgetUi.viewCurrency(), 'JPY'));
  withState({ accountFilterId: 1 }, () => assert.equal(budgetUi.viewCurrency(), 'EUR', 'Konto ohne eigene Waehrung'));
});

test('Filter: Bilanz-Kurzzeile und Umbuchungskarte stehen zusammen in der Kontowaehrung', () => {
  const glance = withState({ accountFilterId: 3 }, () => budgetUi.balanceGlanceHtml(SUMMARY, { expensesOnly: false, forecast: false, balanceTone: '' }));
  for (const n of [600, 1000, 400]) {
    assert.ok(glance.includes(formatMoney(n, 'USD').replace('-', '')) || glance.includes(formatMoney(n, 'USD')), `${n} in USD`);
  }
  assert.ok(!glance.includes(currencySymbol('EUR')), 'kein Euro-Zeichen im Kontofilter');
  const transfers = withState({ accountFilterId: 3 }, () => budgetUi.transferSummaryHtml(SUMMARY));
  assert.ok(transfers.includes(currencySymbol('USD')), 'Eingang und Ausgang in USD');
  assert.ok(!transfers.includes(currencySymbol('EUR')));
});

test('Filter: das Kategoriediagramm folgt der Kontowaehrung', () => {
  const rows = [{ category: 'food', income: 0, expenses: -400, total: -400 }];
  const filtered = withState({ accountFilterId: 2 }, () => budgetUi.renderCategoryBars(rows));
  assert.ok(filtered.includes(currencySymbol('JPY')), 'Yen im Diagramm des Yen-Kontos');
  assert.ok(!filtered.includes(currencySymbol('EUR')));
  const plain = withState({ accountFilterId: null }, () => budgetUi.renderCategoryBars(rows));
  assert.ok(plain.includes(currencySymbol('EUR')), 'ungefiltert in der Budget-Waehrung');
});

test('Liste: eine Buchung steht in der Waehrung ihres Kontos', () => {
  const rows = withState({ accountFilterId: null, month: '2026-06', members: [] }, () => budgetUi.entryRows([
    { id: 1, title: 'Ramen', amount: -1200, category: 'food', subcategory: '', date: '2026-06-03', account_id: 2, responsible_users: [], attachments: [] },
    { id: 2, title: 'Brot', amount: -3, category: 'food', subcategory: '', date: '2026-06-03', account_id: 1, responsible_users: [], attachments: [] },
  ]));
  assert.ok(rows.includes(currencySymbol('JPY')), 'die Yen-Buchung in Yen');
  assert.ok(rows.includes(currencySymbol('EUR')), 'die Giro-Buchung in Euro');
});

test('Filter: jede Karte der Bilanz rechnet in der Waehrung der Uebersicht', async () => {
  // Die Bilanzkarten stehen im Rumpf von renderBody, der ein ganzes DOM
  // braucht; gemessen wird deshalb der Quelltext: jeder Betrag der Summary
  // (`s.`) und des Ausstehenden geht mit `viewCurrency()` durch.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/pages/budget.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function renderBody()'), src.indexOf('function categoryFilterLabel()'));
  const calls = [...body.matchAll(/amountByRole\((s\.\w+|pendingTotal)[^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 5, `Bilanzbetraege gefunden: ${calls.length}`);
  for (const call of calls) assert.match(call, /currency: viewCurrency\(\)/, call);
});

test('Filter: die Vergleichszeile unter einer Karte steht in derselben Waehrung', () => {
  const trend = withState({ accountFilterId: 3 }, () => budgetUi.renderTrend(1100, 1000, 'Mai'));
  assert.ok(trend.includes(currencySymbol('USD')), trend);
  assert.ok(!trend.includes(currencySymbol('EUR')));
});
