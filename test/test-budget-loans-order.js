/**
 * Test: Reihenfolge der Darlehen (#1706, aus Discussion #935)
 * Zweck: Die Darlehensliste laesst sich nach Zinssatz (avalanche) und nach
 *        Restschuld (snowball) ordnen. Gemessen wird an zwei Stellen:
 *        1. `sortLoans()` als Rechnung - Richtung, Gleichstand, Fremdwaehrung,
 *           zinsfreie und getilgte Darlehen.
 *        2. der ECHTE Render-Pfad der Seite (`renderLoansPage()`): die Karten
 *           stehen in der gewaehlten Reihenfolge, das Menue nennt die Wahl,
 *           und beides bleibt bei `budget: read` stehen.
 *        Dazu die Grenze aus dem Issue: die Oberflaeche raet zu nichts.
 * Ausführen: npm run test:budget-loans-order
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { installMiniDom } = await import('./mini-dom.js');
const miniDomAbraeumen = installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: budget } = await import('../public/pages/budget.js');
const {
  LOAN_SORTS, DEFAULT_LOAN_SORT, normalizeLoanSort, sortLoans, loanSortRate, loanSortBalance,
} = await import('../public/utils/loan-order.js');

function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return fn(); } finally { clearPermissions(); }
}

// Die Reihenfolge der Liste IST die des Servers: aktiv zuerst, dann Startmonat.
const darlehen = (id, over = {}) => ({
  id, title: `Darlehen ${id}`, borrower: 'Bank', direction: 'borrowed', status: 'active',
  currency: 'EUR', exchange_rate: 1, is_foreign_currency: false,
  total_amount: 12000, remaining_amount: 6000, remaining_principal: 6000, paid_amount: 6000,
  paid_installments: 6, installment_count: 12, remaining_installments: 6,
  next_due_month: '2026-11', projected_end_month: '2027-04', is_settled: false,
  interest: null, payments: [], ...over,
});
const zins = (current_rate, over = {}) => ({
  mode: 'fixed', principal: 10000, fixed_rate: current_rate, current_rate,
  monthly_payment: 200, total_interest: 500, remaining_principal: 6000,
  remaining_after_binding: 0, binding_end_month: null, ...over,
});
const ids = (loans) => loans.map((l) => l.id);

// -------------------------------------------------------------------------
// Die Rechnung
// -------------------------------------------------------------------------

test('die Voreinstellung laesst die Reihenfolge des Servers stehen', () => {
  const liste = [darlehen(3), darlehen(1), darlehen(2)];
  assert.equal(DEFAULT_LOAN_SORT, 'start');
  assert.deepEqual(ids(sortLoans(liste, 'start')), [3, 1, 2]);
  assert.deepEqual(ids(sortLoans(liste, undefined)), [3, 1, 2]);
  assert.notEqual(sortLoans(liste, 'start'), liste, 'eine neue Liste, die Eingabe bleibt');
});

test('eine unbekannte Wahl (alter oder fremder Speicherwert) faellt auf die Voreinstellung', () => {
  for (const wert of [null, undefined, '', 'recommended', 'RATE', 7, {}]) {
    assert.equal(normalizeLoanSort(wert), 'start');
  }
  for (const wert of LOAN_SORTS) assert.equal(normalizeLoanSort(wert), wert);
});

test('nach Zinssatz: der hoechste Satz zuerst, zinsfrei am Ende', () => {
  const liste = [
    darlehen(1, { interest: zins(2.1) }),
    darlehen(2),                              // ohne Zins
    darlehen(3, { interest: zins(7.9) }),
    darlehen(4, { interest: zins(0) }),       // verzinst gefuehrt, Satz 0
    darlehen(5, { interest: zins(4) }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'rate')), [3, 5, 1, 2, 4]);
  assert.equal(loanSortRate(liste[1]), 0);
});

test('nach Zinssatz zaehlt der Satz der naechsten Rate, nicht der der Bindung', () => {
  // Ein Darlehen NACH der Zinsbindung: fest 1,5 %, jetzt 6 %. Mit `fixed_rate`
  // sortiert, stuende es unter dem 4-%-Darlehen.
  const liste = [
    darlehen(1, { interest: zins(4) }),
    darlehen(2, { interest: zins(6, { mode: 'fixed_then_variable', fixed_rate: 1.5, followup_rate: 6 }) }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'rate')), [2, 1]);
});

test('nach Restschuld: die kleinste zuerst, gemessen an der Restschuld und nicht an den Restraten', () => {
  const liste = [
    darlehen(1, { remaining_principal: 9000, remaining_amount: 100 }),
    darlehen(2, { remaining_principal: 250, remaining_amount: 99999 }),
    darlehen(3, { remaining_principal: 4000, remaining_amount: 5000 }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'balance')), [2, 3, 1]);
});

test('nach Restschuld: Fremdwaehrung geht mit ihrem Kurs in die Budget-Waehrung ein', () => {
  // 1.000.000 JPY bei 0,006 sind 6.000 EUR - weniger als 8.000 EUR, obwohl die
  // nackte Zahl hundertmal groesser ist.
  const liste = [
    darlehen(1, { remaining_principal: 8000 }),
    darlehen(2, { remaining_principal: 1000000, currency: 'JPY', exchange_rate: 0.006, is_foreign_currency: true }),
    darlehen(3, { remaining_principal: 5000, currency: 'USD', exchange_rate: 2, is_foreign_currency: true }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'balance')), [2, 1, 3]);
  assert.equal(loanSortBalance(liste[1]), 6000);
  assert.equal(loanSortBalance(darlehen(9, { remaining_principal: 70, exchange_rate: 0 })), 70, 'ein kaputter Kurs zaehlt als 1');
});

test('Gleichstand bleibt in der Reihenfolge des Servers', () => {
  const liste = [
    darlehen(4, { interest: zins(3) }),
    darlehen(2, { interest: zins(3) }),
    darlehen(7, { interest: zins(3) }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'rate')), [4, 2, 7]);
  assert.deepEqual(ids(sortLoans(liste, 'balance')), [4, 2, 7]);
});

test('getilgte Darlehen stehen in jeder Sortierung hinten, unter sich wie vom Server geliefert', () => {
  // Ohne die Regel fuehrte das getilgte Darlehen "kleinste Restschuld zuerst"
  // an (Restschuld 0), und ein getilgtes 9-%-Darlehen stuende ueber allem, was
  // noch laeuft.
  const liste = [
    darlehen(1, { interest: zins(2), remaining_principal: 7000 }),
    darlehen(2, { interest: zins(5), remaining_principal: 3000 }),
    darlehen(3, { status: 'paid', is_settled: true, interest: zins(9), remaining_principal: 0 }),
    darlehen(4, { status: 'paid', is_settled: true, interest: zins(1), remaining_principal: 0 }),
  ];
  assert.deepEqual(ids(sortLoans(liste, 'rate')), [2, 1, 3, 4]);
  assert.deepEqual(ids(sortLoans(liste, 'balance')), [2, 1, 3, 4]);
  // is_settled ohne nachgezogenen Status zaehlt ebenfalls als fertig.
  const frisch = [darlehen(5, { is_settled: true, remaining_principal: 0 }), darlehen(6, { remaining_principal: 10 })];
  assert.deepEqual(ids(sortLoans(frisch, 'balance')), [6, 5]);
});

// -------------------------------------------------------------------------
// Die Seite
// -------------------------------------------------------------------------

const BESTAND = [
  darlehen(1, { title: 'Haus', interest: zins(2.1), remaining_principal: 180000 }),
  darlehen(2, { title: 'Auto', interest: zins(6.4), remaining_principal: 9000 }),
  darlehen(3, { title: 'Oma', remaining_principal: 400, direction: 'lent' }),
  darlehen(4, { title: 'Alt', status: 'paid', is_settled: true, interest: zins(9), remaining_principal: 0, projected_end_month: null, next_due_month: null }),
];

/** Der echte Render-Pfad des Darlehen-Reiters; gibt die Karten-IDs in Lesereihenfolge. */
function seite(sort, statusFilter = 'active') {
  const vorher = { ...budget.state };
  Object.assign(budget.state, {
    loans: { loans: BESTAND, summary: { has_interest: true } },
    loanSort: sort, loanStatusFilter: statusFilter, loanFilterId: null,
  });
  try {
    const html = budget.renderLoansPage();
    return { html, karten: [...html.matchAll(/<article class="budget-loan-card" data-loan-id="(\d+)"/g)].map((m) => Number(m[1])) };
  } finally { Object.assign(budget.state, vorher); }
}

