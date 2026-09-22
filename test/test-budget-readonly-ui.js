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
 *        DAZU DIE LESEANSICHTEN (Regel vom 21.09.): ein Datensatz oeffnet bei
 *        `read` alles, was sein Editor zeigt. Buchung, Abo und Ausgabe tun
 *        das nach der Bauart aus P1 - der Editor-Einstieg verzweigt wie
 *        openNoteModal(), gezeichnet mit der geteilten Leseansicht ohne `edit`
 *        und ohne `actions` wie die Kontakt-Detailansicht. Gemessen an den
 *        Optionen, die der Einstieg `openDetailView` uebergibt, und an den
 *        Zeilen selbst; die Belege fragen das Dokumente-Recht. Das Darlehen
 *        hatte seine Leseansicht schon (der Bericht) und bekommt dort die
 *        Angaben aus dem Dialog, die ihm fehlten.
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
function buchungsTab(entries, extra = {}) {
  const vorher = { ...budget.state };
  Object.assign(budget.state, {
    activeTab: 'budget', loadError: null, prevSummary: null, entries,
    summary: { income: 0, expenses: -84.5, balance: -84.5, byCategory: [], pending: { count: 0 } },
    responsibleFilterId: null, groupByResponsible: false, accountFilterId: null,
    ...extra,
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
    assert.match(html, /aria-label="budget\.editEntry: Stromabschlag, /);
  });
});

