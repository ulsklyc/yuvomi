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
      'openSettlementModal', 'openMemberModal', 'openGuestModal']],
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

test('Leseansicht einer Buchung: Unterkategorie, Konto, Sichtbarkeit, Wiederholung und Belege', () => {
  const vorher = { budgetMode: budget.state.budgetMode, meta: budget.state.meta, accounts: budget.state.accounts };
  Object.assign(budget.state, {
    budgetMode: 'personal',
    accounts: [{ id: 4, name: 'Girokonto' }],
    meta: { expenseCategories: [{ key: 'housing', name: 'Wohnen' }], incomeCategories: [], subcategories: { housing: [{ key: 'power', name: 'Strom' }] } },
  });
  const eintrag = buchung({
    subcategory: 'power', account_id: 4, visibility: 'private',
    recurrence_interval: 'monthly', recurrence_interval_count: 1, recurrence_confirm: 1,
    attachments: [beleg, belegDocx],
  });
  try {
    withAccess({ budget: 'read', documents: 'read' }, () => {
      const z = zeilen(budget.entryReadSections(eintrag));
      assert.match(z['budget.amountLabel'], /84[.,]50/);
      assert.equal(z['budget.detailDateLabel'], '2026-06-03');
      assert.equal(z['budget.subcategoryLabel'], 'Strom');
      assert.equal(z['budget.accountLabel'], 'Girokonto');
      assert.equal(z['budget.visibilityLabel'], 'budget.visibility_private');
      assert.equal(z['budget.responsibleLabel'], 'Emma');
      assert.equal(z['budget.recurringLabel'], 'budget.intervalMonthly · budget.confirmFirstLabel');
      // Die Belege: je einer ein Link, vorschaubar -> /preview, sonst /download.
      const links = z['budget.receiptsLabel'].childNodes;
      assert.equal(links.length, 2);
      assert.equal(links[0].href, '/api/v1/documents/5/preview');
      assert.equal(links[1].href, '/api/v1/documents/6/download');
      assert.equal(links[0].rel, 'noopener noreferrer');
    });
    // Die Belege gehoeren dem Dokumente-Modul: ohne dessen Leserecht keine Zeile.
    withAccess({ budget: 'read', documents: 'none' }, () => {
      const z = zeilen(budget.entryReadSections(eintrag));
      assert.equal(z['budget.receiptsLabel'], undefined);
      assert.equal(z['budget.subcategoryLabel'], 'Strom', 'der Rest der Ansicht bleibt');
    });
    // Die Antwort folgt dem Datensatz: was nicht gesetzt ist, steht nicht da.
    budget.state.budgetMode = 'shared';
    withAccess({ budget: 'read' }, () => {
      const z = zeilen(budget.entryReadSections(buchung({ is_recurring: 0, attachments: [], responsible_users: [] })));
      for (const leer of ['budget.subcategoryLabel', 'budget.accountLabel', 'budget.visibilityLabel',
        'budget.responsibleLabel', 'budget.recurringLabel', 'budget.receiptsLabel']) {
        assert.equal(z[leer], undefined, `${leer} ohne Wert`);
      }
    });
  } finally { Object.assign(budget.state, vorher); }
});

test('Abo bei `budget: read`: Leseansicht mit Beschreibung, Kategorie, Konto und Notiz - ohne Handlung', () => {
  const eintrag = abo({
    description: 'Premium', category_id: 2, category_name: 'Streaming', payment_method_id: 1,
    payment_method_name: 'Kreditkarte', account_username: 'familie@example.org', notes: 'Familienabo',
  });
  const lesend = withAccess({ budget: 'read' }, () => detailOptionen(() => abos.openSubscriptionModal(eintrag)));
  keineHandlung(lesend, 'Abo');
  assert.equal(lesend.title, 'Streamingdienst');
  const z = zeilen(lesend.sections);
  assert.match(z['subscriptions.detailAmountLabel'], /12[.,]99/);
  assert.equal(z['subscriptions.descriptionLabel'], 'Premium');
  assert.equal(z['subscriptions.categoryLabel'], 'Streaming');
  assert.equal(z['subscriptions.paymentMethodLabel'], 'Kreditkarte');
  assert.equal(z['subscriptions.accountUsernameLabel'], 'familie@example.org');
  assert.equal(z['subscriptions.notesLabel'], 'Familienabo');
  assert.ok(z['subscriptions.billingCycleLabel'] && z['subscriptions.detailNextPaymentLabel']);
  assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => abos.openSubscriptionModal(eintrag))), null,
    'kein Editor daneben');
  assert.equal(withAccess({ budget: 'read' }, () => detailOptionen(() => abos.openSubscriptionModal())), null,
    'Anlegen fuehrt nirgends hin');
  // Und ohne Kategorie, Konto und Notiz stehen diese Zeilen nicht da.
  const leer = withAccess({ budget: 'read' }, () => zeilen(abos.subscriptionReadSections(abo())));
  for (const k of ['subscriptions.categoryLabel', 'subscriptions.accountUsernameLabel', 'subscriptions.notesLabel']) {
    assert.equal(leer[k], undefined, `${k} ohne Wert`);
  }
});