test('die Karten stehen in der gewaehlten Reihenfolge', () => {
  withAccess({ budget: 'write' }, () => {
    assert.deepEqual(seite('start').karten, [1, 2, 3]);
    assert.deepEqual(seite('rate').karten, [2, 1, 3]);
    assert.deepEqual(seite('balance').karten, [3, 2, 1]);
    assert.deepEqual(seite('balance', 'all').karten, [3, 2, 1, 4], 'das getilgte bleibt hinten');
    assert.deepEqual(seite('rate', 'all').karten, [2, 1, 3, 4]);
  });
});

test('das Menue nennt jede Sortierung und hakt genau die gewaehlte', () => {
  withAccess({ budget: 'write' }, () => {
    for (const wahl of LOAN_SORTS) {
      const { html } = seite(wahl);
      const eintraege = [...html.matchAll(/role="menuitemradio" aria-checked="(true|false)" class="popover-menu__item" data-loan-sort="([a-z]+)"/g)];
      assert.deepEqual(eintraege.map((m) => m[2]), LOAN_SORTS);
      assert.deepEqual(eintraege.filter((m) => m[1] === 'true').map((m) => m[2]), [wahl]);
    }
  });
});

test('`budget: read` ordnet wie `write` - die Sortierung liest nur', () => {
  withAccess({ budget: 'read' }, () => {
    const { html, karten } = seite('rate');
    assert.deepEqual(karten, [2, 1, 3]);
    assert.match(html, /id="budget-loan-tools-menu"/);
    assert.match(html, /data-loan-sort="balance"/);
    assert.doesNotMatch(html, /data-action="loan-pay"/, 'Gegenprobe: das Recht ist wirklich nur lesen');
  });
});

