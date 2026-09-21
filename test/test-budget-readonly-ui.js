/**
 * Modul: Nur-lesen-Rechte im Budget (#1265 P7)
 * Zweck: Das Budget zeichnete jeden Schreibweg auch bei `budget: read` -
 *        Buchung loeschen oder verbuchen, den Bearbeiten-Dialog hinter jeder
 *        Zeile, Kategorien verwalten, Konto anlegen und bearbeiten, Darlehen
 *        bearbeiten, loeschen und eine Rate buchen, Raten bearbeiten und
 *        loeschen, Budgets und das Sparziel setzen. Der Server wies jeden
 *        Aufruf mit 403 ab (#1303); dies ist die ehrliche Oberflaeche dazu.
 *
 *        Vier Dateien, EIN Recht: `budget.js` (Buchungen, Konten, Darlehen),
 *        `budget-plans.js` (Plan), `subscriptions.js` (Abos) und
 *        `split-expenses.js` (Geteilte Ausgaben). Die letzten beiden sind
 *        eingebettete Seiten mit eigenem Markup, eigener Wischgeste und
 *        eigenem FAB; sie tragen ihre Regel deshalb selbst, und der Riegel in
 *        `budget.js` greift ausdruecklich NICHT in sie hinein - gemessen.
 *        Geteilte Ausgaben sind dabei KEIN eigenes Modul: `server/scopes.js`
 *        fuehrt `split-expenses` unter `budget`, also fragt jede der vier
 *        Dateien `budget`.
 *
 *        Die Bauart ist die aus P1/P2 (test:module-readonly-ui), nur in einer
 *        eigenen Datei, damit parallel laufende Pakete sich nicht dieselbe
 *        Datei teilen: gemessen am ERZEUGTEN Markup und immer im Paar - bei
 *        `read` weg UND bei `write` da -, dazu ein Inhalt, den nur ein
 *        wirklich gelaufener Renderer ausgibt. Wo die Seite direkt verdrahtet,
 *        prueft die Suite den KOMMENTARFREIEN Quelltext.
 *
 * Ausfuehren: npm run test:budget-readonly-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eachRule } from './css-rules.js';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

// Die Leerzustaende gehen durch emptyStateHTML(), und das BAUT Knoten.
const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { pathAccess } = await import('../public/utils/module-access.js');
const { __test: budget } = await import('../public/pages/budget.js');
const { __test: plans } = await import('../public/pages/budget-plans.js');
const { __test: abos } = await import('../public/pages/subscriptions.js');
const { __test: split } = await import('../public/pages/split-expenses.js');

/** Rechte setzen, messen, aufraeumen (synchron, wie withAccess in P1/P2). */
function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return fn(); } finally { clearPermissions(); }
}

const ohneKommentare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const BUDGET_CODE = ohneKommentare(readFileSync(new URL('../public/pages/budget.js', import.meta.url), 'utf8'));
const PLANS_CODE = ohneKommentare(readFileSync(new URL('../public/pages/budget-plans.js', import.meta.url), 'utf8'));
const ABOS_CODE = ohneKommentare(readFileSync(new URL('../public/pages/subscriptions.js', import.meta.url), 'utf8'));
const SPLIT_CODE = ohneKommentare(readFileSync(new URL('../public/pages/split-expenses.js', import.meta.url), 'utf8'));
const BUDGET_CSS = readFileSync(new URL('../public/styles/budget.css', import.meta.url), 'utf8');

