/**
 * Test: Summen und Kategorien der geteilten Ausgaben (#1888, #1941)
 * Zweck: Die Gruppe zeigt, was jede Person bezahlt hat und ihren eigenen
 *        Anteil (#1888), die Summe je Kategorie, einen Kategoriefilter ueber
 *        der Liste und eine Kategorie-Wahl in beiden Dialogen (#1941).
 *
 *        Die Summen rechnet der Server (test:split-expenses-routes); hier
 *        steht, was die Seite daraus macht: welche Zeilen, welche Worte,
 *        welcher Filter mit welcher Abfrage, und dass die Dialoge die
 *        Kategorie vorbelegen und senden. Gefahren wird mit dem Loader-Stub
 *        fuer api/i18n (`globalThis.__apiStub`, `t()` liefert den Schluessel).
 * Ausfuehren: npm run test:split-totals-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: split } = await import('../public/pages/split-expenses.js');

test.after(() => miniDomAbraeumen());

const KATEGORIEN = ['groceries', 'rent', 'utilities', 'baby', 'pets', 'school', 'travel', 'shopping', 'subscriptions', 'health', 'home', 'general'];

const MITGLIEDER = [
  { currency: 'CHF', user_id: 3, display_name: 'Emma', paid_minor: 6000, paid: '60.00', share_minor: 4000, share: '40.00' },
  { currency: 'EUR', user_id: 1, display_name: 'Alex <b>', paid_minor: 3000, paid: '30.00', share_minor: 6000, share: '60.00' },
];
const JE_KATEGORIE = [
  { category: 'travel', currency: 'EUR', total_minor: 13000, total: '130.00' },
  { category: 'groceries', currency: 'EUR', total_minor: 3100, total: '31.00' },
];

/** Setzt den Zustand einer Gruppe; `zurueck()` stellt den vorigen wieder her. */
function gruppe(extra = {}) {
  const vorher = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groupStatus: 'active', user: { id: 1 }, category: '',
    groups: [{ id: 2, name: 'Reise', type: 'trip', description: '', default_currency: 'EUR' }, { id: 5, name: 'WG', type: 'household', description: '', default_currency: 'EUR' }],
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
    expenses: [], expensesCursor: null, expensesKey: null, expensesLoadingMore: false,
    recurring: [], activity: [], activityCursor: null, activityGroupId: null,
    balances: { balances: [], simplified_debts: [], member_totals: MITGLIEDER, category_totals: JE_KATEGORIE },
    meta: { currencies: ['EUR', 'CHF'], default_currency: 'EUR', categories: KATEGORIEN },
    ...extra,
  });
  return () => Object.assign(split.state, vorher);
}