test('die Karte nennt das voraussichtliche Ende - und laesst es weg, wo es keines gibt', () => {
  withAccess({ budget: 'write' }, () => {
    const mit = budget.renderLoanCard(BESTAND[0]);
    assert.match(mit, /budget\.loanProjectedEnd\{"month":"[^"]*2027[^"]*"\}/);
    assert.match(mit, /budget\.loanNextDue/);
    assert.doesNotMatch(budget.renderLoanCard(BESTAND[3]), /loanProjectedEnd/);
  });
});

// -------------------------------------------------------------------------
// Die Verdrahtung: Klick, Geraetespeicher, Fokus - als Programm gefahren
// -------------------------------------------------------------------------

/** Tauscht den Geraetespeicher fuer die Dauer von `fn` gegen einen, der mitschreibt. */
function mitSpeicher(inhalt, fn) {
  const vorher = globalThis.localStorage;
  const geschrieben = [];
  globalThis.localStorage = {
    getItem: (key) => (key in inhalt ? inhalt[key] : null),
    setItem: (key, value) => { geschrieben.push([key, value]); inhalt[key] = value; },
    removeItem() {},
  };
  try { return fn(geschrieben); } finally { globalThis.localStorage = vorher; }
}

/**
 * Der Darlehen-Reiter ueber den ECHTEN renderBody(): das Markup landet im
 * Koerper, und was wireLoansPage() an das Menue haengt, landet in `klick`.
 */