test('Buchungszeile mit `budget: read`: jede Handlung geht, die Zeile oeffnet die Leseansicht', () => {
  withAccess({ budget: 'read' }, () => {
    const html = buchungsTab([buchung()]);
    // Weg: Verbuchen, Loeschen, der Kategorie-Verwalter im Listenkopf.
    assert.doesNotMatch(html, /data-action=/);
    assert.doesNotMatch(html, /budget-manage-categories/);
    // Die Zeile bleibt ein Knopf - sie oeffnet jetzt die LESEANSICHT (P1-Muster),
    // und ihr Name verspricht deshalb kein „bearbeiten" mehr.
    assert.match(html, /data-id="17"/);
    assert.match(html, /<button class="list-row__name budget-entry__title" type="button"\s+aria-label="Stromabschlag, /);
    assert.doesNotMatch(html, /budget\.editEntry/);
    // Da: Titel, Betrag, die Zustaende „erwartet", „wiederkehrend", „Beleg"
    // als Zeichen, der Zustaendigen-Filter (liest nur) und der CSV-Export.
    assert.match(html, /84[.,]50/);
    assert.match(html, /budget-badge--pending/);
    assert.match(html, /budget\.recurringLabel/);
    assert.match(html, /budget\.receiptsAttachedLabel/);
    assert.match(html, /data-responsible="3"/);
    assert.match(html, /budget-csv-export/);
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

test('Abo-Karte mit `budget: read`: der Koerper oeffnet die Leseansicht, Verlaengern, Loeschen und Wischflaechen gehen', () => {
  withAccess({ budget: 'write' }, () => {
    const html = abos.renderCard(abo());
    assert.match(html, /<button type="button" class="subscription-card__main list-row__main--interactive"\s+data-action="edit">/);
    assert.match(html, /data-action="renew"/);
    assert.match(html, /data-action="delete"/);
    assert.match(html, /swipe-reveal--done/);
    assert.match(html, /common\.edit/);
  });
  withAccess({ budget: 'read' }, () => {
    const html = abos.renderCard(abo());
    assert.match(html, /<button type="button" class="subscription-card__main list-row__main--interactive"\s+data-action="view">/);
    assert.doesNotMatch(html, /data-action="(edit|renew|delete)"|swipe-reveal|common\.edit/);
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
  assert.deepEqual([...abos.READ_SAFE_ACTIONS], ['view'], 'edit, renew und delete schreiben; nur `view` liest');
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
    assert.doesNotMatch(html, /split-header-actions|data-expense-id/);
    // Die Ausgabe oeffnet die Leseansicht, nicht das Bearbeiten.
    assert.match(html, /<button type="button" class="split-expense" data-expense-view="40">/);
    assert.doesNotMatch(html, /splitExpenses\.editExpense/);
    assert.match(html, /Urlaub Ostsee/);
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
    assert.doesNotMatch(html, /data-expense-id/, 'im Archiv bearbeitet die Ausgabe nichts');
    assert.match(html, /data-expense-view="40"/, 'sie oeffnet dort die Leseansicht');
  });
  withAccess({ budget: 'read' }, () => assert.doesNotMatch(splitHauptteil({ archiviert: true }), /split-restore-group/));
});

// --- Storno einer Zahlung im Verlauf (#1309) ---
//
// Die Handlung „Stornieren" haengt an DREI Bedingungen: der Server meldet
// `can_reverse` (Verwalter oder wer eingetragen hat - die Regel wohnt dort),
// das Modul ist beschreibbar, die Gruppe liegt nicht im Archiv. Der Zustand
// „storniert" ist ein Zeichen und steht bei jedem Recht.
function zahlung(extra = {}) {
  return {
    id: 90, type: 'payment_registered', entity_type: 'settlement', entity_id: 7,
    actor_name: 'Emma', created_at: '2026-09-20T10:00:00Z',
    settlement: {
      id: 7, payer_id: 3, payer_name: 'Emma', payee_id: 1, payee_name: 'Alex',
      amount_minor: 2000, amount: '20.00', currency: 'EUR', reversed_at: null, can_reverse: true, ...extra,
    },
  };
}

function verlauf(activity, { archiviert = false } = {}) {
  const vorher = { ...split.state };
  Object.assign(split.state, { activity, groupStatus: archiviert ? 'archived' : 'active' });
  try { return split.renderActivity(); } finally { Object.assign(split.state, vorher); }
}

test('Zahlung im Verlauf: Stornieren nur mit Schreibrecht, `can_reverse` und ausserhalb des Archivs', () => {
  withAccess({ budget: 'write' }, () => {
    const html = verlauf([zahlung()]);
    assert.match(html, /<button type="button" class="btn btn--secondary split-reverse-payment" data-reverse-settlement="7"/);
    // Durch esc(): der Stub von t() haengt die Werte als JSON an, die
    // Anfuehrungszeichen kommen also escaped an.
    const zeile = html.match(/<span class="split-activity-payment">([^<]*)<\/span>/)?.[1].replace(/&quot;/g, '"');
    assert.match(zeile ?? '', /^splitExpenses\.paymentDetail\{"payer":"Emma","payee":"Alex","amount":"20,00\s€"\}$/,
      'die Zeile nennt, wer wem wie viel gezahlt hat');
    assert.doesNotMatch(verlauf([zahlung({ can_reverse: false })]), /data-reverse-settlement/, 'der Server sagt nein');
    assert.doesNotMatch(verlauf([zahlung()], { archiviert: true }), /data-reverse-settlement/, 'Archiv');
  });
  withAccess({ budget: 'read' }, () => {
    const html = verlauf([zahlung()]);
    assert.doesNotMatch(html, /data-reverse-settlement|splitExpenses\.reversePayment/);
    assert.match(html, /splitExpenses\.paymentDetail/, 'die Zahlung selbst bleibt lesbar');
  });
});

test('stornierte Zahlung: Zeichen bei jedem Recht, keine Handlung', () => {
  for (const modus of ['write', 'read']) {
    withAccess({ budget: modus }, () => {
      // can_reverse: true trotz Storno - die Oberflaeche verlaesst sich nicht
      // allein auf den Server, ein Storno des Stornos gibt es nicht.
      const html = verlauf([zahlung({ reversed_at: '2026-09-21T08:00:00Z', can_reverse: true })]);
      assert.match(html, /class="split-activity-item split-activity-item--reversed"/, modus);
      assert.match(html, /<span class="split-activity-reversed">splitExpenses\.paymentReversed<\/span>/, modus);
      assert.doesNotMatch(html, /data-reverse-settlement/, modus);
    });
  }
  // Eine Aktivitaet ohne Zahlung bekommt weder Zeile noch Zeichen.
  withAccess({ budget: 'write' }, () => {
    const html = verlauf([{ id: 1, type: 'expense_created', entity_type: 'expense', actor_name: 'Alex', created_at: '2026-09-20T10:00:00Z' }]);
    assert.doesNotMatch(html, /split-activity-payment|split-activity-reversed|data-reverse-settlement/);
  });
});

/** Klick auf den Knopf aus dem ECHTEN Markup - Attribut und Wert kommen von dort. */
function klickAus(html) {
  const knopf = html.match(/<button [^>]*class="[^"]*split-reverse-payment[^"]*"[^>]*>/);
  assert.ok(knopf, 'kein Storno-Knopf im Markup');
  const dataset = {};
  for (const [, name, wert] of knopf[0].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
    dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = wert;
  }
  return { target: { closest: (sel) => (/^\[data-[\w-]+\]$/.test(sel) && sel.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in dataset ? { dataset } : null) } };
}

async function stornoFahren(modus, { bestaetigt = true } = {}) {
  const posts = [];
  const fragen = [];
  const vorher = { ...split.state };
  const leer = {
    hidden: false, removeAttribute() {}, replaceChildren() {}, insertAdjacentHTML() {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  globalThis.__apiStub = {
    post: async (path, body) => { posts.push([path, body]); return { data: {} }; },
    get: async () => ({ data: [] }),
  };
  globalThis.__confirmModal = async (titel, optionen) => { fragen.push([titel, optionen]); return bestaetigt; };
  try {
    Object.assign(split.state, {
      activeGroupId: 2, groupStatus: 'active', user: null, activity: [zahlung()],
      groups: [{ id: 2, name: 'Urlaub Ostsee', type: 'trip', description: '' }], meta: { currencies: ['EUR'], default_currency: 'EUR' },
    });
    split.renderMainForTest({ querySelector: () => leer });
    Object.assign(split.state, { activity: [zahlung()] });
    const html = withAccess({ budget: 'write' }, () => split.renderActivity());
    // Nicht ueber withAccess(): der Helfer raeumt synchron auf, also am ERSTEN
    // await - der Rest des Handlers liefe dann mit geraeumten Rechten.
    setPermissions({ admin: false, modules: { budget: modus }, widgets: {}, capabilities: {} });
    await split.onActivityClick(klickAus(html));
  } finally {
    clearPermissions();
    delete globalThis.__apiStub;
    delete globalThis.__confirmModal;
    Object.assign(split.state, vorher);
  }
  return { posts, fragen };
}

test('Stornieren: Rueckfrage mit Zahlung, dann POST an die Storno-Route der Zahlung aus dem Markup', async () => {
  const { posts, fragen } = await stornoFahren('write');
  assert.equal(fragen.length, 1, 'eine Rueckfrage');
  assert.equal(fragen[0][0], 'splitExpenses.reversePaymentConfirm');
  assert.match(fragen[0][1].detail, /^splitExpenses\.reversePaymentConfirmDetail\{"payer":"Emma","payee":"Alex","amount":"20,00\s€"\}$/);
  assert.deepEqual(posts, [['/split-expenses/groups/2/settlements/7/reverse', {}]]);
});

test('Stornieren: renderMain haengt den Klick an den Verlauf, den es selbst zeichnet', () => {
  // Ohne diese Verdrahtung waeren Knopf und Handler je fuer sich gruen und der
  // Klick taete nichts. Selektor und Klasse im Markup muessen einander treffen.
  const lauscher = [];
  let html = '';
  const main = {
    removeAttribute() {}, replaceChildren() { html = ''; }, insertAdjacentHTML(_p, m) { html += m; },
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === '.split-activity' ? { addEventListener: (typ, f) => lauscher.push([typ, f]) } : null),
  };
  const vorher = { ...split.state };
  Object.assign(split.state, {
    groupStatus: 'active', activeGroupId: 2, user: null, groups: [{ id: 2, name: 'Urlaub Ostsee', type: 'trip', description: '' }],
    expenses: [], balances: { balances: [], simplified_debts: [] }, activity: [zahlung()],
  });
  try {
    withAccess({ budget: 'write' }, () => split.renderMainForTest({ querySelector: (sel) => (sel === '#split-main' ? main : null) }));
  } finally { Object.assign(split.state, vorher); }
  assert.match(html, /<div class="split-activity">[\s\S]*data-reverse-settlement="7"/);
  assert.deepEqual(lauscher, [['click', split.onActivityClick]]);
});

test('Stornieren: abgebrochen schreibt nichts, bei `budget: read` wird nicht einmal gefragt', async () => {
  const abgebrochen = await stornoFahren('write', { bestaetigt: false });
  assert.equal(abgebrochen.fragen.length, 1);
  assert.deepEqual(abgebrochen.posts, []);
  const lesend = await stornoFahren('read');
  assert.deepEqual(lesend.fragen, []);
  assert.deepEqual(lesend.posts, []);
});

test('Regel 6: `renderExpenses` traegt nicht mehr den Namen des Modulrechts', () => {
  // Der Parameter hiess `readOnly` und meinte „archivierte Gruppe" - zwei
  // Bedeutungen unter einem Namen, genau die Kollision, vor der
  // utils/module-access.js warnt. Jetzt heisst er nach seiner Wirkung, und der
  // Aufrufer nennt beide Gruende ausdruecklich.
  assert.match(SPLIT_CODE, /function renderExpenses\(asList = false\)/);
  assert.match(fn(SPLIT_CODE, 'renderMain'), /renderExpenses\(archived \|\| ro\)/);
  // Der Listen-Handler liest `data-expense-view` in die Leseansicht und nur
  // `data-expense-id` ins Bearbeiten.
  assert.match(fn(SPLIT_CODE, 'renderMain'), /if \(btn\.dataset\.expenseView\) openExpenseReadView\(expense\);\n\s*else openExpenseModal\(expense\);/);
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

test('der delegierte Listen-Handler fragt VOR der ersten Aktion, und der Zeilen-Klick fuehrt ueber den Einstieg', () => {
  const body = fn(BUDGET_CODE, 'renderBody');
  const start = body.indexOf("querySelector('#budget-list')?.addEventListener('click'");
  assert.ok(start > 0, 'der Listen-Handler ist nicht mehr da');
  const handler = body.slice(start);
  // Die GANZE Anweisung, nicht nur ihr Ende: ein `false &&` davor liesse ein
  // Teilstueck stehen und den Riegel tot (die Gegenprobe hat es so gestellt).
  const riegel = handler.indexOf('if (action && readOnly() && !READ_SAFE_ACTIONS.has(action.dataset.action)) return;');
  const ersteAktion = handler.indexOf('[data-action="delete"]');
  assert.ok(riegel > 0 && ersteAktion > 0 && riegel < ersteAktion, 'der Riegel steht hinter dem Loeschen');
  // Der Zeilen-Klick geht an openBudgetModal - und DER verzweigt bei `read`
  // in die Leseansicht (Test unten), wie openNoteModal in P1.
  assert.match(handler, /if \(item && !action\) \{\n[^\n]*\n\s*if \(entry\) openBudgetModal\(\{ mode: 'edit', entry \}\);/);
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
    [BUDGET_CODE, ['openAccountModal', 'openLoanModal', 'openConfirmBookingModal',
      'openCategoryManager', 'openLoanPaymentEntry', 'saveLoanFromPanel', 'markLoanPayment',
      'deleteLoan', 'deleteLoanPayment', 'deleteEntry', 'deleteEntrySeries']],
    [PLANS_CODE, ['wire', 'openAddPlan', 'openPlanEditor', 'savePlan', 'deletePlan']],
    [ABOS_CODE, ['saveSubscription', 'renewSubscription', 'deleteSubscription',
      'openSettingsModal', 'openMetadataModal']],
    [SPLIT_CODE, ['archiveGroup', 'restoreGroup', 'deleteGroup', 'openGroupModal',
      'openSettlementModal', 'openMemberModal', 'openGuestModal', 'reverseSettlement']],
  ];
  for (const [code, namen] of faelle) {
    for (const name of namen) {
      const koerper = fn(code, name);
      const riegel = koerper.indexOf('if (readOnly()) return;');
      assert.ok(riegel >= 0 && riegel < 140, `${name}() fragt nicht (oder zu spaet) nach dem Recht`);
    }
  }
  // Die drei Editor-Einstiege eines Datensatzes fragen AUCH - und verzweigen
  // dabei in die Leseansicht, statt nur abzubrechen (P1: openNoteModal).
  for (const [code, name, zweig] of [
    [BUDGET_CODE, 'openBudgetModal', "if (mode === 'edit' && entry) openEntryReadView(entry);"],
    [ABOS_CODE, 'openSubscriptionModal', 'if (subscription) openSubscriptionReadView(subscription);'],
    [SPLIT_CODE, 'openExpenseModal', 'if (expense?.id) openExpenseReadView(expense);'],
  ]) {
    const koerper = fn(code, name);
    const riegel = koerper.indexOf('if (readOnly()) {');
    assert.ok(riegel >= 0 && riegel < 140, `${name}() fragt nicht (oder zu spaet) nach dem Recht`);
    assert.ok(koerper.indexOf(zweig) > riegel, `${name}() oeffnet bei read keine Leseansicht`);
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

// -------------------------------------------------------------------------
// Leseansichten (#1265 P7, Regel vom 21.09.): ein Datensatz oeffnet bei `read`
// alles, was sein Editor zeigt - und bietet dabei keine einzige Handlung an.
// Die Bauart aus P1: der Einstieg in den Editor verzweigt (openNoteModal ->
// openNoteReadModal), gezeichnet mit der geteilten Leseansicht ohne `edit` und
// ohne `actions` (wie die Kontakt-Detailansicht bei `contacts: read`).
// -------------------------------------------------------------------------

function detailOptionen(fn) {
  const vorher = globalThis.__openDetailView;
  let letzte = null;
  globalThis.__openDetailView = (opts) => { letzte = opts; };
  try { fn(); } finally {
    if (vorher === undefined) delete globalThis.__openDetailView;
    else globalThis.__openDetailView = vorher;
  }
  return letzte;
}

function modalOptionen(fn) {
  const vorher = globalThis.__openModal;
  let letzte = null;
  globalThis.__openModal = (opts) => { letzte = opts; };
  try { fn(); } finally {
    if (vorher === undefined) delete globalThis.__openModal;
    else globalThis.__openModal = vorher;
  }
  return letzte;
}

/** Die Zeilen als { Beschriftung: Wert oder Knoten } - leere fallen weg wie in detailRowEl. */
function zeilen(sections) {
  const out = {};
  for (const s of sections) {
    if (!s || s.hidden) continue;
    if (s.node) out[s.label] = s.node;
    else if (typeof s.value === 'string' && s.value.trim()) out[s.label] = s.value;
  }
  return out;
}

/** Eine Leseansicht bietet nichts an: kein „Bearbeiten" im Kopf, keine Fusszeile. */
function keineHandlung(opts, wer) {
  assert.ok(opts, `${wer}: die Leseansicht geht auf`);
  assert.equal(opts.edit ?? null, null, `${wer}: kein „Bearbeiten" im Kopf`);
  assert.equal((opts.actions ?? []).length, 0, `${wer}: keine Fusszeilen-Aktion`);
}

const beleg = { document_id: 5, name: 'Rechnung.pdf', mime_type: 'application/pdf' };
const belegDocx = {
  document_id: 6, name: 'Vertrag.docx',
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

test('Buchung bei `budget: read`: der Einstieg oeffnet die Leseansicht, nicht den Editor', () => {
  const eintrag = buchung({ attachments: [beleg] });
  const lesend = withAccess({ budget: 'read' }, () => detailOptionen(() => budget.openBudgetModal({ mode: 'edit', entry: eintrag })));
  keineHandlung(lesend, 'Buchung');
  assert.equal(lesend.title, 'Stromabschlag');
  assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => budget.openBudgetModal({ mode: 'edit', entry: eintrag }))), null,
    'kein Editor daneben');
  // Anlegen fuehrt bei `read` nirgends hin - weder Editor noch Leseansicht.
  assert.equal(withAccess({ budget: 'read' }, () => detailOptionen(() => budget.openBudgetModal({ mode: 'create' }))), null);
  assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => budget.openBudgetModal({ mode: 'create' }))), null);
});

/*
 * DER WERT, NICHT DIE BESCHRIFTUNG (P6-Muster, #1349). Jeder Wert, den der
 * Editor mit Schreibrecht zeigt, muss bei `read` in der Leseansicht stehen - je
 * als Paar aus der Form im Editor (roh im Feld, `selected`, `checked`) und der
 * Form in der Leseansicht. Die Zusicherung am Editor haelt die Liste ehrlich:
 * sie misst nur Werte, die der Dialog wirklich zeigt.
 *
 * Und die Liste ist VOLLSTAENDIG: bei einem Datensatz, der jedes Feld traegt,
 * muss die Leseansicht genau die Zeilen der Liste erzeugen - nicht mehr, nicht
 * weniger. Eine tot gestellte Zeile faellt dort und an ihrem Wert auf, eine
 * morgen ergaenzte ohne Eintrag hier ebenfalls. Eine Handliste, die nur ein
 * paar Zeilen prueft, liess die Erinnerung eines Abos still verschwinden.
 */
function jederWert(werte, editorInhalt, z, wer) {
  assert.deepEqual(Object.keys(z).sort(), Object.keys(werte).sort(),
    `${wer}: die Leseansicht erzeugt genau die Zeilen der Liste`);
  for (const [label, [imEditor, inLeseansicht]] of Object.entries(werte)) {
    for (const re of imEditor) assert.match(editorInhalt, re, `${wer}: der Editor zeigt ${re} - sonst misst ${label} nichts`);
    if (typeof inLeseansicht === 'function') assert.ok(inLeseansicht(z[label]), `${wer}: ${label} in der Leseansicht`);
    else assert.match(z[label], inLeseansicht, `${wer}: ${label} in der Leseansicht`);
  }
}

/** Ein Beleg-Knoten mit genau diesem Dokument als Link. */
const belegLink = (id, name, art = 'preview') => (node) => (
  node?.childNodes?.length === 1
  && node.childNodes[0].href === `/api/v1/documents/${id}/${art}`
  && node.childNodes[0].textContent === name
);

test('Buchung: die Leseansicht zeigt jeden Wert des Bearbeiten-Dialogs', async () => {
  const echt = await import('../public/components/user-multi-select.js');
  const vorher = { ...budget.state };
  const vorherPicker = globalThis.__renderUserMultiSelect;
  globalThis.__renderUserMultiSelect = echt.renderUserMultiSelect;
  Object.assign(budget.state, {
    month: '2026-06', budgetMode: 'personal',
    accounts: [{ id: 4, name: 'Girokonto' }],
    members: [{ id: 3, display_name: 'Emma' }, { id: 1, display_name: 'Alex' }],
    meta: { expenseCategories: [{ key: 'housing', name: 'Wohnen' }], incomeCategories: [], subcategories: { housing: [{ key: 'power', name: 'Strom' }] } },
  });
  // Ein Datensatz, der JEDES Feld traegt, das die Ansicht zeigen kann - die
  // virtuelle Serie dazu, weil sie den Betrag umschaltet (Periodenbetrag).
  const eintrag = buchung({
    amount: -84.5, recurrence_full_amount: 1014, recurrence_virtual: 1, recurrence_confirm: 1,
    recurrence_interval: 'monthly', recurrence_interval_count: 1,
    subcategory: 'power', account_id: 4, visibility: 'private', attachments: [beleg],
  });
  const werte = {
    'budget.amountLabel': [[/id="bm-amount"[^>]*value="1014"/, /amount-type-btn--expenses amount-type-btn--active/], /^-1\.014,00\s€$/],
    'budget.detailDateLabel': [[/id="bm-date"\s+value="2026-06-03"/], /^2026-06-03$/],
    'budget.categoryLabel': [[/<option value="housing" selected>budget\.categoryHousing</], /^budget\.categoryHousing$/],
    'budget.subcategoryLabel': [[/<option value="power" selected>Strom</], /^Strom$/],
    'budget.accountLabel': [[/<option value="4" selected>Girokonto</], /^Girokonto$/],
    'budget.visibilityLabel': [[/<option value="private" selected>/], /^budget\.visibility_private$/],
    'budget.responsibleLabel': [[/value="3"[^>]*checked/], /^Emma$/],
    'budget.recurringLabel': [
      [/id="bm-recurring" checked/, /<option value="monthly" selected>/, /id="bm-interval-count"[^>]*value="1"/,
        /id="bm-virtual" checked/, /id="bm-confirm-first" checked/],
      /^budget\.intervalMonthly · budget\.virtualBudgetLabel · budget\.confirmFirstLabel$/],
    'budget.receiptsLabel': [[/Rechnung\.pdf/], belegLink(5, 'Rechnung.pdf')],
  };
  try {
    const editor = withAccess({ budget: 'write', documents: 'read' }, () => modalOptionen(() => budget.openBudgetModal({ mode: 'edit', entry: eintrag })));
    const lesend = withAccess({ budget: 'read', documents: 'read' }, () => detailOptionen(() => budget.openBudgetModal({ mode: 'edit', entry: eintrag })));
    keineHandlung(lesend, 'Buchung');
    jederWert(werte, editor.content, zeilen(lesend.sections), 'Buchung');

    // Die Belege gehoeren dem Dokumente-Modul: ohne dessen Leserecht keine Zeile.
    withAccess({ budget: 'read', documents: 'none' }, () => {
      const z = zeilen(budget.entryReadSections(eintrag));
      assert.equal(z['budget.receiptsLabel'], undefined);
      assert.equal(z['budget.subcategoryLabel'], 'Strom', 'der Rest der Ansicht bleibt');
    });
    // Ohne virtuelle Serie steht der Betrag der Zeile, nicht ein Periodenbetrag.
    withAccess({ budget: 'read' }, () => assert.match(zeilen(budget.entryReadSections(buchung()))['budget.amountLabel'], /^-84,50\s€$/));
    // Die Antwort folgt dem Datensatz: was nicht gesetzt ist, steht nicht da.
    budget.state.budgetMode = 'shared';
    withAccess({ budget: 'read' }, () => {
      const z = zeilen(budget.entryReadSections(buchung({ is_recurring: 0, attachments: [], responsible_users: [] })));
      for (const leer of ['budget.subcategoryLabel', 'budget.accountLabel', 'budget.visibilityLabel',
        'budget.responsibleLabel', 'budget.recurringLabel', 'budget.receiptsLabel']) {
        assert.equal(z[leer], undefined, `${leer} ohne Wert`);
      }
    });
  } finally {
    Object.assign(budget.state, vorher);
    if (vorherPicker === undefined) delete globalThis.__renderUserMultiSelect;
    else globalThis.__renderUserMultiSelect = vorherPicker;
  }
});

test('Abo: die Leseansicht zeigt jeden Wert des Bearbeiten-Dialogs - ohne Handlung', () => {
  const vorher = { ...abos.state.meta };
  Object.assign(abos.state.meta, {
    categories: [{ id: 2, name: 'Streaming' }], payment_methods: [{ id: 1, name: 'Kreditkarte' }],
    billing_cycles: ['monthly', 'yearly'],
  });
  const eintrag = abo({
    description: 'Premium', category_id: 2, category_name: 'Streaming', payment_method_id: 1,
    payment_method_name: 'Kreditkarte', account_username: 'familie@example.org', notes: 'Familienabo',
    end_type: 'on_date', end_date: '2026-12-31', brand_color: '#E50914',
  });
  const werte = {
    'subscriptions.detailAmountLabel': [[/id="subscription-amount"[^>]*value="12\.99"/, /id="subscription-currency" type="hidden" value="EUR"/],
      /^12,99\s€ · subscriptions\.monthlyEquivalent\{"amount":"12,99\s€"\}$/],
    'subscriptions.filterLabelStatus': [[/id="subscription-enabled" type="checkbox" checked/], /^subscriptions\.active$/],
    'subscriptions.descriptionLabel': [[/id="subscription-description"[^>]*value="Premium"/], /^Premium$/],
    'subscriptions.billingCycleLabel': [[/id="subscription-cycle" type="hidden" value="monthly"/, /id="subscription-interval"[^>]*value="1"/],
      /^subscriptions\.cycle\.monthly$/],
    'subscriptions.detailNextPaymentLabel': [[/id="subscription-next-date"[^>]*value="2026-10-01"/], /^2026-10-01 · subscriptions\./],
    'subscriptions.reminderDaysLabel': [[/id="subscription-reminder"[^>]*value="3"/], /^subscriptions\.reminderMeta\{"count":3\}$/],
    'subscriptions.endLabel': [[/id="subscription-end-date"[^>]*value="2026-12-31"/], /^subscriptions\.endsOn\{"date":"2026-12-31"\}$/],
    'subscriptions.categoryLabel': [[/id="subscription-category" type="hidden" value="2"/], /^Streaming$/],
    'subscriptions.paymentMethodLabel': [[/id="subscription-method" type="hidden" value="1"/], /^Kreditkarte$/],
    'subscriptions.accountUsernameLabel': [[/id="subscription-account"[^>]*value="familie@example\.org"/], /^familie@example\.org$/],
    'subscriptions.notesLabel': [[/Familienabo<\/textarea>/], /^Familienabo$/],
  };
  try {
    const editor = withAccess({ budget: 'write' }, () => modalOptionen(() => abos.openSubscriptionModal(eintrag)));
    const lesend = withAccess({ budget: 'read' }, () => detailOptionen(() => abos.openSubscriptionModal(eintrag)));
    keineHandlung(lesend, 'Abo');
    assert.equal(lesend.title, 'Streamingdienst');
    jederWert(werte, editor.content, zeilen(lesend.sections), 'Abo');
    // Die Markenfarbe ist keine Zeile, sondern der Farbstreifen der Ansicht.
    assert.match(editor.content, /id="subscription-color" type="color" value="#E50914"/);
    assert.equal(lesend.accentColor, '#E50914');

    assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => abos.openSubscriptionModal(eintrag))), null,
      'kein Editor daneben');
    assert.equal(withAccess({ budget: 'read' }, () => detailOptionen(() => abos.openSubscriptionModal())), null,
      'Anlegen fuehrt nirgends hin');
    // Ohne Beschreibung, Kategorie, Zahlungsart, Konto, Notiz und Ende stehen diese Zeilen nicht da.
    const leer = withAccess({ budget: 'read' }, () => zeilen(abos.subscriptionReadSections(abo())));
    for (const k of ['subscriptions.descriptionLabel', 'subscriptions.categoryLabel', 'subscriptions.paymentMethodLabel',
      'subscriptions.accountUsernameLabel', 'subscriptions.notesLabel', 'subscriptions.endLabel']) {
      assert.equal(leer[k], undefined, `${k} ohne Wert`);
    }
  } finally { Object.assign(abos.state.meta, vorher); }
});

const ausgabe = {
  id: 40, title: 'Ferienwohnung', amount: 600, currency: 'EUR', payer_id: 1, payer_name: 'Alex',
  expense_date: '2026-08-02', split_method: 'exact', description: 'Anzahlung', attachments: [beleg],
  splits: [
    { user_id: 1, display_name: 'Alex', amount: 400, currency: 'EUR' },
    { user_id: 3, display_name: 'Emma', amount: 200, currency: 'EUR' },
  ],
};

test('Ausgabe: die Leseansicht zeigt jeden Wert des Bearbeiten-Dialogs - ohne Handlung', () => {
  const vorher = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groups: [{ id: 2, default_currency: 'EUR' }], meta: { currencies: ['EUR', 'USD'] },
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
  });
  const werte = {
    'splitExpenses.amount': [[/name="amount"[^>]*value="600"/, /<option value="EUR" selected>/], /^600,00\s€$/],
    'splitExpenses.paidBy': [[/<option value="1" selected>Alex</], /^Alex$/],
    'splitExpenses.date': [[/name="expense_date"[^>]*value="2026-08-02"/], /^2026-08-02$/],
    'splitExpenses.splitMethod': [[/<option value="exact" selected>/], /^splitExpenses\.splitExact$/],
    'splitExpenses.participants': [[/name="split_value_1"[^>]*value="400"/, /name="split_value_3"[^>]*value="200"/],
      /^Alex: 400,00\s€\nEmma: 200,00\s€$/],
    'splitExpenses.notes': [[/Anzahlung<\/textarea>/], /^Anzahlung$/],
    'splitExpenses.receiptsLabel': [[/Rechnung\.pdf/], belegLink(5, 'Rechnung.pdf')],
  };
  try {
    const editor = withAccess({ budget: 'write', documents: 'read' }, () => modalOptionen(() => split.openExpenseModal(ausgabe)));
    const lesend = withAccess({ budget: 'read', documents: 'read' }, () => detailOptionen(() => split.openExpenseModal(ausgabe)));
    keineHandlung(lesend, 'Ausgabe');
    assert.equal(lesend.title, 'Ferienwohnung');
    jederWert(werte, editor.content, zeilen(lesend.sections), 'Ausgabe');

    withAccess({ budget: 'read', documents: 'none' }, () => (
      assert.equal(zeilen(split.expenseReadSections(ausgabe))['splitExpenses.receiptsLabel'], undefined)));
    assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => split.openExpenseModal(ausgabe))), null,
      'kein Editor daneben');
    // Die Uebergabe aus dem Budget ist eine NEUE Ausgabe - bei `read` fuehrt sie nirgends hin.
    assert.equal(withAccess({ budget: 'read' }, () => detailOptionen(() => split.openExpenseModal(null, { title: 'Wasser' }))), null);
    const leer = withAccess({ budget: 'read' }, () => zeilen(split.expenseReadSections({ ...ausgabe, description: '', attachments: [], splits: [] })));
    for (const k of ['splitExpenses.notes', 'splitExpenses.receiptsLabel', 'splitExpenses.participants']) {
      assert.equal(leer[k], undefined, `${k} ohne Wert`);
    }
  } finally { Object.assign(split.state, vorher); }
});