const ausgabe = {
  id: 40, title: 'Ferienwohnung', amount: 600, currency: 'EUR', payer_name: 'Alex',
  expense_date: '2026-08-02', split_method: 'exact', description: 'Anzahlung', attachments: [beleg],
  splits: [
    { user_id: 1, display_name: 'Alex', amount: 400, currency: 'EUR' },
    { user_id: 3, display_name: 'Emma', amount: 200, currency: 'EUR' },
  ],
};

test('Ausgabe bei `budget: read`: Aufteilung, Anteile, Notiz und Beleg - ohne Handlung', () => {
  const lesend = withAccess({ budget: 'read', documents: 'read' }, () => detailOptionen(() => split.openExpenseModal(ausgabe)));
  keineHandlung(lesend, 'Ausgabe');
  assert.equal(lesend.title, 'Ferienwohnung');
  const z = zeilen(lesend.sections);
  assert.equal(z['splitExpenses.paidBy'], 'Alex');
  assert.equal(z['splitExpenses.splitMethod'], 'splitExpenses.splitExact');
  assert.match(z['splitExpenses.participants'], /^Alex: 400[.,]00[^\n]*\nEmma: 200[.,]00/);
  assert.equal(z['splitExpenses.notes'], 'Anzahlung');
  assert.equal(z['splitExpenses.receiptsLabel'].childNodes[0].href, '/api/v1/documents/5/preview');
  withAccess({ budget: 'read', documents: 'none' }, () => (
    assert.equal(zeilen(split.expenseReadSections(ausgabe))['splitExpenses.receiptsLabel'], undefined)));
  assert.equal(withAccess({ budget: 'read' }, () => modalOptionen(() => split.openExpenseModal(ausgabe))), null,
    'kein Editor daneben');
  // Die Uebergabe aus dem Budget ist eine NEUE Ausgabe - bei `read` fuehrt sie nirgends hin.
  assert.equal(withAccess({ budget: 'read' }, () => detailOptionen(() => split.openExpenseModal(null, { title: 'Wasser' }))), null);
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

test('Darlehensbericht: Konto, erster Faelligkeitsmonat, Zinsmodell und Notiz aus dem Dialog', () => {
  mitKonten([konto()], () => {
    const html = budget.loanReportDetails(darlehen({
      account_id: 4, start_month: '2026-01', notes: 'Sondertilgung <jaehrlich>',
      interest: { mode: 'fixed', fixed_rate: 3.2, initial_repayment_rate: 2, monthly_payment: 850 },
    }));
    assert.match(html, /budget\.loanAccountLabel<\/span><strong>Girokonto</);
    assert.match(html, /budget\.loanDetailStartMonthLabel/);
    assert.match(html, /budget\.loanInitialRepaymentLabel<\/span><strong>2</);
    assert.match(html, /class="loan-report__cell--wide"><span>budget\.loanInterestModeLabel/);
    assert.match(html, /Sondertilgung &lt;jaehrlich&gt;/, 'die Notiz geht durch esc()');
    assert.doesNotMatch(html, /<button/);
    assert.equal(budget.loanReportDetails(darlehen()), '', 'ohne Angaben keine leere Kachelreihe');
  });
});

test('der Darlehensbericht haengt nicht an `.budget-page` - er ist ein Modal (#1347)', () => {
  const breit = regeln.filter((r) => r.selector.includes('loan-report__cell--wide'));
  assert.ok(breit.length >= 1);
  for (const r of breit) assert.ok(!r.selector.includes('.budget-page'), r.selector);
  assert.ok(breit.some((r) => /grid-column:\s*1\s*\/\s*-1/.test(r.body)));
});

test.after(() => miniDomAbraeumen());