/** Eine Funktion aus dem kommentarfreien Quelltext (bis zur ersten `}` am Zeilenanfang). */
function fn(code, name) {
  const start = code.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name}() nicht gefunden`);
  const rest = code.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

// -------------------------------------------------------------------------
// Die Frage selbst - und der Name, der sie traegt
// -------------------------------------------------------------------------

test('readOnly() folgt dem Rechte-Store - in allen vier Dateien, und `budget` ist ein Modul, das es gibt', () => {
  // Die Falle aus P1: `birthdays.js` fragte nach einem Namen, den die Rechte
  // nicht fuehren, und `moduleAccess()` faellt dort still auf `write` - die
  // Frage waere nie „ja, nur lesen" geworden. Das Paar haelt das fest.
  for (const seite of [budget, plans, abos, split]) {
    withAccess({ budget: 'read' }, () => assert.equal(seite.readOnly(), true));
    withAccess({ budget: 'write' }, () => assert.equal(seite.readOnly(), false));
    withAccess({ budget: 'none' }, () => assert.equal(seite.readOnly(), false));
    assert.equal(seite.readOnly(), false, 'ohne geladene Rechte fail-open wie permissions.js');
  }
});

test('Geteilte Ausgaben sind KEIN eigenes Modul - `budget` besitzt `/split-expenses`', () => {
  // Wer die Split-Seite nach einem eigenen Recht fragt, fragt ins Leere. Der
  // Server urteilt nach server/scopes.js, und dort steht `split-expenses` als
  // zweiter Praefix von `budget`. Das nachziehende Paket fragt also DASSELBE
  // Recht - kein Kreuzmodul-Fall wie Haushaltshilfe -> Dokumente.
  withAccess({ budget: 'read' }, () => {
    assert.equal(pathAccess('/split-expenses/groups/1/expenses'), 'read');
    assert.equal(pathAccess('/budget/subscriptions/1'), 'read');
  });
  withAccess({ budget: 'write' }, () => assert.equal(pathAccess('/split-expenses/groups'), 'write'));
});

test('Budget hat keine Display-Ausnahme - der Server gibt keine her', () => {
  const display = readFileSync(new URL('../server/display-scopes.js', import.meta.url), 'utf8');
  const scopes = display.slice(display.indexOf('DISPLAY_SCOPES = Object.freeze(['));
  assert.doesNotMatch(scopes.slice(0, scopes.indexOf(']);')), /'budget:/,
    'ein Wandtablett liest das Budget gar nicht');
  const routen = display.slice(display.indexOf('DISPLAY_WRITE_ROUTES = Object.freeze(['));
  const liste = routen.slice(0, routen.indexOf(']);'));
  assert.ok(!/budget|split-expenses/.test(liste),
    'gaebe es hier eine Route, braeuchte die Stelle ein actingAsDisplay() VOR der Modulregel');
});

// -------------------------------------------------------------------------
// Buchungen
// -------------------------------------------------------------------------

const buchung = (over = {}) => ({
  id: 17, title: 'Stromabschlag', amount: -84.5, date: '2026-06-03', category: 'housing',
  account_id: null, is_recurring: 1, attachments: [{ id: 5 }], is_pending: 1,
  responsible_users: [{ id: 3, display_name: 'Emma' }], ...over,
});

/** Laesst den echten Render-Pfad des Buchungs-Tabs laufen und gibt sein Markup zurueck. */
function buchungsTab(entries) {
  const vorher = { ...budget.state };
  Object.assign(budget.state, {
    activeTab: 'budget', loadError: null, prevSummary: null, entries,
    summary: { income: 0, expenses: -84.5, balance: -84.5, byCategory: [], pending: { count: 0 } },
    responsibleFilterId: null, groupByResponsible: false, accountFilterId: null,
  });
  let html = '';
  const body = {
    replaceChildren() { html = ''; },
    insertAdjacentHTML(_pos, markup) { html += markup; },
    setAttribute() {}, querySelector: () => null,
  };
  const container = {
    querySelector: (sel) => (sel === '#budget-body' ? body : null),
    querySelectorAll: () => [],
    classList: { toggle() {} },
  };
  try {
    budget.renderBodyForTest(container);
  } finally {
    Object.assign(budget.state, vorher);
  }
  return html;
}

test('Buchungszeile mit Schreibrecht: Bearbeiten, Verbuchen und Loeschen stehen da', () => {
  withAccess({ budget: 'write' }, () => {
    const html = buchungsTab([buchung()]);
    assert.match(html, /data-id="17"/);
    assert.match(html, /<button class="list-row__name budget-entry__title"/);
    assert.match(html, /data-action="confirm"/);
    assert.match(html, /data-action="delete"/);
    assert.match(html, /id="budget-manage-categories"/);
    assert.doesNotMatch(html, /budget-entry--static/);
  });
});

test('Buchungszeile mit `budget: read`: jede Handlung geht, jede Auskunft bleibt', () => {
  withAccess({ budget: 'read' }, () => {
    const html = buchungsTab([buchung()]);
    // Weg: die Bearbeiten-Flaeche (Titel-Knopf und Zeilen-Klick ueber data-id),
    // Verbuchen, Loeschen, der Kategorie-Verwalter im Listenkopf.
    assert.doesNotMatch(html, /data-id="17"/);
    assert.doesNotMatch(html, /<button class="list-row__name/);
    assert.doesNotMatch(html, /data-action=/);
    assert.doesNotMatch(html, /budget-manage-categories/);
    // Da: Titel, Betrag, die Zustaende „erwartet", „wiederkehrend", „Beleg"
    // als Zeichen, der Zustaendigen-Filter (liest nur) und der CSV-Export.
    assert.match(html, /<div class="list-row__name budget-entry__title">Stromabschlag/);
    assert.match(html, /84[.,]50/);
    assert.match(html, /budget-badge--pending/);
    assert.match(html, /budget\.recurringLabel/);
    assert.match(html, /budget\.receiptsAttachedLabel/);
    assert.match(html, /data-responsible="3"/);
    assert.match(html, /budget-csv-export/);
    assert.match(html, /class="list-row budget-entry budget-entry--pending budget-entry--static"/);
  });
});

test('Leere Buchungsliste mit `budget: read`: nur der Titel, kein CTA und keine Anleitung zum Anlegen', () => {
  withAccess({ budget: 'write' }, () => {
    const html = budget.renderEntries();
    assert.match(html, /id="empty-cta-budget"/);
    assert.match(html, /budget\.emptyDescription/);
  });
  withAccess({ budget: 'read' }, () => {
    const html = budget.renderEntries();
    assert.match(html, /budget\.emptyTitle/);
    assert.doesNotMatch(html, /empty-cta-budget/);
    // „Ueber den + Button hinzufuegen" beschreibt einen Weg, den es nicht gibt.
    assert.doesNotMatch(html, /budget\.emptyDescription/);
    assert.doesNotMatch(html, /emptyHint\.budget/);
  });
});

// -------------------------------------------------------------------------
// Konten
// -------------------------------------------------------------------------

const konto = (over = {}) => ({
  id: 4, name: 'Girokonto', type: 'checking', current_balance: 1200, starting_balance: 900,
  archived: 0, color: '', ...over,
});

function mitKonten(accounts, fn) {
  const vorher = budget.state.accounts;
  budget.state.accounts = accounts;
  try { return fn(); } finally { budget.state.accounts = vorher; }
}

test('Konten mit `budget: read`: Anlegen und Bearbeiten weg, Saldo und Kontoauszug bleiben', () => {
  mitKonten([konto(), konto({ id: 5, name: 'Altkonto', archived: 1 })], () => {
    withAccess({ budget: 'write' }, () => {
      const html = budget.renderAccountsPage();
      assert.match(html, /id="budget-add-account"/);
      assert.match(html, /data-edit="4"/);
    });
    withAccess({ budget: 'read' }, () => {
      const html = budget.renderAccountsPage();
      assert.doesNotMatch(html, /budget-add-account/);
      assert.doesNotMatch(html, /data-edit=/);
      assert.doesNotMatch(html, /budget-account__edit/);
      assert.match(html, /data-drill="4"/, 'der Kontoauszug liest nur und bleibt');
      assert.match(html, /id="budget-toggle-archived"/, 'der Archiv-Umschalter ist ein Filter');
      assert.match(html, /Girokonto/);
      assert.match(html, /budget\.netWorth/);
    });
  });
});

test('Keine Konten mit `budget: read`: kein Anlegen-CTA', () => {
  mitKonten([], () => {
    withAccess({ budget: 'write' }, () => assert.match(budget.renderAccountsPage(), /id="budget-add-account-empty"/));
    withAccess({ budget: 'read' }, () => {
      const html = budget.renderAccountsPage();
      assert.match(html, /budget\.accountsEmptyTitle/);
      assert.doesNotMatch(html, /budget-add-account/);
      assert.doesNotMatch(html, /budget\.accountsEmptyDescription/);
    });
  });
});

// -------------------------------------------------------------------------
// Darlehen
// -------------------------------------------------------------------------

const darlehen = (over = {}) => ({
  id: 9, title: 'Autokredit', borrower: 'Bank', direction: 'borrowed', status: 'active',
  total_amount: 6000, remaining_amount: 4000, paid_amount: 2000, paid_installments: 4,
  installment_count: 12, next_due_month: '2026-07', is_settled: 0, payments: [], ...over,
});
const rate = { id: 31, installment_number: 4, amount: 500, paid_date: '2026-06-01', budget_entry_id: 77 };

test('Darlehenskarte mit `budget: read`: Bearbeiten, Loeschen und Rate buchen weg, Stand bleibt', () => {
  withAccess({ budget: 'write' }, () => {
    const html = budget.renderLoanCard(darlehen());
    for (const a of ['loan-edit', 'loan-delete', 'loan-pay']) assert.match(html, new RegExp(`data-action="${a}"`));
  });
  withAccess({ budget: 'read' }, () => {
    const html = budget.renderLoanCard(darlehen());
    assert.doesNotMatch(html, /loan-edit|loan-delete|loan-pay/);
    assert.doesNotMatch(html, /budget-loan-card__actions/);
    assert.match(html, /data-action="loan-filter"/, 'der Raten-Filter liest nur');
    assert.match(html, /role="progressbar"/);
    assert.match(html, /Autokredit/);
    assert.match(html, /budget\.loanNextDue/);
  });
});

test('Darlehensrate mit `budget: read`: die Zeile bleibt, Bearbeiten und Loeschen gehen', () => {
  withAccess({ budget: 'write' }, () => {
    const html = budget.renderLoanPaymentEntry(darlehen(), rate);
    assert.match(html, /data-action="loan-payment-edit"/);
    assert.match(html, /data-action="loan-payment-delete"/);
  });
  withAccess({ budget: 'read' }, () => {
    const html = budget.renderLoanPaymentEntry(darlehen(), rate);
    assert.doesNotMatch(html, /data-action=/);
    assert.doesNotMatch(html, /list-row__actions/);
    assert.match(html, /500/);
    assert.match(html, /budget\.loanInstallmentNumber/);
  });
});

test('Keine Darlehen mit `budget: read`: kein Anlegen-CTA und keine Anleitung dazu', () => {
  const vorher = budget.state.loans;
  budget.state.loans = { loans: [], summary: {} };
  try {
    withAccess({ budget: 'write' }, () => assert.match(budget.renderLoansPage(), /id="budget-empty-loan"/));
    withAccess({ budget: 'read' }, () => {
      const html = budget.renderLoansPage();
      assert.match(html, /budget\.loansEmpty/);
      assert.doesNotMatch(html, /budget-empty-loan/);
      assert.doesNotMatch(html, /budget\.loansEmptyDescription/);
    });
  } finally { budget.state.loans = vorher; }
});

// -------------------------------------------------------------------------
// Plan
// -------------------------------------------------------------------------

function mitPlanKontext(fn) {
  const vorher = plans.view.ctx;
  plans.view.ctx = {
    currency: 'EUR', esc: (s) => String(s), categoryLabel: (c) => `Kat:${c}`,
    formatAmount: (v) => `${v} EUR`, expenseCategories: [],
  };
  try { return fn(); } finally { plans.view.ctx = vorher; }
}
const plan = { category: 'food', planned: 400, actual: 310, ratio: 0.775, over: false, remaining: 90 };
const sparziel = { planned: 200, actual: 150, ratio: 0.75, met: false, remaining: 50 };

test('Planzeile mit `budget: read`: aus dem Knopf wird ein Kasten, Soll und Ist bleiben', () => {
  mitPlanKontext(() => {
    withAccess({ budget: 'write' }, () => {
      const html = plans.renderRows([plan]);
      assert.match(html, /<button type="button" class="budget-plan-row /);
      assert.match(html, /budget\.planEditAction/);
    });
    withAccess({ budget: 'read' }, () => {
      const html = plans.renderRows([plan]);
      assert.doesNotMatch(html, /<button/);
      assert.doesNotMatch(html, /budget\.planEditAction/);
      assert.match(html, /<div class="budget-plan-row budget-plan-row--tone-under budget-plan-row--static"/);
      assert.match(html, /Kat:food/);
      assert.match(html, /310 EUR/);
      assert.match(html, /budget\.planLeft/);
    });
  });
});

test('Sparziel: gesetzt bleibt es als Karte, nicht gesetzt faellt die Aufforderung weg', () => {
  mitPlanKontext(() => {
    withAccess({ budget: 'write' }, () => {
      assert.match(plans.renderSavingsCard(sparziel), /<button type="button" class="budget-plan-savings[^"]*" id="budget-plan-savings"/);
      assert.match(plans.renderSavingsCard(null), /budget\.planSavingsSetTitle/);
    });
    withAccess({ budget: 'read' }, () => {
      const html = plans.renderSavingsCard(sparziel);
      assert.doesNotMatch(html, /<button|id="budget-plan-savings"|budget-plan-savings__edit|budget\.planEditAction/);
      assert.match(html, /<div class="budget-plan-savings budget-plan-savings--tone-near budget-plan-savings--static"/);
      assert.match(html, /150 EUR/);
      assert.match(html, /75%/);
      // Ein leerer Schalter ist kein Zustand (#1253): ohne gesetztes Ziel gibt
      // es nichts zu zeigen, nur etwas zu tun - und das faellt weg.
      assert.equal(plans.renderSavingsCard(null), '');
    });
  });
});

test('Leerer Plan mit `budget: read`: der Titel bleibt, die Anleitung geht', () => {
  mitPlanKontext(() => {
    withAccess({ budget: 'write' }, () => assert.match(plans.renderRows([]), /budget\.planEmptyDesc/));
    withAccess({ budget: 'read' }, () => {
      const html = plans.renderRows([]);
      assert.match(html, /budget\.planEmptyTitle/);
      assert.doesNotMatch(html, /budget\.planEmptyDesc/);
    });
  });
});

// -------------------------------------------------------------------------
// Abos
// -------------------------------------------------------------------------

const abo = (over = {}) => ({
  id: 12, name: 'Streamingdienst', description: '', status: 'active', enabled: 1,
  amount: 12.99, currency: 'EUR', monthly_base: 12.99, next_payment_date: '2026-10-01',
  billing_cycle: 'monthly', cycle_interval: 1, reminder_days: 3, end_type: 'never', ...over,
});

test('Abo-Karte mit `budget: read`: der Koerper wird zum Kasten, Verlaengern, Loeschen und Wischflaechen gehen', () => {
  withAccess({ budget: 'write' }, () => {
    const html = abos.renderCard(abo());
    assert.match(html, /<button type="button" class="subscription-card__main list-row__main--interactive"\s+data-action="edit">/);
    assert.match(html, /data-action="renew"/);
    assert.match(html, /data-action="delete"/);
    assert.match(html, /swipe-reveal--done/);
  });
  withAccess({ budget: 'read' }, () => {
    const html = abos.renderCard(abo());
    assert.doesNotMatch(html, /<button|data-action=|swipe-reveal|list-row__main--interactive/);
    assert.match(html, /<div class="subscription-card__main">/);
    // Die Auskunft: Name, Status, Zyklus, Erinnerung, Betrag.
    assert.match(html, /Streamingdienst/);
    assert.match(html, /subscriptions\.active/);
    assert.match(html, /subscriptions\.cycle\.monthly/);
    assert.match(html, /subscriptions\.reminderMeta/);
    assert.match(html, /12[.,]99/);
  });
});

test('Abos ohne Eintrag mit `budget: read`: kein Anlegen-CTA; der Filter-Ausweg bleibt', () => {
  const vorher = { ...abos.state };
  try {
    Object.assign(abos.state, { query: '', categoryId: '', paymentMethodId: '', status: 'all', sort: 'due' });
    withAccess({ budget: 'write' }, () => assert.match(abos.renderEmpty(), /id="subscriptions-empty-add"/));
    withAccess({ budget: 'read' }, () => {
      const html = abos.renderEmpty();
      assert.match(html, /subscriptions\.emptyTitle/);
      assert.doesNotMatch(html, /subscriptions-empty-add|subscriptions\.emptyDescription/);
    });
    abos.state.query = 'netf';
    withAccess({ budget: 'read' }, () => assert.match(abos.renderEmpty(), /id="subscriptions-empty-reset"/,
      'Filter zuruecksetzen schreibt nicht'));
  } finally { Object.assign(abos.state, vorher); }
});

test('Abo-Kennzahlen ohne Monatsbudget: bei `budget: read` keine Aufforderung, eines festzulegen', () => {
  const vorher = abos.state.summary;
  abos.state.summary = { active_count: 1, monthly_total: 12.99, monthly_budget: 0, remaining_budget: 0, base_currency: 'EUR' };
  try {
    withAccess({ budget: 'write' }, () => assert.match(abos.renderSummary(), /subscriptions\.setBudgetHint/));
    withAccess({ budget: 'read' }, () => {
      const html = abos.renderSummary();
      assert.doesNotMatch(html, /subscriptions\.setBudgetHint/);
      assert.match(html, /subscriptions\.unlimited/, 'der Zustand „kein Limit" bleibt');
    });
  } finally { abos.state.summary = vorher; }
});

test('Abos: Kopfaktionen, Listen-Riegel und Wischgeste haengen am Recht', () => {
  // Werkzeugleiste: Kategorien/Zahlungsarten und die Einstellungen schreiben beide.
  assert.match(ABOS_CODE, /\$\{readOnly\(\) \? '' : `<div class="subscriptions-toolbar__actions">/);
  assert.deepEqual([...abos.READ_SAFE_ACTIONS], [], 'edit, renew und delete schreiben alle drei');
  const bind = fn(ABOS_CODE, 'bindContent');
  const riegel = bind.indexOf('if (readOnly() && !READ_SAFE_ACTIONS.has(action.dataset.action)) return;');
  const ersteAktion = bind.indexOf("action.dataset.action === 'edit'");
  assert.ok(riegel > 0 && ersteAktion > 0 && riegel < ersteAktion, 'der Riegel steht hinter der ersten Aktion');
  // Regel 3 (utils/module-access.js): ohne Markup bleibt die VERDRAHTUNG aus.
  const wisch = bind.indexOf('if (list && !readOnly()) {');
  assert.ok(wisch > 0 && wisch < bind.indexOf('wireSubscriptionSwipe(list)'), 'die Wischgeste wird auch bei read verdrahtet');
});