test('Beleg, den der Server nicht nennt: "Vorhanden" statt eines Links ins Leere - Buchung, Ausgabe, Inventar (#1358)', async () => {
  // So kommt ein Beleg ohne Leserecht auf die Dokumente an: die Zeile bleibt,
  // ID und Name sind maskiert (services/document-links.js, Regel 3).
  const verdeckt = { id: 9, document_id: null, name: null, original_name: null, mime_type: null, file_size: null };
  const { __test: inventory } = await import('../public/pages/inventory.js');
  const vorher = { ...split.state };
  Object.assign(split.state, {
    activeGroupId: 2, groups: [{ id: 2, default_currency: 'EUR' }], meta: { currencies: ['EUR', 'USD'] },
    groupMembers: [{ id: 1, display_name: 'Alex' }, { id: 3, display_name: 'Emma' }],
  });
  const nurVorhanden = (node) => node?.childNodes?.length === 1
    && node.childNodes[0].href === undefined
    && node.childNodes[0].textContent === 'documentAttach.presentHidden';
  try {
    for (const documents of ['read', 'write']) {
      withAccess({ budget: 'read', documents }, () => {
        const b = zeilen(budget.entryReadSections(buchung({ attachments: [verdeckt] })))['budget.receiptsLabel'];
        assert.ok(nurVorhanden(b), `Buchung, documents: ${documents}: ein Zeichen, kein Link`);
        const s = zeilen(split.expenseReadSections({ ...ausgabe, attachments: [verdeckt, verdeckt] }))['splitExpenses.receiptsLabel'];
        assert.ok(nurVorhanden(s), `Ausgabe, documents: ${documents}: EIN Zeichen fuer alle verdeckten`);
        const gemischt = zeilen(split.expenseReadSections({ ...ausgabe, attachments: [verdeckt, beleg] }))['splitExpenses.receiptsLabel'];
        assert.equal(gemischt.childNodes.length, 2, 'neben einem sichtbaren Beleg steht das Zeichen zusaetzlich');
        assert.equal(gemischt.childNodes[1].href, '/api/v1/documents/5/preview');
        assert.deepEqual(inventory.attachmentDetailEntries([verdeckt]), [{ text: 'documentAttach.presentHidden' }],
          `Inventar, documents: ${documents}: kein Link auf /documents/null`);
      });
    }
    withAccess({ budget: 'read', documents: 'none' }, () => {
      assert.equal(zeilen(budget.entryReadSections(buchung({ attachments: [verdeckt] })))['budget.receiptsLabel'], undefined,
        'bei `documents: none` bleibt die Stelle leer wie beim Beleg eines Einsatzes');
      assert.equal(zeilen(split.expenseReadSections({ ...ausgabe, attachments: [verdeckt] }))['splitExpenses.receiptsLabel'], undefined);
      assert.deepEqual(inventory.attachmentDetailEntries([verdeckt]), []);
      assert.deepEqual(inventory.attachmentDetailEntries([beleg]), [], 'auch ein sichtbarer Beleg: der Link ginge ins 403');
    });
  } finally { Object.assign(split.state, vorher); }
});

