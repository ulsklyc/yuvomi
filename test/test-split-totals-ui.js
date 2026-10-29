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

// Die Ausgaben-Kategorien des Budgets (R24, E12): eigene Schluessel mit Namen,
// damit der Name ohne Uebersetzung im Markup steht (budgetCategoryLabel).
const BUDGET_KATEGORIEN = [
  { key: 'wohnen_x', name: 'Wohnen' }, { key: 'essen_x', name: 'Essen' }, { key: 'reise_x', name: 'Reise' },
];

const MITGLIEDER = [
  { currency: 'CHF', user_id: 3, display_name: 'Emma', paid_minor: 6000, paid: '60.00', share_minor: 4000, share: '40.00' },
  { currency: 'EUR', user_id: 1, display_name: 'Alex <b>', paid_minor: 3000, paid: '30.00', share_minor: 6000, share: '60.00' },
];
const JE_KATEGORIE = [
  { budget_category: 'reise_x', currency: 'EUR', total_minor: 13000, total: '130.00' },
  { budget_category: 'essen_x', currency: 'EUR', total_minor: 3100, total: '31.00' },
  { budget_category: null, currency: 'EUR', total_minor: 500, total: '5.00' },
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
    balances: { balances: [], simplified_debts: [], member_totals: MITGLIEDER, budget_category_totals: JE_KATEGORIE },
    meta: { currencies: ['EUR', 'CHF'], default_currency: 'EUR' },
    budgetCategories: BUDGET_KATEGORIEN,
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

test('R24 E12: je Budget-Kategorie und Waehrung eine Zeile mit Punkt und Namen, in der Reihenfolge des Servers, "ohne" als eigene Zeile', () => {
  const zurueck = gruppe();
  try {
    const html = split.renderCategoryTotals();
    assert.equal((html.match(/class="split-expense split-total"/g) || []).length, 3);
    assert.ok(html.indexOf('Reise') < html.indexOf('Essen'), 'die groesste zuerst');
    assert.match(html, /splitExpenses\.noCategory/, 'Ausgaben ohne Kategorie stehen benannt');
    assert.doesNotMatch(html, /data-lucide=|budget-tile/, 'keine Icon-Mulde mehr - der Punkt wie im Journal');
    assert.equal((html.match(/class="budget-entry__indicator budget-entry__indicator--expenses split-expense__dot"/g) || []).length, 3);
    assert.match(html, /style="--entry-color:var\(--chart-series-3\)"/, 'Reise: die Farbe ihrer Katalogstelle wie im Budget');
    assert.match(html, /130[.,]00/);
  } finally { zurueck(); }
});

test('Ohne Ausgaben: keine Summen, und die Gruppe zeichnet keinen leeren Abschnitt', () => {
  const zurueck = gruppe({ balances: { balances: [], simplified_debts: [], member_totals: [], budget_category_totals: [] } });
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
test('R24 E12: der Kategoriefilter ist ein Filterknopf mit Zaehler, kein natives Select', () => {
  const zurueck = gruppe();
  try {
    const html = split.renderCategoryFilter();
    assert.match(html, /<button[^>]*id="split-category-filter"/);
    assert.doesNotMatch(html, /<select/, 'kein Select mehr neben dem Titel');
    assert.doesNotMatch(html, /filter-btn__count[^>]*>[1-9]/, 'ohne Filter kein Zaehler');
    split.state.category = 'reise_x';
    assert.match(split.renderCategoryFilter(), />1</, 'ein gesetzter Filter zaehlt eins');
  } finally { zurueck(); }
});

test('R24 E12: mit nur einer Kategorie gibt es nichts zu filtern - ausser ein Filter steht schon', () => {
  const zurueck = gruppe({ balances: { balances: [], simplified_debts: [], member_totals: [], budget_category_totals: [JE_KATEGORIE[0]] } });
  try {
    assert.equal(split.renderCategoryFilter(), '');
    split.state.category = 'essen_x';
    assert.match(split.renderCategoryFilter(), /id="split-category-filter"/, 'der stehende Filter laesst sich zuruecknehmen');
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

const reise = { id: 7, title: 'Faehre', amount: '30.00', currency: 'EUR', budget_category: 'reise_x', payer_name: 'Alex', expense_date: '2026-07-01', created_at: '2026-07-01 10:00:00' };

test('R24 E12: eine Kategorie waehlen fragt den Server mit `budget_category` und zeichnet die Liste neu, "none" fuer ohne', async () => {
  const b = filterBuehne((q) => ({ data: q.get('budget_category') === 'reise_x' ? [reise] : [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('reise_x');
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/2/expenses?limit=30&budget_category=reise_x');
    assert.equal(split.state.category, 'reise_x');
    assert.match(b.box.html, /data-expense-view="7"/, 'die gefilterte Liste steht im Kasten');
    assert.match(b.box.html, /Reise/, 'die Zeile nennt ihre Kategorie in der Metazeile');
    await split.setCategoryFilter('none');
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/2/expenses?limit=30&budget_category=none');
    await split.setCategoryFilter('');
    assert.equal(b.ausgabenGets().at(-1), '/split-expenses/groups/2/expenses?limit=30', '"Alle" nimmt den Filter zurueck');
    await split.setCategoryFilter('casino');
    assert.equal(split.state.category, '', 'eine unbekannte Kategorie filtert nicht');
  } finally { b.abbauen(); }
});

test('#1941: eine leere Liste unter einem Filter nennt den Filter als Grund', async () => {
  const b = filterBuehne(() => ({ data: [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('wohnen_x');
    assert.match(b.box.html, /splitExpenses\.noExpensesInCategory/);
    await split.setCategoryFilter('');
    assert.match(b.box.html, /splitExpenses\.noExpenses</);
  } finally { b.abbauen(); }
});

test('#1941: eine andere Gruppe beginnt ohne Filter', async () => {
  const b = filterBuehne(() => ({ data: [], pagination: { has_more: false } }));
  try {
    await split.setCategoryFilter('reise_x');
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
  const m = html.match(/<select class="form-input" name="budget_category">([\s\S]*?)<\/select>/);
  assert.ok(m, 'der Dialog hat eine Kategorie-Wahl');
  return optionen(m[0]);
};

test('R24 E12: der Ausgabe-Dialog waehlt aus den Budget-Kategorien, neu "Ohne Kategorie", bestehend die gespeicherte', () => {
  const zurueck = gruppe();
  try {
    const neu = kategorieWahl(dialogInhalt(() => split.openExpenseModal(null)));
    assert.deepEqual(neu, ['*', 'wohnen_x', 'essen_x', 'reise_x']);
    const bestand = { id: 9, title: 'Faehre', amount: '30.00', currency: 'EUR', payer_id: 1, budget_category: 'reise_x', split_method: 'equal', splits: [], attachments: [] };
    assert.equal(kategorieWahl(dialogInhalt(() => split.openExpenseModal(bestand))).find((v) => v.startsWith('*')), '*reise_x');
    const geloescht = { ...bestand, budget_category: 'weg_x' };
    assert.equal(kategorieWahl(dialogInhalt(() => split.openExpenseModal(geloescht))).find((v) => v.startsWith('*')), '*weg_x', 'eine im Budget geloeschte Kategorie bleibt waehlbar statt still zu wechseln');
  } finally { zurueck(); }
});

test('R24 E12: der Serien-Dialog waehlt die Kategorie ebenso', () => {
  const zurueck = gruppe();
  try {
    assert.equal(kategorieWahl(dialogInhalt(() => split.openRecurringModal(null))).find((v) => v.startsWith('*')), '*');
    const serie = { id: 4, title: 'Miete', amount: '900.00', currency: 'EUR', payer_id: 1, budget_category: 'wohnen_x', split_method: 'equal', frequency: 'monthly', next_run_date: '2026-11-01', participants: [1, 3], can_edit: true };
    split.state.recurring = [serie];
    assert.equal(kategorieWahl(dialogInhalt(() => split.openRecurringModal(serie))).find((v) => v.startsWith('*')), '*wohnen_x');
  } finally { zurueck(); }
});

test('R24 E12: die Serie sendet ihre Budget-Kategorie, beim Bearbeiten nur, wenn sie sich aendert; leer heisst null', () => {
  const vorher = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.daten = form.daten; }
    [Symbol.iterator]() { return Object.entries(this.daten)[Symbol.iterator](); }
  };
  try {
    const form = (budget_category) => ({
      daten: { title: 'Miete', amount: '900', currency: 'EUR', payer_id: '1', frequency: 'monthly', next_run_date: '2026-11-01', split_method: 'equal', budget_category },
      querySelectorAll: () => [],
      querySelector: () => null,
    });
    assert.equal(split.readRecurringForm(form('reise_x')).budget_category, 'reise_x');
    assert.equal(split.readRecurringForm(form('')).budget_category, null);
    const gezeigt = split.readRecurringForm(form('wohnen_x'));
    const serie = { participants: [] };
    assert.deepEqual(split.changedRecurringFields(gezeigt, split.readRecurringForm(form('reise_x')), serie), { budget_category: 'reise_x' });
    assert.deepEqual(split.changedRecurringFields(gezeigt, split.readRecurringForm(form('wohnen_x')), serie), {}, 'unveraendert geht nichts hinaus');
  } finally { globalThis.FormData = vorher; }
});

test('R24 E12: die Leseansichten nennen die Budget-Kategorie', () => {
  const zurueck = gruppe();
  try {
    const ausgabe = split.expenseReadSections({ title: 'Faehre', amount: '30.00', currency: 'EUR', budget_category: 'reise_x', splits: [], attachments: [] });
    assert.ok(ausgabe.some((s) => s.label === 'splitExpenses.categoryLabel' && s.value === 'Reise' && s.icon === 'tag'));
    const serie = split.recurringReadSections({ title: 'Miete', amount: '900.00', currency: 'EUR', budget_category: 'wohnen_x', frequency: 'monthly', participants: [] });
    assert.ok(serie.some((s) => s.label === 'splitExpenses.categoryLabel' && s.value === 'Wohnen'));
  } finally { zurueck(); }
});

// --------------------------------------------------------------------------
// (4) Critique R24 G4: Geldgeruest, Leseblatt (E1), eine Saldo-Aussage
// --------------------------------------------------------------------------
test('R24 G4-Budget-P1-1: der Ausgabe-Dialog beginnt mit dem Betrag, die Waehrung als Wahl im Suffix; Personen als Chips', () => {
  const zurueck = gruppe();
  try {
    const html = dialogInhalt(() => split.openExpenseModal(null));
    const betrag = html.indexOf('id="split-amount"');
    assert.ok(betrag >= 0 && betrag < html.indexOf('name="title"'), 'der Betrag steht vor dem Titel');
    assert.match(html, /<div class="budget-amount-field budget-amount-field--choice">\s*<input class="form-input budget-amount-input" id="split-amount" name="amount"/);
    assert.match(html, /<select class="budget-amount-field__unit budget-amount-field__unit--choice" id="split-amount-currency" name="currency"/, 'die Waehrung ist die Wahl am Feld');
    assert.doesNotMatch(html, /<label class="form-field"><span class="form-label">splitExpenses\.currency/, 'kein eigenes Waehrungsfeld mehr');
    assert.doesNotMatch(html, /<fieldset class="split-participants"|<input type="checkbox" name="participants"/, 'keine nativen Kaestchen im fieldset');
    assert.equal((html.match(/<input type="checkbox" class="user-ms__checkbox" name="participants"/g) || []).length, 2, 'je Person ein Chip');
    assert.match(html, /class="user-ms__avatar"/, 'mit Scheibe');
  } finally { zurueck(); }
  const zurueck2 = gruppe();
  const aufrufe = [];
  globalThis.__advancedSection = (inner, options) => { aufrufe.push({ inner, options }); return inner; };
  try {
    dialogInhalt(() => split.openExpenseModal(null));
    assert.equal(aufrufe.length, 1);
    assert.match(aufrufe[0].inner, /name="description"/, 'die Notiz liegt hinter "Weitere Angaben"');
    assert.match(aufrufe[0].inner, /splitExpenses\.receiptsLabel/, 'die Belege ebenso');
    assert.equal(aufrufe[0].options.hint, 'splitExpenses.moreDetailsHint', 'die Inhaltsangabe nennt, was dahinter liegt');
    assert.equal(aufrufe[0].options.open, false, 'neu geschlossen');
  } finally { delete globalThis.__advancedSection; zurueck2(); }
});

test('R24 G4-Budget-P1-1: Bearbeiten holt keine Tastatur, der Primaerknopf ist nie gesperrt', () => {
  const zurueck = gruppe();
  let optionen = null;
  globalThis.__openModal = (opts) => { optionen = opts; };
  setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
  try {
    split.openExpenseModal({ id: 9, title: 'Faehre', amount: '30.00', currency: 'EUR', payer_id: 1, split_method: 'equal', splits: [], attachments: [] });
    assert.equal(optionen.initialFocus, 'edit');
    split.openExpenseModal(null);
    assert.equal(optionen.initialFocus, 'first-field');
    split.state.recurring = [];
    split.openRecurringModal({ id: 4, title: 'Miete', amount: '900.00', currency: 'EUR', payer_id: 1, split_method: 'equal', frequency: 'monthly', next_run_date: '2026-11-01', participants: [1, 3], can_edit: true });
    assert.equal(optionen.initialFocus, 'edit');
  } finally { clearPermissions(); delete globalThis.__openModal; zurueck(); }
  const src = split.validateSplitForm.toString();
  assert.doesNotMatch(src, /\.disabled\s*=/, 'validateSplitForm sperrt keinen Knopf mehr');
});

test('R24 G4-Budget-P1-1: Absenden ohne Beteiligte nennt den Grund an der ersten Person', () => {
  const gemeldet = [];
  globalThis.__reportFieldError = (input, text) => { gemeldet.push({ input, text }); };
  const knoten = (extra = {}) => ({ value: '', hidden: false, textContent: '', setAttribute() {}, getAttribute: () => null, focus() {}, ...extra });
  const erste = knoten({ value: '1' });
  const felder = {
    '[name="split_method"]': knoten({ value: 'equal' }), '[name="currency"]': knoten({ value: 'EUR' }),
    '[name="amount"]': knoten({ value: '30' }), '#split-method-hint': knoten(), '#split-amount-reason': knoten({ hidden: true }),
    'input[name="participants"]': erste,
  };
  const panel = { querySelector: (sel) => felder[sel] ?? null, querySelectorAll: () => [] };
  try {
    assert.equal(split.reportSplitProblem(panel), true);
    assert.equal(gemeldet[0]?.input, erste);
    assert.equal(gemeldet[0]?.text, 'splitExpenses.participantsRequired');
  } finally { delete globalThis.__reportFieldError; }
});

test('R24 E1: der Tipp auf eine Ausgabe oeffnet das Leseblatt, mit Schreibrecht EIN Primaerknopf Bearbeiten', () => {
  const zurueck = gruppe({ expenses: [reise] });
  let optionen = null;
  globalThis.__openDetailView = (opts) => { optionen = opts; };
  let editor = null;
  globalThis.__openModal = (opts) => { editor = opts; };
  const zeile = { dataset: { expenseId: '7' } };
  const klick = { target: { closest: (sel) => (sel === '[data-expenses-more]' ? null : zeile) } };
  try {
    setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
    split.onExpenseListClick(klick);
    assert.ok(optionen, 'das Leseblatt geht auf');
    assert.equal(editor, null, 'nicht das Formular');
    assert.equal(optionen.title, 'Faehre');
    assert.deepEqual(optionen.actions.map((a) => [a.id, a.variant]), [['split-read-edit', 'primary']]);
    optionen = null;
    split.state.groupStatus = 'archived';
    split.onExpenseListClick(klick);
    assert.deepEqual(optionen.actions, [], 'im Archiv ohne Fuss');
  } finally { clearPermissions(); delete globalThis.__openDetailView; delete globalThis.__openModal; zurueck(); }
});

test('R24 G4-Aufteilung-P2-6: eine eigene Schuld steht EINMAL - als Kennzahl mit Namen, die Salden-Liste laesst sie weg', () => {
  const schuld = { from_user_id: 1, from_name: 'Alex', to_user_id: 3, to_name: 'Emma', amount: '24.14', currency: 'EUR' };
  const zurueck = gruppe({ balances: { balances: [{ user_id: 1, net: '-24.14', net_minor: -2414, currency: 'EUR' }], simplified_debts: [schuld], member_totals: [], budget_category_totals: [] } });
  try {
    assert.equal(split.foldedDebt(), schuld);
    assert.equal(split.renderBalances(), '', 'keine zweite Zeile mit demselben Satz');
    const glance = { html: '', replaceChildren() { this.html = ''; }, insertAdjacentHTML(_p, m) { this.html += m; }, querySelector: () => null, querySelectorAll: () => [] };
    const summary = { html: '', classList: { contains: () => false }, replaceChildren() { this.html = ''; }, insertAdjacentHTML(_p, m) { this.html += m; } };
    split.renderSummaryForTest({ querySelector: (sel) => ({ '#split-glance': glance, '#split-summary': summary }[sel] ?? null) });
    assert.match(glance.html, /splitExpenses\.debtYouOwe\{[^}]*Emma[^}]*\}/, 'die Kurzzeile nennt das Gegenueber');
    assert.match(summary.html, /splitExpenses\.debtYouOwe\{[^}]*Emma[^}]*\}/, 'die Karte ebenso');
    // Zwei Schulden: die Liste fuehrt, die Kennzahl bleibt die Richtung.
    split.state.balances.simplified_debts = [schuld, { ...schuld, from_user_id: 4, from_name: 'Leo' }];
    assert.equal(split.foldedDebt(), null);
    assert.match(split.renderBalances(), /split-debt/);
    // Eine Schuld zwischen anderen ist keine eigene.
    split.state.balances.simplified_debts = [{ ...schuld, from_user_id: 4, from_name: 'Leo' }];
    assert.equal(split.foldedDebt(), null);
  } finally { zurueck(); }
});

// R24 S10-F6 (Ulas 29.10.): steht die einzige Schuld schon in der Kennzahl,
// entfaellt der Abschnitt "Salden" - kein Titel ueber nichts. "Ausgleichen"
// bleibt als Werkzeugzeile; ohne Handlung (Nur-lesen) faellt er ganz weg.
test('R24 S10-F6: die gefaltete Schuld laesst keinen leeren Salden-Abschnitt stehen, Ausgleichen bleibt', () => {
  const schuld = { from_user_id: 1, from_name: 'Alex', to_user_id: 3, to_name: 'Emma', amount: '24.14', currency: 'EUR' };
  const zurueck = gruppe({ balances: { balances: [], simplified_debts: [schuld], member_totals: MITGLIEDER, budget_category_totals: JE_KATEGORIE } });
  try {
    setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
    let html = hauptteil();
    assert.doesNotMatch(html, /u-section-title">splitExpenses\.balances</, 'kein Titel "Salden"');
    assert.doesNotMatch(html, /id="split-balances"/, 'kein leerer Koerper');
    assert.match(html, /split-section--folded" aria-label="splitExpenses\.balances"[\s\S]*id="split-settle"/, 'die Handlung bleibt, benannt');
    setPermissions({ admin: false, modules: { budget: 'read' }, widgets: {}, capabilities: {} });
    html = hauptteil();
    assert.doesNotMatch(html, /split-section--balances/, 'ohne Handlung kein Abschnitt');
    // Zwei Schulden: die Liste fuehrt wie bisher.
    setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
    split.state.balances.simplified_debts = [schuld, { ...schuld, from_user_id: 4, from_name: 'Leo' }];
    html = hauptteil();
    assert.match(html, /u-section-title">splitExpenses\.balances</);
    assert.match(html, /id="split-balances"/);
  } finally { clearPermissions(); zurueck(); }
});