// -------------------------------------------------------------------------
// Geteilte Ausgaben
// -------------------------------------------------------------------------

function splitHauptteil({ archiviert = false } = {}) {
  const vorher = { ...split.state };
  Object.assign(split.state, {
    groupStatus: archiviert ? 'archived' : 'active', activeGroupId: 2, user: null,
    groups: [{ id: 2, name: 'Urlaub Ostsee', type: 'trip', description: '', member_count: 3 }],
    expenses: [{ id: 40, title: 'Ferienwohnung', amount: 600, currency: 'EUR', payer_name: 'Alex', expense_date: '2026-08-02', category: 'other' }],
    balances: { balances: [], simplified_debts: [{ from_name: 'Emma', to_name: 'Alex', amount: 200, currency: 'EUR' }] },
    activity: [],
  });
  let html = '';
  const main = {
    removeAttribute() {}, replaceChildren() { html = ''; },
    insertAdjacentHTML(_p, m) { html += m; }, querySelector: () => null, querySelectorAll: () => [],
  };
  try {
    split.renderMainForTest({ querySelector: (sel) => (sel === '#split-main' ? main : null) });
  } finally { Object.assign(split.state, vorher); }
  return html;
}

test('Gruppe mit Schreibrecht: Bearbeiten, Archivieren, Loeschen, Abrechnen, Einladen und die Ausgabe als Knopf', () => {
  withAccess({ budget: 'write' }, () => {
    const html = splitHauptteil();
    for (const id of ['split-edit-group', 'split-archive-group', 'split-delete-group', 'split-settle', 'split-invite']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /data-expense-id="40"/);
  });
});