test('das Paar dazu: mit Schreibrecht oeffnen dieselben drei Einstiege den Editor, keine Leseansicht', () => {
  const vorherBudget = budget.state.month;
  const vorherSplit = { ...split.state };
  budget.state.month = '2026-06';
  Object.assign(split.state, { activeGroupId: 2, groups: [{ id: 2, default_currency: 'EUR' }], meta: { currencies: ['EUR'] } });
  try {
    for (const [wer, oeffnen] of [
      ['Buchung', () => budget.openBudgetModal({ mode: 'edit', entry: buchung({ attachments: [] }) })],
      ['Abo', () => abos.openSubscriptionModal(abo())],
      ['Ausgabe', () => split.openExpenseModal({ ...ausgabe, attachments: [] })],
    ]) {
      withAccess({ budget: 'write' }, () => {
        let lesen = null;
        const editor = modalOptionen(() => { lesen = detailOptionen(oeffnen); });
        assert.ok(editor, `${wer}: mit Schreibrecht geht der Editor auf`);
        assert.equal(lesen, null, `${wer}: und keine Leseansicht`);
      });
    }
  } finally {
    budget.state.month = vorherBudget;
    Object.assign(split.state, vorherSplit);
  }
});

/** Die Kacheln des Berichts als { Beschriftung: Wert }, entschluesselt wie im Browser. */
function berichtKacheln(html) {
  const ent = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries([...html.matchAll(/<div(?: class="[^"]*")?><span>([^<]*)<\/span><strong>([^<]*)<\/strong><\/div>/g)]
    .map((m) => [ent(m[1]), ent(m[2])]));
}

test('Darlehen: der Bericht zeigt jeden Wert des Darlehens-Dialogs, den Karte und Kennzahlen nicht tragen', () => {
  mitKonten([konto()], () => {
    const loan = darlehen({
      account_id: 4, start_month: '2026-01', notes: 'Sondertilgung <jaehrlich>', currency: 'EUR',
      interest: { mode: 'fixed', principal: 20000, fixed_rate: 3.2, initial_repayment_rate: 2, monthly_payment: 850 },
    });
    const werte = {
      'budget.loanAccountLabel': [[/<option value="4" selected>Girokonto</], /^Girokonto$/],
      'budget.loanDetailStartMonthLabel': [[/id="lm-start" value="2026-01"/], /2026/],
      'budget.loanInitialRepaymentLabel': [[/id="lm-initial-repayment"[^>]*value="2"/], /^2$/],
      'budget.loanInterestModeLabel': [[/<option value="fixed" selected>/, /id="lm-fixed-rate"[^>]*value="3\.2"/],
        /^budget\.loanMonthlyRate\{"amount":"850,00\s€"\} · budget\.loanRateFixed\{"rate":"3,2\s%"\}$/],
      'budget.loanNotesLabel': [[/Sondertilgung &lt;jaehrlich&gt;<\/textarea>/], /^Sondertilgung <jaehrlich>$/],
    };
    const editor = withAccess({ budget: 'write' }, () => modalOptionen(() => budget.openLoanModal(loan)));
    const html = budget.loanReportDetails(loan);
    jederWert(werte, editor.content, berichtKacheln(html), 'Darlehen');
    assert.match(html, /Sondertilgung &lt;jaehrlich&gt;/, 'die Notiz geht durch esc()');
    assert.match(html, /class="loan-report__cell--wide"><span>budget\.loanInterestModeLabel/);
    assert.match(html, /class="loan-report__cell--wide"><span>budget\.loanNotesLabel/);
    assert.doesNotMatch(html, /<button/);
    // Der erste Faelligkeitsmonat steht als Monatsname, nicht als Schluessel.
    assert.notEqual(berichtKacheln(html)['budget.loanDetailStartMonthLabel'], '2026-01');
    assert.equal(budget.loanReportDetails(darlehen()), '', 'ohne Angaben keine leere Kachelreihe');
  });
});

// -------------------------------------------------------------------------
// Konto und Gruppe (Entscheidung Ulas, 21.09.): fehlt bei `read` ein Wert,
// steht er dort, wo der Tipp ohnehin landet - kein neuer Knopf nur fuers Lesen.
// -------------------------------------------------------------------------

test('Kontoauszug: der Kreditrahmen aus dem Konto-Dialog steht im Kopf - in beiden Modi', () => {
  const karte = konto({ type: 'credit', credit_limit: 2000, credit_bank: 'Hausbank', available_limit: 1500, currency: 'EUR' });
  // Der Dialog zeigt den Rahmen mit Schreibrecht roh im Feld - sonst mass die Zeile unten nichts.
  const editor = mitKonten([karte], () => withAccess({ budget: 'write' }, () => modalOptionen(() => budget.openAccountModal(karte))));
  assert.match(editor.content, /id="am-credit-limit"[^>]*value="2000"/);
  const kopf = (modus, account) => mitKonten([account], () => withAccess({ budget: modus }, () => {
    const vorher = budget.state.accountFilterId;
    budget.state.accountFilterId = account.id;
    try { return buchungsTab([buchung({ account_id: account.id })], { accountFilterId: account.id }); } finally { budget.state.accountFilterId = vorher; }
  }));
  for (const modus of ['read', 'write']) {
    const html = kopf(modus, karte);
    assert.match(html, /id="budget-clear-account-filter"/, `${modus}: der Auszug ist offen`);
    assert.match(html, /<div class="budget-list-header__filter">budget\.creditLimitLabel 2\.000,00\s€<\/div>/,
      `${modus}: der Rahmen steht im Kopf des Auszugs`);
  }
  // Die Antwort folgt dem Datensatz: kein Rahmen gesetzt, oder gar keine Kreditkarte - keine Zeile.
  assert.doesNotMatch(kopf('read', { ...karte, credit_limit: null }), /creditLimitLabel/);
  assert.doesNotMatch(kopf('read', konto({ credit_limit: 2000 })), /creditLimitLabel/, 'nur die Kreditkarte fuehrt das Feld');
});

const gruppe = (over = {}) => ({
  id: 2, name: 'Urlaub Ostsee', type: 'trip', description: '', member_count: 2,
  default_currency: 'EUR', default_split_method: 'percentage',
  default_split_config: JSON.stringify([{ user_id: 1, percentage: 60 }, { user_id: 3, percentage: 40 }]),
  ...over,
});
const mitglieder = [
  { user_id: 1, display_name: 'Alex', role: 'owner' },
  { user_id: 3, display_name: 'Emma', role: 'guest' },
];

/** Der Gruppenkopf, wie renderMain() ihn baut. */
function gruppenKopf(g, members, modus) {
  const vorher = { ...split.state };
  Object.assign(split.state, {
    groupStatus: 'active', activeGroupId: g.id, user: null, groups: [g], groupMembers: members,
    expenses: [], balances: { balances: [], simplified_debts: [] }, activity: [],
  });
  let html = '';
  const main = {
    removeAttribute() {}, replaceChildren() { html = ''; },
    insertAdjacentHTML(_p, m) { html += m; }, querySelector: () => null, querySelectorAll: () => [],
  };
  try {
    withAccess({ budget: modus }, () => split.renderMainForTest({ querySelector: (sel) => (sel === '#split-main' ? main : null) }));
  } finally { Object.assign(split.state, vorher); }
  return html;
}

/** Die Zeile als { Beschriftung: Wert } - entschluesselt wie im Browser. */
function gruppenZeile(html) {
  const m = html.match(/<p class="split-group-meta">([^<]*)<\/p>/);
  if (!m) return {};
  const text = m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries(text.split(' · ').map((teil) => {
    const i = teil.indexOf(': ');
    return [teil.slice(0, i), teil.slice(i + 2)];
  }));
}

test('Gruppenkopf bei `budget: read`: Waehrung, Standardaufteilung und Mitglieder aus dem Gruppen-Dialog', async () => {
  const vorher = { ...split.state };
  const kandidaten = [
    { source: 'user', user_id: 1, display_name: 'Alex', in_group: true, group_role: 'owner' },
    { source: 'user', user_id: 3, display_name: 'Emma', in_group: true, group_role: 'guest' },
  ];
  Object.assign(split.state, {
    activeGroupId: 2, groups: [gruppe()], groupMembers: mitglieder, user: null,
    meta: { currencies: ['EUR', 'USD'], group_types: ['trip', 'household'], default_currency: 'EUR' },
  });
  globalThis.__apiStub = { get: async () => ({ data: kandidaten }) };
  let editor = null;
  const vorherModal = globalThis.__openModal;
  globalThis.__openModal = (opts) => { editor = opts; };
  try {
    setPermissions({ admin: false, modules: { budget: 'write' }, widgets: {}, capabilities: {} });
    await split.openGroupModal(gruppe());
  } finally {
    clearPermissions();
    delete globalThis.__apiStub;
    if (vorherModal === undefined) delete globalThis.__openModal; else globalThis.__openModal = vorherModal;
    Object.assign(split.state, vorher);
  }
  const werte = {
    'splitExpenses.currency': [[/<option value="EUR" selected>EUR</], /^EUR$/],
    'splitExpenses.defaultSplit': [[/<option value="percentage" selected>/, /name="default_value_1"[^>]*value="60"/, /name="default_value_3"[^>]*value="40"/],
      /^splitExpenses\.splitPercentage - Alex 60\u00a0%, Emma 40\u00a0%$/],
    'splitExpenses.members': [[/value="user:1" checked[\s\S]*Alex/, /value="user:3" checked[\s\S]*Emma · splitExpenses\.roleGuest/],
      /^Alex, Emma \(splitExpenses\.roleGuest\)$/],
  };
  jederWert(werte, editor.content, gruppenZeile(gruppenKopf(gruppe(), mitglieder, 'read')), 'Gruppe');
  // Mit Schreibrecht fuehrt der Stift in den Dialog - der Kopf bleibt, wie er war.
  assert.doesNotMatch(gruppenKopf(gruppe(), mitglieder, 'write'), /split-group-meta/);
});

test('Gruppenkopf: das Prozentzeichen schreibt die Region, nicht ein festes Literal', () => {
  // Der Dialog fuehrt die Vorbelegung als rohe Zahl (hoechstens zwei
  // Nachkommastellen), die Einheit steckt dort in der Methode. Die Zeile nennt
  // sie selbst - Stellung und Abstand kommen aus Intl ueber getNumberFormat().
  const vorher = globalThis.__formatLocale;
  const zeile = (locale, config) => {
    globalThis.__formatLocale = locale;
    return gruppenZeile(gruppenKopf(gruppe({ default_split_config: JSON.stringify(config) }), mitglieder, 'read'))['splitExpenses.defaultSplit'];
  };
  try {
    const sechzigVierzig = [{ user_id: 1, percentage: 60 }, { user_id: 3, percentage: 40 }];
    assert.equal(zeile('en-US', sechzigVierzig), 'splitExpenses.splitPercentage - Alex 60%, Emma 40%');
    assert.equal(zeile('de-DE', sechzigVierzig), 'splitExpenses.splitPercentage - Alex 60 %, Emma 40 %');
    // Zwei Nachkommastellen wie im Dialog, mit dem Dezimaltrenner der Region.
    assert.equal(zeile('de-DE', [{ user_id: 1, percentage: '66.67' }, { user_id: 3, percentage: '33.33' }]),
      'splitExpenses.splitPercentage - Alex 66,67 %, Emma 33,33 %');
  } finally {
    if (vorher === undefined) delete globalThis.__formatLocale; else globalThis.__formatLocale = vorher;
  }
  // Anteile bleiben reine Zahlen - ohne Zeichen.
  const anteile = gruppenZeile(gruppenKopf(gruppe({ default_split_method: 'shares',
    default_split_config: JSON.stringify([{ user_id: 1, shares: 2 }, { user_id: 3, shares: 1 }]) }), mitglieder, 'read'));
  assert.equal(anteile['splitExpenses.defaultSplit'], 'splitExpenses.splitShares - Alex 2, Emma 1');
});

test('Gruppenkopf: bei vielen Mitgliedern Namen bis zur Grenze, danach „+N"; Namen gehen durch esc()', () => {
  const viele = ['Alex', 'Emma', 'Leo', 'Maria', 'Linda', 'Tom', '<b>Zoe</b>']
    .map((display_name, i) => ({ user_id: i + 1, display_name, role: 'member' }));
  const html = gruppenKopf(gruppe({ default_split_method: 'equal', default_split_config: null }), viele, 'read');
  const z = gruppenZeile(html);
  assert.equal(z['splitExpenses.members'], 'Alex, Emma, Leo, Maria, Linda, splitExpenses.moreMembers{"count":2}');
  assert.equal(z['splitExpenses.defaultSplit'], 'splitExpenses.splitEqual', 'gleich verteilt: keine Vorbelegung je Person');
  const ein = gruppenZeile(gruppenKopf(gruppe({ default_split_method: 'equal' }), viele.slice(0, 6), 'read'));
  assert.match(ein['splitExpenses.members'], /splitExpenses\.moreMembers\{"count":1\}$/);
  const alle = gruppenKopf(gruppe({ default_split_method: 'equal' }), [...viele.slice(0, 4), viele[6]], 'read');
  assert.match(alle, /&lt;b&gt;Zoe&lt;\/b&gt;/, 'ein Name ist Text, kein Markup');
  assert.doesNotMatch(alle, /<b>Zoe/);
  assert.doesNotMatch(alle, /moreMembers/, 'bis zur Grenze kein „+N"');
});

test('der Darlehensbericht haengt nicht an `.budget-page` - er ist ein Modal (#1347)', () => {
  const breit = regeln.filter((r) => r.selector.includes('loan-report__cell--wide'));
  assert.ok(breit.length >= 1);
  for (const r of breit) assert.ok(!r.selector.includes('.budget-page'), r.selector);
  assert.ok(breit.some((r) => /grid-column:\s*1\s*\/\s*-1/.test(r.body)));
});

test.after(() => miniDomAbraeumen());