function reiter() {
  const lauf = { html: '', klick: null, fokus: 0 };
  const body = {
    replaceChildren() { lauf.html = ''; },
    insertAdjacentHTML(_pos, markup) { lauf.html += markup; },
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  const menue = { addEventListener(typ, fn) { if (typ === 'click') lauf.klick = fn; } };
  const knopf = { focus() { lauf.fokus += 1; } };
  const container = {
    querySelector: (sel) => ({
      '#budget-body': body, '#budget-loan-tools-menu': menue, '.budget-loan-tools': knopf,
    }[sel] ?? null),
    querySelectorAll: () => [],
    classList: { toggle() {} },
  };
  lauf.zeichnen = () => budget.renderBodyForTest(container);
  lauf.karten = () => [...lauf.html.matchAll(/<article class="budget-loan-card" data-loan-id="(\d+)"/g)].map((m) => Number(m[1]));
  return lauf;
}

function mitBestand(extra, fn) {
  const vorher = { ...budget.state };
  Object.assign(budget.state, {
    activeTab: 'loans', loadError: null,
    loans: { loans: BESTAND, summary: { has_interest: true } },
    loanStatusFilter: 'active', loanFilterId: null, ...extra,
  });
  try { return withAccess({ budget: 'write' }, fn); } finally { Object.assign(budget.state, vorher); }
}

test('ein Klick auf den Menue-Eintrag ordnet um, merkt die Wahl und gibt den Fokus zurueck', () => {
  mitSpeicher({}, (geschrieben) => mitBestand({ loanSort: 'start' }, () => {
    const lauf = reiter();
    lauf.zeichnen();
    assert.deepEqual(lauf.karten(), [1, 2, 3]);
    assert.equal(typeof lauf.klick, 'function', 'am Menue haengt ein Klick-Handler');

    // Ein Klick neben einen Eintrag (Gruppentitel) tut nichts.
    lauf.klick({ target: { closest: () => null } });
    assert.deepEqual(geschrieben, []);
    assert.equal(lauf.fokus, 0);

    const eintrag = { dataset: { loanSort: 'rate' } };
    lauf.klick({ target: { closest: (sel) => (sel === '[data-loan-sort]' ? eintrag : null) } });
    assert.deepEqual(lauf.karten(), [2, 1, 3], 'die Liste ist neu gezeichnet, in der neuen Reihenfolge');
    assert.match(lauf.html, /aria-checked="true" class="popover-menu__item" data-loan-sort="rate"/);
    assert.deepEqual(geschrieben, [['yuvomi:budget:loan-sort', 'rate']]);
    assert.equal(lauf.fokus, 1, 'der Fokus geht an den Mehr-Knopf zurueck');
    assert.equal(budget.state.loanSort, 'rate');
  }));
});

test('ein gemerkter Wert bestimmt die Reihenfolge beim ersten Zeichnen', () => {
  mitSpeicher({ 'yuvomi:budget:loan-sort': 'balance' }, () => mitBestand({ loanSort: null }, () => {
    const lauf = reiter();
    lauf.zeichnen();
    assert.deepEqual(lauf.karten(), [3, 2, 1]);
    assert.match(lauf.html, /aria-checked="true" class="popover-menu__item" data-loan-sort="balance"/);
  }));
  // Gegenstueck: ohne Wert und mit einem fremden Wert gilt die Voreinstellung.
  for (const inhalt of [{}, { 'yuvomi:budget:loan-sort': 'recommended' }]) {
    mitSpeicher(inhalt, () => mitBestand({ loanSort: null }, () => {
      const lauf = reiter();
      lauf.zeichnen();
      assert.deepEqual(lauf.karten(), [1, 2, 3]);
    }));
  }
});

test('die Ratenliste haelt ihre Reihenfolge, wenn die Darlehen umsortiert werden', () => {
  // Selber Tag, selbe Ratennummer an zwei Darlehen: der Gleichstand folgt der
  // Reihenfolge des Servers, nicht der der Karten.
  const rate = (id) => ({ id, installment_number: 1, amount: 100, paid_date: '2026-09-01', budget_entry_id: null });
  const bestand = [
    darlehen(1, { title: 'Haus', interest: zins(2.1), payments: [rate(11)] }),
    darlehen(2, { title: 'Auto', interest: zins(6.4), payments: [rate(22)] }),
  ];
  const zeilen = (sort) => {
    const vorher = { ...budget.state };
    Object.assign(budget.state, { loans: { loans: bestand, summary: {} }, loanSort: sort, loanStatusFilter: 'active', loanFilterId: null });
    try {
      const html = withAccess({ budget: 'write' }, () => budget.renderLoansPage());
      return {
        karten: [...html.matchAll(/<article class="budget-loan-card" data-loan-id="(\d+)"/g)].map((m) => Number(m[1])),
        raten: [...html.matchAll(/data-loan-payment-id="(\d+)"/g)].map((m) => Number(m[1])),
      };
    } finally { Object.assign(budget.state, vorher); }
  };
  assert.deepEqual(zeilen('start'), { karten: [1, 2], raten: [11, 22] });
  assert.deepEqual(zeilen('rate'), { karten: [2, 1], raten: [11, 22] });
});

// -------------------------------------------------------------------------
// Die Grenze: eine Rechnung, kein Rat
// -------------------------------------------------------------------------

test('kein Wort der Sortierung raet zu etwas (#935: Sortieren ist Rechnen, Umschichten ist Beratung)', () => {
  const KEYS = ['loanSortLabel', 'loanSortStart', 'loanSortRate', 'loanSortBalance', 'loanProjectedEnd'];
  const RAT = /empf|recommend|sollte|should|advice|advis|ratsam|optimal|best\b|beste|zuerst tilgen|pay off first|strateg|avalanche|snowball|lawine|schneeball/i;
  const dir = new URL('../public/locales/', import.meta.url);
  const dateien = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(dateien.length > 20);
  for (const datei of dateien) {
    const budgetKeys = JSON.parse(readFileSync(new URL(datei, dir), 'utf8')).budget;
    for (const key of KEYS) {
      assert.equal(typeof budgetKeys[key], 'string', `${datei}: budget.${key}`);
      if (datei === 'de.json' || datei === 'en.json') {
        assert.doesNotMatch(budgetKeys[key], RAT, `${datei}: budget.${key}`);
      }
    }
    assert.match(budgetKeys.loanProjectedEnd, /\{\{month\}\}/, `${datei}: der Monat muss im Satz stehen`);
  }
});

test.after(() => miniDomAbraeumen());