const optionen = (html) => [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map(([, v, rest]) => (/selected/.test(rest) ? `*${v}` : v));

// --------------------------------------------------------------------------
// (1) Summen je Person und je Kategorie
// --------------------------------------------------------------------------
test('#1888: je Person und Waehrung eine Zeile - Bezahltes rechts, der eigene Anteil benannt darunter, Namen maskiert', () => {
  const zurueck = gruppe();
  try {
    const html = split.renderMemberTotals();
    assert.equal((html.match(/class="split-expense split-total"/g) || []).length, 2, 'eine Zeile je Person und Waehrung');
    assert.match(html, /Alex &lt;b&gt;/, 'der Name geht durch esc()');
    assert.doesNotMatch(html, /Alex <b>/);
    assert.match(html, /splitExpenses\.ownShare/, 'der Anteil nennt sich selbst');
    assert.match(html, /<span class="sr-only">splitExpenses\.paidLabel <\/span>[^<]*30[.,]00/, 'der Betrag rechts ist das Bezahlte und sagt es dem Vorleser');
    assert.ok(html.indexOf('Emma') < html.indexOf('Alex'), 'Reihenfolge des Servers');
  } finally { zurueck(); }
});

test('#1941: je Kategorie und Waehrung eine Zeile mit Zeichen und Namen der Kategorie, in der Reihenfolge des Servers', () => {
  const zurueck = gruppe();
  try {
    const html = split.renderCategoryTotals();
    assert.equal((html.match(/class="split-expense split-total"/g) || []).length, 2);
    assert.ok(html.indexOf('splitExpenses.category.travel') < html.indexOf('splitExpenses.category.groceries'), 'die groesste zuerst');
    assert.match(html, /data-lucide="plane"/, 'das Zeichen der Kategorie wie in der Liste');
    assert.match(html, /130[.,]00/);
  } finally { zurueck(); }
});

test('Ohne Ausgaben: keine Summen, und die Gruppe zeichnet keinen leeren Abschnitt', () => {
  const zurueck = gruppe({ balances: { balances: [], simplified_debts: [], member_totals: [], category_totals: [] } });
  try {
    assert.equal(split.renderMemberTotals(), '');
    assert.equal(split.renderCategoryTotals(), '');
    assert.doesNotMatch(hauptteil(), /split-section--totals/);
  } finally { zurueck(); }
});

/** Das Markup des Hauptteils, wie drawMain es schreibt. */
function hauptteil() {
  let html = '';
  const main = {
    removeAttribute() {}, replaceChildren() { html = ''; }, insertAdjacentHTML(_p, m) { html += m; },
    querySelector: () => null, querySelectorAll: () => [],
  };
  split.renderMainForTest({ querySelector: (sel) => (sel === '#split-main' ? main : null) });
  return html;
}

test('Die Summen folgen im DOM der Liste (rechte Spalte unter den Salden, gestapelt nach der Liste) - bei jedem Recht und im Archiv', () => {
  for (const modus of ['write', 'read']) {
    for (const archiviert of [false, true]) {
      const zurueck = gruppe({ groupStatus: archiviert ? 'archived' : 'active' });
      setPermissions({ admin: false, modules: { budget: modus }, widgets: {}, capabilities: {} });
      try {
        const html = hauptteil();
        const salden = html.indexOf('split-section--balances');
        const person = html.indexOf('splitExpenses.totalsByMember');
        const kategorie = html.indexOf('splitExpenses.totalsByCategory');
        const liste = html.indexOf('split-section--expenses');
        const wiederkehrend = html.indexOf('budget.recurringLabel');
        assert.ok(salden >= 0 && liste > salden && person > liste && kategorie > person && wiederkehrend > kategorie, `${modus} archiv=${archiviert}`);
        assert.match(html, /id="split-category-filter"/, 'der Filter ist Lesen, keine Handlung');
      } finally { clearPermissions(); zurueck(); }
    }
  }
});

// --------------------------------------------------------------------------
// (2) Filter
// --------------------------------------------------------------------------
test('#1941: der Filter bietet "Alle" und die Kategorien, die in der Gruppe vorkommen, in der Reihenfolge der Route', () => {
  const zurueck = gruppe();
  try {
    const html = split.renderCategoryFilter();
    assert.match(html, /aria-label="splitExpenses\.categoryFilter"/);
    assert.deepEqual(optionen(html), ['*', 'groceries', 'travel']);
    assert.match(html, /<option value=""[^>]*>splitExpenses\.allCategories</);
    split.state.category = 'travel';
    assert.deepEqual(optionen(split.renderCategoryFilter()), ['', 'groceries', '*travel'], 'der gesetzte Filter ist der Zustand der Liste');
  } finally { zurueck(); }
});

test('#1941: mit nur einer Kategorie gibt es nichts zu filtern - ausser ein Filter steht schon', () => {
  const zurueck = gruppe({ balances: { balances: [], simplified_debts: [], member_totals: [], category_totals: [JE_KATEGORIE[0]] } });
  try {
    assert.equal(split.renderCategoryFilter(), '');
    split.state.category = 'groceries';
    assert.deepEqual(optionen(split.renderCategoryFilter()), ['', 'travel', '*groceries'], 'der stehende Filter laesst sich zuruecknehmen');
  } finally { zurueck(); }
});

/** Eine Gruppe, deren Liste in `box` gezeichnet wird; `gets` sammelt die Abfragen. */
function filterBuehne(antwort) {
  const zurueck = gruppe();
  const gets = [];
  const box = { html: '', replaceChildren() { this.html = ''; }, insertAdjacentHTML(_p, m) { this.html += m; }, querySelector: () => null };
  split.setContainerForTest({ querySelector: (sel) => (sel === '#split-expense-list' ? box : null) });
  globalThis.__apiStub = {
    get: async (path) => {
      gets.push(path);
      if (path.includes('/expenses?')) return antwort(new URL(path, 'http://x').searchParams);
      if (path.endsWith('/balances')) return { data: split.state.balances };
      return { data: [] };
    },
  };
  setPermissions({ admin: false, modules: { budget: 'read' }, widgets: {}, capabilities: {} });
  return {
    box, gets,
    ausgabenGets: () => gets.filter((p) => p.includes('/expenses?')),
    abbauen() { clearPermissions(); delete globalThis.__apiStub; zurueck(); },
  };
}

const reise = { id: 7, title: 'Faehre', amount: '30.00', currency: 'EUR', category: 'travel', payer_name: 'Alex', expense_date: '2026-07-01', created_at: '2026-07-01 10:00:00' };

test('#1941: eine Kategorie waehlen fragt den Server mit `category` und zeichnet die Liste neu', async () => {
  const b = filterBuehne((q) => ({ data: q.get('category') === 'travel' ? [reise] : [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('travel');
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/2/expenses?limit=30&category=travel');
    assert.equal(split.state.category, 'travel');
    assert.match(b.box.html, /data-expense-view="7"/, 'die gefilterte Liste steht im Kasten');
    await split.setCategoryFilter('');
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/2/expenses?limit=30', '"Alle" nimmt den Filter zurueck');
    await split.setCategoryFilter('casino');
    assert.equal(split.state.category, '', 'eine unbekannte Kategorie filtert nicht');
  } finally { b.abbauen(); }
});

test('#1941: eine leere Liste unter einem Filter nennt den Filter als Grund', async () => {
  const b = filterBuehne(() => ({ data: [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('health');
    assert.match(b.box.html, /splitExpenses\.noExpensesInCategory/);
    await split.setCategoryFilter('');
    assert.match(b.box.html, /splitExpenses\.noExpenses</);
  } finally { b.abbauen(); }
});

test('#1941: eine andere Gruppe beginnt ohne Filter', async () => {
  const b = filterBuehne(() => ({ data: [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('travel');
    split.state.activeGroupId = 5;
    await split.loadGroupData();
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/5/expenses?limit=30');
    assert.equal(split.state.category, '');
  } finally { b.abbauen(); }
});

// --------------------------------------------------------------------------
// (3) Dialoge und Leseansichten
// --------------------------------------------------------------------------
function dialogInhalt(oeffnen) {
  let inhalt = null;
  globalThis.__openModal = (opts) => { inhalt = opts.content; };
  setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  try { oeffnen(); } finally { clearPermissions(); delete globalThis.__openModal; }
  assert.ok(inhalt, 'der Dialog geht auf');
  return inhalt;
}

const kategorieWahl = (html) => {
  const m = html.match(/<select class="form-input" name="category">([\s\S]*?)<\/select>/);
  assert.ok(m, 'der Dialog hat eine Kategorie-Wahl');
  return optionen(m[0]);
};

test('#1941: der Ausgabe-Dialog waehlt aus den zwoelf, neu "Allgemein", bestehend die gespeicherte', () => {
  const zurueck = gruppe();
  try {
    const neu = kategorieWahl(dialogInhalt(() => split.openExpenseModal(null)));
    assert.equal(neu.length, 12);
    assert.equal(neu.find((v) => v.startsWith('*')), '*general');
    const bestand = { id: 9, title: 'Faehre', amount: '30.00', currency: 'EUR', payer_id: 1, category: 'travel', split_method: 'equal', splits: [], attachments: [] };
    assert.equal(kategorieWahl(dialogInhalt(() => split.openExpenseModal(bestand))).find((v) => v.startsWith('*')), '*travel');
  } finally { zurueck(); }
});

test('#1941: der Serien-Dialog waehlt die Kategorie ebenso', () => {
  const zurueck = gruppe();
  try {
    assert.equal(kategorieWahl(dialogInhalt(() => split.openRecurringModal(null))).find((v) => v.startsWith('*')), '*general');
    const serie = { id: 4, title: 'Miete', amount: '900.00', currency: 'EUR', payer_id: 1, category: 'rent', split_method: 'equal', frequency: 'monthly', next_run_date: '2026-11-01', participants: [1, 3], can_edit: true };
    split.state.recurring = [serie];
    assert.equal(kategorieWahl(dialogInhalt(() => split.openRecurringModal(serie))).find((v) => v.startsWith('*')), '*rent');
  } finally { zurueck(); }
});

test('#1941: die Serie sendet ihre Kategorie, beim Bearbeiten nur, wenn sie sich aendert', () => {
  const vorher = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.daten = form.daten; }
    [Symbol.iterator]() { return Object.entries(this.daten)[Symbol.iterator](); }
  };
  try {
    const form = (category) => ({
      daten: { title: 'Miete', amount: '900', currency: 'EUR', payer_id: '1', frequency: 'monthly', next_run_date: '2026-11-01', split_method: 'equal', category },
      querySelectorAll: () => [],
      querySelector: () => null,
    });
    assert.equal(split.readRecurringForm(form('travel')).category, 'travel');
    const gezeigt = split.readRecurringForm(form('rent'));
    const serie = { participants: [] };
    assert.deepEqual(split.changedRecurringFields(gezeigt, split.readRecurringForm(form('travel')), serie), { category: 'travel' });
    assert.deepEqual(split.changedRecurringFields(gezeigt, split.readRecurringForm(form('rent')), serie), {}, 'unveraendert geht nichts hinaus');
  } finally { globalThis.FormData = vorher; }
});

test('#1941: die Leseansichten nennen die Kategorie (dort, wo `budget: read` nichts aendern kann)', () => {
  const zurueck = gruppe();
  try {
    const ausgabe = split.expenseReadSections({ title: 'Faehre', amount: '30.00', currency: 'EUR', category: 'travel', splits: [], attachments: [] });
    assert.ok(ausgabe.some((s) => s.label === 'splitExpenses.categoryLabel' && s.value === 'splitExpenses.category.travel' && s.icon === 'plane'));
    const serie = split.recurringReadSections({ title: 'Miete', amount: '900.00', currency: 'EUR', category: 'rent', frequency: 'monthly', participants: [] });
    assert.ok(serie.some((s) => s.label === 'splitExpenses.categoryLabel' && s.value === 'splitExpenses.category.rent'));
  } finally { zurueck(); }
});