test('Gruppe mit `budget: read`: keine Handlung, aber Salden, Ausgaben und Verlauf', () => {
  withAccess({ budget: 'read' }, () => {
    const html = splitHauptteil();
    assert.doesNotMatch(html, /split-header-actions|<button|data-expense-id/);
    assert.match(html, /Urlaub Ostsee/);
    assert.match(html, /<div class="split-expense">/);
    assert.match(html, /Ferienwohnung/);
    assert.match(html, /splitExpenses\.owes/);
  });
});

test('Archiv: mit Schreibrecht bleibt „Wiederherstellen", bei `budget: read` nicht', () => {
  // Zwei Gruende fuer dieselbe Leseansicht - die Gruppe ist archiviert, oder
  // der Nutzer darf nicht schreiben. Nur der erste laesst den Rueckweg offen.
  withAccess({ budget: 'write' }, () => {
    const html = splitHauptteil({ archiviert: true });
    assert.match(html, /id="split-restore-group"/);
    assert.doesNotMatch(html, /data-expense-id/, 'im Archiv ist die Ausgabe ein Listeneintrag');
  });
  withAccess({ budget: 'read' }, () => assert.doesNotMatch(splitHauptteil({ archiviert: true }), /split-restore-group/));
});

test('Regel 6: `renderExpenses` traegt nicht mehr den Namen des Modulrechts', () => {
  // Der Parameter hiess `readOnly` und meinte „archivierte Gruppe" - zwei
  // Bedeutungen unter einem Namen, genau die Kollision, vor der
  // utils/module-access.js warnt. Jetzt heisst er nach seiner Wirkung, und der
  // Aufrufer nennt beide Gruende ausdruecklich.
  assert.match(SPLIT_CODE, /function renderExpenses\(asList = false\)/);
  assert.match(fn(SPLIT_CODE, 'renderMain'), /renderExpenses\(archived \|\| ro\)/);
  assert.match(fn(SPLIT_CODE, 'renderMain'), /if \(!archived && !ro\) \{/);
});

test('Keine Gruppe mit `budget: read`: der Titel bleibt, „Erstelle eine Gruppe" geht', () => {
  const vorher = { ...split.state };
  const gruppen = (mode) => withAccess({ budget: mode }, () => {
    let html = '';
    const el = { replaceChildren() { html = ''; }, insertAdjacentHTML(_p, m) { html += m; } };
    Object.assign(split.state, { groups: [], groupStatus: 'active' });
    split.renderGroupsForTest({ querySelector: (sel) => (sel === '#split-groups' ? el : null) });
    return html;
  });
  try {
    assert.match(gruppen('write'), /splitExpenses\.emptyGroupsText/);
    const html = gruppen('read');
    assert.match(html, /splitExpenses\.emptyGroupsTitle/);
    assert.doesNotMatch(html, /splitExpenses\.emptyGroupsText/);
  } finally { Object.assign(split.state, vorher); }
});

test('Geteilte Ausgaben: Kopfknopf und Gruppe-Anlegen haengen am Recht', () => {
  const render = fn(SPLIT_CODE, 'render');
  assert.match(render, /\$\{readOnly\(\) \? '' : `<button class="btn \$\{addExpenseBtnVariant\}" id="split-add-expense">/);
  assert.match(render, /\$\{readOnly\(\) \? '' : `<button class="btn btn--icon" id="split-add-group"/);
});

// -------------------------------------------------------------------------
// Die zweite Linie: der Riegel vor dem Effekt
// -------------------------------------------------------------------------

test('READ_SAFE_ACTIONS ist eine Positivliste und enthaelt nur lesende Aktionen', () => {
  assert.deepEqual([...budget.READ_SAFE_ACTIONS], ['loan-filter'],
    'der Raten-Filter ist die einzige lesende `data-action` dieser Seite');
  const alle = new Set([...BUDGET_CODE.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(alle.size >= 8, `nur ${alle.size} Aktionen gefunden - der Scanner misst nichts`);
  for (const schreibend of ['delete', 'confirm', 'loan-pay', 'loan-edit', 'loan-delete',
    'loan-payment-edit', 'loan-payment-delete']) {
    assert.ok(alle.has(schreibend), `${schreibend} steht nicht mehr im Markup`);
    assert.ok(!budget.READ_SAFE_ACTIONS.has(schreibend));
  }
});

test('WRITE_HOOKS nennt jeden schreibenden Bedienhaken ohne `data-action`', () => {
  const genannt = budget.WRITE_HOOKS.split(',').map((s) => s.trim()).sort();
  const erwartet = ['[data-edit]', '#budget-add-account', '#budget-add-account-empty',
    '#budget-empty-loan', '#budget-manage-categories', '#empty-cta-budget'].sort();
  assert.deepEqual(genannt, erwartet);
  for (const hook of erwartet) {
    // Die Leerzustaende tragen ihre id als `attrs: { id: '...' }` fuer
    // emptyStateHTML(), der Rest als Markup-Attribut.
    const needle = hook.startsWith('#')
      ? new RegExp(`id(?:="|: ')${hook.slice(1)}['"]`)
      : /data-edit="/;
    assert.match(BUDGET_CODE, needle, `${hook} steht im Riegel, aber nicht mehr im Markup`);
  }
  // Lesende Haken gehoeren NICHT hinein - der Riegel sperrte sonst den Berechtigten.
  for (const lesend of ['[data-drill]', '[data-responsible]', '#budget-toggle-archived', '#budget-clear-loan-filter']) {
    assert.ok(!genannt.includes(lesend), `${lesend} liest nur`);
  }
});

/** Ein Knoten mit Vorfahren und genau so viel `closest()`, wie der Riegel fragt. */
function knoten(attrs, parent = null) {
  const passt = (sel) => {
    const id = sel.match(/^#([\w-]+)$/);
    if (id) return attrs.id === id[1];
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[1] in attrs && (attr[2] === undefined || attrs[attr[1]] === attr[2]);
    throw new Error(`Selektor ${sel} kennt der Test nicht`);
  };
  const el = {
    dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])),
    closest(list) {
      for (let n = el; n; n = n.parent) {
        if (list.split(',').map((s) => s.trim()).some((s) => n.passt(s))) return n;
      }
      return null;
    },
    passt, parent,
  };
  return el;
}

function klick(target) {
  const ev = { target, gestoppt: false, stopPropagation() { this.gestoppt = true; }, preventDefault() {} };
  budget.readOnlyLatch(ev);
  return ev.gestoppt;
}

test('readOnlyLatch(): sperrt jede Aktion ausser den lesenden, und nur bei `read`', () => {
  const panel = knoten({ id: 'budget-body' });
  const loeschen = knoten({ 'data-action': 'delete' }, panel);
  const neueAktion = knoten({ 'data-action': 'irgendwas-von-morgen' }, panel);
  const filter = knoten({ 'data-action': 'loan-filter' }, panel);
  const stift = knoten({ 'data-edit': '4' }, panel);
  const drill = knoten({ 'data-drill': '4' }, panel);
  withAccess({ budget: 'read' }, () => {
    assert.equal(klick(loeschen), true);
    assert.equal(klick(neueAktion), true, 'eine unbekannte Aktion ist gesperrt - dafuer die Positivliste');
    assert.equal(klick(stift), true);
    assert.equal(klick(filter), false);
    assert.equal(klick(drill), false);
  });
  withAccess({ budget: 'write' }, () => {
    assert.equal(klick(loeschen), false);
    assert.equal(klick(stift), false);
  });
});

test('readOnlyLatch(): die eingebetteten Abos und Geteilten Ausgaben bleiben aussen vor', () => {
  // Sie tragen ihre Regel selbst (unten). Ein zweiter Riegel von aussen
  // deutete ihre Aktionsnamen nach der Positivliste von budget.js - `edit`
  // heisst dort etwas anderes -, und jede Aenderung an einer der beiden
  // Listen verschoebe still, was auf der anderen Seite gesperrt ist.
  for (const id of ['budget-subscriptions-panel', 'budget-split-expenses-panel']) {
    const panel = knoten({ id }, knoten({ id: 'budget-body' }));
    withAccess({ budget: 'read' }, () => {
      assert.equal(klick(knoten({ 'data-action': 'edit' }, panel)), false, id);
      assert.equal(klick(knoten({ 'data-action': 'delete' }, panel)), false, id);
    });
  }
});

test('der Riegel haengt in der ERFASSUNGSPHASE am Panel', () => {
  // In der Blasenphase kaeme er nach dem Listener am Knopf selbst - der Dialog
  // stuende dann schon.
  assert.match(fn(BUDGET_CODE, 'render'),
    /querySelector\('#budget-body'\)\?\.addEventListener\('click', readOnlyLatch, true\)/);
});

test('der delegierte Listen-Handler fragt VOR der ersten Aktion, und der Zeilen-Klick fragt mit', () => {
  const body = fn(BUDGET_CODE, 'renderBody');
  const start = body.indexOf("querySelector('#budget-list')?.addEventListener('click'");
  assert.ok(start > 0, 'der Listen-Handler ist nicht mehr da');
  const handler = body.slice(start);
  // Die GANZE Anweisung, nicht nur ihr Ende: ein `false &&` davor liesse ein
  // Teilstueck stehen und den Riegel tot (die Gegenprobe hat es so gestellt).
  const riegel = handler.indexOf('if (action && readOnly() && !READ_SAFE_ACTIONS.has(action.dataset.action)) return;');
  const ersteAktion = handler.indexOf('[data-action="delete"]');
  assert.ok(riegel > 0 && ersteAktion > 0 && riegel < ersteAktion, 'der Riegel steht hinter dem Loeschen');
  assert.match(handler, /if \(item && !action && !readOnly\(\)\) \{/,
    'ein Klick auf die Zeile oeffnet den Bearbeiten-Dialog - bei read nicht');
});

test('Kopfknopf und FAB: der Anlege-Handler fragt selbst, obwohl CSS beide ausblendet', () => {
  const nav = fn(BUDGET_CODE, 'wireNav');
  assert.match(nav, /const addHandler = \(\) => \{\n\s*if \(readOnly\(\)\) return;/);
});

// -------------------------------------------------------------------------
// Die dritte Linie: jeder Einstieg und jedes Speichern fragt noch einmal
// -------------------------------------------------------------------------

test('jeder Einstieg in einen Schreibweg fragt selbst noch einmal', () => {
  const faelle = [
    [BUDGET_CODE, ['openBudgetModal', 'openAccountModal', 'openLoanModal', 'openConfirmBookingModal',
      'openCategoryManager', 'openLoanPaymentEntry', 'saveLoanFromPanel', 'markLoanPayment',
      'deleteLoan', 'deleteLoanPayment', 'deleteEntry', 'deleteEntrySeries']],
    [PLANS_CODE, ['wire', 'openAddPlan', 'openPlanEditor', 'savePlan', 'deletePlan']],
    [ABOS_CODE, ['openSubscriptionModal', 'saveSubscription', 'renewSubscription', 'deleteSubscription',
      'openSettingsModal', 'openMetadataModal']],
    [SPLIT_CODE, ['archiveGroup', 'restoreGroup', 'deleteGroup', 'openGroupModal', 'openExpenseModal',
      'openSettlementModal', 'openMemberModal', 'openGuestModal']],
  ];
  for (const [code, namen] of faelle) {
    for (const name of namen) {
      const koerper = fn(code, name);
      const riegel = koerper.indexOf('if (readOnly()) return;');
      assert.ok(riegel >= 0 && riegel < 140, `${name}() fragt nicht (oder zu spaet) nach dem Recht`);
    }
  }
});

test('der Riegel sitzt an BEIDEN Enden: jedes Speichern im offenen Dialog fragt auch', () => {
  // Ein Rechtewechsel erreicht einen Dialog, der schon offen ist. Das Speichern
  // ueberspringt dann den Schreibvorgang, statt ihn in ein 403 laufen zu lassen.
  for (const id of ['bm-save', 'am-save', 'am-archive', 'am-delete', 'cb-save']) {
    const re = new RegExp(`querySelector\\('#${id}'\\)\\??\\.addEventListener\\('click', async \\(\\) => \\{\\n\\s*if \\(readOnly\\(\\)\\) return;`);
    assert.match(BUDGET_CODE, re, `#${id} speichert ohne zu fragen`);
  }
  for (const name of ['addCategory', 'addSubcategory']) {
    assert.match(BUDGET_CODE, new RegExp(`const ${name} = async \\(\\) => \\{\\n\\s*if \\(readOnly\\(\\)\\) return;`));
  }
  // Abos: die Einstellungen und die fuenf Schreibwege des Dialogs fuer
  // Kategorien und Zahlungsarten.
  assert.match(ABOS_CODE,
    /'#subscriptions-settings-form'\)\.addEventListener\('submit', async \(event\) => \{\n\s*event\.preventDefault\(\);\n\s*if \(readOnly\(\)\) return;/);
  for (const [name, re] of [
    ['Kategorie anlegen', /'#subscription-add-category'\)\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/],
    ['Zahlungsart anlegen', /'#subscription-add-method'\)\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/],
    ['verschieben', /'\[data-move\]'\)\.forEach\(\(button\) => \{\n\s*button\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/],
    ['umbenennen', /'\[data-act="save"\]'\)\.forEach\(\(button\) => \{\n\s*button\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/],
    ['loeschen', /'\[data-act="delete"\]'\)\.forEach\(\(button\) => \{\n\s*button\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/],
  ]) assert.match(ABOS_CODE, re, `Abo-Metadaten: ${name} fragt nicht`);
  // Geteilte Ausgaben: fuenf Formulare und das Loeschen einer Ausgabe.
  const submits = [...SPLIT_CODE.matchAll(/addEventListener\('submit', async \(e\) => \{\n\s*e\.preventDefault\(\);\n\s*(.*)\n/g)];
  assert.equal(submits.length, 5, `fuenf Formulare erwartet, ${submits.length} gefunden`);
  for (const m of submits) assert.equal(m[1], 'if (readOnly()) return;');
  assert.match(SPLIT_CODE, /'#split-delete-expense'\)\?\.addEventListener\('click', async \(\) => \{\n\s*if \(readOnly\(\)\) return;/);
});

// -------------------------------------------------------------------------
// CSS: das Zeichen verspricht nichts
// -------------------------------------------------------------------------

const regeln = [...eachRule(BUDGET_CSS)];
const regelnMit = (pred) => regeln.filter((r) => pred(r.selector.trim()));

test('Planzeile und Sparziel als Kasten: kein Zeiger, und die Hover-Quittung haengt am Knopf', () => {
  for (const block of ['budget-plan-row', 'budget-plan-savings']) {
    const statisch = regelnMit((s) => s === `.${block}--static`);
    assert.ok(statisch.some((r) => /cursor:\s*default/.test(r.body)), `.${block}--static ohne cursor: default`);
    const hover = regelnMit((s) => s.startsWith(`.${block}`) && s.endsWith(':hover') && !s.includes('__'));
    assert.ok(hover.length > 0, `.${block}: keine Hover-Regel gefunden - der Scanner misst nichts`);
    for (const r of hover) {
      assert.ok(r.selector.includes(`:not(.${block}--static)`),
        `${r.selector} trifft auch das Zeichen - eine Gegenregel verloere gegen die naechste spaetere`);
    }
  }
});

test('reduzierte Bewegung schlaegt die Hover-Regel des Sparziels weiterhin', () => {
  // DIE KASKADENFALLE AUS #1252 IN ANDERER KLEIDUNG: `:not()` hebt die
  // Spezifitaet der Hover-Regel. Die Ausnahme fuer reduzierte Bewegung stand
  // als `.budget-plan-savings:hover` da - schwaecher, und damit trotz spaeterer
  // Stelle wirkungslos; die Karte huepfte wieder.
  const basis = regelnMit((s) => s.startsWith('.budget-plan-savings') && s.endsWith(':hover'))
    .filter((r) => !r.at.length && /transform:\s*translateY/.test(r.body));
  const ausnahme = regelnMit((s) => s.startsWith('.budget-plan-savings') && s.endsWith(':hover'))
    .filter((r) => r.at.some((a) => /prefers-reduced-motion/.test(a)) && /transform:\s*none/.test(r.body));
  assert.equal(basis.length, 1);
  assert.equal(ausnahme.length, 1, 'die Ausnahme fuer reduzierte Bewegung fehlt');
  assert.equal(ausnahme[0].selector.trim(), basis[0].selector.trim(),
    'gleicher Selektor = gleiche Spezifitaet, und die spaetere Stelle gewinnt');
  assert.ok(regeln.indexOf(ausnahme[0]) > regeln.indexOf(basis[0]), 'die Ausnahme muss DANACH stehen');
});

test('die Buchungszeile ohne Bearbeiten traegt keinen Zeiger', () => {
  const zeiger = regeln.findIndex((r) => r.selector.trim() === '.budget-entry' && /cursor:\s*pointer/.test(r.body));
  const statisch = regeln.findIndex((r) => r.selector.trim() === '.budget-entry--static' && /cursor:\s*default/.test(r.body));
  assert.ok(zeiger >= 0 && statisch >= 0);
  assert.ok(statisch > zeiger, 'gleiche Spezifitaet: die Ausnahme muss DANACH stehen');
});

test.after(() => miniDomAbraeumen());
