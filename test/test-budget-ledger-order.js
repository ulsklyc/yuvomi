/**
 * Test: Sortierung und Kontofilter des Budget-Hauptbuchs (Critique R19)
 * Zweck: Persona Alex fand im Hauptbuch "weder Sortierung noch Kontofilter".
 *        Gemessen wird:
 *        1. `sortLedger()` als Rechnung - erst Ausgaben, dann Einnahmen, je
 *           nach Betrag; Gleichstand in der Reihenfolge des Servers, die
 *           Voreinstellung aendert nichts.
 *        2. der ECHTE Render-Pfad (`renderEntries()`, `listToolsMenuHtml()`):
 *           die Zeilen stehen in der gewaehlten Reihenfolge, auch nach Betrag
 *           in den Abschnitten Geplant/Gebucht (Re-Critique 2026-10-17; R19
 *           hatte sie fuer EINE Rangfolge aufgeloest), das Menue hakt
 *           die Wahl und das gefilterte Konto, und beides bleibt bei
 *           `budget: read` stehen.
 *        3. die Verdrahtung im Quelltext: die Wahl wird gemerkt, das Konto
 *           laedt den Kontoauszug vom Server nach.
 * Ausfuehren: npm run test:budget-ledger-order
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };

const { installMiniDom } = await import('./mini-dom.js');
installMiniDom();

const { setPermissions, clearPermissions } = await import('../public/permissions.js');
const { __test: budget } = await import('../public/pages/budget.js');
const { LEDGER_SORTS, DEFAULT_LEDGER_SORT, normalizeLedgerSort, sortLedger } = await import('../public/utils/ledger-order.js');

function withAccess(modules, fn) {
  setPermissions({ admin: false, modules, widgets: {}, capabilities: {} });
  try { return fn(); } finally { clearPermissions(); }
}

const buchung = (id, amount, date, over = {}) => ({
  id, title: `B${id}`, amount, date, category: 'Sonstiges', responsible_users: [], ...over,
});
// Reihenfolge des Servers: neueste zuerst.
const MONAT = [
  buchung(1, -12.5, '2026-09-20'),
  buchung(2, 2400, '2026-09-15'),
  buchung(3, -980, '2026-09-10'),
  buchung(4, -12.5, '2026-09-05'),
];

test('sortLedger: erst Ausgaben, dann Einnahmen, je nach Betrag; Gleichstand in der Reihenfolge des Servers', () => {
  assert.deepEqual(LEDGER_SORTS, ['date', 'amount']);
  assert.equal(DEFAULT_LEDGER_SORT, 'date');
  assert.equal(normalizeLedgerSort('quatsch'), 'date');
  // Das Gehalt (+2.400) stand bis hierhin VOR der Miete (-980): eine
  // Rangfolge ohne Vorzeichen mischte beide Richtungen (Persona Alex).
  assert.deepEqual(sortLedger(MONAT, 'amount').map((e) => e.id), [3, 1, 4, 2]);
  assert.deepEqual(sortLedger(MONAT, 'date').map((e) => e.id), [1, 2, 3, 4], 'die Voreinstellung laesst die Liste stehen');
  const kopie = [...MONAT];
  sortLedger(MONAT, 'amount');
  assert.deepEqual(MONAT, kopie, 'die Eingabe bleibt unveraendert');
});

function zeilen(html) {
  return [...html.matchAll(/class="list-row budget-entry[^"]*"\s*data-id="(\d+)"/g)].map((m) => Number(m[1]));
}

function liste(sort, over = {}) {
  const vorher = { ...budget.state };
  try {
    // Ein vergangener Monat mit einer kuenftigen Zeile waere kein Test der
    // Abschnitte - deshalb der laufende Monat mit einer geplanten Buchung.
    Object.assign(budget.state, {
      month: '2026-09', entries: [...MONAT, buchung(5, -3000, '2099-09-30')], ledgerQuery: '', ledgerResults: null,
      categoryFilter: null, subcategoryFilter: null, responsibleFilterId: null, accountFilterId: null,
      groupByResponsible: false, ledgerSort: sort, accounts: [], ...over,
    });
    return { html: budget.renderEntries(), menu: budget.listToolsMenuHtml() };
  } finally {
    Object.assign(budget.state, vorher);
  }
}

test('renderEntries: nach Betrag in Geplant und Gebucht sortiert, nach Datum wie bisher', () => {
  withAccess({ budget: 'write' }, () => {
    const betrag = liste('amount', {
      entries: [...MONAT, buchung(5, -3000, '2099-09-30'), buchung(6, 50, '2099-09-28'), buchung(7, -400, '2099-09-29')],
    });
    assert.match(betrag.html, /budget-ledger-section--planned/, 'auch nach Betrag bleibt Geplant von Gebucht getrennt');
    assert.deepEqual(zeilen(betrag.html), [5, 7, 6, 3, 1, 4, 2],
      'Geplant: Ausgaben nach Betrag, dann die Einnahme; Gebucht ebenso');
    const datum = liste('date');
    assert.match(datum.html, /budget-ledger-section--planned/, 'nach Datum bleiben die Abschnitte');
  });
});

test('das Menue hakt die Sortierung und das Konto - auch bei budget: read', () => {
  for (const recht of ['write', 'read']) {
    withAccess({ budget: recht }, () => {
      const accounts = [{ id: 7, name: 'Giro' }, { id: 8, name: 'Alt', archived: true }, { id: 9, name: 'Bar' }];
      const { menu } = liste('amount', { accounts, accountFilterId: 9 });
      const sort = [...menu.matchAll(/aria-checked="(true|false)" class="popover-menu__item" data-ledger-sort="(\w+)"/g)];
      assert.deepEqual(sort.map((m) => m[2]), ['date', 'amount'], `${recht}: beide Sortierungen`);
      assert.deepEqual(sort.filter((m) => m[1] === 'true').map((m) => m[2]), ['amount']);
      const konto = [...menu.matchAll(/aria-checked="(true|false)" class="popover-menu__item" data-ledger-account="(\d*)"/g)];
      assert.deepEqual(konto.map((m) => m[2]), ['', '7', '9'], `${recht}: Alle Konten, dann die aktiven Konten (archivierte nur, wenn gefiltert)`);
      assert.deepEqual(konto.filter((m) => m[1] === 'true').map((m) => m[2]), ['9']);
      const ohne = liste('date', { accounts: [] }).menu;
      assert.doesNotMatch(ohne, /data-ledger-account/, 'ohne Konten keine Kontowahl');
      assert.match(ohne, /data-ledger-sort="amount"/, 'die Sortierung steht immer');
    });
  }
});

test('Verdrahtung: die Sortierzeile nennt die Wahl, das Menue merkt sie und laedt den Kontoauszug nach', () => {
  const src = readFileSync(new URL('../public/pages/budget.js', import.meta.url), 'utf8');
  assert.match(src, /\$\{budgetChipHtml\(\)\}\s*\$\{ledgerSortNoteHtml\(\)\}/, 'die Sortierzeile steht im Kopf der Liste');
  const wiring = src.slice(src.indexOf("querySelector('#budget-list-tools-menu')?.addEventListener('click'"));
  const body = wiring.slice(0, wiring.indexOf('\n  });') + 6);
  assert.match(body, /localStorage\.setItem\(LEDGER_SORT_KEY, state\.ledgerSort\)/, 'die Sortierung wird je Geraet gemerkt');
  assert.match(body, /state\.accountFilterId = id;\s*\/\/[^\n]*\n\s*await reloadMonth\(\);/, 'das Konto laedt den Kontoauszug vom Server');
  assert.match(body, /renderBody\(\);[\s\S]*\.budget-list-tools'\)\?\.focus\(\)/, 'der Fokus kehrt an den Menueknopf zurueck');
  assert.match(src, /const rows = sortLedger\(visibleEntries\(\), ledgerSort\(\)\);/);
});
